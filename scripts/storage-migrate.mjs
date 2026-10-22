#!/usr/bin/env node
// Fixed project migration operator. Importing or previewing never loads secrets.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  readProjectEnvironment,
  validateDeployConfig,
  PROFILES,
} from "./cf-api-deploy.mjs";
import { readPrivateJson } from "./cf-library-data.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const MIGRATION_AUTHORITY_ID = "shelf-remote-storage-v1";
export class MigrationError extends Error {
  constructor(code) {
    const safe = SAFE_CODES.has(code) ? code : "migration_operation_unknown";
    super(safe);
    this.name = "MigrationError";
    this.code = safe;
  }
}
const SAFE_CODES = new Set([
  "account_storage_stale",
  "migration_auth_not_closed",
  "migration_check_source_missing",
  "migration_conflict",
  "migration_ddl_budget",
  "migration_deadline",
  "migration_freeze_probe",
  "migration_freeze_rejection_unproven",
  "migration_freeze_schema_incomplete",
  "migration_freeze_unproven",
  "migration_identity_mismatch",
  "migration_import_did_not_remain_closed",
  "migration_incomplete",
  "migration_invalid_arguments",
  "migration_inventory_changed_requires_budget_review",
  "migration_inventory_not_closed_empty",
  "migration_ledger_mismatch",
  "migration_limit",
  "migration_lock_unsafe",
  "migration_method_rejected",
  "migration_operation_unknown",
  "migration_operator_busy",
  "migration_original_empty_source_unproven",
  "migration_preflight_invalid",
  "migration_probe_diagnostic_limit",
  "migration_private_directory_changed",
  "migration_private_directory_unsafe",
  "migration_private_file_changed",
  "migration_private_file_unsafe",
  "migration_project_account_required",
  "migration_project_path_unsafe",
  "migration_query_rejected",
  "migration_readback_failed",
  "migration_redirect_rejected",
  "migration_remote_rejected",
  "migration_request_budget",
  "migration_required",
  "migration_response_invalid",
  "migration_response_limit",
  "migration_run_exists",
  "migration_schema_conflict",
  "migration_schema_freeze_required",
  "migration_schema_incomplete",
  "migration_schema_invalid",
  "migration_snapshot_conflict",
  "migration_source_changed",
  "migration_source_manifest_invalid",
  "migration_source_unsafe",
  "migration_state_conflict",
  "migration_status_changed",
  "migration_status_read_only",
  "migration_status_required_before_resume",
  "migration_target_rejected",
  "migration_unknown_write_quiescence_pending",
  "migration_write_closure_unproven",
  "migration_write_outcome_unknown",
  "object_absence_unresolved",
  "object_changed",
  "object_stream_required",
  "object_verification_timeout",
  "object_verification_unknown",
  "object_verification_write_forbidden",
  "preflight_auth_invalid",
  "preflight_configured_path_outside_private",
  "preflight_database_identity_mismatch",
  "preflight_deadline",
  "preflight_failed",
  "preflight_invalid_deadline",
  "preflight_ledger_invalid",
  "preflight_local_directory_unsafe",
  "preflight_local_file_unsafe",
  "preflight_local_ledger_invalid",
  "preflight_local_manifest_invalid",
  "preflight_no_arguments",
  "preflight_project_account_required",
  "preflight_redirect_rejected",
  "preflight_remote_rejected",
  "preflight_request_budget",
  "preflight_response_invalid",
  "preflight_response_limit",
  "preflight_rows_invalid",
  "preflight_schema_invalid",
  "preflight_transport_unknown",
  "preflight_unknown",
  "preflight_worker_invalid",
  "preflight_worker_target_mismatch",
  "storage_budget_exceeded",
  "storage_descriptor_invalid",
  "storage_freeze_definition_invalid",
  "storage_identity_mismatch",
  "storage_invalid_clock",
  "storage_ledger_mismatch",
  "storage_migration_required",
  "storage_put_already_claimed",
  "storage_remote_configuration_invalid",
  "storage_remote_deadline",
  "storage_remote_journal_failed",
  "storage_remote_outcome_unknown",
  "storage_remote_query_limit",
  "storage_remote_redirect",
  "storage_remote_rejected",
  "storage_remote_request_budget",
  "storage_remote_response_invalid",
  "storage_remote_response_limit",
  "storage_remote_unavailable",
  "storage_reservation_conflict",
  "storage_reservation_invalid",
  "storage_reservation_missing",
  "storage_state",
]);
const fail = (code) => {
  throw new MigrationError(code);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Module-only root injection is for isolated tests. CLI never accepts a path. */
export async function loadMigrationContext({
  root = PROJECT_ROOT,
  environment = process.env,
} = {}) {
  const actual = await fs.realpath(root);
  if (path.resolve(root) !== actual) fail("migration_project_path_unsafe");
  const loaded = await readProjectEnvironment(actual, environment);
  if (
    loaded.credentials.ci ||
    !/^[a-f0-9]{32}$/.test(loaded.credentials.accountId || "") ||
    loaded.fileEnvironment.SHELF_R2_ACCOUNT_ID !==
      loaded.credentials.accountId ||
    loaded.fileEnvironment.SHELF_R2_BUCKET !== "the-shelf-books"
  )
    fail("migration_project_account_required");
  const resources = validateDeployConfig(
    await readPrivateJson(path.join(actual, ".local/cf03/deploy.json"), actual),
  );
  return {
    root: actual,
    credentials: loaded.credentials,
    fileEnvironment: loaded.fileEnvironment,
    resources,
    identity: {
      schemaVersion: 1,
      authorityId: MIGRATION_AUTHORITY_ID,
      accountId: loaded.credentials.accountId,
      bucket: "the-shelf-books",
      legacyDatabases: {
        check: resources.profiles.check.databaseId,
        production: resources.profiles.production.databaseId,
      },
    },
  };
}

const ACTIONS = new Set(["schema-freeze", "import", "ready", "status"]);
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export const MIGRATION_BUDGETS = Object.freeze({
  "schema-freeze": Object.freeze({
    httpRequests: 144,
    ddlStatements: 102,
    ddlFileGroups: 5,
  }),
  import: Object.freeze({
    httpRequests: 80,
    ddlStatements: 0,
    ddlFileGroups: 0,
  }),
  ready: Object.freeze({ httpRequests: 0, ddlStatements: 0, ddlFileGroups: 0 }),
  status: Object.freeze({
    httpRequests: 32,
    ddlStatements: 0,
    ddlFileGroups: 0,
  }),
});
const FILES = Object.freeze({
  base: "cloudflare/library/schema.sql",
  conservative: "cloudflare/library/migrations/002-conservative-storage.sql",
  authority: "cloudflare/library/migrations/003-storage-authority.sql",
  freeze: "cloudflare/library/migrations/004-freeze-legacy-storage.sql",
});
const RESPONSE_LIMIT = 1_000_000;
const FREEZE_PROBE_SQL =
  "INSERT INTO upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,1,'PDF',?,'reserved',?,?)";
const BASIC_FROZEN_ERROR =
  /^(?:D1_ERROR: )?legacy_storage_frozen(?:: SQLITE_CONSTRAINT(?:_TRIGGER)?)?$/;
const EXTENDED_FROZEN_ERROR =
  /^(?:D1_ERROR: )?legacy_storage_frozen: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_TRIGGER\)$/;
// Pure envelope matcher for the already fixed, single-statement negative probe.
// It never consumes the diagnostic grammar or reclassifies previous unknowns.
export function matchesFrozenRejection(status, body) {
  if (status !== 400 || body?.success !== false || !Array.isArray(body.errors))
    return false;
  if (
    body.errors.some(
      (entry) =>
        typeof entry?.message === "string" &&
        BASIC_FROZEN_ERROR.test(entry.message),
    )
  )
    return true;
  return (
    body.errors.length === 1 &&
    body.errors[0]?.code === 7500 &&
    typeof body.errors[0].message === "string" &&
    EXTENDED_FROZEN_ERROR.test(body.errors[0].message)
  );
}
const GRAMMAR_WORDS = Object.freeze({
  legacy_storage_frozen: "legacy",
  SQLITE_CONSTRAINT: "constraint",
  SQLITE_CONSTRAINT_TRIGGER: "constraint_trigger",
  D1_ERROR: "d1_error",
  Error: "error_upper",
  error: "error_lower",
  code: "code",
  extended: "extended",
  7500: "cf_code_7500",
  1811: "sqlite_code_1811",
});
const GRAMMAR_PUNCTUATION = Object.freeze({
  ":": "colon",
  ".": "dot",
  ",": "comma",
  ";": "semicolon",
  "(": "lparen",
  ")": "rparen",
  "[": "lbracket",
  "]": "rbracket",
  "'": "single_quote",
  '"': "double_quote",
  "`": "backtick",
});
const grammarWhitespace = (character) =>
  character === " " ||
  character === "\t" ||
  character === "\r" ||
  character === "\n";
function errorGrammar(message) {
  // Bound every character scan, including the older presence diagnostics. Never
  // persist an unknown fragment, its hash, or an exact unknown-fragment length.
  const input = message.slice(0, 4096),
    bytes = Buffer.byteLength(input);
  const tokens = [],
    counts = {};
  let cursor = 0;
  while (cursor < input.length && tokens.length < 64) {
    const first = input[cursor];
    let token;
    if (grammarWhitespace(first)) {
      const start = cursor++;
      while (cursor < input.length && grammarWhitespace(input[cursor]))
        cursor++;
      const value = input.slice(start, cursor);
      token = /^ +$/.test(value)
        ? "space"
        : /^\t+$/.test(value)
          ? "tab"
          : /^\n+$/.test(value)
            ? "lf"
            : /^\r+$/.test(value)
              ? "cr"
              : "mixed_whitespace";
    } else if (Object.hasOwn(GRAMMAR_PUNCTUATION, first)) {
      token = GRAMMAR_PUNCTUATION[first];
      cursor++;
    } else {
      const start = cursor++;
      while (
        cursor < input.length &&
        !grammarWhitespace(input[cursor]) &&
        !Object.hasOwn(GRAMMAR_PUNCTUATION, input[cursor])
      )
        cursor++;
      const word = input.slice(start, cursor);
      token = Object.hasOwn(GRAMMAR_WORDS, word)
        ? GRAMMAR_WORDS[word]
        : "other";
      if (token !== "other") counts[token] = (counts[token] || 0) + 1;
    }
    if (token !== "other" || tokens.at(-1) !== "other") tokens.push(token);
  }
  return {
    tokens,
    knownTokenCounts: counts,
    utf8LengthBucket:
      bytes === 0
        ? "empty"
        : bytes < 64
          ? "1-63"
          : bytes < 256
            ? "64-255"
            : bytes < 1024
              ? "256-1023"
              : bytes < 4096
                ? "1024-4095"
                : "4096+",
    truncated: message.length > input.length || cursor < input.length,
    scanned: input,
  };
}
// Only bounded, structural provider diagnostics may enter the private journal.
// A token observation is diagnostic; it never proves an atomic SQL rejection.
function providerObservation(body) {
  const first = Array.isArray(body?.result) ? body.result[0] : undefined;
  const top = Array.isArray(body?.errors) ? body.errors : [],
    query = Array.isArray(first?.errors) ? first.errors : [];
  const errors = [...top.slice(0, 8), ...query.slice(0, 8)].slice(0, 8);
  const candidates = [
    ...top
      .slice(0, 8)
      .map((entry) => ({ source: "top-errors", message: entry?.message })),
    ...query
      .slice(0, 8)
      .map((entry) => ({ source: "query-errors", message: entry?.message })),
    ...(typeof body?.error === "string"
      ? [{ source: "top-error", message: body.error }]
      : []),
    ...(typeof first?.error === "string"
      ? [{ source: "query-error", message: first.error }]
      : []),
  ];
  const grammars = candidates
    .slice(0, 8)
    .filter((entry) => typeof entry.message === "string")
    .map((entry) => ({ source: entry.source, ...errorGrammar(entry.message) }));
  const messages = grammars.map((entry) => entry.scanned);
  return {
    envelopeSuccess:
      body?.success === true
        ? "true"
        : body?.success === false
          ? "false"
          : "missing",
    resultShape: Array.isArray(body?.result)
      ? "array"
      : record(body?.result)
        ? "object"
        : body?.result === null
          ? "null"
          : "missing-or-other",
    querySuccess:
      first?.success === true
        ? "true"
        : first?.success === false
          ? "false"
          : "missing",
    providerCodes: [
      ...new Set(
        errors
          .map((entry) => entry?.code)
          .filter(
            (value) =>
              Number.isSafeInteger(value) && value >= 0 && value <= 999999999,
          ),
      ),
    ].slice(0, 8),
    legacyTokenPresent: messages.some((value) =>
      /\blegacy_storage_frozen\b/.test(value),
    ),
    sqliteConstraintPresent: messages.some((value) =>
      /\bSQLITE_CONSTRAINT(?:_TRIGGER)?\b/.test(value),
    ),
    legacyConstraintExact: messages.some((value) =>
      BASIC_FROZEN_ERROR.test(value),
    ),
    legacyConstraintExtendedExact: grammars.some(
      (entry) => !entry.truncated && EXTENDED_FROZEN_ERROR.test(entry.scanned),
    ),
    errorGrammar: grammars.map(({ scanned, ...entry }) => entry),
    errorsTruncated:
      top.length +
        query.length +
        (typeof body?.error === "string" ? 1 : 0) +
        (typeof first?.error === "string" ? 1 : 0) >
      8,
  };
}
// sqlite_master preserves the submitted definition. Never fold whitespace in
// quoted literals: even apparently cosmetic drift must stop this fixed operator.
const normalizeSql = (sql) => sql.trim().replace(/;$/, "");
const safeCode = (error) =>
  SAFE_CODES.has(error?.code) ? error.code : "migration_operation_unknown";
const cancel = (target) => {
  try {
    void target?.cancel().catch(() => {});
  } catch {}
};

async function privateDirectories(root, relative) {
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o700
    )
      fail("migration_private_directory_unsafe");
  }
  return current;
}
async function privateRead(
  location,
  { optional = false, limit = 1_000_000 } = {},
) {
  let handle;
  try {
    handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > limit
    )
      fail("migration_private_file_unsafe");
    const value = JSON.parse(await handle.readFile("utf8"));
    const after = await fs.lstat(location);
    if (
      !same(stat, after) ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs
    )
      fail("migration_private_file_changed");
    return value;
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function privateWrite(location, value, exclusive = false) {
  const directory = path.dirname(location);
  const parent = await fs.lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o777) !== 0o700 ||
    parent.uid !== process.getuid()
  )
    fail("migration_private_directory_unsafe");
  try {
    const old = await fs.lstat(location);
    if (exclusive) fail("migration_run_exists");
    if (
      !old.isFile() ||
      old.isSymbolicLink() ||
      old.nlink !== 1 ||
      old.uid !== process.getuid() ||
      (old.mode & 0o777) !== 0o600
    )
      fail("migration_private_file_unsafe");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.write-${randomUUID()}.tmp`);
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const now = await fs.lstat(directory);
    if (!same(parent, now)) fail("migration_private_directory_changed");
    if (exclusive) {
      await fs.link(temporary, location);
      await fs.unlink(temporary);
    } else await fs.rename(temporary, location);
    const parentHandle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function boundedJson(response, signal) {
  const advertised = response.headers.get("content-length");
  if (
    advertised !== null &&
    (!/^\d+$/.test(advertised) || Number(advertised) > RESPONSE_LIMIT)
  )
    fail("migration_response_limit");
  if (!response.body) fail("migration_response_invalid");
  const reader = response.body.getReader(),
    chunks = [];
  const aborted = () => cancel(reader);
  signal.addEventListener("abort", aborted, { once: true });
  let count = 0,
    size = 0,
    finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) fail("migration_deadline");
      if (done) {
        finished = true;
        break;
      }
      if (
        !(value instanceof Uint8Array) ||
        ++count > 10000 ||
        (size += value.length) > RESPONSE_LIMIT
      )
        fail("migration_response_limit");
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } catch {
      fail("migration_response_invalid");
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    if (!finished) cancel(reader);
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function sourceManifest(root) {
  const { DatabaseSync } = await import("node:sqlite");
  const sources = {};
  for (const [key, relative] of Object.entries(FILES)) {
    const location = path.join(root, relative),
      before = await fs.lstat(location);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 100000)
      fail("migration_source_unsafe");
    const text = await fs.readFile(location, "utf8"),
      after = await fs.lstat(location);
    if (
      !same(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail("migration_source_changed");
    sources[key] = { relative, sha256: hash(text), text };
  }
  const db = new DatabaseSync(":memory:");
  const read = () =>
    db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY type,name",
      )
      .all()
      .map((row) => ({ ...row }));
  try {
    db.exec(sources.base.text);
    const base = read();
    const creationBase = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY rowid",
      )
      .all();
    db.exec(sources.conservative.text);
    const conservative = read();
    db.exec(sources.authority.text);
    const authority = read();
    const creationAuthority = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY rowid",
      )
      .all()
      .filter((row) => !conservative.some((old) => old.name === row.name));
    db.exec(sources.freeze.text);
    const production = read();
    const creationFreeze = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY rowid",
      )
      .all()
      .filter((row) => !authority.some((old) => old.name === row.name));
    const freezeNames = new Set(
      production
        .filter((row) => !authority.some((old) => old.name === row.name))
        .map((row) => row.name),
    );
    const check = production.filter(
      (row) =>
        conservative.some((old) => old.name === row.name) ||
        freezeNames.has(row.name),
    );
    const manifests = { base, conservative, authority, production, check };
    if (
      production.length > 100 ||
      check.length > 64 ||
      freezeNames.size !== 12 ||
      creationBase.length +
        creationAuthority.length +
        creationFreeze.length * 2 +
        2 >
        102
    )
      fail("migration_source_manifest_invalid");
    const seeds = [
      sources.base.text.match(
        /^INSERT OR IGNORE INTO library_schema[^\n]+;/m,
      )?.[0],
      sources.base.text.match(
        /INSERT OR IGNORE INTO public_state[\s\S]*?;/,
      )?.[0],
    ];
    if (seeds.some((value) => !value))
      fail("migration_source_manifest_invalid");
    return {
      sources,
      manifests,
      creation: {
        base: creationBase,
        baseSeeds: seeds,
        authority: creationAuthority,
        freeze: creationFreeze,
      },
      hashes: Object.fromEntries(
        Object.entries(sources).map(([key, value]) => [key, value.sha256]),
      ),
    };
  } finally {
    db.close();
  }
}

class Journal {
  constructor(context, directory, runDirectory, receipt, state) {
    Object.assign(this, { context, directory, runDirectory, receipt, state });
  }
  async save() {
    await privateWrite(
      path.join(this.runDirectory, "receipt.json"),
      this.receipt,
    );
  }
  async stateSave() {
    await privateWrite(path.join(this.directory, "state.json"), this.state);
  }
  async dispatch(item) {
    if (this.receipt.requests.length >= this.receipt.budget.httpRequests)
      fail("migration_request_budget");
    const entry = {
      sequence: this.receipt.requests.length + 1,
      ...item,
      state: "pending",
      registeredAt: Date.now(),
    };
    if (entry.mutating) {
      if (this.state.operations.length >= 2048)
        fail("migration_state_conflict");
      if (entry.type === "ddl") {
        if (this.receipt.ddlStatements >= this.receipt.budget.ddlStatements)
          fail("migration_ddl_budget");
        this.receipt.ddlStatements++;
      }
      this.state.operations.push({ ...entry, runId: this.receipt.runId });
      await this.stateSave();
    }
    this.receipt.requests.push(entry);
    await privateWrite(
      path.join(this.runDirectory, `${entry.sequence}-intent.json`),
      entry,
      true,
    );
    await this.save();
    return entry;
  }
  async outcome(entry, state, detail = {}) {
    Object.assign(entry, { state, ...detail });
    if (entry.mutating) {
      const operation = this.state.operations.find(
        (item) =>
          item.runId === this.receipt.runId && item.sequence === entry.sequence,
      );
      Object.assign(operation, { state, ...detail });
      await this.stateSave();
    }
    await privateWrite(
      path.join(this.runDirectory, `${entry.sequence}-outcome.json`),
      { state, ...detail },
      true,
    );
    await this.save();
  }
}

class Transport {
  constructor(context, journal, fetchImpl, timeoutMs) {
    Object.assign(this, { context, journal, fetchImpl, timeoutMs });
  }
  classify(url, options) {
    const target = new URL(url),
      account = this.context.credentials.accountId;
    if (
      target.origin !== "https://api.cloudflare.com" ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      fail("migration_target_rejected");
    const prefix = `/client/v4/accounts/${account}`;
    let profile, resource;
    for (const scope of ["check", "production"]) {
      const id = this.context.identity.legacyDatabases[scope];
      if (
        [
          `${prefix}/d1/database/${id}`,
          `${prefix}/d1/database/${id}/query`,
        ].includes(target.pathname)
      ) {
        profile = scope;
        resource = "d1";
        break;
      }
      if (
        [
          `${prefix}/workers/scripts/${PROFILES[scope].name}/settings`,
          `${prefix}/workers/scripts/${PROFILES[scope].name}/subdomain`,
        ].includes(target.pathname)
      ) {
        profile = scope;
        resource = "worker";
        break;
      }
    }
    if (!profile) fail("migration_target_rejected");
    const query = target.pathname.endsWith("/query");
    const method = options.method || "GET";
    if (method !== (query ? "POST" : "GET")) fail("migration_method_rejected");
    let sql, params;
    if (query) {
      let body;
      try {
        body = JSON.parse(options.body);
      } catch {
        fail("migration_query_rejected");
      }
      if (
        !record(body) ||
        Object.keys(body).some((key) => !["sql", "params"].includes(key)) ||
        typeof body.sql !== "string" ||
        Buffer.byteLength(body.sql) > 100000 ||
        !Array.isArray(body.params) ||
        body.params.length > 100
      )
        fail("migration_query_rejected");
      ({ sql, params } = body);
    }
    return { target, profile, resource, method, sql, params };
  }
  async send(url, options = {}, metadata = {}) {
    const value = this.classify(url, options);
    const mutating =
      value.sql !== undefined &&
      !/^\s*(?:SELECT|WITH\s+\w+\s+AS\s*\(\s*SELECT)\b/i.test(value.sql);
    if (this.journal.receipt.action === "status" && mutating)
      fail("migration_status_read_only");
    const entry = await this.journal.dispatch({
      profile: value.profile,
      resource: value.resource,
      method: value.method,
      type: metadata.type || "query",
      operation: metadata.operation || "fixed-resource-query",
      mutating,
      ...(value.sql === undefined
        ? {}
        : {
            sqlSha256: hash(value.sql),
            paramsSha256: hash(JSON.stringify(value.params)),
          }),
      ...(metadata.object
        ? {
            object: metadata.object,
            definitionSha256: metadata.definitionSha256,
          }
        : {}),
    });
    const controller = new AbortController();
    let response, timer, diagnostic;
    try {
      const attempt = (async () => {
        response = await this.fetchImpl(value.target.href, {
          method: value.method,
          headers: {
            authorization: `Bearer ${this.context.credentials.token}`,
            "content-type": "application/json",
          },
          ...(value.sql === undefined
            ? {}
            : {
                body: JSON.stringify({ sql: value.sql, params: value.params }),
              }),
          redirect: "error",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          cancel(response.body);
          fail("migration_deadline");
        }
        if (
          response.redirected ||
          (response.url && response.url !== value.target.href) ||
          (response.status >= 300 && response.status < 400)
        ) {
          cancel(response.body);
          fail("migration_redirect_rejected");
        }
        if (response.status === 404 && value.resource === "worker") {
          cancel(response.body);
          return { absent: true };
        }
        const body = await boundedJson(response, controller.signal);
        diagnostic = providerObservation(body);
        if (
          metadata.expectFrozen &&
          matchesFrozenRejection(response.status, body)
        )
          return { frozen: true };
        if (!response.ok || body?.success !== true)
          fail("migration_remote_rejected");
        if (
          value.sql !== undefined &&
          (!Array.isArray(body.result) ||
            body.result.length !== 1 ||
            body.result[0]?.success !== true ||
            !Array.isArray(body.result[0]?.results))
        )
          fail("migration_response_invalid");
        return body;
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          cancel(response?.body);
          reject(new MigrationError("migration_deadline"));
        }, this.timeoutMs);
      });
      const body = await Promise.race([attempt, deadline]);
      await this.journal.outcome(
        entry,
        body.frozen ? "rejected-proven" : "observed",
        {
          httpStatus: response.status,
          ...(body.frozen ? { frozen: true } : {}),
          ...(body.absent ? { absent: true } : {}),
        },
      );
      if (body.absent) return new Response(null, { status: 404 });
      if (body.frozen)
        return Response.json({
          success: true,
          result: [{ success: true, results: [{ frozen: 1 }] }],
        });
      return Response.json(body);
    } catch (error) {
      controller.abort();
      cancel(response?.body);
      await this.journal.outcome(entry, mutating ? "unknown" : "failed", {
        code: safeCode(error),
        ...(response ? { httpStatus: response.status } : {}),
        ...(diagnostic ? { provider: diagnostic } : {}),
      });
      throw new MigrationError(
        mutating ? "migration_write_outcome_unknown" : safeCode(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  suffix(profile) {
    return `https://api.cloudflare.com/client/v4/accounts/${this.context.credentials.accountId}/d1/database/${this.context.identity.legacyDatabases[profile]}`;
  }
  async identity(profile) {
    const body = await (
      await this.send(
        this.suffix(profile),
        {},
        { operation: "verify-database-identity" },
      )
    ).json();
    if (
      body.result?.uuid !== this.context.identity.legacyDatabases[profile] ||
      body.result?.name !==
        this.context.resources.profiles[profile].databaseName
    )
      fail("migration_identity_mismatch");
  }
  async query(profile, sql, params = [], metadata = {}) {
    const body = await (
      await this.send(
        `${this.suffix(profile)}/query`,
        { method: "POST", body: JSON.stringify({ sql, params }) },
        metadata,
      )
    ).json();
    return body.result[0].results;
  }
  async schema(profile) {
    const rows = await this.query(
      profile,
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' AND name NOT IN ('_cf_KV','d1_migrations') ORDER BY type,name LIMIT 129",
      [],
      { operation: "verify-fixed-schema" },
    );
    if (
      rows.length > 128 ||
      rows.some(
        (row) =>
          !record(row) ||
          !["table", "index", "trigger", "view"].includes(row.type) ||
          typeof row.name !== "string" ||
          typeof row.sql !== "string",
      )
    )
      fail("migration_schema_invalid");
    return rows;
  }
}

const schemaMap = (rows) => new Map(rows.map((row) => [row.name, row]));
const equalDefinition = (actual, expected) =>
  actual.type === expected.type &&
  actual.name === expected.name &&
  actual.tbl_name === expected.tbl_name &&
  normalizeSql(actual.sql) === normalizeSql(expected.sql);
function checkSubset(actual, expected, alternatives = []) {
  const allowed = schemaMap(expected);
  for (const row of actual) {
    const primary = allowed.get(row.name);
    if (
      !primary ||
      (!equalDefinition(row, primary) &&
        !alternatives.some((other) => equalDefinition(row, other)))
    )
      fail("migration_schema_conflict");
  }
}
async function closedAuth(transport, profile) {
  const rows = await transport.query(
    profile,
    "SELECT scope,COUNT(*) AS count,COALESCE(SUM(enabled),0) AS enabled FROM auth_config GROUP BY scope ORDER BY scope LIMIT 3",
    [],
    { operation: "verify-auth-closed" },
  );
  if (
    rows.length > 1 ||
    rows.some(
      (row) => row.scope !== profile || row.count !== 1 || row.enabled !== 0,
    )
  )
    fail("migration_auth_not_closed");
}
async function marker(transport, context, profile, state, create) {
  const read = () =>
    transport.query(
      profile,
      "SELECT id,authority_id,account_id,bucket,freeze_id,frozen_at FROM shelf_storage_legacy_freeze WHERE id=1 LIMIT 2",
      [],
      { operation: "verify-freeze-marker" },
    );
  let rows = await read();
  if (!rows.length && create) {
    await transport.query(
      profile,
      "INSERT INTO shelf_storage_legacy_freeze(id,authority_id,account_id,bucket,freeze_id,frozen_at) VALUES(1,?,?,?,?,?)",
      [
        context.identity.authorityId,
        context.identity.accountId,
        context.identity.bucket,
        `migration-${profile}-${state.migrationId}`,
        Date.now(),
      ],
      {
        operation: "seed-freeze-marker",
        object: "shelf_storage_legacy_freeze",
      },
    );
    rows = await read();
  }
  if (
    rows.length !== 1 ||
    rows[0].authority_id !== context.identity.authorityId ||
    rows[0].account_id !== context.identity.accountId ||
    rows[0].bucket !== context.identity.bucket ||
    !RUN_ID.test(rows[0].freeze_id || "") ||
    !integer(rows[0].frozen_at) ||
    rows[0].frozen_at > Date.now()
  )
    fail("migration_freeze_unproven");
  return rows[0];
}
async function freshInventory(context, journal, transport, environment) {
  const { runStoragePreflight } = await import("./storage-preflight.mjs");
  const summary = await runStoragePreflight({
    root: context.root,
    environment,
    fetchImpl: (url, options) =>
      transport.send(url, options, { operation: "fresh-preflight" }),
  });
  const relative = summary.privateReceipt;
  if (
    typeof relative !== "string" ||
    !/^\.local\/cf03\/storage-preflight-[a-f0-9-]{36}\.json$/.test(relative)
  )
    fail("migration_preflight_invalid");
  const full = await privateRead(path.join(context.root, relative));
  if (
    full.status !== "observed" ||
    full.accountId !== context.identity.accountId ||
    JSON.stringify(full.resources) !== JSON.stringify(context.resources) ||
    full.local?.legacyLocalEmpty !== true ||
    Object.values(full.databases).some(
      (value) =>
        value.reservations?.some((row) => row.count !== 0) ||
        value.registry?.some((row) => row.count !== 0) ||
        value.auth?.some((row) => row.enabledCount !== 0),
    ) ||
    (full.workers.check?.state === "present" &&
      (full.workers.check.workersDev !== false ||
        full.workers.check.previews !== false))
  )
    fail("migration_inventory_not_closed_empty");
  journal.receipt.preflight = {
    privateReceipt: relative,
    sha256: hash(JSON.stringify(full)),
    observedAt: full.observedAt,
  };
  if (
    full.databases.production.emptySourceProven === true &&
    !journal.state.productionEmptyProof
  ) {
    journal.state.productionEmptyProof = {
      identitySha256: hash(JSON.stringify(context.identity)),
      privateReceipt: relative,
      sha256: hash(JSON.stringify(full)),
      observedAt: full.observedAt,
    };
    await journal.stateSave();
  }
  if (
    !journal.state.productionEmptyProof ||
    journal.state.productionEmptyProof.identitySha256 !==
      hash(JSON.stringify(context.identity))
  )
    fail("migration_original_empty_source_unproven");
  await journal.save();
  return full;
}
async function schemaFreeze(
  context,
  journal,
  transport,
  manifest,
  environment,
) {
  await freshInventory(context, journal, transport, environment);
  for (const profile of ["check", "production"])
    await transport.identity(profile);
  const initial = {};
  for (const profile of ["check", "production"])
    initial[profile] = await transport.schema(profile);
  checkSubset(initial.check, manifest.manifests.check, manifest.manifests.base);
  checkSubset(
    initial.production,
    manifest.manifests.production,
    manifest.manifests.base,
  );
  if (!initial.check.some((row) => row.name === "upload_reservations"))
    fail("migration_check_source_missing");
  const applyMissing = async (profile, definitions, group) => {
    if (!journal.receipt.ddlGroups.includes(group))
      journal.receipt.ddlGroups.push(group);
    if (journal.receipt.ddlGroups.length > journal.receipt.budget.ddlFileGroups)
      fail("migration_ddl_budget");
    const existing = schemaMap(initial[profile]);
    for (const definition of definitions) {
      if (existing.has(definition.name)) continue;
      await transport.query(profile, definition.sql, [], {
        type: "ddl",
        operation: group,
        object: definition.name,
        definitionSha256: hash(normalizeSql(definition.sql)),
      });
      existing.set(definition.name, definition);
      initial[profile].push(definition);
    }
  };
  // Dependency order comes from sqlite_master rowid, not alphabetical schema order.
  // The manifest attaches the original fixed-file creation order below.
  await applyMissing(
    "production",
    manifest.creation.base,
    "production-base-schema",
  );
  // A lost seed response is resolved by row readback, never replayed merely
  // because INSERT OR IGNORE happens to be idempotent.
  const schemaSeeds = await transport.query(
    "production",
    "SELECT version,applied_at FROM library_schema ORDER BY version LIMIT 2",
    [],
    { operation: "read-production-schema-seed" },
  );
  if (
    schemaSeeds.length > 1 ||
    schemaSeeds.some(
      (row) =>
        row.version !== 1 ||
        !integer(row.applied_at) ||
        row.applied_at > Date.now(),
    )
  )
    fail("migration_schema_conflict");
  if (!schemaSeeds.length)
    await transport.query("production", manifest.creation.baseSeeds[0], [], {
      operation: "production-base-seed",
    });
  const publicSeeds = await transport.query(
    "production",
    "SELECT scope,revision,base_revision,updated_at FROM public_state ORDER BY scope LIMIT 3",
    [],
    { operation: "read-production-public-seeds" },
  );
  if (
    publicSeeds.length > 2 ||
    new Set(publicSeeds.map((row) => row.scope)).size !== publicSeeds.length ||
    publicSeeds.some(
      (row) =>
        !["check", "production"].includes(row.scope) ||
        row.revision !== 0 ||
        row.base_revision !== null ||
        row.updated_at !== 0,
    )
  )
    fail("migration_schema_conflict");
  if (publicSeeds.length !== 2)
    await transport.query("production", manifest.creation.baseSeeds[1], [], {
      operation: "production-base-seed",
    });
  await applyMissing(
    "production",
    manifest.creation.authority,
    "production-authority-schema",
  );
  await applyMissing(
    "production",
    manifest.creation.freeze,
    "production-freeze-schema",
  );
  await applyMissing("check", manifest.creation.freeze, "check-freeze-schema");
  const markers = {};
  for (const profile of ["check", "production"]) {
    // Exact trigger definitions are observed before the single INSERT activates them.
    const current = await transport.schema(profile);
    const expected =
      profile === "check"
        ? manifest.manifests.check
        : manifest.manifests.production;
    checkSubset(current, expected, manifest.manifests.base);
    for (const definition of manifest.creation.freeze) {
      const actual = current.find((row) => row.name === definition.name);
      if (!actual || !equalDefinition(actual, definition))
        fail("migration_freeze_schema_incomplete");
    }
    markers[profile] = await marker(
      transport,
      context,
      profile,
      journal.state,
      true,
    );
  }
  // Replace only the exact known base reserve trigger, AFTER both freezes apply.
  const expectedReserve = manifest.manifests.conservative.find(
    (row) => row.name === "reserve_upload",
  );
  const beforeReserve = (await transport.schema("production")).find(
    (row) => row.name === "reserve_upload",
  );
  if (!beforeReserve || !equalDefinition(beforeReserve, expectedReserve)) {
    if (
      beforeReserve &&
      !equalDefinition(
        beforeReserve,
        manifest.manifests.base.find((row) => row.name === "reserve_upload"),
      )
    )
      fail("migration_schema_conflict");
    journal.receipt.ddlGroups.push("production-conservative-002");
    if (beforeReserve)
      await transport.query("production", "DROP TRIGGER reserve_upload", [], {
        type: "ddl",
        operation: "production-conservative-002",
        object: "reserve_upload",
      });
    await transport.query("production", expectedReserve.sql, [], {
      type: "ddl",
      operation: "production-conservative-002",
      object: expectedReserve.name,
      definitionSha256: hash(normalizeSql(expectedReserve.sql)),
    });
  }
  for (const profile of ["check", "production"]) {
    const final = await transport.schema(profile),
      expected = manifest.manifests[profile];
    checkSubset(final, expected);
    if (final.length !== expected.length) fail("migration_schema_incomplete");
    await closedAuth(transport, profile);
    const rejected = await transport.query(
      profile,
      FREEZE_PROBE_SQL,
      [
        `freeze-proof-${journal.receipt.runId}`,
        profile,
        "migration_freeze_probe",
        "migration_freeze_probe",
        `${profile === "production" ? "books" : "cf03-check"}/migration-freeze-probe`,
        "0".repeat(64),
        Date.now(),
        Date.now(),
      ],
      { operation: "prove-legacy-reservation-rejected", expectFrozen: true },
    );
    if (rejected.length !== 1 || rejected[0].frozen !== 1)
      fail("migration_freeze_rejection_unproven");
    const absent = await transport.query(
      profile,
      "SELECT COUNT(*) AS probe_count,(SELECT COUNT(*) FROM upload_reservations) AS reservations,(SELECT COUNT(*) FROM file_registry) AS registry FROM upload_reservations WHERE reservation_id=?",
      [`freeze-proof-${journal.receipt.runId}`],
      { operation: "verify-rejected-probe-absent" },
    );
    if (
      absent.length !== 1 ||
      absent[0].probe_count !== 0 ||
      absent[0].reservations !== 0 ||
      absent[0].registry !== 0
    )
      fail("migration_inventory_changed_requires_budget_review");
    (journal.receipt.freezeRejectionReadback ||= {})[profile] = absent[0];
    await transport.identity(profile);
  }
  journal.state.schemaFrozen = {
    sourceHashes: manifest.hashes,
    markers,
    verifiedAt: Date.now(),
  };
  await journal.stateSave();
  return {
    phase: "migration_required",
    databaseWriteFreezeProven: true,
    cloudWriteFreezeProven: false,
    uploadAllowed: false,
  };
}

async function openRun(context, action, runId, manifest) {
  const directory = await privateDirectories(
    context.root,
    ".local/cf03/storage-migration",
  );
  let lock;
  const lockPath = path.join(directory, "operator.lock");
  const runDirectory = path.join(directory, runId);
  try {
    await fs.mkdir(runDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") fail("migration_run_exists");
    throw error;
  }
  const receipt = {
    schemaVersion: 1,
    runId,
    action,
    status: "planned",
    startedAt: Date.now(),
    identitySha256: hash(JSON.stringify(context.identity)),
    budget: MIGRATION_BUDGETS[action],
    requests: [],
    ddlStatements: 0,
    ddlGroups: [],
    cloudWriteFreezeProven: false,
    uploadAllowed: false,
  };
  await privateWrite(path.join(runDirectory, "receipt.json"), receipt, true);
  {
    // Serialize *all* lock acquisition and stale-lock replacement. A check then
    // unlink alone lets two recoverers remove each other's newly acquired lock.
    // A crash during this short section leaves a fail-closed local guard; this
    // operator never guesses that such a guard is safe to remove.
    const acquirePath = path.join(directory, "operator-acquire.lock");
    try {
      await fs.mkdir(acquirePath, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") fail("migration_operator_busy");
      throw error;
    }
    try {
      try {
        lock = await fs.open(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const old = await privateRead(lockPath);
        if (!integer(old.pid) || old.pid < 1) fail("migration_lock_unsafe");
        let alive = true;
        try {
          process.kill(old.pid, 0);
        } catch (caught) {
          if (caught.code === "ESRCH") alive = false;
          else fail("migration_operator_busy");
        }
        if (alive) fail("migration_operator_busy");
        await privateWrite(
          path.join(runDirectory, "previous-lock.json"),
          old,
          true,
        );
        await fs.unlink(lockPath);
        lock = await fs.open(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      }
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, runId, createdAt: Date.now() }) +
          "\n",
      );
      await lock.sync();
    } finally {
      await fs.rmdir(acquirePath);
    }
  }
  try {
    let state = await privateRead(path.join(directory, "state.json"), {
      optional: true,
    });
    if (state === null) {
      state = {
        schemaVersion: 1,
        migrationId: randomUUID(),
        identitySha256: receipt.identitySha256,
        sourceHashes: manifest.hashes,
        operations: [],
        productionEmptyProof: null,
        schemaFrozen: null,
        snapshotsSha256: null,
        recovery: null,
      };
      if (action !== "status") {
        await privateWrite(
          path.join(directory, "manifest.json"),
          {
            manifests: manifest.manifests,
            creation: manifest.creation,
            hashes: manifest.hashes,
          },
          true,
        );
        await privateWrite(path.join(directory, "state.json"), state, true);
      }
    }
    if (
      state.schemaVersion !== 1 ||
      state.identitySha256 !== receipt.identitySha256 ||
      !Array.isArray(state.operations) ||
      state.operations.length > 2048
    )
      fail("migration_state_conflict");
    if (
      JSON.stringify(state.sourceHashes) !== JSON.stringify(manifest.hashes) &&
      action !== "status"
    )
      fail("migration_source_changed");
    const journal = new Journal(
      context,
      directory,
      runDirectory,
      receipt,
      state,
    );
    return {
      journal,
      close: async () => {
        if (lock) {
          await lock.close();
          await fs.unlink(lockPath);
        }
      },
    };
  } catch (error) {
    if (lock) {
      await lock.close();
      await fs.unlink(lockPath);
    }
    throw error;
  }
}
function unresolved(state) {
  return state.operations.filter((operation) =>
    ["pending", "unknown"].includes(operation.state),
  );
}
function checkRecovery(state) {
  const pending = unresolved(state);
  if (
    pending.length &&
    state.recovery?.operationsSha256 !== hash(JSON.stringify(pending))
  )
    fail("migration_status_required_before_resume");
}
async function verifySchemaFrozen(context, journal, transport, manifest) {
  if (!journal.state.schemaFrozen) fail("migration_schema_freeze_required");
  for (const profile of ["check", "production"]) {
    await transport.identity(profile);
    const rows = await transport.schema(profile),
      expected = manifest.manifests[profile];
    checkSubset(rows, expected);
    if (rows.length !== expected.length) fail("migration_schema_incomplete");
    await marker(transport, context, profile, journal.state, false);
    await closedAuth(transport, profile);
  }
}
async function importFrozen(
  context,
  journal,
  transport,
  manifest,
  environment,
) {
  const { localInventory } = await import("./storage-preflight.mjs");
  const checkLocal = async () => {
    const inventory = await localInventory(context.root, {
      ...context.fileEnvironment,
      ...environment,
    });
    if (inventory.legacyLocalEmpty !== true)
      fail("migration_inventory_not_closed_empty");
    journal.receipt.localBeforeImport = {
      observedAt: Date.now(),
      ...inventory,
    };
    await journal.save();
  };
  // Reject changed configured local sources before even the cloud readback,
  // then check again immediately before the first possible cloud write.
  await checkLocal();
  await verifySchemaFrozen(context, journal, transport, manifest);
  const { RemoteStorageAuthority } =
    await import("../server/remote-storage-authority.mjs");
  const remote = new RemoteStorageAuthority({
    identity: context.identity,
    credentials: context.credentials,
    resource: context.resources.profiles.production,
    requestLimit: 72,
    beforeRequest: async (intent) => {
      const entries = (journal.receipt.adapterIntents ||= []);
      entries.push(intent);
      await journal.save();
    },
    fetchImpl: (url, options) =>
      transport.send(url, options, { operation: "adapter-import" }),
  });
  // initialize is idempotent; it never replaces an existing authority identity.
  await checkLocal();
  await remote.initialize(context.identity);
  const snapshotPath = path.join(journal.directory, "snapshots.json");
  let snapshots = await privateRead(snapshotPath, { optional: true });
  if (snapshots === null) {
    snapshots = await remote.readFrozenSnapshots(context.identity);
    if (
      snapshots.some(
        (snapshot) => snapshot.reservations.length || snapshot.registry.length,
      )
    )
      fail("migration_inventory_changed_requires_budget_review");
    await privateWrite(snapshotPath, snapshots, true);
    journal.state.snapshotsSha256 = hash(JSON.stringify(snapshots));
    await journal.stateSave();
  }
  if (journal.state.snapshotsSha256 !== hash(JSON.stringify(snapshots)))
    fail("migration_snapshot_conflict");
  const receipt = await remote.migrateFrozen(context.identity, snapshots);
  if (
    receipt.cloudWriteFreezeProven !== false ||
    receipt.databaseWriteFreezeProven !== true
  )
    fail("migration_import_did_not_remain_closed");
  const status = await remote.inspect(context.identity);
  if (status.phase !== "imported")
    fail("migration_import_did_not_remain_closed");
  await privateWrite(
    path.join(journal.runDirectory, "import-receipt.json"),
    receipt,
    true,
  );
  journal.state.imported = {
    migrationHash: receipt.migrationHash,
    receiptSha256: hash(JSON.stringify(receipt)),
    verifiedAt: Date.now(),
  };
  await journal.stateSave();
  return {
    ...status,
    databaseWriteFreezeProven: true,
    cloudWriteFreezeProven: false,
    uploadAllowed: false,
    readyBlockedBy: "migration_write_closure_unproven",
  };
}
async function statusReadback(context, journal, transport, manifest) {
  const status = {
    phase: "schema_missing",
    databases: {},
    cloudWriteFreezeProven: false,
    uploadAllowed: false,
    recoveryObserved: false,
    sourceHashesMatch:
      JSON.stringify(journal.state.sourceHashes) ===
      JSON.stringify(manifest.hashes),
  };
  for (const profile of ["check", "production"]) {
    await transport.identity(profile);
    const rows = await transport.schema(profile);
    checkSubset(rows, manifest.manifests[profile], manifest.manifests.base);
    status.databases[profile] = {
      schemaObjects: rows.length,
      schemaSha256: hash(JSON.stringify(rows)),
      complete: rows.length === manifest.manifests[profile].length,
    };
    if (rows.some((row) => row.name === "auth_config"))
      await closedAuth(transport, profile);
    if (rows.some((row) => row.name === "shelf_storage_legacy_freeze")) {
      const markers = await transport.query(
        profile,
        "SELECT id,authority_id,account_id,bucket,freeze_id,frozen_at FROM shelf_storage_legacy_freeze WHERE id=1 LIMIT 2",
        [],
        { operation: "status-freeze-marker" },
      );
      if (
        markers.length > 1 ||
        markers.some(
          (value) =>
            value.authority_id !== context.identity.authorityId ||
            value.account_id !== context.identity.accountId ||
            value.bucket !== context.identity.bucket,
        )
      )
        fail("migration_identity_mismatch");
      status.databases[profile].freezeMarkerPresent = markers.length === 1;
    }
    if (
      profile === "production" &&
      rows.some((row) => row.name === "shelf_storage_authority")
    ) {
      const authority = await transport.query(
        profile,
        "SELECT identity_json,phase,committed_bytes,reserved_bytes,migration_hash FROM shelf_storage_authority WHERE id=1 LIMIT 2",
        [],
        { operation: "status-authority" },
      );
      if (
        authority.length > 1 ||
        authority.some(
          (value) => value.identity_json !== JSON.stringify(context.identity),
        )
      )
        fail("migration_identity_mismatch");
      status.phase = authority[0]?.phase || "uninitialized";
      if (authority[0]) {
        status.committedBytes = authority[0].committed_bytes;
        status.reservedBytes = authority[0].reserved_bytes;
        status.migrationHash = authority[0].migration_hash;
      }
    }
  }
  const pending = unresolved(journal.state);
  const probes = pending.filter(
    (operation) => operation.operation === "prove-legacy-reservation-rejected",
  );
  if (probes.length > 8) fail("migration_probe_diagnostic_limit");
  if (probes.length) {
    const observations = [];
    for (const operation of probes) {
      if (
        !RUN_ID.test(operation.runId || "") ||
        !["check", "production"].includes(operation.profile) ||
        operation.sqlSha256 !== hash(FREEZE_PROBE_SQL) ||
        operation.mutating !== true
      )
        fail("migration_state_conflict");
      const rows = await transport.query(
        operation.profile,
        "SELECT COUNT(*) AS count FROM upload_reservations WHERE reservation_id=?",
        [`freeze-proof-${operation.runId}`],
        { operation: "status-exact-negative-probe-count" },
      );
      if (rows.length !== 1 || !integer(rows[0].count) || rows[0].count > 1)
        fail("migration_response_invalid");
      observations.push({
        runId: operation.runId,
        sequence: operation.sequence,
        profile: operation.profile,
        exactReservationCount: rows[0].count,
        atomicRejectionProven: false,
      });
    }
    const totals = {};
    for (const profile of ["check", "production"]) {
      const rows = await transport.query(
        profile,
        "SELECT (SELECT COUNT(*) FROM upload_reservations) AS reservations,(SELECT COUNT(*) FROM file_registry) AS registry",
        [],
        { operation: "status-legacy-storage-total-counts" },
      );
      if (
        rows.length !== 1 ||
        !integer(rows[0].reservations) ||
        !integer(rows[0].registry)
      )
        fail("migration_response_invalid");
      totals[profile] = rows[0];
    }
    // This is an observation of current presence, not proof of the old request's
    // outcome. Preserve every unknown operation and never mark it rejected.
    status.negativeProbeReadback = {
      observations,
      totals,
      atomicRejectionProven: false,
    };
    journal.receipt.negativeProbeReadback = status.negativeProbeReadback;
    await journal.save();
    if (
      observations.some((value) => value.exactReservationCount !== 0) ||
      Object.values(totals).some(
        (value) => value.reservations !== 0 || value.registry !== 0,
      )
    ) {
      journal.state.recovery = null;
      await journal.stateSave();
      status.recoveryBlockedBy =
        "migration_inventory_changed_requires_budget_review";
      return status;
    }
  }
  if (pending.length) {
    const latest = Math.max(
      ...pending.map((operation) => operation.registeredAt),
    );
    if (!integer(latest) || Date.now() - latest < 31_000) {
      status.recoveryBlockedBy = "migration_unknown_write_quiescence_pending";
      status.retryStatusAfterMs = integer(latest)
        ? Math.max(0, 31_000 - (Date.now() - latest))
        : null;
    } else {
      // Two independent post-deadline schema observations resolve DDL presence.
      // Import resumes only through the adapter's immutable staging/readback checks.
      for (const profile of ["check", "production"]) {
        const again = await transport.schema(profile);
        if (
          hash(JSON.stringify(again)) !== status.databases[profile].schemaSha256
        )
          fail("migration_status_changed");
      }
      journal.state.recovery = {
        operationsSha256: hash(JSON.stringify(pending)),
        observedAt: Date.now(),
        statusRunId: journal.receipt.runId,
        databaseSchemaHashes: Object.fromEntries(
          Object.entries(status.databases).map(([profile, value]) => [
            profile,
            value.schemaSha256,
          ]),
        ),
      };
      await journal.stateSave();
      status.recoveryObserved = true;
    }
  }
  return status;
}

export async function runStorageMigration({
  action = "status",
  execute = false,
  runId = randomUUID(),
  root = PROJECT_ROOT,
  environment = process.env,
  fetchImpl = fetch,
  requestTimeoutMs = 30000,
} = {}) {
  if (
    !ACTIONS.has(action) ||
    typeof execute !== "boolean" ||
    !RUN_ID.test(runId) ||
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30000
  )
    fail("migration_invalid_arguments");
  const preview = {
    status: "preview",
    action,
    budget: MIGRATION_BUDGETS[action],
    fixedDdlFileGroups: 5,
    readyImplemented: false,
    cloudWriteFreezeProven: false,
    uploadAllowed: false,
  };
  if (!execute) return preview;
  if (action === "ready") fail("migration_write_closure_unproven");
  const context = await loadMigrationContext({ root, environment });
  const manifest = await sourceManifest(context.root);
  const run = await openRun(context, action, runId, manifest),
    { journal } = run;
  const transport = new Transport(
    context,
    journal,
    fetchImpl,
    requestTimeoutMs,
  );
  try {
    if (action !== "status") checkRecovery(journal.state);
    const outcome =
      action === "schema-freeze"
        ? await schemaFreeze(context, journal, transport, manifest, environment)
        : action === "import"
          ? await importFrozen(
              context,
              journal,
              transport,
              manifest,
              environment,
            )
          : await statusReadback(context, journal, transport, manifest);
    journal.receipt.status = "observed";
    journal.receipt.outcome = outcome;
    await journal.save();
    return {
      status: "observed",
      action,
      phase: outcome.phase,
      httpRequests: journal.receipt.requests.length,
      ddlStatements: journal.receipt.ddlStatements,
      privateReceipt: path.relative(
        context.root,
        path.join(journal.runDirectory, "receipt.json"),
      ),
      cloudWriteFreezeProven: false,
      uploadAllowed: false,
      ...(outcome.readyBlockedBy
        ? { readyBlockedBy: outcome.readyBlockedBy }
        : {}),
      ...(outcome.recoveryBlockedBy
        ? {
            recoveryBlockedBy: outcome.recoveryBlockedBy,
            retryStatusAfterMs: outcome.retryStatusAfterMs,
          }
        : {}),
      ...(outcome.recoveryObserved ? { recoveryObserved: true } : {}),
    };
  } catch (error) {
    journal.receipt.status = "stopped";
    journal.receipt.code = safeCode(error);
    await journal.save();
    throw new MigrationError(journal.receipt.code);
  } finally {
    await run.close();
  }
}
export function parseMigrationArgs(args) {
  const result = { action: "status" };
  const seen = new Set();
  if (args[0] && !args[0].startsWith("--"))
    ((result.action = args[0]), (args = args.slice(1)));
  if (!ACTIONS.has(result.action)) fail("migration_invalid_arguments");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) fail("migration_invalid_arguments");
    seen.add(arg);
    if (arg === "--execute") result.execute = true;
    else if (arg === "--run-id") {
      result.runId = args[++index];
      if (!RUN_ID.test(result.runId || "")) fail("migration_invalid_arguments");
    } else fail("migration_invalid_arguments");
  }
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        await runStorageMigration(parseMigrationArgs(process.argv.slice(2))),
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ status: "stopped", code: safeCode(error) }));
    process.exitCode = 1;
  }
}
