import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-audio-timeline-")), "audio-timeline.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/audio-timeline.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const T = await import(pathToFileURL(out).href);

const piece = (seq, durationMs, ready = true) => ({ seq, durationMs, ready });
const full = { index: 0, pieces: [piece(0, 1000), piece(1, 2000), piece(2, 3000)] };
const partial = { index: 0, pieces: [piece(0, 1000), piece(1, 2000), piece(2, 3100, false), piece(3, null, false)] };

test("offsets and total", () => {
  assert.deepEqual(T.pieceOffsets(full), [0, 1000, 3000]);
  assert.equal(T.totalMs(full), 6000);
  assert.equal(T.totalMs(partial), 6100); // estimate of not-ready piece counts, null counts as 0
  assert.equal(T.totalMs({ index: 0, pieces: [] }), 0);
});

test("locate maps time to piece and offset", () => {
  assert.deepEqual(T.locate(full, 0), { pieceIndex: 0, offsetMs: 0 });
  assert.deepEqual(T.locate(full, 999), { pieceIndex: 0, offsetMs: 999 });
  assert.deepEqual(T.locate(full, 1000), { pieceIndex: 1, offsetMs: 0 });
  assert.deepEqual(T.locate(full, 4500), { pieceIndex: 2, offsetMs: 1500 });
  assert.deepEqual(T.locate(full, 6000), { pieceIndex: 2, offsetMs: 3000 });
});

test("locate clamps out-of-range and bad input", () => {
  assert.deepEqual(T.locate(full, -50), { pieceIndex: 0, offsetMs: 0 });
  assert.deepEqual(T.locate(full, 99999), { pieceIndex: 2, offsetMs: 3000 });
  assert.deepEqual(T.locate(full, NaN), { pieceIndex: 0, offsetMs: 0 });
});

test("not-ready pieces: clamp to the ready end", () => {
  assert.equal(T.firstNotReady(partial), 2);
  assert.equal(T.readyEndMs(partial), 3000);
  assert.equal(T.isFullyReady(partial), false);
  assert.deepEqual(T.locate(partial, 5000), { pieceIndex: 1, offsetMs: 2000 });
  assert.deepEqual(T.locate(partial, 2500), { pieceIndex: 1, offsetMs: 1500 });
  assert.equal(T.isFullyReady(full), true);
});

test("nothing playable when the first piece is not ready", () => {
  const none = { index: 0, pieces: [piece(0, 900, false)] };
  assert.equal(T.locate(none, 0), null);
  assert.equal(T.readyEndMs(none), 0);
  assert.equal(T.locate({ index: 0, pieces: [] }, 0), null);
});

test("timeOf is the inverse of locate", () => {
  for (const t of [0, 500, 1000, 2999, 3000, 5999]) {
    const l = T.locate(full, t);
    assert.equal(T.timeOf(full, l.pieceIndex, l.offsetMs), t);
  }
});

test("next / prev segment", () => {
  const segs = [{ index: 0, pieces: [] }, { index: 1, pieces: [] }, { index: 2, pieces: [] }];
  assert.equal(T.nextSegment(segs, 0), 1);
  assert.equal(T.nextSegment(segs, 2), null);
  assert.equal(T.prevSegment(segs, 2), 1);
  assert.equal(T.prevSegment(segs, 0), null);
});

test("formatTime", () => {
  assert.equal(T.formatTime(0), "00:00");
  assert.equal(T.formatTime(59999), "00:59");
  assert.equal(T.formatTime(61000), "01:01");
  assert.equal(T.formatTime(3599000), "59:59");
  assert.equal(T.formatTime(3600000), "1:00:00");
  assert.equal(T.formatTime(3725000), "1:02:05");
  assert.equal(T.formatTime(-5), "00:00");
  assert.equal(T.formatTime(NaN), "00:00");
});

test("progressPct", () => {
  assert.equal(T.progressPct(1, 3), 33);
  assert.equal(T.progressPct(0, 0), 0);
  assert.equal(T.progressPct(5, 4), 100);
});
