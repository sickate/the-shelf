import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { deploy, STATIC_WORKER_SOURCE } from "../scripts/cf-deploy.mjs";
import { workerConfig } from "../scripts/cf-api-deploy.mjs";
import { storageDeploymentContract } from "../shared/storage-deployment-contract.mjs";
import {
  isolatedFixture,
  identity,
  ACCOUNT,
} from "./helpers/isolated-operator-fixture.mjs";
import { wranglerUploadMetadata } from "./helpers/wrangler-upload-metadata.mjs";

test("installed Wrangler assets-only serializer drops bindings and keepSecrets: regression reproduced", () => {
  const metadata = wranglerUploadMetadata(
    {
      assets: { directory: "/synthetic", binding: "ASSETS" },
      vars: { SHOULD_DROP: "synthetic" },
    },
    { assetsOnly: true },
  );
  assert.equal(metadata.bindings, undefined);
  assert.equal(metadata.keep_bindings, undefined);
  assert.equal(metadata.main_module, undefined);
  assert.ok(metadata.assets);
});

for (const profile of ["ordinary", "trial", "filename-trial", "isolated", "v2"])
  test(`real installed upload metadata preserves ASSETS and secret inheritance for static ${profile}`, async (t) => {
    const f = await isolatedFixture(t, { installed: true, seeded: true });
    await f.write("dist/data/runtime.json", {
      schemaVersion: 1,
      apiMode: "disabled",
    });
    let before = f.settings,
      options = { staticRollback: true, singleTrial: true, filenameAi: true };
    if (profile === "ordinary") {
      before = { bindings: [] };
      options = {};
    }
    if (profile === "trial") {
      before = {
        bindings: before.bindings.filter(
          (b) =>
            !b.name.startsWith("ISOLATED_UPLOAD_") &&
            !b.name.startsWith("FILENAME_AI_"),
        ),
      };
      options = { staticRollback: true, singleTrial: true };
    }
    if (profile === "filename-trial")
      before = {
        bindings: before.bindings.filter(
          (b) => !b.name.startsWith("ISOLATED_UPLOAD_"),
        ),
      };
    if (profile === "isolated") options.isolatedUploads = true;
    if (profile === "v2") {
      options = {
        staticRollback: true,
        storageMode: "authority-v2",
        writeMode: "closed",
        filenameAi: true,
      };
      const contract = storageDeploymentContract({
        profile: "authority-v2-closed",
        identity,
        trialTargetSha256: f.target.configSha256,
        filenameAi: true,
        preparedText: false,
        retainedSecrets: "trial-retained-filename-v1",
      });
      before = {
        bindings: [
          { name: "ASSETS", type: "assets" },
          {
            name: "DB",
            type: "d1",
            database_id: identity.legacyDatabases.production,
          },
          ...contract.r2Bindings.map((b) => ({
            name: b.binding,
            type: "r2_bucket",
            bucket_name: b.bucket_name,
          })),
          ...contract.secretNames.map((name) => ({
            name,
            type: "secret_text",
          })),
          ...Object.entries(contract.vars).map(([name, text]) => ({
            name,
            type: "plain_text",
            text,
          })),
        ],
      };
    }
    let metadata,
      config,
      settingsCalls = 0;
    await deploy({
      ...options,
      root: f.root,
      environment: {},
      inspector: async () =>
        ++settingsCalls === 1
          ? before
          : {
              bindings: [
                { name: "ASSETS", type: "assets" },
                ...before.bindings.filter((b) => b.type === "secret_text"),
              ],
            },
      runner: async (call) => {
        if (call.args.includes("deploy")) {
          config = JSON.parse(
            await fs.readFile(
              call.args[call.args.indexOf("--config") + 1],
              "utf8",
            ),
          );
          const content = await fs.readFile(config.main, "utf8");
          assert.equal(content, STATIC_WORKER_SOURCE);
          metadata = wranglerUploadMetadata(config, { content });
        }
        return { code: 0 };
      },
    });
    assert.equal(settingsCalls, 2);
    assert.equal(config.assets.binding, "ASSETS");
    assert.equal(config.keep_vars, undefined);
    assert.equal(config.vars, undefined);
    assert.equal(config.d1_databases, undefined);
    assert.equal(config.r2_buckets, undefined);
    assert.deepEqual(metadata.bindings, [{ name: "ASSETS", type: "assets" }]);
    assert.deepEqual(metadata.keep_bindings, ["secret_text", "secret_key"]);
    assert.equal(metadata.main_module, "shelf-main.mjs");
    assert.ok(metadata.assets);
    assert.equal(JSON.stringify(metadata).includes("plain_text"), false);
  });

test("installed Wrangler API metadata inherits secret categories and keeps explicit DB/R2/isolated vars", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true }),
    config = workerConfig(
      "production",
      f.resources.profiles.production,
      ACCOUNT,
      f.root,
      {
        singleTrialTarget: f.target,
        filenameAi: true,
        isolatedUploadConsentSha256: f.consent.sha256,
      },
    ),
    metadata = wranglerUploadMetadata(config);
  assert.deepEqual(metadata.keep_bindings, ["secret_text", "secret_key"]);
  assert.ok(
    metadata.bindings.some(
      (b) =>
        b.name === "DB" &&
        b.type === "d1" &&
        b.id === identity.legacyDatabases.production,
    ),
  );
  assert.ok(
    metadata.bindings.some(
      (b) =>
        b.name === "BOOKS" &&
        b.type === "r2_bucket" &&
        b.bucket_name === f.target.bucket,
    ),
  );
  assert.ok(
    metadata.bindings.some(
      (b) =>
        b.name === "ISOLATED_UPLOAD_MODE" &&
        b.type === "plain_text" &&
        b.text === "project-v1",
    ),
  );
  assert.ok(
    metadata.bindings.some(
      (b) =>
        b.name === "ISOLATED_UPLOAD_CONSENT_SHA256" &&
        b.text === f.consent.sha256,
    ),
  );
  assert.equal(
    metadata.bindings.some((b) => b.type === "secret_text"),
    false,
  );
});

test("fixed static module touches only ASSETS for API paths and ordinary assets", async () => {
  const module = await import(
      `data:text/javascript,${encodeURIComponent(STATIC_WORKER_SOURCE)}`
    ),
    paths = [];
  const env = new Proxy(
    {
      ASSETS: {
        fetch(request) {
          paths.push(new URL(request.url).pathname);
          return new Response("static");
        },
      },
    },
    {
      get(target, key) {
        assert.equal(key, "ASSETS");
        return target[key];
      },
    },
  );
  for (const path of [
    "/",
    "/api/auth/login",
    "/api/manage/uploads/bytes",
    "/api/single-trial/upload",
  ]) {
    const response = await module.default.fetch(
      new Request("https://synthetic.invalid" + path),
      env,
    );
    assert.equal(await response.text(), "static");
  }
  assert.equal(paths.length, 4);
});
