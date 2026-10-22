import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { authorized, getRun, objectKey, readInput, reserve, storageProbe, runWorkflow, STEP_CONFIG, validateInput } from "../cloudflare/probe/core.mjs";
import { handle } from "../cloudflare/probe/handler.mjs";
import { mockFetch } from "../cloudflare/probe/mock.mjs";
import { classifyCryptoFailure, CryptoProbeError, cryptoProbe, safeCryptoFailureReason } from "../cloudflare/probe/crypto.mjs";
import { config } from "../scripts/cf-probe.mjs";

const TOKEN = "ab".repeat(32); // Public fixture; never deployed.
const schema = await readFile(new URL("../cloudflare/probe/schema.sql", import.meta.url), "utf8");
function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  return {
    sqlite,
    prepare(sql) { return { bind(...args) { return {
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    }; } }; },
  };
}
function bucket() {
  const values = new Map(), keys = [];
  return {
    keys, values,
    async put(key, text) { keys.push(key); assert.ok(text.length < 128); values.set(key, text); },
    async get(key, options) {
      keys.push(key);
      if (!values.has(key)) return null;
      const full = values.get(key);
      const text = options?.range ? full.slice(options.range.offset, options.range.offset + options.range.length) : full;
      return { size: Buffer.byteLength(text), text: async () => text };
    },
    async delete(key) { keys.push(key); values.delete(key); },
    async head(key) { keys.push(key); return values.has(key) ? {} : null; },
  };
}
function environment(wait = async () => {}) {
  const env = { CF_PROBE_TOKEN: TOKEN, CF_DB: d1(), CF_BUCKET: bucket() };
  const instances = new Map();
  const steps = [];
  const step = { async do(name, configuration, fn) { steps.push({ name, configuration }); return fn(); } };
  env.CF_MOCK = { fetch: (url, init) => mockFetch(new Request(url, init), env, wait) };
  env.CF_WORKFLOW = {
    creates: 0,
    async create({ id, params }) {
      this.creates++;
      const instance = { state: "running", promise: null };
      instances.set(id, instance);
      instance.promise = new Promise(resolve => setImmediate(resolve)).then(() => runWorkflow(env, params, step)).then(() => { instance.state = "complete"; });
      return { id };
    },
    async get(id) {
      if (!instances.has(id)) throw new Error("missing");
      return { async status() { return { status: instances.get(id).state }; }, async terminate() { await instances.get(id).promise; instances.get(id).state = "terminated"; } };
    },
  };
  return { env, instances, steps, step };
}
const request = (method, pathname, body, token = TOKEN) => new Request(`https://probe.example${pathname}`, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});
const send = (env, method, pathname, body, token) => handle(request(method, pathname, body, token), env, cryptoProbe);

test("health only is public; missing, weak or incorrect bearer rejects all diagnostic methods", async () => {
  const { env } = environment();
  assert.equal((await handle(new Request("https://probe.example/health"), env)).status, 200);
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.equal((await send(env, method, "/v1/runs", undefined, "wrong")).status, 401);
  }
  assert.equal(authorized(request("GET", "/v1/runs"), "short"), false);
  assert.equal(authorized(request("GET", "/v1/runs"), undefined), false);
  assert.equal(env.CF_DB.sqlite.prepare("SELECT COUNT(*) AS n FROM cf01_budget").get().n, 0);
});

test("JSON byte cap works with misleading or missing length; schema rejects arbitrary keys and endpoints", async () => {
  for (const bad of [null, [], {}, { runId: "../books", kind: "storage" }, { runId: randomUUID(), kind: "fetch" },
    { runId: randomUUID(), kind: "storage", objectKey: "books/private" },
    { runId: randomUUID(), kind: "storage", mode: "success" },
    { runId: randomUUID(), kind: "workflow", delaySeconds: 66, mode: "success" },
    { runId: randomUUID(), kind: "workflow", delaySeconds: 840, mode: "other" }]) {
    assert.throws(() => validateInput(bad));
  }
  assert.throws(() => objectKey("../../private"));
  await assert.rejects(readInput(request("POST", "/v1/runs", " ".repeat(513))), /body_too_large/);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600)); controller.close(); } });
  await assert.rejects(readInput(new Request("https://probe.example/v1/runs", { method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body: stream, duplex: "half" })), /body_too_large/);
  const { env } = environment();
  assert.equal((await send(env, "POST", "/v1/runs", "{" )).status, 400);
  assert.equal((await send(env, "GET", "/v1/runs?url=https://example.com")).status, 400);
  assert.equal((await send(env, "POST", "/anything", {})).status, 404);
});

// Historical fixture only: production storage admission stays permanently disabled.
function historicalStorage(db, id) {
  db.sqlite.prepare("INSERT INTO cf01_budget(run_id,kind,created_at,delay_seconds,mode) VALUES (?,'storage',?,0,'success')").run(id, Date.now());
}
test("storage entrypoints reject before D1/R2 while historical diagnostic cleanup remains available", async () => {
  let databaseCalls = 0, bucketCalls = 0;
  const blockedDb = { prepare() { databaseCalls++; throw Error("must not query"); } };
  const blockedBucket = new Proxy({}, { get() { bucketCalls++; throw Error("must not touch R2"); } });
  const id = randomUUID();
  await assert.rejects(reserve(blockedDb, {runId:id,kind:"storage"}), /legacy_storage_migration_required/);
  await assert.rejects(storageProbe({ CF_DB:blockedDb, CF_BUCKET:blockedBucket }, id), /legacy_storage_migration_required/);
  const response = await send({CF_PROBE_TOKEN:TOKEN,CF_DB:blockedDb,CF_BUCKET:blockedBucket}, "POST", "/v1/runs", {runId:id,kind:"storage"});
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {error:"legacy_storage_migration_required"});
  assert.deepEqual({databaseCalls,bucketCalls}, {databaseCalls:0,bucketCalls:0});
  const { env } = environment();
  historicalStorage(env.CF_DB,id);
  env.CF_DB.sqlite.prepare("UPDATE cf01_runs SET state='completed' WHERE run_id=?").run(id);
  env.CF_BUCKET.values.set(objectKey(id), "historical neutral fixture");
  assert.equal((await (await send(env,"GET",`/v1/runs/${id}`)).json()).run.run_id,id);
  assert.equal((await send(env,"DELETE",`/v1/runs/${id}`)).status,200);
  assert.equal(env.CF_BUCKET.values.size,0);
  assert.equal(await getRun(env.CF_DB,id),null);
  assert.equal(env.CF_DB.sqlite.prepare("SELECT count(*) AS n FROM cf01_budget").get().n,1);
  assert.equal((await send(env,"POST","/v1/runs",{runId:id,kind:"storage"})).status,409);
  assert.ok(env.CF_BUCKET.keys.every(key=>key===objectKey(id)));
});

test("persistent caps cannot be reset by cleanup; crypto caps are per algorithm", async () => {
  const { env } = environment();
  for (let i = 0; i < 4; i++) {
    const input = { runId: randomUUID(), kind: "storage" };
    historicalStorage(env.CF_DB, input.runId);
    env.CF_DB.sqlite.prepare("DELETE FROM cf01_runs WHERE run_id = ?").run(input.runId);
  }
  await assert.rejects(reserve(env.CF_DB, { runId: randomUUID(), kind: "storage" }), /legacy_storage_migration_required/);
  assert.equal(env.CF_DB.sqlite.prepare("SELECT count(*) AS n FROM cf01_budget WHERE kind='storage'").get().n,4);
  for (const kind of ["scrypt", "pbkdf2"]) {
    assert.equal(await reserve(env.CF_DB, { runId: randomUUID(), kind }), true);
    assert.equal(await reserve(env.CF_DB, { runId: randomUUID(), kind }), true);
    assert.equal(await reserve(env.CF_DB, { runId: randomUUID(), kind }), false);
  }
});

test("cleanup preserves historical running storage and removes only a terminal object", async () => {
  const { env } = environment();
  const id = randomUUID();
  historicalStorage(env.CF_DB,id);
  env.CF_DB.sqlite.prepare("UPDATE cf01_runs SET state='running' WHERE run_id=?").run(id);
  const rejected = await send(env,"DELETE",`/v1/runs/${id}`);
  assert.equal(rejected.status,409);
  assert.deepEqual(await rejected.json(),{error:"run_not_terminal"});
  assert.equal((await getRun(env.CF_DB,id)).state,"running");
  assert.equal(env.CF_BUCKET.keys.length,0);
  env.CF_DB.sqlite.prepare("UPDATE cf01_runs SET state='completed' WHERE run_id=?").run(id);
  env.CF_BUCKET.values.set(objectKey(id),"historical neutral fixture");
  assert.equal((await send(env,"DELETE",`/v1/runs/${id}`)).status,200);
  assert.equal(await getRun(env.CF_DB,id),null);
  assert.equal(env.CF_BUCKET.values.size,0);
});

test("reserved and running non-Workflow runs remain until a terminal state", async () => {
  for (const kind of ["storage", "scrypt", "pbkdf2"]) {
    const { env } = environment();
    const id = randomUUID();
    if (kind === "storage") historicalStorage(env.CF_DB,id);
    else await reserve(env.CF_DB, { runId: id, kind });
    for (const state of ["reserved", "running"]) {
      env.CF_DB.sqlite.prepare("UPDATE cf01_runs SET state = ? WHERE run_id = ?").run(state, id);
      const rejected = await send(env, "DELETE", `/v1/runs/${id}`);
      assert.equal(rejected.status, 409);
      assert.deepEqual(await rejected.json(), { error: "run_not_terminal" });
      assert.equal((await getRun(env.CF_DB, id)).state, state);
      assert.equal(env.CF_BUCKET.keys.length, 0);
    }
    env.CF_DB.sqlite.prepare("UPDATE cf01_runs SET state = 'failed' WHERE run_id = ?").run(id);
    assert.equal((await send(env, "DELETE", `/v1/runs/${id}`)).status, 200);
    assert.equal(await getRun(env.CF_DB, id), null);
  }
});

test("Workflow POST returns before independent mock network completes; GET sees running then completed", async () => {
  let unblock;
  const network = new Promise(resolve => { unblock = resolve; });
  const waits = [];
  const { env, instances, steps } = environment(async ms => { waits.push(ms); await network; });
  const id = randomUUID();
  const input = { runId: id, kind: "workflow", delaySeconds: 840, mode: "success" };
  assert.equal((await send(env, "POST", "/v1/runs", input)).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(waits, [840000]);
  const running = await (await send(env, "GET", `/v1/runs/${id}`)).json();
  assert.equal(running.run.state, "running");
  assert.equal(running.run.network_calls, 1);
  assert.equal(running.run.mock_calls, 1);
  assert.equal((await (await send(env, "POST", "/v1/runs", input)).json()).noResend, true);
  assert.equal(env.CF_WORKFLOW.creates, 1);
  assert.equal(await reserve(env.CF_DB, { ...input, runId: randomUUID() }), false);
  unblock();
  await instances.get(id).promise;
  assert.equal((await (await send(env, "GET", `/v1/runs/${id}`)).json()).run.state, "completed");
  assert.equal((await send(env, "DELETE", `/v1/runs/${id}`)).status, 200);
  assert.equal(await getRun(env.CF_DB, id), null);
  assert.ok(steps.length >= 3);
  for (const { configuration } of steps) {
    assert.equal(configuration.retries.limit, 0);
    assert.equal(configuration.timeout, "20 minutes");
  }
});

test("uncertain upstream is retained and cannot resend even if workflow callback is replayed", async () => {
  let calls = 0;
  const { env, instances, step } = environment(async () => { calls++; });
  const input = { runId: randomUUID(), kind: "workflow", delaySeconds: 65, mode: "uncertain" };
  await send(env, "POST", "/v1/runs", input);
  await instances.get(input.runId).promise;
  assert.equal((await getRun(env.CF_DB, input.runId)).state, "uncertain");
  await send(env, "POST", "/v1/runs", input);
  await runWorkflow(env, input, step);
  assert.equal(calls, 1);
  assert.equal(env.CF_WORKFLOW.creates, 1);
  assert.equal((await getRun(env.CF_DB, input.runId)).network_calls, 1);
  assert.equal((await getRun(env.CF_DB, input.runId)).mock_calls, 1);
});

test("creation ambiguity never creates a second Workflow, and mock rejects unreserved requests", async () => {
  const { env } = environment();
  let creates = 0;
  env.CF_WORKFLOW.create = async () => { creates++; throw new Error("connection lost"); };
  const input = { runId: randomUUID(), kind: "workflow", delaySeconds: 65, mode: "success" };
  assert.equal((await send(env, "POST", "/v1/runs", input)).status, 202);
  await send(env, "POST", "/v1/runs", input);
  assert.equal(creates, 1);
  assert.equal((await getRun(env.CF_DB, input.runId)).state, "uncertain");
  const result = await mockFetch(request("POST", "/wait", input), env, () => { throw new Error("must not wait"); });
  assert.equal(result.status, 409);
  assert.equal((await mockFetch(request("POST", "/wait", input, "bad"), env)).status, 401);
});

test("password probes retain existing scrypt strength and strong asynchronous PBKDF2", async () => {
  const scrypt = await cryptoProbe("scrypt");
  assert.equal(scrypt.verified, true);
  assert.equal(scrypt.N, 16384);
  assert.equal(scrypt.r, 8);
  assert.equal(scrypt.p, 1);
  const pbkdf2 = await cryptoProbe("pbkdf2");
  assert.equal(pbkdf2.verified, true);
  assert.equal(pbkdf2.iterations, 600000);
  assert.equal(pbkdf2.operations, 2);
  assert.equal(pbkdf2.cpuSource, "cloudflare_tail_or_analytics_only");
  assert.ok(pbkdf2.wallMs >= 0);
  assert.equal(pbkdf2.timerSource, "io_advancing_runtime_clock_not_cpu");
});

test("crypto failures use fixed codes, do not expose messages, and do not retry rejected KDFs", async () => {
  assert.equal(classifyCryptoFailure("pbkdf2", { name: "NotSupportedError", message: "Pbkdf2 failed: iteration counts above 100000 are not supported" }), "pbkdf2_iteration_limit");
  assert.equal(classifyCryptoFailure("scrypt", new Error("scrypt is not implemented")), "scrypt_unsupported");
  assert.equal(classifyCryptoFailure("pbkdf2", { name: "OperationError", message: "private unexpected details" }), "pbkdf2_operation_failed");
  assert.equal(safeCryptoFailureReason(new Error("private unexpected details")), "probe_failed");
  assert.equal(safeCryptoFailureReason(new CryptoProbeError("unapproved_private_value")), "probe_failed");
  const { env } = environment();
  const id = randomUUID();
  let calls = 0;
  const failingProbe = async () => { calls++; throw new CryptoProbeError("pbkdf2_iteration_limit"); };
  const input = { runId: id, kind: "pbkdf2" };
  const response = await handle(request("POST", "/v1/runs", input), env, failingProbe);
  const data = await response.json();
  assert.equal(data.run.state, "failed");
  assert.deepEqual(JSON.parse(data.run.result_json), { reason: "pbkdf2_iteration_limit" });
  await handle(request("POST", "/v1/runs", input), env, failingProbe);
  assert.equal(calls, 1);
  const unknown = await handle(request("POST", "/v1/runs", { runId: randomUUID(), kind: "pbkdf2" }), env, async () => { throw new Error("private unexpected details"); });
  const text = await unknown.text();
  assert.ok(!text.includes("private unexpected details"));
  assert.ok(text.includes("probe_failed"));
});

test("CLI rejects redirects disguised as origins and weak token; mock has no public deployment route", async () => {
  assert.throws(() => config({ CF_PROBE_TOKEN: "weak", CF_PROBE_URL: "https://probe.example" }));
  for (const url of ["http://probe.example", "https://a:b@probe.example", "https://probe.example/path", "https://probe.example?token=x"]) {
    assert.throws(() => config({ CF_PROBE_TOKEN: TOKEN, CF_PROBE_URL: url }));
  }
  assert.equal(config({ CF_PROBE_TOKEN: TOKEN, CF_PROBE_URL: "https://probe.example" }).origin, "https://probe.example");
  const mockConfig = JSON.parse(await readFile(new URL("../cloudflare/probe/wrangler.mock.example.json", import.meta.url), "utf8"));
  assert.equal(mockConfig.workers_dev, false);
  assert.equal(mockConfig.preview_urls, false);
  assert.equal(mockConfig.routes, undefined);
  assert.equal(STEP_CONFIG.retries.limit, 0);
});
