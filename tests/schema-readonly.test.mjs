import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  DATABASE_SCHEMA_PROFILES,
  DATABASE_SCHEMA_METADATA,
  STORAGE_DATABASE_SCHEMA_SQL,
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
} from "../scripts/schema-readonly.mjs";
const clone = (v) => structuredClone(v);
const invalid = (call) =>
  assert.throws(call, { code: "readonly_schema_invalid" });
for (const [profile, rows] of Object.entries(DATABASE_SCHEMA_PROFILES)) {
  test(`readonly classifier accepts only exact ${profile}`, () => {
    const result = classifyReadonlyDatabaseSchema(rows);
    assert.equal(result.profile, profile);
    assert.equal(result.sha256, DATABASE_SCHEMA_METADATA[profile].sha256);
    assert.equal(
      result.storageLayout,
      profile.startsWith("activation-") ? "activation-v2" : "trial-v1",
    );
    assert.equal(result.schemaJson, JSON.stringify(rows));
    assert.ok(Object.isFrozen(result));
    const wrapped = clone(rows).map((row) => ({
      ...row,
      sql: ` \n${row.sql};`,
    }));
    assert.equal(classifyReadonlyDatabaseSchema(wrapped).profile, profile);
  });
}
test("whole-schema query remains fixed, complete and bounded", () => {
  assert.equal(READONLY_DATABASE_SCHEMA_SQL, STORAGE_DATABASE_SCHEMA_SQL);
  assert.equal(
    READONLY_DATABASE_SCHEMA_SQL,
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN ('_cf_KV','d1_migrations') AND substr(name,1,7)<>'sqlite_' ORDER BY type,name LIMIT 257",
  );
});
test("unknown, partial activation and changed platform DDL never select a profile", () => {
  const rows = clone(DATABASE_SCHEMA_PROFILES["activation-011-cf-metadata-v1"]);
  assert.equal(
    classifyReadonlyDatabaseSchema(
      rows.filter((row) => row.name !== "shelf_storage_v2_phase_gate"),
    ),
    null,
  );
  const changed = clone(rows);
  changed.find((row) => row.name === "_cf_METADATA").sql += " ";
  assert.notEqual(classifyReadonlyDatabaseSchema(changed), null); // outer whitespace only
  changed.find((row) => row.name === "_cf_METADATA").sql = changed
    .find((row) => row.name === "_cf_METADATA")
    .sql.replace("BLOB", "TEXT");
  assert.equal(classifyReadonlyDatabaseSchema(changed), null);
  const missing010 = rows.filter(
    (row) => !row.name.startsWith("shelf_prepared_"),
  );
  assert.equal(classifyReadonlyDatabaseSchema(missing010), null);
  const internal = clone(rows);
  internal[0].sql = internal[0].sql.replace("CREATE", "CREATE  ");
  assert.equal(classifyReadonlyDatabaseSchema(internal), null);
});
test("strict schema rows reject malformed shape, primitives, order, duplicates and accessors", () => {
  const good = clone(DATABASE_SCHEMA_PROFILES["trial-009"]);
  for (const bad of [
    null,
    {},
    Array(257).fill(good[0]),
    [good[0], good[0]],
    [...good].reverse(),
    [{ ...good[0], extra: 1 }],
    [{ ...good[0], sql: null }],
    [{ ...good[0], type: "foreign" }],
    [{ ...good[0], sql: " ;" }],
  ])
    invalid(() => normalizeReadonlySchemaRows(bad));
  const getter = { ...good[0] };
  Object.defineProperty(getter, "sql", {
    enumerable: true,
    get() {
      throw Error("accessor must not execute");
    },
  });
  invalid(() => normalizeReadonlySchemaRows([getter]));
  const inherited = Object.assign(Object.create({ other: true }), good[0]);
  invalid(() => normalizeReadonlySchemaRows([inherited]));
  invalid(() =>
    normalizeReadonlySchemaRows([{ ...good[0], [Symbol("hidden")]: 1 }]),
  );
  invalid(() =>
    normalizeReadonlySchemaRows([{ ...good[0], sql: "x".repeat(1048576) }]),
  );
  const normalized = normalizeReadonlySchemaRows(good);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized[0]));
  assert.notEqual(normalized, good);
});
test("normalization preserves quoted and internal whitespace exactly", () => {
  const sql = "CREATE TABLE sample (value TEXT DEFAULT 'a  b')";
  const row = {
    type: "table",
    name: "sample",
    tbl_name: "sample",
    sql: ` \n${sql};\n`,
  };
  assert.equal(normalizeReadonlySchemaRows([row])[0].sql, sql);
  assert.equal(classifyReadonlyDatabaseSchema([row]), null);
});
test("all 32 fixed business table columns independently match artifact SQLite PRAGMA", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const tables = DATABASE_SCHEMA_PROFILES["activation-011"].filter(
      (row) => row.type === "table",
    );
    assert.equal(tables.length, 32);
    assert.deepEqual(
      Object.keys(READONLY_TABLE_COLUMNS).sort(),
      tables.map((row) => row.name).sort(),
    );
    for (const row of tables) {
      db.exec(row.sql);
      assert.deepEqual(
        READONLY_TABLE_COLUMNS[row.name],
        db
          .prepare(`PRAGMA table_info(${row.name})`)
          .all()
          .map((column) => column.name),
        row.name,
      );
    }
    const groups = [
      ...READONLY_LEGACY_SNAPSHOT_GROUPS.flat(),
      ...READONLY_PREPARED_TABLES,
      ...READONLY_ACTIVATION_TABLES,
    ];
    assert.equal(READONLY_LEGACY_SNAPSHOT_GROUPS.length, 7);
    assert.equal(READONLY_LEGACY_SNAPSHOT_GROUPS.flat().length, 25);
    assert.equal(groups.length, new Set(groups).size);
    assert.deepEqual(groups.sort(), tables.map((row) => row.name).sort());
    assert.ok(!groups.includes("_cf_METADATA"));
    assert.ok(Object.isFrozen(READONLY_TABLE_COLUMNS));
    assert.ok(Object.isFrozen(READONLY_TABLE_COLUMNS.catalog_books));
  } finally {
    db.close();
  }
});
test("snapshot SQL keeps every row and column in deterministic full ordering", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const table of READONLY_ACTIVATION_TABLES)
      db.exec(
        DATABASE_SCHEMA_PROFILES["activation-011"].find(
          (row) => row.type === "table" && row.name === table,
        ).sql,
      );
    db.prepare(
      "INSERT INTO shelf_storage_evidence_v2 VALUES(?,'{}'),(?,'{}'),(?,'{}')",
    ).run("z".repeat(64), "a".repeat(64), "m".repeat(64));
    const sql = readonlySnapshotSql(READONLY_ACTIVATION_TABLES);
    assert.ok(!/\bLIMIT\b/i.test(sql));
    assert.ok(!sql.includes("_cf_METADATA"));
    const actual = JSON.parse(db.prepare(sql).get().snapshot);
    assert.deepEqual(Object.keys(actual), READONLY_ACTIVATION_TABLES);
    assert.deepEqual(
      actual.shelf_storage_evidence_v2.map((row) => row.evidence_hash),
      ["a", "m", "z"].map((value) => value.repeat(64)),
    );
    assert.deepEqual(
      Object.keys(actual.shelf_storage_evidence_v2[0]),
      READONLY_TABLE_COLUMNS.shelf_storage_evidence_v2,
    );
    assert.deepEqual(actual.shelf_storage_activation_v2, []);
  } finally {
    db.close();
  }
});
test("snapshot builder rejects all names outside the fixed public map", () => {
  for (const tables of [
    null,
    [],
    ["_cf_METADATA"],
    ["catalog_books; DROP TABLE sessions"],
    ["catalog_books", "catalog_books"],
    ["__proto__"],
    ["constructor"],
    [1],
    Array(33).fill("catalog_books"),
  ])
    invalid(() => readonlySnapshotSql(tables));
});
test("common helper runtime imports only fixed public schema data", () => {
  const source = readFileSync(
    new URL("../scripts/schema-readonly.mjs", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]),
    ["../shared/storage-schema-profiles.mjs"],
  );
  assert.doesNotMatch(
    source,
    /\b(?:process|fetch|DatabaseSync|readFile|writeFile|import\s*\()\b/,
  );
});
