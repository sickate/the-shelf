/** Closed v2 prepared-original proof; no original-object operations or grants. */
import { LibraryError, randomKey } from "./security.mjs";
import {
  STORAGE_SOURCE_SQL,
  storageReadConfiguration,
  assertStorageReadConfiguration,
  decodePreparedNormalSource,
  confirmedSourceProjection,
} from "./storage-sources.mjs";

export const PREPARED_SOURCE_LIMITS = Object.freeze({
  sqlBytes: 16_384,
  parameters: 10,
  admissionParameters: 14,
  preparedBytes: 16_384,
  responseBytes: 1_048_576,
  timeoutMs: 30_000,
});
const COLUMNS = Object.freeze([
  "scope",
  "file_id",
  "version_hash",
  "book_id",
  "text_reservation_id",
  "text_logical_key",
  "package_sha256",
  "source_sha256",
  "etag",
  "format",
  "chunk_count",
  "text_bytes",
  "codepoint_count",
  "index_sha256",
  "created_at",
  "descriptor_json",
  "identity_json",
  "management_version",
  "original_descriptor_json",
  "original_etag",
  "original_object_key",
  "original_sha256",
  "original_size_bytes",
  "original_format",
  "original_version",
  "actual_chunk_count",
]);
const encoder = new TextEncoder(),
  bytes = (value) => encoder.encode(value).byteLength,
  octets = (value) => `length(CAST(${value} AS BLOB))`,
  jsonRow = `json_object(${COLUMNS.map((key) => `'${key}',p.${key}`).join(",")})`,
  rawBytes = COLUMNS.map((key) => `COALESCE(${octets(`p.${key}`)},0)`).join(
    "+",
  ),
  projectedColumns = COLUMNS.filter((key) => key !== "actual_chunk_count")
    .map((key) => `i.${key}`)
    .join(",");
export const PREPARED_SOURCE_SQL = `WITH source AS MATERIALIZED (${STORAGE_SOURCE_SQL}), prepared AS MATERIALIZED (SELECT ${projectedColumns},(SELECT count(*) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash) AS actual_chunk_count FROM shelf_prepared_readable_sources i WHERE i.scope=? AND i.book_id=? AND i.file_id=? AND i.version_hash=? LIMIT 2), prepared_payload AS MATERIALIZED (SELECT CASE WHEN ${octets("p.descriptor_json")}>4096 OR ${octets("p.identity_json")}>2048 OR ${octets("p.original_descriptor_json")}>4096 OR (${rawBytes})>16384 THEN NULL ELSE ${jsonRow} END AS raw_prepared FROM prepared p), combined AS MATERIALIZED (SELECT source.snapshot_json,source.overflow,CASE WHEN (SELECT count(*) FROM prepared_payload)=1 AND ${octets("(SELECT raw_prepared FROM prepared_payload)")}<=16384 THEN (SELECT raw_prepared FROM prepared_payload) ELSE NULL END AS prepared_json,CASE WHEN (SELECT count(*) FROM prepared_payload)>1 OR EXISTS(SELECT 1 FROM prepared_payload WHERE raw_prepared IS NULL OR ${octets("raw_prepared")}>16384) THEN 1 ELSE 0 END AS prepared_overflow FROM source) SELECT snapshot_json,overflow,prepared_json,prepared_overflow FROM combined`;
export const PREPARED_SOURCE_ADMISSION_SQL = `WITH current_source AS MATERIALIZED (${PREPARED_SOURCE_SQL}) INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id) SELECT ?1,?13,'access',?14,?5,?3,?4,?2 WHERE EXISTS(SELECT 1 FROM current_source WHERE overflow=0 AND prepared_overflow=0 AND snapshot_json=?11 AND prepared_json=?12) RETURNING request_id`;
if (
  [PREPARED_SOURCE_SQL, PREPARED_SOURCE_ADMISSION_SQL].some(
    (sql) => bytes(sql) > PREPARED_SOURCE_LIMITS.sqlBytes,
  )
)
  throw Error("prepared_source_sql_budget");
const fail = (code = "prepared_unavailable", status = 409) => {
  throw new LibraryError(code, status);
};
const exact = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const int = (value, minimum = 0) =>
  Number.isSafeInteger(value) && value >= minimum;
const HASH = /^[a-f0-9]{64}$/;
const v2Names = [
  "STORAGE_MODE",
  "STORAGE_WRITE_MODE",
  "TRIAL_BOOKS",
  "TRIAL_R2_ACCOUNT_ID",
  "TRIAL_R2_BUCKET",
  "TRIAL_TARGET_SHA256",
];
/** An incomplete v2 environment must never select the legacy reader. */
export const hasPreparedV2Configuration = (env) =>
  v2Names.some((key) => Object.hasOwn(env, key));
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new LibraryError("prepared_service_unavailable", 503)),
          PREPARED_SOURCE_LIMITS.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function admissionError(error) {
  if (error instanceof LibraryError) throw error;
  const message = String(error?.message || "");
  if (/library_session_invalid/.test(message))
    fail("authentication_required", 401);
  if (/library_file_unavailable/.test(message))
    fail("prepared_access_changed", 401);
  if (/count<=max_count|count <= max_count/.test(message))
    fail("rate_limited", 429);
  fail("prepared_service_unavailable", 503);
}

/** Internal capability captured once for the complete prepared read lifecycle. */
export function capturePreparedSource(env, context, session, bookId, selected) {
  const configuration = storageReadConfiguration(env);
  if (
    !configuration.preparedEnabled ||
    context.scope !== configuration.scope ||
    context.origin !== configuration.origin
  )
    fail("prepared_unconfigured", 503);
  const database = env.DB,
    withSession = database.withSession,
    binding = env.PREPARED_BOOKS,
    head = binding.head,
    get = binding.get;
  context = Object.freeze({
    scope: context.scope,
    origin: context.origin,
    ip: context.ip,
  });
  session = Object.freeze({
    session_hash: session.session_hash,
    generation: session.generation,
  });
  selected = Object.freeze({ ...selected });
  const assert = () => assertStorageReadConfiguration(env, configuration);
  const primary = () => {
    assert();
    const db = withSession.call(database, "first-primary");
    if (!db || typeof db.prepare !== "function")
      fail("prepared_service_unavailable", 503);
    return db;
  };
  const input = (nowMs) => ({
    scope: context.scope,
    fileId: selected.fileId,
    sessionHash: session.session_hash,
    generation: session.generation,
    nowMs,
    origin: context.origin,
  });
  const parameters = (nowMs) => [
    ...confirmedSourceProjection(configuration, input(nowMs)).parameters,
    context.scope,
    bookId,
    selected.fileId,
    selected.versionHash,
  ];
  const execute = async (sql, values, method = "first") => {
    const db = primary(),
      prepare = db.prepare,
      query = prepare.call(db, sql),
      bind = query?.bind;
    if (typeof bind !== "function") fail("prepared_service_unavailable", 503);
    const statement = bind.call(query, ...values),
      operation = statement?.[method];
    if (typeof operation !== "function")
      fail("prepared_service_unavailable", 503);
    const unchanged = () => {
      assert();
      if (
        db.prepare !== prepare ||
        query.bind !== bind ||
        statement[method] !== operation
      )
        fail("prepared_access_changed", 401);
    };
    let result;
    try {
      result = await bounded(() => {
        unchanged();
        return operation.call(statement);
      });
    } catch (error) {
      unchanged();
      throw error;
    }
    unchanged();
    return result;
  };
  const read = async () => {
    const now = Date.now();
    let observation;
    try {
      observation = await execute(PREPARED_SOURCE_SQL, parameters(now));
    } catch (error) {
      assert();
      throw error instanceof LibraryError
        ? error
        : new LibraryError("prepared_service_unavailable", 503);
    }
    assert();
    if (
      !exact(observation, [
        "snapshot_json",
        "overflow",
        "prepared_json",
        "prepared_overflow",
      ]) ||
      ![0, 1].includes(observation.prepared_overflow) ||
      observation.prepared_overflow !== 0 ||
      bytes(JSON.stringify(observation)) > PREPARED_SOURCE_LIMITS.responseBytes
    )
      fail("prepared_service_unavailable", 503);
    const source = decodePreparedNormalSource(
      configuration,
      {
        snapshot_json: observation.snapshot_json,
        overflow: observation.overflow,
      },
      input(Date.now()),
      bookId,
    );
    if (observation.prepared_json === null) fail();
    if (
      typeof observation.prepared_json !== "string" ||
      bytes(observation.prepared_json) > PREPARED_SOURCE_LIMITS.preparedBytes
    )
      fail("prepared_service_unavailable", 503);
    let row;
    try {
      row = JSON.parse(observation.prepared_json);
    } catch {
      fail("prepared_service_unavailable", 503);
    }
    if (!exact(row, COLUMNS)) fail("prepared_service_unavailable", 503);
    const numberFields = [
      "chunk_count",
      "text_bytes",
      "codepoint_count",
      "created_at",
      "management_version",
      "original_size_bytes",
      "original_version",
      "actual_chunk_count",
    ];
    if (
      COLUMNS.some(
        (key) => !numberFields.includes(key) && typeof row[key] !== "string",
      ) ||
      numberFields.some(
        (key) => !int(row[key], key === "management_version" ? 0 : 1),
      ) ||
      row.scope !== context.scope ||
      row.file_id !== selected.fileId ||
      row.book_id !== bookId ||
      row.version_hash !== selected.versionHash ||
      !["PDF", "EPUB"].includes(row.format) ||
      !HASH.test(row.package_sha256) ||
      !HASH.test(row.index_sha256) ||
      row.text_reservation_id.length < 1 ||
      row.text_reservation_id.length > 100 ||
      row.text_logical_key !==
        `prepared-text:${context.scope}:${selected.fileId}:${selected.versionHash}` ||
      row.identity_json !== source.authorityIdentityJson ||
      row.original_descriptor_json !== source.originalDescriptorJson ||
      row.management_version !== source.catalogFacts.managementVersion ||
      row.original_etag !== source.file.etag ||
      row.original_object_key !== source.file.object_key ||
      row.original_sha256 !== source.file.sha256 ||
      row.original_size_bytes !== source.file.size_bytes ||
      row.original_format !== source.file.format ||
      row.original_version !== source.file.version ||
      row.source_sha256 !== source.file.sha256 ||
      row.format !== source.file.format
    )
      fail();
    if (row.actual_chunk_count !== row.chunk_count)
      fail("prepared_index_mismatch");
    return Object.freeze({
      row: Object.freeze(row),
      source,
      snapshotJson: observation.snapshot_json,
      preparedJson: observation.prepared_json,
    });
  };
  const admit = async (initial) => {
    const requestId = randomKey(),
      now = Date.now();
    let result;
    try {
      result = await execute(PREPARED_SOURCE_ADMISSION_SQL, [
        ...parameters(now),
        initial.snapshotJson,
        initial.preparedJson,
        requestId,
        context.ip,
      ]);
    } catch (error) {
      assert();
      admissionError(error);
    }
    assert();
    if (
      !exact(result, ["request_id"]) ||
      result.request_id !== requestId ||
      bytes(JSON.stringify(result)) > PREPARED_SOURCE_LIMITS.responseBytes
    )
      fail("prepared_access_changed", 401);
  };
  return Object.freeze({
    assert,
    read,
    admit,
    all: (sql, values) => execute(sql, values, "all"),
    store: Object.freeze({
      async head(key) {
        assert();
        const result = await head.call(binding, key);
        assert();
        return result;
      },
      async get(key, options) {
        assert();
        const result = await get.call(binding, key, options);
        try {
          assert();
        } catch (error) {
          try {
            void Promise.resolve(result?.body?.cancel()).catch(() => {});
          } catch {}
          throw error;
        }
        return result;
      },
    }),
  });
}
