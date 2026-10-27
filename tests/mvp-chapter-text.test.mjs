import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-chapter-text-")), "chapter-text.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/chapter-text.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const C = await import(pathToFileURL(out).href);

const zh = "前言段落。\n\n第一章 开端\n甲乙丙。\n\n第二章 发展\n丁戊己。\n第十二回 结局\n庚辛。";
test("TXT: Chinese headings, offsets inside and at boundaries", () => {
  const at = (n) => C.textChapterAt(zh, n);
  assert.equal(at(0).label, "");
  assert.equal(at(0).start, 0);
  const h1 = zh.indexOf("第一章");
  const h2 = zh.indexOf("第二章");
  const h3 = zh.indexOf("第十二回");
  assert.equal(at(h1).start, h1); // exactly at a heading
  assert.equal(at(h1 - 1).start, 0);
  assert.equal(at(h1 + 3).label, "第一章 开端");
  assert.equal(at(h2 - 1).start, h1);
  assert.equal(at(h2).end, h3);
  assert.equal(at(zh.length).label, "第十二回 结局");
  assert.equal(at(zh.length).end, zh.length);
  assert.equal(at(-5).start, 0);
});

test("TXT: English chapter and markdown headings", () => {
  const t = "Chapter IV\nabc\nCHAPTER 5 x\ndef\n# Title\nghi\n#### not\njkl";
  const c = C.textChapterAt(t, t.indexOf("def"));
  assert.equal(c.label, "CHAPTER 5 x");
  assert.equal(c.text.trim(), "CHAPTER 5 x\ndef");
  const m = C.textChapterAt(t, t.indexOf("jkl"));
  assert.equal(m.label, "Title");
  assert.ok(m.text.includes("jkl"));
  assert.equal(C.isHeadingLine("Chapterhouse 1"), false);
});

test("TXT: no headings snaps to paragraph start and ends at a paragraph boundary", () => {
  const p = (c) => c.repeat(5000);
  const t = [p("甲"), p("乙"), p("丙"), p("丁"), p("戊")].join("\n\n");
  const off = t.indexOf("乙") + 100;
  const c = C.textChapterAt(t, off);
  assert.equal(c.start, t.indexOf("乙"));
  assert.ok(c.text.length <= 20000);
  assert.equal(t[c.end], "\n");
  assert.ok(/丁$/.test(c.text.trimEnd()));
  const tail = C.textChapterAt(t, t.length - 1);
  assert.equal(tail.end, t.length);
  assert.equal(C.textChapterAt("one line only", 5).start, 0);
});

test("textChapter: key, label, normalization", () => {
  const r = C.textChapter("# 一\n\n\n\nabc   def\n# 二\nx", 8);
  assert.equal(r.chapterKey, "text:0");
  assert.equal(r.label, "一");
  assert.equal(r.text, "# 一\n\nabc def");
  assert.equal(r.truncated, false);
  assert.equal(C.textChapter("   \n ", 0), null);
});

test("PDF range: no outline, outline, nested/out-of-order, before first", () => {
  assert.deepEqual(C.pdfRangeFor([], 5, 100), { start: 5, end: 34, title: "" });
  assert.deepEqual(C.pdfRangeFor([], 90, 100), { start: 90, end: 100, title: "" });
  const o = [
    { page: 40, title: "C" },
    { page: 1, title: "A" },
    { page: 10, title: "B" },
    { page: 12, title: "B.1" },
  ];
  assert.deepEqual(C.pdfRangeFor(o, 11, 100), { start: 10, end: 11, title: "B" });
  assert.deepEqual(C.pdfRangeFor(o, 12, 100), { start: 12, end: 39, title: "B.1" });
  assert.deepEqual(C.pdfRangeFor(o, 40, 100), { start: 40, end: 100, title: "C" });
  assert.deepEqual(C.pdfRangeFor(o, 999, 100), { start: 40, end: 100, title: "C" });
  assert.deepEqual(C.pdfRangeFor([{ page: 5, title: "X" }], 2, 100), { start: 2, end: 4, title: "" });
  assert.deepEqual(C.pdfRangeFor([{ page: 0, title: "bad" }, { page: 300, title: "bad" }], 3, 50), { start: 3, end: 32, title: "" });
  const same = C.pdfRangeFor([{ page: 7, title: "a" }, { page: 7, title: "b" }, { page: 9, title: "c" }], 7, 20);
  assert.deepEqual(same, { start: 7, end: 8, title: "b" });
});

test("sectionRangeFor merges up to the next same-or-higher level item", () => {
  const toc = [
    { idx: 0, depth: 0, label: "Front" },
    { idx: 2, depth: 0, label: "Ch1" },
    { idx: 4, depth: 1, label: "Ch1.1" },
    { idx: 6, depth: 0, label: "Ch2" },
  ];
  assert.deepEqual(C.sectionRangeFor(toc, 3), { from: 2, to: 5, label: "Ch1" });
  assert.deepEqual(C.sectionRangeFor(toc, 4), { from: 4, to: 5, label: "Ch1.1" });
  assert.deepEqual(C.sectionRangeFor(toc, 9), { from: 6, to: null, label: "Ch2" });
  assert.deepEqual(C.sectionRangeFor([], 3), { from: 3, to: 3, label: "" });
  assert.deepEqual(C.sectionRangeFor([{ idx: 5, depth: 0, label: "x" }], 1), { from: 1, to: 1, label: "" });
});

test("finishChapter clips by code points and keeps keys within 500 bytes", () => {
  const big = "😀".repeat(310_000);
  const r = C.finishChapter("k", "l", big);
  assert.equal(r.truncated, true);
  assert.equal(Array.from(r.text).length, 300_000);
  const k = C.finishChapter("epub:" + "章".repeat(400), "l", "text").chapterKey;
  assert.ok(new TextEncoder().encode(k).length <= 500);
  assert.equal(C.finishChapter("p", "l", "a b", 20), null);
});
