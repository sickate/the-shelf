import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import {
  ApiDeployError,
  PROFILES,
  FILENAME_AI_SECRET_NAME,
  loadPrivacySecrets,
  validateDeployConfig,
  validateRemoteBindings,
  readRemoteSettings,
  verifyDatabaseIdentity,
} from "./cf-api-deploy.mjs";
import { SINGLE_TRIAL_PRIVATE_IO as IO } from "./single-trial.mjs";
import { selectCredentials } from "./cf-deploy.mjs";
import {
  validateSingleTrialTarget,
  SINGLE_TRIAL_TARGET_PATH,
} from "./single-trial-config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const INTENT_DIRECTORY = ".local/cf03/production/filename-ai-secret";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => {
  throw new ApiDeployError(code);
};
export const SECRET_MANIFEST = Object.freeze({
  worker: "the-shelf",
  profile: "production",
  secret: FILENAME_AI_SECRET_NAME,
  source: ".env:SHELF_OAI_KEY",
  maximumSecretPuts: 1,
  aiCalls: 0,
  uploads: 0,
  billingChanges: 0,
  installRequests: 4,
  recoveryRequests: 2,
  timeoutMs: 30000,
  responseBytes: 1048576,
  responseChunks: 4096,
  recovery:
    "Read-only settings inspection; remote secret values cannot be read back.",
});

const cancel = (value) => {
  try {
    void Promise.resolve(value?.cancel()).catch(() => {});
  } catch {}
};
// An independent deadline also bounds custom fetchers/readers that ignore abort.
// Consume incrementally, never buffer an unbounded response before checking it.
export async function boundedControlResponse(
  fetcher,
  url,
  options,
  timeoutMs = SECRET_MANIFEST.timeoutMs,
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > SECRET_MANIFEST.timeoutMs
  )
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
      (!/^\d+$/.test(length) || Number(length) > SECRET_MANIFEST.responseBytes)
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
        ++count > SECRET_MANIFEST.responseChunks ||
        (size += part.value.byteLength) > SECRET_MANIFEST.responseBytes
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

async function optionalPrivateJson(root, relative) {
  try {
    return await IO.readPrivate(root, path.join(root, relative));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function privateEnvironment(root) {
  const filename = path.join(root, ".env");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > 1048576
    )
      fail("files");
    const value = parseEnv(await handle.readFile("utf8")),
      after = await handle.stat(),
      named = await fs.lstat(filename);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("files");
    return value;
  } finally {
    await handle.close();
  }
}
async function context(root, environment) {
  root = await fs.realpath(root);
  const fileEnvironment = await privateEnvironment(root);
  const loaded = {
    fileEnvironment,
    credentials: selectCredentials(environment, fileEnvironment),
  };
  if (loaded.credentials.ci) fail("ci");
  const key = loaded.fileEnvironment.SHELF_OAI_KEY;
  // The deployed endpoint is source-pinned. Reject an operator's conflicting
  // local source configuration instead of silently installing that service key.
  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9._~-]{20,4096}$/.test(key) ||
    ![
      "https://oai.parallelstreamllc.com",
      "https://oai.parallelstreamllc.com/",
      "https://oai.parallelstreamllc.com/v1",
      "https://oai.parallelstreamllc.com/v1/",
    ].includes(loaded.fileEnvironment.SHELF_OAI_BASE_URL)
  )
    fail("config");
  const privacy = await loadPrivacySecrets(root);
  const target = validateSingleTrialTarget(
    await IO.readPrivate(root, path.join(root, SINGLE_TRIAL_TARGET_PATH)),
    loaded.credentials.accountId,
    privacy.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET,
  );
  if (!privacy.SHELF_CF_PRODUCTION_SINGLE_TRIAL_UPLOAD_SECRET) fail("secrets");
  const resource = validateDeployConfig(
    await IO.readPrivate(root, path.join(root, ".local/cf03/deploy.json")),
  ).profiles.production;
  const intent = {
    schemaVersion: 1,
    ...SECRET_MANIFEST,
    accountId: loaded.credentials.accountId,
    databaseId: resource.databaseId,
    bucket: target.bucket,
    singleTrialTargetSha256: target.configSha256,
    keySha256: sha(key),
  };
  return {
    root,
    key,
    credentials: loaded.credentials,
    target,
    resource,
    intent,
  };
}
function sameIntent(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("intent");
}
function validateSettings(settings, ctx, filenameAi) {
  validateRemoteBindings(settings, "production", ctx.resource.databaseId, {
    accountId: ctx.credentials.accountId,
    singleTrialTarget: ctx.target,
    filenameAi,
    allowFilenameAiTransition: filenameAi,
  });
}
export async function filenameAiSecret({
  root = ROOT,
  environment = process.env,
  action = "preview",
  execute = false,
  fetcher = fetch,
  inspector = readRemoteSettings,
  identityChecker = verifyDatabaseIdentity,
  timeoutMs = SECRET_MANIFEST.timeoutMs,
} = {}) {
  // Preview is intentionally zero IO, including local credentials and files.
  if (action === "preview" && !execute)
    return { preview: true, ...SECRET_MANIFEST };
  if (
    !["prepare", "install", "recover"].includes(action) ||
    (action === "install" ? execute !== true : execute !== false)
  )
    fail("target");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > SECRET_MANIFEST.timeoutMs
  )
    fail("config");
  try {
    const ctx = await context(root, environment);
    const relative = (name) => `${INTENT_DIRECTORY}/${name}.json`;
    const filename = (name) => path.join(ctx.root, relative(name));
    if (action === "prepare") {
      await IO.privateDirectory(
        ctx.root,
        path.join(ctx.root, INTENT_DIRECTORY),
        true,
      );
      const old = await optionalPrivateJson(ctx.root, relative("intent"));
      if (old) sameIntent(old, ctx.intent);
      else await IO.writeImmutable(ctx.root, filename("intent"), ctx.intent);
      return {
        prepared: true,
        intentPath: relative("intent"),
        ...SECRET_MANIFEST,
      };
    }
    sameIntent(await IO.readPrivate(ctx.root, filename("intent")), ctx.intent);
    const attempt = await optionalPrivateJson(ctx.root, relative("attempt"));
    const accepted = await optionalPrivateJson(ctx.root, relative("accepted"));
    if (attempt && attempt.intentSha256 !== sha(JSON.stringify(ctx.intent)))
      fail("intent");
    if (
      accepted &&
      (!attempt ||
        accepted.intentSha256 !== attempt.intentSha256 ||
        accepted.accepted !== true)
    )
      fail("intent");
    if (action === "install" && attempt)
      fail("attempt_already_recorded_use_recover");
    if (action === "recover" && !attempt) fail("no_attempt");
    const run = await fs.mkdtemp(
      path.join(ctx.root, INTENT_DIRECTORY, `${action}-`),
    );
    const budget = action === "install" ? 4 : 2;
    await IO.writeImmutable(ctx.root, path.join(run, "run.json"), {
      action,
      requestLimit: budget,
      putLimit: action === "install" ? 1 : 0,
      aiCalls: 0,
      uploads: 0,
      billingChanges: 0,
    });
    let requests = 0;
    const request = async (label, method, operation) => {
      if (++requests > budget) fail("request_budget");
      await IO.writeImmutable(
        ctx.root,
        path.join(run, `${requests}-intent.json`),
        { label, method },
      );
      let result;
      try {
        result = await operation();
      } catch (error) {
        await IO.writeImmutable(
          ctx.root,
          path.join(run, `${requests}-outcome.json`),
          {
            label,
            state: method === "PUT" ? "unknown" : "read_or_validation_failed",
          },
        );
        throw error;
      }
      await IO.writeImmutable(
        ctx.root,
        path.join(run, `${requests}-outcome.json`),
        { label, transportCompleted: true },
      );
      return result;
    };
    const transport = (url, options = {}) => {
      const base = `https://api.cloudflare.com/client/v4/accounts/${ctx.credentials.accountId}`;
      const permitted = new Map([
        [`${base}/d1/database/${ctx.resource.databaseId}`, "GET"],
        [`${base}/workers/scripts/the-shelf/settings`, "GET"],
        [`${base}/workers/scripts/the-shelf/secrets`, "PUT"],
      ]);
      const method = options.method || "GET";
      if (
        permitted.get(url) !== method ||
        (action === "recover" && method !== "GET")
      )
        fail("target");
      return boundedControlResponse(
        fetcher,
        url,
        { ...options, method },
        timeoutMs,
      );
    };
    await request("database_identity", "GET", () =>
      identityChecker(ctx.credentials, ctx.resource, { fetchImpl: transport }),
    );
    if (action === "install") {
      if (accepted) fail("intent");
      await request("pre_settings", "GET", async () =>
        validateSettings(
          await inspector(ctx.credentials, "the-shelf", transport),
          ctx,
          false,
        ),
      );
      await IO.writeImmutable(ctx.root, filename("attempt"), {
        intentSha256: sha(JSON.stringify(ctx.intent)),
        at: new Date().toISOString(),
        maximumSecretPuts: 1,
      });
      // Never retry: a timeout or malformed response leaves the durable attempt
      // unknown even if a later GET happens to show a same-named binding.
      let response, data;
      try {
        response = await request("secret_install", "PUT", () =>
          transport(
            `https://api.cloudflare.com/client/v4/accounts/${ctx.credentials.accountId}/workers/scripts/the-shelf/secrets`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${ctx.credentials.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                name: FILENAME_AI_SECRET_NAME,
                text: ctx.key,
                type: "secret_text",
              }),
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            },
          ),
        );
        const text = await response.text();
        if (text.length > 65536) fail("unknown");
        data = JSON.parse(text);
      } catch {
        fail("unknown");
      }
      if (
        !response.ok ||
        data.success !== true ||
        data.result?.name !== FILENAME_AI_SECRET_NAME ||
        data.result?.type !== "secret_text"
      )
        fail("unknown");
      await IO.writeImmutable(ctx.root, filename("accepted"), {
        intentSha256: sha(JSON.stringify(ctx.intent)),
        accepted: true,
        at: new Date().toISOString(),
      });
    }
    await request("post_settings", "GET", async () =>
      validateSettings(
        await inspector(ctx.credentials, "the-shelf", transport),
        ctx,
        true,
      ),
    );
    const confirmed = action === "install" || Boolean(accepted);
    if (
      confirmed &&
      !(await optionalPrivateJson(ctx.root, relative("verified")))
    )
      await IO.writeImmutable(ctx.root, filename("verified"), {
        intentSha256: sha(JSON.stringify(ctx.intent)),
        secretAcceptedAndBindingPresent: true,
        secretValueReadable: false,
        at: new Date().toISOString(),
      });
    return {
      status: confirmed
        ? "accepted_and_binding_present"
        : "unknown_binding_present",
      secretValueReadable: false,
      mayRetryPut: false,
      intentPath: relative("intent"),
    };
  } catch (error) {
    throw new ApiDeployError(
      error instanceof ApiDeployError ? error.code : "secret_operation",
    );
  }
}
export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length > 2 || (argv[1] !== undefined && argv[1] !== "--execute"))
      fail("target");
    console.log(
      JSON.stringify(
        await filenameAiSecret({
          action: argv[0] || "preview",
          execute: argv[1] === "--execute",
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof ApiDeployError
        ? error.message
        : "Secret operation stopped safely.",
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
