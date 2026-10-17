import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  auditAccountQuota,
  projectQuotaResponse,
  quotaPreview,
  quotaRequest,
  QUOTA_LIMITS,
} from "../scripts/cf-account-quota-audit.mjs";
const accountId = "a".repeat(32),
  token = "quota-test-placeholder-token";
const instant = new Date("2026-10-17T10:00:00.000Z");
const now = () => instant;
function body(label, overrides = {}) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            [label === "workers"
              ? "workersInvocationsAdaptive"
              : "d1AnalyticsAdaptiveGroups"]: [
              label === "workers"
                ? {
                    sum: { requests: 123 },
                    avg: { sampleInterval: 1 },
                    ...overrides,
                  }
                : { sum: { rowsRead: 456, rowsWritten: 7 }, ...overrides },
            ],
          },
        ],
      },
    },
    errors: null,
  };
}
async function directory(t) {
  const d = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "shelf-quota-test-"),
  );
  await fs.chmod(d, 0o700);
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}
const options = (runDirectory, fetcher) => ({
  accountId,
  token,
  runDirectory,
  now,
  execute: true,
  fetcher,
});

test("dry run does not inspect credentials, filesystem, or network", async () => {
  const result = await auditAccountQuota({
    now,
    fetcher: () => assert.fail("network"),
  });
  assert.equal(result.executed, false);
  assert.equal(result.managementRequests, 0);
  assert.equal(result.requests.length, 2);
  assert.deepEqual(result.limits, QUOTA_LIMITS);
});
test("fixed account/day/fields, no resource filters, dimensions, arbitrary query, or subscriptions", () => {
  const preview = quotaPreview(instant);
  assert.equal(preview.window.from, "2026-10-17T00:00:00.000Z");
  for (const item of preview.requests) {
    assert.doesNotMatch(
      item.query,
      /dimensions|scriptName|databaseId|queryBatch|subscription|__schema/,
    );
    const request = quotaRequest(item.label, accountId, preview.window);
    assert.equal(request.variables.a, accountId);
    assert.equal(item.method, "POST");
  }
  assert.deepEqual(quotaRequest("d1", accountId, preview.window).variables, {
    a: accountId,
    d: "2026-10-17",
  });
  assert.throws(() => quotaRequest("arbitrary", accountId, preview.window));
  assert.throws(() => quotaRequest("workers", "bad-account", preview.window));
  assert.throws(() =>
    quotaRequest("workers", accountId, {
      ...preview.window,
      from: "2026-10-16T00:00:00.000Z",
    }),
  );
  assert.throws(() => quotaPreview("not-a-date"));
  assert.throws(() => quotaPreview("2026-10-17T00:00:00Z"));
});
test("observed values never imply exact billing totals or current Free status", () => {
  const w = projectQuotaResponse("workers", body("workers"));
  assert.deepEqual(w.observedAggregate, { requests: 123 });
  assert.equal(w.complete, false);
  assert.equal(w.remaining, null);
  assert.equal(w.freeStatus, "unknown");
  assert.equal(w.sampling, "reported_interval_one");
  const sampled = projectQuotaResponse(
    "workers",
    body("workers", { avg: { sampleInterval: 2 } }),
  );
  assert.equal(sampled.sampling, "sampled_estimate");
  assert.equal(sampled.remaining, null);
  const d = projectQuotaResponse("d1", body("d1"));
  assert.equal(d.filterGranularity, "utc-day");
  assert.equal(d.sampling, "unknown");
  assert.equal(d.complete, false);
  assert.deepEqual(d.conditionalFreeDailyLimit, {
    rowsRead: 5000000,
    rowsWritten: 100000,
  });
});
test("missing, sampled metadata, empty, multiple, malformed, identifiers and GraphQL errors fail closed", () => {
  for (const value of [
    null,
    {},
    { errors: [{ message: "secret" }] },
    { data: null },
    body("workers", { sum: { requests: -1 } }),
    body("workers", { sum: { requests: 1.2 } }),
    body("workers", { avg: { sampleInterval: null } }),
    body("workers", { dimensions: { scriptName: "private" } }),
  ])
    assert.throws(() => projectQuotaResponse("workers", value));
  for (const groups of [
    [],
    [{ sum: { rowsRead: 1 } }],
    [
      body("d1").data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[0],
      body("d1").data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[0],
    ],
  ]) {
    const b = body("d1");
    b.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups = groups;
    assert.throws(() => projectQuotaResponse("d1", b));
  }
});
test("two exact POSTs, durable pre-reservation, private evidence and no replay", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const result = await auditAccountQuota(
    options(dir, async (url, init) => {
      const label = calls++ === 0 ? "workers" : "d1";
      assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "POST");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      const ledger = (await fs.readFile(path.join(dir, "ledger.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(ledger.at(-1).event, "reserve");
      assert.equal(ledger.at(-1).label, label);
      return new Response(JSON.stringify(body(label)));
    }),
  );
  assert.equal(calls, 2);
  assert.equal(result.managementRequests, 2);
  assert.equal(result.workers.freshness, "recent_observation");
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const contents = await fs.readFile(file, "utf8");
    assert.ok(!contents.includes(token));
    assert.ok(!contents.includes(accountId));
  }
  await assert.rejects(
    auditAccountQuota(options(dir, () => assert.fail("replay"))),
    /run_already_started/,
  );
});
test("transport failure, HTTP redirect, permission and GraphQL errors never retry or save their bodies", async (t) => {
  for (const failure of [
    () => {
      throw Error(`private:${token}`);
    },
    () => new Response(`private:${token}`, { status: 302 }),
    () => new Response(`private:${token}`, { status: 403 }),
    () => new Response(JSON.stringify({ errors: [{ message: token }] })),
  ]) {
    const dir = await directory(t);
    let calls = 0;
    const result = await auditAccountQuota(
      options(dir, async () => {
        calls++;
        return failure();
      }),
    );
    assert.equal(calls, 2);
    assert.equal(result.workers.observedAggregate, null);
    assert.equal(result.d1.remaining, null);
    assert.deepEqual((await fs.readdir(dir)).sort(), [
      "ledger.jsonl",
      "run-start.json",
      "summary.json",
    ]);
    assert.ok(
      !(await fs.readFile(path.join(dir, "summary.json"), "utf8")).includes(
        token,
      ),
    );
  }
});
test("response limit covers content-length and streamed bytes", async (t) => {
  for (const response of [
    () =>
      new Response("small", {
        headers: { "content-length": String(QUOTA_LIMITS.responseBytes + 1) },
      }),
    () => new Response("x".repeat(QUOTA_LIMITS.responseBytes + 1)),
  ]) {
    const dir = await directory(t);
    const result = await auditAccountQuota(options(dir, response));
    assert.ok(result.workers.completenessReasons.includes("response_limit"));
    assert.ok(result.d1.completenessReasons.includes("response_limit"));
    assert.ok(!(await fs.readdir(dir)).includes("workers.json"));
  }
});
test("canonical numeric evidence drops duplicate-key hidden content", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  await auditAccountQuota(
    options(dir, () => {
      const label = calls++ === 0 ? "workers" : "d1";
      return new Response(
        JSON.stringify(body(label)).replace(
          '"errors":null',
          `"errors":${JSON.stringify(token)},"errors":null`,
        ),
      );
    }),
  );
  assert.ok(
    !(await fs.readFile(path.join(dir, "workers.json"), "utf8")).includes(
      token,
    ),
  );
});
test("unsafe permissions and symlinks stop before any cloud request", async (t) => {
  const dir = await directory(t);
  await fs.chmod(dir, 0o755);
  await assert.rejects(
    auditAccountQuota(options(dir, () => assert.fail("network"))),
    /private_permissions/,
  );
  await fs.chmod(dir, 0o700);
  const link = path.join(dir, "link");
  await fs.symlink(dir, link);
  await assert.rejects(
    auditAccountQuota(options(link, () => assert.fail("network"))),
    /private_path/,
  );
});
test("evidence persistence failure stops further calls and leaves durable consumed reservation", async (t) => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, "workers.json"), "existing", {
    mode: 0o600,
  });
  let calls = 0;
  await assert.rejects(
    auditAccountQuota(
      options(dir, () => {
        calls++;
        return new Response(JSON.stringify(body("workers")));
      }),
    ),
    /evidence_persistence_failed/,
  );
  assert.equal(calls, 1);
  assert.equal(
    JSON.parse(
      (await fs.readFile(path.join(dir, "ledger.jsonl"), "utf8")).trim(),
    ).event,
    "reserve",
  );
});
test("ledger fsync failure prevents network and cannot be resumed", async (t) => {
  const dir = await directory(t),
    open = fs.open;
  let fileHandle;
  fs.open = async (...args) => {
    const h = await open(...args);
    if (String(args[0]).endsWith("ledger.jsonl")) {
      fileHandle = h;
      h.sync = async () => {
        throw Error("disk failure");
      };
    }
    return h;
  };
  try {
    await assert.rejects(
      auditAccountQuota(options(dir, () => assert.fail("network"))),
      /ledger_persistence_failed/,
    );
  } finally {
    fs.open = open;
    await fileHandle?.close();
  }
  await assert.rejects(
    auditAccountQuota(options(dir, () => assert.fail("replay"))),
    /run_already_started/,
  );
});
test("stale observations are explicit and crossing UTC midnight stops further HTTP", async (t) => {
  const dir = await directory(t);
  let clock = instant;
  const result = await auditAccountQuota({
    ...options(dir, () => {
      clock = new Date("2026-10-17T10:06:00Z");
      return new Response(JSON.stringify(body("workers")));
    }),
    now: () => clock,
  });
  assert.equal(result.workers.freshness, "stale_observation");
  assert.equal(result.workers.remaining, null);
  const dir2 = await directory(t);
  clock = instant;
  let calls = 0;
  await assert.rejects(
    auditAccountQuota({
      ...options(dir2, () => {
        calls++;
        clock = new Date("2026-10-18T00:00:00Z");
        return new Response(JSON.stringify(body("workers")));
      }),
      now: () => clock,
    }),
    /utc_day_changed/,
  );
  assert.equal(calls, 1);
});
test("fixed 30-second abort signal terminates pending transport without retry", async (t) => {
  const dir = await directory(t),
    timeout = AbortSignal.timeout;
  const requestedTimeouts = [];
  let calls = 0;
  AbortSignal.timeout = (ms) => {
    requestedTimeouts.push(ms);
    return timeout(5);
  };
  // Keep the test event loop alive; native AbortSignal timeout timers are unreferenced.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await auditAccountQuota(
      options(dir, async (_url, { signal }) => {
        calls++;
        return await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      }),
    );
    assert.equal(calls, 2);
    assert.deepEqual(requestedTimeouts, [30000, 30000]);
    assert.equal(result.workers.observedAggregate, null);
    assert.equal(result.d1.observedAggregate, null);
  } finally {
    AbortSignal.timeout = timeout;
    clearInterval(keepAlive);
  }
});
