import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import {
  AUTH_SQL,
  AUTH_PROBE_SQL,
  AUTH_LIMITS,
  runProductionAuth,
  ProductionAuthError,
} from "../scripts/cf-production-auth.mjs";
import { createOwnerVerifier } from "../cloudflare/library/security.mjs";
import { validateSingleTrialTarget } from "../scripts/single-trial-config.mjs";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const ACCOUNT = "a".repeat(32),
  DATABASE = "22222222-2222-4222-8222-222222222222",
  VERSION = "33333333-3333-4333-8333-333333333333";
const OWNER = Buffer.alloc(32, 17).toString("base64url"),
  PEPPER = Buffer.alloc(32, 23).toString("base64url"),
  SESSION = Buffer.alloc(32, 29).toString("base64url"),
  TOKEN = "auth-test-private-token-" + "x".repeat(30);
const response = (result) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), {
    status: 200,
  });
const failCode = (code) => (e) =>
  e instanceof ProductionAuthError && e.code === `production_auth_${code}`;
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-auth-")),
  );
  await fs.chmod(root, 0o700);
  for (const dir of [
    ".local",
    ".local/cf03",
    ".local/cf03/production",
    "cloudflare",
    "cloudflare/library",
  ])
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  const schema = await fs.readFile(
    path.join(SOURCE, "cloudflare/library/schema.sql"),
    "utf8",
  );
  await fs.writeFile(path.join(root, "cloudflare/library/schema.sql"), schema, {
    mode: 0o644,
  });
  await fs.writeFile(
    path.join(root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${TOKEN}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        check: {
          databaseId: "11111111-1111-4111-8111-111111111111",
          databaseName: "the-shelf-cf03-check",
        },
        production: { databaseId: DATABASE, databaseName: "the-shelf-library" },
      },
    }),
    { mode: 0o600 },
  );
  for (const [name, value] of [
    ["owner-access-key", OWNER],
    ["owner-key-pepper", PEPPER],
    ["session-secret", SESSION],
  ])
    await fs.writeFile(
      path.join(root, `.local/cf03/production/${name}`),
      value + "\n",
      { mode: 0o600 },
    );
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const verifier = await createOwnerVerifier(OWNER, PEPPER, {
    scope: "production",
    origin: ORIGIN,
  });
  const calls = [];
  const settings = {
    bindings: [
      { name: "DB", type: "d1", id: DATABASE },
      { name: "BOOKS", type: "r2_bucket", bucket_name: "the-shelf-books" },
      { name: "ASSETS", type: "assets" },
      ...[
        "OWNER_KEY_PEPPER",
        "SESSION_SECRET",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
      ].map((name) => ({ name, type: "secret_text" })),
      ...Object.entries({
        APP_SCOPE: "production",
        SITE_ORIGIN: ORIGIN,
        R2_ACCOUNT_ID: ACCOUNT,
        R2_BUCKET: "the-shelf-books",
      }).map(([name, text]) => ({ name, type: "plain_text", text })),
    ],
  };
  const deployment = {
    deployments: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        versions: [{ version_id: VERSION, percentage: 100 }],
      },
    ],
  };
  let interceptor;
  async function fetcher(url, init) {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.ok(
      url.startsWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`,
      ),
    );
    const receipts = await fs.readdir(
      path.join(root, ".local/cf03/production-auth"),
    );
    const pending = await Promise.all(
      receipts
        .filter((p) => p.endsWith(".json"))
        .map(async (p) =>
          JSON.parse(
            await fs.readFile(
              path.join(root, ".local/cf03/production-auth", p),
              "utf8",
            ),
          ),
        ),
    );
    assert.ok(
      pending.some((r) => r.requests.at(-1)?.outcome === "pending"),
      "durable intent precedes transport",
    );
    if (interceptor) {
      const value = await interceptor(url, init);
      if (value !== undefined) return value;
    }
    if (url.endsWith(`/d1/database/${DATABASE}`))
      return response({ uuid: DATABASE, name: "the-shelf-library" });
    if (url.endsWith("/query")) {
      const { sql, params } = JSON.parse(init.body);
      return response([
        { success: true, results: db.prepare(sql).all(...params), meta: {} },
      ]);
    }
    if (url.endsWith("/deployments?page=1&per_page=1"))
      return response(deployment);
    if (url.endsWith("/settings")) return response(settings);
    if (url.endsWith("/subdomain"))
      return response({ enabled: true, previews_enabled: false });
    assert.fail("unexpected endpoint");
  }
  let nextRun = 0;
  const run = (options = {}) =>
    runProductionAuth({
      execute: true,
      root,
      environment: {},
      runId: `run-${++nextRun}`,
      fetchImpl: fetcher,
      clock: () => 10000 + nextRun,
      ...options,
    });
  const seed = ({ enabled = 0, generation = 1 } = {}) =>
    db
      .prepare(
        "INSERT INTO auth_config VALUES ('production',?,'owner-access-key-v1',?,?,?,1)",
      )
      .run(ORIGIN, verifier, generation, enabled);
  const expected = () => {
    const row = db.prepare(AUTH_SQL.status).get(verifier);
    const fields = Object.fromEntries(
      "scope,origin,scheme,generation,enabled,updated_at"
        .split(",")
        .map((key) => [key, row[key]]),
    );
    return {
      expectedGeneration: row.generation,
      expectedRowSha256: awaitHash(fields),
    };
  };
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    verifier,
    calls,
    settings,
    deployment,
    run,
    seed,
    expected,
    intercept: (fn) => {
      interceptor = fn;
    },
  };
}
import { createHash } from "node:crypto";
const awaitHash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
test("trial auth enable requires explicit target config and rejects retained legacy S3 secret", async (t) => {
  const f = await fixture(t);
  f.seed();
  const upload = Buffer.alloc(32, 41).toString("base64url"),
    v = {
      schemaVersion: 1,
      mode: "first-book-20261023",
      accountId: ACCOUNT,
      bucket: "the-shelf-first-book-20261023",
      worker: "the-shelf",
      origin: ORIGIN,
      uploadSecretSha256: createHash("sha256").update(upload).digest("hex"),
    },
    target = validateSingleTrialTarget(v, ACCOUNT, upload);
  await fs.writeFile(
    path.join(f.root, ".local/cf03/production/single-trial-target.json"),
    JSON.stringify(v),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(f.root, ".local/cf03/production/single-trial-upload-secret"),
    upload + "\n",
    { mode: 0o600 },
  );
  f.settings.bindings = f.settings.bindings.filter(
    (b) => !["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].includes(b.name),
  );
  f.settings.bindings.push(
    { name: "SINGLE_TRIAL_UPLOAD_SECRET", type: "secret_text" },
    { name: "SINGLE_TRIAL_MODE", type: "plain_text", text: v.mode },
    {
      name: "SINGLE_TRIAL_TARGET_SHA256",
      type: "plain_text",
      text: target.configSha256,
    },
  );
  f.settings.bindings.find((b) => b.name === "BOOKS").bucket_name = v.bucket;
  f.settings.bindings.find((b) => b.name === "R2_BUCKET").text = v.bucket;
  await assert.rejects(
    f.run({
      action: "enable",
      runId: "no-trial-flag",
      expectedVersion: VERSION,
      ...f.expected(),
    }),
    failCode("worker_precondition_failed"),
  );
  f.settings.bindings.push({ name: "R2_ACCESS_KEY_ID", type: "secret_text" });
  await assert.rejects(
    f.run({
      action: "enable",
      runId: "trial-old-secret",
      expectedVersion: VERSION,
      ...f.expected(),
      singleTrial: true,
    }),
    failCode("worker_precondition_failed"),
  );
  f.settings.bindings = f.settings.bindings.filter(
    (b) => b.name !== "R2_ACCESS_KEY_ID",
  );
  const result = await f.run({
    action: "enable",
    runId: "trial-enable",
    expectedVersion: VERSION,
    ...f.expected(),
    singleTrial: true,
  });
  assert.equal(result.auth.row.enabled, 1);
});

test("preview and real CLI preview perform no file, clock, configuration or transport IO", async () => {
  const result = await runProductionAuth({
    root: "/does-not-exist",
    clock: () => assert.fail(),
    fetchImpl: () => assert.fail(),
    environment: new Proxy(
      {},
      {
        get() {
          assert.fail();
        },
      },
    ),
  });
  assert.equal(result.requests, 0);
  const cli = spawnSync(
    process.execPath,
    [path.join(SOURCE, "scripts/cf-production-auth.mjs"), "enable"],
    { cwd: os.tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(cli.status, 0);
  assert.equal(JSON.parse(cli.stdout).requests, 0);
});

test("status reads fixed production identity, exact auth schema and safe state", async (t) => {
  const f = await fixture(t);
  f.seed();
  const result = await f.run();
  assert.equal(result.requests, 2);
  assert.equal(result.auth.row.enabled, 0);
  assert.ok(result.auth.rowSha256);
  assert.equal(f.calls.length, 2);
});

test("initialize creates only disabled generation1 and independently reads back", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ action: "initialize-disabled" });
  assert.equal(result.requests, 4);
  assert.equal(result.auth.row.enabled, 0);
  assert.equal(result.auth.row.generation, 1);
  assert.equal(
    f.db.prepare("SELECT verifier FROM auth_config").get().verifier,
    f.verifier,
  );
  assert.ok(f.calls.at(-1).init.body.includes(AUTH_SQL.status));
  await assert.rejects(
    f.run({ action: "initialize-disabled" }),
    failCode("auth_exists"),
  );
});

test("close is independent of Worker availability, rotates disabled rows too, revokes ALL sessions", async (t) => {
  const f = await fixture(t);
  f.seed({ enabled: 1 });
  for (const [id, expires] of [
    ["a", 800],
    ["b", 20000],
  ])
    f.db
      .prepare("INSERT INTO sessions VALUES ('production',?,1,1,?,0)")
      .run(id.repeat(64), expires);
  f.intercept((url) => {
    assert.ok(!url.includes("/workers/"));
  });
  const result = await f.run({ action: "close", ...f.expected() });
  assert.equal(result.requests, 4);
  assert.equal(result.auth.row.generation, 2);
  assert.equal(result.auth.unrevokedSessions, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM sessions WHERE revoked=1").get().n,
    2,
  );
  const repeated = await f.run({ action: "close", ...f.expected() });
  assert.equal(repeated.auth.row.generation, 3);
});

test("enable pins reviewed version, exact bindings and worker entrypoints and verifies after CAS", async (t) => {
  const f = await fixture(t);
  f.seed();
  const result = await f.run({
    action: "enable",
    expectedVersion: VERSION,
    ...f.expected(),
  });
  assert.equal(result.requests, 11);
  assert.equal(result.auth.row.enabled, 1);
  assert.ok(result.requests <= AUTH_LIMITS.enable);
});

test("CAS row/gen mismatches and wrong local verifier fail without mutation", async (t) => {
  const f = await fixture(t);
  f.seed();
  await assert.rejects(
    f.run({
      action: "close",
      expectedGeneration: 2,
      expectedRowSha256: "a".repeat(64),
    }),
    failCode("expected_row_mismatch"),
  );
  f.db
    .prepare("UPDATE auth_config SET verifier=?,generation=2")
    .run("f".repeat(64));
  await assert.rejects(f.run(), failCode("auth_identity_mismatch"));
  assert.ok(
    f.calls.every(
      (c) =>
        !c.init.body ||
        [AUTH_SQL.status, AUTH_PROBE_SQL].includes(JSON.parse(c.init.body).sql),
    ),
  );
});

test("missing, altered or extra auth/session triggers reject before any mutation", async (t) => {
  const f = await fixture(t);
  f.seed();
  f.db.exec(
    "CREATE TRIGGER unexpected_auth AFTER UPDATE ON auth_config BEGIN SELECT 1; END;",
  );
  await assert.rejects(
    f.run({ action: "close", ...f.expected() }),
    failCode("schema_invalid"),
  );
  f.db.exec("DROP TRIGGER unexpected_auth; DROP TRIGGER auth_rotation;");
  await assert.rejects(
    f.run({ action: "close", ...f.expected() }),
    failCode("schema_invalid"),
  );
  assert.equal(
    f.db.prepare("SELECT generation FROM auth_config").get().generation,
    1,
  );
});

test("wrong Worker version/bindings/subdomain block enable without CAS", async (t) => {
  const f = await fixture(t);
  f.seed();
  await assert.rejects(
    f.run({
      action: "enable",
      expectedVersion: "55555555-5555-4555-8555-555555555555",
      ...f.expected(),
    }),
    failCode("worker_precondition_failed"),
  );
  f.settings.bindings.find((b) => b.name === "BOOKS").bucket_name = "wrong";
  await assert.rejects(
    f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() }),
    failCode("worker_precondition_failed"),
  );
  f.settings.bindings.find((b) => b.name === "BOOKS").bucket_name =
    "the-shelf-books";
  f.intercept((url) =>
    url.endsWith("/subdomain")
      ? response({ enabled: true, previews_enabled: true })
      : undefined,
  );
  await assert.rejects(
    f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() }),
    failCode("worker_precondition_failed"),
  );
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
    0,
  );
});

test("mutation response loss is retained unknown; status observes without clearing; fresh close remains usable", async (t) => {
  const f = await fixture(t);
  f.seed();
  let mutations = 0;
  f.intercept((url, init) => {
    if (!init.body) return;
    const { sql, params } = JSON.parse(init.body);
    if (sql === AUTH_SQL.enable) {
      mutations++;
      f.db.prepare(sql).all(...params);
      throw new Error(`${TOKEN} ${OWNER} private sentinel`);
    }
  });
  await assert.rejects(
    f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() }),
    failCode("mutation_unknown"),
  );
  assert.equal(mutations, 1);
  const observed = await f.run();
  assert.equal(observed.auth.row.enabled, 1);
  assert.equal(observed.unresolvedMutations, 1);
  await assert.rejects(
    f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() }),
    failCode("unresolved_mutation"),
  );
  const closed = await f.run({ action: "close", ...f.expected() });
  assert.equal(closed.auth.row.enabled, 0);
  assert.equal(closed.unresolvedMutations, 1);
  const state = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".local/cf03/production-auth-state.json"),
      "utf8",
    ),
  );
  assert.equal(state.unresolved.length, 1);
});

test("real SQLite simultaneous CAS has a single winner, and late old enable cannot undo generation bump", async (t) => {
  const f = await fixture(t);
  f.seed();
  const old = f.expected();
  const enableParams = [10, ORIGIN, f.verifier, old.expectedGeneration, 1];
  const closeParams = [11, ORIGIN, f.verifier, old.expectedGeneration, 0, 1];
  const results = await Promise.all([
    Promise.resolve().then(() =>
      f.db.prepare(AUTH_SQL.close).all(...closeParams),
    ),
    Promise.resolve().then(() =>
      f.db.prepare(AUTH_SQL.enable).all(...enableParams),
    ),
  ]);
  assert.deepEqual(
    results.map((r) => r.length),
    [1, 0],
  );
  assert.equal(f.db.prepare(AUTH_SQL.close).all(...closeParams).length, 0);
  assert.equal(
    f.db.prepare("SELECT generation FROM auth_config").get().generation,
    2,
  );
});

test("independent SQLite connections concurrently enabling the same row have only one CAS winner", async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, ".local/cas-test.sqlite");
  const db = new DatabaseSync(filename);
  db.exec(
    await fs.readFile(
      path.join(SOURCE, "cloudflare/library/schema.sql"),
      "utf8",
    ),
  );
  db.prepare(
    "INSERT INTO auth_config VALUES ('production',?,'owner-access-key-v1',?,1,0,1)",
  ).run(ORIGIN, f.verifier);
  const shared = new SharedArrayBuffer(4),
    gate = new Int32Array(shared);
  const script = `const {workerData,parentPort}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA busy_timeout=5000');parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.shared),0,0);try{const rows=db.prepare(workerData.sql).all(...workerData.params);parentPort.postMessage(rows.length)}catch(e){parentPort.postMessage({error:e.code})}finally{db.close()}`;
  const jobs = Array.from({ length: 2 }, () => {
    const worker = new Worker(script, {
      eval: true,
      workerData: {
        filename,
        shared,
        sql: AUTH_SQL.enable,
        params: [10, ORIGIN, f.verifier, 1, 1],
      },
    });
    let readyResolve, resultResolve, reject;
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    const result = new Promise((resolve, fail) => {
      resultResolve = resolve;
      reject = fail;
    });
    worker.on("message", (message) =>
      message === "ready" ? readyResolve() : resultResolve(message),
    );
    worker.on("error", reject);
    t.after(() => worker.terminate());
    return { ready, result };
  });
  try {
    await Promise.all(jobs.map((j) => j.ready));
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0, 2);
    const results = await Promise.all(jobs.map((j) => j.result));
    assert.deepEqual(results.sort(), [0, 1]);
  } finally {
    db.close();
  }
});

test("close and session revocation roll back together if any trigger fails", async (t) => {
  const f = await fixture(t);
  f.seed({ enabled: 1 });
  f.db
    .prepare("INSERT INTO sessions VALUES ('production',?,1,1,20000,0)")
    .run("a".repeat(64));
  f.db.exec(
    "CREATE TRIGGER fail_revocation BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;",
  );
  assert.throws(() =>
    f.db.prepare(AUTH_SQL.close).all(10, ORIGIN, f.verifier, 1, 1, 1),
  );
  assert.equal(
    f.db.prepare("SELECT generation,enabled FROM auth_config").get().generation,
    1,
  );
  assert.equal(f.db.prepare("SELECT revoked FROM sessions").get().revoked, 0);
});

test("mutation result persistence failure retains durable unknown and never repeats CAS", async (t) => {
  const f = await fixture(t);
  f.seed();
  let mutations = 0;
  f.intercept(async (url, init) => {
    if (!init.body) return;
    const { sql, params } = JSON.parse(init.body);
    if (sql === AUTH_SQL.close) {
      mutations++;
      const rows = f.db.prepare(sql).all(...params);
      await fs.writeFile(
        path.join(f.root, ".local/cf03/production-auth/run-1.json.pending"),
        "blocked write",
        { mode: 0o600 },
      );
      return response([{ success: true, results: rows }]);
    }
  });
  await assert.rejects(
    f.run({ action: "close", ...f.expected() }),
    failCode("mutation_unknown"),
  );
  assert.equal(mutations, 1);
  const state = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".local/cf03/production-auth-state.json"),
      "utf8",
    ),
  );
  assert.deepEqual(state.unresolved, [{ runId: "run-1", action: "close" }]);
  assert.equal(
    f.db.prepare("SELECT generation FROM auth_config").get().generation,
    2,
  );
});

test("pending late enable times out once, then fresh close rejects its eventual old CAS", async (t) => {
  const f = await fixture(t);
  f.seed();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let lateSql, lateParams, settle;
  f.intercept((url, init) => {
    if (init.body) {
      const { sql, params } = JSON.parse(init.body);
      if (sql === AUTH_SQL.enable) {
        lateSql = sql;
        lateParams = params;
        return new Promise((resolve) => {
          settle = resolve;
          queueMicrotask(() => t.mock.timers.tick(AUTH_LIMITS.deadlineMs));
        });
      }
    }
  });
  await assert.rejects(
    f.run({
      action: "enable",
      expectedVersion: VERSION,
      ...f.expected(),
    }),
    failCode("mutation_unknown"),
  );
  t.mock.timers.reset();
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
    0,
  );
  await f.run({ action: "close", ...f.expected() });
  const lateRows = f.db.prepare(lateSql).all(...lateParams);
  assert.equal(lateRows.length, 0);
  settle(response([{ success: true, results: lateRows }]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const state = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".local/cf03/production-auth-state.json"),
      "utf8",
    ),
  );
  assert.equal(state.unresolved.length, 1);
});

test("oversize, redirect, malformed envelope and stalled bodies fail safely without retries", async (t) => {
  const f = await fixture(t);
  for (const mode of ["size", "redirect", "envelope"]) {
    const before = f.calls.length;
    f.intercept(() =>
      mode === "size"
        ? new Response("{}", { headers: { "content-length": "1000001" } })
        : mode === "redirect"
          ? new Response("", { status: 302 })
          : new Response(new ReadableStream({ start() {} })),
    );
    if (mode === "envelope")
      f.intercept(
        () =>
          new Response(
            JSON.stringify({ success: false, errors: [{ message: TOKEN }] }),
          ),
      );
    await assert.rejects(
      f.run(),
      (e) => e instanceof ProductionAuthError && !e.message.includes(TOKEN),
    );
    assert.equal(f.calls.length - before, 1);
  }
});

test("stalled response body is cancelled at the enforced whole-body deadline", async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.intercept(
    () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              queueMicrotask(() => t.mock.timers.tick(AUTH_LIMITS.deadlineMs));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  await assert.rejects(f.run(), failCode("deadline"));
  assert.equal(f.calls.length, 1);
  assert.ok(cancelled);
  t.mock.timers.reset();
});

test("empty chunk floods reach the chunk bound and cancel without retries", async (t) => {
  const f = await fixture(t);
  let chunks = 0,
    cancelled = false;
  f.intercept(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(0));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(f.run(), failCode("response_limit"));
  assert.equal(f.calls.length, 1);
  assert.ok(chunks >= 100001);
  assert.ok(cancelled);
});

test("expected row hash rejects coercible non-string values before any IO", async () => {
  await assert.rejects(
    runProductionAuth({
      execute: true,
      action: "close",
      runId: "typed",
      root: "/does-not-exist",
      expectedGeneration: 1,
      expectedRowSha256: {
        toString() {
          assert.fail("must not coerce");
        },
      },
    }),
    failCode("options_invalid"),
  );
});

test("private symlinks and same-mode input inode replacement stop dispatch", async (t) => {
  const f = await fixture(t);
  f.seed();
  const key = path.join(f.root, ".local/cf03/production/owner-access-key");
  await fs.rename(key, key + "-original");
  await fs.symlink(key + "-original", key);
  await assert.rejects(f.run(), failCode("private_file_unsafe"));
  assert.equal(f.calls.length, 0);
  await fs.unlink(key);
  await fs.rename(key + "-original", key);
  f.intercept(async (url) => {
    if (url.endsWith(`/d1/database/${DATABASE}`)) {
      await fs.rename(key, key + "-original");
      await fs.writeFile(key, OWNER + "\n", { mode: 0o600 });
    }
  });
  await assert.rejects(f.run(), failCode("private_file_changed"));
  assert.equal(f.calls.length, 1);
});

test("same run IDs cannot be reused and operator lock blocks concurrent runs", async (t) => {
  const f = await fixture(t);
  await f.run({ runId: "same" });
  const count = f.calls.length;
  await assert.rejects(f.run({ runId: "same" }), failCode("run_exists"));
  assert.equal(f.calls.length, count);
  await fs.writeFile(
    path.join(f.root, ".local/cf03/production-auth.lock"),
    "lock",
    { mode: 0o600 },
  );
  await assert.rejects(f.run(), failCode("operator_locked"));
  assert.equal(f.calls.length, count);
});

test("lost state or lost receipt cannot reset an unresolved mutation", async (t) => {
  const f = await fixture(t);
  f.seed();
  f.intercept((url, init) => {
    if (init.body && JSON.parse(init.body).sql === AUTH_SQL.close)
      throw new Error("synthetic unknown");
  });
  await assert.rejects(
    f.run({ action: "close", runId: "lost-receipt", ...f.expected() }),
    failCode("mutation_unknown"),
  );
  const receipt = path.join(
    f.root,
    ".local/cf03/production-auth/lost-receipt.json",
  );
  await fs.unlink(receipt);
  await assert.rejects(
    f.run({ action: "close", runId: "lost-receipt", ...f.expected() }),
    failCode("run_exists"),
  );
  await f.run();
  const count = f.calls.length;
  await fs.unlink(path.join(f.root, ".local/cf03/production-auth-state.json"));
  await assert.rejects(f.run(), failCode("configuration_invalid"));
  assert.equal(f.calls.length, count);
});

test("private symlink, mode changes, ancestor replacement and input replacement stop dispatch", async (t) => {
  const f = await fixture(t);
  f.seed();
  await fs.chmod(
    path.join(f.root, ".local/cf03/production/owner-access-key"),
    0o644,
  );
  await assert.rejects(f.run(), failCode("private_file_unsafe"));
  assert.equal(f.calls.length, 0);
  await fs.chmod(
    path.join(f.root, ".local/cf03/production/owner-access-key"),
    0o600,
  );
  f.intercept(async (url) => {
    if (url.endsWith(`/d1/database/${DATABASE}`)) {
      const directory = path.join(f.root, ".local/cf03/production");
      await fs.rename(directory, directory + "-old");
      await fs.mkdir(directory, { mode: 0o700 });
    }
  });
  await assert.rejects(f.run(), failCode("private_path_changed"));
  assert.equal(f.calls.length, 1);
});

test("receipts/state retain neither secrets, verifier, SQL, session hash nor provider errors", async (t) => {
  const f = await fixture(t);
  f.seed();
  await f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() });
  const dir = path.join(f.root, ".local/cf03/production-auth");
  const names = await fs.readdir(dir);
  const content =
    (
      await Promise.all(
        names.map((n) => fs.readFile(path.join(dir, n), "utf8")),
      )
    ).join("\n") +
    (await fs.readFile(
      path.join(f.root, ".local/cf03/production-auth-state.json"),
      "utf8",
    ));
  for (const secret of [
    OWNER,
    PEPPER,
    SESSION,
    TOKEN,
    f.verifier,
    AUTH_SQL.enable,
  ])
    assert.ok(!content.includes(secret));
  for (const filename of names)
    assert.equal((await fs.stat(path.join(dir, filename))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
});

test("enable accepts matching official D1 database_id and legacy id aliases", async (t) => {
  const f = await fixture(t);
  f.seed();
  f.settings.bindings.find((binding) => binding.name === "DB").database_id =
    DATABASE;
  const result = await f.run({
    action: "enable",
    expectedVersion: VERSION,
    ...f.expected(),
  });
  assert.equal(result.requests, 11);
  assert.equal(result.auth.row.enabled, 1);
});

for (const [label, value] of [
  ["conflicting", "55555555-5555-4555-8555-555555555555"],
  ["number", 1],
  ["null", null],
  ["object", { id: DATABASE }],
])
  test(`enable rejects ${label} D1 database_id alias before CAS`, async (t) => {
    const f = await fixture(t);
    f.seed();
    f.settings.bindings.find((binding) => binding.name === "DB").database_id =
      value;
    await assert.rejects(
      f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() }),
      failCode("worker_precondition_failed"),
    );
    assert.equal(
      f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
      0,
    );
    assert.ok(
      f.calls.every(
        (call) =>
          !call.init.body || JSON.parse(call.init.body).sql !== AUTH_SQL.enable,
      ),
    );
  });

test("matching D1 aliases still reject unknown binding keys before CAS", async (t) => {
  const f = await fixture(t);
  f.seed();
  Object.assign(
    f.settings.bindings.find((binding) => binding.name === "DB"),
    {
      database_id: DATABASE,
      unexpected: "synthetic-extra-field",
    },
  );
  await assert.rejects(
    f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() }),
    failCode("worker_precondition_failed"),
  );
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config").get().enabled,
    0,
  );
});

for (const drift of ["added", "removed", "changed"])
  test(`enable rejects D1 alias ${drift} between full Worker observations`, async (t) => {
    const f = await fixture(t);
    f.seed();
    if (drift !== "added")
      f.settings.bindings.find((binding) => binding.name === "DB").database_id =
        DATABASE;
    let observations = 0;
    f.intercept((url) => {
      if (!url.endsWith("/settings")) return;
      if (++observations !== 2) return;
      const after = structuredClone(f.settings);
      const db = after.bindings.find((binding) => binding.name === "DB");
      if (drift === "removed") delete db.database_id;
      else
        db.database_id =
          drift === "changed"
            ? "55555555-5555-4555-8555-555555555555"
            : DATABASE;
      return response(after);
    });
    await assert.rejects(
      f.run({ action: "enable", expectedVersion: VERSION, ...f.expected() }),
      failCode("worker_precondition_failed"),
    );
    assert.equal(observations, 2);
    assert.equal(
      f.calls.filter(
        (call) =>
          call.init.body && JSON.parse(call.init.body).sql === AUTH_SQL.enable,
      ).length,
      1,
    );
    const state = JSON.parse(
      await fs.readFile(
        path.join(f.root, ".local/cf03/production-auth-state.json"),
        "utf8",
      ),
    );
    assert.equal(state.unresolved.length, 1);
  });
