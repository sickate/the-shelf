import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  deployApi,
  workerConfig,
  validateRemoteBindings,
  parseApiDeployArguments,
  verifyDatabaseIdentity,
  readRemoteSettings,
} from "../scripts/cf-api-deploy.mjs";
import { deploy, parseStaticDeployArguments } from "../scripts/cf-deploy.mjs";
import {
  runProductionAuth,
  AUTH_ISOLATED_ENABLE_SQL,
  AUTH_ISOLATED_PROBE_SQL,
} from "../scripts/cf-production-auth.mjs";
import {
  verifyIsolatedDeployment,
  ISOLATED_DEPLOY_SQL,
} from "../scripts/isolated-upload.mjs";
import {
  isolatedFixture,
  identity,
  ACCOUNT,
  VERSION,
  sha,
} from "./helpers/isolated-operator-fixture.mjs";
const isolated = {
  profile: "production",
  singleTrial: true,
  filenameAi: true,
  isolatedUploads: true,
};
const bindingOptions = (f) => ({
  accountId: ACCOUNT,
  singleTrialTarget: f.target,
  filenameAi: true,
  isolatedUploadConsentSha256: f.consent.sha256,
});
async function apiRun(f, overrides = {}) {
  const children = [];
  const options = {
    ...isolated,
    root: f.root,
    environment: {},
    identityChecker: (c, r) =>
      verifyDatabaseIdentity(c, r, { fetchImpl: f.fetchImpl }),
    inspector: (c, n) => readRemoteSettings(c, n, f.fetchImpl),
    isolatedChecker: (c, r, i, consent) =>
      verifyIsolatedDeployment(c, r, i, consent, { fetchImpl: f.fetchImpl }),
    runner: async (call) => {
      children.push(call);
      return { code: 0 };
    },
    ...overrides,
  };
  return { children, execute: () => deployApi(options) };
}
test("explicit CLI profile rejects v2/prepared/check/incomplete combinations and duplicates", () => {
  assert.equal(
    parseApiDeployArguments([
      "--profile",
      "production",
      "--single-trial",
      "--filename-ai",
      "--isolated-uploads",
    ]).isolatedUploads,
    true,
  );
  assert.equal(
    parseStaticDeployArguments([
      "--static-rollback",
      "--single-trial",
      "--filename-ai",
      "--isolated-uploads",
    ]).isolatedUploads,
    true,
  );
  for (const extra of [
    ["--prepared-text"],
    ["--prepared-text-rollback"],
    ["--storage-mode", "authority-v2", "--write-mode", "closed"],
    ["--isolated-uploads"],
  ])
    assert.throws(() =>
      parseApiDeployArguments([
        "--profile",
        "production",
        "--single-trial",
        "--filename-ai",
        "--isolated-uploads",
        ...extra,
      ]),
    );
  for (const args of [
    ["--profile", "production", "--isolated-uploads"],
    [
      "--profile",
      "check",
      "--single-trial",
      "--filename-ai",
      "--isolated-uploads",
    ],
  ])
    assert.throws(() => parseApiDeployArguments(args));
});
test("binding/profile guard requires both exact isolated markers; only explicit transition accepts both absent", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  const opts = bindingOptions(f);
  validateRemoteBindings(
    f.settings,
    "production",
    identity.legacyDatabases.production,
    opts,
  );
  const absent = {
    bindings: f.settings.bindings.filter(
      (b) => !b.name.startsWith("ISOLATED_UPLOAD_"),
    ),
  };
  assert.throws(() =>
    validateRemoteBindings(
      absent,
      "production",
      identity.legacyDatabases.production,
      opts,
    ),
  );
  validateRemoteBindings(
    absent,
    "production",
    identity.legacyDatabases.production,
    { ...opts, allowIsolatedUploadTransition: true },
  );
  for (const change of [
    (b) => (b.name === "ISOLATED_UPLOAD_MODE" ? { ...b, text: "bad" } : b),
    (b) => (b.name === "ISOLATED_UPLOAD_CONSENT_SHA256" ? null : b),
    (b) => (b.name === "BOOKS" ? { ...b, bucket_name: "the-shelf-books" } : b),
  ])
    assert.throws(() =>
      validateRemoteBindings(
        { bindings: f.settings.bindings.map(change).filter(Boolean) },
        "production",
        identity.legacyDatabases.production,
        { ...opts, allowIsolatedUploadTransition: true },
      ),
    );
  assert.throws(() =>
    validateRemoteBindings(
      f.settings,
      "production",
      identity.legacyDatabases.production,
      { ...opts, isolatedUploadConsentSha256: undefined },
    ),
  );
  assert.throws(() =>
    workerConfig(
      "production",
      f.resources.profiles.production,
      ACCOUNT,
      f.root,
      { ...opts, preparedText: true },
    ),
  );
});
test("deployment uses exact isolated bindings, retains secrets and independently checks schema/policy twice in five HTTP", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  const active = f.settings;
  f.beforeSettings = () => {
    f.settings =
      f.calls.filter((c) => c.url.endsWith("/settings")).length === 1
        ? {
            bindings: active.bindings.filter(
              (b) => !b.name.startsWith("ISOLATED_UPLOAD_"),
            ),
          }
        : active;
  };
  const r = await apiRun(f);
  assert.equal((await r.execute()).ok, true);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls.filter((c) => c.sql === ISOLATED_DEPLOY_SQL).length, 2);
  const deployCall = r.children.find((c) => c.args.includes("deploy"));
  assert.ok(deployCall);
  const config = JSON.parse(
    await fs.readFile(
      deployCall.args[deployCall.args.indexOf("--config") + 1],
      "utf8",
    ),
  );
  assert.equal(config.vars.ISOLATED_UPLOAD_CONSENT_SHA256, f.consent.sha256);
  assert.equal(config.vars.ISOLATED_UPLOAD_MODE, "project-v1");
  assert.equal(config.vars.SINGLE_TRIAL_TARGET_SHA256, f.target.configSha256);
  assert.deepEqual(config.r2_buckets, [
    { binding: "BOOKS", bucket_name: f.target.bucket },
  ]);
  assert.equal(
    r.children.some((c) => c.args.includes("secret")),
    false,
  );
  assert.equal(
    f.calls.some((c) => /r2|secrets/.test(c.url)),
    false,
  );
});
test("deployment refuses accounting/schema/consent drift before commands and wrong postflight after one deploy", async (t) => {
  for (const damage of [
    (f) => f.db.exec("CREATE TABLE alien(x)"),
    (f) => f.db.exec("UPDATE shelf_storage_authority SET reserved_bytes=73"),
    (f) =>
      (f.settings.bindings.find(
        (b) => b.name === "ISOLATED_UPLOAD_CONSENT_SHA256",
      ).text = "d".repeat(64)),
  ]) {
    const f = await isolatedFixture(t, { installed: true, seeded: true });
    damage(f);
    const r = await apiRun(f);
    await assert.rejects(r.execute());
    assert.equal(r.children.length, 0);
  }
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  f.beforeSettings = () => {
    if (f.calls.filter((c) => c.url.endsWith("/settings")).length === 2)
      f.settings.bindings.find((b) => b.name === "ISOLATED_UPLOAD_MODE").text =
        "bad";
  };
  const r = await apiRun(f);
  await assert.rejects(r.execute());
  assert.equal(r.children.filter((c) => c.args.includes("deploy")).length, 1);
});
async function authOptions(f) {
  const row = f.db
    .prepare(
      "SELECT scope,origin,scheme,generation,enabled,updated_at FROM auth_config WHERE scope='production'",
    )
    .get();
  return {
    ...isolated,
    execute: true,
    action: "enable",
    runId: "auth-enable",
    expectedGeneration: 1,
    expectedRowSha256: sha(row),
    expectedVersion: VERSION,
    root: f.root,
    environment: {},
    fetchImpl: f.fetchImpl,
    clock: () => Date.now(),
  };
}
for (const profile of ["trial-009", "trial-009-cf-metadata-v1"])
  test(`auth enable observes exact profile and guards same-statement CAS in 11HTTP: ${profile}`, async (t) => {
    const f = await isolatedFixture(t, {
      installed: true,
      seeded: true,
      profile,
    });
    const result = await runProductionAuth(await authOptions(f));
    assert.equal(result.ok, true);
    assert.equal(f.calls.length, 11);
    assert.equal(
      f.calls.filter((c) => c.sql === AUTH_ISOLATED_PROBE_SQL).length,
      2,
    );
    assert.equal(
      f.calls.filter((c) => c.sql === AUTH_ISOLATED_ENABLE_SQL).length,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
      1,
    );
  });
test("auth enable CAS rejects schema drift during Worker await, while auth close ignores broken isolated profile", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  f.beforeSettings = () => f.db.exec("CREATE TABLE IF NOT EXISTS alien(x)");
  await assert.rejects(runProductionAuth(await authOptions(f)));
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
    0,
  );
  const row = f.db
    .prepare(
      "SELECT scope,origin,scheme,generation,enabled,updated_at FROM auth_config WHERE scope='production'",
    )
    .get();
  const result = await runProductionAuth({
    execute: true,
    action: "close",
    runId: "auth-close",
    expectedGeneration: 1,
    expectedRowSha256: sha(row),
    root: f.root,
    environment: {},
    fetchImpl: f.fetchImpl,
    isolatedUploads: true,
    singleTrial: true,
    filenameAi: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.requests, 4);
});
test("explicit static rollback validates exact isolated active profile with two settings GET and no D1", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  await f.write("dist/data/runtime.json", {
    schemaVersion: 1,
    apiMode: "disabled",
  });
  const active = f.settings;
  let post = false,
    commands = 0;
  const result = await deploy({
    ...isolated,
    staticRollback: true,
    root: f.root,
    environment: {},
    inspector: (c, n) => {
      f.settings = post
        ? {
            bindings: active.bindings.filter(
              (b) => b.type === "secret_text" || b.type === "assets",
            ),
          }
        : active;
      return readRemoteSettings(c, n, f.fetchImpl);
    },
    runner: async (call) => {
      commands++;
      if (call.args.includes("deploy")) post = true;
      return { code: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.ok(commands > 0);
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls.every((c) => c.url.endsWith("/settings")),
    true,
  );
});
