#!/usr/bin/env node
// Read-only observations, never an upload authorization or a billing assertion.
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { selectCredentials } from "./cf-deploy.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VOLT_CONFIG = "/Users/paw/code/volt/cloud/wrangler.jsonc";
const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
export const R2_AUDIT_LIMITS = Object.freeze({
  requests: 3,
  timeoutMs: 30_000,
  responseBytes: 1_000_000,
  chunks: 100_000,
  groups: 1000,
});
const QUERY = `query ShelfR2Observation($a:string!,$f:Time!,$m:Time!,$t:Time!){viewer{accounts(filter:{accountTag:$a}){
accountStorage:r2StorageAdaptiveGroups(limit:1000,filter:{datetime_geq:$f,datetime_leq:$t},orderBy:[datetime_DESC]){dimensions{datetime storageClass}max{payloadSize metadataSize}}
shelfStorage:r2StorageAdaptiveGroups(limit:1000,filter:{datetime_geq:$f,datetime_leq:$t,bucketName:"the-shelf-books"},orderBy:[datetime_DESC]){dimensions{datetime storageClass}max{payloadSize metadataSize}}
accountOperations:r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:$m,datetime_leq:$t}){dimensions{actionType storageClass}sum{requests}}
shelfOperations:r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:$m,datetime_leq:$t,bucketName:"the-shelf-books"}){dimensions{actionType storageClass}sum{requests}}
}}}`;
const CLASS_A = new Set(
  "ListBuckets PutBucket ListObjects ListObjectsV2 PutObject CopyObject CompleteMultipartUpload CreateMultipartUpload LifecycleStorageTierTransition ListMultipartUploads UploadPart UploadPartCopy ListParts PutBucketEncryption PutBucketCors PutBucketLifecycleConfiguration".split(
    " ",
  ),
);
const CLASS_B = new Set(
  "HeadBucket HeadObject GetObject UsageSummary GetBucketEncryption GetBucketLocation GetBucketCors GetBucketLifecycleConfiguration".split(
    " ",
  ),
);
const FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);
const CODES = new Set([
  "arguments",
  "configuration",
  "private_path",
  "private_file",
  "run_exists",
  "evidence_failed",
  "volt_condition_unknown",
  "volt_r2_present",
  "http_failed",
  "response_invalid",
  "response_limit",
  "deadline",
  "graphql_failed",
  "operation_unknown",
]);
export class R2AuditError extends Error {
  constructor(code) {
    super(CODES.has(code) ? code : "operation_unknown");
    this.code = this.message;
  }
}
const fail = (code) => {
  throw new R2AuditError(code);
};
const insist = (ok, code) => {
  if (!ok) fail(code);
};
const safeCode = (e) =>
  e instanceof R2AuditError ? e.code : "operation_unknown";
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  record(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const timestamp = (v) =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

// A small JSONC lexer: comments and trailing commas are recognized only outside
// quoted strings. JSON.parse remains responsible for all JSON grammar checks.
export function parseVoltConfig(source) {
  insist(
    typeof source === "string" && Buffer.byteLength(source) <= 1_000_000,
    "volt_condition_unknown",
  );
  let clean = "",
    quoted = false,
    escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i],
      n = source[i + 1];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      clean += c;
    } else if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      clean += "\n";
    } else if (c === "/" && n === "*") {
      const end = source.indexOf("*/", i + 2);
      insist(end !== -1, "volt_condition_unknown");
      i = end + 1;
      clean += " ";
    } else clean += c;
  }
  let normalized = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      normalized += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else {
      if (c === '"') quoted = true;
      if (c === "," && /^[\s]*[}\]]/.test(clean.slice(i + 1))) continue;
      normalized += c;
    }
  }
  try {
    return JSON.parse(normalized);
  } catch {
    fail("volt_condition_unknown");
  }
}

export function projectVoltCondition(config, report, accountId) {
  insist(
    record(config) && typeof config.account_id === "string" && record(report),
    "volt_condition_unknown",
  );
  insist(
    report.ok === true &&
      report.accountMatches === true &&
      typeof report.worker === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(report.worker) &&
      config.name === report.worker,
    "volt_condition_unknown",
  );
  let accountMatches = true,
    hasR2 = false;
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!record(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "account_id") accountMatches &&= entry === accountId;
      if (key === "r2_buckets") {
        insist(Array.isArray(entry), "volt_condition_unknown");
        hasR2 ||= entry.length > 0;
      }
      visit(entry);
    }
  };
  visit(config);
  insist(accountMatches, "volt_condition_unknown");
  insist(!hasR2, "volt_r2_present");
  return { accountMatches: true, localR2Absent: true, worker: report.worker };
}
export function projectVoltSettings(body) {
  insist(
    record(body) &&
      body.success === true &&
      (!body.errors ||
        (Array.isArray(body.errors) && body.errors.length === 0)) &&
      record(body.result) &&
      Array.isArray(body.result.bindings) &&
      body.result.bindings.length <= 256,
    "volt_condition_unknown",
  );
  insist(
    body.result.bindings.every((v) => record(v) && typeof v.type === "string"),
    "volt_condition_unknown",
  );
  const r2Absent = !body.result.bindings.some((v) =>
    v.type.toLowerCase().includes("r2"),
  );
  return {
    accountMatches: true,
    localR2Absent: true,
    remoteR2Absent: r2Absent,
  };
}
function storageClass(value) {
  if (["Standard", "STANDARD", "standard"].includes(value)) return "Standard";
  if (["InfrequentAccess", "STANDARD_IA", "infrequentAccess"].includes(value))
    return "InfrequentAccess";
  return "unknown";
}
function storageProjection(groups, now) {
  insist(
    Array.isArray(groups) && groups.length <= R2_AUDIT_LIMITS.groups,
    "response_invalid",
  );
  const maxima = groups.map((group) => {
    insist(
      exact(group, ["dimensions", "max"]) &&
        exact(group.dimensions, ["datetime", "storageClass"]) &&
        timestamp(group.dimensions.datetime) &&
        exact(group.max, ["payloadSize", "metadataSize"]) &&
        Object.values(group.max).every(count),
      "response_invalid",
    );
    const ageMs = now - Date.parse(group.dimensions.datetime);
    insist(ageMs >= 0, "response_invalid");
    return {
      sampleAt: group.dimensions.datetime,
      storageClass: storageClass(group.dimensions.storageClass),
      payloadBytes: group.max.payloadSize,
      metadataBytes: group.max.metadataSize,
      ageMs,
      fresh: ageMs <= 300_000,
    };
  });
  return {
    totalBytes: null,
    aggregation: "max_not_total",
    empty: groups.length === 0,
    limitReached: groups.length === R2_AUDIT_LIMITS.groups,
    observedMaxima: maxima,
  };
}
function operationProjection(groups) {
  insist(
    Array.isArray(groups) && groups.length <= R2_AUDIT_LIMITS.groups,
    "response_invalid",
  );
  const totals = { classA: 0, classB: 0, free: 0, unclassified: 0 };
  let standardOnly = groups.length > 0;
  for (const group of groups) {
    insist(
      exact(group, ["dimensions", "sum"]) &&
        exact(group.dimensions, ["actionType", "storageClass"]) &&
        typeof group.dimensions.actionType === "string" &&
        exact(group.sum, ["requests"]) &&
        count(group.sum.requests),
      "response_invalid",
    );
    const action = group.dimensions.actionType;
    const key = CLASS_A.has(action)
      ? "classA"
      : CLASS_B.has(action)
        ? "classB"
        : FREE.has(action)
          ? "free"
          : "unclassified";
    totals[key] += group.sum.requests;
    insist(count(totals[key]), "response_invalid");
    standardOnly &&= storageClass(group.dimensions.storageClass) === "Standard";
  }
  return {
    observedCounts: groups.length ? totals : null,
    empty: groups.length === 0,
    limitReached: groups.length === R2_AUDIT_LIMITS.groups,
    standardOnly,
    complete: false,
    sampling: "unknown",
    ingestionDelay: "unknown",
  };
}
export function r2ObservationRequest(accountId, now) {
  insist(
    /^[a-f0-9]{32}$/.test(accountId || "") && Number.isSafeInteger(now),
    "arguments",
  );
  const t = new Date(now).toISOString(),
    f = new Date(now - 86_400_000).toISOString(),
    m = t.slice(0, 7) + "-01T00:00:00.000Z";
  return { query: QUERY, variables: { a: accountId, f, m, t } };
}
export function projectR2Observation(body, now) {
  insist(
    record(body) &&
      Object.keys(body).every((k) => ["data", "errors"].includes(k)) &&
      (!body.errors ||
        (Array.isArray(body.errors) && body.errors.length === 0)),
    "graphql_failed",
  );
  insist(
    exact(body.data, ["viewer"]) &&
      exact(body.data.viewer, ["accounts"]) &&
      Array.isArray(body.data.viewer.accounts) &&
      body.data.viewer.accounts.length === 1,
    "response_invalid",
  );
  const account = body.data.viewer.accounts[0];
  insist(
    exact(account, [
      "accountStorage",
      "shelfStorage",
      "accountOperations",
      "shelfOperations",
    ]),
    "response_invalid",
  );
  return {
    fetchedAt: new Date(now).toISOString(),
    billingPeriod: new Date(now).toISOString().slice(0, 7),
    accountStorage: storageProjection(account.accountStorage, now),
    shelfStorage: storageProjection(account.shelfStorage, now),
    accountOperations: operationProjection(account.accountOperations),
    shelfOperations: operationProjection(account.shelfOperations),
    plan: "unknown",
    completeCoverage: false,
    uploadEligible: false,
    accountEvidence: null,
    reasons: [
      "account_storage_max_is_not_sum",
      "storage_sampling_and_coverage_unproven",
      "operations_sampling_and_ingestion_unknown",
      "product_scoped_free_status_unproven",
    ],
  };
}
/** Official REST account metrics are observations, with no sample time/watermark.
 * The endpoint has no field-selection parameter. Validate and discard object
 * counts; retain only authorized storage numbers and fixed schema labels.
 * Uploaded/published overlap is undocumented, so never add these states. */
export function projectR2RestMetrics(body, now) {
  const allowed = (value, keys) =>
    record(value) && Object.keys(value).every((key) => keys.includes(key));
  insist(
    count(now) &&
      allowed(body, ["success", "errors", "messages", "result"]) &&
      body.success === true &&
      (!Object.hasOwn(body, "errors") ||
        (Array.isArray(body.errors) && body.errors.length === 0)) &&
      (!Object.hasOwn(body, "messages") ||
        (Array.isArray(body.messages) &&
          body.messages.every((message) => typeof message === "string"))) &&
      allowed(body.result, ["standard", "infrequentAccess"]),
    "response_invalid",
  );
  const observedStorage = {};
  let hasStorageObservation = false;
  for (const storageClass of ["standard", "infrequentAccess"]) {
    const value = body.result[storageClass];
    if (!Object.hasOwn(body.result, storageClass)) {
      observedStorage[storageClass] = null;
      continue;
    }
    insist(allowed(value, ["published", "uploaded"]), "response_invalid");
    observedStorage[storageClass] = {};
    for (const state of ["published", "uploaded"]) {
      if (!Object.hasOwn(value, state)) {
        observedStorage[storageClass][state] = null;
        continue;
      }
      const metrics = value[state];
      insist(
        allowed(metrics, ["payloadSize", "metadataSize", "objects"]) &&
          Object.values(metrics).every(count),
        "response_invalid",
      );
      hasStorageObservation ||=
        Object.hasOwn(metrics, "payloadSize") ||
        Object.hasOwn(metrics, "metadataSize");
      observedStorage[storageClass][state] = {
        payloadBytes: Object.hasOwn(metrics, "payloadSize")
          ? metrics.payloadSize
          : null,
        metadataBytes: Object.hasOwn(metrics, "metadataSize")
          ? metrics.metadataSize
          : null,
      };
    }
  }
  insist(hasStorageObservation, "response_invalid");
  return {
    fetchedAt: new Date(now).toISOString(),
    sampleAt: null,
    totalBytes: null,
    observedStorage,
    stateOverlap: "unknown",
    freshness: "unknown",
    ingestionDelay: "unknown",
    completeCoverage: false,
  };
}
async function checkPath(location, privateRoot) {
  let current = path.parse(location).root;
  for (const part of location
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), "private_path");
    if (current === privateRoot || current.startsWith(privateRoot + path.sep))
      insist(
        (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(),
        "private_path",
      );
  }
}
async function readFile(filename, privateRequired = true) {
  const components = filename.split(path.sep);
  const privateIndex = components.indexOf(".local");
  await checkPath(
    path.dirname(filename),
    privateRequired && privateIndex !== -1
      ? components.slice(0, privateIndex + 1).join(path.sep)
      : "\0",
  );
  let h;
  try {
    const initial = await fs.lstat(filename);
    insist(
      initial.isFile() && !initial.isSymbolicLink() && initial.nlink === 1,
      "private_file",
    );
    h = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await h.stat();
    insist(
      same(initial, before) &&
        before.isFile() &&
        before.nlink === 1 &&
        before.size <= 1_000_000 &&
        (!privateRequired ||
          ((before.mode & 0o777) === 0o600 && before.uid === process.getuid())),
      "private_file",
    );
    const text = await h.readFile("utf8"),
      after = await fs.lstat(filename);
    insist(
      same(before, after) &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        after.nlink === 1 &&
        (!privateRequired || (after.mode & 0o777) === 0o600),
      "private_file",
    );
    return text;
  } finally {
    await h?.close();
  }
}
async function evidenceStore(root, runId) {
  const privateRoot = path.join(root, ".local");
  await checkPath(root, "\0");
  let directory = root;
  for (const part of [".local", "r2-account-audit", runId]) {
    await checkPath(directory, privateRoot);
    const parent = directory;
    directory = path.join(parent, part);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (part === runId) fail("run_exists");
    }
    await checkPath(directory, privateRoot);
    const handle = await fs.open(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const originalDirectory = await fs.lstat(directory);
  const files = [];
  const verify = async () => {
    await checkPath(directory, privateRoot);
    insist(same(originalDirectory, await fs.lstat(directory)), "private_path");
    for (const file of files) {
      const stat = await fs.lstat(file.location);
      insist(
        same(stat, file.stat) &&
          stat.isFile() &&
          stat.nlink === 1 &&
          (stat.mode & 0o777) === 0o600 &&
          stat.uid === process.getuid(),
        "private_file",
      );
    }
  };
  return {
    verify,
    async write(name, value) {
      await verify();
      const location = path.join(directory, name);
      const h = await fs.open(
        location,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = await h.stat();
        insist(
          stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600,
          "private_file",
        );
        await h.writeFile(JSON.stringify(value) + "\n");
        await h.sync();
        files.push({ location, stat });
      } finally {
        await h.close();
      }
      const d = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await d.sync();
      } finally {
        await d.close();
      }
      await verify();
    },
  };
}
const discard = (response) => {
  try {
    if (response?.body && !response.body.locked)
      Promise.resolve(response.body.cancel()).catch(() => {});
  } catch {}
};
async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let response, reader, timer;
  const cancel = () => {
    try {
      if (reader) Promise.resolve(reader.cancel()).catch(() => {});
      else discard(response);
    } catch {}
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      cancel();
      reject(new R2AuditError("deadline"));
    }, timeoutMs);
  });
  const perform = async () => {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      discard(response);
      fail("deadline");
    }
    insist(
      response.status === 200 &&
        !response.redirected &&
        (!response.url || response.url === url),
      "http_failed",
    );
    insist(
      /^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") || "",
      ) && response.body?.getReader,
      "response_invalid",
    );
    const length = response.headers.get("content-length");
    insist(
      length === null ||
        (/^\d+$/.test(length) &&
          Number(length) <= R2_AUDIT_LIMITS.responseBytes),
      "response_limit",
    );
    reader = response.body.getReader();
    const parts = [];
    let bytes = 0,
      chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) fail("deadline");
      if (done) break;
      insist(
        value instanceof Uint8Array &&
          ++chunks <= R2_AUDIT_LIMITS.chunks &&
          value.byteLength <= R2_AUDIT_LIMITS.responseBytes - bytes,
        "response_limit",
      );
      bytes += value.byteLength;
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  };
  try {
    return await Promise.race([perform(), deadline]);
  } catch (e) {
    fail(safeCode(e));
  } finally {
    clearTimeout(timer);
    controller.abort();
    cancel();
    try {
      reader?.releaseLock();
    } catch {}
  }
}

export async function auditR2Account({
  execute = false,
  runId = randomUUID(),
  projectRoot = ROOT,
  voltConfigPath = VOLT_CONFIG,
  config,
  environment = process.env,
  fetchImpl = fetch,
  clock = Date.now,
  timeoutMs = R2_AUDIT_LIMITS.timeoutMs,
} = {}) {
  let requests = 0,
    evidence;
  try {
    insist(
      typeof execute === "boolean" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId) &&
        path.isAbsolute(projectRoot) &&
        path.isAbsolute(voltConfigPath) &&
        record(environment) &&
        typeof fetchImpl === "function" &&
        typeof clock === "function" &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs >= 1 &&
        timeoutMs <= 30_000,
      "arguments",
    );
    if (!execute)
      return {
        status: "preview",
        readOnly: true,
        limits: R2_AUDIT_LIMITS,
        uploadEligible: false,
      };
    if (config === undefined) {
      const env = parseEnv(await readFile(path.join(projectRoot, ".env")));
      let selected;
      try {
        selected = selectCredentials(environment, env);
      } catch {
        fail("configuration");
      }
      insist(
        !selected.ci && env.SHELF_R2_ACCOUNT_ID === selected.accountId,
        "configuration",
      );
      config = { accountId: selected.accountId, token: selected.token };
    }
    insist(
      record(config) &&
        /^[a-f0-9]{32}$/.test(config.accountId || "") &&
        typeof config.token === "string" &&
        /^[A-Za-z0-9._~-]{20,4096}$/.test(config.token),
      "configuration",
    );
    const accountId = config.accountId,
      token = config.token;
    const local = projectVoltCondition(
      parseVoltConfig(await readFile(voltConfigPath, false)),
      JSON.parse(
        await readFile(
          path.join(projectRoot, ".local/cf03/volt-r2-recheck.json"),
        ),
      ),
      accountId,
    );
    evidence = await evidenceStore(projectRoot, runId);
    await evidence.write("run-start.json", {
      schemaVersion: 1,
      readOnly: true,
      limits: R2_AUDIT_LIMITS,
      startedAt: new Date(clock()).toISOString(),
    });
    const request = async (label, url, options) => {
      insist(requests < R2_AUDIT_LIMITS.requests, "arguments");
      const sequence = ++requests;
      await evidence.write(`${sequence}-pending.json`, {
        sequence,
        label,
        status: "pending",
        registeredAt: new Date(clock()).toISOString(),
      });
      await evidence.verify();
      return fetchJson(
        fetchImpl,
        url,
        {
          ...options,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        },
        timeoutMs,
      );
    };
    const settingsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${local.worker}/settings`;
    const condition = projectVoltSettings(
      await request("volt-r2-condition", settingsUrl, { method: "GET" }),
    );
    await evidence.write("1-result.json", { status: "observed", ...condition });
    insist(condition.remoteR2Absent, "volt_r2_present");
    const queriedAt = clock();
    const query = r2ObservationRequest(accountId, queriedAt);
    const response = await request("r2-pure-aggregates", ENDPOINT, {
      method: "POST",
      body: JSON.stringify(query),
    });
    const observed = projectR2Observation(response, clock());
    insist(
      observed.billingPeriod === new Date(queriedAt).toISOString().slice(0, 7),
      "response_invalid",
    );
    await evidence.write("2-result.json", { status: "observed", ...observed });
    const restMetrics = projectR2RestMetrics(
      await request(
        "r2-account-storage-metrics",
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/metrics`,
        { method: "GET" },
      ),
      clock(),
    );
    await evidence.write("3-result.json", {
      status: "observed",
      ...restMetrics,
    });
    const result = {
      schemaVersion: 1,
      status: "observed_incomplete",
      managementRequests: requests,
      condition,
      queryWindow: {
        storageFrom: query.variables.f,
        operationsFrom: query.variables.m,
        through: query.variables.t,
      },
      ...observed,
      accountStorageRest: restMetrics,
    };
    await evidence.write("summary.json", result);
    return result;
  } catch (error) {
    const result = {
      status: "stopped",
      code: safeCode(error),
      managementRequests: requests,
      uploadEligible: false,
      accountEvidence: null,
    };
    if (evidence) {
      try {
        await evidence.write("stopped.json", result);
      } catch {}
    }
    return result;
  }
}
export function parseR2AuditArgs(args) {
  const result = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    insist(!seen.has(arg), "arguments");
    seen.add(arg);
    if (arg === "--execute") result.execute = true;
    else if (arg === "--run-id") {
      result.runId = args[++i];
      insist(
        typeof result.runId === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(result.runId),
        "arguments",
      );
    } else fail("arguments");
  }
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await auditR2Account(
      parseR2AuditArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify(result));
    if (result.status === "stopped") process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ status: "stopped", code: safeCode(e) }));
    process.exitCode = 1;
  }
}
