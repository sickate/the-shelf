// Fixed CF01 management reads only. This inventory can never authorize cloud writes.
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { selectCredentials } from "./cf-deploy.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKER = "the-shelf-cf01";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const validId = (v) => typeof v === "string" && new RegExp(`^${UUID}$`).test(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
const digest = (v) => hash(JSON.stringify(v));
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, n = 100) =>
  typeof v === "string" && v.length > 0 && v.length <= n;
export const CF01_AUDIT_LIMITS = Object.freeze({
  requests: 16,
  responseBytes: 2_000_000,
  deadlineMs: 30_000,
  storageRows: 4,
  versions: 2,
});
export const CF01_AUDIT_SQL = Object.freeze({
  schema:
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (type='table' AND name IN ('cf01_budget','cf01_runs')) OR (type='trigger' AND tbl_name IN ('cf01_budget','cf01_runs')) ORDER BY type,name LIMIT 17",
  counts:
    "SELECT (SELECT COUNT(*) FROM cf01_budget) AS budget_all,(SELECT COUNT(*) FROM cf01_budget WHERE kind='storage') AS budget_storage,(SELECT COUNT(*) FROM cf01_runs WHERE kind='storage') AS runs_storage,(SELECT COUNT(*) FROM cf01_runs r WHERE r.kind='storage' AND NOT EXISTS (SELECT 1 FROM cf01_budget b WHERE b.run_id=r.run_id AND b.kind='storage')) AS orphan_storage",
  storage:
    "SELECT b.run_id,b.kind,b.created_at,b.delay_seconds,b.mode,r.run_id AS live_run_id,r.kind AS live_kind,r.state,r.delay_seconds AS live_delay_seconds,r.mode AS live_mode,r.network_calls,r.mock_calls,r.created_at AS live_created_at,r.updated_at,r.result_json FROM cf01_budget b LEFT JOIN cf01_runs r ON r.run_id=b.run_id WHERE b.kind='storage' ORDER BY b.run_id LIMIT 5",
  orphans:
    "SELECT run_id,kind,state,delay_seconds,mode,network_calls,mock_calls,created_at,updated_at,result_json FROM cf01_runs r WHERE kind='storage' AND NOT EXISTS (SELECT 1 FROM cf01_budget b WHERE b.run_id=r.run_id AND b.kind='storage') ORDER BY run_id LIMIT 5",
});
const SAFE_CODES = new Set([
  "cf01_audit_account_mismatch",
  "cf01_audit_bindings_invalid",
  "cf01_audit_bindings_unexpected",
  "cf01_audit_config_mismatch",
  "cf01_audit_d1_response_invalid",
  "cf01_audit_database_identity_mismatch",
  "cf01_audit_deadline",
  "cf01_audit_envelope_invalid",
  "cf01_audit_history_incomplete",
  "cf01_audit_json_invalid",
  "cf01_audit_known_versions_incomplete",
  "cf01_audit_local_evidence_invalid",
  "cf01_audit_local_or_transport_failure",
  "cf01_audit_options_invalid",
  "cf01_audit_private_directory_unsafe",
  "cf01_audit_private_directory_changed",
  "cf01_audit_private_file_changed",
  "cf01_audit_private_file_unsafe",
  "cf01_audit_receipt_unsafe",
  "cf01_audit_redirect_rejected",
  "cf01_audit_remote_rejected",
  "cf01_audit_request_budget",
  "cf01_audit_resource_mismatch",
  "cf01_audit_response_invalid",
  "cf01_audit_response_limit",
  "cf01_audit_schema_invalid",
  "cf01_audit_snapshot_changed",
  "cf01_audit_storage_row_invalid",
  "cf01_audit_subdomain_invalid",
  "cf01_audit_usage",
  "cf01_audit_version_invalid",
  "cf01_audit_worker_identity_mismatch",
]);
export class Cf01AuditError extends Error {
  constructor(code) {
    const safe = SAFE_CODES.has(code)
      ? code
      : "cf01_audit_local_or_transport_failure";
    super(safe);
    this.name = "Cf01AuditError";
    this.code = safe;
  }
}
const fail = (code) => {
  throw new Cf01AuditError(code);
};
// Never return a caller-controlled error instance, message, stack or extra fields.
const safeError = (e) =>
  new Cf01AuditError(e instanceof Cf01AuditError ? e.code : undefined);
const cancel = (v) => {
  try {
    void v?.cancel().catch(() => {});
  } catch {
    /* best effort only */
  }
};

async function directory(root, relative) {
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const s = await fs.lstat(current);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o700
    )
      fail("cf01_audit_private_directory_unsafe");
  }
  return current;
}
const sameDirectory = (a, b) =>
  b.isDirectory() &&
  !b.isSymbolicLink() &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.mode === b.mode;
async function pinReceiptDirectories(root) {
  const paths = [path.parse(root).root];
  for (const part of root
    .slice(paths[0].length)
    .split(path.sep)
    .filter(Boolean))
    paths.push(path.join(paths.at(-1), part));
  paths.push(path.join(root, ".local"), path.join(root, ".local/cf01"));
  const pinned = [];
  for (const filename of paths) {
    const stat = await fs.lstat(filename);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(filename)) !== filename ||
      (filename === root && stat.uid !== process.getuid())
    )
      fail("cf01_audit_private_directory_unsafe");
    pinned.push({ filename, stat });
  }
  await directory(root, ".local/cf01");
  return async () => {
    for (const { filename, stat } of pinned) {
      let current;
      try {
        current = await fs.lstat(filename);
        if (
          !sameDirectory(stat, current) ||
          (await fs.realpath(filename)) !== filename
        )
          fail("cf01_audit_private_directory_changed");
      } catch {
        fail("cf01_audit_private_directory_changed");
      }
    }
  };
}
async function readPrivate(
  root,
  relative,
  max = CF01_AUDIT_LIMITS.responseBytes,
) {
  await directory(
    root,
    path.dirname(relative) === "." ? "" : path.dirname(relative),
  );
  const filename = path.join(root, relative),
    before = await fs.lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > max
  )
    fail("cf01_audit_private_file_unsafe");
  const file = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await file.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size > max
    )
      fail("cf01_audit_private_file_changed");
    // Bound the read itself, rather than trusting a size checked before readFile.
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const raw = buffer.subarray(0, size);
    const after = await fs.lstat(filename),
      final = await file.stat();
    if (
      raw.length > max ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.nlink !== 1 ||
      (after.mode & 0o777) !== 0o600 ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.nlink !== 1 ||
      (final.mode & 0o777) !== 0o600
    )
      fail("cf01_audit_private_file_changed");
    await directory(
      root,
      path.dirname(relative) === "." ? "" : path.dirname(relative),
    );
    return raw.toString("utf8");
  } finally {
    await file.close();
  }
}
function json(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    fail("cf01_audit_json_invalid");
  }
}
async function loadFixed(root, environment) {
  const env = parseEnv(await readPrivate(root, ".env", 1_000_000));
  const credentials = selectCredentials(environment, env);
  if (credentials.ci || env.SHELF_R2_ACCOUNT_ID !== credentials.accountId)
    fail("cf01_audit_account_mismatch");
  const raw = {};
  for (const name of [
    "resources.json",
    "wrangler.json",
    "evidence.json",
    "wrangler-debug.log",
    "deploy-the-shelf-cf01.log",
  ])
    raw[name] = await readPrivate(root, `.local/cf01/${name}`);
  const resources = json(raw["resources.json"]),
    config = json(raw["wrangler.json"]),
    evidence = json(raw["evidence.json"]);
  if (
    !record(resources) ||
    resources.accountId !== credentials.accountId ||
    !validId(resources.databaseId) ||
    resources.databaseName !== WORKER ||
    !Array.isArray(resources.ownedWorkers) ||
    resources.ownedWorkers.length !== 2 ||
    new Set(resources.ownedWorkers).size !== 2 ||
    !resources.ownedWorkers.includes(WORKER) ||
    !resources.ownedWorkers.includes(`${WORKER}-mock`)
  )
    fail("cf01_audit_resource_mismatch");
  const allowed = new Set([
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "observability",
    "d1_databases",
    "r2_buckets",
    "services",
    "workflows",
    "account_id",
  ]);
  if (
    !record(config) ||
    Object.keys(config).some((k) => !allowed.has(k)) ||
    config.name !== WORKER ||
    config.account_id !== credentials.accountId ||
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0].binding !== "CF_DB" ||
    config.d1_databases[0].database_id !== resources.databaseId ||
    config.d1_databases[0].database_name !== WORKER ||
    config.r2_buckets?.length !== 1 ||
    config.r2_buckets[0].binding !== "CF_BUCKET" ||
    config.r2_buckets[0].bucket_name !== "the-shelf-books" ||
    config.services?.length !== 1 ||
    config.services[0].binding !== "CF_MOCK" ||
    config.services[0].service !== `${WORKER}-mock` ||
    config.workflows?.length !== 1 ||
    config.workflows[0].binding !== "CF_WORKFLOW" ||
    config.workflows[0].name !== WORKER ||
    config.workflows[0].class_name !== "Cf01Workflow"
  )
    fail("cf01_audit_config_mismatch");
  const versions = [
    ...new Set(
      [
        ...raw["wrangler-debug.log"].matchAll(
          new RegExp(
            `Deployed the-shelf-cf01 triggers[^\\n]*[\\s\\S]{0,500}?Current Version ID: (${UUID})(?=\\s|$)`,
            "g",
          ),
        ),
      ].map((v) => v[1]),
    ),
  ];
  const latest = [
    ...raw["deploy-the-shelf-cf01.log"].matchAll(
      new RegExp(`Current Version ID: (${UUID})(?=\\s|$)`, "g"),
    ),
  ];
  if (
    versions.length !== 2 ||
    latest.length !== 1 ||
    versions.at(-1) !== latest[0][1]
  )
    fail("cf01_audit_known_versions_incomplete");
  if (
    evidence?.schemaVersion !== 1 ||
    !Array.isArray(evidence.runs) ||
    !Array.isArray(evidence.requests) ||
    evidence.runs.length > 512 ||
    evidence.requests.length > 512
  )
    fail("cf01_audit_local_evidence_invalid");
  const runs = evidence.runs.filter((r) => r?.label === "storage");
  if (
    runs.length > 4 ||
    runs.some(
      (r) =>
        !validId(r.runId) ||
        r.origin !== "https://the-shelf-cf01.iamzhutuo.workers.dev" ||
        typeof r.cleaned !== "boolean",
    )
  )
    fail("cf01_audit_local_evidence_invalid");
  const ids = new Set(runs.map((r) => r.runId));
  const requests = evidence.requests
    .filter(
      (r) =>
        ids.has(r?.data?.run?.run_id) ||
        [...ids].some((id) => r?.pathname === `/v1/runs/${id}`),
    )
    .map((r) => {
      if (
        !["GET", "POST", "DELETE"].includes(r.method) ||
        !text(r.at, 50) ||
        !["response", "uncertain_no_resend"].includes(r.outcome)
      )
        fail("cf01_audit_local_evidence_invalid");
      return {
        method: r.method,
        pathname: r.pathname,
        at: r.at,
        outcome: r.outcome,
        status: r.status ?? null,
        run: r.data?.run ? validateRun(r.data.run) : null,
        cleaned: r.data?.cleaned === true,
        budgetTombstoneRetained: r.data?.budgetTombstoneRetained === true,
      };
    });
  return {
    credentials,
    resources,
    versions,
    local: {
      files: Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [
          k,
          { sha256: hash(v), bytes: Buffer.byteLength(v) },
        ]),
      ),
      runs: runs.map((r) => ({ runId: r.runId, cleaned: r.cleaned })),
      requests,
      unassignedUncertainStarts: evidence.requests.filter(
        (r) =>
          r?.method === "POST" &&
          r.pathname === "/v1/runs" &&
          r.outcome === "uncertain_no_resend",
      ).length,
    },
  };
}
function validateRun(r) {
  if (
    !record(r) ||
    !validId(r.run_id) ||
    r.kind !== "storage" ||
    !["reserved", "running", "completed", "failed", "uncertain"].includes(
      r.state,
    ) ||
    r.delay_seconds !== 0 ||
    r.mode !== "success" ||
    !integer(r.network_calls) ||
    !integer(r.mock_calls) ||
    !integer(r.created_at) ||
    !integer(r.updated_at) ||
    r.updated_at < r.created_at ||
    !(
      r.result_json === null ||
      (typeof r.result_json === "string" && r.result_json.length <= 16384)
    )
  )
    fail("cf01_audit_storage_row_invalid");
  return Object.fromEntries(
    [
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
    ].map((k) => [k, r[k]]),
  );
}
function validateSnapshot({ schema, counts, storage, orphans }) {
  if (
    schema.length >= 17 ||
    schema.some(
      (r) =>
        !["table", "trigger"].includes(r.type) ||
        !["cf01_budget", "cf01_runs"].includes(r.tbl_name) ||
        !text(r.name) ||
        !text(r.sql, 100000),
    ) ||
    schema
      .filter((r) => r.type === "table")
      .map((r) => r.name)
      .sort()
      .join() !== "cf01_budget,cf01_runs"
  )
    fail("cf01_audit_schema_invalid");
  if (
    counts.length !== 1 ||
    Object.keys(counts[0]).sort().join() !==
      "budget_all,budget_storage,orphan_storage,runs_storage" ||
    Object.values(counts[0]).some((n) => !integer(n)) ||
    counts[0].budget_all > 12 ||
    counts[0].budget_storage > 4 ||
    counts[0].budget_storage > counts[0].budget_all ||
    counts[0].runs_storage > 4 ||
    counts[0].orphan_storage > 4 ||
    storage.length !== counts[0].budget_storage ||
    orphans.length !== counts[0].orphan_storage ||
    storage.length >= 5 ||
    orphans.length >= 5
  )
    fail("cf01_audit_history_incomplete");
  const ids = new Set();
  let live = 0;
  for (const r of storage) {
    if (
      !validId(r.run_id) ||
      ids.has(r.run_id) ||
      r.kind !== "storage" ||
      !integer(r.created_at) ||
      r.delay_seconds !== 0 ||
      r.mode !== "success"
    )
      fail("cf01_audit_storage_row_invalid");
    ids.add(r.run_id);
    if (r.live_run_id === null) {
      if (
        [
          "live_kind",
          "state",
          "live_delay_seconds",
          "live_mode",
          "network_calls",
          "mock_calls",
          "live_created_at",
          "updated_at",
          "result_json",
        ].some((k) => r[k] !== null)
      )
        fail("cf01_audit_storage_row_invalid");
    } else {
      if (r.live_run_id !== r.run_id || r.live_created_at !== r.created_at)
        fail("cf01_audit_storage_row_invalid");
      validateRun({
        ...r,
        kind: r.live_kind,
        created_at: r.live_created_at,
        delay_seconds: r.live_delay_seconds,
        mode: r.live_mode,
      });
      live++;
    }
  }
  for (const r of orphans) {
    validateRun(r);
    if (ids.has(r.run_id)) fail("cf01_audit_history_incomplete");
    ids.add(r.run_id);
  }
  if (live + orphans.length !== counts[0].runs_storage)
    fail("cf01_audit_history_incomplete");
  return { schema, counts: counts[0], storage, orphans };
}
function bindings(input, databaseId) {
  if (!Array.isArray(input) || input.length > 8)
    fail("cf01_audit_bindings_invalid");
  const seen = new Set();
  return input.map((b) => {
    if (!record(b) || seen.has(b.name)) fail("cf01_audit_bindings_invalid");
    seen.add(b.name);
    if (b.name === "CF_PROBE_TOKEN" && b.type === "secret_text")
      return { name: b.name, type: b.type };
    if (
      b.name === "CF_DB" &&
      b.type === "d1" &&
      (b.database_id ?? b.id) === databaseId &&
      (!b.database_id || !b.id || b.database_id === b.id)
    )
      return { name: b.name, type: b.type, databaseId };
    if (
      b.name === "CF_BUCKET" &&
      b.type === "r2_bucket" &&
      b.bucket_name === "the-shelf-books" &&
      !b.jurisdiction
    )
      return { name: b.name, type: b.type, bucketName: b.bucket_name };
    if (
      b.name === "CF_MOCK" &&
      b.type === "service" &&
      b.service === `${WORKER}-mock` &&
      (b.environment === undefined || b.environment === "production")
    )
      return {
        name: b.name,
        type: b.type,
        service: b.service,
        environment: "production",
      };
    if (
      b.name === "CF_WORKFLOW" &&
      b.type === "workflow" &&
      b.workflow_name === WORKER &&
      b.class_name === "Cf01Workflow" &&
      (!b.script_name || b.script_name === WORKER)
    )
      return {
        name: b.name,
        type: b.type,
        workflowName: b.workflow_name,
        className: b.class_name,
      };
    fail("cf01_audit_bindings_unexpected");
  });
}
async function boundedJson(response, signal) {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > CF01_AUDIT_LIMITS.responseBytes)
  ) {
    cancel(response.body);
    fail("cf01_audit_response_limit");
  }
  if (!response.body) fail("cf01_audit_response_invalid");
  const reader = response.body.getReader(),
    chunks = [];
  const aborted = () => cancel(reader);
  signal.addEventListener("abort", aborted, { once: true });
  let size = 0,
    chunkCount = 0,
    done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) fail("cf01_audit_deadline");
      if (next.done) {
        done = true;
        break;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        ++chunkCount > 10000 ||
        (size += next.value.length) > CF01_AUDIT_LIMITS.responseBytes
      )
        fail("cf01_audit_response_limit");
      chunks.push(Buffer.from(next.value));
    }
    return json(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", aborted);
    if (!done) cancel(reader);
    try {
      reader.releaseLock();
    } catch {
      /* pending cancelled read */
    }
  }
}
export async function runCf01StorageAudit({
  execute = false,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  clock = Date.now,
  requestTimeoutMs = 30_000,
} = {}) {
  // Deliberately precedes even realpath/.env reads and receipt creation.
  if (!execute)
    return {
      mode: "preview",
      requests: 0,
      limits: CF01_AUDIT_LIMITS,
      cloudWriteFreezeProven: false,
      uploadAllowed: false,
    };
  if (
    execute !== true ||
    !integer(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30_000
  )
    fail("cf01_audit_options_invalid");
  let receipt, save;
  try {
    root = await fs.realpath(root);
    const checkDirectories = await pinReceiptDirectories(root);
    const fixed = await loadFixed(root, environment),
      dir = await directory(root, ".local/cf01");
    await checkDirectories();
    const filename = path.join(dir, `storage-audit-${randomUUID()}.json`);
    let receiptIdentity;
    receipt = {
      schemaVersion: 1,
      kind: "cf01-storage-read-only-audit",
      observedAt: new Date(clock()).toISOString(),
      accountId: fixed.credentials.accountId,
      worker: WORKER,
      databaseId: fixed.resources.databaseId,
      knownVersions: fixed.versions,
      limits: CF01_AUDIT_LIMITS,
      local: fixed.local,
      requests: [],
      status: "planned",
      cloudWriteFreezeProven: false,
      executionVersionMappingProven: false,
      drainProven: false,
      uploadAllowed: false,
    };
    save = async () => {
      await checkDirectories();
      const parentBefore = await fs.lstat(dir);
      const temp = path.join(dir, `.storage-audit-${randomUUID()}.tmp`),
        file = await fs.open(
          temp,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      let written;
      try {
        await checkDirectories();
        const opened = await file.stat();
        if (
          !opened.isFile() ||
          opened.uid !== process.getuid() ||
          opened.nlink !== 1 ||
          (opened.mode & 0o777) !== 0o600
        )
          fail("cf01_audit_receipt_unsafe");
        await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
        await checkDirectories();
        await file.sync();
        await checkDirectories();
        written = await file.stat();
      } finally {
        await file.close();
      }
      try {
        await checkDirectories();
        try {
          const st = await fs.lstat(filename);
          if (
            !st.isFile() ||
            st.isSymbolicLink() ||
            st.nlink !== 1 ||
            st.uid !== process.getuid() ||
            (st.mode & 0o777) !== 0o600 ||
            !receiptIdentity ||
            st.ino !== receiptIdentity.ino ||
            st.dev !== receiptIdentity.dev
          )
            fail("cf01_audit_receipt_unsafe");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        await checkDirectories();
        const temporary = await fs.lstat(temp);
        if (
          !temporary.isFile() ||
          temporary.isSymbolicLink() ||
          temporary.nlink !== 1 ||
          temporary.uid !== written.uid ||
          temporary.ino !== written.ino ||
          temporary.dev !== written.dev ||
          temporary.mode !== written.mode ||
          temporary.size !== written.size ||
          temporary.mtimeMs !== written.mtimeMs
        )
          fail("cf01_audit_receipt_unsafe");
        await fs.rename(temp, filename);
        await checkDirectories();
        const parent = await fs.open(
          dir,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          if (!sameDirectory(parentBefore, await parent.stat()))
            fail("cf01_audit_private_directory_changed");
          await checkDirectories();
          await parent.sync();
          await checkDirectories();
          if (!sameDirectory(parentBefore, await parent.stat()))
            fail("cf01_audit_private_directory_changed");
          const saved = await fs.lstat(filename);
          if (
            !saved.isFile() ||
            saved.isSymbolicLink() ||
            saved.nlink !== 1 ||
            saved.uid !== written.uid ||
            saved.ino !== written.ino ||
            saved.dev !== written.dev ||
            saved.mode !== written.mode ||
            saved.size !== written.size ||
            saved.mtimeMs !== written.mtimeMs
          )
            fail("cf01_audit_receipt_unsafe");
          receiptIdentity = saved;
          await checkDirectories();
        } finally {
          await parent.close();
        }
      } finally {
        // Never resolve cleanup through a directory that has drifted.
        await checkDirectories();
        await fs.rm(temp, { force: true });
      }
    };
    await save();
    const base = `https://api.cloudflare.com/client/v4/accounts/${fixed.credentials.accountId}`;
    const request = async (suffix, label, sql) => {
      if (receipt.requests.length >= CF01_AUDIT_LIMITS.requests)
        fail("cf01_audit_request_budget");
      const item = {
        label,
        method: sql ? "POST" : "GET",
        path: suffix,
        ...(sql ? { sqlSha256: hash(sql) } : {}),
        state: "dispatched",
      };
      receipt.requests.push(item);
      await save(); // Durable intent before dispatch. No resume or retry.
      const controller = new AbortController(),
        url = base + suffix;
      let response, timer;
      try {
        const attempt = (async () => {
          response = await fetchImpl(url, {
            method: item.method,
            redirect: "error",
            headers: {
              authorization: `Bearer ${fixed.credentials.token}`,
              "content-type": "application/json",
            },
            ...(sql ? { body: JSON.stringify({ sql, params: [] }) } : {}),
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            cancel(response.body);
            fail("cf01_audit_deadline");
          }
          if (
            response.redirected ||
            (response.url && response.url !== url) ||
            (response.status >= 300 && response.status < 400)
          ) {
            cancel(response.body);
            fail("cf01_audit_redirect_rejected");
          }
          item.httpStatus = response.status;
          if (!response.ok) {
            cancel(response.body);
            fail("cf01_audit_remote_rejected");
          }
          const data = await boundedJson(response, controller.signal);
          if (controller.signal.aborted) fail("cf01_audit_deadline");
          if (
            data?.success !== true ||
            data.result_info?.total_pages > 1 ||
            data.result_info?.has_more === true
          )
            fail("cf01_audit_envelope_invalid");
          return data.result;
        })();
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            cancel(response?.body);
            reject(new Cf01AuditError("cf01_audit_deadline"));
          }, requestTimeoutMs);
        });
        const value = await Promise.race([attempt, timeout]);
        clearTimeout(timer);
        item.state = "observed";
        item.sha256 = digest(value);
        await save();
        return value;
      } catch (e) {
        controller.abort();
        cancel(response?.body);
        const error = safeError(e);
        item.state =
          error.code !== "cf01_audit_local_or_transport_failure" &&
          error.code !== "cf01_audit_deadline"
            ? "rejected"
            : "unknown";
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    const suffix = `/d1/database/${fixed.resources.databaseId}`;
    const identity = await request(suffix, "d1-identity");
    if (
      identity?.uuid !== fixed.resources.databaseId ||
      identity?.name !== WORKER
    )
      fail("cf01_audit_database_identity_mismatch");
    const query = async (name, phase) => {
      const data = await request(
        `${suffix}/query`,
        `${phase}-${name}`,
        CF01_AUDIT_SQL[name],
      );
      if (
        !Array.isArray(data) ||
        data.length !== 1 ||
        data[0]?.success !== true ||
        !Array.isArray(data[0].results) ||
        data[0].meta?.has_more === true
      )
        fail("cf01_audit_d1_response_invalid");
      return data[0].results;
    };
    const snapshot = async (phase) => {
      const data = {};
      for (const name of ["schema", "counts", "storage", "orphans"])
        data[name] = await query(name, phase);
      return validateSnapshot(data);
    };
    receipt.initial = await snapshot("initial");
    await save();
    const settings = await request(
      `/workers/scripts/${WORKER}/settings`,
      "worker-settings",
    );
    receipt.currentBindings = bindings(
      settings?.bindings,
      fixed.resources.databaseId,
    );
    await save();
    const subdomain = await request(
      `/workers/scripts/${WORKER}/subdomain`,
      "worker-subdomain",
    );
    if (
      typeof subdomain?.enabled !== "boolean" ||
      typeof subdomain?.previews_enabled !== "boolean"
    )
      fail("cf01_audit_subdomain_invalid");
    receipt.subdomain = {
      enabled: subdomain.enabled,
      previewsEnabled: subdomain.previews_enabled,
    };
    const worker = await request(`/workers/workers/${WORKER}`, "worker-detail");
    if (
      worker?.name !== WORKER ||
      !text(worker.id) ||
      !text(worker.updated_on, 50)
    )
      fail("cf01_audit_worker_identity_mismatch");
    receipt.workerDetail = {
      id: worker.id,
      name: worker.name,
      updatedOn: worker.updated_on,
      deployedOn: worker.deployed_on ?? null,
      currentVersionId: null,
    };
    receipt.versions = [];
    for (const id of fixed.versions) {
      const version = await request(
        `/workers/workers/${WORKER}/versions/${id}?include=modules`,
        "known-worker-version",
      );
      if (
        version?.id !== id ||
        !Array.isArray(version.modules) ||
        version.modules.length < 1 ||
        version.modules.length > 64 ||
        !text(version.main_module, 200) ||
        !integer(version.number) ||
        !text(version.created_on, 50)
      )
        fail("cf01_audit_version_invalid");
      const names = new Set();
      const modules = version.modules.map((m) => {
        if (
          !record(m) ||
          !text(m.name, 200) ||
          names.has(m.name) ||
          !text(m.content_type, 100) ||
          typeof m.content_base64 !== "string"
        )
          fail("cf01_audit_version_invalid");
        names.add(m.name);
        const decoded = Buffer.from(m.content_base64, "base64");
        if (decoded.toString("base64") !== m.content_base64)
          fail("cf01_audit_version_invalid");
        return {
          name: m.name,
          contentType: m.content_type,
          bytes: decoded.length,
          sha256: hash(decoded),
          contentBase64: m.content_base64,
        };
      });
      if (!names.has(version.main_module)) fail("cf01_audit_version_invalid");
      receipt.versions.push({
        id,
        number: version.number,
        createdOn: version.created_on,
        mainModule: version.main_module,
        bindings: bindings(version.bindings, fixed.resources.databaseId),
        modules,
      });
      await save();
    }
    receipt.final = await snapshot("final");
    if (digest(receipt.initial) !== digest(receipt.final))
      fail("cf01_audit_snapshot_changed");
    receipt.storageMappings = receipt.final.storage.map((r) => ({
      runId: r.run_id,
      tombstone: r.live_run_id === null,
      liveState: r.state,
      localCompletedReceiptObserved: fixed.local.requests.some(
        (q) =>
          q.status === 200 &&
          q.outcome === "response" &&
          q.run?.run_id === r.run_id &&
          q.run.state === "completed",
      ),
      candidateVersionIds: fixed.versions,
      executionVersionMappingProven: false,
      reason:
        "execution_version_not_recorded_manual_historical_code_review_required",
    }));
    receipt.status = "inventory-observed-closure-unproven";
    await save();
    return {
      mode: "execute",
      status: receipt.status,
      requests: receipt.requests.length,
      storageReservations: receipt.final.counts.budget_storage,
      liveStorageRuns: receipt.final.counts.runs_storage,
      orphanStorageRuns: receipt.final.counts.orphan_storage,
      historicalVersions: receipt.versions.length,
      snapshotSha256: digest(receipt.final),
      receiptSha256: digest(receipt),
      executionVersionMappingProven: false,
      cloudWriteFreezeProven: false,
      drainProven: false,
      uploadAllowed: false,
    };
  } catch (e) {
    const error = safeError(e);
    if (receipt && save) {
      receipt.status = "failed-closed";
      receipt.error = error.code;
      try {
        await save();
      } catch {
        /* A failed durable save must never dispatch another request. */
      }
    }
    throw error;
  }
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--execute"))
    fail("cf01_audit_usage");
  const out = await runCf01StorageAudit({ execute: argv[0] === "--execute" });
  console.log(JSON.stringify(out));
  return out;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(
      JSON.stringify({ error: safeError(e).code, uploadAllowed: false }),
    );
    process.exitCode = 1;
  });
