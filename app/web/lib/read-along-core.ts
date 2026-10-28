// Read-along: pure helpers (no DOM). Sentence splitting and timing inside an audio piece, and
// matching a cleaned sentence back to the original text (the LLM only deletes, so the cleaned
// text is a subsequence of the original after normalization).

const END = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);
const CLOSERS = new Set(["”", "’", '"', "'", "）", ")", "】", "」", "』", "》", "〕", "]", "〉"]);
const STRIP = /[\s\p{P}\p{S}\p{Cf}]/u;

/** Splits on CJK/English end punctuation and newlines; trailing quotes/brackets stay with the sentence. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const s = text || "";
  let start = 0;
  const push = (end: number) => {
    const t = s.slice(start, end).trim();
    start = end;
    if (!t) return;
    // Punctuation-only fragments (e.g. a stray "……") join the previous sentence.
    if (hasContent(t)) out.push(t);
    else if (out.length) out[out.length - 1] += t;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") {
      push(i);
      continue;
    }
    if (!END.has(c) && c !== ".") continue;
    let j = i + 1;
    while (j < s.length && (END.has(s[j]) || s[j] === ".")) j++;
    while (j < s.length && CLOSERS.has(s[j])) j++;
    // An English period ends a sentence only before whitespace or the end ("3.14" does not).
    if (c === "." && j < s.length && !/\s/.test(s[j])) continue;
    push(j);
    i = j - 1;
  }
  push(s.length);
  return out;
}

const hasContent = (t: string) => normalize(t).text.length > 0;

/** Duration weight: non-punctuation chars, Latin/digit words count 2 each (≈ measured speech rate). */
export function sentenceWeight(sentence: string): number {
  const words = sentence.normalize("NFKC").match(/[a-z0-9]+/gi)?.length ?? 0;
  const rest = normalize(sentence).text.replace(/[a-z0-9]/g, "").length;
  return Math.max(1, rest + words * 2);
}

/** Start time (ms) of each sentence within a piece of `durationMs`. */
export function sentenceStarts(sentences: string[], durationMs: number): number[] {
  const w = sentences.map(sentenceWeight);
  const total = w.reduce((a, b) => a + b, 0);
  const d = Math.max(0, durationMs || 0);
  const out: number[] = [];
  let acc = 0;
  for (const x of w) {
    out.push(total > 0 ? (d * acc) / total : 0);
    acc += x;
  }
  return out;
}

export interface SentenceHit {
  index: number;
  sentence: string;
  /** First sentence of the piece (fallback anchor). */
  first: string;
}

/** The sentence being read at `offsetMs` into a piece; null when the piece has no text. */
export function sentenceAt(pieceText: string, durationMs: number, offsetMs: number): SentenceHit | null {
  const ss = splitSentences(pieceText);
  if (!ss.length) return null;
  const starts = sentenceStarts(ss, durationMs);
  let index = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= offsetMs) index = i;
  return { index, sentence: ss[index], first: ss[0] };
}

export interface Normalized {
  text: string;
  /** map[i] = UTF-16 index in the source of normalized code unit i. */
  map: number[];
}

/** Drops whitespace/punctuation/symbols, folds fullwidth to halfwidth and lowercases, keeping an index map. */
export function normalize(s: string): Normalized {
  let text = "";
  const map: number[] = [];
  let i = 0;
  for (const raw of s) {
    let ch = raw;
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff01 && cp <= 0xff5e) ch = String.fromCharCode(cp - 0xfee0);
    if (!STRIP.test(ch)) {
      const lc = ch.toLowerCase();
      if (lc.length === ch.length) ch = lc;
      for (let k = 0; k < ch.length; k++) map.push(i + k);
      text += ch;
    }
    i += raw.length;
  }
  return { text, map };
}

const MAX_TRIES = 20;
const MIN_MATCH = 0.8;

/**
 * Locates `sentence` in a normalized haystack: its 12-char prefix searched forward from `fromPos`,
 * then the 6-char prefix, then later 6-char chunks (a deletion inside the prefix), then all of that
 * over the whole haystack. Ends come from greedy subsequence matching within 1.6× the length.
 * Returns normalized [start, end) or null.
 */
export function findSentence(haystackNorm: string, sentence: string, fromPos = 0): { start: number; end: number } | null {
  const h = haystackNorm;
  const needle = normalize(sentence).text;
  if (!needle) return null;
  const from = Math.min(Math.max(0, fromPos | 0), h.length);
  const keys: [string, number][] = [[needle.slice(0, 12), 0]];
  for (let k = 0; k < needle.length; k += 6) if (k === 0 ? needle.length > 6 : needle.length - k >= 4) keys.push([needle.slice(k, k + 6), k]);
  for (const at of from > 0 ? [from, 0] : [0]) {
    for (const [key, k] of keys) {
      let pos = h.indexOf(key, at);
      for (let n = 0; pos >= 0 && n < MAX_TRIES; n++) {
        const back = backward(h, needle, k, pos);
        const fwd = forward(h, needle, k, pos);
        if (back.matched + fwd.matched >= needle.length * MIN_MATCH && back.start >= at) return { start: back.start, end: fwd.end };
        pos = h.indexOf(key, pos + 1);
      }
    }
  }
  return null;
}

/** Greedy match of needle[k..] forward from h[pos]. */
function forward(h: string, needle: string, k: number, pos: number): { matched: number; end: number } {
  const limit = Math.min(h.length, pos + Math.ceil((needle.length - k) * 1.6));
  let j = k;
  let end = pos;
  for (let p = pos; p < limit && j < needle.length; p++) {
    if (h[p] === needle[j]) {
      j++;
      end = p + 1;
    }
  }
  return { matched: j - k, end };
}

/** Greedy match of needle[..k) backward from just before h[pos]. */
function backward(h: string, needle: string, k: number, pos: number): { matched: number; start: number } {
  const limit = Math.max(0, pos - Math.ceil(k * 1.6));
  let j = k - 1;
  let start = pos;
  for (let p = pos - 1; p >= limit && j >= 0; p--) {
    if (h[p] === needle[j]) {
      j--;
      start = p;
    }
  }
  return { matched: k - 1 - j, start };
}

/** Normalized chars after the cursor searched before falling back to the whole chapter. */
export const NEAR_CHARS = 1500;

/**
 * Cursor-aware lookup: `sentence` (else `first`) within NEAR_CHARS after `cursor`, then over the
 * whole haystack from its start — so a backward seek or a short sentence never jumps to a far
 * later duplicate.
 */
export function findNear(hay: string, sentence: string, first: string, cursor: number, near = NEAR_CHARS) {
  const rel = Math.min(Math.max(0, cursor | 0), hay.length);
  const one = (s: string) => {
    // Let the end match run past the window edge; only the start must fall inside it.
    const win = hay.slice(rel, rel + near + Math.ceil(normalize(s).text.length * 1.6));
    const a = findSentence(win, s, 0);
    if (a && a.start < near) return { start: a.start + rel, end: a.end + rel };
    return findSentence(hay, s, 0);
  };
  return one(sentence) ?? (first && first !== sentence ? one(first) : null);
}
