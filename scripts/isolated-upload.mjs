#!/usr/bin/env node
// Fixed project isolation policy and 013 installer. No object/AI/secret writes or retries.
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ISOLATED_UPLOAD_TARGET,
  ISOLATED_UPLOAD_BUCKET,
  ISOLATED_UPLOAD_SCHEMA_SQL,
  ISOLATED_UPLOAD_SCHEMA_HASHES,
  ISOLATED_UPLOAD_MIGRATION_SHA256,
  ISOLATED_ACCOUNTING_SQL,
} from "../cloudflare/library/isolated-upload.mjs";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";
import {
  READONLY_LEGACY_SNAPSHOT_GROUPS,
  readonlySnapshotSql,
  classifyReadonlyDatabaseSchema,
} from "./schema-readonly.mjs";
import { loadMigrationContext } from "./storage-migrate.mjs";
import { d1Client } from "./cf-library-clients.mjs";
import { boundedControlResponse } from "./cf-filename-ai-secret.mjs";
import { observedRecoveryResponse } from "./cf-recovery-transport.mjs";
import { SINGLE_TRIAL_PRIVATE_IO as IO } from "./single-trial.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const ISOLATED_CONSENT_PATH = ".local/isolated-upload/consent.json";
export const ISOLATED_FINISH_INSTALL_RUN = "isolated-install-416e986-20261024";
export const ISOLATED_CONSENT_TEXT =
  "每本不超过20,000,000 bytes；同一个production D1 authority中全部已登记责任（含旧unknown、已确认首本和新上传预留）合计不超过8,000,000,000 bytes；接受共享账号实际总用量及未完整登记的旧写责任/终态仍未知，以及可能产生的本项目费用，不保证共享账号实际占用不超过8 GB；不修改套餐或计费。以后用户在网页逐本提交即授权该文件上传，无需逐本在聊天中批准。";
const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
const source = readFileSync(
  new URL(
    "../cloudflare/library/migrations/013-isolated-upload.sql",
    import.meta.url,
  ),
  "utf8",
);
if (sha(source) !== ISOLATED_UPLOAD_MIGRATION_SHA256)
  fail("isolated_source_changed");
export const ISOLATED_INSTALL_STATEMENTS = Object.freeze(
  source
    .split(/\n(?=(?:CREATE|ALTER|DROP) )/)
    .map((v) => v.trim())
    .filter((v) => /^(CREATE|ALTER|DROP) /.test(v)),
);
// D1's single-statement parser rejects a trailing comment-only remainder.
// Keep the frozen source/statement hashes for history and schema unchanged.
export const isolatedDdlStatement = (sql) =>
  sql.replace(/^[\t ]*--[^\r\n]*(?:\r?\n|$)/gm, "").trim();
export const ISOLATED_INSTALL_LOCKS = Object.freeze([
  "CREATE TRIGGER shelf_isolated_install_reserve_closed BEFORE INSERT ON shelf_storage_reservations BEGIN SELECT RAISE(ABORT,'isolated_install_closed'); END",
  "CREATE TRIGGER shelf_isolated_install_claim_closed BEFORE UPDATE ON shelf_storage_reservations WHEN NEW.state='uploading' AND OLD.state<>'uploading' BEGIN SELECT RAISE(ABORT,'isolated_install_closed'); END",
  "CREATE TRIGGER shelf_isolated_install_registry_closed BEFORE INSERT ON shelf_storage_original_registry BEGIN SELECT RAISE(ABORT,'isolated_install_closed'); END",
]);
const normalize = (rows) =>
  rows.map((r) => ({
    type: r.type,
    name: r.name,
    tbl_name: r.tbl_name,
    sql: r.sql.trim().replace(/;$/, ""),
  }));
function schemaHash(rows) {
  if (!Array.isArray(rows) || rows.length > 256)
    fail("isolated_schema_invalid");
  return sha(normalize(rows));
}
const lockedHashes = { before: [], after: [] },
  lockedPrefixes = [];
for (const profile of ["trial-009", "trial-009-cf-metadata-v1"]) {
  const db = new DatabaseSync(":memory:");
  try {
    for (const type of ["table", "index", "view", "trigger"])
      for (const row of DATABASE_SCHEMA_PROFILES[profile])
        if (row.type === type) db.exec(row.sql);
    for (const lock of ISOLATED_INSTALL_LOCKS) db.exec(lock);
    lockedHashes.before.push(
      schemaHash(db.prepare(ISOLATED_UPLOAD_SCHEMA_SQL).all()),
    );
    for (const [index, sql] of ISOLATED_INSTALL_STATEMENTS.entries()) {
      db.exec(sql);
      if ([6, 7, 14].includes(index + 1))
        lockedPrefixes.push({
          profile,
          prefix: index + 1,
          sha256: schemaHash(db.prepare(ISOLATED_UPLOAD_SCHEMA_SQL).all()),
        });
    }
    lockedHashes.after.push(
      schemaHash(db.prepare(ISOLATED_UPLOAD_SCHEMA_SQL).all()),
    );
  } finally {
    db.close();
  }
}
export const ISOLATED_OPERATOR_BUDGETS = Object.freeze({
  install: { http: 41, ddl: 20, d1Writes: 0 },
  "finish-install": { http: 32, ddl: 11, d1Writes: 0 },
  status: { http: 2, ddl: 0, d1Writes: 0 },
  seed: { http: 4, ddl: 0, d1Writes: 1 },
  enable: { http: 6, ddl: 0, d1Writes: 1 },
  close: { http: 4, ddl: 0, d1Writes: 1 },
});
export function classifyIsolatedInstallPrefix(rows) {
  const hash = schemaHash(rows),
    matches = lockedPrefixes.filter(
      (p) => [6, 7].includes(p.prefix) && p.sha256 === hash,
    );
  if (matches.length !== 1) fail("isolated_finish_initial_schema");
  return { ...matches[0] };
}

// Read-only decoder for exactly the original stopped install, never a new run.
export async function validateIsolatedInstallFinishHistory(root, identity) {
  const dir = path.join(root, ".local/isolated-upload"),
    oldRun = path.join(dir, ISOLATED_FINISH_INSTALL_RUN);
  await IO.privateDirectory(root, dir);
  await IO.privateDirectory(root, oldRun);
  try {
    await fs.lstat(path.join(dir, "finish-install-claim.json"));
    fail("isolated_finish_already_claimed");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const equal = (actual, expected) => {
    if (sha(actual) !== sha(expected)) fail("isolated_finish_history_invalid");
  };
  // Revalidate the approved record rather than trusting a caller-provided hash.
  const approved = validateIsolatedConsent(
      await IO.readPrivate(root, path.join(root, ISOLATED_CONSENT_PATH)),
      identity,
    ),
    claim = await IO.readPrivate(root, path.join(dir, "install-claim.json"));
  if (!/^[a-f0-9]{64}$/.test(claim.protectedFactsSha256 || ""))
    fail("isolated_finish_history_invalid");
  equal(claim, {
    runId: ISOLATED_FINISH_INSTALL_RUN,
    migrationSha256: ISOLATED_UPLOAD_MIGRATION_SHA256,
    protectedFactsSha256: claim.protectedFactsSha256,
  });
  const expected = {
      "run.json": {
        schemaVersion: 1,
        action: "install",
        budget: ISOLATED_OPERATOR_BUDGETS.install,
        migrationSha256: ISOLATED_UPLOAD_MIGRATION_SHA256,
        consentSha256: approved.sha256,
      },
      "result.json": {
        state: "stopped",
        code: "isolated_write_unknown",
        requests: 21,
        ddl: 10,
        d1Writes: 0,
        uploadAllowed: false,
      },
    },
    statements = [
      null,
      ISOLATED_UPLOAD_SCHEMA_SQL,
      ISOLATED_BASE_CONTROL_SQL,
      ...READONLY_LEGACY_SNAPSHOT_GROUPS.map(readonlySnapshotSql),
      ...ISOLATED_INSTALL_LOCKS,
      ISOLATED_UPLOAD_SCHEMA_SQL,
      ...ISOLATED_INSTALL_STATEMENTS.slice(0, 7),
    ];
  for (const [index, sql] of statements.entries()) {
    const sequence = index + 1,
      stem = String(sequence).padStart(3, "0");
    expected[stem + "-intent.json"] = {
      sequence,
      kind:
        (sequence >= 11 && sequence <= 13) || sequence >= 15 ? "ddl" : "read",
      sqlSha256: sql ? sha(sql) : null,
      paramsSha256: sha([]),
    };
    expected[stem + "-outcome.json"] = {
      state: sequence === 21 ? "unknown" : "response-validated",
    };
  }
  equal((await fs.readdir(oldRun)).sort(), Object.keys(expected).sort());
  for (const [name, value] of Object.entries(expected))
    equal(await IO.readPrivate(root, path.join(oldRun, name)), value);
  return {
    protectedFactsSha256: claim.protectedFactsSha256,
    historySha256: sha({ claim, records: expected }),
  };
}
export function isolatedConsentRecord(identity) {
  if (
    identity?.authorityId !== "shelf-remote-storage-v1" ||
    identity?.bucket !== "the-shelf-books" ||
    !/^[a-f0-9]{32}$/.test(identity.accountId || "") ||
    ![
      identity.legacyDatabases?.check,
      identity.legacyDatabases?.production,
    ].every((v) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        v || "",
      ),
    ) ||
    identity.legacyDatabases.check === identity.legacyDatabases.production
  )
    fail("isolated_consent_invalid");
  return {
    schemaVersion: 1,
    consentId: "2026-10-24-project-isolated-upload",
    accountId: identity.accountId,
    productionDatabaseId: identity.legacyDatabases.production,
    authorityId: identity.authorityId,
    bucket: ISOLATED_UPLOAD_BUCKET,
    statement: ISOLATED_CONSENT_TEXT,
  };
}
export function validateIsolatedConsent(value, identity) {
  const expected = isolatedConsentRecord(identity);
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      Object.keys(expected).sort().join(",") ||
    Object.keys(expected).some((k) => value[k] !== expected[k])
  )
    fail("isolated_consent_invalid");
  return Object.freeze({ ...expected, sha256: sha(expected) });
}
export const ISOLATED_BASE_CONTROL_SQL = `SELECT (SELECT json_group_array(json_object('id',id,'identity_json',identity_json,'phase',phase,'migration_hash',migration_hash,'committed_bytes',committed_bytes,'reserved_bytes',reserved_bytes)) FROM shelf_storage_authority) AS authority_json,
 (SELECT json_group_array(json_object('id',id,'authority_identity_json',authority_identity_json,'target_json',target_json,'isolated_target_config_sha256',isolated_target_config_sha256,'state',state,'put_attempted',put_attempted,'content_verified',content_verified)) FROM shelf_storage_single_trial) AS trial_json,
 (SELECT json_group_array(json_object('scope',scope,'enabled',enabled,'generation',generation)) FROM auth_config WHERE scope='production') AS auth_json,
 (SELECT (${ISOLATED_ACCOUNTING_SQL}) FROM shelf_storage_authority a WHERE a.id=1) AS accounting_matches`;
export const ISOLATED_DEPLOY_SQL = `SELECT control.*,
 (SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${ISOLATED_UPLOAD_SCHEMA_SQL})) AS schema_json,
 (SELECT json_group_array(json_object('target_id',target_id,'authority_identity_json',authority_identity_json,'account_id',account_id,'bucket',bucket,'trial_target_sha256',trial_target_sha256,'consent_sha256',consent_sha256,'budget_bytes',budget_bytes,'enabled',enabled,'generation',generation,'created_at',created_at,'updated_at',updated_at)) FROM shelf_storage_isolated_upload_policy) AS policy_json FROM (${ISOLATED_BASE_CONTROL_SQL}) control`;
export const ISOLATED_DEPLOY_JSON_SQL =
  "json_object('authority_json',authority_json,'trial_json',trial_json,'auth_json',auth_json,'accounting_matches',accounting_matches,'schema_json',schema_json,'policy_json',policy_json)";
export const ISOLATED_CLOSE_SQL = `SELECT (SELECT json_group_array(json_object('id',id,'identity_json',identity_json)) FROM shelf_storage_authority) AS authority_json,(SELECT json_group_array(json_object('target_id',target_id,'authority_identity_json',authority_identity_json,'account_id',account_id,'bucket',bucket,'trial_target_sha256',trial_target_sha256,'consent_sha256',consent_sha256,'budget_bytes',budget_bytes,'enabled',enabled,'generation',generation,'created_at',created_at,'updated_at',updated_at)) FROM shelf_storage_isolated_upload_policy) AS policy_json`;
function closeFacts(rows, identity, consent) {
  if (!Array.isArray(rows) || rows.length !== 1) fail("isolated_facts_invalid");
  const authorities = JSON.parse(rows[0].authority_json),
    ps = JSON.parse(rows[0].policy_json),
    p = ps[0];
  if (
    authorities.length !== 1 ||
    authorities[0].id !== 1 ||
    authorities[0].identity_json !== JSON.stringify(identity) ||
    ps.length !== 1 ||
    p.target_id !== ISOLATED_UPLOAD_TARGET ||
    p.authority_identity_json !== JSON.stringify(identity) ||
    p.account_id !== identity.accountId ||
    p.bucket !== ISOLATED_UPLOAD_BUCKET ||
    p.consent_sha256 !== consent.sha256 ||
    ![0, 1].includes(p.enabled) ||
    !Number.isSafeInteger(p.generation) ||
    p.generation < 0 ||
    p.generation >= Number.MAX_SAFE_INTEGER
  )
    fail("isolated_policy_invalid");
  return { policy: p, observationSha256: sha(rows[0]) };
}
function controlFacts(rows, identity, { authClosed = false } = {}) {
  if (!Array.isArray(rows) || rows.length !== 1) fail("isolated_facts_invalid");
  const r = rows[0],
    authorities = JSON.parse(r.authority_json),
    trials = JSON.parse(r.trial_json),
    auths = JSON.parse(r.auth_json),
    a = authorities[0],
    t = trials[0],
    auth = auths[0];
  if (
    authorities.length !== 1 ||
    trials.length !== 1 ||
    auths.length !== 1 ||
    a.id !== 1 ||
    a.identity_json !== JSON.stringify(identity) ||
    a.phase !== "imported" ||
    !/^[a-f0-9]{64}$/.test(a.migration_hash || "") ||
    r.accounting_matches !== 1 ||
    !Number.isSafeInteger(a.committed_bytes) ||
    !Number.isSafeInteger(a.reserved_bytes) ||
    a.committed_bytes < 0 ||
    a.reserved_bytes < 0 ||
    a.committed_bytes + a.reserved_bytes > 8_000_000_000 ||
    !/^[a-f0-9]{64}$/.test(t.isolated_target_config_sha256 || "") ||
    t.id !== 1 ||
    t.authority_identity_json !== a.identity_json ||
    t.state !== "confirmed" ||
    t.put_attempted !== 1 ||
    t.content_verified !== 1 ||
    JSON.parse(t.target_json).accountId !== identity.accountId ||
    JSON.parse(t.target_json).bucket !== ISOLATED_UPLOAD_BUCKET ||
    auth.scope !== "production" ||
    ![0, 1].includes(auth.enabled) ||
    !Number.isSafeInteger(auth.generation) ||
    auth.generation < 1 ||
    (authClosed && auth.enabled !== 0)
  )
    fail("isolated_facts_invalid");
  return { a, t, auth };
}
export function validateIsolatedDeployRows(
  rows,
  identity,
  consent,
  { authClosed = false, requirePolicy = true, enabled } = {},
) {
  const facts = controlFacts(rows, identity, { authClosed }),
    r = rows[0];
  if (
    !ISOLATED_UPLOAD_SCHEMA_HASHES.includes(
      schemaHash(JSON.parse(r.schema_json)),
    )
  )
    fail("isolated_schema_invalid");
  const ps = JSON.parse(r.policy_json),
    p = ps[0];
  if (ps.length > 1 || (!p && requirePolicy)) fail("isolated_policy_invalid");
  if (
    p &&
    (p.target_id !== ISOLATED_UPLOAD_TARGET ||
      p.authority_identity_json !== JSON.stringify(identity) ||
      p.account_id !== identity.accountId ||
      p.bucket !== ISOLATED_UPLOAD_BUCKET ||
      p.trial_target_sha256 !== facts.t.isolated_target_config_sha256 ||
      p.consent_sha256 !== consent.sha256 ||
      p.budget_bytes !== 8_000_000_000 ||
      ![0, 1].includes(p.enabled) ||
      !Number.isSafeInteger(p.generation) ||
      p.generation < 0 ||
      p.generation >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(p.created_at) ||
      !Number.isSafeInteger(p.updated_at) ||
      p.created_at < 0 ||
      p.updated_at < p.created_at ||
      (enabled !== undefined && p.enabled !== enabled))
  )
    fail("isolated_policy_invalid");
  return { ...facts, policy: p || null, observationSha256: sha(r) };
}
export async function verifyIsolatedDeployment(
  credentials,
  resource,
  identity,
  consent,
  { fetchImpl = fetch, timeoutMs = 30000, enabled } = {},
) {
  if (
    resource.databaseName !== "the-shelf-library" ||
    identity.accountId !== credentials.accountId ||
    identity.legacyDatabases.production !== resource.databaseId
  )
    fail("isolated_target_invalid");
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${resource.databaseId}/query`;
  const response = await boundedControlResponse(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql: ISOLATED_DEPLOY_SQL, params: [] }),
    },
    timeoutMs,
  );
  const data = await response.json();
  if (
    !response.ok ||
    data.success !== true ||
    data.result?.length !== 1 ||
    data.result[0].success !== true ||
    !Array.isArray(data.result[0].results)
  )
    fail("isolated_read_failed");
  return validateIsolatedDeployRows(data.result[0].results, identity, consent, {
    enabled,
  });
}
export async function runIsolatedUpload({
  action = "status",
  execute = false,
  runId,
  expectedGeneration,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = 30000,
  context: injected,
} = {}) {
  if (
    !Object.hasOwn(ISOLATED_OPERATOR_BUDGETS, action) ||
    typeof execute !== "boolean" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    fail("isolated_arguments_invalid");
  const budget = ISOLATED_OPERATOR_BUDGETS[action];
  if (!execute)
    return {
      mode: "preview",
      action,
      requests: 0,
      budget,
      uploadAllowed: false,
      migrationSha256: ISOLATED_UPLOAD_MIGRATION_SHA256,
    };
  if (
    !/^[A-Za-z0-9][\w-]{0,79}$/.test(runId || "") ||
    (["enable", "close"].includes(action) &&
      (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0))
  )
    fail("isolated_arguments_invalid");
  const context =
      injected || (await loadMigrationContext({ root, environment })),
    identity = context.identity,
    resource = context.resources.profiles.production;
  root = context.root;
  if (
    identity.accountId !== context.credentials.accountId ||
    identity.bucket !== "the-shelf-books" ||
    resource.databaseName !== "the-shelf-library" ||
    resource.databaseId !== identity.legacyDatabases.production
  )
    fail("isolated_target_invalid");
  const dir = path.join(root, ".local/isolated-upload");
  await IO.privateDirectory(root, dir, true);
  const consent = validateIsolatedConsent(
    await IO.readPrivate(root, path.join(root, ISOLATED_CONSENT_PATH)),
    identity,
  );
  const finishHistory =
    action === "finish-install"
      ? await validateIsolatedInstallFinishHistory(root, identity)
      : null;
  const run = path.join(dir, runId);
  await fs.mkdir(run, { mode: 0o700 });
  await IO.writeImmutable(root, path.join(run, "run.json"), {
    schemaVersion: 1,
    action,
    budget,
    migrationSha256: ISOLATED_UPLOAD_MIGRATION_SHA256,
    consentSha256: consent.sha256,
  });
  let count = 0,
    ddl = 0,
    writes = 0,
    observationStem;
  const observedFetch = (url, options) =>
    observedRecoveryResponse(fetchImpl, url, options, {
      timeoutMs,
      observe: (observation) =>
        IO.writeImmutable(
          root,
          observationStem +
            (Object.hasOwn(observation, "httpStatus")
              ? "-http-status.json"
              : "-error-codes.json"),
          observation,
        ),
    });
  const client = d1Client(context.credentials, resource, {
    fetchImpl: observedFetch,
  });
  const request = async (sql, params = [], kind = "read") => {
    if (kind === "ddl") sql = isolatedDdlStatement(sql);
    if (
      ++count > budget.http ||
      (kind === "ddl" && ++ddl > budget.ddl) ||
      (kind === "write" && ++writes > budget.d1Writes)
    )
      fail("isolated_request_budget");
    const stem = path.join(run, String(count).padStart(3, "0"));
    observationStem = stem;
    await IO.writeImmutable(root, stem + "-intent.json", {
      sequence: count,
      kind,
      sqlSha256: sql ? sha(sql) : null,
      paramsSha256: sha(params),
    });
    try {
      const rows = sql
        ? await client.query(sql, params)
        : await client.verify();
      await IO.writeImmutable(root, stem + "-outcome.json", {
        state: "response-validated",
      });
      return rows;
    } catch {
      await IO.writeImmutable(root, stem + "-outcome.json", {
        state: kind === "read" ? "read-failed" : "unknown",
      });
      fail(kind === "read" ? "isolated_read_failed" : "isolated_write_unknown");
    }
  };
  const settings = async () => {
    if (++count > budget.http) fail("isolated_request_budget");
    const stem = path.join(run, String(count).padStart(3, "0"));
    observationStem = stem;
    await IO.writeImmutable(root, stem + "-intent.json", {
      sequence: count,
      kind: "read",
      operation: "fixed-worker-settings",
    });
    try {
      const { readRemoteSettings, validateRemoteBindings } =
        await import("./cf-api-deploy.mjs");
      const { validateSingleTrialTarget, SINGLE_TRIAL_TARGET_PATH } =
        await import("./single-trial-config.mjs");
      const target = validateSingleTrialTarget(
        await IO.readPrivate(root, path.join(root, SINGLE_TRIAL_TARGET_PATH)),
        identity.accountId,
      );
      const observed = await readRemoteSettings(
        context.credentials,
        "the-shelf",
        observedFetch,
        { timeoutMs },
      );
      validateRemoteBindings(observed, "production", resource.databaseId, {
        accountId: identity.accountId,
        singleTrialTarget: target,
        filenameAi: true,
        isolatedUploadConsentSha256: consent.sha256,
      });
      const result = sha(observed);
      await IO.writeImmutable(root, stem + "-outcome.json", {
        state: "response-validated",
        settingsSha256: result,
      });
      return result;
    } catch {
      await IO.writeImmutable(root, stem + "-outcome.json", {
        state: "read-failed",
      });
      fail("isolated_worker_invalid");
    }
  };
  const snapshot = async () => {
    const hashes = [];
    for (const group of READONLY_LEGACY_SNAPSHOT_GROUPS)
      hashes.push(sha(await request(readonlySnapshotSql(group))));
    return sha(hashes);
  };
  try {
    await request();
    let result;
    if (action === "finish-install") {
      const initial = classifyIsolatedInstallPrefix(
        await request(ISOLATED_UPLOAD_SCHEMA_SQL),
      );
      const controlSql =
        ISOLATED_BASE_CONTROL_SQL +
        ",(SELECT count(*) FROM browser_uploads WHERE target_id IS NOT NULL) AS mapped_upload_count" +
        ",(SELECT count(*) FROM shelf_storage_isolated_upload_policy) AS policy_count";
      const checkedControl = (rows) => {
        controlFacts(rows, identity, { authClosed: true });
        if (rows[0].mapped_upload_count !== 0 || rows[0].policy_count !== 0)
          fail("isolated_finish_data_changed");
      };
      checkedControl(await request(controlSql));
      const before = await snapshot();
      if (before !== finishHistory.protectedFactsSha256)
        fail("isolated_protected_facts_changed");
      await IO.writeImmutable(
        root,
        path.join(dir, "finish-install-claim.json"),
        {
          runId,
          originalRunId: ISOLATED_FINISH_INSTALL_RUN,
          migrationSha256: ISOLATED_UPLOAD_MIGRATION_SHA256,
          historySha256: finishHistory.historySha256,
          protectedFactsSha256: before,
          prefix: initial.prefix,
          schemaSha256: initial.sha256,
        },
      );
      for (
        let index = initial.prefix;
        index < ISOLATED_INSTALL_STATEMENTS.length;
        index++
      ) {
        const sql = ISOLATED_INSTALL_STATEMENTS[index];
        await request(
          index === 6
            ? sql.replace(/^CREATE TRIGGER /, "CREATE TRIGGER IF NOT EXISTS ")
            : sql,
          [],
          "ddl",
        );
        if (index === 6) {
          const afterCreate = classifyIsolatedInstallPrefix(
            await request(ISOLATED_UPLOAD_SCHEMA_SQL),
          );
          if (
            afterCreate.prefix !== 7 ||
            afterCreate.profile !== initial.profile
          )
            fail("isolated_schema_invalid");
        }
      }
      const complete = lockedPrefixes.find(
        (p) => p.profile === initial.profile && p.prefix === 14,
      );
      if (
        schemaHash(await request(ISOLATED_UPLOAD_SCHEMA_SQL)) !==
        complete.sha256
      )
        fail("isolated_schema_invalid");
      const after = await snapshot();
      if (after !== before) fail("isolated_protected_facts_changed");
      checkedControl(await request(controlSql));
      for (const sql of ISOLATED_INSTALL_LOCKS)
        await request(
          "DROP TRIGGER " + sql.match(/^CREATE TRIGGER (\w+)/)[1],
          [],
          "ddl",
        );
      if (
        !ISOLATED_UPLOAD_SCHEMA_HASHES.includes(
          schemaHash(await request(ISOLATED_UPLOAD_SCHEMA_SQL)),
        )
      )
        fail("isolated_schema_invalid");
      result = {
        action,
        originalRunId: ISOLATED_FINISH_INSTALL_RUN,
        initialPrefix: initial.prefix,
        protectedFactsSha256: after,
        policySeeded: false,
        uploadAllowed: false,
      };
    } else if (action === "install") {
      const initial = await request(ISOLATED_UPLOAD_SCHEMA_SQL),
        classified = classifyReadonlyDatabaseSchema(initial);
      if (
        !classified ||
        !["trial-009", "trial-009-cf-metadata-v1"].includes(classified.profile)
      )
        fail("isolated_install_initial_schema");
      controlFacts(await request(ISOLATED_BASE_CONTROL_SQL), identity, {
        authClosed: true,
      });
      const before = await snapshot();
      await IO.writeImmutable(root, path.join(dir, "install-claim.json"), {
        runId,
        migrationSha256: ISOLATED_UPLOAD_MIGRATION_SHA256,
        protectedFactsSha256: before,
      });
      for (const sql of ISOLATED_INSTALL_LOCKS) await request(sql, [], "ddl");
      if (
        !lockedHashes.before.includes(
          schemaHash(await request(ISOLATED_UPLOAD_SCHEMA_SQL)),
        )
      )
        fail("isolated_install_lock_invalid");
      for (const sql of ISOLATED_INSTALL_STATEMENTS)
        await request(sql, [], "ddl");
      if (
        !lockedHashes.after.includes(
          schemaHash(await request(ISOLATED_UPLOAD_SCHEMA_SQL)),
        )
      )
        fail("isolated_schema_invalid");
      const after = await snapshot();
      if (after !== before) fail("isolated_protected_facts_changed");
      const postControl = await request(
        ISOLATED_BASE_CONTROL_SQL +
          ",(SELECT count(*) FROM browser_uploads WHERE target_id IS NOT NULL) AS mapped_upload_count",
      );
      controlFacts(postControl, identity, { authClosed: true });
      if (postControl[0].mapped_upload_count !== 0)
        fail("isolated_legacy_mapping_changed");
      for (const sql of ISOLATED_INSTALL_LOCKS)
        await request(
          "DROP TRIGGER " + sql.match(/^CREATE TRIGGER (\w+)/)[1],
          [],
          "ddl",
        );
      if (
        !ISOLATED_UPLOAD_SCHEMA_HASHES.includes(
          schemaHash(await request(ISOLATED_UPLOAD_SCHEMA_SQL)),
        )
      )
        fail("isolated_schema_invalid");
      result = {
        action,
        protectedFactsSha256: after,
        policySeeded: false,
        uploadAllowed: false,
      };
    } else {
      const probeSql =
        action === "close" ? ISOLATED_CLOSE_SQL : ISOLATED_DEPLOY_SQL;
      const rows = await request(probeSql),
        before =
          action === "close"
            ? closeFacts(rows, identity, consent)
            : validateIsolatedDeployRows(rows, identity, consent, {
                authClosed: action === "seed",
                requirePolicy: action !== "seed",
              });
      if (action === "status")
        result = {
          action,
          enabled: before.policy.enabled,
          generation: before.policy.generation,
          observationSha256: before.observationSha256,
          uploadAllowed: false,
        };
      else {
        if (action === "seed" && before.policy) fail("isolated_policy_exists");
        if (
          action !== "seed" &&
          (before.policy.generation !== expectedGeneration ||
            (action === "enable" && before.policy.enabled === 1))
        )
          fail("isolated_policy_precondition");
        const claim =
          action === "seed"
            ? "seed-claim.json"
            : `${action}-generation-${expectedGeneration}-claim.json`;
        await IO.writeImmutable(root, path.join(dir, claim), {
          runId,
          action,
          observationSha256: before.observationSha256,
          consentSha256: consent.sha256,
        });
        const beforeSettings = action === "enable" ? await settings() : null;
        const now = Date.now();
        let changed;
        if (action === "seed")
          changed = await request(
            "INSERT INTO shelf_storage_isolated_upload_policy(target_id,authority_identity_json,account_id,bucket,trial_target_sha256,consent_sha256,budget_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,8000000000,?,?) RETURNING target_id",
            [
              ISOLATED_UPLOAD_TARGET,
              JSON.stringify(identity),
              identity.accountId,
              ISOLATED_UPLOAD_BUCKET,
              before.t.isolated_target_config_sha256,
              consent.sha256,
              now,
              now,
            ],
            "write",
          );
        else {
          const update =
            "UPDATE shelf_storage_isolated_upload_policy SET enabled=?,generation=generation+1,updated_at=? WHERE target_id=? AND generation=? AND consent_sha256=? AND authority_identity_json=?";
          changed = await request(
            action === "enable"
              ? `WITH isolated_guard AS MATERIALIZED (${ISOLATED_DEPLOY_SQL}) ${update} AND (SELECT ${ISOLATED_DEPLOY_JSON_SQL} FROM isolated_guard)=? RETURNING target_id`
              : update + " RETURNING target_id",
            [
              action === "enable" ? 1 : 0,
              now,
              ISOLATED_UPLOAD_TARGET,
              expectedGeneration,
              consent.sha256,
              JSON.stringify(identity),
              ...(action === "enable" ? [JSON.stringify(rows[0])] : []),
            ],
            "write",
          );
        }
        if (changed.length !== 1) fail("isolated_policy_cas_failed");
        const afterRows = await request(probeSql),
          after =
            action === "close"
              ? closeFacts(afterRows, identity, consent)
              : validateIsolatedDeployRows(afterRows, identity, consent, {
                  enabled: action === "enable" ? 1 : 0,
                });
        if (
          after.policy.enabled !== (action === "enable" ? 1 : 0) ||
          after.policy.generation !==
            (action === "seed" ? 0 : expectedGeneration + 1)
        )
          fail("isolated_policy_readback_invalid");
        if (action === "enable" && (await settings()) !== beforeSettings)
          fail("isolated_worker_changed");
        result = {
          action,
          enabled: after.policy.enabled,
          generation: after.policy.generation,
          observationSha256: after.observationSha256,
          uploadAllowed: false,
        };
      }
    }
    const output = {
      mode: "executed",
      ...result,
      requests: count,
      ddl,
      d1Writes: writes,
    };
    await IO.writeImmutable(root, path.join(run, "result.json"), output);
    return output;
  } catch (error) {
    try {
      await IO.writeImmutable(root, path.join(run, "result.json"), {
        state: "stopped",
        code: /^isolated_[a-z_]+$/.test(error.code || "")
          ? error.code
          : "isolated_private_io_failed",
        requests: count,
        ddl,
        d1Writes: writes,
        uploadAllowed: false,
      });
    } catch {}
    throw error;
  }
}
export async function main(argv = process.argv.slice(2)) {
  const args = [...argv],
    action = args[0] && !args[0].startsWith("--") ? args.shift() : "status",
    options = { action };
  const seen = new Set();
  while (args.length) {
    const key = args.shift();
    if (seen.has(key)) fail("isolated_arguments_invalid");
    seen.add(key);
    if (key === "--execute") {
      options.execute = true;
      continue;
    }
    if (!["--run", "--expected-generation"].includes(key) || !args.length)
      fail("isolated_arguments_invalid");
    const value = args.shift();
    if (key === "--expected-generation" && !/^(0|[1-9]\d*)$/.test(value))
      fail("isolated_arguments_invalid");
    options[key === "--run" ? "runId" : "expectedGeneration"] =
      key === "--run" ? value : Number(value);
  }
  return runIsolatedUpload(options);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(
        /^isolated_[a-z_]+$/.test(e.code || "")
          ? e.code
          : "isolated_operation_stopped",
      );
      process.exitCode = 1;
    });
