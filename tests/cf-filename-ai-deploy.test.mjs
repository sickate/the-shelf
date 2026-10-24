import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  PROFILES,
  FILENAME_AI_SECRET_NAMES,
  SINGLE_TRIAL_SECRET_NAMES,
  workerConfig,
  validateRemoteBindings,
  safeStaticBindings,
  deployApi,
} from "../scripts/cf-api-deploy.mjs";
import { deploy, STATIC_WORKER_SOURCE } from "../scripts/cf-deploy.mjs";
import { validateSingleTrialTarget } from "../scripts/single-trial-config.mjs";
import {
  filenameAiSecret,
  INTENT_DIRECTORY,
  boundedControlResponse,
} from "../scripts/cf-filename-ai-secret.mjs";

const ACCOUNT = "a".repeat(32),
  TOKEN = "fake-project-deployment-token-only-1234";
const KEY = "fake-private-ai-service-key-test-only-1234";
const ID = "22222222-2222-4222-8222-222222222222";
const environment = {
  SHELF_R2_ACCOUNT_ID: ACCOUNT,
  SHELF_CF_DEPLOY_TOKEN: TOKEN,
};
const trialSecret = Buffer.alloc(32, 77).toString("base64url");
const targetInput = {
  schemaVersion: 1,
  mode: "first-book-20261023",
  accountId: ACCOUNT,
  bucket: "the-shelf-first-book-20261023",
  worker: "the-shelf",
  origin: PROFILES.production.origin,
  uploadSecretSha256: createHash("sha256").update(trialSecret).digest("hex"),
};
const target = validateSingleTrialTarget(targetInput, ACCOUNT, trialSecret);
const vars = (ai) =>
  workerConfig("production", { databaseId: ID }, ACCOUNT, "/safe", {
    singleTrialTarget: target,
    filenameAi: ai,
  }).vars;
const settings = (ai = false, staged = ai) => ({
  bindings: [
    { name: "DB", type: "d1", id: ID },
    { name: "BOOKS", type: "r2_bucket", bucket_name: target.bucket },
    { name: "ASSETS", type: "assets" },
    ...(staged ? FILENAME_AI_SECRET_NAMES : SINGLE_TRIAL_SECRET_NAMES).map(
      (name) => ({ name, type: "secret_text" }),
    ),
    ...Object.entries(vars(ai)).map(([name, text]) => ({
      name,
      text,
      type: "plain_text",
    })),
  ],
});
const options = {
  accountId: ACCOUNT,
  singleTrialTarget: target,
  filenameAi: true,
};
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-filename-ai-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of [".local", ".local/cf03", ".local/cf03/production"])
    await fs.mkdir(path.join(root, directory), { mode: 0o700 });
  const write = (name, content) =>
    fs.writeFile(path.join(root, name), content, { mode: 0o600 });
  await write(
    ".env",
    `SHELF_OAI_KEY=${KEY}\nSHELF_OAI_BASE_URL=https://oai.parallelstreamllc.com/\n`,
  );
  await write(".local/cf03/production/single-trial-upload-secret", trialSecret);
  await write(
    ".local/cf03/production/single-trial-target.json",
    JSON.stringify(targetInput),
  );
  await write(
    ".local/cf03/deploy.json",
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        check: {
          databaseId: "11111111-1111-4111-8111-111111111111",
          databaseName: PROFILES.check.databaseName,
        },
        production: {
          databaseId: ID,
          databaseName: PROFILES.production.databaseName,
        },
      },
    }),
  );
  await fs.mkdir(path.join(root, "cloudflare/library"), { recursive: true });
  await write("cloudflare/library/worker.mjs", "export default {}");
  for (const dir of ["dist", "dist/data", "dist/docs"])
    await fs.mkdir(path.join(root, dir));
  await write("dist/index.html", "<p>Shelf</p>");
  await write(
    "dist/data/runtime.json",
    JSON.stringify({ apiMode: "same-origin", schemaVersion: 1 }),
  );
  await write("dist/docs/index.json", JSON.stringify({ basePath: "/" }));
  await write(
    "wrangler.jsonc",
    JSON.stringify({
      name: "the-shelf",
      compatibility_date: "2026-10-15",
      workers_dev: true,
      preview_urls: false,
      assets: {
        directory: "./dist",
        html_handling: "force-trailing-slash",
        not_found_handling: "404-page",
      },
    }),
  );
  return root;
}
const dependencies = { identityChecker: async () => {} };
test("AI mode is exact, paired and production trial only, while old validators stay closed", () => {
  validateRemoteBindings(settings(true), "production", ID, options);
  assert.throws(() =>
    validateRemoteBindings(settings(false, true), "production", ID, options),
  );
  validateRemoteBindings(settings(false, true), "production", ID, {
    ...options,
    allowFilenameAiTransition: true,
  });
  assert.throws(() =>
    validateRemoteBindings(settings(true), "production", ID, {
      ...options,
      filenameAi: false,
    }),
  );
  assert.throws(() =>
    workerConfig("check", { databaseId: ID }, ACCOUNT, "/safe", {
      singleTrialTarget: target,
      filenameAi: true,
    }),
  );
  for (const mutate of [
    (b) => b.push({ name: "OTHER", type: "secret_text" }),
    (b) =>
      b.splice(
        b.findIndex((v) => v.name === "FILENAME_AI_KEY"),
        1,
      ),
    (b) => (b.find((v) => v.name === "FILENAME_AI_MODE").text = "other"),
    (b) => (b.find((v) => v.name === "BOOKS").bucket_name = "the-shelf-books"),
  ]) {
    const value = settings(true);
    mutate(value.bindings);
    assert.throws(() =>
      validateRemoteBindings(value, "production", ID, options),
    );
  }
  const staticValue = {
    bindings: settings(true).bindings.filter((b) =>
      ["assets", "secret_text"].includes(b.type),
    ),
  };
  assert.equal(safeStaticBindings(staticValue), false);
  assert.equal(safeStaticBindings(staticValue, { filenameAi: true }), true);
  validateRemoteBindings(staticValue, "production", ID, {
    ...options,
    allowStatic: true,
  });
  for (const value of [
    staticValue.bindings.slice(1),
    staticValue.bindings.slice(0, -1),
    [...staticValue.bindings, { name: "X", type: "secret_text" }],
  ])
    assert.throws(() =>
      validateRemoteBindings({ bindings: value }, "production", ID, {
        ...options,
        allowStatic: true,
      }),
    );
});
test("AI deploy accepts explicit staged or strict static state, strips secrets from generated artifacts and requires final mode", async (t) => {
  const root = await fixture(t);
  for (const before of [
    settings(false, true),
    {
      bindings: settings(true).bindings.filter((b) =>
        ["assets", "secret_text"].includes(b.type),
      ),
    },
  ]) {
    let reads = 0;
    await deployApi({
      root,
      profile: "production",
      singleTrial: true,
      filenameAi: true,
      environment,
      ...dependencies,
      inspector: async () => (++reads === 1 ? before : settings(true)),
      runner: async (call) => {
        if (call.args.includes("deploy")) {
          const config = await fs.readFile(
            call.args[call.args.indexOf("--config") + 1],
            "utf8",
          );
          assert.equal(JSON.parse(config).vars.FILENAME_AI_MODE, "filename-v1");
          assert.ok(!config.includes(KEY));
          assert.equal(call.env.SHELF_OAI_KEY, undefined);
          assert.ok(call.redactions.includes(KEY));
        }
        return { code: 0 };
      },
    });
  }
  let reads = 0;
  await assert.rejects(
    deployApi({
      root,
      profile: "production",
      singleTrial: true,
      filenameAi: true,
      environment,
      ...dependencies,
      inspector: async () => (++reads, settings(false, true)),
      runner: async () => ({ code: 0 }),
    }),
    (e) => e.code === "bindings",
  );
});
test("AI static rollback requires explicit flag and leaves only assets and exact secrets", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    path.join(root, "dist/data/runtime.json"),
    JSON.stringify({ apiMode: "disabled", schemaVersion: 1 }),
  );
  await assert.rejects(
    deploy({
      root,
      staticRollback: true,
      singleTrial: true,
      environment,
      inspector: async () => settings(true),
      runner: () => assert.fail("flag required"),
    }),
  );
  let calls = 0;
  const retained = {
    bindings: settings(true).bindings.filter((b) =>
      ["assets", "secret_text"].includes(b.type),
    ),
  };
  const runner = async (call) => {
    calls++;
    if (call.args.includes("deploy")) {
      const config = JSON.parse(
        await fs.readFile(call.args[call.args.indexOf("--config") + 1], "utf8"),
      );
      assert.equal(config.vars, undefined);
      assert.equal(
        await fs.readFile(config.main, "utf8"),
        STATIC_WORKER_SOURCE,
      );
      assert.equal(config.assets.binding, "ASSETS");
      assert.equal(config.r2_buckets, undefined);
    }
    return { code: 0 };
  };
  await deploy({
    root,
    staticRollback: true,
    singleTrial: true,
    filenameAi: true,
    environment,
    inspector: async () => (calls === 0 ? settings(true) : retained),
    runner,
  });
  await deploy({
    root,
    staticRollback: true,
    singleTrial: true,
    filenameAi: true,
    environment,
    inspector: async () => retained,
    runner,
  });
});
test("explicit AI rollback accepts exact pre-deploy staged secrets and rejects all other drift", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    path.join(root, "dist/data/runtime.json"),
    JSON.stringify({ apiMode: "disabled", schemaVersion: 1 }),
  );
  const staged = settings(false, true);
  const retained = {
    bindings: staged.bindings.filter((b) =>
      ["assets", "secret_text"].includes(b.type),
    ),
  };
  for (const mutate of [
    (b) =>
      b.push({ name: "FILENAME_AI_MODE", type: "plain_text", text: "other" }),
    (b) =>
      b.splice(
        b.findIndex((v) => v.name === "FILENAME_AI_KEY"),
        1,
      ),
    (b) => b.push({ name: "OTHER", type: "secret_text" }),
  ]) {
    const bad = structuredClone(staged);
    mutate(bad.bindings);
    await assert.rejects(
      deploy({
        root,
        staticRollback: true,
        singleTrial: true,
        filenameAi: true,
        environment,
        inspector: async () => bad,
        runner: () => assert.fail("drift must prevent rollback"),
      }),
    );
  }
  let calls = 0;
  await deploy({
    root,
    staticRollback: true,
    singleTrial: true,
    filenameAi: true,
    environment,
    inspector: async () => (calls === 0 ? staged : retained),
    runner: async () => {
      calls++;
      return { code: 0 };
    },
  });
  assert.equal(calls, 3);
});
test("secret preview has zero IO and prepare is immutable, private and free of plaintext keys", async (t) => {
  assert.equal(
    (
      await filenameAiSecret({
        root: "/does/not/exist",
        environment: new Proxy(
          {},
          {
            get() {
              assert.fail("zero IO");
            },
          },
        ),
      })
    ).preview,
    true,
  );
  const root = await fixture(t);
  await filenameAiSecret({
    root,
    environment,
    action: "prepare",
    fetcher: () => assert.fail("local only"),
  });
  await filenameAiSecret({ root, environment, action: "prepare" });
  const filename = path.join(root, INTENT_DIRECTORY, "intent.json"),
    text = await fs.readFile(filename, "utf8");
  assert.ok(!text.includes(KEY));
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
  await fs.appendFile(path.join(root, ".env"), `SHELF_OAI_KEY=${KEY}changed\n`);
  await assert.rejects(
    filenameAiSecret({ root, environment, action: "prepare" }),
    (e) => e.code === "intent",
  );
});
test("secret install sends exactly one PUT after durable attempt, recover performs only GET and never proves unknown values", async (t) => {
  for (const uncertain of [false, true]) {
    const root = await fixture(t);
    await filenameAiSecret({ root, environment, action: "prepare" });
    let puts = 0,
      reads = 0;
    const inspector = async () =>
      ++reads === 1 ? settings(false) : settings(false, true);
    const fetcher = async (url, request) => {
      puts++;
      assert.equal(request.method, "PUT");
      assert.equal(request.redirect, "error");
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/the-shelf/secrets`,
      );
      assert.deepEqual(JSON.parse(request.body), {
        name: "FILENAME_AI_KEY",
        text: KEY,
        type: "secret_text",
      });
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(root, INTENT_DIRECTORY, "attempt.json"),
            "utf8",
          ),
        ).maximumSecretPuts,
        1,
      );
      if (uncertain) throw new Error(KEY);
      return Response.json({
        success: true,
        result: { name: "FILENAME_AI_KEY", type: "secret_text" },
      });
    };
    const args = {
      root,
      environment,
      action: "install",
      execute: true,
      ...dependencies,
      inspector,
      fetcher,
    };
    if (uncertain)
      await assert.rejects(
        filenameAiSecret(args),
        (e) => e.code === "unknown" && !e.message.includes(KEY),
      );
    else
      assert.equal(
        (await filenameAiSecret(args)).status,
        "accepted_and_binding_present",
      );
    await assert.rejects(
      filenameAiSecret(args),
      (e) => e.code === "attempt_already_recorded_use_recover",
    );
    const result = await filenameAiSecret({
      ...args,
      action: "recover",
      execute: false,
      inspector: async () => settings(false, true),
      fetcher: () => assert.fail("no retry"),
    });
    assert.equal(
      result.status,
      uncertain ? "unknown_binding_present" : "accepted_and_binding_present",
    );
    assert.equal(result.secretValueReadable, false);
    assert.equal(puts, 1);
    for (const file of await fs.readdir(path.join(root, INTENT_DIRECTORY), {
      recursive: true,
      withFileTypes: true,
    }))
      if (file.isFile())
        assert.ok(
          !(
            await fs.readFile(path.join(file.parentPath, file.name), "utf8")
          ).includes(KEY),
        );
  }
});
test("concurrent installers race on exclusive attempt and only one can PUT", async (t) => {
  const root = await fixture(t);
  await filenameAiSecret({ root, environment, action: "prepare" });
  let puts = 0;
  const args = {
    root,
    environment,
    action: "install",
    execute: true,
    ...dependencies,
    inspector: async () => settings(false),
    fetcher: async () => {
      puts++;
      throw Error("unknown");
    },
  };
  const results = await Promise.allSettled([
    filenameAiSecret(args),
    filenameAiSecret(args),
  ]);
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(puts, 1);
});
test("real transport contract is four fixed requests and durable bounded request journals", async (t) => {
  const root = await fixture(t);
  await filenameAiSecret({ root, environment, action: "prepare" });
  const calls = [];
  let settingsReads = 0;
  const fetcher = async (url, request) => {
    calls.push({ url, method: request.method });
    if (url.endsWith(`/d1/database/${ID}`))
      return Response.json({
        success: true,
        result: { uuid: ID, name: "the-shelf-library" },
      });
    if (url.endsWith("/settings"))
      return Response.json({
        success: true,
        result: ++settingsReads === 1 ? settings(false) : settings(false, true),
      });
    return Response.json({
      success: true,
      result: { name: "FILENAME_AI_KEY", type: "secret_text" },
    });
  };
  assert.equal(
    (
      await filenameAiSecret({
        root,
        environment,
        action: "install",
        execute: true,
        fetcher,
      })
    ).status,
    "accepted_and_binding_present",
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET", "GET", "PUT", "GET"],
  );
  const files = await fs.readdir(path.join(root, INTENT_DIRECTORY));
  const journal = path.join(
    root,
    INTENT_DIRECTORY,
    files.find((name) => name.startsWith("install-")),
  );
  assert.equal((await fs.readdir(journal)).length, 9);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(journal, "run.json"), "utf8")),
    {
      action: "install",
      requestLimit: 4,
      putLimit: 1,
      aiCalls: 0,
      uploads: 0,
      billingChanges: 0,
    },
  );
});
test("secret transport bounds ignored aborts, hanging bodies, redirects, bytes and chunks", async () => {
  const url = "https://fixed.invalid";
  const hungBody = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: () => new Promise(() => {}),
        releaseLock() {},
      }),
      cancel: () => new Promise(() => {}),
    },
  };
  for (const fetcher of [
    async () => new Promise(() => {}),
    async () => hungBody,
    async () => ({ status: 200, redirected: true }),
    async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "1048577",
        },
      }),
    async () =>
      new Response(new Uint8Array(1048577), {
        headers: { "content-type": "application/json" },
      }),
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array());
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  ])
    await assert.rejects(
      boundedControlResponse(fetcher, url, {}, 20),
      (e) => e.code === "unknown",
    );
  for (const timeout of [0, -1, 30001, Infinity, 1.5, "30"])
    await assert.rejects(
      boundedControlResponse(
        () => assert.fail("invalid deadline"),
        url,
        {},
        timeout,
      ),
      (e) => e.code === "config",
    );
});
test("private configuration rejects unsafe env files, wrong key characters and service origins before IO", async (t) => {
  const root = await fixture(t);
  await fs.chmod(path.join(root, ".env"), 0o644);
  await assert.rejects(
    filenameAiSecret({ root, environment, action: "prepare" }),
  );
  await fs.chmod(path.join(root, ".env"), 0o600);
  for (const text of [
    `SHELF_OAI_KEY=bad key with spaces long enough\nSHELF_OAI_BASE_URL=https://oai.parallelstreamllc.com/`,
    `SHELF_OAI_KEY=${KEY}\nSHELF_OAI_BASE_URL=https://other.invalid/`,
  ]) {
    await fs.writeFile(path.join(root, ".env"), text);
    await assert.rejects(
      filenameAiSecret({ root, environment, action: "prepare" }),
      (e) => e.code === "config",
    );
  }
  await fs.unlink(path.join(root, ".env"));
  await fs.symlink("outside.env", path.join(root, ".env"));
  await assert.rejects(
    filenameAiSecret({ root, environment, action: "prepare" }),
  );
});
test("CLI rejects incomplete AI flag combinations without loading credentials", async () => {
  for (const args of [
    ["scripts/cf-api-deploy.mjs", "--profile", "production", "--filename-ai"],
    [
      "scripts/cf-api-deploy.mjs",
      "--profile",
      "check",
      "--single-trial",
      "--filename-ai",
    ],
    ["scripts/cf-deploy.mjs", "--filename-ai"],
    ["scripts/cf-filename-ai-secret.mjs", "install"],
  ]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, args),
      (e) => e.code === 1 && !`${e.stdout}${e.stderr}`.includes(KEY),
    );
  }
});
