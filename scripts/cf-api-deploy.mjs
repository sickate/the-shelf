import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import {
  storageDeploymentContract,
  validateRemoteStorageBindings,
} from "../shared/storage-deployment-contract.mjs";
import {
  readDeploymentControlJson,
  verifyStorageDeployGuard,
  STORAGE_DEPLOY_GUARD_LIMITS,
} from "./storage-deploy-guard.mjs";
import {
  SINGLE_TRIAL_MODE,
  SINGLE_TRIAL_BUCKET,
} from "../cloudflare/library/single-trial.mjs";
import {
  validateSingleTrialTarget,
  SINGLE_TRIAL_TARGET_PATH,
  SINGLE_TRIAL_SECRET_PATH,
} from "./single-trial-config.mjs";
import {
  selectCredentials,
  runChild,
  regularFile,
  privateDirectory,
  privateFile,
  inspectAssets,
  baseEnvironment,
  scrubLog,
  PRIVATE_KEYS,
} from "./cf-deploy.mjs";

import {
  PREPARED_SCHEMA_SHA256,
  PREPARED_SCHEMA_DEFINITIONS,
} from "./prepared-schema.mjs";
export const PREPARED_TEXT_MODE = "registry-v1";
const PREPARED_NAMES = [
  "PREPARED_TEXT_MODE",
  "PREPARED_BOOKS",
  "PREPARED_R2_ACCOUNT_ID",
  "PREPARED_R2_BUCKET",
];
const preparedOptions = (profile, singleTrialTarget, preparedText) => {
  if (
    typeof preparedText !== "boolean" ||
    (preparedText && (profile !== "production" || !singleTrialTarget))
  )
    fail("config");
};
const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PROFILES = Object.freeze({
  check: {
    name: "the-shelf-cf03-check",
    scope: "check",
    origin: "https://the-shelf-cf03-check.iamzhutuo.workers.dev",
    databaseName: "the-shelf-cf03-check",
  },
  production: {
    name: "the-shelf",
    scope: "production",
    origin: "https://the-shelf.iamzhutuo.workers.dev",
    databaseName: "the-shelf-library",
  },
});
export const SECRET_NAMES = [
  "OWNER_KEY_PEPPER",
  "SESSION_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];
export const SINGLE_TRIAL_SECRET_NAMES = [
  "OWNER_KEY_PEPPER",
  "SESSION_SECRET",
  "SINGLE_TRIAL_UPLOAD_SECRET",
];
export const FILENAME_AI_SECRET_NAME = "FILENAME_AI_KEY";
export const FILENAME_AI_MODE = "filename-v1";
export const FILENAME_AI_SECRET_NAMES = [
  ...SINGLE_TRIAL_SECRET_NAMES,
  FILENAME_AI_SECRET_NAME,
];
const own = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const fail = (code) => {
  throw new ApiDeployError(code);
};
export class ApiDeployError extends Error {
  constructor(code = "internal", logPath) {
    super(
      `Cloudflare API operation stopped safely (${code}).${logPath ? " Inspect the private log before retrying." : ""}`,
    );
    this.code = code;
    this.logPath = logPath;
  }
}
export function validateDeployConfig(source) {
  if (
    !own(source, ["schemaVersion", "profiles"]) ||
    source.schemaVersion !== 1 ||
    !own(source.profiles, ["check", "production"])
  )
    fail("config");
  const profiles = {};
  for (const [key, policy] of Object.entries(PROFILES)) {
    const value = source.profiles[key];
    if (
      !own(value, ["databaseId", "databaseName"]) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        value.databaseId || "",
      ) ||
      value.databaseName !== policy.databaseName
    )
      fail("config");
    profiles[key] = {
      databaseId: value.databaseId,
      databaseName: policy.databaseName,
    };
  }
  if (profiles.check.databaseId === profiles.production.databaseId)
    fail("config");
  return { schemaVersion: 1, profiles };
}
async function inspectParents(root, relative) {
  if (path.isAbsolute(relative) || relative.split("/").some((p) => p === ".."))
    fail("files");
  let current = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      ((segment === ".local" ||
        current.includes(`${path.sep}.local${path.sep}`)) &&
        (stat.mode & 0o777) !== 0o700)
    )
      fail("files");
  }
}
export async function readPrivateJson(root, relative) {
  await inspectParents(root, relative);
  const filename = path.join(root, relative),
    stat = await regularFile(filename);
  if ((stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) fail("files");
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch {
    fail("files");
  }
}
export async function loadPrivacySecrets(root) {
  const result = {};
  for (const profile of Object.keys(PROFILES))
    for (const [file, label] of [
      ["owner-access-key", "OWNER_ACCESS_KEY"],
      ["owner-key-pepper", "OWNER_KEY_PEPPER"],
      ["session-secret", "SESSION_SECRET"],
    ]) {
      const relative = `.local/cf03/${profile}/${file}`;
      try {
        await inspectParents(root, relative);
        const filename = path.join(root, relative),
          stat = await regularFile(filename);
        if ((stat.mode & 0o777) !== 0o600 || stat.size > 100) fail("files");
        const value = (await fs.readFile(filename, "utf8")).trim();
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(value) ||
          Buffer.from(value, "base64url").toString("base64url") !== value
        )
          fail("files");
        result[`SHELF_CF_${profile.toUpperCase()}_${label}`] = value;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  try {
    await inspectParents(root, SINGLE_TRIAL_SECRET_PATH);
    const filename = path.join(root, SINGLE_TRIAL_SECRET_PATH),
      stat = await regularFile(filename);
    if ((stat.mode & 0o777) !== 0o600 || stat.size > 100) fail("files");
    const value = (await fs.readFile(filename, "utf8")).trim();
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      Buffer.from(value, "base64url").toString("base64url") !== value
    )
      fail("files");
    result.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET = value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return result;
}
export async function readProjectEnvironment(root, environment = {}) {
  let fileEnvironment = {};
  try {
    const filename = path.join(root, ".env"),
      stat = await regularFile(filename);
    if ((stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) fail("files");
    fileEnvironment = parseEnv(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    fileEnvironment,
    environment,
    credentials: selectCredentials(environment, fileEnvironment),
  };
}
export async function readRemoteSettings(
  credentials,
  name,
  fetcher = fetch,
  options = {},
) {
  if (!Object.values(PROFILES).some((p) => p.name === name)) fail("target");
  let data;
  try {
    data = await readDeploymentControlJson({
      url: `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/workers/scripts/${name}/settings`,
      fetcher,
      allowNotFound: true,
      timeoutMs: options.timeoutMs,
      init: { headers: { Authorization: `Bearer ${credentials.token}` } },
    });
    if (data === null) return null;
  } catch {
    fail("remote");
  }
  if (
    data.success !== true ||
    (data.errors !== undefined &&
      (!Array.isArray(data.errors) || data.errors.length)) ||
    !Array.isArray(data.result?.bindings)
  )
    fail("remote");
  return data.result;
}
export function safeStaticBindings(settings, { filenameAi = false } = {}) {
  const bindings = settings?.bindings;
  if (
    !Array.isArray(bindings) ||
    new Set(bindings.map((b) => b.name)).size !== bindings.length
  )
    return false;
  if (
    bindings.some(
      (b) =>
        !(b.name === "ASSETS" && b.type === "assets") &&
        !(
          [
            ...SECRET_NAMES,
            ...SINGLE_TRIAL_SECRET_NAMES,
            ...(filenameAi ? [FILENAME_AI_SECRET_NAME] : []),
          ].includes(b.name) && b.type === "secret_text"
        ),
    )
  )
    return false;
  const secrets = bindings.filter((b) => b.type === "secret_text");
  const names = secrets.map((b) => b.name);
  return (
    (!filenameAi && names.length === 0) ||
    (filenameAi
      ? [FILENAME_AI_SECRET_NAMES]
      : [SECRET_NAMES, SINGLE_TRIAL_SECRET_NAMES]
    ).some(
      (set) =>
        names.length === set.length &&
        set.every((n) => names.includes(n)) &&
        (!filenameAi ||
          bindings.some((b) => b.name === "ASSETS" && b.type === "assets")),
    )
  );
}
export async function verifyDatabaseIdentity(
  credentials,
  resource,
  { fetchImpl = fetch, timeoutMs } = {},
) {
  if (
    !/^[a-f0-9]{32}$/.test(credentials?.accountId || "") ||
    !credentials.token ||
    !/^[a-f0-9-]{36}$/.test(resource?.databaseId || "") ||
    !Object.values(PROFILES).some(
      (p) => p.databaseName === resource.databaseName,
    )
  )
    fail("database_identity");
  try {
    const data = await readDeploymentControlJson({
      url: `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${resource.databaseId}`,
      fetcher: fetchImpl,
      timeoutMs,
      init: {
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
      },
    });
    if (
      data?.success !== true ||
      (data.errors !== undefined &&
        (!Array.isArray(data.errors) || data.errors.length)) ||
      data.result?.uuid !== resource.databaseId ||
      data.result?.name !== resource.databaseName
    )
      fail("database_identity");
  } catch {
    fail("database_identity");
  }
}
const cancel = (value) => {
  try {
    void Promise.resolve(value?.cancel()).catch(() => {});
  } catch {}
};
// An independent deadline also bounds custom fetchers/readers that ignore abort.
// Consume incrementally, never buffer an unbounded response before checking it.
async function preparedControlResponse(
  fetcher,
  url,
  options,
  timeoutMs = 30_000,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    fail("config");
  const controller = new AbortController();
  let timer, response, reader;
  const operation = (async () => {
    response = await fetcher(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      cancel(response?.body);
      fail("unknown");
    }
    if (
      response?.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url) ||
      !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") || "",
      )
    )
      fail("unknown");
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > 1_048_576)
    )
      fail("unknown");
    reader = response.body.getReader();
    const chunks = [];
    let count = 0,
      size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (
        !(part.value instanceof Uint8Array) ||
        ++count > 4096 ||
        (size += part.value.byteLength) > 1_048_576
      )
        fail("unknown");
      chunks.push(Buffer.from(part.value));
    }
    return new Response(Buffer.concat(chunks), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  })();
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          cancel(reader);
          cancel(response?.body);
          reject(new ApiDeployError("unknown"));
        }, timeoutMs);
      }),
    ]);
  } catch {
    controller.abort();
    cancel(reader);
    cancel(response?.body);
    fail("unknown");
  } finally {
    clearTimeout(timer);
    cancel(reader);
    try {
      reader?.releaseLock();
    } catch {}
  }
}

export const PREPARED_DEPLOY_GUARD_SQL =
  "SELECT (SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,15)='shelf_prepared_' ORDER BY type,name LIMIT 14)) AS schema_json,(SELECT json_group_array(json_object('id',id,'identity_json',identity_json)) FROM (SELECT id,identity_json FROM shelf_storage_authority ORDER BY id LIMIT 2)) AS authority_json";
/** One bounded read-only request, after the caller's separate fixed D1 identity GET. */
export async function verifyPreparedSchema(
  credentials,
  resource,
  identity,
  { fetcher = fetch, timeoutMs = 30_000 } = {},
) {
  if (
    !/^[a-f0-9]{32}$/.test(credentials?.accountId || "") ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      resource?.databaseId || "",
    ) ||
    resource.databaseName !== PROFILES.production.databaseName ||
    identity?.accountId !== credentials.accountId ||
    identity?.bucket !== "the-shelf-books" ||
    identity?.legacyDatabases?.production !== resource.databaseId
  )
    fail("config");
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${resource.databaseId}/query`;
    const response = await preparedControlResponse(
      fetcher,
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: PREPARED_DEPLOY_GUARD_SQL, params: [] }),
      },
      timeoutMs,
    );
    const data = await response.json();
    if (
      data.success !== true ||
      !Array.isArray(data.result) ||
      data.result.length !== 1 ||
      data.result[0].success !== true ||
      !Array.isArray(data.result[0].results) ||
      data.result[0].results.length !== 1
    )
      fail("prepared_schema");
    const row = data.result[0].results[0];
    if (
      !own(row, ["schema_json", "authority_json"]) ||
      typeof row.schema_json !== "string" ||
      typeof row.authority_json !== "string"
    )
      fail("prepared_schema");
    const definitions = JSON.parse(row.schema_json),
      authorities = JSON.parse(row.authority_json);
    const normalize = (v) =>
      typeof v === "string" ? v.trim().replace(/;$/, "") : null;
    if (
      !Array.isArray(definitions) ||
      definitions.length !== PREPARED_SCHEMA_DEFINITIONS.length ||
      new Set(definitions.map((v) => v.name)).size !== definitions.length ||
      definitions.some((v) => {
        const expected = PREPARED_SCHEMA_DEFINITIONS.find(
          (e) => e.name === v.name,
        );
        return (
          !expected ||
          !own(v, ["type", "name", "tbl_name", "sql"]) ||
          v.type !== expected.type ||
          v.tbl_name !== expected.tbl_name ||
          normalize(v.sql) !== normalize(expected.sql)
        );
      }) ||
      !Array.isArray(authorities) ||
      authorities.length !== 1 ||
      !own(authorities[0], ["id", "identity_json"]) ||
      authorities[0].id !== 1 ||
      typeof authorities[0].identity_json !== "string"
    )
      fail("prepared_schema");
    const actual = JSON.parse(authorities[0].identity_json);
    if (
      !own(actual, [
        "schemaVersion",
        "authorityId",
        "accountId",
        "bucket",
        "legacyDatabases",
      ]) ||
      !own(actual.legacyDatabases, ["check", "production"]) ||
      actual.schemaVersion !== 1 ||
      actual.authorityId !== "shelf-remote-storage-v1" ||
      actual.accountId !== identity.accountId ||
      actual.bucket !== identity.bucket ||
      actual.legacyDatabases.check !== identity.legacyDatabases.check ||
      actual.legacyDatabases.production !== identity.legacyDatabases.production
    )
      fail("prepared_schema");
  } catch {
    fail("prepared_schema");
  }
}
export function validateRemoteBindings(
  settings,
  profile,
  databaseId,
  {
    requireSecrets = true,
    allowStatic = false,
    accountId,
    singleTrialTarget,
    filenameAi = false,
    allowFilenameAiTransition = false,
    isolatedUploadConsentSha256,
    allowIsolatedUploadTransition = false,
    preparedText = false,
    allowPreparedTextTransition = false,
  } = {},
) {
  if (
    singleTrialTarget &&
    (profile !== "production" ||
      singleTrialTarget.accountId !== accountId ||
      singleTrialTarget.bucket !== SINGLE_TRIAL_BUCKET ||
      !/^[a-f0-9]{64}$/.test(singleTrialTarget.configSha256 || ""))
  )
    fail("config");
  if (
    filenameAi !== false &&
    (filenameAi !== true || !singleTrialTarget || profile !== "production")
  )
    fail("config");
  preparedOptions(profile, singleTrialTarget, preparedText);
  if (
    typeof allowPreparedTextTransition !== "boolean" ||
    (allowPreparedTextTransition && !preparedText)
  )
    fail("config");
  if (
    (isolatedUploadConsentSha256 !== undefined &&
      (!/^[a-f0-9]{64}$/.test(isolatedUploadConsentSha256) ||
        !filenameAi ||
        !singleTrialTarget ||
        profile !== "production" ||
        preparedText)) ||
    typeof allowIsolatedUploadTransition !== "boolean" ||
    (allowIsolatedUploadTransition && !isolatedUploadConsentSha256)
  )
    fail("config");
  const secretNames = filenameAi
    ? FILENAME_AI_SECRET_NAMES
    : singleTrialTarget
      ? SINGLE_TRIAL_SECRET_NAMES
      : SECRET_NAMES;
  const bucket = singleTrialTarget ? SINGLE_TRIAL_BUCKET : "the-shelf-books";
  if (!settings) {
    if (preparedText && !allowPreparedTextTransition) fail("bindings");
    if (requireSecrets) fail("secrets");
    return;
  }
  const bindings = settings.bindings;
  if (
    !Array.isArray(bindings) ||
    new Set(bindings.map((b) => b.name)).size !== bindings.length
  )
    fail("bindings");
  const isolatedEntries = bindings.filter((b) =>
    ["ISOLATED_UPLOAD_MODE", "ISOLATED_UPLOAD_CONSENT_SHA256"].includes(b.name),
  );
  const isolatedPresent = isolatedEntries.length > 0;
  if (
    (!isolatedUploadConsentSha256 && isolatedPresent) ||
    (isolatedUploadConsentSha256 &&
      isolatedEntries.length !== 2 &&
      !(allowIsolatedUploadTransition && !isolatedPresent))
  )
    fail("bindings");
  const preparedEntries = bindings.filter((b) =>
    PREPARED_NAMES.includes(b.name),
  );
  const preparedPresent = preparedEntries.length > 0;
  if (
    (!preparedText && preparedPresent) ||
    (preparedText &&
      preparedEntries.length !== 4 &&
      !(allowPreparedTextTransition && !preparedPresent))
  )
    fail("bindings");
  const expectedVars = {
    APP_SCOPE: PROFILES[profile].scope,
    SITE_ORIGIN: PROFILES[profile].origin,
    R2_ACCOUNT_ID: accountId,
    R2_BUCKET: bucket,
    ...(preparedText && preparedPresent
      ? {
          PREPARED_TEXT_MODE,
          PREPARED_R2_ACCOUNT_ID: accountId,
          PREPARED_R2_BUCKET: "the-shelf-books",
        }
      : {}),
    ...(filenameAi ? { FILENAME_AI_MODE } : {}),
    ...(isolatedUploadConsentSha256 && isolatedPresent
      ? {
          ISOLATED_UPLOAD_MODE: "project-v1",
          ISOLATED_UPLOAD_CONSENT_SHA256: isolatedUploadConsentSha256,
        }
      : {}),
    ...(singleTrialTarget
      ? {
          SINGLE_TRIAL_MODE,
          SINGLE_TRIAL_TARGET_SHA256: singleTrialTarget.configSha256,
        }
      : {}),
  };
  const dynamic = bindings.filter(
    (b) => !["assets", "secret_text", "plain_text", "json"].includes(b.type),
  );
  if (
    allowStatic &&
    !dynamic.length &&
    (!filenameAi ||
      (bindings.length === FILENAME_AI_SECRET_NAMES.length + 1 &&
        FILENAME_AI_SECRET_NAMES.every((name) =>
          bindings.some((b) => b.name === name && b.type === "secret_text"),
        ) &&
        bindings.some((b) => b.name === "ASSETS" && b.type === "assets"))) &&
    bindings.every(
      (b) =>
        (b.name === "ASSETS" &&
          b.type === "assets" &&
          profile === "production") ||
        (b.type === "secret_text" && secretNames.includes(b.name)),
    )
  )
    return;
  const db = bindings.find((b) => b.name === "DB"),
    books = bindings.find((b) => b.name === "BOOKS");
  if (
    !db ||
    db.type !== "d1" ||
    db.id !== databaseId ||
    !books ||
    books.type !== "r2_bucket" ||
    books.bucket_name !== bucket
  )
    fail("bindings");
  for (const b of bindings) {
    if (
      ["BOOKS", "PREPARED_BOOKS"].includes(b.name) &&
      (Object.keys(b).some(
        (k) =>
          ![
            "name",
            "type",
            "bucket_name",
            "jurisdiction",
            "account_id",
          ].includes(k),
      ) ||
        (Object.hasOwn(b, "account_id") && b.account_id !== accountId) ||
        (Object.hasOwn(b, "jurisdiction") && b.jurisdiction !== "default"))
    )
      fail("bindings");
    if (b.name === "DB" || b.name === "BOOKS") continue;
    if (
      preparedText &&
      b.name === "PREPARED_BOOKS" &&
      b.type === "r2_bucket" &&
      b.bucket_name === "the-shelf-books" &&
      (!Object.hasOwn(b, "jurisdiction") || b.jurisdiction === "default")
    )
      continue;
    if (b.name === "ASSETS" && b.type === "assets" && profile === "production")
      continue;
    if (secretNames.includes(b.name) && b.type === "secret_text") continue;
    if (
      Object.hasOwn(expectedVars, b.name) &&
      b.type === "plain_text" &&
      b.text === expectedVars[b.name]
    )
      continue;
    fail("bindings");
  }
  if (
    preparedPresent &&
    PREPARED_NAMES.filter((n) => n !== "PREPARED_BOOKS").some(
      (name) =>
        !bindings.some(
          (b) =>
            b.name === name &&
            b.type === "plain_text" &&
            b.text === expectedVars[name],
        ),
    )
  )
    fail("bindings");
  if (
    requireSecrets &&
    secretNames.some(
      (name) =>
        !bindings.some((b) => b.name === name && b.type === "secret_text"),
    )
  )
    fail("secrets");
  if (requireSecrets) {
    const expected = expectedVars;
    for (const [name, value] of Object.entries(expected)) {
      if (
        allowFilenameAiTransition &&
        filenameAi &&
        name === "FILENAME_AI_MODE" &&
        !bindings.some((b) => b.name === name)
      )
        continue;
      if (
        !value ||
        !bindings.some(
          (b) => b.type === "plain_text" && b.name === name && b.text === value,
        )
      )
        fail("bindings");
    }
    if (
      profile === "production" &&
      !bindings.some((b) => b.type === "assets" && b.name === "ASSETS")
    )
      fail("bindings");
  }
}
export function workerConfig(
  profile,
  resource,
  accountId,
  root,
  {
    singleTrialTarget,
    filenameAi = false,
    preparedText = false,
    storageContract,
    isolatedUploadConsentSha256,
  } = {},
) {
  const p = PROFILES[profile];
  if (!p) fail("target");
  if (
    singleTrialTarget &&
    (profile !== "production" ||
      singleTrialTarget.accountId !== accountId ||
      singleTrialTarget.bucket !== SINGLE_TRIAL_BUCKET ||
      !/^[a-f0-9]{64}$/.test(singleTrialTarget.configSha256 || ""))
  )
    fail("config");
  if (
    filenameAi !== false &&
    (filenameAi !== true ||
      (!singleTrialTarget && !storageContract) ||
      profile !== "production")
  )
    fail("config");
  if (
    isolatedUploadConsentSha256 !== undefined &&
    (!/^[a-f0-9]{64}$/.test(isolatedUploadConsentSha256) ||
      !filenameAi ||
      !singleTrialTarget ||
      preparedText ||
      storageContract)
  )
    fail("config");
  if (storageContract) {
    if (
      profile !== "production" ||
      singleTrialTarget ||
      storageContract.profile !== "authority-v2-closed" ||
      storageContract.identity.accountId !== accountId ||
      storageContract.d1Bindings[0].database_id !== resource.databaseId ||
      storageContract.filenameAi !== filenameAi ||
      storageContract.preparedText !== preparedText
    )
      fail("config");
    // The shared validator verifies that this is a genuine contract instance.
    validateRemoteStorageBindings(
      {
        bindings: [
          { name: "ASSETS", type: "assets" },
          ...storageContract.secretNames.map((name) => ({
            name,
            type: "secret_text",
          })),
        ],
      },
      storageContract,
      { staticOnly: true },
    );
  } else preparedOptions(profile, singleTrialTarget, preparedText);
  const bucket = singleTrialTarget ? SINGLE_TRIAL_BUCKET : "the-shelf-books";
  const config = {
    name: p.name,
    main: path.join(root, "cloudflare/library/worker.mjs"),
    compatibility_date: "2026-10-15",
    workers_dev: true,
    preview_urls: false,
    send_metrics: false,
    vars: {
      APP_SCOPE: p.scope,
      SITE_ORIGIN: p.origin,
      R2_ACCOUNT_ID: accountId,
      R2_BUCKET: bucket,
      ...(preparedText
        ? {
            PREPARED_TEXT_MODE,
            PREPARED_R2_ACCOUNT_ID: accountId,
            PREPARED_R2_BUCKET: "the-shelf-books",
          }
        : {}),
      ...(filenameAi ? { FILENAME_AI_MODE } : {}),
      ...(isolatedUploadConsentSha256
        ? {
            ISOLATED_UPLOAD_MODE: "project-v1",
            ISOLATED_UPLOAD_CONSENT_SHA256: isolatedUploadConsentSha256,
          }
        : {}),
      ...(singleTrialTarget
        ? {
            SINGLE_TRIAL_MODE,
            SINGLE_TRIAL_TARGET_SHA256: singleTrialTarget.configSha256,
          }
        : {}),
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: p.databaseName,
        database_id: resource.databaseId,
      },
    ],
    r2_buckets: [
      { binding: "BOOKS", bucket_name: bucket },
      ...(preparedText
        ? [{ binding: "PREPARED_BOOKS", bucket_name: "the-shelf-books" }]
        : []),
    ],
  };
  if (profile === "production")
    config.assets = {
      directory: path.join(root, "dist"),
      binding: "ASSETS",
      html_handling: "force-trailing-slash",
      not_found_handling: "404-page",
      run_worker_first: ["/api", "/api/*"],
    };
  if (storageContract) {
    config.vars = { ...storageContract.vars };
    config.d1_databases = storageContract.d1Bindings.map((b) => ({ ...b }));
    config.r2_buckets = storageContract.r2Bindings.map((b) => ({ ...b }));
  }
  return config;
}

/** Closed enumeration: legacy transition flags are never used for v2. */
export function validateV2DeploymentTransition(
  settings,
  contract,
  { preparedTextRollback = false } = {},
) {
  if (
    contract?.profile !== "authority-v2-closed" ||
    typeof preparedTextRollback !== "boolean" ||
    (preparedTextRollback && contract.preparedText)
  )
    fail("config");
  const build = (profile, preparedText) =>
    storageDeploymentContract({
      profile,
      identity: contract.identity,
      trialTargetSha256: contract.vars.TRIAL_TARGET_SHA256,
      filenameAi: true,
      preparedText,
      retainedSecrets: "trial-retained-filename-v1",
    });
  const candidates = preparedTextRollback
    ? [build("authority-v2-closed", true)]
    : [
        contract,
        build("trial-v1", contract.preparedText),
        ...(contract.preparedText ? [build("authority-v2-closed", false)] : []),
      ];
  for (const candidate of candidates) {
    try {
      return {
        ...validateRemoteStorageBindings(settings, candidate),
        profile: candidate.profile,
        preparedText: candidate.preparedText,
      };
    } catch {}
  }
  fail("bindings");
}
export async function deployApi({
  root = ROOT,
  profile,
  environment = process.env,
  runner = runChild,
  inspector = readRemoteSettings,
  identityChecker = verifyDatabaseIdentity,
  preparedChecker = verifyPreparedSchema,
  storageChecker = verifyStorageDeployGuard,
  isolatedChecker,
  storageMode,
  writeMode,
  singleTrial = false,
  filenameAi = false,
  isolatedUploads = false,
  preparedText = false,
  preparedTextRollback = false,
} = {}) {
  let directory, credentials;
  let phase = "files";
  const v2 = storageMode === "authority-v2";
  const controlLimit = isolatedUploads
    ? 5
    : STORAGE_DEPLOY_GUARD_LIMITS.maxTotalHttp;
  let controlRequests = 0;
  const control = async (operation) => {
    if (++controlRequests > controlLimit) fail("request_budget");
    return operation();
  };
  try {
    if (
      ((storageMode !== undefined || writeMode !== undefined) &&
        (!v2 ||
          writeMode !== "closed" ||
          profile !== "production" ||
          singleTrial !== false ||
          filenameAi !== true)) ||
      !PROFILES[profile] ||
      typeof isolatedUploads !== "boolean" ||
      (isolatedUploads &&
        (profile !== "production" ||
          !singleTrial ||
          !filenameAi ||
          v2 ||
          storageMode !== undefined ||
          writeMode !== undefined ||
          preparedText ||
          preparedTextRollback)) ||
      typeof singleTrial !== "boolean" ||
      typeof preparedText !== "boolean" ||
      typeof preparedTextRollback !== "boolean" ||
      (preparedText && preparedTextRollback) ||
      ((preparedText || preparedTextRollback) &&
        (profile !== "production" || (!v2 && singleTrial !== true))) ||
      (filenameAi !== false &&
        (filenameAi !== true ||
          profile !== "production" ||
          (!v2 && singleTrial !== true)))
    )
      fail("target");
    root = await fs.realpath(root);
    const loaded = await readProjectEnvironment(root, environment);
    credentials = loaded.credentials;
    const privacySecrets = await loadPrivacySecrets(root);
    let singleTrialTarget;
    if (singleTrial || v2) {
      if (profile !== "production") fail("target");
      if (
        !v2 &&
        typeof privacySecrets.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET !==
          "string"
      )
        fail("secrets");
      try {
        singleTrialTarget = validateSingleTrialTarget(
          await readPrivateJson(root, SINGLE_TRIAL_TARGET_PATH),
          credentials.accountId,
          v2
            ? undefined
            : privacySecrets.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET,
        );
      } catch {
        fail("config");
      }
    }
    credentials.privateValues.push(...Object.values(privacySecrets));
    // API publication remains local until a separately reviewed CI deployment exists.
    if (credentials.ci) fail("ci");
    const resources = validateDeployConfig(
      await readPrivateJson(root, ".local/cf03/deploy.json"),
    );
    const resource = resources.profiles[profile];
    const identity = {
      schemaVersion: 1,
      authorityId: "shelf-remote-storage-v1",
      accountId: credentials.accountId,
      bucket: "the-shelf-books",
      legacyDatabases: {
        check: resources.profiles.check.databaseId,
        production: resources.profiles.production.databaseId,
      },
    };
    let isolatedPolicy, isolatedConsent;
    if (isolatedUploads) {
      isolatedPolicy = await import("./isolated-upload.mjs");
      isolatedConsent = isolatedPolicy.validateIsolatedConsent(
        await readPrivateJson(root, isolatedPolicy.ISOLATED_CONSENT_PATH),
        identity,
      );
    }
    const storageContract = v2
      ? storageDeploymentContract({
          profile: "authority-v2-closed",
          identity,
          trialTargetSha256: singleTrialTarget.configSha256,
          filenameAi,
          preparedText,
          retainedSecrets: "trial-retained-filename-v1",
        })
      : undefined;
    phase = "database_identity";
    await control(() => identityChecker(credentials, resource));
    await inspectParents(root, "cloudflare/library/worker.mjs");
    await regularFile(path.join(root, "cloudflare/library/worker.mjs"));
    await inspectAssets(path.join(root, "cloudflare/library"));
    phase = "bindings";
    const before = await control(() =>
      inspector(credentials, PROFILES[profile].name),
    );
    const beforeObservation = v2
      ? validateV2DeploymentTransition(before, storageContract, {
          preparedTextRollback,
        })
      : undefined;
    if (!v2)
      validateRemoteBindings(before, profile, resource.databaseId, {
        requireSecrets: filenameAi,
        allowStatic: true,
        accountId: credentials.accountId,
        singleTrialTarget,
        filenameAi,
        allowFilenameAiTransition: filenameAi,
        isolatedUploadConsentSha256: isolatedConsent?.sha256,
        allowIsolatedUploadTransition: isolatedUploads,
        preparedText: preparedText || preparedTextRollback,
        allowPreparedTextTransition: preparedText,
      });
    let isolatedObservation;
    if (isolatedUploads) {
      phase = "isolated_guard";
      isolatedObservation = await control(() =>
        (isolatedChecker || isolatedPolicy.verifyIsolatedDeployment)(
          credentials,
          resource,
          identity,
          isolatedConsent,
        ),
      );
    }
    let storageObservation;
    if (v2) {
      phase = "storage_guard";
      storageObservation = await control(() =>
        storageChecker(credentials, resource, storageContract),
      );
    } else if (preparedText) {
      phase = "prepared_schema";
      await control(() =>
        preparedChecker(credentials, resource, {
          schemaVersion: 1,
          authorityId: "shelf-remote-storage-v1",
          accountId: credentials.accountId,
          bucket: "the-shelf-books",
          legacyDatabases: {
            check: resources.profiles.check.databaseId,
            production: resource.databaseId,
          },
        }),
      );
    }
    // Fresh Worker secret placeholders may be installed before its first code upload.
    const names =
      before?.bindings
        ?.filter((b) => b.type === "secret_text")
        .map((b) => b.name) || [];
    if (
      (filenameAi
        ? FILENAME_AI_SECRET_NAMES
        : singleTrialTarget
          ? SINGLE_TRIAL_SECRET_NAMES
          : SECRET_NAMES
      ).some((name) => !names.includes(name))
    )
      fail("secrets");
    if (profile === "production") {
      await inspectAssets(path.join(root, "dist"));
      const runtime = JSON.parse(
        await fs.readFile(path.join(root, "dist/data/runtime.json"), "utf8"),
      );
      const index = JSON.parse(
        await fs.readFile(path.join(root, "dist/docs/index.json"), "utf8"),
      );
      if (
        runtime.apiMode !== "same-origin" ||
        runtime.schemaVersion !== 1 ||
        index.basePath !== "/"
      )
        fail("config");
    }
    await privateDirectory(path.join(root, ".local"));
    await privateDirectory(path.join(root, ".local/cf03"));
    directory = await fs.mkdtemp(path.join(root, ".local/cf03/deploy-"));
    await fs.chmod(directory, 0o700);
    const logPath = path.join(directory, "deploy.log");
    await privateFile(logPath);
    await privateFile(path.join(directory, "wrangler.log"));
    const configPath = path.join(directory, "wrangler.json"),
      empty = path.join(directory, "empty.env");
    await privateFile(
      configPath,
      JSON.stringify(
        workerConfig(profile, resource, credentials.accountId, root, {
          singleTrialTarget: v2 ? undefined : singleTrialTarget,
          filenameAi,
          preparedText,
          storageContract,
          isolatedUploadConsentSha256: isolatedConsent?.sha256,
        }),
        null,
        2,
      ),
    );
    await privateFile(empty);
    const env = baseEnvironment(environment, directory);
    phase = "preflight";
    if (profile === "production")
      for (const script of ["verify-public.mjs", "verify-static.mjs"]) {
        const result = await runner({
          command: process.execPath,
          args: [path.join(root, "scripts", script)],
          cwd: root,
          env:
            script === "verify-public.mjs"
              ? {
                  ...env,
                  ...Object.fromEntries(
                    Object.entries({
                      ...loaded.fileEnvironment,
                      ...environment,
                      ...privacySecrets,
                    }).filter(([k]) => PRIVATE_KEYS.includes(k)),
                  ),
                }
              : env,
          logPath,
          redactions: credentials.privateValues,
        });
        if (result.code !== 0 || result.signal) fail("preflight");
      }
    phase = "deploy";
    if (v2 || isolatedUploads)
      await privateFile(
        path.join(directory, "deployment-attempt.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            outcome: "dispatch_not_proven",
            storageProfile: isolatedUploads
              ? "isolated-project-v1"
              : storageContract.profile,
            ...(isolatedUploads
              ? {
                  isolatedConsentSha256: isolatedConsent.sha256,
                  isolatedObservation,
                }
              : {}),
            beforeSettingsSha256: createHash("sha256")
              .update(
                isolatedUploads
                  ? JSON.stringify(before)
                  : beforeObservation.canonicalSettingsJson,
              )
              .digest("hex"),
            storageObservation,
            explicitControlHttpBeforeDeploy: controlRequests,
            maxTotalExplicitControlHttp: controlLimit,
            wranglerInternalHttp: "not_counted",
            codeVersionVerified: false,
          },
          null,
          2,
        ),
      );
    const result = await runner({
      command: process.execPath,
      args: [
        path.join(root, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        configPath,
        "--env-file",
        empty,
      ],
      cwd: directory,
      env: {
        ...env,
        CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
        CLOUDFLARE_API_TOKEN: credentials.token,
      },
      logPath,
      redactions: credentials.privateValues,
    });
    if (result.code !== 0 || result.signal) fail("deploy");
    phase = "postflight";
    const after = await control(() =>
      inspector(credentials, PROFILES[profile].name),
    );
    const afterObservation = v2
      ? validateRemoteStorageBindings(after, storageContract)
      : undefined;
    if (!v2)
      validateRemoteBindings(after, profile, resource.databaseId, {
        accountId: credentials.accountId,
        singleTrialTarget,
        filenameAi,
        preparedText,
        isolatedUploadConsentSha256: isolatedConsent?.sha256,
      });
    if (isolatedUploads) {
      const observed = await control(() =>
        (isolatedChecker || isolatedPolicy.verifyIsolatedDeployment)(
          credentials,
          resource,
          identity,
          isolatedConsent,
        ),
      );
      if (observed.observationSha256 !== isolatedObservation.observationSha256)
        fail("isolated_guard");
    }
    const receipt = {
      schemaVersion: 1,
      ...(isolatedUploads
        ? {
            isolatedUploadMode: "project-v1",
            isolatedConsentSha256: isolatedConsent.sha256,
            isolatedObservation,
            explicitControlHttp: controlRequests,
            maxTotalExplicitControlHttp: controlLimit,
            wranglerInternalHttp: "not_counted",
            codeVersionVerified: false,
          }
        : {}),
      profile,
      worker: PROFILES[profile].name,
      databaseId: resource.databaseId,
      bucket:
        singleTrialTarget && !v2 ? SINGLE_TRIAL_BUCKET : "the-shelf-books",
      ...(v2
        ? {
            storageMode,
            writeMode,
            storageProfile: storageContract.profile,
            outcome: "settings_verified",
            explicitControlHttp: controlRequests,
            maxTotalExplicitControlHttp:
              STORAGE_DEPLOY_GUARD_LIMITS.maxTotalHttp,
            wranglerInternalHttp: "not_counted",
            codeVersionVerified: false,
            profileSha256: createHash("sha256")
              .update(storageContract.canonicalProfile)
              .digest("hex"),
            beforeSettingsSha256: createHash("sha256")
              .update(beforeObservation.canonicalSettingsJson)
              .digest("hex"),
            afterSettingsSha256: createHash("sha256")
              .update(afterObservation.canonicalSettingsJson)
              .digest("hex"),
            storageObservation,
          }
        : {}),
      ...(singleTrialTarget
        ? { singleTrialTargetSha256: singleTrialTarget.configSha256 }
        : {}),
      ...(filenameAi ? { filenameAiMode: FILENAME_AI_MODE } : {}),
      ...(preparedText
        ? {
            preparedTextMode: PREPARED_TEXT_MODE,
            preparedBucket: "the-shelf-books",
            preparedSchemaSha256: PREPARED_SCHEMA_SHA256,
          }
        : {}),
      ...(preparedTextRollback ? { preparedTextRollback: true } : {}),
      at: new Date().toISOString(),
    };
    await privateFile(
      path.join(directory, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    return {
      ok: true,
      ...(v2 || isolatedUploads
        ? {
            outcome: "settings_verified",
            explicitControlHttp: controlRequests,
            codeVersionVerified: false,
          }
        : {}),
      url: PROFILES[profile].origin,
      logPath: path.relative(root, logPath),
    };
  } catch (error) {
    throw new ApiDeployError(
      error instanceof ApiDeployError ? error.code : phase,
      directory
        ? path.relative(root, path.join(directory, "deploy.log"))
        : undefined,
    );
  } finally {
    if (directory && credentials)
      for (const name of ["deploy.log", "wrangler.log"])
        await scrubLog(path.join(directory, name), credentials.privateValues);
  }
}
export function parseApiDeployArguments(argv) {
  if (!Array.isArray(argv) || argv[0] !== "--profile" || !PROFILES[argv[1]])
    fail("target");
  const result = {
    profile: argv[1],
    singleTrial: false,
    filenameAi: false,
    preparedText: false,
    preparedTextRollback: false,
  };
  const names = {
    "--single-trial": "singleTrial",
    "--isolated-uploads": "isolatedUploads",
    "--filename-ai": "filenameAi",
    "--prepared-text": "preparedText",
    "--prepared-text-rollback": "preparedTextRollback",
  };
  const seen = new Set();
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) fail("target");
    seen.add(key);
    if (Object.hasOwn(names, key)) result[names[key]] = true;
    else if (["--storage-mode", "--write-mode"].includes(key)) {
      if (++i >= argv.length) fail("target");
      result[key === "--storage-mode" ? "storageMode" : "writeMode"] = argv[i];
    } else fail("target");
  }
  const v2 = result.storageMode === "authority-v2";
  if (
    ((result.storageMode !== undefined || result.writeMode !== undefined) &&
      (!v2 ||
        result.writeMode !== "closed" ||
        result.singleTrial ||
        !result.filenameAi ||
        result.profile !== "production")) ||
    (result.filenameAi && !result.singleTrial && !v2) ||
    ((result.preparedText || result.preparedTextRollback) &&
      ((!result.singleTrial && !v2) || result.profile !== "production")) ||
    (result.isolatedUploads &&
      (result.profile !== "production" ||
        !result.singleTrial ||
        !result.filenameAi ||
        result.storageMode !== undefined ||
        result.writeMode !== undefined ||
        result.preparedText ||
        result.preparedTextRollback)) ||
    (result.preparedText && result.preparedTextRollback)
  )
    fail("target");
  return result;
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const r = await deployApi(parseApiDeployArguments(argv));
    console.log(
      `${r.outcome === "settings_verified" ? "Cloudflare API deployment settings verified" : "Cloudflare API deployment succeeded"}: ${r.url}\nPrivate deployment log: ${r.logPath}`,
    );
  } catch (error) {
    console.error(
      error instanceof ApiDeployError
        ? error.message
        : "Cloudflare API deployment stopped safely.",
    );
    if (error.logPath)
      console.error(`Private deployment log: ${error.logPath}`);
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
