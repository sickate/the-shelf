// Offline evidence only: no environment, filesystem, network, or raw CPU samples.
export const CPU_BRANCHES = Object.freeze([
  "health",
  "anonymous-session",
  "anonymous-file",
  "unknown-api",
  "cross-origin-login",
  "malformed-login",
  "wrong-key-login",
  "login",
  "session",
  "csrf-rejected",
  "body-rejected",
  "metadata-cas",
  "book",
  "unregistered-file",
  "logout",
  "revoked-session",
  "revoked-file",
  "generation-session",
]);
const STATUSES = new Set([
  "success",
  "ok",
  "exception",
  "exceededCpu",
  "exceededMemory",
  "canceled",
  "unknown",
  "responseStreamDisconnected",
  "scriptNotFound",
]);
const WORKER = "the-shelf-cf03-check";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
function time(value) {
  if (typeof value !== "string" || !UTC.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) &&
    new Date(ms).toISOString() ===
      value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z")
    ? ms
    : null;
}
function metrics(value) {
  if (
    !object(value) ||
    !count(value.requests) ||
    !count(value.errors) ||
    value.errors > value.requests
  )
    return null;
  const values = ["cpuTimeP50", "cpuTimeP95", "cpuTimeP99"].map(
    (key) => value[key],
  );
  if (!values.every(finite) || values[0] > values[1] || values[1] > values[2])
    return null;
  if (
    value.cpuTimeMax !== undefined &&
    (!finite(value.cpuTimeMax) || value.cpuTimeMax < values[2])
  )
    return null;
  return {
    requests: value.requests,
    errors: value.errors,
    cpuTimeP50: values[0],
    cpuTimeP95: values[1],
    cpuTimeP99: values[2],
    p50Ms: values[0] / 1000,
    p95Ms: values[1] / 1000,
    p99Ms: values[2] / 1000,
    cpuTimeMax: value.cpuTimeMax ?? null,
    platformMaxMs:
      value.cpuTimeMax === undefined ? null : value.cpuTimeMax / 1000,
  };
}

/**
 * Input is a whitelist projection of GraphQL, never an HTTP receipt. All CPU
 * values are original microseconds. aggregate has workerName/versionId/from/to
 * and requests/errors/cpuTimeP50/cpuTimeP95/cpuTimeP99 and optional cpuTimeMax.
 * cpuTimeMax is a platform maximum, never a raw sample sequence. groups have the same
 * metrics, workerName/versionId, integer-second datetime, and runtime status.
 * query={from,to,groupLimit,groupsTruncated}; sampling={sampleInterval,confidence?}.
 * requests=[{sequence,branch,versionId,startedAt,endedAt}]. UTC timestamps use Z.
 * clockUncertaintyMs is explicit, 0..1000. All version IDs must match the top
 * versionId UUID. versionEvidence='deployment-attested' means the private runner
 * checked deployments: it does NOT mean GraphQL supplied a version dimension.
 * 'platform-dimension' instead requires the runner to project scriptVersion.
 * Unknown fields are ignored and never returned. Invalid data is not zero-filled.
 * Gate covers only this query's platform P95/errors, not long-term performance,
 * individual request CPU, raw max, or the other CF-03 production requirements.
 */
export function analyzeCpuEvidence(input) {
  const result = {
    status: "invalid",
    reasons: [],
    versionEvidence: null,
    cpuUnit: "microseconds",
    reportUnit: "milliseconds",
    query: null,
    sampling: null,
    aggregate: null,
    groups: [],
    requests: [],
    rawMaxMs: null,
    p99IsMax: false,
    gate: { status: "unknown", scope: "window-platform-cpu", reasons: [] },
  };
  const reasons = new Set();
  const invalid = new Set();
  const add = (reason, bad = false) => {
    reasons.add(reason);
    if (bad) invalid.add(reason);
  };
  if (!object(input)) {
    result.reasons = ["invalid_input"];
    result.gate.reasons = ["incomplete_evidence"];
    return result;
  }
  const versionValid =
    typeof input.versionId === "string" && UUID.test(input.versionId);
  const evidenceValid = ["deployment-attested", "platform-dimension"].includes(
    input.versionEvidence,
  );
  if (evidenceValid) result.versionEvidence = input.versionEvidence;
  const identityValid =
    input.workerName === WORKER &&
    input.scope === "check" &&
    versionValid &&
    evidenceValid;
  if (!identityValid) add("invalid_target_or_version", true);
  const unitValid = input.cpuUnit === "microseconds";
  if (!unitValid) add("invalid_cpu_unit", true);
  const query = object(input.query) ? input.query : {};
  const from = time(query.from),
    to = time(query.to);
  const rangeValid = from !== null && to !== null && from < to;
  const limitValid =
    count(query.groupLimit) &&
    query.groupLimit > 0 &&
    query.groupLimit <= 10000;
  if (!rangeValid || !limitValid || typeof query.groupsTruncated !== "boolean")
    add("invalid_query", true);
  if (rangeValid)
    result.query = {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      groupLimit: limitValid ? query.groupLimit : null,
      groupsTruncated:
        typeof query.groupsTruncated === "boolean"
          ? query.groupsTruncated
          : null,
    };
  const uncertaintyValid =
    finite(input.clockUncertaintyMs) && input.clockUncertaintyMs <= 1000;
  if (!uncertaintyValid) add("invalid_clock_uncertainty", true);
  const matchesIdentity = (value) =>
    object(value) &&
    value.workerName === WORKER &&
    value.versionId === input.versionId &&
    identityValid;

  const aggregateMetrics = metrics(input.aggregate);
  const aggregateRange =
    object(input.aggregate) &&
    rangeValid &&
    time(input.aggregate.from) === from &&
    time(input.aggregate.to) === to;
  // Keep a valid platform aggregate even when request attribution is impossible.
  const aggregateValid =
    unitValid &&
    matchesIdentity(input.aggregate) &&
    aggregateRange &&
    aggregateMetrics !== null;
  if (aggregateValid) result.aggregate = aggregateMetrics;
  else add("invalid_or_missing_aggregate", true);

  if (
    object(input.sampling) &&
    finite(input.sampling.sampleInterval) &&
    input.sampling.sampleInterval >= 1 &&
    (input.sampling.confidence === undefined ||
      (finite(input.sampling.confidence) && input.sampling.confidence <= 1))
  ) {
    result.sampling = { sampleInterval: input.sampling.sampleInterval };
    if (input.sampling.confidence !== undefined)
      result.sampling.confidence = input.sampling.confidence;
    if (input.sampling.sampleInterval > 1) add("sampled_data");
  } else add("sampling_unknown");

  const requests = [],
    sequences = new Set();
  if (!Array.isArray(input.requests) || input.requests.length > 10000)
    add("invalid_requests", true);
  else
    for (const request of input.requests) {
      if (!object(request)) {
        add("invalid_request_window", true);
        continue;
      }
      const start = time(request.startedAt),
        end = time(request.endedAt);
      if (
        !Number.isSafeInteger(request.sequence) ||
        request.sequence < 1 ||
        sequences.has(request.sequence)
      ) {
        add("invalid_or_duplicate_sequence", true);
        continue;
      }
      sequences.add(request.sequence);
      if (
        !CPU_BRANCHES.includes(request.branch) ||
        request.versionId !== input.versionId
      ) {
        add("invalid_request_label_or_version", true);
        continue;
      }
      if (
        !rangeValid ||
        !uncertaintyValid ||
        start === null ||
        end === null ||
        start > end
      ) {
        add("invalid_request_window", true);
        continue;
      }
      const lo = start - input.clockUncertaintyMs,
        hi = end + input.clockUncertaintyMs;
      if (lo < from || hi >= to) add("request_outside_query", true);
      requests.push({
        sequence: request.sequence,
        branch: request.branch,
        lo,
        hi,
      });
    }

  const groups = [],
    groupKeys = new Set();
  if (!Array.isArray(input.groups) || input.groups.length > 10000)
    add("invalid_groups", true);
  else {
    if (
      query.groupsTruncated === true ||
      (limitValid && input.groups.length >= query.groupLimit)
    )
      add("groups_may_be_truncated");
    for (const group of input.groups) {
      if (!object(group)) {
        add("invalid_group", true);
        continue;
      }
      const second = time(group.datetime),
        values = metrics(group);
      if (
        !unitValid ||
        !matchesIdentity(group) ||
        !STATUSES.has(group.status) ||
        !values ||
        values.requests === 0 ||
        second === null ||
        second % 1000 !== 0 ||
        !rangeValid ||
        second < Math.floor(from / 1000) * 1000 ||
        second >= to
      ) {
        add("invalid_group", true);
        continue;
      }
      const key = `${second}:${group.status}`;
      if (groupKeys.has(key)) {
        add("duplicate_group", true);
        continue;
      }
      groupKeys.add(key);
      groups.push({ second, status: group.status, values });
    }
  }
  const groupRequests = groups.reduce(
    (sum, group) => sum + group.values.requests,
    0,
  );
  const groupErrors = groups.reduce(
    (sum, group) => sum + group.values.errors,
    0,
  );
  if (
    aggregateValid &&
    (groupRequests !== aggregateMetrics.requests ||
      groupErrors !== aggregateMetrics.errors)
  )
    add("group_aggregate_count_mismatch");
  if (
    aggregateValid &&
    aggregateMetrics.platformMaxMs !== null &&
    groups.some(
      (group) =>
        group.values.platformMaxMs !== null &&
        group.values.platformMaxMs > aggregateMetrics.platformMaxMs,
    )
  )
    add("platform_max_mismatch");
  if (aggregateValid && requests.length !== aggregateMetrics.requests)
    add("request_aggregate_count_mismatch");
  if (aggregateValid && aggregateMetrics.requests === 0) add("no_observations");

  const overlap = (request, group) =>
    request.lo < group.second + 1000 && request.hi >= group.second;
  const crossesSecond = (request) =>
    Math.floor(request.lo / 1000) !== Math.floor(request.hi / 1000);
  const requestGroups = new Map(
    requests.map((request) => [
      request.sequence,
      groups.filter((group) => overlap(request, group)),
    ]),
  );
  const groupCandidates = new Map(
    groups.map((group) => [
      group,
      requests.filter((request) => overlap(request, group)),
    ]),
  );
  const hasPeers = new Map(
    requests.map((request) => [
      request.sequence,
      requests.some(
        (other) =>
          other.sequence !== request.sequence &&
          request.lo <= other.hi &&
          other.lo <= request.hi,
      ),
    ]),
  );
  const seconds = new Set(groups.map((group) => group.second));
  for (const second of seconds) {
    const total = groups
      .filter((group) => group.second === second)
      .reduce((sum, group) => sum + group.values.requests, 0);
    const candidates = requests.filter((request) =>
      overlap(request, { second }),
    );
    if (total > candidates.length) add("extra_group_traffic");
  }
  for (const group of groups) {
    const candidates = groupCandidates.get(group);
    let kind = "group-only",
      reason = "no_matching_request";
    if (candidates.length > 1) {
      kind = "ambiguous";
      reason = "multiple_candidates";
    } else if (candidates.length === 1) {
      const candidate = candidates[0];
      if (crossesSecond(candidate)) {
        kind = "ambiguous";
        reason = "cross_second_window";
      } else if (requestGroups.get(candidate.sequence).length > 1) {
        kind = "ambiguous";
        reason =
          new Set(
            requestGroups.get(candidate.sequence).map((match) => match.second),
          ).size > 1
            ? "cross_second_window"
            : "multiple_groups";
      } else if (hasPeers.get(candidate.sequence)) {
        kind = "ambiguous";
        reason = "overlapping_request_windows";
      } else if (group.values.requests !== 1) reason = "group_count_not_one";
      else {
        kind = "unique-window";
        reason = "group_quantile_only";
      }
    }
    if (!candidates.length) add("extra_group_traffic");
    else if (kind === "group-only") add("group_request_count_mismatch");
    if (kind === "ambiguous") add("ambiguous_attribution");
    if (group.status === "unknown") add("unknown_runtime_status");
    result.groups.push({
      second: new Date(group.second).toISOString(),
      runtimeStatus: group.status,
      ...group.values,
      attribution: {
        kind,
        reason,
        sequences: candidates.map((request) => request.sequence),
        branches: candidates.map((request) => request.branch),
      },
    });
  }
  for (const request of requests) {
    const matches = requestGroups.get(request.sequence);
    if (!matches.length) add("missing_request_traffic");
    result.requests.push({
      sequence: request.sequence,
      branch: request.branch,
      association:
        matches.length === 0
          ? "missing"
          : matches.length === 1 &&
              !crossesSecond(request) &&
              !hasPeers.get(request.sequence) &&
              groupCandidates.get(matches[0]).length === 1 &&
              matches[0].values.requests === 1
            ? "unique-window"
            : "ambiguous",
      seconds: [
        ...new Set(
          matches.map((group) => new Date(group.second).toISOString()),
        ),
      ],
    });
  }
  // With a complete unsampled grouping, the full-range maximum must also be
  // attained in a group. Missing group maxima cannot establish this direction.
  if (
    aggregateValid &&
    aggregateMetrics.platformMaxMs !== null &&
    result.sampling?.sampleInterval === 1 &&
    invalid.size === 0 &&
    [...reasons].every((reason) => reason === "ambiguous_attribution") &&
    groups.length > 0 &&
    groups.every((group) => group.values.platformMaxMs !== null) &&
    aggregateMetrics.platformMaxMs !==
      Math.max(...groups.map((group) => group.values.platformMaxMs))
  )
    add("platform_max_mismatch");
  result.reasons = [...reasons];
  if (aggregateValid && aggregateMetrics.requests < 21) {
    result.reasons.push("fewer_than_21_requests");
    reasons.add("fewer_than_21_requests");
  }
  result.status = invalid.size
    ? "invalid"
    : reasons.size
      ? "incomplete"
      : "complete";
  // Ambiguous route labels alone do not invalidate the full-range platform P95.
  const blockers = result.reasons.filter(
    (reason) => reason !== "ambiguous_attribution",
  );
  const runtimeError = groups.some(
    (group) =>
      group.status !== "ok" &&
      group.status !== "success" &&
      group.status !== "unknown",
  );
  const maxTooHigh =
    aggregateValid &&
    (aggregateMetrics.platformMaxMs >= 10 ||
      groups.some((group) => group.values.platformMaxMs >= 10));
  if (
    aggregateValid &&
    (aggregateMetrics.p95Ms > 5 ||
      maxTooHigh ||
      aggregateMetrics.errors > 0 ||
      runtimeError)
  ) {
    result.gate.status = "fail";
    if (aggregateMetrics.p95Ms > 5) result.gate.reasons.push("p95_above_5ms");
    if (maxTooHigh) result.gate.reasons.push("platform_max_at_least_10ms");
    if (aggregateMetrics.errors > 0 || runtimeError)
      result.gate.reasons.push("platform_errors");
  } else if (aggregateValid && blockers.length === 0)
    result.gate.status = "pass";
  else result.gate.reasons.push("incomplete_evidence");
  return result;
}
