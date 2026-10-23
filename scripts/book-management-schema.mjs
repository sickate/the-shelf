#!/usr/bin/env node
// Fixed additive 007 schema installation only. No upload, arbitrary SQL, retry or auth mutation.
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { loadMigrationContext } from "./storage-migrate.mjs";
import { d1Client } from "./cf-library-clients.mjs";
import { SINGLE_TRIAL_PRIVATE_IO as IO } from "./single-trial.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
export const BOOK_MANAGEMENT_MIGRATION_SHA256 =
  "808ebf6bb222e98e69ec74dac9ec036a5347930c53ce6e2f194eefddc278a39f";
const source = readFileSync(
  new URL(
    "../cloudflare/library/migrations/007-book-management.sql",
    import.meta.url,
  ),
  "utf8",
);
if (sha(source) !== BOOK_MANAGEMENT_MIGRATION_SHA256)
  throw Error("management_schema_source_changed");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE admissions(scope TEXT,file_id TEXT,kind TEXT)");
db.exec(source);
export const BOOK_MANAGEMENT_SCHEMA = Object.freeze(
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name<>'admissions' ORDER BY type,name",
    )
    .all()
    .map((v) => Object.freeze({ ...v })),
);
db.close();
const NAMES = BOOK_MANAGEMENT_SCHEMA.map((v) => v.name);
const QUOTED = NAMES.map((n) => `'${n}'`).join(",");
export const BOOK_MANAGEMENT_SCHEMA_SQL = Object.freeze({
  schema: `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN (${QUOTED}) ORDER BY type,name LIMIT 8`,
  oldSchema: `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN (${QUOTED},'_cf_KV','d1_migrations') AND name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 129`,
  authority: "SELECT * FROM shelf_storage_authority WHERE id=1 LIMIT 2",
  trial: "SELECT * FROM shelf_storage_single_trial WHERE id=1 LIMIT 2",
  auth: "SELECT * FROM auth_config WHERE scope='production' LIMIT 2",
  registries:
    "SELECT 'reservation' AS kind,reservation_id AS id,json_object('reservation_id',reservation_id,'logical_key',logical_key,'object_key',object_key,'descriptor_json',descriptor_json,'size_bytes',size_bytes,'state',state,'put_attempted',put_attempted,'content_verified',content_verified,'etag',etag,'created_at',created_at,'updated_at',updated_at) AS data FROM shelf_storage_reservations UNION ALL SELECT 'registry',logical_key,json_object('logical_key',logical_key,'reservation_id',reservation_id,'descriptor_json',descriptor_json,'etag',etag,'enabled',enabled) FROM shelf_storage_original_registry UNION ALL SELECT 'text',logical_key,json_object('logical_key',logical_key,'reservation_id',reservation_id,'descriptor_json',descriptor_json,'etag',etag,'enabled',enabled) FROM shelf_storage_text_registry ORDER BY kind,id LIMIT 10001",
  counts:
    "SELECT (SELECT count(*) FROM book_management) AS management,(SELECT count(*) FROM browser_uploads) AS uploads",
});
export const BOOK_MANAGEMENT_SCHEMA_BUDGET = Object.freeze({
  apply: { http: 23, ddl: 7 },
  status: { http: 9, ddl: 0 },
});
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
const normalize = (rows) =>
  rows.map((r) => ({
    type: r.type,
    name: r.name,
    tbl_name: r.tbl_name,
    sql: r.sql.trim().replace(/;$/, "").replace(/\s+/g, " "),
  }));
const schemaState = (rows) => {
  if (rows.length > 7 || new Set(rows.map((r) => r.name)).size !== rows.length)
    fail("management_schema_invalid");
  for (const row of rows) {
    const expected = BOOK_MANAGEMENT_SCHEMA.find((e) => e.name === row.name);
    if (!expected || sha(normalize([row])) !== sha(normalize([expected])))
      fail("management_schema_invalid");
  }
  return rows.length === 7
    ? "complete"
    : rows.length === 0
      ? "absent"
      : "partial";
};
export async function runBookManagementSchema({
  action = "status",
  execute = false,
  runId,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  requestTimeoutMs = 30000,
  context: injectedContext,
} = {}) {
  if (
    !["apply", "status"].includes(action) ||
    typeof execute !== "boolean" ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30000
  )
    fail("management_schema_arguments");
  if (!execute)
    return {
      mode: "preview",
      action,
      requests: 0,
      budget: BOOK_MANAGEMENT_SCHEMA_BUDGET[action],
      migrationSha256: BOOK_MANAGEMENT_MIGRATION_SHA256,
      uploadAllowed: false,
    };
  if (!/^[A-Za-z0-9][\w-]{0,79}$/.test(runId || ""))
    fail("management_schema_run_required");
  const context =
    injectedContext || (await loadMigrationContext({ root, environment }));
  root = context.root;
  if (
    context.identity.accountId !== context.credentials.accountId ||
    context.identity.bucket !== "the-shelf-books" ||
    context.resources.profiles.production.databaseId !==
      context.identity.legacyDatabases.production ||
    context.resources.profiles.production.databaseName !== "the-shelf-library"
  )
    fail("management_schema_target_invalid");
  const directory = path.join(root, ".local/book-management-schema");
  await IO.privateDirectory(root, directory, true);
  const run = path.join(directory, runId);
  await fs.mkdir(run, { mode: 0o700 });
  await IO.writeImmutable(root, path.join(run, "run.json"), {
    schemaVersion: 1,
    action,
    identity: context.identity,
    migrationSha256: BOOK_MANAGEMENT_MIGRATION_SHA256,
    budget: BOOK_MANAGEMENT_SCHEMA_BUDGET[action],
  });
  let count = 0,
    writes = 0,
    controller;
  const client = d1Client(
    context.credentials,
    context.resources.profiles.production,
    {
      fetchImpl: async (url, options) => {
        let timer;
        const operation = Promise.resolve().then(() =>
          fetchImpl(url, {
            ...options,
            signal: controller?.signal ?? options.signal,
          }),
        );
        try {
          return await Promise.race([
            operation,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                operation.then(
                  (r) => {
                    try {
                      void r.body?.cancel();
                    } catch {}
                  },
                  () => {},
                );
                reject(Error("deadline"));
              }, requestTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  );
  const request = async (sql, mutating = false) => {
    if (
      ++count > BOOK_MANAGEMENT_SCHEMA_BUDGET[action].http ||
      (mutating && ++writes > BOOK_MANAGEMENT_SCHEMA_BUDGET[action].ddl)
    )
      fail("management_schema_request_budget");
    const n = String(count).padStart(3, "0");
    await IO.writeImmutable(root, path.join(run, n + "-intent.json"), {
      sequence: count,
      method: sql ? "POST" : "GET",
      mutating,
      sqlSha256: sql ? sha(sql) : null,
    });
    try {
      controller = new AbortController();
      let timer;
      const operation = sql ? client.query(sql) : client.verify();
      let result;
      try {
        result = await Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(Error("deadline"));
            }, requestTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await IO.writeImmutable(root, path.join(run, n + "-outcome.json"), {
        state: "response-validated",
      });
      return result;
    } catch {
      await IO.writeImmutable(root, path.join(run, n + "-outcome.json"), {
        state: mutating ? "unknown" : "read-failed",
      });
      fail(
        mutating
          ? "management_schema_write_unknown"
          : "management_schema_read_failed",
      );
    }
  };
  const facts = async () => {
    const old = await request(BOOK_MANAGEMENT_SCHEMA_SQL.oldSchema);
    if (old.length >= 129) fail("management_schema_old_schema_limit");
    const authority = await request(BOOK_MANAGEMENT_SCHEMA_SQL.authority),
      trial = await request(BOOK_MANAGEMENT_SCHEMA_SQL.trial),
      auth = await request(BOOK_MANAGEMENT_SCHEMA_SQL.auth),
      registries = await request(BOOK_MANAGEMENT_SCHEMA_SQL.registries);
    if (
      authority.length !== 1 ||
      authority[0].identity_json !== JSON.stringify(context.identity) ||
      authority[0].phase !== "imported" ||
      trial.length !== 1 ||
      trial[0].state !== "confirmed" ||
      trial[0].put_attempted !== 1 ||
      trial[0].content_verified !== 1 ||
      trial[0].consent_id !== "2026-10-23-first-book" ||
      auth.length !== 1 ||
      auth[0].scope !== "production" ||
      registries.length >= 10001
    )
      fail("management_schema_protected_facts_invalid");
    return sha({ old, authority, trial, auth, registries });
  };
  try {
    await request();
    let state = schemaState(await request(BOOK_MANAGEMENT_SCHEMA_SQL.schema));
    const before = await facts();
    if (action === "status") {
      const result = {
        mode: "executed",
        action,
        schema: state,
        requests: count,
        protectedFactsSha256: before,
        uploadAllowed: false,
      };
      await IO.writeImmutable(root, path.join(run, "result.json"), result);
      return result;
    }
    if (state === "partial") fail("management_schema_partial_requires_review");
    if (state === "absent") {
      // Global immutable claim is saved before any DDL. A new run cannot replay unknown writes.
      await IO.writeImmutable(root, path.join(directory, "apply-claim.json"), {
        schemaVersion: 1,
        runId,
        migrationSha256: BOOK_MANAGEMENT_MIGRATION_SHA256,
        protectedFactsSha256: before,
        identity: context.identity,
      });
      for (const statement of BOOK_MANAGEMENT_SCHEMA)
        await request(statement.sql, true);
    }
    state = schemaState(await request(BOOK_MANAGEMENT_SCHEMA_SQL.schema));
    if (state !== "complete") fail("management_schema_incomplete");
    const after = await facts();
    if (after !== before) fail("management_schema_protected_facts_changed");
    const counts = await request(BOOK_MANAGEMENT_SCHEMA_SQL.counts);
    if (
      counts.length !== 1 ||
      counts[0].management !== 0 ||
      counts[0].uploads !== 0
    )
      fail("management_schema_not_empty");
    const result = {
      mode: "executed",
      action,
      schema: state,
      requests: count,
      ddl: writes,
      protectedFactsSha256: after,
      uploadAllowed: false,
    };
    await IO.writeImmutable(root, path.join(run, "result.json"), result);
    return result;
  } catch (error) {
    try {
      await IO.writeImmutable(root, path.join(run, "result.json"), {
        state: "stopped",
        code: /^management_schema_/.test(error?.code || "")
          ? error.code
          : "management_schema_private_io_failed",
        requests: count,
        ddl: writes,
        uploadAllowed: false,
      });
    } catch {}
    throw error;
  }
}
export async function main(args = process.argv.slice(2)) {
  const action = args[0] || "status",
    execute = args.includes("--execute"),
    runIndex = args.indexOf("--run");
  if (
    args.some(
      (a, i) =>
        i !== 0 && a !== "--execute" && a !== "--run" && i !== runIndex + 1,
    ) ||
    args.filter((a) => a === "--run").length > 1 ||
    args.filter((a) => a === "--execute").length > 1
  )
    fail("management_schema_arguments");
  return runBookManagementSchema({
    action,
    execute,
    runId: runIndex >= 0 ? args[runIndex + 1] : undefined,
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((v) => console.log(JSON.stringify(v)))
    .catch(() => {
      console.error(JSON.stringify({ code: "management_schema_stopped" }));
      process.exitCode = 1;
    });
