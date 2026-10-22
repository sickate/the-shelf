// Fixed-target, read-only cloud inventory. No SQL/URL/profile override or cloud write action.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PROFILES,
  readProjectEnvironment,
  validateDeployConfig,
} from "./cf-api-deploy.mjs";
import { readPrivateJson, writePrivateJson } from "./cf-library-data.mjs";
import { getConfig } from "../server/config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PREFLIGHT_REQUEST_LIMIT = 18;
const RESPONSE_LIMIT = 1_000_000;
const TABLES = [
  "storage_state",
  "upload_reservations",
  "file_registry",
  "auth_config",
  "catalog_books",
  "library_schema",
];
const STORAGE_TABLES = TABLES.slice(0, 3);
const schemaSql = `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (type='table' AND name IN ('storage_state','upload_reservations','file_registry','auth_config','catalog_books','library_schema')) OR (type='trigger' AND tbl_name IN ('storage_state','upload_reservations','file_registry')) ORDER BY type,name LIMIT 65`;
const hash = (v) => createHash("sha256").update(v).digest("hex");
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const record = (v) => v && typeof v === "object" && !Array.isArray(v);
export class PreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreflightError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new PreflightError(code);
};

const cancel = (target) => {
  try {
    void target?.cancel().catch(() => {});
  } catch {
    /* Cleanup cannot delay the request deadline. */
  }
};
async function boundedJson(response, signal) {
  const advertised = response.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) > RESPONSE_LIMIT)
  )
    fail("preflight_response_limit");
  if (!response.body) fail("preflight_response_invalid");
  const reader = response.body.getReader(),
    chunks = [];
  const aborted = () => cancel(reader);
  signal.addEventListener("abort", aborted, { once: true });
  let size = 0,
    count = 0,
    finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) fail("preflight_deadline");
      if (done) {
        finished = true;
        break;
      }
      if (
        !(value instanceof Uint8Array) ||
        ++count > 10000 ||
        (size += value.length) > RESPONSE_LIMIT
      )
        fail("preflight_response_limit");
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } catch {
      fail("preflight_response_invalid");
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    if (!finished) cancel(reader);
    try {
      reader.releaseLock();
    } catch {
      /* A timed out read may still be pending. */
    }
  }
}

async function optionalPrivate(filename, root) {
  try {
    const stat = await fs.lstat(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600
    )
      fail("preflight_local_file_unsafe");
    return { state: "present", value: await readPrivateJson(filename, root) };
  } catch (e) {
    if (e.code === "ENOENT") return { state: "absent" };
    throw e;
  }
}

// Shared read-only check for the fixed migration operator; callers must provide
// the effective project environment, including the private .env overrides.
export async function localInventory(root, env) {
  const config = getConfig(env, root),
    privateRoot = path.join(root, ".local");
  for (const p of [config.manifestPath, config.stateDir]) {
    const relative = path.relative(privateRoot, p);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      fail("preflight_configured_path_outside_private");
  }
  // Validate the actual configured state directory, including every ancestor.
  let current = privateRoot;
  for (const segment of [
    "",
    ...path
      .relative(privateRoot, config.stateDir)
      .split(path.sep)
      .filter(Boolean),
  ]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700
    )
      fail("preflight_local_directory_unsafe");
  }
  const manifest = await optionalPrivate(config.manifestPath, root),
    ledgerPath = path.join(config.stateDir, "upload-reservations.json");
  const ledger = await optionalPrivate(ledgerPath, root);
  let lockState = "absent";
  try {
    const st = await fs.lstat(path.join(config.stateDir, "upload.lock"));
    lockState =
      st.isFile() &&
      !st.isSymbolicLink() &&
      st.nlink === 1 &&
      (st.mode & 0o777) === 0o600
        ? "present"
        : "unsafe";
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let files = null,
    registered = null,
    reserved = null;
  if (manifest.state === "present") {
    if (!record(manifest.value.files)) fail("preflight_local_manifest_invalid");
    files = Object.keys(manifest.value.files).length;
    if (
      files > 100000 ||
      Object.values(manifest.value.files).some((v) => !record(v))
    )
      fail("preflight_local_manifest_invalid");
    registered = Object.values(manifest.value.files).filter(
      (v) =>
        Object.hasOwn(v, "storageKey") &&
        v.storageKey !== null &&
        v.storageKey !== "",
    ).length;
  }
  if (ledger.state === "present") {
    if (!record(ledger.value) || Object.keys(ledger.value).length > 100000)
      fail("preflight_local_ledger_invalid");
    reserved = Object.keys(ledger.value).length;
  }
  return {
    manifest: {
      path: path.relative(root, config.manifestPath),
      state: manifest.state,
      files,
      registered,
      sha256:
        manifest.state === "present"
          ? hash(JSON.stringify(manifest.value))
          : null,
    },
    reservations: {
      path: path.relative(root, ledgerPath),
      state: ledger.state,
      count: reserved,
      sha256:
        ledger.state === "present" ? hash(JSON.stringify(ledger.value)) : null,
    },
    lock: {
      path: path.relative(root, path.join(config.stateDir, "upload.lock")),
      state: lockState,
    },
    legacyLocalEmpty:
      manifest.state === "present" &&
      registered === 0 &&
      (ledger.state === "absent" || reserved === 0) &&
      lockState === "absent",
    // No process inventory, freeze or object existence claim is made by this read-only probe.
    writesStoppedProven: false,
  };
}

function stateRows(rows, states) {
  if (rows.length > 12) fail("preflight_rows_invalid");
  return rows.map((r) => {
    if (
      !record(r) ||
      !["check", "production"].includes(r.scope) ||
      !states.includes(r.state) ||
      !integer(r.count) ||
      !integer(r.bytes)
    )
      fail("preflight_rows_invalid");
    return { scope: r.scope, state: r.state, count: r.count, bytes: r.bytes };
  });
}

export async function runStoragePreflight({
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  clock = Date.now,
  requestTimeoutMs = 30_000,
} = {}) {
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30_000
  )
    fail("preflight_invalid_deadline");
  root = await fs.realpath(root);
  const loaded = await readProjectEnvironment(root, environment);
  if (
    loaded.credentials.ci ||
    loaded.fileEnvironment.SHELF_R2_ACCOUNT_ID !== loaded.credentials.accountId
  )
    fail("preflight_project_account_required");
  const resources = validateDeployConfig(
    await readPrivateJson(path.join(root, ".local/cf03/deploy.json"), root),
  );
  const local = await localInventory(root, {
    ...loaded.fileEnvironment,
    ...environment,
  });
  const filename = path.join(
    root,
    `.local/cf03/storage-preflight-${randomUUID()}.json`,
  );
  const receipt = {
    schemaVersion: 1,
    kind: "storage-read-only-preflight",
    observedAt: new Date(clock()).toISOString(),
    accountId: loaded.credentials.accountId,
    resources,
    requestLimit: PREFLIGHT_REQUEST_LIMIT,
    responseLimitBytes: RESPONSE_LIMIT,
    requests: [],
    status: "planned",
    local,
    databases: {},
    workers: {},
    cloudWriteFreezeProven: false,
    migrationComplete: false,
    uploadAllowed: false,
  };
  const save = async () => {
    await writePrivateJson(filename, receipt, root);
    const directory = await fs.open(path.dirname(filename), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  await save(); // Persist the fixed budget before the first remote request.
  const base = `https://api.cloudflare.com/client/v4/accounts/${loaded.credentials.accountId}`;
  const request = async (suffix, label, sql) => {
    if (receipt.requests.length >= PREFLIGHT_REQUEST_LIMIT)
      fail("preflight_request_budget");
    const item = {
      label,
      method: sql === undefined ? "GET" : "POST",
      state: "dispatched",
    };
    receipt.requests.push(item);
    await save(); // A crash consumes this request; the operator does not resume/retry it.
    let response, timer;
    const controller = new AbortController(),
      url = base + suffix;
    try {
      const attempt = (async () => {
        response = await fetchImpl(url, {
          method: item.method,
          headers: {
            authorization: `Bearer ${loaded.credentials.token}`,
            "content-type": "application/json",
          },
          ...(sql === undefined
            ? {}
            : { body: JSON.stringify({ sql, params: [] }) }),
          redirect: "error",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          cancel(response.body);
          fail("preflight_deadline");
        }
        if (
          response.redirected ||
          (response.url && response.url !== url) ||
          (response.status >= 300 && response.status < 400)
        ) {
          cancel(response.body);
          fail("preflight_redirect_rejected");
        }
        if (response.status === 404 && label.startsWith("worker-")) {
          cancel(response.body);
          return null;
        }
        if (!response.ok) {
          cancel(response.body);
          fail("preflight_remote_rejected");
        }
        const data = await boundedJson(response, controller.signal);
        if (controller.signal.aborted) fail("preflight_deadline");
        if (data.success !== true) fail("preflight_remote_rejected");
        return data.result;
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          cancel(response?.body);
          reject(new PreflightError("preflight_deadline"));
        }, requestTimeoutMs);
      });
      const value = await Promise.race([attempt, deadline]);
      clearTimeout(timer);
      item.httpStatus = response.status;
      item.state = value === null ? "absent" : "observed";
      await save();
      return value;
    } catch (e) {
      controller.abort();
      cancel(response?.body);
      item.state =
        e instanceof PreflightError && e.code !== "preflight_deadline"
          ? "rejected"
          : "unknown";
      throw e instanceof PreflightError
        ? e
        : new PreflightError("preflight_transport_unknown");
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    for (const profile of ["check", "production"]) {
      const resource = resources.profiles[profile],
        suffix = `/d1/database/${resource.databaseId}`;
      const identity = await request(suffix, `${profile}-identity`);
      if (
        identity?.uuid !== resource.databaseId ||
        identity?.name !== resource.databaseName
      )
        fail("preflight_database_identity_mismatch");
      const query = async (sql, label) => {
        const results = await request(
          suffix + "/query",
          `${profile}-${label}`,
          sql,
        );
        if (
          !Array.isArray(results) ||
          results.length !== 1 ||
          results[0]?.success !== true ||
          !Array.isArray(results[0].results)
        )
          fail("preflight_d1_response_invalid");
        return results[0].results;
      };
      const schema = await query(schemaSql, "schema");
      if (
        schema.length >= 65 ||
        schema.some(
          (r) =>
            !["table", "trigger"].includes(r.type) ||
            !TABLES.includes(r.tbl_name) ||
            typeof r.name !== "string" ||
            r.name.length > 100 ||
            typeof r.sql !== "string" ||
            r.sql.length > 100000,
        )
      )
        fail("preflight_schema_invalid");
      const tables = schema
        .filter((r) => r.type === "table")
        .map((r) => r.name);
      const tableCounts = await query(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' AND name NOT IN ('_cf_KV','d1_migrations')",
        "table-count",
      );
      if (
        tableCounts.length !== 1 ||
        !integer(tableCounts[0].count) ||
        tableCounts[0].count < tables.length
      )
        fail("preflight_schema_invalid");
      const db = (receipt.databases[profile] = {
        identityVerified: true,
        sourceState:
          tableCounts[0].count === 0
            ? "empty-application-schema-observed"
            : tables.length === 0
              ? "unrecognized-schema"
              : "existing-schema",
        // This proves only an observed empty application schema; freeze proof is still absent.
        emptySourceProven: tableCounts[0].count === 0,
        applicationTableCount: tableCounts[0].count,
        schema: schema.map((r) => ({
          type: r.type,
          name: r.name,
          table: r.tbl_name,
          sqlSha256: hash(r.sql),
        })),
        storageState: null,
        reservations: null,
        registry: null,
        auth: null,
      });
      if (tables.includes("storage_state")) {
        const rows = await query(
          "SELECT id,account_id,observed_account_bytes,observed_at,ceiling_bytes,reserved_bytes,committed_bytes,evidence_hash,evidence_complete,updated_at FROM storage_state ORDER BY id LIMIT 2",
          "ledger",
        );
        if (rows.length > 1) fail("preflight_ledger_invalid");
        db.storageState = rows.map((r) => {
          const validHash =
            typeof r.evidence_hash === "string" &&
            /^[a-f0-9]{64}$/.test(r.evidence_hash);
          if (
            r.id !== 1 ||
            r.account_id !== loaded.credentials.accountId ||
            ![
              r.observed_account_bytes,
              r.observed_at,
              r.ceiling_bytes,
              r.reserved_bytes,
              r.committed_bytes,
              r.updated_at,
            ].every(integer) ||
            r.ceiling_bytes < 1 ||
            r.ceiling_bytes > 8_000_000_000 ||
            ![0, 1].includes(r.evidence_complete) ||
            (r.evidence_complete === 1 && !validHash)
          )
            fail("preflight_ledger_invalid");
          return {
            id: 1,
            accountMatch: true,
            observedBytes: r.observed_account_bytes,
            observedAt: r.observed_at,
            ceilingBytes: r.ceiling_bytes,
            reservedBytes: r.reserved_bytes,
            committedBytes: r.committed_bytes,
            evidenceHash: validHash ? r.evidence_hash : null,
            evidenceComplete: r.evidence_complete,
            updatedAt: r.updated_at,
          };
        });
      }
      if (tables.includes("upload_reservations"))
        db.reservations = stateRows(
          await query(
            "SELECT scope,state,COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM upload_reservations GROUP BY scope,state ORDER BY scope,state LIMIT 13",
            "reservations",
          ),
          ["reserved", "uploading", "uncertain", "confirmed", "aborted"],
        );
      if (tables.includes("file_registry"))
        db.registry = stateRows(
          await query(
            "SELECT scope,state,COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM file_registry GROUP BY scope,state ORDER BY scope,state LIMIT 13",
            "registry",
          ),
          ["reserved", "uploading", "uncertain", "confirmed", "disabled"],
        );
      if (tables.includes("auth_config")) {
        const rows = await query(
          "SELECT scope,COUNT(*) AS count,SUM(enabled) AS enabled_count,MIN(generation) AS min_generation,MAX(generation) AS max_generation FROM auth_config GROUP BY scope ORDER BY scope LIMIT 3",
          "auth",
        );
        if (rows.length > 2) fail("preflight_auth_invalid");
        db.auth = rows.map((r) => {
          if (
            !["check", "production"].includes(r.scope) ||
            r.count !== 1 ||
            ![0, 1].includes(r.enabled_count) ||
            !integer(r.min_generation) ||
            r.min_generation < 1 ||
            r.max_generation !== r.min_generation
          )
            fail("preflight_auth_invalid");
          return {
            scope: r.scope,
            count: r.count,
            enabledCount: r.enabled_count,
            generation: r.min_generation,
          };
        });
      }
      await save();
    }
    for (const profile of ["check", "production"]) {
      const suffix = `/workers/scripts/${PROFILES[profile].name}`;
      const settings = await request(
        suffix + "/settings",
        `worker-${profile}-settings`,
      );
      if (settings === null) {
        receipt.workers[profile] = { state: "absent" };
        continue;
      }
      if (!Array.isArray(settings.bindings) || settings.bindings.length > 32)
        fail("preflight_worker_invalid");
      const bindings = settings.bindings.map((b) => {
        if (typeof b.name !== "string" || typeof b.type !== "string")
          fail("preflight_worker_invalid");
        if (
          b.type === "d1" &&
          (b.name !== "DB" || b.id !== resources.profiles[profile].databaseId)
        )
          fail("preflight_worker_target_mismatch");
        if (
          b.type === "r2_bucket" &&
          (b.name !== "BOOKS" || b.bucket_name !== "the-shelf-books")
        )
          fail("preflight_worker_target_mismatch");
        return {
          name: b.name,
          type: b.type,
          ...(b.type === "d1" || b.type === "r2_bucket"
            ? { targetMatch: true }
            : {}),
        };
      });
      const subdomain = await request(
        suffix + "/subdomain",
        `worker-${profile}-subdomain`,
      );
      if (
        subdomain !== null &&
        (typeof subdomain.enabled !== "boolean" ||
          typeof subdomain.previews_enabled !== "boolean")
      )
        fail("preflight_worker_invalid");
      receipt.workers[profile] = {
        state: "present",
        bindings,
        workersDev: subdomain?.enabled ?? null,
        previews: subdomain?.previews_enabled ?? null,
      };
      await save();
    }
    receipt.status = "observed";
    await save();
    return {
      status: "observed",
      requests: receipt.requests.length,
      requestLimit: PREFLIGHT_REQUEST_LIMIT,
      privateReceipt: path.relative(root, filename),
      uploadAllowed: false,
      legacyLocalEmpty: local.legacyLocalEmpty,
      databases: Object.fromEntries(
        Object.entries(receipt.databases).map(([k, d]) => [
          k,
          {
            identityVerified: true,
            sourceState: d.sourceState,
            emptySourceProven: d.emptySourceProven,
            reservationRows:
              d.reservations?.reduce((n, r) => n + r.count, 0) ?? null,
            registryRows: d.registry?.reduce((n, r) => n + r.count, 0) ?? null,
            enabledAuthRows:
              d.auth?.reduce((n, r) => n + r.enabledCount, 0) ?? null,
          },
        ]),
      ),
    };
  } catch (e) {
    receipt.status = "incomplete";
    receipt.errorCode =
      e instanceof PreflightError ? e.code : "preflight_unknown";
    await save();
    throw new PreflightError(receipt.errorCode);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2) fail("preflight_no_arguments");
    console.log(JSON.stringify(await runStoragePreflight()));
  } catch (e) {
    console.error(e instanceof PreflightError ? e.code : "preflight_failed");
    process.exitCode = 1;
  }
}
