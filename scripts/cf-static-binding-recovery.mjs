#!/usr/bin/env node
// One fixed incident recovery. No Wrangler deploy, automatic retry, business secret use,
// auth mutation, D1/R2 writes, resource discovery or reusable recovery capability.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  readProjectEnvironment,
  readPrivateJson,
  validateDeployConfig,
  validateRemoteBindings,
  FILENAME_AI_SECRET_NAMES,
} from "./cf-api-deploy.mjs";
import { STATIC_WORKER_SOURCE } from "./cf-deploy.mjs";
import {
  validateSingleTrialTarget,
  SINGLE_TRIAL_TARGET_PATH,
} from "./single-trial-config.mjs";
import { SINGLE_TRIAL_PRIVATE_IO as IO } from "./single-trial.mjs";
import { boundedControlResponse } from "./cf-filename-ai-secret.mjs";
import { AUTH_SQL } from "./cf-production-auth.mjs";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const RECOVERY_SOURCE_VERSION = "aaa7a94f-6478-4d76-aa65-03a3d2461d25";
export const RECOVERY_ASSETS_VERSION = "08d46159-f7a7-4eec-b47c-30a9502aad2c";
export const RECOVERY_LIMITS = Object.freeze({
  http: 13,
  versionPosts: 1,
  deploymentPosts: 1,
  responseBytes: 1_048_576,
  timeoutMs: 30_000,
});
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev",
  WORKER = "the-shelf",
  MODULE = "static-worker.mjs";
const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
const fail = (code) => {
  const e = new Error(`static_binding_recovery_${code}`);
  e.code = e.message;
  throw e;
};
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const expectedAuthSchema = DATABASE_SCHEMA_PROFILES["trial-009"].filter(
  (r) =>
    (r.type === "table" && ["auth_config", "sessions"].includes(r.name)) ||
    (r.type === "trigger" && ["auth_config", "sessions"].includes(r.tbl_name)),
);
export const RECOVERY_AUTH_SQL = `SELECT (SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${AUTH_SQL.schema})) AS schema_json,(SELECT json_group_array(json_object('scope',scope,'origin',origin,'scheme',scheme,'generation',generation,'enabled',enabled,'updated_at',updated_at)) FROM auth_config WHERE scope='production') AS auth_json,(SELECT count(*) FROM sessions WHERE scope='production' AND revoked=0) AS unrevoked_sessions`;
export function validateRecoveryAuth(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !exact(rows[0], ["schema_json", "auth_json", "unrevoked_sessions"])
  )
    fail("auth_invalid");
  let schema, auth;
  try {
    schema = JSON.parse(rows[0].schema_json);
    auth = JSON.parse(rows[0].auth_json);
  } catch {
    fail("auth_invalid");
  }
  if (
    JSON.stringify(schema) !== JSON.stringify(expectedAuthSchema) ||
    !Array.isArray(auth) ||
    auth.length !== 1 ||
    !exact(auth[0], [
      "scope",
      "origin",
      "scheme",
      "generation",
      "enabled",
      "updated_at",
    ]) ||
    auth[0].scope !== "production" ||
    auth[0].origin !== ORIGIN ||
    auth[0].scheme !== "owner-access-key-v1" ||
    auth[0].generation !== 2 ||
    auth[0].enabled !== 0 ||
    !Number.isSafeInteger(auth[0].updated_at) ||
    auth[0].updated_at < 0 ||
    rows[0].unrevoked_sessions !== 0
  )
    fail("auth_invalid");
  return sha(rows[0]);
}
export function recoveryUploadMetadata() {
  return {
    main_module: MODULE,
    compatibility_date: "2026-10-15",
    bindings: [
      { name: "ASSETS", type: "assets" },
      ...FILENAME_AI_SECRET_NAMES.map((name) => ({
        name,
        type: "inherit",
        version_id: RECOVERY_SOURCE_VERSION,
      })),
    ],
    keep_assets: true,
  };
}
export function staticBindings(bindings) {
  if (
    !Array.isArray(bindings) ||
    bindings.length !== 5 ||
    new Set(bindings.map((b) => b.name)).size !== 5 ||
    !bindings.every(
      (b) =>
        exact(b, ["name", "type"]) &&
        (b.name === "ASSETS"
          ? b.type === "assets"
          : FILENAME_AI_SECRET_NAMES.includes(b.name) &&
            b.type === "secret_text"),
    )
  )
    fail("bindings_invalid");
  return sha(
    bindings
      .map(({ name, type }) => ({ name, type }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  );
}
export function validateRecoveryVersion(value, versionId) {
  if (!value || value.id !== versionId || !uuid(versionId) || !value.resources)
    fail("version_invalid");
  return staticBindings(value.resources.bindings);
}
export function deploymentVersion(value, expected) {
  if (
    !exact(value, ["deployments"]) ||
    !Array.isArray(value.deployments) ||
    value.deployments.length !== 1
  )
    fail("deployment_invalid");
  const row = value.deployments[0];
  if (
    !uuid(row?.id) ||
    !Array.isArray(row.versions) ||
    row.versions.length !== 1 ||
    !exact(row.versions[0], ["version_id", "percentage"]) ||
    row.versions[0].version_id !== expected ||
    row.versions[0].percentage !== 100
  )
    fail("deployment_invalid");
  return row.id;
}
export function sourceVersion(value, context) {
  if (
    value?.id !== RECOVERY_SOURCE_VERSION ||
    !Array.isArray(value.resources?.bindings)
  )
    fail("source_invalid");
  const bindings = value.resources.bindings;
  try {
    validateRemoteBindings(
      { bindings },
      "production",
      context.resource.databaseId,
      {
        accountId: context.credentials.accountId,
        singleTrialTarget: context.target,
        filenameAi: true,
      },
    );
  } catch {
    fail("source_invalid");
  }
  if (
    bindings.length !== 14 ||
    !bindings.every((b) => {
      if (b.name === "DB")
        return (
          (exact(b, ["name", "type", "id"]) ||
            exact(b, ["name", "type", "id", "database_id"])) &&
          b.id === context.resource.databaseId &&
          (!Object.hasOwn(b, "database_id") ||
            b.database_id === context.resource.databaseId)
        );
      if (b.name === "BOOKS") return exact(b, ["name", "type", "bucket_name"]);
      if (b.type === "plain_text") return exact(b, ["name", "type", "text"]);
      return exact(b, ["name", "type"]);
    })
  )
    fail("source_invalid");
  return sha([...bindings].sort((a, b) => (a.name < b.name ? -1 : 1)));
}
export async function loadContext(root, environment) {
  root = await fs.realpath(root);
  const loaded = await readProjectEnvironment(root, environment),
    credentials = loaded.credentials;
  if (
    credentials.ci ||
    loaded.fileEnvironment.SHELF_R2_ACCOUNT_ID !== credentials.accountId ||
    loaded.fileEnvironment.SHELF_R2_BUCKET !== "the-shelf-books"
  )
    fail("target_invalid");
  const config = validateDeployConfig(
      await readPrivateJson(root, ".local/cf03/deploy.json"),
    ),
    resource = config.profiles.production;
  const target = validateSingleTrialTarget(
    await readPrivateJson(root, SINGLE_TRIAL_TARGET_PATH),
    credentials.accountId,
  );
  return { root, credentials, resource, target };
}
export async function runStaticBindingRecovery({
  execute = false,
  runId,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = RECOVERY_LIMITS.timeoutMs,
} = {}) {
  if (execute === false)
    return {
      mode: "preview",
      requests: 0,
      limits: RECOVERY_LIMITS,
      sourceVersion: RECOVERY_SOURCE_VERSION,
      assetsVersion: RECOVERY_ASSETS_VERSION,
      cloudMutation: false,
    };
  if (
    execute !== true ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId || "") ||
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RECOVERY_LIMITS.timeoutMs
  )
    fail("options_invalid");
  const context = await loadContext(root, environment);
  root = context.root;
  const dir = path.join(root, ".local/cf-static-binding-recovery");
  await IO.privateDirectory(root, dir, true);
  const run = path.join(dir, runId);
  await fs.mkdir(run, { mode: 0o700 });
  const identity = {
    accountId: context.credentials.accountId,
    worker: WORKER,
    productionDatabaseId: context.resource.databaseId,
    sourceVersion: RECOVERY_SOURCE_VERSION,
    assetsVersion: RECOVERY_ASSETS_VERSION,
  };
  await IO.writeImmutable(root, path.join(run, "run.json"), {
    schemaVersion: 1,
    identity,
    limits: RECOVERY_LIMITS,
    staticModuleSha256: sha(STATIC_WORKER_SOURCE),
  });
  const base = `https://api.cloudflare.com/client/v4/accounts/${context.credentials.accountId}`,
    workerBase = `${base}/workers/scripts/${WORKER}`;
  let count = 0,
    versionPosts = 0,
    deploymentPosts = 0;
  const request = async (
    url,
    { label, method = "GET", body, mutation } = {},
  ) => {
    if (
      ++count > RECOVERY_LIMITS.http ||
      (mutation === "version" && ++versionPosts > 1) ||
      (mutation === "deployment" && ++deploymentPosts > 1)
    )
      fail("request_budget");
    const stem = path.join(run, String(count).padStart(3, "0"));
    await IO.writeImmutable(root, stem + "-intent.json", {
      sequence: count,
      label,
      method,
      mutation: mutation || null,
      bodySha256:
        body instanceof FormData
          ? sha(recoveryUploadMetadata())
          : body
            ? sha(body)
            : null,
    });
    try {
      const response = await boundedControlResponse(
          fetchImpl,
          url,
          {
            method,
            headers: {
              Authorization: `Bearer ${context.credentials.token}`,
              ...(typeof body === "string"
                ? { "Content-Type": "application/json" }
                : {}),
            },
            ...(body ? { body } : {}),
          },
          timeoutMs,
        ),
        data = await response.json();
      if (
        !response.ok ||
        data.success !== true ||
        (data.errors !== undefined &&
          data.errors !== null &&
          (!Array.isArray(data.errors) || data.errors.length)) ||
        !Object.hasOwn(data, "result")
      )
        fail("response_invalid");
      await IO.writeImmutable(root, stem + "-outcome.json", {
        state: "response-validated",
      });
      return data.result;
    } catch {
      await IO.writeImmutable(root, stem + "-outcome.json", {
        state: mutation ? "unknown" : "read-failed",
      });
      fail(mutation ? "mutation_unknown" : "read_failed");
    }
  };
  const auth = async (label) => {
    const result = await request(
      `${base}/d1/database/${context.resource.databaseId}/query`,
      {
        label,
        method: "POST",
        body: JSON.stringify({ sql: RECOVERY_AUTH_SQL, params: [] }),
      },
    );
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      result[0]?.success !== true ||
      !Array.isArray(result[0].results)
    )
      fail("auth_invalid");
    return validateRecoveryAuth(result[0].results);
  };
  let uploadedVersion;
  try {
    const sourceSha256 = sourceVersion(
      await request(`${workerBase}/versions/${RECOVERY_SOURCE_VERSION}`, {
        label: "immutable-source",
      }),
      context,
    );
    const settings = await request(`${workerBase}/settings`, {
      label: "empty-latest-settings",
    });
    if (!Array.isArray(settings?.bindings) || settings.bindings.length !== 0)
      fail("settings_invalid");
    const database = await request(
      `${base}/d1/database/${context.resource.databaseId}`,
      { label: "production-database-identity" },
    );
    if (
      database?.uuid !== context.resource.databaseId ||
      database.name !== context.resource.databaseName
    )
      fail("database_invalid");
    deploymentVersion(
      await request(`${workerBase}/deployments?page=1&per_page=1`, {
        label: "retained-active-deployment",
      }),
      RECOVERY_SOURCE_VERSION,
    );
    const latest = await request(`${workerBase}/versions?page=1&per_page=1`, {
      label: "fixed-latest-assets-version",
    });
    if (
      !Array.isArray(latest?.items) ||
      latest.items.length !== 1 ||
      latest.items[0]?.id !== RECOVERY_ASSETS_VERSION
    )
      fail("latest_invalid");
    const authSha256 = await auth("closed-auth-before");
    const metadata = recoveryUploadMetadata(),
      form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set(
      MODULE,
      new File([STATIC_WORKER_SOURCE], MODULE, {
        type: "application/javascript+module",
      }),
    );
    await IO.writeImmutable(root, path.join(dir, "attempt-claim.json"), {
      schemaVersion: 1,
      runId,
      identity,
      sourceSha256,
      authSha256,
      metadataSha256: sha(metadata),
      staticModuleSha256: sha(STATIC_WORKER_SOURCE),
    });
    const uploaded = await request(
      `${workerBase}/versions?bindings_inherit=strict`,
      {
        label: "single-version-upload",
        method: "POST",
        body: form,
        mutation: "version",
      },
    );
    uploadedVersion = uploaded?.id;
    if (
      !uuid(uploadedVersion) ||
      [RECOVERY_SOURCE_VERSION, RECOVERY_ASSETS_VERSION].includes(
        uploadedVersion,
      )
    )
      fail("version_invalid");
    let responseBindingsSha256;
    if (uploaded.resources && Object.hasOwn(uploaded.resources, "bindings"))
      responseBindingsSha256 = validateRecoveryVersion(
        uploaded,
        uploadedVersion,
      );
    await IO.writeImmutable(root, path.join(run, "uploaded-version.json"), {
      versionId: uploadedVersion,
      ...(responseBindingsSha256 ? { responseBindingsSha256 } : {}),
    });
    const uploadedBindingsSha256 = validateRecoveryVersion(
      await request(`${workerBase}/versions/${uploadedVersion}`, {
        label: "independent-uploaded-version",
      }),
      uploadedVersion,
    );
    if (
      responseBindingsSha256 &&
      responseBindingsSha256 !== uploadedBindingsSha256
    )
      fail("version_changed");
    await IO.writeImmutable(root, path.join(run, "deployment-claim.json"), {
      versionId: uploadedVersion,
      bindingsSha256: uploadedBindingsSha256,
      force: true,
    });
    const deployBody = JSON.stringify({
      strategy: "percentage",
      versions: [{ version_id: uploadedVersion, percentage: 100 }],
      annotations: {
        "workers/message":
          "The Shelf fixed static binding recovery; retained secrets inherited by immutable version",
      },
    });
    const deployed = await request(`${workerBase}/deployments?force=true`, {
      label: "single-static-deployment",
      method: "POST",
      body: deployBody,
      mutation: "deployment",
    });
    if (
      !uuid(deployed?.id) ||
      deployed.strategy !== "percentage" ||
      !Array.isArray(deployed.versions) ||
      deployed.versions.length !== 1 ||
      deployed.versions[0]?.version_id !== uploadedVersion ||
      deployed.versions[0]?.percentage !== 100
    )
      fail("deployment_invalid");
    const activeId = deploymentVersion(
      await request(`${workerBase}/deployments?page=1&per_page=1`, {
        label: "independent-active-deployment",
      }),
      uploadedVersion,
    );
    if (activeId !== deployed.id) fail("deployment_invalid");
    if (
      validateRecoveryVersion(
        await request(`${workerBase}/versions/${uploadedVersion}`, {
          label: "immutable-deployed-version",
        }),
        uploadedVersion,
      ) !== uploadedBindingsSha256
    )
      fail("version_changed");
    const after = await request(`${workerBase}/settings`, {
      label: "exact-static-settings",
    });
    if (staticBindings(after?.bindings) !== uploadedBindingsSha256)
      fail("settings_invalid");
    if ((await auth("closed-auth-after")) !== authSha256) fail("auth_changed");
    const result = {
      mode: "executed",
      outcome: "static_bindings_verified",
      requests: count,
      versionPosts,
      deploymentPosts,
      versionId: uploadedVersion,
      sourceVersion: RECOVERY_SOURCE_VERSION,
      assetsVersion: RECOVERY_ASSETS_VERSION,
      force: true,
      authEnabled: false,
      deploymentVersionVerified: true,
      codeContentVerified: false,
      assetsRuntimeVerified: false,
      uploadAllowed: false,
    };
    await IO.writeImmutable(root, path.join(run, "result.json"), result);
    return result;
  } catch (error) {
    try {
      await IO.writeImmutable(root, path.join(run, "result.json"), {
        state: "stopped",
        code: /^static_binding_recovery_[a-z_]+$/.test(error.code || "")
          ? error.code
          : "static_binding_recovery_private_io_failed",
        requests: count,
        versionPosts,
        deploymentPosts,
        ...(uploadedVersion ? { versionId: uploadedVersion } : {}),
        uploadAllowed: false,
      });
    } catch {}
    throw error;
  }
}
export async function main(argv = process.argv.slice(2)) {
  const options = {},
    seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) fail("options_invalid");
    seen.add(key);
    if (key === "--execute") options.execute = true;
    else if (key === "--run" && i + 1 < argv.length) options.runId = argv[++i];
    else fail("options_invalid");
  }
  return runStaticBindingRecovery(options);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(
        /^static_binding_recovery_[a-z_]+$/.test(e.code || "")
          ? e.code
          : "static_binding_recovery_stopped",
      );
      process.exitCode = 1;
    });
