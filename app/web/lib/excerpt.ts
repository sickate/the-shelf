// Owner-side text excerpt for AI book info. The text is only sent with the POST to
// /api/books/:id/info (the server clips it again and never stores it).
import { Book, fmt } from "./common";

export const EXCERPT_CHARS = 12000;
const PDF_PAGES = 8;
const EPUB_SECTIONS = 12;
const TEXT_BYTES = 65536;

const fileUrl = (b: Pick<Book, "id">) => `/api/books/${encodeURIComponent(String(b.id))}/file`;

/** Collapses runs of spaces, keeps paragraph breaks (at most one blank line). */
export function normalizeText(s: string): string {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g, "")
    .replace(/[ \t 　]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clip = (s: string) => Array.from(s).slice(0, EXCERPT_CHARS).join("");

async function pdfExcerpt(b: Book): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  // Same range-loading setup as the reader: only the chunks of the first pages are fetched.
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
  const pdf = await task.promise;
  try {
    const parts: string[] = [];
    let len = 0;
    for (let n = 1; n <= Math.min(pdf.numPages, PDF_PAGES) && len < EXCERPT_CHARS; n++) {
      try {
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        let text = "";
        for (const item of tc.items as any[]) {
          if (typeof item?.str !== "string") continue;
          text += item.str + (item.hasEOL ? "\n" : "");
        }
        text = normalizeText(text);
        page.cleanup();
        if (!text) continue; // scanned / image-only page
        parts.push(text);
        len += text.length + 2;
      } catch {
        /* skip unreadable page */
      }
    }
    return parts.join("\n\n");
  } finally {
    // Frees the worker and range transport (the loading task owns them).
    Promise.resolve()
      .then(() => task.destroy())
      .catch(() => {});
  }
}

async function epubExcerpt(b: Book): Promise<string> {
  const res = await fetch(fileUrl(b), { credentials: "same-origin" });
  if (!res.ok) return "";
  const [{ default: ePub }, buf] = await Promise.all([import("epubjs"), res.arrayBuffer()]);
  // Not destroyed afterwards: epub.js still has async resource work in flight and would throw;
  // the instance is unreferenced once this returns.
  const book = ePub(buf as any);
  await book.ready;
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; i < EPUB_SECTIONS && len < EXCERPT_CHARS; i++) {
    const section: any = book.spine.get(i);
    if (!section) break;
    try {
      const doc: any = await section.load(book.load.bind(book));
      // XHTML may be parsed as XML (no doc.body): find <body> and drop style/script text.
      const root = doc?.body ?? doc?.getElementsByTagName?.("body")?.[0] ?? doc?.documentElement;
      const clone = root?.cloneNode(true);
      clone?.querySelectorAll?.("style, script, head, title").forEach((n: Element) => n.remove());
      const text = normalizeText(clone?.textContent || "");
      section.unload();
      if (!text) continue;
      parts.push(text);
      len += text.length + 2;
    } catch {
      /* skip broken section */
    }
  }
  return parts.join("\n\n");
}

/** UTF-8 first; GB18030 when UTF-8 yields many replacement characters. */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  // A Range cut may split the last character; ignore a few trailing replacements.
  const bad = (utf8.match(/�/g) || []).length;
  if (bad <= 2 || bad / Math.max(1, utf8.length) < 0.01) return utf8;
  try {
    const gb = new TextDecoder("gb18030").decode(bytes);
    return (gb.match(/�/g) || []).length < bad ? gb : utf8;
  } catch {
    return utf8;
  }
}

async function textExcerpt(b: Book): Promise<string> {
  const res = await fetch(fileUrl(b), { credentials: "same-origin", headers: { Range: `bytes=0-${TEXT_BYTES - 1}` } });
  if (!res.ok) return "";
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > TEXT_BYTES) bytes = bytes.subarray(0, TEXT_BYTES); // server ignored Range
  return normalizeText(decodeText(bytes));
}

async function mobiExcerpt(b: Book): Promise<string> {
  const res = await fetch(fileUrl(b), { credentials: "same-origin" });
  if (!res.ok) return "";
  const { openMobi } = await import("./mobi");
  const book = await openMobi(await res.blob());
  const parts: string[] = [];
  let len = 0;
  for (const section of book.sections.slice(0, 12)) {
    if (len >= EXCERPT_CHARS) break;
    try {
      const doc: Document = await section.createDocument();
      const text = normalizeText(doc.body?.textContent || doc.documentElement?.textContent || "");
      if (!text) continue;
      parts.push(text);
      len += text.length + 2;
    } catch {
      /* skip broken section */
    }
  }
  return parts.join("\n\n");
}

/** Best-effort excerpt (≤ 12,000 chars) of the book's opening text. Never throws; "" on failure. */
export async function extractExcerpt(book: Book): Promise<string> {
  try {
    if (book.status !== "uploaded") return ""; // local-only: no cloud file to read
    const f = fmt(book);
    let text = "";
    if (f === "pdf") text = await pdfExcerpt(book);
    else if (f === "epub") text = await epubExcerpt(book);
    else if (f === "txt" || f === "md") text = await textExcerpt(book);
    else if (f === "mobi" || f === "azw3" || f === "azw") text = await mobiExcerpt(book);
    return clip(normalizeText(text));
  } catch {
    return "";
  }
}
