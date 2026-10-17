// One-shot, fixed-target, read-only check preflight. No credential discovery or CLI.
import { readFileSync, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { CHECK, samplerEnvironment } from "./cf-cpu-sampler.mjs";
import {
  validateDeployConfig,
  validateRemoteBindings,
} from "./cf-api-deploy.mjs";
import {
  validateSamplerObservationSettings,
  SAMPLER_SCHEMA_HASH,
  SAMPLER_TABLES,
} from "./cf-cpu-sampler-manager.mjs";
import { privatePath } from "./cf-library-data.mjs";

const integer = (n) => Number.isSafeInteger(n) && n >= 0;
export class PreflightError extends Error {
  constructor(code) {
    super(`Check read-only preflight stopped (${code}).`);
    this.code = code;
  }
}
const insist = (ok, code) => {
  if (!ok) throw new PreflightError(code);
};
const safeError = (error) =>
  error instanceof PreflightError ? error.code : "preflight_outcome_unknown";
const normalizeSql = (s) =>
  (typeof s === "string" ? s : "")
    .match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+|[^\s'\"]+/g)
    ?.map((t) => (/^\s+$/.test(t) ? " " : t))
    .join("")
    .trim()
    .replace(/;$/, "") ?? "";
function contract() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("../cloudflare/library/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(
      readFileSync(
        new URL(
          "../cloudflare/library/migrations/002-conservative-storage.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    return db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all()
      .map((r) => ({
        type: r.type,
        name: r.name,
        table: r.tbl_name,
        sql: normalizeSql(r.sql),
      }));
  } finally {
    db.close();
  }
}
const objects = contract();
insist(
  createHash("sha256").update(JSON.stringify(objects)).digest("hex") ===
    SAMPLER_SCHEMA_HASH,
  "local_schema_contract_mismatch",
);
export const PREFLIGHT_LIMITS = Object.freeze({
  management: 8,
  d1: 2,
  rowsRead: 20000,
  rowsWritten: 0,
  tableRows: 1024,
  schemaObjects: 128,
  responseBytes: 1048576,
  rawBytes: 8388608,
  timeoutMs: 30000,
});
const statement = (sql, params = []) => ({ sql, params });
// LIMIT is INSIDE every count/filter/aggregate: a saturated probe is unknown.
// Schema bounds its source before filtering; only project SQL is returned.
// Source saturation rejects the result, so extra project indexes/triggers cannot hide.
// Platform objects count toward the source bound, but are not exposed or compared.
const batch = [
  statement(
    `WITH bounded AS MATERIALIZED (SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 128)
SELECT type,name,tbl_name,sql,(SELECT count(*) FROM bounded) AS scanned FROM bounded
WHERE tbl_name IN (${SAMPLER_TABLES.map(() => "?").join(",")}) AND name NOT LIKE 'sqlite_%' ORDER BY type,name`,
    [...SAMPLER_TABLES],
  ),
  statement(
    `SELECT count(*) AS n, COALESCE(sum(CASE WHEN scope='check' AND origin=? AND scheme='owner-access-key-v1' THEN 0 ELSE 1 END),0) AS invalid, COALESCE(sum(enabled),0) AS enabled, min(generation) AS generation FROM (SELECT scope,origin,scheme,generation,enabled FROM auth_config LIMIT 1024)`,
    [CHECK.origin],
  ),
  statement(
    "SELECT count(*) AS n, COALESCE(sum(CASE WHEN scope='check' AND revoked=0 THEN 1 ELSE 0 END),0) AS active, COALESCE(sum(CASE WHEN scope='check' THEN 0 ELSE 1 END),0) AS invalid FROM (SELECT scope,revoked FROM sessions LIMIT 1024)",
  ),
  statement(
    "SELECT version FROM (SELECT version FROM library_schema LIMIT 1024) ORDER BY version",
  ),
  ...SAMPLER_TABLES.map((name) =>
    statement(`SELECT count(*) AS n FROM (SELECT 1 FROM "${name}" LIMIT 1024)`),
  ),
];
export function preflightPreview() {
  return {
    schemaVersion: 1,
    scope: "check",
    readOnly: true,
    limits: { ...PREFLIGHT_LIMITS },
    schemaHash: SAMPLER_SCHEMA_HASH,
    tables: [...SAMPLER_TABLES],
    sql: structuredClone(batch),
    requests: [
      { label: "settings-before", method: "GET", resource: "check/settings" },
      { label: "tails-before", method: "GET", resource: "check/tails" },
      { label: "deployments", method: "GET", resource: "check/deployments" },
      { label: "database-identity", method: "GET", resource: "check/database" },
      {
        label: "database-query",
        method: "POST",
        resource: "check/database/query",
      },
      { label: "entry", method: "GET", resource: "check/subdomain" },
      { label: "settings-after", method: "GET", resource: "check/settings" },
      { label: "tails-after", method: "GET", resource: "check/tails" },
    ],
  };
}
// Extract known meta independently of success/projection; never discard partial costs.
function queryMeta(value) {
  const items = Array.isArray(value?.result) ? value.result : [];
  const entries = items.map((item, index) => ({
    index,
    success: item?.success === true,
    rowsRead: integer(item?.meta?.rows_read) ? item.meta.rows_read : null,
    rowsWritten: integer(item?.meta?.rows_written)
      ? item.meta.rows_written
      : null,
  }));
  const complete =
    entries.length === batch.length &&
    entries.every((e) => e.rowsRead !== null && e.rowsWritten !== null);
  const rowsRead = entries.reduce((sum, e) => sum + (e.rowsRead ?? 0), 0),
    rowsWritten = entries.reduce((sum, e) => sum + (e.rowsWritten ?? 0), 0);
  return {
    entries,
    complete: complete && integer(rowsRead) && integer(rowsWritten),
    rowsRead: integer(rowsRead) ? rowsRead : null,
    rowsWritten: integer(rowsWritten) ? rowsWritten : null,
  };
}
function databaseProjection(value) {
  insist(
    Array.isArray(value) &&
      value.length === batch.length &&
      value.every((x) => x?.success === true && Array.isArray(x.results)),
    "d1_result_invalid",
  );
  const rows = value.map((x) => x.results);
  insist(
    rows[0].length > 0 &&
      rows[0].every(
        (r) => integer(r.scanned) && r.scanned < PREFLIGHT_LIMITS.schemaObjects,
      ),
    "schema_probe_truncated",
  );
  const actual = rows[0].map((r) => ({
    type: r.type,
    name: r.name,
    table: r.tbl_name,
    sql: normalizeSql(r.sql),
  }));
  insist(JSON.stringify(actual) === JSON.stringify(objects), "schema_drift");
  const counts = {};
  for (let i = 0; i < SAMPLER_TABLES.length; i++) {
    const probe = rows[i + 4];
    insist(
      probe.length === 1 && integer(probe[0].n) && probe[0].n <= 1024,
      "cardinality_invalid",
    );
    counts[SAMPLER_TABLES[i]] = probe[0].n;
    insist(probe[0].n < 1024, "cardinality_truncated");
  }
  insist(rows[1].length === 1 && rows[2].length === 1, "auth_result_invalid");
  const auth = rows[1][0],
    sessions = rows[2][0];
  insist(
    auth.n === counts.auth_config &&
      auth.n < 1024 &&
      auth.n === 1 &&
      auth.invalid === 0 &&
      auth.enabled === 0 &&
      integer(auth.generation) &&
      auth.generation >= 1,
    "auth_preflight_invalid",
  );
  insist(
    sessions.n === counts.sessions &&
      sessions.n < 1024 &&
      sessions.invalid === 0 &&
      sessions.active === 0,
    "sessions_preflight_invalid",
  );
  insist(
    rows[3].length === 1 &&
      rows[3][0].version === 1 &&
      counts.library_schema === 1,
    "schema_marker_invalid",
  );
  return {
    schemaHash: SAMPLER_SCHEMA_HASH,
    schemaVersion: 2,
    counts,
    authEnabled: false,
    generation: auth.generation,
    activeSessions: 0,
  };
}

// The caller must supply durable private IO; construction/dry-run never fetches.
export async function runReadonlyPreflight(options = {}) {
  if (options.execute !== true) return { dryRun: true, ...preflightPreview() };
  samplerEnvironment(options.environment ?? {}, ".local/cf03/preflight");
  const deploy = validateDeployConfig(options.deployConfig),
    dbid = deploy.profiles.check.databaseId;
  insist(
    /^[a-f0-9]{32}$/.test(options.accountId ?? "") &&
      typeof options.token === "string" &&
      /^[A-Za-z0-9._~-]{20,4096}$/.test(options.token),
    "credentials_invalid",
  );
  insist(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      options.versionId ?? "",
    ),
    "candidate_invalid",
  );
  insist(
    typeof options.checkpoint === "function" &&
      typeof options.evidenceSink === "function",
    "private_journal_required",
  );
  const timeoutMs = options.timeoutMs ?? 30000;
  insist(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000,
    "timeout_invalid",
  );
  const fetchImpl = options.fetchImpl ?? fetch,
    clock = options.now ?? (() => new Date().toISOString());
  const base = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}`,
    worker = `${base}/workers/scripts/${CHECK.name}`,
    database = `${base}/d1/database/${dbid}`;
  const targets = [
    worker + "/settings",
    worker + "/tails",
    worker + "/deployments",
    database,
    database + "/query",
    worker + "/subdomain",
    worker + "/settings",
    worker + "/tails",
  ];
  const receipt = {
    schemaVersion: 1,
    scope: "check",
    readOnly: true,
    ok: false,
    error: null,
    startedAt: clock(),
    endedAt: null,
    ledger: {
      management: 0,
      d1: 0,
      rowsRead: 0,
      rowsWritten: 0,
      metaComplete: null,
      rawBytes: 0,
    },
    requests: [],
    database: null,
    observationBefore: null,
    observationAfter: null,
    entryClosed: null,
  };
  let persistenceFailed = false;
  async function persist() {
    insist(!persistenceFailed, "private_journal_failed");
    try {
      await options.checkpoint(structuredClone(receipt));
    } catch {
      persistenceFailed = true;
      throw new PreflightError("private_journal_failed");
    }
  }
  async function request(index) {
    insist(!persistenceFailed, "private_journal_failed");
    insist(!options.signal?.aborted, "preflight_aborted");
    insist(
      index === receipt.ledger.management && index < 8,
      "request_order_or_budget",
    );
    const spec = preflightPreview().requests[index],
      isD1 = index === 3 || index === 4;
    receipt.ledger.management++;
    if (isD1) receipt.ledger.d1++;
    const evidence = {
      sequence: index + 1,
      label: spec.label,
      startedAt: clock(),
      endedAt: null,
      status: null,
      outcome: "reserved",
    };
    receipt.requests.push(evidence);
    // Reserve the entire D1 read estimate before its sole SQL POST, not after.
    if (index === 4) {
      receipt.rowsReadReservation = 20000;
      receipt.ledger.metaComplete = false;
    }
    await persist();
    const controller = new AbortController(),
      abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let timer,
      timedOut = false,
      active = true;
    const checkActive = () =>
      insist(
        active && !controller.signal.aborted && !persistenceFailed,
        timedOut
          ? "request_timeout"
          : options.signal?.aborted
            ? "preflight_aborted"
            : persistenceFailed
              ? "private_journal_failed"
              : "request_aborted",
      );
    try {
      const value = await Promise.race([
        (async () => {
          insist(!options.signal?.aborted, "preflight_aborted");
          const response = await fetchImpl(targets[index], {
            method: spec.method,
            headers: {
              Authorization: `Bearer ${options.token}`,
              ...(index === 4 ? { "Content-Type": "application/json" } : {}),
            },
            ...(index === 4 ? { body: JSON.stringify({ batch }) } : {}),
            redirect: "error",
            signal: controller.signal,
          });
          checkActive();
          evidence.status = response.status;
          insist(!response.redirected, "response_redirected");
          const declared = response.headers.get("content-length");
          if (declared !== null) {
            insist(
              /^\d+$/.test(declared) && integer(Number(declared)),
              "response_length_invalid",
            );
            insist(Number(declared) <= 1048576, "response_too_large");
          }
          const chunks = [];
          let size = 0;
          insist(response.body, "response_body_missing");
          for await (const chunk of response.body) {
            checkActive();
            size += chunk.length;
            insist(size <= 1048576, "response_too_large");
            chunks.push(Buffer.from(chunk));
          }
          checkActive();
          const body = Buffer.concat(chunks).toString("utf8");
          receipt.ledger.rawBytes += Buffer.byteLength(body);
          insist(receipt.ledger.rawBytes <= 8388608, "raw_evidence_budget");
          // Save even provider HTTP/API errors before JSON parsing or projecting.
          try {
            await options.evidenceSink({
              sequence: index + 1,
              label: spec.label,
              status: response.status,
              body,
            });
          } catch {
            persistenceFailed = true;
            throw new PreflightError("private_evidence_failed");
          }
          checkActive();
          let json;
          try {
            json = JSON.parse(body);
          } catch {
            throw new PreflightError("response_json_invalid");
          }
          if (index === 4) {
            const meta = queryMeta(json);
            receipt.d1Meta = meta;
            receipt.databaseProbes = Object.fromEntries(
              SAMPLER_TABLES.map((name, i) => {
                const rows = json?.result?.[i + 4]?.results;
                const n =
                  Array.isArray(rows) &&
                  rows.length === 1 &&
                  integer(rows[0]?.n) &&
                  rows[0].n <= 1024
                    ? rows[0].n
                    : null;
                return [
                  name,
                  {
                    count: n,
                    complete:
                      json.success === true &&
                      json.result?.[i + 4]?.success === true &&
                      n !== null &&
                      n < 1024,
                  },
                ];
              }),
            );
            receipt.ledger.rowsRead = meta.rowsRead;
            receipt.ledger.rowsWritten = meta.rowsWritten;
            receipt.ledger.metaComplete = meta.complete;
          }
          evidence.endedAt = clock();
          evidence.outcome = "received";
          await persist();
          checkActive();
          if (index === 4) {
            insist(receipt.d1Meta.complete, "d1_meta_incomplete");
            insist(
              receipt.ledger.rowsRead <= 20000 &&
                receipt.ledger.rowsWritten === 0,
              "d1_cost_exceeded",
            );
          }
          insist(
            response.ok &&
              json?.success === true &&
              (!json.errors ||
                (Array.isArray(json.errors) && json.errors.length === 0)),
            "provider_rejected",
          );
          return json.result;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            active = false;
            controller.abort();
            reject(new PreflightError("request_timeout"));
          }, timeoutMs);
        }),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                new PreflightError(
                  timedOut
                    ? "request_timeout"
                    : options.signal?.aborted
                      ? "preflight_aborted"
                      : "request_aborted",
                ),
              ),
            { once: true },
          ),
        ),
      ]);
      return value;
    } catch (error) {
      controller.abort();
      evidence.outcome = "stopped";
      evidence.endedAt = clock();
      throw error;
    } finally {
      active = false;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  function settings(value) {
    try {
      validateRemoteBindings(value, "check", dbid, {
        accountId: options.accountId,
      });
      return validateSamplerObservationSettings(value, {
        wranglerVersion: options.wranglerVersion,
      });
    } catch {
      throw new PreflightError("settings_unverified");
    }
  }
  function tails(value) {
    insist(
      Array.isArray(value) && value.length === 0,
      "tail_activity_or_invalid",
    );
  }
  try {
    receipt.observationBefore = settings(await request(0));
    tails(await request(1));
    const deployed = await request(2),
      first = deployed?.deployments?.[0];
    insist(
      first?.versions?.length === 1 &&
        first.versions[0].percentage === 100 &&
        first.versions[0].version_id === options.versionId,
      "deployed_version_mismatch",
    );
    const identity = await request(3);
    insist(
      identity?.uuid === dbid && identity.name === CHECK.databaseName,
      "database_identity_mismatch",
    );
    receipt.database = databaseProjection(await request(4));
    const entry = await request(5);
    insist(
      entry?.enabled === false && entry.previews_enabled === false,
      "entry_not_closed",
    );
    receipt.entryClosed = true;
    receipt.observationAfter = settings(await request(6));
    tails(await request(7));
    receipt.ok = true;
  } catch (error) {
    receipt.ok = false;
    receipt.error = safeError(error);
  }
  receipt.endedAt = clock();
  if (!persistenceFailed)
    try {
      await persist();
    } catch {
      receipt.ok = false;
      receipt.error = "private_journal_failed";
    }
  return receipt;
}

// Append-only, fsynced, exclusive files. An existing run-start permanently blocks replay.
// A failure is terminal: this helper never deletes a reservation or reuses a name.
export async function createPreflightJournal({ root, directory, manifest }) {
  const start = await privatePath(
    path.join(directory, "run-start.json"),
    root,
    { existing: false },
  );
  async function write(file, body) {
    const target = await privatePath(file, root, { existing: false });
    const handle = await fs.open(
      target,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      insist(
        stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1,
        "private_file_unsafe",
      );
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parent = await fs.open(
      path.dirname(target),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  await write(start, JSON.stringify(manifest));
  let ordinal = 0,
    failed = false;
  async function guardedWrite(file, body) {
    insist(!failed, "private_journal_failed");
    try {
      await write(file, body);
    } catch {
      failed = true;
      throw new PreflightError("private_journal_failed");
    }
  }
  return {
    checkpoint: (receipt) =>
      guardedWrite(
        path.join(directory, `ledger-${++ordinal}.json`),
        JSON.stringify(receipt),
      ),
    evidenceSink: ({ sequence, body }) =>
      guardedWrite(path.join(directory, `response-${sequence}.json`), body),
  };
}
