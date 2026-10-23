import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RemoteStorageAuthority,
  SINGLE_TRIAL_BUCKET,
  singleTrialPermit,
  singleTrialSchemaDefinitions,
} from "../server/remote-storage-authority.mjs";
import {
  prepareObject,
  bytesSha256,
  objectContentType,
} from "../server/storage-authority.mjs";
const accountId = "a".repeat(32),
  databaseId = "22222222-2222-4222-8222-222222222222";
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: databaseId,
  },
};
const obj = async () =>
  prepareObject({
    kind: "original",
    scope: "production",
    fileId: "trial_file",
    bookId: "trial_book",
    format: "PDF",
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
async function fixture(t, { extension = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-single-trial-")),
    file = path.join(dir, "db.sqlite");
  const db = new DatabaseSync(file),
    db2 = new DatabaseSync(file);
  let now = Date.now(),
    fault = null;
  for (const d of [db, db2])
    d.function("unixepoch", { varargs: true }, () => now / 1000);
  t.after(async () => {
    db.close();
    db2.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const name of [
    "schema.sql",
    "migrations/003-storage-authority.sql",
    "migrations/004-freeze-legacy-storage.sql",
    ...(extension ? ["migrations/005-single-trial.sql"] : []),
  ])
    db.exec(
      await fs.readFile(
        new URL("../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    );
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,'migration_required')",
  ).run(JSON.stringify(identity));
  const old = (
    await prepareObject({
      kind: "original",
      scope: "production",
      fileId: "old_unknown",
      bookId: "old_book",
      format: "PDF",
      bytes: new Uint8Array(7),
    })
  ).descriptor;
  db.prepare(
    "INSERT INTO shelf_storage_staging VALUES(?,?,?,?,?,'uncertain',NULL,NULL,?)",
  ).run(
    "old_unknown",
    "original:production:old_unknown:original",
    old.objectKey,
    JSON.stringify(old),
    7,
    now - 1000,
  );
  for (const scope of ["check", "production"])
    db.prepare(
      "INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      scope,
      "f".repeat(64),
      "e".repeat(64),
      "{}",
      "{}",
      scope === "production" ? 1 : 0,
      0,
      0,
      scope === "production" ? 7 : 0,
    );
  db.prepare(
    "UPDATE shelf_storage_authority SET phase='imported',migration_hash=? WHERE id=1",
  ).run("f".repeat(64));
  const calls = [];
  const create = (connection = db, extra = {}) =>
    new RemoteStorageAuthority({
      identity,
      credentials: { accountId, token: "synthetic" },
      resource: { databaseId, databaseName: "the-shelf-library" },
      clock: () => now,
      ...extra,
      requestLimit: 256,
      beforeRequest: async () => {},
      fetchImpl: async (url, options) => {
        if (!url.endsWith("/query"))
          return Response.json({
            success: true,
            result: { uuid: databaseId, name: "the-shelf-library" },
          });
        const { sql, params } = JSON.parse(options.body);
        calls.push(sql);
        const results = connection.prepare(sql).all(...params);
        if (fault && fault(sql)) throw new Error("synthetic lost response");
        return Response.json({
          success: true,
          result: [{ success: true, results }],
        });
      },
    });
  const o = await obj();
  const permit = () => ({
    schemaVersion: 1,
    permitId: "first-book",
    consentId: "2026-10-23-first-book",
    target: { accountId, bucket: SINGLE_TRIAL_BUCKET },
    descriptor: o.descriptor,
    isolatedTargetConfigSha256: bytesSha256("reviewed isolated config"),
    issuedAt: now,
    expiresAt: now + 60000,
  });
  const remote = create(),
    history = () =>
      JSON.stringify(
        db.prepare("SELECT * FROM shelf_storage_reservations").all(),
      );
  return {
    db,
    db2,
    create,
    remote,
    permit,
    calls,
    history,
    advance: (ms) => {
      now += ms;
    },
    fault: (fn) => {
      fault = fn;
    },
  };
}
async function store() {
  const { descriptor, bytes } = await obj(),
    calls = [];
  const result = {
    target: { accountId, bucket: SINGLE_TRIAL_BUCKET },
    async head() {
      calls.push("head");
      return {
        size: bytes.length,
        sha256: descriptor.sha256,
        etag: '"trial-etag"',
        contentType: objectContentType(descriptor),
      };
    },
    async get() {
      calls.push("get");
      return new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      });
    },
    async put() {
      assert.fail("read-only recovery must never PUT");
    },
  };
  Object.defineProperty(result, "calls", { value: calls });
  return result;
}
test("trial adds reservation to same authority and confirmed registry preserves imported unknown history", async (t) => {
  const f = await fixture(t),
    before = f.history(),
    p = f.permit(),
    o = await obj();
  assert.equal(singleTrialSchemaDefinitions.length, 7);
  await f.remote.issueSingleTrial(identity, p);
  assert.deepEqual(await f.remote.inspect(identity), {
    phase: "imported",
    committedBytes: 0,
    reservedBytes: 11,
    observedBytes: null,
    migrationHash: "f".repeat(64),
  });
  await assert.rejects(
    f.remote.reserve(identity, "normal", o.descriptor, o.bytes, {}),
    { code: "storage_migration_required" },
  );
  await assert.rejects(
    f.remote.claimSingleTrialPut(
      identity,
      p.permitId,
      o.descriptor,
      new Uint8Array([9]),
    ),
    { code: "storage_bytes_invalid" },
  );
  assert.equal((await f.remote.inspectSingleTrial(identity)).state, "reserved");
  await f.remote.claimSingleTrialPut(
    identity,
    p.permitId,
    o.descriptor,
    o.bytes,
  );
  const s = await store();
  f.advance(100000);
  const r = await f.remote.reconcileSingleTrial(identity, p.permitId, s);
  assert.equal(r.state, "confirmed");
  assert.deepEqual(s.calls, ["head", "get", "head"]);
  assert.equal((await f.remote.inspect(identity)).committedBytes, 4);
  assert.equal((await f.remote.inspect(identity)).reservedBytes, 7);
  assert.equal(f.history(), before);
  assert.equal(f.db.prepare("SELECT count(*) n FROM file_registry").get().n, 0);
  assert.throws(() =>
    f.db.exec("UPDATE shelf_storage_authority SET phase='ready'"),
  );
  await assert.rejects(f.remote.issueSingleTrial(identity, p));
  assert.throws(() => f.db.exec("DELETE FROM shelf_storage_single_trial"));
  assert.throws(() =>
    f.db.exec("UPDATE shelf_storage_single_trial SET expires_at=expires_at+1"),
  );
  assert.throws(() =>
    f.db.exec(
      "INSERT OR REPLACE INTO shelf_storage_single_trial SELECT * FROM shelf_storage_single_trial",
    ),
  );
});
test("two independent database connections allow only one singleton issue and one claim", async (t) => {
  const f = await fixture(t),
    second = f.create(f.db2),
    p = f.permit(),
    o = await obj();
  const issued = await Promise.allSettled([
    f.remote.issueSingleTrial(identity, p),
    second.issueSingleTrial(identity, p),
  ]);
  assert.equal(issued.filter((r) => r.status === "fulfilled").length, 1);
  const claims = await Promise.allSettled([
    f.remote.claimSingleTrialPut(identity, p.permitId, o.descriptor, o.bytes),
    second.claimSingleTrialPut(identity, p.permitId, o.descriptor, o.bytes),
  ]);
  assert.equal(claims.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.remote.inspect(identity)).reservedBytes, 11);
});
test("lost issuance/claim responses and process restart never issue a second dispatch grant", async (t) => {
  const f = await fixture(t),
    p = f.permit(),
    o = await obj();
  f.fault((sql) => sql.startsWith("INSERT INTO shelf_storage_single_trial"));
  await assert.rejects(f.remote.issueSingleTrial(identity, p), {
    code: "storage_remote_outcome_unknown",
  });
  f.fault(null);
  const fresh = f.create(f.db2);
  assert.equal((await fresh.inspectSingleTrial(identity)).state, "reserved");
  f.fault((sql) => sql.includes("SET state='uploading'"));
  await assert.rejects(
    fresh.claimSingleTrialPut(identity, p.permitId, o.descriptor, o.bytes),
    { code: "storage_remote_outcome_unknown" },
  );
  f.fault(null);
  const restarted = f.create();
  assert.equal(
    (await restarted.inspectSingleTrial(identity)).state,
    "uploading",
  );
  await assert.rejects(
    restarted.claimSingleTrialPut(identity, p.permitId, o.descriptor, o.bytes),
    { code: "single_trial_put_already_claimed" },
  );
  const absent = {
    ...(await store()),
    async head() {
      return null;
    },
  };
  const unknown = await restarted.reconcileSingleTrial(
    identity,
    p.permitId,
    absent,
  );
  assert.equal(unknown.state, "uncertain");
  assert.equal(unknown.blockedReason, "object_absence_unresolved");
  assert.equal((await restarted.inspect(identity)).reservedBytes, 11);
});
test("lost PUT or confirmation response only reconciles fixed object, and retains budget on corruption", async (t) => {
  const f = await fixture(t),
    p = f.permit(),
    o = await obj();
  await f.remote.issueSingleTrial(identity, p);
  await f.remote.claimSingleTrialPut(
    identity,
    p.permitId,
    o.descriptor,
    o.bytes,
  );
  // Simulates a PUT that reached storage but whose caller died before marking result.
  f.fault((sql) => sql.includes("SET state='confirmed'"));
  await assert.rejects(
    f.remote.reconcileSingleTrial(identity, p.permitId, await store()),
  );
  f.fault(null);
  const recovered = await f
    .create(f.db2)
    .reconcileSingleTrial(identity, p.permitId, await store());
  assert.equal(recovered.state, "confirmed");
  assert.equal((await f.remote.inspect(identity)).reservedBytes, 7);
});
test("expiry burns reserved grant permanently and identity/config/descriptor SQL mutations fail closed", async (t) => {
  const f = await fixture(t),
    p = f.permit(),
    o = await obj();
  for (const mutate of [
    (v) => (v.target.bucket = "the-shelf-books"),
    (v) => (v.target.accountId = "b".repeat(32)),
    (v) => (v.descriptor.objectKey += "bad"),
    (v) => (v.expiresAt = v.issuedAt + 86400001),
    (v) => (v.descriptor.kind = "prepared-text"),
  ]) {
    const bad = structuredClone(p);
    mutate(bad);
    assert.throws(() => singleTrialPermit(bad, identity));
  }
  await f.remote.issueSingleTrial(identity, p);
  f.advance(60001);
  await assert.rejects(
    f.remote.claimSingleTrialPut(identity, p.permitId, o.descriptor, o.bytes),
    { code: "single_trial_put_already_claimed" },
  );
  assert.equal((await f.remote.inspectSingleTrial(identity)).state, "reserved");
  assert.equal((await f.remote.inspect(identity)).reservedBytes, 11);
  await assert.rejects(
    f.remote.reconcileSingleTrial(identity, p.permitId, await store()),
    { code: "single_trial_put_not_claimed" },
  );
});
test("pre-SQL005 authority clients still inspect old ledger; partial schema is rejected", async (t) => {
  const f = await fixture(t, { extension: false });
  assert.equal((await f.remote.inspect(identity)).reservedBytes, 7);
  await assert.rejects(f.remote.inspectSingleTrial(identity), {
    code: "single_trial_schema_required",
  });
  f.db.exec(
    singleTrialSchemaDefinitions.find(
      (d) => d.name === "shelf_storage_single_trial",
    ).sql,
  );
  await assert.rejects(
    f.create(f.db, { singleTrial: true }).inspect(identity),
    { code: "single_trial_schema_invalid" },
  );
});
test("raw SQL rejects malformed bindings, NULL/id bypass and grants no replacement after expiry", async (t) => {
  const f = await fixture(t),
    p = f.permit();
  const insert = (permit = p, extra = {}) => {
    const row = {
      id: 1,
      permitId: permit.permitId,
      consentId: permit.consentId,
      authority: JSON.stringify(identity),
      target: JSON.stringify(permit.target),
      descriptor: JSON.stringify(permit.descriptor),
      config: permit.isolatedTargetConfigSha256,
      size: permit.descriptor.sizeBytes,
      issued: permit.issuedAt,
      expires: permit.expiresAt,
      state: "reserved",
      attempted: 0,
      verified: 0,
      etag: null,
      updated: permit.issuedAt,
      ...extra,
    };
    f.db
      .prepare(
        "INSERT INTO shelf_storage_single_trial VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(...Object.values(row));
  };
  for (const mutate of [
    (v) => (v.target.accountId = "b".repeat(32)),
    (v) => (v.target.bucket = "the-shelf-books"),
    (v) => (v.descriptor.sha256 = null),
    (v) => (v.descriptor.sha256 = "z".repeat(64)),
    (v) => (v.descriptor.objectKey = null),
    (v) => (v.descriptor.fileId = "../outside"),
    (v) => (v.descriptor.bookId = null),
    (v) => (v.descriptor.format = null),
    (v) => (v.descriptor.extra = "x"),
    (v) => delete v.descriptor.source,
  ]) {
    const bad = structuredClone(p);
    mutate(bad);
    assert.throws(() => insert(bad));
  }
  for (const extra of [
    { id: 2 },
    { size: 1 },
    { state: "confirmed", attempted: 1, verified: 1, etag: "fake" },
    { attempted: 0.5 },
    { verified: null },
    { issued: null },
  ])
    assert.throws(() => insert(p, extra));
  assert.equal((await f.remote.inspect(identity)).reservedBytes, 7);
  insert();
  assert.throws(() => insert(p, { id: null }));
  for (const [column, value] of [
    ["target_json", null],
    ["descriptor_json", null],
    ["id", null],
    ["put_attempted", null],
    ["size_bytes", null],
  ])
    assert.throws(() =>
      f.db
        .prepare(`UPDATE shelf_storage_single_trial SET ${column}=?`)
        .run(value),
    );
  f.advance(60001);
  assert.throws(() =>
    f.db.exec(
      "INSERT OR REPLACE INTO shelf_storage_single_trial SELECT * FROM shelf_storage_single_trial",
    ),
  );
  assert.equal((await f.remote.inspectSingleTrial(identity)).state, "reserved");
});
test("corrupt fixed object and wrong store cannot confirm or free any reservation", async (t) => {
  const f = await fixture(t),
    p = f.permit(),
    o = await obj();
  await f.remote.issueSingleTrial(identity, p);
  await f.remote.claimSingleTrialPut(
    identity,
    p.permitId,
    o.descriptor,
    o.bytes,
  );
  const wrong = await store();
  wrong.target.bucket = "the-shelf-books";
  await assert.rejects(
    f.remote.reconcileSingleTrial(identity, p.permitId, wrong),
    { code: "object_target_mismatch" },
  );
  const corrupt = await store();
  corrupt.get = async () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([9, 9, 9, 9]));
        c.close();
      },
    });
  await assert.rejects(
    f.remote.reconcileSingleTrial(identity, p.permitId, corrupt),
    { code: "object_hash_mismatch" },
  );
  assert.equal(
    (await f.remote.inspectSingleTrial(identity)).state,
    "uncertain",
  );
  assert.equal((await f.remote.inspect(identity)).reservedBytes, 11);
});
test("SQL006 keeps private session checks and admits only exact confirmed catalog singleton", async (t) => {
  const f = await fixture(t),
    p = f.permit(),
    o = await obj(),
    hash = "a".repeat(64),
    time = p.issuedAt;
  f.db.exec(
    await fs.readFile(
      new URL(
        "../cloudflare/library/migrations/006-single-trial-admission.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  f.db
    .prepare(
      "INSERT INTO auth_config VALUES('production','https://shelf.invalid','owner-access-key-v1',?,1,1,?)",
    )
    .run(hash, time);
  f.db
    .prepare("INSERT INTO sessions VALUES('production',?,1,?,?,0)")
    .run(hash, time, time + 3600000);
  const catalog = {
    id: p.descriptor.bookId,
    files: [
      {
        id: p.descriptor.fileId,
        format: "PDF",
        sizeBytes: 4,
        status: "candidate",
      },
    ],
  };
  f.db
    .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
    .run(p.descriptor.bookId, JSON.stringify(catalog));
  let n = 0;
  const access = (
    session = hash,
    fileId = p.descriptor.fileId,
    scope = "production",
  ) =>
    f.db
      .prepare("INSERT INTO admissions VALUES(?,?,'access',?,?,?,1,?)")
      .run(scope, "request" + ++n, hash, time, session, fileId);
  await f.remote.issueSingleTrial(identity, p);
  assert.throws(() => access(), /library_file_unavailable/);
  await f.remote.claimSingleTrialPut(
    identity,
    p.permitId,
    o.descriptor,
    o.bytes,
  );
  assert.throws(() => access(), /library_file_unavailable/);
  await f.remote.reconcileSingleTrial(identity, p.permitId, await store());
  access();
  assert.throws(() => access("b".repeat(64)), /library_session_invalid/);
  assert.throws(() => access(hash, "other-file"), /library_file_unavailable/);
  catalog.files[0].sizeBytes = 5;
  f.db
    .prepare("UPDATE catalog_books SET public_json=? WHERE scope='production'")
    .run(JSON.stringify(catalog));
  assert.throws(() => access(), /library_file_unavailable/);
  catalog.files[0].sizeBytes = 4;
  f.db
    .prepare("UPDATE catalog_books SET public_json=? WHERE scope='production'")
    .run(JSON.stringify(catalog));
  f.db.exec("UPDATE sessions SET revoked=1");
  assert.throws(() => access(), /library_session_invalid/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM admissions").get().n, 1);
});
