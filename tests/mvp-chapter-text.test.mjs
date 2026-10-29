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

test("TXT next chapter: headings, front matter, last chapter", async () => {
  const h1 = zh.indexOf("第一章");
  const h2 = zh.indexOf("第二章");
  const h3 = zh.indexOf("第十二回");
  assert.equal(C.nextTextChapter(zh, 0).start, h1); // front matter → first heading
  assert.equal(C.nextTextChapter(zh, h1).start, h2);
  assert.equal(C.nextTextChapter(zh, h2).label, "第十二回 结局");
  assert.equal(C.nextTextChapter(zh, h3), null);
  assert.equal(C.nextTextChapter(zh + "\n\n  \n", h3), null); // only whitespace follows
  const nav = C.textChapterNav(zh, () => [h2 + 2]);
  assert.equal((await nav.next(`text:${h1}`)).chapterKey, `text:${h2}`);
  assert.equal(await nav.next(`text:${h3}`), null);
  assert.equal(await nav.contains(`text:${h2}`), true);
  assert.equal(await nav.contains(`text:${h1}`), false);
  assert.equal(await nav.contains("pdf:1-2"), null);
  // top still in the previous chapter, middle already in this one: inside
  assert.equal(await C.textChapterNav(zh, () => [h2 - 1, h2 + 1]).contains(`text:${h2}`), true);
});

test("TXT next chapter without headings: consecutive blocks, keys reproduce the block", async () => {
  const p = (c) => c.repeat(5000);
  const t = [p("甲"), p("乙"), p("丙"), p("丁"), p("戊"), p("己")].join("\n\n");
  const a = C.textChapterAt(t, 10);
  const b = C.nextTextChapter(t, a.start);
  assert.ok(b.start >= a.end && b.start <= a.end + 2);
  assert.equal(b.end, t.length);
  assert.ok(!/^\n/.test(b.text));
  assert.deepEqual(C.textChapterForKey(t, b.start), b);
  assert.equal(C.textChapterForKey(t, a.start).start, a.start); // same as textChapterAt for its keys
  assert.equal(C.nextTextChapter(t, b.start), null); // b runs to the end
  // a block starting after a single line break keeps its exact start (textChapterAt would snap back)
  const u = "x".repeat(30) + "\n" + "y".repeat(30);
  assert.equal(C.textChapterForKey(u, 31).start, 31);
  const nav = C.textChapterNav(t, () => [b.start + 5]);
  assert.equal(await nav.contains(`text:${b.start}`), true);
  assert.equal(await nav.contains(`text:${a.start}`), false);
});

test("PDF next range: outline item after the chapter, 30 pages without outline, end of book", () => {
  const o = [
    { page: 5, title: "A" },
    { page: 10, title: "B" },
    { page: 12, title: "B.1" },
  ];
  assert.deepEqual(C.pdfNextRange(o, { start: 1, end: 4 }, 50), { start: 5, end: 9, title: "A" });
  assert.deepEqual(C.pdfNextRange(o, { start: 5, end: 9 }, 50), { start: 10, end: 11, title: "B" });
  assert.equal(C.pdfNextRange(o, { start: 12, end: 50 }, 50), null);
  assert.deepEqual(C.pdfNextRange([], { start: 1, end: 30 }, 100), { start: 31, end: 60, title: "" });
  assert.deepEqual(C.pdfNextRange([], { start: 61, end: 90 }, 100), { start: 91, end: 100, title: "" });
  // a chapter ending mid-outline-item (odd key) still continues right after it
  assert.deepEqual(C.pdfNextRange(o, { start: 5, end: 6 }, 50), { start: 7, end: 9, title: "" });
  assert.equal(C.pdfPageIn({ start: 10, end: 20 }, 9), true); // spread showing 9–10
  assert.equal(C.pdfPageIn({ start: 10, end: 20 }, 8), false);
  assert.equal(C.pdfPageIn({ start: 10, end: 20 }, 21), false);
});

test("PDF nav: next skips pages without text and stops at the end", async () => {
  const texts = { 1: "第一页的文字足够长，可以朗读出来。", 61: "第六十一页的文字也足够长，可以朗读出来，而且超过二十个字。" };
  const pdf = {
    numPages: 70,
    getOutline: async () => [],
    getPage: async (n) => ({ getTextContent: async () => ({ items: [{ str: texts[n] ?? "" }] }), cleanup() {} }),
  };
  let page = 3;
  const nav = C.pdfChapterNav(pdf, () => page);
  assert.equal(await nav.contains("pdf:1-30"), true);
  page = 40;
  assert.equal(await nav.contains("pdf:1-30"), false);
  assert.equal(await nav.contains("text:0"), null);
  const n = await nav.next("pdf:1-30");
  assert.equal(n.chapterKey, "pdf:61-70");
  assert.equal(await nav.next("pdf:61-70"), null);
});

test("section books: key span and next span (TOC, nested, capped, no TOC)", () => {
  const toc = [
    { idx: 0, depth: 0, label: "Front" },
    { idx: 2, depth: 0, label: "Ch1" },
    { idx: 4, depth: 1, label: "Ch1.1" },
    { idx: 6, depth: 0, label: "Ch2" },
  ];
  assert.deepEqual(C.keySpan(toc, 2, 9), { from: 2, to: 5, label: "Ch1" });
  assert.deepEqual(C.keySpan(toc, 3, 9), { from: 3, to: 3, label: "" }); // not a TOC start
  assert.deepEqual(C.nextSpan(toc, 0, 9), { from: 2, to: 5, label: "Ch1" });
  assert.deepEqual(C.nextSpan(toc, 2, 9), { from: 6, to: 9, label: "Ch2" });
  assert.deepEqual(C.nextSpan(toc, 4, 9), { from: 6, to: 9, label: "Ch2" }); // from a sub-item
  assert.equal(C.nextSpan(toc, 6, 9), null);
  assert.deepEqual(C.nextSpan([], 3, 5), { from: 4, to: 4, label: "" });
  assert.equal(C.nextSpan([], 5, 5), null);
  // chapter capped at MAX_SECTIONS: continues with the following section, not the same chapter again
  const big = [{ idx: 0, depth: 0, label: "Huge" }];
  const cap = C.MAX_SECTIONS;
  assert.deepEqual(C.nextSpan(big, 0, 500), { from: cap + 1, to: cap + 1, label: "" });
  assert.deepEqual(C.nextSpan(big, cap + 1, 500), { from: cap + 2, to: cap + 2, label: "" });
});
