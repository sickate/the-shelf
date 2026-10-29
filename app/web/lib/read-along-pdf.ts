// Read-along adapter for PDF: page turn only (no text layer, so no highlight).
// The chapter key is `pdf:<start>-<end>` (see pdfChapterSource); we index the same pages with the same
// text extraction, so a sentence found in the concatenated text maps back to its page.
import { findNear, normalize } from "./read-along-core";
import type { ReadAlongTarget } from "./read-along";
import { parsePdfKey, pdfPageText } from "./chapter-text";

/** Reader hooks provided by read.ts. goTo must not itself count as user navigation. */
export interface PdfReaderHook {
  goTo(page: number): void;
  /** Register the callback fired when the *user* changes page (not goTo). */
  onUserPage(cb: () => void): void;
}

export interface PageIndex {
  text: string;
  /** Start offset (in `text`) of each indexed page; parallel to `pages`. */
  starts: number[];
  pages: number[];
}

export function buildPageIndex(pageTexts: { page: number; text: string }[]): PageIndex {
  let text = "";
  const starts: number[] = [];
  const pages: number[] = [];
  for (const p of pageTexts) {
    const norm = normalize(p.text).text;
    if (!norm) continue;
    starts.push(text.length);
    pages.push(p.page);
    text += norm;
  }
  return { text, starts, pages };
}

export function pageAt(idx: PageIndex, pos: number): number | null {
  if (!idx.pages.length) return null;
  let lo = 0;
  let hi = idx.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return idx.pages[lo];
}

/** Search near the cursor, then the whole chapter (findNear), and map the hit to its page. */
export function searchPage(
  idx: PageIndex,
  sentence: string,
  first: string,
  cursor: number,
): { start: number; end: number; page: number } | null {
  if (!sentence && !first) return null;
  const hit = findNear(idx.text, sentence, first, cursor);
  if (!hit) return null;
  const page = pageAt(idx, hit.start);
  return page == null ? null : { ...hit, page };
}

export function pdfReadAlongFactory(pdf: any, hook: PdfReaderHook): (key: string) => ReadAlongTarget | null {
  const cache = new Map<string, ReadAlongTarget | null>();
  const pageCache = new Map<number, Promise<string>>();
  const pageText = (n: number) => {
    let p = pageCache.get(n);
    if (!p) pageCache.set(n, (p = pdfPageText(pdf, n)));
    return p;
  };
  let navigating = false;
  let userCb: (() => void) | null = null;
  hook.onUserPage(() => {
    if (!navigating) userCb?.();
  });

  const make = (key: string): ReadAlongTarget | null => {
    const range = parsePdfKey(key);
    if (!range) return null;
    let index: Promise<PageIndex> | null = null;
    let cursor = 0;
    const getIndex = () =>
      (index ??= (async () => {
        const list: { page: number; text: string }[] = [];
        for (let n = range.start; n <= Math.min(range.end, pdf.numPages); n++) list.push({ page: n, text: await pageText(n) });
        return buildPageIndex(list);
      })());
    return {
      async show(sentence, pieceFirstSentence) {
        const idx = await getIndex();
        const hit = searchPage(idx, sentence, pieceFirstSentence, cursor);
        if (!hit) return false;
        cursor = hit.end;
        navigating = true;
        try {
          hook.goTo(hit.page);
        } finally {
          navigating = false;
        }
        return true;
      },
      async showStart() {
        cursor = 0;
        navigating = true;
        try {
          hook.goTo(range.start);
        } finally {
          navigating = false;
        }
        return true;
      },
      clear() {},
      onUserNavigate(cb) {
        userCb = cb;
      },
    };
  };
  return (key) => {
    if (!cache.has(key)) cache.set(key, make(key));
    return cache.get(key)!;
  };
}
