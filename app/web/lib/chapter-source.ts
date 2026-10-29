// Contract between the reader (which knows how to extract the current chapter's text) and the
// read-aloud player (which consumes it). The reader registers a source once it is ready.
export interface ChapterText {
  /** Stable id of the chapter, ≤ 500 bytes UTF-8. */
  chapterKey: string;
  /** Human-readable chapter title, e.g. "第三章 xxx" or "第 12–30 页". */
  label: string;
  /** Normalized plain text (paragraphs separated by "\n\n"). */
  text: string;
  /** True if clipped to MAX_CHAPTER_CHARS. */
  truncated: boolean;
}
/** Resolves to null when there is no readable text (scanned PDF, comic, empty). */
export type ChapterSource = () => Promise<ChapterText | null>;
export const MAX_CHAPTER_CHARS = 300_000;

let current: ChapterSource | null = null;
export function setChapterSource(fn: ChapterSource | null): void {
  current = fn;
}
export function getChapterSource(): ChapterSource | null {
  return current;
}

/**
 * Chapter navigation for continuous playback and "follow chapter", registered next to the source.
 * Keys are chapterKeys the source produces; keys of another book/format give null.
 */
export interface ChapterNav {
  /** Cheap check (no text extraction): is the reader's current position inside chapter `chapterKey`? null = unknown. */
  contains(chapterKey: string): Promise<boolean | null>;
  /** The chapter right after `chapterKey` (chapters without text are skipped); null at the end of the book. */
  next(chapterKey: string): Promise<ChapterText | null>;
}

let nav: ChapterNav | null = null;
export function setChapterNav(n: ChapterNav | null): void {
  nav = n;
}
export function getChapterNav(): ChapterNav | null {
  return nav;
}
