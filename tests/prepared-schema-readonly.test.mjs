import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  DATABASE_SCHEMA_PROFILES,
  STORAGE_DATABASE_SCHEMA_SQL,
} from "../shared/storage-schema-profiles.mjs";
import {
  runPreparedIndex,
  preparedBudgets,
  preparedSchemaBudgets,
  PREPARED_SCHEMA_DEFINITIONS,
  PREPARED_SCHEMA_SHA256,
} from "../scripts/prepared-index.mjs";
import {
  READONLY_ACTIVATION_TABLES,
  READONLY_LEGACY_SNAPSHOT_GROUPS,
  READONLY_TABLE_COLUMNS,
  readonlySnapshotSql,
} from "../scripts/schema-readonly.mjs";
const DBID = "11111111-1111-4111-8111-111111111111";
const PREPARED_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,15)='shelf_prepared_' ORDER BY type,name LIMIT 14";
const envelope = (results) => ({
  success: true,
  result: [{ success: true, results }],
});
// Independent synthetic API fixture. It cannot load local sources, R2 or real credentials.
async function operator(t, profile = "activation-011") {
  const root = await fs.mkdtemp(path.join(tmpdir(), "shelf-schema-readonly-"));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const rows = DATABASE_SCHEMA_PROFILES[profile];
  for (const type of ["table", "index", "view"])
    for (const row of rows) if (row.type === type) db.exec(row.sql);
  const identity = {
    schemaVersion: 1,
    authorityId: "shelf-remote-storage-v1",
    accountId: "a".repeat(32),
    bucket: "the-shelf-books",
    legacyDatabases: {
      check: "22222222-2222-4222-8222-222222222222",
      production: DBID,
    },
  };
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase,migration_hash,readback_hash,receipt_json,reserved_bytes) VALUES(1,?,'imported',?,?,?,3)",
  ).run(
    JSON.stringify(identity),
    "b".repeat(64),
    "c".repeat(64),
    '{"synthetic":"imported"}',
  );
  if (profile.startsWith("activation-")) {
    db.prepare(
      "INSERT INTO shelf_storage_activation_v2(id,identity_json,migration_hash,imported_receipt_json,imported_readback_hash,state,generation) VALUES(1,?,?,?,?,'closed',0)",
    ).run(
      JSON.stringify(identity),
      "b".repeat(64),
      '{"synthetic":"imported"}',
      "c".repeat(64),
    );
    for (const n of [2, 1]) {
      db.prepare(
        "INSERT INTO shelf_storage_activation_receipts_v2 VALUES(?,?,?)",
      ).run(
        String(n).repeat(64),
        JSON.stringify({ receipt: n }),
        JSON.stringify({ snapshot: n }),
      );
      db.prepare("INSERT INTO shelf_storage_evidence_v2 VALUES(?,?)").run(
        String(n).repeat(64),
        JSON.stringify({ evidence: n }),
      );
      db.prepare(
        "INSERT INTO shelf_storage_legacy_liabilities_v2 VALUES(?,?,?,?,?,?)",
      ).run(
        `source-${n}`,
        String(n).repeat(64),
        String(n + 2).repeat(64),
        n,
        n + 3,
        n + 5,
      );
    }
  }
  for (const row of rows) if (row.type === "trigger") db.exec(row.sql);
  const context = {
    root,
    identity,
    credentials: { accountId: identity.accountId, token: "synthetic-token" },
    resources: {
      profiles: {
        production: { databaseId: DBID, databaseName: "the-shelf-library" },
      },
    },
  };
  const requests = [],
    snapshots = [],
    hooks = { before: null, result: null, response: null };
  const base = `https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/d1/database/${DBID}`;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "manual");
    assert.ok(url === base || url === `${base}/query`);
    assert.ok(["GET", "POST"].includes(options.method));
    const sql = options.body ? JSON.parse(options.body).sql : null;
    requests.push({ url, method: options.method, sql });
    if (options.method === "GET")
      return Response.json({
        success: true,
        result: { uuid: DBID, name: "the-shelf-library" },
      });
    if (hooks.before) hooks.before(sql);
    let results;
    if (sql.startsWith("CREATE ")) {
      db.exec(sql);
      results = [];
    } else {
      assert.match(sql, /^SELECT /);
      results = db.prepare(sql).all();
    }
    if (hooks.result) results = hooks.result(sql, results);
    if (sql.startsWith("SELECT json_object")) snapshots.push({ sql, results });
    return hooks.response?.(sql, results) ?? Response.json(envelope(results));
  };
  const run = (action = "schema-status", overrides = {}) =>
    runPreparedIndex({
      root,
      action,
      execute: true,
      fetchImpl,
      testing: {
        loadContext: async () => context,
        loadLocal: async () => {
          throw Error("schema must not read local sources");
        },
      },
      ...overrides,
    });
  const receipts = async (prefix) => {
    const directory = path.join(
      root,
      ".local",
      "prepared-index",
      "schema",
      PREPARED_SCHEMA_SHA256,
    );
    const names = (await fs.readdir(directory)).filter((name) =>
      name.startsWith(prefix),
    );
    return Promise.all(
      names.map(async (name) => ({
        name,
        value: JSON.parse(
          await fs.readFile(path.join(directory, name), "utf8"),
        ),
      })),
    );
  };
  return { root, db, rows, context, requests, snapshots, hooks, run, receipts };
}
for (const profile of Object.keys(DATABASE_SCHEMA_PROFILES)) {
  test(`actual schema-status ${profile} has exact readonly request count and complete profile`, async (t) => {
    const f = await operator(t, profile),
      v2 = profile.startsWith("activation-");
    const result = await f.run();
    assert.equal(result.databaseProfile, profile);
    assert.equal(result.schemaCompatibility, "complete-profile");
    assert.equal(result.storageLayout, v2 ? "activation-v2" : "trial-v1");
    assert.equal(
      result.status,
      profile.startsWith("trial-009") ? "incomplete" : "installed",
    );
    assert.deepEqual(result.counts, { d1: v2 ? 11 : 10, r2: 0, ddl: 0 });
    assert.equal(result.puts, 0);
    assert.equal(f.requests.length, v2 ? 11 : 10);
    assert.equal(f.requests[1].sql, PREPARED_SQL);
    assert.equal(f.requests[2].sql, STORAGE_DATABASE_SCHEMA_SQL);
    assert.ok(
      f.requests.every(
        (request) => request.sql === null || request.sql.startsWith("SELECT "),
      ),
    );
    assert.deepEqual(
      f.snapshots.map(({ sql }) => sql),
      [
        ...READONLY_LEGACY_SNAPSHOT_GROUPS,
        ...(v2 ? [READONLY_ACTIVATION_TABLES] : []),
      ].map(readonlySnapshotSql),
    );
    assert.ok(f.snapshots.every(({ sql }) => !/\bLIMIT\b/i.test(sql)));
    const [{ value: receipt }] = await f.receipts("status-");
    assert.equal(receipt.fingerprints.length, v2 ? 8 : 7);
    assert.equal(receipt.snapshotGroups, v2 ? 8 : 7);
    assert.match(receipt.oldSchemaSha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.wholeSchemaSha256, /^[a-f0-9]{64}$/);
  });
}
for (const profile of ["activation-011", "activation-011-cf-metadata-v1"]) {
  test(`actual schema-apply ${profile} performs eleven reads and zero DDL intents`, async (t) => {
    const f = await operator(t, profile);
    await assert.rejects(f.run("schema-apply"), {
      code: "prepared_schema_apply_v2_disabled",
    });
    assert.equal(f.requests.length, 11);
    assert.ok(
      f.requests.every(
        (request) => !request.sql || request.sql.startsWith("SELECT "),
      ),
    );
    assert.deepEqual(await f.receipts("write-ddl-"), []);
    const [{ value: before }] = await f.receipts("schema-before-");
    const [{ value: disabled }] = await f.receipts("schema-apply-disabled-");
    assert.equal(before.fingerprints.length, 8);
    assert.equal(before.databaseProfile, profile);
    assert.deepEqual(disabled.counts, { d1: 11, r2: 0, ddl: 0 });
    assert.equal(disabled.puts, 0);
    assert.equal(disabled.code, "prepared_schema_apply_v2_disabled");
    assert.equal(
      (await f.receipts("read-")).filter(({ name }) =>
        name.endsWith("-intent.json"),
      ).length,
      11,
    );
  });
}
test("all four activation tables participate in the eighth complete snapshot fingerprint", async (t) => {
  const f = await operator(t);
  let previous;
  const status = async () => {
    const existing = new Set(
      (await f.receipts("status-")).map(({ name }) => name),
    );
    await f.run();
    return (await f.receipts("status-")).find(({ name }) => !existing.has(name))
      .value;
  };
  // Receipt directory first exists after the first actual status.
  await f.run();
  previous = (await f.receipts("status-"))[0].value;
  const activation = JSON.parse(f.snapshots.at(-1).results[0].snapshot);
  assert.deepEqual(Object.keys(activation), READONLY_ACTIVATION_TABLES);
  assert.deepEqual(
    Object.values(activation).map((rows) => rows.length),
    [1, 2, 2, 2],
  );
  for (const [table, sql] of [
    [
      "shelf_storage_activation_v2",
      "UPDATE shelf_storage_activation_v2 SET imported_readback_hash='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'",
    ],
    [
      "shelf_storage_activation_receipts_v2",
      "UPDATE shelf_storage_activation_receipts_v2 SET receipt_json='{\"changed\":true}' WHERE receipt_hash='1111111111111111111111111111111111111111111111111111111111111111'",
    ],
    [
      "shelf_storage_evidence_v2",
      "UPDATE shelf_storage_evidence_v2 SET evidence_json='{\"changed\":true}' WHERE evidence_hash='1111111111111111111111111111111111111111111111111111111111111111'",
    ],
    [
      "shelf_storage_legacy_liabilities_v2",
      "UPDATE shelf_storage_legacy_liabilities_v2 SET class_b_max=99 WHERE source_id='source-1'",
    ],
  ]) {
    const triggers = f.rows.filter(
      (row) => row.type === "trigger" && row.tbl_name === table,
    );
    for (const row of triggers) f.db.exec(`DROP TRIGGER ${row.name}`);
    f.db.exec(sql);
    for (const row of triggers) f.db.exec(row.sql);
    const current = await status();
    assert.deepEqual(
      current.fingerprints.slice(0, 7),
      previous.fingerprints.slice(0, 7),
    );
    assert.notEqual(current.fingerprints[7], previous.fingerprints[7], table);
    assert.equal(current.databaseProfile, previous.databaseProfile);
    previous = current;
  }
});
for (const variant of [
  "partial011",
  "missing010",
  "unknownDDL",
  "alteredPlatform",
  "betweenQueries",
  "duplicatePrepared",
  "overflow257",
]) {
  test(`schema rejection ${variant} has no fallback, snapshots or writes`, async (t) => {
    const f = await operator(
      t,
      variant === "alteredPlatform"
        ? "activation-011-cf-metadata-v1"
        : "activation-011",
    );
    if (variant === "partial011")
      f.db.exec("DROP TRIGGER shelf_storage_v2_phase_gate");
    if (variant === "missing010")
      f.db.exec("DROP TRIGGER shelf_prepared_chunk_insert");
    if (variant === "unknownDDL")
      f.db.exec("CREATE TABLE unknown_extra(a TEXT)");
    if (variant === "betweenQueries")
      f.hooks.before = (sql) => {
        if (sql === STORAGE_DATABASE_SCHEMA_SQL)
          f.db.exec("DROP TRIGGER shelf_prepared_chunk_insert");
      };
    f.hooks.result = (sql, results) => {
      if (variant === "duplicatePrepared" && sql === PREPARED_SQL)
        return [...results.slice(0, -1), results[0]];
      if (variant === "alteredPlatform" && sql === STORAGE_DATABASE_SCHEMA_SQL)
        return results.map((row) =>
          row.name === "_cf_METADATA"
            ? { ...row, sql: row.sql.replace("BLOB", "TEXT") }
            : row,
        );
      if (variant === "overflow257" && sql === STORAGE_DATABASE_SCHEMA_SQL)
        return Array.from({ length: 257 }, (_, n) => ({
          type: "table",
          name: `x${n}`,
          tbl_name: `x${n}`,
          sql: `CREATE TABLE x${n}(a)`,
        }));
      return results;
    };
    await assert.rejects(f.run("schema-apply"), (error) =>
      error.code?.startsWith("prepared_schema_"),
    );
    assert.ok(f.requests.length <= 3);
    assert.equal(f.snapshots.length, 0);
    assert.deepEqual(await f.receipts("write-ddl-"), []);
  });
}
for (const profile of ["trial-009", "trial-009-cf-metadata-v1"]) {
  test(`partial010 ${profile} stays distinct and historical apply preserves nonPrepared hash`, async (t) => {
    const f = await operator(t, profile);
    f.db.exec(PREPARED_SCHEMA_DEFINITIONS[0].sql);
    const partial = await f.run();
    assert.equal(partial.schemaCompatibility, "legacy-partial-010");
    assert.equal(partial.databaseProfile, null);
    assert.equal(partial.status, "incomplete");
    const applied = await f.run("schema-apply");
    assert.equal(applied.schemaCompatibility, "complete-profile");
    assert.equal(applied.databaseProfile, profile.replace("009", "010"));
    assert.deepEqual(applied.counts, { d1: 32, r2: 0, ddl: 12 });
    const [{ value: before }] = await f.receipts("schema-before-"),
      [{ value: after }] = await f.receipts("schema-after-");
    assert.equal(before.oldSchemaSha256, after.oldSchemaSha256);
    assert.notEqual(before.wholeSchemaSha256, after.wholeSchemaSha256);
    assert.deepEqual(before.fingerprints, after.fingerprints);
  });
}
for (const variant of [
  "missingTable",
  "unknownTable",
  "missingColumn",
  "unknownColumn",
  "invalidPrimitive",
  "extraResult",
  "invalidJson",
]) {
  test(`complete activation snapshot rejects ${variant}`, async (t) => {
    const f = await operator(t);
    f.hooks.result = (sql, rows) => {
      if (sql !== readonlySnapshotSql(READONLY_ACTIVATION_TABLES)) return rows;
      if (variant === "extraResult") return [...rows, ...rows];
      if (variant === "invalidJson") return [{ snapshot: "{" }];
      const value = JSON.parse(rows[0].snapshot);
      if (variant === "missingTable") delete value.shelf_storage_evidence_v2;
      if (variant === "unknownTable") {
        delete value.shelf_storage_evidence_v2;
        value.unknown_table = [];
      }
      if (variant === "missingColumn")
        delete value.shelf_storage_evidence_v2[0].evidence_json;
      if (variant === "unknownColumn")
        value.shelf_storage_evidence_v2[0].extra = "unknown";
      if (variant === "invalidPrimitive")
        value.shelf_storage_evidence_v2[0].evidence_json = {};
      return [{ snapshot: JSON.stringify(value) }];
    };
    await assert.rejects(f.run(), { code: "prepared_snapshot_invalid" });
    assert.equal(f.requests.length, 11);
    assert.deepEqual(await f.receipts("write-ddl-"), []);
  });
}
for (const variant of [
  "advertisedOver1MiB",
  "streamOver1MiB",
  "tooManyBlocks",
  "truncatedEnvelope",
]) {
  test(`activation readonly transport rejects ${variant} without widening limits`, async (t) => {
    const f = await operator(t);
    let cancelled = 0;
    f.hooks.response = (sql, rows) => {
      if (sql !== readonlySnapshotSql(READONLY_ACTIVATION_TABLES)) return null;
      if (variant === "advertisedOver1MiB")
        return new Response("{}", { headers: { "content-length": "1048577" } });
      if (variant === "streamOver1MiB")
        return Response.json(envelope([{ snapshot: "x".repeat(1048576) }]));
      if (variant === "truncatedEnvelope")
        return new Response('{"success":true,');
      let count = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (count++ < 65537) controller.enqueue(new Uint8Array());
          },
          cancel() {
            cancelled++;
          },
        }),
      );
    };
    await assert.rejects(f.run(), {
      code:
        variant === "truncatedEnvelope"
          ? "prepared_operator_unknown"
          : "prepared_response_limit",
    });
    assert.equal(f.requests.length, 11);
    assert.deepEqual(await f.receipts("write-ddl-"), []);
    if (variant === "tooManyBlocks") assert.equal(cancelled, 1);
  });
}
test("full four-table activation snapshot over one MiB fails without truncation", async (t) => {
  const f = await operator(t);
  const triggers = f.rows.filter(
    (row) =>
      row.type === "trigger" && row.tbl_name === "shelf_storage_evidence_v2",
  );
  for (const row of triggers) f.db.exec(`DROP TRIGGER ${row.name}`);
  f.db
    .prepare(
      "UPDATE shelf_storage_evidence_v2 SET evidence_json=? WHERE evidence_hash=?",
    )
    .run(JSON.stringify({ synthetic: "x".repeat(1048576) }), "1".repeat(64));
  for (const row of triggers) f.db.exec(row.sql);
  await assert.rejects(f.run(), { code: "prepared_response_limit" });
  assert.equal(f.requests.length, 11);
  const { results } = f.snapshots.at(-1);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope(results))) > 1048576);
  const actual = JSON.parse(results[0].snapshot);
  assert.deepEqual(Object.keys(actual), READONLY_ACTIVATION_TABLES);
  assert.equal(actual.shelf_storage_evidence_v2.length, 2);
  for (const table of READONLY_ACTIVATION_TABLES)
    for (const row of actual[table])
      assert.deepEqual(Object.keys(row), READONLY_TABLE_COLUMNS[table]);
  assert.deepEqual(await f.receipts("write-ddl-"), []);
});
test("activation snapshot deadline cancels late response and emits no DDL intent", async (t) => {
  const f = await operator(t);
  let resolveLate,
    cancelled = 0;
  f.hooks.response = (sql) =>
    sql === readonlySnapshotSql(READONLY_ACTIVATION_TABLES)
      ? new Promise((resolve) => {
          resolveLate = resolve;
        })
      : null;
  await assert.rejects(f.run("schema-apply", { timeoutMs: 40 }), {
    code: "prepared_deadline",
  });
  assert.equal(f.requests.length, 11);
  resolveLate(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cancelled, 1);
  assert.deepEqual(await f.receipts("write-ddl-"), []);
});
test("schema layout preview budgets remain separate from immutable historical index-plan budgets", async () => {
  assert.deepEqual(preparedBudgets(1), {
    schemaStatus: { http: 10, ddl: 0 },
    schemaApply: { http: 33, ddl: 13 },
    indexPublish: { d1: 16, r2: 6, http: 22 },
    indexResume: { d1: 17, r2: 6, http: 23 },
    indexStatus: { d1: 6, r2: 3, http: 9 },
  });
  for (const action of ["schema-status", "schema-apply"]) {
    const result = await runPreparedIndex({ action });
    assert.deepEqual(
      result.budgets,
      action === "schema-apply" ? { http: 33, ddl: 13 } : { http: 10, ddl: 0 },
    );
    assert.deepEqual(result.schemaLayoutBudgets["activation-v2"], {
      http: 11,
      ddl: 0,
      applyAllowed: false,
    });
    assert.deepEqual(
      result.schemaLayoutBudgets["trial-v1"],
      preparedSchemaBudgets("trial-v1", action),
    );
    assert.equal(result.http, 0);
  }
  assert.throws(() => preparedSchemaBudgets("unknown", "schema-status"), {
    code: "prepared_invalid_arguments",
  });
});
