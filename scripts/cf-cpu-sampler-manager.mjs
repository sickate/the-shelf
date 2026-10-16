// Fixed check Cloudflare management adapter. No CLI or credential discovery.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  CHECK,
  MAINTENANCE_LIMITS,
  MANAGEMENT_COMMANDS,
  SAMPLER_MANIFEST,
  validateSamplerPlan,
} from "./cf-cpu-sampler.mjs";
const sha = (x) => createHash("sha256").update(x).digest("hex");
const own = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
class ManagerError extends Error {
  constructor(code) {
    super(`Check sampler management stopped (${code}).`);
    this.code = code;
  }
}
const insist = (ok, code = "invalid_management_input") => {
  if (!ok) throw new ManagerError(code);
};
const DAY = 86400000,
  MINUTE = 60000;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const validTime = (t) =>
  typeof t === "string" &&
  UTC.test(t) &&
  Number.isFinite(Date.parse(t)) &&
  new Date(t).toISOString() === t;
const dailyKinds =
  "'api_day','login_day','access_day','metadata_day','session_day'";
const minuteKinds =
  "'api_minute','api_ip','login_minute','login_ip','access_ip','metadata_ip'";
// Canonicalize only whitespace OUTSIDE SQL literals/quoted identifiers.
const normalizeSql = (s) =>
  (typeof s === "string" ? s : "")
    .match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+|[^\s'\"]+/g)
    ?.map((t) => (/^\s+$/.test(t) ? " " : t))
    .join("")
    .trim()
    .replace(/;$/, "") ?? "";
function schemaContract() {
  const memory = new DatabaseSync(":memory:");
  try {
    memory.exec(
      readFileSync(
        new URL("../cloudflare/library/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    memory.exec(
      readFileSync(
        new URL(
          "../cloudflare/library/migrations/002-conservative-storage.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const rows = memory
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    const objects = rows.map((r) => ({
      type: r.type,
      name: r.name,
      table: r.tbl_name,
      sql: normalizeSql(r.sql),
    }));
    return {
      objects,
      tables: objects.filter((r) => r.type === "table").map((r) => r.name),
      schemaHash: sha(JSON.stringify(objects)),
    };
  } finally {
    memory.close();
  }
}
const SCHEMA = schemaContract();
export const SAMPLER_SCHEMA_HASH = SCHEMA.schemaHash;
export const SAMPLER_TABLES = Object.freeze([...SCHEMA.tables]);
// Upper bounds, not measured platform costs. The basis is explicitly supplied
// and reviewed by the operator, then actual starting cardinalities are checked.
export function buildSamplerCostBasis(maxRows) {
  insist(
    own(maxRows, SAMPLER_TABLES) &&
      Object.values(maxRows).every((n) => integer(n) && n <= 100000),
    "invalid_cost_basis",
  );
  const bounds = { ...maxRows };
  const after = {
    ...bounds,
    admissions: bounds.admissions + 180,
    counters: bounds.counters + 400,
    sessions: bounds.sessions + 68,
    catalog_books: bounds.catalog_books + 2,
    metadata_overrides: bounds.metadata_overrides + 2,
  };
  const scans = Object.values(after).reduce((a, b) => a + b, 0);
  const snapshot =
    128 + 2 * after.admissions + 2 * after.counters + 3 * after.sessions;
  const auth = 64 + 2 * after.sessions;
  const cost = (rowsRead, rowsWritten) => ({ rowsRead, rowsWritten });
  const costs = {
    business: cost(
      128 + 4 * after.catalog_books + 2 * after.file_registry + after.sessions,
      64,
    ),
    maintenance: cost(384 + 2 * after.counters + 2 * after.sessions, 640),
    inspectDatabase: cost(256 + 4 * scans + 2 * SCHEMA.objects.length, 1),
    enableAuth: cost(auth, 16 + 3 * after.sessions),
    seedMaintenance: cost(
      4096 + 128 + 256 + 64 * (16 + after.sessions) + snapshot,
      4096,
    ),
    prepareRound: cost(
      snapshot + 64 + 2 * after.catalog_books + after.file_registry,
      16,
    ),
    rotateGeneration: cost(auth, 16 + 3 * after.sessions),
    readCoverage: cost(snapshot, 1),
    closeAuth: cost(auth, 16 + 3 * after.sessions),
    verifyAuthClosed: cost(auth, 1),
  };
  return {
    schemaHash: SCHEMA.schemaHash,
    maxRows: bounds,
    growth: {
      admissions: 180,
      counters: 400,
      sessions: 68,
      catalog_books: 2,
      metadata_overrides: 2,
    },
    costs,
  };
}
const sql = (text, params = []) => ({ sql: text, params });
const countOld = (cutoff) =>
  sql(
    `SELECT
 (SELECT count(*) FROM admissions WHERE scope='check' AND created_at<?) AS admissions,
 (SELECT count(*) FROM counters WHERE scope='check' AND kind IN (${dailyKinds}) AND window_start<?) AS daily,
 (SELECT count(*) FROM counters WHERE scope='check' AND kind IN (${minuteKinds}) AND window_start<?) AS minute,
 (SELECT count(*) FROM sessions WHERE scope='check' AND expires_at<?) AS sessions`,
    [
      cutoff - 2 * DAY,
      Math.floor(cutoff / DAY) - 2,
      Math.floor(cutoff / MINUTE) - 120,
      cutoff - DAY,
    ],
  );
function snapshotQuery(cutoff, day, boundary) {
  return sql(
    `SELECT
 COALESCE((SELECT count FROM counters WHERE scope='check' AND kind='api_day' AND bucket='global' AND window_start=?),0) AS ordinal,
 (SELECT count(*) FROM admissions WHERE scope='check' AND kind='metadata' AND rowid>?) AS metadataAdmissions,
 (SELECT COALESCE(max(rowid),0) FROM admissions) AS boundary,
 (SELECT count(*) FROM sessions WHERE scope='check') AS sessionRows,
 (SELECT count(*) FROM sessions WHERE scope='check' AND length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*') AS hashedSessionRows,
 ? AS cutoff, ? AS day`,
    [
      Math.floor(Date.parse(day + "T00:00:00.000Z") / DAY),
      boundary,
      cutoff,
      day,
    ],
  );
}
const GRAPHQL = `query($a:String!,$f:Time!,$t:Time!){viewer{accounts(filter:{accountTag:$a}){aggregate:workersInvocationsAdaptive(limit:10,filter:{scriptName:"the-shelf-cf03-check",datetime_geq:$f,datetime_leq:$t}){dimensions{scriptName scriptVersion}avg{sampleInterval}max{cpuTime}sum{requests errors}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}}groups:workersInvocationsAdaptive(limit:1000,filter:{scriptName:"the-shelf-cf03-check",datetime_geq:$f,datetime_leq:$t},orderBy:[datetime_ASC]){dimensions{datetime status scriptName scriptVersion}max{cpuTime}sum{requests errors}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99}}}}}`;
const ROUNDS = ["first-access", "subsequent"];
const roundIds = (round) => ({
  bookId: `cf03-sampler-${round}`,
  fileId: `cf03-sampler-${round}-file`,
});
const snapshotProjection = (row, maintenance) => {
  insist(
    row &&
      [
        "ordinal",
        "metadataAdmissions",
        "boundary",
        "sessionRows",
        "hashedSessionRows",
        "cutoff",
      ].every((k) => integer(row[k])) &&
      /^\d{4}-\d{2}-\d{2}$/.test(row.day || ""),
    "invalid_snapshot",
  );
  insist(
    own(maintenance, Object.keys(MAINTENANCE_LIMITS)) &&
      Object.values(maintenance).every(integer),
    "invalid_snapshot",
  );
  return {
    ordinal: row.ordinal,
    metadataAdmissions: row.metadataAdmissions,
    cutoff: row.cutoff,
    day: row.day,
    sessionRows: row.sessionRows,
    hashedSessionRows: row.hashedSessionRows,
    maintenance: { ...maintenance },
  };
};

export function createSamplerManager(options) {
  insist(
    options &&
      /^[a-f0-9]{32}$/.test(options.accountId || "") &&
      typeof options.token === "string" &&
      /^[\x21-\x7e]{16,4096}$/.test(options.token),
    "invalid_credentials",
  );
  const { plan } = validateSamplerPlan(options.plan);
  insist(
    own(options.costBasis, ["schemaHash", "maxRows", "reviewed"]) &&
      options.costBasis.reviewed === true,
    "reviewed_cost_basis_required",
  );
  const basis = buildSamplerCostBasis(options.costBasis.maxRows);
  insist(
    options.costBasis.schemaHash === basis.schemaHash &&
      Object.keys(basis.costs).every((key) =>
        Object.keys(basis.costs[key]).every(
          (metric) => plan.costs[key]?.[metric] === basis.costs[key][metric],
        ),
      ),
    "cost_basis_mismatch",
  );
  insist(
    typeof options.evidenceSink === "function" ||
      options.fetchImpl !== undefined,
    "private_evidence_sink_required",
  );
  const token = options.token,
    evidenceSink = options.evidenceSink;
  const fetchImpl = options.fetchImpl ?? fetch,
    clock = options.clock ?? (() => Date.now());
  insist(typeof fetchImpl === "function" && typeof clock === "function");
  const nonce = options.runNonce ?? randomBytes(16).toString("hex");
  insist(/^[a-f0-9]{32}$/.test(nonce || ""), "invalid_run_nonce");
  const start = clock();
  insist(integer(start) && start > 10000 * DAY, "invalid_clock");
  const cutoff = start,
    historicalDay =
      Math.floor(start / DAY) - 1024 - (parseInt(nonce.slice(0, 6), 16) % 4096);
  const prefix = `cf03-sampler-${nonce}-`;
  const dbid = plan.deployConfig.profiles.check.databaseId;
  const base = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}`;
  const worker = `${base}/workers/scripts/${CHECK.name}`,
    database = `${base}/d1/database/${dbid}`;
  const expectedTarget = {
    ...CHECK,
    databaseId: dbid,
    versionId: plan.versionId,
  };
  const state = {
    version: false,
    identity: false,
    schema: false,
    entry: false,
    enabled: false,
    seeded: false,
    generation: null,
    rounds: new Map(),
    attempted: new Set(),
    busy: false,
    closing: false,
  };
  let activeCommand = null,
    activeWindow = null;
  const requireReady = () =>
    insist(
      state.version && state.identity && state.schema && state.entry,
      "preflight_required",
    );
  const freshMutation = (key) => {
    insist(!state.attempted.has(key), "mutation_already_attempted");
    state.attempted.add(key);
  };
  async function request(
    url,
    { method = "GET", body, signal, graphql = false } = {},
  ) {
    insist(!signal?.aborted, "management_aborted");
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timer;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetchImpl(url, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "error",
            signal: controller.signal,
          });
          insist(
            response &&
              response.status >= 200 &&
              response.status < 600 &&
              response.redirected !== true,
            "management_response_invalid",
          );
          if (response.status === 403 || response.status === 401)
            throw new ManagerError("management_permission_denied");
          if (response.status === 429)
            throw new ManagerError("management_rate_limited");
          insist(response.ok && response.status < 300, "management_rejected");
          const length = response.headers.get("content-length");
          insist(
            length === null ||
              (/^\d+$/.test(length) && Number(length) <= 1048576),
            "management_response_too_large",
          );
          let total = 0;
          const chunks = [];
          insist(response.body, "management_response_invalid");
          for await (const chunk of response.body) {
            insist(!controller.signal.aborted, "management_aborted");
            total += chunk.length;
            insist(total <= 1048576, "management_response_too_large");
            chunks.push(Buffer.from(chunk));
          }
          let value;
          try {
            value = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
          } catch {
            throw new ManagerError("management_json_invalid");
          }
          insist(
            graphql
              ? !value.errors
              : value.success === true &&
                  (!value.errors ||
                    (Array.isArray(value.errors) && value.errors.length === 0)),
            "management_rejected",
          );
          if (evidenceSink) {
            try {
              await evidenceSink({
                command: activeCommand,
                window: activeWindow,
                response: structuredClone(value),
              });
            } catch {
              throw new ManagerError("private_evidence_write_failed");
            }
          }
          return graphql ? value.data : value.result;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new ManagerError("management_timeout"));
            controller.abort();
          }, plan.timeoutMs);
        }),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new ManagerError("management_aborted")),
            { once: true },
          ),
        ),
      ]);
      return result;
    } catch (error) {
      controller.abort();
      throw error instanceof ManagerError
        ? error
        : new ManagerError("management_outcome_unknown");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async function query(batch, signal) {
    const result = await request(database + "/query", {
      method: "POST",
      body: { batch },
      signal,
    });
    insist(
      Array.isArray(result) && result.length === batch.length,
      "d1_result_invalid",
    );
    const meta = { rowsRead: 0, rowsWritten: 0 };
    for (const item of result) {
      insist(
        item?.success === true &&
          Array.isArray(item.results) &&
          item.meta &&
          integer(item.meta.rows_read) &&
          integer(item.meta.rows_written),
        "d1_meta_or_result_missing",
      );
      meta.rowsRead += item.meta.rows_read;
      meta.rowsWritten += item.meta.rows_written;
    }
    insist(
      integer(meta.rowsRead) && integer(meta.rowsWritten),
      "d1_meta_or_result_missing",
    );
    return { rows: result.map((item) => item.results), meta };
  }
  async function manage(command, context) {
    insist(Object.hasOwn(MANAGEMENT_COMMANDS, command), "unknown_command");
    insist(
      own(context, ["target", "payload", "signal"]) &&
        own(context.target, Object.keys(expectedTarget)) &&
        Object.keys(expectedTarget).every(
          (k) => context.target[k] === expectedTarget[k],
        ),
      "invalid_management_target",
    );
    insist(
      context.signal instanceof AbortSignal && !context.signal.aborted,
      "management_aborted",
    );
    insist(!state.busy, "concurrent_management_rejected");
    insist(
      !state.closing ||
        [
          "closeAuth",
          "verifyAuthClosed",
          "closeEntry",
          "verifyEntryClosed",
        ].includes(command),
      "manager_closing",
    );
    const payload = context.payload,
      signal = context.signal;
    const empty = () => insist(own(payload, []), "invalid_command_payload");
    let batch, project, mutatingKey;
    if (
      [
        "inspectVersion",
        "inspectDatabaseIdentity",
        "inspectEntry",
        "inspectDatabase",
        "enableEntry",
        "closeAuth",
        "verifyAuthClosed",
        "closeEntry",
        "verifyEntryClosed",
        "seedMaintenance",
      ].includes(command)
    ) {
      if (command !== "seedMaintenance") empty();
    }
    if (command === "enableAuth" || command === "rotateGeneration") {
      insist(
        own(payload, ["expectedGeneration"]) &&
          integer(payload.expectedGeneration) &&
          payload.expectedGeneration === state.generation,
        "generation_mismatch",
      );
      requireReady();
      if (command === "rotateGeneration")
        insist(
          state.enabled &&
            state.seeded &&
            [...state.rounds.values()].some((r) => !r.rotated),
          "round_not_prepared",
        );
      mutatingKey =
        command === "enableAuth"
          ? command
          : `${command}:${payload.expectedGeneration}`;
      batch = [
        sql(
          `UPDATE auth_config SET enabled=1,generation=generation+1,updated_at=? WHERE scope='check' AND origin=? AND generation=? AND enabled=? RETURNING enabled,generation`,
          [
            clock(),
            CHECK.origin,
            payload.expectedGeneration,
            command === "enableAuth" ? 0 : 1,
          ],
        ),
      ];
      project = (rows) => {
        const row = rows[0][0];
        insist(
          rows[0].length === 1 &&
            row.enabled === 1 &&
            row.generation === payload.expectedGeneration + 1,
          "generation_update_unverified",
        );
        state.generation = row.generation;
        state.enabled = true;
        if (command === "rotateGeneration") {
          const current = [...state.rounds.values()].find((r) => !r.rotated);
          current.rotated = true;
        }
        return { enabled: true, generation: row.generation };
      };
    } else if (command === "inspectDatabase") {
      insist(state.identity, "database_identity_unverified");
      const names = SCHEMA.tables.map(() => "?").join(",");
      batch = [
        sql(
          `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (${names}) AND name NOT LIKE 'sqlite_%' ORDER BY type,name`,
          SCHEMA.tables,
        ),
        sql(
          "SELECT scope,origin,generation,enabled,(SELECT count(*) FROM sessions WHERE scope='check' AND revoked=0) AS active FROM auth_config WHERE scope='check'",
        ),
        sql("SELECT version FROM library_schema ORDER BY version"),
        ...SCHEMA.tables.map((name) =>
          sql(`SELECT count(*) AS n FROM ${name}`),
        ),
      ];
      project = (rows) => {
        const actual = rows[0].map((r) => ({
          type: r.type,
          name: r.name,
          table: r.tbl_name,
          sql: normalizeSql(r.sql),
        }));
        insist(
          JSON.stringify(actual) === JSON.stringify(SCHEMA.objects),
          "schema_drift",
        );
        insist(
          rows[2].length === 1 && rows[2][0].version === 1,
          "schema_marker_invalid",
        );
        for (let i = 0; i < SCHEMA.tables.length; i++)
          insist(
            rows[3 + i].length === 1 &&
              integer(rows[3 + i][0].n) &&
              rows[3 + i][0].n <= basis.maxRows[SCHEMA.tables[i]],
            "cardinality_bound_exceeded",
          );
        const auth = rows[1][0];
        insist(
          rows[1].length === 1 &&
            auth.scope === "check" &&
            auth.origin === CHECK.origin &&
            integer(auth.generation) &&
            auth.generation >= 1 &&
            auth.enabled === 0 &&
            auth.active === 0,
          "auth_preflight_invalid",
        );
        state.schema = true;
        state.generation = auth.generation;
        return {
          scope: "check",
          origin: CHECK.origin,
          schemaVersion: 2,
          authEnabled: false,
          generation: auth.generation,
          activeSessions: 0,
        };
      };
    } else if (command === "seedMaintenance") {
      requireReady();
      insist(
        state.enabled &&
          own(payload, ["limits", "batches"]) &&
          payload.batches === 2 &&
          own(payload.limits, Object.keys(MAINTENANCE_LIMITS)) &&
          Object.keys(MAINTENANCE_LIMITS).every(
            (k) => payload.limits[k] === MAINTENANCE_LIMITS[k],
          ),
        "invalid_fixture_payload",
      );
      mutatingKey = command;
      // Unique old windows: refuse existing historical consumption, never reset it.
      const guard = `EXISTS(SELECT 1 FROM auth_config WHERE scope='check' AND generation=? AND enabled=1)`;
      const untouched = `NOT EXISTS(SELECT 1 FROM counters WHERE scope='check' AND ((kind IN (${dailyKinds}) AND window_start IN (?,?,?)) OR (kind IN (${minuteKinds}) AND window_start IN (?,?))))`;
      const htime = historicalDay * DAY;
      // An INSERT of a duplicate fixture PK is intentionally a hard failure.
      batch = [
        sql(
          `SELECT CASE WHEN ${guard} AND ${untouched} THEN 1 ELSE abs(-9223372036854775808) END AS allowed`,
          [
            state.generation,
            historicalDay,
            historicalDay - 1,
            historicalDay - 2,
            historicalDay * 1440,
            historicalDay * 1440 + 1,
          ],
        ),
        sql(
          `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<128) INSERT INTO admissions(scope,request_id,kind,ip_key,created_at) SELECT 'check',?||printf('%04d',i),'api',?,? FROM n WHERE ${guard} RETURNING 1 AS inserted`,
          [prefix + "admission-", sha(prefix + "ip"), htime, state.generation],
        ),
        sql(
          `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<16) INSERT INTO counters SELECT 'check','metadata_day',?||printf('%04d',i),?,1,100 FROM n WHERE ${guard} RETURNING 1 AS inserted`,
          [prefix + "daily-", historicalDay, state.generation],
        ),
        sql(
          `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<256) INSERT INTO counters SELECT 'check','metadata_ip',?||printf('%04d',i),?,1,20 FROM n WHERE ${guard} RETURNING 1 AS inserted`,
          [prefix + "minute-", historicalDay * 1440, state.generation],
        ),
        sql(
          `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<64) INSERT INTO sessions(scope,session_hash,generation,created_at,expires_at,revoked) SELECT 'check',?||printf('%08x',i),?,(?-1-(i>32))*86400000+1,(?-1-(i>32))*86400000+2,1 FROM n WHERE ${guard} RETURNING 1 AS inserted`,
          [
            sha(prefix + "session").slice(0, 56),
            state.generation,
            historicalDay,
            historicalDay,
            state.generation,
          ],
        ),
        countOld(cutoff),
      ];
      project = (rows) => {
        for (let i = 0; i < 4; i++)
          insist(
            rows[i + 1].length === [128, 16, 256, 64][i],
            "fixture_insert_unverified",
          );
        const counts = rows[5][0];
        insist(
          own(counts, Object.keys(MAINTENANCE_LIMITS)) &&
            Object.values(counts).every(integer),
          "invalid_snapshot",
        );
        state.seeded = true;
        return { counts: { ...counts } };
      };
    } else if (command === "prepareRound") {
      requireReady();
      insist(
        state.enabled &&
          state.seeded &&
          own(payload, [
            "round",
            "bookId",
            "fileId",
            "expectedGeneration",
            "unknownCategory",
          ]) &&
          ROUNDS.includes(payload.round) &&
          payload.bookId === roundIds(payload.round).bookId &&
          payload.fileId === roundIds(payload.round).fileId &&
          payload.expectedGeneration === state.generation &&
          payload.unknownCategory === "Cloud Test New Category",
        "invalid_round_payload",
      );
      insist(
        payload.round ===
          (state.rounds.size === 0
            ? "first-access"
            : state.rounds.size === 1
              ? "subsequent"
              : null) &&
          (state.rounds.size === 0 || state.rounds.get("first-access").covered),
        "round_order_invalid",
      );
      mutatingKey = `prepareRound:${payload.round}`;
      const day = new Date(clock()).toISOString().slice(0, 10);
      const book = {
        id: payload.bookId,
        title: "Synthetic cloud test",
        author: null,
        category: "Tests",
        categoryId: "cat-tests",
        tags: [],
        description: "Synthetic fixture, no book content.",
        files: [
          {
            id: payload.fileId,
            format: "EPUB",
            sizeBytes: 100,
            status: "candidate",
            reason: "not_uploaded",
            visibility: "private",
            readable: true,
          },
        ],
      };
      batch = [
        sql(
          `INSERT INTO catalog_books(scope,book_id,public_json) SELECT 'check',?,? WHERE EXISTS(SELECT 1 FROM auth_config WHERE scope='check' AND enabled=1 AND generation=?) AND NOT EXISTS(SELECT 1 FROM metadata_overrides WHERE scope='check' AND book_id=?) AND NOT EXISTS(SELECT 1 FROM file_registry WHERE scope='check' AND (book_id=? OR file_id=?)) RETURNING 1 AS inserted`,
          [
            payload.bookId,
            JSON.stringify(book),
            state.generation,
            payload.bookId,
            payload.bookId,
            payload.fileId,
          ],
        ),
        snapshotQuery(cutoff, day, Number.MAX_SAFE_INTEGER),
        countOld(cutoff),
      ];
      project = (rows) => {
        insist(
          rows[0].length === 1 && rows[0][0].inserted === 1,
          "round_fixture_unverified",
        );
        const snapshot = snapshotProjection(rows[1][0], rows[2][0]);
        state.rounds.set(payload.round, {
          day,
          boundary: rows[1][0].boundary,
          rotated: false,
          covered: false,
        });
        return { fixtureInserted: 1, metadataVersion: 0, ...snapshot };
      };
    } else if (command === "readCoverage") {
      insist(
        own(payload, ["round", "cutoff", "day", "bookId"]) &&
          ROUNDS.includes(payload.round) &&
          payload.bookId === roundIds(payload.round).bookId &&
          payload.cutoff === cutoff,
        "invalid_coverage_payload",
      );
      const round = state.rounds.get(payload.round);
      insist(
        round?.rotated &&
          !round.covered &&
          payload.day === round.day &&
          new Date(clock()).toISOString().slice(0, 10) === round.day,
        "coverage_boundary_invalid",
      );
      batch = [
        snapshotQuery(cutoff, round.day, round.boundary),
        countOld(cutoff),
      ];
      project = (rows) => {
        const data = snapshotProjection(rows[0][0], rows[1][0]);
        round.covered = true;
        return data;
      };
    } else if (command === "closeAuth") {
      insist(state.identity && state.schema, "database_identity_unverified");
      mutatingKey = command;
      batch = [
        sql(
          "UPDATE auth_config SET enabled=0,generation=generation+1,updated_at=? WHERE scope='check' AND origin=? RETURNING enabled,generation",
          [clock(), CHECK.origin],
        ),
      ];
      project = (rows) => {
        const row = rows[0][0];
        insist(
          rows[0].length === 1 && row.enabled === 0 && integer(row.generation),
          "auth_shutdown_unverified",
        );
        state.generation = row.generation;
        state.enabled = false;
        return { enabled: false, generation: row.generation };
      };
    } else if (command === "verifyAuthClosed") {
      insist(state.identity && state.schema, "database_identity_unverified");
      batch = [
        sql(
          "SELECT enabled,generation,(SELECT count(*) FROM sessions WHERE scope='check' AND revoked=0) AS active FROM auth_config WHERE scope='check'",
        ),
      ];
      project = (rows) => {
        const row = rows[0][0];
        insist(
          rows[0].length === 1 &&
            row.enabled === 0 &&
            integer(row.generation) &&
            row.active === 0,
          "auth_shutdown_unverified",
        );
        return {
          enabled: false,
          generation: row.generation,
          activeSessions: 0,
        };
      };
    }
    if (command === "enableEntry") {
      requireReady();
      insist(state.enabled && state.seeded, "auth_and_fixture_required");
      mutatingKey = command;
    }
    if (command === "closeEntry") {
      insist(state.identity && state.schema, "database_identity_unverified");
      mutatingKey = command;
    }
    if (command === "analytics") validateAnalytics(payload, state, plan);
    if (mutatingKey) freshMutation(mutatingKey);
    if (command === "closeAuth" || command === "closeEntry")
      state.closing = true;
    state.busy = true;
    activeCommand = command;
    activeWindow = command === "analytics" ? payload.window : null;
    try {
      if (batch) {
        const result = await query(batch, signal);
        return { data: project(result.rows), meta: result.meta };
      }
      if (command === "inspectVersion") {
        const result = await request(worker + "/deployments", { signal });
        const first = result?.deployments?.[0];
        insist(
          first?.versions?.length === 1 &&
            first.versions[0].percentage === 100 &&
            first.versions[0].version_id === plan.versionId,
          "deployed_version_mismatch",
        );
        state.version = true;
        return { data: { versionId: plan.versionId } };
      }
      if (command === "inspectDatabaseIdentity") {
        const result = await request(database, { signal });
        insist(
          result?.uuid === dbid && result.name === CHECK.databaseName,
          "database_identity_mismatch",
        );
        state.identity = true;
        return { data: { databaseId: dbid, databaseName: CHECK.databaseName } };
      }
      if (
        [
          "inspectEntry",
          "verifyEntryClosed",
          "enableEntry",
          "closeEntry",
        ].includes(command)
      ) {
        const write = command === "enableEntry" || command === "closeEntry";
        const result = await request(worker + "/subdomain", {
          signal,
          ...(write
            ? {
                method: "POST",
                body: {
                  enabled: command === "enableEntry",
                  previews_enabled: false,
                },
              }
            : {}),
        });
        insist(
          typeof result?.enabled === "boolean" &&
            typeof result.previews_enabled === "boolean",
          "entry_response_invalid",
        );
        insist(
          result.enabled === (command === "enableEntry") &&
            result.previews_enabled === false,
          "entry_state_unverified",
        );
        if (command === "inspectEntry") state.entry = true;
        return {
          data: {
            enabled: result.enabled,
            previewsEnabled: result.previews_enabled,
          },
        };
      }
      if (command === "analytics") {
        const response = await request(
          "https://api.cloudflare.com/client/v4/graphql",
          {
            signal,
            method: "POST",
            body: {
              query: GRAPHQL,
              variables: {
                a: options.accountId,
                f: payload.from,
                t: payload.to,
              },
            },
            graphql: true,
          },
        );
        return { data: analyticsProjection(response, payload, plan.versionId) };
      }
      throw new ManagerError("unknown_command");
    } catch (error) {
      throw error instanceof ManagerError
        ? error
        : new ManagerError("management_response_invalid");
    } finally {
      state.busy = false;
    }
  }
  return Object.freeze({
    manage,
    costs: structuredClone(basis.costs),
    schemaHash: basis.schemaHash,
    fixtureIdentity: Object.freeze({ runNonce: nonce, historicalDay, cutoff }),
  });
}
function validateAnalytics(payload, state, plan) {
  insist(
    own(payload, ["window", "from", "to", "expectedRequests", "requests"]) &&
      [...ROUNDS, "combined"].includes(payload.window) &&
      validTime(payload.from) &&
      validTime(payload.to) &&
      Date.parse(payload.to) > Date.parse(payload.from) &&
      Date.parse(payload.to) - Date.parse(payload.from) <= 900000,
    "invalid_analytics_payload",
  );
  insist(
    state.rounds.size === 2 &&
      [...state.rounds.values()].every((r) => r.covered),
    "both_rounds_required",
  );
  const size = payload.window === "combined" ? 42 : 21,
    offset = payload.window === "subsequent" ? 21 : 0;
  insist(
    payload.expectedRequests === size &&
      Array.isArray(payload.requests) &&
      payload.requests.length === size,
    "invalid_analytics_payload",
  );
  for (let i = 0; i < size; i++) {
    const row = payload.requests[i],
      template = SAMPLER_MANIFEST[i % 21];
    insist(
      own(row, ["sequence", "branch", "versionId", "startedAt", "endedAt"]) &&
        row.sequence === offset + i + 1 &&
        row.branch === template.branch &&
        row.versionId === plan.versionId &&
        validTime(row.startedAt) &&
        validTime(row.endedAt) &&
        row.startedAt <= row.endedAt &&
        row.startedAt >= payload.from &&
        row.endedAt < payload.to,
      "invalid_analytics_payload",
    );
  }
  insist(
    payload.from ===
      new Date(
        Date.parse(payload.requests[0].startedAt) - 2000,
      ).toISOString() &&
      payload.to ===
        new Date(
          Date.parse(payload.requests.at(-1).endedAt) + 2000,
        ).toISOString(),
    "analytics_window_mismatch",
  );
}
function analyticsProjection(response, payload, versionId) {
  const accounts = response?.viewer?.accounts;
  insist(
    Array.isArray(accounts) && accounts.length === 1,
    "analytics_response_invalid",
  );
  const { aggregate, groups } = accounts[0];
  insist(
    Array.isArray(aggregate) &&
      Array.isArray(groups) &&
      aggregate.length <= 10 &&
      groups.length <= 1000,
    "analytics_response_invalid",
  );
  const metric = (row) => {
    // Missing fields remain missing. The offline analyzer keeps a valid aggregate
    // even if group coverage/fields are incomplete; no invented zeroes or P99=max.
    const out = {};
    for (const key of ["requests", "errors"])
      if (integer(row?.sum?.[key])) out[key] = row.sum[key];
    for (const key of ["cpuTimeP50", "cpuTimeP95", "cpuTimeP99"])
      if (
        typeof row?.quantiles?.[key] === "number" &&
        Number.isFinite(row.quantiles[key]) &&
        row.quantiles[key] >= 0
      )
        out[key] = row.quantiles[key];
    if (
      typeof row?.max?.cpuTime === "number" &&
      Number.isFinite(row.max.cpuTime) &&
      row.max.cpuTime >= 0
    )
      out.cpuTimeMax = row.max.cpuTime;
    return out;
  };
  const identity = (row) => ({
    workerName:
      row?.dimensions?.scriptName === CHECK.name
        ? CHECK.name
        : "invalid-worker",
    versionId:
      row?.dimensions?.scriptVersion === versionId
        ? versionId
        : "invalid-version",
  });
  const data = {
    workerName: CHECK.name,
    scope: "check",
    versionId,
    versionEvidence: "platform-dimension",
    cpuUnit: "microseconds",
    clockUncertaintyMs: 1000,
    query: {
      from: payload.from,
      to: payload.to,
      groupLimit: 1000,
      groupsTruncated: groups.length === 1000,
    },
    groups: groups.map((row) => {
      const value = { ...identity(row), ...metric(row) };
      if (
        typeof row?.dimensions?.datetime === "string" &&
        Number.isFinite(Date.parse(row?.dimensions?.datetime))
      )
        value.datetime = new Date(row?.dimensions?.datetime).toISOString();
      if (
        [
          "ok",
          "success",
          "exception",
          "exceededCpu",
          "exceededMemory",
          "canceled",
          "unknown",
          "responseStreamDisconnected",
          "scriptNotFound",
        ].includes(row?.dimensions?.status)
      )
        value.status = row?.dimensions?.status;
      return value;
    }),
  };
  if (aggregate.length === 1) {
    data.aggregate = {
      ...identity(aggregate[0]),
      from: payload.from,
      to: payload.to,
      ...metric(aggregate[0]),
    };
    const sample = aggregate[0]?.avg?.sampleInterval;
    if (typeof sample === "number" && Number.isFinite(sample) && sample > 0)
      data.sampling = { sampleInterval: sample };
  }
  return data;
}
