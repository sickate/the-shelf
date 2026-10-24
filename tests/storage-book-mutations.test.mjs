import test from "node:test";
import assert from "node:assert/strict";
import { fixture, context, session } from "./helpers/storage-read-fixture.mjs";
import { deriveCategoryId } from "../cloudflare/library/core.mjs";
import {
  storageMetadata,
  storageLifecycle,
  STORAGE_METADATA_INITIAL_SQL,
  STORAGE_METADATA_UPDATE_SQL,
  STORAGE_METADATA_FINAL_SQL,
  STORAGE_LIFECYCLE_UPDATE_SQL,
  STORAGE_LIFECYCLE_FINAL_SQL,
  STORAGE_BOOK_MUTATION_LIMITS,
} from "../cloudflare/library/storage-book-mutations.mjs";
const response = (status, value) => ({ status, value });
const req = (body) =>
  new Request(context.origin + "/api/books/book_shared/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const reject = (fn, status) => assert.rejects(fn, (e) => e.status === status);
function setup(t, options = {}) {
  const f = fixture(t, options),
    calls = [],
    prepare = f.env.DB.prepare;
  f.env.DB.prepare = function (sql) {
    const stmt = prepare.call(this, sql),
      bind = stmt.bind;
    stmt.bind = (...params) => {
      calls.push({ sql, params });
      return bind(...params);
    };
    return stmt;
  };
  const meta = (body = { expectedVersion: 0, changes: { title: "Edited" } }) =>
    storageMetadata(req(body), f.env, context, session, "book_shared", {
      response,
    });
  const life = (trashed, expectedVersion = 1) =>
    storageLifecycle(
      req({ expectedVersion }),
      f.env,
      context,
      session,
      "book_shared",
      trashed,
      { response },
    );
  const admissions = () =>
    f.db
      .prepare("SELECT count(*) AS n FROM admissions WHERE kind='metadata'")
      .get().n;
  const version = () =>
    f.db.prepare("SELECT version FROM metadata_overrides").get()?.version ?? 0;
  return { f, calls, meta, life, admissions, version };
}
for (const source of ["normal", "trial"])
  test(`${source} metadata uses initial+batch3 and preserves safe source availability`, async (t) => {
    const h = setup(t, { source }),
      r = await h.meta();
    assert.equal(r.status, 200);
    assert.equal(r.value.metadataVersion, 1);
    assert.equal(r.value.book.title, "Edited");
    assert.equal(r.value.book.files[0].reason, "uploaded");
    assert.equal(h.calls.length, 4);
    assert.deepEqual(
      h.calls.map((c) => c.params.length),
      [7, 8, 10, 6],
    );
    assert.equal(h.admissions(), 1);
    assert.equal(h.version(), 1);
    assert.deepEqual(h.f.r2, []);
    assert.equal(h.f.secretReads(), 0);
    assert.equal(h.f.writeReads(), 0);
  });
for (const source of ["normal", "trial"])
  test(`${source} trash and restore preserve dual-source book response with final allowTrash`, async (t) => {
    const h = setup(t, { source }),
      trash = await h.life(1);
    assert.equal(trash.status, 200);
    assert.equal(trash.value.trashed, true);
    assert.equal(trash.value.managementVersion, 2);
    assert.equal(trash.value.book.files[0].reason, "uploaded");
    assert.equal(h.calls.length, 4);
    assert.deepEqual(
      h.calls.map((c) => c.params.length),
      [6, 8, 10, 6],
    );
    const restore = await h.life(0, 2);
    assert.equal(restore.status, 200);
    assert.equal(restore.value.trashed, false);
    assert.equal(restore.value.managementVersion, 3);
    assert.equal(restore.value.deletedAt, null);
    assert.equal(restore.value.book.files[0].reason, "uploaded");
    assert.equal(h.calls.length, 8);
    assert.equal(h.admissions(), 2);
  });
test("fixed metadata/lifecycle SQL stays under 16KiB and max ten binds", () => {
  for (const sql of [
    STORAGE_METADATA_INITIAL_SQL,
    STORAGE_METADATA_UPDATE_SQL,
    STORAGE_METADATA_FINAL_SQL,
    STORAGE_LIFECYCLE_UPDATE_SQL,
    STORAGE_LIFECYCLE_FINAL_SQL,
  ])
    assert.ok(Buffer.byteLength(sql) <= STORAGE_BOOK_MUTATION_LIMITS.sqlBytes);
  assert.deepEqual(
    [
      STORAGE_METADATA_INITIAL_SQL,
      STORAGE_METADATA_UPDATE_SQL,
      STORAGE_METADATA_FINAL_SQL,
      STORAGE_LIFECYCLE_UPDATE_SQL,
      STORAGE_LIFECYCLE_FINAL_SQL,
    ].map((s) => Buffer.byteLength(s)),
    [15698, 15725, 15440, 15871, 15437],
  );
  assert.equal(STORAGE_BOOK_MUTATION_LIMITS.statements, 4);
  assert.equal(STORAGE_BOOK_MUTATION_LIMITS.parameters, 10);
});
test("persisted validated patch values are preserved and category uses the initial lookup", async (t) => {
  const h = setup(t);
  h.f.unsafe(() =>
    h.f.db
      .prepare(
        "INSERT INTO metadata_overrides VALUES('production','book_shared',?,1,0)",
      )
      .run(JSON.stringify({ title: " Padded ", tags: [" A ", " A "] })),
  );
  const r = await h.meta({
    expectedVersion: 1,
    changes: { author: " New Author ", category: "Synthetic" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.value.book.title, " Padded ");
  assert.deepEqual(r.value.book.tags, [" A ", " A "]);
  assert.equal(r.value.book.author, "New Author");
  assert.equal(r.value.book.categoryId, "synthetic");
  assert.equal(h.calls.length, 4);
});
test("unknown category derives its ID without an additional D1 statement", async (t) => {
  const h = setup(t),
    r = await h.meta({
      expectedVersion: 0,
      changes: { category: "New Synthetic Category" },
    });
  assert.equal(
    r.value.book.categoryId,
    await deriveCategoryId("New Synthetic Category"),
  );
  assert.equal(h.calls.length, 4);
});
for (const kind of ["metadata", "management"])
  test(`${kind} initial stale version rejects before admission or mutation`, async (t) => {
    const h = setup(t);
    const r =
      kind === "metadata"
        ? await h.meta({ expectedVersion: 2, changes: { title: "Edited" } })
        : await h.life(1, 2);
    assert.equal(r.status, 409);
    assert.equal(
      r.value.error.code,
      kind === "metadata" ? "metadata_conflict" : "management_conflict",
    );
    assert.equal(
      r.value[kind === "metadata" ? "metadataVersion" : "managementVersion"],
      kind === "metadata" ? 0 : 1,
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.admissions(), 0);
  });
for (const action of ["meta", "life"])
  for (const source of ["both", "normal"])
    test(`${action} invalid initial ${source === "both" ? "dual-source conflict" : "source facts"} rejects before writing`, async (t) => {
      const h = setup(t, { source });
      if (source === "normal")
        h.f.unsafe(() =>
          h.f.db.exec("DELETE FROM shelf_storage_original_registry"),
        );
      await reject(() => (action === "meta" ? h.meta() : h.life(1)), 409);
      assert.equal(h.calls.length, 1);
      assert.equal(h.admissions(), 0);
      assert.equal(h.version(), 0);
    });
for (const action of ["meta", "life"])
  for (const change of [
    "normal",
    "trial",
    "catalog",
    "schema",
    "session",
    "authority",
    "management",
    "metadata",
  ])
    test(`${action} guarded CAS rejects ${change} race without a business mutation`, async (t) => {
      const h = setup(t, { source: change === "trial" ? "trial" : "normal" });
      h.f.env.DB.afterFirst = () => {
        h.f.unsafe(() => {
          if (change === "normal")
            h.f.db.exec("UPDATE file_registry SET etag='changed'");
          if (change === "trial")
            h.f.db.exec("UPDATE shelf_storage_single_trial SET etag='changed'");
          if (change === "catalog") {
            const b = { ...h.f.book, title: "concurrent" };
            h.f.db
              .prepare("UPDATE catalog_books SET public_json=?")
              .run(JSON.stringify(b));
          }
          if (change === "session")
            h.f.db.exec("UPDATE sessions SET revoked=1");
          if (change === "authority")
            h.f.db.exec(
              "UPDATE shelf_storage_authority SET phase='migration_required'",
            );
          if (change === "management")
            h.f.db.exec("UPDATE book_management SET version=2");
          if (change === "metadata")
            h.f.db
              .prepare(
                "INSERT INTO metadata_overrides VALUES('production','book_shared',?,1,0)",
              )
              .run("{}");
        });
        if (change === "schema")
          h.f.db.exec("CREATE TABLE unexpected_marker(id INTEGER)");
      };
      let result;
      try {
        result = await (action === "meta" ? h.meta() : h.life(1));
        assert.equal(result.status, 409);
      } catch (e) {
        assert.ok([401, 409, 503].includes(e.status));
      }
      assert.equal(h.version(), change === "metadata" ? 1 : 0);
      assert.equal(
        h.f.db.prepare("SELECT trashed FROM book_management").get().trashed,
        0,
      );
      assert.equal(h.calls.length, 4);
      assert.equal(h.admissions(), change === "session" ? 0 : 1);
    });
for (const action of ["meta", "life"])
  test(`${action} version at MAX_SAFE_INTEGER rejects before write`, async (t) => {
    const h = setup(t);
    h.f.unsafe(() =>
      action === "meta"
        ? h.f.db
            .prepare(
              "INSERT INTO metadata_overrides VALUES('production','book_shared','{}',?,0)",
            )
            .run(Number.MAX_SAFE_INTEGER)
        : h.f.db
            .prepare("UPDATE book_management SET version=?")
            .run(Number.MAX_SAFE_INTEGER),
    );
    await reject(
      () =>
        action === "meta"
          ? h.meta({
              expectedVersion: Number.MAX_SAFE_INTEGER,
              changes: { title: "Edited" },
            })
          : h.life(1, Number.MAX_SAFE_INTEGER),
      400,
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.admissions(), 0);
  });
for (const name of ["DB", "withSession", "prepare", "batch", "binding"])
  test(`metadata await ${name} drift rejects before batch`, async (t) => {
    const h = setup(t);
    h.f.env.DB.afterFirst = () => {
      if (name === "DB") h.f.env.DB = { ...h.f.env.DB };
      if (name === "withSession")
        h.f.env.DB.withSession = function () {
          return this;
        };
      if (name === "prepare") h.f.env.DB.prepare = () => null;
      if (name === "batch") h.f.env.DB.batch = async () => [];
      if (name === "binding") h.f.env.TRIAL_BOOKS = { ...h.f.trialStore };
    };
    await reject(() => h.meta(), 409);
    assert.equal(h.calls.length, 1);
    assert.equal(h.admissions(), 0);
  });
test("expired initial session cannot write after awaited crypto/category work", async (t) => {
  const h = setup(t);
  h.f.unsafe(() =>
    h.f.db.prepare("UPDATE sessions SET expires_at=?").run(Date.now() + 30),
  );
  h.f.env.DB.afterFirst = () => new Promise((r) => setTimeout(r, 50));
  await reject(() => h.meta(), 401);
  assert.equal(h.admissions(), 0);
});
test("lost batch response is unknown and is never automatically replayed", async (t) => {
  const h = setup(t),
    batch = h.f.env.DB.batch;
  let attempts = 0;
  h.f.env.DB.batch = async function (statements) {
    attempts++;
    await batch.call(this, statements);
    throw Error("lost synthetic response");
  };
  await reject(() => h.meta(), 503);
  assert.equal(attempts, 1);
  assert.equal(h.calls.length, 4);
  assert.equal(h.admissions(), 1);
  assert.equal(h.version(), 1);
  const retry = await h.meta();
  assert.equal(retry.status, 409);
  assert.equal(retry.value.metadataVersion, 1);
  assert.equal(attempts, 1);
});
for (const extra of ["wrapper", "business-results"])
  test(`batch ${extra} aggregate transport over 1MiB is withheld`, async (t) => {
    const h = setup(t),
      batch = h.f.env.DB.batch;
    h.f.env.DB.batch = async function (statements) {
      const result = await batch.call(this, statements);
      if (extra === "wrapper") result[0].extra = "x".repeat(1048576);
      else result[1].results.push({ extra: "x".repeat(1048576) });
      return result;
    };
    await reject(() => h.meta(), 503);
    assert.equal(h.admissions(), 1);
    assert.equal(h.version(), 1);
    assert.equal(h.calls.length, 4);
  });
test("metadata rate-limit abort rolls back the whole batch and keeps the known version", async (t) => {
  const h = setup(t);
  h.f.db
    .prepare(
      "INSERT INTO counters VALUES('production','metadata_day','global',?,100,100)",
    )
    .run(Math.floor(Date.now() / 86400000));
  await reject(() => h.meta(), 429);
  assert.equal(h.admissions(), 0);
  assert.equal(h.version(), 0);
});
for (const input of [
  { expectedVersion: 0, changes: {} },
  { expectedVersion: -1, changes: { title: "bad" } },
  { expectedVersion: 0, changes: { unknown: "bad" } },
  { expectedVersion: 0, changes: { title: "bad" }, unknown: 1 },
])
  test("invalid metadata preserves the existing validation boundary", async (t) => {
    const h = setup(t);
    await reject(() => h.meta(input), 400);
    assert.equal(h.calls.length, 0);
    assert.equal(h.admissions(), 0);
  });
for (const index of [0, 1, 2])
  test(`unexpected business rows in batch entry ${index} fail closed`, async (t) => {
    const h = setup(t),
      batch = h.f.env.DB.batch;
    h.f.env.DB.batch = async function (statements) {
      const r = await batch.call(this, statements);
      r[index].results.push({ unexpected: true });
      return r;
    };
    await reject(() => h.meta(), 503);
    assert.equal(h.version(), 1);
    assert.equal(h.admissions(), 1);
  });
