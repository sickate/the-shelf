// Read-only account aggregates. No resource enumeration, SQL, subscription or billing API.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const QUOTA_LIMITS = Object.freeze({
  management: 12,
  timeoutMs: 30000,
  responseBytes: 512 * 1024,
  rawBytes: 6 * 1024 * 1024,
});
const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const QUERIES = Object.freeze({
  workers:
    "query ShelfWorkersQuota($a:string!,$f:Time!,$t:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:2,filter:{datetime_geq:$f,datetime_lt:$t}){sum{requests}avg{sampleInterval}}}}}",
  d1: "query ShelfD1Quota($a:string!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:2,filter:{date_geq:$d,date_leq:$d}){sum{rowsRead rowsWritten}}}}}",
});
const DATASETS = Object.freeze({
  workers: "workersInvocationsAdaptive",
  d1: "d1AnalyticsAdaptiveGroups",
});
const COUNT_FIELDS = Object.freeze({
  workers: ["requests"],
  d1: ["rowsRead", "rowsWritten"],
});
const FREE_LIMITS = Object.freeze({
  workers: { requests: 100000 },
  d1: { rowsRead: 5000000, rowsWritten: 100000 },
});
const own = (o, keys) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).every((k) => keys.includes(k));
const exact = (o, keys) =>
  own(o, keys) && Object.keys(o).length === keys.length;
const count = (n) => Number.isSafeInteger(n) && n >= 0;
export class QuotaAuditError extends Error {
  constructor(code) {
    super(`Account quota audit stopped (${code}).`);
    this.code = code;
  }
}
const insist = (ok, code) => {
  if (!ok) throw new QuotaAuditError(code);
};
const safeCode = (e) =>
  e instanceof QuotaAuditError ? e.code : "operation_unknown";
function windowFor(now) {
  const end = new Date(now);
  insist(Number.isFinite(end.valueOf()), "window");
  const to = end.toISOString();
  const from = `${to.slice(0, 10)}T00:00:00.000Z`;
  insist(from !== to, "empty_window");
  return { utcDay: to.slice(0, 10), from, to };
}
export function quotaPreview(now = new Date()) {
  return {
    schemaVersion: 1,
    readOnly: true,
    window: windowFor(now),
    limits: { ...QUOTA_LIMITS },
    requests: Object.entries(QUERIES).map(([label, query]) => ({
      label,
      method: "POST",
      endpoint: ENDPOINT,
      query,
    })),
    freeStatus: "unknown",
    subscriptionApi: "not_called_no_product_scoped_contract",
  };
}
export function quotaRequest(label, accountId, window) {
  insist(
    Object.hasOwn(QUERIES, label) && /^[a-f0-9]{32}$/.test(accountId || ""),
    "target",
  );
  insist(
    exact(window, ["utcDay", "from", "to"]) &&
      JSON.stringify(windowFor(window.to)) === JSON.stringify(window),
    "window",
  );
  return {
    query: QUERIES[label],
    variables:
      label === "workers"
        ? { a: accountId, f: window.from, t: window.to }
        : { a: accountId, d: window.utcDay },
  };
}
function unknown(label, reason) {
  return {
    observedAggregate: null,
    sampleInterval: null,
    sampling: "unknown",
    complete: false,
    completenessReasons: [
      reason,
      "ingestion_delay_unknown",
      "management_plane_coverage_unknown",
    ],
    filterGranularity: label === "d1" ? "utc-day" : "datetime",
    receivedAt: null,
    freeStatus: "unknown",
    conditionalFreeDailyLimit: { ...FREE_LIMITS[label] },
    remaining: null,
  };
}
// Reject unexpected selections: never persist error text, identifiers or unsolicited fields.
export function projectQuotaResponse(label, body) {
  insist(Object.hasOwn(DATASETS, label), "target");
  insist(
    own(body, ["data", "errors"]) &&
      (!Object.hasOwn(body, "errors") ||
        body.errors === null ||
        (Array.isArray(body.errors) && body.errors.length === 0)),
    "graphql_error",
  );
  insist(
    exact(body.data, ["viewer"]) && exact(body.data.viewer, ["accounts"]),
    "response_contract",
  );
  const accounts = body.data.viewer.accounts;
  insist(
    Array.isArray(accounts) &&
      accounts.length === 1 &&
      exact(accounts[0], [DATASETS[label]]),
    "account_result_unknown",
  );
  const groups = accounts[0][DATASETS[label]];
  insist(
    Array.isArray(groups) && groups.length === 1,
    groups?.length === 0 ? "empty_not_zero" : "aggregation_unknown",
  );
  const group = groups[0];
  insist(
    exact(group, label === "workers" ? ["sum", "avg"] : ["sum"]) &&
      exact(group.sum, COUNT_FIELDS[label]) &&
      COUNT_FIELDS[label].every((k) => count(group.sum[k])),
    "count_unknown",
  );
  const out = unknown(label, "billing_equivalence_unproven");
  out.observedAggregate = { ...group.sum };
  if (label === "workers") {
    insist(
      exact(group.avg, ["sampleInterval"]) &&
        typeof group.avg.sampleInterval === "number" &&
        Number.isFinite(group.avg.sampleInterval) &&
        group.avg.sampleInterval >= 1,
      "sampling_unknown",
    );
    out.sampleInterval = group.avg.sampleInterval;
    out.sampling =
      out.sampleInterval > 1 ? "sampled_estimate" : "reported_interval_one";
    if (out.sampleInterval > 1)
      out.completenessReasons.push("sampled_estimate");
  } else out.completenessReasons.push("sampling_unknown");
  return out;
}
async function privateDirectory(directory) {
  insist(path.isAbsolute(directory), "private_path");
  // Validate every ancestor: a symlink in .local or its parents must not redirect evidence.
  let current = path.parse(directory).root;
  for (const part of directory
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), "private_path");
    if (current === directory || current.split(path.sep).includes(".local"))
      insist((stat.mode & 0o777) === 0o700, "private_permissions");
  }
}
async function syncDirectory(directory) {
  const h = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function createPrivate(filename, value) {
  const h = await fs.open(
    filename,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await h.writeFile(value);
    await h.sync();
  } finally {
    await h.close();
  }
}
async function boundedBody(response) {
  const length = response.headers.get("content-length");
  if (!(
    length === null ||
    (/^\d+$/.test(length) && Number(length) <= QUOTA_LIMITS.responseBytes)
  )) {
    await response.body?.cancel().catch(() => {});
    throw new QuotaAuditError("response_limit");
  }
  insist(
    response.body && typeof response.body.getReader === "function",
    "response_body",
  );
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      insist(size <= QUOTA_LIMITS.responseBytes, "response_limit");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function runAudit({
  accountId,
  token,
  runDirectory,
  execute = false,
  now = () => new Date(),
  fetcher = fetch,
} = {}) {
  const preview = quotaPreview(now());
  if (!execute) return { ...preview, executed: false, managementRequests: 0 };
  insist(
    /^[a-f0-9]{32}$/.test(accountId || "") &&
      typeof token === "string" &&
      /^[A-Za-z0-9._~-]{20,4096}$/.test(token),
    "credentials",
  );
  await privateDirectory(runDirectory);
  // Exclusive marker is never removed, including failed starts. No replay/resume/automatic retries.
  try {
    await createPrivate(
      path.join(runDirectory, "run-start.json"),
      JSON.stringify({
        schemaVersion: 1,
        window: preview.window,
        limits: QUOTA_LIMITS,
      }) + "\n",
    );
    await syncDirectory(runDirectory);
  } catch {
    throw new QuotaAuditError("run_already_started_or_persistence_failed");
  }
  let ledger;
  try {
    ledger = await fs.open(
      path.join(runDirectory, "ledger.jsonl"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await ledger.sync();
    await syncDirectory(runDirectory);
  } catch {
    await ledger?.close().catch(() => {});
    throw new QuotaAuditError("ledger_persistence_failed");
  }
  let managementRequests = 0,
    reservedBytes = 0;
  const results = {
    workers: unknown("workers", "not_observed"),
    d1: unknown("d1", "not_observed"),
  };
  const record = async (value) => {
    try {
      await ledger.writeFile(JSON.stringify(value) + "\n");
      await ledger.sync();
    } catch {
      throw new QuotaAuditError("ledger_persistence_failed");
    }
  };
  try {
    for (const label of ["workers", "d1"]) {
      insist(
        new Date(now()).toISOString().slice(0, 10) === preview.window.utcDay,
        "utc_day_changed",
      );
      insist(
        managementRequests < QUOTA_LIMITS.management &&
          reservedBytes + QUOTA_LIMITS.responseBytes <= QUOTA_LIMITS.rawBytes,
        "request_budget",
      );
      const request = quotaRequest(label, accountId, preview.window);
      managementRequests++;
      reservedBytes += QUOTA_LIMITS.responseBytes;
      // Crash-safe upper bound: persisted BEFORE even constructing a network promise.
      await record({
        event: "reserve",
        sequence: managementRequests,
        label,
        reservedResponseBytes: QUOTA_LIMITS.responseBytes,
        observedAt: new Date(now()).toISOString(),
      });
      let outcome,
        responseText,
        projection,
        evidenceWriteStarted = false;
      try {
        const response = await fetcher(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(request),
          redirect: "error",
          signal: AbortSignal.timeout(QUOTA_LIMITS.timeoutMs),
        });
        responseText = await boundedBody(response);
        insist(response.ok, "http_error");
        let body;
        try {
          body = JSON.parse(responseText);
        } catch {
          throw new QuotaAuditError("response_json");
        }
        projection = projectQuotaResponse(label, body);
        projection.receivedAt = new Date(now()).toISOString();
        const ageMs =
          new Date(projection.receivedAt).valueOf() -
          new Date(preview.window.to).valueOf();
        projection.freshness =
          ageMs >= 0 && ageMs <= 300000
            ? "recent_observation"
            : "stale_observation";
        if (projection.freshness === "stale_observation")
          projection.completenessReasons.push("stale_observation");
        // Canonicalize after validation: duplicate JSON keys cannot smuggle discarded data into evidence.
        evidenceWriteStarted = true;
        await createPrivate(
          path.join(runDirectory, `${label}.json`),
          JSON.stringify(body) + "\n",
        );
        await syncDirectory(runDirectory);
        outcome = "observed";
      } catch (e) {
        outcome = safeCode(e);
        // A failed evidence write must stop the run, not advance to another HTTP call.
        if (evidenceWriteStarted)
          throw new QuotaAuditError("evidence_persistence_failed");
      }
      results[label] = projection || unknown(label, outcome);
      await record({
        event: "result",
        sequence: managementRequests,
        label,
        outcome,
        responseBytes:
          responseText === undefined ? null : Buffer.byteLength(responseText),
        observedAt: new Date(now()).toISOString(),
      });
    }
    const report = {
      schemaVersion: 1,
      executed: true,
      window: preview.window,
      observedAt: new Date(now()).toISOString(),
      managementRequests,
      ...results,
    };
    await createPrivate(
      path.join(runDirectory, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await syncDirectory(runDirectory);
    return report;
  } finally {
    await ledger.close();
  }
}

export async function auditAccountQuota(options) {
  try {
    return await runAudit(options);
  } catch (error) {
    throw new QuotaAuditError(safeCode(error));
  }
}
