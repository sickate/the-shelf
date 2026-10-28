// Read-along: DOM text index, highlight, target registry and the follow controller.
//
// Adapter contract (one per format, registered by read.ts like setChapterSource):
// - setReadAlongTarget(factory): the factory gets the job's chapterKey (the one its ChapterSource
//   produced) and returns a target for that chapter, or null when it can't serve it.
// - show() finds `sentence` inside that chapter (fallback: `pieceFirstSentence`, else don't move),
//   makes it visible (scroll / page turn / load a section) and, with opts.highlight, highlights it
//   via highlightRange(doc, range). Keep a cursor (last hit) so repeats are found in order.
// - Programmatic navigation must not trigger onUserNavigate; only real user scrolls/page turns do.
// - TextIndex and highlightRange take any Node/Document, so they work inside epub/foliate iframes.
import { findSentence, normalize, sentenceAt } from "./read-along-core";
import { store } from "./common";

export interface ReadAlongTarget {
  /** 在本章内找到这句话并显示出来（必要时翻页/跨节加载），返回是否成功。 */
  show(sentence: string, pieceFirstSentence: string, opts: { highlight: boolean }): Promise<boolean>;
  clear(): void;
  /** 用户自己翻页/滚动时回调（适配器自己区分程序翻页）。 */
  onUserNavigate(cb: () => void): void;
}
export type ReadAlongTargetFactory = (chapterKey: string) => ReadAlongTarget | null;

let factory: ReadAlongTargetFactory | null = null;
export function setReadAlongTarget(fn: ReadAlongTargetFactory | null): void {
  factory = fn;
}
export function getReadAlongTarget(): ReadAlongTargetFactory | null {
  return factory;
}

// ---------------- Text index ----------------
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);

/** Normalized text of a subtree with a map back to (Text node, offset). */
export class TextIndex {
  /** Normalized text (see normalize()). */
  readonly text: string;
  /** Concatenated raw text of the indexed nodes. */
  readonly raw: string;
  private readonly map: number[];
  private readonly nodes: Text[] = [];
  private readonly starts: number[] = [];
  private readonly doc: Document;

  constructor(root: Node) {
    this.doc = (root.nodeType === 9 ? root : root.ownerDocument) as Document;
    const walker = this.doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
    let raw = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (hiddenText(n, root)) continue;
      this.nodes.push(n as Text);
      this.starts.push(raw.length);
      raw += (n as Text).data;
    }
    this.raw = raw;
    const norm = normalize(raw);
    this.text = norm.text;
    this.map = norm.map;
  }

  /** Normalized position of a raw offset (first normalized char at or after it). */
  normPos(rawOffset: number): number {
    let lo = 0;
    let hi = this.map.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.map[mid] < rawOffset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** DOM Range for normalized [start, end). */
  rangeFor(start: number, end: number): Range | null {
    if (start < 0 || end <= start || end > this.map.length) return null;
    const a = this.locate(this.map[start]);
    const b = this.locate(this.map[end - 1] + 1);
    if (!a || !b) return null;
    const r = this.doc.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }

  private locate(raw: number): { node: Text; offset: number } | null {
    let lo = 0;
    let hi = this.starts.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= raw) lo = mid;
      else hi = mid - 1;
    }
    const node = this.nodes[lo];
    return { node, offset: Math.min(raw - this.starts[lo], node.data.length) };
  }
}

function hiddenText(n: Node, root: Node): boolean {
  for (let p = n.parentNode; p && p !== root; p = p.parentNode) {
    const e = p as Element;
    if (e.nodeType !== 1) continue;
    if (SKIP.has(e.tagName.toUpperCase()) || e.hasAttribute("hidden")) return true;
    if ((e as HTMLElement).style?.display === "none") return true;
  }
  return false;
}

// ---------------- Highlight ----------------
const HL = "shelf-read-along";
const styled = new WeakSet<Document>();

/** Highlights `range` in `doc` with the CSS Custom Highlight API (no DOM mutation); null clears. */
export function highlightRange(doc: Document, range: Range | null): boolean {
  const w = doc.defaultView as any;
  const reg = w?.CSS?.highlights;
  if (!reg || typeof w.Highlight !== "function") return false;
  if (!range) {
    reg.delete(HL);
    return true;
  }
  if (!styled.has(doc)) {
    styled.add(doc);
    const st = doc.createElement("style");
    st.textContent = `::highlight(${HL}) { background-color: rgba(255, 210, 50, 0.38); }`;
    (doc.head || doc.documentElement).append(st);
  }
  reg.set(HL, new w.Highlight(range));
  return true;
}

// ---------------- Search helper shared by adapters ----------------
/**
 * Finds `sentence` (else `first`) in index.text[from, to) starting at `cursor` (normalized,
 * absolute). Returns absolute normalized [start, end) or null.
 */
export function locateIn(index: TextIndex, from: number, to: number, cursor: number, sentence: string, first: string) {
  const hay = index.text.slice(from, to);
  const rel = Math.max(0, cursor - from);
  const hit = findSentence(hay, sentence, rel) ?? (first && first !== sentence ? findSentence(hay, first, rel) : null);
  return hit ? { start: hit.start + from, end: hit.end + from } : null;
}

// ---------------- TXT / scrolling-page target ----------------
const PROGRAMMATIC_MS = 1000;

/** Target for text laid out in the main page and scrolled with the window; raw [start, end) bounds the chapter. */
export function windowTextTarget(root: HTMLElement, rawStart: number, rawEnd: number): ReadAlongTarget {
  let index: TextIndex | null = null;
  let cursor = -1;
  let lit: { start: number; end: number } | null = null;
  let progUntil = 0;
  const listeners: (() => void)[] = [];
  // Notes re-render the article: rebuild the index (same text, so positions stay) and re-highlight.
  const mo = new MutationObserver(() => {
    index = null;
    if (!lit) return;
    index = new TextIndex(root);
    highlightRange(document, index.rangeFor(lit.start, lit.end));
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true });
  const onScroll = () => {
    if (Date.now() < progUntil) return;
    for (const cb of listeners) cb();
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  return {
    async show(sentence, first, opts) {
      index ??= new TextIndex(root);
      const from = index.normPos(rawStart);
      const to = index.normPos(rawEnd);
      const hit = locateIn(index, from, to, cursor < 0 ? from : cursor, sentence, first);
      if (!hit) return false;
      cursor = hit.start;
      const range = index.rangeFor(hit.start, hit.end);
      if (!range) return false;
      lit = opts.highlight && highlightRange(document, range) ? hit : null;
      if (!lit) highlightRange(document, null);
      const r = range.getBoundingClientRect();
      const barH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--audio-h")) || 0;
      const vh = innerHeight - barH;
      const mid = (r.top + r.bottom) / 2;
      if (mid < vh / 3 || mid > (vh * 2) / 3) {
        const dy = mid - vh / 2;
        progUntil = Date.now() + PROGRAMMATIC_MS;
        // Smooth only for short hops so the scroll settles inside the programmatic window.
        window.scrollBy({ top: dy, behavior: Math.abs(dy) > vh ? "auto" : "smooth" });
      }
      return true;
    },
    clear() {
      highlightRange(document, null);
      lit = null;
      cursor = -1;
    },
    onUserNavigate(cb) {
      listeners.push(cb);
    },
  };
}

// ---------------- Controller ----------------
const FOLLOW_KEY = "shelf:read-along";

export interface AudioPosition {
  chapterKey: string;
  pieceText: string;
  offsetMs: number;
  durationMs: number;
}

export interface ReadAlong {
  update(pos: AudioPosition): void;
  readonly follow: boolean;
  setFollow(on: boolean): void;
  /** True after the user navigated away while following. */
  readonly paused: boolean;
  resume(): void;
  clear(): void;
  /** Called when follow/paused change. */
  onChange(cb: () => void): void;
}

export function createReadAlong(getFactory: () => ReadAlongTargetFactory | null = getReadAlongTarget): ReadAlong {
  let follow = store.get(FOLLOW_KEY) !== "0";
  let paused = false;
  let last: AudioPosition | null = null;
  let shownKey = "";
  let target: ReadAlongTarget | null = null;
  let targetFor = "";
  let targetFactory: ReadAlongTargetFactory | null = null;
  const hooked = new WeakSet<ReadAlongTarget>();
  let busy = false;
  let queued = false;
  const subs: (() => void)[] = [];
  const changed = () => subs.forEach((cb) => cb());

  function targetOf(key: string): ReadAlongTarget | null {
    const f = getFactory();
    if (f !== targetFactory || key !== targetFor) {
      target?.clear();
      targetFactory = f;
      targetFor = key;
      target = f ? f(key) : null;
      const mine = target;
      if (mine && !hooked.has(mine)) {
        hooked.add(mine);
        mine.onUserNavigate(() => {
          if (mine !== target || !follow || paused) return;
          paused = true;
          changed();
        });
      }
    }
    return target;
  }

  async function run() {
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    try {
      do {
        queued = false;
        const pos = last;
        if (!pos || !follow || paused) break;
        const hit = sentenceAt(pos.pieceText, pos.durationMs, pos.offsetMs);
        const t = targetOf(pos.chapterKey);
        if (!hit || !t) break;
        const key = `${pos.chapterKey}\n${pos.pieceText}\n${hit.index}`;
        if (key === shownKey) continue;
        shownKey = key;
        try {
          await t.show(hit.sentence, hit.first, { highlight: true });
        } catch {
          /* adapter failure: keep playing */
        }
      } while (queued);
    } finally {
      busy = false;
    }
  }

  return {
    update(pos) {
      last = pos;
      void run();
    },
    get follow() {
      return follow;
    },
    setFollow(on) {
      follow = on;
      store.set(FOLLOW_KEY, on ? "1" : "0");
      paused = false;
      shownKey = "";
      if (on) void run();
      else target?.clear();
      changed();
    },
    get paused() {
      return paused;
    },
    resume() {
      paused = false;
      shownKey = "";
      changed();
      void run();
    },
    clear() {
      target?.clear();
      target = null;
      targetFor = "";
      targetFactory = null;
      last = null;
      shownKey = "";
      if (paused) {
        paused = false;
        changed();
      }
    },
    onChange(cb) {
      subs.push(cb);
    },
  };
}
