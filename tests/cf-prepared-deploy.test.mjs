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
  deployApi,
  verifyPreparedSchema,
  PREPARED_DEPLOY_GUARD_SQL,
} from "../scripts/cf-api-deploy.mjs";
import {
  PREPARED_SCHEMA_DEFINITIONS,
  PREPARED_SCHEMA_SHA256,
} from "../scripts/prepared-schema.mjs";
import { deploy, STATIC_WORKER_SOURCE } from "../scripts/cf-deploy.mjs";
import { validateSingleTrialTarget } from "../scripts/single-trial-config.mjs";
import { DatabaseSync } from "node:sqlite";

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
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-prepared-deploy-")),
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
const preparedOptions = { ...options, preparedText: true };
function preparedSettings() {
  const value = settings(true);
  value.bindings.push(
    {
      name: "PREPARED_BOOKS",
      type: "r2_bucket",
      bucket_name: "the-shelf-books",
    },
    ...Object.entries({
      PREPARED_TEXT_MODE: "registry-v1",
      PREPARED_R2_ACCOUNT_ID: ACCOUNT,
      PREPARED_R2_BUCKET: "the-shelf-books",
    }).map(([name, text]) => ({ name, text, type: "plain_text" })),
  );
  return value;
}
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: ID,
  },
};
const resource = {
  databaseId: ID,
  databaseName: PROFILES.production.databaseName,
};
function guardData(
  definitions = PREPARED_SCHEMA_DEFINITIONS,
  authorities = [{ id: 1, identity_json: JSON.stringify(identity) }],
) {
  return {
    success: true,
    result: [
      {
        success: true,
        results: [
          {
            schema_json: JSON.stringify(definitions),
            authority_json: JSON.stringify(authorities),
          },
        ],
      },
    ],
  };
}
const jsonResponse = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
test("prepared config preserves isolated BOOKS, filename and all trial fields; exact schema helper is frozen", () => {
  assert.equal(
    PREPARED_SCHEMA_SHA256,
    "b70ad99611023bde6aa08901cd8eeebbdeeae0cd38e96f0ea8dec93e566afd0f",
  );
  assert.equal(PREPARED_SCHEMA_DEFINITIONS.length, 13);
  const config = workerConfig(
    "production",
    resource,
    ACCOUNT,
    "/safe",
    preparedOptions,
  );
  assert.deepEqual(config.r2_buckets, [
    { binding: "BOOKS", bucket_name: target.bucket },
    { binding: "PREPARED_BOOKS", bucket_name: "the-shelf-books" },
  ]);
  for (const [name, value] of Object.entries(vars(true)))
    assert.equal(config.vars[name], value);
  assert.equal(config.vars.PREPARED_R2_ACCOUNT_ID, ACCOUNT);
  validateRemoteBindings(preparedSettings(), "production", ID, preparedOptions);
  assert.throws(() =>
    validateRemoteBindings(preparedSettings(), "production", ID, options),
  );
  assert.throws(() =>
    workerConfig("check", resource, ACCOUNT, "/safe", preparedOptions),
  );
  assert.throws(() =>
    workerConfig("production", resource, ACCOUNT, "/safe", {
      preparedText: true,
    }),
  );
});
test("prepared transition accepts only wholly absent or complete exact four entries", () => {
  const transition = { ...preparedOptions, allowPreparedTextTransition: true };
  validateRemoteBindings(settings(true), "production", ID, transition);
  validateRemoteBindings(preparedSettings(), "production", ID, transition);
  assert.throws(() =>
    validateRemoteBindings(settings(true), "production", ID, preparedOptions),
  );
  for (const name of [
    "PREPARED_BOOKS",
    "PREPARED_TEXT_MODE",
    "PREPARED_R2_ACCOUNT_ID",
    "PREPARED_R2_BUCKET",
  ]) {
    const value = preparedSettings();
    value.bindings = value.bindings.filter((b) => b.name !== name);
    assert.throws(() =>
      validateRemoteBindings(value, "production", ID, transition),
    );
  }
  for (const mutate of [
    (b) => b.push({ ...b.find((v) => v.name === "PREPARED_BOOKS") }),
    (b) =>
      b.push({
        name: "EXTRA",
        type: "r2_bucket",
        bucket_name: "the-shelf-books",
      }),
    (b) =>
      (b.find((v) => v.name === "PREPARED_BOOKS").bucket_name = target.bucket),
    (b) => (b.find((v) => v.name === "BOOKS").bucket_name = "the-shelf-books"),
    (b) =>
      (b.find((v) => v.name === "PREPARED_BOOKS").account_id = "b".repeat(32)),
    (b) => (b.find((v) => v.name === "PREPARED_BOOKS").jurisdiction = "eu"),
    (b) =>
      (b.find((v) => v.name === "PREPARED_R2_ACCOUNT_ID").text = "b".repeat(
        32,
      )),
    (b) =>
      (b.find((v) => v.name === "PREPARED_R2_BUCKET").text = target.bucket),
    (b) => (b.find((v) => v.name === "PREPARED_TEXT_MODE").type = "json"),
  ]) {
    const value = preparedSettings();
    mutate(value.bindings);
    assert.throws(() =>
      validateRemoteBindings(value, "production", ID, transition),
    );
  }
});
test("prepared guard makes one fixed SELECT, checks named definitions and exact authority without DDL", async () => {
  let calls = 0;
  await verifyPreparedSchema(environmentCredentials(), resource, identity, {
    fetcher: async (url, init) => {
      calls++;
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${ID}/query`,
      );
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), {
        sql: PREPARED_DEPLOY_GUARD_SQL,
        params: [],
      });
      assert.ok(PREPARED_DEPLOY_GUARD_SQL.startsWith("SELECT "));
      return jsonResponse(
        guardData(
          [...PREPARED_SCHEMA_DEFINITIONS].reverse().map((v) => ({
            sql: v.sql,
            tbl_name: v.tbl_name,
            name: v.name,
            type: v.type,
          })),
        ),
      );
    },
  });
  assert.equal(calls, 1);
});
function environmentCredentials() {
  return { accountId: ACCOUNT, token: TOKEN };
}
for (const [label, change] of [
  ["missing010", (d) => (d.result[0].results[0].schema_json = "[]")],
  [
    "partial010",
    (d) =>
      (d.result[0].results[0].schema_json = JSON.stringify(
        PREPARED_SCHEMA_DEFINITIONS.slice(1),
      )),
  ],
  [
    "conflicting010",
    (d) => {
      const v = structuredClone(PREPARED_SCHEMA_DEFINITIONS);
      v[0].sql += " drift";
      d.result[0].results[0].schema_json = JSON.stringify(v);
    },
  ],
  [
    "extra010",
    (d) => {
      const v = structuredClone(PREPARED_SCHEMA_DEFINITIONS);
      v.push(v[0]);
      d.result[0].results[0].schema_json = JSON.stringify(v);
    },
  ],
  [
    "wrong authority",
    (d) =>
      (d.result[0].results[0].authority_json = JSON.stringify([
        {
          id: 1,
          identity_json: JSON.stringify({ ...identity, bucket: target.bucket }),
        },
      ])),
  ],
  [
    "wrong production DB",
    (d) =>
      (d.result[0].results[0].authority_json = JSON.stringify([
        {
          id: 1,
          identity_json: JSON.stringify({
            ...identity,
            legacyDatabases: {
              ...identity.legacyDatabases,
              production: identity.legacyDatabases.check,
            },
          }),
        },
      ])),
  ],
  ["extra authority", (d) => (d.result[0].results[0].authority_json = "[]")],
  ["failed query", (d) => (d.result[0].success = false)],
])
  test(`prepared guard rejects ${label} once`, async () => {
    let calls = 0;
    const d = guardData();
    change(d);
    await assert.rejects(
      verifyPreparedSchema(environmentCredentials(), resource, identity, {
        fetcher: async () => {
          calls++;
          return jsonResponse(d);
        },
      }),
      (e) => e.code === "prepared_schema",
    );
    assert.equal(calls, 1);
  });
test("prepared guard bounds oversized, redirected, stalled and late responses; cancels without retries", async () => {
  for (const make of [
    () =>
      new Response("x".repeat(1048577), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("{}", {
        status: 302,
        headers: { "content-type": "application/json" },
      }),
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "1048577",
        },
      }),
  ]) {
    let calls = 0;
    await assert.rejects(
      verifyPreparedSchema(environmentCredentials(), resource, identity, {
        fetcher: async () => {
          calls++;
          return make();
        },
      }),
    );
    assert.equal(calls, 1);
  }
  let cancelled = 0,
    calls = 0;
  const stalled = new Response(
    new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled++;
        return new Promise(() => {});
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    verifyPreparedSchema(environmentCredentials(), resource, identity, {
      timeoutMs: 10,
      fetcher: async () => {
        calls++;
        return stalled;
      },
    }),
  );
  assert.equal(calls, 1);
  assert.ok(cancelled >= 1);
  let release;
  const pending = new Promise((r) => (release = r));
  await assert.rejects(
    verifyPreparedSchema(environmentCredentials(), resource, identity, {
      timeoutMs: 10,
      fetcher: () => pending,
    }),
  );
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(cancelled >= 2);
});
const apiArgs = {
  profile: "production",
  singleTrial: true,
  filenameAi: true,
  environment,
  ...dependencies,
};
async function deployCalls(root, before, after, extra = {}) {
  const calls = [];
  let reads = 0;
  await deployApi({
    ...apiArgs,
    root,
    preparedText: true,
    preparedChecker: async () => {},
    inspector: async () => (++reads === 1 ? before : after),
    runner: async (call) => {
      if (call.args.includes("deploy"))
        calls.push(
          JSON.parse(
            await fs.readFile(
              call.args[call.args.indexOf("--config") + 1],
              "utf8",
            ),
          ),
        );
      return { code: 0 };
    },
    ...extra,
  });
  return calls;
}
test("prepared enable observes identity then guard then exactly one deploy and requires full postflight", async (t) => {
  const root = await fixture(t);
  let guarded = 0,
    identityChecked = false;
  const calls = await deployCalls(root, settings(true), preparedSettings(), {
    identityChecker: async () => {
      identityChecked = true;
    },
    preparedChecker: async (c, r, i) => {
      assert.ok(identityChecked);
      assert.deepEqual(i, identity);
      assert.deepEqual(r, resource);
      guarded++;
    },
  });
  assert.equal(guarded, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].vars.PREPARED_TEXT_MODE, "registry-v1");
  await assert.rejects(
    deployCalls(root, settings(true), settings(true)),
    (e) => e.code === "bindings",
  );
});
test("missing010 and authority mismatch guard failures perform zero Wrangler or preflight", async (t) => {
  const root = await fixture(t);
  for (const data of [
    guardData([]),
    guardData(PREPARED_SCHEMA_DEFINITIONS, [{ id: 1, identity_json: "{}" }]),
  ]) {
    let requests = 0;
    await assert.rejects(
      deployApi({
        ...apiArgs,
        root,
        preparedText: true,
        inspector: async () => settings(true),
        preparedChecker: (c, r, i) =>
          verifyPreparedSchema(c, r, i, {
            fetcher: async () => {
              requests++;
              return jsonResponse(data);
            },
          }),
        runner: () => assert.fail("guard must stop before child"),
      }),
      (e) => e.code === "prepared_schema",
    );
    assert.equal(requests, 1);
  }
});
test("omission cannot remove prepared; explicit prepared rollback removes only four entries and retains filename trial", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    deployCalls(root, preparedSettings(), settings(true), {
      preparedText: false,
    }),
    (e) => e.code === "bindings",
  );
  const calls = await deployCalls(root, preparedSettings(), settings(true), {
    preparedText: false,
    preparedTextRollback: true,
    preparedChecker: () => assert.fail("rollback is no schema call"),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].vars, vars(true));
  assert.deepEqual(calls[0].r2_buckets, [
    { binding: "BOOKS", bucket_name: target.bucket },
  ]);
  await assert.rejects(
    deployCalls(root, settings(true), settings(true), {
      preparedText: false,
      preparedTextRollback: true,
    }),
    (e) => e.code === "bindings",
  );
});
test("prepared full static rollback must explicitly recognize prepared and preserves assets and secrets", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(
    path.join(root, "dist/data/runtime.json"),
    JSON.stringify({ apiMode: "disabled", schemaVersion: 1 }),
  );
  const args = {
    root,
    environment,
    staticRollback: true,
    singleTrial: true,
    filenameAi: true,
  };
  await assert.rejects(
    deploy({
      ...args,
      inspector: async () => preparedSettings(),
      runner: () => assert.fail("explicit recognition required"),
    }),
  );
  let reads = 0,
    deploys = 0;
  await deploy({
    ...args,
    preparedText: true,
    inspector: async () =>
      ++reads === 1
        ? preparedSettings()
        : {
            bindings: settings(true).bindings.filter((b) =>
              ["assets", "secret_text"].includes(b.type),
            ),
          },
    runner: async (call) => {
      if (call.args.includes("deploy")) {
        deploys++;
        const config = JSON.parse(
          await fs.readFile(
            call.args[call.args.indexOf("--config") + 1],
            "utf8",
          ),
        );
        assert.equal(config.vars, undefined);
        assert.equal(config.r2_buckets, undefined);
        assert.equal(
          await fs.readFile(config.main, "utf8"),
          STATIC_WORKER_SOURCE,
        );
        assert.equal(config.assets.binding, "ASSETS");
      }
      return { code: 0 };
    },
  });
  assert.equal(deploys, 1);
});
test("invalid prepared option combinations stop before filesystem and unknown deploy is never retried", async (t) => {
  for (const change of [
    { preparedText: "true" },
    { preparedText: true, profile: "check" },
    { preparedText: true, singleTrial: false },
    { preparedText: true, preparedTextRollback: true },
    { preparedTextRollback: true, singleTrial: false },
  ])
    await assert.rejects(
      deployApi({ ...apiArgs, root: "/nonexistent", ...change }),
      (e) => e.code === "target",
    );
  await assert.rejects(
    deploy({ root: "/nonexistent", preparedText: true }),
    (e) => e.code === "config",
  );
  const root = await fixture(t);
  let deploys = 0;
  await assert.rejects(
    deployCalls(root, settings(true), preparedSettings(), {
      runner: async (call) => {
        if (call.args.includes("deploy")) {
          deploys++;
          throw new Error("unknown deployment");
        }
        return { code: 0 };
      },
    }),
    (e) => e.code === "deploy",
  );
  assert.equal(deploys, 1);
});
test("guard SQL executes against SQLite, bounds extra schema/authority rows and handles missing010", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE shelf_storage_authority(id INTEGER PRIMARY KEY,identity_json TEXT)",
  );
  db.prepare("INSERT INTO shelf_storage_authority VALUES(1,?)").run(
    JSON.stringify(identity),
  );
  const fetcher = async (_url, init) => {
    const { sql, params } = JSON.parse(init.body);
    return jsonResponse({
      success: true,
      result: [{ success: true, results: db.prepare(sql).all(...params) }],
    });
  };
  await assert.rejects(
    verifyPreparedSchema(environmentCredentials(), resource, identity, {
      fetcher,
    }),
  );
  for (const definition of PREPARED_SCHEMA_DEFINITIONS) db.exec(definition.sql);
  await verifyPreparedSchema(environmentCredentials(), resource, identity, {
    fetcher,
  });
  db.exec("CREATE TABLE shelf_prepared_unexpected(value TEXT)");
  await assert.rejects(
    verifyPreparedSchema(environmentCredentials(), resource, identity, {
      fetcher,
    }),
  );
  db.exec("DROP TABLE shelf_prepared_unexpected");
  db.prepare("INSERT INTO shelf_storage_authority VALUES(2,?)").run(
    JSON.stringify(identity),
  );
  await assert.rejects(
    verifyPreparedSchema(environmentCredentials(), resource, identity, {
      fetcher,
    }),
  );
});
test("prepared CLI invalid combinations reject before credentials or filesystem context", async () => {
  for (const args of [
    ["scripts/cf-api-deploy.mjs", "--profile", "production", "--prepared-text"],
    [
      "scripts/cf-api-deploy.mjs",
      "--profile",
      "check",
      "--single-trial",
      "--prepared-text",
    ],
    [
      "scripts/cf-api-deploy.mjs",
      "--profile",
      "production",
      "--single-trial",
      "--prepared-text",
      "--prepared-text-rollback",
    ],
    [
      "scripts/cf-api-deploy.mjs",
      "--profile",
      "production",
      "--single-trial",
      "--prepared-text",
      "--prepared-text",
    ],
    ["scripts/cf-deploy.mjs", "--static-rollback", "--prepared-text"],
    ["scripts/cf-deploy.mjs", "--prepared-text"],
  ])
    await assert.rejects(
      promisify(execFile)(process.execPath, args, {
        env: { PATH: process.env.PATH },
      }),
      (e) =>
        e.code === 1 && /stopped safely|configuration rejected/.test(e.stderr),
    );
});
