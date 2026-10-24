import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";
import { storageDeploymentContract } from "../shared/storage-deployment-contract.mjs";
import {
  STORAGE_DEPLOY_GUARD_SQL,
  STORAGE_DEPLOY_GUARD_LIMITS,
  validateStorageDeployGuard,
  verifyStorageDeployGuard,
  readDeploymentControlJson,
} from "../scripts/storage-deploy-guard.mjs";
import {
  readRemoteSettings,
  verifyDatabaseIdentity,
} from "../scripts/cf-api-deploy.mjs";
const accountId = "a".repeat(32),
  targetSha256 = "b".repeat(64);
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
const contract = (preparedText) =>
  storageDeploymentContract({
    profile: "authority-v2-closed",
    identity,
    trialTargetSha256: targetSha256,
    filenameAi: true,
    preparedText,
    retainedSecrets: "trial-retained-filename-v1",
  });
const credentials = { accountId, token: "synthetic-token" },
  resource = {
    databaseId: identity.legacyDatabases.production,
    databaseName: "the-shelf-library",
  };
const descriptor = {
  kind: "original",
  scope: "production",
  fileId: "retained_trial",
  bookId: "retained_book",
  format: "PDF",
  sizeBytes: 15,
  sha256: "d".repeat(64),
  objectKey: `books/cf03/retained_trial/${"d".repeat(64)}.pdf`,
  versionHash: null,
  source: null,
};
function fixture(t, profile = "trial-010", { collision = false } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const type of ["table", "index", "view"])
    for (const row of DATABASE_SCHEMA_PROFILES[profile])
      if (row.type === type) db.exec(row.sql);
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,'imported')",
  ).run(JSON.stringify(identity));
  db.prepare(
    "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,?,?)",
  ).run(
    "retained_permit",
    "2026-10-23-first-book",
    JSON.stringify(identity),
    JSON.stringify({ accountId, bucket: "the-shelf-first-book-20261023" }),
    JSON.stringify(descriptor),
    targetSha256,
    15,
    1,
    3600000,
    "synthetic_etag",
    100,
  );
  if (collision) {
    db.exec(
      "INSERT INTO public_state(scope,updated_at) VALUES('production',0)",
    );
    db.exec(
      "INSERT INTO catalog_books VALUES('production','another_book','{}')",
    );
    db.prepare(
      "INSERT INTO file_registry VALUES('production',?,?,?,?,?,?,?,'confirmed',1,?)",
    ).run(
      descriptor.fileId,
      "another_book",
      "PDF",
      15,
      "books/another_key",
      descriptor.sha256,
      "other_etag",
      100,
    );
  }
  for (const row of DATABASE_SCHEMA_PROFILES[profile])
    if (row.type === "trigger") db.exec(row.sql);
  return db;
}
const row = (db) => db.prepare(STORAGE_DEPLOY_GUARD_SQL).get();
const envelope = (row) => ({
  success: true,
  result: [{ success: true, results: [row] }],
});
const error = (code) => (e) => e.code === `storage_deploy_${code}`;
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${resource.databaseId}/query`;

test("fixed guard is one bounded SELECT with zero parameters and no writes", () => {
  assert.ok(Buffer.byteLength(STORAGE_DEPLOY_GUARD_SQL) <= 16384);
  assert.equal(STORAGE_DEPLOY_GUARD_SQL.includes("?"), false);
  assert.match(STORAGE_DEPLOY_GUARD_SQL, /LIMIT 257/);
  assert.equal(
    /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b/.test(
      STORAGE_DEPLOY_GUARD_SQL,
    ),
    false,
  );
  assert.equal(STORAGE_DEPLOY_GUARD_LIMITS.parameters, 0);
  assert.equal(STORAGE_DEPLOY_GUARD_LIMITS.maxTotalHttp, 4);
});
for (const profile of Object.keys(DATABASE_SCHEMA_PROFILES)) {
  test(`real SQLite accepts complete ${profile} only with matching prepared requirement`, (t) => {
    const db = fixture(t, profile),
      projection = row(db);
    assert.ok(
      Buffer.byteLength(JSON.stringify(envelope(projection))) < 1048576,
    );
    assert.equal(
      validateStorageDeployGuard(projection, contract(false))
        .databaseSchemaProfile,
      profile,
    );
    if (profile.startsWith("trial-009"))
      assert.throws(() =>
        validateStorageDeployGuard(projection, contract(true)),
      );
    else
      assert.equal(
        validateStorageDeployGuard(projection, contract(true))
          .databaseSchemaProfile,
        profile,
      );
  });
}
test("one fixed POST validates retained historical expired permit without secret or R2", async (t) => {
  const db = fixture(t);
  let calls = 0;
  const result = await verifyStorageDeployGuard(
    credentials,
    resource,
    contract(true),
    {
      fetcher: async (actual, init) => {
        calls++;
        assert.equal(actual, url);
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(init.body), {
          sql: STORAGE_DEPLOY_GUARD_SQL,
          params: [],
        });
        assert.equal(init.redirect, "error");
        return Response.json(envelope(row(db)));
      },
    },
  );
  assert.equal(calls, 1);
  assert.match(result.retainedSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, "descriptor"), false);
});
test("raw ordinary confirmed collision rejects even with different book and object", (t) => {
  assert.throws(
    () =>
      validateStorageDeployGuard(
        row(fixture(t, "trial-010", { collision: true })),
        contract(false),
      ),
    error("guard"),
  );
});
for (const [label, mutate] of [
  ["missing", (r) => (r.schema_json = "[]")],
  [
    "missing schema definition",
    (r) => {
      const v = JSON.parse(r.schema_json);
      v.pop();
      r.schema_json = JSON.stringify(v);
    },
  ],
  [
    "internal SQL whitespace drift",
    (r) => {
      const v = JSON.parse(r.schema_json);
      v[0].sql += " ";
      v[0].sql = v[0].sql.replace("CREATE", "CREATE ");
      r.schema_json = JSON.stringify(v);
    },
  ],
  [
    "unknown object",
    (r) => {
      const v = JSON.parse(r.schema_json);
      v.push({
        type: "table",
        name: "_cf_unknown",
        tbl_name: "_cf_unknown",
        sql: "CREATE TABLE _cf_unknown(x)",
      });
      r.schema_json = JSON.stringify(v);
    },
  ],
  [
    "duplicate authority",
    (r) => {
      const a = JSON.parse(r.authority_json);
      a.push(a[0]);
      r.authority_json = JSON.stringify(a);
    },
  ],
  [
    "foreign authority database",
    (r) => {
      const a = JSON.parse(r.authority_json);
      const i = JSON.parse(a[0].identity_json);
      i.legacyDatabases.check = i.legacyDatabases.production;
      a[0].identity_json = JSON.stringify(i);
      r.authority_json = JSON.stringify(a);
    },
  ],
  [
    "authority phase",
    (r) =>
      (r.authority_json = r.authority_json.replace(
        "imported",
        "migration_required",
      )),
  ],
  ["missing retained source", (r) => (r.trial_json = "[]")],
  [
    "duplicate retained source",
    (r) => {
      const a = JSON.parse(r.trial_json);
      a.push(a[0]);
      r.trial_json = JSON.stringify(a);
    },
  ],
  [
    "unused permit",
    (r) => {
      const a = JSON.parse(r.trial_json);
      a[0].put_attempted = 0;
      r.trial_json = JSON.stringify(a);
    },
  ],
  [
    "target SHA",
    (r) => {
      const a = JSON.parse(r.trial_json);
      a[0].isolated_target_config_sha256 = "c".repeat(64);
      r.trial_json = JSON.stringify(a);
    },
  ],
  [
    "descriptor bound",
    (r) => {
      const a = JSON.parse(r.trial_json);
      a[0].descriptor_json = " ".repeat(4097);
      r.trial_json = JSON.stringify(a);
    },
  ],
  ["coerced count", (r) => (r.normal_collision_count = "0")],
  ["overflow", (r) => (r.overflow = 1)],
  ["extra field", (r) => (r.extra = 1)],
])
  test(`guard rejects ${label}`, (t) => {
    const v = { ...row(fixture(t)) };
    mutate(v);
    assert.throws(() => validateStorageDeployGuard(v, contract(false)));
  });
test("SQL bounds large retained text before emitting or extracting it", (t) => {
  const db = fixture(t);
  db.exec("DROP TRIGGER shelf_single_trial_transition");
  db.prepare("UPDATE shelf_storage_single_trial SET descriptor_json=?").run(
    JSON.stringify({ text: "x".repeat(4097) }),
  );
  const v = row(db);
  assert.equal(v.overflow, 1);
  assert.equal(v.trial_json, null);
  assert.equal(v.normal_collision_count, null);
  assert.throws(() => validateStorageDeployGuard(v, contract(false)));
});

for (const status of [200, 404]) {
  test(`HTTP ${status} response bytes and empty chunk flood are bounded`, async () => {
    for (const make of [
      () =>
        new Response(new Uint8Array(1048577), {
          status,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array());
            },
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
      () =>
        new Response("", {
          status,
          headers: {
            "content-type": "application/json",
            "content-length": "1048577",
          },
        }),
    ]) {
      let calls = 0;
      await assert.rejects(
        readDeploymentControlJson({
          url,
          allowNotFound: true,
          fetcher: async () => {
            calls++;
            return make();
          },
        }),
        error("response_limit"),
      );
      assert.equal(calls, 1);
    }
  });
  test(`HTTP ${status} stalled body and never-settling cancellation cannot hold deadline`, async () => {
    let cancels = 0;
    await assert.rejects(
      readDeploymentControlJson({
        url,
        allowNotFound: true,
        timeoutMs: 10,
        fetcher: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancels++;
                return new Promise(() => {});
              },
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
      }),
      error("deadline"),
    );
    assert.ok(cancels >= 1);
  });
}
test("404 empty and malformed bodies return missing after bounded drain", async () => {
  for (const body of [null, "", "not-json"])
    assert.equal(
      await readDeploymentControlJson({
        url,
        allowNotFound: true,
        fetcher: async () => new Response(body, { status: 404 }),
      }),
      null,
    );
});
test("ignored fetch abort and late response body are bounded and cancelled", async () => {
  let deliver,
    calls = 0,
    cancelled = 0;
  const pending = readDeploymentControlJson({
    url,
    timeoutMs: 10,
    fetcher: () => {
      calls++;
      return new Promise((resolve) => {
        deliver = resolve;
      });
    },
  });
  await assert.rejects(pending, error("deadline"));
  deliver(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.ok(cancelled >= 1);
});
test("never-settling fetch, body error, redirect, malformed envelopes and null JSON fail once", async () => {
  for (const fetcher of [
    () => new Promise(() => {}),
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("synthetic"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    async () => ({
      status: 200,
      redirected: true,
      body: {
        cancel() {
          return new Promise(() => {});
        },
      },
    }),
    async () =>
      new Response("not-json", {
        headers: { "content-type": "application/json" },
      }),
    async () => Response.json(null),
  ])
    await assert.rejects(
      readDeploymentControlJson({ url, fetcher, timeoutMs: 10 }),
    );
});
test("settings and identity public adapters share bounded fetch/body handling", async () => {
  for (const status of [200, 404]) {
    await assert.rejects(
      readRemoteSettings(
        credentials,
        "the-shelf",
        async () =>
          new Response(new ReadableStream(), {
            status,
            headers: { "content-type": "application/json" },
          }),
        { timeoutMs: 10 },
      ),
      (e) => e.code === "remote",
    );
  }
  await assert.rejects(
    verifyDatabaseIdentity(credentials, resource, {
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 10,
    }),
    (e) => e.code === "database_identity",
  );
});
