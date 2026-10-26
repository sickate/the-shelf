import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeProgress } from "../app/worker.mjs";
import { ORIGIN, setup } from "./helpers/mvp-fixture.mjs";

const enc = new TextEncoder();

async function ready(t) {
  const ctx = await setup(t);
  const cookie = await ctx.login();
  const upload = async (path, text) => {
    const res = await ctx.upload(cookie, path, enc.encode(text));
    assert.equal(res.status, 200);
    return (await res.json()).book.id;
  };
  const bookA = await upload("01-计算机/算法导论.pdf", "%PDF-1.4 " + "a".repeat(300));
  const bookB = await upload("02-文学/系列/红楼梦.txt", "红楼梦 " + "b".repeat(300));
  const bookC = await upload("03-历史/史记.epub", "PK epub " + "c".repeat(300));
  const owner = (init = {}) => ({
    ...init,
    headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json", ...init.headers },
  });
  const opened = (bookId, body, extra = {}) =>
    ctx.fetch(`/api/books/${bookId}/opened`, owner({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body), ...extra }));
  const progress = (bookId, body, extra = {}) =>
    ctx.fetch(`/api/books/${bookId}/progress`, owner({ method: "PUT", body: JSON.stringify(body), ...extra }));
  const list = async (query = "") => {
    const res = await ctx.fetch(`/api/recent${query}`, owner());
    assert.equal(res.status, 200);
    return (await res.json()).recent;
  };
  const at = (bookId, iso) => ctx.sqlite.prepare("UPDATE reading_history SET last_opened_at = ? WHERE book_id = ?").run(iso, bookId);
  return { ...ctx, cookie, bookA, bookB, bookC, owner, opened, progress, list, at };
}

test("recent: migration and schema.sql define the same table", async () => {
  const mig = await readFile(new URL("../app/migrations/0006_reading.sql", import.meta.url), "utf8");
  const schema = await readFile(new URL("../app/schema.sql", import.meta.url), "utf8");
  const ddl = (s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
  const table = ddl(mig);
  assert.match(table, /CREATE TABLE IF NOT EXISTS reading_history/);
  assert.ok(ddl(schema).includes(table));
});

test("recent: visitors get 401 everywhere, cross-origin writes 403", async (t) => {
  const c = await ready(t);
  assert.equal((await c.opened(c.bookA)).status, 200);
  const anon = { Origin: ORIGIN, "Content-Type": "application/json" };
  const cases = [
    ["/api/recent", { headers: anon }],
    ["/api/recent?limit=abc", { headers: anon }],
    [`/api/books/${c.bookA}/opened`, { method: "POST", headers: anon }],
    [`/api/books/${c.bookA}/opened`, { method: "POST", headers: anon, body: "{" }],
    [`/api/books/${c.bookA}/progress`, { method: "PUT", headers: anon, body: JSON.stringify({ progress: "x" }) }],
    [`/api/books/b_missing/progress`, { method: "PUT", headers: anon, body: "[]" }],
    [`/api/recent/${c.bookA}`, { method: "DELETE", headers: anon }],
  ];
  for (const [path, init] of cases) {
    const res = await c.fetch(path, init);
    assert.equal(res.status, 401, `${init.method || "GET"} ${path}`);
    assert.deepEqual(await res.json(), { error: "login_required" });
  }
  const evil = { Origin: "https://evil.test" };
  assert.equal((await c.opened(c.bookA, {}, { headers: { Cookie: c.cookie, ...evil } })).status, 403);
  assert.equal((await c.progress(c.bookA, { progress: "x" }, { headers: evil })).status, 403);
  assert.equal((await c.fetch(`/api/recent/${c.bookA}`, { method: "DELETE", headers: { Cookie: c.cookie } })).status, 403);
  const [row] = await c.list();
  assert.equal(row.openCount, 1);
  assert.equal(row.progress, null);
});

test("recent: progress validation", async (t) => {
  const c = await ready(t);
  assert.equal((await c.opened(c.bookA)).status, 200);
  const cases = [
    [{ progress: 12 }, "bad_progress"],
    [{ progress: ["x"] }, "bad_progress"],
    [{ progress: "第 1\n页" }, "bad_progress"],
    [{ progress: "a\u0000b" }, "bad_progress"],
    [{ progress: "a\u007fb" }, "bad_progress"],
    [{ progress: "a\u2028b" }, "bad_progress"],
    [{ progress: "字".repeat(41) }, "progress_too_long"],
  ];
  for (const [body, error] of cases) {
    for (const res of [await c.opened(c.bookA, body), await c.progress(c.bookA, body)]) {
      assert.equal(res.status, 400, `${error} ${JSON.stringify(body)}`);
      assert.deepEqual(await res.json(), { error });
    }
  }
  for (const raw of ["{", "[]", "null", '"x"']) {
    const res = await c.fetch(`/api/books/${c.bookA}/opened`, c.owner({ method: "POST", body: raw }));
    assert.deepEqual([res.status, await res.json()], [400, { error: "bad_json" }], raw);
    const put = await c.fetch(`/api/books/${c.bookA}/progress`, c.owner({ method: "PUT", body: raw }));
    assert.deepEqual([put.status, await put.json()], [400, { error: "bad_json" }], raw);
  }
  // PUT requires the field (null / "" clear it); an empty PUT body is not JSON.
  assert.deepEqual(await (await c.progress(c.bookA, {})).json(), { error: "bad_progress" });
  const empty = await c.fetch(`/api/books/${c.bookA}/progress`, c.owner({ method: "PUT" }));
  assert.equal(empty.status, 400);
  // Exact limit (code points, trimmed) is accepted.
  let res = await c.progress(c.bookA, { progress: `  ${"𝄞".repeat(40)}  ` });
  assert.equal(res.status, 200);
  assert.equal([...(await res.json()).progress].length, 40);
  res = await c.progress(c.bookA, { progress: "  " });
  assert.deepEqual(await res.json(), { bookId: c.bookA, progress: null });
  assert.equal(normalizeProgress(undefined), null);
  assert.equal(normalizeProgress(" 第 12 / 300 页 "), "第 12 / 300 页");
  assert.equal(normalizeProgress("约 35%"), "约 35%");
  // limit parsing
  for (const q of ["?limit=0", "?limit=abc", "?limit=-1", "?limit=1.5", "?limit=1234567"]) {
    const r = await c.fetch(`/api/recent${q}`, c.owner());
    assert.deepEqual([r.status, await r.json()], [400, { error: "bad_limit" }], q);
  }
});

test("recent: upsert counts, keeps progress, orders by last open", async (t) => {
  const c = await ready(t);
  let res = await c.opened(c.bookA, { progress: "第 3 / 10 页" });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.openCount, 1);
  assert.equal(body.progress, "第 3 / 10 页");
  assert.ok(body.lastOpenedAt);
  // A bare open bumps the count and keeps the last progress; a new progress replaces it.
  body = await (await c.opened(c.bookA)).json();
  assert.deepEqual([body.openCount, body.progress], [2, "第 3 / 10 页"]);
  body = await (await c.opened(c.bookA, { progress: null })).json();
  assert.deepEqual([body.openCount, body.progress], [3, "第 3 / 10 页"]);
  body = await (await c.opened(c.bookA, { progress: "第 5 / 10 页" })).json();
  assert.deepEqual([body.openCount, body.progress], [4, "第 5 / 10 页"]);

  assert.equal((await c.opened(c.bookB)).status, 200);
  assert.equal((await c.opened(c.bookC, { progress: "约 35%" })).status, 200);
  c.at(c.bookA, "2026-10-01T00:00:00.000Z");
  c.at(c.bookB, "2026-10-03T00:00:00.000Z");
  c.at(c.bookC, "2026-10-02T00:00:00.000Z");
  let rows = await c.list();
  assert.deepEqual(rows.map((r) => r.id), [c.bookB, c.bookC, c.bookA]);
  const a = rows[2];
  assert.equal(a.title, "算法导论");
  assert.equal(a.format, "PDF");
  assert.equal(a.status, "uploaded");
  assert.equal(a.openCount, 4);
  assert.equal(a.progress, "第 5 / 10 页");
  assert.equal(a.lastOpenedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(a.hasCover, false);
  assert.deepEqual(a.authors, []);
  assert.equal(rows[0].title, "系列/红楼梦");
  assert.equal(rows[0].progress, null);
  assert.ok(!("sha256" in a) && !("r2_key" in a) && !("source_path" in a));

  // Opening again moves a book to the front.
  await c.opened(c.bookA);
  rows = await c.list();
  assert.deepEqual(rows.map((r) => r.id), [c.bookA, c.bookB, c.bookC]);
  assert.deepEqual((await c.list("?limit=2")).map((r) => r.id), [c.bookA, c.bookB]);
  assert.equal((await c.list("?limit=999")).length, 3); // clamped to 100

  // Progress updates do not change the order or the count.
  res = await c.progress(c.bookC, { progress: "约 60%" });
  assert.deepEqual(await res.json(), { bookId: c.bookC, progress: "约 60%" });
  rows = await c.list();
  assert.deepEqual(rows.map((r) => r.id), [c.bookA, c.bookB, c.bookC]);
  assert.deepEqual([rows[2].progress, rows[2].openCount], ["约 60%", 1]);
});

test("recent: default limit 20, max 100", async (t) => {
  const c = await ready(t);
  const ins = c.sqlite.prepare(
    `INSERT INTO books VALUES (?, ?, '01-x', 'PDF', 1, ?, ?, ?, 'uploaded', '2026-01-01', NULL)`,
  );
  const hist = c.sqlite.prepare("INSERT INTO reading_history VALUES (?, ?, 1, NULL)");
  for (let i = 0; i < 120; i++) {
    const id = `b_bulk${String(i).padStart(3, "0")}`;
    ins.run(id, `书 ${i}`, `h${i}`, `books/${id}`, `x/${id}.pdf`);
    hist.run(id, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
  }
  const rows = await c.list();
  assert.equal(rows.length, 20);
  assert.equal(rows[0].id, "b_bulk119");
  assert.equal((await c.list("?limit=100")).length, 100);
  assert.equal((await c.list("?limit=101")).length, 100);
  assert.equal((await c.list("?limit=")).length, 20);
});

test("recent: missing, deleted and non-uploaded books are rejected or excluded; DELETE removes", async (t) => {
  const c = await ready(t);
  for (const id of [c.bookA, c.bookB, c.bookC]) assert.equal((await c.opened(id)).status, 200);
  // Unknown / never opened
  assert.equal((await c.opened("b_missing")).status, 404);
  assert.equal((await c.progress("b_missing", { progress: "x" })).status, 404);
  c.sqlite
    .prepare(`INSERT INTO books VALUES ('b_local','本地书','x','PDF',1,'l1',NULL,'x/l.pdf','local_only','2026-01-01',NULL)`)
    .run();
  c.sqlite
    .prepare(`INSERT INTO books VALUES ('b_reserved','r','x','PDF',1,'r1','books/r','x/r.pdf','reserved','2026-01-01',NULL)`)
    .run();
  for (const id of ["b_local", "b_reserved"]) {
    assert.equal((await c.opened(id)).status, 404, id);
    assert.equal((await c.progress(id, { progress: "x" })).status, 404, id);
  }
  // A book that is readable but was never opened: PUT progress is 404 not_opened (no row created).
  c.sqlite.prepare("DELETE FROM reading_history WHERE book_id = ?").run(c.bookC);
  let res = await c.progress(c.bookC, { progress: "x" });
  assert.deepEqual([res.status, await res.json()], [404, { error: "not_opened" }]);
  assert.equal(c.sqlite.prepare("SELECT COUNT(*) AS n FROM reading_history WHERE book_id = ?").get(c.bookC).n, 0);
  assert.equal((await c.opened(c.bookC)).status, 200);

  // A history row whose book later became non-uploaded is hidden from the list.
  c.sqlite.prepare("INSERT INTO reading_history VALUES ('b_local', '2030-01-01T00:00:00.000Z', 1, NULL)").run();
  assert.ok(!(await c.list()).some((r) => r.id === "b_local"));

  // Soft-deleted book: hidden and can't be opened; restoring brings it back.
  assert.equal((await c.fetch(`/api/books/${c.bookB}`, c.owner({ method: "DELETE" }))).status, 200);
  assert.ok(!(await c.list()).some((r) => r.id === c.bookB));
  assert.equal((await c.opened(c.bookB)).status, 404);
  assert.equal((await c.progress(c.bookB, { progress: "x" })).status, 404);
  c.sqlite.prepare("UPDATE books SET deleted_at = NULL WHERE id = ?").run(c.bookB);
  assert.ok((await c.list()).some((r) => r.id === c.bookB));

  // DELETE removes the row; a second delete is 404; opening again starts from 1.
  const del = (id) => c.fetch(`/api/recent/${id}`, c.owner({ method: "DELETE" }));
  res = await del(c.bookA);
  assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  assert.equal((await del(c.bookA)).status, 404);
  assert.equal((await del("bad/id")).status, 404);
  assert.ok(!(await c.list()).some((r) => r.id === c.bookA));
  assert.equal((await (await c.opened(c.bookA)).json()).openCount, 1);
  // Other methods on the new paths are 404.
  assert.equal((await c.fetch(`/api/books/${c.bookA}/opened`, c.owner())).status, 404);
  assert.equal((await c.fetch(`/api/recent`, c.owner({ method: "POST", body: "{}" }))).status, 404);
});
