// Per-format extraction of the plain text of the chapter the reader is currently in.
import { normalizeText } from "./excerpt";
import { MAX_CHAPTER_CHARS, type ChapterText } from "./chapter-source";

const MAX_KEY_BYTES = 500;
const NO_OUTLINE_PAGES = 30;
const TEXT_FALLBACK_CHARS = 20_000;
const MIN_PDF_CHARS = 20;

/** Truncates a key to ≤ 500 UTF-8 bytes (on a code point boundary). */
export function clipKey(key: string): string {
  const enc = new TextEncoder();
  if (enc.encode(key).length <= MAX_KEY_BYTES) return key;
  let out = "";
  let bytes = 0;
  for (const ch of key) {
    const n = enc.encode(ch).length;
    if (bytes + n > MAX_KEY_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Normalizes and clips to MAX_CHAPTER_CHARS code points. Returns null when too short. */
export function finishChapter(chapterKey: string, label: string, raw: string, minChars = 1): ChapterText | null {
  const norm = normalizeText(raw);
  if (norm.replace(/\s/g, "").length < minChars) return null;
  const cps = Array.from(norm);
  const truncated = cps.length > MAX_CHAPTER_CHARS;
  const text = truncated ? cps.slice(0, MAX_CHAPTER_CHARS).join("").trim() : norm;
  return { chapterKey: clipKey(chapterKey), label: label.trim().slice(0, 200), text, truncated };
}

// ---------------- TXT / MD ----------------
const HEADING_RES = [
  /^\s*第[0-9零一二三四五六七八九十百千万两〇]+[章回节卷部篇集]/,
  /^\s*(chapter|CHAPTER|Chapter)\s+[0-9IVXLCivxlc]+\b/,
  /^#{1,3}\s/,
];
export const isHeadingLine = (line: string) => HEADING_RES.some((r) => r.test(line));

export interface TextChapter {
  start: number;
  end: number;
  label: string;
  text: string;
}

/**
 * The chapter of `fullText` containing character `offset` (UTF-16 index). With headings: from the
 * last heading at or before the offset (the text start for an offset before the first heading) to
 * the next heading. Without headings: from the paragraph start at/before the offset to ~20,000
 * chars later, ending at a paragraph boundary.
 */
export function textChapterAt(fullText: string, offset: number): TextChapter {
  const s = fullText;
  const off = Math.min(Math.max(0, Math.floor(offset) || 0), s.length);
  const heads: { pos: number; line: string }[] = [];
  let pos = 0;
  while (pos <= s.length) {
    let nl = s.indexOf("\n", pos);
    if (nl < 0) nl = s.length;
    const line = s.slice(pos, nl);
    if (line.length <= 200 && isHeadingLine(line)) heads.push({ pos, line: line.trim() });
    pos = nl + 1;
  }
  if (heads.length) {
    let i = -1;
    for (let k = 0; k < heads.length; k++) if (heads[k].pos <= off) i = k;
    const start = i < 0 ? 0 : heads[i].pos;
    const end = i + 1 < heads.length ? heads[i + 1].pos : s.length;
    const label = i < 0 ? "" : heads[i].line.replace(/^#{1,3}\s+/, "");
    return { start, end, label, text: s.slice(start, end) };
  }
  // No headings: snap back to the start of the paragraph containing the offset.
  let start = 0;
  const para = off > 0 ? s.lastIndexOf("\n\n", off - 1) : -1;
  if (para >= 0) start = para + 2;
  else {
    const nl = off > 0 ? s.lastIndexOf("\n", off - 1) : -1;
    start = nl >= 0 ? nl + 1 : 0;
  }
  while (start < s.length && s[start] === "\n") start++;
  let end = Math.min(s.length, start + TEXT_FALLBACK_CHARS);
  if (end < s.length) {
    const cut = s.lastIndexOf("\n", end);
    if (cut > start) end = cut; // paragraph boundary
  }
  return { start, end, label: "", text: s.slice(start, end) };
}

export function textChapter(fullText: string, offset: number): ChapterText | null {
  const c = textChapterAt(fullText, offset);
  return finishChapter(`text:${c.start}`, c.label || `约第 ${c.start} 字起`, c.text);
}

// ---------------- PDF ----------------
export interface OutlinePage {
  page: number;
  title: string;
}

/** Inclusive page range of the outline item containing `current`. */
export function pdfRangeFor(
  outlinePages: OutlinePage[],
  current: number,
  numPages: number,
): { start: number; end: number; title: string } {
  const cur = Math.min(Math.max(1, Math.floor(current) || 1), Math.max(1, numPages));
  const items = outlinePages
    .filter((o) => Number.isFinite(o.page) && o.page >= 1 && o.page <= numPages)
    .map((o, i) => ({ ...o, i }))
    .sort((a, b) => a.page - b.page || a.i - b.i);
  let found: (typeof items)[number] | undefined;
  for (const it of items) if (it.page <= cur) found = it; // latest item at/before the page
  if (!found) {
    // No outline, or before the first item: 30 pages from here (stopping at the first item).
    let end = Math.min(numPages, cur + NO_OUTLINE_PAGES - 1);
    if (items.length && items[0].page - 1 >= cur) end = Math.min(end, items[0].page - 1);
    return { start: cur, end, title: "" };
  }
  const next = items.find((it) => it.page > found!.page);
  const end = next ? next.page - 1 : numPages;
  return { start: found.page, end: Math.max(found.page, end), title: found.title };
}

const pdfLabel = (start: number, end: number, title: string) =>
  title.trim() ? `${title.trim()}（第 ${start}–${end} 页）` : start === end ? `第 ${start} 页` : `第 ${start}–${end} 页`;

export async function resolveOutlinePages(pdf: any): Promise<OutlinePage[]> {
  let outline: any[] | null = null;
  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }
  const out: OutlinePage[] = [];
  const walk = async (items: any[]) => {
    for (const it of items || []) {
      if (out.length > 3000) return;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest)) {
          const ref = dest[0];
          const idx = typeof ref === "number" ? ref : await pdf.getPageIndex(ref);
          out.push({ page: idx + 1, title: String(it.title || "") });
        }
      } catch {
        /* broken destination */
      }
      if (it.items?.length) await walk(it.items);
    }
  };
  await walk(outline || []);
  return out;
}

/** Normalized text of one PDF page ("" when unreadable). */
export async function pdfPageText(pdf: any, n: number): Promise<string> {
  try {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    let text = "";
    for (const item of tc.items as any[]) {
      if (typeof item?.str !== "string") continue;
      text += item.str + (item.hasEOL ? "\n" : "");
    }
    page.cleanup();
    return normalizeText(text);
  } catch {
    return ""; // skip unreadable page
  }
}

export async function pdfPagesText(pdf: any, start: number, end: number): Promise<string> {
  const parts: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = await pdfPageText(pdf, n);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/** Inverse of the `pdf:<start>-<end>` chapter key. */
export function parsePdfKey(key: string): { start: number; end: number } | null {
  const m = /^pdf:(\d+)-(\d+)$/.exec(key);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return start >= 1 && end >= start ? { start, end } : null;
}

/** `currentPage` returns the page the reader shows now (first page of a spread). */
export function pdfChapterSource(pdf: any, currentPage: () => number): () => Promise<ChapterText | null> {
  let outline: Promise<OutlinePage[]> | null = null;
  return async () => {
    outline ??= resolveOutlinePages(pdf);
    const r = pdfRangeFor(await outline, currentPage(), pdf.numPages);
    const raw = await pdfPagesText(pdf, r.start, r.end);
    return finishChapter(`pdf:${r.start}-${r.end}`, pdfLabel(r.start, r.end, r.title), raw, MIN_PDF_CHARS);
  };
}

// ---------------- DOM (EPUB / MOBI sections) ----------------
const DROP_SEL = [
  "rt",
  "rp",
  "script",
  "style",
  "head",
  "title",
  "aside",
  '[role="doc-footnote"]',
  '[role="doc-endnote"]',
  '[role="doc-footnotes"]',
  '[role="doc-endnotes"]',
].join(",");
const BLOCK_SEL = "p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr,dt,dd,figcaption,section,article,br";
const NOTE_TYPE = /\b(footnote|endnote|rearnote|footnotes|endnotes)\b/;

/** Plain text of a section document, paragraph breaks kept, ruby/footnotes dropped. */
export function documentText(doc: any): string {
  const root: Element | null = doc?.body ?? doc?.getElementsByTagName?.("body")?.[0] ?? doc?.documentElement ?? null;
  if (!root) return "";
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll(DROP_SEL).forEach((n) => n.remove());
  // epub:type is a namespaced attribute; match by attribute name rather than a CSS selector.
  clone.querySelectorAll("*").forEach((n) => {
    const t = n.getAttribute("epub:type") ?? n.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "";
    if (t && NOTE_TYPE.test(t)) n.remove();
  });
  const d = clone.ownerDocument;
  clone.querySelectorAll(BLOCK_SEL).forEach((n) => {
    n.appendChild(d.createTextNode(n.tagName.toLowerCase() === "br" ? "\n" : "\n\n"));
  });
  return normalizeText(clone.textContent || "");
}

// ---------------- shared EPUB / MOBI TOC logic ----------------
interface TocEntry {
  href: string;
  label: string;
  depth: number;
}
interface TocIdx {
  idx: number;
  depth: number;
  label: string;
}
const stripFrag = (h: string) => String(h || "").split("#")[0];

function flattenToc(items: any[], depth = 0, out: TocEntry[] = []): TocEntry[] {
  for (const it of items || []) {
    if (out.length > 3000) break;
    out.push({ href: String(it.href || ""), label: String(it.label || "").trim(), depth });
    flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}

/** Section range [from, to] for the TOC item covering `currentIdx` (to = null: through the end). */
export function sectionRangeFor(
  toc: TocIdx[],
  currentIdx: number,
): { from: number; to: number | null; label: string } {
  let k = -1; // last TOC item whose section is at/before the current one
  for (let i = 0; i < toc.length; i++) {
    if (toc[i].idx >= 0 && toc[i].idx <= currentIdx && (k < 0 || toc[i].idx >= toc[k].idx)) k = i;
  }
  if (k < 0) return { from: currentIdx, to: currentIdx, label: "" };
  let to: number | null = null;
  for (let i = k + 1; i < toc.length; i++) {
    // next item at same-or-higher level that starts in a later section
    if (toc[i].idx > toc[k].idx && toc[i].depth <= toc[k].depth) {
      to = toc[i].idx - 1;
      break;
    }
  }
  return { from: toc[k].idx, to, label: toc[k].label };
}

const MAX_SECTIONS = 200;

// ---------------- EPUB ----------------
export function epubChapterSource(book: any, currentHref: () => string | null): () => Promise<ChapterText | null> {
  let tocIdx: Promise<TocIdx[]> | null = null;
  const buildToc = async (): Promise<TocIdx[]> => {
    const nav = await book.loaded.navigation;
    return flattenToc(nav?.toc).map((t) => {
      const s = t.href ? book.spine.get(stripFrag(t.href)) : null;
      return { idx: s ? (s.index as number) : -1, depth: t.depth, label: t.label };
    });
  };
  return async () => {
    const href = currentHref();
    if (!href) return null;
    const cur: any = book.spine.get(stripFrag(href));
    if (!cur) return null;
    tocIdx ??= buildToc();
    const r = sectionRangeFor(await tocIdx, cur.index);
    const last = (book.spine.length ?? book.spine.items?.length ?? r.from + 1) - 1;
    const to = Math.min(r.to ?? last, r.from + MAX_SECTIONS);
    const parts: string[] = [];
    let len = 0;
    for (let i = r.from; i <= to && len <= MAX_CHAPTER_CHARS; i++) {
      const section: any = book.spine.get(i);
      if (!section) break;
      try {
        const doc: any = await section.load(book.load.bind(book));
        const t = documentText(doc);
        section.unload();
        if (t) {
          parts.push(t);
          len += t.length + 2;
        }
      } catch {
        /* skip broken section */
      }
    }
    const first: any = book.spine.get(r.from);
    return finishChapter(`epub:${first?.href ?? href}`, r.label, parts.join("\n\n"));
  };
}

// ---------------- MOBI / AZW (foliate) ----------------
export function mobiChapterSource(fv: any): () => Promise<ChapterText | null> {
  let tocIdx: Promise<TocIdx[]> | null = null;
  const buildToc = async (): Promise<TocIdx[]> => {
    const out: TocIdx[] = [];
    for (const t of flattenToc(fv.book?.toc)) {
      let idx = -1;
      try {
        if (t.href) idx = Number((await fv.book.resolveHref(t.href))?.index ?? -1);
      } catch {
        /* unresolved */
      }
      out.push({ idx: Number.isFinite(idx) ? idx : -1, depth: t.depth, label: t.label });
    }
    return out;
  };
  return async () => {
    const book = fv.book;
    const index = fv.lastLocation?.index;
    if (!book || typeof index !== "number") return null;
    tocIdx ??= buildToc();
    const r = sectionRangeFor(await tocIdx, index);
    const to = Math.min(r.to ?? book.sections.length - 1, r.from + MAX_SECTIONS);
    const parts: string[] = [];
    let len = 0;
    for (let i = r.from; i <= to && len <= MAX_CHAPTER_CHARS; i++) {
      try {
        const doc: Document = await book.sections[i].createDocument();
        const t = documentText(doc);
        if (t) {
          parts.push(t);
          len += t.length + 2;
        }
      } catch {
        /* skip broken section */
      }
    }
    return finishChapter(`mobi:${r.from}`, r.label || String(fv.lastLocation?.tocItem?.label || "").trim(), parts.join("\n\n"));
  };
}
