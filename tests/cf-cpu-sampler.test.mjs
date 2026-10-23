import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import {
  runSampler,
  validateSamplerPlan,
  samplerEnvironment,
  SAMPLER_MANIFEST,
  MANAGEMENT_COMMANDS,
  CHECK,
} from "../scripts/cf-cpu-sampler.mjs";
import { connectSamplerH2 } from "../scripts/cf-cpu-sampler-h2.mjs";
import { baseEnvironment } from "../scripts/cf-deploy.mjs";
const versionId = "11111111-2222-4333-8444-555555555555";
const checkId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ownerKey = Buffer.alloc(32, 7).toString("base64url");
const privateSecret = "DO-NOT-LEAK-COOKIE-URL-OR-EXCEPTION";
function plan() {
  return {
    schemaVersion: 1,
    scope: "check",
    workerName: CHECK.name,
    origin: CHECK.origin,
    versionId,
    deployConfig: {
      schemaVersion: 1,
      profiles: {
        check: { databaseId: checkId, databaseName: CHECK.databaseName },
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
    costs: Object.fromEntries(
      [
        "business",
        "maintenance",
        ...Object.keys(MANAGEMENT_COMMANDS).filter(
          (key) => MANAGEMENT_COMMANDS[key] === "d1",
        ),
      ].map((key) => [key, { rowsRead: 1000, rowsWritten: 100 }]),
    ),
    timeoutMs: 1000,
    spacingMs: 1100,
    analyticsAttempts: 3,
    analyticsDelayMs: 0,
  };
}
async function fixture(t, tweaks = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-sampler-"));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let instant = Date.UTC(2026, 9, 16, 0, 0, 1),
    generation = 1,
    round = 0,
    count = 0,
    concurrent = 0,
    maxConcurrent = 0,
    connects = 0,
    ordinal = tweaks.initialOrdinal ?? 0;
  let maintenance = { admissions: 128, daily: 16, minute: 256, sessions: 64 };
  const calls = [],
    requests = [],
    controller = new AbortController();
  const adapters = {
    clock: {
      now: () => instant,
      sleep: async (ms) => {
        instant += ms;
      },
    },
    async manage(command, { target, payload, signal }) {
      calls.push(command);
      assert.equal(target.databaseId, checkId);
      assert.equal(target.name, CHECK.name);
      assert.ok(signal);
      if (tweaks.manage) {
        const override = await tweaks.manage(command, {
          target,
          payload,
          signal,
          calls,
        });
        if (override !== undefined) return override;
      }
      let data;
      switch (command) {
        case "inspectVersion":
          data = { versionId };
          break;
        case "inspectDatabaseIdentity":
          data = { databaseId: checkId, databaseName: CHECK.databaseName };
          break;
        case "inspectEntry":
          data = { enabled: false, previewsEnabled: false };
          break;
        case "inspectDatabase":
          data = {
            databaseId: checkId,
            databaseName: CHECK.databaseName,
            scope: "check",
            origin: CHECK.origin,
            schemaVersion: 2,
            authEnabled: false,
            entryEnabled: false,
            previewEnabled: false,
            generation,
            activeSessions: 0,
            observationActive: false,
          };
          break;
        case "enableAuth":
          data = { enabled: true, generation: ++generation };
          break;
        case "seedMaintenance":
          data = { counts: { ...maintenance } };
          break;
        case "enableEntry":
          data = { enabled: true, previewsEnabled: false };
          break;
        case "prepareRound":
          count = 0;
          round++;
          data = {
            fixtureInserted: 1,
            metadataVersion: 0,
            ordinal,
            metadataAdmissions: 0,
            day: "2026-10-16",
            cutoff: Date.UTC(2026, 9, 16),
            maintenance: { ...maintenance },
          };
          break;
        case "rotateGeneration":
          data = { generation: ++generation };
          break;
        case "readCoverage": {
          const old = ordinal;
          ordinal += 20;
          if (
            Array.from({ length: 20 }, (_, i) => old + i + 1).some(
              (n) => n === 1 || n % 32 === 0,
            )
          ) {
            const deleted = tweaks.maintenanceDeleted ?? {
              admissions: 64,
              daily: 8,
              minute: 128,
              sessions: 32,
            };
            maintenance = Object.fromEntries(
              Object.entries(maintenance).map(([kind, n]) => [
                kind,
                n - deleted[kind],
              ]),
            );
          }
          data = {
            ordinal,
            metadataAdmissions: tweaks.casAdmissions ?? 2,
            day: "2026-10-16",
            cutoff: Date.UTC(2026, 9, 16),
            maintenance: { ...maintenance },
            sessionRows: 2,
            hashedSessionRows: 2,
          };
          break;
        }
        case "analytics": {
          assert.equal(
            requests.length,
            42,
            "analytics must follow BOTH complete rounds",
          );
          const metrics = {
            cpuTimeP50: 2000,
            cpuTimeP95: 4500,
            cpuTimeP99: 6000,
            cpuTimeMax: 7000,
          };
          const groups = new Map();
          for (const request of payload.requests) {
            const second = new Date(
              Math.floor(Date.parse(request.startedAt) / 1000) * 1000,
            ).toISOString();
            groups.set(second, (groups.get(second) || 0) + 1);
          }
          data = {
            versionEvidence: "platform-dimension",
            cpuUnit: "microseconds",
            query: { groupLimit: 1000, groupsTruncated: false },
            clockUncertaintyMs: 0,
            sampling: { sampleInterval: 1 },
            aggregate: {
              workerName: CHECK.name,
              versionId,
              from: payload.from,
              to: payload.to,
              requests: payload.requests.length,
              errors: 0,
              ...metrics,
            },
            groups: [...groups].map(([datetime, requests]) => ({
              workerName: CHECK.name,
              versionId,
              datetime,
              status: "ok",
              requests,
              errors: 0,
              ...metrics,
            })),
          };
          if (tweaks.analytics) data = tweaks.analytics(data, payload);
          break;
        }
        case "closeAuth":
          data = { enabled: false, generation: ++generation };
          break;
        case "verifyAuthClosed":
          data = {
            enabled: false,
            activeSessions: 0,
            observationActive: false,
            generation,
          };
          break;
        case "closeEntry":
        case "verifyEntryClosed":
          data = { enabled: false, previewsEnabled: false };
          break;
        default:
          throw new Error("unhandled fixture command");
      }
      return {
        data,
        ...(MANAGEMENT_COMMANDS[command] === "d1"
          ? { meta: { rowsRead: 3, rowsWritten: 1 } }
          : {}),
      };
    },
    async connect({ origin }) {
      assert.equal(origin, CHECK.origin);
      connects++;
      return {
        protocol: "h2",
        async close() {
          calls.push("transportClosed");
        },
        async request(request) {
          count++;
          const n = count;
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          requests.push(request);
          calls.push(`http-${round}-${n}`);
          try {
            await Promise.resolve();
            instant += 10;
            if (tweaks.request) {
              const override = await tweaks.request(n, request, controller);
              if (override !== undefined) return override;
            }
            const status = Array.isArray(SAMPLER_MANIFEST[n - 1].expectedStatus)
              ? n === 13
                ? 200
                : 409
              : SAMPLER_MANIFEST[n - 1].expectedStatus;
            let data = {};
            if (n === 1) data = { ok: true };
            if ([2, 17, 18, 21].includes(n)) data = { authenticated: false };
            if (n === 10) data = { authenticated: true };
            if ([9, 20].includes(n))
              data = {
                authenticated: true,
                csrfToken: Buffer.alloc(32, 8).toString("base64url"),
              };
            if (n === 15)
              data = {
                metadataVersion: 1,
                book: {
                  title: "First edit",
                  category: "Cloud Test New Category",
                  files: [{ reason: "not_uploaded" }],
                },
              };
            return {
              status,
              headers: {
                "cache-control": "no-store",
                ...(n === 9 || n === 20
                  ? {
                      "set-cookie": `__Host-shelf_session=${Buffer.alloc(32, 9).toString("base64url")}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
                    }
                  : {}),
                "cf-ray": "0123456789abcdef-SJC",
                date: new Date(instant).toUTCString(),
              },
              body: Buffer.from(JSON.stringify(data)),
            };
          } finally {
            concurrent--;
          }
        },
      };
    },
    ...(tweaks.beforeCheckpoint
      ? { beforeCheckpoint: tweaks.beforeCheckpoint }
      : {}),
  };
  const receipt = { root, file: path.join(root, ".local/receipt.json") };
  const options = {
    plan: plan(),
    execute: true,
    accessKey: ownerKey,
    environment: { PATH: "/bin" },
    adapters,
    receipt,
    signal: controller.signal,
  };
  return {
    options,
    adapters,
    calls,
    requests,
    root,
    receipt,
    controller,
    stats: () => ({ maxConcurrent, connects }),
  };
}

test("default dry-run validates fixed targets and full bounded costs without adapter calls", async () => {
  const result = await runSampler({ plan: plan() });
  assert.equal(result.dryRun, true);
  assert.equal(result.needed.business, 42);
  assert.equal(result.needed.analytics, 9);
  assert.equal(result.cleanupReserve, 4);
  for (const mutate of [
    (p) => (p.workerName = "the-shelf"),
    (p) => (p.origin = "https://evil.test"),
    (p) => (p.versionId = "latest"),
    (p) => (p.scope = "production"),
    (p) =>
      (p.deployConfig.profiles.check.databaseId =
        p.deployConfig.profiles.production.databaseId),
    (p) => (p.limits.business = 41),
    (p) => (p.limits.management = 5),
    (p) => (p.limits.rowsRead = 500),
    (p) => (p.costs.business.rowsRead = 0),
    (p) => (p.costs.closeAuth.rowsWritten = NaN),
    (p) => (p.analyticsAttempts = 4),
  ]) {
    const value = plan();
    mutate(value);
    assert.throws(() => validateSamplerPlan(value));
  }
});
test("minimal environment preserves local status, blocks every CI marker, drops ambient secrets/options", async (t) => {
  const safe = samplerEnvironment(
    {
      PATH: "/bin",
      NODE_OPTIONS: "--require bad",
      HTTP_PROXY: "bad",
      CLOUDFLARE_API_TOKEN: privateSecret,
    },
    "/tmp/sampler",
  );
  assert.equal(safe.PATH, "/bin");
  assert.equal(safe.CI, undefined);
  assert.equal(safe.NODE_OPTIONS, undefined);
  assert.equal(safe.CLOUDFLARE_API_TOKEN, undefined);
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "BUILDKITE",
    "CIRCLECI",
    "TF_BUILD",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
  ])
    assert.throws(
      () => samplerEnvironment({ [key]: "false" }, "/tmp/sampler"),
      /local_operator_required/,
    );
  const f = await fixture(t);
  f.options.environment = baseEnvironment({}, "/tmp/sampler");
  await assert.rejects(runSampler(f.options), /local_operator_required/);
  assert.deepEqual(f.calls, []);
});
test("collects fixed 21+21, real proof contract, one connection and simultaneous CAS before three-window analytics", async (t) => {
  const f = await fixture(t);
  const result = await runSampler(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.cpuGate, "pass");
  assert.equal(result.ledger.business, 42);
  assert.equal(f.stats().connects, 1);
  assert.equal(f.stats().maxConcurrent, 2);
  assert.equal(result.rounds.length, 2);
  assert.deepEqual(
    result.rounds.flatMap((r) => r.requests.map((r) => r.sequence)),
    Array.from({ length: 42 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    result.rounds.map((r) => r.requests.length),
    [21, 21],
  );
  assert.deepEqual(
    result.rounds.map((r) => r.coverage.maintenanceOrdinals),
    [[1], [32]],
  );
  for (const round of result.rounds) {
    assert.equal(round.coverage.fullBatch, true);
    assert.deepEqual(round.coverage.deleted, {
      admissions: 64,
      daily: 8,
      minute: 128,
      sessions: 32,
    });
  }
  assert.equal(
    f.calls.indexOf("analytics") > f.calls.indexOf("http-2-21"),
    true,
  );
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.cleanup.authClosed, true);
  const stat = await fs.stat(f.receipt.file);
  assert.equal(stat.mode & 0o777, 0o600);
  const text = await fs.readFile(f.receipt.file, "utf8");
  for (const secret of [
    ownerKey,
    privateSecret,
    "__Host-shelf_session",
    "csrfToken",
    "First edit",
    "/api/",
    "https://",
  ])
    assert.equal(text.includes(secret), false, secret);
  assert.equal(JSON.parse(text).ledger.business, 42);
});
test("early stale CAS proof fails after complete request 21 and preserves full window", async (t) => {
  const f = await fixture(t, { casAdmissions: 1 });
  const result = await runSampler(f.options);
  assert.equal(result.error, "both_metadata_mutations_did_not_reach_cas");
  assert.equal(result.rounds[0].requests.length, 21);
  assert.equal(result.rounds[0].requests.at(-1).branch, "generation-session");
  assert.equal(f.calls.includes("analytics"), false);
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.cpuGate, "unknown");
});
test("version and database preflight failure never mutate unverified resources", async (t) => {
  for (const command of [
    "inspectVersion",
    "inspectDatabaseIdentity",
    "inspectDatabase",
    "inspectEntry",
  ]) {
    const f = await fixture(t, {
      manage: (name) =>
        name === command
          ? {
              data: {},
              ...(name === "inspectDatabase"
                ? { meta: { rowsRead: 1, rowsWritten: 0 } }
                : {}),
            }
          : undefined,
    });
    const result = await runSampler(f.options);
    assert.equal(result.ok, false);
    assert.equal(result.cleanup.complete, true);
    assert.equal(
      f.calls.some((name) =>
        ["enableAuth", "closeAuth", "closeEntry"].includes(name),
      ),
      false,
    );
    assert.equal(f.requests.length, 0);
  }
});
test("HTTP timeout, invalid JSON, assertion failure, interruption all retain reservations and close check", async (t) => {
  for (const kind of ["timeout", "json", "assert", "abort", "secret"]) {
    const f = await fixture(t, {
      request: async (n, request, controller) => {
        if (n !== 1) return;
        if (kind === "timeout") return new Promise(() => {});
        if (kind === "abort") {
          controller.abort();
          return new Promise(() => {});
        }
        if (kind === "secret") throw new Error(privateSecret);
        return {
          status: 200,
          headers: { "cache-control": "no-store" },
          body: Buffer.from(kind === "json" ? "{" : "{}"),
        };
      },
    });
    f.options.plan.timeoutMs = 20;
    const result = await runSampler(f.options);
    assert.equal(result.ok, false, kind);
    assert.equal(result.ledger.business, 1, kind);
    assert.equal(result.rounds[0].requests[0].endedAt !== null, true);
    assert.equal(result.cleanup.complete, true, kind);
    assert.equal(JSON.stringify(result).includes(privateSecret), false);
  }
});
test("management timeout remains bounded, cleanup ignores external abort, cleanup failures stay explicit", async (t) => {
  const f = await fixture(t, {
    manage: (name, { signal }) => {
      if (name === "enableAuth") return new Promise(() => {});
      if (name === "closeEntry") throw new Error(privateSecret);
    },
  });
  f.options.plan.timeoutMs = 20;
  const result = await runSampler(f.options);
  assert.equal(result.error, "operation_aborted");
  assert.equal(result.cleanup.complete, false);
  assert.ok(result.cleanup.errors.includes("closeEntry_failed"));
  assert.ok(f.calls.includes("verifyEntryClosed"));
  assert.equal(JSON.stringify(result).includes(privateSecret), false);
});
test("receipt failure after enable never prevents independent bounded shutdown", async (t) => {
  let failed = false;
  const f = await fixture(t, {
    beforeCheckpoint: (record) => {
      if (record.ledger.management >= 6) {
        failed = true;
        throw new Error(privateSecret);
      }
    },
  });
  const result = await runSampler(f.options);
  assert.equal(failed, true);
  assert.equal(result.error, "receipt_write_failed");
  assert.equal(result.receiptFailure, true);
  assert.equal(result.ok, false);
  assert.equal(result.cleanup.complete, true);
  assert.ok(f.calls.includes("closeAuth"));
  assert.ok(f.calls.includes("verifyEntryClosed"));
});
test("unknown analytics retries only fixed windows, never replays business or hides high CPU", async (t) => {
  const f = await fixture(t, {
    analytics: (data) => ({
      ...data,
      aggregate: { ...data.aggregate, requests: 3 },
      groups: [],
    }),
  });
  const result = await runSampler(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.cpuGate, "unknown");
  assert.equal(result.ledger.business, 42);
  assert.equal(result.ledger.analytics, 9);
  assert.equal(result.analytics.length, 9);
  const high = await fixture(t, {
    analytics: (data) => ({
      ...data,
      aggregate: { ...data.aggregate, cpuTimeP95: 6000 },
    }),
  });
  const second = await runSampler(high.options);
  assert.equal(second.cpuGate, "fail");
  assert.equal(second.ledger.analytics, 3);
  assert.equal(second.analytics[0].analysis.aggregate.p95Ms, 6);
});
test("maintenance requires actual before/after full bounds and ordinal proof", async (t) => {
  const f = await fixture(t, {
    manage: (command) =>
      command === "readCoverage"
        ? {
            data: {
              ordinal: 20,
              metadataAdmissions: 2,
              day: "2026-10-16",
              cutoff: Date.UTC(2026, 9, 16),
              maintenance: { admissions: 0, daily: 0, minute: 0, sessions: 0 },
              sessionRows: 2,
              hashedSessionRows: 2,
            },
            meta: { rowsRead: 1, rowsWritten: 0 },
          }
        : undefined,
  });
  const result = await runSampler(f.options);
  assert.equal(result.error, "invalid_maintenance_proof");
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.rounds[0].requests.length, 21);
});
test("one actual full batch fails after all 42 HTTP requests despite two reserved and seeded batches", async (t) => {
  const f = await fixture(t, { initialOrdinal: 10 });
  const result = await runSampler(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.error, "maintenance_batches_incomplete");
  assert.equal(result.cpuGate, "unknown");
  assert.equal(result.ledger.business, 42);
  assert.equal(result.ledger.maintenanceBatchesReserved, 2);
  assert.deepEqual(
    result.rounds.map((r) => r.requests.length),
    [21, 21],
  );
  assert.deepEqual(
    result.rounds.map((r) => r.coverage.maintenanceOrdinals),
    [[], [32]],
  );
  assert.deepEqual(
    result.rounds.map((r) => [
      r.coverage.ordinalBefore,
      r.coverage.ordinalAfter,
    ]),
    [
      [10, 30],
      [30, 50],
    ],
  );
  assert.equal(f.calls.includes("analytics"), false);
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.cleanup.authClosed, true);
  assert.equal(result.cleanup.entryClosed, true);
  assert.equal(f.calls.filter((c) => c === "rotateGeneration").length, 2);
  const receipt = JSON.parse(await fs.readFile(f.receipt.file, "utf8"));
  assert.deepEqual(
    receipt.rounds.map((r) => r.requests.length),
    [21, 21],
  );
  assert.equal(receipt.error, "maintenance_batches_incomplete");
});
test("zero executed and partially executed maintenance batches never count as full proofs", async (t) => {
  for (const [label, maintenanceDeleted] of [
    ["zero", { admissions: 0, daily: 0, minute: 0, sessions: 0 }],
    ["partial", { admissions: 64, daily: 8, minute: 127, sessions: 32 }],
  ]) {
    await t.test(label, async (t) => {
      const f = await fixture(t, { initialOrdinal: 10, maintenanceDeleted });
      const result = await runSampler(f.options);
      assert.equal(result.ok, false);
      assert.equal(result.error, "maintenance_batch_not_full");
      assert.equal(result.cpuGate, "unknown");
      assert.equal(result.ledger.business, 42);
      assert.equal(result.ledger.maintenanceBatchesReserved, 2);
      assert.deepEqual(
        result.rounds.map((r) => r.requests.length),
        [21, 21],
      );
      assert.deepEqual(result.rounds[0].coverage.maintenanceOrdinals, []);
      assert.equal(result.rounds[1].coverage, null);
      assert.equal(f.calls.includes("analytics"), false);
      assert.equal(result.cleanup.complete, true);
    });
  }
});
test("round boundaries reject reused ordinal, changed cutoff and replenished maintenance fixtures", async (t) => {
  for (const [label, change] of [
    ["ordinal replay", { ordinal: 0 }],
    ["ordinal gap", { ordinal: 32 }],
    ["changed cutoff", { cutoff: Date.UTC(2026, 9, 15) }],
    [
      "fixture replenished",
      {
        maintenance: { admissions: 128, daily: 16, minute: 256, sessions: 64 },
      },
    ],
  ]) {
    await t.test(label, async (t) => {
      let rounds = 0;
      const f = await fixture(t, {
        manage: (command) => {
          if (command !== "prepareRound" || ++rounds !== 2) return;
          return {
            data: {
              fixtureInserted: 1,
              metadataVersion: 0,
              ordinal: 20,
              metadataAdmissions: 0,
              day: "2026-10-16",
              cutoff: Date.UTC(2026, 9, 16),
              maintenance: {
                admissions: 64,
                daily: 8,
                minute: 128,
                sessions: 32,
              },
              ...change,
            },
            meta: { rowsRead: 1, rowsWritten: 0 },
          };
        },
      });
      const result = await runSampler(f.options);
      assert.equal(result.error, "non_contiguous_coverage");
      assert.deepEqual(
        result.rounds.map((r) => r.requests.length),
        [21, 0],
      );
      assert.equal(f.calls.includes("analytics"), false);
      assert.equal(result.cleanup.complete, true);
    });
  }
});
test("private outputs reject symlink target and symlink parent before external calls", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "other");
  await fs.writeFile(other, "unchanged");
  await fs.symlink(other, f.receipt.file);
  await assert.rejects(runSampler(f.options));
  assert.deepEqual(f.calls, []);
  assert.equal(await fs.readFile(other, "utf8"), "unchanged");
  await fs.rm(f.receipt.file);
  const link = path.join(f.root, ".local/link");
  await fs.symlink(f.root, link);
  f.receipt.file = path.join(link, "new.json");
  await assert.rejects(runSampler(f.options));
  assert.deepEqual(f.calls, []);
});

function fakeH2({
  status = 200,
  alpn = "h2",
  tooLarge = false,
  hang = false,
  largeChunk = false,
} = {}) {
  const streams = [];
  let connections = 0;
  const connectImpl = (origin, options) => {
    connections++;
    assert.equal(origin, CHECK.origin);
    assert.equal(options.rejectUnauthorized, true);
    assert.deepEqual(options.ALPNProtocols, ["h2"]);
    const client = new EventEmitter();
    client.alpnProtocol = alpn;
    client.close = () => {
      client.closed = true;
    };
    client.destroy = () => {
      client.destroyed = true;
    };
    client.request = (headers) => {
      const stream = new EventEmitter();
      streams.push({ stream, headers });
      stream.close = () => {};
      stream.end = () =>
        queueMicrotask(() => {
          if (hang) return;
          stream.emit("response", {
            ":status": status,
            ...(tooLarge ? { "content-length": "65537" } : {}),
          });
          stream.emit(
            "data",
            largeChunk ? Buffer.alloc(65537) : Buffer.from("{}"),
          );
          stream.emit("end");
        });
      return stream;
    };
    queueMicrotask(() => client.emit("connect"));
    return client;
  };
  return { connectImpl, streams, connections: () => connections };
}
test("H2 transport uses one verified TLS session and opens CAS streams synchronously", async () => {
  const f = fakeH2();
  const session = await connectSamplerH2(
    { origin: CHECK.origin },
    { connectImpl: f.connectImpl },
  );
  const req = {
    path: "/api/books/cf03-sampler-first-access/metadata",
    method: "POST",
    body: "{}",
    headers: { origin: CHECK.origin },
  };
  const pair = [session.request(req), session.request(req)];
  assert.equal(f.streams.length, 2);
  assert.equal(f.connections(), 1);
  assert.equal(
    f.streams[0].headers[":authority"],
    "the-shelf-cf03-check.iamzhutuo.workers.dev",
  );
  await Promise.all(pair);
  await session.close();
  await assert.rejects(session.request(req));
});
test("H2 refuses other targets, redirects, oversized bodies, invalid ALPN and abort without reconnect", async () => {
  for (const options of [
    { status: 302 },
    { tooLarge: true },
    { largeChunk: true },
  ]) {
    const f = fakeH2(options);
    const s = await connectSamplerH2(
      { origin: CHECK.origin },
      { connectImpl: f.connectImpl },
    );
    await assert.rejects(s.request({ path: "/api/health", method: "GET" }));
    await s.close();
    assert.equal(f.connections(), 1);
  }
  const active = fakeH2({ hang: true });
  const open = await connectSamplerH2(
    { origin: CHECK.origin },
    { connectImpl: active.connectImpl },
  );
  const abort = new AbortController();
  const pending = open.request({
    path: "/api/health",
    method: "GET",
    signal: abort.signal,
  });
  assert.equal(active.streams.length, 1);
  abort.abort();
  await assert.rejects(pending, (error) => error.code === "h2_request_aborted");
  await open.close();
  assert.equal(active.connections(), 1);
  const f = fakeH2({ alpn: "http/1.1" });
  await assert.rejects(
    connectSamplerH2({ origin: CHECK.origin }, { connectImpl: f.connectImpl }),
  );
  const other = fakeH2();
  await assert.rejects(
    connectSamplerH2(
      { origin: "https://evil.test" },
      { connectImpl: other.connectImpl },
    ),
  );
  assert.equal(other.connections(), 0);
  const normal = fakeH2();
  const s = await connectSamplerH2(
    { origin: CHECK.origin },
    { connectImpl: normal.connectImpl },
  );
  await assert.rejects(s.request({ path: "/api/arbitrary", method: "GET" }));
  await assert.rejects(
    s.request({ path: "/api/login", method: "POST", body: "x".repeat(18001) }),
  );
  await s.close();
});

test("shutdown generation is independently compared to closeAuth, never to itself", async (t) => {
  const f = await fixture(t, {
    manage: (command) =>
      command === "verifyAuthClosed"
        ? {
            data: {
              enabled: false,
              activeSessions: 0,
              observationActive: false,
              generation: 999,
            },
            meta: { rowsRead: 1, rowsWritten: 0 },
          }
        : undefined,
  });
  const result = await runSampler(f.options);
  assert.equal(result.cleanup.complete, false);
  assert.ok(result.cleanup.errors.includes("verifyAuthClosed_failed"));
  assert.equal(result.cpuGate, "unknown");
});

test("full sampler runs real Worker+SQLite: 40 real API admissions, two CAS races and maintenance at 1/32", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { handleRequest } = await import("../cloudflare/library/worker.mjs");
  const { createOwnerVerifier } =
    await import("../cloudflare/library/security.mjs");
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec(
    await fs.readFile(
      new URL("../cloudflare/library/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(
    await fs.readFile(
      new URL(
        "../cloudflare/library/migrations/007-book-management.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // The real Worker executes its actual SQL, triggers, transaction boundaries,
  // session crypto and CAS. Only D1's remote transport is replaced by SQLite.
  let metadataReaders = [];
  const db = {
    prepare(statement) {
      const make = (params) => ({
        bind: (...args) => make(args),
        execute: () => ({
          success: true,
          results: sql.prepare(statement).all(...params),
        }),
        async run() {
          const result = sql.prepare(statement).run(...params);
          return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes) },
          };
        },
        async first() {
          const row = sql.prepare(statement).get(...params) ?? null;
          if (statement.includes("COALESCE(o.version,0)"))
            await new Promise((resolve) => {
              metadataReaders.push(resolve);
              if (metadataReaders.length === 2) {
                const ready = metadataReaders;
                metadataReaders = [];
                ready.forEach((done) => done());
              }
            });
          return row;
        },
        async all() {
          return { results: sql.prepare(statement).all(...params) };
        },
      });
      return make([]);
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const result = statements.map((s) => s.execute());
        sql.exec("COMMIT");
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const pepper = Buffer.alloc(32, 22).toString("base64url"),
    secret = Buffer.alloc(32, 33).toString("base64url");
  const verifier = await createOwnerVerifier(ownerKey, pepper, {
    scope: "check",
    origin: CHECK.origin,
  });
  sql
    .prepare("INSERT INTO auth_config VALUES(?,?,?,?,?,?,?)")
    .run(
      "check",
      CHECK.origin,
      "owner-access-key-v1",
      verifier,
      1,
      0,
      Date.now(),
    );
  const env = {
    APP_SCOPE: "check",
    SITE_ORIGIN: CHECK.origin,
    OWNER_KEY_PEPPER: pepper,
    SESSION_SECRET: secret,
    DB: db,
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET: "the-shelf-books",
    R2_ACCESS_KEY_ID: "synthetic-access",
    R2_SECRET_ACCESS_KEY: "synthetic-secret",
    BOOKS: {
      async head() {
        throw new Error("Unregistered fixture must never read R2");
      },
    },
  };
  const originalNow = Date.now;
  let f,
    cutoff = 10000000000,
    roundStart;
  const maintenance = () => ({
    admissions: sql
      .prepare(
        "SELECT count(*) n FROM admissions WHERE scope='check' AND created_at<?",
      )
      .get(cutoff).n,
    daily: sql
      .prepare(
        "SELECT count(*) n FROM counters WHERE scope='check' AND kind IN ('api_day','login_day','access_day','metadata_day','session_day') AND window_start<1000",
      )
      .get().n,
    minute: sql
      .prepare(
        "SELECT count(*) n FROM counters WHERE scope='check' AND kind IN ('api_minute','api_ip','login_minute','login_ip','access_ip','metadata_ip') AND window_start<1000",
      )
      .get().n,
    sessions: sql
      .prepare(
        "SELECT count(*) n FROM sessions WHERE scope='check' AND expires_at<?",
      )
      .get(cutoff).n,
  });
  const snapshot = () => ({
    ordinal:
      sql
        .prepare(
          "SELECT count FROM counters WHERE scope='check' AND kind='api_day' AND bucket='global' AND window_start=?",
        )
        .get(Math.floor(Date.now() / 86400000))?.count ?? 0,
    metadataAdmissions: sql
      .prepare(
        "SELECT count(*) n FROM admissions WHERE scope='check' AND kind='metadata' AND created_at>=?",
      )
      .get(roundStart).n,
    day: new Date(Date.now()).toISOString().slice(0, 10),
    cutoff,
    maintenance: maintenance(),
  });
  const resultWrap = (data) => ({
    data,
    meta: { rowsRead: 1, rowsWritten: 1 },
  });
  f = await fixture(t, {
    manage: async (command, { payload }) => {
      if (command === "inspectDatabase")
        return resultWrap({
          databaseId: checkId,
          databaseName: CHECK.databaseName,
          scope: "check",
          origin: CHECK.origin,
          schemaVersion: 2,
          authEnabled: false,
          entryEnabled: false,
          previewEnabled: false,
          generation: 1,
          activeSessions: 0,
          observationActive: false,
        });
      if (command === "enableAuth")
        return resultWrap(
          sql
            .prepare(
              "UPDATE auth_config SET enabled=1,generation=generation+1 WHERE scope='check' RETURNING enabled,generation",
            )
            .get() && { enabled: true, generation: 2 },
        );
      if (command === "seedMaintenance") {
        assert.equal(payload.batches, 2);
        sql.exec(
          "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<128) INSERT INTO admissions(scope,request_id,kind,ip_key,created_at) SELECT 'check','sampler-old-'||i,'api',lower(hex(zeroblob(32))),1 FROM n",
        );
        sql.exec(
          "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<16) INSERT INTO counters SELECT 'check','metadata_day','old-day-'||i,0,1,100 FROM n",
        );
        sql.exec(
          "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<256) INSERT INTO counters SELECT 'check','metadata_ip','old-minute-'||i,0,1,20 FROM n",
        );
        sql.exec(
          "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<64) INSERT INTO sessions(scope,session_hash,generation,created_at,expires_at,revoked) SELECT 'check',lower(hex(zeroblob(28)))||printf('%08x',i),2,(i+1)*86400000+1,(i+1)*86400000+2,1 FROM n",
        );
        return resultWrap({ counts: maintenance() });
      }
      if (command === "prepareRound") {
        roundStart = Date.now();
        const book = {
          id: payload.bookId,
          title: "Synthetic cloud test",
          author: null,
          category: "Tests",
          categoryId: "cat-tests",
          tags: [],
          description: "Synthetic fixture, no book content.",
          files: [
            {
              id: payload.fileId,
              format: "EPUB",
              sizeBytes: 100,
              status: "candidate",
              reason: "not_uploaded",
              visibility: "private",
              readable: true,
            },
          ],
        };
        sql
          .prepare(
            "INSERT INTO catalog_books(scope,book_id,public_json) VALUES(?,?,?)",
          )
          .run("check", payload.bookId, JSON.stringify(book));
        return resultWrap({
          ...snapshot(),
          fixtureInserted: 1,
          metadataVersion: 0,
        });
      }
      if (command === "rotateGeneration")
        return resultWrap(
          sql
            .prepare(
              "UPDATE auth_config SET generation=generation+1 WHERE scope='check' RETURNING generation",
            )
            .get(),
        );
      if (command === "readCoverage")
        return resultWrap({
          ...snapshot(),
          sessionRows: sql
            .prepare("SELECT count(*) n FROM sessions WHERE scope='check'")
            .get().n,
          hashedSessionRows: sql
            .prepare(
              "SELECT count(*) n FROM sessions WHERE scope='check' AND length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'",
            )
            .get().n,
        });
      if (command === "closeAuth")
        return resultWrap({
          ...sql
            .prepare(
              "UPDATE auth_config SET enabled=0,generation=generation+1 WHERE scope='check' RETURNING generation",
            )
            .get(),
          enabled: false,
        });
      if (command === "verifyAuthClosed")
        return resultWrap({
          ...sql
            .prepare("SELECT generation FROM auth_config WHERE scope='check'")
            .get(),
          enabled: false,
          activeSessions: sql
            .prepare(
              "SELECT count(*) n FROM sessions WHERE scope='check' AND revoked=0",
            )
            .get().n,
          observationActive: false,
        });
      if (command === "analytics") return { data: {} }; // CPU is a cloud-only metric: explicitly unknown locally.
    },
  });
  Date.now = () => f.adapters.clock.now();
  t.after(() => {
    Date.now = originalNow;
  });
  let connectionCount = 0;
  f.adapters.connect = async () => ({
    protocol: "h2",
    async close() {},
    async request({ path, method, headers, body }) {
      connectionCount++;
      const reply = await handleRequest(
        new Request(CHECK.origin + path, {
          method,
          headers: { ...headers, "CF-Connecting-IP": "192.0.2.1" },
          ...(body === undefined ? {} : { body }),
        }),
        env,
      );
      return {
        status: reply.status,
        headers: Object.fromEntries(reply.headers),
        body: Buffer.from(await reply.arrayBuffer()),
      };
    },
  });
  const result = await runSampler(f.options);
  assert.equal(
    result.ok,
    true,
    JSON.stringify({
      error: result.error,
      rounds: result.rounds.map((r) => ({
        requests: r.requests.length,
        last: r.requests.at(-1),
      })),
      cleanup: result.cleanup,
    }),
  );
  assert.equal(connectionCount, 42);
  assert.deepEqual(
    result.rounds.map((r) => r.coverage.metadataAdmissions),
    [2, 2],
  );
  assert.deepEqual(
    result.rounds.map((r) => r.coverage.maintenanceOrdinals),
    [[1], [32]],
  );
  for (const round of result.rounds)
    assert.deepEqual(round.coverage.deleted, {
      admissions: 64,
      daily: 8,
      minute: 128,
      sessions: 32,
    });
  assert.equal(
    sql
      .prepare(
        "SELECT count FROM counters WHERE scope='check' AND kind='api_day' AND bucket='global' AND window_start=?",
      )
      .get(Math.floor(Date.now() / 86400000)).count,
    40,
  );
  assert.equal(result.cpuGate, "unknown");
  assert.equal(result.cleanup.complete, true);
});

test("failure only at final checkpoint cannot return collected or a passing CPU gate", async (t) => {
  const f = await fixture(t, {
    beforeCheckpoint: (record) => {
      if (record.state === "collected") throw new Error(privateSecret);
    },
  });
  const result = await runSampler(f.options);
  assert.equal(result.ok, false);
  assert.equal(result.state, "stopped");
  assert.equal(result.error, "receipt_write_failed");
  assert.equal(result.receiptFailure, true);
  assert.equal(result.cpuGate, "unknown");
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.ledger.business, 42);
});

test("explicit analytics delay follows all 42 HTTP requests and two maintenance batches are reserved before mutation", async (t) => {
  const f = await fixture(t);
  const originalManage = f.adapters.manage;
  let firstAnalyticsAt;
  f.options.plan.analyticsDelayMs = 180000;
  f.adapters.manage = async (command, context) => {
    if (command === "analytics") firstAnalyticsAt ??= f.adapters.clock.now();
    return originalManage(command, context);
  };
  let reservedBeforeEnable = false;
  f.adapters.beforeCheckpoint = (record) => {
    if (
      record.ledger.management >= 6 &&
      record.ledger.maintenanceBatchesReserved === 2
    )
      reservedBeforeEnable = true;
  };
  const result = await runSampler(f.options);
  assert.equal(result.ok, true);
  assert.equal(result.ledger.maintenanceBatchesReserved, 2);
  assert.equal(reservedBeforeEnable, true);
  assert.ok(
    firstAnalyticsAt - Date.parse(result.rounds[1].requests.at(-1).endedAt) >=
      180000,
  );
  assert.equal(result.ledger.business, 42);
  assert.equal(
    (await runSampler({ plan: f.options.plan })).analyticsDelayMs,
    180000,
  );
});
