import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCpuEvidence } from "../scripts/cf-cpu-evidence.mjs";

const versionId = "11111111-2222-4333-8444-555555555555";
const workerName = "the-shelf-cf03-check";
const timestamp = (ms) => new Date(Date.UTC(2026, 9, 15) + ms).toISOString();
const cpu = {
  cpuTimeP50: 2000,
  cpuTimeP95: 4500,
  cpuTimeP99: 6000,
  cpuTimeMax: 7000,
};
function evidence(n = 21) {
  return {
    workerName,
    scope: "check",
    versionId,
    versionEvidence: "platform-dimension",
    cpuUnit: "microseconds",
    query: {
      from: timestamp(0),
      to: timestamp((n + 1) * 1000),
      groupLimit: 100,
      groupsTruncated: false,
    },
    clockUncertaintyMs: 50,
    sampling: { sampleInterval: 1 },
    aggregate: {
      workerName,
      versionId,
      from: timestamp(0),
      to: timestamp((n + 1) * 1000),
      requests: n,
      errors: 0,
      ...cpu,
    },
    groups: Array.from({ length: n }, (_, i) => ({
      workerName,
      versionId,
      datetime: timestamp(i * 1000),
      status: "ok",
      requests: 1,
      errors: 0,
      ...cpu,
    })),
    requests: Array.from({ length: n }, (_, i) => ({
      sequence: i + 1,
      branch: "health",
      versionId,
      startedAt: timestamp(i * 1000 + 100),
      endedAt: timestamp(i * 1000 + 200),
    })),
  };
}

test("a complete window uses original aggregate quantiles, converts microseconds and distinguishes platform max", () => {
  const input = evidence();
  input.aggregate.cpuTimeP95 = 5000;
  const output = analyzeCpuEvidence(input);
  assert.equal(output.status, "complete");
  assert.equal(output.gate.status, "pass");
  assert.equal(output.aggregate.cpuTimeP95, 5000);
  assert.equal(output.aggregate.p95Ms, 5); // Not the mean of the per-second 4.5ms.
  assert.equal(output.aggregate.platformMaxMs, 7);
  assert.equal(output.rawMaxMs, null);
  assert.equal(output.p99IsMax, false);
  assert.equal(output.groups[0].attribution.kind, "unique-window");
  assert.equal(output.groups[0].attribution.reason, "group_quantile_only");
  assert.equal(output.versionEvidence, "platform-dimension");
  assert.deepEqual(input, evidenceWithP95(5000));
});
function evidenceWithP95(value) {
  const input = evidence();
  input.aggregate.cpuTimeP95 = value;
  return input;
}

test("P99 never becomes max, and fewer than 21 observations cannot pass", () => {
  const input = evidence(1);
  delete input.aggregate.cpuTimeMax;
  delete input.groups[0].cpuTimeMax;
  const output = analyzeCpuEvidence(input);
  assert.equal(output.aggregate.platformMaxMs, null);
  assert.equal(output.rawMaxMs, null);
  assert.equal(output.gate.status, "unknown");
  assert.ok(output.reasons.includes("fewer_than_21_requests"));
});

test("a crossing window is ambiguous even when only one observed second exists", () => {
  const input = evidence(1);
  input.requests[0].startedAt = timestamp(950);
  input.requests[0].endedAt = timestamp(1050);
  const output = analyzeCpuEvidence(input);
  assert.equal(output.groups[0].attribution.kind, "ambiguous");
  assert.equal(output.groups[0].attribution.reason, "cross_second_window");
  assert.equal(output.requests[0].association, "ambiguous");
});

test("concurrent metadata CAS retains pair quantiles without assigning CPU to HTTP outcomes", () => {
  const input = evidence();
  input.requests[0].branch = input.requests[1].branch = "metadata-cas";
  input.requests[1].startedAt = input.requests[0].startedAt;
  input.requests[1].endedAt = input.requests[0].endedAt;
  input.requests[0].httpStatus = 200;
  input.requests[1].httpStatus = 409;
  input.groups[0].requests = 2;
  input.groups.splice(1, 1);
  const output = analyzeCpuEvidence(input);
  assert.equal(output.groups[0].attribution.kind, "ambiguous");
  assert.equal(output.groups[0].attribution.reason, "multiple_candidates");
  assert.deepEqual(output.groups[0].attribution.sequences, [1, 2]);
  assert.equal(output.aggregate.requests, 21);
  assert.equal(output.gate.status, "pass"); // Full platform distribution remains valid.
  assert.equal(JSON.stringify(output).includes("409"), false);
});

test("two sequential requests sharing a second are also ambiguous, independent of ordering", () => {
  const input = evidence();
  input.requests[1].startedAt = timestamp(400);
  input.requests[1].endedAt = timestamp(500);
  input.groups[0].requests = 2;
  input.groups.splice(1, 1);
  input.requests.reverse();
  const output = analyzeCpuEvidence(input);
  assert.equal(output.groups[0].attribution.kind, "ambiguous");
  assert.equal(
    output.requests.find((request) => request.sequence === 1).association,
    "ambiguous",
  );
});

test("missing, extra, inconsistent, and limit-bound groups cannot produce a passing gate", () => {
  const cases = [
    (input) => {
      input.groups.pop();
    },
    (input) => {
      input.groups[0].requests++;
    },
    (input) => {
      input.aggregate.errors = 1;
    },
    (input) => {
      input.query.groupsTruncated = true;
    },
    (input) => {
      input.query.groupLimit = input.groups.length;
    },
    (input) => {
      input.groups[0].cpuTimeMax = 8000;
    },
    (input) => {
      input.requests[0].startedAt = timestamp(21100);
      input.requests[0].endedAt = timestamp(21200);
    },
    (input) => {
      input.groups.push({ ...input.groups[0] });
    },
  ];
  for (const mutate of cases) {
    const input = evidence();
    mutate(input);
    const output = analyzeCpuEvidence(input);
    assert.notEqual(output.gate.status, "pass");
    assert.equal(output.aggregate.requests, 21);
  }
});

test("CPU units, finite nonnegative values, percentile ordering and maximum are mandatory validations", () => {
  const cases = [
    (input) => {
      input.cpuUnit = "milliseconds";
    },
    (input) => {
      input.aggregate.cpuTimeP95 = NaN;
    },
    (input) => {
      input.aggregate.cpuTimeP99 = Infinity;
    },
    (input) => {
      input.aggregate.cpuTimeP50 = -1;
    },
    (input) => {
      input.aggregate.cpuTimeP50 = 5001;
    },
    (input) => {
      input.aggregate.cpuTimeMax = 5999;
    },
    (input) => {
      delete input.aggregate.cpuTimeP95;
    },
  ];
  for (const mutate of cases) {
    const input = evidence();
    mutate(input);
    const output = analyzeCpuEvidence(input);
    assert.equal(output.status, "invalid");
    assert.equal(output.aggregate, null);
    assert.equal(output.gate.status, "unknown");
  }
});

test("known P95, runtime errors and maximum violations fail even when attribution is incomplete", () => {
  for (const mutate of [
    (input) => {
      input.aggregate.cpuTimeP95 = 5001;
    },
    (input) => {
      input.aggregate.cpuTimeMax = 10000;
    },
    (input) => {
      input.groups[0].status = "exceededCpu";
    },
    (input) => {
      input.aggregate.errors = 1;
    },
  ]) {
    const input = evidence();
    mutate(input);
    input.requests.pop();
    assert.equal(analyzeCpuEvidence(input).gate.status, "fail");
  }
});

test("invalid per-second evidence never suppresses a valid full-range platform aggregate", () => {
  const input = evidence();
  input.groups[0].cpuTimeP95 = Infinity;
  const output = analyzeCpuEvidence(input);
  assert.equal(output.aggregate.p95Ms, 4.5);
  assert.equal(output.gate.status, "unknown");
  assert.equal(output.groups.length, 20);
});

test("a grouped maximum above the full-range maximum prevents pass without rewriting the aggregate", () => {
  const input = evidence();
  input.groups[0].cpuTimeMax = 8000;
  const output = analyzeCpuEvidence(input);
  assert.equal(output.gate.status, "unknown");
  assert.ok(output.reasons.includes("platform_max_mismatch"));
  assert.equal(output.aggregate.platformMaxMs, 7);
  assert.equal(output.groups[0].platformMaxMs, 8);
  assert.equal(output.gate.scope, "window-platform-cpu");
});

test("a complete unsampled grouping must attain the aggregate maximum; missing maxima stay unknown", () => {
  const input = evidence();
  input.aggregate.cpuTimeMax = 8000;
  const output = analyzeCpuEvidence(input);
  assert.equal(output.gate.status, "unknown");
  assert.ok(output.reasons.includes("platform_max_mismatch"));
  assert.equal(output.aggregate.platformMaxMs, 8);
  assert.ok(output.groups.every((group) => group.platformMaxMs === 7));

  delete input.groups[0].cpuTimeMax;
  const partial = analyzeCpuEvidence(input);
  assert.equal(partial.reasons.includes("platform_max_mismatch"), false);
  assert.equal(partial.groups[0].platformMaxMs, null);
  assert.equal(partial.gate.status, "pass");
});

test("target, version, range, runtime status and request identity are checked independently", () => {
  const cases = [
    (input) => {
      input.workerName = "the-shelf";
    },
    (input) => {
      input.scope = "production";
    },
    (input) => {
      input.versionEvidence = "latest";
    },
    (input) => {
      input.groups[0].versionId = "99999999-2222-4333-8444-555555555555";
    },
    (input) => {
      input.requests[0].versionId = "99999999-2222-4333-8444-555555555555";
    },
    (input) => {
      input.aggregate.to = timestamp(21000);
    },
    (input) => {
      input.requests[0].sequence = 2;
    },
    (input) => {
      input.groups[0].status = 200;
    },
    (input) => {
      input.clockUncertaintyMs = 1001;
    },
    (input) => {
      input.requests[0].startedAt = timestamp(0);
    },
  ];
  for (const mutate of cases) {
    const input = evidence();
    mutate(input);
    const output = analyzeCpuEvidence(input);
    assert.equal(output.status, "invalid");
    assert.equal(output.gate.status, "unknown");
  }
});

test("legacy response-at-only evidence cannot invent a request start", () => {
  const input = evidence();
  input.requests[0].at = input.requests[0].endedAt;
  delete input.requests[0].startedAt;
  const output = analyzeCpuEvidence(input);
  assert.ok(output.reasons.includes("invalid_request_window"));
  assert.equal(output.aggregate.p95Ms, 4.5);
  assert.equal(output.gate.status, "unknown");
});

test("sampling remains explicit and unknown or adaptive evidence does not pass", () => {
  for (const sampling of [
    undefined,
    { sampleInterval: 2, confidence: 0.9 },
    { sampleInterval: 0 },
  ]) {
    const input = evidence();
    input.sampling = sampling;
    assert.equal(analyzeCpuEvidence(input).gate.status, "unknown");
  }
  const input = evidence();
  input.versionEvidence = "deployment-attested";
  assert.equal(
    analyzeCpuEvidence(input).versionEvidence,
    "deployment-attested",
  );
});

test("output only contains whitelisted labels, numerical evidence and canonical times", () => {
  const input = evidence();
  const secret = "PRIVATE-URL-TOKEN-COOKIE";
  input.rawResponse = { secret };
  input.query.secret = secret;
  input.aggregate.body = secret;
  input.groups[0].header = secret;
  input.requests[0].url = secret;
  input.sampling.secret = secret;
  const output = analyzeCpuEvidence(input);
  assert.equal(JSON.stringify(output).includes(secret), false);
  input.requests[0].branch = secret;
  input.groups[0].status = secret;
  const rejected = analyzeCpuEvidence(input);
  assert.equal(JSON.stringify(rejected).includes(secret), false);
  assert.equal(rejected.status, "invalid");
  assert.equal(analyzeCpuEvidence(null).gate.status, "unknown");
});
