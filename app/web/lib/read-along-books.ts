// Read-along targets for sectioned books rendered in iframes: EPUB (epub.js) and MOBI/AZW3
// (foliate-js). Both follow the contract in read-along.ts; the format-specific parts sit behind a
// small SectionHost so the search / reveal / highlight logic is shared.
//
// A chapter (as named by the chapter key the chapter source produced) spans sections
// [from, to]. Search runs in reading order from the cursor (section, normalized pos): the rest of
// the cursor's section, then later sections, then earlier ones, then the start of the cursor's
// section; the piece's first sentence is only tried after the whole chapter failed for the
// sentence itself. Sections not on screen are loaded off-screen (cached) to search them and to
// compute the CFI used to navigate; the hit is then re-found in the rendered document (same text)
// and highlighted there.
import { MAX_CHAPTER_CHARS } from "./chapter-source";
import { chapterSpan, epubLastIndex, epubTocIdx, mobiTocIdx, type TocIdx } from "./chapter-text";
import { highlightRange, locateIn, TextIndex, type ReadAlongTarget, type ReadAlongTargetFactory } from "./read-along";

// ---------------- pure helpers (tested) ----------------
export interface Cursor {
  section: number;
  pos: number;
}
export interface SearchStep {
  section: number;
  /** Normalized position in that section's text where the search window starts (no wrap before it). */
  start: number;
}

/** Search order over sections [from, to] starting at `cursor` (null: from the start of `from`). */
export function searchPlan(from: number, to: number, cursor: Cursor | null): SearchStep[] {
  if (!(to >= from)) return [];
  const c = cursor && cursor.section >= from && cursor.section <= to ? cursor : null;
  const s0 = c ? c.section : from;
  const pos = c ? Math.max(0, c.pos) : 0;
  const steps: SearchStep[] = [{ section: s0, start: pos }];
  for (let i = s0 + 1; i <= to; i++) steps.push({ section: i, start: 0 });
  for (let i = from; i < s0; i++) steps.push({ section: i, start: 0 });
  if (pos > 0) steps.push({ section: s0, start: 0 });
  return steps;
}

/**
 * Last section worth searching: the chapter source stops reading once it has more than
 * MAX_CHAPTER_CHARS, so sections after that point can't hold piece text. `sizes` holds known
 * normalized lengths (≤ the source's text lengths, so the bound is never too tight); unknown
 * sections end the known prefix.
 */
export function spanEnd(from: number, to: number, sizes: Map<number, number>, max = MAX_CHAPTER_CHARS): number {
  let len = 0;
  for (let i = from; i <= to; i++) {
    const n = sizes.get(i);
    if (n === undefined) return to;
    if (len > max) return i - 1;
    if (n) len += n + 2;
  }
  return to;
}

export interface TextLike {
  readonly text: string;
}
export interface Found<T> {
  section: number;
  index: T;
  start: number;
  end: number;
}

/** Runs the search plan: `sentence` over the whole chapter first, then `first`. */
export async function findInSections<T extends TextLike>(
  steps: SearchStep[],
  indexOf: (section: number) => Promise<T | null>,
  sentence: string,
  first: string,
  bound: () => number = () => Infinity,
): Promise<Found<T> | null> {
  const needles = first && first !== sentence ? [sentence, first] : [sentence];
  for (const needle of needles) {
    if (!needle) continue;
    for (const st of steps) {
      if (st.section > bound()) continue;
      const index = await indexOf(st.section);
      if (!index || st.start >= index.text.length) continue;
      const hit = locateIn(index as any, st.start, index.text.length, st.start, needle, "");
      if (hit) return { section: st.section, index, start: hit.start, end: hit.end };
    }
  }
  return null;
}

/** Where `sub` (normalized hit text found at `near` in an equal copy) sits in `text`. */
export function refind(text: string, sub: string, near: number): number {
  if (!sub) return -1;
  if (text.startsWith(sub, near)) return near;
  const after = text.indexOf(sub, Math.max(0, near - 200));
  return after >= 0 ? after : text.indexOf(sub);
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** True when rect (in iframe coordinates, shifted by the frame's offset) starts inside `view`. */
export function startVisible(rect: Box, offset: { left: number; top: number }, view: Box): boolean {
  if (rect.right - rect.left <= 0 && rect.bottom - rect.top <= 0) return false;
  const x = rect.left + offset.left + Math.min(2, (rect.right - rect.left) / 2);
  const top = rect.top + offset.top;
  const bottom = rect.bottom + offset.top;
  return x >= view.left && x < view.right && top >= view.top - 1 && bottom <= view.bottom + 1;
}

// ---------------- shared target ----------------
interface Shown {
  section: number;
  doc: Document;
}

/** What a renderer has to provide. */
export interface SectionHost {
  /** Inclusive section span of the chapter key, or null when the key isn't this book's. */
  span(): Promise<{ from: number; to: number } | null>;
  /** Section documents currently rendered. */
  rendered(): Shown[];
  /** Off-screen copy of a section (same text as the rendered one). */
  load(section: number): Promise<Document | null>;
  /** CFI of a range inside (any copy of) a section. */
  cfi(section: number, range: Range): string | null;
  display(cfi: string): Promise<void>;
  /** Visible reading area in top-level page coordinates. */
  viewport(): Box | null;
  /** A section document was (re-)rendered. */
  onRendered(cb: (section: number, doc: Document) => void): void;
  /** Relocation; `maybeUser` false for relocations that are certainly layout-only. */
  onRelocate(cb: (maybeUser: boolean) => void): void;
}

const PROGRAMMATIC_MS = 1000;
const indexRoot = (doc: Document): Node => doc.body ?? doc.getElementsByTagName("body")[0] ?? doc.documentElement;

function frameOffset(doc: Document): { left: number; top: number } {
  try {
    const fe = doc.defaultView?.frameElement as Element | null;
    if (fe) {
      const r = fe.getBoundingClientRect();
      return { left: r.left, top: r.top };
    }
  } catch {
    /* cross-origin: assume no offset */
  }
  return { left: 0, top: 0 };
}

export function sectionTarget(host: SectionHost): ReadAlongTarget {
  let span: { from: number; to: number } | null | undefined;
  const offscreen = new Map<number, Promise<TextIndex | null>>();
  const sizes = new Map<number, number>();
  const renderedIdx = new WeakMap<Document, TextIndex>();
  let cursor: Cursor | null = null;
  let lit: { section: number; sub: string; pos: number; doc: Document } | null = null;
  let gen = 0;
  let navigating = 0;
  let progUntil = 0;
  const listeners: (() => void)[] = [];

  const indexOfDoc = (doc: Document): TextIndex => {
    let ix = renderedIdx.get(doc);
    if (!ix) {
      ix = new TextIndex(indexRoot(doc));
      renderedIdx.set(doc, ix);
    }
    return ix;
  };
  const shownDoc = (section: number): Document | null => {
    try {
      return host.rendered().find((s) => s.section === section)?.doc ?? null;
    } catch {
      return null;
    }
  };
  const indexOf = async (section: number): Promise<TextIndex | null> => {
    const doc = shownDoc(section);
    if (doc) {
      const ix = indexOfDoc(doc);
      sizes.set(section, ix.text.length);
      return ix;
    }
    let p = offscreen.get(section);
    if (!p) {
      p = host
        .load(section)
        .then((d) => (d ? new TextIndex(indexRoot(d)) : null))
        .catch(() => null);
      offscreen.set(section, p);
    }
    const ix = await p;
    if (ix) sizes.set(section, ix.text.length);
    return ix;
  };

  const paint = (doc: Document, range: Range | null) => {
    try {
      return highlightRange(doc, range);
    } catch {
      return false;
    }
  };
  const unpaint = () => {
    if (lit) paint(lit.doc, null);
    lit = null;
  };
  /** Range of normalized `sub` near `pos` in a rendered document. */
  const rangeIn = (doc: Document, sub: string, pos: number): Range | null => {
    const ix = indexOfDoc(doc);
    const at = refind(ix.text, sub, pos);
    return at < 0 ? null : ix.rangeFor(at, at + sub.length);
  };
  const visible = (doc: Document, range: Range): boolean => {
    const view = host.viewport();
    if (!view) return true;
    const rects = range.getClientRects();
    const r = rects.length ? rects[0] : range.getBoundingClientRect();
    return startVisible(r, frameOffset(doc), view);
  };
  const navigate = async (cfi: string | null) => {
    if (!cfi) return;
    navigating++;
    progUntil = Date.now() + PROGRAMMATIC_MS;
    try {
      await host.display(cfi);
    } finally {
      navigating--;
      progUntil = Date.now() + PROGRAMMATIC_MS;
    }
  };

  host.onRendered((section, doc) => {
    if (!lit || lit.section !== section || !doc) return;
    try {
      const range = rangeIn(doc, lit.sub, lit.pos);
      if (range && paint(doc, range)) lit.doc = doc;
    } catch {
      /* keep playing */
    }
  });
  host.onRelocate((maybeUser) => {
    if (!maybeUser || navigating > 0 || Date.now() < progUntil) return;
    for (const cb of listeners) cb();
  });

  async function show(sentence: string, first: string, opts: { highlight: boolean }): Promise<boolean> {
    const my = ++gen;
    if (span === undefined) span = await host.span();
    if (!span || my !== gen) return false;
    const { from, to } = span;
    let start = cursor;
    if (!start) {
      const shown = host.rendered().find((s) => s.section >= from && s.section <= to);
      if (shown) start = { section: shown.section, pos: 0 };
    }
    const found = await findInSections(searchPlan(from, to, start), indexOf, sentence, first, () => spanEnd(from, to, sizes));
    if (!found || my !== gen) return false;
    cursor = { section: found.section, pos: found.start };
    const sub = found.index.text.slice(found.start, found.end);

    let doc = shownDoc(found.section);
    let range = doc ? rangeIn(doc, sub, found.start) : null;
    if (!doc || !range || !visible(doc, range)) {
      const src = range ?? found.index.rangeFor(found.start, found.end);
      if (!src) return false;
      await navigate(host.cfi(found.section, src));
      if (my !== gen) return false;
      doc = shownDoc(found.section);
      range = doc ? rangeIn(doc, sub, found.start) : null;
      if (!doc || !range) return false;
    }
    unpaint();
    if (opts.highlight && paint(doc, range)) lit = { section: found.section, sub, pos: found.start, doc };
    return true;
  }

  return {
    async show(sentence, first, opts) {
      try {
        return await show(sentence, first, opts);
      } catch {
        return false;
      }
    },
    clear() {
      gen++;
      unpaint();
      cursor = null;
    },
    onUserNavigate(cb) {
      listeners.push(cb);
    },
  };
}

/** One cached target per chapter key; keys the book can't map give null. */
function keyedFactory(make: (key: string) => ReadAlongTarget | null): ReadAlongTargetFactory {
  const cache = new Map<string, ReadAlongTarget | null>();
  return (key) => {
    if (!cache.has(key)) {
      let t: ReadAlongTarget | null = null;
      try {
        t = make(key);
      } catch {
        t = null;
      }
      cache.set(key, t);
    }
    return cache.get(key) ?? null;
  };
}

/** Fan-out of renderer events, so per-chapter targets don't each add listeners to the reader. */
function hub<A extends unknown[]>() {
  const subs: ((...a: A) => void)[] = [];
  return {
    on: (cb: (...a: A) => void) => void subs.push(cb),
    emit: (...a: A) => {
      for (const cb of subs) {
        try {
          cb(...a);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function spanFrom(toc: Promise<TocIdx[]>, from: number, last: number) {
  return toc.then(
    (t) => {
      const s = chapterSpan(t, from, last);
      return s.from === from ? { from, to: Math.max(from, s.to) } : { from, to: from };
    },
    () => ({ from, to: from }),
  );
}

// ---------------- EPUB (epub.js) ----------------
/** `rendition`/`book` from epub.js; `area` is the element the rendition was rendered into. */
export function epubReadAlong(book: any, rendition: any, area: HTMLElement): ReadAlongTargetFactory {
  let toc: Promise<TocIdx[]> | null = null;
  const rendered = hub<[number, Document]>();
  const relocated = hub<[boolean]>();
  rendition.on("rendered", (section: any, view: any) => {
    const doc = view?.document ?? view?.contents?.document;
    if (doc && typeof section?.index === "number") rendered.emit(section.index, doc);
  });
  rendition.on("relocated", () => relocated.emit(true));

  return keyedFactory((key) => {
    if (!key.startsWith("epub:")) return null;
    const first: any = book.spine.get(key.slice(5));
    if (!first || typeof first.index !== "number") return null;
    const from: number = first.index;
    return sectionTarget({
      span: () => {
        toc ??= epubTocIdx(book);
        return spanFrom(toc, from, epubLastIndex(book, from));
      },
      rendered: () =>
        ((rendition.getContents?.() ?? []) as any[])
          .filter((c) => c?.document && typeof c.sectionIndex === "number")
          .map((c) => ({ section: c.sectionIndex as number, doc: c.document as Document })),
      async load(i) {
        const section: any = book.spine.get(i);
        if (!section) return null;
        const root: any = await section.load(book.load.bind(book));
        // Left loaded: unloading could race epub.js rendering the same section.
        return (root?.ownerDocument ?? section.document ?? null) as Document | null;
      },
      cfi: (i, range) => book.spine.get(i)?.cfiFromRange(range) ?? null,
      display: async (cfi) => {
        await rendition.display(cfi);
      },
      viewport: () => (rendition.manager?.container ?? area).getBoundingClientRect(),
      onRendered: rendered.on,
      onRelocate: relocated.on,
    });
  });
}

// ---------------- MOBI / AZW3 (foliate-js <foliate-view>) ----------------
// Paginator relocation reasons: "page"/"snap"/"scroll" come from the user, "navigation" from goTo
// (ours or the TOC), "anchor" from a re-layout keeping its place, "selection" from selecting text.
const LAYOUT_ONLY = new Set(["anchor"]);

export function mobiReadAlong(fv: any): ReadAlongTargetFactory {
  let toc: Promise<TocIdx[]> | null = null;
  const rendered = hub<[number, Document]>();
  const relocated = hub<[boolean]>();
  fv.addEventListener("load", (ev: CustomEvent) => {
    const { doc, index } = ev.detail || {};
    if (doc && typeof index === "number") rendered.emit(index, doc);
  });
  // The renderer's own event still carries `reason` (the view's re-dispatch drops it).
  (fv.renderer ?? fv).addEventListener("relocate", (ev: CustomEvent) =>
    relocated.emit(!LAYOUT_ONLY.has(String(ev.detail?.reason ?? ""))),
  );

  return keyedFactory((key) => {
    const m = /^mobi:(\d+)$/.exec(key);
    if (!m) return null;
    const from = Number(m[1]);
    const sections = (): any[] => fv.book?.sections ?? [];
    if (from >= sections().length) return null;
    return sectionTarget({
      span: () => {
        toc ??= mobiTocIdx(fv);
        return spanFrom(toc, from, sections().length - 1);
      },
      rendered: () =>
        ((fv.renderer?.getContents?.() ?? []) as any[])
          .filter((c) => c?.doc && typeof c.index === "number")
          .map((c) => ({ section: c.index as number, doc: c.doc as Document })),
      async load(i) {
        const s = sections()[i];
        return s?.createDocument ? ((await s.createDocument()) as Document) : null;
      },
      cfi: (i, range) => fv.getCFI(i, range) ?? null,
      display: async (cfi) => {
        await fv.goTo(cfi);
      },
      viewport: () => fv.getBoundingClientRect(),
      onRendered: rendered.on,
      onRelocate: relocated.on,
    });
  });
}
