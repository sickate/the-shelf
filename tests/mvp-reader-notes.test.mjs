import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-reader-notes-")), "reader-notes-core.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/reader-notes-core.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const N = await import(pathToFileURL(out).href);
const { normalizeLocator } = await import(pathToFileURL(join(root, "app/worker.mjs")).href);

test("parseLocator accepts exactly the server's locator shapes", () => {
  const ok = [
    { type: "cfi", cfi: "epubcfi(/6/4!/4/2,/1:0,/1:12)" },
    { type: "pdf", page: 3 },
    { type: "pdf", page: 3, start: 0, end: 10 },
    { type: "text", start: 5, end: 9 },
  ];
  for (const loc of ok) {
    assert.deepEqual(N.parseLocator(loc), loc);
    // Whatever the client builds must pass the Worker's validation unchanged.
    assert.deepEqual(JSON.parse(normalizeLocator(loc)), loc);
  }
  const bad = [
    null,
    [],
    "x",
    { type: "cfi", cfi: "" },
    { type: "cfi", cfi: "x", extra: 1 },
    { type: "pdf", page: 0 },
    { type: "pdf", page: 1.5 },
    { type: "pdf", page: 2, start: 5, end: 4 },
    { type: "pdf", page: 2, start: -1 },
    { type: "text", start: 3 },
    { type: "text", start: 4, end: 2 },
    { type: "text", start: 0, end: 1, page: 1 },
    { type: "other" },
  ];
  for (const loc of bad) assert.equal(N.parseLocator(loc), null, JSON.stringify(loc));
});

test("labels: percent, page and chapter", () => {
  assert.equal(N.percentLabel(0.234), "约 23%");
  assert.equal(N.percentLabel(1.7), "约 100%");
  assert.equal(N.percentLabel(-1), "约 0%");
  assert.equal(N.percentLabel(undefined), null);
  assert.equal(N.percentLabel(Number.NaN), null);
  assert.equal(N.pageLabel(12), "第 12 页");
  assert.equal(N.chapterLabel("  第一章\n 开端 ", 0.5), "第一章 开端");
  assert.equal(N.chapterLabel("", 0.5), "约 50%");
  assert.equal(N.chapterLabel(undefined), null);
  const long = N.chapterLabel("章".repeat(300));
  assert.equal([...long].length, N.MAX_LABEL);
  assert.ok(long.endsWith("…"));
});

test("checkQuote trims and enforces the 4,000 code point limit", () => {
  assert.deepEqual(N.checkQuote("  hi \n"), { quote: "hi", error: null });
  assert.equal(N.checkQuote(" \n ").error, "bad_quote");
  assert.equal(N.checkQuote("字".repeat(4000)).error, null);
  assert.equal(N.checkQuote("字".repeat(4001)).error, "quote_too_long");
  // Astral characters count once (as on the server).
  assert.equal(N.checkQuote("😀".repeat(4000)).error, null);
  assert.equal(N.excerpt("a\n\nb   c", 80), "a b c");
  assert.equal(N.excerpt("abcdef", 4), "abc…");
});

test("trimSpan drops surrounding whitespace like the server's quote trim", () => {
  const t = "ab \n  cd ef\t\n gh";
  assert.deepEqual(N.trimSpan(t, 2, 12), { start: 6, end: 11 });
  assert.equal(t.slice(6, 11), t.slice(2, 12).trim());
  assert.deepEqual(N.trimSpan(t, 2, 6), { start: 6, end: 6 }); // whitespace only: empty
  assert.deepEqual(N.trimSpan(t, -3, 99), { start: 0, end: t.length });
});

test("prefixSums and locateOffset map global offsets to chunks", () => {
  const sums = N.prefixSums([3, 0, 2, 4]); // "abc" "" "de" "fghi"
  assert.deepEqual(sums, [0, 3, 3, 5, 9]);
  assert.deepEqual(N.locateOffset(sums, 0), { index: 0, offset: 0 });
  assert.deepEqual(N.locateOffset(sums, 2), { index: 0, offset: 2 });
  // Boundary: a range start belongs to the chunk that begins there (skipping the empty one) …
  assert.deepEqual(N.locateOffset(sums, 3, "start"), { index: 2, offset: 0 });
  // … a range end to the chunk that ends there.
  assert.deepEqual(N.locateOffset(sums, 3, "end"), { index: 0, offset: 3 });
  assert.deepEqual(N.locateOffset(sums, 9, "start"), { index: 3, offset: 4 });
  assert.deepEqual(N.locateOffset(sums, 9, "end"), { index: 3, offset: 4 });
  assert.deepEqual(N.locateOffset(sums, 99), { index: 3, offset: 4 });
  assert.deepEqual(N.locateOffset(sums, -5), { index: 0, offset: 0 });
  assert.equal(N.locateOffset([0], 0), null);
});

test("sliceRanges splits an offset range over text-layer items", () => {
  const strs = ["Hello ", "", "world", "!", " Next line"];
  const sums = N.prefixSums(strs.map((s) => s.length));
  const all = strs.join("");
  const slices = N.sliceRanges(sums, 3, 13);
  assert.deepEqual(slices, [
    { index: 0, from: 3, to: 6 },
    { index: 2, from: 0, to: 5 },
    { index: 3, from: 0, to: 1 },
    { index: 4, from: 0, to: 1 },
  ]);
  // Reassembling the slices gives exactly the substring of the concatenated text.
  assert.equal(slices.map((s) => strs[s.index].slice(s.from, s.to)).join(""), all.slice(3, 13));
  assert.deepEqual(N.sliceRanges(sums, 6, 6), []);
  assert.deepEqual(N.sliceRanges(sums, 22, 30), []);
  assert.deepEqual(N.sliceRanges(sums, 18, 99), [{ index: 4, from: 6, to: 10 }]);
  assert.deepEqual(N.sliceRanges([0], 0, 5), []);
});

test("segments cut text at highlight boundaries, last id on top", () => {
  assert.deepEqual(N.segments(10, []), [{ start: 0, end: 10, ids: [] }]);
  assert.deepEqual(N.segments(10, [{ id: "a", start: 2, end: 5 }]), [
    { start: 0, end: 2, ids: [] },
    { start: 2, end: 5, ids: ["a"] },
    { start: 5, end: 10, ids: [] },
  ]);
  assert.deepEqual(
    N.segments(10, [
      { id: "a", start: 0, end: 6 },
      { id: "b", start: 4, end: 12 }, // clamped to the text
      { id: "c", start: 7, end: 7 }, // empty: dropped
    ]),
    [
      { start: 0, end: 4, ids: ["a"] },
      { start: 4, end: 6, ids: ["a", "b"] },
      { start: 6, end: 10, ids: ["b"] },
    ],
  );
  // Segments always tile the whole text.
  const segs = N.segments(50, [{ id: "x", start: 10, end: 20 }, { id: "y", start: 15, end: 30 }, { id: "z", start: 40, end: 45 }]);
  assert.equal(segs[0].start, 0);
  assert.equal(segs.at(-1).end, 50);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end);
});

test("compareLocators sorts by reading position", () => {
  const cfis = ["epubcfi(/6/4!/4/10,/1:0,/1:5)", "epubcfi(/6/2!/4/2/1:3)", "epubcfi(/6/4[ch2]!/4/2,/1:9,/1:12)", "epubcfi(/6/4!/4/2,/1:0,/1:4)"];
  const sorted = cfis.map((cfi) => ({ type: "cfi", cfi })).sort(N.compareLocators).map((l) => l.cfi);
  assert.deepEqual(sorted, [cfis[1], cfis[3], cfis[2], cfis[0]]);
  assert.deepEqual(N.cfiKey("epubcfi(/6/4[id9]!/4/2,/1:9,/1:12)"), [6, 4, 4, 2, 1, 9]);
  const pdf = [{ type: "pdf", page: 3, start: 9 }, { type: "pdf", page: 1 }, { type: "pdf", page: 3, start: 2 }].sort(N.compareLocators);
  assert.deepEqual(pdf.map((l) => `${l.page}:${l.start ?? "-"}`), ["1:-", "3:2", "3:9"]);
  const text = [{ type: "text", start: 9, end: 10 }, { type: "text", start: 1, end: 4 }].sort(N.compareLocators);
  assert.deepEqual(text.map((l) => l.start), [1, 9]);
  assert.equal(N.compareLocators(null, { type: "text", start: 1, end: 2 }), 0);
});

test("colors match the server enum", () => {
  assert.deepEqual(N.NOTE_COLORS.map((c) => c.value), ["yellow", "green", "blue", "pink"]);
  for (const c of N.NOTE_COLORS) assert.match(N.HL_HEX[c.value], /^#[0-9a-f]{6}$/);
  assert.ok(N.isColor("pink"));
  assert.ok(!N.isColor("red"));
});
