#!/usr/bin/env node
/** Fixed-project private prepared index operator. Preview performs no secret or remote IO. */
import fs from "node:fs/promises";
import { readFileSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadMigrationContext } from "./storage-migrate.mjs";
import { loadSelectedLocalObject } from "./selected-sync.mjs";
import { readPrivateJson, writePrivateJson } from "./cf-library-data.mjs";
import { createR2ObjectStore } from "../server/r2-object-store.mjs";
import {
  objectDescriptor,
  validateObjectBytes,
} from "../server/storage-authority.mjs";
import { validatePreparedText } from "../shared/prepared-text.mjs";
import {
  buildPreparedIndex,
  preparedChunkRow,
} from "../shared/prepared-index.mjs";
import {
  PREPARED_SCHEMA_SHA256,
  PREPARED_SCHEMA_DEFINITIONS,
} from "./prepared-schema.mjs";
import {
  READONLY_DATABASE_SCHEMA_SQL,
  READONLY_TABLE_COLUMNS,
  READONLY_LEGACY_SNAPSHOT_GROUPS,
  READONLY_ACTIVATION_TABLES,
  normalizeReadonlySchemaRows,
  classifyReadonlyDatabaseSchema,
  readonlySnapshotSql,
} from "./schema-readonly.mjs";
export {
  PREPARED_SCHEMA_SHA256,
  PREPARED_SCHEMA_DEFINITIONS,
} from "./prepared-schema.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const ACTIONS = new Set([
  "plan",
  "schema-status",
  "schema-apply",
  "index-status",
  "index-publish",
]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const same = (a, b) => stable(a) === stable(b);
const normalize = (sql) => sql.trim().replace(/;$/, "");
export class PreparedOperatorError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreparedOperatorError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new PreparedOperatorError(code);
};
const safeCode = (error) =>
  error instanceof PreparedOperatorError
    ? error.code
    : "prepared_operator_unknown";
const schemaFiles = [
  "schema.sql",
  ...[
    "002-conservative-storage",
    "003-storage-authority",
    "004-freeze-legacy-storage",
    "005-single-trial",
    "006-single-trial-admission",
    "007-book-management",
    "008-filename-identification",
    "009-filename-identification-observations",
  ].map((n) => `migrations/${n}.sql`),
];
// Parse with SQLite, including triggers and comments; never split SQL at semicolons.
function schemas() {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of schemaFiles)
      db.exec(
        readFileSync(
          new URL(`../cloudflare/library/${file}`, import.meta.url),
          "utf8",
        ),
      );
    const select =
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY rowid";
    const old = db.prepare(select).all();
    const tables = Object.fromEntries(
      old
        .filter((v) => v.type === "table")
        .map((v) => [
          v.name,
          db
            .prepare(`PRAGMA table_info(${v.name})`)
            .all()
            .map((c) => c.name),
        ]),
    );
    const added = PREPARED_SCHEMA_DEFINITIONS;
    return { old, added, tables };
  } finally {
    db.close();
  }
}
const SCHEMAS = schemas();
export function preparedBudgets(chunks) {
  if (!Number.isSafeInteger(chunks) || chunks < 1 || chunks > 20000)
    fail("prepared_invalid_chunks");
  const batches = Math.ceil(chunks / 100),
    pages = Math.ceil(chunks / 1000);
  return {
    schemaStatus: { http: 10, ddl: 0 },
    schemaApply: { http: 33, ddl: 13 },
    indexPublish: {
      d1: 13 + batches + 2 * pages,
      r2: 6,
      http: 19 + batches + 2 * pages,
    },
    indexResume: {
      d1: 13 + batches + 3 * pages,
      r2: 6,
      http: 19 + batches + 3 * pages,
    },
    indexStatus: { d1: 5 + pages, r2: 3, http: 8 + pages },
  };
}
function argumentsFor(input) {
  const {
    action = "plan",
    execute = false,
    fileId,
    versionHash,
    sha256,
  } = input;
  if (
    !ACTIONS.has(action) ||
    typeof execute !== "boolean" ||
    Object.keys(input).some(
      (k) =>
        !["action", "execute", "fileId", "versionHash", "sha256"].includes(k),
    )
  )
    fail("prepared_invalid_arguments");
  const selected = !action.startsWith("schema-");
  if (
    (selected &&
      (!/^file_[a-f0-9]{16}$/.test(fileId || "") ||
        !HASH.test(versionHash || "") ||
        !HASH.test(sha256 || ""))) ||
    (!selected && [fileId, versionHash, sha256].some((v) => v !== undefined))
  )
    fail("prepared_invalid_arguments");
  return {
    action,
    execute,
    ...(selected ? { fileId, versionHash, sha256 } : {}),
  };
}
export function parsePreparedIndexArgs(args) {
  const input = { action: "plan" },
    seen = new Set();
  if (args[0] && !args[0].startsWith("--")) {
    input.action = args[0];
    args = args.slice(1);
  }
  const names = {
    "--file": "fileId",
    "--version": "versionHash",
    "--sha256": "sha256",
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) fail("prepared_invalid_arguments");
    seen.add(key);
    if (key === "--execute") {
      input.execute = true;
      continue;
    }
    if (
      !Object.hasOwn(names, key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      fail("prepared_invalid_arguments");
    input[names[key]] = args[++i];
  }
  return argumentsFor(input);
}
async function privateDirectory(root, suffix) {
  let current = root;
  for (const component of [".local", "prepared-index", ...suffix]) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
      await syncDirectory(path.dirname(current));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const st = await fs.lstat(current);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid() ||
      (st.mode & 0o777) !== 0o700
    )
      fail("prepared_private_directory_unsafe");
  }
  return current;
}
async function syncDirectory(directory) {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readOptional(root, filename) {
  try {
    const st = await fs.lstat(filename);
    if (st.nlink !== 1 || st.uid !== process.getuid())
      fail("prepared_private_file_unsafe");
    return await readPrivateJson(filename, root, 20_000_000);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function immutableWrite(root, filename, value) {
  const temporary = path.join(
    path.dirname(filename),
    `.claim-${randomUUID()}.json`,
  );
  await writePrivateJson(temporary, value, root);
  try {
    await fs.link(temporary, filename);
    await fs.unlink(temporary);
    await syncDirectory(path.dirname(filename));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function claim(root, directory, plan) {
  const file = path.join(directory, "plan.json");
  const previous = await readOptional(root, file);
  if (previous) {
    if (!same(previous, plan)) fail("prepared_plan_conflict");
    return previous;
  }
  try {
    await immutableWrite(root, file, plan);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const won = await readOptional(root, file);
    if (!same(won, plan)) fail("prepared_plan_conflict");
  }
  return plan;
}
function journal(root, directory) {
  const read = (name) =>
    readOptional(root, path.join(directory, `${name}.json`));
  const write = (name, value) =>
    immutableWrite(root, path.join(directory, `${name}.json`), value);
  return {
    read,
    write,
    async before(label, metadata, mutating) {
      const name = mutating ? `write-${label}` : `read-${randomUUID()}`;
      if (mutating && (await read(`${name}-intent`)))
        fail("prepared_write_already_attempted");
      try {
        await write(`${name}-intent`, {
          schemaVersion: 1,
          label,
          mutating,
          ...metadata,
        });
      } catch (error) {
        if (error.code === "EEXIST") fail("prepared_write_already_attempted");
        throw error;
      }
      return name;
    },
  };
}
function cancel(value) {
  try {
    void Promise.resolve(value?.cancel()).catch(() => {});
  } catch {}
}
async function boundedJson(response, signal) {
  const advertised = response.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) > 1048576)
  )
    fail("prepared_response_limit");
  if (!response.body) fail("prepared_response_invalid");
  const reader = response.body.getReader(),
    parts = [];
  let bytes = 0,
    blocks = 0,
    done = false;
  const stop = () => cancel(reader);
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) fail("prepared_deadline");
      if (next.done) {
        done = true;
        break;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        ++blocks > 65536 ||
        (bytes += next.value.length) > 1048576
      )
        fail("prepared_response_limit");
      parts.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(parts, bytes).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", stop);
    if (!done) stop();
    try {
      reader.releaseLock();
    } catch {}
  }
}
class Transport {
  constructor(context, log, fetchImpl, budget, timeoutMs) {
    Object.assign(this, { context, log, fetchImpl, budget, timeoutMs });
    this.counts = { d1: 0, r2: 0, ddl: 0 };
    this.base = `https://api.cloudflare.com/client/v4/accounts/${context.identity.accountId}/d1/database/${context.identity.legacyDatabases.production}`;
  }
  async send(url, options, label, mutating = false, ddl = false) {
    const isD1 = url === this.base || url === this.base + "/query",
      kind = isD1 ? "d1" : "r2";
    if (
      ++this.counts[kind] > (this.budget[kind] ?? this.budget.http) ||
      this.counts.d1 + this.counts.r2 > this.budget.http ||
      (ddl && ++this.counts.ddl > this.budget.ddl)
    )
      fail("prepared_request_budget");
    if (!isD1 || !["GET", "POST"].includes(options.method))
      fail("prepared_target_rejected");
    const entry = await this.log.before(
      label,
      {
        service: "d1",
        method: options.method,
        requestSha256: hash(options.body ?? ""),
      },
      mutating,
    );
    const controller = new AbortController();
    let response, timer;
    const pending = (async () => {
      response = await this.fetchImpl(url, {
        ...options,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.context.credentials.token}`,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        cancel(response?.body);
        fail("prepared_deadline");
      }
      if (
        !response ||
        response.redirected ||
        (response.url && response.url !== url) ||
        response.status !== 200
      )
        fail("prepared_response_invalid");
      const body = await boundedJson(response, controller.signal);
      if (
        body.success !== true ||
        (isD1 &&
          options.method === "POST" &&
          (!Array.isArray(body.result) ||
            body.result.length !== 1 ||
            body.result[0].success !== true ||
            !Array.isArray(body.result[0].results)))
      )
        fail("prepared_response_invalid");
      return body;
    })();
    pending.then(
      () => {
        if (controller.signal.aborted) cancel(response?.body);
      },
      () => {},
    );
    try {
      const body = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            cancel(response?.body);
            reject(new PreparedOperatorError("prepared_deadline"));
          }, this.timeoutMs);
        }),
      ]);
      await this.log.write(`${entry}-outcome`, {
        status: "known",
        responseSha256: hash(stable(body)),
      });
      return body;
    } catch (error) {
      controller.abort();
      cancel(response?.body);
      try {
        await this.log.write(`${entry}-outcome`, {
          status: mutating ? "unknown" : "failed",
          code: safeCode(error),
        });
      } catch {}
      fail(mutating ? "prepared_write_outcome_unknown" : safeCode(error));
    } finally {
      clearTimeout(timer);
    }
  }
  async identity() {
    const body = await this.send(this.base, { method: "GET" }, "identity");
    if (
      body.result?.uuid !== this.context.identity.legacyDatabases.production ||
      body.result?.name !==
        this.context.resources.profiles.production.databaseName
    )
      fail("prepared_identity_mismatch");
  }
  async query(
    sql,
    params = [],
    label = "query",
    mutating = false,
    ddl = false,
  ) {
    return (
      await this.send(
        this.base + "/query",
        { method: "POST", body: JSON.stringify({ sql, params }) },
        label,
        mutating,
        ddl,
      )
    ).result[0].results;
  }
  async r2(url, options) {
    const u = new URL(url),
      d = this.descriptor;
    const expected = `https://${this.context.identity.accountId}.r2.cloudflarestorage.com/the-shelf-books/${d.objectKey}`;
    if (
      url !== expected ||
      u.search ||
      !["HEAD", "GET"].includes(options.method)
    )
      fail("prepared_target_rejected");
    if (
      ++this.counts.r2 > this.budget.r2 ||
      this.counts.d1 + this.counts.r2 > this.budget.http
    )
      fail("prepared_request_budget");
    const entry = await this.log.before(
      "object",
      { service: "r2", method: options.method, keySha256: hash(d.objectKey) },
      false,
    );
    // createR2ObjectStore owns the request+stream deadline, size/hash and late-response cancellation.
    try {
      if (options.signal.aborted) fail("prepared_deadline");
      const result = await this.fetchImpl(url, {
        ...options,
        redirect: "manual",
      });
      if (options.signal.aborted) {
        cancel(result?.body);
        fail("prepared_deadline");
      }
      await this.log.write(`${entry}-outcome`, {
        status: "headers",
        httpStatus: result?.status ?? null,
      });
      return result;
    } catch {
      await this.log.write(`${entry}-outcome`, { status: "failed" });
      fail("prepared_object_unknown");
    }
  }
}
const preparedSchemaSql =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,15)='shelf_prepared_' ORDER BY type,name LIMIT 14";
function compareSchema(rows, expected, partial = false) {
  if (!Array.isArray(rows) || rows.length > (partial ? expected.length : 256))
    fail("prepared_schema_invalid");
  for (const row of rows) {
    const definition = expected.find((v) => v.name === row.name);
    if (
      !definition ||
      row.type !== definition.type ||
      row.tbl_name !== definition.tbl_name ||
      normalize(row.sql) !== normalize(definition.sql)
    )
      fail("prepared_schema_conflict");
  }
  if (!partial && rows.length !== expected.length)
    fail("prepared_schema_incomplete");
}
/** Schema-only layout budgets never enter persisted per-index plans. */
export function preparedSchemaBudgets(layout, action) {
  if (
    !["trial-v1", "activation-v2"].includes(layout) ||
    !["schema-status", "schema-apply"].includes(action)
  )
    fail("prepared_invalid_arguments");
  return layout === "activation-v2"
    ? { http: 11, ddl: 0 }
    : action === "schema-apply"
      ? { http: 33, ddl: 13 }
      : { http: 10, ddl: 0 };
}
function schemaRows(rows) {
  try {
    return normalizeReadonlySchemaRows(rows);
  } catch {
    fail("prepared_schema_invalid");
  }
}
function schemaLayout(added, whole) {
  const normalized = schemaRows(whole),
    currentAdded = normalized.filter((row) =>
      row.name.startsWith("shelf_prepared_"),
    );
  if (!same(schemaRows(added), currentAdded)) fail("prepared_schema_changed");
  const completeProfile = classifyReadonlyDatabaseSchema(normalized);
  if (completeProfile)
    return {
      storageLayout: completeProfile.storageLayout,
      databaseProfile: completeProfile.profile,
      databaseSchemaSha256: completeProfile.sha256,
      schemaCompatibility: "complete-profile",
    };
  // Historical 010 installation/resume only: exact old base plus known 010 subset.
  // No partial activation schema or unknown object can select this compatibility.
  const old = normalized.filter(
      (row) => !row.name.startsWith("shelf_prepared_"),
    ),
    base = classifyReadonlyDatabaseSchema(old);
  if (
    base &&
    ["trial-009", "trial-009-cf-metadata-v1"].includes(base.profile) &&
    added.length > 0 &&
    added.length < 13
  )
    return {
      storageLayout: "trial-v1",
      databaseProfile: null,
      databaseSchemaSha256: null,
      schemaCompatibility: "legacy-partial-010",
    };
  // Preserve existing actionable old-schema incomplete/conflict diagnostics.
  compareSchema(old, SCHEMAS.old);
  fail("prepared_schema_conflict");
}
function snapshotValue(result, tables) {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    !result[0] ||
    Object.keys(result[0]).length !== 1 ||
    typeof result[0].snapshot !== "string"
  )
    fail("prepared_snapshot_invalid");
  let value;
  try {
    value = JSON.parse(result[0].snapshot);
  } catch {
    fail("prepared_snapshot_invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== tables.length
  )
    fail("prepared_snapshot_invalid");
  for (const table of tables) {
    if (!Object.hasOwn(value, table) || !Array.isArray(value[table]))
      fail("prepared_snapshot_invalid");
    for (const row of value[table]) {
      const columns = READONLY_TABLE_COLUMNS[table];
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== columns.length
      )
        fail("prepared_snapshot_invalid");
      for (const column of columns) {
        if (
          !Object.hasOwn(row, column) ||
          !(
            row[column] === null ||
            typeof row[column] === "string" ||
            typeof row[column] === "number"
          )
        )
          fail("prepared_snapshot_invalid");
      }
    }
  }
  return value;
}
async function schemaStatus(t) {
  await t.identity();
  const added = await t.query(preparedSchemaSql);
  schemaRows(added);
  compareSchema(added, SCHEMAS.added, true);
  const whole = await t.query(READONLY_DATABASE_SCHEMA_SQL),
    layout = schemaLayout(added, whole),
    old = whole.filter((row) => !row.name.startsWith("shelf_prepared_"));
  const groups =
    layout.storageLayout === "activation-v2"
      ? [...READONLY_LEGACY_SNAPSHOT_GROUPS, READONLY_ACTIVATION_TABLES]
      : READONLY_LEGACY_SNAPSHOT_GROUPS;
  // Extend only the exact complete activation profile's read-only schema budget.
  if (layout.storageLayout === "activation-v2")
    t.budget = preparedSchemaBudgets(layout.storageLayout, "schema-status");
  const fingerprints = [];
  for (const [number, group] of groups.entries()) {
    const result = await t.query(readonlySnapshotSql(group)),
      value = snapshotValue(result, group);
    if (number === 0) {
      let a;
      try {
        a = value.shelf_storage_authority;
      } catch {
        fail("prepared_snapshot_invalid");
      }
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        !same(JSON.parse(a[0].identity_json), t.context.identity)
      )
        fail("prepared_identity_mismatch");
    }
    fingerprints.push(hash(result[0].snapshot));
  }
  return {
    ...layout,
    schemaSha256: PREPARED_SCHEMA_SHA256,
    added,
    oldSchemaSha256: hash(stable(old)),
    wholeSchemaSha256: hash(stable(whole)),
    snapshotGroups: groups.length,
    fingerprints,
    complete: added.length === 13,
  };
}
async function applySchema(t, log) {
  const before = await schemaStatus(t);
  await log.write(`schema-before-${randomUUID()}`, before);
  if (before.storageLayout === "activation-v2") {
    await log.write(`schema-apply-disabled-${randomUUID()}`, {
      status: "disabled",
      code: "prepared_schema_apply_v2_disabled",
      databaseProfile: before.databaseProfile,
      counts: { ...t.counts },
      puts: 0,
    });
    fail("prepared_schema_apply_v2_disabled");
  }
  for (const definition of SCHEMAS.added) {
    const exists = before.added.some((v) => v.name === definition.name),
      intent = await log.read(`write-ddl-${definition.name}-intent`);
    if (exists) continue;
    if (intent) fail("prepared_write_outcome_unknown");
    await t.query(definition.sql, [], `ddl-${definition.name}`, true, true);
  }
  const after = await schemaStatus(t);
  if (
    !after.complete ||
    after.oldSchemaSha256 !== before.oldSchemaSha256 ||
    !same(after.fingerprints, before.fingerprints)
  )
    fail("prepared_schema_preservation_failed");
  await log.write(`schema-after-${randomUUID()}`, after);
  return after;
}
// Every fact used for publication comes from one primary statement, independent
// of the prepared view (which deliberately excludes unfinished publications).
const sourceSql = `SELECT t.logical_key,t.reservation_id,t.descriptor_json,t.etag,
 a.identity_json,o.descriptor_json AS original_descriptor_json,o.etag AS original_etag,
 f.object_key AS original_object_key,f.sha256 AS original_sha256,f.size_bytes AS original_size_bytes,
 f.format AS original_format,f.version AS original_version,b.public_json AS original_catalog_json,
 COALESCE(m.version,0) AS management_version
 FROM shelf_storage_text_registry t
 JOIN shelf_storage_reservations r ON r.reservation_id=t.reservation_id AND r.state='confirmed' AND r.content_verified=1 AND r.descriptor_json=t.descriptor_json AND r.etag=t.etag
 JOIN shelf_storage_original_registry o ON o.enabled=1
 JOIN shelf_storage_reservations original ON original.reservation_id=o.reservation_id AND original.state='confirmed' AND original.content_verified=1 AND original.descriptor_json=o.descriptor_json AND original.etag=o.etag
 JOIN file_registry f ON f.scope='production' AND f.file_id=? AND f.state='confirmed'
 JOIN catalog_books b ON b.scope=f.scope AND b.book_id=f.book_id
 JOIN shelf_storage_authority a ON a.id=1
 LEFT JOIN book_management m ON m.scope=f.scope AND m.book_id=f.book_id
 WHERE t.logical_key=? AND t.enabled=1 AND COALESCE(m.trashed,0)=0
 AND json_extract(o.descriptor_json,'$.kind')='original' AND json_extract(o.descriptor_json,'$.scope')=f.scope
 AND json_extract(o.descriptor_json,'$.fileId')=f.file_id AND json_extract(o.descriptor_json,'$.bookId')=f.book_id
 AND json_extract(o.descriptor_json,'$.objectKey')=f.object_key AND o.etag=f.etag
 AND json_extract(o.descriptor_json,'$.sha256')=f.sha256 AND json_extract(o.descriptor_json,'$.format')=f.format
 AND json_extract(o.descriptor_json,'$.sizeBytes')=f.size_bytes
 AND EXISTS(SELECT 1 FROM json_each(b.public_json,'$.files') j WHERE json_extract(j.value,'$.id')=f.file_id
 AND json_extract(j.value,'$.format')=f.format AND json_extract(j.value,'$.sizeBytes')=f.size_bytes AND json_extract(j.value,'$.status')='candidate') LIMIT 2`;
const tupleParams = (plan) => [
  "production",
  plan.descriptor.fileId,
  plan.descriptor.versionHash,
];
const headerSql = `SELECT i.*,(SELECT json_object('scope',p.scope,'file_id',p.file_id,'version_hash',p.version_hash,'index_sha256',p.index_sha256,'chunk_count',p.chunk_count,'text_bytes',p.text_bytes,'codepoint_count',p.codepoint_count) FROM shelf_prepared_index_publications p WHERE p.scope=i.scope AND p.file_id=i.file_id AND p.version_hash=i.version_hash) AS publication_json,(SELECT count(*) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash) AS actual_chunk_count FROM shelf_prepared_indexes i WHERE scope=? AND file_id=? AND version_hash=? LIMIT 2`;
const chunksSql =
  "SELECT chunk_index,locator_type,section_number,start_offset,end_offset,chunk_sha256,codepoints,utf8_bytes FROM shelf_prepared_index_chunks WHERE scope=? AND file_id=? AND version_hash=? ORDER BY chunk_index LIMIT 1000 OFFSET ?";
async function source(t, plan) {
  const d = plan.descriptor,
    rows = await t.query(sourceSql, [
      d.fileId,
      `prepared-text:production:${d.fileId}:${d.versionHash}`,
    ]);
  if (rows.length !== 1) fail("prepared_source_unavailable");
  const row = rows[0];
  let descriptor, original, identity;
  try {
    descriptor = objectDescriptor(JSON.parse(row.descriptor_json));
    original = objectDescriptor(JSON.parse(row.original_descriptor_json));
    identity = JSON.parse(row.identity_json);
  } catch {
    fail("prepared_source_invalid");
  }
  if (
    !same(descriptor, d) ||
    !same(identity, plan.identity) ||
    (row.etag !== plan.header.etag && plan.header.etag !== null) ||
    original.kind !== "original" ||
    original.scope !== "production" ||
    original.fileId !== d.fileId ||
    original.bookId !== d.bookId ||
    original.format !== d.source.format ||
    original.sizeBytes !== d.source.sizeBytes ||
    original.sha256 !== d.source.sourceSha256 ||
    row.original_sha256 !== d.source.sourceSha256 ||
    !Number.isSafeInteger(row.original_version) ||
    row.original_version < 1 ||
    !Number.isSafeInteger(row.management_version) ||
    row.management_version < 0 ||
    typeof row.etag !== "string" ||
    !row.etag ||
    row.etag.length > 128
  )
    fail("prepared_source_invalid");
  return row;
}
function headerFor(plan, snapshot) {
  return {
    ...plan.header,
    text_reservation_id: snapshot.reservation_id,
    text_logical_key: snapshot.logical_key,
    etag: snapshot.etag,
  };
}
const publicationFor = (header) =>
  Object.fromEntries(
    [
      "scope",
      "file_id",
      "version_hash",
      "index_sha256",
      "chunk_count",
      "text_bytes",
      "codepoint_count",
    ].map((k) => [k, header[k]]),
  );
function one(rows) {
  if (rows.length > 1) fail("prepared_index_conflict");
  return rows[0] ?? null;
}
async function rowsFor(t, plan, header, partial) {
  if (!header) return [];
  if (
    !Number.isSafeInteger(header.actual_chunk_count) ||
    header.actual_chunk_count < 0 ||
    header.actual_chunk_count > plan.index.chunkCount
  )
    fail("prepared_index_conflict");
  const rows = [];
  // Always use C's fixed page count when nonempty, including partial staging, so
  // an adversarial extra index cannot hide past a short first page.
  if (header.actual_chunk_count) {
    for (let offset = 0; offset < plan.index.chunkCount; offset += 1000) {
      const page = await t.query(chunksSql, [...tupleParams(plan), offset]);
      if (page.length > 1000) fail("prepared_index_conflict");
      rows.push(...page);
    }
  }
  if (
    rows.length !== header.actual_chunk_count ||
    (!partial && rows.length !== plan.index.chunkCount)
  )
    fail("prepared_index_incomplete");
  const seen = new Set();
  let previous = -1;
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.chunk_index) ||
      row.chunk_index < 0 ||
      row.chunk_index >= plan.index.chunkCount ||
      row.chunk_index <= previous ||
      seen.has(row.chunk_index) ||
      !same(row, preparedChunkRow(plan.index.chunks[row.chunk_index]))
    )
      fail("prepared_index_mismatch");
    seen.add(row.chunk_index);
    previous = row.chunk_index;
  }
  return rows;
}
async function indexState(t, plan, { readRows = true, partial = true } = {}) {
  const s = await source(t, plan),
    h = one(await t.query(headerSql, tupleParams(plan))),
    p = h?.publication_json ? JSON.parse(h.publication_json) : null;
  const expected = headerFor(plan, s);
  if (h) {
    const { actual_chunk_count, publication_json, ...actual } = h;
    if (!same(actual, expected)) fail("prepared_index_conflict");
  }
  if (p && (!h || !same(p, publicationFor(expected))))
    fail("prepared_index_conflict");
  const rows = readRows ? await rowsFor(t, plan, h, partial && !p) : [];
  return { source: s, header: h, publication: p, rows };
}
async function objectRound(t, plan, store, expectedEtag) {
  const d = plan.descriptor;
  const before = await store.head(d.objectKey);
  const bare = (value) =>
    typeof value === "string" ? value.replace(/^"|"$/g, "") : null;
  if (!before || bare(before.etag) !== bare(expectedEtag))
    fail("prepared_object_changed");
  const stream = await store.get(d.objectKey, {
    maxBytes: d.sizeBytes,
    ifMatch: before.etag,
  });
  const reader = stream.getReader(),
    parts = [];
  let blocks = 0,
    size = 0,
    done = false,
    timer;
  const reading = (async () => {
    for (;;) {
      const v = await reader.read();
      if (v.done) {
        done = true;
        break;
      }
      if (
        !(v.value instanceof Uint8Array) ||
        ++blocks > 65536 ||
        (size += v.value.length) > d.sizeBytes
      )
        fail("prepared_object_limit");
      parts.push(Buffer.from(v.value));
    }
    return Buffer.concat(parts, size);
  })();
  let bytes;
  try {
    bytes = await Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancel(reader);
          reject(new PreparedOperatorError("prepared_object_unknown"));
        }, 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!done) cancel(reader);
    try {
      reader.releaseLock();
    } catch {}
  }
  await validateObjectBytes(d, bytes);
  const value = await validatePreparedText(bytes, d.source),
    index = await buildPreparedIndex(value);
  if (!same(index, plan.index)) fail("prepared_index_mismatch");
  const after = await store.head(d.objectKey);
  if (!same(before, after)) fail("prepared_object_changed");
}
const headerColumns = [
  "scope",
  "file_id",
  "version_hash",
  "book_id",
  "text_reservation_id",
  "text_logical_key",
  "package_sha256",
  "source_sha256",
  "etag",
  "format",
  "chunk_count",
  "text_bytes",
  "codepoint_count",
  "index_sha256",
  "created_at",
];
const insertHeaderSql = `INSERT INTO shelf_prepared_indexes(scope,file_id,version_hash,book_id,text_reservation_id,text_logical_key,package_sha256,source_sha256,etag,format,chunk_count,text_bytes,codepoint_count,index_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const insertChunksSql = `INSERT INTO shelf_prepared_index_chunks(scope,file_id,version_hash,chunk_index,locator_type,section_number,start_offset,end_offset,chunk_sha256,codepoints,utf8_bytes)
 SELECT ?,?,?,json_extract(value,'$.chunk_index'),json_extract(value,'$.locator_type'),json_extract(value,'$.section_number'),json_extract(value,'$.start_offset'),json_extract(value,'$.end_offset'),json_extract(value,'$.chunk_sha256'),json_extract(value,'$.codepoints'),json_extract(value,'$.utf8_bytes') FROM json_each(?)`;
const insertPublicationSql = `INSERT INTO shelf_prepared_index_publications(scope,file_id,version_hash,index_sha256,chunk_count,text_bytes,codepoint_count) VALUES(?,?,?,?,?,?,?)`;
async function publish(t, plan, log, store) {
  await t.identity();
  compareSchema(await t.query(preparedSchemaSql), SCHEMAS.added);
  const initial = await indexState(t, plan, { readRows: false });
  await objectRound(t, plan, store, initial.source.etag);
  const expected = headerFor(plan, initial.source);
  // An existing header must retain its original creation time through the frozen plan.
  if (!initial.header) {
    if (await log.read("write-header-intent"))
      fail("prepared_write_outcome_unknown");
    await t.query(
      insertHeaderSql,
      headerColumns.map((key) => expected[key]),
      "header",
      true,
    );
  }
  const existing = await rowsFor(t, plan, initial.header, true),
    existingIds = new Set(existing.map((r) => r.chunk_index));
  if (initial.publication) {
    if (existing.length !== plan.index.chunkCount)
      fail("prepared_index_incomplete");
  } else
    for (let offset = 0; offset < plan.index.chunkCount; offset += 100) {
      const batch = plan.index.chunks
          .slice(offset, offset + 100)
          .map(preparedChunkRow),
        present = batch.filter((c) => existingIds.has(c.chunk_index)).length;
      if (present === batch.length) continue;
      if (present !== 0) fail("prepared_partial_batch");
      if (await log.read(`write-chunks-${offset}-intent`))
        fail("prepared_write_outcome_unknown");
      const json = JSON.stringify(batch);
      if (Buffer.byteLength(json) > 65536) fail("prepared_parameter_limit");
      await t.query(
        insertChunksSql,
        [...tupleParams(plan), json],
        `chunks-${offset}`,
        true,
      );
    }
  // Independently read every row after inserts before publishing, even if all
  // response envelopes were known. The count comes from a fresh header read.
  const checkHeader = one(await t.query(headerSql, tupleParams(plan)));
  if (!checkHeader) fail("prepared_index_incomplete");
  await rowsFor(t, plan, checkHeader, false);
  const current = await source(t, plan);
  if (!same(current, initial.source)) fail("prepared_source_changed");
  if (!initial.publication) {
    if (await log.read("write-publication-intent"))
      fail("prepared_write_outcome_unknown");
    await t.query(
      insertPublicationSql,
      Object.values(publicationFor(expected)),
      "publication",
      true,
    );
  }
  const final = await indexState(t, plan, { partial: false });
  if (!final.publication || !same(final.source, initial.source))
    fail("prepared_source_changed");
  await objectRound(t, plan, store, final.source.etag);
  if (!same(await source(t, plan), initial.source))
    fail("prepared_source_changed");
  await log.write(`published-${randomUUID()}`, {
    status: "published",
    indexSha256: plan.index.indexSha256,
    counts: t.counts,
  });
  return { status: "published", counts: t.counts };
}
async function makePlan(local, identity, createdAt = Date.now()) {
  const descriptor = objectDescriptor(local.descriptor),
    bytes = local.bytes;
  await validateObjectBytes(descriptor, bytes);
  const value = await validatePreparedText(bytes, descriptor.source),
    index = await buildPreparedIndex(value);
  return {
    schemaVersion: 1,
    schemaSha256: PREPARED_SCHEMA_SHA256,
    identity,
    descriptor,
    index,
    budgets: preparedBudgets(index.chunkCount),
    header: {
      scope: "production",
      file_id: descriptor.fileId,
      version_hash: descriptor.versionHash,
      book_id: descriptor.bookId,
      text_reservation_id: null,
      text_logical_key: null,
      package_sha256: descriptor.sha256,
      source_sha256: descriptor.source.sourceSha256,
      etag: null,
      format: descriptor.source.format,
      chunk_count: index.chunkCount,
      text_bytes: index.textBytes,
      codepoint_count: index.codepointCount,
      index_sha256: index.indexSha256,
      created_at: createdAt,
    },
  };
}
/** Dependencies are module-only for offline tests; CLI accepts no provider/target/path. */
export async function runPreparedIndex({
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = 30000,
  testing,
  ...input
} = {}) {
  const options = argumentsFor(input),
    { action, execute, fileId, versionHash, sha256 } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    fail("prepared_invalid_deadline");
  if (!execute)
    return {
      ...options,
      status: "preview",
      secretReads: 0,
      http: 0,
      ddl: 0,
      puts: 0,
      schemaSha256: PREPARED_SCHEMA_SHA256,
      budgets: action.startsWith("schema-")
        ? {
            http: action === "schema-apply" ? 33 : 10,
            ddl: action === "schema-apply" ? 13 : 0,
          }
        : null,
      ...(action.startsWith("schema-")
        ? {
            schemaLayoutBudgets: {
              "trial-v1": preparedSchemaBudgets("trial-v1", action),
              "activation-v2": {
                ...preparedSchemaBudgets("activation-v2", action),
                applyAllowed: false,
              },
            },
          }
        : {}),
    };
  const loadLocal = testing?.loadLocal ?? loadSelectedLocalObject;
  if (action === "plan") {
    // Explicit local-only plan reads the project's private source/pin files; no
    // cloud credentials are loaded through loadMigrationContext and no HTTP runs.
    const local = await loadLocal(root, environment, {
      profile: "production",
      fileId,
      kind: "prepared-text",
      versionHash,
      sha256,
    });
    const plan = await makePlan(local, null);
    return {
      status: "planned-local",
      fileId,
      versionHash,
      sha256,
      chunks: plan.index.chunkCount,
      budgets: plan.budgets,
      http: 0,
      ddl: 0,
      puts: 0,
    };
  }
  const context = await (testing?.loadContext ?? loadMigrationContext)({
    root,
    environment,
  });
  if (
    context.root !== path.resolve(root) ||
    context.identity.accountId !== context.credentials.accountId ||
    context.identity.bucket !== "the-shelf-books" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      context.identity.legacyDatabases.production,
    ) ||
    context.resources.profiles.production.databaseId !==
      context.identity.legacyDatabases.production
  )
    fail("prepared_identity_mismatch");
  root = context.root;
  if (action.startsWith("schema-")) {
    const directory = await privateDirectory(root, [
      "schema",
      PREPARED_SCHEMA_SHA256,
    ]);
    await claim(root, directory, {
      schemaVersion: 1,
      identity: context.identity,
      schemaSha256: PREPARED_SCHEMA_SHA256,
    });
    const log = journal(root, directory),
      t = new Transport(
        context,
        log,
        fetchImpl,
        {
          http: action === "schema-apply" ? 33 : 10,
          ddl: action === "schema-apply" ? 13 : 0,
        },
        timeoutMs,
      );
    const result =
      action === "schema-apply"
        ? await applySchema(t, log)
        : await schemaStatus(t);
    await log.write(`status-${randomUUID()}`, result);
    return {
      status: result.complete ? "installed" : "incomplete",
      schemaSha256: PREPARED_SCHEMA_SHA256,
      objects: result.added.length,
      storageLayout: result.storageLayout,
      databaseProfile: result.databaseProfile,
      schemaCompatibility: result.schemaCompatibility,
      snapshotGroups: result.snapshotGroups,
      counts: t.counts,
      puts: 0,
    };
  }
  const tuple = { identity: context.identity, fileId, versionHash, sha256 },
    directory = await privateDirectory(root, ["indexes", hash(stable(tuple))]);
  let plan = await readOptional(root, path.join(directory, "plan.json"));
  if (plan) {
    if (
      plan.schemaSha256 !== PREPARED_SCHEMA_SHA256 ||
      !same(plan.identity, context.identity) ||
      plan.descriptor.fileId !== fileId ||
      plan.descriptor.versionHash !== versionHash ||
      plan.descriptor.sha256 !== sha256
    )
      fail("prepared_plan_conflict");
    // Recovery deliberately never reloads today's pins or redefines the source.
  } else {
    if (action === "index-status") fail("prepared_plan_missing");
    const local = await loadLocal(root, environment, {
      profile: "production",
      fileId,
      kind: "prepared-text",
      versionHash,
      sha256,
    });
    plan = await claim(
      root,
      directory,
      await makePlan(local, context.identity),
    );
  }
  if (
    !same(plan.budgets, preparedBudgets(plan.index.chunkCount)) ||
    plan.index.fileId !== fileId ||
    plan.index.versionHash !== versionHash ||
    plan.index.bookId !== plan.descriptor.bookId ||
    plan.header.package_sha256 !== sha256 ||
    plan.header.index_sha256 !== plan.index.indexSha256 ||
    plan.header.chunk_count !== plan.index.chunkCount
  )
    fail("prepared_plan_conflict");
  const log = journal(root, directory),
    resume = Boolean(await log.read("write-header-intent"));
  const budget =
    action === "index-status"
      ? plan.budgets.indexStatus
      : resume
        ? plan.budgets.indexResume
        : plan.budgets.indexPublish;
  const t = new Transport(context, log, fetchImpl, budget, timeoutMs);
  t.descriptor = plan.descriptor;
  const store = (testing?.createStore ?? createR2ObjectStore)({
    accountId: context.identity.accountId,
    bucket: context.identity.bucket,
    accessKeyId: context.fileEnvironment.SHELF_R2_ACCESS_KEY_ID,
    secretAccessKey: context.fileEnvironment.SHELF_R2_SECRET_ACCESS_KEY,
    descriptors: [plan.descriptor],
    fetchImpl: (...args) => t.r2(...args),
    timeoutMs,
  });
  if (action === "index-publish")
    return { ...(await publish(t, plan, log, store)), puts: 0 };
  await t.identity();
  compareSchema(await t.query(preparedSchemaSql), SCHEMAS.added);
  const state = await indexState(t, plan);
  await objectRound(t, plan, store, state.source.etag);
  if (!same(await source(t, plan), state.source))
    fail("prepared_source_changed");
  await log.write(`status-${randomUUID()}`, { state, counts: t.counts });
  return {
    status: state.publication
      ? "published"
      : state.header
        ? "staged"
        : "absent",
    chunks: state.rows.length,
    counts: t.counts,
    puts: 0,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        await runPreparedIndex(parsePreparedIndexArgs(process.argv.slice(2))),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ error: { code: safeCode(error) } }));
    process.exitCode = 1;
  }
}
