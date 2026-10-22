// Local evidence projection only; never a drain, ready or upload authorization.
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CF01_CLOSE_INTERNALS } from "./cf01-storage-close.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INPUT = ".local/cf01/evidence.json";
const ORIGIN = "https://the-shelf-cf01.iamzhutuo.workers.dev";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FLAGS = Object.freeze({
  readyEligible: false,
  drainProven: false,
  uploadAllowed: false,
});
export const CF01_HISTORY_LIMITS = Object.freeze({
  inputBytes: 1_000_000,
  runs: 512,
  requests: 512,
});
const CODES = new Set(
  [
    "usage",
    "options_invalid",
    "evidence_invalid",
    "json_invalid",
    "private_directory_unsafe",
    "private_directory_changed",
    "private_file_unsafe",
    "private_file_changed",
    "receipt_unsafe",
    "local_failure",
  ].map((x) => `cf01_history_${x}`),
);
export class Cf01HistoryError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : "cf01_history_local_failure";
    super(safe);
    this.name = "Cf01HistoryError";
    this.code = safe;
  }
}
const fail = (code = "evidence_invalid") => {
  throw new Cf01HistoryError(`cf01_history_${code}`);
};
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, allowed) =>
  object(v) && Object.keys(v).every((k) => allowed.includes(k));
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const id = (v) => typeof v === "string" && UUID.test(v);
const timestamp = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const labels = ["storage", "scrypt", "pbkdf2", "short", "long", "uncertain"];
const kinds = ["storage", "scrypt", "pbkdf2", "workflow"];
const states = ["reserved", "running", "completed", "failed", "uncertain"];
const opaqueString = (v, maxChars, maxBytes) =>
  typeof v === "string" &&
  v.length <= maxChars &&
  Buffer.byteLength(JSON.stringify(v)) <= maxBytes;

function validateOpaqueRollback(value) {
  if (value === null) return;
  if (
    !keys(value, ["outcome", "error"]) ||
    !["complete", "failed"].includes(value.outcome) ||
    !Object.hasOwn(value, "error") ||
    (value.error !== null &&
      (!keys(value.error, ["name", "message"]) ||
        !opaqueString(value.error.name, 1024, 4096) ||
        !opaqueString(value.error.message, 1024, 4096))) ||
    Buffer.byteLength(JSON.stringify(value)) > 4096
  )
    fail();
  // This provider metadata never contributes to state, association or proof.
}

function responseProjection(data) {
  if (
    !keys(data, [
      "run",
      "workflow",
      "accepted",
      "duplicate",
      "noResend",
      "cleaned",
      "budgetTombstoneRetained",
      "error",
    ])
  )
    fail();
  for (const field of [
    "accepted",
    "duplicate",
    "noResend",
    "cleaned",
    "budgetTombstoneRetained",
  ])
    if (Object.hasOwn(data, field) && typeof data[field] !== "boolean") fail();
  if (
    Object.hasOwn(data, "error") &&
    (typeof data.error !== "string" || data.error.length > 256)
  )
    fail();
  if (Object.hasOwn(data, "workflow") && data.workflow !== null) {
    if (
      !keys(data.workflow, ["status", "error", "output", "rollback"]) ||
      ![
        "queued",
        "running",
        "paused",
        "errored",
        "terminated",
        "complete",
        "waiting",
        "waitingForPause",
        "unknown",
        "unavailable",
      ].includes(data.workflow.status)
    )
      fail();
    if (Object.hasOwn(data.workflow, "rollback"))
      validateOpaqueRollback(data.workflow.rollback);
    // Workflow output/error can contain provider data; never inspect or project it.
  }
  const r = data.run;
  if (r !== undefined && r !== null) {
    if (
      !keys(r, [
        "run_id",
        "kind",
        "state",
        "delay_seconds",
        "mode",
        "network_calls",
        "mock_calls",
        "created_at",
        "updated_at",
        "result_json",
      ]) ||
      !id(r.run_id) ||
      !kinds.includes(r.kind) ||
      !states.includes(r.state)
    )
      fail();
    if (
      Object.hasOwn(r, "delay_seconds") &&
      ![0, 65, 840].includes(r.delay_seconds)
    )
      fail();
    if (Object.hasOwn(r, "mode") && !["success", "uncertain"].includes(r.mode))
      fail();
    for (const field of [
      "network_calls",
      "mock_calls",
      "created_at",
      "updated_at",
    ])
      if (Object.hasOwn(r, field) && !integer(r[field])) fail();
    if (
      Object.hasOwn(r, "result_json") &&
      r.result_json !== null &&
      (typeof r.result_json !== "string" || r.result_json.length > 16384)
    )
      fail();
    // result_json is deliberately opaque, including malformed JSON strings.
  }
  return {
    responseId: r?.run_id ?? null,
    kind: r?.kind ?? null,
    state: r?.state ?? null,
    cleaned: data.cleaned === true,
    budgetTombstoneRetained: data.budgetTombstoneRetained === true,
  };
}

export function projectCf01History(input) {
  if (
    !keys(input, ["schemaVersion", "runs", "requests"]) ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.runs) ||
    !Array.isArray(input.requests) ||
    input.runs.length > CF01_HISTORY_LIMITS.runs ||
    input.requests.length > CF01_HISTORY_LIMITS.requests
  )
    fail();
  const ids = new Set();
  const runs = input.runs.map((r, index) => {
    if (
      !keys(r, ["label", "runId", "origin", "createdAt", "cleaned"]) ||
      !labels.includes(r.label) ||
      !id(r.runId) ||
      ids.has(r.runId) ||
      r.origin !== ORIGIN ||
      !timestamp(r.createdAt) ||
      typeof r.cleaned !== "boolean"
    )
      fail();
    ids.add(r.runId);
    return { index, label: r.label, runRef: hash(r.runId), cleaned: r.cleaned };
  });
  const requests = input.requests.map((r, index) => {
    if (
      !keys(r, [
        "method",
        "pathname",
        "at",
        "outcome",
        "status",
        "data",
        "operatorRecovery",
      ]) ||
      !["GET", "POST", "DELETE"].includes(r.method) ||
      !timestamp(r.at) ||
      !["pending", "response", "uncertain_no_resend"].includes(r.outcome)
    )
      fail();
    if (
      Object.hasOwn(r, "operatorRecovery") &&
      !opaqueString(r.operatorRecovery, 256, 1024)
    )
      fail();
    // Historical operator annotation is opaque and cannot repair an outcome.
    const pathId =
      typeof r.pathname === "string" && r.pathname.startsWith("/v1/runs/")
        ? r.pathname.slice(9)
        : null;
    const collection = r.pathname === "/v1/runs";
    if (
      !(collection
        ? r.method === "POST"
        : id(pathId) && ["GET", "DELETE"].includes(r.method))
    )
      fail();
    if (
      r.outcome === "response"
        ? !Number.isSafeInteger(r.status) ||
          r.status < 100 ||
          r.status > 599 ||
          !object(r.data)
        : Object.hasOwn(r, "status") || Object.hasOwn(r, "data")
    )
      fail();
    const data =
      r.outcome === "response"
        ? responseProjection(r.data)
        : {
            responseId: null,
            kind: null,
            state: null,
            cleaned: false,
            budgetTombstoneRetained: false,
          };
    if (pathId && data.responseId && pathId !== data.responseId) fail();
    const explicitId = pathId || data.responseId;
    return {
      index,
      method: r.method,
      pathClass: collection ? "runs_collection" : "run_item",
      outcome: r.outcome === "uncertain_no_resend" ? "unknown" : r.outcome,
      status: r.status ?? null,
      attribution:
        pathId && data.responseId
          ? "path_and_response"
          : pathId
            ? "path"
            : data.responseId
              ? "response"
              : "unattributed",
      runRef: explicitId ? hash(explicitId) : null,
      localRunMatched: explicitId ? ids.has(explicitId) : false,
      kind: data.kind,
      state: data.state,
      cleaned: data.cleaned,
      budgetTombstoneRetained: data.budgetTombstoneRetained,
    };
  });
  const count = (predicate) => requests.filter(predicate).length;
  const unresolved = (r) => r.outcome === "pending" || r.outcome === "unknown";
  const summary = {
    runs: runs.length,
    requests: requests.length,
    starts: count((r) => r.method === "POST"),
    pendingRequests: count((r) => r.outcome === "pending"),
    unknownRequests: count((r) => r.outcome === "unknown"),
    unattributedRequests: count((r) => r.attribution === "unattributed"),
    unattributedStarts: count(
      (r) => r.method === "POST" && r.attribution === "unattributed",
    ),
    unresolvedStarts: count((r) => r.method === "POST" && unresolved(r)),
    unresolvedMutations: count((r) => r.method !== "GET" && unresolved(r)),
    failedResponses: count((r) => r.status >= 400),
    storageCompletedResponses: count(
      (r) =>
        r.status >= 200 &&
        r.status < 300 &&
        r.kind === "storage" &&
        r.state === "completed",
    ),
    cleanupResponses: count(
      (r) =>
        r.method === "DELETE" &&
        r.status >= 200 &&
        r.status < 300 &&
        r.cleaned &&
        r.budgetTombstoneRetained,
    ),
  };
  return { schemaVersion: 1, ...FLAGS, summary, runs, requests };
}

export async function runCf01HistoryInspect({
  execute = false,
  root = ROOT,
} = {}) {
  if (
    typeof execute !== "boolean" ||
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root.replace(/\/$/, "")
  )
    fail("options_invalid");
  if (!execute)
    return {
      action: "preview",
      input: INPUT,
      limits: CF01_HISTORY_LIMITS,
      networkRequests: 0,
      ...FLAGS,
    };
  try {
    const checkDirectories = await CF01_CLOSE_INTERNALS.pinReceiptDirectories(
      root.replace(/\/$/, ""),
    );
    const store = await CF01_CLOSE_INTERNALS.privateStore(
      root.replace(/\/$/, ""),
      checkDirectories,
    );
    const raw = await store.read(INPUT, false, CF01_HISTORY_LIMITS.inputBytes);
    // The shared reader returns UTF-8 text; reject replacement glyphs so the
    // persisted digest cannot silently describe a lossy decoding of input bytes.
    if (
      raw.includes("\uFFFD") ||
      Buffer.byteLength(raw) > CF01_HISTORY_LIMITS.inputBytes
    )
      fail("evidence_invalid");
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      fail("json_invalid");
    }
    const projection = projectCf01History(input);
    const receipt = {
      ...projection,
      input: { sha256: hash(raw), bytes: Buffer.byteLength(raw) },
    };
    const destination = `.local/cf01/history-inspect-${randomUUID()}.json`;
    if ((await store.read(destination, true)) !== null) fail("receipt_unsafe");
    await store.check();
    await store.save(destination, receipt);
    await store.check();
    return {
      action: "inspect",
      networkRequests: 0,
      receiptWritten: true,
      ...FLAGS,
      ...projection.summary,
    };
  } catch (error) {
    if (error instanceof Cf01HistoryError)
      throw new Cf01HistoryError(error.code);
    const suffix =
      typeof error?.code === "string" && error.code.startsWith("cf01_close_")
        ? error.code.slice(11)
        : "local_failure";
    throw new Cf01HistoryError(`cf01_history_${suffix}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--execute"))
    fail("usage");
  const output = await runCf01HistoryInspect({
    execute: argv[0] === "--execute",
  });
  console.log(JSON.stringify(output));
  return output;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(new Cf01HistoryError(error?.code).code);
    process.exitCode = 1;
  });
}
