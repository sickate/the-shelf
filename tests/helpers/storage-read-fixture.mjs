// Synthetic exact-schema fixture shared only by v2 controller tests.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DATABASE_SCHEMA_PROFILES } from "../../shared/storage-schema-profiles.mjs";
import {
  resolveConfirmedSource,
  assertUnchangedSourceGrant,
} from "../../cloudflare/library/storage-sources.mjs";
const json = JSON.stringify;
const ACCOUNT = "a".repeat(32),
  TARGET = "b".repeat(64),
  NOW = Date.now();
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
export const context = {
    scope: "production",
    origin: ORIGIN,
    now: NOW,
    ip: "f".repeat(64),
  },
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

export function fixture(
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
    prepare(sql) {
      const make = (params = []) => ({
        bind: (...values) => make(values),
        async first() {
          calls.push({ sql, params });
          const result = db.prepare(sql).get(...params) || null;
          await DB.afterFirst?.(sql, params, result);
          return result;
        },
        async all() {
          calls.push({ sql, params });
          return { results: db.prepare(sql).all(...params) };
        },
        async run() {
          calls.push({ sql, params });
          return { meta: db.prepare(sql).run(...params) };
        },
        execute: () => ({ results: db.prepare(sql).all(...params) }),
      });
      return make();
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const result = statements.map((statement) => statement.execute());
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    withSession(mode) {
      assert.equal(mode, "first-primary");
      return this;
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
      configurable: true,
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
