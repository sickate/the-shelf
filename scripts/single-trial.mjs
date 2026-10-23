#!/usr/bin/env node
/** Fixed first-book exception. There is no general upload, arbitrary SQL or retry mode. */
import fs from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSelectedLocalObject } from "./selected-sync.mjs";
import { loadMigrationContext } from "./storage-migrate.mjs";
import { publicCatalog } from "./cf-library-data.mjs";
import { bootstrap, bootstrapInput } from "./cf-library-operations.mjs";
import {
  RemoteStorageAuthority,
  SINGLE_TRIAL_BUCKET,
  singleTrialPermit,
  singleTrialSchemaDefinitions,
  singleTrialSchemaHash,
  singleTrialAdmissionDefinition,
} from "../server/remote-storage-authority.mjs";
import {
  bytesSha256,
  objectContentType,
} from "../server/storage-authority.mjs";

import {
  SINGLE_TRIAL_TARGET_PATH,
  SINGLE_TRIAL_SECRET_PATH,
  validateSingleTrialTarget,
} from "./single-trial-config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACTIONS = new Set([
  "plan",
  "schema",
  "catalog",
  "issue",
  "status",
  "upload",
  "reconcile",
]);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const READS = new Set([
  "verify-identity",
  "verify-single-trial-schema",
  "authority-query",
  "read-single-trial",
]);
export const SINGLE_TRIAL_BUDGETS = Object.freeze({
  catalog: Object.freeze({ http: 10, ddl: 0, d1Writes: 3, objectWrites: 0 }),
  schema: Object.freeze({ http: 20, ddl: 9, d1Writes: 9, objectWrites: 0 }),
  issue: Object.freeze({ http: 12, ddl: 0, d1Writes: 1, objectWrites: 0 }),
  status: Object.freeze({ http: 6, ddl: 0, d1Writes: 0, objectWrites: 0 }),
  upload: Object.freeze({ http: 1, ddl: 0, d1Writes: 0, objectWrites: 1 }),
  reconcile: Object.freeze({ http: 16, ddl: 0, d1Writes: 2, objectWrites: 0 }),
});
export class SingleTrialError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new SingleTrialError(code);
};
const safeCode = (error) =>
  /^(single_trial_|selected_|migration_|storage_|object_|r2_|prepared_|file_|source_|manifest_|size_|empty_|invalid_|local_)[a-z_]+$/.test(
    error?.code ?? "",
  )
    ? error.code
    : "single_trial_operation_unknown";
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = (st, mode) =>
  st.uid === process.getuid() && (st.mode & 0o777) === mode;

function argumentsValue(input) {
  const { action = "plan", fileId, runId } = input;
  if (
    !ACTIONS.has(action) ||
    (fileId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(fileId)) ||
    (action !== "plan" && !ID.test(runId ?? "")) ||
    (action === "plan" && runId !== undefined)
  )
    fail("single_trial_invalid_arguments");
  return { action, fileId, runId };
}
export function parseSingleTrialArgs(args) {
  const value = { action: "plan" },
    seen = new Set();
  if (args[0] && !args[0].startsWith("--")) {
    value.action = args[0];
    args = args.slice(1);
  }
  const names = { "--file": "fileId", "--run": "runId" };
  for (let i = 0; i < args.length; i++) {
    const key = args[i],
      argument = args[++i];
    if (
      !Object.hasOwn(names, key) ||
      seen.has(key) ||
      !argument ||
      argument.startsWith("--")
    )
      fail("single_trial_invalid_arguments");
    seen.add(key);
    value[names[key]] = argument;
  }
  return argumentsValue(value);
}

// Reusable receipts are private immutable files, not command-line attestations.
async function privateDirectory(root, target, create = false) {
  if ((await fs.realpath(root)) !== path.resolve(root))
    fail("single_trial_project_path_unsafe");
  const relative = path.relative(path.join(root, ".local"), target);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    fail("single_trial_private_path_unsafe");
  let current = root;
  for (const part of [".local", ...relative.split(path.sep).filter(Boolean)]) {
    const parent = current;
    current = path.join(current, part);
    let created = false;
    if (create)
      try {
        await fs.mkdir(current, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || !owned(st, 0o700))
      fail("single_trial_private_directory_unsafe");
    if (created) await syncDirectory(parent);
  }
  return target;
}
async function syncDirectory(directory) {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeImmutable(root, filename, value) {
  await privateDirectory(root, path.dirname(filename));
  const before = await fs.lstat(path.dirname(filename));
  let handle;
  try {
    handle = await fs.open(
      filename,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error.code === "EEXIST") fail("single_trial_attempt_already_recorded");
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!sameInode(before, await fs.lstat(path.dirname(filename))))
    fail("single_trial_private_directory_changed");
  await syncDirectory(path.dirname(filename));
}
async function readPrivate(root, filename) {
  await privateDirectory(root, path.dirname(filename));
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !owned(before, 0o600) ||
      before.nlink !== 1 ||
      before.size > 100_000
    )
      fail("single_trial_private_file_unsafe");
    const value = JSON.parse(await handle.readFile("utf8"));
    const after = await handle.stat(),
      named = await fs.lstat(filename);
    if (
      !sameInode(before, named) ||
      !sameInode(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("single_trial_private_file_changed");
    return value;
  } finally {
    await handle.close();
  }
}

async function selectionFileId(root) {
  const selection = await readPrivate(
    root,
    path.join(root, ".local/single-trial/selection.json"),
  );
  if (
    !selection ||
    Object.keys(selection).sort().join() !== "fileId,schemaVersion" ||
    selection.schemaVersion !== 1 ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(selection.fileId ?? "")
  )
    fail("single_trial_selection_invalid");
  return selection.fileId;
}

async function journal(root, directory, action, runId, identity) {
  await privateDirectory(root, directory, true);
  const run = path.join(directory, runId);
  try {
    await fs.mkdir(run, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") fail("single_trial_run_exists");
    throw error;
  }
  await syncDirectory(directory);
  await writeImmutable(root, path.join(run, "run.json"), {
    schemaVersion: 1,
    action,
    identity,
    budget: SINGLE_TRIAL_BUDGETS[action],
  });
  let count = 0,
    writes = 0;
  const deadline = Date.now() + 300_000;
  return {
    async before(intent) {
      if (Date.now() > deadline) fail("single_trial_deadline");
      if (++count > SINGLE_TRIAL_BUDGETS[action].http)
        fail("single_trial_request_budget");
      if (
        intent.mutating &&
        ++writes >
          SINGLE_TRIAL_BUDGETS[action].d1Writes +
            SINGLE_TRIAL_BUDGETS[action].objectWrites
      )
        fail("single_trial_write_budget");
      const id = String(count).padStart(3, "0");
      await writeImmutable(root, path.join(run, `${id}-intent.json`), {
        schemaVersion: 1,
        ...intent,
        sequence: count,
        registeredAt: Date.now(),
      });
      return id;
    },
    outcome: (id, value) =>
      writeImmutable(root, path.join(run, `${id}-outcome.json`), value),
    finish: (value) =>
      writeImmutable(root, path.join(run, "result.json"), value),
  };
}

const ADMISSION_QUERY =
  "SELECT name,sql FROM sqlite_master WHERE name='admission_private' LIMIT 2";
const AUTH_QUERY =
  "SELECT scope,generation,enabled FROM auth_config WHERE scope='production' LIMIT 2";
const CATALOG_QUERY =
  "SELECT count(*) AS matches FROM catalog_books c,json_each(c.public_json,'$.files') f WHERE c.scope='production' AND json_extract(f.value,'$.id')=? AND json_extract(f.value,'$.format') IN ('PDF','EPUB') AND json_extract(f.value,'$.status')='candidate' AND json_extract(f.value,'$.sizeBytes') BETWEEN 1 AND 20000000";
const CATALOG_EXACT_QUERY =
  CATALOG_QUERY +
  " AND c.book_id=? AND json_extract(f.value,'$.format')=? AND json_extract(f.value,'$.sizeBytes')=?";
const CATALOG_PREFLIGHT_QUERY =
  "SELECT (SELECT count(*) FROM auth_config WHERE scope='production') AS auth_rows,(SELECT enabled FROM auth_config WHERE scope='production') AS enabled,(SELECT count(*) FROM catalog_books WHERE scope='production') AS books,(SELECT count(*) FROM metadata_overrides WHERE scope='production') AS overrides,(SELECT count(*) FROM catalog_imports WHERE scope='production' AND state='active') AS active_imports";
const BOOTSTRAP_READ_QUERY =
  "SELECT state,input_hash,seeded_overrides FROM catalog_imports WHERE scope=?";
const CATALOG_READBACK_QUERY =
  "SELECT i.state,i.input_hash,i.base_hash,i.book_count,i.patch_count,i.seeded_overrides,s.base_revision,(SELECT count(*) FROM catalog_books WHERE scope='production') AS books,(SELECT count(*) FROM metadata_overrides WHERE scope='production') AS overrides,c.book_id,c.public_json FROM catalog_imports i JOIN public_state s ON s.scope=i.scope JOIN catalog_books c ON c.scope=i.scope WHERE i.scope='production' LIMIT 2";
const OLD_ADMISSION = readFileSync(
  new URL("../cloudflare/library/schema.sql", import.meta.url),
  "utf8",
)
  .match(/CREATE TRIGGER IF NOT EXISTS admission_private\b[\s\S]*?\nEND;/)[0]
  .replace("IF NOT EXISTS ", "")
  .trim()
  .replace(/;$/, "");
const SCHEMA_QUERY =
  "SELECT name,sql FROM sqlite_master WHERE name='shelf_storage_single_trial' OR name GLOB 'shelf_single_trial_*' ORDER BY name LIMIT 9";
const normalized = (rows) =>
  rows.map((row) => ({
    name: row.name,
    sql: row.sql?.trim().replace(/;$/, ""),
  }));
const exactSchema = (rows) =>
  JSON.stringify(normalized(rows)) ===
  JSON.stringify(singleTrialSchemaDefinitions);

// Schema calls deliberately do not expose an arbitrary SQL API or replay a partial install.
function createD1Requests(context, log, fetchImpl, timeoutMs = 30000) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${context.identity.accountId}/d1/database/${context.identity.legacyDatabases.production}`;
  return async function request(sql, params = []) {
    const method = sql === undefined ? "GET" : "POST";
    const mutating =
      sql !== undefined &&
      ![
        SCHEMA_QUERY,
        ADMISSION_QUERY,
        AUTH_QUERY,
        CATALOG_QUERY,
        CATALOG_EXACT_QUERY,
        CATALOG_PREFLIGHT_QUERY,
        BOOTSTRAP_READ_QUERY,
        CATALOG_READBACK_QUERY,
      ].includes(sql);
    const id = await log.before({
      service: "d1",
      method,
      operation:
        sql === undefined
          ? "verify-identity"
          : mutating
            ? "single-trial-schema"
            : "verify-single-trial-schema",
      ...(sql === undefined ? {} : { sqlSha256: bytesSha256(sql) }),
      mutating,
    });
    const controller = new AbortController();
    let response, timer, reader;
    try {
      const attempt = (async () => {
        response = await fetchImpl(url + (sql === undefined ? "" : "/query"), {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${context.credentials.token}`,
            "content-type": "application/json",
          },
          ...(sql === undefined
            ? {}
            : { body: JSON.stringify({ sql, params }) }),
        });
        if (controller.signal.aborted) {
          try {
            void Promise.resolve(response?.body?.cancel()).catch(() => {});
          } catch {}
          fail("single_trial_deadline");
        }
        if (
          response.redirected ||
          (response.url &&
            response.url !== url + (sql === undefined ? "" : "/query")) ||
          !response.ok
        )
          fail("single_trial_remote_rejected");
        reader = response.body.getReader();
        let text = "",
          bytes = 0,
          chunkCount = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            if (!(part.value instanceof Uint8Array) || ++chunkCount > 10000)
              fail("single_trial_response_limit");
            bytes += part.value.byteLength;
            if (bytes > 1_000_000 || controller.signal.aborted)
              fail("single_trial_response_limit");
            text += Buffer.from(part.value).toString("utf8");
          }
        } finally {
          try {
            void Promise.resolve(reader.cancel()).catch(() => {});
          } catch {}
          try {
            reader.releaseLock();
          } catch {}
        }
        const envelope = JSON.parse(text);
        if (
          envelope.success !== true ||
          (sql !== undefined &&
            (!Array.isArray(envelope.result) ||
              envelope.result.length !== 1 ||
              envelope.result[0]?.success !== true ||
              !Array.isArray(envelope.result[0].results)))
        )
          fail("single_trial_response_invalid");
        await log.outcome(id, {
          state: "response-validated",
          httpStatus: response.status,
        });
        return sql === undefined ? envelope.result : envelope.result[0].results;
      })();
      return await Promise.race([
        attempt,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            try {
              void Promise.resolve(reader?.cancel()).catch(() => {});
            } catch {}
            try {
              void response?.body?.cancel().catch(() => {});
            } catch {}
            reject(new SingleTrialError("single_trial_deadline"));
          }, timeoutMs);
        }),
      ]);
    } catch {
      try {
        await log.outcome(id, { state: mutating ? "unknown" : "failed" });
      } catch {}
      fail(
        mutating
          ? "single_trial_write_outcome_unknown"
          : "single_trial_read_failed",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      try {
        void Promise.resolve(response?.body?.cancel()).catch(() => {});
      } catch {}
    }
  };
}
async function catalogAction(
  context,
  log,
  directory,
  fetchImpl,
  local,
  timeoutMs,
) {
  const filename = path.join(context.root, "data/catalog.json");
  const parent = await fs.lstat(path.dirname(filename));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    fail("single_trial_public_catalog_unsafe");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let catalog;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 20000000)
      fail("single_trial_public_catalog_unsafe");
    const value = JSON.parse(await handle.readFile("utf8"));
    const after = await handle.stat(),
      named = await fs.lstat(filename);
    if (
      !sameInode(before, after) ||
      !sameInode(before, named) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail("single_trial_public_catalog_changed");
    const matches = Array.isArray(value.books)
      ? value.books.filter((book) => book.id === local.descriptor.bookId)
      : [];
    if (matches.length !== 1) fail("single_trial_public_catalog_mismatch");
    catalog = publicCatalog({ books: matches });
    const files = catalog.books[0].files.filter(
      (file) => file.id === local.descriptor.fileId,
    );
    if (
      files.length !== 1 ||
      files[0].format !== local.descriptor.format ||
      files[0].sizeBytes !== local.descriptor.sizeBytes ||
      files[0].status !== "candidate" ||
      files[0].visibility !== "private"
    )
      fail("single_trial_public_catalog_mismatch");
  } finally {
    await handle.close();
  }
  const now = Date.now(),
    overrides = { schemaVersion: 1, books: {} };
  const input = bootstrapInput("production", catalog, overrides, now, {
    secrets: context.credentials.privateValues,
  });
  const request = createD1Requests(
    context,
    log,
    fetchImpl,
    Math.min(timeoutMs, 30000),
  );
  const identity = await request();
  if (
    identity?.uuid !== context.identity.legacyDatabases.production ||
    identity?.name !== "the-shelf-library"
  )
    fail("single_trial_identity_mismatch");
  const preflight = await request(CATALOG_PREFLIGHT_QUERY);
  if (
    preflight.length !== 1 ||
    preflight[0].auth_rows !== 1 ||
    preflight[0].enabled !== 0 ||
    preflight[0].books !== 0 ||
    preflight[0].overrides !== 0 ||
    preflight[0].active_imports !== 0
  )
    fail("single_trial_catalog_not_empty_disabled");
  await writeImmutable(
    context.root,
    path.join(directory, "catalog-attempt.json"),
    {
      schemaVersion: 1,
      identity: context.identity,
      inputFingerprint: input.inputFingerprint,
      baseRevision: input.baseRevision,
      registeredAt: now,
    },
  );
  await bootstrap({ query: request }, "production", catalog, overrides, now, {
    secrets: context.credentials.privateValues,
  });
  const rows = await request(CATALOG_READBACK_QUERY),
    row = rows[0];
  if (
    rows.length !== 1 ||
    row.state !== "complete" ||
    row.input_hash !== input.inputFingerprint ||
    row.base_hash !== input.baseRevision ||
    row.base_revision !== input.baseRevision ||
    row.book_count !== 1 ||
    row.patch_count !== 0 ||
    row.seeded_overrides !== 0 ||
    row.books !== 1 ||
    row.overrides !== 0 ||
    row.book_id !== local.descriptor.bookId ||
    row.public_json !== JSON.stringify(input.safe.books[0])
  )
    fail("single_trial_catalog_readback_failed");
  return {
    status: "catalog-imported",
    books: 1,
    catalogAvailable: true,
    uploadAllowed: false,
  };
}

async function schemaAction(
  context,
  log,
  directory,
  fetchImpl,
  fileId,
  timeoutMs,
) {
  const request = createD1Requests(
    context,
    log,
    fetchImpl,
    Math.min(timeoutMs, 30000),
  );
  const identity = await request();
  if (
    identity?.uuid !== context.identity.legacyDatabases.production ||
    identity?.name !== "the-shelf-library"
  )
    fail("single_trial_identity_mismatch");
  const before = await request(SCHEMA_QUERY);
  const admission = await request(ADMISSION_QUERY);
  const observedAdmission =
    admission.length === 1 ? normalized(admission)[0].sql : null;
  if (
    ![OLD_ADMISSION, singleTrialAdmissionDefinition.sql].includes(
      observedAdmission,
    )
  )
    fail("single_trial_admission_schema_invalid");
  const catalog = await request(CATALOG_QUERY, [fileId]);
  if (catalog.length !== 1 || ![0, 1].includes(catalog[0]?.matches))
    fail("single_trial_catalog_invalid");
  const catalogAvailable = catalog[0].matches === 1;
  if (
    exactSchema(before) &&
    observedAdmission === singleTrialAdmissionDefinition.sql
  )
    return {
      status: "schema-verified",
      catalogAvailable,
      uploadAllowed: false,
    };
  if (before.length && !exactSchema(before))
    fail("single_trial_partial_schema_requires_review");
  const auth = await request(AUTH_QUERY);
  if (
    auth.length !== 1 ||
    auth[0]?.scope !== "production" ||
    auth[0]?.enabled !== 0 ||
    !Number.isSafeInteger(auth[0]?.generation) ||
    auth[0].generation < 1
  )
    fail("single_trial_auth_not_disabled");
  const id = await log.before({
    service: "worker",
    method: "GET",
    operation: "verify-api-absent",
    mutating: false,
  });
  let response;
  try {
    response = await boundedWorkerRequest(
      fetchImpl,
      "/api/health",
      { method: "GET" },
      false,
      404,
      timeoutMs,
    );
    await log.outcome(id, { state: "api-absent-verified", httpStatus: 404 });
  } catch {
    fail("single_trial_api_not_absent");
  } finally {
    try {
      void Promise.resolve(response?.body?.cancel()).catch(() => {});
    } catch {}
  }
  await writeImmutable(
    context.root,
    path.join(directory, "schema-attempt.json"),
    {
      schemaVersion: 1,
      identity: context.identity,
      schemaSha256: singleTrialSchemaHash,
      admissionSha256: bytesSha256(singleTrialAdmissionDefinition.sql),
      registeredAt: Date.now(),
    },
  );
  if (!before.length)
    for (const definition of [...singleTrialSchemaDefinitions].sort(
      (a, b) =>
        Number(b.sql.startsWith("CREATE TABLE ")) -
        Number(a.sql.startsWith("CREATE TABLE ")),
    ))
      await request(definition.sql);
  if (observedAdmission !== singleTrialAdmissionDefinition.sql) {
    await request("DROP TRIGGER admission_private");
    await request(singleTrialAdmissionDefinition.sql);
  }
  if (
    !exactSchema(await request(SCHEMA_QUERY)) ||
    JSON.stringify(normalized(await request(ADMISSION_QUERY))) !==
      JSON.stringify([singleTrialAdmissionDefinition])
  )
    fail("single_trial_schema_invalid");
  return { status: "schema-installed", catalogAvailable, uploadAllowed: false };
}

const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const validEtag = (value) =>
  typeof value === "string" && /^"[\x21\x23-\x7e]{1,254}"$/.test(value);
async function loadTarget(context) {
  const directory = path.join(context.root, ".local/cf03/production");
  const config = await readPrivate(
    context.root,
    path.join(context.root, SINGLE_TRIAL_TARGET_PATH),
  );
  let validated;
  try {
    validated = validateSingleTrialTarget(config, context.identity.accountId);
  } catch {
    fail("single_trial_target_configuration_invalid");
  }
  // Read as bytes with the same no-follow/owner/identity checks as private JSON.
  const filename = path.join(context.root, SINGLE_TRIAL_SECRET_PATH);
  await privateDirectory(context.root, directory);
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let secret;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !owned(before, 0o600) ||
      before.nlink !== 1 ||
      before.size > 100
    )
      fail("single_trial_secret_unsafe");
    secret = (await handle.readFile("utf8")).trim();
    const after = await handle.stat(),
      named = await fs.lstat(filename);
    if (
      !sameInode(before, after) ||
      !sameInode(before, named) ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    )
      fail("single_trial_secret_changed");
  } finally {
    await handle.close();
  }
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
    Buffer.from(secret, "base64url").toString("base64url") !== secret ||
    bytesSha256(secret) !== config.uploadSecretSha256
  )
    fail("single_trial_secret_mismatch");
  return {
    sha256: validated.configSha256,
    headers: (permitId) => ({
      origin: ORIGIN,
      "x-shelf-trial-secret": secret,
      "x-shelf-trial-permit": permitId,
    }),
  };
}
async function boundedWorkerRequest(
  fetchImpl,
  pathname,
  options,
  json = false,
  requiredStatus = 200,
  timeoutMs = 60000,
) {
  const url = ORIGIN + pathname,
    controller = new AbortController();
  let response, timer, reader;
  const attempt = (async () => {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      try {
        void Promise.resolve(response?.body?.cancel()).catch(() => {});
      } catch {}
      fail("single_trial_deadline");
    }
    if (
      !response ||
      response.redirected ||
      (response.url && response.url !== url) ||
      controller.signal.aborted ||
      (response.status !== requiredStatus &&
        !(options.method === "HEAD" && response.status === 404))
    )
      fail("single_trial_worker_rejected");
    if (!json) return response;
    reader = response.body.getReader();
    let chunks = [],
      size = 0,
      chunkCount = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || ++chunkCount > 4096)
          fail("single_trial_response_limit");
        size += part.value.byteLength;
        if (size > 4096 || controller.signal.aborted)
          fail("single_trial_response_limit");
        chunks.push(Buffer.from(part.value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      try {
        void Promise.resolve(reader.cancel()).catch(() => {});
      } catch {}
      try {
        reader.releaseLock();
      } catch {}
    }
  })();
  try {
    return await Promise.race([
      attempt,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          try {
            void Promise.resolve(reader?.cancel()).catch(() => {});
          } catch {}
          try {
            void response?.body?.cancel().catch(() => {});
          } catch {}
          reject(new SingleTrialError("single_trial_deadline"));
        }, timeoutMs);
      }),
    ]);
  } catch {
    controller.abort();
    try {
      void Promise.resolve(response?.body?.cancel()).catch(() => {});
    } catch {}
    fail("single_trial_worker_outcome_unknown");
  } finally {
    clearTimeout(timer);
  }
}
function bindingStore(accountId, permit, target, log, fetchImpl, timeoutMs) {
  const descriptor = permit.descriptor;
  function metadata(response) {
    const h = response.headers,
      length = h.get("content-length"),
      etag = h.get("etag");
    if (
      !/^[1-9]\d*$/.test(length ?? "") ||
      Number(length) !== descriptor.sizeBytes ||
      h.get("x-amz-meta-sha256") !== descriptor.sha256 ||
      h.get("content-type") !== objectContentType(descriptor) ||
      !validEtag(etag) ||
      h.get("content-range") !== null ||
      ![null, "identity"].includes(h.get("content-encoding"))
    )
      fail("single_trial_object_identity_mismatch");
    return {
      size: Number(length),
      sha256: descriptor.sha256,
      etag,
      contentType: objectContentType(descriptor),
    };
  }
  async function request(method, key, extra = {}) {
    if (key !== descriptor.objectKey) fail("single_trial_key_forbidden");
    const id = await log.before({
      service: "worker",
      method,
      operation: "single-trial-object",
      mutating: false,
    });
    try {
      const response = await boundedWorkerRequest(
        fetchImpl,
        "/api/single-trial/object",
        {
          method,
          headers: {
            ...target.headers(permit.permitId),
            "accept-encoding": "identity",
            ...extra,
          },
        },
        false,
        200,
        timeoutMs,
      );
      await log.outcome(id, {
        state: "headers-received",
        httpStatus: response.status,
      });
      return response;
    } catch (error) {
      try {
        await log.outcome(id, { state: "failed" });
      } catch {}
      throw error;
    }
  }
  return Object.freeze({
    target: Object.freeze({ accountId, bucket: SINGLE_TRIAL_BUCKET }),
    async head(key) {
      const response = await request("HEAD", key);
      try {
        return response.status === 404 ? null : metadata(response);
      } finally {
        try {
          void Promise.resolve(response.body?.cancel()).catch(() => {});
        } catch {}
      }
    },
    async get(key, options) {
      if (
        !options ||
        Object.keys(options).sort().join() !== "ifMatch,maxBytes" ||
        options.maxBytes !== descriptor.sizeBytes ||
        !validEtag(options.ifMatch)
      )
        fail("single_trial_get_options_invalid");
      const response = await request("GET", key, {
        "if-match": options.ifMatch,
      });
      try {
        if (
          metadata(response).etag !== options.ifMatch ||
          !(response.body instanceof ReadableStream)
        )
          fail("single_trial_object_identity_mismatch");
        return response.body;
      } catch (error) {
        try {
          void Promise.resolve(response.body?.cancel()).catch(() => {});
        } catch {}
        throw error;
      }
    },
    async put() {
      fail("object_verification_write_forbidden");
    },
  });
}

/** Module-only injection supports synthetic transports; CLI never selects a provider. */
export async function runSingleTrial({
  action = "plan",
  fileId,
  runId,
  root = ROOT,
  environment = process.env,
  fetchImpl = fetch,
  requestTimeoutMs = 60000,
} = {}) {
  argumentsValue({ action, fileId, runId });
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 60000
  )
    fail("single_trial_invalid_arguments");
  let log;
  try {
    let local;
    if (["plan", "catalog", "issue"].includes(action)) {
      if (fileId === undefined) {
        fileId = await selectionFileId(root);
      }
      local = await loadSelectedLocalObject(root, environment, {
        action: "plan",
        profile: "production",
        fileId,
        kind: "original",
      });
      if (!["PDF", "EPUB"].includes(local.descriptor.format))
        fail("single_trial_format_invalid");
      if (action === "plan")
        return {
          action,
          status: "planned",
          format: local.descriptor.format,
          sizeBytes: local.descriptor.sizeBytes,
          uploadAllowed: false,
          accountUsage: "unknown",
          legacyRequestFinality: "unknown",
        };
    }
    const context = await loadMigrationContext({ root, environment });
    const directory = path.join(context.root, ".local/single-trial");
    log = await journal(
      context.root,
      directory,
      action,
      runId,
      context.identity,
    );
    if (action === "catalog") {
      const result = await catalogAction(
        context,
        log,
        directory,
        fetchImpl,
        local,
        requestTimeoutMs,
      );
      await log.finish(result);
      return result;
    }
    if (action === "schema") {
      const result = await schemaAction(
        context,
        log,
        directory,
        fetchImpl,
        fileId ?? (await selectionFileId(root)),
        requestTimeoutMs,
      );
      await log.finish(result);
      return result;
    }
    let pending;
    const authority = new RemoteStorageAuthority({
      identity: context.identity,
      credentials: context.credentials,
      resource: context.resources.profiles.production,
      requestLimit: SINGLE_TRIAL_BUDGETS[action].http,
      requestTimeoutMs: Math.min(requestTimeoutMs, 30000),
      verificationTimeoutMs: requestTimeoutMs,
      beforeRequest: async (intent) => {
        const mutating = !READS.has(intent.operation);
        if (
          mutating &&
          !(action === "issue" && intent.operation === "issue-single-trial") &&
          !(
            action === "reconcile" &&
            ["confirm-single-trial", "uncertain-single-trial"].includes(
              intent.operation,
            )
          )
        )
          fail("single_trial_method_rejected");
        pending = await log.before({ service: "d1", ...intent, mutating });
      },
      fetchImpl: async (url, options) => {
        const id = pending;
        pending = undefined;
        if (!id) fail("single_trial_request_without_intent");
        try {
          const response = await fetchImpl(url, options);
          await log.outcome(id, {
            state: "headers-received",
            httpStatus: response?.status ?? null,
          });
          return response;
        } catch (error) {
          try {
            await log.outcome(id, { state: "unknown" });
          } catch {}
          throw error;
        }
      },
    });
    if (action === "status") {
      const row = await authority.inspectSingleTrial(context.identity);
      const catalog = await createD1Requests(
        context,
        log,
        fetchImpl,
        Math.min(requestTimeoutMs, 30000),
      )(CATALOG_QUERY, [fileId ?? (await selectionFileId(root))]);
      if (catalog.length !== 1 || ![0, 1].includes(catalog[0]?.matches))
        fail("single_trial_catalog_invalid");
      const result = {
        catalogAvailable: catalog[0].matches === 1,
        status: row?.state ?? "not-issued",
        putAttempted: row?.putAttempted ?? false,
        contentVerified: row?.contentVerified ?? false,
        uploadAllowed: false,
      };
      await log.finish(result);
      return result;
    }
    const target = await loadTarget(context);
    if (action === "issue") {
      if (await authority.inspectSingleTrial(context.identity))
        fail("single_trial_already_issued");
      const d = local.descriptor;
      const catalog = await createD1Requests(
        context,
        log,
        fetchImpl,
        Math.min(requestTimeoutMs, 30000),
      )(CATALOG_EXACT_QUERY, [d.fileId, d.bookId, d.format, d.sizeBytes]);
      if (catalog.length !== 1 || catalog[0]?.matches !== 1)
        fail("single_trial_catalog_required");
      const now = Date.now();
      const permit = singleTrialPermit(
        {
          schemaVersion: 1,
          permitId: "first-book-20261023",
          consentId: "2026-10-23-first-book",
          target: {
            accountId: context.identity.accountId,
            bucket: SINGLE_TRIAL_BUCKET,
          },
          descriptor: local.descriptor,
          isolatedTargetConfigSha256: target.sha256,
          issuedAt: now,
          expiresAt: now + 86400000,
        },
        context.identity,
        now,
      );
      await writeImmutable(
        context.root,
        path.join(directory, "permit.json"),
        permit,
      );
      const row = await authority.issueSingleTrial(context.identity, permit);
      const result = {
        status: row.state,
        putAttempted: row.putAttempted,
        contentVerified: row.contentVerified,
        uploadAllowed: false,
      };
      await log.finish(result);
      return result;
    }
    const permit = singleTrialPermit(
      await readPrivate(context.root, path.join(directory, "permit.json")),
      context.identity,
    );
    if (permit.isolatedTargetConfigSha256 !== target.sha256)
      fail("single_trial_target_configuration_changed");
    if (action === "upload") {
      if (permit.expiresAt <= Date.now()) fail("single_trial_permit_expired");
      local = await loadSelectedLocalObject(context.root, environment, {
        action: "plan",
        profile: "production",
        fileId: permit.descriptor.fileId,
        kind: "original",
      });
      if (
        JSON.stringify(local.descriptor) !== JSON.stringify(permit.descriptor)
      )
        fail("single_trial_source_changed");
      // A fixed exclusive marker prevents a second HTTP dispatch after crash or loss.
      // Only the Worker is allowed to claim immediately before its bound R2.put.
      await writeImmutable(
        context.root,
        path.join(directory, "upload-attempt.json"),
        {
          schemaVersion: 1,
          permitId: permit.permitId,
          registeredAt: Date.now(),
        },
      );
      const id = await log.before({
        service: "worker",
        method: "POST",
        operation: "single-trial-upload",
        mutating: true,
      });
      try {
        const response = await boundedWorkerRequest(
          fetchImpl,
          "/api/single-trial/upload",
          {
            method: "POST",
            headers: {
              ...target.headers(permit.permitId),
              "content-type": "application/octet-stream",
              "content-length": String(local.bytes.byteLength),
            },
            body: local.bytes,
          },
          true,
          200,
          requestTimeoutMs,
        );
        if (
          response.state !== "uploaded" ||
          response.permitId !== permit.permitId ||
          !validEtag(response.etag) ||
          Object.keys(response).sort().join() !== "etag,permitId,state"
        )
          fail("single_trial_upload_response_invalid");
        await log.outcome(id, { state: "upload-response-validated" });
      } catch {
        try {
          await log.outcome(id, { state: "unknown" });
        } catch {}
        fail("single_trial_upload_outcome_unknown");
      }
      const result = {
        status: "uploaded-unverified",
        uploadAllowed: false,
        nextAction: "reconcile",
      };
      await log.finish(result);
      return result;
    }
    const adapter = bindingStore(
      context.identity.accountId,
      permit,
      target,
      log,
      fetchImpl,
      requestTimeoutMs,
    );
    const row = await authority.reconcileSingleTrial(
      context.identity,
      permit.permitId,
      adapter,
    );
    const result = {
      status: row.state,
      putAttempted: row.putAttempted,
      contentVerified: row.contentVerified,
      uploadAllowed: false,
      ...(row.blockedReason ? { blockedBy: row.blockedReason } : {}),
    };
    await log.finish(result);
    return result;
  } catch (error) {
    const code = safeCode(error);
    try {
      await log?.finish({ status: "stopped", code });
    } catch {}
    throw new SingleTrialError(code);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  (async () => runSingleTrial(parseSingleTrialArgs(process.argv.slice(2))))()
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(JSON.stringify({ code: safeCode(error) }));
      process.exitCode = 1;
    });
}

// Shared pinned private receipt IO only; no trial capability is exported here.
export const SINGLE_TRIAL_PRIVATE_IO = Object.freeze({
  privateDirectory,
  writeImmutable,
  readPrivate,
});
