/** Pure timeline logic: a segment is an ordered list of pieces stitched into one timeline. */
export interface TimelinePiece { seq: number; durationMs: number | null; ready: boolean }
export interface TimelineSegment { index: number; durationMs?: number | null; pieces: TimelinePiece[] }

const dur = (p: TimelinePiece) => (p.durationMs && p.durationMs > 0 ? p.durationMs : 0);

/** Cumulative start offsets (ms) of each piece; length = pieces.length. */
export function pieceOffsets(seg: TimelineSegment): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const p of seg.pieces) {
    out.push(acc);
    acc += dur(p);
  }
  return out;
}

/** Total duration of the stitched segment (unknown durations count as 0). */
export function totalMs(seg: TimelineSegment): number {
  return seg.pieces.reduce((a, p) => a + dur(p), 0);
}

/** Index of the first not-ready piece, or -1 when all are ready. */
export function firstNotReady(seg: TimelineSegment): number {
  return seg.pieces.findIndex((p) => !p.ready);
}

/** Playable end of the timeline: the start of the first not-ready piece, or the total. */
export function readyEndMs(seg: TimelineSegment): number {
  const i = firstNotReady(seg);
  return i < 0 ? totalMs(seg) : pieceOffsets(seg)[i];
}

export function isFullyReady(seg: TimelineSegment): boolean {
  return seg.pieces.length > 0 && seg.pieces.every((p) => p.ready);
}

/**
 * Maps a time to a piece and offset within it. Times beyond the ready part clamp to the ready
 * end (the end of the last ready piece). Null when the first piece is not ready.
 */
export function locate(seg: TimelineSegment, tMs: number): { pieceIndex: number; offsetMs: number } | null {
  const ready = firstNotReady(seg) < 0 ? seg.pieces.length : firstNotReady(seg);
  if (ready === 0) return null;
  const end = readyEndMs(seg);
  const t = Math.min(Math.max(0, Number.isFinite(tMs) ? tMs : 0), end);
  const offs = pieceOffsets(seg);
  for (let i = 0; i < ready; i++) {
    if (t < offs[i] + dur(seg.pieces[i])) return { pieceIndex: i, offsetMs: t - offs[i] };
  }
  const last = ready - 1;
  return { pieceIndex: last, offsetMs: dur(seg.pieces[last]) };
}

/** Absolute time for a position inside a piece. */
export function timeOf(seg: TimelineSegment, pieceIndex: number, offsetMs: number): number {
  return (pieceOffsets(seg)[pieceIndex] ?? 0) + offsetMs;
}

export function nextSegment(segs: TimelineSegment[], cur: number): number | null {
  return cur + 1 < segs.length ? cur + 1 : null;
}
export function prevSegment(_segs: TimelineSegment[], cur: number): number | null {
  return cur > 0 ? cur - 1 : null;
}

/** mm:ss, or h:mm:ss from one hour up. */
export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

/** Generation percentage 0..100. */
export function progressPct(done: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}
