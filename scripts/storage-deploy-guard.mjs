/** Fixed-project, read-only deployment observations. No CLI, discovery or mutation. */
import { createHash } from "node:crypto";
import {
  STORAGE_DATABASE_SCHEMA_SQL,
  validateStorageDatabaseSchema,
} from "../shared/storage-deployment-contract.mjs";
import { decodeTrialRecord } from "../cloudflare/library/trial-record.mjs";

export const STORAGE_DEPLOY_GUARD_LIMITS = Object.freeze({
  maxTotalHttp: 4, // deployApi only; Wrangler's internal requests are separate.
  sqlBytes: 16_384,
  parameters: 0,
  responseBytes: 1_048_576,
  chunks: 4096,
  deadlineMs: 30_000,
  authorityRows: 2,
  trialRows: 2,
  identityBytes: 2048,
  descriptorBytes: 4096,
  targetBytes: 256,
});
export class StorageDeployGuardError extends Error {
  constructor(code = "observation") {
    super(`storage_deploy_${code}`);
    this.code = `storage_deploy_${code}`;
  }
}
const fail = (code) => {
  throw new StorageDeployGuardError(code);
};
const exact = (v, names) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  return (
    Reflect.ownKeys(descriptors).length === names.length &&
    names.every(
      (name) =>
        descriptors[name]?.enumerable &&
        Object.hasOwn(descriptors[name], "value"),
    )
  );
};
const byteLength = (v) =>
  typeof v === "string" ? Buffer.byteLength(v) : Infinity;
const hash = (v) => createHash("sha256").update(v).digest("hex");
// Never await cancellation: providers and synthetic adapters can ignore abort or
// return a cancel promise that never settles. This is cleanup, not drain proof.
const cancel = (target) => {
  try {
    Promise.resolve(target?.cancel?.()).catch(() => {});
  } catch {}
};

/** One attempt, with a deadline spanning fetch AND body consumption, even if the
 * provider ignores AbortSignal. 404 is drained under the same bounds, not parsed. */
export async function readDeploymentControlJson({
  url,
  fetcher = fetch,
  init = {},
  allowNotFound = false,
  timeoutMs = STORAGE_DEPLOY_GUARD_LIMITS.deadlineMs,
} = {}) {
  if (
    typeof url !== "string" ||
    typeof fetcher !== "function" ||
    typeof allowNotFound !== "boolean" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > STORAGE_DEPLOY_GUARD_LIMITS.deadlineMs
  )
    fail("configuration");
  const controller = new AbortController();
  let response,
    reader,
    timer,
    finished = false;
  const cleanup = () => {
    controller.abort();
    cancel(reader);
    cancel(response?.body);
    try {
      reader?.releaseLock();
    } catch {}
  };
  const operation = Promise.resolve().then(async () => {
    if (finished) fail("deadline");
    const pending = Promise.resolve(
      fetcher(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      }),
    );
    pending.then(
      (late) => {
        if (finished) cancel(late?.body);
      },
      () => {},
    );
    response = await pending;
    if (finished) {
      cancel(response?.body);
      fail("deadline");
    }
    const missing = allowNotFound && response?.status === 404;
    if (
      (!missing && response?.status !== 200) ||
      response.redirected ||
      (response.url && response.url !== url)
    )
      fail("response");
    const advertised = response.headers?.get("content-length");
    if (
      advertised !== null &&
      advertised !== undefined &&
      (!/^\d+$/.test(advertised) ||
        Number(advertised) > STORAGE_DEPLOY_GUARD_LIMITS.responseBytes)
    )
      fail("response_limit");
    if (
      !missing &&
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers?.get("content-type") || "",
      )
    )
      fail("response");
    if (!response.body) {
      if (missing) return null;
      fail("response");
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0,
      count = 0;
    for (;;) {
      const next = await reader.read();
      if (finished) fail("deadline");
      if (next.done) break;
      if (
        !(next.value instanceof Uint8Array) ||
        ++count > STORAGE_DEPLOY_GUARD_LIMITS.chunks ||
        (size += next.value.byteLength) >
          STORAGE_DEPLOY_GUARD_LIMITS.responseBytes
      )
        fail("response_limit");
      if (!missing) chunks.push(Buffer.from(next.value));
    }
    if (missing) return null;
    try {
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, size),
        ),
      );
      if (!data || typeof data !== "object" || Array.isArray(data))
        fail("response");
      return data;
    } catch {
      fail("response");
    }
  });
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          finished = true;
          cleanup();
          reject(new StorageDeployGuardError("deadline"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    throw error instanceof StorageDeployGuardError
      ? error
      : new StorageDeployGuardError();
  } finally {
    finished = true;
    clearTimeout(timer);
    cleanup();
  }
}

const octets = (field) => `length(CAST(${field} AS BLOB))`;
const TRIAL_FIELDS = [
  "id",
  "permit_id",
  "consent_id",
  "authority_identity_json",
  "target_json",
  "descriptor_json",
  "isolated_target_config_sha256",
  "size_bytes",
  "issued_at",
  "expires_at",
  "state",
  "put_attempted",
  "content_verified",
  "etag",
  "updated_at",
];
const trialJson = TRIAL_FIELDS.map((name) => `'${name}',${name}`).join(",");
export const STORAGE_DEPLOY_GUARD_FIELDS = Object.freeze([
  "schema_json",
  "authority_json",
  "trial_json",
  "normal_collision_count",
  "overflow",
]);
export const STORAGE_DEPLOY_GUARD_JSON_SQL = `json_object(${STORAGE_DEPLOY_GUARD_FIELDS.map((name) => `'${name}',${name}`).join(",")})`;
// No caller-controlled SQL or identifiers. Schema and retained facts share a
// statement; the conflict count is raw, before book/catalog filtering.
export const STORAGE_DEPLOY_GUARD_SQL = `WITH
 database_schema AS MATERIALIZED (${STORAGE_DATABASE_SCHEMA_SQL}),
 authority_rows AS MATERIALIZED (SELECT id,identity_json,phase FROM shelf_storage_authority ORDER BY id LIMIT 2),
 trial_rows AS MATERIALIZED (SELECT ${TRIAL_FIELDS.join(",")} FROM shelf_storage_single_trial ORDER BY id LIMIT 2),
 bounds AS (SELECT CASE WHEN
 EXISTS(SELECT 1 FROM authority_rows WHERE ${octets("identity_json")}>2048)
 OR EXISTS(SELECT 1 FROM trial_rows WHERE ${octets("authority_identity_json")}>2048 OR ${octets("descriptor_json")}>4096 OR ${octets("target_json")}>256 OR ${octets("permit_id")}>100 OR ${octets("consent_id")}>100 OR ${octets("isolated_target_config_sha256")}>64 OR ${octets("etag")}>256)
 THEN 1 ELSE 0 END AS overflow)
 SELECT
 (SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM database_schema ORDER BY type,name)) AS schema_json,
 CASE WHEN overflow=0 THEN (SELECT json_group_array(json_object('id',id,'identity_json',identity_json,'phase',phase)) FROM authority_rows) ELSE NULL END AS authority_json,
 CASE WHEN overflow=0 THEN (SELECT json_group_array(json_object(${trialJson})) FROM trial_rows) ELSE NULL END AS trial_json,
 CASE WHEN overflow=0 THEN (SELECT count(*) FROM (SELECT 1 FROM file_registry WHERE state='confirmed' AND scope='production' AND file_id=(SELECT json_extract(descriptor_json,'$.fileId') FROM trial_rows WHERE id=1) LIMIT 2)) ELSE NULL END AS normal_collision_count,
 overflow FROM bounds`;
if (
  Buffer.byteLength(STORAGE_DEPLOY_GUARD_SQL) >
    STORAGE_DEPLOY_GUARD_LIMITS.sqlBytes ||
  STORAGE_DEPLOY_GUARD_SQL.includes("?")
)
  fail("sql_budget");

/** Pure validation. No evidence freshness, activation or upload claims. */
export function validateStorageDeployGuard(row, contract) {
  try {
    if (
      contract?.profile !== "authority-v2-closed" ||
      !exact(row, [
        "schema_json",
        "authority_json",
        "trial_json",
        "normal_collision_count",
        "overflow",
      ]) ||
      row.overflow !== 0 ||
      row.normal_collision_count !== 0 ||
      ![row.schema_json, row.authority_json, row.trial_json].every(
        (v) => typeof v === "string",
      ) ||
      byteLength(JSON.stringify(row)) >
        STORAGE_DEPLOY_GUARD_LIMITS.responseBytes
    )
      fail("guard");
    const schema = validateStorageDatabaseSchema(
      JSON.parse(row.schema_json),
      contract,
    );
    const authorities = JSON.parse(row.authority_json),
      trials = JSON.parse(row.trial_json);
    if (
      !Array.isArray(authorities) ||
      authorities.length !== 1 ||
      !exact(authorities[0], ["id", "identity_json", "phase"]) ||
      authorities[0].id !== 1 ||
      !["imported", "ready"].includes(authorities[0].phase) ||
      byteLength(authorities[0].identity_json) > 2048 ||
      !Array.isArray(trials) ||
      trials.length !== 1
    )
      fail("guard");
    const a = JSON.parse(authorities[0].identity_json),
      expected = contract.identity;
    if (
      !exact(a, [
        "schemaVersion",
        "authorityId",
        "accountId",
        "bucket",
        "legacyDatabases",
      ]) ||
      !exact(a.legacyDatabases, ["check", "production"]) ||
      ["schemaVersion", "authorityId", "accountId", "bucket"].some(
        (k) => a[k] !== expected[k],
      ) ||
      ["check", "production"].some(
        (k) => a.legacyDatabases[k] !== expected.legacyDatabases[k],
      )
    )
      fail("guard");
    if (
      byteLength(trials[0].authority_identity_json) > 2048 ||
      byteLength(trials[0].descriptor_json) > 4096 ||
      byteLength(trials[0].target_json) > 256
    )
      fail("guard");
    const trial = decodeTrialRecord(trials[0], {
      accountId: expected.accountId,
      targetSha256: contract.vars.TRIAL_TARGET_SHA256,
    });
    if (trial.row.authority_identity_json !== authorities[0].identity_json)
      fail("guard");
    return Object.freeze({
      databaseSchemaProfile: schema.profile,
      databaseSchemaSha256: schema.sha256,
      authorityIdentitySha256: hash(authorities[0].identity_json),
      retainedSourceSha256: hash(row.trial_json),
      // Include phase and every raw schema/retained field, not just the summary.
      storageSnapshotSha256: hash(
        JSON.stringify(STORAGE_DEPLOY_GUARD_FIELDS.map((name) => row[name])),
      ),
    });
  } catch (error) {
    throw error instanceof StorageDeployGuardError
      ? error
      : new StorageDeployGuardError("guard");
  }
}

/** Exactly one fixed SELECT, after a separate database identity observation. */
export async function verifyStorageDeployGuard(
  credentials,
  resource,
  contract,
  { fetcher = fetch, timeoutMs = 30_000 } = {},
) {
  if (
    contract?.profile !== "authority-v2-closed" ||
    credentials?.accountId !== contract.identity.accountId ||
    resource?.databaseId !== contract.identity.legacyDatabases.production ||
    resource.databaseName !== "the-shelf-library"
  )
    fail("configuration");
  const data = await readDeploymentControlJson({
    url: `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${resource.databaseId}/query`,
    fetcher,
    timeoutMs,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: STORAGE_DEPLOY_GUARD_SQL, params: [] }),
    },
  });
  if (
    !data ||
    data.success !== true ||
    (data.errors !== undefined &&
      (!Array.isArray(data.errors) || data.errors.length)) ||
    !Array.isArray(data.result) ||
    data.result.length !== 1 ||
    data.result[0]?.success !== true ||
    !Array.isArray(data.result[0].results) ||
    data.result[0].results.length !== 1
  )
    fail("guard");
  return validateStorageDeployGuard(data.result[0].results[0], contract);
}
