// Fixed check-only sampler. Import this API from a reviewed local operator runner.
// No CLI, credential discovery, deployment, profiling, or arbitrary cloud queries.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { PROFILES, validateDeployConfig } from "./cf-api-deploy.mjs";
import { baseEnvironment } from "./cf-deploy.mjs";
import { privatePath, writePrivateJson } from "./cf-library-data.mjs";
import { analyzeCpuEvidence } from "./cf-cpu-evidence.mjs";

export const CHECK = Object.freeze({ ...PROFILES.check });
export const MAINTENANCE_LIMITS = Object.freeze({
  admissions: 64,
  daily: 8,
  minute: 128,
  sessions: 32,
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const hash = (x) => createHash("sha256").update(x).digest("hex");
const own = (o, keys) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).length === keys.length &&
  Object.keys(o).every((k) => keys.includes(k));
class SamplerError extends Error {
  constructor(code) {
    super(`Controlled sampler stopped (${code}).`);
    this.code = code;
  }
}
const fail = (code) => {
  throw new SamplerError(code);
};
const requireThat = (condition, code) => {
  if (!condition) fail(code);
};
const branches = [
  "health",
  "anonymous-session",
  "anonymous-file",
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
  "metadata-cas",
  "book",
  "unregistered-file",
  "logout",
  "revoked-session",
  "revoked-file",
  "login",
  "generation-session",
];
const statuses = [
  200,
  200,
  401,
  401,
  404,
  403,
  401,
  401,
  200,
  200,
  403,
  413,
  [200, 409],
  [200, 409],
  200,
  409,
  200,
  200,
  401,
  200,
  200,
];
export const SAMPLER_MANIFEST = Object.freeze(
  branches.map((branch, index) =>
    Object.freeze({
      sequence: index + 1,
      branch,
      expectedStatus: Array.isArray(statuses[index])
        ? Object.freeze(statuses[index])
        : statuses[index],
      method: [6, 7, 8, 9, 11, 12, 13, 14, 17, 20].includes(index + 1)
        ? "POST"
        : "GET",
    }),
  ),
);
const MANIFEST_HASH = hash(
  JSON.stringify({
    requests: SAMPLER_MANIFEST,
    rounds: 2,
    unknownCategory: "Cloud Test New Category",
    bodyRejectedBytes: 17011,
    casExpectedVersion: 0,
    maintenance: MAINTENANCE_LIMITS,
  }),
);

// Each command is ONE bounded management HTTP request, never an adapter retry.
// D1 commands may use one atomic/serial provider query batch. See adapter contract.
export const MANAGEMENT_COMMANDS = Object.freeze({
  inspectVersion: "worker",
  inspectDatabaseIdentity: "d1-identity",
  inspectEntry: "worker",
  inspectDatabase: "d1",
  enableAuth: "d1",
  seedMaintenance: "d1",
  enableEntry: "worker",
  prepareRound: "d1",
  rotateGeneration: "d1",
  readCoverage: "d1",
  analytics: "analytics",
  closeAuth: "d1",
  verifyAuthClosed: "d1",
  closeEntry: "worker",
  verifyEntryClosed: "worker",
});
const D1_COMMANDS = Object.keys(MANAGEMENT_COMMANDS).filter(
  (k) => MANAGEMENT_COMMANDS[k] === "d1",
);
const CLEANUP = [
  "closeAuth",
  "verifyAuthClosed",
  "closeEntry",
  "verifyEntryClosed",
];

const isCi = (source) =>
  [
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "BUILDKITE",
    "CIRCLECI",
    "TF_BUILD",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
  ].some((key) => Boolean(source[key]));
export function samplerEnvironment(source, runDirectory) {
  requireThat(!isCi(source), "local_operator_required");
  const result = baseEnvironment(source, runDirectory);
  // baseEnvironment deliberately sets CI=true for deployment helpers. This
  // in-process operator has a separate non-CI gate; never strip a caller's CI.
  delete result.CI;
  delete result.WRANGLER_LOG_PATH;
  return result;
}

export function validateSamplerPlan(input) {
  requireThat(
    own(input, [
      "schemaVersion",
      "scope",
      "workerName",
      "origin",
      "versionId",
      "deployConfig",
      "limits",
      "costs",
      "timeoutMs",
      "spacingMs",
      "analyticsAttempts",
      "analyticsDelayMs",
    ]),
    "invalid_plan",
  );
  requireThat(
    input.schemaVersion === 1 &&
      input.scope === CHECK.scope &&
      input.workerName === CHECK.name &&
      input.origin === CHECK.origin &&
      UUID.test(input.versionId || ""),
    "invalid_target",
  );
  let config;
  try {
    config = validateDeployConfig(input.deployConfig);
  } catch {
    fail("invalid_database_target");
  }
  requireThat(
    own(input.limits, [
      "business",
      "management",
      "d1",
      "analytics",
      "rowsRead",
      "rowsWritten",
    ]),
    "invalid_budget",
  );
  const maximum = {
    business: 100,
    management: 90,
    d1: 40,
    analytics: 9,
    rowsRead: 100000,
    rowsWritten: 15000,
  };
  for (const key of Object.keys(maximum))
    requireThat(
      integer(input.limits[key]) && input.limits[key] <= maximum[key],
      "invalid_budget",
    );
  requireThat(
    integer(input.timeoutMs) &&
      input.timeoutMs >= 10 &&
      input.timeoutMs <= 30000 &&
      integer(input.spacingMs) &&
      input.spacingMs >= 1100 &&
      input.spacingMs <= 60000 &&
      integer(input.analyticsDelayMs) &&
      input.analyticsDelayMs <= 300000 &&
      integer(input.analyticsAttempts) &&
      input.analyticsAttempts >= 1 &&
      input.analyticsAttempts <= 3,
    "invalid_timing",
  );
  requireThat(
    own(input.costs, ["business", "maintenance", ...D1_COMMANDS]),
    "invalid_costs",
  );
  for (const cost of Object.values(input.costs))
    requireThat(
      own(cost, ["rowsRead", "rowsWritten"]) &&
        integer(cost.rowsRead) &&
        integer(cost.rowsWritten) &&
        cost.rowsRead > 0 &&
        cost.rowsWritten > 0,
      "invalid_costs",
    );
  const plan = structuredClone({ ...input, deployConfig: config });
  const count = {
    inspectVersion: 3,
    inspectDatabaseIdentity: 1,
    inspectEntry: 1,
    inspectDatabase: 1,
    enableAuth: 1,
    seedMaintenance: 1,
    enableEntry: 1,
    prepareRound: 2,
    rotateGeneration: 2,
    readCoverage: 2,
    analytics: 3 * plan.analyticsAttempts,
    closeAuth: 1,
    verifyAuthClosed: 1,
    closeEntry: 1,
    verifyEntryClosed: 1,
  };
  const needed = {
    business: 42,
    management: Object.values(count).reduce((a, b) => a + b, 0),
    d1: count.inspectDatabaseIdentity,
    analytics: count.analytics,
    rowsRead:
      42 * plan.costs.business.rowsRead + 2 * plan.costs.maintenance.rowsRead,
    rowsWritten:
      42 * plan.costs.business.rowsWritten +
      2 * plan.costs.maintenance.rowsWritten,
  };
  for (const command of D1_COMMANDS) {
    needed.d1 += count[command];
    for (const key of ["rowsRead", "rowsWritten"])
      needed[key] += count[command] * plan.costs[command][key];
  }
  for (const key of Object.keys(needed))
    requireThat(needed[key] <= plan.limits[key], "insufficient_budget");
  return { plan, needed, manifestHash: MANIFEST_HASH };
}

const maintenanceCounts = (input) => {
  requireThat(
    own(input, Object.keys(MAINTENANCE_LIMITS)) &&
      Object.values(input).every(integer),
    "invalid_maintenance_proof",
  );
  return { ...input };
};
function coverageProof(before, after, round) {
  requireThat(
    before &&
      after &&
      integer(before.ordinal) &&
      integer(after.ordinal) &&
      after.ordinal - before.ordinal === 20 &&
      before.day === after.day &&
      /^\d{4}-\d{2}-\d{2}$/.test(before.day || "") &&
      before.cutoff === after.cutoff &&
      Number.isSafeInteger(before.cutoff),
    "invalid_admission_proof",
  );
  requireThat(
    integer(before.metadataAdmissions) &&
      integer(after.metadataAdmissions) &&
      after.metadataAdmissions - before.metadataAdmissions === 2,
    "both_metadata_mutations_did_not_reach_cas",
  );
  requireThat(
    integer(after.sessionRows) &&
      after.sessionRows >= 2 &&
      after.hashedSessionRows === after.sessionRows,
    "invalid_session_hash_proof",
  );
  const start = maintenanceCounts(before.maintenance),
    end = maintenanceCounts(after.maintenance);
  const ordinals = Array.from(
    { length: 20 },
    (_, i) => before.ordinal + i + 1,
  ).filter((n) => n === 1 || n % 32 === 0);
  const deleted = {};
  for (const [kind, limit] of Object.entries(MAINTENANCE_LIMITS)) {
    // Stable historical cutoff, no concurrent fixture insert/delete. Exact
    // decrease proves full bounded batches; ordinal alone proves no deletion.
    deleted[kind] = start[kind] - end[kind];
    requireThat(
      deleted[kind] >= 0 && deleted[kind] <= ordinals.length * limit,
      "invalid_maintenance_proof",
    );
    if (ordinals.length)
      requireThat(
        start[kind] >= limit * ordinals.length &&
          deleted[kind] === limit * ordinals.length,
        "maintenance_batch_not_full",
      );
  }
  return {
    round,
    apiAdmissions: 20,
    metadataAdmissions: 2,
    ordinalBefore: before.ordinal,
    ordinalAfter: after.ordinal,
    maintenanceOrdinals: ordinals,
    before: start,
    after: end,
    deleted,
    fullBatch: ordinals.length > 0,
  };
}

// Required execute options: plan, accessKey, environment, adapters, receipt.
// adapters.manage(command, { target, payload, signal }) -> { data, meta? }.
// adapters.connect({origin, signal}) -> {request, close}; only ONE H2 session.
// adapters.clock defaults to UTC Date.now / abortable setTimeout.
export async function runSampler(options) {
  const { plan, needed, manifestHash } = validateSamplerPlan(options.plan);
  if (options.execute !== true)
    return {
      dryRun: true,
      scope: "check",
      manifestHash,
      requests: 42,
      rounds: 2,
      needed,
      cleanupReserve: CLEANUP.length,
      liveManagementAdapterProvided: false,
      analyticsDelayMs: plan.analyticsDelayMs,
    };
  const environment = options.environment ?? process.env;
  requireThat(!isCi(environment), "local_operator_required");
  requireThat(
    typeof options.accessKey === "string" &&
      /^[\w-]{43}$/.test(options.accessKey) &&
      Buffer.from(options.accessKey, "base64url").toString("base64url") ===
        options.accessKey,
    "invalid_access_key",
  );
  const adapters = options.adapters;
  requireThat(
    typeof adapters?.manage === "function" &&
      typeof adapters?.connect === "function",
    "adapters_required",
  );
  const clock = adapters.clock ?? {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() {
          signal?.removeEventListener("abort", abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          reject(new SamplerError("interrupted"));
        }
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
  };
  requireThat(
    typeof clock.now === "function" && typeof clock.sleep === "function",
    "invalid_clock",
  );
  requireThat(
    options.receipt &&
      typeof options.receipt.root === "string" &&
      typeof options.receipt.file === "string",
    "private_receipt_required",
  );
  const receiptFile = await privatePath(
    options.receipt.file,
    options.receipt.root,
    { existing: false },
  );
  const file = await fs.open(
    receiptFile,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  await file.close();
  const now = () => {
    const value = clock.now();
    requireThat(Number.isSafeInteger(value), "invalid_clock");
    return new Date(value).toISOString();
  };
  const target = Object.freeze({
    ...CHECK,
    databaseId: plan.deployConfig.profiles.check.databaseId,
    versionId: plan.versionId,
  });
  const ledger = {
    business: 0,
    maintenanceBatchesReserved: 0,
    management: 0,
    d1: 0,
    analytics: 0,
    rowsRead: 0,
    rowsWritten: 0,
    actualManagementRowsRead: 0,
    actualManagementRowsWritten: 0,
  };
  const record = {
    schemaVersion: 1,
    scope: "check",
    workerName: CHECK.name,
    versionId: plan.versionId,
    manifestHash,
    startedAt: now(),
    state: "prepared",
    ok: false,
    error: null,
    ledger,
    rounds: [],
    analytics: [],
    cleanup: { complete: false, errors: [] },
  };
  let saveQueue = Promise.resolve();
  const save = () => {
    const pending = saveQueue.then(async () => {
      try {
        // Optional injected writer gets only the sanitized snapshot; the default
        // private writer still runs, enforcing path and permission checks.
        if (adapters.beforeCheckpoint)
          await adapters.beforeCheckpoint(structuredClone(record));
        await writePrivateJson(receiptFile, record, options.receipt.root);
      } catch {
        record.receiptFailure = true;
        record.ok = false;
        record.error ??= "receipt_write_failed";
        record.state = "stopped";
        record.cpuGate =
          record.cpuGate === "fail" ||
          record.analytics.some(
            (entry) => entry.analysis.gate.status === "fail",
          )
            ? "fail"
            : "unknown";
        if (!cleanupMode) fail("receipt_write_failed");
      }
    });
    saveQueue = pending.catch(() => {});
    return pending;
  };
  let connection,
    touched = false,
    cleanupMode = false,
    before,
    generation;
  const cleanupReserve = () => {
    const costs = { management: 4, d1: 2, rowsRead: 0, rowsWritten: 0 };
    for (const cmd of ["closeAuth", "verifyAuthClosed"])
      for (const k of ["rowsRead", "rowsWritten"])
        costs[k] += plan.costs[cmd][k];
    return costs;
  };
  const reserve = async (kind, command) => {
    if (!cleanupMode && options.signal?.aborted) fail("interrupted");
    const delta =
      kind === "business"
        ? { business: 1, ...plan.costs.business }
        : kind === "maintenance"
          ? { ...plan.costs.maintenance }
          : {
              management: 1,
              ...(MANAGEMENT_COMMANDS[command] === "d1"
                ? { d1: 1, ...plan.costs[command] }
                : {}),
              ...(MANAGEMENT_COMMANDS[command] === "d1-identity"
                ? { d1: 1 }
                : {}),
              ...(command === "analytics" ? { analytics: 1 } : {}),
            };
    const spare = cleanupMode ? {} : cleanupReserve();
    for (const [key, value] of Object.entries(delta))
      requireThat(
        ledger[key] + value + (spare[key] ?? 0) <= plan.limits[key],
        "budget_exhausted",
      );
    for (const [key, value] of Object.entries(delta)) ledger[key] += value;
    if (kind === "maintenance") ledger.maintenanceBatchesReserved++;
    await save(); // Persist reservation BEFORE a possibly ambiguous mutation.
  };
  async function bounded(fn, cleanup = false) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (!cleanup)
      options.signal?.addEventListener("abort", abort, { once: true });
    let timer;
    try {
      requireThat(cleanup || !options.signal?.aborted, "interrupted");
      return await Promise.race([
        Promise.resolve().then(() => fn(controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new SamplerError("operation_timeout"));
          }, plan.timeoutMs);
        }),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new SamplerError("operation_aborted")),
            { once: true },
          ),
        ),
      ]);
    } finally {
      clearTimeout(timer);
      if (!cleanup) options.signal?.removeEventListener("abort", abort);
    }
  }
  async function manage(command, payload = {}) {
    await reserve("management", command);
    let result;
    try {
      result = await bounded(
        (signal) => adapters.manage(command, { target, payload, signal }),
        cleanupMode,
      );
    } catch (error) {
      if (error instanceof SamplerError) throw error;
      fail("management_outcome_unknown");
    }
    if (MANAGEMENT_COMMANDS[command] === "d1") {
      requireThat(
        result?.meta &&
          integer(result.meta.rowsRead) &&
          integer(result.meta.rowsWritten),
        "missing_d1_cost",
      );
      ledger.actualManagementRowsRead += result.meta.rowsRead;
      ledger.actualManagementRowsWritten += result.meta.rowsWritten;
      requireThat(
        result.meta.rowsRead <= plan.costs[command].rowsRead &&
          result.meta.rowsWritten <= plan.costs[command].rowsWritten,
        "d1_cost_exceeded",
      );
    }
    await save();
    return result?.data;
  }
  const wait = async (ms) => {
    // Operator waits can exceed one network operation deadline. Split them so
    // interruption remains prompt and no >60s blocking wait is necessary.
    for (let remaining = ms; remaining > 0;) {
      const chunk = Math.min(remaining, 10000, Math.max(1, plan.timeoutMs - 5));
      await bounded((signal) => clock.sleep(chunk, signal));
      remaining -= chunk;
    }
  };
  function requestEntry(round, sequence) {
    const item = SAMPLER_MANIFEST[sequence - 1];
    return {
      sequence: (record.rounds.length - 1) * 21 + sequence,
      roundSequence: sequence,
      branch: item.branch,
      versionId: plan.versionId,
      method: item.method,
      expectedStatus: item.expectedStatus,
      startedAt: now(),
      endedAt: null,
      httpStatus: null,
      bodyBytes: null,
      bodySha256: null,
      serverDate: null,
      cfRay: null,
      error: null,
    };
  }
  async function request(
    round,
    sequence,
    path,
    { body, cookie, csrf, origin } = {},
    reserved = false,
  ) {
    const item = SAMPLER_MANIFEST[sequence - 1];
    if (!reserved) {
      await wait(plan.spacingMs);
      await reserve("business");
    }
    const entry = reserved
      ? round.requests.find((item) => item.roundSequence === sequence)
      : requestEntry(round, sequence);
    if (!reserved) {
      round.requests.push(entry);
      await save();
    }
    let reply;
    try {
      reply = await bounded((signal) =>
        connection.request({
          path,
          method: item.method,
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
          headers: {
            ...(item.method === "POST"
              ? {
                  "content-type": "application/json",
                  origin: origin ?? CHECK.origin,
                }
              : {}),
            ...(cookie ? { cookie } : {}),
            ...(csrf ? { "x-csrf-token": csrf } : {}),
          },
          signal,
        }),
      );
      requireThat(
        reply &&
          integer(reply.status) &&
          reply.status >= 100 &&
          reply.status <= 599 &&
          Buffer.isBuffer(reply.body) &&
          reply.body.length <= 65536,
        "invalid_http_response",
      );
      entry.httpStatus = reply.status;
      entry.bodyBytes = reply.body.length;
      entry.bodySha256 = hash(reply.body);
      const date = reply.headers?.date,
        ray = reply.headers?.["cf-ray"];
      if (
        typeof date === "string" &&
        /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
          date,
        ) &&
        Number.isFinite(Date.parse(date))
      )
        entry.serverDate = new Date(date).toISOString();
      if (typeof ray === "string" && /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(ray))
        entry.cfRay = ray;
      requireThat(
        (Array.isArray(item.expectedStatus)
          ? item.expectedStatus
          : [item.expectedStatus]
        ).includes(reply.status),
        "unexpected_http_status",
      );
      requireThat(
        reply.headers?.["cache-control"] === "no-store" &&
          reply.headers?.["access-control-allow-origin"] === undefined,
        "http_security_headers",
      );
      try {
        reply.data = JSON.parse(reply.body.toString("utf8"));
      } catch {
        fail("invalid_http_json");
      }
      return reply;
    } catch (error) {
      entry.error =
        error instanceof SamplerError ? error.code : "http_outcome_unknown";
      throw error instanceof SamplerError
        ? error
        : new SamplerError("http_outcome_unknown");
    } finally {
      entry.endedAt = now();
      await save();
    }
  }
  function session(reply) {
    const set = Array.isArray(reply.headers["set-cookie"])
      ? reply.headers["set-cookie"][0]
      : reply.headers["set-cookie"];
    requireThat(
      typeof set === "string" &&
        /^__Host-shelf_session=[\w-]{43};/.test(set) &&
        /(?:^|;)\s*Secure(?:;|$)/i.test(set) &&
        /(?:^|;)\s*HttpOnly(?:;|$)/i.test(set) &&
        /(?:^|;)\s*Path=\/(?:;|$)/.test(set) &&
        /(?:^|;)\s*SameSite=Strict(?:;|$)/i.test(set) &&
        /(?:^|;)\s*Max-Age=86400(?:;|$)/.test(set) &&
        !/(?:^|;)\s*Domain=/i.test(set),
      "invalid_session_cookie",
    );
    requireThat(
      reply.data.authenticated === true &&
        typeof reply.data.csrfToken === "string" &&
        /^[\w-]{43}$/.test(reply.data.csrfToken),
      "invalid_login_response",
    );
    return { cookie: set.split(";")[0], csrf: reply.data.csrfToken };
  }
  try {
    await save();
    record.state = "preflight";
    requireThat(
      (await manage("inspectVersion"))?.versionId === plan.versionId,
      "deployed_version_mismatch",
    );
    const identity = await manage("inspectDatabaseIdentity");
    requireThat(
      identity?.databaseId === target.databaseId &&
        identity.databaseName === CHECK.databaseName,
      "database_identity_mismatch",
    );
    const db = await manage("inspectDatabase");
    requireThat(
      db?.scope === "check" &&
        db.origin === CHECK.origin &&
        db.schemaVersion === 2 &&
        db.authEnabled === false &&
        integer(db.generation) &&
        db.activeSessions === 0,
      "check_not_closed_or_invalid",
    );
    const entry = await manage("inspectEntry");
    requireThat(
      entry?.enabled === false && entry.previewsEnabled === false,
      "entry_not_closed",
    );
    await reserve("maintenance");
    await reserve("maintenance");
    generation = db.generation;
    touched = true; // Arm finally before the first mutation, including timeout.
    const enabled = await manage("enableAuth", {
      expectedGeneration: generation,
    });
    requireThat(
      enabled?.enabled === true && enabled.generation === generation + 1,
      "auth_enable_unverified",
    );
    generation++;
    const seeded = await manage("seedMaintenance", {
      limits: MAINTENANCE_LIMITS,
      batches: 2,
    });
    maintenanceCounts(seeded?.counts);
    for (const [key, n] of Object.entries(MAINTENANCE_LIMITS))
      requireThat(seeded.counts[key] >= 2 * n, "maintenance_fixture_not_full");
    const enabledEntry = await manage("enableEntry");
    requireThat(
      enabledEntry?.enabled === true && enabledEntry.previewsEnabled === false,
      "entry_enable_unverified",
    );
    await wait(30000); // Entry propagation, without an extra business probe.
    connection = await bounded((signal) =>
      adapters.connect({ origin: CHECK.origin, signal }),
    );
    requireThat(
      connection?.protocol === "h2" &&
        typeof connection.request === "function" &&
        typeof connection.close === "function",
      "single_h2_connection_required",
    );
    for (const name of ["first-access", "subsequent"]) {
      if (name === "subsequent") {
        // Avoid reusing the previous minute's login allowance. No retries.
        const instant = clock.now();
        await wait(60000 - (instant % 60000) + 100);
      }
      record.state = `collect-${name}`;
      const round = {
        name,
        startedAt: now(),
        endedAt: null,
        ok: false,
        requests: [],
        coverage: null,
      };
      record.rounds.push(round);
      const bookId = `cf03-sampler-${name}`,
        fileId = `${bookId}-file`;
      before = await manage("prepareRound", {
        round: name,
        bookId,
        fileId,
        expectedGeneration: generation,
        unknownCategory: "Cloud Test New Category",
      });
      requireThat(
        before?.fixtureInserted === 1 &&
          before.metadataVersion === 0 &&
          integer(before.ordinal) &&
          before.ordinal <= 980 &&
          integer(before.metadataAdmissions) &&
          before.day === now().slice(0, 10) &&
          integer(before.cutoff) &&
          before.cutoff < clock.now(),
        "round_fixture_unverified",
      );
      const bookPath = `/api/books/${bookId}`,
        filePath = `/api/files/${fileId}/access`;
      const send = (n, path, opts, reserved) =>
        request(round, n, path, opts, reserved);
      requireThat(
        (await send(1, "/api/health")).data.ok === true,
        "health_semantics",
      );
      requireThat(
        (await send(2, "/api/session")).data.authenticated === false,
        "anonymous_session_semantics",
      );
      await send(3, filePath);
      await send(4, "/api/files/unknown-file/access");
      await send(5, "/api/does-not-exist");
      await send(6, "/api/login", {
        origin: "https://sickate.github.io",
        body: { accessKey: "invalid" },
      });
      await send(7, "/api/login", { body: { accessKey: "ordinary-password" } });
      await send(8, "/api/login", {
        body: { accessKey: randomBytes(32).toString("base64url") },
      });
      const auth = session(
        await send(9, "/api/login", { body: { accessKey: options.accessKey } }),
      );
      requireThat(
        (await send(10, "/api/session", auth)).data.authenticated === true,
        "authenticated_session_semantics",
      );
      await send(11, `${bookPath}/metadata`, {
        cookie: auth.cookie,
        body: { expectedVersion: 0, changes: { title: "blocked" } },
      });
      await send(12, `${bookPath}/metadata`, {
        ...auth,
        body: JSON.stringify({ junk: "x".repeat(17000) }),
      });
      await wait(plan.spacingMs);
      await reserve("business");
      await reserve("business");
      round.requests.push(requestEntry(round, 13), requestEntry(round, 14));
      await save();
      // Reserve both requests and open both streams on the already used session.
      // Await both settled outcomes so receipt and connection remain consistent.
      const pair = await Promise.allSettled(
        ["First edit", "Second edit"].map((title, i) =>
          send(
            13 + i,
            `${bookPath}/metadata`,
            {
              ...auth,
              body: {
                expectedVersion: 0,
                changes: { title, category: "Cloud Test New Category" },
              },
            },
            true,
          ),
        ),
      );
      requireThat(
        pair.every((result) => result.status === "fulfilled"),
        "cas_stream_failed",
      );
      const pairStatusesValid =
        pair
          .map((result) => result.value.status)
          .sort()
          .join(",") === "200,409";
      const overlay = (await send(15, bookPath)).data;
      requireThat(
        overlay.metadataVersion === 1 &&
          ["First edit", "Second edit"].includes(overlay.book?.title) &&
          overlay.book?.category === "Cloud Test New Category" &&
          overlay.book?.files?.[0]?.reason === "not_uploaded",
        "metadata_overlay_semantics",
      );
      await send(16, filePath, auth);
      requireThat(
        (await send(17, "/api/logout", { ...auth, body: {} })).data
          .authenticated === false,
        "logout_semantics",
      );
      requireThat(
        (await send(18, "/api/session", auth)).data.authenticated === false,
        "revoked_session_semantics",
      );
      await send(19, filePath, auth);
      const auth2 = session(
        await send(20, "/api/login", {
          body: { accessKey: options.accessKey },
        }),
      );
      const rotation = await manage("rotateGeneration", {
        expectedGeneration: generation,
      });
      requireThat(
        rotation?.generation === generation + 1,
        "generation_rotation_unverified",
      );
      generation++;
      requireThat(
        (await send(21, "/api/session", auth2)).data.authenticated === false,
        "generation_session_semantics",
      );
      round.endedAt = now();
      // Real D1 proof is deliberately after request 21, never a reason to omit it.
      const after = await manage("readCoverage", {
        round: name,
        cutoff: before?.cutoff,
        day: before?.day,
        bookId,
      });
      round.coverage = coverageProof(before, after, name);
      requireThat(pairStatusesValid, "cas_status_pair");
      round.ok = true;
      await save();
      requireThat(
        (await manage("inspectVersion"))?.versionId === plan.versionId,
        "deployed_version_mismatch",
      );
    }
    requireThat(
      record.rounds.some((round) => round.coverage.fullBatch),
      "maintenance_not_triggered",
    );
    // Close the business transport before waiting for eventually consistent CPU.
    await bounded(() => connection.close());
    connection = null;
    await wait(plan.analyticsDelayMs);
    record.state = "analytics";
    await save();
    const windows = [
      ...record.rounds.map((round) => ({ name: round.name, rounds: [round] })),
      { name: "combined", rounds: record.rounds },
    ];
    for (const window of windows) {
      const requests = window.rounds
        .flatMap((round) => round.requests)
        .map(({ sequence, branch, versionId, startedAt, endedAt }) => ({
          sequence,
          branch,
          versionId,
          startedAt,
          endedAt,
        }));
      const from = new Date(
          Date.parse(requests[0].startedAt) - 2000,
        ).toISOString(),
        to = new Date(Date.parse(requests.at(-1).endedAt) + 2000).toISOString();
      await wait(Math.max(0, Date.parse(to) - clock.now()));
      let analysis;
      for (let attempt = 1; attempt <= plan.analyticsAttempts; attempt++) {
        if (attempt > 1) await wait(15000);
        const input = await manage("analytics", {
          window: window.name,
          from,
          to,
          expectedRequests: requests.length,
          requests,
        });
        // Controller supplies the authoritative request window, identities and
        // sequence; an adapter cannot drop requests to obtain a better gate.
        const data = {
          ...input,
          workerName: CHECK.name,
          scope: "check",
          versionId: plan.versionId,
          query: { ...input?.query, from, to },
          requests,
        };
        analysis = analyzeCpuEvidence(data);
        record.analytics.push({ window: window.name, attempt, analysis });
        await save();
        if (
          analysis.gate.status === "fail" ||
          analysis.status === "complete" ||
          (analysis.status === "incomplete" &&
            analysis.reasons.every(
              (reason) => reason === "ambiguous_attribution",
            ))
        )
          break;
      }
    }
    record.ok = true;
  } catch (error) {
    record.error =
      error instanceof SamplerError ? error.code : "sampler_failed";
  } finally {
    record.state = "closing";
    cleanupMode = true;
    if (connection) {
      try {
        await bounded(() => connection.close(), true);
      } catch {
        record.cleanup.errors.push("transport_close_failed");
      }
    }
    if (touched) {
      for (const command of CLEANUP) {
        try {
          const result = await manage(command);
          if (command === "closeAuth") {
            requireThat(
              result?.enabled === false &&
                integer(result.generation) &&
                result.generation > generation,
              "auth_shutdown_unverified",
            );
            record.cleanup.generation = result.generation;
          }
          if (command === "verifyAuthClosed") {
            requireThat(
              result?.enabled === false &&
                result.activeSessions === 0 &&
                result.generation === record.cleanup.generation,
              "auth_shutdown_unverified",
            );
            record.cleanup.authClosed = true;
          }
          if (command === "closeEntry")
            requireThat(
              result?.enabled === false && result.previewsEnabled === false,
              "entry_shutdown_unverified",
            );
          if (command === "verifyEntryClosed") {
            requireThat(
              result?.enabled === false && result.previewsEnabled === false,
              "entry_shutdown_unverified",
            );
            record.cleanup.entryClosed = true;
          }
        } catch {
          record.cleanup.errors.push(`${command}_failed`);
        }
      }
      record.cleanup.complete =
        record.cleanup.authClosed === true &&
        record.cleanup.entryClosed === true &&
        record.cleanup.errors.length === 0;
    } else record.cleanup.complete = true;
    record.ok = record.ok && record.cleanup.complete && !record.receiptFailure;
    record.state = record.ok ? "collected" : "stopped";
    record.endedAt = now();
    const latest = record.analytics.filter(
      (entry, index, all) =>
        !all.slice(index + 1).some((other) => other.window === entry.window),
    );
    record.cpuGate =
      record.ok &&
      latest.length === 3 &&
      latest.every((entry) => entry.analysis.gate.status === "pass")
        ? "pass"
        : latest.some((entry) => entry.analysis.gate.status === "fail")
          ? "fail"
          : "unknown";
    await save();
  }
  return record;
}
