import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditR2Account,
  projectR2Observation,
  projectVoltCondition,
  parseVoltConfig,
  r2ObservationRequest,
  parseR2AuditArgs,
  R2_AUDIT_LIMITS,
} from "../scripts/cf-r2-account-audit.mjs";

const NOW = Date.parse("2026-10-21T01:02:03.000Z");
const ACCOUNT = "a".repeat(32),
  TOKEN = "synthetic-secret-not-for-output";
const WORKER = "synthetic-worker";
const configuration = { accountId: ACCOUNT, token: TOKEN };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const settings = (bindings = []) => ({
  success: true,
  result: { bindings },
  errors: [],
  messages: [],
});
const storage = (time = NOW - 60_000, bytes = 17) => ({
  dimensions: {
    datetime: new Date(time).toISOString(),
    storageClass: "Standard",
  },
  max: { payloadSize: bytes, metadataSize: 3 },
});
const operation = (actionType = "PutObject", requests = 5) => ({
  dimensions: { actionType, storageClass: "Standard" },
  sum: { requests },
});
function aggregate(overrides = {}) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            accountStorage: [storage()],
            shelfStorage: [storage()],
            accountOperations: [
              operation(),
              operation("GetObject", 7),
              operation("DeleteObject", 2),
            ],
            shelfOperations: [operation()],
            ...overrides,
          },
        ],
      },
    },
  };
}
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-r2-audit-test-")),
  );
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf03"), { mode: 0o700 });
  const report = path.join(root, ".local/cf03/volt-r2-recheck.json"),
    volt = path.join(root, "volt.jsonc");
  await fs.writeFile(
    report,
    JSON.stringify({ ok: true, accountMatches: true, worker: WORKER }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    volt,
    JSON.stringify({ account_id: ACCOUNT, name: WORKER }),
    { mode: 0o644 },
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    report,
    volt,
    options: {
      execute: true,
      runId: "one",
      projectRoot: root,
      voltConfigPath: volt,
      config: configuration,
      environment: {},
      clock: () => NOW,
    },
  };
}
async function evidence(f) {
  const dir = path.join(f.root, ".local/r2-account-audit/one");
  const names = await fs.readdir(dir);
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await fs.readFile(path.join(dir, name), "utf8"),
      mode: (await fs.stat(path.join(dir, name))).mode & 0o777,
    })),
  );
}

test("preview and CLI expose no credentials and never load files or send", async () => {
  assert.deepEqual(parseR2AuditArgs(["--execute", "--run-id", "one"]), {
    execute: true,
    runId: "one",
  });
  for (const args of [
    ["--execute", "--execute"],
    ["--run-id", "../escape"],
    ["--endpoint", "x"],
  ])
    assert.throws(() => parseR2AuditArgs(args));
  const out = await auditR2Account({
    projectRoot: "/does-not-exist",
    environment: {},
    fetchImpl: () => assert.fail("preview sent"),
  });
  assert.equal(out.status, "preview");
  assert.equal(out.uploadEligible, false);
  assert.equal(out.limits.requests, 2);
});
test("fixed .env account accepts inherited token without copying it to a file; conflicts and CI refuse before network", async (t) => {
  const f = await fixture(t);
  const envFile = path.join(f.root, ".env");
  const fileContents = `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\n`;
  await fs.writeFile(envFile, fileContents, { mode: 0o600 });
  let calls = 0;
  const result = await auditR2Account({
    ...f.options,
    config: undefined,
    environment: { CLOUDFLARE_API_TOKEN: TOKEN },
    fetchImpl: async (_url, request) => {
      calls++;
      assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
      return json(calls === 1 ? settings() : aggregate());
    },
  });
  assert.equal(result.status, "observed_incomplete");
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(envFile, "utf8"), fileContents);
  assert.ok(
    !(await evidence(f))
      .map((v) => v.text)
      .join("")
      .includes(TOKEN),
  );
  for (const environment of [
    { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) },
    { CLOUDFLARE_API_TOKEN: TOKEN, CI: "true" },
    {
      CI: "true",
      SHELF_CF_AUTO_DEPLOY: "true",
      SHELF_CF_DEPLOY_TOKEN: TOKEN,
      SHELF_CF_ACCOUNT_ID: ACCOUNT,
    },
  ]) {
    const stopped = await auditR2Account({
      ...f.options,
      config: undefined,
      environment,
      fetchImpl: () => assert.fail("conflicting account or CI sent"),
    });
    assert.equal(stopped.code, "configuration");
    assert.equal(stopped.managementRequests, 0);
  }
});
test("JSONC local precondition handles strings/comments/trailing commas and rejects R2/account uncertainty", () => {
  const config = parseVoltConfig(
    `//comment\n{"account_id":"${ACCOUNT}","name":"${WORKER}","unused":"https://x.invalid/*not-comment*/,]","env":{"preview":{}},}`,
  );
  const report = { ok: true, accountMatches: true, worker: WORKER };
  const condition = projectVoltCondition(config, report, ACCOUNT);
  assert.equal(condition.accountMatches, true);
  assert.equal(condition.localR2Absent, true);
  for (const extra of [
    { account_id: "b".repeat(32) },
    { r2_buckets: [{}] },
    { env: { preview: { r2_buckets: [{}] } } },
    { env: { preview: { account_id: "b".repeat(32) } } },
    { r2_buckets: {} },
  ])
    assert.throws(() =>
      projectVoltCondition({ ...config, ...extra }, report, ACCOUNT),
    );
  for (const source of ["/*unfinished", '"unfinished', "{bad}"])
    assert.throws(() => parseVoltConfig(source));
});
test("GraphQL selects fixed bucket/numeric dimensions only, preserves actual sample age and max never becomes total", () => {
  const request = r2ObservationRequest(ACCOUNT, NOW);
  assert.equal(request.variables.m, "2026-10-01T00:00:00.000Z");
  assert.equal(request.variables.t, new Date(NOW).toISOString());
  assert.ok(
    !/\b(?:objectName|accountName|bucketId|bucketName\s*\}|subscriptions)\b/.test(
      request.query,
    ),
  );
  assert.equal((request.query.match(/bucketName:/g) || []).length, 2);
  assert.ok(!request.query.includes(TOKEN));
  assert.ok(!/objectCount|uploadCount/.test(request.query));
  const out = projectR2Observation(
    aggregate({
      accountStorage: [storage(NOW - 60_000, 99), storage(NOW - 3600_000, 17)],
    }),
    NOW,
  );
  assert.equal(out.accountStorage.totalBytes, null);
  assert.equal(out.accountStorage.aggregation, "max_not_total");
  assert.equal(out.accountStorage.observedMaxima[0].ageMs, 60_000);
  assert.equal(out.accountStorage.observedMaxima[1].fresh, false);
  assert.equal(
    out.accountStorage.observedMaxima[1].sampleAt,
    new Date(NOW - 3600_000).toISOString(),
  );
  assert.equal(out.fetchedAt, new Date(NOW).toISOString());
  assert.equal(out.uploadEligible, false);
  assert.equal(out.completeCoverage, false);
  assert.equal(out.plan, "unknown");
  assert.equal(out.accountEvidence, null);
  assert.deepEqual(out.accountOperations.observedCounts, {
    classA: 5,
    classB: 7,
    free: 2,
    unclassified: 0,
  });
});
test("empty datasets never become zero, future samples/unexpected fields/GraphQL errors fail sanitized", () => {
  const out = projectR2Observation(
    aggregate({ accountStorage: [], accountOperations: [] }),
    NOW,
  );
  assert.equal(out.accountStorage.totalBytes, null);
  assert.equal(out.accountOperations.observedCounts, null);
  assert.equal(out.accountOperations.empty, true);
  for (const body of [
    aggregate({ accountStorage: [storage(NOW + 1)] }),
    { errors: [{ message: TOKEN }], data: null },
    aggregate({ accountStorage: [{ ...storage(), bucketName: TOKEN }] }),
    { data: { viewer: { accounts: [] } } },
  ])
    assert.throws(
      () => projectR2Observation(body, NOW),
      (e) => !String(e).includes(TOKEN),
    );
  const unknown = projectR2Observation(
    aggregate({ accountOperations: [operation(TOKEN, 9)] }),
    NOW,
  );
  assert.equal(unknown.accountOperations.observedCounts.unclassified, 9);
  assert.ok(!JSON.stringify(unknown).includes(TOKEN));
  const saturated = projectR2Observation(
    aggregate({
      accountStorage: Array.from({ length: 1000 }, () => storage()),
    }),
    NOW,
  );
  assert.equal(saturated.accountStorage.limitReached, true);
  assert.equal(saturated.completeCoverage, false);
});
test("two fixed reads are pre-registered; raw Volt settings/IDs/values never reach evidence", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await auditR2Account({
    ...f.options,
    fetchImpl: async (url, req) => {
      calls++;
      assert.equal(req.redirect, "error");
      assert.ok(req.signal instanceof AbortSignal);
      assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`);
      const files = await evidence(f);
      assert.ok(files.some((v) => v.name === `${calls}-pending.json`));
      if (calls === 1) {
        assert.equal(req.method, "GET");
        assert.equal(
          url,
          `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/settings`,
        );
        return json(
          settings([
            {
              type: "plain_text",
              name: "private-binding",
              text: "private-value",
            },
          ]),
        );
      }
      assert.equal(req.method, "POST");
      assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
      assert.deepEqual(
        JSON.parse(req.body),
        r2ObservationRequest(ACCOUNT, NOW),
      );
      return json(aggregate());
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "observed_incomplete");
  assert.equal(result.managementRequests, 2);
  assert.equal(result.uploadEligible, false);
  const output =
    JSON.stringify(result) +
    (await evidence(f))
      .map((v) => {
        assert.equal(v.mode, 0o600);
        return v.text;
      })
      .join("");
  for (const value of [
    TOKEN,
    ACCOUNT,
    WORKER,
    "private-binding",
    "private-value",
  ])
    assert.ok(!output.includes(value));
  assert.equal(
    (await fs.stat(path.join(f.root, ".local/r2-account-audit/one"))).mode &
      0o777,
    0o700,
  );
  const again = await auditR2Account({
    ...f.options,
    fetchImpl: () => assert.fail("run retried"),
  });
  assert.equal(again.code, "run_exists");
  assert.equal(again.managementRequests, 0);
});
test("local missing/mismatched/R2-enabled Volt stops before any remote account observation", async (t) => {
  for (const variant of [
    "mismatch",
    "r2",
    "report",
    "symlink",
    "permissions",
  ]) {
    const f = await fixture(t);
    if (variant === "mismatch")
      await fs.writeFile(
        f.volt,
        JSON.stringify({ account_id: "b".repeat(32), name: WORKER }),
      );
    if (variant === "r2")
      await fs.writeFile(
        f.volt,
        JSON.stringify({ account_id: ACCOUNT, name: WORKER, r2_buckets: [{}] }),
      );
    if (variant === "report") await fs.rm(f.report);
    if (variant === "symlink") {
      await fs.rename(f.report, f.report + ".real");
      await fs.symlink(f.report + ".real", f.report);
    }
    if (variant === "permissions") await fs.chmod(f.report, 0o644);
    const result = await auditR2Account({
      ...f.options,
      fetchImpl: () => assert.fail("unsafe condition sent"),
    });
    assert.equal(result.status, "stopped");
    assert.equal(result.managementRequests, 0);
  }
});
test("remote Volt R2 or unknown settings stops at one fixed request", async (t) => {
  for (const response of [
    settings([{ type: "r2_bucket", bucket_name: "private-bucket" }]),
    settings([{}]),
    { success: false, result: {}, errors: [{ message: TOKEN }] },
  ]) {
    const f = await fixture(t);
    let calls = 0;
    const result = await auditR2Account({
      ...f.options,
      fetchImpl: async () => {
        calls++;
        return json(response);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "stopped");
    assert.equal(result.managementRequests, 1);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(
      !(await evidence(f))
        .map((v) => v.text)
        .join("")
        .includes("private-bucket"),
    );
  }
});
test("HTTP errors, malformed JSON and redirect/final URL rejection never retry or log error body", async (t) => {
  for (const variant of ["http", "json", "redirect", "url", "throw", "large"]) {
    const f = await fixture(t);
    let calls = 0;
    const result = await auditR2Account({
      ...f.options,
      fetchImpl: async () => {
        calls++;
        if (variant === "throw") throw new Error(TOKEN);
        if (variant === "json")
          return new Response(TOKEN, {
            headers: { "content-type": "application/json" },
          });
        if (variant === "http") return json({ error: TOKEN }, 503);
        if (variant === "large")
          return new Response(
            new Uint8Array(R2_AUDIT_LIMITS.responseBytes + 1),
            { headers: { "content-type": "application/json" } },
          );
        const r = json(settings());
        Object.defineProperty(
          r,
          variant === "redirect" ? "redirected" : "url",
          { value: variant === "redirect" ? true : "https://other.invalid" },
        );
        return r;
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "stopped");
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(
      !(await evidence(f))
        .map((v) => v.text)
        .join("")
        .includes(TOKEN),
    );
  }
});
test("deadline bounds fetch and response streams even when cancellation hangs; late response is discarded", async (t) => {
  for (const variant of ["fetch", "stream"]) {
    const f = await fixture(t);
    let release,
      cancelled = 0,
      signal;
    const result = await auditR2Account({
      ...f.options,
      timeoutMs: 10,
      fetchImpl: async (_, req) => {
        signal = req.signal;
        if (variant === "fetch")
          return new Promise((resolve) => {
            release = resolve;
          });
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
              return new Promise(() => {});
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    assert.equal(result.code, "deadline");
    assert.equal(result.managementRequests, 1);
    assert.ok(signal.aborted);
    if (release) {
      release(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
              return new Promise(() => {});
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(cancelled >= 1);
  }
});
test("private evidence symlinks and hardlinks fail before the next request", async (t) => {
  for (const variant of ["symlink", "hardlink"]) {
    const f = await fixture(t);
    let calls = 0;
    const result = await auditR2Account({
      ...f.options,
      fetchImpl: async () => {
        calls++;
        const start = path.join(
          f.root,
          ".local/r2-account-audit/one/run-start.json",
        );
        if (variant === "hardlink") await fs.link(start, start + ".extra");
        else {
          await fs.rename(start, start + ".real");
          await fs.symlink(start + ".real", start);
        }
        return json(settings());
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "stopped");
    assert.equal(result.uploadEligible, false);
  }
});
