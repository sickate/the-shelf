/** Offline compiler for public schema data. No credentials, environment or cloud IO. */
import fs from "node:fs/promises";
import { readFileSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { format } from "prettier";
import { STORAGE_SCHEMA_PROFILES } from "../server/storage-schema-state.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = new URL(
  "../shared/storage-schema-profiles.mjs",
  import.meta.url,
);
export const STORAGE_SCHEMA_SOURCE_HASHES = Object.freeze({
  "schema.sql":
    "44843c782416d881436b146b836c08cf0c0e1e3182d55d1f75b57d4a05728915",
  "migrations/002-conservative-storage.sql":
    "6838a36d94ebe8b8fa01fa7dd3a196efadca29ce795f5bde4e58317fc64adffb",
  "migrations/003-storage-authority.sql":
    "d38fc74d53034e88b1fa538ee4b447759d4b0ae463fcc558cc9ba338f9f6ea4f",
  "migrations/004-freeze-legacy-storage.sql":
    "2e126f0d1061b2d5679552f9ade03a60f3fc671d7a5a136cb264a3d96d37ab58",
  "migrations/005-single-trial.sql":
    "13878555653ad0b6dcd1b41df589cdb925d69af2d01222caf83b7257396be27f",
  "migrations/006-single-trial-admission.sql":
    "734687286259cd447c1ede9ffbd88f33f7c04a2118da1c5cadfcc78de2c569e3",
  "migrations/007-book-management.sql":
    "808ebf6bb222e98e69ec74dac9ec036a5347930c53ce6e2f194eefddc278a39f",
  "migrations/008-filename-identification.sql":
    "a2d6f76e54365eff03361902f1484373e80c6c8350d50fb71dd0f4c8cee0fe15",
  "migrations/009-filename-identification-observations.sql":
    "46607c049ca3d16afc2a50fa6f27cf01c7aba6b5fa7073616c2461d9c19bebcd",
  "migrations/010-prepared-index.sql":
    "b70ad99611023bde6aa08901cd8eeebbdeeae0cd38e96f0ea8dec93e566afd0f",
  "migrations/011-storage-activation-v2.sql":
    "db532d26cbe6dc3639cb9f5a32ae85ad6f0943ab7b2fc1fabe974bd1bfc3a0c3",
});
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const DATABASE_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN ('_cf_KV','d1_migrations') AND substr(name,1,7)<>'sqlite_' ORDER BY type,name LIMIT 257";
// Exact sqlite_master observation from local Miniflare 5.20261012.0-beta /
// workerd 1.20261012.1. D1's getCurrentBookmark() creates this platform table.
// This is schema data only: never query its contents or install/delete it.
const CF_METADATA_ROW = Object.freeze({
  type: "table",
  name: "_cf_METADATA",
  tbl_name: "_cf_METADATA",
  sql: "CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )",
});
const normalized = (rows) =>
  rows.map((r) => ({
    type: r.type,
    name: r.name,
    tbl_name: r.tbl_name,
    sql: r.sql.trim().replace(/;$/, ""),
  }));
const storageRows = (rows) =>
  rows.filter((v) =>
    /^(?:shelf_storage_|shelf_single_trial_|shelf_legacy_)/.test(v.name),
  );

/** Execute only pinned repository DDL and synthetic empty import data in memory. */
export function compileStorageSchemaData() {
  const sources = Object.fromEntries(
    Object.entries(STORAGE_SCHEMA_SOURCE_HASHES).map(([name, expected]) => {
      const text = readFileSync(
        new URL(`../cloudflare/library/${name}`, import.meta.url),
        "utf8",
      );
      if (sha(text) !== expected) throw Error("storage_schema_source_changed");
      return [name, text];
    }),
  );
  const db = new DatabaseSync(":memory:");
  const databaseProfiles = {};
  try {
    for (const name of Object.keys(sources).slice(0, 9)) db.exec(sources[name]);
    databaseProfiles["trial-009"] = normalized(
      db.prepare(DATABASE_SCHEMA_SQL).all(),
    );
    db.exec(sources["migrations/010-prepared-index.sql"]);
    databaseProfiles["trial-010"] = normalized(
      db.prepare(DATABASE_SCHEMA_SQL).all(),
    );
    db.prepare(
      "INSERT INTO shelf_storage_authority(id,identity_json,phase)VALUES(1,?,'migration_required')",
    ).run("{}");
    for (const scope of ["check", "production"])
      db.prepare(
        "INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(scope, "a".repeat(64), "b".repeat(64), "{}", "{}", 0, 0, 0, 0);
    db.prepare(
      "UPDATE shelf_storage_authority SET phase='imported',migration_hash=?,readback_hash=?,receipt_json='{}' WHERE id=1",
    ).run("a".repeat(64), "b".repeat(64));
    db.exec(sources["migrations/011-storage-activation-v2.sql"]);
    databaseProfiles["activation-011"] = normalized(
      db.prepare(DATABASE_SCHEMA_SQL).all(),
    );
  } finally {
    db.close();
  }
  for (const [name, expected] of [
    ["trial-009", 112],
    ["trial-010", 125],
    ["activation-011", 149],
  ]) {
    if (databaseProfiles[name].length !== expected)
      throw Error("storage_schema_count_changed");
    const layout = name === "activation-011" ? "activation-v2" : "trial-v1";
    if (
      JSON.stringify(storageRows(databaseProfiles[name])) !==
      JSON.stringify(STORAGE_SCHEMA_PROFILES[layout])
    )
      throw Error("storage_schema_profile_changed");
  }
  // Preserve the original application profiles and pin complete platform
  // variants. The platform row remains in observations and their full hashes.
  for (const name of ["trial-009", "trial-010", "activation-011"])
    databaseProfiles[`${name}-cf-metadata-v1`] = [
      ...databaseProfiles[name],
      CF_METADATA_ROW,
    ].sort((a, b) =>
      a.type < b.type
        ? -1
        : a.type > b.type
          ? 1
          : a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0,
    );
  const storageProfiles = Object.fromEntries(
    Object.entries(STORAGE_SCHEMA_PROFILES).map(([name, rows]) => [
      name,
      normalized(rows),
    ]),
  );
  const metadata = (profiles) =>
    Object.fromEntries(
      Object.entries(profiles).map(([name, rows]) => {
        const schemaJson = JSON.stringify(rows);
        return [
          name,
          {
            objectCount: rows.length,
            sha256: sha(schemaJson),
            schemaBytes: Buffer.byteLength(schemaJson),
            projectedBytes: Buffer.byteLength(
              JSON.stringify({ schema_json: schemaJson }),
            ),
          },
        ];
      }),
    );
  const definitions = [],
    byDefinition = new Map();
  const references = (profiles) =>
    Object.fromEntries(
      Object.entries(profiles).map(([name, rows]) => [
        name,
        rows.map((row) => {
          const key = JSON.stringify(row);
          if (!byDefinition.has(key)) {
            byDefinition.set(key, definitions.length);
            definitions.push(row);
          }
          return byDefinition.get(key);
        }),
      ]),
    );
  const storageRefs = references(storageProfiles),
    databaseRefs = references(databaseProfiles);
  return {
    sourceHashes: STORAGE_SCHEMA_SOURCE_HASHES,
    definitions,
    storageRefs,
    databaseRefs,
    storageMetadata: metadata(storageProfiles),
    databaseMetadata: metadata(databaseProfiles),
    databaseSql: DATABASE_SCHEMA_SQL,
  };
}

export async function renderStorageSchemaArtifact() {
  const data = compileStorageSchemaData();
  return format(
    `/** GENERATED by scripts/storage-schema-artifact.mjs; public fixed SQL only.\n * Run the offline compiler with --check; do not edit this artifact by hand. */
const freeze = value => { if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); } return value; };
const data = freeze(${JSON.stringify(data)});
const materialize = refs => freeze(Object.fromEntries(Object.entries(refs).map(([name, indexes]) => [name, indexes.map(index => data.definitions[index])])));
export const STORAGE_SCHEMA_PROFILES = materialize(data.storageRefs);
export const DATABASE_SCHEMA_PROFILES = materialize(data.databaseRefs);
export const STORAGE_SCHEMA_METADATA = data.storageMetadata;
export const DATABASE_SCHEMA_METADATA = data.databaseMetadata;
export const STORAGE_SCHEMA_SOURCE_HASHES = data.sourceHashes;
export const STORAGE_DATABASE_SCHEMA_SQL = data.databaseSql;
`,
    { parser: "babel" },
  );
}

export async function main(argv = process.argv.slice(2)) {
  if (
    argv.length > 1 ||
    (argv.length === 1 && !["--check", "--write"].includes(argv[0]))
  )
    throw Error("storage_schema_artifact_arguments");
  const expected = await renderStorageSchemaArtifact();
  if (argv[0] === "--write") {
    if (
      (await fs.realpath(new URL("../shared", import.meta.url))) !==
      path.join(await fs.realpath(ROOT), "shared")
    )
      throw Error("storage_schema_artifact_target");
    const handle = await fs.open(
      OUTPUT,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(expected);
    } finally {
      await handle.close();
    }
  } else if ((await fs.readFile(OUTPUT, "utf8")) !== expected)
    throw Error("storage_schema_artifact_stale");
  return {
    ok: true,
    sha256: sha(expected),
    bytes: Buffer.byteLength(expected),
    requests: 0,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(await main()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
