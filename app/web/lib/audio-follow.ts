// Pure decisions for the read-aloud player: poll backoff, piece retries, remaining time, next-chapter
// prefetch and the "follow chapter" debounce. No DOM; tested in tests/mvp-audio-follow.test.mjs.
import { locate, type TimelinePiece, type TimelineSegment } from "./audio-timeline";

// ---------- Job polling ----------
export const POLL_MS = 3000;
export const MAX_POLL_MS = 30_000;
/** Consecutive poll failures before a (soft) note is shown. */
export const POLL_NOTE_AFTER = 3;

/** Delay before the next poll after `failures` consecutive failures: 3 s, then 3, 6, 12, 24, 30, 30 … */
export function pollDelay(failures: number): number {
  if (!(failures > 0)) return POLL_MS;
  return Math.min(MAX_POLL_MS, POLL_MS * 2 ** Math.min(failures - 1, 10));
}

/**
 * Whether to show the "connection unstable" note: only after POLL_NOTE_AFTER failures, and never
 * while audio plays fine — unless playback is stuck waiting for a piece the poll would reveal.
 */
export function pollNoteVisible(failures: number, playing: boolean, waiting: boolean): boolean {
  return failures >= POLL_NOTE_AFTER && (!playing || waiting);
}

// ---------- Piece loading ----------
/** Automatic reloads of the same piece before an error is shown. */
export const PIECE_RETRIES = 2;
export const pieceRetryDelay = (attempt: number) => 1000 * Math.max(1, attempt);

/** Piece URL for retry `attempt` (≥ 1 adds a cache-buster; blob:/data: URLs are left alone). */
export function retryUrl(url: string, attempt: number): string {
  if (!(attempt > 0) || /^(blob|data):/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;
}

// ---------- Remaining time / prefetch ----------
/** Prefetch the next chapter when this much playback (or less) is left. */
export const PREFETCH_MS = 5 * 60_000;

/** Estimated duration of pieces with unknown length: the mean of known ones (else `fallback`). */
export function unknownPieceMs(segments: TimelineSegment[], fallback = 20_000): number {
  let sum = 0;
  let n = 0;
  for (const s of segments)
    for (const p of s.pieces)
      if (p.durationMs && p.durationMs > 0) {
        sum += p.durationMs;
        n++;
      }
  return n ? sum / n : fallback;
}

/** Playback left in the job from `posMs` within segment `segPos` (unknown piece lengths estimated). */
export function remainingMs(segments: TimelineSegment[], segPos: number, posMs: number): number {
  const est = unknownPieceMs(segments);
  const d = (p: { durationMs: number | null }) => (p.durationMs && p.durationMs > 0 ? p.durationMs : est);
  let left = 0;
  for (let i = Math.max(0, segPos); i < segments.length; i++) {
    for (const p of segments[i].pieces) left += d(p);
    if (i === segPos) left -= Math.max(0, posMs);
  }
  return Math.max(0, left);
}

export interface PrefetchInput {
  continuous: boolean;
  playing: boolean;
  status: string;
  remainingMs: number;
  /** Already requested for this chapter + voice + tone. */
  requested: boolean;
}
/** Create (or find) the next chapter's job once, while playing with ≤ PREFETCH_MS left. */
export function shouldPrefetch(i: PrefetchInput): boolean {
  if (!i.continuous || !i.playing || i.requested) return false;
  if (i.status === "failed" || i.status === "budget_exceeded") return false;
  return i.remainingMs <= PREFETCH_MS;
}

// ---------- Follow chapter ----------
export const FOLLOW_DEBOUNCE_MS = 2000;

export interface FollowInput {
  now: number;
  /** Reader inside the playing chapter (null: unknown). */
  inPlaying: boolean | null;
  /** Reader still inside the chapter continuous playback just left (its own change, ignored). */
  inPrevious: boolean;
}
/**
 * Debounced "the reader is in another chapter" decision. `awaySince` is the state carried between
 * checks; `away` turns true once the reader has been outside the playing chapter ≥ debounceMs.
 */
export function followStep(
  awaySince: number | null,
  i: FollowInput,
  debounceMs = FOLLOW_DEBOUNCE_MS,
): { awaySince: number | null; away: boolean } {
  if (i.inPlaying !== false || i.inPrevious) return { awaySince: null, away: false };
  const since = awaySince ?? i.now;
  return { awaySince: since, away: i.now - since >= debounceMs };
}

export const CONTINUOUS_KEY = "shelf:audio-continuous";
/** Stored value → on/off (default on). */
export const continuousOn = (stored: string | null | undefined) => stored !== "0";

// ---------- Slider scrubbing ----------
/** Read-along updates while dragging the progress slider are throttled to this. */
export const SCRUB_MS = 200;

/** Milliseconds to wait before the next throttled emit (0 = emit now). */
export function throttleWait(now: number, last: number, ms = SCRUB_MS): number {
  return Math.max(0, last + ms - now);
}

/**
 * The piece and offset a slider value points at, clamped to the ready range (see locate), with the
 * piece itself so the caller can hand its text/marks/duration to read-along. Null when nothing is ready.
 */
export function scrubTarget<P extends TimelinePiece>(
  seg: { index: number; pieces: P[] },
  tMs: number,
): { pieceIndex: number; offsetMs: number; piece: P } | null {
  const loc = locate(seg, tMs);
  if (!loc) return null;
  return { ...loc, piece: seg.pieces[loc.pieceIndex] };
}

// ---------- Background audio (iOS Safari 17+ Audio Session API) ----------
export type AudioSessionMode = "playback" | "transient" | "ambient";
export const AUDIO_SESSION_KEY = "shelf:audio-session";
export const AUDIO_SESSION_MODES: { id: AudioSessionMode; label: string }[] = [
  { id: "playback", label: "背景音：打断" },
  { id: "transient", label: "背景音：压低" },
  { id: "ambient", label: "背景音：混音" },
];
/** Stored value → mode (default "playback": interrupts other apps, the browser default). */
export function audioSessionMode(stored: string | null | undefined): AudioSessionMode {
  return AUDIO_SESSION_MODES.some((m) => m.id === stored) ? (stored as AudioSessionMode) : "playback";
}

// ---------- Toggle buttons ----------
/** Visible label of a pressed/unpressed toggle ("✓ " prefix when on). */
export const toggleLabel = (label: string, on: boolean) => (on ? `✓ ${label}` : label);
