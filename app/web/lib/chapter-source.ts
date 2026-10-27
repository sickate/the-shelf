export interface ChapterText { chapterKey: string; label: string; text: string; truncated: boolean }
export type ChapterSource = () => Promise<ChapterText | null>;
export const MAX_CHAPTER_CHARS = 300_000;
let source: ChapterSource | null = null;
export function setChapterSource(fn: ChapterSource | null): void { source = fn; }
export function getChapterSource(): ChapterSource | null { return source; }
