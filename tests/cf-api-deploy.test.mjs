import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROFILES,
  SECRET_NAMES,
  validateDeployConfig,
  validateRemoteBindings,
  workerConfig,
  deployApi,
  readRemoteSettings,
  ApiDeployError,
  verifyDatabaseIdentity,
} from "../scripts/cf-api-deploy.mjs";
import { initialize } from "../scripts/cf-api-init.mjs";
const ACCOUNT = "a".repeat(32),
  TOKEN = "fake-test-project-token-123456789";
const IDS = {
  check: "11111111-1111-4111-8111-111111111111",
  production: "22222222-2222-4222-8222-222222222222",
};
const config = () => ({
  schemaVersion: 1,
  profiles: Object.fromEntries(
    Object.entries(PROFILES).map(([k, v]) => [
      k,
      { databaseId: IDS[k], databaseName: v.databaseName },
    ]),
  ),
});
const bindings = (profile) => [
  { name: "DB", type: "d1", id: IDS[profile] },
  { name: "BOOKS", type: "r2_bucket", bucket_name: "the-shelf-books" },
  ...SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
  ...Object.entries({
    APP_SCOPE: PROFILES[profile].scope,
    SITE_ORIGIN: PROFILES[profile].origin,
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: "the-shelf-books",
  }).map(([name, text]) => ({ name, text, type: "plain_text" })),
  ...(profile === "production" ? [{ name: "ASSETS", type: "assets" }] : []),
];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-api-deploy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf03"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify(config()),
    { mode: 0o600 },
  );
  await fs.mkdir(path.join(root, "cloudflare/library"), { recursive: true });
  await fs.writeFile(
    path.join(root, "cloudflare/library/worker.mjs"),
    "export default {}",
  );
  await fs.writeFile(path.join(root, ".gitignore"), ".local/\n");
  return fs.realpath(root);
}
const env = () => ({
  SHELF_R2_ACCOUNT_ID: ACCOUNT,
  SHELF_CF_DEPLOY_TOKEN: TOKEN,
  NODE_OPTIONS: "unsafe",
  CLOUDFLARE_API_BASE_URL: "https://unsafe.invalid",
});
test("fixed profiles require separate databases and reject injected resources", () => {
  assert.deepEqual(validateDeployConfig(config()), config());
  for (const mutate of [
    (c) => (c.profiles.production.databaseId = IDS.check),
    (c) => (c.profiles.check.databaseName = "other"),
    (c) => (c.profiles.check.token = TOKEN),
    (c) => (c.extra = true),
  ]) {
    const c = config();
    mutate(c);
    assert.throws(() => validateDeployConfig(c));
  }
  const check = workerConfig(
    "check",
    config().profiles.check,
    ACCOUNT,
    "/safe",
  );
  assert.equal(check.assets, undefined);
  assert.equal(check.vars.APP_SCOPE, "check");
  const prod = workerConfig(
    "production",
    config().profiles.production,
    ACCOUNT,
    "/safe",
  );
  assert.deepEqual(prod.assets.run_worker_first, ["/api", "/api/*"]);
  assert.equal(prod.vars.SITE_ORIGIN, PROFILES.production.origin);
});
test("binding protection rejects mismatched or missing databases, buckets and unexpected bindings", () => {
  validateRemoteBindings({ bindings: bindings("check") }, "check", IDS.check, {
    accountId: ACCOUNT,
  });
  for (const extra of [
    { name: "OTHER", type: "d1", id: IDS.production },
    { name: "SECRET", type: "plain_text", text: TOKEN },
  ])
    assert.throws(() =>
      validateRemoteBindings(
        { bindings: [...bindings("check"), extra] },
        "check",
        IDS.check,
      ),
    );
  const wrong = bindings("check");
  wrong[0].id = IDS.production;
  assert.throws(() =>
    validateRemoteBindings({ bindings: wrong }, "check", IDS.check, {
      allowStatic: true,
    }),
  );
  assert.throws(() =>
    validateRemoteBindings({ bindings: [] }, "check", IDS.check),
  );
});
test("check deployment isolates CLI secrets, validates before and after without building assets", async (t) => {
  const root = await fixture(t);
  let reads = 0,
    calls = 0;
  const r = await deployApi({
    identityChecker: async () => {},
    root,
    profile: "check",
    environment: env(),
    inspector: async () => {
      reads++;
      return { bindings: bindings("check") };
    },
    runner: async (call) => {
      calls++;
      assert.equal(call.env.NODE_OPTIONS, undefined);
      assert.equal(call.env.CLOUDFLARE_API_BASE_URL, undefined);
      assert.equal(call.env.CLOUDFLARE_API_TOKEN, TOKEN);
      assert.ok(!call.args.join(" ").includes(TOKEN));
      const out = JSON.parse(
        await fs.readFile(call.args[call.args.indexOf("--config") + 1], "utf8"),
      );
      assert.equal(out.name, PROFILES.check.name);
      assert.equal(out.assets, undefined);
      assert.equal(
        await fs.readFile(
          call.args[call.args.indexOf("--env-file") + 1],
          "utf8",
        ),
        "",
      );
      assert.equal((await fs.stat(call.cwd)).mode & 0o777, 0o700);
      await fs.appendFile(call.logPath, TOKEN);
      return { code: 0 };
    },
  });
  assert.equal(reads, 2);
  assert.equal(calls, 1);
  assert.equal(r.url, PROFILES.check.origin);
  assert.ok(
    !(await fs.readFile(path.join(root, r.logPath), "utf8")).includes(TOKEN),
  );
});
test("missing secrets, unsafe configuration permissions and CI reject before deployment", async (t) => {
  const root = await fixture(t),
    runner = () => assert.fail("must not run");
  await assert.rejects(
    deployApi({
      identityChecker: async () => {},
      root,
      profile: "check",
      environment: env(),
      inspector: async () => ({ bindings: [] }),
      runner,
    }),
    (e) => e.code === "secrets",
  );
  await fs.chmod(path.join(root, ".local/cf03/deploy.json"), 0o644);
  await assert.rejects(
    deployApi({
      identityChecker: async () => {},
      root,
      profile: "check",
      environment: env(),
      runner,
    }),
    (e) => e.code === "files",
  );
  await assert.rejects(
    deployApi({
      identityChecker: async () => {},
      root,
      profile: "check",
      environment: { ...env(), CI: "true" },
      runner,
    }),
  );
});
test("remote inspection is fixed endpoint and failures reveal no response or token", async () => {
  const credentials = { accountId: ACCOUNT, token: TOKEN };
  const data = await readRemoteSettings(
    credentials,
    PROFILES.check.name,
    async (url, opts) => {
      assert.ok(
        url.startsWith("https://api.cloudflare.com/client/v4/accounts/"),
      );
      assert.equal(opts.redirect, "error");
      return Response.json({ success: true, result: { bindings: [] } });
    },
  );
  assert.deepEqual(data, { bindings: [] });
  await assert.rejects(
    readRemoteSettings(credentials, PROFILES.check.name, async () =>
      Response.json({ message: TOKEN }, { status: 403 }),
    ),
    (e) => e instanceof ApiDeployError && !e.message.includes(TOKEN),
  );
});
test("initialization is private, idempotent and never replaces existing credentials", async (t) => {
  const root = await fixture(t),
    factory = async (key, pepper, scope) => {
      assert.equal(key.length, 43);
      assert.notEqual(key, pepper);
      assert.equal(scope.scope, "check");
      return "a".repeat(64);
    };
  const first = await initialize({
    root,
    profile: "check",
    verifierFactory: factory,
    now: () => 1000,
  });
  const filename = path.join(root, first.ownerKeyPath);
  const key = await fs.readFile(filename, "utf8");
  await initialize({
    root,
    profile: "check",
    verifierFactory: factory,
    now: () => 2000,
  });
  assert.equal(await fs.readFile(filename, "utf8"), key);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  const sql = await fs.readFile(path.join(root, first.sqlPath), "utf8");
  assert.ok(!sql.includes(key.trim()));
  assert.match(sql, /INSERT INTO auth_config/);
  assert.ok(!sql.includes("REPLACE"));
  await fs.chmod(filename, 0o644);
  await assert.rejects(
    initialize({ root, profile: "check", verifierFactory: factory }),
  );
  assert.equal(await fs.readFile(filename, "utf8"), key);
});

test("first upload accepts only four known secrets and rejects partial resource drift", async (t) => {
  const root = await fixture(t),
    secrets = SECRET_NAMES.map((name) => ({ name, type: "secret_text" }));
  let reads = 0,
    deployments = 0;
  await deployApi({
    identityChecker: async () => {},
    root,
    profile: "check",
    environment: env(),
    inspector: async () => ({
      bindings: ++reads === 1 ? secrets : bindings("check"),
    }),
    runner: async () => {
      deployments++;
      return { code: 0 };
    },
  });
  assert.equal(deployments, 1);
  for (const bad of [
    [...secrets, { name: "DB", type: "d1", id: IDS.check }],
    [...secrets, { name: "unexpected", type: "secret_text" }],
    [
      ...secrets,
      { name: "SITE_ORIGIN", type: "plain_text", text: "https://evil.invalid" },
    ],
  ]) {
    await assert.rejects(
      deployApi({
        identityChecker: async () => {},
        root,
        profile: "check",
        environment: env(),
        inspector: async () => ({ bindings: bad }),
        runner: () => assert.fail("must not deploy"),
      }),
      (e) => e.code === "bindings",
    );
  }
});

test("postflight detects lost secrets or changed public policy values", async (t) => {
  const root = await fixture(t);
  let reads = 0;
  const wrong = bindings("check");
  wrong.find((b) => b.name === "SITE_ORIGIN").text = "https://evil.invalid";
  await assert.rejects(
    deployApi({
      identityChecker: async () => {},
      root,
      profile: "check",
      environment: env(),
      inspector: async () => ({
        bindings: ++reads === 1 ? bindings("check") : wrong,
      }),
      runner: async () => ({ code: 0 }),
    }),
    (e) => e.code === "bindings",
  );
});

test("generated initialization verifier uses the same cryptographic contract as the Worker", async (t) => {
  const root = await fixture(t);
  const result = await initialize({
    root,
    profile: "production",
    now: () => 1234,
  });
  const key = (
    await fs.readFile(path.join(root, result.ownerKeyPath), "utf8")
  ).trim();
  const pepper = (
    await fs.readFile(
      path.join(root, ".local/cf03/production/owner-key-pepper"),
      "utf8",
    )
  ).trim();
  const { createOwnerVerifier } =
    await import("../cloudflare/library/security.mjs");
  const expected = await createOwnerVerifier(key, pepper, {
    scope: "production",
    origin: PROFILES.production.origin,
  });
  const sql = await fs.readFile(path.join(root, result.sqlPath), "utf8");
  assert.ok(sql.includes(`'${expected}'`));
  assert.ok(sql.includes("'production'"));
});

test("local owner credentials join privacy scans and log redaction but never Wrangler environment", async (t) => {
  const root = await fixture(t);
  await initialize({ root, profile: "check" });
  const secret = (
    await fs.readFile(
      path.join(root, ".local/cf03/check/owner-access-key"),
      "utf8",
    )
  ).trim();
  const result = await deployApi({
    identityChecker: async () => {},
    root,
    profile: "check",
    environment: env(),
    inspector: async () => ({ bindings: bindings("check") }),
    runner: async (call) => {
      assert.equal(call.env.SHELF_CF_CHECK_OWNER_ACCESS_KEY, undefined);
      assert.ok(call.redactions.includes(secret));
      await fs.appendFile(call.logPath, secret);
      return { code: 0 };
    },
  });
  assert.ok(
    !(await fs.readFile(path.join(root, result.logPath), "utf8")).includes(
      secret,
    ),
  );
});

test("database identity GET must match the fixed profile name and UUID before deployment", async (t) => {
  const credentials = { accountId: ACCOUNT, token: TOKEN },
    resource = config().profiles.check;
  await verifyDatabaseIdentity(credentials, resource, {
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${IDS.check}`,
      );
      assert.equal(options.redirect, "error");
      return Response.json({
        success: true,
        result: { uuid: IDS.check, name: "the-shelf-cf03-check" },
      });
    },
  });
  for (const result of [
    { uuid: IDS.check, name: "unrelated-database" },
    { uuid: IDS.production, name: "the-shelf-cf03-check" },
  ])
    await assert.rejects(
      verifyDatabaseIdentity(credentials, resource, {
        fetchImpl: async () => Response.json({ success: true, result }),
      }),
    );
  const root = await fixture(t);
  let checks = 0;
  await assert.rejects(
    deployApi({
      root,
      profile: "check",
      environment: env(),
      identityChecker: async (_credentials, actual) => {
        checks++;
        assert.deepEqual(actual, resource);
        throw new Error("identity mismatch");
      },
      inspector: () =>
        assert.fail("must not inspect worker after identity mismatch"),
      runner: () => assert.fail("must not deploy"),
    }),
    (e) => e.code === "database_identity",
  );
  assert.equal(checks, 1);
});
