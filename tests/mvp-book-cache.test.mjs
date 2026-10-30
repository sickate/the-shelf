import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-book-cache-")), "book-cache.mjs");
await build({ entryPoints: [join(root, "app/web/lib/book-cache.ts")], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const C = await import(pathToFileURL(out).href);

test("key changes with id, size and createdAt", () => {
  const a = C.bookKey({ id: 1, sizeBytes: 10, createdAt: "t1" });
  assert.equal(a, C.bookKey({ id: "1", sizeBytes: 10, createdAt: "t1" }));
  assert.notEqual(a, C.bookKey({ id: 1, sizeBytes: 11, createdAt: "t1" }));
  assert.notEqual(a, C.bookKey({ id: 1, sizeBytes: 10, createdAt: "t2" }));
  assert.notEqual(a, C.bookKey({ id: 2, sizeBytes: 10, createdAt: "t1" }));
  assert.ok(a.startsWith("/"));
});

test("eviction: nothing under limits; LRU first by count and by bytes", () => {
  const e = (k, size, used) => ({ key: k, id: k, size, used });
  assert.deepEqual(C.planEviction([e("a", 1, 1), e("b", 1, 2)], 10, 5), []);
  assert.deepEqual(C.planEviction([e("a", 1, 3), e("b", 1, 1), e("c", 1, 2)], 100, 2), ["b"]);
  assert.deepEqual(C.planEviction([e("a", 6, 3), e("b", 6, 1), e("c", 6, 2)], 12, 30), ["b"]);
  assert.deepEqual(C.planEviction([e("a", 6, 3), e("b", 6, 1), e("c", 6, 2)], 5, 30), ["b", "c", "a"]);
});

test("no Cache Storage: get/put/clear fall back silently", async () => {
  const b = { id: 1, sizeBytes: 3 };
  assert.equal(await C.getCachedBook(b), null);
  await C.putCachedBook(b, new ArrayBuffer(3));
  await C.clearBookCache();
});
