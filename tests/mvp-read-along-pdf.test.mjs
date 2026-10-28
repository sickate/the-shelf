import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-read-along-pdf-")), "read-along-pdf.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/read-along-pdf.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const P = await import(pathToFileURL(out).href);

const pages = [
  { page: 5, text: "春天来了，花开满园。孩子们在草地上奔跑。" },
  { page: 6, text: "" },
  { page: 7, text: "夏天的夜晚很热。我们坐在院子里乘凉。春天来了，花开满园。" },
];

test("page index maps offsets to pages and skips empty pages", () => {
  const idx = P.buildPageIndex(pages);
  assert.deepEqual(idx.pages, [5, 7]);
  assert.equal(P.pageAt(idx, 0), 5);
  assert.equal(P.pageAt(idx, idx.starts[1] - 1), 5);
  assert.equal(P.pageAt(idx, idx.starts[1]), 7);
  assert.equal(P.pageAt(idx, 9999), 7);
  assert.equal(P.pageAt(P.buildPageIndex([]), 0), null);
});

test("search: cursor prefers the later duplicate; falls back to chapter start", () => {
  const idx = P.buildPageIndex(pages);
  assert.equal(P.searchPage(idx, "春天来了，花开满园。", "", 0).page, 5);
  assert.equal(P.searchPage(idx, "春天来了，花开满园。", "", idx.starts[1]).page, 7);
  assert.equal(P.searchPage(idx, "孩子们在草地上奔跑。", "", idx.text.length).page, 5);
  assert.equal(P.searchPage(idx, "完全不存在的句子", "", 0), null);
  assert.equal(P.searchPage(idx, "", "", 0), null);
});

test("factory: key parsing, caching, page turn, user vs programmatic navigation", async () => {
  const texts = { 5: pages[0].text, 6: "", 7: pages[2].text };
  const pdf = {
    numPages: 9,
    getPage: async (n) => ({
      getTextContent: async () => ({ items: [{ str: texts[n] ?? "" }] }),
      cleanup() {},
    }),
  };
  let userCb;
  const jumps = [];
  const f = P.pdfReadAlongFactory(pdf, { goTo: (n) => jumps.push(n), onUserPage: (cb) => (userCb = cb) });
  assert.equal(f("epub:abc"), null);
  const t = f("pdf:5-7");
  assert.equal(f("pdf:5-7"), t);
  let user = 0;
  t.onUserNavigate(() => user++);
  assert.equal(await t.show("夏天的夜晚很热。", "", { highlight: true }), true);
  assert.deepEqual(jumps, [7]);
  assert.equal(user, 0);
  userCb();
  assert.equal(user, 1);
  assert.equal(await t.show("没有", "孩子们在草地上奔跑。", { highlight: false }), true);
  assert.deepEqual(jumps, [7, 5]);
  assert.equal(await t.show("没有", "也没有", { highlight: false }), false);
});
