import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-clc-tree-")), "clc-tree.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/clc-tree.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const T = await import(pathToFileURL(out).href);

// K81 and K82 are siblings under K8; K82 must never be treated as below K81 just because codes look alike.
const nodes = [
  { code: "I", name: "文学", parent: null },
  { code: "I2", name: "中国文学", parent: "I" },
  { code: "I24", name: "小说", parent: "I2" },
  { code: "K", name: "历史、地理", parent: null },
  { code: "K8", name: "传记", parent: "K" },
  { code: "K81", name: "传记总类", parent: "K8" },
  { code: "K82", name: "世界各国人物传记", parent: "K8" },
  { code: "T", name: "工业技术", parent: null },
  { code: "TP", name: "自动化技术、计算机技术", parent: "T" },
  { code: "TP3", name: "计算技术、计算机技术", parent: "TP" },
  { code: "TP31", name: "计算机软件", parent: "TP3" },
  { code: "TP39", name: "计算机的应用", parent: "TP3" },
  { code: "Z", name: "综合性图书", parent: null },
];
const idx = T.buildIndex(nodes);
const bk = (clc) => ({ clc });
const books = [bk("TP31"), bk("TP31"), bk("TP39"), bk("I24"), bk("K82"), bk("K81"), bk("K8"), bk(null), bk(null), bk("ZZZ")];
const counts = () => T.countBooks(idx, books);
const codesOf = (rows) => rows.map((r) => r.code);

test("paths follow parent links, not string prefixes", () => {
  assert.deepEqual(T.pathOf(idx, "K82"), ["K", "K8", "K82"]);
  assert.deepEqual(T.pathOf(idx, "TP31"), ["T", "TP", "TP3", "TP31"]);
  assert.deepEqual(T.pathOf(idx, "nope"), []);
  assert.equal(T.isWithin(idx, "K82", "K81"), false);
  assert.equal(T.isWithin(idx, "K82", "K8"), true);
  assert.equal(T.isWithin(idx, "K8", "K8"), true);
  assert.equal(T.isWithin(idx, "TP31", "TP"), true);
  assert.equal(T.isWithin(idx, null, "TP"), false);
  assert.deepEqual(T.pathNames(idx, "K82"), ["历史、地理", "传记", "世界各国人物传记"]);
});

test("a parent missing from the list makes the node a root; cycles do not loop", () => {
  const i = T.buildIndex([
    { code: "A", name: "a", parent: "GONE" },
    { code: "B", name: "b", parent: "C" },
    { code: "C", name: "c", parent: "B" },
  ]);
  assert.deepEqual(T.pathOf(i, "A"), ["A"]);
  assert.ok(T.pathOf(i, "B").length <= 2);
});

test("selection matching incl. unclassified and descendants", () => {
  const m = (clc, sel) => T.matchesSelection(idx, clc, sel);
  assert.equal(m("TP31", ""), true);
  assert.equal(m("TP31", "TP"), true);
  assert.equal(m("TP31", "TP39"), false);
  assert.equal(m("K82", "K81"), false);
  assert.equal(m("K81", "K8"), true);
  assert.equal(m(null, T.UNCLASSIFIED), true);
  assert.equal(m("TP31", T.UNCLASSIFIED), false);
  assert.equal(m(null, "TP"), false);
});

test("counts include descendants; unknown codes are skipped; unclassified counted", () => {
  const c = counts();
  assert.equal(c.total, 10);
  assert.equal(c.unclassified, 2);
  assert.equal(c.nodes.get("TP3"), 3);
  assert.equal(c.nodes.get("T"), 3);
  assert.equal(c.nodes.get("K8"), 3);
  assert.equal(c.nodes.get("K81"), 1);
  assert.equal(c.nodes.get("I"), 1);
  assert.equal(c.nodes.has("Z"), false);
  // counts react to other filters: only the filtered list is passed in
  const f = T.countBooks(idx, books.filter((b) => b.clc === "TP31"));
  assert.equal(f.nodes.get("T"), 2);
  assert.equal(f.nodes.has("I"), false);
  assert.equal(f.unclassified, 0);
  const sc = T.serverCounts([{ code: "T", name: "x", parent: null, count: 5 }], 2, 9);
  assert.deepEqual([sc.nodes.get("T"), sc.unclassified, sc.total], [5, 2, 9]);
});

test("single-child chains with no direct books are merged into the deepest name", () => {
  const rows = T.buildRows(idx, counts(), "");
  const t = rows.find((r) => r.code === "TP3");
  // T > TP > TP3 collapses (TP3 has two children, so the merge stops there)
  assert.deepEqual(t.chain.map((n) => n.code), ["T", "TP", "TP3"]);
  assert.equal(T.chainLabel(t.chain), "工业技术 › 自动化技术、计算机技术 › 计算技术、计算机技术");
  assert.equal(t.depth, 0);
  assert.equal(rows.some((r) => r.code === "TP" || r.code === "T"), false);
  // I > I2 > I24 collapses fully into a leaf row
  const i = rows.find((r) => r.code === "I24");
  assert.equal(i.chain.length, 3);
  assert.equal(i.hasChildren, false);
});

test("a node with books assigned directly is not merged; empty nodes are hidden", () => {
  const rows = T.buildRows(idx, counts(), "");
  assert.deepEqual(codesOf(rows), ["I24", "K8", "K81", "K82", "TP3", "TP31", "TP39"]);
  assert.equal(rows.some((r) => r.code === "Z"), false);
  // K8 has a direct book, so it stays separate from its children
  const only = T.buildRows(idx, T.countBooks(idx, [bk("K81"), bk("K8")]), "");
  assert.deepEqual(codesOf(only), ["K8", "K81"]);
  assert.equal(only[0].hasChildren, true);
  // without the direct book K > K8 > K81 collapses into one K81 row
  const r3 = T.buildRows(idx, T.countBooks(idx, [bk("K81")]), "");
  assert.deepEqual(r3.map((r) => [r.code, r.chain.length]), [["K81", 3]]);
});

test("default expansion: top level open, selection ancestors open, toggles override", () => {
  const c = counts();
  const rows = T.buildRows(idx, c, "");
  assert.deepEqual(rows.filter((r) => r.depth === 1).map((r) => r.code), ["K81", "K82", "TP31", "TP39"]);
  // explicit collapse hides the children
  const collapsed = T.buildRows(idx, c, "", new Map([["K8", false]]));
  assert.equal(collapsed.find((r) => r.code === "K8").expanded, false);
  assert.equal(collapsed.some((r) => r.code === "K82"), false);
  // K82 is active, K81 is not
  const sel = T.buildRows(idx, c, "K82");
  assert.equal(sel.find((r) => r.code === "K82").active, true);
  assert.equal(sel.find((r) => r.code === "K81").active, false);
  // selecting a node inside a merged chain activates the merged row
  assert.equal(T.buildRows(idx, c, "TP").find((r) => r.code === "TP3").active, true);
  // all=true expands everything (mobile select)
  assert.equal(T.buildRows(idx, c, "", new Map([["K8", false]]), true).some((r) => r.code === "K82"), true);
});

test("selection below a collapsed-by-default level expands its ancestors", () => {
  // three levels: A has own book -> not merged; B has own book -> not merged; C leaf
  const i = T.buildIndex([
    { code: "A", name: "a", parent: null },
    { code: "AB", name: "ab", parent: "A" },
    { code: "ABC", name: "abc", parent: "AB" },
    { code: "ABD", name: "abd", parent: "AB" },
  ]);
  const bs = [bk("A"), bk("AB"), bk("ABC"), bk("ABD")];
  const c = T.countBooks(i, bs);
  assert.deepEqual(codesOf(T.buildRows(i, c, "")), ["A", "AB"]);
  assert.deepEqual(codesOf(T.buildRows(i, c, "ABC")), ["A", "AB", "ABC", "ABD"]);
});

test("selected node with zero books stays visible with its ancestors", () => {
  const rows = T.buildRows(idx, T.countBooks(idx, [bk("I24")]), "K82");
  const k82 = rows.find((r) => r.code === "K82");
  assert.ok(k82);
  assert.equal(k82.count, 0);
  assert.equal(k82.active, true);
});

test("deepest name, URL round trip, picker search", () => {
  assert.equal(T.deepestName(idx, "TP31"), "计算机软件");
  assert.equal(T.deepestName(idx, null), "未分类");
  assert.equal(T.deepestName(idx, "ZZZ"), "未分类");
  assert.equal(T.parseSelection(new URLSearchParams("clc=tp31")), "TP31");
  assert.equal(T.parseSelection(new URLSearchParams("clc=none")), "none");
  assert.equal(T.parseSelection(new URLSearchParams("")), "");
  const p = T.serializeSelection("K82", new URLSearchParams("q=x&clc=old"));
  assert.equal(p.get("clc"), "K82");
  assert.equal(p.get("q"), "x");
  assert.equal(T.serializeSelection("", new URLSearchParams("clc=K8")).has("clc"), false);
  assert.equal(T.parseSelection(p), "K82");
  const codes = (q) => T.searchNodes(idx, q).map((n) => n.code);
  assert.deepEqual(codes("tp3"), ["TP3", "TP31", "TP39"]);
  assert.deepEqual(codes("K8"), ["K8", "K81", "K82"]);
  assert.deepEqual(codes("计算机"), ["TP", "TP3", "TP31", "TP39"]);
  assert.deepEqual(codes(""), []);
  assert.deepEqual(codes("没有"), []);
});

test("non-book material: excluded from the CLC tree, own counts and URL param", () => {
  const mixed = [
    { clc: "TP31", docType: "book" },
    { clc: "TP31", docType: null },
    { clc: "TP31", docType: "course" },
    { clc: null, docType: "paper" },
    { clc: null, docType: "paper" },
    { clc: null, docType: null },
  ];
  const c = T.countBooks(idx, mixed);
  assert.equal(c.nodes.get("TP31"), 2);
  assert.equal(c.unclassified, 1);
  assert.equal(c.total, 6);
  assert.deepEqual(Object.fromEntries(T.typeCounts(mixed)), { course: 1, paper: 2 });
  assert.equal(T.isBookType("book"), true);
  assert.equal(T.isBookType(null), true);
  assert.equal(T.isBookType("other"), false);
  // type selection matches exactly; CLC selection never matches non-books
  assert.equal(mixed.filter((b) => T.matchesView(idx, b, "", "paper")).length, 2);
  assert.equal(mixed.filter((b) => T.matchesView(idx, b, "TP", "")).length, 2);
  assert.equal(mixed.filter((b) => T.matchesView(idx, b, T.UNCLASSIFIED, "")).length, 1);
  assert.equal(mixed.filter((b) => T.matchesView(idx, b, "", "")).length, 6);
  // URL round trip: only non-book types are valid
  assert.equal(T.parseType(new URLSearchParams("type=Course")), "course");
  assert.equal(T.parseType(new URLSearchParams("type=book")), "");
  assert.equal(T.parseType(new URLSearchParams("type=bogus")), "");
  assert.equal(T.serializeType("paper", new URLSearchParams("clc=x&type=old")).get("type"), "paper");
  assert.equal(T.serializeType("", new URLSearchParams("type=paper")).has("type"), false);
  assert.deepEqual(T.DOC_TYPES.map((t) => T.DOC_LABELS[t]), ["课程资料", "论文与报告", "文章汇编", "手册与文档", "其他资料"]);
});
