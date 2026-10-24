import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  storageDeploymentContract,
  validateRemoteStorageBindings,
} from "../shared/storage-deployment-contract.mjs";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";
import { validateSingleTrialTarget } from "../scripts/single-trial-config.mjs";
import {
  verifyStorageDeployGuard,
  STORAGE_DEPLOY_GUARD_SQL,
} from "../scripts/storage-deploy-guard.mjs";
import {
  deployApi,
  workerConfig,
  validateV2DeploymentTransition,
  parseApiDeployArguments,
  verifyDatabaseIdentity,
  readRemoteSettings,
} from "../scripts/cf-api-deploy.mjs";
const accountId = "a".repeat(32);
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
const targetInput = {
  schemaVersion: 1,
  mode: "first-book-20261023",
  accountId,
  bucket: "the-shelf-first-book-20261023",
  worker: "the-shelf",
  origin: "https://the-shelf.iamzhutuo.workers.dev",
  uploadSecretSha256: "d".repeat(64),
};
const target = validateSingleTrialTarget(targetInput, accountId);
const make = (profile = "authority-v2-closed", preparedText = false) =>
  storageDeploymentContract({
    profile,
    identity,
    trialTargetSha256: target.configSha256,
    filenameAi: true,
    preparedText,
    retainedSecrets: "trial-retained-filename-v1",
  });
const settings = (c) => ({
  bindings: [
    { name: "DB", type: "d1", database_id: c.d1Bindings[0].database_id },
    ...c.r2Bindings.map((b) => ({
      name: b.binding,
      type: "r2_bucket",
      bucket_name: b.bucket_name,
    })),
    { name: "ASSETS", type: "assets" },
    ...c.secretNames.map((name) => ({ name, type: "secret_text" })),
    ...Object.entries(c.vars).map(([name, text]) => ({
      name,
      type: "plain_text",
      text,
    })),
  ],
});
const args = {
  profile: "production",
  storageMode: "authority-v2",
  writeMode: "closed",
  filenameAi: true,
  environment: {
    SHELF_R2_ACCOUNT_ID: accountId,
    SHELF_CF_DEPLOY_TOKEN: "synthetic-project-only-token",
  },
};
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-v2-deploy-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of [
    ".local",
    ".local/cf03",
    ".local/cf03/production",
    "cloudflare",
    "cloudflare/library",
    "dist",
    "dist/data",
    "dist/docs",
  ])
    await fs.mkdir(path.join(root, name), { mode: 0o700 });
  for (const [name, value] of Object.entries({
    ".local/cf03/deploy.json": {
      schemaVersion: 1,
      profiles: {
        check: {
          databaseId: identity.legacyDatabases.check,
          databaseName: "the-shelf-cf03-check",
        },
        production: {
          databaseId: identity.legacyDatabases.production,
          databaseName: "the-shelf-library",
        },
      },
    },
    ".local/cf03/production/single-trial-target.json": targetInput,
    "dist/data/runtime.json": { schemaVersion: 1, apiMode: "same-origin" },
    "dist/docs/index.json": { basePath: "/" },
  }))
    await fs.writeFile(path.join(root, name), JSON.stringify(value), {
      mode: 0o600,
    });
  await fs.writeFile(
    path.join(root, "cloudflare/library/worker.mjs"),
    "export default {};",
  );
  await fs.writeFile(path.join(root, "dist/index.html"), "<p>Synthetic</p>");
  return root;
}
function projection(prepared = false) {
  const d = {
    kind: "original",
    scope: "production",
    fileId: "retained_file",
    bookId: "retained_book",
    format: "PDF",
    sizeBytes: 15,
    sha256: "e".repeat(64),
    objectKey: `books/cf03/retained_file/${"e".repeat(64)}.pdf`,
    versionHash: null,
    source: null,
  };
  return {
    schema_json: JSON.stringify(
      DATABASE_SCHEMA_PROFILES[prepared ? "trial-010" : "trial-009"],
    ),
    authority_json: JSON.stringify([
      { id: 1, identity_json: JSON.stringify(identity), phase: "imported" },
    ]),
    trial_json: JSON.stringify([
      {
        id: 1,
        permit_id: "retained_permit",
        consent_id: "2026-10-23-first-book",
        authority_identity_json: JSON.stringify(identity),
        target_json: JSON.stringify({ accountId, bucket: target.bucket }),
        descriptor_json: JSON.stringify(d),
        isolated_target_config_sha256: target.configSha256,
        size_bytes: 15,
        issued_at: 1,
        expires_at: 3600000,
        state: "confirmed",
        put_attempted: 1,
        content_verified: 1,
        etag: "synthetic_etag",
        updated_at: 100,
      },
    ]),
    normal_collision_count: 0,
    overflow: 0,
  };
}
async function run(t, before, after, changes = {}) {
  const root = await fixture(t),
    calls = [],
    child = [];
  const fetcher = async (url, init) => {
    calls.push([url, init.method || "GET"]);
    if (url.endsWith("/settings"))
      return Response.json({
        success: true,
        result:
          calls.filter((c) => c[0].endsWith("/settings")).length === 1
            ? before
            : after,
      });
    if (url.endsWith("/query")) {
      assert.deepEqual(JSON.parse(init.body), {
        sql: STORAGE_DEPLOY_GUARD_SQL,
        params: [],
      });
      return Response.json({
        success: true,
        result: [
          {
            success: true,
            results: [
              projection(changes.preparedText || changes.preparedTextRollback),
            ],
          },
        ],
      });
    }
    return Response.json({
      success: true,
      result: {
        uuid: identity.legacyDatabases.production,
        name: "the-shelf-library",
      },
    });
  };
  const options = {
    ...args,
    root,
    identityChecker: (c, r) =>
      verifyDatabaseIdentity(c, r, { fetchImpl: fetcher }),
    inspector: (c, n) => readRemoteSettings(c, n, fetcher),
    storageChecker: (c, r, contract) =>
      verifyStorageDeployGuard(c, r, contract, { fetcher }),
    preparedChecker: () => assert.fail("v2 must share its one guard"),
    runner: async (call) => {
      child.push(call);
      if (call.args.includes("deploy")) {
        const config = JSON.parse(
          await fs.readFile(
            call.args[call.args.indexOf("--config") + 1],
            "utf8",
          ),
        );
        assert.deepEqual(
          config.vars,
          make("authority-v2-closed", changes.preparedText || false).vars,
        );
        assert.equal(config.vars.SINGLE_TRIAL_MODE, undefined);
        assert.deepEqual(
          config.r2_buckets,
          make("authority-v2-closed", changes.preparedText || false).r2Bindings,
        );
        assert.equal(
          Object.keys(call.env).some(
            (k) =>
              k === "FILENAME_AI_KEY" || k === "SINGLE_TRIAL_UPLOAD_SECRET",
          ),
          false,
        );
      }
      return { code: 0 };
    },
    ...changes,
  };
  return { root, calls, child, options, execute: () => deployApi(options) };
}

for (const [from, preparedFrom, preparedTo, rollback, accepts] of [
  ["trial-v1", false, false, false, true],
  ["trial-v1", true, true, false, true],
  ["trial-v1", false, true, false, false],
  ["trial-v1", true, false, true, false],
  ["authority-v2-closed", false, false, false, true],
  ["authority-v2-closed", true, true, false, true],
  ["authority-v2-closed", false, true, false, true],
  ["authority-v2-closed", true, false, true, true],
  ["authority-v2-closed", true, false, false, false],
  ["authority-v2-closed", false, false, true, false],
])
  test(`precise transition ${from}/${preparedFrom} → v2/${preparedTo}, rollback=${rollback}: ${accepts}`, () => {
    const operation = () =>
      validateV2DeploymentTransition(
        settings(make(from, preparedFrom)),
        make("authority-v2-closed", preparedTo),
        { preparedTextRollback: rollback },
      );
    if (accepts) operation();
    else assert.throws(operation, (e) => e.code === "bindings");
  });
test("v2 generated config contains dual sources/closed gate and exact four retained secrets", () => {
  const c = make("authority-v2-closed", true),
    result = workerConfig(
      "production",
      { databaseId: identity.legacyDatabases.production },
      accountId,
      "/synthetic",
      { storageContract: c, filenameAi: true, preparedText: true },
    );
  assert.deepEqual(result.vars, c.vars);
  assert.deepEqual(result.d1_databases, c.d1Bindings);
  assert.deepEqual(result.r2_buckets, c.r2Bindings);
  assert.deepEqual(c.secretNames, [
    "OWNER_KEY_PEPPER",
    "SESSION_SECRET",
    "SINGLE_TRIAL_UPLOAD_SECRET",
    "FILENAME_AI_KEY",
  ]);
  for (const key of [
    "SINGLE_TRIAL_MODE",
    "SINGLE_TRIAL_TARGET_SHA256",
    "NORMAL_UPLOAD_MODE",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ])
    assert.equal(Object.hasOwn(result.vars, key), false);
});
for (const preparedText of [false, true])
  test(`real adapters preserve four explicit HTTP and no upload secret requirement, prepared=${preparedText}`, async (t) => {
    const f = await run(
      t,
      settings(make("trial-v1", preparedText)),
      settings(make("authority-v2-closed", preparedText)),
      { preparedText },
    );
    const result = await f.execute();
    assert.equal(result.explicitControlHttp, 4);
    assert.equal(result.outcome, "settings_verified");
    assert.equal(result.codeVersionVerified, false);
    assert.equal(f.calls.length, 4);
    assert.deepEqual(
      f.calls.map((c) => c[1]),
      ["GET", "GET", "POST", "GET"],
    );
    assert.equal(f.child.filter((c) => c.args.includes("deploy")).length, 1);
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(f.root, path.dirname(result.logPath), "receipt.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.outcome, "settings_verified");
    assert.equal(receipt.explicitControlHttp, 4);
    assert.equal(receipt.wranglerInternalHttp, "not_counted");
    assert.match(receipt.beforeSettingsSha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.afterSettingsSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.bucket, "the-shelf-books");
    assert.match(
      receipt.storageObservation.retainedSourceSha256,
      /^[a-f0-9]{64}$/,
    );
  });
test("prepared enable and rollback both use one v2 guard", async (t) => {
  for (const [before, after, changes] of [
    [false, true, { preparedText: true }],
    [true, false, { preparedTextRollback: true }],
  ]) {
    const f = await run(
      t,
      settings(make("authority-v2-closed", before)),
      settings(make("authority-v2-closed", after)),
      changes,
    );
    await f.execute();
    assert.equal(f.calls.length, 4);
    assert.equal(f.calls.filter((c) => c[0].endsWith("/query")).length, 1);
  }
});
for (const [label, mutate] of [
  [
    "old mode mixed",
    (s) =>
      s.bindings.push({
        name: "SINGLE_TRIAL_MODE",
        type: "plain_text",
        text: "first-book-20261023",
      }),
  ],
  [
    "missing filename mode",
    (s) =>
      (s.bindings = s.bindings.filter((b) => b.name !== "FILENAME_AI_MODE")),
  ],
  [
    "partial prepared",
    (s) =>
      s.bindings.push({
        name: "PREPARED_TEXT_MODE",
        type: "plain_text",
        text: "registry-v1",
      }),
  ],
  [
    "wrong bucket",
    (s) =>
      (s.bindings.find((b) => b.name === "BOOKS").bucket_name = target.bucket),
  ],
  [
    "missing secret",
    (s) =>
      (s.bindings = s.bindings.filter((b) => b.name !== "FILENAME_AI_KEY")),
  ],
  [
    "retained S3 secret",
    (s) => s.bindings.push({ name: "R2_ACCESS_KEY_ID", type: "secret_text" }),
  ],
  ["extra binding key", (s) => (s.bindings[0].unexpected = 1)],
])
  test(`invalid v2 predecessor ${label} blocks guard and Wrangler`, async (t) => {
    const before = settings(make());
    mutate(before);
    const f = await run(t, before, settings(make()));
    await assert.rejects(f.execute(), (e) => e.code === "bindings");
    assert.equal(f.calls.length, 2);
    assert.equal(f.child.length, 0);
  });
test("missing schema and wrong retained target fail before all child processes", async (t) => {
  for (const key of ["schema_json", "trial_json"]) {
    const f = await run(t, settings(make()), settings(make()), {
      storageChecker: (c, r, contract) =>
        verifyStorageDeployGuard(c, r, contract, {
          fetcher: async () => {
            const p = projection();
            p[key] = "[]";
            return Response.json({
              success: true,
              result: [{ success: true, results: [p] }],
            });
          },
        }),
    });
    await assert.rejects(f.execute(), (e) => e.code === "storage_guard");
    assert.equal(f.child.length, 0);
  }
});
test("strict postflight rejects leftover trial state and records attempted deployment", async (t) => {
  const f = await run(
    t,
    settings(make("trial-v1")),
    settings(make("trial-v1")),
  );
  let failure;
  await assert.rejects(f.execute(), (e) => {
    failure = e;
    return e.code === "postflight";
  });
  assert.equal(f.calls.length, 4);
  assert.equal(f.child.filter((c) => c.args.includes("deploy")).length, 1);
  const attempt = JSON.parse(
    await fs.readFile(
      path.join(
        f.root,
        path.dirname(failure.logPath),
        "deployment-attempt.json",
      ),
      "utf8",
    ),
  );
  assert.equal(attempt.outcome, "dispatch_not_proven");
});
test("unknown Wrangler result retains durable attempt and is never automatically repeated", async (t) => {
  let deploys = 0;
  const f = await run(t, settings(make()), settings(make()), {
    runner: async (c) => {
      if (c.args.includes("deploy")) {
        deploys++;
        throw new Error("synthetic outcome unknown");
      }
      return { code: 0 };
    },
  });
  let failure;
  await assert.rejects(f.execute(), (e) => {
    failure = e;
    return e.code === "deploy";
  });
  assert.equal(deploys, 1);
  assert.equal(f.calls.length, 3);
  const attempt = JSON.parse(
    await fs.readFile(
      path.join(
        f.root,
        path.dirname(failure.logPath),
        "deployment-attempt.json",
      ),
      "utf8",
    ),
  );
  assert.equal(attempt.outcome, "dispatch_not_proven");
  assert.equal(attempt.explicitControlHttpBeforeDeploy, 3);
});
test("v2 cannot accidentally accept static or reverse to old trial deployment validation", () => {
  assert.throws(() =>
    validateV2DeploymentTransition(
      {
        bindings: settings(make()).bindings.filter((b) =>
          ["assets", "secret_text"].includes(b.type),
        ),
      },
      make(),
    ),
  );
  assert.throws(() =>
    validateRemoteStorageBindings(settings(make()), make("trial-v1")),
  );
});
test("v2 CLI is explicit, rejects malformed pairs/duplicates and is validated before files", async () => {
  const valid = [
    "--profile",
    "production",
    "--storage-mode",
    "authority-v2",
    "--write-mode",
    "closed",
    "--filename-ai",
  ];
  assert.deepEqual(parseApiDeployArguments(valid), {
    profile: "production",
    storageMode: "authority-v2",
    writeMode: "closed",
    singleTrial: false,
    filenameAi: true,
    preparedText: false,
    preparedTextRollback: false,
  });
  for (const invalid of [
    valid.slice(0, -1),
    [...valid, "--single-trial"],
    [...valid, "--storage-mode", "authority-v2"],
    valid.map((v) => (v === "closed" ? "open" : v)),
    valid.map((v) => (v === "production" ? "check" : v)),
    ["--profile", "production", "--write-mode", "closed"],
    [...valid, "--prepared-text", "--prepared-text-rollback"],
  ])
    assert.throws(() => parseApiDeployArguments(invalid));
  for (const changes of [
    { writeMode: undefined },
    { storageMode: undefined },
    { singleTrial: true },
    { filenameAi: false },
    { writeMode: "open" },
    { storageMode: "unknown" },
    { preparedText: "true" },
  ])
    await assert.rejects(
      deployApi({ ...args, root: "/nonexistent", ...changes }),
      (e) => e.code === "target",
    );
});

for (const stage of ["identity", "settings", "guard"]) {
  test(`${stage} unresponsive transport stops bounded with zero Wrangler`, async (t) => {
    const never = () => new Promise(() => {});
    const changes =
      stage === "identity"
        ? {
            identityChecker: (c, r) =>
              verifyDatabaseIdentity(c, r, { fetchImpl: never, timeoutMs: 10 }),
          }
        : stage === "settings"
          ? {
              inspector: (c, n) =>
                readRemoteSettings(c, n, never, { timeoutMs: 10 }),
            }
          : {
              storageChecker: (c, r, contract) =>
                verifyStorageDeployGuard(c, r, contract, {
                  fetcher: never,
                  timeoutMs: 10,
                }),
            };
    const f = await run(t, settings(make()), settings(make()), changes);
    await assert.rejects(f.execute());
    assert.equal(f.child.length, 0);
  });
}
test("404 absent settings and anomalous 404 bodies never reach guard or Wrangler", async (t) => {
  for (const body of [null, new ReadableStream()]) {
    const f = await run(t, settings(make()), settings(make()), {
      inspector: (c, n) =>
        readRemoteSettings(
          c,
          n,
          async () => new Response(body, { status: 404 }),
          { timeoutMs: 10 },
        ),
      storageChecker: () =>
        assert.fail("missing settings must stop before guard"),
    });
    await assert.rejects(f.execute());
    assert.equal(f.child.length, 0);
  }
});
test("postflight transport loss preserves unknown intent and performs no deploy retry", async (t) => {
  let reads = 0;
  const f = await run(t, settings(make()), settings(make()), {
    inspector: async (c, n) =>
      ++reads === 1
        ? settings(make())
        : readRemoteSettings(c, n, () => new Promise(() => {}), {
            timeoutMs: 10,
          }),
  });
  let failure;
  await assert.rejects(f.execute(), (e) => {
    failure = e;
    return e.code === "remote";
  });
  assert.equal(reads, 2);
  assert.equal(f.child.filter((c) => c.args.includes("deploy")).length, 1);
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
