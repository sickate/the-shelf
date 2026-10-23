import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  createSamplerManager,
  buildSamplerCostBasis,
  SAMPLER_TABLES,
  SAMPLER_SCHEMA_HASH,
} from "../scripts/cf-cpu-sampler-manager.mjs";
import {
  CHECK,
  runSampler,
  SAMPLER_MANIFEST,
  validateSamplerPlan,
} from "../scripts/cf-cpu-sampler.mjs";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import { createOwnerVerifier } from "../cloudflare/library/security.mjs";
const versionId = "11111111-2222-4333-8444-555555555555",
  dbid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const accountId = "a".repeat(32),
  token = "SYNTHETIC-TOKEN-NEVER-LOG-THIS";
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
  worker = base + "/workers/scripts/" + CHECK.name,
  database = base + "/d1/database/" + dbid;
const key = Buffer.alloc(32, 17).toString("base64url"),
  pepper = Buffer.alloc(32, 18).toString("base64url"),
  secret = Buffer.alloc(32, 19).toString("base64url");
const target = { ...CHECK, databaseId: dbid, versionId };
function setupPlan() {
  const basis = buildSamplerCostBasis(
    Object.fromEntries(SAMPLER_TABLES.map((name) => [name, 4])),
  );
  const plan = {
    schemaVersion: 1,
    scope: "check",
    workerName: CHECK.name,
    origin: CHECK.origin,
    versionId,
    deployConfig: {
      schemaVersion: 1,
      profiles: {
        check: { databaseId: dbid, databaseName: CHECK.databaseName },
        production: {
          databaseId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
          databaseName: "the-shelf-library",
        },
      },
    },
    limits: {
      business: 42,
      management: 30,
      d1: 20,
      analytics: 9,
      rowsRead: 100000,
      rowsWritten: 15000,
    },
    costs: basis.costs,
    timeoutMs: 1000,
    spacingMs: 1100,
    analyticsAttempts: 3,
    analyticsDelayMs: 0,
  };
  return {
    plan,
    costBasis: {
      schemaHash: basis.schemaHash,
      maxRows: basis.maxRows,
      reviewed: true,
    },
  };
}
async function fixture(
  t,
  {
    migrate = true,
    override,
    nonce = "0123456789abcdef0123456789abcdef",
    timeout = 1000,
    sink,
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    await fs.readFile(
      new URL("../cloudflare/library/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  if (migrate)
    db.exec(
      await fs.readFile(
        new URL(
          "../cloudflare/library/migrations/002-conservative-storage.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  if (!migrate) {
    const old = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='reserve_upload'")
      .get()
      .sql.replace("observed_account_bytes+committed_bytes", "committed_bytes");
    db.exec("DROP TRIGGER reserve_upload");
    db.exec(old);
  }
  let now = Date.UTC(2026, 9, 16, 0, 0, 1),
    enabled = false;
  const verifier = await createOwnerVerifier(key, pepper, {
    scope: "check",
    origin: CHECK.origin,
  });
  db.prepare("INSERT INTO auth_config VALUES(?,?,?,?,?,?,?)").run(
    "check",
    CHECK.origin,
    "owner-access-key-v1",
    verifier,
    1,
    0,
    now,
  );
  const calls = [],
    evidence = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(
      [
        database,
        database + "/query",
        worker + "/deployments",
        worker + "/subdomain",
        "https://api.cloudflare.com/client/v4/graphql",
      ].includes(url),
    );
    if (override) {
      const result = await override(url, options, { db, calls });
      if (result !== undefined) return result;
    }
    let result;
    if (url === database) result = { uuid: dbid, name: CHECK.databaseName };
    else if (url === worker + "/deployments")
      result = {
        deployments: [
          { versions: [{ version_id: versionId, percentage: 100 }] },
        ],
      };
    else if (url === worker + "/subdomain") {
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        assert.deepEqual(Object.keys(body).sort(), [
          "enabled",
          "previews_enabled",
        ]);
        assert.equal(body.previews_enabled, false);
        enabled = body.enabled;
      }
      result = { enabled, previews_enabled: false };
    } else if (url === database + "/query") {
      const payload = JSON.parse(options.body);
      assert.deepEqual(Object.keys(payload), ["batch"]);
      assert.ok(Array.isArray(payload.batch));
      db.exec("BEGIN");
      try {
        result = payload.batch.map((statement, i) => {
          assert.deepEqual(Object.keys(statement), ["sql", "params"]);
          assert.ok(Array.isArray(statement.params));
          // Real generated SQL/constraints/triggers execute here. Meta below is an
          // explicitly synthetic provider envelope, not a platform billing measurement.
          const before = db.prepare("SELECT total_changes() n").get().n;
          const results = db.prepare(statement.sql).all(...statement.params);
          const changes =
            db.prepare("SELECT total_changes() n").get().n - before;
          return {
            success: true,
            results,
            meta: { rows_read: i + 1, rows_written: changes },
          };
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        return Response.json(
          { success: false, errors: [{ message: error.message }] },
          { status: 400 },
        );
      }
    } else
      return Response.json({
        data: { viewer: { accounts: [{ aggregate: [], groups: [] }] } },
      });
    return Response.json({ success: true, result });
  };
  const { plan, costBasis } = setupPlan();
  plan.timeoutMs = timeout;
  const options = {
    accountId,
    token,
    plan,
    costBasis,
    runNonce: nonce,
    fetchImpl,
    clock: () => now,
    evidenceSink: async (entry) => {
      evidence.push(entry);
      if (sink) await sink(entry);
    },
  };
  const manager = createSamplerManager(options);
  const call = (command, payload = {}) =>
    manager.manage(command, {
      target,
      payload,
      signal: new AbortController().signal,
    });
  return {
    db,
    calls,
    evidence,
    options,
    manager,
    call,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    getNow: () => now,
  };
}
async function preflight(f) {
  await f.call("inspectVersion");
  await f.call("inspectDatabaseIdentity");
  const inspected = await f.call("inspectDatabase");
  await f.call("inspectEntry");
  return inspected;
}
async function enable(f) {
  const inspected = await preflight(f);
  await f.call("enableAuth", { expectedGeneration: inspected.data.generation });
  return f.call("seedMaintenance", {
    limits: { admissions: 64, daily: 8, minute: 128, sessions: 32 },
    batches: 2,
  });
}
const prepare = (round) => ({
  round,
  bookId: `cf03-sampler-${round}`,
  fileId: `cf03-sampler-${round}-file`,
  expectedGeneration: 2,
  unknownCategory: "Cloud Test New Category",
});

test("manager requires reviewed matching cost basis, complete plan and explicit credentials before HTTP", () => {
  const { plan, costBasis } = setupPlan();
  const baseOptions = {
    accountId,
    token,
    plan,
    costBasis,
    offlineTest: true,
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  };
  assert.throws(
    () =>
      createSamplerManager({
        ...baseOptions,
        costBasis: { ...costBasis, reviewed: false },
      }),
    /reviewed_cost_basis_required/,
  );
  assert.throws(
    () =>
      createSamplerManager({
        ...baseOptions,
        costBasis: { ...costBasis, schemaHash: "bad" },
      }),
    /cost_basis_mismatch/,
  );
  assert.throws(
    () => createSamplerManager({ ...baseOptions, accountId: "wrong" }),
    /invalid_credentials/,
  );
  assert.throws(
    () =>
      createSamplerManager({
        ...baseOptions,
        plan: {
          ...plan,
          costs: { ...plan.costs, business: { rowsRead: 1, rowsWritten: 1 } },
        },
      }),
    /cost_basis_mismatch/,
  );
  assert.throws(
    () => createSamplerManager({ ...baseOptions, fetchImpl: undefined }),
    /private_evidence_sink_required/,
  );
  assert.equal(SAMPLER_SCHEMA_HASH.length, 64);
  assert.equal(validateSamplerPlan(plan).needed.rowsWritten < 15000, true);
});
test("every target and payload is fixed; unknown command/SQL/production/URL sends zero HTTP", async (t) => {
  const f = await fixture(t);
  for (const [command, payload] of [
    ["query", { sql: "DROP TABLE sessions" }],
    ["inspectVersion", { url: "https://evil.test" }],
    ["enableAuth", { expectedGeneration: 1, scope: "production" }],
    ["seedMaintenance", { limits: {}, batches: 20 }],
    ["prepareRound", { ...prepare("first-access"), bookId: "private-book" }],
  ])
    await assert.rejects(f.call(command, payload));
  await assert.rejects(
    f.manager.manage("inspectVersion", {
      target: { ...target, scope: "production" },
      payload: {},
      signal: new AbortController().signal,
    }),
  );
  await assert.rejects(
    f.manager.manage("inspectVersion", {
      target: {
        ...target,
        databaseId: f.options.plan.deployConfig.profiles.production.databaseId,
      },
      payload: {},
      signal: new AbortController().signal,
    }),
  );
  assert.equal(f.calls.length, 0);
});
test("preflight verifies real sqlite_master including 002, identity, closed auth and complete row meta", async (t) => {
  const f = await fixture(t);
  const result = await preflight(f);
  assert.equal(result.data.schemaVersion, 2);
  assert.equal(result.data.authEnabled, false);
  assert.equal(f.calls.length, 4);
  const batch = JSON.parse(f.calls[2].options.body).batch;
  assert.ok(batch[0].sql.includes("sqlite_master"));
  const n = batch.length;
  assert.equal(result.meta.rowsRead, (n * (n + 1)) / 2);
  assert.equal(result.meta.rowsWritten, 0);
  assert.equal(f.evidence.length, 4);
  assert.equal(JSON.stringify(result).includes(token), false);
  for (const migrate of [false]) {
    const old = await fixture(t, { migrate });
    await old.call("inspectVersion");
    await old.call("inspectDatabaseIdentity");
    await assert.rejects(old.call("inspectDatabase"), /schema_drift/);
    assert.equal(old.calls.length, 3);
  }
  const drift = await fixture(t);
  drift.db.exec("CREATE INDEX wrong_extra ON sessions(generation)");
  await drift.call("inspectDatabaseIdentity");
  await assert.rejects(drift.call("inspectDatabase"), /schema_drift/);
});
test("schema/cardinality/identity/version/entry drift fails before any mutation", async (t) => {
  const capped = await fixture(t);
  capped.db.exec(
    "INSERT INTO catalog_books(scope,book_id,public_json) VALUES('check','a','{}'),('check','b','{}'),('check','c','{}'),('check','d','{}'),('check','e','{}')",
  );
  await capped.call("inspectDatabaseIdentity");
  await assert.rejects(
    capped.call("inspectDatabase"),
    /cardinality_bound_exceeded/,
  );
  for (const kind of ["version", "identity", "entry"]) {
    const f = await fixture(t, {
      override: (url) => {
        if (kind === "version" && url.endsWith("/deployments"))
          return Response.json({
            success: true,
            result: {
              deployments: [
                {
                  versions: [
                    { version_id: versionId, percentage: 50 },
                    { version_id: "other", percentage: 50 },
                  ],
                },
              ],
            },
          });
        if (kind === "identity" && url === database)
          return Response.json({
            success: true,
            result: { uuid: dbid, name: "production" },
          });
        if (kind === "entry" && url.endsWith("/subdomain"))
          return Response.json({
            success: true,
            result: { enabled: true, previews_enabled: false },
          });
      },
    });
    await assert.rejects(preflight(f));
    assert.equal(
      f.calls.some(
        (c) => c.options.method === "POST" && !c.url.endsWith("/query"),
      ),
      false,
    );
    assert.equal(
      f.db.prepare("SELECT enabled FROM auth_config WHERE scope='check'").get()
        .enabled,
      0,
    );
  }
});
test("actual generated seed SQL uses normal triggers, two full batches, unique old windows and summed write meta", async (t) => {
  const f = await fixture(t);
  const seeded = await enable(f);
  assert.ok(seeded.data.counts.admissions >= 128);
  assert.ok(seeded.data.counts.daily >= 16);
  assert.ok(seeded.data.counts.minute >= 256);
  assert.ok(seeded.data.counts.sessions >= 64);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM admissions WHERE scope='check'").get()
      .n,
    128,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sessions WHERE scope='check'").get().n,
    64,
  );
  assert.equal(
    f.db
      .prepare("SELECT max(count) n FROM counters WHERE kind='session_day'")
      .get().n,
    32,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count FROM counters WHERE kind='api_minute' AND bucket='global'",
      )
      .get().count,
    128,
  );
  assert.equal(seeded.meta.rowsWritten > 500, true);
  const used = f.calls.length;
  await assert.rejects(
    f.call("seedMaintenance", {
      limits: { admissions: 64, daily: 8, minute: 128, sessions: 32 },
      batches: 2,
    }),
    /mutation_already_attempted/,
  );
  assert.equal(f.calls.length, used);
  const before = f.db.prepare("SELECT sum(count) n FROM counters").get().n;
  await f.call("closeAuth");
  await f.call("verifyAuthClosed");
  assert.equal(
    f.db.prepare("SELECT sum(count) n FROM counters").get().n,
    before,
    "shutdown preserves consumed budgets",
  );
});
test("old historical window conflict aborts the whole seed batch and never rewrites counters", async (t) => {
  const f = await fixture(t);
  await preflight(f);
  await f.call("enableAuth", { expectedGeneration: 1 });
  const day =
    Math.floor(f.getNow() / 86400000) -
    1024 -
    (parseInt(f.options.runNonce.slice(0, 6), 16) % 4096);
  f.db
    .prepare(
      "INSERT INTO counters VALUES('check','api_day','global',?,17,1000)",
    )
    .run(day);
  await assert.rejects(
    f.call("seedMaintenance", {
      limits: { admissions: 64, daily: 8, minute: 128, sessions: 32 },
      batches: 2,
    }),
    /management_rejected/,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM admissions").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sessions").get().n, 0);
  assert.equal(
    f.db.prepare("SELECT count FROM counters WHERE kind='api_day'").get().count,
    17,
  );
});
test("fixed book fixtures reject old book/metadata/file state and never reset versions or true counters", async (t) => {
  const f = await fixture(t);
  await enable(f);
  const first = await f.call("prepareRound", prepare("first-access"));
  assert.equal(first.data.fixtureInserted, 1);
  assert.equal(first.data.metadataVersion, 0);
  const n = f.calls.length;
  await assert.rejects(f.call("prepareRound", prepare("first-access")));
  assert.equal(f.calls.length, n);
  const old = await fixture(t);
  await enable(old);
  old.db
    .prepare("INSERT INTO catalog_books VALUES('check',?,?)")
    .run("cf03-sampler-first-access", "{}");
  await assert.rejects(
    old.call("prepareRound", prepare("first-access")),
    /management_rejected/,
  );
  assert.equal(
    old.db
      .prepare(
        "SELECT public_json FROM catalog_books WHERE book_id='cf03-sampler-first-access'",
      )
      .get().public_json,
    "{}",
  );
});
test("permissions, quota, unknown errors, redirects, missing meta, malformed/oversized responses are bounded and sanitized", async (t) => {
  for (const kind of [
    "403",
    "429",
    "secret",
    "redirect",
    "missingmeta",
    "json",
    "declaredsize",
    "chunksize",
  ]) {
    const f = await fixture(t, {
      override: (url, options) => {
        if (kind === "403" || kind === "429")
          return Response.json(
            { errors: [{ message: token }] },
            { status: Number(kind) },
          );
        if (kind === "secret") throw new Error(token);
        if (kind === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.test/" + token },
          });
        if (kind === "missingmeta")
          return Response.json({
            success: true,
            result: [{ success: true, results: [] }],
          });
        if (kind === "json") return new Response("{" + token);
        if (kind === "declaredsize")
          return new Response("{}", {
            headers: { "content-length": "1048577" },
          });
        return new Response("x".repeat(1048577));
      },
    });
    const command =
      kind === "missingmeta" ? "inspectDatabase" : "inspectVersion";
    if (command === "inspectDatabase") {
      // Identity precondition is obtained from a separate mocked first call.
      const original = f.options.fetchImpl;
      let first = true;
      const manager = createSamplerManager({
        ...f.options,
        fetchImpl: async (url, opts) => {
          if (first) {
            first = false;
            return Response.json({
              success: true,
              result: { uuid: dbid, name: CHECK.databaseName },
            });
          }
          return original(url, opts);
        },
      });
      await manager.manage("inspectDatabaseIdentity", {
        target,
        payload: {},
        signal: new AbortController().signal,
      });
      await assert.rejects(
        manager.manage(command, {
          target,
          payload: {},
          signal: new AbortController().signal,
        }),
        (error) => !String(error).includes(token),
      );
    } else
      await assert.rejects(
        f.call(command),
        (error) => !String(error).includes(token),
      );
    assert.equal(f.calls.length, 1, kind);
  }
});
test("abort before dispatch sends nothing; timeout/abort during fetch dispatch once, no automatic retry", async (t) => {
  const f = await fixture(t, {
    timeout: 20,
    override: (url, options) =>
      new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(new Error(token)),
          { once: true },
        ),
      ),
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.manager.manage("inspectVersion", {
      target,
      payload: {},
      signal: abort.signal,
    }),
    /management_aborted/,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.call("inspectVersion"), /management_timeout/);
  assert.equal(f.calls.length, 1);
  const active = new AbortController();
  const pending = f.manager.manage("inspectVersion", {
    target,
    payload: {},
    signal: active.signal,
  });
  active.abort();
  await assert.rejects(pending, (error) => !String(error).includes(token));
  assert.equal(f.calls.length, 2);
});

test("real manager SQL and real Worker complete 42 requests with rowid-bound CAS and two full maintenance proofs", async (t) => {
  const f = await fixture(t);
  // This historical sampler verifies the frozen original admissions/schema contract.
  // Current Worker metadata reads additionally need empty lifecycle tables. Install
  // only these two tables in this metadata-only fixture, not the 007 access trigger:
  // dedicated management tests apply and verify the COMPLETE 007 security migration.
  const managementSql = await fs.readFile(
    new URL(
      "../cloudflare/library/migrations/007-book-management.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const managementTables = [
    ...managementSql.matchAll(/CREATE TABLE IF NOT EXISTS[\s\S]*?\n\);/g),
  ].map((match) => match[0]);
  assert.equal(managementTables.length, 2);
  for (const table of managementTables) f.db.exec(table);

  const originalNow = Date.now;
  Date.now = f.getNow;
  t.after(() => {
    Date.now = originalNow;
  });
  let readers = [];
  const DB = {
    prepare(text) {
      const make = (params) => ({
        bind: (...args) => make(args),
        execute: () => ({
          success: true,
          results: f.db.prepare(text).all(...params),
        }),
        async first() {
          const row = f.db.prepare(text).get(...params) ?? null;
          if (text.includes("COALESCE(o.version,0)"))
            await new Promise((resolve) => {
              readers.push(resolve);
              if (readers.length === 2) {
                const ready = readers;
                readers = [];
                ready.forEach((done) => done());
              }
            });
          return row;
        },
        async run() {
          return f.db.prepare(text).run(...params);
        },
        async all() {
          return { results: f.db.prepare(text).all(...params) };
        },
      });
      return make([]);
    },
    async batch(statements) {
      f.db.exec("BEGIN");
      try {
        const rows = statements.map((s) => s.execute());
        f.db.exec("COMMIT");
        return rows;
      } catch (error) {
        f.db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env = {
    APP_SCOPE: "check",
    SITE_ORIGIN: CHECK.origin,
    OWNER_KEY_PEPPER: pepper,
    SESSION_SECRET: secret,
    DB,
    R2_ACCOUNT_ID: accountId,
    R2_BUCKET: "the-shelf-books",
    R2_ACCESS_KEY_ID: "synthetic-access",
    R2_SECRET_ACCESS_KEY: "synthetic-secret",
    BOOKS: {
      async head() {
        throw new Error("No R2 access allowed");
      },
    },
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-manager-"));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const result = await runSampler({
    plan: f.options.plan,
    execute: true,
    environment: {},
    accessKey: key,
    receipt: { root, file: path.join(root, ".local/receipt.json") },
    adapters: {
      manage: f.manager.manage,
      clock: f.clock,
      connect: async () => ({
        protocol: "h2",
        async close() {},
        async request(request) {
          requests.push(request);
          const response = await handleRequest(
            new Request(CHECK.origin + request.path, {
              method: request.method,
              headers: { ...request.headers, "CF-Connecting-IP": "192.0.2.1" },
              ...(request.body === undefined ? {} : { body: request.body }),
            }),
            env,
          );
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          };
        },
      }),
    },
  });
  assert.equal(
    result.ok,
    true,
    JSON.stringify({
      error: result.error,
      cleanup: result.cleanup,
      counts: result.rounds.map((r) => r.requests.length),
    }),
  );
  assert.equal(requests.length, 42);
  assert.equal(result.cpuGate, "unknown");
  assert.equal(result.ledger.maintenanceBatchesReserved, 2);
  assert.deepEqual(
    result.rounds.map((r) => r.coverage.maintenanceOrdinals),
    [[1], [32]],
  );
  assert.deepEqual(
    result.rounds.map((r) => r.coverage.metadataAdmissions),
    [2, 2],
  );
  for (const round of result.rounds)
    assert.deepEqual(round.coverage.deleted, {
      admissions: 64,
      daily: 8,
      minute: 128,
      sessions: 32,
    });
  assert.equal(f.calls.length, result.ledger.management);
  assert.equal(f.evidence.length, f.calls.length);
  assert.equal(result.ledger.analytics, 9);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(result).includes("sqlite_master"), false);
});

test("closing is terminal: same manager never reopens or resumes collection after either shutdown attempt", async (t) => {
  for (const first of ["closeAuth", "closeEntry"]) {
    const f = await fixture(t);
    await enable(f);
    await f.call(first);
    const count = f.calls.length;
    for (const [command, payload] of [
      ["enableAuth", { expectedGeneration: 3 }],
      ["prepareRound", prepare("first-access")],
      [
        "seedMaintenance",
        {
          limits: { admissions: 64, daily: 8, minute: 128, sessions: 32 },
          batches: 2,
        },
      ],
    ])
      await assert.rejects(f.call(command, payload), /manager_closing/);
    assert.equal(f.calls.length, count);
    if (first === "closeEntry") await f.call("closeAuth");
    else await f.call("closeEntry");
    await f.call("verifyAuthClosed");
    await f.call("verifyEntryClosed");
  }
});
async function analyticsReady(f) {
  await enable(f);
  for (const [index, round] of ["first-access", "subsequent"].entries()) {
    const snapshot = await f.call("prepareRound", {
      ...prepare(round),
      expectedGeneration: 2 + index,
    });
    await f.call("rotateGeneration", { expectedGeneration: 2 + index });
    await f.call("readCoverage", {
      round,
      cutoff: snapshot.data.cutoff,
      day: snapshot.data.day,
      bookId: prepare(round).bookId,
    });
  }
  const requests = SAMPLER_MANIFEST.map((row, i) => ({
    sequence: i + 1,
    branch: row.branch,
    versionId,
    startedAt: new Date(f.getNow() + i * 1000 + 100).toISOString(),
    endedAt: new Date(f.getNow() + i * 1000 + 200).toISOString(),
  }));
  return {
    window: "first-access",
    from: new Date(Date.parse(requests[0].startedAt) - 2000).toISOString(),
    to: new Date(Date.parse(requests.at(-1).endedAt) + 2000).toISOString(),
    expectedRequests: 21,
    requests,
  };
}
test("analytics preserves valid high aggregate despite bad group identity, keeps raw privately and never invents missing metrics", async (t) => {
  const { analyzeCpuEvidence } = await import("../scripts/cf-cpu-evidence.mjs");
  for (const variant of [
    "bad-group",
    "missing-dimensions",
    "null-group",
    "missing-quantile",
    "multiple-aggregate",
  ]) {
    const f = await fixture(t, {
      override: (url, options) => {
        if (!url.endsWith("/graphql")) return;
        const row = {
          dimensions: { scriptName: CHECK.name, scriptVersion: versionId },
          avg: { sampleInterval: 1 },
          sum: { requests: 21, errors: 0 },
          quantiles: { cpuTimeP50: 2000, cpuTimeP95: 11000, cpuTimeP99: 12000 },
          max: { cpuTime: 12000 },
        };
        if (variant === "missing-quantile") delete row.quantiles.cpuTimeP50;
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  aggregate:
                    variant === "multiple-aggregate"
                      ? [row, structuredClone(row)]
                      : [row],
                  groups: [
                    variant === "null-group"
                      ? null
                      : {
                          ...structuredClone(row),
                          dimensions:
                            variant === "missing-dimensions"
                              ? undefined
                              : {
                                  scriptName: CHECK.name,
                                  scriptVersion:
                                    variant === "bad-group"
                                      ? "PRIVATE-OTHER-VERSION"
                                      : versionId,
                                  datetime: "2026-10-16T00:00:01Z",
                                  status: "ok",
                                },
                        },
                  ],
                },
              ],
            },
          },
        });
      },
    });
    const payload = await analyticsReady(f);
    const result = await f.call("analytics", payload);
    if (["bad-group", "missing-dimensions", "null-group"].includes(variant)) {
      assert.equal(result.data.aggregate.cpuTimeP95, 11000);
      assert.equal(result.data.groups[0].versionId, "invalid-version");
      assert.equal(
        JSON.stringify(result).includes("PRIVATE-OTHER-VERSION"),
        false,
      );
      assert.equal(
        analyzeCpuEvidence({ ...result.data, requests: payload.requests }).gate
          .status,
        "fail",
      );
      assert.equal(
        JSON.stringify(f.evidence.at(-1)).includes("PRIVATE-OTHER-VERSION"),
        variant === "bad-group",
      );
    } else if (variant === "missing-quantile") {
      assert.equal(Object.hasOwn(result.data.aggregate, "cpuTimeP50"), false);
      assert.equal(
        analyzeCpuEvidence({ ...result.data, requests: payload.requests }).gate
          .status,
        "unknown",
      );
    } else {
      assert.equal(result.data.aggregate, undefined);
      assert.equal(
        analyzeCpuEvidence({ ...result.data, requests: payload.requests }).gate
          .status,
        "unknown",
      );
    }
  }
});
test("analytics rejects arbitrary windows/labels before HTTP and key ordering does not change cost validation", async (t) => {
  const f = await fixture(t);
  const payload = await analyticsReady(f);
  const count = f.calls.length;
  for (const bad of [
    { ...payload, from: "2026-10-15T00:00:00.000Z" },
    { ...payload, window: "production" },
    {
      ...payload,
      requests: payload.requests.map((r, i) =>
        i ? r : { ...r, branch: "https://evil.test" },
      ),
    },
  ])
    await assert.rejects(f.call("analytics", bad));
  assert.equal(f.calls.length, count);
  const reordered = structuredClone(f.options.plan);
  reordered.costs = Object.fromEntries(
    Object.entries(reordered.costs)
      .reverse()
      .map(([k, v]) => [
        k,
        { rowsWritten: v.rowsWritten, rowsRead: v.rowsRead },
      ]),
  );
  assert.doesNotThrow(() =>
    createSamplerManager({ ...f.options, plan: reordered }),
  );
});

test("nontransactional provider partial seed failure is unknown, never replayed or rolled back, and shutdown remains available", async (t) => {
  const f = await fixture(t, {
    override: (url, options, { db }) => {
      if (url !== database + "/query") return;
      const batch = JSON.parse(options.body).batch;
      if (!batch.some((row) => row.sql.includes("WHERE i<128"))) return;
      // Deliberately emulate a provider that commits only guard+admissions, then
      // fails. This is a failure model, not a claim about Cloudflare atomicity.
      for (const statement of batch.slice(0, 2))
        db.prepare(statement.sql).all(...statement.params);
      return Response.json(
        { success: false, errors: [{ message: token }] },
        { status: 400 },
      );
    },
  });
  await preflight(f);
  await f.call("enableAuth", { expectedGeneration: 1 });
  const payload = {
    limits: { admissions: 64, daily: 8, minute: 128, sessions: 32 },
    batches: 2,
  };
  await assert.rejects(
    f.call("seedMaintenance", payload),
    /management_rejected/,
  );
  assert.equal(f.db.prepare("SELECT count(*) n FROM admissions").get().n, 128);
  const calls = f.calls.length;
  await assert.rejects(
    f.call("seedMaintenance", payload),
    /mutation_already_attempted/,
  );
  assert.equal(f.calls.length, calls);
  await f.call("closeAuth");
  await f.call("closeEntry");
  await f.call("verifyAuthClosed");
  await f.call("verifyEntryClosed");
  assert.equal(f.db.prepare("SELECT count(*) n FROM admissions").get().n, 128);
  assert.equal(
    f.db.prepare("SELECT enabled FROM auth_config WHERE scope='check'").get()
      .enabled,
    0,
  );
});
