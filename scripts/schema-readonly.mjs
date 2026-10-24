/** Fixed public schema data only. No environment, filesystem, database or network IO. */
import {
  DATABASE_SCHEMA_PROFILES,
  DATABASE_SCHEMA_METADATA,
  STORAGE_DATABASE_SCHEMA_SQL,
} from "../shared/storage-schema-profiles.mjs";
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export const READONLY_DATABASE_SCHEMA_SQL = STORAGE_DATABASE_SCHEMA_SQL;
export const READONLY_TABLE_COLUMNS = freeze({
  admissions: [
    "scope",
    "request_id",
    "kind",
    "ip_key",
    "created_at",
    "session_hash",
    "generation",
    "file_id",
  ],
  auth_config: [
    "scope",
    "origin",
    "scheme",
    "verifier",
    "generation",
    "enabled",
    "updated_at",
  ],
  book_management: [
    "scope",
    "book_id",
    "visibility",
    "trashed",
    "version",
    "updated_at",
  ],
  browser_uploads: [
    "upload_id",
    "scope",
    "book_id",
    "file_id",
    "sha256",
    "reservation_id",
    "descriptor_json",
    "created_at",
  ],
  catalog_books: ["scope", "book_id", "public_json"],
  catalog_import_rows: [
    "scope",
    "input_hash",
    "book_id",
    "public_json",
    "patch_json",
    "writer_token",
  ],
  catalog_imports: [
    "scope",
    "input_hash",
    "base_hash",
    "owner_token",
    "state",
    "book_count",
    "patch_count",
    "seeded_overrides",
    "started_at",
    "updated_at",
  ],
  counters: ["scope", "kind", "bucket", "window_start", "count", "max_count"],
  file_registry: [
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
  filename_identification_observations: [
    "scope",
    "request_id",
    "phase",
    "http_status",
    "elapsed_ms",
    "response_bytes",
    "response_chunks",
    "content_type",
    "request_id_present",
    "request_id_valid",
    "upstream_request_id",
    "url_matches",
    "envelope_valid",
    "model_matches",
    "usage_valid",
    "metadata_valid",
  ],
  filename_identifications: [
    "scope",
    "request_id",
    "fingerprint",
    "contract_version",
    "session_hash",
    "generation",
    "created_at",
    "deadline_at",
    "billing_day",
    "input_characters",
    "state",
    "result_json",
    "usage_json",
    "error_code",
    "updated_at",
  ],
  library_schema: ["version", "applied_at"],
  metadata_overrides: [
    "scope",
    "book_id",
    "patch_json",
    "version",
    "updated_at",
  ],
  public_state: ["scope", "revision", "base_revision", "updated_at"],
  sessions: [
    "scope",
    "session_hash",
    "generation",
    "created_at",
    "expires_at",
    "revoked",
  ],
  shelf_prepared_index_chunks: [
    "scope",
    "file_id",
    "version_hash",
    "chunk_index",
    "locator_type",
    "section_number",
    "start_offset",
    "end_offset",
    "chunk_sha256",
    "codepoints",
    "utf8_bytes",
  ],
  shelf_prepared_index_publications: [
    "scope",
    "file_id",
    "version_hash",
    "index_sha256",
    "chunk_count",
    "text_bytes",
    "codepoint_count",
  ],
  shelf_prepared_indexes: [
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
  ],
  shelf_storage_activation_receipts_v2: [
    "receipt_hash",
    "receipt_json",
    "snapshot_json",
  ],
  shelf_storage_activation_v2: [
    "id",
    "identity_json",
    "migration_hash",
    "imported_receipt_json",
    "imported_readback_hash",
    "state",
    "generation",
    "snapshot_json",
    "receipt_json",
    "receipt_hash",
    "evidence_json",
    "evidence_hash",
    "activated_at",
  ],
  shelf_storage_authority: [
    "id",
    "identity_json",
    "phase",
    "migration_hash",
    "committed_bytes",
    "reserved_bytes",
    "observed_bytes",
    "observed_at",
    "evidence_hash",
    "billing_period",
    "readback_hash",
    "receipt_json",
  ],
  shelf_storage_evidence_v2: ["evidence_hash", "evidence_json"],
  shelf_storage_legacy_freeze: [
    "id",
    "authority_id",
    "account_id",
    "bucket",
    "freeze_id",
    "frozen_at",
  ],
  shelf_storage_legacy_liabilities_v2: [
    "source_id",
    "source_hash",
    "proof_hash",
    "max_bytes",
    "class_a_max",
    "class_b_max",
  ],
  shelf_storage_original_registry: [
    "logical_key",
    "reservation_id",
    "descriptor_json",
    "etag",
    "enabled",
  ],
  shelf_storage_reservations: [
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
  shelf_storage_single_trial: [
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
  shelf_storage_sources: [
    "scope",
    "migration_hash",
    "snapshot_hash",
    "metadata_json",
    "freeze_proof_json",
    "reservation_count",
    "registry_count",
    "committed_bytes",
    "reserved_bytes",
  ],
  shelf_storage_staging: [
    "reservation_id",
    "logical_key",
    "object_key",
    "descriptor_json",
    "size_bytes",
    "state",
    "etag",
    "enabled",
    "created_at",
  ],
  shelf_storage_text_registry: [
    "logical_key",
    "reservation_id",
    "descriptor_json",
    "etag",
    "enabled",
  ],
  storage_state: [
    "id",
    "account_id",
    "observed_account_bytes",
    "observed_at",
    "ceiling_bytes",
    "reserved_bytes",
    "committed_bytes",
    "evidence_hash",
    "evidence_complete",
    "updated_at",
  ],
  upload_reservations: [
    "reservation_id",
    "scope",
    "file_id",
    "book_id",
    "object_key",
    "size_bytes",
    "format",
    "sha256",
    "state",
    "etag",
    "content_verified",
    "absence_verified",
    "created_at",
    "updated_at",
  ],
});
export const READONLY_LEGACY_SNAPSHOT_GROUPS = freeze([
  [
    "shelf_storage_authority",
    "shelf_storage_sources",
    "shelf_storage_staging",
    "shelf_storage_legacy_freeze",
    "storage_state",
    "upload_reservations",
    "shelf_storage_single_trial",
  ],
  ["auth_config", "sessions", "counters", "admissions"],
  [
    "shelf_storage_reservations",
    "shelf_storage_original_registry",
    "shelf_storage_text_registry",
    "file_registry",
  ],
  ["book_management", "browser_uploads", "metadata_overrides", "public_state"],
  ["catalog_books", "library_schema"],
  ["catalog_imports", "catalog_import_rows"],
  ["filename_identifications", "filename_identification_observations"],
]);
export const READONLY_PREPARED_TABLES = freeze([
  "shelf_prepared_indexes",
  "shelf_prepared_index_chunks",
  "shelf_prepared_index_publications",
]);
export const READONLY_ACTIVATION_TABLES = freeze([
  "shelf_storage_activation_v2",
  "shelf_storage_activation_receipts_v2",
  "shelf_storage_evidence_v2",
  "shelf_storage_legacy_liabilities_v2",
]);
export class ReadonlySchemaError extends Error {
  constructor() {
    super("readonly_schema_invalid");
    this.name = "ReadonlySchemaError";
    this.code = "readonly_schema_invalid";
  }
}
const fail = () => {
  throw new ReadonlySchemaError();
};
const exact = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const d = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(d);
  return (
    keys.length === 4 &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        ["type", "name", "tbl_name", "sql"].includes(key) &&
        d[key].enumerable &&
        Object.hasOwn(d[key], "value"),
    )
  );
};
const order = (a, b) =>
  a.type < b.type
    ? -1
    : a.type > b.type
      ? 1
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0;
/** Preserve internal SQL literally; only the original outer trim/single-semicolon rule applies. */
export function normalizeReadonlySchemaRows(rows) {
  if (!Array.isArray(rows) || rows.length > 256) fail();
  const seen = new Set(),
    result = [];
  for (const row of rows) {
    if (
      !exact(row) ||
      !["type", "name", "tbl_name", "sql"].every(
        (k) => typeof row[k] === "string" && row[k].length > 0,
      ) ||
      !["table", "trigger", "view", "index"].includes(row.type) ||
      seen.has(row.name)
    )
      fail();
    const value = {
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql: row.sql.trim().replace(/;$/, ""),
    };
    if (!value.sql || (result.length && order(result.at(-1), value) >= 0))
      fail();
    seen.add(row.name);
    result.push(value);
  }
  const json = JSON.stringify(result);
  if (new TextEncoder().encode(json).byteLength > 1048576) fail();
  return freeze(result);
}
/** Unknown well-formed schemas return null; callers may only add separately pinned legacy profiles. */
export function classifyReadonlyDatabaseSchema(rows) {
  const actual = normalizeReadonlySchemaRows(rows),
    schemaJson = JSON.stringify(actual),
    profile = Object.keys(DATABASE_SCHEMA_PROFILES).find(
      (name) => schemaJson === JSON.stringify(DATABASE_SCHEMA_PROFILES[name]),
    );
  return profile
    ? freeze({
        profile,
        storageLayout: profile.startsWith("activation-")
          ? "activation-v2"
          : "trial-v1",
        ...DATABASE_SCHEMA_METADATA[profile],
        schemaJson,
      })
    : null;
}
/** Only fixed public business table/column names can enter this unbounded, ordered snapshot. */
export function readonlySnapshotSql(tables) {
  if (
    !Array.isArray(tables) ||
    !tables.length ||
    tables.length > 32 ||
    new Set(tables).size !== tables.length ||
    tables.some(
      (name) =>
        typeof name !== "string" ||
        !Object.hasOwn(READONLY_TABLE_COLUMNS, name),
    )
  )
    fail();
  return (
    "SELECT json_object(" +
    tables
      .map((table) => {
        const cols = READONLY_TABLE_COLUMNS[table];
        return (
          "'" +
          table +
          "',json((SELECT json_group_array(json(row)) FROM (SELECT json_object(" +
          cols.map((c) => "'" + c + "'," + c).join(",") +
          ") AS row FROM " +
          table +
          " ORDER BY " +
          cols.join(",") +
          ")))"
        );
      })
      .join(",") +
    ") AS snapshot"
  );
}
