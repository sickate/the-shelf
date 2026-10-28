import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "shelf-read-along-books-"));
async function load(entry, name) {
  const outfile = join(dir, name);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}
const B = await load("app/web/lib/read-along-books.ts", "books.mjs");
const C = await load("app/web/lib/chapter-text.ts", "chapter-text.mjs");
const { normalize } = await load("app/web/lib/read-along-core.ts", "core.mjs");

test("searchPlan: cursor section rest, later, earlier, then wrap", () => {
  assert.deepEqual(B.searchPlan(3, 6, { section: 4, pos: 10 }), [
    { section: 4, start: 10 },
    { section: 5, start: 0 },
    { section: 6, start: 0 },
    { section: 3, start: 0 },
    { section: 4, start: 0 },
  ]);
  assert.deepEqual(B.searchPlan(3, 5, null), [
    { section: 3, start: 0 },
    { section: 4, start: 0 },
    { section: 5, start: 0 },
  ]);
  // cursor at pos 0 needs no wrap; outside the span is ignored
  assert.deepEqual(B.searchPlan(2, 3, { section: 3, pos: 0 }), [
    { section: 3, start: 0 },
    { section: 2, start: 0 },
  ]);
  assert.deepEqual(B.searchPlan(2, 3, { section: 9, pos: 5 }), [
    { section: 2, start: 0 },
    { section: 3, start: 0 },
  ]);
  assert.deepEqual(B.searchPlan(4, 3, null), []);
});

const fake = (s) => ({ text: normalize(s).text });

test("findInSections: in order across sections, cursor-first, sentence before `first`", async () => {
  const docs = new Map([
    [0, fake("开头的话。重复的一句话在这里。")],
    [1, fake("第二节内容。重复的一句话在这里。结尾。")],
    [2, fake("第三节只有首句候选。")],
  ]);
  const loaded = [];
  const indexOf = async (i) => (loaded.push(i), docs.get(i) ?? null);
  const s = "重复的一句话在这里。";
  let hit = await B.findInSections(B.searchPlan(0, 2, null), indexOf, s, "");
  assert.equal(hit.section, 0);
  const after = { section: 0, pos: hit.start + 1 };
  hit = await B.findInSections(B.searchPlan(0, 2, after), indexOf, s, "");
  assert.equal(hit.section, 1, "repeat found in the next section after the cursor");
  hit = await B.findInSections(B.searchPlan(0, 2, { section: 1, pos: hit.start + 1 }), indexOf, s, "");
  assert.equal(hit.section, 0, "wraps to earlier sections");
  // sentence missing everywhere: the piece's first sentence is used, even in a later section
  hit = await B.findInSections(B.searchPlan(0, 2, null), indexOf, "完全不存在的句子啊啊。", "第三节只有首句候选。");
  assert.equal(hit.section, 2);
  // sentence present in a later section beats `first` present in the cursor's section
  hit = await B.findInSections(B.searchPlan(0, 2, null), indexOf, "第三节只有首句候选。", "开头的话。");
  assert.equal(hit.section, 2);
  assert.equal(await B.findInSections(B.searchPlan(0, 2, null), indexOf, "没有这句。", ""), null);
  // a bound skips sections past the chapter source's cut-off
  assert.equal(await B.findInSections(B.searchPlan(0, 2, null), indexOf, "第三节只有首句候选。", "", () => 1), null);
  // missing sections are skipped
  assert.equal((await B.findInSections(B.searchPlan(0, 3, null), indexOf, "结尾。", "")).section, 1);
});

test("spanEnd mirrors the chapter source's MAX_CHAPTER_CHARS cut-off", () => {
  const sizes = new Map([
    [0, 5],
    [1, 5],
    [2, 5],
  ]);
  assert.equal(B.spanEnd(0, 5, sizes, 100), 5, "unknown sizes keep the full span");
  assert.equal(B.spanEnd(0, 2, sizes, 6), 0, "section 1 starts after > max chars");
  assert.equal(B.spanEnd(0, 2, sizes, 7), 1);
  assert.equal(B.spanEnd(0, 2, sizes, 14), 2);
  assert.equal(B.spanEnd(0, 2, new Map([[0, 0], [1, 0], [2, 0]]), 1), 2, "empty sections add nothing");
});

test("refind locates the hit text in an equal copy", () => {
  assert.equal(B.refind("abcxyzabc", "abc", 6), 6);
  assert.equal(B.refind("zzabcxyz", "abc", 5), 2);
  assert.equal(B.refind("abc", "q", 0), -1);
  assert.equal(B.refind("abc", "", 0), -1);
});

test("startVisible accounts for the frame offset", () => {
  const view = { left: 0, top: 0, right: 400, bottom: 600 };
  assert.equal(B.startVisible({ left: 10, top: 10, right: 50, bottom: 30 }, { left: 0, top: 0 }, view), true);
  // next column/page: scrolled-out iframe content
  assert.equal(B.startVisible({ left: 450, top: 10, right: 490, bottom: 30 }, { left: 0, top: 0 }, view), false);
  assert.equal(B.startVisible({ left: 450, top: 10, right: 490, bottom: 30 }, { left: -400, top: 0 }, view), true);
  assert.equal(B.startVisible({ left: 10, top: 590, right: 50, bottom: 640 }, { left: 0, top: 0 }, view), false);
  assert.equal(B.startVisible({ left: 0, top: 0, right: 0, bottom: 0 }, { left: 0, top: 0 }, view), false);
});

test("chapterSpan from the key's first section reproduces the source's span", () => {
  const toc = [
    { idx: 0, depth: 0, label: "封面" },
    { idx: 2, depth: 0, label: "第一章" },
    { idx: 3, depth: 1, label: "1.1" },
    { idx: 5, depth: 0, label: "第二章" },
    { idx: -1, depth: 0, label: "坏链接" },
  ];
  for (let cur = 0; cur <= 8; cur++) {
    const s = C.chapterSpan(toc, cur, 8);
    assert.deepEqual(C.chapterSpan(toc, s.from, 8), s, `section ${cur}`);
  }
  assert.deepEqual(C.chapterSpan(toc, 4, 8), { from: 3, to: 4, label: "1.1" });
  assert.deepEqual(C.chapterSpan(toc, 6, 8), { from: 5, to: 8, label: "第二章" });
  assert.deepEqual(C.chapterSpan([], 4, 8), { from: 4, to: 4, label: "" });
  assert.equal(C.chapterSpan([{ idx: 0, depth: 0, label: "" }], 0, 999).to, C.MAX_SECTIONS);
});

test("sectionTarget: cross-section show navigates by CFI, highlights rendered doc, never throws", async () => {
  // Minimal fake host (no DOM): verifies the flow, not epub.js/foliate behaviour.
  const calls = [];
  let shown = 0;
  const relocs = [];
  const host = {
    span: async () => ({ from: 0, to: 1 }),
    rendered: () => [],
    load: async () => {
      throw new Error("boom");
    },
    cfi: () => "epubcfi(/6/2!)",
    display: async (c) => (calls.push(c), shown++),
    viewport: () => null,
    onRendered: () => {},
    onRelocate: (cb) => relocs.push(cb),
  };
  const t = B.sectionTarget(host);
  let user = 0;
  t.onUserNavigate(() => user++);
  assert.equal(await t.show("一句话。", "", { highlight: true }), false);
  assert.deepEqual(calls, []);
  relocs[0](true);
  assert.equal(user, 1, "relocation not caused by the adapter counts as user navigation");
  relocs[0](false);
  assert.equal(user, 1, "layout-only relocation is ignored");
  t.clear();
});
