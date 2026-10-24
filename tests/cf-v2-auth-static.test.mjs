import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  AUTH_SQL,
  AUTH_PROBE_SQL,
  AUTH_V2_PROBE_SQL,
  AUTH_V2_ENABLE_SQL,
  AUTH_LIMITS,
  runProductionAuth,
} from "../scripts/cf-production-auth.mjs";
import {
  deploy,
  parseStaticDeployArguments,
  STATIC_WORKER_SOURCE,
} from "../scripts/cf-deploy.mjs";
import { readRemoteSettings } from "../scripts/cf-api-deploy.mjs";
import { createOwnerVerifier } from "../cloudflare/library/security.mjs";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";
import { storageDeploymentContract } from "../shared/storage-deployment-contract.mjs";
import {
  STORAGE_DEPLOY_GUARD_SQL,
  validateStorageDeployGuard,
} from "../scripts/storage-deploy-guard.mjs";
import { validateSingleTrialTarget } from "../scripts/single-trial-config.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCOUNT = "a".repeat(32),
  DATABASE = "22222222-2222-4222-8222-222222222222",
  VERSION = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: DATABASE,
  },
};
const targetInput = {
  schemaVersion: 1,
  mode: "first-book-20261023",
  accountId: ACCOUNT,
  bucket: "the-shelf-first-book-20261023",
  worker: "the-shelf",
  origin: ORIGIN,
  uploadSecretSha256: "b".repeat(64),
};
const target = validateSingleTrialTarget(targetInput, ACCOUNT);
const contract = (preparedText) =>
  storageDeploymentContract({
    profile: "authority-v2-closed",
    identity,
    trialTargetSha256: target.configSha256,
    filenameAi: true,
    preparedText,
    retainedSecrets: "trial-retained-filename-v1",
  });
const settings = (c) => ({
  bindings: [
    { name: "DB", type: "d1", database_id: DATABASE },
    { name: "ASSETS", type: "assets" },
    ...c.r2Bindings.map((b) => ({
      name: b.binding,
      type: "r2_bucket",
      bucket_name: b.bucket_name,
    })),
    ...Object.entries(c.vars).map(([name, text]) => ({
      name,
      type: "plain_text",
      text,
    })),
    ...c.secretNames.map((name) => ({ name, type: "secret_text" })),
  ],
});
const response = (result) =>
  Response.json({ success: true, errors: [], result });
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const v2 = {
  storageMode: "authority-v2",
  writeMode: "closed",
  filenameAi: true,
};
async function fixture(
  t,
  { profile = "activation-011", preparedText = false, enabled = 0 } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-v2-auth-static-")),
  );
  await fs.chmod(root, 0o700);
  for (const dir of [
    ".local",
    ".local/cf03",
    ".local/cf03/production",
    "cloudflare",
    "cloudflare/library",
    "dist",
    "dist/data",
    "dist/docs",
  ])
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  const write = (name, value) =>
    fs.writeFile(
      path.join(root, name),
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
  await write(
    ".env",
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=synthetic-project-token-only-1234\n`,
  );
  await write(".local/cf03/deploy.json", {
    schemaVersion: 1,
    profiles: {
      check: {
        databaseId: identity.legacyDatabases.check,
        databaseName: "the-shelf-cf03-check",
      },
      production: { databaseId: DATABASE, databaseName: "the-shelf-library" },
    },
  });
  await write(".local/cf03/production/single-trial-target.json", targetInput);
  const [owner, pepper, session] = [17, 23, 29].map((n) =>
    Buffer.alloc(32, n).toString("base64url"),
  );
  for (const [name, value] of [
    ["owner-access-key", owner],
    ["owner-key-pepper", pepper],
    ["session-secret", session],
  ])
    await write(`.local/cf03/production/${name}`, value);
  await write(
    "cloudflare/library/schema.sql",
    await fs.readFile(path.join(ROOT, "cloudflare/library/schema.sql"), "utf8"),
  );
  await fs.chmod(path.join(root, "cloudflare/library/schema.sql"), 0o644);
  await write("dist/index.html", "<p>Synthetic</p>");
  await write("dist/data/runtime.json", {
    schemaVersion: 1,
    apiMode: "disabled",
  });
  await write("dist/docs/index.json", { basePath: "/" });
  await write("wrangler.jsonc", {
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
  const db = new DatabaseSync(":memory:"),
    schema = DATABASE_SCHEMA_PROFILES[profile];
  for (const type of ["table", "index", "view"])
    for (const row of schema) if (row.type === type) db.exec(row.sql);
  const verifier = await createOwnerVerifier(owner, pepper, {
    scope: "production",
    origin: ORIGIN,
  });
  db.exec(
    "INSERT INTO public_state(scope,updated_at) VALUES('production',0),('check',0)",
  );
  db.prepare(
    "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,?,1)",
  ).run(ORIGIN, verifier, enabled);
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,'imported')",
  ).run(JSON.stringify(identity));
  const d = {
    kind: "original",
    scope: "production",
    fileId: "retained_file",
    bookId: "retained_book",
    format: "PDF",
    sizeBytes: 15,
    sha256: "d".repeat(64),
    objectKey: `books/cf03/retained_file/${"d".repeat(64)}.pdf`,
    versionHash: null,
    source: null,
  };
  db.prepare(
    "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,?,?)",
  ).run(
    "retained_permit",
    "2026-10-23-first-book",
    JSON.stringify(identity),
    JSON.stringify({ accountId: ACCOUNT, bucket: targetInput.bucket }),
    JSON.stringify(d),
    target.configSha256,
    15,
    1,
    3600000,
    "synthetic_etag",
    100,
  );
  const triggers = schema.filter((r) => r.type === "trigger");
  for (const row of triggers) db.exec(row.sql);
  const mutateFacts = (sql) => {
    for (const row of triggers) db.exec(`DROP TRIGGER ${row.name}`);
    db.exec(sql);
    for (const row of triggers) db.exec(row.sql);
  };
  const currentSettings = settings(contract(preparedText)),
    deployment = {
      deployments: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          versions: [{ version_id: VERSION, percentage: 100 }],
        },
      ],
    };
  const calls = [];
  let interceptor,
    runIndex = 0;
  async function fetcher(url, init) {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.ok(
      url.startsWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`,
      ),
    );
    if (interceptor) {
      const result = await interceptor(url, init);
      if (result !== undefined) return result;
    }
    if (url.endsWith(`/d1/database/${DATABASE}`))
      return response({ uuid: DATABASE, name: "the-shelf-library" });
    if (url.endsWith("/query")) {
      const { sql, params } = JSON.parse(init.body);
      return response([
        { success: true, results: db.prepare(sql).all(...params) },
      ]);
    }
    if (url.endsWith("/deployments?page=1&per_page=1"))
      return response(deployment);
    if (url.endsWith("/settings")) return response(currentSettings);
    if (url.endsWith("/subdomain"))
      return response({ enabled: true, previews_enabled: false });
    assert.fail("unexpected endpoint");
  }
  const expected = () => {
    const row = db
      .prepare(
        "SELECT scope,origin,scheme,generation,enabled,updated_at FROM auth_config WHERE scope='production'",
      )
      .get();
    if (!row) return {};
    return { expectedGeneration: row.generation, expectedRowSha256: hash(row) };
  };
  const run = (options) =>
    runProductionAuth({
      root,
      execute: true,
      action: "enable",
      expectedVersion: VERSION,
      ...v2,
      ...expected(),
      runId: `v2-${++runIndex}`,
      environment: {},
      fetchImpl: fetcher,
      clock: () => 10000 + runIndex,
      ...options,
    });
  const state = async () =>
    JSON.parse(
      await fs.readFile(
        path.join(root, ".local/cf03/production-auth-state.json"),
        "utf8",
      ),
    );
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    verifier,
    schema,
    contract: contract(preparedText),
    settings: currentSettings,
    deployment,
    calls,
    fetcher,
    run,
    expected,
    write,
    state,
    mutateFacts,
    intercept: (fn) => {
      interceptor = fn;
    },
  };
}

test("combined auth SQL is bounded, probe has one verifier bind and CAS has six", () => {
  assert.equal((AUTH_V2_PROBE_SQL.match(/\?/g) || []).length, 1);
  assert.equal((AUTH_V2_ENABLE_SQL.match(/\?/g) || []).length, 6);
  assert.ok(Buffer.byteLength(AUTH_V2_PROBE_SQL) <= 16384);
  assert.ok(Buffer.byteLength(AUTH_V2_ENABLE_SQL) <= 16384);
  assert.equal(AUTH_LIMITS.responseBytes, 1000000);
  assert.equal(AUTH_LIMITS.enable, 12);
  assert.equal(AUTH_LIMITS.close, 4);
});
for (const preparedText of [false, true])
  test(`v2 enable observes exact version/settings/storage with 11 HTTP, prepared=${preparedText}`, async (t) => {
    const f = await fixture(t, { preparedText });
    // A non-regular broken upload-secret path proves enable never reads it.
    await fs.symlink(
      "/nonexistent-upload-secret",
      path.join(f.root, ".local/cf03/production/single-trial-upload-secret"),
    );
    const result = await f.run({ preparedText });
    assert.equal(result.requests, 11);
    assert.equal(result.auth.row.enabled, 1);
    const queries = f.calls
      .filter((c) => c.url.endsWith("/query"))
      .map((c) => JSON.parse(c.init.body));
    assert.deepEqual(
      queries.map((c) => c.sql),
      [AUTH_V2_PROBE_SQL, AUTH_V2_ENABLE_SQL, AUTH_V2_PROBE_SQL],
    );
    assert.deepEqual(
      queries.map((c) => c.params.length),
      [1, 6, 1],
    );
    assert.ok(
      queries.every((c) => Buffer.byteLength(JSON.stringify(c)) <= 1000000),
    );
    assert.equal(
      f.calls.filter((c) => c.url.endsWith("/deployments?page=1&per_page=1"))
        .length,
      3,
    );
    const files = await fs.readdir(
      path.join(f.root, ".local/cf03/production-auth"),
    );
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(
          f.root,
          ".local/cf03/production-auth",
          files.find((n) => n.endsWith(".json")),
        ),
        "utf8",
      ),
    );
    assert.match(receipt.storage.storageSnapshotSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(receipt).includes("retained_permit"), false);
    assert.equal((await f.state()).unresolved.length, 0);
  });
for (const profile of Object.keys(DATABASE_SCHEMA_PROFILES))
  test(`real SQLite combined probe supports complete ${profile}`, async (t) => {
    const f = await fixture(t, { profile }),
      projected = f.db.prepare(AUTH_V2_PROBE_SQL).get(f.verifier);
    const responseBytes = Buffer.byteLength(
        JSON.stringify({
          success: true,
          errors: [],
          result: [{ success: true, results: [projected] }],
        }),
      ),
      casRequestBytes = Buffer.byteLength(
        JSON.stringify({
          sql: AUTH_V2_ENABLE_SQL,
          params: [
            10000,
            ORIGIN,
            f.verifier,
            1,
            1,
            projected.storage_guard_json,
          ],
        }),
      );
    assert.ok(responseBytes < 1000000);
    assert.ok(casRequestBytes < 1000000);
    t.diagnostic(JSON.stringify({ profile, responseBytes, casRequestBytes }));
    const validated = validateStorageDeployGuard(
      JSON.parse(projected.storage_guard_json),
      f.contract,
    );
    assert.equal(validated.databaseSchemaProfile, profile);
    assert.equal(JSON.parse(projected.auth_json)[0].verifier_match, 1);
  });
test("full storage digest includes phase while all previous summary fields remain equal", async (t) => {
  const f = await fixture(t),
    before = validateStorageDeployGuard(
      f.db.prepare(STORAGE_DEPLOY_GUARD_SQL).get(),
      f.contract,
    );
  f.mutateFacts("UPDATE shelf_storage_authority SET phase='ready'");
  const after = validateStorageDeployGuard(
    f.db.prepare(STORAGE_DEPLOY_GUARD_SQL).get(),
    f.contract,
  );
  for (const key of [
    "databaseSchemaProfile",
    "databaseSchemaSha256",
    "authorityIdentitySha256",
    "retainedSourceSha256",
  ])
    assert.equal(before[key], after[key]);
  assert.notEqual(before.storageSnapshotSha256, after.storageSnapshotSha256);
});
for (const [label, sql] of [
  ["phase", "UPDATE shelf_storage_authority SET phase='ready'"],
  ["retained record", "UPDATE shelf_storage_single_trial SET updated_at=101"],
  ["schema", "CREATE TABLE unexpected_object(x)"],
])
  test(`same-statement auth CAS rejects ${label} drift during Worker await`, async (t) => {
    const f = await fixture(t);
    let deployments = 0;
    f.intercept((url) => {
      if (url.endsWith("/deployments?page=1&per_page=1") && ++deployments === 2)
        f.mutateFacts(sql);
    });
    await assert.rejects(
      f.run(),
      (e) => e.code === "production_auth_cas_conflict",
    );
    assert.equal(
      f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
      0,
    );
    assert.equal(
      f.calls.filter(
        (c) =>
          c.url.endsWith("/query") &&
          JSON.parse(c.init.body).sql === AUTH_V2_ENABLE_SQL,
      ).length,
      1,
    );
  });
test("phase drift after CAS fails final complete probe, retains unknown, and close still works", async (t) => {
  const f = await fixture(t);
  let probes = 0;
  f.intercept((url, init) => {
    if (
      url.endsWith("/query") &&
      JSON.parse(init.body).sql === AUTH_V2_PROBE_SQL &&
      ++probes === 2
    )
      f.mutateFacts("UPDATE shelf_storage_authority SET phase='ready'");
  });
  await assert.rejects(
    f.run(),
    (e) => e.code === "production_auth_worker_precondition_failed",
  );
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
    1,
  );
  assert.equal((await f.state()).unresolved.length, 1);
  await f.write(
    ".local/cf03/production/single-trial-target.json",
    "broken target",
  );
  f.intercept((url) => {
    assert.equal(url.includes("/workers/"), false);
  });
  const result = await f.run({
    action: "close",
    storageMode: "broken",
    writeMode: { bad: true },
    filenameAi: "bad",
    preparedText: "bad",
    singleTrial: "bad",
  });
  assert.equal(result.requests, 4);
  assert.equal(result.auth.row.enabled, 0);
  assert.equal(result.auth.row.generation, 2);
  assert.equal(result.unresolvedMutations, 1);
});
for (const action of ["status", "initialize-disabled", "close"])
  test(`${action} ignores broken storage options/files and only performs auth operations`, async (t) => {
    const f = await fixture(t, { enabled: 1 });
    if (action === "initialize-disabled")
      f.db.prepare("DELETE FROM auth_config").run();
    await fs.unlink(
      path.join(f.root, ".local/cf03/production/single-trial-target.json"),
    );
    await fs.symlink(
      "/missing-target",
      path.join(f.root, ".local/cf03/production/single-trial-target.json"),
    );
    await fs.symlink(
      "/missing-secret",
      path.join(f.root, ".local/cf03/production/single-trial-upload-secret"),
    );
    f.db.exec("DROP TABLE shelf_storage_single_trial");
    f.intercept((url, init) => {
      assert.equal(url.includes("/workers/"), false);
      if (init.body)
        assert.equal(
          JSON.parse(init.body).sql.includes("storage_guard"),
          false,
        );
    });
    const result = await f.run({
      action,
      storageMode: "unknown",
      writeMode: "open",
      filenameAi: 7,
      preparedText: null,
      singleTrial: true,
    });
    assert.equal(result.requests, action === "status" ? 2 : 4);
  });
test("v2 enable rejects wrong prepared/settings profile before CAS", async (t) => {
  const f = await fixture(t, { preparedText: true });
  await assert.rejects(
    f.run(),
    (e) => e.code === "production_auth_worker_precondition_failed",
  );
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
    0,
  );
});
for (const drift of ["settings", "version"])
  test(`v2 enable retains full ${drift} comparison after CAS`, async (t) => {
    const f = await fixture(t);
    let reads = 0;
    f.intercept((url) => {
      if (
        url.endsWith(
          drift === "settings" ? "/settings" : "/deployments?page=1&per_page=1",
        ) &&
        ++reads === (drift === "settings" ? 2 : 3)
      ) {
        if (drift === "settings") f.settings.placement = {};
        else f.deployment.deployments[0].versions[0].percentage = 50;
      }
    });
    await assert.rejects(
      f.run(),
      (e) => e.code === "production_auth_worker_precondition_failed",
    );
    assert.equal((await f.state()).unresolved.length, 1);
  });
test("auth response remains limited to 1,000,000 bytes and late fetch is bounded", async (t) => {
  for (const kind of ["large", "never"]) {
    const f = await fixture(t);
    f.intercept(() =>
      kind === "large"
        ? new Response(new Uint8Array(1000001))
        : new Promise(() => {}),
    );
    await assert.rejects(
      f.run({ timeoutMs: 10 }),
      (e) =>
        e.code ===
        `production_auth_${kind === "large" ? "response_limit" : "deadline"}`,
    );
    assert.equal(f.calls.length, 1);
  }
});

const staticAfter = (f) => ({
  bindings: f.settings.bindings.filter((b) =>
    ["assets", "secret_text"].includes(b.type),
  ),
});
async function staticRun(f, changes = {}) {
  const observations = [],
    children = [];
  let reads = 0;
  const result = await deploy({
    root: f.root,
    environment: {},
    staticRollback: true,
    ...v2,
    inspector: async () => {
      observations.push(++reads);
      return reads === 1 ? f.settings : staticAfter(f);
    },
    runner: async (call) => {
      children.push(call);
      if (call.args.includes("deploy")) {
        const config = JSON.parse(
          await fs.readFile(
            call.args[call.args.indexOf("--config") + 1],
            "utf8",
          ),
        );
        assert.equal(config.assets.binding, "ASSETS");
        assert.equal(
          await fs.readFile(config.main, "utf8"),
          STATIC_WORKER_SOURCE,
        );
        for (const key of ["vars", "d1_databases", "r2_buckets"])
          assert.equal(Object.hasOwn(config, key), false);
      }
      return { code: 0 };
    },
    ...changes,
  });
  return { result, observations, children };
}
for (const preparedText of [false, true])
  test(`explicit v2 static rollback validates same prepared profile and only assets/four secrets, prepared=${preparedText}`, async (t) => {
    const f = await fixture(t, { preparedText });
    const { result, observations, children } = await staticRun(f, {
      preparedText,
    });
    assert.equal(observations.length, 2);
    assert.equal(result.explicitControlHttp, 2);
    assert.equal(result.outcome, "settings_verified");
    assert.equal(result.codeVersionVerified, false);
    assert.equal(children.filter((c) => c.args.includes("deploy")).length, 1);
    assert.deepEqual(
      staticAfter(f)
        .bindings.filter((b) => b.type === "secret_text")
        .map((b) => b.name),
      [
        "OWNER_KEY_PEPPER",
        "SESSION_SECRET",
        "SINGLE_TRIAL_UPLOAD_SECRET",
        "FILENAME_AI_KEY",
      ],
    );
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(f.root, path.dirname(result.logPath), "receipt.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.maxTotalExplicitControlHttp, 2);
    assert.equal(receipt.wranglerInternalHttp, "not_counted");
  });
for (const [label, mutate, flags] of [
  ["omitted prepared", () => {}, {}],
  [
    "extra unknown",
    (f) => f.settings.bindings.push({ name: "unknown", type: "secret_text" }),
    { preparedText: true },
  ],
  [
    "partial prepared",
    (f) =>
      (f.settings.bindings = f.settings.bindings.filter(
        (b) => b.name !== "PREPARED_BOOKS",
      )),
    { preparedText: true },
  ],
  [
    "static predecessor",
    (f) => (f.settings = staticAfter(f)),
    { preparedText: true },
  ],
])
  test(`v2 static rollback rejects ${label} before Wrangler`, async (t) => {
    const f = await fixture(t, { preparedText: true });
    mutate(f);
    let calls = 0;
    await assert.rejects(
      staticRun(f, {
        ...flags,
        runner: () => {
          calls++;
          assert.fail("must reject before child");
        },
      }),
    );
    assert.equal(calls, 0);
  });
for (const kind of [
  "wrong postflight",
  "postflight timeout",
  "Wrangler unknown",
])
  test(`static ${kind} preserves intent without a second deploy`, async (t) => {
    const f = await fixture(t);
    let reads = 0,
      deploys = 0,
      failure;
    await assert.rejects(
      staticRun(f, {
        inspector: async () => {
          if (++reads === 1) return f.settings;
          if (kind === "postflight timeout")
            return readRemoteSettings(
              { accountId: ACCOUNT, token: "synthetic-token" },
              "the-shelf",
              () => new Promise(() => {}),
              { timeoutMs: 10 },
            );
          return f.settings;
        },
        runner: async (call) => {
          if (call.args.includes("deploy")) {
            deploys++;
            if (kind === "Wrangler unknown")
              throw new Error("synthetic unknown");
          }
          return { code: 0 };
        },
      }),
      (e) => {
        failure = e;
        return true;
      },
    );
    assert.equal(deploys, 1);
    assert.equal(reads, kind === "Wrangler unknown" ? 1 : 2);
    const directory = path.join(f.root, path.dirname(failure.logPath));
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(directory, "deployment-attempt.json"),
          "utf8",
        ),
      ).outcome,
      "dispatch_not_proven",
    );
    await assert.rejects(
      fs.stat(path.join(directory, "receipt.json")),
      (e) => e.code === "ENOENT",
    );
  });
test("static v2 CLI requires complete explicit mode pair and retains duplicate/unknown rejection", () => {
  const args = [
    "--static-rollback",
    "--storage-mode",
    "authority-v2",
    "--write-mode",
    "closed",
    "--filename-ai",
  ];
  assert.deepEqual(parseStaticDeployArguments(args), {
    staticRollback: true,
    singleTrial: false,
    filenameAi: true,
    preparedText: false,
    storageMode: "authority-v2",
    writeMode: "closed",
  });
  for (const invalid of [
    args.slice(0, -1),
    [...args, "--single-trial"],
    [...args, "--storage-mode", "authority-v2"],
    [...args, "--unknown"],
    args.map((v) => (v === "closed" ? "open" : v)),
  ])
    assert.throws(() => parseStaticDeployArguments(invalid));
});

test("static rollback uses exactly two real bounded settings adapters and no D1 endpoint", async (t) => {
  const f = await fixture(t),
    urls = [];
  const result = await staticRun(f, {
    inspector: (credentials, name) =>
      readRemoteSettings(credentials, name, async (url, init) => {
        urls.push(url);
        assert.ok(url.endsWith("/workers/scripts/the-shelf/settings"));
        assert.equal(init.redirect, "error");
        return response(urls.length === 1 ? f.settings : staticAfter(f));
      }),
  });
  assert.equal(urls.length, 2);
  assert.equal(result.result.explicitControlHttp, 2);
});
test("broken storage cannot bypass required owner verification during close", async (t) => {
  const f = await fixture(t, { enabled: 1 });
  await f.write(
    ".local/cf03/production/single-trial-target.json",
    "invalid storage",
  );
  await f.write(".local/cf03/production/owner-access-key", "invalid owner");
  await assert.rejects(
    f.run({ action: "close", storageMode: "invalid", singleTrial: true }),
    (e) => e.code === "production_auth_configuration_invalid",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
    1,
  );
});
test("storage snapshot digest uses fixed field order rather than input object order", async (t) => {
  const f = await fixture(t),
    row = f.db.prepare(STORAGE_DEPLOY_GUARD_SQL).get();
  const reordered = Object.fromEntries(Object.entries(row).reverse());
  assert.equal(
    validateStorageDeployGuard(row, f.contract).storageSnapshotSha256,
    validateStorageDeployGuard(reordered, f.contract).storageSnapshotSha256,
  );
});
