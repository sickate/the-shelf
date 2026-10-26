// Shared PDF opening for the reader and thumbnails. Normal files are opened with range loading;
// if pdf.js rejects the structure, the whole file is downloaded once and, when it is a damaged
// (typically truncated) PDF, a minimal trailer / page tree is appended so the surviving pages
// can still be rendered. Import this module dynamically together with pdfjs-dist.
import { ApiError } from "./common";

type PdfJs = typeof import("pdfjs-dist");
type PdfTask = ReturnType<PdfJs["getDocument"]>;
export type PdfDoc = Awaited<PdfTask["promise"]>;

export const PDF_ASSETS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
};

/** The file cannot be opened as a PDF; `bytes` is the downloaded file (for last-resort use). */
export class PdfUnreadableError extends Error {
  constructor(public reason: "not_pdf" | "damaged", message: string, public bytes: Uint8Array) {
    super(message);
    this.name = "PdfUnreadableError";
  }
}

export interface OpenedPdf {
  pdf: PdfDoc;
  /** True when the file was damaged and opened from a repaired in-memory copy. */
  repaired: boolean;
  destroy(): Promise<void>;
}

/** Known non-PDF containers that are sometimes saved with a .pdf extension. */
function sniffFormat(head: string): string {
  if (head.startsWith("AT&TFORM")) return "DjVu";
  if (head.startsWith("PK\x03\x04")) return "ZIP/EPUB";
  if (head.startsWith("BOOKMOBI", 60)) return "MOBI";
  if (/^\{\\rtf/.test(head)) return "RTF";
  if (/^\s*<(!doctype|html)/i.test(head)) return "HTML";
  return "";
}

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

/**
 * Appends a trailer (and, when the page tree is gone, a new catalog + flat page tree built from
 * the surviving /Type /Page objects in file order) to a PDF whose xref / trailer are missing.
 * Returns null when no usable pages are left. pdf.js then rebuilds the xref by scanning objects.
 */
export function repairPdf(bytes: Uint8Array): Uint8Array | null {
  const s = latin1(bytes);
  const objRe = /(?:^|[\r\n\s])(\d{1,7})\s+(\d{1,5})\s+obj\b/g;
  type Obj = { num: number; gen: number; dict: string };
  const objs: Obj[] = [];
  let maxNum = 0;
  for (const m of s.matchAll(objRe)) {
    const start = m.index! + m[0].length;
    // Only the object's own dictionary matters, not stream data or following objects.
    const tail = s.slice(start, start + 4096);
    const cut = tail.search(/\bstream\b|\bendobj\b/);
    const num = Number(m[1]);
    objs.push({ num, gen: Number(m[2]), dict: cut < 0 ? tail : tail.slice(0, cut) });
    maxNum = Math.max(maxNum, num);
  }
  const defined = new Set(objs.map((o) => `${o.num} ${o.gen}`));
  const typeIs = (o: Obj, t: string) => new RegExp(`/Type\\s*/${t}(?![A-Za-z])`).test(o.dict);
  const catalog = objs.filter((o) => typeIs(o, "Catalog")).pop();
  const pagesRef = catalog && /\/Pages\s+(\d+)\s+(\d+)\s+R/.exec(catalog.dict);
  // The leading "endobj" closes a truncated last object: pdf.js' object scanner otherwise
  // treats everything up to EOF (including the appended trailer) as that object's content.
  let extra = "\nendobj\n";
  let root: string;
  if (catalog && pagesRef && defined.has(`${pagesRef[1]} ${pagesRef[2]}`)) {
    root = `${catalog.num} ${catalog.gen} R`;
  } else {
    const seen = new Set<string>();
    const pages = objs.filter((o) => typeIs(o, "Page")).filter((o) => !seen.has(`${o.num} ${o.gen}`) && seen.add(`${o.num} ${o.gen}`));
    // Tagged PDFs number pages through /StructParents in reading order; when every surviving
    // page has a distinct one, that order beats file order (writers often emit pages reversed).
    const sp = pages.map((o) => /\/StructParents\s+(\d+)/.exec(o.dict)?.[1]);
    if (sp.every((v) => v != null) && new Set(sp).size === sp.length) {
      const order = new Map(pages.map((o, i) => [o, Number(sp[i])]));
      pages.sort((a, b) => order.get(a)! - order.get(b)!);
    }
    const kids = pages.map((o) => `${o.num} ${o.gen} R`);
    if (!kids.length) return null;
    const pagesNum = maxNum + 1;
    const catNum = maxNum + 2;
    maxNum += 2;
    extra += `${pagesNum} 0 obj\n<</Type/Pages/Count ${kids.length}/Kids[${kids.join(" ")}]>>\nendobj\n`;
    extra += `${catNum} 0 obj\n<</Type/Catalog/Pages ${pagesNum} 0 R>>\nendobj\n`;
    root = `${catNum} 0 R`;
  }
  extra += `trailer\n<</Size ${maxNum + 1}/Root ${root}>>\n%%EOF\n`;
  const tail = new TextEncoder().encode(extra);
  const out = new Uint8Array(bytes.length + tail.length);
  out.set(bytes);
  out.set(tail, bytes.length);
  return out;
}

/**
 * First embedded JPEG image (a scanned book's cover page) of a PDF, for files so damaged that
 * no page survives. Returns null when there is none.
 */
export function firstPdfJpeg(bytes: Uint8Array): Blob | null {
  const s = latin1(bytes.subarray(0, Math.min(bytes.length, 8 << 20)));
  const re = /\/Subtype\s*\/Image\b[^]{0,600}?\bstream\r?\n/g;
  for (const m of s.matchAll(re)) {
    if (!/\/DCTDecode/.test(m[0]) || /\/Decode\s*\[|\/DeviceCMYK|\/SMask/.test(m[0])) continue;
    const start = m.index! + m[0].length;
    if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) continue;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    return new Blob([bytes.slice(start, end)], { type: "image/jpeg" });
  }
  return null;
}

async function fetchAll(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) throw new ApiError(401, "unauthorized");
  if (!res.ok) throw new Error(`download http_${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Opens a PDF by URL with range loading (only the chunks the shown pages need are fetched).
 * On a structural failure (InvalidPDFException) it downloads the file once and tries the repair
 * above; throws PdfUnreadableError when the file is not a PDF or nothing can be recovered, and
 * ApiError(401) when file access is lost.
 */
export async function openPdf(
  pdfjs: PdfJs,
  url: string,
  onProgress?: (p: { loaded: number; total?: number }) => void,
): Promise<OpenedPdf> {
  // With disableStream pdf.js aborts the initial full GET once it sees Accept-Ranges /
  // Content-Length and fetches 256 KB chunks on demand; disableAutoFetch stops background
  // prefetching. (Files <= 512 KB are simply fetched whole.)
  const task = pdfjs.getDocument({
    url,
    withCredentials: true,
    rangeChunkSize: 65536 * 4,
    disableStream: true,
    disableAutoFetch: true,
    ...PDF_ASSETS,
  });
  if (onProgress) task.onProgress = onProgress;
  try {
    const pdf = await task.promise;
    return { pdf, repaired: false, destroy: () => task.destroy().catch(() => {}) };
  } catch (e: any) {
    await task.destroy().catch(() => {});
    if (e?.status === 401) throw new ApiError(401, "unauthorized");
    if (e?.name !== "InvalidPDFException") throw e;
  }
  const bytes = await fetchAll(url);
  onProgress?.({ loaded: bytes.length, total: bytes.length });
  const head = latin1(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) {
    const kind = sniffFormat(head);
    throw new PdfUnreadableError("not_pdf", kind ? `文件实际是 ${kind} 格式，不是 PDF` : "文件不是有效的 PDF", bytes);
  }
  const repaired = repairPdf(bytes);
  if (repaired) {
    // pdf.js transfers `data` to its worker, so `bytes` stays usable for the caller.
    const fixed = pdfjs.getDocument({ data: repaired, ...PDF_ASSETS });
    try {
      const pdf = await fixed.promise;
      return { pdf, repaired: true, destroy: () => fixed.destroy().catch(() => {}) };
    } catch {
      await fixed.destroy().catch(() => {});
    }
  }
  throw new PdfUnreadableError("damaged", "PDF 文件已损坏（不完整），没有可显示的页面", bytes);
}
