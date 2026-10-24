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

const fileUrl = (b: Book) => `/api/books/${encodeURIComponent(String(b.id))}/file`;

/** Whether a thumbnail can be generated for this book (uploaded + supported format). */
export function canThumb(b: Book): boolean {
  return b.status === "uploaded" && THUMB_FORMATS.has(fmt(b));
}

class Skip extends Error {
  constructor(public reason: ThumbSkip, message = reason) {
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

async function pdfThumb(b: Book): Promise<Thumb> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  // Same range setup as the reader: only the chunks page 1 needs are requested.
  const task = pdfjs.getDocument({
    url: fileUrl(b),
    withCredentials: true,
    rangeChunkSize: 65536 * 4,
    disableStream: true,
    disableAutoFetch: true,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  });
  try {
    let pdf;
    try {
      pdf = await task.promise;
    } catch (e: any) {
      if (e?.status === 401) throw new ApiError(401, "unauthorized");
      throw new Skip("parse_failed", `pdf open: ${e?.name || e}`);
    }
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    if (!base.width || !base.height) throw new Skip("parse_failed", "empty page");
    const rendered = new Map<number, HTMLCanvasElement>();
    return await encode(async (width) => {
      const hit = rendered.get(width);
      if (hit) return hit;
      const w = Math.min(width, Math.ceil(base.width * 2));
      const vp = page.getViewport({ scale: w / base.width });
      const full = document.createElement("canvas");
      full.width = Math.round(vp.width);
      full.height = Math.min(Math.round(vp.height), MAX_HEIGHT);
      const ctx = full.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, full.width, full.height);
      // Rendering into a canvas shorter than the viewport keeps just the top of tall pages.
      // intent "print" renders without requestAnimationFrame, which stalls in background tabs.
      await page.render({ canvas: full, canvasContext: ctx, viewport: vp, background: "#fff", intent: "print" } as any)
        .promise;
      rendered.set(width, full);
      return full;
    });
  } finally {
    await task.destroy().catch(() => {});
  }
}

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
    if (!url) throw new Skip("no_cover", "epub has no cover");
    const res = await fetch(url);
    return await imageThumb(await res.blob());
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
  const [{ mobiCover }, blob] = await Promise.all([import("./mobi"), download(b)]);
  const cover = await mobiCover(blob);
  if (!cover) throw new Skip("no_cover", "mobi has no readable cover");
  return imageThumb(cover);
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
