import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-filters-")), "filters.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/filters.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const F = await import(pathToFileURL(out).href);

const NOW = Date.parse("2026-10-24T12:00:00Z");
const DAY = 86_400_000;
const MB = 1_000_000;
const book = (title, format, sizeBytes, daysAgo, extra = {}) => ({
  title,
  format,
  sizeBytes,
  status: "uploaded",
  _created: NOW - daysAgo * DAY,
  ...extra,
});
const books = [
  book("A", "pdf", 500_000, 1, { hasCover: true, hasInfo: true, authors: ["张三"] }),
  book("B", "epub", 2 * MB, 10, { hasCover: false, hasInfo: true, authors: ["李四", "张三"] }),
  book("C", ".MOBI", 10 * MB, 40, { hasCover: true, hasInfo: false, authors: [] }),
  book("D", "azw3", 20 * MB, 5, { status: "local_only" }),
  book("E", "md", 25 * MB, 3, { status: "local_only" }),
  book("F", "docx", 1 * MB, 100),
  book("G", "txt", 4_999_999, 29),
];
const opts = { owner: true, now: NOW };
const titles = (l) => l.map((b) => b.title).join("");
const state = (o = {}) => ({ ...F.emptyFilters(), ...o });

test("format groups and size buckets", () => {
  assert.deepEqual(
    ["PDF", ".mobi", "azw", "AZW3", "md", "txt", "epub", "zip"].map(F.formatGroup),
    ["pdf", "mobi", "mobi", "mobi", "txt", "txt", "epub", "other"],
  );
  assert.deepEqual(
    [0, 999_999, 1 * MB, 4_999_999, 5 * MB, 20 * MB, 20 * MB + 1].map(F.sizeBucket),
    ["lt1", "lt1", "1-5", "1-5", "5-20", "5-20", "gt20"],
  );
});

test("parse and serialize round trip", () => {
  const p = new URLSearchParams("q=x&fmt=epub,pdf,bogus&size=1-5,gt20&added=7&readable=1&cover=1&info=0&author=%E5%BC%A0%E4%B8%89");
  const s = F.parseFilters(p);
  assert.deepEqual(s, { fmt: ["pdf", "epub"], size: ["1-5", "gt20"], added: "7", readable: true, cover: "1", info: "0", author: "张三" });
  const out = F.serializeFilters(s, new URLSearchParams("q=x"));
  assert.equal(out.get("q"), "x");
  assert.equal(out.get("fmt"), "pdf,epub");
  assert.deepEqual(F.parseFilters(new URLSearchParams(out.toString())), s);
  assert.equal(F.serializeFilters(F.emptyFilters(), new URLSearchParams("fmt=pdf&author=x")).toString(), "");
  assert.deepEqual(F.parseFilters(new URLSearchParams("added=9&cover=2")), F.emptyFilters());
  assert.equal(F.parseSort("size"), "size");
  assert.equal(F.parseSort("nope"), "title");
});

test("predicates", () => {
  const f = (s, o = opts) => titles(F.filterEntries(books, state(s), o));
  assert.equal(f({}), "ABCDEFG");
  assert.equal(f({ fmt: ["mobi"] }), "CD");
  assert.equal(f({ fmt: ["txt", "pdf"] }), "AEG");
  assert.equal(f({ fmt: ["other"] }), "F");
  assert.equal(f({ size: ["lt1"] }), "A");
  assert.equal(f({ size: ["1-5", "gt20"] }), "BEFG");
  assert.equal(f({ size: ["5-20"] }), "CD");
  assert.equal(f({ added: "7" }), "ADE");
  assert.equal(f({ added: "30" }), "ABDEG");
  assert.equal(f({ readable: true }), "ABCG"); // C is an uploaded MOBI (readable since F3)
  assert.equal(f({ cover: "1" }), "AC");
  assert.equal(f({ cover: "0" }), "BDEFG");
  assert.equal(f({ info: "1" }), "AB");
  assert.equal(f({ info: "0" }), "CDEFG");
  assert.equal(f({ author: "张三" }), "AB");
  assert.equal(f({ fmt: ["pdf", "epub"], size: ["1-5"] }), "B");
  // visitors ignore owner-only filters
  const v = { owner: false, now: NOW };
  assert.equal(f({ cover: "1", info: "1", author: "张三" }, v), "ABCDEFG");
  assert.equal(f({ cover: "1", fmt: ["pdf"] }, v), "A");
  assert.equal(F.hasActive(state({ cover: "1" }), false), false);
  assert.equal(F.hasActive(state({ cover: "1" }), true), true);
});

test("faceted counts ignore only their own facet", () => {
  const counts = (s, facet, o = opts) => Object.fromEntries(F.facetCounts(books, state(s), o, facet));
  assert.deepEqual(counts({}, "fmt"), { pdf: 1, epub: 1, mobi: 2, txt: 2, other: 1 });
  assert.deepEqual(counts({ fmt: ["pdf"] }, "fmt"), { pdf: 1, epub: 1, mobi: 2, txt: 2, other: 1 });
  assert.deepEqual(counts({ fmt: ["pdf"] }, "size"), { lt1: 1 });
  assert.deepEqual(counts({ size: ["5-20"] }, "fmt"), { mobi: 2 });
  assert.deepEqual(counts({ readable: true }, "fmt"), { pdf: 1, epub: 1, mobi: 1, txt: 1 });
  assert.deepEqual(counts({ added: "7" }, "added"), { 7: 3, 30: 5 });
  assert.deepEqual(counts({ fmt: ["epub", "pdf"] }, "author"), { 张三: 2, 李四: 1 });
});

test("sort orders", () => {
  const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  const s = (k) => titles(F.sortEntries(books, k, collator));
  assert.equal(s("title"), "ABCDEFG");
  assert.equal(s("recent"), "AEDBGCF");
  assert.equal(s("size"), "EDCGBFA");
  assert.equal(s("format"), "ABCDEGF");
  assert.equal(titles(F.sortEntries([books[4], books[0], books[2]], "title", collator)), "ACE");
  assert.equal(titles(books), "ABCDEFG", "sort does not mutate input");
});

test("summary line", () => {
  assert.equal(F.summarize(state({ fmt: ["pdf", "epub"], size: ["5-20"] }), true, 18), "PDF、EPUB · 5–20 MB · 18 本");
  assert.equal(
    F.summarize(state({ added: "7", readable: true, cover: "0", author: "张三" }), true, 2),
    "最近 7 天 · 可在线阅读 · 无缩略图 · 作者：张三 · 2 本",
  );
  assert.equal(F.summarize(state({ cover: "0", fmt: ["txt"] }), false, 3), "TXT · 3 本");
});
