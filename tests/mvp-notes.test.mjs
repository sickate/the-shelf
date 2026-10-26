import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, normalizeLocator, notesCsv } from "../app/worker.mjs";
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
  const bookA = await upload("01-计算机/算法导论.epub", "PK epub " + "a".repeat(300));
  const bookB = await upload("02-文学/系列/红楼梦.txt", "红楼梦 " + "b".repeat(300));
  const owner = (init = {}) => ({
    ...init,
    headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/json", ...init.headers },
  });
  const create = (bookId, body, extra = {}) =>
    ctx.fetch(`/api/books/${bookId}/notes`, owner({ method: "POST", body: JSON.stringify(body), ...extra }));
  const add = async (bookId, body) => {
    const res = await create(bookId, body);
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    return (await res.json()).note;
  };
  const list = async (query = "") => {
    const res = await ctx.fetch(`/api/notes${query}`, owner());
    assert.equal(res.status, 200);
    return res.json();
  };
  return { ...ctx, cookie, bookA, bookB, owner, create, add, list };
}

const cfi = { type: "cfi", cfi: "epubcfi(/6/4!/4/2/1:0)" };

test("notes: visitors get 401 everywhere, cross-origin writes 403", async (t) => {
  const c = await ready(t);
  const note = await c.add(c.bookA, { quote: "q", locator: cfi });
  const anon = { Origin: ORIGIN, "Content-Type": "application/json" };
  const cases = [
    ["/api/notes", { headers: anon }],
    [`/api/notes?book=${c.bookA}`, { headers: anon }],
    ["/api/notes/export?format=json", { headers: anon }],
    [`/api/books/${c.bookA}/notes`, { method: "POST", headers: anon, body: JSON.stringify({ quote: "x", locator: cfi }) }],
    [`/api/notes/${note.id}`, { method: "PATCH", headers: anon, body: JSON.stringify({ note: "x" }) }],
    [`/api/notes/${note.id}`, { method: "DELETE", headers: anon }],
    // Visitors are rejected before any validation.
    [`/api/books/${c.bookA}/notes`, { method: "POST", headers: anon, body: "{" }],
    ["/api/notes/export?format=xml", { headers: anon }],
  ];
  for (const [path, init] of cases) {
    const res = await c.fetch(path, init);
    assert.equal(res.status, 401, `${init.method || "GET"} ${path}`);
    assert.deepEqual(await res.json(), { error: "login_required" });
  }
  const evil = { Origin: "https://evil.test" };
  assert.equal((await c.create(c.bookA, { quote: "x", locator: cfi }, { headers: { Cookie: c.cookie, ...evil } })).status, 403);
  const patch = await c.fetch(`/api/notes/${note.id}`, c.owner({ method: "PATCH", body: "{}", headers: evil }));
  assert.equal(patch.status, 403);
  const del = await c.fetch(`/api/notes/${note.id}`, { method: "DELETE", headers: { Cookie: c.cookie } });
  assert.equal(del.status, 403);
  assert.equal((await c.list()).notes.length, 1);
});

test("notes: create validation", async (t) => {
  const c = await ready(t);
  const base = { quote: "一段话", locator: cfi };
  const cases = [
    [{ ...base, quote: undefined }, "bad_quote"],
    [{ ...base, quote: "   \n " }, "bad_quote"],
    [{ ...base, quote: 12 }, "bad_quote"],
    [{ ...base, quote: "字".repeat(4001) }, "quote_too_long"],
    [{ ...base, note: "字".repeat(10_001) }, "note_too_long"],
    [{ ...base, note: 5 }, "bad_note"],
    [{ ...base, label: "x".repeat(201) }, "label_too_long"],
    [{ ...base, label: ["x"] }, "bad_label"],
    [{ ...base, color: "red" }, "bad_color"],
    [{ ...base, locator: undefined }, "bad_locator"],
    [{ ...base, locator: "epubcfi(/6/4)" }, "bad_locator"],
    [{ ...base, locator: [cfi] }, "bad_locator"],
    [{ ...base, locator: { type: "cfi", cfi: "" } }, "bad_locator"],
    [{ ...base, locator: { type: "cfi", cfi: "x", extra: 1 } }, "bad_locator"],
    [{ ...base, locator: { type: "pdf", page: 0 } }, "bad_locator"],
    [{ ...base, locator: { type: "pdf", page: 2, start: -1 } }, "bad_locator"],
    [{ ...base, locator: { type: "pdf", page: 2, start: 5, end: 3 } }, "bad_locator"],
    [{ ...base, locator: { type: "text", start: 1 } }, "bad_locator"],
    [{ ...base, locator: { type: "text", start: 1.5, end: 3 } }, "bad_locator"],
    [{ ...base, locator: { type: "epub", start: 1, end: 3 } }, "bad_locator"],
    [{ ...base, locator: { type: "cfi", cfi: "c".repeat(2000) } }, "locator_too_large"],
    [[], "bad_json"],
  ];
  for (const [body, error] of cases) {
    const res = await c.create(c.bookA, body);
    assert.equal(res.status, 400, error);
    assert.deepEqual(await res.json(), { error });
  }
  assert.deepEqual(await (await c.create(c.bookA, base, { body: "{" })).json(), { error: "bad_json" });
  // Exact limits are accepted (quote is trimmed first, counted in code points).
  const ok = await c.add(c.bookA, {
    ...base,
    quote: `  ${"𝄞".repeat(4000)}  `,
    note: "n".repeat(10_000),
    label: "l".repeat(200),
  });
  assert.equal([...ok.quote].length, 4000);
  // Missing, soft-deleted and reserved books are 404.
  assert.equal((await c.create("b_missing", base)).status, 404);
  c.sqlite
    .prepare(
      `INSERT INTO books VALUES ('b_reserved','r','x','PDF',1,'r'||hex(randomblob(8)),'books/r','x/r.pdf','reserved','2026-01-01',NULL)`,
    )
    .run();
  assert.equal((await c.create("b_reserved", base)).status, 404);
  assert.equal((await c.fetch(`/api/books/${c.bookB}`, c.owner({ method: "DELETE" }))).status, 200);
  assert.equal((await c.create(c.bookB, base)).status, 404);
  assert.equal((await c.list()).notes.length, 1);
});

test("notes: locator shapes are canonicalised", () => {
  assert.equal(normalizeLocator({ cfi: "x", type: "cfi" }), '{"type":"cfi","cfi":"x"}');
  assert.equal(normalizeLocator({ type: "pdf", page: 12 }), '{"type":"pdf","page":12}');
  assert.equal(normalizeLocator({ type: "pdf", page: 3, end: 9, start: 4 }), '{"type":"pdf","page":3,"start":4,"end":9}');
  assert.equal(normalizeLocator({ type: "text", end: 10, start: 0 }), '{"type":"text","start":0,"end":10}');
});

test("notes: CRUD, ordering, pagination and soft delete", async (t) => {
  const c = await ready(t);
  const first = await c.add(c.bookA, { quote: "  第一条  ", locator: cfi, label: "第 1 章" });
  assert.match(first.id, /^n_[0-9a-f]{24}$/);
  assert.deepEqual(
    { ...first, id: undefined, createdAt: undefined, updatedAt: undefined },
    {
      id: undefined,
      bookId: c.bookA,
      bookTitle: "算法导论",
      bookFormat: "EPUB",
      quote: "第一条",
      note: null,
      color: "yellow",
      locator: cfi,
      label: "第 1 章",
      createdAt: undefined,
      updatedAt: undefined,
    },
  );
  const second = await c.add(c.bookB, { quote: "第二条", note: "  想法  ", color: "blue", locator: { type: "text", start: 3, end: 9 } });
  assert.equal(second.note, "想法");
  // Force distinct, known timestamps for ordering and the cursor.
  c.sqlite.prepare("UPDATE notes SET created_at = '2026-10-01T00:00:00.000Z' WHERE id = ?").run(first.id);
  c.sqlite.prepare("UPDATE notes SET created_at = '2026-10-02T00:00:00.000Z' WHERE id = ?").run(second.id);
  const third = await c.add(c.bookA, { quote: "第三条", locator: { type: "pdf", page: 2 } });

  let data = await c.list();
  assert.deepEqual(data.notes.map((n) => n.id), [third.id, second.id, first.id]);
  assert.equal(data.notes[1].bookTitle, "系列/红楼梦");
  assert.equal(data.nextBefore, null);
  assert.deepEqual((await c.list(`?book=${c.bookA}`)).notes.map((n) => n.id), [third.id, first.id]);

  data = await c.list("?limit=2");
  assert.deepEqual(data.notes.map((n) => n.id), [third.id, second.id]);
  assert.equal(data.nextBefore, "2026-10-02T00:00:00.000Z");
  data = await c.list(`?limit=2&before=${encodeURIComponent(data.nextBefore)}`);
  assert.deepEqual(data.notes.map((n) => n.id), [first.id]);
  assert.equal(data.nextBefore, null);
  for (const q of ["?limit=0", "?limit=abc", "?limit=-1", "?book=a/b"]) {
    assert.equal((await c.fetch(`/api/notes${q}`, c.owner())).status, 400, q);
  }
  assert.equal((await c.list("?limit=999999")).notes.length, 3); // clamped to 1000

  // PATCH note text and colour.
  const patch = (id, body) => c.fetch(`/api/notes/${id}`, c.owner({ method: "PATCH", body: JSON.stringify(body) }));
  let res = await patch(first.id, { note: "补充", color: "pink" });
  assert.equal(res.status, 200);
  let updated = (await res.json()).note;
  assert.equal(updated.note, "补充");
  assert.equal(updated.color, "pink");
  assert.equal(updated.quote, "第一条");
  assert.ok(updated.updatedAt >= first.updatedAt);
  res = await patch(first.id, { note: "" });
  assert.equal((await res.json()).note.note, null);
  assert.equal((await patch(first.id, { color: "green" })).status, 200);
  for (const [body, error] of [
    [{}, "nothing_to_update"],
    [{ quote: "改原文" }, "nothing_to_update"],
    [{ color: "red" }, "bad_color"],
    [{ note: "x".repeat(10_001) }, "note_too_long"],
  ]) {
    res = await patch(first.id, body);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error });
  }
  assert.equal((await patch("n_missing", { note: "x" })).status, 404);

  // Soft delete: hidden from list/export, row kept, second delete and edits are 404.
  const del = (id) => c.fetch(`/api/notes/${id}`, c.owner({ method: "DELETE" }));
  assert.equal((await del(second.id)).status, 200);
  assert.equal((await del(second.id)).status, 404);
  assert.equal((await patch(second.id, { note: "x" })).status, 404);
  assert.deepEqual((await c.list()).notes.map((n) => n.id), [third.id, first.id]);
  const kept = c.sqlite.prepare("SELECT deleted_at FROM notes WHERE id = ?").get(second.id);
  assert.ok(kept.deleted_at);

  // Soft-deleting the book hides its notes; they come back when the book is restored.
  assert.equal((await c.fetch(`/api/books/${c.bookA}`, c.owner({ method: "DELETE" }))).status, 200);
  assert.deepEqual((await c.list()).notes, []);
  assert.equal((await patch(first.id, { note: "x" })).status, 404);
  c.sqlite.prepare("UPDATE books SET deleted_at = NULL WHERE id = ?").run(c.bookA);
  assert.equal((await c.list()).notes.length, 2);
});

test("notes: q searches quote and note, escaping LIKE wildcards", async (t) => {
  const c = await ready(t);
  const pct = await c.add(c.bookA, { quote: "增长 100% 的秘密", locator: cfi });
  const under = await c.add(c.bookA, { quote: "snake_case 命名", locator: cfi });
  const inNote = await c.add(c.bookB, { quote: "无关原文", note: "笔记里提到 Ab\\c", locator: cfi });
  await c.add(c.bookB, { quote: "100 个 snakeXcase 例子", locator: cfi });
  const ids = async (q, extra = "") => (await c.list(`?q=${encodeURIComponent(q)}${extra}`)).notes.map((n) => n.id);
  assert.deepEqual(await ids("100%"), [pct.id]);
  assert.deepEqual(await ids("%"), [pct.id]);
  assert.deepEqual(await ids("snake_case"), [under.id]);
  assert.deepEqual(await ids("_"), [under.id]);
  assert.deepEqual(await ids("b\\c"), [inNote.id]);
  assert.deepEqual(await ids("ab"), [inNote.id]); // LIKE is case-insensitive for ASCII
  assert.deepEqual(await ids("原文"), [inNote.id]);
  assert.deepEqual(await ids("100", `&book=${c.bookA}`), [pct.id]);
  assert.equal((await ids("   ")).length, 4);
  assert.equal((await c.fetch(`/api/notes?q=${"x".repeat(201)}`, c.owner())).status, 400);
});

test("notes: export md / csv / json with filters and CSV injection guard", async (t) => {
  const c = await ready(t);
  const a1 = await c.add(c.bookA, { quote: "第一行\n第二行", note: "我的想法", label: "第 3 章", locator: cfi });
  const evil = await c.add(c.bookB, {
    quote: '=HYPERLINK("http://evil.test","x")',
    note: "+1, -2 \"引号\"",
    label: "@label",
    locator: { type: "text", start: 0, end: 5 },
  });
  await c.add(c.bookB, { quote: "-负号开头", locator: cfi });
  const get = (q) => c.fetch(`/api/notes/export${q}`, c.owner());
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  for (const q of ["", "?format=xml", "?format=MD"]) {
    const res = await get(q);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad_format" });
  }

  // JSON
  let res = await get("?format=json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("Content-Disposition"), `attachment; filename="the-shelf-notes-${today}.json"`);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  const data = await res.json();
  assert.equal(data.count, 3);
  assert.ok(data.notes.every((n) => typeof n.bookTitle === "string" && n.locator && typeof n.locator === "object"));
  const filtered = await (await get(`?format=json&book=${c.bookA}`)).json();
  assert.deepEqual(filtered.notes.map((n) => n.id), [a1.id]);
  assert.equal((await (await get(`?format=json&q=${encodeURIComponent("引号")}`)).json()).count, 1);

  // CSV
  res = await get("?format=csv");
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("Content-Disposition"), `attachment; filename="the-shelf-notes-${today}.csv"`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM
  const csv = new TextDecoder().decode(bytes.slice(3));
  const lines = csv.split("\r\n");
  assert.equal(lines[0], '"book_title","quote","note","color","label","created_at","updated_at","book_id","note_id","locator"');
  assert.equal(lines.at(-1), "");
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.test"",""x"")"`));
  assert.ok(csv.includes(`"'+1, -2 ""引号"""`));
  assert.ok(csv.includes(`"'@label"`));
  assert.ok(csv.includes(`"'-负号开头"`));
  assert.ok(csv.includes('"第一行\n第二行"')); // embedded newline stays inside a quoted field
  assert.ok(csv.includes(`"${evil.id}"`));
  assert.equal(csvCell("\tcmd"), `"'\tcmd"`);
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell("普通"), '"普通"');
  assert.equal(notesCsv([]).split("\r\n").length, 2);

  // Markdown
  res = await get("?format=md");
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(res.headers.get("Content-Disposition"), `attachment; filename="the-shelf-notes-${today}.md"`);
  const md = await res.text();
  assert.match(md, /^# The Shelf 笔记摘要\n/);
  assert.match(md, /共 3 条/);
  const iA = md.indexOf("## 算法导论");
  const iB = md.indexOf("## 系列 / 红楼梦");
  assert.ok(iA > 0 && iB > 0);
  assert.ok(md.includes("> 第一行\n> 第二行\n\n我的想法\n\n— 第 3 章 · "));
  assert.ok(md.includes('> =HYPERLINK("http://evil.test","x")'));
  const mdA = await (await get(`?format=md&book=${c.bookA}`)).text();
  assert.ok(mdA.includes("## 算法导论") && !mdA.includes("红楼梦"));
});
