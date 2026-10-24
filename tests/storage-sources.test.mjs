import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, NoOpLog, convertV4MiniflareOptions } from "miniflare";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";
import {
  storageReadConfiguration,
  confirmedSourceProjection,
  resolveConfirmedSource,
  assertUnchangedSourceGrant,
  confirmedSourceGuard,
  readSourceAdapter,
  STORAGE_SOURCE_SQL,
  STORAGE_SOURCE_GUARD_SQL,
  STORAGE_SOURCE_LIMITS,
} from "../cloudflare/library/storage-sources.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)),
  json = JSON.stringify;
const ACCOUNT = "a".repeat(32),
  TARGET = "b".repeat(64),
  NOW = 1792800000000;
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
const context = { scope: "production", origin: ORIGIN, now: NOW },
  session = { session_hash: "c".repeat(64), generation: 1 };
const descriptorFor = (format = "PDF") => ({
  kind: "original",
  scope: "production",
  fileId: "file_shared",
  bookId: "book_shared",
  format,
  sizeBytes: 15,
  sha256: "d".repeat(64),
  objectKey: `books/cf03/file_shared/${"d".repeat(64)}.${format.toLowerCase()}`,
  versionHash: null,
  source: null,
});
const rejected = (operation, status) =>
  assert.rejects(
    operation,
    (e) =>
      e instanceof Error &&
      e.status === (status || e.status) &&
      [401, 409, 503].includes(e.status),
  );

function fixture(
  t,
  {
    profile = "trial-010",
    source = "normal",
    format = "PDF",
    management = true,
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const schema = DATABASE_SCHEMA_PROFILES[profile],
    triggers = schema.filter((r) => r.type === "trigger");
  for (const type of ["table", "index", "view"])
    for (const row of schema) if (row.type === type) db.exec(row.sql);
  const d = descriptorFor(format),
    file = {
      id: d.fileId,
      format,
      sizeBytes: d.sizeBytes,
      status: "candidate",
      reason: "uploaded",
      visibility: "private",
      readable: ["PDF", "EPUB"].includes(format),
    };
  const book = {
    id: d.bookId,
    title: "Synthetic",
    author: null,
    category: "Synthetic",
    categoryId: "synthetic",
    tags: [],
    description: "",
    files: [file],
  };
  db.prepare(
    "INSERT INTO public_state(scope,updated_at) VALUES('production',0),('check',0)",
  ).run();
  db.prepare("INSERT INTO catalog_books VALUES('production',?,?)").run(
    d.bookId,
    json(book),
  );
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase)VALUES(1,?,'imported')",
  ).run(json(identity));
  db.prepare(
    "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,1,?)",
  ).run(ORIGIN, "e".repeat(64), NOW - 1000);
  db.prepare("INSERT INTO sessions VALUES('production',?,1,?,?,0)").run(
    session.session_hash,
    NOW - 1000,
    NOW + 60000,
  );
  if (management)
    db.prepare(
      "INSERT INTO book_management VALUES('production',?,'private',0,1,?)",
    ).run(d.bookId, NOW - 1000);
  const normal = () => {
    db.prepare(
      "INSERT INTO shelf_storage_reservations VALUES(?,?,?,?,?,'confirmed',1,1,?,?,?)",
    ).run(
      "normal_reservation",
      `original:production:${d.fileId}:original`,
      d.objectKey,
      json(d),
      d.sizeBytes,
      "synthetic_etag",
      NOW - 1000,
      NOW - 500,
    );
    db.prepare(
      "INSERT INTO shelf_storage_original_registry VALUES(?,?,?,?,1)",
    ).run(
      `original:production:${d.fileId}:original`,
      "normal_reservation",
      json(d),
      "synthetic_etag",
    );
    db.prepare(
      "INSERT INTO file_registry VALUES('production',?,?,?,?,?,?,?,'confirmed',1,?)",
    ).run(
      d.fileId,
      d.bookId,
      d.format,
      d.sizeBytes,
      d.objectKey,
      d.sha256,
      "synthetic_etag",
      NOW - 500,
    );
  };
  const trial = () =>
    db
      .prepare(
        "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,?,?)",
      )
      .run(
        "synthetic_permit",
        "2026-10-23-first-book",
        json(identity),
        json({ accountId: ACCOUNT, bucket: "the-shelf-first-book-20261023" }),
        json(d),
        TARGET,
        d.sizeBytes,
        NOW - 172800000,
        NOW - 172800000 + 3600000,
        "synthetic_etag",
        NOW - 172800000 + 1000,
      );
  if (source === "normal" || source === "both") normal();
  if (source === "trial" || source === "both") trial();
  for (const row of triggers) db.exec(row.sql);
  const calls = [],
    r2 = [],
    normalStore = {
      async head(...args) {
        r2.push(["normal", "head", ...args]);
        return { size: 15, etag: "synthetic_etag" };
      },
      async get(...args) {
        r2.push(["normal", "get", ...args]);
        return { body: new Response("normal original").body };
      },
    },
    trialStore = {
      async head(...args) {
        r2.push(["trial", "head", ...args]);
        return { size: 15, etag: "synthetic_etag" };
      },
      async get(...args) {
        r2.push(["trial", "get", ...args]);
        return { body: new Response("trial isolated!").body };
      },
    };
  let secretReads = 0,
    writeReads = 0;
  for (const store of [normalStore, trialStore])
    for (const name of ["put", "delete", "list"])
      Object.defineProperty(store, name, {
        get() {
          writeReads++;
          throw Error("must-not-read");
        },
      });
  const DB = {
    withSession(mode) {
      assert.equal(mode, "first-primary");
      return {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                async first() {
                  calls.push({ sql, params });
                  return db.prepare(sql).get(...params) || null;
                },
              };
            },
          };
        },
      };
    },
  };
  const env = {
    APP_SCOPE: "production",
    SITE_ORIGIN: ORIGIN,
    STORAGE_MODE: "authority-v2",
    STORAGE_WRITE_MODE: "closed",
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: "the-shelf-books",
    TRIAL_R2_ACCOUNT_ID: ACCOUNT,
    TRIAL_R2_BUCKET: "the-shelf-first-book-20261023",
    TRIAL_TARGET_SHA256: TARGET,
    FILENAME_AI_MODE: "filename-v1",
    DB,
    BOOKS: normalStore,
    TRIAL_BOOKS: trialStore,
  };
  for (const name of [
    "SINGLE_TRIAL_UPLOAD_SECRET",
    "OWNER_KEY_PEPPER",
    "SESSION_SECRET",
    "FILENAME_AI_KEY",
  ])
    Object.defineProperty(env, name, {
      enumerable: true,
      get() {
        secretReads++;
        throw Error("must-not-read");
      },
    });
  const unsafe = (operation) => {
    for (const row of triggers) db.exec(`DROP TRIGGER ${row.name}`);
    try {
      return operation();
    } finally {
      for (const row of triggers) db.exec(row.sql);
    }
  };
  const resolve = (extra = {}) =>
    resolveConfirmedSource(env, {
      context,
      session,
      fileId: d.fileId,
      ...extra,
    });
  const verify = (grant) =>
    assertUnchangedSourceGrant(env, grant, { context, session, nowMs: NOW });
  return {
    db,
    schema,
    d,
    book,
    file,
    calls,
    r2,
    env,
    normalStore,
    trialStore,
    unsafe,
    resolve,
    verify,
    secretReads: () => secretReads,
    writeReads: () => writeReads,
  };
}

// Pause only the chosen primary result after the real fixture SQL has run.
// Installation precedes grant creation so its withSession identity is pinned.
function holdPrimaryRead(t, f, readNumber) {
  let enter,
    release,
    count = 0;
  const started = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const original = f.env.DB.withSession;
  f.env.DB.withSession = function (mode) {
    const primary = original.call(this, mode);
    return {
      prepare(sql) {
        const statement = primary.prepare(sql);
        return {
          bind(...parameters) {
            const bound = statement.bind(...parameters);
            return {
              async first() {
                const result = await bound.first();
                if (++count === readNumber) {
                  enter();
                  await gate;
                }
                return result;
              },
            };
          },
        };
      },
    };
  };
  return { started, release };
}
for (const profile of [
  "trial-009",
  "trial-010",
  "activation-011",
  "trial-009-cf-metadata-v1",
  "trial-010-cf-metadata-v1",
  "activation-011-cf-metadata-v1",
])
  for (const source of ["normal", "trial"])
    test(`one primary SELECT resolves ${source} under ${profile} without readiness or live permit`, async (t) => {
      const f = fixture(t, { profile, source }),
        g = await f.resolve();
      assert.equal(g.source, source);
      assert.equal(
        g.target.bucket,
        source === "normal"
          ? "the-shelf-books"
          : "the-shelf-first-book-20261023",
      );
      assert.equal(g.schemaProfile, profile);
      assert.equal(g.catalogFacts.managementVersion, 1);
      assert.ok(Object.isFrozen(g.authorityIdentity.legacyDatabases));
      assert.equal(f.calls.length, 1);
      assert.equal(f.r2.length, 0);
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM browser_uploads").get().n,
        0,
      );
      await f.verify(g);
      assert.equal(f.calls.length, 2);
      assert.equal(f.secretReads(), 0);
      assert.equal(f.writeReads(), 0);
    });
for (const format of ["PDF", "EPUB", "MOBI", "AZW", "AZW3"])
  test(`normal ${format} keeps catalog format capability and owner access`, async (t) => {
    const f = fixture(t, { format }),
      g = await f.resolve();
    assert.equal(g.descriptor.format, format);
    assert.equal(
      g.catalogFacts.file.readable,
      ["PDF", "EPUB"].includes(format),
    );
    const object = await readSourceAdapter(f.env, g).get();
    assert.equal(await new Response(object.body).text(), "normal original");
    await f.verify(g);
    assert.equal(f.r2.length, 1);
    assert.equal(f.secretReads(), 0);
    assert.equal(f.writeReads(), 0);
  });
test("global raw conflict is rejected before decoder validity, catalog or expected book", async (t) => {
  const f = fixture(t, { source: "both" });
  f.unsafe(() => {
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db
      .prepare(
        "UPDATE shelf_storage_single_trial SET put_attempted=0,content_verified=0,etag=NULL",
      )
      .run();
    f.db.prepare("UPDATE catalog_books SET public_json='{}'").run();
  });
  await rejected(() => f.resolve({ expectedBookId: "wrong_book" }), 409);
  assert.equal(f.calls.length, 1);
  assert.equal(f.r2.length, 0);
  assert.equal(f.secretReads(), 0);
});
test("normal lookup never accepts another book referencing the same file", async (t) => {
  const f = fixture(t);
  f.unsafe(() =>
    f.db
      .prepare("INSERT INTO catalog_books VALUES('production','other_book',?)")
      .run(json({ ...f.book, id: "other_book" })),
  );
  await rejected(() => f.resolve({ expectedBookId: "other_book" }), 409);
  assert.equal(f.r2.length, 0);
});
for (const [label, sql, params] of [
  [
    "registry disabled",
    "UPDATE shelf_storage_original_registry SET enabled=0",
    [],
  ],
  ["missing registry", "DELETE FROM shelf_storage_original_registry", []],
  ["missing reservation", "DELETE FROM shelf_storage_reservations", []],
  [
    "reservation logical key",
    "UPDATE shelf_storage_reservations SET logical_key='wrong'",
    [],
  ],
  [
    "reservation identity",
    "UPDATE shelf_storage_original_registry SET reservation_id='missing'",
    [],
  ],
  [
    "reservation bytes",
    "UPDATE shelf_storage_reservations SET size_bytes=16",
    [],
  ],
  [
    "reservation key",
    "UPDATE shelf_storage_reservations SET object_key='books/wrong'",
    [],
  ],
  [
    "reservation flag",
    "UPDATE shelf_storage_reservations SET put_attempted=0",
    [],
  ],
  [
    "reservation content",
    "UPDATE shelf_storage_reservations SET content_verified=0",
    [],
  ],
  [
    "reservation etag",
    "UPDATE shelf_storage_reservations SET etag='other'",
    [],
  ],
  ["file etag", "UPDATE file_registry SET etag='other'", []],
  ["file version", "UPDATE file_registry SET version=0", []],
  ["file size", "UPDATE file_registry SET size_bytes=16", []],
  ["file format", "UPDATE file_registry SET format='MOBI'", []],
  ["file book", "UPDATE file_registry SET book_id='missing_book'", []],
])
  test(`strict normal attribution rejects ${label}`, async (t) => {
    const f = fixture(t);
    f.unsafe(() => {
      f.db.exec("PRAGMA ignore_check_constraints=ON;PRAGMA foreign_keys=OFF");
      f.db.prepare(sql).run(...params);
    });
    await rejected(() => f.resolve());
    assert.equal(f.r2.length, 0);
  });
for (const [label, mutate] of [
  ["wrong descriptor scope", (d) => (d.scope = "check")],
  ["wrong descriptor file", (d) => (d.fileId = "different")],
  ["wrong descriptor book", (d) => (d.bookId = "different")],
  ["wrong descriptor hash", (d) => (d.sha256 = "1".repeat(64))],
  ["wrong descriptor kind", (d) => (d.kind = "prepared-text")],
  ["extra descriptor", (d) => (d.extra = true)],
])
  test(`normal descriptor rejects ${label}`, async (t) => {
    const f = fixture(t),
      d = structuredClone(f.d);
    mutate(d);
    f.unsafe(() => {
      f.db
        .prepare("UPDATE shelf_storage_original_registry SET descriptor_json=?")
        .run(json(d));
      f.db
        .prepare("UPDATE shelf_storage_reservations SET descriptor_json=?")
        .run(json(d));
    });
    await rejected(() => f.resolve());
    assert.equal(f.r2.length, 0);
  });
for (const [label, mutate] of [
  ["root book", (b) => (b.id = "different")],
  ["duplicate file", (b) => b.files.push({ ...b.files[0] })],
  ["missing file", (b) => (b.files = [])],
  ["file format", (b) => (b.files[0].format = "MOBI")],
  ["file size", (b) => b.files[0].sizeBytes++],
  ["file status", (b) => (b.files[0].status = "unavailable")],
  ["public original", (b) => (b.files[0].visibility = "public")],
  ["nonboolean readable", (b) => (b.files[0].readable = 1)],
])
  test(`catalog attribution rejects ${label}`, async (t) => {
    const f = fixture(t),
      b = structuredClone(f.book);
    mutate(b);
    f.db.prepare("UPDATE catalog_books SET public_json=?").run(json(b));
    await rejected(() => f.resolve());
    assert.equal(f.r2.length, 0);
  });
test("a missing management row keeps the explicit default, while trash rejects", async (t) => {
  const f = fixture(t, { management: false }),
    g = await f.resolve();
  assert.equal(g.catalogFacts.managementVersion, 0);
  assert.equal(g.catalogFacts.visibility, "public");
  await f.verify(g);
  const h = fixture(t);
  h.db.prepare("UPDATE book_management SET trashed=1").run();
  await rejected(() => h.resolve(), 409);
});

for (const format of ["PDF", "EPUB"])
  for (const source of ["normal", "trial"])
    test(`${source} ${format} cannot bypass an explicit readable=false`, async (t) => {
      const f = fixture(t, { format, source });
      f.book.files[0].readable = false;
      f.db.prepare("UPDATE catalog_books SET public_json=?").run(json(f.book));
      await rejected(() => f.resolve(), 409);
      assert.equal(f.r2.length, 0);
    });

test("trial must pin the complete current authority and consumed facts before R2", async (t) => {
  for (const change of [
    (f) =>
      f.db
        .prepare(
          "UPDATE shelf_storage_single_trial SET authority_identity_json=?",
        )
        .run(
          json({
            ...identity,
            legacyDatabases: {
              ...identity.legacyDatabases,
              production: "33333333-3333-4333-8333-333333333333",
            },
          }),
        ),
    (f) =>
      f.db
        .prepare(
          "UPDATE shelf_storage_single_trial SET put_attempted=0,content_verified=0,etag=NULL",
        )
        .run(),
    (f) =>
      f.db
        .prepare(
          "UPDATE shelf_storage_single_trial SET isolated_target_config_sha256=?",
        )
        .run("f".repeat(64)),
  ]) {
    const f = fixture(t, { source: "trial" });
    f.unsafe(() => {
      f.db.exec("PRAGMA ignore_check_constraints=ON");
      change(f);
    });
    await rejected(() => f.resolve(), 409);
    assert.equal(f.r2.length, 0);
    assert.equal(f.secretReads(), 0);
  }
});

test("grant rejection cancels the returned body without waiting for cancel to settle", async (t) => {
  const f = fixture(t);
  let cancels = 0;
  f.normalStore.get = async () => ({
    body: {
      cancel() {
        cancels++;
        return new Promise(() => {});
      },
    },
  });
  const g = await f.resolve();
  await readSourceAdapter(f.env, g).get();
  f.db.prepare("UPDATE book_management SET trashed=1").run();
  await rejected(() => f.verify(g), 409);
  assert.equal(cancels, 1);
});

test("a change while the selected R2 operation awaits cannot reuse the original grant", async (t) => {
  const f = fixture(t);
  let release,
    cancels = 0;
  f.trialStore.get = () => {
    throw Error("cross-bucket fallback");
  };
  f.normalStore.get = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const g = await f.resolve(),
    pending = readSourceAdapter(f.env, g).get();
  await Promise.resolve();
  f.db.prepare("UPDATE file_registry SET version=version+1").run();
  release({
    body: {
      cancel() {
        cancels++;
        return Promise.resolve();
      },
    },
  });
  await pending;
  await rejected(() => f.verify(g), 409);
  assert.equal(cancels, 1);
  assert.equal(f.calls.length, 2);
});

test("one R2 deadline retains the attempted operation and cancels a late body without awaiting it", async (t) => {
  const f = fixture(t);
  let release,
    cancels = 0;
  f.normalStore.get = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const g = await f.resolve();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = readSourceAdapter(f.env, g),
    operation = adapter.get(),
    failure = rejected(() => operation, 503);
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await failure;
  assert.throws(() => adapter.get(), { status: 409 });
  release({
    body: {
      cancel() {
        cancels++;
        return new Promise(() => {});
      },
    },
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(cancels, 1);
  assert.equal(f.calls.length, 1);
  t.mock.timers.reset();
});

test("a primary D1 deadline makes one read attempt without retry or R2", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.env.DB = {
    withSession(mode) {
      assert.equal(mode, "first-primary");
      return {
        prepare() {
          return {
            bind() {
              return {
                first() {
                  reads++;
                  return new Promise(() => {});
                },
              };
            },
          };
        },
      };
    },
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = f.resolve(),
    failure = rejected(() => operation, 503);
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await failure;
  assert.equal(reads, 1);
  assert.equal(f.r2.length, 0);
  t.mock.timers.reset();
});

test("the final snapshot cap returns a short overflow marker for a huge unknown definition", async (t) => {
  const f = fixture(t);
  f.db.exec(
    `CREATE TABLE huge_unknown(v TEXT DEFAULT '${"x".repeat(600000)}')`,
  );
  const row = f.db
    .prepare(STORAGE_SOURCE_SQL)
    .get("production", f.d.fileId, session.session_hash, 1, NOW, ORIGIN);
  assert.deepEqual({ ...row }, { snapshot_json: null, overflow: 1 });
  await rejected(() => f.resolve(), 503);
  assert.equal(f.r2.length, 0);
});
for (const [label, sql] of [
  ["source disable", "UPDATE file_registry SET state='disabled'"],
  ["source version", "UPDATE file_registry SET version=version+1"],
  ["management version", "UPDATE book_management SET version=version+1"],
  ["management visibility", "UPDATE book_management SET visibility='public'"],
  ["management trash", "UPDATE book_management SET trashed=1"],
  [
    "catalog",
    "UPDATE catalog_books SET public_json=json_set(public_json,'$.title','Changed')",
  ],
  ["session revoke", "UPDATE sessions SET revoked=1"],
  ["auth close", "UPDATE auth_config SET enabled=0"],
  ["auth generation", "UPDATE auth_config SET generation=generation+1"],
  [
    "authority identity",
    "UPDATE shelf_storage_authority SET identity_json=json_set(identity_json,'$.legacyDatabases.production','33333333-3333-4333-8333-333333333333')",
  ],
  ["unknown012 schema", "CREATE TABLE shelf_job_control(scope TEXT)"],
  ["partial schema", "DROP TRIGGER shelf_single_trial_keep_imported"],
])
  test(`post-R2 primary recheck rejects ${label}`, async (t) => {
    const f = fixture(t),
      g = await f.resolve();
    await readSourceAdapter(f.env, g).head();
    if (label === "authority identity") f.unsafe(() => f.db.exec(sql));
    else f.db.exec(sql);
    await rejected(() => f.verify(g));
    assert.equal(f.calls.length, 2);
    assert.equal(f.r2.length, 1);
    const guard = confirmedSourceGuard(g, { context, session, nowMs: NOW });
    assert.equal(f.db.prepare(guard.sql).get(...guard.parameters), undefined);
  });
test("cross-source appearance during external await rejects both final grant and atomic guard", async (t) => {
  const f = fixture(t),
    g = await f.resolve();
  await readSourceAdapter(f.env, g).head();
  f.unsafe(() =>
    f.db
      .prepare(
        "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,?,?)",
      )
      .run(
        "synthetic_permit",
        "2026-10-23-first-book",
        json(identity),
        json({ accountId: ACCOUNT, bucket: "the-shelf-first-book-20261023" }),
        json(f.d),
        TARGET,
        f.d.sizeBytes,
        NOW - 172800000,
        NOW - 172800000 + 3600000,
        "synthetic_etag",
        NOW - 172800000 + 1000,
      ),
  );
  await rejected(() => f.verify(g), 409);
  const guard = confirmedSourceGuard(g, { context, session, nowMs: NOW });
  assert.equal(f.db.prepare(guard.sql).get(...guard.parameters), undefined);
});
test("platform schema stays in the raw grant and a synthetic shape change rejects final verification and guard", async (t) => {
  const f = fixture(t, { profile: "trial-010-cf-metadata-v1" });
  let cancels = 0;
  f.normalStore.get = async () => ({
    body: {
      cancel() {
        cancels++;
        return Promise.resolve();
      },
    },
  });
  const grant = await f.resolve();
  const before = confirmedSourceGuard(grant, { context, session, nowMs: NOW });
  const raw = JSON.parse(before.parameters[6]);
  assert.deepEqual(
    raw.schema.find((row) => row.name === "_cf_METADATA"),
    f.schema.find((row) => row.name === "_cf_METADATA"),
  );
  // This fixture is in-memory Node SQLite, not the actual platform store.
  await readSourceAdapter(f.env, grant).get();
  f.db.exec("ALTER TABLE _cf_METADATA ADD COLUMN extra TEXT");
  await rejected(() => f.verify(grant), 503);
  assert.equal(cancels, 1);
  assert.equal(f.db.prepare(before.sql).get(...before.parameters), undefined);
});
test("session expiry and incoming session substitution cannot reuse a grant", async (t) => {
  const f = fixture(t),
    g = await f.resolve();
  await rejected(
    () =>
      assertUnchangedSourceGrant(f.env, g, {
        context,
        session,
        nowMs: NOW + 60000,
      }),
    401,
  );
  await rejected(
    () =>
      assertUnchangedSourceGrant(f.env, g, {
        context,
        session: { ...session, session_hash: "f".repeat(64) },
        nowMs: NOW,
      }),
    409,
  );
  const guard = confirmedSourceGuard(g, {
    context,
    session,
    nowMs: NOW + 60000,
  });
  assert.equal(f.db.prepare(guard.sql).get(...guard.parameters), undefined);
  assert.throws(
    () =>
      confirmedSourceGuard(structuredClone(g), {
        context,
        session,
        nowMs: NOW,
      }),
    { status: 409 },
  );
});
test("atomic guard composes into one conditional admission without reauthorizing a changed snapshot", async (t) => {
  const f = fixture(t),
    g = await f.resolve(),
    guard = confirmedSourceGuard(g, { context, session, nowMs: NOW });
  const sql = `INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id) SELECT 'production',?,'access',?,${NOW},'${session.session_hash}',1,'${f.d.fileId}' WHERE EXISTS(${guard.sql}) RETURNING request_id`;
  const params = ["synthetic_request", "a".repeat(64), ...guard.parameters];
  assert.equal(params.length, 9);
  assert.equal(
    f.db.prepare(sql).get(...params).request_id,
    "synthetic_request",
  );
  f.db.prepare("UPDATE book_management SET version=version+1").run();
  assert.equal(
    f.db
      .prepare(sql)
      .get("synthetic_second", "a".repeat(64), ...guard.parameters),
    undefined,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'")
      .get().n,
    1,
  );
});
test("runtime configuration rejects mixed modes and partial prepared shape without secrets or mutations", async (t) => {
  const f = fixture(t);
  storageReadConfiguration(f.env);
  for (const change of [
    { APP_SCOPE: "check" },
    { SITE_ORIGIN: "https://other.invalid" },
    { STORAGE_MODE: "authority-v1" },
    { STORAGE_WRITE_MODE: "open" },
    { R2_BUCKET: "the-shelf-first-book-20261023" },
    { TRIAL_R2_ACCOUNT_ID: "f".repeat(32) },
    { TRIAL_R2_BUCKET: "the-shelf-books" },
    { TRIAL_TARGET_SHA256: "B".repeat(64) },
    { FILENAME_AI_MODE: undefined },
    { SINGLE_TRIAL_MODE: undefined },
    { NORMAL_UPLOAD_MODE: "authority-v1" },
    { R2_ACCESS_KEY_ID: undefined },
    { TRIAL_BOOKS: f.normalStore },
    {
      DB: {
        prepare() {
          throw Error("no primary session");
        },
      },
    },
    { PREPARED_TEXT_MODE: "registry-v1" },
  ]) {
    const env = Object.create(null, Object.getOwnPropertyDescriptors(f.env));
    Object.assign(env, change);
    assert.throws(() => storageReadConfiguration(env), {
      code: "files_unconfigured",
      status: 503,
    });
  }
  for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    const env = Object.create(null, Object.getOwnPropertyDescriptors(f.env));
    Object.defineProperty(env, name, {
      get() {
        throw Error("must-not-read");
      },
    });
    assert.throws(() => storageReadConfiguration(env), {
      code: "files_unconfigured",
    });
  }
  assert.equal(f.secretReads(), 0);
  assert.equal(f.writeReads(), 0);
  assert.equal(f.calls.length, 0);
});
test("prepared group is complete and requires exact010, with no extra D1 statement", async (t) => {
  for (const profile of ["trial-009", "trial-010", "activation-011"]) {
    const f = fixture(t, { profile });
    Object.assign(f.env, {
      PREPARED_TEXT_MODE: "registry-v1",
      PREPARED_R2_ACCOUNT_ID: ACCOUNT,
      PREPARED_R2_BUCKET: "the-shelf-books",
      PREPARED_BOOKS: f.normalStore,
    });
    if (profile === "trial-009") await rejected(() => f.resolve(), 503);
    else assert.equal((await f.resolve()).source, "normal");
    assert.equal(f.calls.length, 1);
  }
});
test("config drift, replacement bindings and forged grants cannot reuse a read adapter", async (t) => {
  const f = fixture(t),
    g = await f.resolve();
  assert.throws(() => readSourceAdapter(f.env, structuredClone(g)), {
    status: 409,
  });
  f.env.TRIAL_TARGET_SHA256 = "f".repeat(64);
  assert.throws(() => readSourceAdapter(f.env, g), { status: 409 });
  f.env.TRIAL_TARGET_SHA256 = TARGET;
  f.env.BOOKS = { head() {}, get() {} };
  await rejected(() => f.verify(g), 409);
  assert.equal(f.r2.length, 0);
});

for (const [label, mutate] of [
  [
    "env fingerprint",
    (f) => {
      f.env.TRIAL_TARGET_SHA256 = "f".repeat(64);
    },
  ],
  [
    "DB binding",
    (f) => {
      f.env.DB = { ...f.env.DB };
    },
  ],
  [
    "DB withSession method",
    (f) => {
      const original = f.env.DB.withSession;
      f.env.DB.withSession = function (...args) {
        return original.apply(this, args);
      };
    },
  ],
  [
    "normal binding",
    (f) => {
      f.env.BOOKS = { ...f.normalStore };
    },
  ],
  [
    "trial binding",
    (f) => {
      f.env.TRIAL_BOOKS = { ...f.trialStore };
    },
  ],
  [
    "normal head method",
    (f) => {
      f.normalStore.head = async () => null;
    },
  ],
  [
    "normal get method",
    (f) => {
      f.normalStore.get = async () => null;
    },
  ],
  [
    "trial head method",
    (f) => {
      f.trialStore.head = async () => null;
    },
  ],
  [
    "trial get method",
    (f) => {
      f.trialStore.get = async () => null;
    },
  ],
])
  for (const stage of ["resolve", "final verify"])
    test(`${stage} rejects ${label} drift during the awaited primary result`, async (t) => {
      const f = fixture(t);
      let cancels = 0;
      f.normalStore.get = async () => {
        f.r2.push(["normal", "get"]);
        return {
          body: {
            cancel() {
              cancels++;
              return new Promise(() => {});
            },
          },
        };
      };
      const held = holdPrimaryRead(t, f, stage === "resolve" ? 1 : 2);
      let operation;
      if (stage === "resolve") operation = f.resolve();
      else {
        const grant = await f.resolve();
        await readSourceAdapter(f.env, grant).get();
        operation = f.verify(grant);
      }
      await held.started;
      mutate(f);
      const failure = rejected(() => operation, 409);
      held.release();
      await failure;
      assert.equal(f.calls.length, stage === "resolve" ? 1 : 2);
      assert.equal(f.r2.length, stage === "resolve" ? 0 : 1);
      assert.equal(cancels, stage === "resolve" ? 0 : 1);
      assert.equal(f.secretReads(), 0);
      assert.equal(f.writeReads(), 0);
    });

test("the primary operation uses the captured DB method when configuration changes before its microtask", async (t) => {
  const f = fixture(t);
  let replacementCalls = 0;
  const operation = f.resolve();
  f.env.DB.withSession = () => {
    replacementCalls++;
    throw Error("must-not-dispatch-replacement");
  };
  await rejected(() => operation, 409);
  assert.equal(replacementCalls, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.r2.length, 0);
});
test("read adapter pins key/etag/range, exposes no write method and permits one operation without fallback", async (t) => {
  const f = fixture(t),
    g = await f.resolve(),
    adapter = readSourceAdapter(f.env, g);
  assert.deepEqual(Object.keys(adapter), ["head", "get"]);
  for (const bad of [
    { key: "another" },
    { onlyIf: { etagMatches: "other" } },
    { range: { offset: 14, length: 2 } },
    { range: { offset: 0, length: 0 } },
  ])
    assert.throws(() => adapter.get(bad), { status: 409 });
  await adapter.get({ range: { offset: 1, length: 2 } });
  assert.deepEqual(f.r2, [
    [
      "normal",
      "get",
      f.d.objectKey,
      {
        onlyIf: { etagMatches: "synthetic_etag" },
        range: { offset: 1, length: 2 },
      },
    ],
  ]);
  assert.throws(() => adapter.head(), { status: 409 });
  assert.throws(() => readSourceAdapter(f.env, g).get(), { status: 409 });
  assert.equal(f.writeReads(), 0);
  const h = fixture(t, { source: "trial" });
  h.trialStore.get = async () => {
    throw Error("synthetic failure");
  };
  const trial = await h.resolve();
  await rejected(() => readSourceAdapter(h.env, trial).get(), 503);
  assert.equal(h.r2.length, 0);
});
for (const [label, mutate] of [
  [
    "identity",
    (f) =>
      f.db
        .prepare("UPDATE shelf_storage_authority SET identity_json=?")
        .run(json({ ...identity, padding: "x".repeat(2048) })),
  ],
  [
    "descriptor",
    (f) =>
      f.db
        .prepare("UPDATE shelf_storage_original_registry SET descriptor_json=?")
        .run(json({ ...f.d, padding: "x".repeat(4096) })),
  ],
  [
    "catalog",
    (f) =>
      f.db
        .prepare("UPDATE catalog_books SET public_json=?")
        .run(json({ ...f.book, description: "x".repeat(262144) })),
  ],
])
  test(`SQL bounds ${label} before returning a large observation`, async (t) => {
    const f = fixture(t);
    f.unsafe(() => mutate(f));
    const projection = confirmedSourceProjection(
      storageReadConfiguration(f.env),
      {
        scope: "production",
        fileId: f.d.fileId,
        sessionHash: session.session_hash,
        generation: 1,
        nowMs: NOW,
        origin: ORIGIN,
      },
    );
    assert.deepEqual(
      { ...f.db.prepare(projection.sql).get(...projection.parameters) },
      { snapshot_json: null, overflow: 1 },
    );
    await rejected(() => f.resolve(), 503);
    assert.equal(f.r2.length, 0);
  });
test("schema overflow/unknown objects and oversized transport observations fail closed", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 300; i++) f.db.exec(`CREATE TABLE extra_${i}(v TEXT)`);
  await rejected(() => f.resolve(), 503);
  const h = fixture(t);
  h.env.DB = {
    withSession() {
      return {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  return { snapshot_json: "x".repeat(1048576), overflow: 0 };
                },
              };
            },
          };
        },
      };
    },
  };
  await rejected(() => h.resolve(), 503);
});
test("fixed SQL and observations stay inside exact per-operation budgets", async (t) => {
  const f = fixture(t),
    configuration = storageReadConfiguration(f.env),
    projection = confirmedSourceProjection(configuration, {
      scope: "production",
      fileId: f.d.fileId,
      sessionHash: session.session_hash,
      generation: 1,
      nowMs: NOW,
      origin: ORIGIN,
    });
  assert.equal(projection.parameters.length, 6);
  assert.equal((STORAGE_SOURCE_SQL.match(/\?/g) || []).length, 6);
  assert.equal((STORAGE_SOURCE_GUARD_SQL.match(/\?/g) || []).length, 7);
  assert.ok(
    Buffer.byteLength(STORAGE_SOURCE_SQL) <= STORAGE_SOURCE_LIMITS.sqlBytes,
  );
  assert.ok(
    Buffer.byteLength(STORAGE_SOURCE_GUARD_SQL) <=
      STORAGE_SOURCE_LIMITS.sqlBytes,
  );
  const g = await f.resolve(),
    guard = confirmedSourceGuard(g, { context, session, nowMs: NOW });
  assert.equal(guard.parameters.length, 7);
  assert.equal(f.db.prepare(guard.sql).get(...guard.parameters).unchanged, 1);
  assert.ok(
    Buffer.byteLength(guard.parameters[6]) <=
      STORAGE_SOURCE_LIMITS.snapshotBytes,
  );
  assert.ok(
    Buffer.byteLength(
      json(f.db.prepare(projection.sql).get(...projection.parameters)),
    ) < STORAGE_SOURCE_LIMITS.responseBytes,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.r2.length, 0);
  const bundle = await build({
    entryPoints: ["cloudflare/library/storage-sources.mjs"],
    platform: "browser",
    bundle: true,
    write: false,
    format: "esm",
    metafile: true,
    logLevel: "silent",
  });
  assert.equal(
    Object.keys(bundle.metafile.inputs).some(
      (name) =>
        name.startsWith("server/") ||
        name.startsWith("scripts/") ||
        name.includes("single-trial.mjs"),
    ),
    false,
  );
});

test("real workerd dual R2 bindings: same key, different bytes, selected source only and no fallback", async (t) => {
  const normal = fixture(t),
    trial = fixture(t, { source: "trial" });
  const entry = `import{resolveConfirmedSource,readSourceAdapter,assertUnchangedSourceGrant}from"../cloudflare/library/storage-sources.mjs";
 export default{async fetch(request,env){let secretReads=0,writes=0;const e={...env,BOOKS:{head:env.BOOKS.head.bind(env.BOOKS),get:env.BOOKS.get.bind(env.BOOKS)},TRIAL_BOOKS:{head:env.TRIAL_BOOKS.head.bind(env.TRIAL_BOOKS),get:env.TRIAL_BOOKS.get.bind(env.TRIAL_BOOKS)}};
 for(const name of ['OWNER_KEY_PEPPER','SESSION_SECRET','SINGLE_TRIAL_UPLOAD_SECRET','FILENAME_AI_KEY'])Object.defineProperty(e,name,{get(){secretReads++;throw Error('must-not-read');}});
 for(const store of[e.BOOKS,e.TRIAL_BOOKS])for(const name of['put','delete','list'])Object.defineProperty(store,name,{get(){writes++;throw Error('must-not-read');}});
 try{const context=${json(context)},session=${json(session)};const grant=await resolveConfirmedSource(e,{context,session,fileId:'file_shared'}),adapter=readSourceAdapter(e,grant);const object=await adapter.get();if(!object)return Response.json({source:grant.source,missing:true,secretReads,writes});await assertUnchangedSourceGrant(e,grant,{context,session,nowMs:${NOW}});return Response.json({source:grant.source,text:await new Response(object.body).text(),secretReads,writes});}catch(error){return Response.json({error:error.code,status:error.status,secretReads,writes});}}};`;
  const bundle = await build({
    stdin: {
      contents: entry,
      resolveDir: path.join(ROOT, "tests"),
      sourcefile: "synthetic-storage-sources-runtime.mjs",
    },
    platform: "neutral",
    bundle: true,
    write: false,
    format: "esm",
  });
  const bindings = {
    APP_SCOPE: "production",
    SITE_ORIGIN: ORIGIN,
    STORAGE_MODE: "authority-v2",
    STORAGE_WRITE_MODE: "closed",
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: "the-shelf-books",
    TRIAL_R2_ACCOUNT_ID: ACCOUNT,
    TRIAL_R2_BUCKET: "the-shelf-first-book-20261023",
    TRIAL_TARGET_SHA256: TARGET,
    FILENAME_AI_MODE: "filename-v1",
  };
  const worker = (name) => ({
    name,
    modules: true,
    compatibilityDate: "2026-10-15",
    rootPath: ROOT,
    scriptPath: path.join(
      ROOT,
      "tests",
      `synthetic-storage-sources-${name}.mjs`,
    ),
    script: bundle.outputFiles[0].text,
    bindings,
    d1Databases: { DB: `storage-sources-${name}` },
    r2Buckets: {
      BOOKS: "storage-sources-normal",
      TRIAL_BOOKS: "storage-sources-trial",
    },
    outboundService() {
      throw Error("unexpected external request");
    },
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new NoOpLog(),
      workers: [worker("normal"), worker("trial")],
    }),
  );
  t.after(() => mf.dispose());
  for (const [name, f] of [
    ["normal", normal],
    ["trial", trial],
  ]) {
    const d1 = await mf.getD1Database("DB", name);
    for (const type of ["table", "index", "view"])
      for (const row of f.schema)
        if (row.type === type) await d1.prepare(row.sql).run();
    const dependencyOrder = [
      "public_state",
      "auth_config",
      "catalog_books",
      "sessions",
      "book_management",
      "shelf_storage_authority",
      "shelf_storage_reservations",
      "shelf_storage_original_registry",
      "file_registry",
      "shelf_storage_single_trial",
    ];
    const seedTables = f.schema
      .filter((r) => r.type === "table")
      .sort((a, b) => {
        const rank = (name) =>
          dependencyOrder.includes(name)
            ? dependencyOrder.indexOf(name)
            : dependencyOrder.length;
        return rank(a.name) - rank(b.name);
      });
    for (const row of seedTables)
      for (const values of f.db.prepare(`SELECT * FROM ${row.name}`).all()) {
        const columns = Object.keys(values);
        await d1
          .prepare(
            `INSERT INTO ${row.name}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...columns.map((c) => values[c]))
          .run();
      }
    for (const row of f.schema.filter((r) => r.type === "trigger"))
      await d1.prepare(row.sql).run();
  }
  const books = await mf.getR2Bucket("BOOKS", "normal"),
    isolated = await mf.getR2Bucket("TRIAL_BOOKS", "normal");
  // Deliberately different fixture bytes under one key; this proves binding
  // selection, not a new content-verification assertion about either fixture.
  const stored = await books.put(normal.d.objectKey, "normal original");
  const trialStored = await isolated.put(normal.d.objectKey, "trial isolated!");
  for (const [name, etag] of [
    ["normal", stored.etag],
    ["trial", trialStored.etag],
  ]) {
    const d1 = await mf.getD1Database("DB", name);
    const guards = normal.schema.filter((r) => r.type === "trigger");
    for (const row of guards)
      await d1.prepare(`DROP TRIGGER ${row.name}`).run();
    for (const table of [
      name === "normal" ? "file_registry" : "shelf_storage_single_trial",
      ...(name === "normal"
        ? ["shelf_storage_original_registry", "shelf_storage_reservations"]
        : []),
    ])
      await d1.prepare(`UPDATE ${table} SET etag=?`).bind(etag).run();
    for (const row of guards) await d1.prepare(row.sql).run();
    const observed = await d1
      .prepare(STORAGE_SOURCE_SQL)
      .bind("production", "file_shared", session.session_hash, 1, NOW, ORIGIN)
      .first();
    assert.equal(observed.overflow, 0);
    const observedSchema = JSON.parse(observed.snapshot_json).schema;
    const expectedSchema = DATABASE_SCHEMA_PROFILES["trial-010-cf-metadata-v1"];
    assert.deepEqual(
      observedSchema.map((row) => ({
        ...row,
        sql: row.sql.trim().replace(/;$/, ""),
      })),
      expectedSchema,
    );
  }
  const run = async (name) =>
    (
      await (await mf.getWorker(name)).fetch("https://synthetic.invalid/read")
    ).json();
  assert.deepEqual(await run("normal"), {
    source: "normal",
    text: "normal original",
    secretReads: 0,
    writes: 0,
  });
  assert.deepEqual(await run("trial"), {
    source: "trial",
    text: "trial isolated!",
    secretReads: 0,
    writes: 0,
  });
  await isolated.delete(normal.d.objectKey);
  assert.deepEqual(await run("trial"), {
    source: "trial",
    missing: true,
    secretReads: 0,
    writes: 0,
  });
  assert.equal(
    await (await books.get(normal.d.objectKey)).text(),
    "normal original",
  );
});
