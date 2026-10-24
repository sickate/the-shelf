/** Fixed legacy operator compatibility. Public pinned DDL only; no private IO or network. */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  STORAGE_SCHEMA_SOURCE_HASHES,
  DATABASE_SCHEMA_PROFILES,
} from "../shared/storage-schema-profiles.mjs";
import {
  READONLY_DATABASE_SCHEMA_SQL,
  READONLY_TABLE_COLUMNS,
  READONLY_LEGACY_SNAPSHOT_GROUPS,
  READONLY_PREPARED_TABLES,
  READONLY_ACTIVATION_TABLES,
  normalizeReadonlySchemaRows,
  classifyReadonlyDatabaseSchema,
  readonlySnapshotSql,
} from "./schema-readonly.mjs";

export { READONLY_DATABASE_SCHEMA_SQL };
const sha = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const fail = () => {
  throw Error("legacy_schema_status_invalid");
};
export const LEGACY_SCHEMA_STATUS_LIMITS = Object.freeze({
  responseBytes: 1048576,
  responseChunks: 4096,
  timeoutMs: 30000,
  atomic: false,
  pagination: false,
});
export const LEGACY_SCHEMA_STATUS_BUDGETS = Object.freeze(
  Object.fromEntries(
    Object.keys(DATABASE_SCHEMA_PROFILES).map((profile) => [
      profile,
      Object.freeze({
        http: profile.startsWith("activation-")
          ? 11
          : profile.startsWith("trial-010")
            ? 10
            : 9,
        ddl: 0,
      }),
    ]),
  ),
);

// Compile only hash-pinned public sources. Migration 002 is redundant after 004;
// compiling with it produces the same exact pre-007/008/009 schemas.
const sources = Object.entries(STORAGE_SCHEMA_SOURCE_HASHES).map(
  ([name, hash]) => {
    const sql = readFileSync(
      new URL("../cloudflare/library/" + name, import.meta.url),
      "utf8",
    );
    if (sha(sql) !== hash) fail();
    return {
      name,
      sql,
      number: name === "schema.sql" ? 0 : Number(name.slice(11, 14)),
    };
  },
);
const baselines = new Map();
for (const version of [7, 8, 9]) {
  const db = new DatabaseSync(":memory:");
  try {
    for (const source of sources)
      if (source.number < version) db.exec(source.sql);
    const before = normalizeReadonlySchemaRows(
      db.prepare(READONLY_DATABASE_SCHEMA_SQL).all(),
    );
    const oldGuard = before.find(
      (row) => row.name === "filename_identification_admit",
    );
    db.exec(sources.find((source) => source.number === version).sql);
    const after = normalizeReadonlySchemaRows(
      db.prepare(READONLY_DATABASE_SCHEMA_SQL).all(),
    );
    const knownOwn = after.filter(
      (row) => !before.some((old) => old.name === row.name),
    );
    if (version === 9) knownOwn.push(oldGuard);
    const names = new Set(knownOwn.map((row) => row.name));
    baselines.set(version, {
      before: before.filter((row) => !names.has(row.name)),
      knownOwn,
      names,
    });
  } finally {
    db.close();
  }
}
const platformRows = DATABASE_SCHEMA_PROFILES[
  "trial-009-cf-metadata-v1"
].filter(
  (row) =>
    !DATABASE_SCHEMA_PROFILES["trial-009"].some((old) => old.name === row.name),
);

/** Unknown whole schemas never get a hash-only fallback. Own-object subsets remain historical states. */
export function legacyOperatorSchema(version, rows) {
  const normalized = normalizeReadonlySchemaRows(rows);
  const full = classifyReadonlyDatabaseSchema(normalized);
  const baseline = baselines.get(version);
  if (!baseline) fail();
  if (full)
    return {
      full,
      own: normalized.filter((row) => baseline.names.has(row.name)),
    };
  const own = normalized.filter((row) => baseline.names.has(row.name));
  if (
    own.some(
      (row) =>
        !baseline.knownOwn.some(
          (expected) => JSON.stringify(row) === JSON.stringify(expected),
        ),
    )
  )
    fail();
  const old = normalized.filter((row) => !baseline.names.has(row.name));
  const expected = [
    baseline.before,
    [...baseline.before, ...platformRows].sort((a, b) =>
      a.type < b.type
        ? -1
        : a.type > b.type
          ? 1
          : a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0,
    ),
  ];
  if (!expected.some((rows) => JSON.stringify(rows) === JSON.stringify(old)))
    fail();
  return { full: null, own };
}

export function legacyStatusGroups(profile) {
  if (!Object.hasOwn(LEGACY_SCHEMA_STATUS_BUDGETS, profile)) fail();
  return [
    ...READONLY_LEGACY_SNAPSHOT_GROUPS,
    ...(profile.startsWith("trial-010") || profile.startsWith("activation-")
      ? [READONLY_PREPARED_TABLES]
      : []),
    ...(profile.startsWith("activation-") ? [READONLY_ACTIVATION_TABLES] : []),
  ];
}
export function legacySnapshotValue(rows, tables) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    Object.keys(rows[0]).length !== 1 ||
    typeof rows[0].snapshot !== "string"
  )
    fail();
  let value;
  try {
    value = JSON.parse(rows[0].snapshot);
  } catch {
    fail();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== tables.length
  )
    fail();
  for (const table of tables) {
    const columns = READONLY_TABLE_COLUMNS[table];
    if (!Object.hasOwn(value, table) || !Array.isArray(value[table])) fail();
    for (const row of value[table]) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== columns.length
      )
        fail();
      for (const column of columns)
        if (
          !Object.hasOwn(row, column) ||
          !(
            row[column] === null ||
            typeof row[column] === "string" ||
            (typeof row[column] === "number" && Number.isFinite(row[column]))
          )
        )
          fail();
    }
  }
  return value;
}

/** Each group is one full, ordered statement; groups are observations, not an atomic/ready permit. */
export async function observeLegacySchemaStatus({
  classification,
  rows,
  identity,
  request,
}) {
  const groups = legacyStatusGroups(classification.profile),
    summaries = [];
  for (const [number, tables] of groups.entries()) {
    const result = await request(readonlySnapshotSql(tables)),
      value = legacySnapshotValue(result, tables);
    if (number === 0) {
      const authority = value.shelf_storage_authority,
        trial = value.shelf_storage_single_trial;
      if (
        authority.length !== 1 ||
        authority[0].identity_json !== JSON.stringify(identity) ||
        !["imported", "ready"].includes(authority[0].phase) ||
        trial.length !== 1 ||
        trial[0].state !== "confirmed" ||
        trial[0].put_attempted !== 1 ||
        trial[0].content_verified !== 1 ||
        trial[0].consent_id !== "2026-10-23-first-book"
      )
        fail();
    }
    if (
      number === 1 &&
      value.auth_config.filter((row) => row.scope === "production").length !== 1
    )
      fail();
    summaries.push({
      number: number + 1,
      tables: [...tables],
      rows: Object.fromEntries(
        tables.map((table) => [table, value[table].length]),
      ),
      sha256: sha(result[0].snapshot),
    });
  }
  const wholeSchemaSha256 = sha(normalizeReadonlySchemaRows(rows));
  return {
    schema: "complete",
    databaseProfile: classification.profile,
    storageLayout: classification.storageLayout,
    wholeSchemaSha256,
    snapshotGroups: summaries,
    protectedFactsSha256: sha({
      wholeSchemaSha256,
      groups: summaries.map((group) => group.sha256),
    }),
    budget: LEGACY_SCHEMA_STATUS_BUDGETS[classification.profile],
    limits: LEGACY_SCHEMA_STATUS_LIMITS,
    observationOnly: true,
    atomic: false,
    readyAllowed: false,
  };
}
