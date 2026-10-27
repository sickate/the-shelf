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
