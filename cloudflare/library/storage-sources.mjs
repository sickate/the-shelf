/** Fixed-project dual-source reads. No controller wiring, writes, discovery or retries. */
import { LibraryError } from "./security.mjs";
import {
  normalizedEtag,
  THRESHOLD,
  mergePublicBook,
  validateMetadataFields,
  safeId,
} from "./core.mjs";
import { decodeTrialRecord } from "./trial-record.mjs";
import {
  storageDeploymentContract,
  validateStorageDatabaseSchema,
  STORAGE_DATABASE_SCHEMA_SQL,
} from "../../shared/storage-deployment-contract.mjs";

export const STORAGE_SOURCE_LIMITS = Object.freeze({
  sqlBytes: 16_384,
  parameters: 6,
  guardParameters: 7,
  admissionParameters: 9,
  rawCandidates: 2,
  candidateQueryLimit: 3,
  descriptorBytes: 4096,
  identityBytes: 2048,
  trialTargetBytes: 256,
  catalogBytes: 262_144,
  snapshotBytes: 524_224,
  responseBytes: 1_048_576,
  timeoutMs: 30_000,
});
export const STORAGE_BOOK_PROJECTION_LIMITS = Object.freeze({
  books: 100,
  rawCandidates: 20_000,
  candidateQueryLimit: 20_001,
  responseBytes: STORAGE_SOURCE_LIMITS.responseBytes,
  metadataBytes: 32_768,
});
const NORMAL = "the-shelf-books",
  TRIAL = "the-shelf-first-book-20261023";
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const HASH = /^[a-f0-9]{64}$/,
  ID = /^[A-Za-z0-9_-]{1,100}$/;
const FORMATS = ["PDF", "EPUB", "MOBI", "AZW", "AZW3"];
const encoder = new TextEncoder();
const configurations = new WeakMap(),
  grants = new WeakMap();
const fail = (code = "file_unavailable", status = 409) => {
  throw new LibraryError(code, status);
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
};
const bytes = (text) => encoder.encode(text).byteLength;
const integer = (n, minimum = 0) => Number.isSafeInteger(n) && n >= minimum;
const textId = (value) => typeof value === "string" && ID.test(value);
const hash = (value) => typeof value === "string" && HASH.test(value);
function keys(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value),
    names = Reflect.ownKeys(descriptors);
  return names.every(
    (name) =>
      typeof name === "string" &&
      descriptors[name].enumerable &&
      Object.hasOwn(descriptors[name], "value"),
  )
    ? names
    : null;
}
const exact = (value, names) => {
  const actual = keys(value);
  return (
    actual !== null &&
    actual.length === names.length &&
    actual.every((name) => names.includes(name))
  );
};
const safeJson = (text, maximum) => {
  if (typeof text !== "string" || bytes(text) > maximum)
    fail("service_unavailable", 503);
  try {
    return JSON.parse(text);
  } catch {
    fail("service_unavailable", 503);
  }
};

function storeMethods(binding) {
  if (
    !binding ||
    typeof binding.head !== "function" ||
    typeof binding.get !== "function"
  )
    fail("files_unconfigured", 503);
  return { binding, head: binding.head, get: binding.get };
}
/** Secret names may be retained in env; their values are never read here. */
export function storageReadConfiguration(env) {
  if (
    !env ||
    env.APP_SCOPE !== "production" ||
    env.SITE_ORIGIN !== ORIGIN ||
    env.STORAGE_MODE !== "authority-v2" ||
    env.STORAGE_WRITE_MODE !== "closed" ||
    typeof env.R2_ACCOUNT_ID !== "string" ||
    !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID) ||
    env.R2_BUCKET !== NORMAL ||
    env.TRIAL_R2_ACCOUNT_ID !== env.R2_ACCOUNT_ID ||
    env.TRIAL_R2_BUCKET !== TRIAL ||
    !hash(env.TRIAL_TARGET_SHA256) ||
    env.FILENAME_AI_MODE !== "filename-v1" ||
    [
      "SINGLE_TRIAL_MODE",
      "SINGLE_TRIAL_TARGET_SHA256",
      "NORMAL_UPLOAD_MODE",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ].some((name) => Object.hasOwn(env, name)) ||
    !env.DB ||
    typeof env.DB.withSession !== "function"
  )
    fail("files_unconfigured", 503);
  const normal = storeMethods(env.BOOKS),
    trial = storeMethods(env.TRIAL_BOOKS);
  if (normal.binding === trial.binding) fail("files_unconfigured", 503);
  const preparedNames = [
    "PREPARED_TEXT_MODE",
    "PREPARED_R2_ACCOUNT_ID",
    "PREPARED_R2_BUCKET",
    "PREPARED_BOOKS",
  ];
  const preparedCount = preparedNames.filter((name) =>
    Object.hasOwn(env, name),
  ).length;
  if (preparedCount !== 0 && preparedCount !== preparedNames.length)
    fail("files_unconfigured", 503);
  let prepared = null;
  if (preparedCount) {
    if (
      env.PREPARED_TEXT_MODE !== "registry-v1" ||
      env.PREPARED_R2_ACCOUNT_ID !== env.R2_ACCOUNT_ID ||
      env.PREPARED_R2_BUCKET !== NORMAL
    )
      fail("files_unconfigured", 503);
    prepared = storeMethods(env.PREPARED_BOOKS);
  }
  const result = freeze({
    mode: "authority-v2",
    writeGate: "closed",
    scope: "production",
    origin: ORIGIN,
    normalTarget: { accountId: env.R2_ACCOUNT_ID, bucket: NORMAL },
    trialTarget: {
      accountId: env.R2_ACCOUNT_ID,
      bucket: TRIAL,
      targetSha256: env.TRIAL_TARGET_SHA256,
    },
    preparedEnabled: prepared !== null,
  });
  configurations.set(result, {
    normal,
    trial,
    prepared,
    database: env.DB,
    databaseSession: env.DB.withSession,
    fingerprint: JSON.stringify(result),
  });
  return result;
}
function configurationState(configuration) {
  const state = configurations.get(configuration);
  if (!state) fail("files_unconfigured", 503);
  return state;
}
function unchangedConfiguration(env, configuration) {
  const previous = configurationState(configuration),
    next = storageReadConfiguration(env),
    current = configurationState(next);
  if (
    previous.fingerprint !== current.fingerprint ||
    previous.database !== current.database ||
    previous.databaseSession !== current.databaseSession ||
    ["normal", "trial", "prepared"].some(
      (name) =>
        previous[name]?.binding !== current[name]?.binding ||
        previous[name]?.head !== current[name]?.head ||
        previous[name]?.get !== current[name]?.get,
    )
  )
    fail("file_changed", 409);
  return previous;
}
/** Recheck captured bindings and methods without exposing them or reading data. */
export function assertStorageReadConfiguration(env, configuration) {
  unchangedConfiguration(env, configuration);
}

// These field lists and SQL expressions are fixed source, never caller-controlled SQL.
const fields = Object.freeze({
  file: [
    "scope",
    "file_id",
    "book_id",
    "format",
    "size_bytes",
    "object_key",
    "sha256",
    "etag",
    "state",
    "version",
    "updated_at",
  ],
  registry: [
    "logical_key",
    "reservation_id",
    "descriptor_json",
    "etag",
    "enabled",
  ],
  reservation: [
    "reservation_id",
    "logical_key",
    "object_key",
    "descriptor_json",
    "size_bytes",
    "state",
    "put_attempted",
    "content_verified",
    "etag",
    "created_at",
    "updated_at",
  ],
  trial: [
    "id",
    "permit_id",
    "consent_id",
    "authority_identity_json",
    "target_json",
    "descriptor_json",
    "isolated_target_config_sha256",
    "size_bytes",
    "issued_at",
    "expires_at",
    "state",
    "put_attempted",
    "content_verified",
    "etag",
    "updated_at",
  ],
  management: [
    "scope",
    "book_id",
    "visibility",
    "trashed",
    "version",
    "updated_at",
  ],
  session: [
    "scope",
    "session_hash",
    "generation",
    "created_at",
    "expires_at",
    "revoked",
  ],
});
const jsonRow = (alias, names) =>
  `json_object(${names.map((name) => `'${name}',${alias}.${name}`).join(",")})`;
const octets = (expr) => `length(CAST(${expr} AS BLOB))`;
const base = `WITH input(scope,file_id,session_hash,generation,now_ms,origin) AS (VALUES(?,?,?,?,?,?)),
 schema_rows AS MATERIALIZED (${STORAGE_DATABASE_SCHEMA_SQL}),
 normal_raw AS MATERIALIZED (SELECT f.* FROM file_registry f,input i WHERE f.scope=i.scope AND f.file_id=i.file_id AND f.state='confirmed'),
 trial_raw AS MATERIALIZED (SELECT t.* FROM shelf_storage_single_trial t,input i WHERE t.state='confirmed' AND json_extract(t.descriptor_json,'$.scope')=i.scope AND json_extract(t.descriptor_json,'$.fileId')=i.file_id),
 raw_candidates AS MATERIALIZED (SELECT 'normal' AS source,f.book_id FROM normal_raw f UNION ALL SELECT 'trial',json_extract(t.descriptor_json,'$.bookId') FROM trial_raw t LIMIT 3),
 chosen AS (SELECT source,book_id FROM raw_candidates WHERE (SELECT count(*) FROM raw_candidates)=1),
 normal_facts AS MATERIALIZED (SELECT ${jsonRow("f", fields.file)} AS file_json,
 CASE WHEN g.logical_key IS NULL THEN NULL ELSE ${jsonRow("g", fields.registry)} END AS registry_json,
 CASE WHEN r.reservation_id IS NULL THEN NULL ELSE ${jsonRow("r", fields.reservation)} END AS reservation_json,
 g.descriptor_json AS g_descriptor,r.descriptor_json AS r_descriptor
 FROM normal_raw f LEFT JOIN shelf_storage_original_registry g ON g.logical_key=('original:'||f.scope||':'||f.file_id||':original') LEFT JOIN shelf_storage_reservations r ON r.reservation_id=g.reservation_id),
 catalog AS MATERIALIZED (SELECT b.public_json FROM chosen c JOIN catalog_books b ON b.scope=(SELECT scope FROM input) AND b.book_id=c.book_id),
 management AS MATERIALIZED (SELECT m.* FROM chosen c JOIN book_management m ON m.scope=(SELECT scope FROM input) AND m.book_id=c.book_id),
 live_session AS MATERIALIZED (SELECT s.*,a.origin AS auth_origin,a.generation AS auth_generation,a.updated_at AS auth_updated_at FROM sessions s JOIN auth_config a ON a.scope=s.scope,input i WHERE s.scope=i.scope AND s.session_hash=i.session_hash AND s.generation=i.generation AND s.revoked=0 AND s.expires_at>i.now_ms AND a.enabled=1 AND a.generation=s.generation AND a.origin=i.origin AND a.scheme='owner-access-key-v1'),
 bounded AS MATERIALIZED (SELECT
 EXISTS(SELECT 1 FROM normal_facts WHERE ${octets("g_descriptor")}>4096 OR ${octets("r_descriptor")}>4096)
 OR EXISTS(SELECT 1 FROM trial_raw WHERE ${octets("descriptor_json")}>4096 OR ${octets("authority_identity_json")}>2048 OR ${octets("target_json")}>256)
 OR EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND ${octets("identity_json")}>2048)
 OR EXISTS(SELECT 1 FROM catalog WHERE ${octets("public_json")}>262144) AS overflow),
 projected AS MATERIALIZED (SELECT CASE WHEN bounded.overflow THEN NULL ELSE json_object(
 'schema',json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM schema_rows ORDER BY type,name))),
 'raw_count',(SELECT count(*) FROM raw_candidates),
 'authority',json((SELECT json_object('identity_json',identity_json,'phase',phase) FROM shelf_storage_authority WHERE id=1)),
 'normal',json((SELECT json_group_array(json_object('file',json(file_json),'registry',json(registry_json),'reservation',json(reservation_json))) FROM normal_facts)),
 'trial',json((SELECT json_group_array(${jsonRow("t", fields.trial)}) FROM trial_raw t)),
 'catalog_json',(SELECT public_json FROM catalog),
 'management',json((SELECT ${jsonRow("m", fields.management)} FROM management m)),
 'session',json((SELECT json_object('session',json(${jsonRow("s", fields.session)}),'auth_origin',auth_origin,'auth_generation',auth_generation,'auth_updated_at',auth_updated_at) FROM live_session s))
 ) END AS raw_snapshot FROM bounded)`;
export const STORAGE_SOURCE_SQL = `${base} SELECT CASE WHEN ${octets("raw_snapshot")}<=524224 THEN raw_snapshot ELSE NULL END AS snapshot_json,CASE WHEN raw_snapshot IS NULL OR ${octets("raw_snapshot")}>524224 THEN 1 ELSE 0 END AS overflow FROM projected`;
export const STORAGE_SOURCE_GUARD_SQL = `${base} SELECT 1 AS unchanged FROM projected WHERE raw_snapshot IS NOT NULL AND ${octets("raw_snapshot")}<=524224 AND raw_snapshot=?`;
if (
  bytes(STORAGE_SOURCE_SQL) > STORAGE_SOURCE_LIMITS.sqlBytes ||
  bytes(STORAGE_SOURCE_GUARD_SQL) > STORAGE_SOURCE_LIMITS.sqlBytes
)
  throw Error("storage_source_sql_budget");

function selection(configuration, input) {
  configurationState(configuration);
  if (
    !exact(input, [
      "scope",
      "fileId",
      "sessionHash",
      "generation",
      "nowMs",
      "origin",
    ]) ||
    input.scope !== configuration.scope ||
    input.origin !== configuration.origin ||
    !textId(input.fileId) ||
    !hash(input.sessionHash) ||
    !integer(input.generation, 1) ||
    !integer(input.nowMs)
  )
    fail("file_unavailable", 409);
  return [
    input.scope,
    input.fileId,
    input.sessionHash,
    input.generation,
    input.nowMs,
    input.origin,
  ];
}
export function confirmedSourceProjection(configuration, input) {
  return freeze({
    sql: STORAGE_SOURCE_SQL,
    parameters: selection(configuration, input),
  });
}
function requestSelection(configuration, context, session, fileId, nowMs) {
  if (!keys(context) || !keys(session)) fail("authentication_required", 401);
  const input = {
    scope: context.scope,
    fileId,
    sessionHash: session.session_hash,
    generation: session.generation,
    nowMs,
    origin: context.origin,
  };
  selection(configuration, input);
  return input;
}
const discard = (value) => {
  try {
    void Promise.resolve(value?.body?.cancel()).catch(() => {});
  } catch {}
};
async function deadline(operation, discardLate = false) {
  let timer,
    expired = false;
  const work = Promise.resolve()
    .then(operation)
    .then((value) => {
      if (expired && discardLate) discard(value);
      return value;
    });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new LibraryError("service_unavailable", 503));
    }, STORAGE_SOURCE_LIMITS.timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
async function readSnapshot(env, configuration, input) {
  const configured = unchangedConfiguration(env, configuration);
  const projection = confirmedSourceProjection(configuration, input);
  let result;
  try {
    result = await deadline(() => {
      const primary = configured.databaseSession.call(
        configured.database,
        "first-primary",
      );
      if (!primary || typeof primary.prepare !== "function")
        fail("service_unavailable", 503);
      return primary
        .prepare(projection.sql)
        .bind(...projection.parameters)
        .first();
    });
  } catch {
    fail("service_unavailable", 503);
  }
  unchangedConfiguration(env, configuration);
  if (
    !exact(result, ["snapshot_json", "overflow"]) ||
    (result.overflow !== 0 && result.overflow !== 1)
  )
    fail("service_unavailable", 503);
  if (
    result.overflow !== 0 ||
    typeof result.snapshot_json !== "string" ||
    bytes(JSON.stringify(result)) > STORAGE_SOURCE_LIMITS.responseBytes
  )
    fail("service_unavailable", 503);
  return {
    raw: result.snapshot_json,
    snapshot: safeJson(
      result.snapshot_json,
      STORAGE_SOURCE_LIMITS.snapshotBytes,
    ),
  };
}
function contractForSnapshot(snapshot, configuration) {
  if (
    !exact(snapshot.authority, ["identity_json", "phase"]) ||
    !["imported", "ready"].includes(snapshot.authority.phase)
  )
    fail("service_unavailable", 503);
  const identity = safeJson(
    snapshot.authority.identity_json,
    STORAGE_SOURCE_LIMITS.identityBytes,
  );
  try {
    const contract = storageDeploymentContract({
      profile: "authority-v2-closed",
      identity,
      filenameAi: true,
      preparedText: configuration.preparedEnabled,
      retainedSecrets: "trial-retained-filename-v1",
      trialTargetSha256: configuration.trialTarget.targetSha256,
    });
    if (contract.identity.accountId !== configuration.normalTarget.accountId)
      fail("service_unavailable", 503);
    return contract;
  } catch {
    fail("service_unavailable", 503);
  }
}
function snapshotHeader(snapshot, configuration) {
  const contract = contractForSnapshot(snapshot, configuration);
  try {
    return {
      contract,
      schema: validateStorageDatabaseSchema(snapshot.schema, contract),
    };
  } catch {
    fail("service_unavailable", 503);
  }
}
function normalRecord(facts, configuration) {
  if (
    !exact(facts, ["file", "registry", "reservation"]) ||
    !exact(facts.file, fields.file) ||
    !exact(facts.registry, fields.registry) ||
    !exact(facts.reservation, fields.reservation)
  )
    fail();
  const f = facts.file,
    g = facts.registry,
    r = facts.reservation;
  const d = safeJson(g.descriptor_json, STORAGE_SOURCE_LIMITS.descriptorBytes);
  if (
    !exact(d, [
      "kind",
      "scope",
      "fileId",
      "bookId",
      "format",
      "sizeBytes",
      "sha256",
      "objectKey",
      "versionHash",
      "source",
    ]) ||
    d.kind !== "original" ||
    d.scope !== configuration.scope ||
    !textId(d.fileId) ||
    !textId(d.bookId) ||
    !FORMATS.includes(d.format) ||
    !integer(d.sizeBytes, 1) ||
    d.sizeBytes > THRESHOLD ||
    !hash(d.sha256) ||
    d.versionHash !== null ||
    d.source !== null ||
    d.objectKey !==
      `books/cf03/${d.fileId}/${d.sha256}.${d.format.toLowerCase()}`
  )
    fail();
  const logical = `original:${d.scope}:${d.fileId}:original`;
  if (
    f.scope !== d.scope ||
    f.file_id !== d.fileId ||
    f.book_id !== d.bookId ||
    f.format !== d.format ||
    f.size_bytes !== d.sizeBytes ||
    f.object_key !== d.objectKey ||
    f.sha256 !== d.sha256 ||
    f.state !== "confirmed" ||
    !integer(f.version, 1) ||
    !integer(f.updated_at) ||
    !normalizedEtag(f.etag) ||
    g.enabled !== 1 ||
    g.logical_key !== logical ||
    typeof g.reservation_id !== "string" ||
    g.reservation_id.length < 1 ||
    g.reservation_id.length > 100 ||
    g.etag !== f.etag ||
    r.reservation_id !== g.reservation_id ||
    r.logical_key !== logical ||
    r.object_key !== d.objectKey ||
    r.descriptor_json !== g.descriptor_json ||
    r.size_bytes !== d.sizeBytes ||
    r.state !== "confirmed" ||
    r.put_attempted !== 1 ||
    r.content_verified !== 1 ||
    r.etag !== f.etag ||
    !integer(r.created_at) ||
    !integer(r.updated_at) ||
    r.updated_at < r.created_at
  )
    fail();
  return { descriptor: d, file: f, sourceVersion: f.version };
}
function catalogBook(catalogJson) {
  const book = safeJson(catalogJson, STORAGE_SOURCE_LIMITS.catalogBytes);
  if (!keys(book) || !Array.isArray(book.files)) fail();
  const files = new Map();
  for (const file of book.files) {
    if (!file || typeof file !== "object" || typeof file.id !== "string")
      continue;
    const matches = files.get(file.id) || [];
    matches.push(file);
    files.set(file.id, matches);
  }
  return { book, files };
}
function catalogManagement(m, scope, bookId, allowTrash = false) {
  if (
    m !== null &&
    (!exact(m, fields.management) ||
      m.scope !== scope ||
      m.book_id !== bookId ||
      !["public", "private"].includes(m.visibility) ||
      ![0, 1].includes(m.trashed) ||
      (!allowTrash && m.trashed !== 0) ||
      !integer(m.version, 1) ||
      !integer(m.updated_at))
  )
    fail();
  return {
    management: m,
    managementVersion: m?.version ?? 0,
    visibility: m?.visibility ?? "public",
  };
}
function catalogAttribution(catalog, management, descriptor, source) {
  if (catalog.book.id !== descriptor.bookId) fail();
  const matches = catalog.files.get(descriptor.fileId) || [];
  if (matches.length !== 1) fail();
  const file = matches[0];
  if (
    !exact(file, [
      "id",
      "format",
      "sizeBytes",
      "status",
      "reason",
      "visibility",
      "readable",
    ]) ||
    file.format !== descriptor.format ||
    file.sizeBytes !== descriptor.sizeBytes ||
    file.status !== "candidate" ||
    file.visibility !== "private" ||
    typeof file.readable !== "boolean" ||
    !(file.reason === null || typeof file.reason === "string") ||
    ((source === "trial" || ["PDF", "EPUB"].includes(descriptor.format)) &&
      file.readable !== true)
  )
    fail();
  // For normal Kindle originals, readable=false is the existing browser-format
  // capability flag, not a denial of the owner's access to the original bytes.
  return { file, ...management };
}
function catalogFacts(snapshot, descriptor, source) {
  const catalog = catalogBook(snapshot.catalog_json),
    management = catalogManagement(
      snapshot.management,
      descriptor.scope,
      descriptor.bookId,
    );
  return catalogAttribution(catalog, management, descriptor, source);
}
function confirmedRecord(snapshot, configuration) {
  if (snapshot.normal.length === 1) {
    const facts = snapshot.normal[0];
    for (const text of [
      facts?.registry?.descriptor_json,
      facts?.reservation?.descriptor_json,
    ])
      if (
        typeof text === "string" &&
        bytes(text) > STORAGE_SOURCE_LIMITS.descriptorBytes
      )
        fail("service_unavailable", 503);
    return { source: "normal", record: normalRecord(facts, configuration) };
  }
  const row = snapshot.trial[0];
  for (const [name, limit] of [
    ["descriptor_json", STORAGE_SOURCE_LIMITS.descriptorBytes],
    ["authority_identity_json", STORAGE_SOURCE_LIMITS.identityBytes],
    ["target_json", STORAGE_SOURCE_LIMITS.trialTargetBytes],
  ])
    if (typeof row?.[name] === "string" && bytes(row[name]) > limit)
      fail("service_unavailable", 503);
  const decoded = decodeTrialRecord(row, {
    accountId: configuration.trialTarget.accountId,
    targetSha256: configuration.trialTarget.targetSha256,
  });
  if (decoded.row.authority_identity_json !== snapshot.authority.identity_json)
    fail();
  return {
    source: "trial",
    record: {
      descriptor: decoded.descriptor,
      file: decoded.file,
      sourceVersion: decoded.row.updated_at,
    },
  };
}
function projectionMetadata(row, scope, bookId) {
  if (row === null) return { patch: {}, metadataVersion: 0 };
  if (
    !exact(row, ["scope", "book_id", "patch_json", "version"]) ||
    row.scope !== scope ||
    row.book_id !== bookId ||
    !integer(row.version, 1)
  )
    fail("service_unavailable", 503);
  const patch = safeJson(
      row.patch_json,
      STORAGE_BOOK_PROJECTION_LIMITS.metadataBytes,
    ),
    names = keys(patch);
  if (names === null) fail("service_unavailable", 503);
  const fields = Object.fromEntries(
    names
      .filter((name) => name !== "categoryId")
      .map((name) => [name, patch[name]]),
  );
  try {
    // Reuse the writer's safety checks, but preserve the persisted values.
    // Reading metadata does not trim strings or deduplicate imported tags.
    if (Object.keys(fields).length) validateMetadataFields(fields);
    if (Object.hasOwn(patch, "categoryId") && !safeId(patch.categoryId))
      fail("service_unavailable", 503);
  } catch {
    fail("service_unavailable", 503);
  }
  return { patch, metadataVersion: row.version };
}
function decodeSnapshot(snapshot, configuration, input, expectedBookId) {
  if (
    !exact(snapshot, [
      "schema",
      "raw_count",
      "authority",
      "normal",
      "trial",
      "catalog_json",
      "management",
      "session",
    ])
  )
    fail("service_unavailable", 503);
  const { contract, schema } = snapshotHeader(snapshot, configuration);
  if (!snapshot.session) fail("authentication_required", 401);
  const current = snapshot.session;
  if (
    !exact(current, [
      "session",
      "auth_origin",
      "auth_generation",
      "auth_updated_at",
    ]) ||
    !exact(current.session, fields.session) ||
    current.session.scope !== input.scope ||
    current.session.session_hash !== input.sessionHash ||
    current.session.generation !== input.generation ||
    current.session.revoked !== 0 ||
    !integer(current.session.created_at) ||
    !integer(current.session.expires_at) ||
    current.session.expires_at <= input.nowMs ||
    current.session.expires_at <= current.session.created_at ||
    current.session.expires_at > current.session.created_at + 86_400_000 ||
    current.auth_origin !== input.origin ||
    current.auth_generation !== input.generation ||
    !integer(current.auth_updated_at)
  )
    fail("authentication_required", 401);
  if (
    !Array.isArray(snapshot.normal) ||
    !Array.isArray(snapshot.trial) ||
    !integer(snapshot.raw_count) ||
    snapshot.raw_count !== snapshot.normal.length + snapshot.trial.length ||
    snapshot.raw_count > STORAGE_SOURCE_LIMITS.rawCandidates
  )
    fail("service_unavailable", 503);
  // Conflict is checked before source-specific decoders, catalog or expectedBookId.
  if (snapshot.raw_count !== 1) fail();
  const { record, source } = confirmedRecord(snapshot, configuration);
  if (
    record.descriptor.fileId !== input.fileId ||
    record.descriptor.scope !== input.scope ||
    (expectedBookId !== undefined &&
      expectedBookId !== record.descriptor.bookId)
  )
    fail();
  const catalog = catalogFacts(snapshot, record.descriptor, source);
  return {
    source,
    target:
      source === "normal"
        ? configuration.normalTarget
        : configuration.trialTarget,
    ...record,
    etag: normalizedEtag(record.file.etag),
    authorityIdentity: contract.identity,
    schemaProfile: schema.profile,
    catalogFacts: catalog,
    sessionFacts: current,
  };
}

/** Pure prepared-original proof. This result never receives a read-grant brand. */
export function decodePreparedNormalSource(
  configuration,
  observation,
  input,
  expectedBookId,
) {
  selection(configuration, input);
  if (!textId(expectedBookId)) fail();
  if (
    !exact(observation, ["snapshot_json", "overflow"]) ||
    observation.overflow !== 0 ||
    typeof observation.snapshot_json !== "string" ||
    bytes(observation.snapshot_json) > STORAGE_SOURCE_LIMITS.snapshotBytes ||
    bytes(JSON.stringify(observation)) > STORAGE_SOURCE_LIMITS.responseBytes
  )
    fail("service_unavailable", 503);
  const snapshot = safeJson(
    observation.snapshot_json,
    STORAGE_SOURCE_LIMITS.snapshotBytes,
  );
  const record = decodeSnapshot(snapshot, configuration, input, expectedBookId);
  if (record.source !== "normal") fail();
  return freeze({
    ...record,
    originalDescriptorJson: snapshot.normal[0].registry.descriptor_json,
    authorityIdentityJson: snapshot.authority.identity_json,
  });
}

/** Pure bounded page facts. These are display records, never branded read grants. */
export function decodeStorageBookProjection(
  configuration,
  observation,
  options,
) {
  configurationState(configuration);
  if (
    !exact(options, ["audience", "allowTrash"]) ||
    !["owner", "anonymous"].includes(options.audience) ||
    typeof options.allowTrash !== "boolean" ||
    (options.audience === "anonymous" && options.allowTrash) ||
    !exact(observation, ["projection_json", "overflow"]) ||
    observation.overflow !== 0 ||
    typeof observation.projection_json !== "string" ||
    bytes(observation.projection_json) >
      STORAGE_BOOK_PROJECTION_LIMITS.responseBytes ||
    bytes(JSON.stringify(observation)) >
      STORAGE_BOOK_PROJECTION_LIMITS.responseBytes
  )
    fail("service_unavailable", 503);
  const projection = safeJson(
    observation.projection_json,
    STORAGE_BOOK_PROJECTION_LIMITS.responseBytes,
  );
  if (
    !exact(projection, ["header", "books", "sources"]) ||
    !exact(projection.header, ["schema", "authority"]) ||
    !Array.isArray(projection.books) ||
    projection.books.length > STORAGE_BOOK_PROJECTION_LIMITS.books ||
    !Array.isArray(projection.sources) ||
    projection.sources.length > STORAGE_BOOK_PROJECTION_LIMITS.rawCandidates
  )
    fail("service_unavailable", 503);
  snapshotHeader(projection.header, configuration);

  // Finish every raw-count check before decoding any record or catalog. The
  // fixed caller SQL must obtain these candidates globally by scope/file_id.
  const sourceIds = new Set();
  let candidates = 0,
    conflict = false;
  for (const group of projection.sources) {
    if (
      !exact(group, ["scope", "file_id", "raw_count", "normal", "trial"]) ||
      group.scope !== configuration.scope ||
      !textId(group.file_id) ||
      sourceIds.has(group.file_id) ||
      !Array.isArray(group.normal) ||
      !Array.isArray(group.trial) ||
      !integer(group.raw_count) ||
      group.raw_count !== group.normal.length + group.trial.length ||
      group.raw_count > STORAGE_SOURCE_LIMITS.rawCandidates
    )
      fail("service_unavailable", 503);
    sourceIds.add(group.file_id);
    candidates += group.raw_count;
    conflict ||= group.raw_count > 1;
  }
  if (candidates > STORAGE_BOOK_PROJECTION_LIMITS.rawCandidates)
    fail("service_unavailable", 503);
  if (conflict) fail();

  const books = new Map(),
    references = new Map();
  for (const row of projection.books) {
    if (
      !exact(row, [
        "scope",
        "book_id",
        "catalog_json",
        "management",
        "metadata",
      ]) ||
      row.scope !== configuration.scope ||
      !textId(row.book_id) ||
      books.has(row.book_id)
    )
      fail("service_unavailable", 503);
    const catalog = catalogBook(row.catalog_json);
    if (catalog.book.id !== row.book_id) fail();
    const management = catalogManagement(
      row.management,
      row.scope,
      row.book_id,
      true,
    );
    for (const [id, matches] of catalog.files) {
      if (!textId(id) || matches.length !== 1 || references.has(id)) fail();
      references.set(id, row.book_id);
    }
    const metadata = projectionMetadata(row.metadata, row.scope, row.book_id);
    books.set(row.book_id, { catalog, management, metadata });
  }
  for (const id of references.keys())
    if (!sourceIds.has(id)) fail("service_unavailable", 503);
  const registry = [];
  for (const group of projection.sources) {
    if (group.raw_count === 0) {
      if (!references.has(group.file_id)) fail("service_unavailable", 503);
      continue;
    }
    const { record, source } = confirmedRecord(
      { ...group, authority: projection.header.authority },
      configuration,
    );
    const d = record.descriptor,
      book = books.get(d.bookId);
    if (
      d.scope !== group.scope ||
      d.fileId !== group.file_id ||
      !book ||
      references.get(group.file_id) !== d.bookId
    )
      fail();
    catalogAttribution(book.catalog, book.management, d, source);
    registry.push({
      file_id: d.fileId,
      book_id: d.bookId,
      format: d.format,
      size_bytes: d.sizeBytes,
      state: "confirmed",
    });
  }
  const displayed = new Set(),
    bookFacts = [];
  for (const [bookId, { catalog, management, metadata }] of books) {
    const trashed = management.management?.trashed ?? 0;
    if (
      (!options.allowTrash && trashed !== 0) ||
      (options.audience === "anonymous" && management.visibility !== "public")
    )
      continue;
    displayed.add(bookId);
    bookFacts.push({
      bookId,
      visibility: management.visibility,
      trashed,
      managementVersion: management.managementVersion,
      deletedAt: trashed ? management.management.updated_at : null,
      metadataVersion: metadata.metadataVersion,
      patch: metadata.patch,
      book: mergePublicBook(
        catalog.book,
        metadata.patch,
        registry.filter((row) => row.book_id === bookId),
      ),
    });
  }
  return freeze({
    registry: registry.filter((row) => displayed.has(row.book_id)),
    books: bookFacts,
  });
}
export async function resolveConfirmedSource(
  env,
  { context, session, fileId, expectedBookId } = {},
) {
  const configuration = storageReadConfiguration(env);
  if (expectedBookId !== undefined && !textId(expectedBookId)) fail();
  const input = requestSelection(
    configuration,
    context,
    session,
    fileId,
    context?.now,
  );
  const read = await readSnapshot(env, configuration, input);
  const result = freeze(
    decodeSnapshot(read.snapshot, configuration, input, expectedBookId),
  );
  grants.set(result, {
    configuration,
    input,
    raw: read.raw,
    expectedBookId,
    operationUsed: false,
    object: null,
  });
  return result;
}
function grantState(grant) {
  const state = grants.get(grant);
  if (!state) fail();
  return state;
}
export async function assertUnchangedSourceGrant(
  env,
  grant,
  { context, session, nowMs } = {},
) {
  const state = grantState(grant);
  try {
    const input = requestSelection(
      state.configuration,
      context,
      session,
      state.input.fileId,
      nowMs,
    );
    if (
      input.scope !== state.input.scope ||
      input.origin !== state.input.origin ||
      input.sessionHash !== state.input.sessionHash ||
      input.generation !== state.input.generation
    )
      fail("file_changed", 409);
    const current = await readSnapshot(env, state.configuration, input);
    decodeSnapshot(
      current.snapshot,
      state.configuration,
      input,
      state.expectedBookId,
    );
    if (current.raw !== state.raw) fail("file_changed", 409);
  } catch (error) {
    discard(state.object);
    state.object = null;
    throw error;
  }
}
export function confirmedSourceGuard(grant, { context, session, nowMs } = {}) {
  const state = grantState(grant),
    input = requestSelection(
      state.configuration,
      context,
      session,
      state.input.fileId,
      nowMs,
    );
  if (
    input.scope !== state.input.scope ||
    input.origin !== state.input.origin ||
    input.sessionHash !== state.input.sessionHash ||
    input.generation !== state.input.generation
  )
    fail("file_changed", 409);
  return freeze({
    sql: STORAGE_SOURCE_GUARD_SQL,
    parameters: [...selection(state.configuration, input), state.raw],
  });
}
export function readSourceAdapter(env, grant) {
  const state = grantState(grant),
    configured = unchangedConfiguration(env, state.configuration);
  const store = configured[grant.source];
  const operate = (method, options) => {
    unchangedConfiguration(env, state.configuration);
    if (state.operationUsed) fail("file_unavailable", 409);
    state.operationUsed = true;
    return deadline(
      () =>
        store[method].call(
          store.binding,
          grant.descriptor.objectKey,
          ...(method === "get" ? [options] : []),
        ),
      true,
    )
      .then((object) => {
        state.object = object;
        return object;
      })
      .catch(() => fail("service_unavailable", 503));
  };
  return Object.freeze({
    head(...args) {
      if (args.length) fail();
      return operate("head");
    },
    get(options = {}) {
      if (!exact(options, []) && !exact(options, ["range"])) fail();
      const range = options.range;
      if (
        Object.hasOwn(options, "range") &&
        (!exact(range, ["offset", "length"]) ||
          !integer(range.offset) ||
          !integer(range.length, 1) ||
          range.offset + range.length > grant.descriptor.sizeBytes)
      )
        fail();
      return operate("get", {
        onlyIf: { etagMatches: grant.etag },
        ...(range ? { range: { ...range } } : {}),
      });
    },
  });
}
