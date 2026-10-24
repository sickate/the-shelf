// Explicit project-isolated uploads. No discovery, readiness claim, retry or second balance.
import { LibraryError } from "./security.mjs";
import { trialMode, trialSha256 } from "./single-trial.mjs";
export const ISOLATED_UPLOAD_TARGET = "isolated-project-20261024";
export const ISOLATED_UPLOAD_BUCKET = "the-shelf-first-book-20261023";
export const ISOLATED_UPLOAD_MIGRATION_SHA256 =
  "3b6b3b9686ed98e26cfbf873bd0869c15cba5103a9cd555383aa388147596866";
export const ISOLATED_UPLOAD_SCHEMA_HASHES = Object.freeze([
  "f37ec22776cfc94299af08f31af6944282a7bc8afd152df5739007add7b48626",
  "f91bff01a7b5ce50b497ad58d061787f7895df8125cddc5924c00e7424169c7b",
]);
export const ISOLATED_UPLOAD_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN ('_cf_KV','d1_migrations') AND substr(name,1,7)<>'sqlite_' ORDER BY type,name LIMIT 257";
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const fail = (code = "files_unconfigured", status = 503) => {
  throw new LibraryError(code, status);
};
export function isolatedUploadConfiguration(env) {
  const present = [
    "ISOLATED_UPLOAD_MODE",
    "ISOLATED_UPLOAD_CONSENT_SHA256",
  ].filter((key) => Object.hasOwn(env, key)).length;
  if (!present) return null;
  if (
    present !== 2 ||
    env.ISOLATED_UPLOAD_MODE !== "project-v1" ||
    !hash(env.ISOLATED_UPLOAD_CONSENT_SHA256) ||
    !trialMode(env) ||
    Object.hasOwn(env, "NORMAL_UPLOAD_MODE") ||
    Object.hasOwn(env, "STORAGE_MODE") ||
    env.SITE_ORIGIN !== "https://the-shelf.iamzhutuo.workers.dev" ||
    typeof env.DB?.prepare !== "function" ||
    typeof env.DB?.batch !== "function"
  )
    fail();
  return Object.freeze({
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    trialTarget: env.SINGLE_TRIAL_TARGET_SHA256,
    consent: env.ISOLATED_UPLOAD_CONSENT_SHA256,
    db: env.DB,
    prepare: env.DB.prepare,
    batch: env.DB.batch,
    books: env.BOOKS,
    put: env.BOOKS.put,
    head: env.BOOKS.head,
    get: env.BOOKS.get,
  });
}
export function assertIsolatedConfiguration(env, captured, session) {
  const current = isolatedUploadConfiguration(env);
  if (!current || Object.keys(captured).some((k) => current[k] !== captured[k]))
    fail();
  if (
    session &&
    (!Number.isSafeInteger(session.expires_at) ||
      session.expires_at <= Date.now())
  )
    fail("authentication_required", 401);
}
export async function assertIsolatedSchema(env, d, captured) {
  const result = await d.query(() =>
    d.prepare(env, ISOLATED_UPLOAD_SCHEMA_SQL).all(),
  );
  const rows = result.results;
  if (!Array.isArray(rows) || rows.length > 256) fail();
  const normalized = rows.map((r) => {
    if (
      !r ||
      Object.keys(r).sort().join(",") !== "name,sql,tbl_name,type" ||
      ["type", "name", "tbl_name", "sql"].some((k) => typeof r[k] !== "string")
    )
      fail();
    return {
      type: r.type,
      name: r.name,
      tbl_name: r.tbl_name,
      sql: r.sql.trim().replace(/;$/, ""),
    };
  });
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  if (
    bytes.length > 1_048_576 ||
    !ISOLATED_UPLOAD_SCHEMA_HASHES.includes(await trialSha256(bytes))
  )
    fail();
  assertIsolatedConfiguration(env, captured);
}
export const ISOLATED_ACCOUNTING_SQL = `a.committed_bytes=COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state='confirmed'),0)
 AND a.reserved_bytes=COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state<>'confirmed'),0)`;
export const ISOLATED_POLICY_SQL = `SELECT p.*,a.phase,a.identity_json AS current_identity,a.committed_bytes,a.reserved_bytes,
 (${ISOLATED_ACCOUNTING_SQL}) AS accounting_matches
 FROM shelf_storage_isolated_upload_policy p JOIN shelf_storage_authority a ON a.id=1 WHERE p.target_id=?`;
export function isolatedPolicyTuple(p) {
  return JSON.stringify([
    p.target_id,
    p.authority_identity_json,
    p.account_id,
    p.bucket,
    p.trial_target_sha256,
    p.consent_sha256,
    p.budget_bytes,
    p.created_at,
  ]);
}
export async function loadIsolatedPolicy(
  env,
  d,
  captured,
  { write = false } = {},
) {
  await assertIsolatedSchema(env, d, captured);
  const p = await d.query(() =>
    d.prepare(env, ISOLATED_POLICY_SQL, ISOLATED_UPLOAD_TARGET).first(),
  );
  assertIsolatedConfiguration(env, captured);
  if (
    !p ||
    p.phase !== "imported" ||
    p.current_identity !== p.authority_identity_json ||
    p.target_id !== ISOLATED_UPLOAD_TARGET ||
    p.account_id !== captured.accountId ||
    p.bucket !== captured.bucket ||
    p.trial_target_sha256 !== captured.trialTarget ||
    p.consent_sha256 !== captured.consent ||
    p.budget_bytes !== 8_000_000_000 ||
    ![0, 1].includes(p.enabled) ||
    p.accounting_matches !== 1 ||
    !Number.isSafeInteger(p.committed_bytes) ||
    !Number.isSafeInteger(p.reserved_bytes) ||
    p.committed_bytes < 0 ||
    p.reserved_bytes < 0 ||
    p.committed_bytes + p.reserved_bytes > p.budget_bytes ||
    (write && p.enabled !== 1)
  )
    fail("upload_blocked", 409);
  return p;
}
// Exact target mapping, retained after writes close. Legacy NULL rows never enter.
export const ISOLATED_CONFIRMED_SQL = `SELECT f.*,m.version AS management_version,u.descriptor_json,u.target_id,u.upload_id,
 json_array(u.target_id,u.authority_identity_json,u.account_id,u.bucket,u.trial_target_sha256,u.consent_sha256,u.budget_bytes,u.policy_created_at) AS target_tuple
 FROM shelf_isolated_upload_targets u JOIN shelf_storage_reservations r ON r.reservation_id=u.reservation_id AND r.descriptor_json=u.descriptor_json AND r.size_bytes=u.size_bytes
 JOIN shelf_storage_original_registry g ON g.reservation_id=r.reservation_id AND g.logical_key=r.logical_key AND g.descriptor_json=r.descriptor_json AND g.etag=r.etag AND g.enabled=1
 JOIN file_registry f ON f.scope=u.scope AND f.file_id=u.file_id AND f.book_id=u.book_id AND f.object_key=r.object_key AND f.sha256=u.sha256 AND f.etag=r.etag AND f.size_bytes=r.size_bytes AND f.format=json_extract(u.descriptor_json,'$.format')
 JOIN book_management m ON m.scope=u.scope AND m.book_id=u.book_id
 WHERE r.state='confirmed' AND r.put_attempted=1 AND r.content_verified=1 AND f.state='confirmed' AND m.trashed=0
 AND r.logical_key=('original:production:'||u.file_id||':original') AND r.object_key=json_extract(u.descriptor_json,'$.objectKey')`;
export function isolatedRegistrySource(env, trialSource) {
  const c = isolatedUploadConfiguration(env);
  if (!c) return trialSource;
  // Configuration values are validated canonical hex; all other SQL is fixed.
  const newSource = `${ISOLATED_CONFIRMED_SQL} AND u.account_id='${c.accountId}' AND u.bucket='${c.bucket}' AND u.consent_sha256='${c.consent}' AND u.trial_target_sha256='${c.trialTarget}'`;
  return `(SELECT scope,file_id,book_id,format,size_bytes,state FROM ${trialSource}
    UNION ALL SELECT scope,file_id,book_id,format,size_bytes,state FROM (${newSource}))`;
}

export const ISOLATED_UPLOAD_ROW_SQL = `SELECT u.*,r.state,r.put_attempted,r.content_verified,r.etag,m.version AS management_version
 FROM shelf_isolated_upload_targets u JOIN shelf_storage_reservations r ON r.reservation_id=u.reservation_id
 AND r.descriptor_json=u.descriptor_json AND r.size_bytes=u.size_bytes AND r.object_key=json_extract(u.descriptor_json,'$.objectKey')
 AND r.logical_key=('original:production:'||u.file_id||':original')
 JOIN book_management m ON m.scope=u.scope AND m.book_id=u.book_id`;
export async function assertIsolatedUploadRow(env, d, captured, row) {
  const current = await d.query(() =>
    d
      .prepare(
        env,
        `${ISOLATED_UPLOAD_ROW_SQL} WHERE u.upload_id=? AND u.account_id=? AND u.bucket=? AND u.consent_sha256=? AND u.trial_target_sha256=?`,
        row.upload_id,
        captured.accountId,
        captured.bucket,
        captured.consent,
        captured.trialTarget,
      )
      .first(),
  );
  assertIsolatedConfiguration(env, captured);
  if (
    !current ||
    row.target_id !== ISOLATED_UPLOAD_TARGET ||
    current.descriptor_json !== row.descriptor_json ||
    current.reservation_id !== row.reservation_id ||
    current.file_id !== row.file_id ||
    current.book_id !== row.book_id ||
    current.sha256 !== row.sha256
  )
    fail("upload_target_conflict", 409);
  return current;
}
