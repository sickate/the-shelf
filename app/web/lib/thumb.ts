// Browser-side cover thumbnails (F1). The PDF first page or the EPUB / MOBI embedded cover is
// drawn into a canvas, encoded as WebP (JPEG where WebP encoding is unsupported, e.g. Safari)
// and stored by the Worker via PUT /api/books/:id/cover. Parsers are imported dynamically so
// this module is cheap to import from the shelf and detail pages.
import { api, ApiError, Book, fmt, store } from "./common";

export { coverUrl } from "./common";

export interface Thumb {
  blob: Blob;
  width: number;
  height: number;
}

export interface CoverResult {
  ok: true;
  cover: { sizeBytes: number; width: number | null; height: number | null };
}

/** Why no thumbnail was produced. */
export type ThumbSkip = "no_cover" | "parse_failed" | "unsupported";

export type EnsureResult = { ok: true; cover: CoverResult["cover"] } | { ok: false; reason: ThumbSkip };

export const THUMB_FORMATS = new Set(["pdf", "epub", "mobi", "azw3", "azw"]);

const WIDTH = 360;
const SMALL_WIDTH = 280;
const MAX_HEIGHT = 600;
const TARGET_BYTES = 150_000;
const MAX_BYTES = 200_000; // server limit
/** Below this share of inked pixels a rendered PDF page counts as blank. */
const BLANK_INK = 0.004;

const fileUrl = (b: Book) => `/api/books/${encodeURIComponent(String(b.id))}/file`;

/** Whether a thumbnail can be generated for this book (uploaded + supported format). */
export function canThumb(b: Book): boolean {
  return b.status === "uploaded" && THUMB_FORMATS.has(fmt(b));
}

class Skip extends Error {
  constructor(public reason: ThumbSkip, message: string = reason) {
    super(message);
  }
}

async function download(b: Book): Promise<Blob> {
  const res = await fetch(fileUrl(b), { credentials: "same-origin" });
  if (res.status === 401) throw new ApiError(401, "unauthorized");
  if (!res.ok) throw new Skip("parse_failed", `download http_${res.status}`);
  return res.blob();
}

type Source = CanvasImageSource & { width: number; height: number };

/**
 * Draws `src` scaled to `width` (never upscaled). Pages taller than MAX_HEIGHT are cropped from
 * the top (titles live there); very wide images are simply short.
 */
function draw(src: Source, srcW: number, srcH: number, width: number): HTMLCanvasElement {
  const w = Math.max(1, Math.round(Math.min(width, srcW)));
  const scale = w / srcW;
  const h = Math.max(1, Math.min(MAX_HEIGHT, Math.round(srcH * scale)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, srcW, Math.min(srcH, h / scale), 0, 0, w, h);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encodeAt(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  const webp = await toBlob(canvas, "image/webp", quality);
  if (webp?.type === "image/webp") return webp;
  const jpeg = await toBlob(canvas, "image/jpeg", Math.min(0.82, quality + 0.02));
  return jpeg?.type === "image/jpeg" ? jpeg : null;
}

/** Encodes, stepping down quality and then width until the blob is small enough. */
async function encode(render: (width: number) => HTMLCanvasElement | Promise<HTMLCanvasElement>): Promise<Thumb> {
  let best: Thumb | null = null;
  for (const [width, quality] of [
    [WIDTH, 0.8],
    [WIDTH, 0.6],
    [SMALL_WIDTH, 0.6],
    [SMALL_WIDTH, 0.45],
  ] as const) {
    const canvas = await render(width);
    const blob = await encodeAt(canvas, quality);
    if (!blob) throw new Skip("parse_failed", "encode failed");
    best = { blob, width: canvas.width, height: canvas.height };
    if (blob.size <= TARGET_BYTES) return best;
  }
  if (best && best.blob.size <= MAX_BYTES) return best;
  throw new Skip("parse_failed", "thumbnail too large");
}

async function imageThumb(image: Blob): Promise<Thumb> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new Skip("parse_failed", "cover image decode failed");
  }
  try {
    if (!bitmap.width || !bitmap.height) throw new Skip("no_cover", "empty cover image");
    return await encode((w) => draw(bitmap, bitmap.width, bitmap.height, w));
  } finally {
    bitmap.close();
  }
}

/** Typographic cover for books whose file offers no usable cover or first page. */
async function designedThumb(b: Book, author?: string): Promise<Thumb> {
  const { typographicCover } = await import("./thumb-render");
  const canvas = typographicCover(b, (b.authors?.length ? b.authors.join("、") : author || "").trim());
  return encode((w) => draw(canvas, canvas.width, canvas.height, w));
}

/** Rasterised content page as a thumbnail. */
function pageThumb(canvas: HTMLCanvasElement): Promise<Thumb> {
  return encode((w) => draw(canvas, canvas.width, canvas.height, w));
}

async function pdfThumb(b: Book): Promise<Thumb> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const { openPdf, PdfUnreadableError, firstPdfJpeg } = await import("./pdf");
  let opened;
  try {
    // Same range setup as the reader: only the chunks page 1 needs are requested. Damaged
    // (truncated) files are downloaded once and repaired in memory.
    opened = await openPdf(pdfjs, fileUrl(b));
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    if (e instanceof PdfUnreadableError) {
      // Nothing renderable: a scanned book's first image is its cover; otherwise design one.
      const jpeg = e.reason === "damaged" ? firstPdfJpeg(e.bytes) : null;
      if (jpeg) return await imageThumb(jpeg).catch(() => designedThumb(b));
      console.warn(`thumb ${b.id}: ${e.message}`);
      return designedThumb(b);
    }
    throw new Skip("parse_failed", `pdf open: ${e?.name || e} ${e?.message || ""}`.trim());
  }
  try {
    const { pdf } = opened;
    const renderPage = async (n: number) => {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      if (!base.width || !base.height) throw new Skip("parse_failed", "empty page");
      const rendered = new Map<number, HTMLCanvasElement>();
      const at = async (width: number) => {
        const hit = rendered.get(width);
        if (hit) return hit;
        const w = Math.min(width, Math.ceil(base.width * 2));
        const vp = page.getViewport({ scale: w / base.width });
        const full = document.createElement("canvas");
        full.width = Math.max(1, Math.round(vp.width));
        full.height = Math.max(1, Math.min(Math.round(vp.height), MAX_HEIGHT));
        const ctx = full.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, full.width, full.height);
        // Rendering into a canvas shorter than the viewport keeps just the top of tall pages.
        // intent "print" renders without requestAnimationFrame, which stalls in background tabs.
        await page.render({ canvas: full, canvasContext: ctx, viewport: vp, background: "#fff", intent: "print" } as any)
          .promise;
        rendered.set(width, full);
        return full;
      };
      return { first: await at(WIDTH), thumb: () => encode(at) };
    };
    // Page 1 normally. A failing or (nearly) blank first page - e.g. a damaged file whose cover
    // image is missing - falls through to the next of the first three pages.
    const { inkRatio } = await import("./thumb-render");
    let fallback: Awaited<ReturnType<typeof renderPage>> | null = null;
    let error: unknown = null;
    for (let n = 1; n <= Math.min(3, pdf.numPages); n++) {
      try {
        const r = await renderPage(n);
        const ink = inkRatio(r.first);
        if (ink >= BLANK_INK) return await r.thumb();
        fallback ??= r;
      } catch (e) {
        error ??= e;
        console.warn(`thumb ${b.id}: page ${n} failed (${String((e as any)?.message || e).slice(0, 80)})`);
      }
    }
    if (fallback) return await fallback.thumb();
    throw error;
  } finally {
    await opened.destroy();
  }
}

type PageSource = { doc: Document; res: import("./thumb-render").PageResources; done?: () => void };

/** First of up to 6 content pages that renders with visible ink, as a 360x480 canvas. */
async function firstPage(pages: AsyncIterable<PageSource>): Promise<HTMLCanvasElement | null> {
  const { rasterizeDocument, hasVisibleContent } = await import("./thumb-render");
  let tried = 0;
  for await (const p of pages) {
    try {
      if (!hasVisibleContent(p.doc)) continue;
      const canvas = await rasterizeDocument(p.doc, p.res);
      if (canvas) return canvas;
    } finally {
      p.done?.();
    }
    if (++tried >= 6) break;
  }
  return null;
}

async function* epubPages(book: any): AsyncGenerator<PageSource> {
  const archive = book.archive;
  const sections = (book.spine?.spineItems || []).filter((s: any) => s.linear !== "no").slice(0, 10);
  for (const section of sections) {
    let doc: Document | undefined;
    try {
      await section.load(book.load.bind(book));
      doc = section.document;
    } catch {
      /* unreadable section */
    }
    if (!doc || !archive) continue;
    // Archive paths are absolute ("/OEBPS/x.xhtml"); resolve references against the section.
    const path = (href: string) => new URL(href, `http://epub${section.url}`).pathname;
    yield {
      doc,
      res: {
        image: async (src) =>
          src.startsWith("data:") ? (await fetch(src)).blob() : (await archive.getBlob(path(src))) || null,
        css: async (href) => (await archive.getText(path(href))) || null,
      },
      done: () => section.unload?.(),
    };
  }
}

async function* mobiPages(book: any): AsyncGenerator<PageSource> {
  const { typedImage } = await import("./mobi");
  const blobOnly = (url: string) => (url.startsWith("blob:") ? fetch(url) : null);
  for (const section of (book.sections || []).slice(0, 10)) {
    let doc: Document | undefined;
    try {
      // foliate's load() returns a blob URL of the section with resources as blob URLs.
      const text = await (await fetch(await section.load())).text();
      doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
      if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(text, "text/html");
    } catch {
      /* unreadable section */
    }
    if (!doc) continue;
    yield {
      doc,
      res: {
        image: async (src) => {
          const r = await blobOnly(src);
          return r?.ok ? typedImage(await r.blob()) : null;
        },
        css: async (href) => {
          const r = await blobOnly(href);
          return r?.ok ? r.text() : null;
        },
      },
    };
  }
}

const joinNames = (v: unknown): string =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .map((x: any) => (typeof x === "string" ? x : x?.name || ""))
    .filter(Boolean)
    .join("、");

async function epubThumb(b: Book): Promise<Thumb> {
  const [{ default: ePub }, blob] = await Promise.all([import("epubjs"), download(b)]);
  const book = ePub(await blob.arrayBuffer() as any);
  let url: string | null = null;
  try {
    try {
      await book.loaded.cover;
    } catch (e: any) {
      throw new Skip("parse_failed", `epub open: ${e?.message || e}`);
    }
    url = await book.coverUrl().catch(() => null);
    if (!url) {
      // EPUB 2 files without a cover declaration often still ship a "cover" image.
      const items = Object.values((book as any).packaging?.manifest || {}) as { href?: string; type?: string }[];
      const guess = items.find((i) => /^image\//.test(i.type || "") && /cover/i.test(i.href || ""));
      if (guess?.href && (book as any).archive) {
        const path = (book as any).resolve?.(guess.href);
        if (path) url = await (book as any).archive.createUrl(path).catch(() => null);
      }
    }
    if (url) {
      const res = await fetch(url);
      return await imageThumb(await res.blob());
    }
    // No cover image: use the first content page, else a designed cover.
    await Promise.race([(book as any).opened, new Promise((r) => setTimeout(r, 15_000))]);
    const page = await firstPage(epubPages(book)).catch(() => null);
    if (page) return await pageThumb(page);
    return await designedThumb(b, joinNames((book as any).packaging?.metadata?.creator));
  } finally {
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    // epub.js keeps unpacking (navigation, CSS replacements) after the cover is known;
    // destroying it mid-way makes those steps throw, so let opening settle first (bounded).
    await Promise.race([
      Promise.allSettled([(book as any).opened, book.ready]),
      new Promise((r) => setTimeout(r, 15_000)),
    ]);
    try {
      book.destroy();
    } catch {
      /* ignore */
    }
  }
}

async function mobiThumb(b: Book): Promise<Thumb> {
  const [{ openMobi, foliateCover }, blob] = await Promise.all([import("./mobi"), download(b)]);
  let book;
  try {
    book = await openMobi(blob);
  } catch (e: any) {
    throw new Skip("parse_failed", `mobi open: ${e?.message || e}`);
  }
  const cover = await foliateCover(book);
  if (cover) return imageThumb(cover);
  // No cover image: use the first content page, else a designed cover.
  const page = await firstPage(mobiPages(book)).catch(() => null);
  if (page) return pageThumb(page);
  return designedThumb(b, joinNames(book.metadata?.author));
}

/** Builds a thumbnail or explains why not. Throws only ApiError(401) (file access lost). */
export async function buildThumb(b: Book): Promise<{ thumb: Thumb } | { reason: ThumbSkip }> {
  const f = fmt(b);
  if (!canThumb(b)) return { reason: "unsupported" };
  try {
    const thumb = f === "pdf" ? await pdfThumb(b) : f === "epub" ? await epubThumb(b) : await mobiThumb(b);
    return { thumb };
  } catch (e: any) {
    if (e instanceof ApiError && e.status === 401) throw e;
    const reason: ThumbSkip = e instanceof Skip ? e.reason : "parse_failed";
    console.warn(`thumb ${b.id}: ${String(e?.message || e).slice(0, 120)}`);
    return { reason };
  }
}

/** Thumbnail for a book, or null when it has no usable cover or parsing fails. Never throws. */
export async function makeThumb(b: Book): Promise<Thumb | null> {
  try {
    const r = await buildThumb(b);
    return "thumb" in r ? r.thumb : null;
  } catch (e: any) {
    console.warn(`thumb ${b.id}: ${String(e?.message || e).slice(0, 120)}`);
    return null;
  }
}

/** Stores a thumbnail. Throws ApiError (401, 404, 413, 415, 502 storage_unknown, 507 budget_exceeded). */
export async function uploadThumb(id: string | number, thumb: Thumb): Promise<CoverResult> {
  const res = await api<CoverResult>(`/api/books/${encodeURIComponent(String(id))}/cover`, {
    method: "PUT",
    body: thumb.blob,
    headers: {
      "Content-Type": thumb.blob.type,
      "X-Shelf-Width": String(thumb.width),
      "X-Shelf-Height": String(thumb.height),
    },
  });
  store.set(`shelf:cover-v:${id}`, String(Date.now()));
  return res;
}

/**
 * makeThumb + uploadThumb for one book (e.g. right after an upload). Resolves with the stored
 * cover or the skip reason; throws ApiError from the cover PUT (or 401 from the file fetch).
 * No automatic retry: a 502 storage_unknown is reported to the caller as-is.
 */
export async function ensureThumb(b: Book): Promise<EnsureResult> {
  const r = await buildThumb(b);
  if (!("thumb" in r)) return { ok: false, reason: r.reason };
  const res = await uploadThumb(b.id, r.thumb);
  b.hasCover = true;
  return { ok: true, cover: res.cover };
}
