import { ProbeError, authorized, getRun, json, objectKey, readInput, reserve, saveResult, stmt, storageProbe, validId } from "./core.mjs";
import { safeCryptoFailureReason } from "./crypto.mjs";

export async function handle(request, env, cryptoProbe) {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true, probe: "CF-01" });
    if (!authorized(request, env.CF_PROBE_TOKEN)) return json({ error: "unauthorized" }, 401);
    if (url.search) throw new ProbeError("query_not_allowed");
    if (url.pathname === "/v1/runs" && request.method === "POST") {
      const input = await readInput(request);
      if (!await reserve(env.CF_DB, input)) {
        const existing = await getRun(env.CF_DB, input.runId);
        if (existing && (existing.kind !== input.kind || existing.delay_seconds !== (input.delaySeconds || 0) || existing.mode !== (input.mode || "success")))
          return json({ error: "id_conflict" }, 409);
        return json({ duplicate: true, run: existing, noResend: true }, existing ? 200 : 409);
      }
      if (input.kind === "workflow") {
        try { await env.CF_WORKFLOW.create({ id: input.runId, params: input }); }
        catch { await saveResult(env.CF_DB, input.runId, "uncertain", { reason: "workflow_creation_uncertain_no_resend" }); }
        return json({ run: await getRun(env.CF_DB, input.runId), accepted: true }, 202);
      }
      await saveResult(env.CF_DB, input.runId, "running", { phase: input.kind });
      try {
        const result = input.kind === "storage" ? await storageProbe(env, input.runId) : await cryptoProbe(input.kind);
        await saveResult(env.CF_DB, input.runId, "completed", result);
      } catch (error) {
        await saveResult(env.CF_DB, input.runId, "failed", { reason: safeCryptoFailureReason(error) });
      }
      return json({ run: await getRun(env.CF_DB, input.runId) });
    }
    const match = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);
    const id = validId(match[1]);
    const run = await getRun(env.CF_DB, id);
    if (!run) return json({ error: "not_found" }, 404);
    if (request.method === "GET") {
      let workflow = null;
      if (run.kind === "workflow") {
        try { workflow = await (await env.CF_WORKFLOW.get(id)).status(); }
        catch { workflow = { status: "unavailable" }; }
      }
      return json({ run, workflow });
    }
    if (request.method === "DELETE") {
      // A non-Workflow invocation cannot be terminated here. Keep its row and
      // object until it finishes so an in-flight put cannot outlive cleanup.
      if (run.kind !== "workflow" && !["completed", "failed"].includes(run.state))
        throw new ProbeError("run_not_terminal", 409);
      // Terminate first. If creation was uncertain and no instance can be found,
      // retain the row until an operator resolves it; never race a live workflow.
      if (run.kind === "workflow") {
        try { await (await env.CF_WORKFLOW.get(id)).terminate(); }
        catch {
          const status = await (await env.CF_WORKFLOW.get(id)).status();
          if (!["complete", "errored", "terminated"].includes(status.status)) throw new ProbeError("workflow_not_stopped", 409);
        }
      }
      await env.CF_BUCKET.delete(objectKey(id));
      const remaining = await env.CF_BUCKET.head(objectKey(id));
      if (remaining) throw new ProbeError("cleanup_verification_failed", 502);
      await stmt(env.CF_DB, "DELETE FROM cf01_runs WHERE run_id = ?", id).run();
      return json({ cleaned: true, budgetTombstoneRetained: true });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    return json({ error: error instanceof ProbeError ? error.message : "probe_internal_error" }, error instanceof ProbeError ? error.status : 500);
  }
}
