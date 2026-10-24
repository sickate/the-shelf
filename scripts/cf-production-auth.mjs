// Fixed production auth lifecycle. No schema, deployment, secret or storage mutation.
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { selectCredentials } from "./cf-deploy.mjs";
import {
  PROFILES,
  validateDeployConfig,
  validateRemoteBindings,
} from "./cf-api-deploy.mjs";
import { createOwnerVerifier } from "../cloudflare/library/security.mjs";
import {
  validateSingleTrialTarget,
  SINGLE_TRIAL_TARGET_PATH,
  SINGLE_TRIAL_SECRET_PATH,
} from "./single-trial-config.mjs";

import {
  storageDeploymentContract,
  validateRemoteStorageBindings,
} from "../shared/storage-deployment-contract.mjs";
import {
  STORAGE_DEPLOY_GUARD_SQL,
  STORAGE_DEPLOY_GUARD_JSON_SQL,
  validateStorageDeployGuard,
} from "./storage-deploy-guard.mjs";

import {
  ISOLATED_CONSENT_PATH,
  validateIsolatedConsent,
  ISOLATED_DEPLOY_SQL,
  ISOLATED_DEPLOY_JSON_SQL,
  validateIsolatedDeployRows,
} from "./isolated-upload.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const POLICY = PROFILES.production;
export const AUTH_LIMITS = Object.freeze({
  status: 3,
  "initialize-disabled": 4,
  enable: 12,
  close: 4,
  responseBytes: 1_000_000,
  deadlineMs: 30_000,
  chunks: 4096,
  sqlBytes: 16_384,
  parameters: 6,
});
const FIELDS = "scope,origin,scheme,generation,enabled,updated_at";
export const AUTH_SQL = Object.freeze({
  schema:
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (type='table' AND name IN ('auth_config','sessions')) OR (type='trigger' AND tbl_name IN ('auth_config','sessions')) ORDER BY type,name LIMIT 33",
  status: `SELECT ${FIELDS},verifier=? AS verifier_match,(SELECT count(*) FROM sessions WHERE scope='production' AND revoked=0) AS unrevoked_sessions FROM auth_config WHERE scope='production' LIMIT 2`,
  initialize: `INSERT INTO auth_config(scope,origin,scheme,verifier,generation,enabled,updated_at) SELECT 'production',?,'owner-access-key-v1',?,1,0,? WHERE NOT EXISTS(SELECT 1 FROM auth_config WHERE scope='production') RETURNING ${FIELDS}`,
  enable: `UPDATE auth_config SET enabled=1,updated_at=? WHERE scope='production' AND origin=? AND scheme='owner-access-key-v1' AND verifier=? AND generation=? AND enabled=0 AND updated_at=? RETURNING ${FIELDS}`,
  close: `UPDATE auth_config SET enabled=0,generation=generation+1,updated_at=? WHERE scope='production' AND origin=? AND scheme='owner-access-key-v1' AND verifier=? AND generation=? AND enabled=? AND updated_at=? RETURNING ${FIELDS}`,
});
// One read statement, not a REST multi-statement batch. Keeping schema and auth
// in one bounded projection leaves room for an independent post-CAS HTTP read.
export const AUTH_PROBE_SQL = `SELECT
 (SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${AUTH_SQL.schema})) AS schema_json,
 (SELECT json_group_array(json_object('scope',scope,'origin',origin,'scheme',scheme,'generation',generation,'enabled',enabled,'updated_at',updated_at,'verifier_match',verifier=?,'unrevoked_sessions',(SELECT count(*) FROM sessions WHERE scope='production' AND revoked=0))) FROM (SELECT * FROM auth_config WHERE scope='production' LIMIT 2)) AS auth_json`;
// Nested fixed CTEs retain the one verifier bind in each combined probe.
export const AUTH_V2_PROBE_SQL = `WITH storage_guard AS MATERIALIZED (${STORAGE_DEPLOY_GUARD_SQL}), auth_probe AS MATERIALIZED (${AUTH_PROBE_SQL}) SELECT schema_json,auth_json,(SELECT ${STORAGE_DEPLOY_GUARD_JSON_SQL} FROM storage_guard) AS storage_guard_json FROM auth_probe`;
export const AUTH_V2_ENABLE_SQL = `WITH storage_guard AS MATERIALIZED (${STORAGE_DEPLOY_GUARD_SQL}) ${AUTH_SQL.enable.replace(" RETURNING ", ` AND (SELECT ${STORAGE_DEPLOY_GUARD_JSON_SQL} FROM storage_guard)=? RETURNING `)}`;
export const AUTH_ISOLATED_PROBE_SQL = `WITH isolated_guard AS MATERIALIZED (${ISOLATED_DEPLOY_SQL}),auth_probe AS MATERIALIZED (${AUTH_PROBE_SQL}) SELECT schema_json,auth_json,(SELECT ${ISOLATED_DEPLOY_JSON_SQL} FROM isolated_guard) AS isolated_guard_json FROM auth_probe`;
export const AUTH_ISOLATED_ENABLE_SQL = `WITH isolated_guard AS MATERIALIZED (${ISOLATED_DEPLOY_SQL}) ${AUTH_SQL.enable.replace(" RETURNING ", ` AND (SELECT ${ISOLATED_DEPLOY_JSON_SQL} FROM isolated_guard)=? RETURNING `)}`;
if (
  [
    AUTH_V2_PROBE_SQL,
    AUTH_V2_ENABLE_SQL,
    AUTH_ISOLATED_PROBE_SQL,
    AUTH_ISOLATED_ENABLE_SQL,
  ].some((sql) => Buffer.byteLength(sql) > AUTH_LIMITS.sqlBytes) ||
  (AUTH_V2_PROBE_SQL.match(/\?/g) || []).length !== 1 ||
  (AUTH_V2_ENABLE_SQL.match(/\?/g) || []).length !== 6 ||
  (AUTH_ISOLATED_PROBE_SQL.match(/\?/g) || []).length !== 1 ||
  (AUTH_ISOLATED_ENABLE_SQL.match(/\?/g) || []).length !== 6
)
  throw new Error("production_auth_sql_budget");

const CODES = new Set([
  "options_invalid",
  "private_path_unsafe",
  "private_path_changed",
  "private_file_unsafe",
  "private_file_changed",
  "private_write_failed",
  "configuration_invalid",
  "credentials_invalid",
  "schema_invalid",
  "response_invalid",
  "response_limit",
  "deadline",
  "request_failed",
  "request_budget",
  "database_identity_mismatch",
  "auth_identity_mismatch",
  "auth_missing",
  "auth_exists",
  "expected_row_mismatch",
  "cas_conflict",
  "readback_mismatch",
  "worker_precondition_failed",
  "unresolved_mutation",
  "operator_locked",
  "run_exists",
  "mutation_unknown",
  "internal",
]);
export class ProductionAuthError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : "internal";
    super(`production_auth_${safe}`);
    this.code = `production_auth_${safe}`;
  }
}
const fail = (code) => {
  throw new ProductionAuthError(code);
};
const safeError = (e) =>
  new ProductionAuthError(
    e instanceof ProductionAuthError && typeof e.code === "string"
      ? e.code.replace(/^production_auth_/, "")
      : "internal",
  );
const record = (v) => v && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  record(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
const canonicalKey = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(v) &&
  Buffer.from(v, "base64url").length === 32 &&
  Buffer.from(v, "base64url").toString("base64url") === v;
const parse = (v) => {
  try {
    return JSON.parse(v);
  } catch {
    fail("configuration_invalid");
  }
};
const cancel = (v) => {
  try {
    void Promise.resolve(v?.cancel()).catch(() => {});
  } catch {}
};
const same = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.nlink === b.nlink;
const sameDirectory = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;

// Pin every ancestor, all private inputs, and every generated private file. Mutation
// dispatch is always preceded by a complete recheck; same-UID adversaries remain
// outside the trusted operator boundary, as in the other project operators.
async function privateContext(root) {
  if (
    typeof root !== "string" ||
    path.resolve(root) !== root ||
    (await fs.realpath(root)) !== root
  )
    fail("private_path_unsafe");
  const dirs = new Map(),
    files = new Map();
  async function pinDirectory(filename, isPrivate = false) {
    const st = await fs.lstat(filename);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (await fs.realpath(filename)) !== filename ||
      (isPrivate &&
        ((st.mode & 0o777) !== 0o700 || st.uid !== process.getuid()))
    )
      fail("private_path_unsafe");
    const prior = dirs.get(filename);
    if (prior && !sameDirectory(prior, st)) fail("private_path_changed");
    dirs.set(filename, st);
  }
  let current = path.parse(root).root;
  await pinDirectory(current);
  for (const segment of root
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    await pinDirectory(current);
  }
  if (dirs.get(root).uid !== process.getuid()) fail("private_path_unsafe");
  for (const relative of [".local", ".local/cf03", ".local/cf03/production"])
    await pinDirectory(path.join(root, relative), true);
  async function check() {
    for (const [filename, before] of dirs) {
      let st;
      try {
        st = await fs.lstat(filename);
      } catch {
        fail("private_path_changed");
      }
      if (
        !st.isDirectory() ||
        st.isSymbolicLink() ||
        !sameDirectory(before, st) ||
        (await fs.realpath(filename)) !== filename
      )
        fail("private_path_changed");
    }
    for (const [filename, before] of files) {
      let st;
      try {
        st = await fs.lstat(filename);
      } catch (e) {
        if (e.code !== "ENOENT") fail("private_file_changed");
      }
      if (
        before === null
          ? st !== undefined
          : !st ||
            !st.isFile() ||
            st.isSymbolicLink() ||
            !same(before, st) ||
            before.size !== st.size ||
            before.mtimeMs !== st.mtimeMs
      )
        fail("private_file_changed");
    }
  }
  const location = (relative) => {
    if (
      typeof relative !== "string" ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).some((p) => p === "..")
    )
      fail("private_path_unsafe");
    return path.join(root, relative);
  };
  async function read(
    relative,
    {
      optional = false,
      limit = AUTH_LIMITS.responseBytes,
      privateFile = true,
    } = {},
  ) {
    await check();
    const filename = location(relative);
    let parent = root;
    for (const segment of path
      .relative(root, path.dirname(filename))
      .split(path.sep)
      .filter(Boolean)) {
      parent = path.join(parent, segment);
      await pinDirectory(
        parent,
        parent === path.join(root, ".local") ||
          parent.startsWith(path.join(root, ".local") + path.sep),
      );
    }
    let before;
    try {
      before = await fs.lstat(filename);
    } catch (e) {
      if (e.code === "ENOENT" && optional) {
        files.set(filename, null);
        return null;
      }
      throw e;
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid() ||
      (privateFile && (before.mode & 0o777) !== 0o600) ||
      before.size > limit
    )
      fail("private_file_unsafe");
    const file = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let raw;
    try {
      const opened = await file.stat();
      if (!same(before, opened)) fail("private_file_changed");
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const r = await file.read(buffer, size, buffer.length - size, size);
        if (!r.bytesRead) break;
        size += r.bytesRead;
      }
      const after = await file.stat();
      if (
        size > limit ||
        !same(before, after) ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        fail("private_file_changed");
      raw = buffer.subarray(0, size).toString("utf8");
    } finally {
      await file.close();
    }
    files.set(filename, before);
    await check();
    return raw;
  }
  async function mkdir(relative) {
    await check();
    const filename = location(relative);
    if (!dirs.has(path.dirname(filename))) fail("private_path_unsafe");
    try {
      await fs.mkdir(filename, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    await pinDirectory(filename, true);
    await check();
  }
  async function write(relative, value, exclusive = false) {
    const filename = location(relative),
      parent = path.dirname(filename);
    if (!dirs.has(parent)) fail("private_path_unsafe");
    if (!files.has(filename)) await read(relative, { optional: true });
    if (exclusive && files.get(filename) !== null) fail("run_exists");
    await check();
    const temp = filename + ".pending";
    const file = await fs.open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let stat;
    try {
      await check();
      await file.writeFile(JSON.stringify(value, null, 2) + "\n");
      await file.sync();
      stat = await file.stat();
    } finally {
      await file.close();
    }
    if (
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600
    )
      fail("private_write_failed");
    await check();
    if (!same(stat, await fs.lstat(temp))) fail("private_file_changed");
    await fs.rename(temp, filename);
    files.set(filename, stat);
    await check();
    const dir = await fs.open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await check();
      if (!sameDirectory(dirs.get(parent), await dir.stat()))
        fail("private_path_changed");
      await dir.sync();
    } finally {
      await dir.close();
    }
    await check();
  }
  async function lock() {
    await check();
    const filename = location(".local/cf03/production-auth.lock");
    let file;
    try {
      file = await fs.open(
        filename,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (e) {
      if (e.code === "EEXIST") fail("operator_locked");
      throw e;
    }
    await file.writeFile("production-auth\n");
    await file.sync();
    const st = await file.stat();
    await file.close();
    files.set(filename, st);
    await check();
    return async () => {
      await check();
      await fs.unlink(filename);
      files.set(filename, null);
      await check();
    };
  }
  async function directoryEmpty(relative) {
    const filename = location(relative);
    if (!dirs.has(filename)) fail("private_path_unsafe");
    await check();
    const entries = await fs.readdir(filename);
    await check();
    return entries.length === 0;
  }
  return { root, check, read, mkdir, write, lock, directoryEmpty };
}

function schemaRows(source) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(source);
    return db
      .prepare(AUTH_SQL.schema)
      .all()
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}
const safeRow = (row) => {
  if (
    !row ||
    row.scope !== "production" ||
    row.origin !== POLICY.origin ||
    row.scheme !== "owner-access-key-v1" ||
    !integer(row.generation, 1) ||
    row.generation >= Number.MAX_SAFE_INTEGER ||
    ![0, 1].includes(row.enabled) ||
    !integer(row.updated_at)
  )
    fail("auth_identity_mismatch");
  return Object.fromEntries(FIELDS.split(",").map((k) => [k, row[k]]));
};
function statusRow(rows) {
  if (!Array.isArray(rows) || rows.length > 1) fail("auth_identity_mismatch");
  if (!rows.length) return null;
  const raw = rows[0];
  if (
    !exact(raw, [
      ...FIELDS.split(","),
      "verifier_match",
      "unrevoked_sessions",
    ]) ||
    raw.verifier_match !== 1 ||
    !integer(raw.unrevoked_sessions)
  )
    fail("auth_identity_mismatch");
  return {
    row: safeRow(raw),
    unrevokedSessions: raw.unrevoked_sessions,
    rowSha256: hash(safeRow(raw)),
  };
}
function mutationRow(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !exact(rows[0], FIELDS.split(","))
  )
    fail("cas_conflict");
  return safeRow(rows[0]);
}
function deployment(value, expected) {
  if (
    !exact(value, ["deployments"]) ||
    !Array.isArray(value.deployments) ||
    value.deployments.length !== 1
  )
    fail("worker_precondition_failed");
  const d = value.deployments[0];
  if (
    !uuid(d?.id) ||
    !Array.isArray(d.versions) ||
    d.versions.length !== 1 ||
    !exact(d.versions[0], ["version_id", "percentage"]) ||
    d.versions[0].version_id !== expected ||
    d.versions[0].percentage !== 100
  )
    fail("worker_precondition_failed");
  return { deploymentId: d.id, versionId: expected };
}
function bindings(
  settings,
  databaseId,
  accountId,
  singleTrialTarget,
  storageContract,
  isolatedConsent,
) {
  if (storageContract) {
    try {
      const observed = validateRemoteStorageBindings(settings, storageContract);
      return {
        bindingsSha256: hash(observed.canonicalBindingsJson),
        settingsSha256: hash(observed.canonicalSettingsJson),
      };
    } catch {
      fail("worker_precondition_failed");
    }
  }
  try {
    validateRemoteBindings(settings, "production", databaseId, {
      accountId,
      singleTrialTarget,
      filenameAi: !!isolatedConsent,
      isolatedUploadConsentSha256: isolatedConsent?.sha256,
    });
  } catch {
    fail("worker_precondition_failed");
  }
  const normalized = settings.bindings
    .map((b) => {
      if (b.name === "DB" && exact(b, ["name", "type", "id"])) return b;
      if (
        b.name === "DB" &&
        exact(b, ["name", "type", "id", "database_id"]) &&
        b.id === databaseId &&
        b.database_id === databaseId
      )
        return b;
      if (b.name === "BOOKS" && exact(b, ["name", "type", "bucket_name"]))
        return b;
      if (b.type === "secret_text" && exact(b, ["name", "type"])) return b;
      if (b.type === "plain_text" && exact(b, ["name", "type", "text"]))
        return b;
      if (b.name === "ASSETS" && exact(b, ["name", "type"])) return b;
      fail("worker_precondition_failed");
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { bindingsSha256: hash(normalized), settingsSha256: hash(settings) };
}
function subdomain(value) {
  if (
    !exact(value, ["enabled", "previews_enabled"]) ||
    value.enabled !== true ||
    value.previews_enabled !== false
  )
    fail("worker_precondition_failed");
  return { enabled: true, previewsEnabled: false };
}
function d1Rows(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0]?.success !== true ||
    !Array.isArray(value[0].results)
  )
    fail("response_invalid");
  return value[0].results;
}
async function boundedJson(response, signal) {
  const length = response.headers?.get("content-length");
  if (
    length !== null &&
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > AUTH_LIMITS.responseBytes)
  )
    fail("response_limit");
  if (!response.body) fail("response_invalid");
  const reader = response.body.getReader();
  let size = 0,
    count = 0,
    done = false;
  const chunks = [];
  const abort = () => cancel(reader);
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        ++count > AUTH_LIMITS.chunks ||
        (size += next.value.length) > AUTH_LIMITS.responseBytes
      )
        fail("response_limit");
      chunks.push(Buffer.from(next.value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } catch {
      fail("response_invalid");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!done) cancel(reader);
    try {
      reader.releaseLock();
    } catch {}
  }
}

export async function runProductionAuth({
  execute = false,
  action = "status",
  runId,
  expectedGeneration,
  expectedRowSha256,
  expectedVersion,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  clock = Date.now,
  timeoutMs = AUTH_LIMITS.deadlineMs,
  singleTrial = false,
  storageMode,
  writeMode,
  filenameAi = false,
  isolatedUploads = false,
  preparedText = false,
} = {}) {
  // Preview precedes all file/configuration/clock/network access.
  if (!execute)
    return {
      mode: "preview",
      action,
      requests: 0,
      limits: AUTH_LIMITS,
      cloudMutation: false,
    };
  if (
    execute !== true ||
    !["status", "initialize-disabled", "enable", "close"].includes(action) ||
    typeof runId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(runId) ||
    !integer(timeoutMs, 1) ||
    timeoutMs > AUTH_LIMITS.deadlineMs ||
    typeof fetchImpl !== "function" ||
    typeof clock !== "function"
  )
    fail("options_invalid");
  if (
    ["enable", "close"].includes(action) &&
    (!integer(expectedGeneration, 1) ||
      typeof expectedRowSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedRowSha256 || ""))
  )
    fail("options_invalid");
  if (action === "enable" && !uuid(expectedVersion)) fail("options_invalid");
  const v2 = action === "enable" && storageMode === "authority-v2";
  if (
    action === "enable" &&
    (typeof singleTrial !== "boolean" ||
      typeof filenameAi !== "boolean" ||
      typeof preparedText !== "boolean" ||
      typeof isolatedUploads !== "boolean" ||
      (isolatedUploads &&
        (!singleTrial ||
          !filenameAi ||
          preparedText ||
          storageMode !== undefined ||
          writeMode !== undefined)) ||
      ((storageMode !== undefined || writeMode !== undefined) &&
        (!v2 || writeMode !== "closed" || singleTrial || !filenameAi)) ||
      (!v2 && !isolatedUploads && (filenameAi || preparedText)))
  )
    fail("options_invalid");
  let context,
    unlock,
    receipt,
    state,
    receiptPath,
    statePath = ".local/cf03/production-auth-state.json",
    dispatchedMutation = false;
  try {
    context = await privateContext(root);
    unlock = await context.lock();
    const env = parseEnv(await context.read(".env"));
    let credentials;
    try {
      credentials = selectCredentials(environment, env);
    } catch {
      fail("credentials_invalid");
    }
    if (credentials.ci || credentials.accountId !== env.SHELF_R2_ACCOUNT_ID)
      fail("credentials_invalid");
    let config;
    try {
      config = validateDeployConfig(
        parse(await context.read(".local/cf03/deploy.json")),
      );
    } catch {
      fail("configuration_invalid");
    }
    const resource = config.profiles.production;
    let singleTrialTarget;
    if (action === "enable" && (singleTrial || v2)) {
      try {
        singleTrialTarget = validateSingleTrialTarget(
          parse(await context.read(SINGLE_TRIAL_TARGET_PATH)),
          credentials.accountId,
          v2
            ? undefined
            : (
                await context.read(SINGLE_TRIAL_SECRET_PATH, { limit: 100 })
              ).trim(),
        );
      } catch {
        fail("configuration_invalid");
      }
    }
    const isolatedIdentity = {
      schemaVersion: 1,
      authorityId: "shelf-remote-storage-v1",
      accountId: credentials.accountId,
      bucket: "the-shelf-books",
      legacyDatabases: {
        check: config.profiles.check.databaseId,
        production: resource.databaseId,
      },
    };
    const isolatedConsent =
      action === "enable" && isolatedUploads
        ? validateIsolatedConsent(
            parse(await context.read(ISOLATED_CONSENT_PATH)),
            isolatedIdentity,
          )
        : undefined;
    const storageContract = v2
      ? storageDeploymentContract({
          profile: "authority-v2-closed",
          identity: {
            schemaVersion: 1,
            authorityId: "shelf-remote-storage-v1",
            accountId: credentials.accountId,
            bucket: "the-shelf-books",
            legacyDatabases: {
              check: config.profiles.check.databaseId,
              production: resource.databaseId,
            },
          },
          trialTargetSha256: singleTrialTarget.configSha256,
          filenameAi,
          preparedText,
          retainedSecrets: "trial-retained-filename-v1",
        })
      : undefined;
    const secretValues = [];
    for (const filename of [
      "owner-access-key",
      "owner-key-pepper",
      "session-secret",
    ]) {
      const value = (
        await context.read(`.local/cf03/production/${filename}`, { limit: 100 })
      ).trim();
      if (!canonicalKey(value)) fail("configuration_invalid");
      secretValues.push(value);
    }
    if (new Set(secretValues).size !== 3) fail("configuration_invalid");
    const verifier = await createOwnerVerifier(
      secretValues[0],
      secretValues[1],
      { scope: "production", origin: POLICY.origin },
    );
    const expectedSchema = schemaRows(
      await context.read("cloudflare/library/schema.sql", {
        privateFile: false,
      }),
    );
    const identitySha256 = hash({
      accountId: credentials.accountId,
      databaseId: resource.databaseId,
      worker: POLICY.name,
      origin: POLICY.origin,
    });
    const oldState = await context.read(statePath, { optional: true });
    state =
      oldState === null
        ? { schemaVersion: 1, identitySha256, unresolved: [] }
        : parse(oldState);
    if (
      !exact(state, ["schemaVersion", "identitySha256", "unresolved"]) ||
      state.schemaVersion !== 1 ||
      state.identitySha256 !== identitySha256 ||
      !Array.isArray(state.unresolved) ||
      state.unresolved.length > 1000 ||
      state.unresolved.some(
        (r) =>
          !exact(r, ["runId", "action"]) ||
          typeof r.runId !== "string" ||
          !["initialize-disabled", "enable", "close"].includes(r.action),
      )
    )
      fail("configuration_invalid");
    if (state.unresolved.some((r) => r.runId === runId)) fail("run_exists");
    if (
      state.unresolved.length &&
      ["enable", "initialize-disabled"].includes(action)
    )
      fail("unresolved_mutation");
    await context.mkdir(".local/cf03/production-auth");
    // Missing state alongside old receipts is evidence loss, not a fresh start.
    if (oldState === null) {
      if (!(await context.directoryEmpty(".local/cf03/production-auth")))
        fail("configuration_invalid");
      await context.write(statePath, state);
    }
    // A run owns its receipt for its whole lifetime, even after a failed preflight.
    receiptPath = `.local/cf03/production-auth/${runId}.json`;
    receipt = {
      schemaVersion: 1,
      identitySha256,
      action,
      runId,
      ...(singleTrialTarget
        ? { singleTrialTargetSha256: singleTrialTarget.configSha256 }
        : {}),
      requests: [],
      outcome: "running",
    };
    await context.write(receiptPath, receipt, true);
    const base = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}`;
    async function request(
      suffix,
      label,
      { sql, params, mutation = false } = {},
    ) {
      if (receipt.requests.length >= AUTH_LIMITS[action])
        fail("request_budget");
      if (
        sql !== undefined &&
        (typeof sql !== "string" ||
          Buffer.byteLength(sql) > AUTH_LIMITS.sqlBytes ||
          !Array.isArray(params) ||
          params.length > AUTH_LIMITS.parameters ||
          Buffer.byteLength(JSON.stringify({ sql, params })) >
            AUTH_LIMITS.responseBytes)
      )
        fail("options_invalid");
      const entry = {
        sequence: receipt.requests.length + 1,
        label,
        method: sql === undefined ? "GET" : "POST",
        mutation,
        outcome: "pending",
      };
      receipt.requests.push(entry);
      await context.write(receiptPath, receipt);
      if (mutation) {
        state.unresolved.push({ runId, action });
        await context.write(statePath, state);
      }
      await context.check();
      const controller = new AbortController();
      let timer, response;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          cancel(response?.body);
          reject(new ProductionAuthError("deadline"));
        }, timeoutMs);
      });
      let expired = false;
      const work = Promise.resolve().then(async () => {
        if (expired) fail("deadline");
        const pending = Promise.resolve(
          fetchImpl(base + suffix, {
            method: entry.method,
            redirect: "error",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${credentials.token}`,
              ...(sql === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            ...(sql === undefined
              ? {}
              : { body: JSON.stringify({ sql, params }) }),
          }),
        );
        pending.then(
          (late) => {
            if (expired) cancel(late?.body);
          },
          () => {},
        );
        response = await pending;
        if (expired) {
          cancel(response?.body);
          fail("deadline");
        }
        if (
          response.redirected ||
          (response.url && response.url !== base + suffix) ||
          response.status !== 200
        )
          fail("request_failed");
        const data = await boundedJson(response, controller.signal);
        if (
          !record(data) ||
          data.success !== true ||
          !Object.hasOwn(data, "result") ||
          (data.errors !== undefined &&
            (!Array.isArray(data.errors) || data.errors.length))
        )
          fail("response_invalid");
        return data.result;
      });
      try {
        if (mutation) dispatchedMutation = true;
        const result = await Promise.race([work, deadline]);
        expired = true;
        clearTimeout(timer);
        // Persistence is part of result handling. Failure cannot reclassify a mutation.
        entry.outcome = "response_observed";
        await context.write(receiptPath, receipt);
        return result;
      } catch (e) {
        expired = true;
        clearTimeout(timer);
        controller.abort();
        cancel(response?.body);
        entry.outcome = mutation ? "unknown" : "failed";
        try {
          await context.write(receiptPath, receipt);
        } catch {}
        if (mutation) fail("mutation_unknown");
        throw safeError(e);
      }
    }
    const query = async (sql, params, label, mutation = false) =>
      d1Rows(
        await request(`/d1/database/${resource.databaseId}/query`, label, {
          sql,
          params,
          mutation,
        }),
      );
    let initialStorageJson, initialStorageObservation;
    function decodeProbe(projection) {
      if (
        projection.length !== 1 ||
        !exact(
          projection[0],
          v2
            ? ["schema_json", "auth_json", "storage_guard_json"]
            : isolatedConsent
              ? ["schema_json", "auth_json", "isolated_guard_json"]
              : ["schema_json", "auth_json"],
        )
      )
        fail("schema_invalid");
      const schema = parse(projection[0].schema_json);
      if (
        !Array.isArray(schema) ||
        schema.length >= 33 ||
        JSON.stringify(schema) !== JSON.stringify(expectedSchema)
      )
        fail("schema_invalid");
      let storage;
      if (v2) {
        if (typeof projection[0].storage_guard_json !== "string")
          fail("schema_invalid");
        try {
          storage = validateStorageDeployGuard(
            JSON.parse(projection[0].storage_guard_json),
            storageContract,
          );
        } catch {
          fail("worker_precondition_failed");
        }
      }
      if (isolatedConsent) {
        try {
          const raw = JSON.parse(projection[0].isolated_guard_json);
          storage = validateIsolatedDeployRows(
            [raw],
            isolatedIdentity,
            isolatedConsent,
          );
          const stable = { ...raw };
          delete stable.auth_json;
          storage.storageSnapshotSha256 = hash(stable);
        } catch {
          fail("worker_precondition_failed");
        }
      }
      return {
        auth: statusRow(parse(projection[0].auth_json)),
        storage,
        storageJson: isolatedConsent
          ? projection[0].isolated_guard_json
          : projection[0].storage_guard_json,
      };
    }
    const observeAuth = async (label) => {
      if (!v2 && !isolatedConsent)
        return statusRow(await query(AUTH_SQL.status, [verifier], label));
      const observed = decodeProbe(
        await query(
          isolatedConsent ? AUTH_ISOLATED_PROBE_SQL : AUTH_V2_PROBE_SQL,
          [verifier],
          label,
        ),
      );
      if (
        observed.storage.storageSnapshotSha256 !==
          initialStorageObservation.storageSnapshotSha256 ||
        (!isolatedConsent && observed.storageJson !== initialStorageJson)
      )
        fail("worker_precondition_failed");
      return observed.auth;
    };
    const identity = await request(
      `/d1/database/${resource.databaseId}`,
      "database-identity",
    );
    if (
      identity?.uuid !== resource.databaseId ||
      identity?.name !== resource.databaseName
    )
      fail("database_identity_mismatch");
    const initial = decodeProbe(
      await query(
        isolatedConsent
          ? AUTH_ISOLATED_PROBE_SQL
          : v2
            ? AUTH_V2_PROBE_SQL
            : AUTH_PROBE_SQL,
        [verifier],
        "auth-schema-and-state",
      ),
    );
    initialStorageJson = initial.storageJson;
    initialStorageObservation = initial.storage;
    if (v2 || isolatedConsent) {
      receipt.storage = initialStorageObservation;
      await context.write(receiptPath, receipt);
    }
    const before = initial.auth;
    if (action === "status") {
      receipt.outcome = "observed";
      receipt.auth = before;
      receipt.unresolvedMutations = state.unresolved.length;
      await context.write(receiptPath, receipt);
      return {
        ok: true,
        action,
        requests: receipt.requests.length,
        auth: before,
        unresolvedMutations: state.unresolved.length,
      };
    }
    if (action === "initialize-disabled" ? before !== null : before === null)
      fail(action === "initialize-disabled" ? "auth_exists" : "auth_missing");
    if (
      ["enable", "close"].includes(action) &&
      (before.row.generation !== expectedGeneration ||
        before.rowSha256 !== expectedRowSha256)
    )
      fail("expected_row_mismatch");
    if (action === "enable" && before.row.enabled !== 0)
      fail("expected_row_mismatch");
    const workerBase = `/workers/scripts/${POLICY.name}`;
    async function observeWorker(prefix) {
      const d = deployment(
        await request(
          workerBase + "/deployments?page=1&per_page=1",
          `${prefix}-deployment`,
        ),
        expectedVersion,
      );
      const b = bindings(
        await request(workerBase + "/settings", `${prefix}-settings`),
        resource.databaseId,
        credentials.accountId,
        singleTrialTarget,
        storageContract,
        isolatedConsent,
      );
      const s = subdomain(
        await request(workerBase + "/subdomain", `${prefix}-subdomain`),
      );
      return { deployment: d, bindingsSha256: b, subdomain: s };
    }
    let worker;
    if (action === "enable") {
      worker = await observeWorker("before");
      const d = deployment(
        await request(
          workerBase + "/deployments?page=1&per_page=1",
          "before-cas-deployment",
        ),
        expectedVersion,
      );
      if (JSON.stringify(d) !== JSON.stringify(worker.deployment))
        fail("worker_precondition_failed");
    }
    const now = clock();
    if (!integer(now) || (before && now < before.row.updated_at))
      fail("options_invalid");
    let sql, params;
    if (action === "initialize-disabled") {
      sql = AUTH_SQL.initialize;
      params = [POLICY.origin, verifier, now];
    } else if (action === "enable") {
      sql = isolatedConsent
        ? AUTH_ISOLATED_ENABLE_SQL
        : v2
          ? AUTH_V2_ENABLE_SQL
          : AUTH_SQL.enable;
      params = [
        now,
        POLICY.origin,
        verifier,
        expectedGeneration,
        before.row.updated_at,
        ...(v2 || isolatedConsent ? [initialStorageJson] : []),
      ];
    } else {
      sql = AUTH_SQL.close;
      params = [
        now,
        POLICY.origin,
        verifier,
        expectedGeneration,
        before.row.enabled,
        before.row.updated_at,
      ];
    }
    const changed = mutationRow(await query(sql, params, "auth-cas", true));
    const target =
      action === "initialize-disabled"
        ? {
            scope: "production",
            origin: POLICY.origin,
            scheme: "owner-access-key-v1",
            generation: 1,
            enabled: 0,
            updated_at: now,
          }
        : {
            ...before.row,
            generation:
              action === "close" ? expectedGeneration + 1 : expectedGeneration,
            enabled: action === "enable" ? 1 : 0,
            updated_at: now,
          };
    if (JSON.stringify(changed) !== JSON.stringify(target))
      fail("readback_mismatch");
    const after = await observeAuth("independent-auth");
    if (
      !after ||
      JSON.stringify(after.row) !== JSON.stringify(target) ||
      (action !== "enable" && after.unrevokedSessions !== 0)
    )
      fail("readback_mismatch");
    if (
      action === "enable" &&
      JSON.stringify(await observeWorker("after")) !== JSON.stringify(worker)
    )
      fail("worker_precondition_failed");
    receipt.auth = after;
    if (v2 || isolatedConsent) receipt.storage = initialStorageObservation;
    receipt.outcome = "verified";
    await context.write(receiptPath, receipt);
    state.unresolved = state.unresolved.filter((r) => r.runId !== runId);
    await context.write(statePath, state);
    return {
      ok: true,
      action,
      requests: receipt.requests.length,
      auth: after,
      unresolvedMutations: state.unresolved.length,
    };
  } catch (e) {
    if (receipt && context) {
      receipt.outcome = dispatchedMutation ? "unknown" : "stopped";
      try {
        await context.write(receiptPath, receipt);
      } catch {}
    }
    throw safeError(e);
  } finally {
    if (unlock) {
      try {
        await unlock();
      } catch (e) {
        throw safeError(e);
      }
    }
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  try {
    const args = [...argv],
      action = args[0] && !args[0].startsWith("--") ? args.shift() : "status",
      parsed = { action };
    const names = {
      "--run-id": "runId",
      "--expected-generation": "expectedGeneration",
      "--expected-row-sha256": "expectedRowSha256",
      "--expected-version": "expectedVersion",
      "--storage-mode": "storageMode",
      "--write-mode": "writeMode",
    };
    const seen = new Set();
    while (args.length) {
      const key = args.shift();
      if (seen.has(key)) fail("options_invalid");
      seen.add(key);
      if (key === "--execute") {
        parsed.execute = true;
        continue;
      }
      if (
        [
          "--single-trial",
          "--filename-ai",
          "--prepared-text",
          "--isolated-uploads",
        ].includes(key)
      ) {
        parsed[
          {
            "--single-trial": "singleTrial",
            "--isolated-uploads": "isolatedUploads",
            "--filename-ai": "filenameAi",
            "--prepared-text": "preparedText",
          }[key]
        ] = true;
        continue;
      }
      if (!names[key] || !args.length) fail("options_invalid");
      const value = args.shift();
      if (key === "--expected-generation" && !/^[1-9]\d*$/.test(value))
        fail("options_invalid");
      parsed[names[key]] =
        key === "--expected-generation" ? Number(value) : value;
    }
    if (!["status", "initialize-disabled", "enable", "close"].includes(action))
      fail("options_invalid");
    const result = await runProductionAuth({ ...options, ...parsed });
    console.log(JSON.stringify(result));
    return result;
  } catch (e) {
    const error = safeError(e);
    console.error(error.code);
    process.exitCode = 1;
    return { ok: false, code: error.code };
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
