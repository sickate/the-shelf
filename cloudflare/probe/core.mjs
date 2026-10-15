export const PREFIX = "diagnostics/cf01/";
export const STEP_CONFIG = Object.freeze({
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
  timeout: "20 minutes",
});
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KINDS = ["storage", "scrypt", "pbkdf2", "workflow"];
export class ProbeError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}
export function validId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw new ProbeError("invalid_run_id");
  return id;
}
export function objectKey(id) { return `${PREFIX}${validId(id)}/neutral.txt`; }
export function authorized(request, token) {
  // Provision at least 32 random bytes encoded as hex; no weak fallback secret.
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
  const given = request.headers.get("authorization") || "";
  const expected = `Bearer ${token}`;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
export async function readInput(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new ProbeError("json_required", 415);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 512))
    throw new ProbeError("body_too_large", 413);
  const reader = request.body?.getReader();
  let size = 0, chunks = [];
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512) { await reader.cancel(); throw new ProbeError("body_too_large", 413); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let input;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ProbeError("invalid_json"); }
  return validateInput(input);
}
export function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProbeError("invalid_schema");
  if (Object.keys(input).some(k => !["runId", "kind", "delaySeconds", "mode"].includes(k)))
    throw new ProbeError("unknown_field");
  validId(input.runId);
  if (!KINDS.includes(input.kind)) throw new ProbeError("invalid_kind");
  if (input.kind === "workflow") {
    if (![65, 840].includes(input.delaySeconds) || !["success", "uncertain"].includes(input.mode))
      throw new ProbeError("invalid_workflow_options");
  } else if (Object.hasOwn(input, "delaySeconds") || Object.hasOwn(input, "mode")) {
    throw new ProbeError("unexpected_options");
  }
  return input;
}
export function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
export const getRun = (db, id) => stmt(db, "SELECT * FROM cf01_runs WHERE run_id = ?", validId(id)).first();
export async function saveResult(db, id, state, result) {
  await stmt(db, "UPDATE cf01_runs SET state = ?, result_json = ?, updated_at = ? WHERE run_id = ?",
    state, JSON.stringify(result), Date.now(), validId(id)).run();
}
export async function reserve(db, input) {
  const now = Date.now();
  // The schema trigger atomically reserves the run. Tombstones survive cleanup, so a retried ID
  // never recreates work and cleanup cannot reset the lifetime execution cap.
  const result = await stmt(db, `INSERT OR IGNORE INTO cf01_budget (run_id, kind, created_at, delay_seconds, mode)
      SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM cf01_budget) < 12
      AND (SELECT COUNT(*) FROM cf01_budget WHERE kind = ?) < ?
      AND (? != 'workflow' OR NOT EXISTS (
        SELECT 1 FROM cf01_runs WHERE kind = 'workflow' AND state IN ('reserved', 'running', 'uncertain')))`,
      input.runId, input.kind, now, input.delaySeconds || 0, input.mode || "success",
      input.kind, input.kind === "workflow" ? 4 : input.kind === "storage" ? 4 : 2, input.kind).run();
  return result.meta.changes > 0;
}
export async function storageProbe(env, id) {
  const key = objectKey(id);
  const text = `The Shelf neutral CF-01 diagnostic ${id}\n`;
  await env.CF_BUCKET.put(key, text, { httpMetadata: { contentType: "text/plain" } });
  const full = await env.CF_BUCKET.get(key);
  const range = await env.CF_BUCKET.get(key, { range: { offset: 4, length: 5 } });
  const fullOk = full?.size === new TextEncoder().encode(text).byteLength && await full.text() === text;
  const rangeOk = range && await range.text() === text.slice(4, 9);
  if (!fullOk || !rangeOk) throw new ProbeError("r2_verification_failed", 502);
  return { fullOk: true, rangeOk: true, bytes: new TextEncoder().encode(text).byteLength };
}
export async function runWorkflow(env, input, step) {
  validateInput(input);
  if (input.kind !== "workflow") throw new ProbeError("invalid_kind");
  const id = input.runId;
  await step.do("persist-running", STEP_CONFIG, async () => {
    await saveResult(env.CF_DB, id, "running", { phase: "network_pending" });
    return { running: true };
  });
  let outcome;
  try {
    outcome = await step.do("one-mock-network-request", STEP_CONFIG, async () => {
      const claim = await stmt(env.CF_DB,
        "UPDATE cf01_runs SET network_calls = 1, updated_at = ? WHERE run_id = ? AND network_calls = 0 AND state = 'running'",
        Date.now(), id).run();
      if (claim.meta.changes !== 1) return { state: "uncertain", reason: "already_claimed_no_resend" };
      const start = Date.now();
      try {
        const response = await env.CF_MOCK.fetch("https://cf01-mock.invalid/wait", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.CF_PROBE_TOKEN}` },
          body: JSON.stringify(input), signal: AbortSignal.timeout(18 * 60 * 1000),
        });
        const body = await response.text();
        const ok = response.status === 200 && body === "cf01-mock-completed";
        return { state: ok ? "completed" : "uncertain", reason: ok ? "mock_success" : "mock_response_uncertain", networkWallMs: Date.now() - start };
      } catch { return { state: "uncertain", reason: "network_error_no_resend", networkWallMs: Date.now() - start }; }
    });
  } catch { outcome = { state: "uncertain", reason: "step_failed_or_timed_out_no_resend" }; }
  await step.do("persist-outcome", STEP_CONFIG, async () => {
    await saveResult(env.CF_DB, id, outcome.state, outcome);
    return outcome;
  });
  return outcome;
}
