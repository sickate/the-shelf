// DOM-free helpers for reader notes (docs/notes-plan-2026-10-26.md, N2): locator shapes,
// offset <-> chunk mapping (TXT text nodes, PDF text-layer items), highlight segments and labels.
// Tested by tests/mvp-reader-notes.test.mjs.

export type NoteColor = "yellow" | "green" | "blue" | "pink";
export const NOTE_COLORS: { value: NoteColor; name: string }[] = [
  { value: "yellow", name: "黄色" },
  { value: "green", name: "绿色" },
  { value: "blue", name: "蓝色" },
  { value: "pink", name: "粉色" },
];
/** Concrete fills for highlights drawn as SVG (EPUB/MOBI), where CSS variables do not apply. */
export const HL_HEX: Record<NoteColor, string> = { yellow: "#e9c13f", green: "#6aa96f", blue: "#5b8fd0", pink: "#d9739a" };

/** Server limits (app/worker.mjs). Quote/note/label are counted in code points there. */
export const MAX_QUOTE = 4000;
export const MAX_NOTE = 10000;
export const MAX_LABEL = 200;

export type Locator =
  | { type: "cfi"; cfi: string }
  // `endPage` (> page): from `start` on `page` to `end` on `endPage` (a note running over a page turn).
  | { type: "pdf"; page: number; start?: number; end?: number; endPage?: number }
  | { type: "text"; start: number; end: number };

export const isColor = (v: unknown): v is NoteColor => v === "yellow" || v === "green" || v === "blue" || v === "pink";
export const chars = (s: string) => [...s].length;

const isIndex = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Validates a stored locator with exactly the shapes the server accepts; anything else is null. */
export function parseLocator(raw: unknown): Locator | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const only = (...keys: string[]) => Object.keys(r).every((k) => keys.includes(k));
  if (r.type === "cfi" && only("type", "cfi")) {
    return typeof r.cfi === "string" && r.cfi.trim() ? { type: "cfi", cfi: r.cfi } : null;
  }
  if (r.type === "pdf" && only("type", "page", "start", "end", "endPage")) {
    if (!Number.isSafeInteger(r.page) || (r.page as number) < 1) return null;
    const loc: Locator = { type: "pdf", page: r.page as number };
    if (r.start !== undefined) {
      if (!isIndex(r.start)) return null;
      loc.start = r.start;
    }
    if (r.end !== undefined) {
      if (!isIndex(r.end)) return null;
      loc.end = r.end;
    }
    if (r.endPage !== undefined) {
      if (!Number.isSafeInteger(r.endPage) || (r.endPage as number) <= loc.page) return null;
      if (loc.start === undefined || loc.end === undefined) return null;
      loc.endPage = r.endPage as number;
    } else if (loc.start !== undefined && loc.end !== undefined && loc.end < loc.start) return null;
    return loc;
  }
  if (r.type === "text" && only("type", "start", "end")) {
    if (!isIndex(r.start) || !isIndex(r.end) || r.end < r.start) return null;
    return { type: "text", start: r.start, end: r.end };
  }
  return null;
}

// ---------------- Labels ----------------
const cut = (s: string, n: number) => {
  const a = [...s];
  return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s;
};

/** "约 N%" for a 0..1 fraction; null when unknown. */
export function percentLabel(fraction: unknown): string | null {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  return `约 ${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

export const pageLabel = (page: number) => `第 ${page} 页`;
export const pagesLabel = (page: number, endPage?: number) => (endPage && endPage > page ? `第 ${page}–${endPage} 页` : pageLabel(page));

/** Chapter title (whitespace collapsed, ≤ 200 chars) or, without one, the percentage. */
export function chapterLabel(title: unknown, fraction?: unknown): string | null {
  const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  return t ? cut(t, MAX_LABEL) : percentLabel(fraction);
}

/** One-line preview of a quote/note for lists and dialogs. */
export function excerpt(s: string, n = 80): string {
  return cut(s.replace(/\s+/g, " ").trim(), n);
}

/** Trimmed quote and why it cannot be saved (null = ok). */
export function checkQuote(raw: string): { quote: string; error: string | null } {
  const quote = raw.trim();
  if (!quote) return { quote, error: "bad_quote" };
  if (chars(quote) > MAX_QUOTE) return { quote, error: "quote_too_long" };
  return { quote, error: null };
}

/** Shrinks [start, end) of `text` past leading/trailing whitespace (the server trims quotes). */
export function trimSpan(text: string, start: number, end: number): { start: number; end: number } {
  let a = Math.max(0, start);
  let b = Math.min(text.length, end);
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return { start: a, end: b };
}

// ---------------- Offsets over chunks ----------------
/** [0, l0, l0+l1, …]: start offset of each chunk plus the total at the end. */
export function prefixSums(lengths: number[]): number[] {
  const out = [0];
  for (const l of lengths) out.push(out[out.length - 1] + l);
  return out;
}

/**
 * Chunk holding a global offset. At a boundary between chunks, `bias: "start"` picks the
 * chunk that begins there (for a range start) and `"end"` the one that ends there.
 * Offsets are clamped to [0, total]; returns null when there are no chunks.
 */
export function locateOffset(sums: number[], offset: number, bias: "start" | "end" = "start"): { index: number; offset: number } | null {
  const n = sums.length - 1;
  if (n < 1) return null;
  const total = sums[n];
  const off = Math.min(Math.max(0, offset), total);
  // Last chunk whose start <= off (or < off for end bias), skipping empty chunks.
  let lo = 0;
  let hi = n - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ok = bias === "start" ? sums[mid] <= off : sums[mid] < off;
    if (ok) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  let index = found;
  if (bias === "start") {
    while (index < n - 1 && sums[index + 1] === sums[index]) index++; // empty chunk: next one
    if (off === total) index = lastNonEmpty(sums, n);
  }
  return { index, offset: off - sums[index] };
}

function lastNonEmpty(sums: number[], n: number) {
  for (let i = n - 1; i >= 0; i--) if (sums[i + 1] > sums[i]) return i;
  return n - 1;
}

/** Per-chunk slices covered by [start, end): `{ index, from, to }` with chunk-local offsets. */
export function sliceRanges(sums: number[], start: number, end: number): { index: number; from: number; to: number }[] {
  const out: { index: number; from: number; to: number }[] = [];
  const n = sums.length - 1;
  const a = Math.max(0, start);
  const b = Math.min(end, n >= 0 ? sums[n] : 0);
  if (b <= a) return out;
  const first = locateOffset(sums, a, "start");
  if (!first) return out;
  for (let i = first.index; i < n && sums[i] < b; i++) {
    const from = Math.max(a, sums[i]) - sums[i];
    const to = Math.min(b, sums[i + 1]) - sums[i];
    if (to > from) out.push({ index: i, from, to });
  }
  return out;
}

/**
 * Splits [0, length) at every highlight boundary. Each segment lists the ids covering it
 * (input order, so the last id is drawn on top). Ranges are clamped; empty ones dropped.
 */
export function segments(length: number, marks: { id: string; start: number; end: number }[]): { start: number; end: number; ids: string[] }[] {
  const valid = marks
    .map((m) => ({ id: m.id, start: Math.max(0, m.start), end: Math.min(length, m.end) }))
    .filter((m) => m.end > m.start);
  const cuts = new Set<number>([0, length]);
  for (const m of valid) {
    cuts.add(m.start);
    cuts.add(m.end);
  }
  const points = [...cuts].sort((x, y) => x - y);
  const out: { start: number; end: number; ids: string[] }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const ids = valid.filter((m) => m.start <= start && m.end >= end).map((m) => m.id);
    const prev = out[out.length - 1];
    // Merge neighbours with the same cover (keeps plain text in as few nodes as possible).
    if (prev && prev.end === start && prev.ids.join("\0") === ids.join("\0")) prev.end = end;
    else out.push({ start, end, ids });
  }
  return out;
}

// ---------------- Merging adjacent notes (docs/notes-merge-plan-2026-10-31.md) ----------------
/** Page-turn tolerance: up to this many non-blank chars (running header/footer, page number) may sit between two parts. */
export const PAGE_EDGE_SLACK = 40;

export const gapIsBlank = (s: string) => !/\S/.test(s);
const nonBlank = (s: string) => chars(s.replace(/\s+/g, ""));
// CJK, kana, fullwidth forms and CJK/general punctuation join without a space.
const WIDE = /[‐-⁯⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/;

/** Joins two quotes at a page turn: whitespace at the seam dropped, one space only between Latin-like text. */
export function joinQuotes(a: string, b: string): string {
  const x = a.replace(/\s+$/, "");
  const y = b.replace(/^\s+/, "");
  if (!x || !y) return x + y;
  return WIDE.test(x.at(-1)!) || WIDE.test(y[0]) ? x + y : `${x} ${y}`;
}

/** Note texts of two merged notes, separated by a blank line; null when both are empty. */
export function joinNoteTexts(a: string | null | undefined, b: string | null | undefined): string | null {
  const parts = [a, b].map((s) => (s || "").trim()).filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

/** The merged quote, or null when it would exceed the server limit. */
export const fitQuote = (q: string) => (chars(q.trim()) <= MAX_QUOTE ? q.trim() : null);

/** [start, end) union of two text spans whose gap is blank (either order); null when apart or overlapping. */
export function joinTextSpans(
  text: string,
  a: { start: number; end: number },
  b: { start: number; end: number },
): { start: number; end: number } | null {
  const [x, y] = a.start <= b.start ? [a, b] : [b, a];
  if (x.end > y.start || !gapIsBlank(text.slice(x.end, y.start))) return null;
  return { start: x.start, end: Math.max(x.end, y.end) };
}

export type PdfSpan = { page: number; start: number; end: number; endPage?: number };
const lastPage = (s: PdfSpan) => s.endPage ?? s.page;

/**
 * Union of two PDF spans when one directly follows the other: on the same page with only
 * blank text between, or over a page turn with at most PAGE_EDGE_SLACK non-blank chars after
 * the first part on its page and before the second on the next. `pageText(p)` is the page's
 * text as the offsets index it (undefined = unknown, then nothing is merged).
 */
export function joinPdfSpans(a: PdfSpan, b: PdfSpan, pageText: (page: number) => string | undefined): PdfSpan | null {
  const [x, y] = a.page < b.page || (a.page === b.page && a.start <= b.start) ? [a, b] : [b, a];
  const xEnd = lastPage(x);
  if (y.page === xEnd) {
    const t = pageText(xEnd);
    if (t === undefined || x.end > y.start || !gapIsBlank(t.slice(x.end, y.start))) return null;
  } else if (y.page === xEnd + 1) {
    const tail = pageText(xEnd);
    const head = pageText(y.page);
    if (tail === undefined || head === undefined) return null;
    if (nonBlank(tail.slice(x.end)) > PAGE_EDGE_SLACK || nonBlank(head.slice(0, y.start)) > PAGE_EDGE_SLACK) return null;
  } else return null;
  const endPage = lastPage(y);
  const out: PdfSpan = { page: x.page, start: x.start, end: y.end };
  if (endPage > x.page) out.endPage = endPage;
  return out;
}

/** Offsets of a PDF locator on one page (the whole page in the middle of a multi-page note); null when not on it. */
export function pdfPageSpan(loc: { page: number; start?: number; end?: number; endPage?: number }, page: number, pageLength: number): { start: number; end: number } | null {
  if (loc.start === undefined || loc.end === undefined) return null;
  const last = loc.endPage ?? loc.page;
  if (page < loc.page || page > last) return null;
  const start = page === loc.page ? loc.start : 0;
  const end = page === last ? loc.end : pageLength;
  return end > start ? { start, end } : null;
}

// ---------------- Ordering ----------------
/** Numeric path of an EPUB CFI (assertions dropped; range = parent + start) for document order. */
export function cfiKey(cfi: string): number[] {
  const body = cfi.replace(/^epubcfi\(/, "").replace(/\)$/, "").replace(/\[[^\]]*\]/g, "");
  const [parent = "", start = ""] = body.split(",");
  return (parent + start).match(/\d+/g)?.map(Number) ?? [];
}

const cmpNums = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

/** Reading order for locators of one book; unknown/mixed shapes compare equal (stable sort keeps creation order). */
export function compareLocators(a: Locator | null, b: Locator | null): number {
  if (!a || !b || a.type !== b.type) return 0;
  if (a.type === "pdf" && b.type === "pdf") return a.page - b.page || (a.start ?? 0) - (b.start ?? 0);
  if (a.type === "text" && b.type === "text") return a.start - b.start || a.end - b.end;
  if (a.type === "cfi" && b.type === "cfi") return cmpNums(cfiKey(a.cfi), cfiKey(b.cfi));
  return 0;
}
