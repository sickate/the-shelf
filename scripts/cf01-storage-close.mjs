// Fixed CF01 capability reduction only. Never a drain or upload authorization.
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { selectCredentials } from "./cf-deploy.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKER = "the-shelf-cf01";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validId = (v) => typeof v === "string" && UUID.test(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
const digest = (v) => hash(JSON.stringify(v));
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
export const CF01_CLOSE_LIMITS = Object.freeze({
  requests: 32,
  ddl: 6,
  negativeProbes: 1,
  patches: 1,
  responseBytes: 2_000_000,
  deadlineMs: 30_000,
});
const CODES = new Set(
  [
    "options_invalid",
    "usage",
    "account_mismatch",
    "resource_mismatch",
    "config_mismatch",
    "bindings_invalid",
    "settings_changed",
    "deployment_invalid",
    "version_invalid",
    "schema_invalid",
    "counts_invalid",
    "inventory_changed",
    "identity_mismatch",
    "subdomain_invalid",
    "request_budget",
    "write_budget",
    "deadline",
    "response_limit",
    "response_invalid",
    "json_invalid",
    "redirect_rejected",
    "remote_rejected",
    "envelope_invalid",
    "d1_response_invalid",
    "rejection_unproven",
    "probe_row_present",
    "status_required",
    "patch_resolution_required",
    "unknown_write_quiescence_pending",
    "state_invalid",
    "operator_locked",
    "local_or_transport_failure",
    "private_directory_unsafe",
    "private_directory_changed",
    "private_file_changed",
    "private_file_unsafe",
    "receipt_unsafe",
  ].map((v) => `cf01_close_${v}`),
);
export class Cf01CloseError extends Error {
  constructor(code) {
    const safe = CODES.has(code)
      ? code
      : "cf01_close_local_or_transport_failure";
    super(safe);
    this.name = "Cf01CloseError";
    this.code = safe;
  }
}
const fail = (code) => {
  throw new Cf01CloseError(code);
};
const safeError = (e) =>
  new Cf01CloseError(e instanceof Cf01CloseError ? e.code : undefined);
const cancel = (v) => {
  try {
    void v?.cancel().catch(() => {});
  } catch {}
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
      fail("cf01_close_private_directory_unsafe");
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
      fail("cf01_close_private_directory_unsafe");
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
          fail("cf01_close_private_directory_changed");
      } catch {
        fail("cf01_close_private_directory_changed");
      }
    }
  };
}
async function readPrivate(
  root,
  relative,
  max = CF01_CLOSE_LIMITS.responseBytes,
) {
  await directory(
    root,
    path.dirname(relative) === "." ? "" : path.dirname(relative),
  );
  const filename = path.join(root, relative),
    before = await fs.lstat(filename);
  if (
    !before.isFile() ||
    before.uid !== process.getuid() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    before.size > max
  )
    fail("cf01_close_private_file_unsafe");
  const file = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await file.stat();
    if (
      opened.uid !== process.getuid() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size > max
    )
      fail("cf01_close_private_file_changed");
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
      after.uid !== process.getuid() ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.nlink !== 1 ||
      (after.mode & 0o777) !== 0o600 ||
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      final.nlink !== 1 ||
      (final.mode & 0o777) !== 0o600
    )
      fail("cf01_close_private_file_changed");
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
    fail("cf01_close_json_invalid");
  }
}
export const CF01_CLOSE_GUARDS = Object.freeze(
  [
    [
      "cf01_storage_budget_insert_closed",
      "cf01_budget",
      "BEFORE INSERT",
      "NEW.kind='storage'",
    ],
    [
      "cf01_storage_budget_update_closed",
      "cf01_budget",
      "BEFORE UPDATE",
      "OLD.kind='storage' OR NEW.kind='storage'",
    ],
    [
      "cf01_storage_budget_delete_closed",
      "cf01_budget",
      "BEFORE DELETE",
      "OLD.kind='storage'",
    ],
    [
      "cf01_storage_run_insert_closed",
      "cf01_runs",
      "BEFORE INSERT",
      "NEW.kind='storage'",
    ],
    [
      "cf01_storage_run_identity_closed",
      "cf01_runs",
      "BEFORE UPDATE",
      "(OLD.kind='storage' OR NEW.kind='storage') AND (OLD.kind IS NOT NEW.kind OR OLD.run_id IS NOT NEW.run_id OR OLD.delay_seconds IS NOT NEW.delay_seconds OR OLD.mode IS NOT NEW.mode OR OLD.created_at IS NOT NEW.created_at OR NEW.state NOT IN ('completed','failed','uncertain'))",
    ],
    [
      "cf01_storage_run_delete_closed",
      "cf01_runs",
      "BEFORE DELETE",
      "OLD.kind='storage'",
    ],
  ].map(([name, table, action, condition]) =>
    Object.freeze({
      name,
      table,
      sql: `CREATE TRIGGER ${name} ${action} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'cf01_storage_admission_closed'); END`,
    }),
  ),
);
const BASE_SCHEMA = [
  [
    "table",
    "cf01_budget",
    "cf01_budget",
    "CREATE TABLE cf01_budget (run_id TEXT PRIMARY KEY,kind TEXT NOT NULL,created_at INTEGER NOT NULL,delay_seconds INTEGER NOT NULL,mode TEXT NOT NULL)",
  ],
  [
    "table",
    "cf01_runs",
    "cf01_runs",
    "CREATE TABLE cf01_runs (run_id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,delay_seconds INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'success',network_calls INTEGER NOT NULL DEFAULT 0,mock_calls INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,result_json TEXT)",
  ],
  [
    "trigger",
    "cf01_reserve_run",
    "cf01_budget",
    "CREATE TRIGGER cf01_reserve_run AFTER INSERT ON cf01_budget BEGIN INSERT INTO cf01_runs (run_id, kind, state, delay_seconds, mode, created_at, updated_at) VALUES (NEW.run_id, NEW.kind, 'reserved', NEW.delay_seconds, NEW.mode, NEW.created_at, NEW.created_at); END",
  ],
].map(([type, name, tbl_name, sql]) => ({ type, name, tbl_name, sql }));
const normalizeSql = (sql) =>
  typeof sql === "string"
    ? sql
        .trim()
        .replace(/;$/, "")
        .replace(/\s+/g, " ")
        .replace(/\s*([(),])\s*/g, "$1")
    : "";
export const CF01_CLOSE_SQL = Object.freeze({
  schema:
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE (type='table' AND name IN ('cf01_budget','cf01_runs')) OR (type='trigger' AND tbl_name IN ('cf01_budget','cf01_runs')) ORDER BY type,name LIMIT 17",
  counts:
    "SELECT (SELECT COUNT(*) FROM cf01_budget) AS budget_all,(SELECT COUNT(*) FROM cf01_budget WHERE kind='storage') AS budget_storage,(SELECT COUNT(*) FROM cf01_budget WHERE kind='storage' AND run_id IS NULL) AS null_storage_budget,(SELECT COUNT(*) FROM cf01_runs WHERE kind='storage' AND run_id IS NULL) AS null_storage_runs,(SELECT COUNT(*) FROM cf01_runs WHERE kind='storage') AS runs_storage,(SELECT COUNT(*) FROM cf01_runs r WHERE r.kind='storage' AND NOT EXISTS (SELECT 1 FROM cf01_budget b WHERE b.run_id=r.run_id AND b.kind='storage')) AS orphan_storage",
  probe:
    "INSERT INTO cf01_budget (run_id,kind,created_at,delay_seconds,mode) VALUES (?,'storage',?,0,'success')",
  probeCount:
    "SELECT (SELECT COUNT(*) FROM cf01_budget WHERE run_id=?) AS budget_probe,(SELECT COUNT(*) FROM cf01_runs WHERE run_id=?) AS run_probe",
});
function validateSchema(rows) {
  if (!Array.isArray(rows) || rows.length >= 17)
    fail("cf01_close_schema_invalid");
  const allowed = [
    ...BASE_SCHEMA,
    ...CF01_CLOSE_GUARDS.map((g) => ({
      type: "trigger",
      name: g.name,
      tbl_name: g.table,
      sql: g.sql,
    })),
  ];
  const found = new Set();
  for (const r of rows) {
    const expected = allowed.find((e) => e.name === r.name);
    if (
      !expected ||
      found.has(r.name) ||
      r.type !== expected.type ||
      r.tbl_name !== expected.tbl_name ||
      normalizeSql(r.sql) !== normalizeSql(expected.sql)
    )
      fail("cf01_close_schema_invalid");
    found.add(r.name);
  }
  if (BASE_SCHEMA.some((r) => !found.has(r.name)))
    fail("cf01_close_schema_invalid");
  return CF01_CLOSE_GUARDS.filter((g) => found.has(g.name)).map((g) => g.name);
}
function validateCounts(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    Object.keys(rows[0]).sort().join() !==
      "budget_all,budget_storage,null_storage_budget,null_storage_runs,orphan_storage,runs_storage" ||
    Object.values(rows[0]).some((v) => !integer(v)) ||
    rows[0].null_storage_budget !== 0 ||
    rows[0].null_storage_runs !== 0 ||
    rows[0].budget_all > 12 ||
    rows[0].budget_storage > 4 ||
    rows[0].budget_storage > rows[0].budget_all ||
    rows[0].runs_storage > 4 ||
    rows[0].orphan_storage > rows[0].runs_storage
  )
    fail("cf01_close_counts_invalid");
  return rows[0];
}
function normalizeBindings(input, dbid) {
  if (!Array.isArray(input) || ![4, 5].includes(input.length))
    fail("cf01_close_bindings_invalid");
  const found = new Set(),
    output = [];
  for (const b of input) {
    if (!record(b) || found.has(b.name)) fail("cf01_close_bindings_invalid");
    found.add(b.name);
    let allowed, normalized;
    if (
      b.name === "CF_DB" &&
      b.type === "d1" &&
      (b.id ?? b.database_id) === dbid &&
      (!b.id || !b.database_id || b.id === b.database_id)
    ) {
      allowed = ["name", "type", "id", "database_id"];
      normalized = { name: b.name, type: b.type, id: dbid };
    } else if (
      b.name === "CF_BUCKET" &&
      b.type === "r2_bucket" &&
      b.bucket_name === "the-shelf-books" &&
      !b.jurisdiction
    ) {
      allowed = ["name", "type", "bucket_name", "jurisdiction"];
      normalized = { name: b.name, type: b.type, bucket_name: b.bucket_name };
    } else if (
      b.name === "CF_MOCK" &&
      b.type === "service" &&
      b.service === `${WORKER}-mock` &&
      (b.environment === undefined || b.environment === "production") &&
      b.entrypoint === undefined
    ) {
      allowed = ["name", "type", "service", "environment"];
      normalized = {
        name: b.name,
        type: b.type,
        service: b.service,
        environment: "production",
      };
    } else if (
      b.name === "CF_WORKFLOW" &&
      b.type === "workflow" &&
      b.workflow_name === WORKER &&
      b.class_name === "Cf01Workflow" &&
      (b.script_name === undefined || b.script_name === WORKER)
    ) {
      allowed = ["name", "type", "workflow_name", "class_name", "script_name"];
      normalized = {
        name: b.name,
        type: b.type,
        workflow_name: b.workflow_name,
        class_name: b.class_name,
        script_name: WORKER,
      };
    } else if (b.name === "CF_PROBE_TOKEN" && b.type === "secret_text") {
      allowed = ["name", "type", "text"];
      normalized = { name: b.name, type: b.type };
    } else fail("cf01_close_bindings_invalid");
    if (Object.keys(b).some((k) => !allowed.includes(k)))
      fail("cf01_close_bindings_invalid");
    output.push(normalized);
  }
  if (
    ["CF_DB", "CF_MOCK", "CF_WORKFLOW", "CF_PROBE_TOKEN"].some(
      (n) => !found.has(n),
    )
  )
    fail("cf01_close_bindings_invalid");
  return output.sort((a, b) => a.name.localeCompare(b.name));
}
function settingsView(settings, dbid) {
  if (!record(settings)) fail("cf01_close_bindings_invalid");
  const bindings = normalizeBindings(settings.bindings, dbid);
  // Omitted metadata is PATCH-preserved; hash it for independent drift detection.
  const other = Object.fromEntries(
    Object.entries(settings).filter(
      ([k]) => k !== "bindings" && k !== "annotations",
    ),
  );
  const annotations = settings.annotations ?? {};
  if (
    !record(annotations) ||
    Object.keys(annotations).some(
      (k) =>
        !["workers/message", "workers/tag", "workers/triggered_by"].includes(k),
    ) ||
    Object.values(annotations).some(
      (v) => typeof v !== "string" || Buffer.byteLength(v) > 1000,
    )
  )
    fail("cf01_close_settings_changed");
  const writableAnnotations = Object.fromEntries(
    Object.entries(annotations).filter(([k]) => k !== "workers/triggered_by"),
  );
  const view = {
    bindings,
    metadataSha256: digest(other),
    annotationsSha256: digest(writableAnnotations),
  };
  Object.defineProperty(view, "writableAnnotations", {
    value: writableAnnotations,
    enumerable: false,
  });
  return view;
}
async function loadFixed(root, environment) {
  const env = parseEnv(await readPrivate(root, ".env", 1_000_000));
  const credentials = selectCredentials(environment, env);
  if (credentials.ci || credentials.accountId !== env.SHELF_R2_ACCOUNT_ID)
    fail("cf01_close_account_mismatch");
  const resources = json(await readPrivate(root, ".local/cf01/resources.json"));
  const configRaw = await readPrivate(root, ".local/cf01/wrangler.json"),
    config = json(configRaw);
  if (
    !record(resources) ||
    resources.accountId !== credentials.accountId ||
    resources.databaseName !== WORKER ||
    !validId(resources.databaseId) ||
    !Array.isArray(resources.ownedWorkers) ||
    resources.ownedWorkers.length !== 2 ||
    new Set(resources.ownedWorkers).size !== 2 ||
    !resources.ownedWorkers.includes(WORKER) ||
    !resources.ownedWorkers.includes(`${WORKER}-mock`)
  )
    fail("cf01_close_resource_mismatch");
  const keys = [
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
  ];
  const exact = (v, allowed) =>
    record(v) && Object.keys(v).every((k) => allowed.includes(k));
  if (
    !exact(config, keys) ||
    config.name !== WORKER ||
    config.account_id !== credentials.accountId ||
    config.d1_databases?.length !== 1 ||
    !exact(config.d1_databases[0], [
      "binding",
      "database_id",
      "database_name",
    ]) ||
    config.d1_databases[0].binding !== "CF_DB" ||
    config.d1_databases[0].database_id !== resources.databaseId ||
    config.d1_databases[0].database_name !== WORKER ||
    !Array.isArray(config.r2_buckets) ||
    config.r2_buckets.length > 1 ||
    (config.r2_buckets.length === 1 &&
      (!exact(config.r2_buckets[0], ["binding", "bucket_name"]) ||
        config.r2_buckets[0].binding !== "CF_BUCKET" ||
        config.r2_buckets[0].bucket_name !== "the-shelf-books")) ||
    config.services?.length !== 1 ||
    !exact(config.services[0], ["binding", "service"]) ||
    config.services[0].binding !== "CF_MOCK" ||
    config.services[0].service !== `${WORKER}-mock` ||
    config.workflows?.length !== 1 ||
    !exact(config.workflows[0], ["binding", "name", "class_name"]) ||
    config.workflows[0].binding !== "CF_WORKFLOW" ||
    config.workflows[0].name !== WORKER ||
    config.workflows[0].class_name !== "Cf01Workflow"
  )
    fail("cf01_close_config_mismatch");
  return { credentials, resources, config, configRaw };
}
async function privateStore(root, checkDirectories) {
  const dir = path.join(root, ".local/cf01"),
    pins = new Map();
  const sameFile = (a, b) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    b.isFile() &&
    !b.isSymbolicLink();
  const check = async () => {
    await checkDirectories();
    for (const [relative, before] of pins) {
      let after;
      try {
        after = await fs.lstat(path.join(root, relative));
      } catch (e) {
        if (e.code !== "ENOENT" || before !== null)
          fail("cf01_close_private_file_changed");
      }
      if (
        before === null
          ? after !== undefined
          : !after || !sameFile(before, after)
      )
        fail("cf01_close_private_file_changed");
    }
  };
  const read = async (relative, optional = false) => {
    await checkDirectories();
    let before;
    try {
      before = await fs.lstat(path.join(root, relative));
    } catch (e) {
      if (e.code !== "ENOENT" || !optional) throw e;
      pins.set(relative, null);
      return null;
    }
    const raw = await readPrivate(root, relative);
    const after = await fs.lstat(path.join(root, relative));
    if (!sameFile(before, after)) fail("cf01_close_private_file_changed");
    pins.set(relative, after);
    await check();
    return raw;
  };
  const save = async (relative, value) => {
    if (!pins.has(relative)) await read(relative, true);
    await check();
    const destination = path.join(root, relative),
      temp = path.join(dir, `.storage-close-${randomUUID()}.tmp`);
    const file = await fs.open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let written;
    try {
      await check();
      await file.writeFile(
        typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2) + "\n",
      );
      await file.sync();
      written = await file.stat();
      if (
        written.uid !== process.getuid() ||
        written.nlink !== 1 ||
        (written.mode & 0o777) !== 0o600
      )
        fail("cf01_close_receipt_unsafe");
    } finally {
      await file.close();
    }
    try {
      await check();
      if (!sameFile(written, await fs.lstat(temp)))
        fail("cf01_close_receipt_unsafe");
      await fs.rename(temp, destination);
      pins.set(relative, written);
      await check();
      const parent = await fs.open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await checkDirectories();
        await parent.sync();
        await checkDirectories();
      } finally {
        await parent.close();
      }
      await check();
    } finally {
      await checkDirectories();
      await fs.rm(temp, { force: true });
    }
  };
  return { read, save, check };
}
async function boundedJson(response, signal) {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > CF01_CLOSE_LIMITS.responseBytes)
  ) {
    cancel(response.body);
    fail("cf01_close_response_limit");
  }
  if (!response.body) fail("cf01_close_response_invalid");
  const reader = response.body.getReader(),
    chunks = [];
  const aborted = () => cancel(reader);
  signal.addEventListener("abort", aborted, { once: true });
  let size = 0,
    count = 0,
    done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) fail("cf01_close_deadline");
      if (next.done) {
        done = true;
        break;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        ++count > 10000 ||
        (size += next.value.length) > CF01_CLOSE_LIMITS.responseBytes
      )
        fail("cf01_close_response_limit");
      chunks.push(Buffer.from(next.value));
    }
    return json(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", aborted);
    if (!done) cancel(reader);
    try {
      reader.releaseLock();
    } catch {}
  }
}
const d1Rows = (data) => {
  if (
    data?.success !== true ||
    !Array.isArray(data.result) ||
    data.result.length !== 1 ||
    data.result[0]?.success !== true ||
    !Array.isArray(data.result[0].results) ||
    data.result[0].meta?.has_more === true
  )
    fail("cf01_close_d1_response_invalid");
  return data.result[0].results;
};
function rejected(data, status) {
  const messages = [
    "cf01_storage_admission_closed: SQLITE_CONSTRAINT",
    "cf01_storage_admission_closed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
  ];
  return (
    status === 400 &&
    data?.success === false &&
    Array.isArray(data.errors) &&
    data.errors.length === 1 &&
    data.errors[0]?.code === 7500 &&
    messages.some((m) =>
      [m, `D1_ERROR: ${m}`].includes(data.errors[0]?.message),
    )
  );
}
function deploymentView(result) {
  // Official deployment endpoint returns an object containing deployments; first is current.
  if (
    !record(result) ||
    !Array.isArray(result.deployments) ||
    result.deployments.length < 1 ||
    result.deployments.length > 20
  )
    fail("cf01_close_deployment_invalid");
  const current = result.deployments[0];
  if (
    !validId(current?.id) ||
    !Array.isArray(current.versions) ||
    current.versions.length !== 1 ||
    current.versions[0].percentage !== 100 ||
    !validId(current.versions[0].version_id) ||
    typeof current.created_on !== "string" ||
    current.created_on.length > 50
  )
    fail("cf01_close_deployment_invalid");
  return {
    id: current.id,
    versionId: current.versions[0].version_id,
    createdOn: current.created_on,
  };
}
function validateVersion(value, id, bindings, dbid) {
  if (
    value?.id !== id ||
    !Array.isArray(value.modules) ||
    value.modules.length < 1 ||
    value.modules.length > 64 ||
    typeof value.main_module !== "string" ||
    value.main_module.length > 200
  )
    fail("cf01_close_version_invalid");
  if (digest(normalizeBindings(value.bindings, dbid)) !== digest(bindings))
    fail("cf01_close_bindings_invalid");
  const names = new Set();
  const modules = value.modules
    .map((m) => {
      if (
        !record(m) ||
        typeof m.name !== "string" ||
        m.name.length < 1 ||
        m.name.length > 200 ||
        names.has(m.name) ||
        typeof m.content_type !== "string" ||
        m.content_type.length > 100 ||
        typeof m.content_base64 !== "string"
      )
        fail("cf01_close_version_invalid");
      names.add(m.name);
      const bytes = Buffer.from(m.content_base64, "base64");
      if (bytes.toString("base64") !== m.content_base64)
        fail("cf01_close_version_invalid");
      return {
        name: m.name,
        type: m.content_type,
        bytes: bytes.length,
        sha256: hash(bytes),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!names.has(value.main_module)) fail("cf01_close_version_invalid");
  return { mainModule: value.main_module, modules };
}
export async function runCf01StorageClose({
  action = "status",
  execute = false,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  clock = Date.now,
  requestTimeoutMs = 30_000,
} = {}) {
  if (!["status", "close"].includes(action)) fail("cf01_close_usage");
  if (!execute)
    return {
      mode: "preview",
      action,
      requests: 0,
      limits: CF01_CLOSE_LIMITS,
      cloudWriteFreezeProven: false,
      drainProven: false,
      uploadAllowed: false,
    };
  if (
    execute !== true ||
    !integer(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30_000
  )
    fail("cf01_close_options_invalid");
  let receipt, store, state, receiptPath, lock, lockStat, checkDirectories;
  const statePath = ".local/cf01/storage-close-state.json";
  const save = async () => {
    await store.save(statePath, state);
    await store.save(receiptPath, receipt);
  };
  try {
    root = await fs.realpath(root);
    checkDirectories = await pinReceiptDirectories(root);
    store = await privateStore(root, checkDirectories);
    // Pin all actual inputs before validation and every later dispatch.
    for (const p of [
      ".env",
      ".local/cf01/resources.json",
      ".local/cf01/wrangler.json",
    ])
      await store.read(p);
    const fixed = await loadFixed(root, environment);
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
      if (e.code === "EEXIST") fail("cf01_close_operator_locked");
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
    const prior = await store.read(statePath, true);
    state =
      prior === null
        ? {
            schemaVersion: 1,
            identity,
            writes: [],
            failures: [],
            checkpoint: null,
          }
        : json(prior);
    if (
      state?.schemaVersion !== 1 ||
      digest(state.identity) !== digest(identity) ||
      !Array.isArray(state.writes) ||
      !Array.isArray(state.failures) ||
      state.failures.length > 128 ||
      state.writes.length > 128 ||
      state.writes.some(
        (w) =>
          !validId(w.runId) ||
          !integer(w.index) ||
          !integer(w.at) ||
          !["dispatched", "observed", "rejected", "unknown"].includes(
            w.state,
          ) ||
          !["ddl", "probe", "patch"].includes(w.kind),
      )
    )
      fail("cf01_close_state_invalid");
    const unresolved = () =>
      state.writes.filter((w) => ["dispatched", "unknown"].includes(w.state));
    const unresolvedHash = () => digest(unresolved());
    const unresolvedD1 = () => unresolved().filter((w) => w.kind !== "patch");
    const unresolvedPatches = () =>
      unresolved().filter((w) => w.kind === "patch");
    const capabilityHashes = (observation) => ({
      bindingsSha256: digest(observation.settings.bindings),
      metadataSha256: observation.settings.metadataSha256,
      annotationsSha256: observation.settings.annotationsSha256,
      codeSha256: digest(observation.code),
      subdomainSha256: digest(observation.subdomain),
    });
    const patchObservations = (observation) =>
      unresolvedPatches().map((w) => {
        if (
          !record(w.expected) ||
          Object.keys(w.expected).sort().join() !==
            "annotationsSha256,bindingsSha256,codeSha256,metadataSha256,subdomainSha256" ||
          Object.values(w.expected).some(
            (v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v),
          ) ||
          observation.settings.bindings.some((b) => b.name === "CF_BUCKET") ||
          digest(w.expected) !== digest(capabilityHashes(observation))
        )
          fail("cf01_close_patch_resolution_required");
        return {
          runId: w.runId,
          index: w.index,
          expectedSha256: digest(w.expected),
          observedSha256: digest(capabilityHashes(observation)),
        };
      });
    if (
      action === "close" &&
      (unresolved().length || state.failures.length) &&
      (!record(state.checkpoint) ||
        state.checkpoint.unknownSha256 !== unresolvedHash() ||
        state.checkpoint.failureSha256 !== digest(state.failures) ||
        !integer(state.checkpoint.observedAt) ||
        (unresolvedD1().length &&
          state.checkpoint.observedAt <
            Math.max(...unresolvedD1().map((w) => w.at)) + 31_000))
    )
      fail("cf01_close_status_required");
    if (action === "status") state.checkpoint = null;
    const runId = randomUUID();
    receiptPath = `.local/cf01/storage-close-${runId}.json`;
    receipt = {
      schemaVersion: 1,
      kind: "cf01-storage-capability-reduction",
      runId,
      action,
      identity,
      startedAt: new Date(clock()).toISOString(),
      limits: CF01_CLOSE_LIMITS,
      requests: [],
      localConfigBeforeSha256: hash(fixed.configRaw),
      status: "planned",
      routesCompleteness: "unknown",
      drainProven: false,
      cloudWriteFreezeProven: false,
      uploadAllowed: false,
    };
    await save();
    const base = `https://api.cloudflare.com/client/v4/accounts/${fixed.credentials.accountId}`,
      db = `/d1/database/${fixed.resources.databaseId}`,
      worker = `/workers/scripts/${WORKER}`;
    let ddl = 0,
      probes = 0,
      patches = 0;
    const request = async ({
      suffix,
      label,
      sql,
      params = [],
      kind = null,
      patch,
      expected,
      validate,
    }) => {
      if (receipt.requests.length >= CF01_CLOSE_LIMITS.requests)
        fail("cf01_close_request_budget");
      if (
        (kind === "ddl" && ++ddl > 6) ||
        (kind === "probe" && ++probes > 1) ||
        (kind === "patch" && ++patches > 1)
      )
        fail("cf01_close_write_budget");
      await store.check();
      await checkDirectories();
      if (!lockStat.isFile() || lockStat.isSymbolicLink())
        fail("cf01_close_operator_locked");
      const activeLock = await fs.lstat(lockPath);
      if (
        activeLock.ino !== lockStat.ino ||
        activeLock.dev !== lockStat.dev ||
        activeLock.nlink !== 1 ||
        (activeLock.mode & 0o777) !== 0o600
      )
        fail("cf01_close_operator_locked");
      const item = {
        index: receipt.requests.length + 1,
        label,
        path: suffix,
        method: patch ? "PATCH" : sql ? "POST" : "GET",
        kind: kind ?? "read",
        state: "dispatched",
        at: clock(),
        ...(sql ? { sqlSha256: hash(sql) } : {}),
      };
      receipt.requests.push(item);
      let write;
      if (kind) {
        if (state.writes.length >= 128) fail("cf01_close_write_budget");
        write = {
          runId,
          index: item.index,
          at: item.at,
          kind,
          state: "dispatched",
          ...(kind === "patch" ? { expected } : {}),
        };
        state.writes.push(write);
        state.checkpoint = null;
      }
      await save();
      const controller = new AbortController();
      let response, timer;
      try {
        const attempt = (async () => {
          let body,
            headers = { authorization: `Bearer ${fixed.credentials.token}` };
          if (patch) {
            body = new FormData();
            body.set(
              "settings",
              new Blob([JSON.stringify(patch)], { type: "application/json" }),
            );
          } else if (sql) {
            headers["content-type"] = "application/json";
            body = JSON.stringify({ sql, params });
          }
          response = await fetchImpl(base + suffix, {
            method: item.method,
            redirect: "error",
            headers,
            ...(body ? { body } : {}),
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            cancel(response.body);
            fail("cf01_close_deadline");
          }
          if (
            response.redirected ||
            (response.url && response.url !== base + suffix) ||
            (response.status >= 300 && response.status < 400)
          ) {
            cancel(response.body);
            fail("cf01_close_redirect_rejected");
          }
          item.httpStatus = response.status;
          const data = await boundedJson(response, controller.signal);
          if (controller.signal.aborted) fail("cf01_close_deadline");
          if (kind === "probe") {
            if (!rejected(data, response.status))
              fail("cf01_close_rejection_unproven");
            return { atomicRejectionProven: true };
          }
          if (!response.ok) fail("cf01_close_remote_rejected");
          if (
            data?.success !== true ||
            (data.errors !== undefined &&
              (!Array.isArray(data.errors) || data.errors.length !== 0)) ||
            data.result_info?.has_more === true ||
            (data.result_info?.total_pages > 1 &&
              !suffix.endsWith("/deployments"))
          )
            fail("cf01_close_envelope_invalid");
          return validate ? validate(data) : data.result;
        })();
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            cancel(response?.body);
            reject(new Cf01CloseError("cf01_close_deadline"));
          }, requestTimeoutMs);
        });
        const value = await Promise.race([attempt, timeout]);
        clearTimeout(timer);
        item.state = kind === "probe" ? "rejected" : "observed";
        item.sha256 = digest(value);
        if (write && kind !== "patch") write.state = item.state;
        await save();
        return value;
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
    const get = async (suffix, label, validate) =>
      request({
        suffix,
        label,
        validate: validate ? (d) => validate(d.result) : undefined,
      });
    const query = async (sql, label, params = [], kind = null) =>
      request({
        suffix: db + "/query",
        label,
        sql,
        params,
        kind,
        validate: d1Rows,
      });
    const schema = async (label) =>
      validateSchema(await query(CF01_CLOSE_SQL.schema, label));
    const counts = async (label) =>
      validateCounts(await query(CF01_CLOSE_SQL.counts, label));
    const workerSettings = async (label) =>
      get(worker + "/settings", label, (v) =>
        settingsView(v, fixed.resources.databaseId),
      );
    const deployment = async (label) =>
      get(worker + "/deployments", label, deploymentView);
    const version = async (d, s, label) =>
      get(
        `/workers/workers/${WORKER}/versions/${d.versionId}?include=modules`,
        label,
        (v) =>
          validateVersion(
            v,
            d.versionId,
            s.bindings,
            fixed.resources.databaseId,
          ),
      );
    const subdomain = async (label) =>
      get(worker + "/subdomain", label, (v) => {
        if (
          typeof v?.enabled !== "boolean" ||
          typeof v.previews_enabled !== "boolean"
        )
          fail("cf01_close_subdomain_invalid");
        return { enabled: v.enabled, previewsEnabled: v.previews_enabled };
      });
    await get(db, "d1-identity", (v) => {
      if (v?.uuid !== fixed.resources.databaseId || v.name !== WORKER)
        fail("cf01_close_identity_mismatch");
      return { uuid: v.uuid, name: v.name };
    });
    receipt.initial = {
      guards: await schema("initial-schema"),
      counts: await counts("initial-counts"),
      settings: await workerSettings("initial-settings"),
      deployment: await deployment("initial-deployment"),
    };
    receipt.initial.code = await version(
      receipt.initial.deployment,
      receipt.initial.settings,
      "initial-version",
    );
    receipt.initial.subdomain = await subdomain("initial-subdomain");
    await save();
    const observedPatches = patchObservations(receipt.initial);
    if (
      action === "close" &&
      unresolvedPatches().length &&
      digest(state.checkpoint?.patchObservations) !== digest(observedPatches)
    )
      fail("cf01_close_patch_resolution_required");
    if (action === "status") {
      const second = {
        guards: await schema("independent-schema"),
        counts: await counts("independent-counts"),
      };
      if (
        digest(second.guards) !== digest(receipt.initial.guards) ||
        digest(second.counts) !== digest(receipt.initial.counts)
      )
        fail("cf01_close_inventory_changed");
      if (
        unresolvedD1().length &&
        clock() < Math.max(...unresolvedD1().map((w) => w.at)) + 31_000
      )
        fail("cf01_close_unknown_write_quiescence_pending");
      const unknownProbes = unresolved().filter((w) => w.kind === "probe");
      if (unknownProbes.length > 8) fail("cf01_close_state_invalid");
      for (const unknown of unknownProbes) {
        const rows = await query(
          CF01_CLOSE_SQL.probeCount,
          "unknown-probe-count",
          [unknown.runId, unknown.runId],
        );
        if (
          rows.length !== 1 ||
          rows[0].budget_probe !== 0 ||
          rows[0].run_probe !== 0
        )
          fail("cf01_close_probe_row_present");
      }
      state.checkpoint = {
        unknownSha256: unresolvedHash(),
        failureSha256: digest(state.failures),
        observedAt: clock(),
        runId,
        schemaSha256: digest(second.guards),
        patchObservations: observedPatches,
      };
      receipt.final = { ...receipt.initial, ...second };
    } else {
      for (const guard of CF01_CLOSE_GUARDS) {
        if (receipt.initial.guards.includes(guard.name)) continue;
        await query(guard.sql, `install-${guard.name}`, [], "ddl");
        const present = await schema(`verify-${guard.name}`);
        if (!present.includes(guard.name)) fail("cf01_close_schema_invalid");
      }
      // Every probe has a new ID. No uncertain probe is ever replayed.
      await request({
        suffix: db + "/query",
        label: "storage-admission-negative",
        sql: CF01_CLOSE_SQL.probe,
        params: [runId, clock()],
        kind: "probe",
      });
      const probeRows = await query(
        CF01_CLOSE_SQL.probeCount,
        "independent-probe-count",
        [runId, runId],
      );
      if (
        probeRows.length !== 1 ||
        probeRows[0].budget_probe !== 0 ||
        probeRows[0].run_probe !== 0
      )
        fail("cf01_close_probe_row_present");
      if (
        digest(await counts("post-guard-counts")) !==
        digest(receipt.initial.counts)
      )
        fail("cf01_close_inventory_changed");
      const before = await workerSettings("prepatch-settings"),
        beforeDeployment = await deployment("prepatch-deployment");
      if (
        digest(before) !== digest(receipt.initial.settings) ||
        digest(beforeDeployment) !== digest(receipt.initial.deployment)
      )
        fail("cf01_close_settings_changed");
      const expected = before.bindings.filter((b) => b.name !== "CF_BUCKET");
      if (fixed.config.r2_buckets.length) {
        await store.save(
          ".local/cf01/wrangler.json",
          JSON.stringify({ ...fixed.config, r2_buckets: [] }, null, 2) + "\n",
        );
        receipt.localConfigClosedSha256 = hash(
          await store.read(".local/cf01/wrangler.json"),
        );
        await save();
      }
      if (before.bindings.some((b) => b.name === "CF_BUCKET")) {
        const patch = {
          bindings: expected.map((b) => ({
            name: b.name,
            type: "inherit",
            version_id: beforeDeployment.versionId,
          })),
          annotations: before.writableAnnotations,
        };
        await request({
          suffix: worker + "/settings",
          label: "remove-fixed-r2-binding",
          kind: "patch",
          expected: {
            bindingsSha256: digest(expected),
            metadataSha256: before.metadataSha256,
            annotationsSha256: before.annotationsSha256,
            codeSha256: digest(receipt.initial.code),
            subdomainSha256: digest(receipt.initial.subdomain),
          },
          patch,
          validate: (d) => {
            const s = settingsView(d.result, fixed.resources.databaseId);
            if (
              digest(s.bindings) !== digest(expected) ||
              s.metadataSha256 !== before.metadataSha256 ||
              s.annotationsSha256 !== before.annotationsSha256
            )
              fail("cf01_close_settings_changed");
            return s;
          },
        });
      }
      const finalSettings = await workerSettings("independent-settings"),
        finalDeployment = await deployment("independent-deployment");
      const finalCode = await version(
          finalDeployment,
          finalSettings,
          "independent-version",
        ),
        finalSubdomain = await subdomain("independent-subdomain");
      const finalGuards = await schema("final-schema"),
        finalCounts = await counts("final-counts");
      if (
        digest(finalSettings.bindings) !== digest(expected) ||
        finalSettings.metadataSha256 !== before.metadataSha256 ||
        finalSettings.annotationsSha256 !== before.annotationsSha256 ||
        digest(finalCode) !== digest(receipt.initial.code) ||
        digest(finalSubdomain) !== digest(receipt.initial.subdomain) ||
        finalGuards.length !== 6 ||
        digest(finalCounts) !== digest(receipt.initial.counts)
      )
        fail("cf01_close_settings_changed");
      receipt.final = {
        guards: finalGuards,
        counts: finalCounts,
        settings: finalSettings,
        deployment: finalDeployment,
        code: finalCode,
        subdomain: finalSubdomain,
      };
    }
    for (const w of state.writes)
      if (w.runId === runId && w.kind === "patch" && w.state === "dispatched")
        w.state = "observed";
    receipt.status =
      action === "close"
        ? "capability-reduced-drain-unproven"
        : "status-observed-closure-unproven";
    receipt.storageAdmissionGuardsObserved = receipt.final.guards.length === 6;
    receipt.r2BindingAbsentObserved = !receipt.final.settings.bindings.some(
      (b) => b.name === "CF_BUCKET",
    );
    await save();
    return {
      mode: "execute",
      action,
      status: receipt.status,
      requests: receipt.requests.length,
      ddl,
      patches,
      storageAdmissionGuardsObserved: receipt.storageAdmissionGuardsObserved,
      r2BindingAbsentObserved: receipt.r2BindingAbsentObserved,
      routesCompleteness: "unknown",
      drainProven: false,
      cloudWriteFreezeProven: false,
      uploadAllowed: false,
      receiptSha256: digest(receipt),
    };
  } catch (e) {
    const error = safeError(e);
    if (receipt && store && state) {
      for (const w of state.writes)
        if (
          w.runId === receipt.runId &&
          w.kind === "patch" &&
          w.state === "dispatched"
        )
          w.state = "unknown";
      receipt.status = "failed-closed";
      receipt.error = error.code;
      if (
        receipt.action === "close" &&
        state.writes.some((w) => w.runId === receipt.runId)
      ) {
        state.failures.push({ runId: receipt.runId, at: clock() });
        state.checkpoint = null;
      }
      try {
        await save();
      } catch {}
    }
    throw error;
  } finally {
    if (lock) {
      try {
        await checkDirectories();
        const file = path.join(root, ".local/cf01/storage-close.lock"),
          s = await fs.lstat(file);
        if (s.ino === lockStat?.ino && s.dev === lockStat?.dev && s.nlink === 1)
          await fs.unlink(file);
      } catch {}
      await lock.close();
    }
  }
}
export async function main(argv = process.argv.slice(2)) {
  if (
    argv.length > 2 ||
    (argv[0] !== undefined && !["close", "status"].includes(argv[0])) ||
    (argv[1] !== undefined && argv[1] !== "--execute")
  )
    fail("cf01_close_usage");
  const out = await runCf01StorageClose({
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
    console.error(
      JSON.stringify({ error: safeError(e).code, uploadAllowed: false }),
    );
    process.exitCode = 1;
  });
