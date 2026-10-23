import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { d1Client } from "./cf-library-clients.mjs";
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
export async function readRemoteSettings(credentials, name, fetcher = fetch) {
  if (!Object.values(PROFILES).some((p) => p.name === name)) fail("target");
  let response, data;
  try {
    response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/workers/scripts/${name}/settings`,
      {
        headers: { Authorization: `Bearer ${credentials.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) return null;
    const text = await response.text();
    if (text.length > 1024 * 1024) fail("remote");
    data = JSON.parse(text);
  } catch {
    fail("remote");
  }
  if (
    !response.ok ||
    data.success !== true ||
    !Array.isArray(data.result?.bindings)
  )
    fail("remote");
  return data.result;
}
export function safeStaticBindings(settings) {
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
          [...SECRET_NAMES, ...SINGLE_TRIAL_SECRET_NAMES].includes(b.name) &&
          b.type === "secret_text"
        ),
    )
  )
    return false;
  const secrets = bindings.filter((b) => b.type === "secret_text");
  const names = secrets.map((b) => b.name);
  return (
    names.length === 0 ||
    [SECRET_NAMES, SINGLE_TRIAL_SECRET_NAMES].some(
      (set) =>
        names.length === set.length && set.every((n) => names.includes(n)),
    )
  );
}
export async function verifyDatabaseIdentity(credentials, resource, options) {
  await d1Client(credentials, resource, options).verify();
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
  const secretNames = singleTrialTarget
    ? SINGLE_TRIAL_SECRET_NAMES
    : SECRET_NAMES;
  const bucket = singleTrialTarget ? SINGLE_TRIAL_BUCKET : "the-shelf-books";
  if (!settings) {
    if (requireSecrets) fail("secrets");
    return;
  }
  const bindings = settings.bindings;
  if (
    !Array.isArray(bindings) ||
    new Set(bindings.map((b) => b.name)).size !== bindings.length
  )
    fail("bindings");
  const expectedVars = {
    APP_SCOPE: PROFILES[profile].scope,
    SITE_ORIGIN: PROFILES[profile].origin,
    R2_ACCOUNT_ID: accountId,
    R2_BUCKET: bucket,
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
    if (b.name === "DB" || b.name === "BOOKS") continue;
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
    requireSecrets &&
    secretNames.some(
      (name) =>
        !bindings.some((b) => b.name === name && b.type === "secret_text"),
    )
  )
    fail("secrets");
  if (requireSecrets) {
    const expected = expectedVars;
    for (const [name, value] of Object.entries(expected))
      if (
        !value ||
        !bindings.some(
          (b) => b.type === "plain_text" && b.name === name && b.text === value,
        )
      )
        fail("bindings");
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
  { singleTrialTarget } = {},
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
    r2_buckets: [{ binding: "BOOKS", bucket_name: bucket }],
  };
  if (profile === "production")
    config.assets = {
      directory: path.join(root, "dist"),
      binding: "ASSETS",
      html_handling: "force-trailing-slash",
      not_found_handling: "404-page",
      run_worker_first: ["/api", "/api/*"],
    };
  return config;
}
export async function deployApi({
  root = ROOT,
  profile,
  environment = process.env,
  runner = runChild,
  inspector = readRemoteSettings,
  identityChecker = verifyDatabaseIdentity,
  singleTrial = false,
} = {}) {
  let directory, credentials;
  let phase = "files";
  try {
    if (!PROFILES[profile]) fail("target");
    root = await fs.realpath(root);
    const loaded = await readProjectEnvironment(root, environment);
    credentials = loaded.credentials;
    const privacySecrets = await loadPrivacySecrets(root);
    let singleTrialTarget;
    if (singleTrial) {
      if (singleTrial !== true || profile !== "production") fail("target");
      if (
        typeof privacySecrets.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET !==
        "string"
      )
        fail("secrets");
      try {
        singleTrialTarget = validateSingleTrialTarget(
          await readPrivateJson(root, SINGLE_TRIAL_TARGET_PATH),
          credentials.accountId,
          privacySecrets.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET,
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
    phase = "database_identity";
    await identityChecker(credentials, resource);
    await inspectParents(root, "cloudflare/library/worker.mjs");
    await regularFile(path.join(root, "cloudflare/library/worker.mjs"));
    await inspectAssets(path.join(root, "cloudflare/library"));
    phase = "bindings";
    const before = await inspector(credentials, PROFILES[profile].name);
    validateRemoteBindings(before, profile, resource.databaseId, {
      requireSecrets: false,
      allowStatic: true,
      accountId: credentials.accountId,
      singleTrialTarget,
    });
    // Fresh Worker secret placeholders may be installed before its first code upload.
    const names =
      before?.bindings
        ?.filter((b) => b.type === "secret_text")
        .map((b) => b.name) || [];
    if (
      (singleTrialTarget ? SINGLE_TRIAL_SECRET_NAMES : SECRET_NAMES).some(
        (name) => !names.includes(name),
      )
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
          singleTrialTarget,
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
    validateRemoteBindings(
      await inspector(credentials, PROFILES[profile].name),
      profile,
      resource.databaseId,
      { accountId: credentials.accountId, singleTrialTarget },
    );
    const receipt = {
      schemaVersion: 1,
      profile,
      worker: PROFILES[profile].name,
      databaseId: resource.databaseId,
      bucket: singleTrialTarget ? SINGLE_TRIAL_BUCKET : "the-shelf-books",
      ...(singleTrialTarget
        ? { singleTrialTargetSha256: singleTrialTarget.configSha256 }
        : {}),
      at: new Date().toISOString(),
    };
    await privateFile(
      path.join(directory, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    return {
      ok: true,
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
export async function main(argv = process.argv.slice(2)) {
  try {
    if (
      ![2, 3].includes(argv.length) ||
      argv[0] !== "--profile" ||
      (argv.length === 3 && argv[2] !== "--single-trial")
    )
      fail("target");
    const r = await deployApi({
      profile: argv[1],
      singleTrial: argv.length === 3,
    });
    console.log(
      `Cloudflare API deployment succeeded: ${r.url}\nPrivate deployment log: ${r.logPath}`,
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
