#!/usr/bin/env node
// Fixed recovery via the Workers JSON API. The old unknown attempt is untouched.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  RECOVERY_SOURCE_VERSION,
  RECOVERY_ASSETS_VERSION,
  RECOVERY_AUTH_SQL,
  validateRecoveryAuth,
  validateRecoveryVersion,
  staticBindings,
  deploymentVersion,
  sourceVersion,
  loadContext,
} from "./cf-static-binding-recovery.mjs";
import { FILENAME_AI_SECRET_NAMES } from "./cf-api-deploy.mjs";
import { STATIC_WORKER_SOURCE } from "./cf-deploy.mjs";
import { SINGLE_TRIAL_PRIVATE_IO as IO } from "./single-trial.mjs";
import { observedRecoveryResponse } from "./cf-recovery-transport.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)),
  WORKER = "the-shelf",
  MODULE = "static-worker.mjs";
export const RECOVERY_V2_DIRECTORY = ".local/cf-static-binding-recovery-v2";
export const RECOVERY_ASSET_DIRECTORY =
  ".local/isolated-upload/static-fix-disabled-dist";
export const FROZEN_ASSET_SHA256 =
  "6af1677ac59cd57db7c6498453f01e0a33b6fffde4e0e0f7ac05b57ec0e6da8f";
export const RECOVERY_ASSETS_CONFIG = Object.freeze({
  html_handling: "force-trailing-slash",
  not_found_handling: "404-page",
});
export const RECOVERY_V2_LIMITS = Object.freeze({
  http: 30,
  assetSessions: 1,
  assetBuckets: 16,
  assetBytes: 20_000_000,
  versionPosts: 1,
  deploymentPosts: 1,
  responseBytes: 1_048_576,
  timeoutMs: 30_000,
});
const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
});
const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest("hex");
const fail = (code) => {
  const e = new Error(`static_binding_recovery_v2_${code}`);
  e.code = e.message;
  throw e;
};
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const require = createRequire(import.meta.url);
export function recoveryAssetHash(bytes, filename) {
  return require("blake3-wasm")
    .hash(bytes.toString("base64") + path.extname(filename).slice(1))
    .toString("hex")
    .slice(0, 32);
}
export async function loadFrozenRecoveryAssets(root) {
  await IO.privateDirectory(root, path.join(root, ".local/isolated-upload"));
  const base = path.join(root, RECOVERY_ASSET_DIRECTORY),
    rows = [],
    contents = new Map();
  let total = 0;
  const walk = async (directory) => {
    const st = await fs.lstat(directory);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid() ||
      (st.mode & 0o022) !== 0
    )
      fail("asset_path_invalid");
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name))
        fail("asset_path_invalid");
      const filename = path.join(directory, name),
        entry = await fs.lstat(filename);
      if (entry.isDirectory()) {
        await walk(filename);
        continue;
      }
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.uid !== process.getuid() ||
        entry.nlink !== 1 ||
        (entry.mode & 0o022) !== 0 ||
        !Object.hasOwn(MIME, path.extname(filename)) ||
        (total += entry.size) > RECOVERY_V2_LIMITS.assetBytes ||
        rows.length >= 1312
      )
        fail("asset_file_invalid");
      const handle = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes;
      try {
        const before = await handle.stat();
        if (before.ino !== entry.ino || before.dev !== entry.dev)
          fail("asset_file_changed");
        bytes = await handle.readFile();
        const after = await handle.stat();
        if (
          bytes.length !== entry.size ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.nlink !== 1
        )
          fail("asset_file_changed");
      } finally {
        await handle.close();
      }
      const assetPath =
          "/" + path.relative(base, filename).split(path.sep).join("/"),
        row = {
          path: assetPath,
          hash: recoveryAssetHash(bytes, filename),
          size: bytes.length,
          sha256: sha(bytes),
        };
      rows.push(row);
      contents.set(assetPath, bytes);
    }
  };
  await walk(base);
  rows.sort(byPath);
  if (
    rows.length !== 1312 ||
    total !== 12_516_770 ||
    sha(rows) !== FROZEN_ASSET_SHA256
  )
    fail("asset_manifest_changed");
  const runtime = JSON.parse(
    contents.get("/data/runtime.json").toString("utf8"),
  );
  if (runtime.apiMode !== "disabled") fail("asset_runtime_invalid");
  const manifest = Object.fromEntries(
      rows.map((r) => [r.path, { hash: r.hash, size: r.size }]),
    ),
    byHash = new Map();
  for (const row of rows) {
    const previous = byHash.get(row.hash);
    if (
      previous &&
      (previous.sha256 !== row.sha256 || previous.size !== row.size)
    )
      fail("asset_hash_collision");
    if (!previous) byHash.set(row.hash, row);
  }
  return { rows, manifest, byHash, contents, bytes: total };
}
export function validateRecoveryJwt(jwt, now = Date.now()) {
  if (
    typeof jwt !== "string" ||
    jwt.length > 32_768 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)
  )
    fail("asset_jwt_invalid");
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {
    fail("asset_jwt_invalid");
  }
  if (
    !Number.isSafeInteger(payload?.exp) ||
    payload.exp <= Math.floor(now / 1000) + 30 ||
    payload.exp > Math.floor(now / 1000) + 7200
  )
    fail("asset_jwt_invalid");
  return jwt;
}
export function validateRecoveryBuckets(value, byHash) {
  validateRecoveryJwt(value?.jwt);
  if (
    !Array.isArray(value?.buckets) ||
    value.buckets.length > RECOVERY_V2_LIMITS.assetBuckets
  )
    fail("asset_buckets_invalid");
  const single =
    JSON.parse(
      Buffer.from(value.jwt.split(".")[1], "base64url").toString("utf8"),
    ).wrangler_single_asset_uploads === true;
  const seen = new Set();
  let bytes = 0;
  const buckets = value.buckets.map((bucket) => {
    if (
      !Array.isArray(bucket) ||
      bucket.length === 0 ||
      bucket.length > byHash.size
    )
      fail("asset_buckets_invalid");
    return bucket.map((hash) => {
      if (
        typeof hash !== "string" ||
        !/^[a-f0-9]{32}$/.test(hash) ||
        !byHash.has(hash) ||
        seen.has(hash)
      )
        fail("asset_buckets_invalid");
      seen.add(hash);
      const row = byHash.get(hash);
      if ((bytes += row.size) > RECOVERY_V2_LIMITS.assetBytes)
        fail("asset_bytes_exceeded");
      return row;
    });
  });
  const uploads = single ? buckets.flat().map((row) => [row]) : buckets;
  if (uploads.length > RECOVERY_V2_LIMITS.assetBuckets)
    fail("asset_buckets_invalid");
  return { buckets: uploads, bytes, single };
}
export function recoveryV2UploadBody(jwt) {
  validateRecoveryJwt(jwt);
  return {
    main_module: MODULE,
    compatibility_date: "2026-10-15",
    modules: [
      {
        name: MODULE,
        content_type: "application/javascript+module",
        content_base64: Buffer.from(STATIC_WORKER_SOURCE).toString("base64"),
      },
    ],
    assets: { jwt, config: { ...RECOVERY_ASSETS_CONFIG } },
    bindings: [
      { name: "ASSETS", type: "assets" },
      ...FILENAME_AI_SECRET_NAMES.map((name) => ({
        name,
        type: "inherit",
        version_id: RECOVERY_SOURCE_VERSION,
      })),
    ],
  };
}
export function validateRecoveryV2Version(value, versionId) {
  if (
    !uuid(versionId) ||
    value?.id !== versionId ||
    value.main_module !== MODULE ||
    value.compatibility_date !== "2026-10-15" ||
    !Array.isArray(value.modules) ||
    value.modules.length !== 1
  )
    fail("version_invalid");
  const module = value.modules[0];
  if (
    !module ||
    Object.keys(module).length !== 3 ||
    module.name !== MODULE ||
    module.content_type !== "application/javascript+module" ||
    module.content_base64 !==
      Buffer.from(STATIC_WORKER_SOURCE).toString("base64")
  )
    fail("module_invalid");
  return staticBindings(value.bindings);
}

export async function runStaticBindingRecoveryV2({
  execute = false,
  runId,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = RECOVERY_V2_LIMITS.timeoutMs,
  // Test-only dependency injection; the CLI never accepts an asset loader/path.
  loadAssets = loadFrozenRecoveryAssets,
} = {}) {
  if (execute === false)
    return {
      mode: "preview",
      requests: 0,
      limits: RECOVERY_V2_LIMITS,
      frozenAssetSha256: FROZEN_ASSET_SHA256,
      cloudMutation: false,
    };
  if (
    execute !== true ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId || "") ||
    typeof fetchImpl !== "function" ||
    typeof loadAssets !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RECOVERY_V2_LIMITS.timeoutMs
  )
    fail("options_invalid");
  const context = await loadContext(root, environment);
  root = context.root;
  const assets = await loadAssets(root),
    dir = path.join(root, RECOVERY_V2_DIRECTORY);
  await IO.privateDirectory(root, dir, true);
  const run = path.join(dir, runId);
  await fs.mkdir(run, { mode: 0o700 });
  const identity = {
    accountId: context.credentials.accountId,
    worker: WORKER,
    productionDatabaseId: context.resource.databaseId,
    sourceVersion: RECOVERY_SOURCE_VERSION,
    assetsVersion: RECOVERY_ASSETS_VERSION,
    frozenAssetSha256: FROZEN_ASSET_SHA256,
  };
  await IO.writeImmutable(root, path.join(run, "run.json"), {
    schemaVersion: 1,
    identity,
    limits: RECOVERY_V2_LIMITS,
  });
  const base = `https://api.cloudflare.com/client/v4/accounts/${context.credentials.accountId}`,
    workerBase = `${base}/workers/scripts/${WORKER}`,
    versionBase = `${base}/workers/workers/${WORKER}/versions`;
  let count = 0,
    assetSessions = 0,
    assetBuckets = 0,
    assetBytes = 0,
    versionPosts = 0,
    deploymentPosts = 0,
    uploadedVersion;
  const request = async (
    url,
    {
      label,
      method = "GET",
      body,
      mutation,
      bearer,
      contentType,
      bodySha256,
      allowAssetCreated = false,
    } = {},
  ) => {
    if (
      ++count > RECOVERY_V2_LIMITS.http ||
      (mutation === "session" && ++assetSessions > 1) ||
      (mutation === "asset" && ++assetBuckets > 16) ||
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
      bodySha256: bodySha256 || (typeof body === "string" ? sha(body) : null),
    });
    try {
      const response = await observedRecoveryResponse(
          fetchImpl,
          url,
          {
            method,
            headers: {
              Authorization: `Bearer ${bearer || context.credentials.token}`,
              ...(contentType || typeof body === "string"
                ? { "Content-Type": contentType || "application/json" }
                : {}),
            },
            ...(body ? { body } : {}),
          },
          {
            timeoutMs,
            allowAssetCreated,
            observe: (observation) =>
              IO.writeImmutable(
                root,
                stem +
                  (Object.hasOwn(observation, "httpStatus")
                    ? "-http-status.json"
                    : "-error-codes.json"),
                observation,
              ),
          },
        ),
        data = await response.json();
      if (
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
    await IO.writeImmutable(root, path.join(dir, "asset-session-claim.json"), {
      schemaVersion: 1,
      runId,
      identity,
      sourceSha256,
      authSha256,
    });
    const session = await request(`${workerBase}/assets-upload-session`, {
      label: "single-asset-session",
      method: "POST",
      body: JSON.stringify({ manifest: assets.manifest }),
      mutation: "session",
    });
    const plan = validateRecoveryBuckets(session, assets.byHash);
    await IO.writeImmutable(root, path.join(run, "asset-plan.json"), {
      buckets: plan.buckets.map((bucket) => bucket.map((r) => r.hash)),
      bytes: plan.bytes,
      mode: plan.single ? "single" : "bulk",
      frozenAssetSha256: FROZEN_ASSET_SHA256,
    });
    let completionJwt = plan.buckets.length === 0 ? session.jwt : null;
    for (const [index, bucket] of plan.buckets.entries()) {
      validateRecoveryJwt(session.jwt);
      const hashes = bucket.map((r) => r.hash),
        form = new FormData();
      let singleBytes;
      for (const row of bucket) {
        const bytes = assets.contents.get(row.path);
        if (!bytes || bytes.length !== row.size || sha(bytes) !== row.sha256)
          fail("asset_file_changed");
        if (plan.single) singleBytes = bytes;
        else
          form.append(
            row.hash,
            new File([bytes.toString("base64")], row.hash, {
              type: MIME[path.extname(row.path)],
            }),
            row.hash,
          );
      }
      await IO.writeImmutable(
        root,
        path.join(run, `asset-${index + 1}-claim.json`),
        {
          bucket: index + 1,
          mode: plan.single ? "single" : "bulk",
          hashes,
          bytes: bucket.reduce((sum, r) => sum + r.size, 0),
        },
      );
      assetBytes += bucket.reduce((sum, r) => sum + r.size, 0);
      const result = await request(
        plan.single
          ? `${base}/workers/assets/upload/${bucket[0].hash}`
          : `${base}/workers/assets/upload?base64=true`,
        {
          label: plan.single
            ? "single-fixed-asset"
            : "single-bulk-asset-bucket",
          method: "POST",
          body: plan.single ? singleBytes : form,
          mutation: "asset",
          bearer: session.jwt,
          ...(plan.single
            ? { contentType: MIME[path.extname(bucket[0].path)] }
            : {}),
          bodySha256: sha(hashes),
          allowAssetCreated: true,
        },
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        fail("asset_upload_invalid");
      if (result.jwt !== undefined && result.jwt !== null && result.jwt !== "")
        completionJwt = validateRecoveryJwt(result.jwt);
    }
    validateRecoveryJwt(completionJwt);
    const uploadBody = recoveryV2UploadBody(completionJwt);
    await IO.writeImmutable(root, path.join(dir, "attempt-claim.json"), {
      schemaVersion: 1,
      runId,
      identity,
      sourceSha256,
      authSha256,
      payloadSha256: sha(uploadBody),
      staticModuleSha256: sha(STATIC_WORKER_SOURCE),
    });
    const uploaded = await request(`${versionBase}?deploy=false`, {
      label: "single-json-version-upload",
      method: "POST",
      body: JSON.stringify(uploadBody),
      mutation: "version",
    });
    uploadedVersion = uploaded?.id;
    if (
      !uuid(uploadedVersion) ||
      [RECOVERY_SOURCE_VERSION, RECOVERY_ASSETS_VERSION].includes(
        uploadedVersion,
      )
    )
      fail("version_invalid");
    if (Object.hasOwn(uploaded, "bindings")) staticBindings(uploaded.bindings);
    await IO.writeImmutable(root, path.join(run, "uploaded-version.json"), {
      versionId: uploadedVersion,
    });
    const uploadedBindingsSha256 = validateRecoveryV2Version(
      await request(`${versionBase}/${uploadedVersion}?include=modules`, {
        label: "independent-uploaded-json-version",
      }),
      uploadedVersion,
    );
    await IO.writeImmutable(root, path.join(run, "deployment-claim.json"), {
      versionId: uploadedVersion,
      bindingsSha256: uploadedBindingsSha256,
      staticModuleSha256: sha(STATIC_WORKER_SOURCE),
      force: true,
    });
    const deployed = await request(`${workerBase}/deployments?force=true`, {
      label: "single-static-deployment",
      method: "POST",
      mutation: "deployment",
      body: JSON.stringify({
        strategy: "percentage",
        versions: [{ version_id: uploadedVersion, percentage: 100 }],
        annotations: {
          "workers/message": "The Shelf fixed JSON static binding recovery",
        },
      }),
    });
    if (deployed?.strategy !== "percentage") fail("deployment_invalid");
    const deployedId = deploymentVersion(
        { deployments: [deployed] },
        uploadedVersion,
      ),
      activeId = deploymentVersion(
        await request(`${workerBase}/deployments?page=1&per_page=1`, {
          label: "independent-active-deployment",
        }),
        uploadedVersion,
      );
    if (activeId !== deployedId) fail("deployment_invalid");
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
      assetSessions,
      assetBuckets,
      assetBytes,
      versionPosts,
      deploymentPosts,
      versionId: uploadedVersion,
      sourceVersion: RECOVERY_SOURCE_VERSION,
      frozenAssetSha256: FROZEN_ASSET_SHA256,
      authEnabled: false,
      deploymentVersionVerified: true,
      codeContentVerified: true,
      assetsRuntimeVerified: false,
      uploadAllowed: false,
    };
    await IO.writeImmutable(root, path.join(run, "result.json"), result);
    return result;
  } catch (error) {
    try {
      await IO.writeImmutable(root, path.join(run, "result.json"), {
        state: "stopped",
        code: /^static_binding_recovery(?:_v2)?_[a-z_]+$/.test(error.code || "")
          ? error.code
          : "static_binding_recovery_v2_private_io_failed",
        requests: count,
        assetSessions,
        assetBuckets,
        assetBytes,
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
  return runStaticBindingRecoveryV2(options);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(
        /^static_binding_recovery(?:_v2)?_[a-z_]+$/.test(e.code || "")
          ? e.code
          : "static_binding_recovery_v2_stopped",
      );
      process.exitCode = 1;
    });
