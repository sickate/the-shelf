import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  DATABASE_SCHEMA_PROFILES,
  STORAGE_SCHEMA_SOURCE_HASHES,
} from "../shared/storage-schema-profiles.mjs";
import {
  READONLY_TABLE_COLUMNS,
  readonlySnapshotSql,
} from "../scripts/schema-readonly.mjs";
import { runBookManagementSchema } from "../scripts/book-management-schema.mjs";
import { runFilenameIdentificationSchema } from "../scripts/filename-identification-schema.mjs";
import { runIdentifyObservationSchema } from "../scripts/identify-observation-schema.mjs";
import {
  READONLY_DATABASE_SCHEMA_SQL,
  LEGACY_SCHEMA_STATUS_BUDGETS,
  legacyOperatorSchema,
  legacyStatusGroups,
} from "../scripts/legacy-schema-status.mjs";

const tools = [
  {
    version: 7,
    run: runBookManagementSchema,
    directory: "book-management-schema",
    prefix: "management",
  },
  {
    version: 8,
    run: runFilenameIdentificationSchema,
    directory: "filename-identification-schema",
    prefix: "identification",
  },
  {
    version: 9,
    run: runIdentifyObservationSchema,
    directory: "identify-observation-schema",
    prefix: "observation",
  },
];
const envelope = (results) => ({
  success: true,
  result: [{ success: true, results }],
});
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: "a".repeat(32),
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
async function fixture(
  t,
  tool,
  profile = "activation-011",
  { phase = "imported", largePrepared = false } = {},
) {
  const root = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), "shelf-legacy-status-")),
    ),
    db = new DatabaseSync(":memory:");
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  let definitions = DATABASE_SCHEMA_PROFILES[profile];
  if (Number.isInteger(profile)) {
    const shape = new DatabaseSync(":memory:");
    try {
      for (const name of Object.keys(STORAGE_SCHEMA_SOURCE_HASHES)) {
        const number = name === "schema.sql" ? 0 : Number(name.slice(11, 14));
        if (number < profile)
          shape.exec(
            await fs.readFile(
              new URL("../cloudflare/library/" + name, import.meta.url),
              "utf8",
            ),
          );
      }
      definitions = shape.prepare(READONLY_DATABASE_SCHEMA_SQL).all();
    } finally {
      shape.close();
    }
  }
  for (const type of ["table", "index", "view"])
    for (const row of definitions) if (row.type === type) db.exec(row.sql);
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,?)",
  ).run(JSON.stringify(identity), phase);
  const descriptor = JSON.stringify({ synthetic: "private-descriptor" });
  db.prepare(
    "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,'synthetic-etag',?)",
  ).run(
    "synthetic-permit",
    "2026-10-23-first-book",
    JSON.stringify(identity),
    "{}",
    descriptor,
    "b".repeat(64),
    5,
    1,
    60001,
    2,
  );
  db.prepare(
    "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,1,1)",
  ).run("https://the-shelf.iamzhutuo.workers.dev", "c".repeat(64));
  db.prepare("INSERT INTO sessions VALUES('production',?,1,1,60001,0)").run(
    "d".repeat(64),
  );
  db.prepare(
    "INSERT INTO shelf_storage_reservations VALUES('unknown-reservation','unknown-logical','private-unknown-object',?,7,'uncertain',1,0,NULL,1,2)",
  ).run(descriptor);
  if (String(profile).startsWith("activation-")) {
    db.prepare(
      "INSERT INTO shelf_storage_activation_v2(id,identity_json,migration_hash,imported_receipt_json,imported_readback_hash,state,generation) VALUES(1,?,?,?,?,'closed',0)",
    ).run(
      JSON.stringify(identity),
      "b".repeat(64),
      '{"private":"receipt"}',
      "e".repeat(64),
    );
    db.prepare(
      "INSERT INTO shelf_storage_activation_receipts_v2 VALUES(?,?,?)",
    ).run(
      "1".repeat(64),
      '{"private":"activation-receipt"}',
      '{"private":"snapshot"}',
    );
    db.prepare("INSERT INTO shelf_storage_evidence_v2 VALUES(?,?)").run(
      "2".repeat(64),
      '{"private":"evidence"}',
    );
    db.prepare(
      "INSERT INTO shelf_storage_legacy_liabilities_v2 VALUES('old-unknown',?,?,1,2,3)",
    ).run("3".repeat(64), "4".repeat(64));
  }
  if (largePrepared) {
    db.prepare(
      "INSERT INTO shelf_storage_text_registry VALUES('synthetic_text','unknown-reservation',?,'synthetic',1)",
    ).run(descriptor);
    db.prepare(
      "INSERT INTO shelf_prepared_indexes VALUES('production','synthetic-prepared',?,'book_shared','unknown-reservation','synthetic_text',?,?,'synthetic','PDF',20000,20000,20000,?,1)",
    ).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64));
    const putChunk = db.prepare(
      "INSERT INTO shelf_prepared_index_chunks VALUES('production','synthetic-prepared',?,?,'pdf-page',?,0,1,?,1,1)",
    );
    for (let i = 0; i < 20000; i++)
      putChunk.run("a".repeat(64), i, i, "e".repeat(64));
    db.prepare(
      "INSERT INTO shelf_prepared_index_publications VALUES('production','synthetic-prepared',?,?,20000,20000,20000)",
    ).run("a".repeat(64), "d".repeat(64));
  }
  for (const row of definitions) if (row.type === "trigger") db.exec(row.sql);
  const context = {
    root,
    identity,
    credentials: { accountId: identity.accountId, token: "synthetic-token" },
    resources: {
      profiles: {
        production: {
          databaseId: identity.legacyDatabases.production,
          databaseName: "the-shelf-library",
        },
      },
    },
  };
  const requests = [],
    hooks = { response: null, rows: null, identity: null };
  let runNumber = 0;
  const fetchImpl = async (url, options) => {
    assert.ok(
      url ===
        `https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/d1/database/${identity.legacyDatabases.production}` ||
        url ===
          `https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/d1/database/${identity.legacyDatabases.production}/query`,
    );
    assert.equal(options.redirect, "error");
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({
      sql: body?.sql ?? null,
      params: body?.params,
      method: options.method,
    });
    if (!body)
      return (
        (await hooks.identity?.()) ??
        Response.json({
          success: true,
          result: {
            uuid: identity.legacyDatabases.production,
            name: "the-shelf-library",
          },
        })
      );
    assert.deepEqual(body.params, []);
    assert.match(
      body.sql,
      /^SELECT /,
      "status/apply-disabled may never issue DDL",
    );
    let results = db.prepare(body.sql).all();
    if (hooks.rows) results = hooks.rows(body.sql, results);
    return (
      (await hooks.response?.(body.sql, results)) ??
      Response.json(envelope(results))
    );
  };
  const run = (action = "status", overrides = {}) =>
    tool.run({
      action,
      execute: true,
      context,
      root,
      runId: "run-" + ++runNumber,
      fetchImpl,
      ...overrides,
    });
  const receipt = (filename) =>
    fs
      .readFile(
        path.join(root, ".local", tool.directory, "run-" + runNumber, filename),
        "utf8",
      )
      .then(JSON.parse);
  return {
    root,
    db,
    requests,
    hooks,
    run,
    receipt,
    directory: path.join(root, ".local", tool.directory),
  };
}

for (const tool of tools) {
  test(`${tool.version}: actual legacy status retains ${tool.version} requests and historical state`, async (t) => {
    const f = await fixture(t, tool, tool.version),
      result = await f.run();
    assert.equal(result.requests, tool.version);
    assert.equal(result.schema, tool.version === 9 ? "original" : "absent");
    assert.equal(f.requests.length, tool.version);
    assert.equal(result.uploadAllowed, false);
  });
  test(`${tool.version}: preview declares all status budgets/limits without IO`, async () => {
    const result = await tool.run({
      root: "/missing",
      fetchImpl: () => {
        throw Error("network");
      },
    });
    assert.deepEqual(
      result.readonlyStatusBudgets,
      LEGACY_SCHEMA_STATUS_BUDGETS,
    );
    assert.equal(result.readonlyStatusLimits.responseBytes, 1048576);
    assert.equal(result.readonlyStatusLimits.pagination, false);
  });
  for (const profile of Object.keys(DATABASE_SCHEMA_PROFILES)) {
    test(`${tool.version}: actual ${profile} full status has exact budget, complete snapshots and no private output`, async (t) => {
      const f = await fixture(t, tool, profile),
        r = await f.run();
      assert.equal(r.requests, LEGACY_SCHEMA_STATUS_BUDGETS[profile].http);
      assert.equal(f.requests.length, r.requests);
      assert.equal(f.requests[1].sql, READONLY_DATABASE_SCHEMA_SQL);
      assert.equal(Buffer.byteLength(f.requests[1].sql), 174);
      assert.equal(r.databaseProfile, profile);
      assert.equal(r.schema, "complete");
      assert.equal(r.ddl, 0);
      assert.equal(r.uploadAllowed, false);
      assert.equal(r.readyAllowed, false);
      assert.equal(r.atomic, false);
      assert.deepEqual(
        r.snapshotGroups.map((g) => g.tables),
        legacyStatusGroups(profile),
      );
      assert.equal(
        r.snapshotGroups.reduce((n, g) => n + g.tables.length, 0),
        profile.startsWith("activation-")
          ? 32
          : profile.startsWith("trial-010")
            ? 28
            : 25,
      );
      for (const req of f.requests.slice(2)) {
        assert.match(req.sql, /^SELECT json_object/);
        assert.doesNotMatch(req.sql, /\bLIMIT\b/);
      }
      const text = JSON.stringify(r);
      for (const privateValue of [
        "private-descriptor",
        "private-unknown-object",
        "synthetic-token",
        "synthetic-etag",
        "activation-receipt",
        'private":"evidence',
      ])
        assert.equal(text.includes(privateValue), false);
      assert.deepEqual(
        (await f.receipt("readonly-layout.json")).budget,
        r.budget,
      );
      assert.deepEqual(
        (await f.receipt("run.json")).readonlyStatusBudgets,
        LEGACY_SCHEMA_STATUS_BUDGETS,
      );
      assert.equal(
        await fs.stat(path.join(f.directory, "apply-claim.json")).then(
          () => true,
          () => false,
        ),
        false,
      );
    });
    if (tool.version !== 9 || !profile.startsWith("trial-009"))
      test(`${tool.version}: ${profile} apply stops at second HTTP without claim`, async (t) => {
        const f = await fixture(t, tool, profile);
        await assert.rejects(f.run("apply"), {
          code: `${tool.prefix}_schema_apply_layout_disabled`,
        });
        assert.equal(f.requests.length, 2);
        assert.equal((await f.receipt("result.json")).ddl, 0);
        assert.equal(
          await fs.stat(path.join(f.directory, "apply-claim.json")).then(
            () => true,
            () => false,
          ),
          false,
        );
      });
  }
  for (const kind of [
    "unknown",
    "partial011",
    "missing010",
    "012",
    "foreignCf",
    "literalChange",
    "duplicate",
    "shape",
  ])
    test(`${tool.version}: ${kind} whole schema refuses early`, async (t) => {
      const f = await fixture(t, tool);
      f.hooks.rows = (sql, rows) => {
        if (sql !== READONLY_DATABASE_SCHEMA_SQL) return rows;
        if (kind === "unknown" || kind === "012" || kind === "foreignCf")
          return [
            ...rows,
            {
              type: "view",
              name: kind,
              tbl_name: kind,
              sql: `CREATE VIEW ${kind} AS SELECT 1`,
            },
          ];
        if (kind === "partial011")
          return rows.filter(
            (row) => row.name !== "shelf_storage_activation_v2",
          );
        if (kind === "missing010")
          return rows.filter((row) => row.name !== "shelf_prepared_indexes");
        if (kind === "literalChange")
          return rows.map((row) =>
            row.name === "shelf_storage_admit"
              ? {
                  ...row,
                  sql: row.sql.replace(
                    "storage_budget_or_evidence_invalid",
                    "storage_budget_or_evidence_  invalid",
                  ),
                }
              : row,
          );
        if (kind === "duplicate") return [rows[0], ...rows];
        return rows.map((row, n) => (n ? row : { ...row, unexpected: true }));
      };
      await assert.rejects(f.run("apply"), {
        code: `${tool.prefix}_schema_invalid`,
      });
      assert.equal(f.requests.length, 2);
      assert.equal(
        await fs.stat(path.join(f.directory, "apply-claim.json")).then(
          () => true,
          () => false,
        ),
        false,
      );
    });
  for (const place of ["schema", "snapshot"])
    for (const mode of ["length", "bytes", "chunks", "deadline", "late"])
      test(`${tool.version}: ${place} ${mode} is bounded and never pages`, async (t) => {
        const f = await fixture(t, tool);
        let lateCancelled = false;
        f.hooks.response = async (sql, results) => {
          if ((place === "schema") !== (sql === READONLY_DATABASE_SCHEMA_SQL))
            return;
          if (place === "snapshot" && !sql.startsWith("SELECT json_object"))
            return;
          if (mode === "late") {
            await new Promise((resolve) => setTimeout(resolve, 60));
            return {
              status: 200,
              body: {
                cancel() {
                  lateCancelled = true;
                },
              },
            };
          }
          if (mode === "length")
            return new Response("{}", {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": "1048577",
              },
            });
          if (mode === "bytes")
            return new Response(" ".repeat(1048577), {
              headers: { "Content-Type": "application/json" },
            });
          if (mode === "deadline")
            return new Response(
              new ReadableStream({
                pull: () => new Promise(() => {}),
                cancel: () => new Promise(() => {}),
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          return new Response(
            new ReadableStream({
              start(controller) {
                for (let n = 0; n < 4097; n++)
                  controller.enqueue(new Uint8Array());
                controller.close();
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        };
        await assert.rejects(f.run("status", { requestTimeoutMs: 25 }), {
          code: `${tool.prefix}_schema_read_failed`,
        });
        assert.equal(f.requests.length, place === "schema" ? 2 : 3);
        assert.equal((await f.receipt("result.json")).ddl, 0);
        if (mode === "late") {
          await new Promise((resolve) => setTimeout(resolve, 90));
          assert.equal(lateCancelled, true);
        }
      });
  for (const fault of [
    "authorityIdentity",
    "authorityPhase",
    "trialUnknown",
    "trialAttempt",
    "trialVerified",
    "trialConsent",
    "authMissing",
    "snapshotColumns",
    "snapshotTable",
    "snapshotExtraRow",
  ])
    test(`${tool.version}: full snapshot rejects ${fault}`, async (t) => {
      const f = await fixture(t, tool);
      f.hooks.rows = (sql, rows) => {
        if (!sql.startsWith("SELECT json_object")) return rows;
        const value = JSON.parse(rows[0].snapshot);
        if (value.shelf_storage_authority) {
          if (fault === "authorityIdentity")
            value.shelf_storage_authority[0].identity_json = "{}";
          if (fault === "authorityPhase")
            value.shelf_storage_authority[0].phase = "migration_required";
          if (fault === "trialUnknown")
            value.shelf_storage_single_trial[0].state = "reserved";
          if (fault === "trialAttempt")
            value.shelf_storage_single_trial[0].put_attempted = 0;
          if (fault === "trialVerified")
            value.shelf_storage_single_trial[0].content_verified = 0;
          if (fault === "trialConsent")
            value.shelf_storage_single_trial[0].consent_id = "other";
          if (fault === "snapshotColumns")
            delete value.shelf_storage_authority[0].identity_json;
          if (fault === "snapshotTable") delete value.shelf_storage_staging;
          if (fault === "snapshotExtraRow") return [rows[0], rows[0]];
        }
        if (fault === "authMissing" && value.auth_config)
          value.auth_config = [];
        return [{ snapshot: JSON.stringify(value) }];
      };
      await assert.rejects(f.run(), {
        code: `${tool.prefix}_schema_protected_facts_invalid`,
      });
      assert.ok(f.requests.length <= 4);
    });
  test(`${tool.version}: ready authority is an observation with no ready/upload permit`, async (t) => {
    const f = await fixture(t, tool, "activation-011", { phase: "ready" });
    const r = await f.run();
    assert.equal(r.observationOnly, true);
    assert.equal(r.readyAllowed, false);
    assert.equal(r.uploadAllowed, false);
  });
  for (const mode of ["length", "bytes", "chunks", "deadline", "late"])
    test(`${tool.version}: first identity GET also enforces status response ${mode} limit`, async (t) => {
      const f = await fixture(t, tool);
      let cancelled = false;
      f.hooks.identity = async () => {
        if (mode === "late") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            status: 200,
            body: {
              cancel() {
                cancelled = true;
              },
            },
          };
        }
        const headers = { "Content-Type": "application/json" };
        if (mode === "length")
          return new Response("{}", {
            headers: { ...headers, "Content-Length": "1048577" },
          });
        if (mode === "bytes")
          return new Response(" ".repeat(1048577), { headers });
        if (mode === "deadline")
          return new Response(
            new ReadableStream({
              pull: () => new Promise(() => {}),
              cancel: () => new Promise(() => {}),
            }),
            { headers },
          );
        return new Response(
          new ReadableStream({
            start(controller) {
              for (let n = 0; n < 4097; n++)
                controller.enqueue(new Uint8Array());
              controller.close();
            },
          }),
          { headers },
        );
      };
      await assert.rejects(f.run("status", { requestTimeoutMs: 25 }), {
        code: `${tool.prefix}_schema_read_failed`,
      });
      assert.equal(f.requests.length, 1);
      if (mode === "late") {
        await new Promise((resolve) => setTimeout(resolve, 90));
        assert.equal(cancelled, true);
      }
    });
  test(`${tool.version}: 20000 prepared chunks exceed 1MiB and stop without truncation or more pages`, async (t) => {
    const f = await fixture(t, tool, "activation-011", { largePrepared: true });
    const rows = f.db
      .prepare(readonlySnapshotSql(legacyStatusGroups("activation-011")[7]))
      .all();
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM shelf_prepared_index_chunks")
        .get().n,
      20000,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(envelope(rows))) > 7500000);
    await assert.rejects(f.run(), {
      code: `${tool.prefix}_schema_read_failed`,
    });
    assert.equal(f.requests.length, 10);
    assert.equal(
      f.requests.filter((request) =>
        request.sql?.includes("AS row FROM shelf_prepared_index_chunks"),
      ).length,
      1,
    );
    assert.equal((await f.receipt("result.json")).ddl, 0);
  });
  test(`${tool.version}: real unknown, auth, trial and each v2 responsibility change affects complete status fingerprint`, async (t) => {
    const f = await fixture(t, tool);
    let before = await f.run();
    const edits = [
      [
        "shelf_storage_reservations",
        "UPDATE shelf_storage_reservations SET updated_at=3",
      ],
      ["auth_config", "UPDATE auth_config SET enabled=0"],
      [
        "shelf_storage_single_trial",
        "UPDATE shelf_storage_single_trial SET etag='changed-etag'",
      ],
      [
        "shelf_storage_activation_v2",
        "UPDATE shelf_storage_activation_v2 SET imported_receipt_json='{}'",
      ],
      [
        "shelf_storage_activation_receipts_v2",
        "UPDATE shelf_storage_activation_receipts_v2 SET receipt_json='{}'",
      ],
      [
        "shelf_storage_evidence_v2",
        "UPDATE shelf_storage_evidence_v2 SET evidence_json='{}'",
      ],
      [
        "shelf_storage_legacy_liabilities_v2",
        "UPDATE shelf_storage_legacy_liabilities_v2 SET max_bytes=4",
      ],
    ];
    for (const [table, sql] of edits) {
      // Synthetic fixture mutations only; restore byte-identical public guards before operator reads.
      const triggers = f.db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
        )
        .all(table);
      for (const trigger of triggers) f.db.exec("DROP TRIGGER " + trigger.name);
      f.db.exec(sql);
      for (const trigger of triggers) f.db.exec(trigger.sql);
      const after = await f.run();
      assert.equal(after.wholeSchemaSha256, before.wholeSchemaSha256);
      assert.notEqual(
        after.protectedFactsSha256,
        before.protectedFactsSha256,
        table,
      );
      assert.notEqual(
        after.snapshotGroups.find((group) => group.tables.includes(table))
          .sha256,
        before.snapshotGroups.find((group) => group.tables.includes(table))
          .sha256,
        table,
      );
      before = after;
    }
  });
}

test("all 32 table columns and every ordered group match independent SQLite PRAGMA", async (t) => {
  const f = await fixture(t, tools[0]);
  const seen = new Set();
  for (const group of legacyStatusGroups("activation-011")) {
    const sql = readonlySnapshotSql(group);
    for (const table of group) {
      assert.equal(seen.has(table), false);
      seen.add(table);
      const columns = f.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      assert.deepEqual(
        [...READONLY_TABLE_COLUMNS[table]].sort(),
        [...columns].sort(),
      );
      assert.ok(
        sql.includes(" ORDER BY " + READONLY_TABLE_COLUMNS[table].join(",")),
      );
    }
  }
  assert.equal(seen.size, 32);
});

test("pinned legacy fallback accepts pre/known own subsets with and without 002; rejects stranger/partial011", async () => {
  const sources = await Promise.all(
    Object.keys(STORAGE_SCHEMA_SOURCE_HASHES).map(async (name) => ({
      name,
      number: name === "schema.sql" ? 0 : Number(name.slice(11, 14)),
      sql: await fs.readFile(
        new URL("../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    })),
  );
  for (const tool of tools)
    for (const include002 of [false, true]) {
      const db = new DatabaseSync(":memory:");
      try {
        for (const source of sources)
          if (
            source.number < tool.version &&
            (include002 || source.number !== 2)
          )
            db.exec(source.sql);
        const before = db.prepare(READONLY_DATABASE_SCHEMA_SQL).all();
        assert.equal(legacyOperatorSchema(tool.version, before).full, null);
        db.exec(sources.find((source) => source.number === tool.version).sql);
        const after = db.prepare(READONLY_DATABASE_SCHEMA_SQL).all();
        const own = after.filter(
          (row) => !before.some((old) => old.name === row.name),
        );
        for (let n = 0; n <= own.length; n++) {
          const rows = [...before, ...own.slice(0, n)].sort(
            (a, b) =>
              a.type.localeCompare(b.type, "en") ||
              a.name.localeCompare(b.name, "en"),
          );
          assert.doesNotThrow(() => legacyOperatorSchema(tool.version, rows));
        }
        for (const stranger of [
          {
            type: "table",
            name: "zz_unknown",
            tbl_name: "zz_unknown",
            sql: "CREATE TABLE zz_unknown(x)",
          },
          DATABASE_SCHEMA_PROFILES["activation-011"].find(
            (row) => row.name === "shelf_storage_activation_v2",
          ),
        ]) {
          const rows = [...before, stranger].sort(
            (a, b) =>
              a.type.localeCompare(b.type, "en") ||
              a.name.localeCompare(b.name, "en"),
          );
          assert.throws(() => legacyOperatorSchema(tool.version, rows));
        }
      } finally {
        db.close();
      }
    }
});
