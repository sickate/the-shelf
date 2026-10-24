import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import {
  storageDeploymentContract,
  validateRemoteStorageBindings,
} from "../shared/storage-deployment-contract.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PUBLIC_URL = "https://the-shelf.iamzhutuo.workers.dev/";
// Wrangler's assets-only serializer omits bindings and keepSecrets. A fixed user
// Worker keeps secret inheritance active while exposing only the assets binding.
export const STATIC_WORKER_SOURCE =
  "export default { fetch(request, env) { return env.ASSETS.fetch(request); } };\n";
const ACCOUNT_KEYS = [
  "SHELF_R2_ACCOUNT_ID",
  "SHELF_CF_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID",
];
export const PRIVATE_KEYS = [
  ...ACCOUNT_KEYS,
  "SHELF_CF_DEPLOY_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CF_PROBE_TOKEN",
  "SHELF_CF_PROBE_TOKEN",
  "SHELF_CF_OWNER_ACCESS_KEY",
  "OWNER_KEY_PEPPER",
  "SESSION_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "SHELF_CF_CHECK_OWNER_ACCESS_KEY",
  "SHELF_CF_CHECK_OWNER_KEY_PEPPER",
  "SHELF_CF_CHECK_SESSION_SECRET",
  "SHELF_CF_PRODUCTION_OWNER_ACCESS_KEY",
  "SHELF_CF_PRODUCTION_OWNER_KEY_PEPPER",
  "SHELF_CF_PRODUCTION_SESSION_SECRET",
  "SINGLE_TRIAL_UPLOAD_SECRET",
  "SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET",
  "SHELF_OAI_KEY",
  "FILENAME_AI_KEY",
  "SHELF_R2_ACCESS_KEY_ID",
  "SHELF_R2_SECRET_ACCESS_KEY",
  "SHELF_OWNER_PASSWORD",
];
const MESSAGES = {
  config: "Static deployment configuration rejected.",
  credentials: "Project deployment credentials are missing or conflicting.",
  ci: "CI deployment requires explicit enablement and dedicated project credentials.",
  files: "Static deployment files or private workspace are unsafe.",
  preflight: "Static deployment checks failed; inspect the private log.",
  deploy:
    "Cloudflare deployment failed or its outcome is uncertain; inspect the private log before retrying.",
  bindings:
    "Static deployment would replace an API Worker; use an explicit verified static rollback.",
  remote:
    "Cloudflare Worker settings could not be verified; deployment stopped safely.",
  internal:
    "Static deployment stopped safely; inspect the private log if available.",
};
export class DeployError extends Error {
  constructor(code, logPath) {
    super(MESSAGES[code] || MESSAGES.internal);
    this.code = code;
    this.logPath = logPath;
  }
}
const reject = (code) => {
  throw new DeployError(code);
};
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const hasOnly = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));

export function validateConfig(config) {
  if (
    !hasOnly(config, [
      "$schema",
      "name",
      "compatibility_date",
      "workers_dev",
      "preview_urls",
      "assets",
    ]) ||
    config.name !== "the-shelf" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date || "") ||
    config.workers_dev !== true ||
    config.preview_urls !== false ||
    !hasOnly(config.assets, [
      "directory",
      "html_handling",
      "not_found_handling",
    ]) ||
    config.assets.directory !== "./dist" ||
    config.assets.html_handling !== "force-trailing-slash" ||
    config.assets.not_found_handling !== "404-page"
  )
    reject("config");
  // Return a reconstructed policy, never forward unvalidated input to Wrangler.
  return {
    name: "the-shelf",
    compatibility_date: config.compatibility_date,
    workers_dev: true,
    preview_urls: false,
    assets: { ...config.assets },
    send_metrics: false,
  };
}

export function selectCredentials(environment = {}, fileEnvironment = {}) {
  const merged = { ...fileEnvironment, ...environment };
  const ci = [
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "BUILDKITE",
    "CIRCLECI",
    "TF_BUILD",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
  ].some((key) => Boolean(environment[key]));
  if (
    ci &&
    (environment.SHELF_CF_AUTO_DEPLOY !== "true" ||
      !environment.SHELF_CF_DEPLOY_TOKEN ||
      !environment.SHELF_CF_ACCOUNT_ID)
  )
    reject("ci");
  // Every explicitly configured account must agree, including the private file.
  // An inherited account variable must never silently switch this project.
  const accounts = [environment, fileEnvironment]
    .flatMap((source) => ACCOUNT_KEYS.map((key) => source[key]))
    .filter((value) => value !== undefined && value !== "");
  if (
    !accounts.length ||
    accounts.some((value) => !/^[a-f0-9]{32}$/.test(value)) ||
    new Set(accounts).size !== 1 ||
    !(merged.SHELF_R2_ACCOUNT_ID || merged.SHELF_CF_ACCOUNT_ID)
  )
    reject("credentials");
  const token = ci
    ? environment.SHELF_CF_DEPLOY_TOKEN
    : merged.SHELF_CF_DEPLOY_TOKEN || merged.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{20,4096}$/.test(token))
    reject("credentials");
  return {
    accountId: accounts[0],
    token,
    ci,
    privateValues: PRIVATE_KEYS.map((key) => merged[key]).filter(
      (value) => typeof value === "string" && value.length >= 8,
    ),
  };
}

export async function regularFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) reject("files");
  return stat;
}
export async function privateDirectory(directory) {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject("files");
  await fs.chmod(directory, 0o700);
}
export async function privateFile(filename, content = "") {
  const file = await fs.open(filename, "wx", 0o600);
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}
export async function inspectAssets(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject("files");
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (!entries.length) reject("files");
  for (const entry of entries) {
    if (
      entry.isSymbolicLink() ||
      /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.local|\.git|\.wrangler|server|_worker\.js|_routes\.json)$/i.test(
        entry.name,
      )
    )
      reject("files");
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await inspectAssets(filename);
    else if (!entry.isFile()) reject("files");
  }
}
export function baseEnvironment(environment, runDirectory) {
  const result = {};
  // Do not forward NODE_OPTIONS, alternate API endpoints, proxies, auth keys,
  // Wrangler environments, CLI name overrides, or unrelated project secrets.
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ])
    if (environment[key]) result[key] = environment[key];
  return {
    ...result,
    CI: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    WRANGLER_SEND_METRICS: "false",
    // Capture and redact CLI output ourselves; avoid raw debug-log secrets.
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_PATH: path.join(runDirectory, "wrangler.log"),
    XDG_CONFIG_HOME: path.join(runDirectory, "config"),
    XDG_CACHE_HOME: path.join(runDirectory, "cache"),
  };
}
function redactText(text, values) {
  const variants = new Set(
    values.flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
    ]),
  );
  for (const value of [...variants].sort((a, b) => b.length - a.length))
    text = text.replaceAll(value, "[REDACTED]");
  return text;
}
export async function runChild({
  command,
  args,
  cwd,
  env,
  logPath,
  redactions = [],
}) {
  const log = await fs.open(logPath, "a", 0o600);
  const chunks = { stdout: [], stderr: [] };
  let bytes = 0,
    oversized = false;
  try {
    return await new Promise((resolve, rejectPromise) => {
      const child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15 * 60 * 1000,
      });
      const capture = (stream) => (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          oversized = true;
          child.kill();
        } else chunks[stream].push(chunk);
      };
      child.stdout.on("data", capture("stdout"));
      child.stderr.on("data", capture("stderr"));
      child.once("error", rejectPromise);
      child.once("close", (code, signal) =>
        resolve({ code: oversized ? 1 : code, signal }),
      );
    });
  } finally {
    try {
      await log.writeFile(
        oversized
          ? "Child output exceeded the private log limit.\n"
          : [chunks.stdout, chunks.stderr]
              .map((output) =>
                redactText(Buffer.concat(output).toString("utf8"), redactions),
              )
              .join("\n"),
      );
    } finally {
      await log.close();
    }
  }
}
export async function scrubLog(filename, values) {
  let text;
  try {
    text = await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await fs.writeFile(filename, redactText(text, values), { mode: 0o600 });
  await fs.chmod(filename, 0o600);
}

export async function deploy({
  root = ROOT,
  environment = process.env,
  runner = runChild,
  inspector,
  staticRollback = false,
  singleTrial = false,
  filenameAi = false,
  isolatedUploads = false,
  preparedText = false,
  storageMode,
  writeMode,
} = {}) {
  let runDirectory, credentials;
  let phase = "files";
  const v2 = storageMode === "authority-v2";
  let explicitControlHttp = 0;
  const inspect = async (apiPolicy, credentials) => {
    if (++explicitControlHttp > 2) reject("remote");
    return (inspector || apiPolicy.readRemoteSettings)(
      credentials,
      "the-shelf",
    );
  };
  try {
    if (
      typeof isolatedUploads !== "boolean" ||
      (isolatedUploads &&
        (!staticRollback ||
          !singleTrial ||
          !filenameAi ||
          preparedText ||
          storageMode !== undefined ||
          writeMode !== undefined))
    )
      reject("config");
    if (
      (storageMode !== undefined || writeMode !== undefined) &&
      (!v2 ||
        writeMode !== "closed" ||
        staticRollback !== true ||
        singleTrial !== false ||
        filenameAi !== true)
    )
      reject("config");
    if (
      typeof preparedText !== "boolean" ||
      (preparedText &&
        (staticRollback !== true || (!v2 && singleTrial !== true)))
    )
      reject("config");
    if (
      filenameAi !== false &&
      (filenameAi !== true || (!v2 && singleTrial !== true))
    )
      reject("config");
    const repository = await fs.realpath(root);
    let fileEnvironment = {};
    const envPath = path.join(repository, ".env");
    try {
      const stat = await regularFile(envPath);
      if ((stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024)
        reject("files");
      fileEnvironment = parseEnv(await fs.readFile(envPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    credentials = selectCredentials(environment, fileEnvironment);
    const sourceConfig = path.join(repository, "wrangler.jsonc");
    const configStat = await regularFile(sourceConfig);
    if (configStat.size > 65536) reject("config");
    let source;
    try {
      source = JSON.parse(await fs.readFile(sourceConfig, "utf8"));
    } catch {
      reject("config");
    }
    const config = validateConfig(source);
    const apiPolicy = await import("./cf-api-deploy.mjs");
    const privacySecrets = await apiPolicy.loadPrivacySecrets(repository);
    let singleTrialTarget;
    if (singleTrial || v2) {
      if (
        staticRollback !== true ||
        (!v2 &&
          (singleTrial !== true ||
            typeof privacySecrets.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET !==
              "string"))
      )
        reject("config");
      const trialPolicy = await import("./single-trial-config.mjs");
      try {
        singleTrialTarget = trialPolicy.validateSingleTrialTarget(
          await apiPolicy.readPrivateJson(
            repository,
            trialPolicy.SINGLE_TRIAL_TARGET_PATH,
          ),
          credentials.accountId,
          v2
            ? undefined
            : privacySecrets.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET,
        );
      } catch {
        reject("config");
      }
    }
    let storageContract;
    if (v2) {
      const resources = apiPolicy.validateDeployConfig(
        await apiPolicy.readPrivateJson(repository, ".local/cf03/deploy.json"),
      );
      storageContract = storageDeploymentContract({
        profile: "authority-v2-closed",
        identity: {
          schemaVersion: 1,
          authorityId: "shelf-remote-storage-v1",
          accountId: credentials.accountId,
          bucket: "the-shelf-books",
          legacyDatabases: {
            check: resources.profiles.check.databaseId,
            production: resources.profiles.production.databaseId,
          },
        },
        trialTargetSha256: singleTrialTarget.configSha256,
        filenameAi,
        preparedText,
        retainedSecrets: "trial-retained-filename-v1",
      });
    }
    let isolatedConsent;
    if (isolatedUploads) {
      const isolated = await import("./isolated-upload.mjs"),
        resources = apiPolicy.validateDeployConfig(
          await apiPolicy.readPrivateJson(
            repository,
            ".local/cf03/deploy.json",
          ),
        );
      isolatedConsent = isolated.validateIsolatedConsent(
        await apiPolicy.readPrivateJson(
          repository,
          isolated.ISOLATED_CONSENT_PATH,
        ),
        {
          schemaVersion: 1,
          authorityId: "shelf-remote-storage-v1",
          accountId: credentials.accountId,
          bucket: "the-shelf-books",
          legacyDatabases: {
            check: resources.profiles.check.databaseId,
            production: resources.profiles.production.databaseId,
          },
        },
      );
    }
    credentials.privateValues.push(...Object.values(privacySecrets));
    phase = "remote";
    const settings = await inspect(apiPolicy, credentials);
    const beforeObservation = v2
      ? validateRemoteStorageBindings(settings, storageContract)
      : undefined;
    const bindings = settings?.bindings || [];
    const hasApi = !apiPolicy.safeStaticBindings(settings || { bindings: [] }, {
      filenameAi,
    });
    if (isolatedUploads && !hasApi) reject("bindings");
    if (!v2 && hasApi) {
      if (!staticRollback) reject("bindings");
      const resources = apiPolicy.validateDeployConfig(
        await apiPolicy.readPrivateJson(repository, ".local/cf03/deploy.json"),
      );
      apiPolicy.validateRemoteBindings(
        settings,
        "production",
        resources.profiles.production.databaseId,
        {
          accountId: credentials.accountId,
          singleTrialTarget,
          filenameAi,
          preparedText,
          isolatedUploadConsentSha256: isolatedConsent?.sha256,
          allowFilenameAiTransition: filenameAi && staticRollback,
        },
      );
    } else if (!v2 && ((staticRollback && !filenameAi) || preparedText))
      reject("bindings");
    phase = "files";
    const assets = path.join(repository, "dist");
    await inspectAssets(assets);
    try {
      const runtime = JSON.parse(
        await fs.readFile(path.join(assets, "data/runtime.json"), "utf8"),
      );
      if (runtime.apiMode !== "disabled" || runtime.schemaVersion !== 1)
        reject("config");
    } catch {
      reject("config");
    }
    if (
      JSON.parse(
        await fs.readFile(path.join(assets, "docs/index.json"), "utf8"),
      ).basePath !== "/"
    )
      reject("config");
    await privateDirectory(path.join(repository, ".local"));
    const privateRoot = path.join(repository, ".local/cf-static");
    await privateDirectory(privateRoot);
    runDirectory = await fs.mkdtemp(path.join(privateRoot, "deploy-"));
    await fs.chmod(runDirectory, 0o700);
    if (hasApi)
      await privateFile(
        path.join(runDirectory, "rollback-bindings.json"),
        JSON.stringify({ at: new Date().toISOString(), bindings }, null, 2),
      );
    const logPath = path.join(runDirectory, "deploy.log");
    await privateFile(logPath);
    await privateFile(path.join(runDirectory, "wrangler.log"));
    const emptyEnv = path.join(runDirectory, "empty.env");
    await privateFile(emptyEnv);
    const configPath = path.join(runDirectory, "wrangler.json");
    const staticMain = path.join(runDirectory, "static-worker.mjs");
    await privateFile(staticMain, STATIC_WORKER_SOURCE);
    await privateFile(
      configPath,
      JSON.stringify(
        {
          ...config,
          main: staticMain,
          assets: {
            ...config.assets,
            directory: assets,
            binding: "ASSETS",
          },
        },
        null,
        2,
      ),
    );
    const childEnvironment = baseEnvironment(environment, runDirectory);
    const checkEnvironment = { ...childEnvironment };
    const merged = { ...fileEnvironment, ...environment, ...privacySecrets };
    for (const key of PRIVATE_KEYS)
      if (merged[key] !== undefined) checkEnvironment[key] = merged[key];
    // Validate without exposing tokens to npm, a shell, static source or argv.
    phase = "preflight";
    for (const script of ["verify-public.mjs", "verify-static.mjs"]) {
      const result = await runner({
        command: process.execPath,
        args: [path.join(repository, "scripts", script)],
        cwd: repository,
        env:
          script === "verify-public.mjs"
            ? checkEnvironment
            : { ...childEnvironment, SHELF_CF_SITE_URL: PUBLIC_URL },
        logPath,
        redactions: credentials.privateValues,
      });
      if (result.code !== 0 || result.signal) reject("preflight");
    }
    phase = "deploy";
    if (v2 || isolatedUploads)
      await privateFile(
        path.join(runDirectory, "deployment-attempt.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            outcome: "dispatch_not_proven",
            storageProfile: isolatedUploads
              ? "isolated-project-v1"
              : storageContract.profile,
            ...(isolatedUploads
              ? { isolatedConsentSha256: isolatedConsent.sha256 }
              : {}),
            preparedText,
            retainedSecrets: isolatedUploads
              ? "trial-retained-filename-v1"
              : storageContract.retainedSecrets,
            beforeSettingsSha256: createHash("sha256")
              .update(
                isolatedUploads
                  ? JSON.stringify(settings)
                  : beforeObservation.canonicalSettingsJson,
              )
              .digest("hex"),
            explicitControlHttpBeforeDeploy: explicitControlHttp,
            maxTotalExplicitControlHttp: 2,
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
        path.join(repository, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        configPath,
        "--env-file",
        emptyEnv,
      ],
      cwd: runDirectory,
      env: {
        ...childEnvironment,
        CLOUDFLARE_API_TOKEN: credentials.token,
        CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
      },
      logPath,
      redactions: [
        ...credentials.privateValues,
        credentials.token,
        credentials.accountId,
      ],
    });
    if (result.code !== 0 || result.signal) reject("deploy");
    phase = "remote";
    const deployed = await inspect(apiPolicy, credentials);
    if (v2) {
      const afterObservation = validateRemoteStorageBindings(
        deployed,
        storageContract,
        { staticOnly: true },
      );
      await privateFile(
        path.join(runDirectory, "receipt.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            outcome: "settings_verified",
            codeVersionVerified: false,
            explicitControlHttp,
            maxTotalExplicitControlHttp: 2,
            wranglerInternalHttp: "not_counted",
            beforeSettingsSha256: createHash("sha256")
              .update(beforeObservation.canonicalSettingsJson)
              .digest("hex"),
            afterSettingsSha256: createHash("sha256")
              .update(afterObservation.canonicalSettingsJson)
              .digest("hex"),
          },
          null,
          2,
        ),
      );
    } else if (
      !deployed ||
      !apiPolicy.safeStaticBindings(deployed, { filenameAi })
    )
      reject("bindings");
    if (isolatedUploads)
      await privateFile(
        path.join(runDirectory, "receipt.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            outcome: "settings_verified",
            isolatedUploadMode: "project-v1",
            isolatedConsentSha256: isolatedConsent.sha256,
            explicitControlHttp,
            maxTotalExplicitControlHttp: 2,
            wranglerInternalHttp: "not_counted",
            codeVersionVerified: false,
            beforeSettingsSha256: createHash("sha256")
              .update(JSON.stringify(settings))
              .digest("hex"),
            afterSettingsSha256: createHash("sha256")
              .update(JSON.stringify(deployed))
              .digest("hex"),
          },
          null,
          2,
        ),
      );
    return {
      ok: true,
      ...(v2 || isolatedUploads
        ? {
            outcome: "settings_verified",
            codeVersionVerified: false,
            explicitControlHttp,
          }
        : {}),
      url: PUBLIC_URL,
      logPath: path.relative(repository, logPath),
    };
  } catch (error) {
    throw new DeployError(
      error instanceof DeployError ? error.code : phase,
      runDirectory
        ? path.join(
            ".local/cf-static",
            path.basename(runDirectory),
            "deploy.log",
          )
        : undefined,
    );
  } finally {
    if (runDirectory && credentials) {
      const values = [
        ...credentials.privateValues,
        credentials.token,
        credentials.accountId,
      ];
      for (const name of ["deploy.log", "wrangler.log"])
        await scrubLog(path.join(runDirectory, name), values);
    }
  }
}

export function parseStaticDeployArguments(argv) {
  if (!Array.isArray(argv) || (argv.length && argv[0] !== "--static-rollback"))
    reject("config");
  const result = {
    staticRollback: argv.length > 0,
    singleTrial: false,
    filenameAi: false,
    preparedText: false,
  };
  const flags = {
      "--single-trial": "singleTrial",
      "--isolated-uploads": "isolatedUploads",
      "--filename-ai": "filenameAi",
      "--prepared-text": "preparedText",
    },
    seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) reject("config");
    seen.add(key);
    if (Object.hasOwn(flags, key)) result[flags[key]] = true;
    else if (["--storage-mode", "--write-mode"].includes(key)) {
      if (++i >= argv.length) reject("config");
      result[key === "--storage-mode" ? "storageMode" : "writeMode"] = argv[i];
    } else reject("config");
  }
  if (
    result.isolatedUploads &&
    (!result.staticRollback ||
      !result.singleTrial ||
      !result.filenameAi ||
      result.preparedText ||
      result.storageMode !== undefined ||
      result.writeMode !== undefined)
  )
    reject("config");
  const v2 = result.storageMode === "authority-v2";
  if (
    (result.storageMode !== undefined || result.writeMode !== undefined) &&
    (!v2 ||
      result.writeMode !== "closed" ||
      result.singleTrial ||
      !result.filenameAi)
  )
    reject("config");
  return result;
}

export async function main() {
  try {
    const result = await deploy(
      parseStaticDeployArguments(process.argv.slice(2)),
    );
    console.log(
      `${result.outcome === "settings_verified" ? "Cloudflare static deployment settings verified" : "Cloudflare static deployment succeeded"}: ${result.url}`,
    );
    console.log(`Private deployment log: ${result.logPath}`);
  } catch (error) {
    console.error(
      error instanceof DeployError ? error.message : MESSAGES.internal,
    );
    if (error instanceof DeployError && error.logPath)
      console.error(`Private deployment log: ${error.logPath}`);
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  // Finish module evaluation before deploy dynamically imports the API policy,
  // whose shared helpers import this module. main handles all failures itself.
  void main();
