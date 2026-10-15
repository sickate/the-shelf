import { ProbeError, authorized, json, readInput, stmt } from "./core.mjs";

export async function mockFetch(request, env, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  if (!authorized(request, env.CF_PROBE_TOKEN)) return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST" || new URL(request.url).pathname !== "/wait" || new URL(request.url).search)
    return json({ error: "not_found" }, 404);
  try {
    const input = await readInput(request);
    if (input.kind !== "workflow") throw new ProbeError("invalid_kind");
    const claim = await stmt(env.CF_DB,
      `UPDATE cf01_runs SET mock_calls = 1 WHERE run_id = ? AND kind = 'workflow'
      AND state = 'running' AND network_calls = 1 AND mock_calls = 0 AND delay_seconds = ? AND mode = ?`,
      input.runId, input.delaySeconds, input.mode).run();
    if (claim.meta.changes !== 1) return json({ error: "not_reserved_or_duplicate" }, 409);
    // Actual network request remains open here; no Workflow step.sleep shortcut.
    await wait(input.delaySeconds * 1000);
    return new Response(input.mode === "success" ? "cf01-mock-completed" : "cf01-mock-uncertain", { status: input.mode === "success" ? 200 : 503 });
  } catch (error) {
    return json({ error: error instanceof ProbeError ? error.message : "mock_internal_error" }, error instanceof ProbeError ? error.status : 500);
  }
}
export default { fetch: (request, env) => mockFetch(request, env) };
