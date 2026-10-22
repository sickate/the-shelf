import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  RemoteStorageAuthority,
  validateMigrationReceipt,
} from "../server/remote-storage-authority.mjs";
import {
  prepareObject,
  bytesSha256,
  objectContentType,
  StorageError,
} from "../server/storage-authority.mjs";
import { syncObject } from "../server/object-sync.mjs";

const ACCOUNT = "a".repeat(32),
  TOKEN = "synthetic-private-token";
const IDS = {
  check: "11111111-1111-4111-8111-111111111111",
  production: "22222222-2222-4222-8222-222222222222",
};
const identity = () => ({
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: { ...IDS },
});
const names = {
  check: "the-shelf-cf03-check",
  production: "the-shelf-library",
};
const evidence = (storedBytes = 0, time = Date.now()) => ({
  schemaVersion: 1,
  source: "cloudflare-account-aggregate",
  targetAccount: ACCOUNT,
  accountMatch: true,
  completeCoverage: true,
  plan: "free",
  storageClass: "Standard",
  storedBytes,
  observedAt: new Date(time).toISOString(),
  billingPeriod: new Date(time).toISOString().slice(0, 7),
  classAOperations: 0,
  classBOperations: 0,
});
const original = (
  scope = "production",
  fileId = "file_one",
  bytes = new Uint8Array([1, 2, 3, 4]),
) =>
  prepareObject({
    kind: "original",
    scope,
    fileId,
    bookId: "book_one",
    format: "PDF",
    bytes,
  });
async function prepared(scope = "production") {
  const text = "Synthetic text";
  const source = {
    fileId: "file_1234567890abcdef",
    bookId: "book_1234567890abcdef",
    format: "PDF",
    sizeBytes: 123,
    mtimeNs: "123456",
    fingerprint: { algorithm: "sha256", value: bytesSha256("source") },
  };
  const chunks = [
    {
      index: 0,
      locator: { type: "pdf-page", page: 1, start: 0, end: text.length },
      text,
      sha256: bytesSha256(text),
    },
  ];
  const body = {
    schemaVersion: 1,
    kind: "shelf.prepared-text",
    preparation: {
      algorithm: "shelf-text-v1",
      normalization: "LF-NFC-trim-section",
      chunkCodepoints: 6000,
      offsetUnit: "unicode-code-point",
    },
    source,
    textBytes: Buffer.byteLength(text),
    contentHash: bytesSha256(JSON.stringify(chunks)),
    chunks,
  };
  const value = { ...body, versionHash: bytesSha256(JSON.stringify(body)) };
  return prepareObject({
    kind: "prepared-text",
    scope,
    fileId: source.fileId,
    bookId: source.bookId,
    format: "JSON",
    bytes: new TextEncoder().encode(JSON.stringify(value) + "\n"),
    source: {
      fileId: source.fileId,
      bookId: source.bookId,
      format: "PDF",
      sizeBytes: source.sizeBytes,
      mtimeNs: source.mtimeNs,
      versionHash: value.versionHash,
      sourceSha256: source.fingerprint.value,
    },
  });
}
function store() {
  const objects = new Map(),
    calls = [];
  return {
    objects,
    calls,
    store: {
      target: { accountId: ACCOUNT, bucket: "the-shelf-books" },
      async head(k) {
        calls.push("head");
        return objects.has(k) ? { ...objects.get(k).head } : null;
      },
      async get(k, options) {
        calls.push("get");
        assert.equal(options.ifMatch, objects.get(k).head.etag);
        return new ReadableStream({
          start(c) {
            c.enqueue(Uint8Array.from(objects.get(k).bytes));
            c.close();
          },
        });
      },
      async put(k, b, o) {
        calls.push("put");
        assert.equal(o.ifNoneMatch, "*");
        assert.equal(objects.has(k), false);
        objects.set(k, {
          bytes: Uint8Array.from(b),
          head: {
            size: b.length,
            sha256: o.sha256,
            etag: '"synthetic-etag"',
            contentType: o.contentType,
          },
        });
      },
    },
  };
}
async function fixture(t, { ready = true, seed, initialize = true } = {}) {
  const dbs = {
    check: new DatabaseSync(":memory:"),
    production: new DatabaseSync(":memory:"),
  };
  t.after(() => {
    for (const db of Object.values(dbs)) db.close();
  });
  const base = await fs.readFile(
    new URL("../cloudflare/library/schema.sql", import.meta.url),
    "utf8",
  );
  const authority = await fs.readFile(
    new URL(
      "../cloudflare/library/migrations/003-storage-authority.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const freeze = await fs.readFile(
    new URL(
      "../cloudflare/library/migrations/004-freeze-legacy-storage.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const db of Object.values(dbs)) db.exec(base);
  const catalog = (object) => {
    const d = object.descriptor;
    dbs[d.scope]
      .prepare(
        "INSERT INTO catalog_books(scope,book_id,public_json) VALUES(?,?,?) ON CONFLICT(scope,book_id) DO UPDATE SET public_json=excluded.public_json",
      )
      .run(
        d.scope,
        d.bookId,
        JSON.stringify({
          id: d.bookId,
          files: [
            {
              id: d.fileId,
              format: d.format,
              sizeBytes: d.sizeBytes,
              status: "candidate",
            },
          ],
        }),
      );
  };
  if (seed) await seed(dbs, catalog);
  dbs.production.exec(authority);
  const frozenAt = Date.now() - 1000;
  for (const [scope, db] of Object.entries(dbs)) {
    db.exec(freeze);
    db.prepare(
      "INSERT INTO shelf_storage_legacy_freeze VALUES(1,?,?,?,?,?)",
    ).run(
      identity().authorityId,
      ACCOUNT,
      "the-shelf-books",
      `freeze-${scope}`,
      frozenAt,
    );
  }
  const calls = [],
    intents = [];
  let fault = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    const scope = url.includes(IDS.check)
      ? "check"
      : url.includes(IDS.production)
        ? "production"
        : assert.fail("wrong fixed D1");
    if (fault) {
      const response = await fault({ url, options, scope, db: dbs[scope] });
      if (response) return response;
    }
    if (!url.endsWith("/query"))
      return Response.json({
        success: true,
        result: { uuid: IDS[scope], name: names[scope] },
      });
    const { sql, params } = JSON.parse(options.body);
    assert.ok(params.length <= 100);
    assert.ok(sql.length <= 100000);
    // Each statement is a real SQLite autocommit transaction, matching D1 serialization.
    const results = dbs[scope].prepare(sql).all(...params);
    return Response.json({
      success: true,
      result: [{ success: true, results }],
    });
  };
  const create = (extra = {}) =>
    new RemoteStorageAuthority({
      identity: identity(),
      credentials: { accountId: ACCOUNT, token: TOKEN },
      resource: { databaseId: IDS.production, databaseName: names.production },
      fetchImpl,
      beforeRequest: async (i) => {
        intents.push(i);
        assert.equal(JSON.stringify(i).includes(TOKEN), false);
      },
      requestLimit: 256,
      verifyWriteClosure: async () => ({
        schemaVersion: 1,
        identitySha256: bytesSha256(JSON.stringify(identity())),
        entrypointSha256: bytesSha256("synthetic entrypoint proof"),
        localStateSha256: bytesSha256("synthetic local proof"),
        processEvidenceSha256: bytesSha256("synthetic process proof"),
        connectionEvidenceSha256: bytesSha256(
          "synthetic closed connection proof",
        ),
        probeClosureSha256: bytesSha256("synthetic probe proof"),
        localLegacyEmpty: true,
        lockAbsent: true,
        legacyEntryPointsDisabled: true,
        legacyProcessesStopped: true,
        legacyConnectionsClosed: true,
        probeWriteCapabilityDisabled: true,
        drainBound: {
          source: "enforced-transport-deadline",
          maxRequestLifetimeMs: 60000,
          configurationSha256: bytesSha256(
            "synthetic enforced deadline configuration",
          ),
        },
        stoppedAt: Date.now() - 61000,
        drainedAt: Date.now(),
        verifiedAt: Date.now(),
        deadlineMs: 60000,
      }),
      ...extra,
    });
  const remote = create();
  if (initialize) await remote.initialize(identity());
  let snapshots, receipt;
  if (ready) {
    snapshots = await remote.readFrozenSnapshots(identity());
    await remote.migrateFrozen(identity(), snapshots);
    receipt = await remote.activateFrozen(identity(), snapshots);
  }
  return {
    remote,
    dbs,
    calls,
    intents,
    create,
    catalog,
    snapshots,
    receipt,
    setFault(fn) {
      fault = fn;
    },
  };
}
const sync = (f, object, mock, more = {}) =>
  syncObject({
    authority: f.remote,
    identity: identity(),
    reservationId: "one",
    ...object,
    evidence: evidence(),
    store: mock.store,
    ...more,
  });

test("real SQL frozen empty sources import atomically and independent complete readback opens one authority", async (t) => {
  const f = await fixture(t);
  assert.equal(f.receipt.cloudWriteFreezeProven, true);
  assert.equal(f.receipt.sourceProjectionVerified, true);
  assert.deepEqual(await f.remote.inspect(identity()), {
    phase: "ready",
    committedBytes: 0,
    reservedBytes: 0,
    observedBytes: null,
    migrationHash: f.receipt.migrationHash,
  });
  assert.deepEqual(
    await f.remote.migrateFrozen(identity(), f.snapshots),
    f.receipt,
  );
  assert.equal(f.calls.length, f.intents.length);
  assert.equal(
    f.dbs.check
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='shelf_storage_authority'",
      )
      .get().n,
    0,
  );
});

test("original confirmation and production read projection share the same atomic SQL commit", async (t) => {
  const f = await fixture(t),
    object = await original(),
    mock = store();
  f.catalog(object);
  assert.equal((await sync(f, object, mock)).state, "confirmed");
  const state = await f.remote.inspect(identity());
  assert.equal(state.committedBytes, 4);
  assert.equal(state.reservedBytes, 0);
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM file_registry").get().n,
    1,
  );
  assert.equal((await f.remote.registry(identity(), "original")).length, 1);
  await sync(f, object, mock);
  assert.equal(mock.calls.filter((c) => c === "put").length, 1);
});

test("original/text and both scopes compete for one final shared allocation using exact D1 statements", async (t) => {
  const f = await fixture(t),
    text = await prepared(),
    size = text.bytes.length;
  const objects = [
    await original("production", "file_a", new Uint8Array(size)),
    await original("check", "file_b", new Uint8Array(size)),
    text,
    await prepared("check"),
  ];
  const observed = evidence(8_000_000_000 - size);
  const results = await Promise.allSettled(
    objects.map((o, i) =>
      f
        .create()
        .reserve(identity(), `race${i}`, o.descriptor, o.bytes, observed),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const state = await f.remote.inspect(identity());
  assert.equal(state.reservedBytes, size);
  assert.equal(state.committedBytes, 0);
});

test("fresh evidence, monotonic hash/time and SQL admission bounds fail closed", async (t) => {
  const f = await fixture(t),
    o = await original();
  for (const patch of [
    { observedAt: new Date(Date.now() - 300001).toISOString() },
    { completeCoverage: false },
    { observedAt: new Date(Date.now() + 1000).toISOString() },
    { plan: "paid" },
  ])
    await assert.rejects(
      f.remote.reserve(identity(), "one", o.descriptor, o.bytes, {
        ...evidence(),
        ...patch,
      }),
    );
  const e = evidence();
  await f.remote.reserve(identity(), "one", o.descriptor, o.bytes, e);
  await assert.rejects(
    f.remote.reserve(identity(), "one", o.descriptor, o.bytes, {
      ...e,
      storedBytes: 1,
    }),
  );
  assert.equal((await f.remote.inspect(identity())).reservedBytes, 4);
});

test("lost PUT response retains all budget and only verification can recover without a second PUT", async (t) => {
  const f = await fixture(t),
    o = await original(),
    mock = store();
  f.catalog(o);
  const put = mock.store.put;
  mock.store.put = async (...args) => {
    await put(...args);
    throw new Error("lost response");
  };
  await assert.rejects(sync(f, o, mock));
  assert.equal((await f.remote.get(identity(), "one")).state, "uncertain");
  assert.equal((await f.remote.inspect(identity())).reservedBytes, 4);
  assert.equal((await sync(f, o, mock)).state, "confirmed");
  assert.equal(mock.calls.filter((c) => c === "put").length, 1);
});

test("claim response loss never dispatches PUT and durable uploading becomes uncertain", async (t) => {
  const f = await fixture(t),
    o = await original(),
    mock = store();
  let once = true;
  f.setFault(({ options, db }) => {
    if (once && options.body?.includes("SET state='uploading'")) {
      once = false;
      const { sql, params } = JSON.parse(options.body);
      db.prepare(sql).all(...params);
      throw new Error("response lost");
    }
  });
  await assert.rejects(sync(f, o, mock));
  assert.equal(mock.calls.includes("put"), false);
  assert.equal((await f.remote.get(identity(), "one")).state, "uncertain");
  await sync(f, o, mock);
  assert.equal(mock.calls.includes("put"), false);
  assert.equal((await f.remote.inspect(identity())).reservedBytes, 4);
});

test("confirmation or catalog projection failure rolls back registry/counters and leaves full uncertain reservation", async (t) => {
  const f = await fixture(t),
    o = await original(),
    mock = store(); // Deliberately no production catalog row.
  await assert.rejects(sync(f, o, mock));
  assert.equal((await f.remote.get(identity(), "one")).state, "uncertain");
  assert.equal((await f.remote.inspect(identity())).reservedBytes, 4);
  assert.equal(
    f.dbs.production
      .prepare("SELECT count(*) AS n FROM shelf_storage_original_registry")
      .get().n,
    0,
  );
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM file_registry").get().n,
    0,
  );
});

test("caller frozen boolean cannot replace fixed-source marker and exact freeze-trigger readback", async (t) => {
  const f = await fixture(t, { ready: false });
  const snapshots = await f.remote.readFrozenSnapshots(identity());
  f.dbs.check.exec("DROP TRIGGER shelf_legacy_state_insert");
  await assert.rejects(f.remote.migrateFrozen(identity(), snapshots), {
    code: "migration_freeze_unproven",
  });
  assert.equal(
    (await f.remote.inspect(identity())).phase,
    "migration_required",
  );
});

test("partial staging resumes idempotently and hidden extra live rows block readiness", async (t) => {
  const f = await fixture(t, { ready: false });
  const snapshots = await f.remote.readFrozenSnapshots(identity());
  let once = true;
  f.setFault(({ options }) => {
    if (once && options.body?.includes("SET phase='imported'")) {
      once = false;
      throw new Error("stopped before publish");
    }
  });
  await assert.rejects(f.remote.migrateFrozen(identity(), snapshots));
  assert.equal(
    (await f.remote.inspect(identity())).phase,
    "migration_required",
  );
  f.setFault(null);
  const receipt = await f.create().migrateFrozen(identity(), snapshots);
  assert.equal(receipt.cloudWriteFreezeProven, false);
  await f.create().activateFrozen(identity(), snapshots);
});

test("legacy storage writes cannot re-open independent budgets after freeze", async (t) => {
  const f = await fixture(t);
  for (const db of Object.values(f.dbs)) {
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO storage_state VALUES(1,?,0,?,8000000000,0,0,?,1,?)",
        )
        .run(ACCOUNT, Date.now(), "f".repeat(64), Date.now()),
    );
    assert.throws(() =>
      db.prepare("UPDATE shelf_storage_legacy_freeze SET frozen_at=0").run(),
    );
    assert.throws(() =>
      db.prepare("DELETE FROM shelf_storage_legacy_freeze").run(),
    );
  }
});

test("wrong identity, fixed production target, missing journal and request exhaustion prevent dispatch", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  assert.throws(
    () =>
      f.create({
        resource: { databaseId: IDS.check, databaseName: names.check },
      }),
    { code: "storage_remote_configuration_invalid" },
  );
  assert.throws(() => f.create({ beforeRequest: undefined }), {
    code: "storage_remote_configuration_invalid",
  });
  const limited = f.create({
    requestLimit: 1,
    fetchImpl: async (...args) => {
      calls++;
      return Response.json({
        success: true,
        result: { uuid: IDS.production, name: names.production },
      });
    },
  });
  await assert.rejects(limited.inspect(identity()), {
    code: "storage_remote_request_budget",
  });
  assert.equal(calls, 1);
  await assert.rejects(
    f.remote.inspect({ ...identity(), authorityId: "other" }),
    { code: "storage_identity_mismatch" },
  );
});

test("identity and id rejection cannot leave rejected async byte validation unhandled", async (t) => {
  const f = await fixture(t),
    o = await original(),
    unhandled = [];
  const observe = (error) => unhandled.push(error);
  process.on("unhandledRejection", observe);
  try {
    const before = f.calls.length;
    await assert.rejects(
      f.remote.reserve(
        { ...identity(), authorityId: "wrong" },
        "one",
        o.descriptor,
        new Uint8Array(),
        evidence(),
      ),
      { code: "storage_identity_mismatch" },
    );
    await assert.rejects(
      f.remote.reserve(
        identity(),
        "invalid:id",
        { malformed: true },
        new Uint8Array(),
        evidence(),
      ),
      { code: "storage_reservation_invalid" },
    );
    await assert.rejects(
      f.remote.reserve(
        { ...identity(), authorityId: "wrong" },
        "one",
        { malformed: true },
        new Uint8Array(),
        evidence(),
      ),
      { code: "storage_identity_mismatch" },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(f.calls.length, before);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", observe);
  }
});

async function seedLegacy(dbs, catalog, object, state, id) {
  const d = object.descriptor,
    db = dbs[d.scope];
  catalog(object);
  db.prepare(
    "INSERT OR IGNORE INTO storage_state VALUES(1,?,0,?,8000000000,0,0,?,1,?)",
  ).run(ACCOUNT, Date.now(), "f".repeat(64), Date.now());
  db.prepare(
    "INSERT INTO upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?,?)",
  ).run(
    id,
    d.scope,
    d.fileId,
    d.bookId,
    d.objectKey,
    d.sizeBytes,
    d.format,
    d.sha256,
    Date.now(),
    Date.now(),
  );
  if (state === "confirmed" || state === "disabled") {
    db.prepare(
      "UPDATE upload_reservations SET state='confirmed',content_verified=1,etag=? WHERE reservation_id=?",
    ).run('"legacy-etag"', id);
    if (state === "disabled")
      db.prepare(
        "UPDATE file_registry SET state='disabled' WHERE scope=? AND file_id=?",
      ).run(d.scope, d.fileId);
  } else if (state !== "reserved")
    db.prepare(
      "UPDATE upload_reservations SET state=?,absence_verified=? WHERE reservation_id=?",
    ).run(state, Number(state === "aborted"), id);
}

test("nonempty exact legacy sources retain uncertain, disabled committed and verified aborted semantics", async (t) => {
  const pending = await original("check", "file_pending"),
    disabled = await original("production", "file_disabled"),
    aborted = await original("check", "file_aborted");
  const f = await fixture(t, {
    seed: async (dbs, catalog) => {
      await seedLegacy(dbs, catalog, pending, "uncertain", "old-pending");
      await seedLegacy(dbs, catalog, disabled, "disabled", "old-disabled");
      await seedLegacy(dbs, catalog, aborted, "aborted", "old-aborted");
    },
  });
  const state = await f.remote.inspect(identity());
  assert.equal(state.reservedBytes, 4);
  assert.equal(state.committedBytes, 4);
  const row = await f.remote.get(identity(), "check:old-pending");
  assert.equal(row.state, "uncertain");
  assert.equal(row.putAttempted, true);
  await assert.rejects(f.remote.claimPut(identity(), "check:old-pending"), {
    code: "storage_put_already_claimed",
  });
  const registry = await f.remote.registry(identity(), "original");
  assert.equal(registry.length, 1);
  assert.equal(registry[0].enabled, false);
  assert.equal(f.receipt.importedReservations, 2);
  assert.equal(
    f.dbs.production
      .prepare("SELECT state FROM file_registry WHERE file_id='file_disabled'")
      .get().state,
    "disabled",
  );
});

test("database-only freeze proof cannot make ready without independently supplied structured writer-closure verifier", async (t) => {
  const f = await fixture(t, { ready: false }),
    snapshots = await f.remote.readFrozenSnapshots(identity());
  await assert.rejects(
    f
      .create({ verifyWriteClosure: undefined })
      .activateFrozen(identity(), snapshots),
    { code: "migration_write_closure_unproven" },
  );
  assert.equal((await f.remote.inspect(identity())).phase, "imported");
  const o = await original(),
    d = o.descriptor;
  assert.throws(
    () =>
      f.dbs.production
        .prepare(
          "INSERT INTO shelf_storage_reservations VALUES(?,?,?,?,?,'reserved',0,0,NULL,?,?)",
        )
        .run(
          "unstaged",
          "original:production:file_one:original",
          d.objectKey,
          JSON.stringify(d),
          4,
          Date.now(),
          Date.now(),
        ),
    /migration_unstaged_reservation/,
  );
  await assert.rejects(
    f
      .create({ verifyWriteClosure: async () => true })
      .activateFrozen(identity(), snapshots),
    { code: "migration_write_closure_unproven" },
  );
  assert.equal((await f.remote.inspect(identity())).phase, "imported");
  await f.create().activateFrozen(identity(), snapshots);
  assert.equal((await f.remote.inspect(identity())).phase, "ready");
});

test("unverified direct original/text registry insertion is blocked by SQL guards", async (t) => {
  const f = await fixture(t),
    o = await original();
  await f.remote.reserve(identity(), "one", o.descriptor, o.bytes, evidence());
  for (const table of [
    "shelf_storage_original_registry",
    "shelf_storage_text_registry",
  ])
    assert.throws(
      () =>
        f.dbs.production
          .prepare(`INSERT INTO ${table} VALUES(?,?,?, ?,1)`)
          .run(
            "original:production:file_one:original",
            "one",
            JSON.stringify(o.descriptor),
            '"fake"',
          ),
      /storage_registry_unverified/,
    );
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM file_registry").get().n,
    0,
  );
});

test("whole verification timeout contains hanging GET/cancel and suppresses subsequent HEAD dispatch", async (t) => {
  const f = await fixture(t),
    o = await original();
  await f.remote.reserve(identity(), "one", o.descriptor, o.bytes, evidence());
  await f.remote.claimPut(identity(), "one");
  const remote = f.create({ verificationTimeoutMs: 10 });
  let heads = 0,
    cancels = 0,
    release;
  const adapter = {
    target: { accountId: ACCOUNT, bucket: "the-shelf-books" },
    async head() {
      heads++;
      return {
        size: 4,
        sha256: o.descriptor.sha256,
        etag: '"etag"',
        contentType: objectContentType(o.descriptor),
      };
    },
    async get() {
      return new ReadableStream({
        pull() {
          return new Promise((r) => {
            release = r;
          });
        },
        cancel() {
          cancels++;
          return new Promise(() => {});
        },
      });
    },
    async put() {
      assert.fail("no put");
    },
  };
  const start = performance.now();
  await assert.rejects(remote.reconcile(identity(), "one", adapter), {
    code: "object_verification_timeout",
  });
  assert.ok(performance.now() - start < 1000);
  assert.equal(heads, 1);
  assert.equal(cancels, 1);
  release?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(heads, 1);
  assert.equal((await f.remote.get(identity(), "one")).state, "uncertain");
  assert.equal((await f.remote.inspect(identity())).reservedBytes, 4);
});

test("committed claim followed by HTTP502 or malformed200 is unknown, never PUT or automatic replay", async (t) => {
  for (const response of [
    () => new Response("private upstream text", { status: 502 }),
    () => new Response("private provider rejection", { status: 400 }),
    () => new Response("not JSON"),
    () => Response.json({ success: false }),
    () =>
      Response.json({
        success: true,
        result: [{ success: false, results: [] }],
      }),
  ]) {
    const f = await fixture(t),
      o = await original(),
      mock = store();
    let applied = 0;
    f.setFault(({ options, db }) => {
      if (options.body?.includes("SET state='uploading'")) {
        applied++;
        const { sql, params } = JSON.parse(options.body);
        db.prepare(sql).all(...params);
        return response();
      }
    });
    await assert.rejects(sync(f, o, mock), {
      code: "storage_remote_outcome_unknown",
    });
    assert.equal(applied, 1);
    assert.equal(mock.calls.includes("put"), false);
    assert.equal((await f.remote.get(identity(), "one")).state, "uncertain");
    assert.equal((await f.remote.inspect(identity())).reservedBytes, 4);
  }
});

test("prepared-text confirms in its own registry for both scopes without faking original files", async (t) => {
  const f = await fixture(t),
    mock = store();
  let total = 0;
  for (const [i, scope] of ["check", "production"].entries()) {
    const o = await prepared(scope);
    total += o.bytes.length;
    assert.equal(
      (await sync(f, o, mock, { reservationId: `text${i}` })).state,
      "confirmed",
    );
  }
  assert.equal(
    (await f.remote.registry(identity(), "prepared-text")).length,
    2,
  );
  assert.equal((await f.remote.registry(identity(), "original")).length, 0);
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM file_registry").get().n,
    0,
  );
  assert.equal((await f.remote.inspect(identity())).committedBytes, total);
});

test("concurrent same-reservation sync uses one durable CAS and exactly one PUT", async (t) => {
  const f = await fixture(t),
    o = await original(),
    mock = store();
  f.catalog(o);
  const results = await Promise.allSettled([
    sync(f, o, mock),
    sync({ ...f, remote: f.create() }, o, mock),
  ]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  assert.equal(mock.calls.filter((c) => c === "put").length, 1);
  assert.equal((await f.remote.get(identity(), "one")).state, "confirmed");
  assert.equal((await f.remote.inspect(identity())).committedBytes, 4);
});

test("independent readback rejects extra response rows and final freeze-schema drift before readiness", async (t) => {
  for (const mode of ["extra", "final-freeze"]) {
    const f = await fixture(t, { ready: false }),
      snapshots = await f.remote.readFrozenSnapshots(identity());
    let once = true;
    f.setFault(({ options, db }) => {
      if (
        once &&
        mode === "extra" &&
        options.body?.includes(
          "SELECT * FROM shelf_storage_reservations WHERE reservation_id>",
        )
      ) {
        once = false;
        return Response.json({
          success: true,
          result: [
            {
              success: true,
              results: [{ reservation_id: "unexpected-hidden-row" }],
            },
          ],
        });
      }
      if (
        once &&
        mode === "final-freeze" &&
        options.body?.includes("SELECT * FROM shelf_storage_text_registry")
      ) {
        once = false;
        f.dbs.check.exec("DROP TRIGGER shelf_legacy_marker_delete");
      }
    });
    await assert.rejects(f.remote.migrateFrozen(identity(), snapshots), {
      code:
        mode === "extra"
          ? "migration_readback_failed"
          : "migration_freeze_unproven",
    });
    assert.equal((await f.remote.inspect(identity())).phase, "imported");
  }
});

test("imported disabled original cannot be replaced/enabled and ready reservations cannot be replaced to evade counters", async (t) => {
  const o = await original("production", "file_disabled");
  const f = await fixture(t, {
    ready: false,
    seed: async (dbs, catalog) =>
      seedLegacy(dbs, catalog, o, "disabled", "old-disabled"),
  });
  const snapshots = await f.remote.readFrozenSnapshots(identity());
  const imported = await f.remote.migrateFrozen(identity(), snapshots);
  assert.equal(imported.cloudWriteFreezeProven, false);
  assert.equal((await f.remote.inspect(identity())).phase, "imported");
  const r = f.dbs.production
    .prepare("SELECT * FROM shelf_storage_original_registry")
    .get();
  assert.throws(() =>
    f.dbs.production
      .prepare(
        "INSERT OR REPLACE INTO shelf_storage_original_registry VALUES(?,?,?,?,1)",
      )
      .run(r.logical_key, r.reservation_id, r.descriptor_json, r.etag),
  );
  assert.equal(
    f.dbs.production
      .prepare("SELECT enabled FROM shelf_storage_original_registry")
      .get().enabled,
    0,
  );
  await f.remote.activateFrozen(identity(), snapshots);
  const other = await original("check", "file_next");
  await f.remote.reserve(
    identity(),
    "next",
    other.descriptor,
    other.bytes,
    evidence(),
  );
  const row = f.dbs.production
    .prepare(
      "SELECT * FROM shelf_storage_reservations WHERE reservation_id='next'",
    )
    .get();
  assert.throws(
    () =>
      f.dbs.production
        .prepare(
          "INSERT OR REPLACE INTO shelf_storage_reservations VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(...Object.values(row)),
    /storage_reservation_conflict/,
  );
  assert.equal((await f.remote.inspect(identity())).reservedBytes, 4);
});

test("late GET response after verification timeout is canceled before any body consumption or later HEAD", async (t) => {
  const f = await fixture(t),
    o = await original();
  await f.remote.reserve(identity(), "one", o.descriptor, o.bytes, evidence());
  await f.remote.claimPut(identity(), "one");
  let resolveGet,
    cancels = 0,
    heads = 0;
  const adapter = {
    target: { accountId: ACCOUNT, bucket: "the-shelf-books" },
    async head() {
      heads++;
      return {
        size: 4,
        sha256: o.descriptor.sha256,
        etag: '"etag"',
        contentType: objectContentType(o.descriptor),
      };
    },
    async get() {
      return new Promise((r) => {
        resolveGet = r;
      });
    },
    async put() {
      assert.fail("no put");
    },
  };
  const remote = f.create({ verificationTimeoutMs: 10 });
  await assert.rejects(remote.reconcile(identity(), "one", adapter), {
    code: "object_verification_timeout",
  });
  resolveGet(
    new ReadableStream({
      cancel() {
        cancels++;
      },
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(cancels, 1);
  assert.equal(heads, 1);
  assert.equal((await f.remote.get(identity(), "one")).state, "uncertain");
});

test("HTTP200 invalid D1 result envelope after committed claim remains unknown", async (t) => {
  const f = await fixture(t),
    o = await original(),
    mock = store();
  let applied = 0;
  f.setFault(({ options, db }) => {
    if (options.body?.includes("SET state='uploading'")) {
      applied++;
      const { sql, params } = JSON.parse(options.body);
      db.prepare(sql).all(...params);
      return Response.json({ success: true, result: { invalid: true } });
    }
  });
  await assert.rejects(sync(f, o, mock), {
    code: "storage_remote_outcome_unknown",
  });
  assert.equal(applied, 1);
  assert.equal(mock.calls.includes("put"), false);
  assert.equal((await f.remote.get(identity(), "one")).state, "uncertain");
});

test("unknown initialization is observed on resume without replaying the INSERT", async (t) => {
  const f = await fixture(t, { ready: false, initialize: false });
  let inserts = 0;
  f.setFault(({ options, db }) => {
    if (options.body?.includes("INSERT INTO shelf_storage_authority")) {
      inserts++;
      const { sql, params } = JSON.parse(options.body);
      db.prepare(sql).all(...params);
      return new Response("unknown commit", { status: 503 });
    }
  });
  await assert.rejects(f.remote.initialize(identity()), {
    code: "storage_remote_outcome_unknown",
  });
  assert.equal(
    (await f.create().initialize(identity())).phase,
    "migration_required",
  );
  assert.equal(inserts, 1);
});

test("late identity GET response is canceled after the request deadline", async (t) => {
  const f = await fixture(t, { ready: false });
  let resolveGet,
    cancels = 0;
  const remote = f.create({
    requestTimeoutMs: 10,
    fetchImpl: () =>
      new Promise((r) => {
        resolveGet = r;
      }),
  });
  await assert.rejects(remote.inspect(identity()), {
    code: "storage_remote_deadline",
  });
  resolveGet(
    new Response(
      new ReadableStream({
        cancel() {
          cancels++;
        },
      }),
    ),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(cancels, 1);
});

test("projection is independently read back before a final full frozen-source verification", async (t) => {
  const o = await original("production", "file_projected"),
    f = await fixture(t, {
      ready: false,
      seed: (dbs, catalog) =>
        seedLegacy(dbs, catalog, o, "confirmed", "old-projected"),
    }),
    snapshots = await f.remote.readFrozenSnapshots(identity());
  let afterLive = false,
    projectionRead = false;
  f.setFault(({ options, scope }) => {
    const sql = options.body && JSON.parse(options.body).sql;
    if (sql?.startsWith("SELECT * FROM shelf_storage_staging"))
      afterLive = true;
    if (
      afterLive &&
      scope === "production" &&
      sql?.startsWith(
        "SELECT scope,file_id,book_id,format,size_bytes,object_key,sha256,etag,state,version FROM file_registry",
      )
    ) {
      projectionRead = true;
      return Response.json({
        success: true,
        result: [{ success: true, results: [] }],
      });
    }
  });
  await assert.rejects(f.remote.migrateFrozen(identity(), snapshots), {
    code: "migration_readback_failed",
  });
  assert.equal(projectionRead, true);
  assert.equal((await f.remote.inspect(identity())).phase, "imported");
});

test("activation requires closed connections and an evidenced enforced drain bound", async (t) => {
  const f = await fixture(t),
    valid = f.receipt.writeClosureProof;
  for (const patch of [
    { legacyConnectionsClosed: false },
    { connectionEvidenceSha256: undefined },
    { drainBound: undefined },
    { drainBound: { ...valid.drainBound, source: "assumed-default" } },
    { drainBound: { ...valid.drainBound, configurationSha256: "missing" } },
    { drainBound: { ...valid.drainBound, maxRequestLifetimeMs: 60001 } },
  ]) {
    const pending = await fixture(t, { ready: false }),
      snapshots = await pending.remote.readFrozenSnapshots(identity());
    await assert.rejects(
      pending
        .create({ verifyWriteClosure: async () => ({ ...valid, ...patch }) })
        .activateFrozen(identity(), snapshots),
      { code: "migration_write_closure_unproven" },
    );
    assert.equal((await pending.remote.inspect(identity())).phase, "imported");
  }
  const inspection = await f.remote.inspect(identity());
  assert.deepEqual(
    validateMigrationReceipt(f.receipt, identity(), inspection),
    f.receipt,
  );
  // Closing proof is historical and remains valid after import; new evidence gates each upload.
  assert.deepEqual(
    validateMigrationReceipt(
      f.receipt,
      identity(),
      inspection,
      Date.now() + 600000,
    ),
    f.receipt,
  );
  for (const patch of [
    { cloudWriteFreezeProven: false },
    { sourceProjectionVerified: false },
    { migrationHash: "0".repeat(64) },
    { freezeProofs: [f.receipt.freezeProofs[0], f.receipt.freezeProofs[0]] },
    { writeClosureProof: { ...valid, legacyConnectionsClosed: false } },
  ])
    assert.throws(() =>
      validateMigrationReceipt(
        { ...f.receipt, ...patch },
        identity(),
        inspection,
      ),
    );
});

test("freeze schema readback requires exact SQL and rejects whitespace drift", async (t) => {
  const f = await fixture(t, { ready: false }),
    snapshots = await f.remote.readFrozenSnapshots(identity()),
    db = f.dbs.check;
  const sql = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE name='shelf_legacy_marker_update'",
    )
    .get().sql;
  db.exec("DROP TRIGGER shelf_legacy_marker_update");
  db.exec(sql.replace(" BEGIN", "  BEGIN"));
  await assert.rejects(f.remote.migrateFrozen(identity(), snapshots), {
    code: "migration_freeze_unproven",
  });
});

test("transport and object-store StorageError payloads never leak through remote errors", async (t) => {
  const f = await fixture(t),
    secret = "injected-private-error-payload",
    o = await original();
  for (const method of ["GET", "POST"]) {
    const remote = f.create({
      fetchImpl: async (url, options) => {
        if (options.method === method) throw new StorageError(secret);
        return Response.json({
          success: true,
          result: { uuid: IDS.production, name: names.production },
        });
      },
    });
    await assert.rejects(remote.inspect(identity()), (e) => {
      assert.equal(
        e.code,
        method === "GET"
          ? "storage_remote_unavailable"
          : "storage_remote_outcome_unknown",
      );
      assert.equal(JSON.stringify(e).includes(secret), false);
      assert.equal(String(e).includes(secret), false);
      return true;
    });
  }
  await f.remote.reserve(identity(), "one", o.descriptor, o.bytes, evidence());
  await f.remote.claimPut(identity(), "one");
  await assert.rejects(
    f.remote.reconcile(identity(), "one", {
      target: { accountId: ACCOUNT, bucket: "the-shelf-books" },
      async head() {
        throw new StorageError(secret);
      },
      async get() {
        assert.fail("no GET");
      },
      async put() {
        assert.fail("no PUT");
      },
    }),
    (e) => {
      assert.equal(e.code, "object_verification_unknown");
      assert.equal(JSON.stringify(e).includes(secret), false);
      return true;
    },
  );
});
