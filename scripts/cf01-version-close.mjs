// Fixed CF01 version creation and separately verified deployment. Never a drain proof.
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CF01_CLOSE_INTERNALS as H,
  CF01_CLOSE_GUARDS,
  CF01_CLOSE_SQL,
  Cf01CloseError,
} from "./cf01-storage-close.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKER = "the-shelf-cf01";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const id = (v) => typeof v === "string" && UUID.test(v);
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v) => Number.isSafeInteger(v) && v >= 0;
const hash = (v) => createHash("sha256").update(v).digest("hex");
const digest = (v) => hash(JSON.stringify(v));
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : record(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const equal = (a, b) => digest(canonical(a)) === digest(canonical(b));
const exact = (v, keys) =>
  record(v) && Object.keys(v).every((k) => keys.includes(k));
const flags = () => ({
  cloudWriteFreezeProven: false,
  drainProven: false,
  uploadAllowed: false,
});
export const CF01_VERSION_CLOSE_LIMITS = Object.freeze({
  requests: Object.freeze({ create: 18, deploy: 20, status: 14 }),
  versionPosts: 1,
  deploymentPosts: 1,
  responseBytes: 2_000_000,
  requestBytes: 2_000_000,
  deadlineMs: 30_000,
});
const CODES = new Set(
  [
    "usage",
    "options_invalid",
    "shared_validation_failed",
    "state_invalid",
    "legacy_invalid",
    "config_invalid",
    "operator_locked",
    "request_budget",
    "write_budget",
    "source_invalid",
    "candidate_invalid",
    "metadata_invalid",
    "annotations_invalid",
    "settings_invalid",
    "deployment_invalid",
    "subdomain_invalid",
    "guards_invalid",
    "counts_invalid",
    "inventory_changed",
    "unknown_write_pending",
    "already_created",
    "already_deployed",
    "candidate_required",
    "expected_mismatch",
    "payload_limit",
    "deadline",
    "redirect_rejected",
    "response_invalid",
    "remote_rejected",
    "envelope_invalid",
    "local_or_transport_failure",
  ].map((v) => `cf01_version_close_${v}`),
);
export class Cf01VersionCloseError extends Error {
  constructor(code) {
    const safe = CODES.has(code)
      ? code
      : "cf01_version_close_local_or_transport_failure";
    super(safe);
    this.name = "Cf01VersionCloseError";
    this.code = safe;
  }
}
const fail = (suffix) => {
  throw new Cf01VersionCloseError(`cf01_version_close_${suffix}`);
};
// Reconstruct, never propagate caller-controlled message, name, stack, cause or mutated code.
const safeError = (e) =>
  new Cf01VersionCloseError(
    e instanceof Cf01VersionCloseError && CODES.has(e.code)
      ? e.code
      : e instanceof Cf01CloseError
        ? "cf01_version_close_shared_validation_failed"
        : undefined,
  );
const cancel = (v) => {
  try {
    void v?.cancel().catch(() => {});
  } catch {}
};
const projected = (value, safe = value) => ({ value, safe });
const FIVE = [
  "annotationsSha256",
  "bindingsSha256",
  "codeSha256",
  "metadataSha256",
  "subdomainSha256",
];
function fiveValid(v) {
  return (
    record(v) &&
    Object.keys(v).sort().join() === FIVE.join() &&
    Object.values(v).every((x) => typeof x === "string" && HEX.test(x))
  );
}
function annotations(v, deployment = false) {
  if (v === undefined) return {};
  if (
    !exact(
      v,
      deployment
        ? ["workers/message", "workers/triggered_by"]
        : ["workers/message", "workers/tag", "workers/triggered_by"],
    )
  )
    fail("annotations_invalid");
  for (const [k, text] of Object.entries(v)) {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > (k === "workers/tag" ? 100 : 1000)
    )
      fail("annotations_invalid");
  }
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => k !== "workers/triggered_by"),
  );
}
const META = [
  "compatibility_date",
  "compatibility_flags",
  "limits",
  "usage_model",
  "placement",
  "cache_options",
  "package_dependencies",
];
const READONLY = [
  "id",
  "number",
  "urls",
  "created_on",
  "author_email",
  "author_id",
  "source",
  "startup_time_ms",
];
function metadata(v) {
  const out = {};
  for (const key of META) {
    if (!Object.hasOwn(v, key)) continue;
    const x = v[key];
    let valid = false;
    if (key === "compatibility_date")
      valid = typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
    if (key === "compatibility_flags")
      valid =
        Array.isArray(x) &&
        x.length <= 64 &&
        new Set(x).size === x.length &&
        x.every(
          (f) => typeof f === "string" && f.length > 0 && f.length <= 100,
        );
    if (key === "limits")
      valid =
        exact(x, ["cpu_ms", "subrequests"]) &&
        Object.values(x).every((n) => int(n) && n > 0);
    if (key === "usage_model")
      valid = ["standard", "bundled", "unbound"].includes(x);
    if (key === "placement") valid = exact(x, ["mode"]) && x.mode === "smart";
    if (key === "cache_options")
      valid =
        exact(x, ["enabled", "cross_version_cache"]) &&
        x.enabled === false &&
        (x.cross_version_cache === undefined ||
          typeof x.cross_version_cache === "boolean");
    if (key === "package_dependencies")
      valid = Array.isArray(x) && x.length === 0;
    if (!valid) fail("metadata_invalid");
    out[key] = x;
  }
  return out;
}
function observability(v) {
  if (
    !exact(v, [
      "enabled",
      "head_sampling_rate",
      "issues",
      "logs",
      "traces",
      "redact_query_string",
    ])
  )
    fail("settings_invalid");
  const sample = (n) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  for (const [k, x] of Object.entries(v)) {
    if (
      ["enabled", "redact_query_string"].includes(k) &&
      typeof x !== "boolean"
    )
      fail("settings_invalid");
    if (k === "head_sampling_rate" && !sample(x)) fail("settings_invalid");
    if (
      k === "issues" &&
      x !== null &&
      (!exact(x, ["enabled"]) || typeof x.enabled !== "boolean")
    )
      fail("settings_invalid");
    if (["logs", "traces"].includes(k)) {
      const allowed = [
        "enabled",
        "head_sampling_rate",
        "destinations",
        "persist",
        ...(k === "logs" ? ["invocation_logs"] : ["propagation_policy"]),
      ];
      if (!exact(x, allowed)) fail("settings_invalid");
      for (const [n, value] of Object.entries(x)) {
        if (
          ["enabled", "persist", "invocation_logs"].includes(n) &&
          typeof value !== "boolean"
        )
          fail("settings_invalid");
        if (n === "head_sampling_rate" && !sample(value))
          fail("settings_invalid");
        if (
          n === "destinations" &&
          (!Array.isArray(value) || value.length !== 0)
        )
          fail("settings_invalid");
        if (
          n === "propagation_policy" &&
          ![null, "authenticated", "accept"].includes(value)
        )
          fail("settings_invalid");
      }
    }
  }
}
function settings(v, dbid) {
  if (
    !exact(v, [
      "bindings",
      "annotations",
      ...META.filter((k) => k !== "package_dependencies"),
      "logpush",
      "observability",
      "tags",
      "tail_consumers",
    ])
  )
    fail("settings_invalid");
  metadata(v);
  annotations(v.annotations);
  if (v.logpush !== undefined && typeof v.logpush !== "boolean")
    fail("settings_invalid");
  if (v.observability !== undefined) observability(v.observability);
  if (
    v.tags !== undefined &&
    v.tags !== null &&
    (!Array.isArray(v.tags) ||
      v.tags.length > 8 ||
      v.tags.some((x) => typeof x !== "string" || Buffer.byteLength(x) > 1024))
  )
    fail("settings_invalid");
  if (
    v.tail_consumers !== undefined &&
    v.tail_consumers !== null &&
    (!Array.isArray(v.tail_consumers) || v.tail_consumers.length !== 0)
  )
    fail("settings_invalid");
  return { raw: v, view: H.settingsView(v, dbid) };
}
function version(v, versionId, dbid) {
  if (
    !exact(v, [
      "annotations",
      "bindings",
      "modules",
      "main_module",
      ...META,
      ...READONLY,
    ]) ||
    !id(versionId) ||
    v.id !== versionId
  )
    fail("candidate_invalid");
  if (
    !int(v.number) ||
    v.number < 1 ||
    !Array.isArray(v.urls) ||
    v.urls.length > 64 ||
    v.urls.some((u) => typeof u !== "string" || u.length > 2000) ||
    typeof v.created_on !== "string" ||
    v.created_on.length > 50
  )
    fail("candidate_invalid");
  if (
    v.modules?.some(
      (m) => !exact(m, ["name", "content_type", "content_base64"]),
    )
  )
    fail("candidate_invalid");
  const bindings = H.normalizeBindings(v.bindings, dbid);
  const code = H.validateVersion(v, versionId, bindings, dbid);
  const meta = metadata(v),
    anno = annotations(v.annotations);
  const safe = {
    id: versionId,
    bindings,
    code,
    metadataSha256: digest(canonical(meta)),
    annotationsSha256: digest(anno),
  };
  return { raw: v, meta, anno, ...safe, safe };
}
function deployment(result) {
  if (
    !exact(result, ["deployments"]) ||
    !Array.isArray(result.deployments) ||
    result.deployments.length !== 1
  )
    fail("deployment_invalid");
  const raw = result.deployments[0],
    view = H.deploymentView(result);
  if (
    !exact(raw, [
      "id",
      "created_on",
      "source",
      "strategy",
      "versions",
      "annotations",
      "author_email",
    ]) ||
    raw.strategy !== "percentage" ||
    !exact(raw.versions[0], ["version_id", "percentage"])
  )
    fail("deployment_invalid");
  const anno = annotations(raw.annotations, true);
  return { raw, anno, ...view, annotationsSha256: digest(anno) };
}
function deploymentSafe(d) {
  return {
    id: d.id,
    versionId: d.versionId,
    createdOn: d.createdOn,
    annotationsSha256: d.annotationsSha256,
  };
}
function subdomain(v) {
  if (
    !exact(v, ["enabled", "previews_enabled"]) ||
    v.enabled !== false ||
    v.previews_enabled !== false
  )
    fail("subdomain_invalid");
  return { enabled: false, previewsEnabled: false };
}
function capability(s, v, q, removeR2 = false) {
  return {
    bindingsSha256: digest(
      removeR2
        ? s.view.bindings.filter((b) => b.name !== "CF_BUCKET")
        : s.view.bindings,
    ),
    metadataSha256: s.view.metadataSha256,
    annotationsSha256: s.view.annotationsSha256,
    codeSha256: digest(v.code),
    subdomainSha256: digest(q),
  };
}
function requireSame(a, b) {
  if (!equal(a, b)) fail("inventory_changed");
}
function crossMetadata(s, v) {
  for (const key of META.filter((k) => k !== "package_dependencies")) {
    if (
      Object.hasOwn(s.raw, key) !== Object.hasOwn(v.meta, key) ||
      !equal(s.raw[key] ?? null, v.meta[key] ?? null)
    )
      fail("metadata_invalid");
  }
  if (s.view.annotationsSha256 !== v.annotationsSha256)
    fail("annotations_invalid");
}
function validateState(v, identity, legacy) {
  if (
    !exact(v, [
      "schemaVersion",
      "identity",
      "legacy",
      "source",
      "candidate",
      "writes",
      "observations",
    ]) ||
    v.schemaVersion !== 1 ||
    !equal(v.identity, identity) ||
    !equal(v.legacy, legacy) ||
    !Array.isArray(v.writes) ||
    v.writes.length > 2 ||
    !Array.isArray(v.observations) ||
    v.observations.length > 128
  )
    fail("state_invalid");
  const kinds = new Set();
  for (const w of v.writes) {
    if (
      !exact(w, [
        "runId",
        "index",
        "at",
        "kind",
        "state",
        "bodySha256",
        "responseVersionId",
        "responseDeploymentId",
      ]) ||
      !id(w.runId) ||
      !int(w.index) ||
      w.index < 1 ||
      !int(w.at) ||
      !["create", "deploy"].includes(w.kind) ||
      kinds.has(w.kind) ||
      !["dispatched", "unknown", "verified"].includes(w.state) ||
      !HEX.test(w.bodySha256) ||
      (w.responseVersionId !== undefined && !id(w.responseVersionId)) ||
      (w.responseDeploymentId !== undefined && !id(w.responseDeploymentId))
    )
      fail("state_invalid");
    kinds.add(w.kind);
  }
  if (
    v.writes.some(
      (w, i) =>
        w.kind !== (i === 0 ? "create" : "deploy") ||
        (w.kind === "create" && w.responseDeploymentId !== undefined) ||
        (w.kind === "deploy" && w.responseVersionId !== undefined) ||
        (w.state === "verified" &&
          !id(
            w.kind === "create" ? w.responseVersionId : w.responseDeploymentId,
          )),
    )
  )
    fail("state_invalid");
  for (const o of v.observations)
    if (
      !exact(o, ["runId", "at", "capabilityObserved", "sha256"]) ||
      !id(o.runId) ||
      !int(o.at) ||
      typeof o.capabilityObserved !== "boolean" ||
      !HEX.test(o.sha256)
    )
      fail("state_invalid");
  if (
    v.source !== null &&
    (!exact(v.source, [
      "deployment",
      "bindings",
      "code",
      "versionMetadataSha256",
      "expected",
    ]) ||
      !exact(v.source.deployment, [
        "id",
        "versionId",
        "createdOn",
        "annotationsSha256",
      ]) ||
      !id(v.source.deployment.id) ||
      !id(v.source.deployment.versionId) ||
      typeof v.source.deployment.createdOn !== "string" ||
      v.source.deployment.createdOn.length > 50 ||
      !HEX.test(v.source.deployment.annotationsSha256) ||
      !HEX.test(v.source.versionMetadataSha256) ||
      !fiveValid(v.source.expected) ||
      !equal(v.source.expected, legacy.expected))
  )
    fail("state_invalid");
  if (v.source !== null) {
    requireSame(
      v.source.bindings,
      H.normalizeBindings(v.source.bindings, identity.databaseId),
    );
    if (
      v.source.bindings.length !== 5 ||
      !exact(v.source.code, ["mainModule", "modules"]) ||
      typeof v.source.code.mainModule !== "string" ||
      v.source.code.mainModule.length > 200 ||
      !Array.isArray(v.source.code.modules) ||
      v.source.code.modules.length < 1 ||
      v.source.code.modules.length > 64 ||
      digest(v.source.code) !== legacy.expected.codeSha256
    )
      fail("state_invalid");
    for (const m of v.source.code.modules)
      if (
        !exact(m, ["name", "type", "bytes", "sha256"]) ||
        typeof m.name !== "string" ||
        m.name.length > 200 ||
        typeof m.type !== "string" ||
        m.type.length > 100 ||
        !int(m.bytes) ||
        !HEX.test(m.sha256)
      )
        fail("state_invalid");
  }
  if (
    v.candidate !== null &&
    (!exact(v.candidate, ["versionId", "verified"]) ||
      !id(v.candidate.versionId) ||
      typeof v.candidate.verified !== "boolean" ||
      !v.writes.some(
        (w) =>
          w.kind === "create" && w.responseVersionId === v.candidate.versionId,
      ))
  )
    fail("state_invalid");
  if (kinds.has("create") && v.source === null) fail("state_invalid");
  if (
    v.candidate?.verified &&
    !v.writes.some((w) => w.kind === "create" && w.state === "verified")
  )
    fail("state_invalid");
  if (
    kinds.has("deploy") &&
    (!v.candidate?.verified ||
      !v.writes.some((w) => w.kind === "create" && w.state === "verified"))
  )
    fail("state_invalid");
  return v;
}
function legacyState(v, identity) {
  if (
    !exact(v, [
      "schemaVersion",
      "identity",
      "writes",
      "failures",
      "checkpoint",
    ]) ||
    v.schemaVersion !== 1 ||
    !equal(v.identity, identity) ||
    !Array.isArray(v.writes) ||
    v.writes.length > 128 ||
    !Array.isArray(v.failures) ||
    v.failures.length > 128
  )
    fail("legacy_invalid");
  const seen = new Set();
  for (const item of v.writes) {
    if (
      !exact(item, ["runId", "index", "at", "kind", "state", "expected"]) ||
      !id(item.runId) ||
      !int(item.index) ||
      item.index < 1 ||
      item.index > 32 ||
      !int(item.at) ||
      !["ddl", "probe", "patch"].includes(item.kind) ||
      !["dispatched", "observed", "rejected", "unknown"].includes(item.state) ||
      seen.has(`${item.runId}:${item.index}`) ||
      (item.kind === "patch"
        ? !fiveValid(item.expected)
        : Object.hasOwn(item, "expected"))
    )
      fail("legacy_invalid");
    seen.add(`${item.runId}:${item.index}`);
  }
  for (const item of v.failures)
    if (!exact(item, ["runId", "at"]) || !id(item.runId) || !int(item.at))
      fail("legacy_invalid");
  const unknown = v.writes.filter((w) =>
    ["dispatched", "unknown"].includes(w.state),
  );
  if (
    unknown.length !== 1 ||
    v.writes.filter((w) => w.kind === "patch").length !== 1
  )
    fail("legacy_invalid");
  const w = unknown[0];
  if (
    w.kind !== "patch" ||
    !id(w.runId) ||
    !int(w.index) ||
    !int(w.at) ||
    !fiveValid(w.expected)
  )
    fail("legacy_invalid");
  return { runId: w.runId, index: w.index, at: w.at, expected: w.expected };
}
export async function runCf01VersionClose({
  action = "status",
  execute = false,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  clock = Date.now,
  requestTimeoutMs = 30_000,
} = {}) {
  if (!["create", "deploy", "status"].includes(action)) fail("usage");
  if (!execute)
    return {
      mode: "preview",
      action,
      requests: 0,
      limits: CF01_VERSION_CLOSE_LIMITS,
      ...flags(),
    };
  if (
    execute !== true ||
    !int(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30_000 ||
    typeof clock !== "function" ||
    typeof fetchImpl !== "function"
  )
    fail("options_invalid");
  let store, state, receipt, receiptPath, lock, lockStat, checkDirectories;
  const statePath = ".local/cf01/version-close-state.json";
  const save = async () => {
    await store.save(statePath, state);
    await store.save(receiptPath, receipt);
  };
  try {
    root = await fs.realpath(root);
    checkDirectories = await H.pinReceiptDirectories(root);
    store = await H.privateStore(root, checkDirectories);
    for (const p of [
      ".env",
      ".local/cf01/resources.json",
      ".local/cf01/wrangler.json",
    ])
      await store.read(p);
    const fixed = await H.loadFixed(root, environment);
    if (
      fixed.config.r2_buckets.length !== 0 ||
      fixed.config.workers_dev !== false ||
      fixed.config.preview_urls !== false
    )
      fail("config_invalid");
    await store.check();
    const lockPath = path.join(root, ".local/cf01/storage-close.lock");
    try {
      lock = await fs.open(
        lockPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (e) {
      if (e.code === "EEXIST") fail("operator_locked");
      throw e;
    }
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, id: randomUUID() }),
    );
    await lock.sync();
    lockStat = await lock.stat();
    const parent = await fs.open(
      path.dirname(lockPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const identity = {
      root,
      accountId: fixed.credentials.accountId,
      databaseId: fixed.resources.databaseId,
      worker: WORKER,
      guardSha256: digest(CF01_CLOSE_GUARDS),
    };
    const legacyRaw = await store.read(".local/cf01/storage-close-state.json");
    const legacy = legacyState(JSON.parse(legacyRaw), identity);
    const oldReceipt = JSON.parse(
      await store.read(`.local/cf01/storage-close-${legacy.runId}.json`),
    );
    if (
      oldReceipt.schemaVersion !== 1 ||
      oldReceipt.kind !== "cf01-storage-capability-reduction" ||
      oldReceipt.action !== "close" ||
      oldReceipt.runId !== legacy.runId ||
      !equal(oldReceipt.identity, identity) ||
      !Array.isArray(oldReceipt.requests) ||
      oldReceipt.requests.length !== legacy.index ||
      oldReceipt.requests.some((r, i) => !record(r) || r.index !== i + 1) ||
      oldReceipt.requests.filter((r) => r.kind === "patch").length !== 1 ||
      !oldReceipt.requests.some(
        (r) =>
          r.index === legacy.index &&
          r.kind === "patch" &&
          r.at === legacy.at &&
          r.label === "remove-fixed-r2-binding" &&
          r.path === `/workers/scripts/${WORKER}/settings` &&
          r.method === "PATCH" &&
          ["dispatched", "unknown"].includes(r.state),
      )
    )
      fail("legacy_invalid");
    const prior = await store.read(statePath, true);
    state =
      prior === null
        ? {
            schemaVersion: 1,
            identity,
            legacy,
            source: null,
            candidate: null,
            writes: [],
            observations: [],
          }
        : validateState(JSON.parse(prior), identity, legacy);
    // A state-file rename and its receipt rename cannot be one atomic operation.
    // Require the independent completed journal too before permitting a new mutation.
    if (action !== "status")
      for (const w of state.writes.filter((w) => w.state === "verified")) {
        const completed = JSON.parse(
          await store.read(`.local/cf01/version-close-${w.runId}.json`),
        );
        const request = completed.requests?.find((r) => r.index === w.index);
        if (
          completed.schemaVersion !== 1 ||
          completed.kind !== "cf01-version-capability-reduction" ||
          completed.runId !== w.runId ||
          completed.action !== w.kind ||
          !equal(completed.identity, identity) ||
          completed.legacyExpectedSha256 !== digest(legacy.expected) ||
          completed.status !==
            (w.kind === "create"
              ? "candidate_verified"
              : "capability_observed") ||
          completed.requests?.length !==
            CF01_VERSION_CLOSE_LIMITS.requests[w.kind] ||
          completed.requests.some(
            (r, i) =>
              r.index !== i + 1 ||
              r.state !== "observed" ||
              r.httpStatus !== 200,
          ) ||
          completed.requests.filter((r) => r.kind !== "read").length !== 1 ||
          request?.kind !== w.kind ||
          request.at !== w.at ||
          request.method !== "POST" ||
          request.label !==
            (w.kind === "create" ? "create-candidate" : "deploy-candidate") ||
          request.path !==
            (w.kind === "create"
              ? `/workers/workers/${WORKER}/versions?deploy=false`
              : `/workers/scripts/${WORKER}/deployments?force=false`) ||
          request.bodySha256 !== w.bodySha256 ||
          (w.kind === "create" &&
            request.sha256 !==
              digest({ versionId: state.candidate?.versionId }))
        )
          fail("unknown_write_pending");
      }
    if (action !== "status" && state.writes.some((w) => w.state !== "verified"))
      fail("unknown_write_pending");
    if (action === "create" && state.writes.some((w) => w.kind === "create"))
      fail("already_created");
    if (action === "deploy" && !state.candidate?.verified)
      fail("candidate_required");
    if (action === "deploy" && state.writes.some((w) => w.kind === "deploy"))
      fail("already_deployed");
    if (state.observations.length >= 128) fail("state_invalid");
    const now = () => {
      const n = clock();
      if (!int(n)) fail("options_invalid");
      return n;
    };
    const runId = randomUUID();
    receiptPath = `.local/cf01/version-close-${runId}.json`;
    receipt = {
      schemaVersion: 1,
      kind: "cf01-version-capability-reduction",
      runId,
      action,
      identity,
      legacyExpectedSha256: digest(legacy.expected),
      startedAt: now(),
      limits: CF01_VERSION_CLOSE_LIMITS,
      requests: [],
      status: "planned",
      concurrency: "operator_window_no_api_cas",
      routesCompleteness: "unknown",
      ...flags(),
    };
    await save();
    const base = `https://api.cloudflare.com/client/v4/accounts/${fixed.credentials.accountId}`;
    const worker = `/workers/scripts/${WORKER}`,
      versions = `/workers/workers/${WORKER}/versions`,
      db = `/d1/database/${fixed.resources.databaseId}`;
    let mutations = 0;
    const request = async ({
      suffix,
      label,
      body,
      kind = null,
      validate,
      onResult,
    }) => {
      if (receipt.requests.length >= CF01_VERSION_CLOSE_LIMITS.requests[action])
        fail("request_budget");
      if (
        kind !== null &&
        (kind !== action ||
          !["create", "deploy"].includes(kind) ||
          ++mutations > 1)
      )
        fail("write_budget");
      const bodyText = body === undefined ? undefined : JSON.stringify(body);
      if (bodyText !== undefined && Buffer.byteLength(bodyText) > 2_000_000)
        fail("payload_limit");
      await store.check();
      await checkDirectories();
      const active = await fs.lstat(lockPath);
      if (
        !active.isFile() ||
        active.isSymbolicLink() ||
        active.ino !== lockStat.ino ||
        active.dev !== lockStat.dev ||
        active.uid !== process.getuid() ||
        active.nlink !== 1 ||
        (active.mode & 0o777) !== 0o600
      )
        fail("operator_locked");
      const item = {
        index: receipt.requests.length + 1,
        label,
        path: suffix,
        method: bodyText === undefined ? "GET" : "POST",
        kind: kind ?? "read",
        state: "dispatched",
        at: now(),
        ...(bodyText === undefined ? {} : { bodySha256: hash(bodyText) }),
      };
      receipt.requests.push(item);
      let write;
      if (kind) {
        write = {
          runId,
          index: item.index,
          at: item.at,
          kind,
          state: "dispatched",
          bodySha256: item.bodySha256,
        };
        state.writes.push(write);
      }
      await save();
      const controller = new AbortController();
      let response, timer;
      try {
        const attempt = (async () => {
          response = await fetchImpl(base + suffix, {
            method: item.method,
            redirect: "error",
            headers: {
              authorization: `Bearer ${fixed.credentials.token}`,
              ...(bodyText === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            ...(bodyText === undefined ? {} : { body: bodyText }),
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            cancel(response.body);
            fail("deadline");
          }
          if (
            response.redirected ||
            (response.url && response.url !== base + suffix) ||
            (response.status >= 300 && response.status < 400)
          ) {
            cancel(response.body);
            fail("redirect_rejected");
          }
          if (
            !Number.isInteger(response.status) ||
            response.status < 100 ||
            response.status > 599
          )
            fail("response_invalid");
          item.httpStatus = response.status;
          const data = await H.boundedJson(response, controller.signal);
          if (controller.signal.aborted) fail("deadline");
          if (!response.ok || response.status !== 200) fail("remote_rejected");
          if (
            data?.success !== true ||
            (data.errors !== undefined &&
              (!Array.isArray(data.errors) || data.errors.length !== 0)) ||
            data.result_info?.has_more === true ||
            (data.result_info?.total_pages > 1 &&
              !suffix.startsWith(worker + "/deployments?"))
          )
            fail("envelope_invalid");
          return validate(data.result);
        })();
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            cancel(response?.body);
            reject(new Cf01VersionCloseError("cf01_version_close_deadline"));
          }, requestTimeoutMs);
        });
        const result = await Promise.race([attempt, timeout]);
        clearTimeout(timer);
        if (controller.signal.aborted) fail("deadline");
        item.state = "observed";
        item.sha256 = digest(result.safe);
        if (onResult) onResult(result.value, write);
        await save();
        return result.value;
      } catch (e) {
        controller.abort();
        cancel(response?.body);
        item.state = write ? "unknown" : "failed";
        if (write) write.state = "unknown";
        throw safeError(e);
      } finally {
        clearTimeout(timer);
      }
    };
    const get = (suffix, label, validate) =>
      request({ suffix, label, validate });
    const schema = (label) =>
      request({
        suffix: db + "/query",
        label,
        body: { sql: CF01_CLOSE_SQL.schema, params: [] },
        validate: (r) => {
          const names = H.validateSchema(
            H.d1Rows({ success: true, result: r }),
          );
          if (names.length !== 6) fail("guards_invalid");
          return projected(names);
        },
      });
    const counts = (label) =>
      request({
        suffix: db + "/query",
        label,
        body: { sql: CF01_CLOSE_SQL.counts, params: [] },
        validate: (r) => {
          const c = H.validateCounts(H.d1Rows({ success: true, result: r }));
          if (c.runs_storage !== 0 || c.orphan_storage !== 0)
            fail("counts_invalid");
          return projected(c);
        },
      });
    const dep = (label) =>
      get(worker + "/deployments?page=1&per_page=1", label, (r) => {
        const d = deployment(r);
        return projected(d, deploymentSafe(d));
      });
    const set = (label) =>
      get(worker + "/settings", label, (r) => {
        const s = settings(r, fixed.resources.databaseId);
        return projected(s, s.view);
      });
    const sub = (label) =>
      get(worker + "/subdomain", label, (r) => projected(subdomain(r)));
    const ver = (v, label) => {
      if (!id(v)) fail("state_invalid");
      return get(versions + `/${v}?include=modules`, label, (r) => {
        const value = version(r, v, fixed.resources.databaseId);
        return projected(value, value.safe);
      });
    };
    await get(db, "d1-identity", (v) => {
      if (v?.uuid !== fixed.resources.databaseId || v.name !== WORKER)
        fail("source_invalid");
      return projected({ uuid: v.uuid, name: v.name });
    });
    const g0 = await schema("initial-schema"),
      c0 = await counts("initial-counts");
    const d0 = await dep("initial-deployment"),
      s0 = await set("initial-settings"),
      q0 = await sub("initial-subdomain");
    const u = await ver(d0.versionId, "initial-source-version");
    crossMetadata(s0, u);
    const expected = legacy.expected;
    const desiredBindings = s0.view.bindings.filter(
      (b) => b.name !== "CF_BUCKET",
    );
    const sameStableSettings = (s) => {
      if (
        s.view.metadataSha256 !== expected.metadataSha256 ||
        s.view.annotationsSha256 !== expected.annotationsSha256 ||
        ![
          digest(desiredBindings),
          state.source
            ? digest(state.source.bindings)
            : digest(s0.view.bindings),
        ].includes(digest(s.view.bindings))
      )
        fail("inventory_changed");
    };
    const sameCandidate = (w) => {
      if (
        !state.source ||
        w.metadataSha256 !== state.source.versionMetadataSha256 ||
        w.annotationsSha256 !== expected.annotationsSha256 ||
        digest(w.code) !== expected.codeSha256 ||
        digest(w.bindings) !== expected.bindingsSha256
      )
        fail("candidate_invalid");
    };
    if (action === "status") {
      if (state.candidate?.versionId === d0.versionId) sameCandidate(u);
      if (state.candidate && state.candidate.versionId !== d0.versionId)
        sameCandidate(
          await ver(state.candidate.versionId, "known-candidate-version"),
        );
      const g1 = await schema("independent-schema"),
        c1 = await counts("independent-counts");
      const d1 = await dep("independent-deployment"),
        s1 = await set("independent-settings"),
        q1 = await sub("independent-subdomain"),
        v1 = await ver(d1.versionId, "independent-current-version");
      crossMetadata(s1, v1);
      requireSame(g0, g1);
      requireSame(c0, c1);
      requireSame(deploymentSafe(d0), deploymentSafe(d1));
      requireSame(s0.view, s1.view);
      requireSame(q0, q1);
      requireSame(u.safe, v1.safe);
      const observed =
        !u.bindings.some((b) => b.name === "CF_BUCKET") &&
        !s0.view.bindings.some((b) => b.name === "CF_BUCKET") &&
        equal(capability(s0, u, q0), expected);
      receipt.capabilityObserved = observed;
      receipt.status = observed
        ? "capability_observed"
        : "r2_or_hash_resolution_required";
      state.observations.push({
        runId,
        at: now(),
        capabilityObserved: observed,
        sha256: digest({
          deployment: deploymentSafe(d1),
          capability: capability(s1, v1, q1),
        }),
      });
    } else {
      if (action === "create") {
        if (
          s0.view.bindings.length !== 5 ||
          !s0.view.bindings.some((b) => b.name === "CF_BUCKET") ||
          !equal(s0.view.bindings, u.bindings) ||
          !equal(capability(s0, u, q0, true), expected)
        )
          fail("expected_mismatch");
        state.source = {
          deployment: deploymentSafe(d0),
          bindings: s0.view.bindings,
          code: u.code,
          versionMetadataSha256: u.metadataSha256,
          expected,
        };
      } else {
        requireSame(deploymentSafe(d0), state.source.deployment);
        if (
          digest(u.code) !== expected.codeSha256 ||
          u.metadataSha256 !== state.source.versionMetadataSha256 ||
          !equal(u.bindings, state.source.bindings)
        )
          fail("source_invalid");
        sameStableSettings(s0);
        sameCandidate(
          await ver(state.candidate.versionId, "candidate-predeploy-version"),
        );
      }
      const dBefore = await dep("before-write-deployment"),
        sBefore = await set("before-write-settings"),
        qBefore = await sub("before-write-subdomain");
      requireSame(deploymentSafe(d0), deploymentSafe(dBefore));
      requireSame(q0, qBefore);
      sameStableSettings(sBefore);
      if (action === "create") {
        requireSame(s0.view, sBefore.view);
        const body = {
          annotations: u.anno,
          bindings: ["CF_DB", "CF_MOCK", "CF_PROBE_TOKEN", "CF_WORKFLOW"].map(
            (name) => ({ name, type: "inherit", version_id: d0.versionId }),
          ),
          main_module: u.raw.main_module,
          modules: u.raw.modules,
          ...u.meta,
        };
        await request({
          suffix: versions + "?deploy=false",
          label: "create-candidate",
          kind: "create",
          body,
          validate: (r) => {
            if (!record(r) || !id(r.id) || r.id === d0.versionId)
              fail("candidate_invalid");
            return projected({ versionId: r.id });
          },
          onResult: (value, write) => {
            write.responseVersionId = value.versionId;
            state.candidate = { versionId: value.versionId, verified: false };
          },
        });
        sameCandidate(
          await ver(state.candidate.versionId, "independent-candidate-version"),
        );
        requireSame(
          deploymentSafe(d0),
          deploymentSafe(await dep("after-create-deployment")),
        );
        sameStableSettings(await set("after-create-settings"));
        requireSame(q0, await sub("after-create-subdomain"));
      } else {
        const body = {
          strategy: "percentage",
          versions: [
            { version_id: state.candidate.versionId, percentage: 100 },
          ],
          ...(Object.keys(d0.anno).length ? { annotations: d0.anno } : {}),
        };
        let deployedId;
        await request({
          suffix: worker + "/deployments?force=false",
          label: "deploy-candidate",
          kind: "deploy",
          body,
          validate: (r) => {
            const d = deployment({ deployments: [r] });
            if (
              d.versionId !== state.candidate.versionId ||
              d.id === d0.id ||
              d.annotationsSha256 !== d0.annotationsSha256
            )
              fail("deployment_invalid");
            return projected(deploymentSafe(d));
          },
          onResult: (v, w) => {
            deployedId = v.id;
            w.responseDeploymentId = v.id;
          },
        });
        const specific = await get(
          worker + `/deployments/${deployedId}`,
          "independent-deployment-id",
          (r) => {
            const d = deployment({ deployments: [r] });
            return projected(deploymentSafe(d));
          },
        );
        const current = deploymentSafe(await dep("after-deploy-current"));
        requireSame(specific, current);
        if (
          current.id !== deployedId ||
          current.versionId !== state.candidate.versionId
        )
          fail("deployment_invalid");
        const w = await ver(state.candidate.versionId, "after-deploy-version");
        sameCandidate(w);
        const s = await set("after-deploy-settings"),
          q = await sub("after-deploy-subdomain");
        if (!equal(capability(s, w, q), expected)) fail("expected_mismatch");
      }
      requireSame(g0, await schema("final-schema"));
      requireSame(c0, await counts("final-counts"));
      const finalDeployment = await dep("final-deployment");
      if (action === "create")
        requireSame(deploymentSafe(d0), deploymentSafe(finalDeployment));
      else if (
        finalDeployment.versionId !== state.candidate.versionId ||
        finalDeployment.id !==
          state.writes.find((w) => w.kind === "deploy").responseDeploymentId
      )
        fail("deployment_invalid");
      const write = state.writes.find((w) => w.runId === runId);
      write.state = "verified";
      if (action === "create") state.candidate.verified = true;
      receipt.status =
        action === "create" ? "candidate_verified" : "capability_observed";
      receipt.capabilityObserved = action === "deploy";
    }
    receipt.finishedAt = now();
    await save();
    return {
      mode: "executed",
      action,
      status: receipt.status,
      requests: receipt.requests.length,
      receipt: receiptPath,
      candidateVersionId: state.candidate?.versionId ?? null,
      capabilityObserved: receipt.capabilityObserved === true,
      historicalUnknownPreserved: true,
      ...flags(),
    };
  } catch (e) {
    const error = safeError(e);
    if (receipt && state) {
      for (const w of state.writes.filter((w) => w.runId === receipt.runId))
        w.state = "unknown";
      if (action === "create" && state.candidate)
        state.candidate.verified = false;
      receipt.status = "failed";
      receipt.error = error.code;
      try {
        await save();
      } catch {}
    }
    throw error;
  } finally {
    if (lock) {
      try {
        await checkDirectories();
        const p = path.join(root, ".local/cf01/storage-close.lock"),
          s = await fs.lstat(p);
        if (s.ino === lockStat?.ino && s.dev === lockStat?.dev && s.nlink === 1)
          await fs.unlink(p);
      } catch {}
      await lock.close();
    }
  }
}
export async function main(argv = process.argv.slice(2)) {
  if (
    argv.length > 2 ||
    (argv[0] !== undefined &&
      !["create", "deploy", "status"].includes(argv[0])) ||
    (argv[1] !== undefined && argv[1] !== "--execute")
  )
    fail("usage");
  const out = await runCf01VersionClose({
    action: argv[0] ?? "status",
    execute: argv[1] === "--execute",
  });
  console.log(JSON.stringify(out));
  return out;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(JSON.stringify({ error: safeError(e).code, ...flags() }));
    process.exitCode = 1;
  });
