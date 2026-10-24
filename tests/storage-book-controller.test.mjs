import test from "node:test";
import assert from "node:assert/strict";
import {
  storageBooks,
  storageBookCursor,
  STORAGE_BOOK_PAGE_SQL,
  STORAGE_BOOK_DETAIL_SQL,
  STORAGE_BOOK_READ_LIMITS,
} from "../cloudflare/library/storage-book-controller.mjs";
import { managementRoute } from "../cloudflare/library/management.mjs";
import { fixture, context, session } from "./helpers/storage-read-fixture.mjs";
const reject = (fn, status) => assert.rejects(fn, (e) => e.status === status);
const read = (f, options) => storageBooks(f.env, context, session, options);
function book(f, id, options = {}) {
  const b = { ...f.book, id, title: id, files: [], ...options };
  f.db
    .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
    .run(id, JSON.stringify(b));
  return b;
}
function rewrite(f, id, changes) {
  const b = JSON.parse(
    f.db
      .prepare("SELECT public_json FROM catalog_books WHERE book_id=?")
      .get(id).public_json,
  );
  f.db
    .prepare("UPDATE catalog_books SET public_json=? WHERE book_id=?")
    .run(JSON.stringify({ ...b, ...changes }), id);
}
for (const source of ["normal", "trial"])
  for (const detail of [false, true])
    test(`${source} ${detail ? "detail" : "page"} uses one primary SELECT, no object/credential operations`, async (t) => {
      const f = fixture(t, { source });
      const result = await read(
        f,
        detail ? { bookId: "book_shared" } : undefined,
      );
      const b = detail ? result.book : result.books[0].book;
      assert.equal(b.id, "book_shared");
      assert.equal(b.files[0].reason, "uploaded");
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].params.length, 6);
      assert.equal(
        f.calls[0].sql,
        detail ? STORAGE_BOOK_DETAIL_SQL : STORAGE_BOOK_PAGE_SQL,
      );
      assert.deepEqual(f.r2, []);
      assert.equal(f.secretReads(), 0);
      assert.equal(f.writeReads(), 0);
    });
test("fixed SQL budgets and closed list auth", async (t) => {
  const f = fixture(t);
  for (const sql of [STORAGE_BOOK_PAGE_SQL, STORAGE_BOOK_DETAIL_SQL]) {
    assert.ok(Buffer.byteLength(sql) <= STORAGE_BOOK_READ_LIMITS.sqlBytes);
    assert.equal((sql.match(/\?/g) || []).length, 6);
  }
  await reject(() => storageBooks(f.env, context, null), 401);
  assert.equal(f.calls.length, 0);
});
for (const query of [
  "?cursor=",
  "?cursor=a&cursor=b",
  "?other=a",
  "?cursor=a%2Fb",
  "?cursor=" + "x".repeat(101),
])
  test(`strict cursor rejects ${query.slice(0, 40)}`, () => {
    assert.throws(
      () =>
        storageBookCursor(new Request(context.origin + "/api/manage" + query)),
      (e) => e.status === 400,
    );
  });
test("cursor first page and canonical IDs", () => {
  assert.equal(
    storageBookCursor(new Request(context.origin + "/api/manage")),
    "",
  );
  assert.equal(
    storageBookCursor(
      new Request(context.origin + "/api/manage?cursor=book_a-1"),
    ),
    "book_a-1",
  );
});
test("100-book keyset pages are user-addressable with no skipped or repeated book", async (t) => {
  const f = fixture(t);
  f.unsafe(() => {
    for (let i = 0; i < 230; i++) book(f, "book_" + String(i).padStart(4, "0"));
  });
  let cursor = "",
    seen = [];
  do {
    const p = await read(f, { cursor });
    assert.ok(p.books.length <= 100);
    seen.push(...p.books.map((e) => e.book.id));
    cursor = p.pagination.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 231);
  assert.equal(new Set(seen).size, 231);
  assert.equal(f.calls.length, 3);
});
for (const change of [
  "both",
  "wrong-book",
  "missing-registry",
  "missing-reservation",
  "raw-unverified",
  "unattributed-claim",
])
  test(`global source facts reject ${change}`, async (t) => {
    const f = fixture(t, { source: change === "both" ? "both" : "normal" });
    f.unsafe(() => {
      if (change === "wrong-book") {
        book(f, "other");
        f.db.prepare("UPDATE file_registry SET book_id='other'").run();
      }
      if (change === "missing-registry")
        f.db.exec("DELETE FROM shelf_storage_original_registry");
      if (change === "missing-reservation") {
        f.db.exec("PRAGMA foreign_keys=OFF");
        f.db.exec("DELETE FROM shelf_storage_reservations");
        f.db.exec("PRAGMA foreign_keys=ON");
      }
      if (change === "raw-unverified")
        f.db.exec(
          "UPDATE shelf_storage_reservations SET state='uncertain',content_verified=0",
        );
      if (change === "unattributed-claim")
        rewrite(f, "book_shared", { files: [] });
    });
    await reject(() => read(f), 409);
    assert.equal(f.calls.length, 1);
  });
test("unconfirmed file still has zero-count source group and stays pending", async (t) => {
  const f = fixture(t);
  f.unsafe(() => f.db.exec("UPDATE file_registry SET state='reserved'"));
  const p = await read(f);
  assert.notEqual(p.books[0].book.files[0].status, "available");
});
for (const [mode, status] of [
  ["private", 404],
  ["public", 200],
  ["trash", 404],
])
  test(`anonymous detail ${mode}`, async (t) => {
    const f = fixture(t);
    if (mode !== "private")
      f.db
        .prepare("UPDATE book_management SET visibility=?,trashed=?")
        .run("public", mode === "trash" ? 1 : 0);
    if (status === 404)
      await reject(
        () => storageBooks(f.env, context, null, { bookId: "book_shared" }),
        404,
      );
    else
      assert.equal(
        (await storageBooks(f.env, context, null, { bookId: "book_shared" }))
          .book.id,
        "book_shared",
      );
  });
test("management displays trash while detail withholds it", async (t) => {
  const f = fixture(t);
  f.db.exec("UPDATE book_management SET trashed=1");
  assert.equal((await read(f)).books[0].trashed, true);
  await reject(() => read(f, { bookId: "book_shared" }), 404);
});
for (const sql of [
  "UPDATE sessions SET revoked=1",
  "UPDATE sessions SET generation=2",
  "UPDATE sessions SET created_at=0,expires_at=1",
  "UPDATE auth_config SET enabled=0",
  "UPDATE auth_config SET generation=2",
])
  test(`owner session fails closed: ${sql}`, async (t) => {
    const f = fixture(t);
    f.unsafe(() => f.db.exec(sql));
    await reject(() => read(f), 401);
  });
for (const name of [
  "DB",
  "withSession",
  "prepare",
  "normal-binding",
  "trial-method",
  "scope",
  "write-mode",
])
  test(`await capability drift ${name} is rejected`, async (t) => {
    const f = fixture(t);
    f.env.DB.afterFirst = () => {
      if (name === "DB") f.env.DB = { ...f.env.DB };
      if (name === "withSession")
        f.env.DB.withSession = function () {
          return this;
        };
      if (name === "prepare")
        f.env.DB.prepare = () => {
          throw Error("replaced");
        };
      if (name === "normal-binding") f.env.BOOKS = { ...f.normalStore };
      if (name === "trial-method") f.trialStore.head = async () => null;
      if (name === "scope") f.env.APP_SCOPE = "check";
      if (name === "write-mode") f.env.STORAGE_WRITE_MODE = "open";
    };
    await assert.rejects(
      () => read(f),
      (e) => [409, 503].includes(e.status),
    );
  });
for (const kind of [
  "catalog",
  "patch",
  "source-descriptor",
  "source-other-text",
])
  test(`later ${kind} oversize preserves earlier prefix and first oversize fails`, async (t) => {
    const f = fixture(t);
    f.unsafe(() => {
      book(f, "book_0000");
      if (kind === "catalog")
        rewrite(f, "book_shared", { description: "x".repeat(262144) });
      if (kind === "patch")
        f.db
          .prepare(
            "INSERT INTO metadata_overrides VALUES('production','book_shared',?,1,0)",
          )
          .run(JSON.stringify({ description: "x".repeat(32768) }));
      if (kind === "source-descriptor")
        f.db
          .prepare(
            "UPDATE shelf_storage_original_registry SET descriptor_json=?",
          )
          .run(JSON.stringify({ x: "x".repeat(4096) }));
      if (kind === "source-other-text")
        f.db.prepare("UPDATE file_registry SET etag=?").run("x".repeat(40000));
    });
    const first = await read(f);
    assert.deepEqual(
      first.books.map((e) => e.book.id),
      ["book_0000"],
    );
    assert.equal(first.pagination.nextCursor, "book_0000");
    await reject(() => read(f, { cursor: "book_0000" }), 503);
  });
test("maximum legal catalogs fit a continuous byte prefix under 1MiB", async (t) => {
  const f = fixture(t);
  f.unsafe(() => {
    for (let i = 0; i < 10; i++) {
      const id = "book_" + String(i).padStart(4, "0");
      const b = { ...f.book, id, files: [], description: "" };
      b.description = "x".repeat(262144 - Buffer.byteLength(JSON.stringify(b)));
      book(f, id, b);
    }
  });
  const out = await read(f);
  assert.equal(out.books.length, 3);
  const row = f.db
    .prepare(STORAGE_BOOK_PAGE_SQL)
    .get("production", "", session.session_hash, 1, Date.now(), context.origin);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 1048576);
});
test("escaping and metadata are charged as transport UTF8, rather than character count", async (t) => {
  const f = fixture(t);
  f.unsafe(() => {
    for (let i = 0; i < 12; i++) {
      const id = "book_" + String(i).padStart(4, "0");
      book(f, id, { description: '"\\\t\n'.repeat(16000) });
      f.db
        .prepare("INSERT INTO metadata_overrides VALUES('production',?,?,1,0)")
        .run(id, JSON.stringify({ description: "字".repeat(4000) }));
    }
  });
  const out = await read(f);
  assert.ok(out.books.length > 0 && out.books.length < 12);
  const row = f.db
    .prepare(STORAGE_BOOK_PAGE_SQL)
    .get("production", "", session.session_hash, 1, Date.now(), context.origin);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 1048576);
});
test("more than 20k unrelated confirmed sources do not block an associated small page", async (t) => {
  const f = fixture(t);
  f.unsafe(() => {
    book(f, "unrelated");
    const insert = f.db.prepare(
      "INSERT INTO file_registry SELECT scope,?, 'unrelated',format,size_bytes,object_key||?,sha256,etag,state,version,updated_at FROM file_registry WHERE file_id='file_shared'",
    );
    for (let i = 0; i < 20001; i++) insert.run("other_" + i, "_" + i);
  });
  assert.equal((await read(f)).books.length, 1);
});
test("20001 claimed sources on a later book stop the prefix before that book", async (t) => {
  const f = fixture(t);
  f.unsafe(() => {
    book(f, "book_0000");
    const insert = f.db.prepare(
      "INSERT INTO file_registry SELECT scope,?,book_id,format,size_bytes,object_key||?,sha256,etag,state,version,updated_at FROM file_registry WHERE file_id='file_shared'",
    );
    for (let i = 0; i < 20001; i++) insert.run("extra_" + i, "_" + i);
  });
  const out = await read(f);
  assert.deepEqual(
    out.books.map((e) => e.book.id),
    ["book_0000"],
  );
  await reject(() => read(f, { cursor: "book_0000" }), 503);
});
for (const update of [
  "UPDATE shelf_storage_authority SET identity_json='\"'||replace(hex(zeroblob(2000)),'0','x')||'\"'",
  "UPDATE shelf_storage_authority SET phase='migration_required'",
])
  test("header authority bound and identity validation fail closed", async (t) => {
    const f = fixture(t);
    f.unsafe(() => f.db.exec(update));
    await reject(() => read(f), 503);
  });
test("malformed D1 row and forged projection are withheld", async (t) => {
  const f = fixture(t);
  const original = f.env.DB.prepare;
  f.env.DB.prepare = function (sql) {
    const stmt = original.call(this, sql);
    const bind = stmt.bind;
    stmt.bind = (...args) => {
      const bound = bind(...args);
      const first = bound.first;
      bound.first = async () => ({
        ...(await first.call(bound)),
        unexpected: true,
      });
      return bound;
    };
    return stmt;
  };
  await reject(() => read(f), 503);
});
test("management capability awaits precede one primary projection, with upload closed", async (t) => {
  const f = fixture(t);
  Object.defineProperty(f.env, "FILENAME_AI_KEY", { value: undefined });
  const d = {
    query: (fn) => fn(),
    prepare: (env, sql, ...args) => env.DB.prepare(sql).bind(...args),
    response: (status, value) => ({ status, value }),
  };
  const result = await managementRoute(
    new Request(context.origin + "/api/manage"),
    f.env,
    context,
    session,
    d,
  );
  assert.equal(result.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(result.value.upload.enabled, false);
  assert.deepEqual(result.value.upload.reasons, ["storage_write_closed"]);
});

test("owner snapshot expiry is rechecked after the awaited primary read", async (t) => {
  const f = fixture(t);
  f.unsafe(() =>
    f.db.prepare("UPDATE sessions SET expires_at=?").run(Date.now() + 40),
  );
  f.env.DB.afterFirst = () => new Promise((resolve) => setTimeout(resolve, 60));
  await reject(() => read(f), 401);
});
test("captured statement.first cannot be replaced during its await", async (t) => {
  const f = fixture(t),
    prepare = f.env.DB.prepare;
  f.env.DB.prepare = function (sql) {
    const statement = prepare.call(this, sql),
      bind = statement.bind;
    statement.bind = (...args) => {
      const bound = bind(...args);
      f.env.DB.afterFirst = () => {
        bound.first = async () => null;
      };
      return bound;
    };
    return statement;
  };
  await reject(() => read(f), 409);
});
test("configuration is pinned across capability queries before the primary projection", async (t) => {
  const f = fixture(t);
  Object.defineProperty(f.env, "FILENAME_AI_KEY", {
    value: "synthetic_".repeat(4),
  });
  f.env.DB.afterFirst = () => {
    f.trialStore.get = async () => null;
  };
  const d = {
    query: (fn) => fn(),
    prepare: (env, sql, ...args) => env.DB.prepare(sql).bind(...args),
    response: (status, value) => ({ status, value }),
  };
  await reject(
    () =>
      managementRoute(
        new Request(context.origin + "/api/manage"),
        f.env,
        context,
        session,
        d,
      ),
    409,
  );
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(({ sql }) => sql !== STORAGE_BOOK_PAGE_SQL));
});
