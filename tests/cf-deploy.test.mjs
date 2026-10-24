import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deploy,
  DeployError,
  PUBLIC_URL,
  runChild,
  selectCredentials,
  validateConfig,
  STATIC_WORKER_SOURCE,
} from "../scripts/cf-deploy.mjs";

const ACCOUNT = "a".repeat(32);
const OTHER_ACCOUNT = "b".repeat(32);
const TOKEN = "fake-test-only-dedicated-token-value";
const GENERAL_TOKEN = "fake-test-only-general-token-value";
const sourceConfig = () => ({
  name: "the-shelf",
  compatibility_date: "2026-10-15",
  workers_dev: true,
  preview_urls: false,
  assets: {
    directory: "./dist",
    html_handling: "force-trailing-slash",
    not_found_handling: "404-page",
  },
});
const localEnvironment = () => ({
  SHELF_R2_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_API_TOKEN: GENERAL_TOKEN,
});
const ciEnvironment = () => ({
  CI: "true",
  SHELF_CF_AUTO_DEPLOY: "true",
  SHELF_CF_ACCOUNT_ID: ACCOUNT,
  SHELF_CF_DEPLOY_TOKEN: TOKEN,
});
async function fixture(t, config = sourceConfig()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cf-deploy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist/index.html"), "<p>The Shelf</p>");
  await fs.mkdir(path.join(root, "dist/docs"));
  await fs.mkdir(path.join(root, "dist/data"));
  await fs.writeFile(
    path.join(root, "dist/data/runtime.json"),
    JSON.stringify({ schemaVersion: 1, apiMode: "disabled" }),
  );
  await fs.writeFile(
    path.join(root, "dist/docs/index.json"),
    JSON.stringify({ basePath: "/" }),
  );
  await fs.writeFile(path.join(root, "wrangler.jsonc"), JSON.stringify(config));
  return fs.realpath(root);
}
const safeError = (code) => (error) =>
  error instanceof DeployError &&
  error.code === code &&
  !error.message.includes(TOKEN) &&
  !error.message.includes(ACCOUNT);

test("only the Shelf static Worker and dist assets are permitted", () => {
  assert.equal(validateConfig(sourceConfig()).name, "the-shelf");
  const mutations = [
    (config) => {
      config.name = "another-project";
    },
    (config) => {
      config.main = "server/index.mjs";
    },
    (config) => {
      config.d1_databases = [{ binding: "DB" }];
    },
    (config) => {
      config.r2_buckets = [{ binding: "BOOKS" }];
    },
    (config) => {
      config.vars = { PASSWORD: TOKEN };
    },
    (config) => {
      config.routes = ["example.com/*"];
    },
    (config) => {
      config.account_id = ACCOUNT;
    },
    (config) => {
      config.build = { command: "unsafe" };
    },
    (config) => {
      config.env = { production: { name: "another-project" } };
    },
    (config) => {
      config.assets.directory = ".local";
    },
    (config) => {
      config.assets.directory = "../dist";
    },
    (config) => {
      config.assets.binding = "ASSETS";
    },
    (config) => {
      config.assets.run_worker_first = true;
    },
    (config) => {
      config.assets.not_found_handling = "single-page-application";
    },
    (config) => {
      delete config.assets.html_handling;
    },
    (config) => {
      config.assets.html_handling = "none";
    },
    (config) => {
      delete config.assets.not_found_handling;
    },
    (config) => {
      config.workers_dev = false;
    },
    (config) => {
      config.preview_urls = true;
    },
  ];
  for (const mutate of mutations) {
    const config = sourceConfig();
    mutate(config);
    assert.throws(() => validateConfig(config), safeError("config"));
  }
});

test("account values must all match the project, without overriding process configuration", () => {
  const environment = { ...localEnvironment(), SHELF_CF_DEPLOY_TOKEN: TOKEN };
  const before = { ...environment };
  const selected = selectCredentials(environment, {
    SHELF_CF_DEPLOY_TOKEN: GENERAL_TOKEN,
  });
  assert.equal(selected.token, TOKEN);
  assert.equal(selected.accountId, ACCOUNT);
  assert.deepEqual(environment, before);
  assert.equal(selectCredentials(localEnvironment()).token, GENERAL_TOKEN);
  assert.throws(
    () =>
      selectCredentials({
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        CLOUDFLARE_API_TOKEN: TOKEN,
      }),
    safeError("credentials"),
  );
  assert.throws(
    () =>
      selectCredentials({
        ...localEnvironment(),
        CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT,
      }),
    safeError("credentials"),
  );
  assert.throws(
    () =>
      selectCredentials(localEnvironment(), {
        SHELF_R2_ACCOUNT_ID: OTHER_ACCOUNT,
      }),
    safeError("credentials"),
  );
});

test("CI cannot fall back to inherited general credentials or an unenabled deployment", () => {
  for (const marker of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE"]) {
    assert.throws(
      () => selectCredentials({ ...localEnvironment(), [marker]: "true" }),
      safeError("ci"),
    );
  }
  assert.throws(
    () =>
      selectCredentials({ ...ciEnvironment(), SHELF_CF_AUTO_DEPLOY: "false" }),
    safeError("ci"),
  );
  assert.throws(
    () =>
      selectCredentials(
        { CI: "true", SHELF_CF_AUTO_DEPLOY: "true" },
        ciEnvironment(),
      ),
    safeError("ci"),
  );
  const selected = selectCredentials({
    ...ciEnvironment(),
    CLOUDFLARE_API_TOKEN: GENERAL_TOKEN,
  });
  assert.equal(selected.token, TOKEN);
  assert.equal(selected.ci, true);
});

test("deployment uses isolated config, empty dotenv, minimal environment and private redacted logs", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    path.join(root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_OWNER_PASSWORD="fake-test-only-private-password"\n`,
    { mode: 0o600 },
  );
  const calls = [];
  const environment = {
    SHELF_CF_DEPLOY_TOKEN: TOKEN,
    CLOUDFLARE_API_TOKEN: GENERAL_TOKEN,
    CLOUDFLARE_API_BASE_URL: "https://untrusted.example",
    NODE_OPTIONS: "--require=untrusted-module",
    WRANGLER_CI_OVERRIDE_NAME: "another-project",
    PUBLIC_SHELF_API_URL: "https://untrusted.example",
    WRANGLER_LOG_PATH: "/untrusted/global.log",
  };
  const result = await deploy({
    inspector: async () => ({ bindings: [] }),
    root,
    environment,
    runner: async (call) => {
      calls.push(call);
      if (calls.length === 1) {
        assert.equal(
          call.env.SHELF_OWNER_PASSWORD,
          "fake-test-only-private-password",
        );
      }
      if (calls.length === 3) {
        assert.equal(call.env.CLOUDFLARE_API_TOKEN, TOKEN);
        assert.equal(call.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
        for (const key of [
          "NODE_OPTIONS",
          "CLOUDFLARE_API_BASE_URL",
          "WRANGLER_CI_OVERRIDE_NAME",
          "PUBLIC_SHELF_API_URL",
          "SHELF_OWNER_PASSWORD",
          "SHELF_CF_DEPLOY_TOKEN",
        ])
          assert.equal(call.env[key], undefined);
        assert.ok(!call.args.join(" ").includes(TOKEN));
        assert.ok(!call.args.join(" ").includes(ACCOUNT));
        assert.equal(call.env.WRANGLER_SEND_METRICS, "false");
        const configPath = call.args[call.args.indexOf("--config") + 1];
        const config = JSON.parse(await fs.readFile(configPath, "utf8"));
        assert.equal(config.name, "the-shelf");
        assert.equal(config.assets.directory, path.join(root, "dist"));
        assert.equal(
          await fs.readFile(config.main, "utf8"),
          STATIC_WORKER_SOURCE,
        );
        assert.equal(config.assets.binding, "ASSETS");
        assert.equal(
          await fs.readFile(
            call.args[call.args.indexOf("--env-file") + 1],
            "utf8",
          ),
          "",
        );
        assert.equal((await fs.stat(call.cwd)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(call.logPath)).mode & 0o777, 0o600);
        await fs.appendFile(
          call.logPath,
          `fake child output ${TOKEN} ${ACCOUNT}`,
        );
        await fs.appendFile(
          call.env.WRANGLER_LOG_PATH,
          `fake diagnostic ${TOKEN}`,
        );
      }
      return { code: 0, signal: null };
    },
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].args[0], /verify-public\.mjs$/);
  assert.match(calls[1].args[0], /verify-static\.mjs$/);
  assert.equal(result.url, PUBLIC_URL);
  assert.equal(result.ok, true);
  for (const name of ["deploy.log", "wrangler.log"]) {
    const filename = path.join(root, path.dirname(result.logPath), name);
    const text = await fs.readFile(filename, "utf8");
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes(ACCOUNT));
    assert.match(text, /\[REDACTED\]/);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  }
});

test("preflight failures prevent deployment and deployment errors reveal no native details", async (t) => {
  const root = await fixture(t);
  let count = 0;
  await assert.rejects(
    deploy({
      inspector: async () => ({ bindings: [] }),
      root,
      environment: localEnvironment(),
      runner: async () => {
        count++;
        return { code: 1 };
      },
    }),
    safeError("preflight"),
  );
  assert.equal(count, 1);
  count = 0;
  await assert.rejects(
    deploy({
      inspector: async () => ({ bindings: [] }),
      root,
      environment: localEnvironment(),
      runner: async (call) => {
        count++;
        if (count === 3) {
          await fs.appendFile(call.logPath, GENERAL_TOKEN);
          throw new Error(`fake native failure ${GENERAL_TOKEN} ${ACCOUNT}`);
        }
        return { code: 0 };
      },
    }),
    (error) => {
      assert.equal(error.code, "deploy");
      assert.ok(!error.message.includes(GENERAL_TOKEN));
      assert.ok(!error.message.includes(ACCOUNT));
      return true;
    },
  );
  assert.equal(count, 3);
});

test("unsafe asset links, private directories and symlinked private workspace reject before commands", async (t) => {
  const cases = [
    (root) =>
      fs.symlink(
        path.join(root, "wrangler.jsonc"),
        path.join(root, "dist/config.json"),
      ),
    (root) => fs.mkdir(path.join(root, "dist/.local")),
    (root) => fs.symlink(path.join(root, "dist"), path.join(root, ".local")),
    (root) =>
      fs.writeFile(path.join(root, ".env"), `SHELF_R2_ACCOUNT_ID=${ACCOUNT}`, {
        mode: 0o644,
      }),
  ];
  for (const setup of cases) {
    const root = await fixture(t);
    await setup(root);
    await assert.rejects(
      deploy({
        inspector: async () => ({ bindings: [] }),
        root,
        environment: localEnvironment(),
        runner: () => assert.fail("must not execute"),
      }),
      safeError("files"),
    );
  }
});

test("child execution captures output without interpreting shell metacharacters", async (t) => {
  const root = await fixture(t);
  const logPath = path.join(root, "child.log");
  const literal = "$(touch should-never-exist); fake-test-only";
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", literal],
    cwd: root,
    env: {},
    logPath,
  });
  assert.equal(result.code, 0);
  assert.equal((await fs.readFile(logPath, "utf8")).trim(), literal);
  await assert.rejects(fs.stat(path.join(root, "should-never-exist")), {
    code: "ENOENT",
  });
});

test("child logs redact credentials before persistence and Pages artifacts cannot be deployed", async (t) => {
  const root = await fixture(t);
  const logPath = path.join(root, "child.log");
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.TEST_CREDENTIAL)"],
    cwd: root,
    env: { TEST_CREDENTIAL: TOKEN },
    logPath,
    redactions: [TOKEN],
  });
  assert.equal(result.code, 0);
  assert.equal((await fs.readFile(logPath, "utf8")).trim(), "[REDACTED]");
  await fs.writeFile(
    path.join(root, "dist/docs/index.json"),
    JSON.stringify({ basePath: "/the-shelf/" }),
  );
  await assert.rejects(
    deploy({
      inspector: async () => ({ bindings: [] }),
      root,
      environment: localEnvironment(),
      runner: () => assert.fail("must not execute"),
    }),
    safeError("config"),
  );
});

test("ordinary static deployment cannot replace an API Worker or accept its frontend artifact", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    deploy({
      root,
      environment: localEnvironment(),
      inspector: async () => ({
        bindings: [{ name: "DB", type: "d1", id: "unknown" }],
      }),
      runner: () => assert.fail("must not run"),
    }),
    safeError("bindings"),
  );
  await fs.writeFile(
    path.join(root, "dist/data/runtime.json"),
    JSON.stringify({ schemaVersion: 1, apiMode: "same-origin" }),
  );
  await assert.rejects(
    deploy({
      root,
      environment: localEnvironment(),
      inspector: async () => ({ bindings: [] }),
      runner: () => assert.fail("must not run"),
    }),
    safeError("config"),
  );
});

test("explicit static rollback verifies and records the exact previous API bindings", async (t) => {
  const { PROFILES, SECRET_NAMES } =
    await import("../scripts/cf-api-deploy.mjs");
  const root = await fixture(t),
    checkId = "11111111-1111-4111-8111-111111111111",
    prodId = "22222222-2222-4222-8222-222222222222";
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf03"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        check: {
          databaseId: checkId,
          databaseName: PROFILES.check.databaseName,
        },
        production: {
          databaseId: prodId,
          databaseName: PROFILES.production.databaseName,
        },
      },
    }),
    { mode: 0o600 },
  );
  const settings = {
    bindings: [
      { name: "DB", type: "d1", id: prodId },
      { name: "BOOKS", type: "r2_bucket", bucket_name: "the-shelf-books" },
      { name: "ASSETS", type: "assets" },
      ...SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
      ...Object.entries({
        APP_SCOPE: "production",
        SITE_ORIGIN: PROFILES.production.origin,
        R2_ACCOUNT_ID: ACCOUNT,
        R2_BUCKET: "the-shelf-books",
      }).map(([name, text]) => ({ name, text, type: "plain_text" })),
    ],
  };
  let calls = 0;
  const result = await deploy({
    root,
    staticRollback: true,
    environment: localEnvironment(),
    inspector: async () =>
      calls === 0
        ? settings
        : {
            bindings: settings.bindings.filter(
              (b) => b.type === "secret_text" || b.type === "assets",
            ),
          },
    runner: async () => {
      calls++;
      return { code: 0 };
    },
  });
  assert.equal(calls, 3);
  const record = path.join(
    root,
    path.dirname(result.logPath),
    "rollback-bindings.json",
  );
  assert.equal((await fs.stat(record)).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(await fs.readFile(record, "utf8")).bindings,
    settings.bindings,
  );
  const staticSettings = {
    bindings: settings.bindings.filter(
      (b) => b.type === "secret_text" || b.type === "assets",
    ),
  };
  await deploy({
    root,
    environment: localEnvironment(),
    inspector: async () => staticSettings,
    runner: async () => {
      calls++;
      return { code: 0 };
    },
  });
  assert.equal(
    calls,
    6,
    "ordinary static publication works after explicit rollback retained secrets",
  );
  settings.bindings.find((b) => b.name === "DB").id = checkId;
  await assert.rejects(
    deploy({
      root,
      staticRollback: true,
      environment: localEnvironment(),
      inspector: async () => settings,
      runner: () => assert.fail("must not deploy wrong DB"),
    }),
  );
});
test("trial static rollback requires explicit private target and strips all runtime capabilities", async (t) => {
  const { PROFILES, SINGLE_TRIAL_SECRET_NAMES, workerConfig } =
      await import("../scripts/cf-api-deploy.mjs"),
    { validateSingleTrialTarget } =
      await import("../scripts/single-trial-config.mjs"),
    { createHash } = await import("node:crypto");
  const root = await fixture(t),
    prodId = "22222222-2222-4222-8222-222222222222",
    upload = Buffer.alloc(32, 47).toString("base64url"),
    v = {
      schemaVersion: 1,
      mode: "first-book-20261023",
      accountId: ACCOUNT,
      bucket: "the-shelf-first-book-20261023",
      worker: "the-shelf",
      origin: PROFILES.production.origin,
      uploadSecretSha256: createHash("sha256").update(upload).digest("hex"),
    },
    target = validateSingleTrialTarget(v, ACCOUNT, upload);
  for (const dir of [".local", ".local/cf03", ".local/cf03/production"])
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        check: {
          databaseId: "11111111-1111-4111-8111-111111111111",
          databaseName: PROFILES.check.databaseName,
        },
        production: {
          databaseId: prodId,
          databaseName: PROFILES.production.databaseName,
        },
      },
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/production/single-trial-target.json"),
    JSON.stringify(v),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/production/single-trial-upload-secret"),
    upload + "\n",
    { mode: 0o600 },
  );
  const generated = workerConfig(
      "production",
      { databaseId: prodId },
      ACCOUNT,
      root,
      { singleTrialTarget: target },
    ),
    settings = {
      bindings: [
        { name: "DB", type: "d1", id: prodId },
        { name: "BOOKS", type: "r2_bucket", bucket_name: v.bucket },
        { name: "ASSETS", type: "assets" },
        ...SINGLE_TRIAL_SECRET_NAMES.map((name) => ({
          name,
          type: "secret_text",
        })),
        ...Object.entries(generated.vars).map(([name, text]) => ({
          name,
          text,
          type: "plain_text",
        })),
      ],
    };
  await assert.rejects(
    deploy({
      root,
      staticRollback: true,
      environment: localEnvironment(),
      inspector: async () => settings,
      runner: () => assert.fail("unreviewed trial must not deploy"),
    }),
    safeError("remote"),
  );
  await assert.rejects(
    deploy({
      root,
      staticRollback: true,
      singleTrial: "true",
      environment: localEnvironment(),
      inspector: () =>
        assert.fail("invalid trial flag must reject before HTTP"),
      runner: () => assert.fail("invalid trial flag must not deploy"),
    }),
    safeError("config"),
  );
  let calls = 0;
  const result = await deploy({
    root,
    staticRollback: true,
    singleTrial: true,
    environment: localEnvironment(),
    inspector: async () =>
      calls === 0
        ? settings
        : {
            bindings: settings.bindings.filter((b) =>
              ["assets", "secret_text"].includes(b.type),
            ),
          },
    runner: async (call) => {
      calls++;
      assert.ok(call.redactions.includes(upload));
      if (call.args.includes("deploy")) {
        const cfg = JSON.parse(
          await fs.readFile(
            call.args[call.args.indexOf("--config") + 1],
            "utf8",
          ),
        );
        assert.equal(await fs.readFile(cfg.main, "utf8"), STATIC_WORKER_SOURCE);
        assert.equal(cfg.assets.binding, "ASSETS");
        assert.equal(cfg.r2_buckets, undefined);
        assert.equal(cfg.d1_databases, undefined);
        assert.equal(cfg.vars, undefined);
      }
      return { code: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test("retained known secrets allow subsequent ordinary static publishing and postflight rejects leftover API bindings", async (t) => {
  const { SECRET_NAMES } = await import("../scripts/cf-api-deploy.mjs");
  const root = await fixture(t),
    retained = {
      bindings: [
        { name: "ASSETS", type: "assets" },
        ...SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
      ],
    };
  let inspected = 0;
  const result = await deploy({
    root,
    environment: localEnvironment(),
    inspector: async () => {
      inspected++;
      return retained;
    },
    runner: async () => ({ code: 0 }),
  });
  assert.equal(result.ok, true);
  assert.equal(inspected, 2);
  for (const bad of [
    { name: "DB", type: "d1", id: "unexpected" },
    { name: "BOOKS", type: "r2_bucket", bucket_name: "the-shelf-books" },
    { name: "UNKNOWN", type: "plain_text", text: "unsafe" },
  ]) {
    let reads = 0;
    await assert.rejects(
      deploy({
        root,
        environment: localEnvironment(),
        inspector: async () =>
          ++reads === 1 ? retained : { bindings: [...retained.bindings, bad] },
        runner: async () => ({ code: 0 }),
      }),
      safeError("bindings"),
    );
  }
  await assert.rejects(
    deploy({
      root,
      environment: localEnvironment(),
      inspector: async () => ({ bindings: retained.bindings.slice(0, 2) }),
      runner: () =>
        assert.fail("partial secrets are not an approved static state"),
    }),
    safeError("bindings"),
  );
});
