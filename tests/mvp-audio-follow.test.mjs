import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-audio-follow-")), "audio-follow.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/audio-follow.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const F = await import(pathToFileURL(out).href);

test("poll backoff: 3 s, then 3 → 6 → 12 → 24 → capped at 30 s", () => {
  assert.equal(F.pollDelay(0), 3000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(F.pollDelay), [3000, 6000, 12000, 24000, 30000, 30000, 30000]);
});

test("poll note: only after 3 failures, never while playing fine", () => {
  assert.equal(F.pollNoteVisible(2, false, false), false);
  assert.equal(F.pollNoteVisible(3, false, false), true); // paused
  assert.equal(F.pollNoteVisible(5, true, false), false); // playing fine
  assert.equal(F.pollNoteVisible(3, true, true), true); // stuck waiting for the next piece
  assert.equal(F.pollNoteVisible(0, true, true), false);
});

test("piece retry url: cache-buster for http URLs only", () => {
  assert.equal(F.retryUrl("/api/audio/a/pieces/3", 0), "/api/audio/a/pieces/3");
  assert.equal(F.retryUrl("/api/audio/a/pieces/3", 1), "/api/audio/a/pieces/3?retry=1");
  assert.equal(F.retryUrl("/x?y=1", 2), "/x?y=1&retry=2");
  assert.equal(F.retryUrl("blob:http://h/uuid", 2), "blob:http://h/uuid");
  assert.equal(F.PIECE_RETRIES, 2);
});

const p = (durationMs, ready = true) => ({ seq: 0, durationMs, ready });
test("remaining time across segments, unknown pieces estimated by the mean", () => {
  const segs = [
    { index: 0, pieces: [p(1000), p(3000)] },
    { index: 1, pieces: [p(2000, false), p(null, false)] },
  ];
  assert.equal(F.unknownPieceMs(segs), 2000);
  assert.equal(F.remainingMs(segs, 0, 0), 8000);
  assert.equal(F.remainingMs(segs, 0, 1500), 6500);
  assert.equal(F.remainingMs(segs, 1, 500), 3500);
  assert.equal(F.remainingMs(segs, 0, 99999), 0);
  assert.equal(F.unknownPieceMs([{ index: 0, pieces: [p(null, false)] }]), 20000);
});

test("prefetch: once, while playing, ≤ 5 min left, not for failed jobs", () => {
  const base = { continuous: true, playing: true, status: "synthesizing", remainingMs: 5 * 60_000, requested: false };
  assert.equal(F.shouldPrefetch(base), true);
  assert.equal(F.shouldPrefetch({ ...base, remainingMs: 5 * 60_000 + 1 }), false);
  assert.equal(F.shouldPrefetch({ ...base, requested: true }), false);
  assert.equal(F.shouldPrefetch({ ...base, playing: false }), false);
  assert.equal(F.shouldPrefetch({ ...base, continuous: false }), false);
  assert.equal(F.shouldPrefetch({ ...base, status: "failed" }), false);
  assert.equal(F.shouldPrefetch({ ...base, status: "ready", remainingMs: 1000 }), true);
});

test("follow chapter: debounced 2 s, reset when back, ignores the chapter continuous playback left", () => {
  let s = F.followStep(null, { now: 0, inPlaying: false, inPrevious: false });
  assert.deepEqual(s, { awaySince: 0, away: false });
  s = F.followStep(s.awaySince, { now: 1999, inPlaying: false, inPrevious: false });
  assert.equal(s.away, false);
  s = F.followStep(s.awaySince, { now: 2000, inPlaying: false, inPrevious: false });
  assert.equal(s.away, true);
  // back in the playing chapter resets
  assert.deepEqual(F.followStep(s.awaySince, { now: 2500, inPlaying: true, inPrevious: false }), { awaySince: null, away: false });
  // unknown never counts as away
  assert.deepEqual(F.followStep(0, { now: 9000, inPlaying: null, inPrevious: false }), { awaySince: null, away: false });
  // still on the chapter continuous playback just finished: not a user change
  assert.deepEqual(F.followStep(0, { now: 9000, inPlaying: false, inPrevious: true }), { awaySince: null, away: false });
});

test("continuous playback is on by default", () => {
  assert.equal(F.continuousOn(null), true);
  assert.equal(F.continuousOn("1"), true);
  assert.equal(F.continuousOn("0"), false);
  assert.equal(F.CONTINUOUS_KEY, "shelf:audio-continuous");
});

test("scrub throttle: emit now after the interval, else wait the remainder", () => {
  assert.equal(F.throttleWait(1000, 0), 0);
  assert.equal(F.throttleWait(1000, 900), 100);
  assert.equal(F.throttleWait(1000, 900, 250), 150);
  assert.equal(F.throttleWait(1000, 800), 0);
});

test("scrub target: slider value → piece/offset, clamped to the ready range", () => {
  const seg = {
    index: 0,
    pieces: [
      { seq: 0, durationMs: 1000, ready: true, text: "a" },
      { seq: 1, durationMs: 2000, ready: true, text: "b" },
      { seq: 2, durationMs: 1500, ready: false, text: "c" },
    ],
  };
  assert.deepEqual(F.scrubTarget(seg, 500), { pieceIndex: 0, offsetMs: 500, piece: seg.pieces[0] });
  assert.deepEqual(F.scrubTarget(seg, 1500), { pieceIndex: 1, offsetMs: 500, piece: seg.pieces[1] });
  // Past the ready end (3000) → end of the last ready piece.
  assert.deepEqual(F.scrubTarget(seg, 4000), { pieceIndex: 1, offsetMs: 2000, piece: seg.pieces[1] });
  assert.deepEqual(F.scrubTarget(seg, -10), { pieceIndex: 0, offsetMs: 0, piece: seg.pieces[0] });
  assert.equal(F.scrubTarget({ index: 0, pieces: [{ seq: 0, durationMs: 1, ready: false }] }, 0), null);
});

test("audio session mode: stored value, default playback", () => {
  assert.equal(F.audioSessionMode(null), "playback");
  assert.equal(F.audioSessionMode("bogus"), "playback");
  assert.equal(F.audioSessionMode("transient"), "transient");
  assert.equal(F.audioSessionMode("ambient"), "ambient");
  assert.equal(F.AUDIO_SESSION_KEY, "shelf:audio-session");
  assert.deepEqual(F.AUDIO_SESSION_MODES.map((m) => m.id), ["playback", "transient", "ambient"]);
});

test("toggle label: ✓ prefix only when on", () => {
  assert.equal(F.toggleLabel("跟随", true), "✓ 跟随");
  assert.equal(F.toggleLabel("跟随", false), "跟随");
});
