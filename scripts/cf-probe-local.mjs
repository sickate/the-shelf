import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Wrangler pins this Miniflare version. No .env, network API, or disk database.
const root = fileURLToPath(new URL("../", import.meta.url));
const token = "ab".repeat(32);
const options = convertV4MiniflareOptions({
  modules: true,
  scriptPath: `${root}.local/cf01/build/worker.js`,
  compatibilityDate: "2026-10-15",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { CF_PROBE_TOKEN: token },
  d1Databases: { CF_DB: "cf01-local-only" },
  r2Buckets: ["CF_BUCKET"],
  workflows: { CF_WORKFLOW: { name: "cf01-local", className: "Cf01Workflow" } },
  serviceBindings: { CF_MOCK: async () => new Response("cf01-mock-completed") },
  d1Persist: false, r2Persist: false, workflowsPersist: false,
});
options.telemetry = { enabled: false };
const mf = new Miniflare(options);
try {
  const db = await mf.getD1Database("CF_DB");
  // D1 exec's line parser requires each whole statement on one line, including triggers.
  const schema = await readFile(new URL("../cloudflare/probe/schema.sql", import.meta.url), "utf8");
  const clean = schema.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim();
  await db.exec(clean);
  const call = (method, pathname, body) => mf.dispatchFetch(`https://probe.example${pathname}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await mf.dispatchFetch("https://probe.example/v1/runs")).status, 401);
  const id = randomUUID();
  const response = await call("POST", "/v1/runs", { runId: id, kind: "storage" });
  const created = await response.json();
  assert.equal(response.status, 200, JSON.stringify(created));
  assert.equal(created.run.state, "completed");
  const queried = await (await call("GET", `/v1/runs/${id}`)).json();
  assert.equal(queried.run.run_id, id);
  assert.equal(queried.run.state, "completed");
  assert.equal((await (await call("DELETE", `/v1/runs/${id}`)).json()).cleaned, true);
  assert.equal((await call("GET", `/v1/runs/${id}`)).status, 404);
  assert.equal((await call("POST", "/v1/runs", { runId: id, kind: "storage" })).status, 409);
  console.log(JSON.stringify({ runtime: "workerd", storage: JSON.parse(created.run.result_json), crossRequest: true, cleaned: true, noResendAfterCleanup: true }));
} finally { await mf.dispose(); }
