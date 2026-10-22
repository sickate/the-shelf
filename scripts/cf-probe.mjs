import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EVIDENCE = path.join(ROOT, ".local/cf01/evidence.json");
const LABELS = {
  storage: { kind: "storage" }, scrypt: { kind: "scrypt" }, pbkdf2: { kind: "pbkdf2" },
  short: { kind: "workflow", delaySeconds: 65, mode: "success" },
  long: { kind: "workflow", delaySeconds: 840, mode: "success" },
  uncertain: { kind: "workflow", delaySeconds: 65, mode: "uncertain" },
};

export function config(env) {
  if (!/^[a-f0-9]{64}$/.test(env.CF_PROBE_TOKEN || "")) throw new Error("CF_PROBE_TOKEN must be 32 random bytes encoded as 64 lowercase hex characters");
  const url = new URL(env.CF_PROBE_URL);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("CF_PROBE_URL must be an HTTPS origin (localhost HTTP allowed)");
  return { origin: url.origin, token: env.CF_PROBE_TOKEN };
}
async function run(argv) {
  // No dotenv parser or shell interpolation; never send a secret in argv.
  try { process.loadEnvFile(path.join(ROOT, ".env")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot load private environment file"); }
  const settings = config(process.env);
  let evidence = { schemaVersion: 1, runs: [], requests: [] };
  try {
    const raw = await readFile(EVIDENCE, "utf8");
    if (raw.length > 1024 * 1024) throw new Error("Evidence file too large");
    evidence = JSON.parse(raw);
    if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.runs) || !Array.isArray(evidence.requests)) throw new Error("Invalid evidence file");
  } catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot read CF-01 evidence safely"); }
  await mkdir(path.dirname(EVIDENCE), { recursive: true, mode: 0o700 });
  const persist = async () => {
    const temporary = `${EVIDENCE}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(evidence, null, 2) + "\n");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, EVIDENCE);
    await chmod(EVIDENCE, 0o600);
  };
  const call = async (method, pathname, body) => {
    if (evidence.requests.length >= 512) throw new Error("Local evidence request cap reached; inspect before continuing");
    const record = { method, pathname, at: new Date().toISOString(), outcome: "pending" };
    evidence.requests.push(record);
    await persist();
    try {
      const response = await fetch(settings.origin + pathname, {
        method, redirect: "error", headers: { authorization: `Bearer ${settings.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000),
      });
      const text = await response.text();
      if (text.length > 16384) throw new Error("Oversized response");
      const data = JSON.parse(text);
      record.outcome = "response"; record.status = response.status; record.data = data;
      await persist();
      if (!response.ok) throw new Error(`Probe returned HTTP ${response.status}; inspect private evidence`);
      return data;
    } catch (error) {
      if (record.outcome === "pending") { record.outcome = "uncertain_no_resend"; await persist(); }
      throw new Error(record.outcome === "uncertain_no_resend" ? "Request outcome uncertain; recorded run ID must be polled, never automatically resent" : error.message);
    }
  };
  const describe = data => console.log(JSON.stringify({ runId: data.run?.run_id, kind: data.run?.kind, state: data.run?.state, networkCalls: data.run?.network_calls, mockCalls: data.run?.mock_calls, result: data.run?.result_json ? JSON.parse(data.run.result_json) : undefined, workflow: data.workflow?.status, cleaned: data.cleaned }));
  const start = async label => {
    if (label === "storage") throw new Error("legacy_storage_migration_required");
    if (!Object.hasOwn(LABELS, label)) throw new Error("Expected storage, scrypt, pbkdf2, short, long or uncertain");
    const previous = evidence.runs.findLast(run => run.label === label && !run.cleaned);
    if (previous) { console.log("Existing run retained; polling without resending."); describe(await call("GET", `/v1/runs/${previous.runId}`)); return; }
    const run = { label, runId: randomUUID(), origin: settings.origin, createdAt: new Date().toISOString(), cleaned: false };
    evidence.runs.push(run);
    await persist(); // Durable local record exists even if POST disconnects.
    describe(await call("POST", "/v1/runs", { runId: run.runId, ...LABELS[label] }));
  };
  const [action, target, ...extra] = argv;
  if (extra.length) throw new Error("Too many arguments");
  if (evidence.runs.some(run => run.origin !== settings.origin)) throw new Error("Evidence belongs to another origin; inspect private evidence before changing endpoint");
  if (action === "start") return start(target);
  if (action === "smoke" && !target) { await start("storage"); return start("short"); }
  if (!["poll", "cleanup"].includes(action)) throw new Error("Usage: npm run cf:probe -- smoke | start LABEL | poll [LABEL|UUID] | cleanup [LABEL|UUID|all]");
  const runs = target === "all" && action === "cleanup" ? evidence.runs.filter(run => !run.cleaned) :
    [target ? evidence.runs.findLast(run => run.runId === target || run.label === target) : evidence.runs.findLast(run => !run.cleaned)];
  if (!runs.length || !runs[0]) throw new Error("No matching recorded run");
  for (const run of runs) {
    const data = await call(action === "poll" ? "GET" : "DELETE", `/v1/runs/${run.runId}`);
    if (action === "cleanup") { run.cleaned = true; await persist(); }
    describe(data);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [action, target, ...extra] = argv;
  if ((action === "start" && target === "storage") || (action === "smoke" && !target && extra.length === 0))
    throw new Error("legacy_storage_migration_required");
  await mkdir(path.dirname(EVIDENCE), { recursive: true, mode: 0o700 });
  const lockPath = `${EVIDENCE}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("CF-01 evidence is locked by another or interrupted client; inspect evidence before removing a stale lock");
    throw error;
  }
  try { await run(argv); }
  finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
