import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import {
  storageDeploymentContract,
  validateRemoteStorageBindings,
  validateStorageDatabaseSchema,
  validateStorageNamespaceSchema,
  STORAGE_DEPLOYMENT_LIMITS,
  STORAGE_DATABASE_SCHEMA_SQL,
} from "../shared/storage-deployment-contract.mjs";
import {
  STORAGE_SCHEMA_PROFILES,
  DATABASE_SCHEMA_PROFILES,
  STORAGE_SCHEMA_METADATA,
  DATABASE_SCHEMA_METADATA,
  STORAGE_SCHEMA_SOURCE_HASHES,
} from "../shared/storage-schema-profiles.mjs";
import { STORAGE_SCHEMA_PROFILES as nodeProfiles } from "../server/storage-schema-state.mjs";
import {
  renderStorageSchemaArtifact,
  compileStorageSchemaData,
  main as artifactMain,
} from "../scripts/storage-schema-artifact.mjs";

const clone = structuredClone;
const sha = (v) => createHash("sha256").update(v).digest("hex");
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: "a".repeat(32),
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
const argumentsFor = (profile = "authority-v2-closed", overrides = {}) => ({
  profile,
  identity: clone(identity),
  filenameAi: profile === "authority-v2-closed",
  preparedText: false,
  retainedSecrets:
    profile === "legacy-v1"
      ? "ordinary-v1"
      : profile === "authority-v2-closed"
        ? "trial-retained-filename-v1"
        : "trial-retained-v1",
  ...(profile !== "legacy-v1" ? { trialTargetSha256: "b".repeat(64) } : {}),
  ...overrides,
});
const contractFor = (profile, overrides) =>
  storageDeploymentContract(argumentsFor(profile, overrides));
function settingsFor(
  contract,
  { databaseAlias = "id", r2Fields = false, staticOnly = false } = {},
) {
  const bindings = [
    ...(staticOnly
      ? []
      : [
          {
            name: "DB",
            type: "d1",
            ...(databaseAlias === "both"
              ? {
                  id: contract.d1Bindings[0].database_id,
                  database_id: contract.d1Bindings[0].database_id,
                }
              : { [databaseAlias]: contract.d1Bindings[0].database_id }),
          },
          ...contract.r2Bindings.map((b) => ({
            name: b.binding,
            type: "r2_bucket",
            bucket_name: b.bucket_name,
            ...(r2Fields
              ? { account_id: identity.accountId, jurisdiction: "default" }
              : {}),
          })),
          ...Object.entries(contract.vars).map(([name, text]) => ({
            name,
            type: "plain_text",
            text,
          })),
        ]),
    ...(contract.assetBinding ? [{ name: "ASSETS", type: "assets" }] : []),
    ...contract.secretNames.map((name) => ({ name, type: "secret_text" })),
  ];
  return { bindings, compatibility_date: "2026-10-15", logpush: false };
}
const rejects = (callback) =>
  assert.throws(callback, (e) => e.code?.startsWith("storage_deployment_"));
const binding = (settings, name) =>
  settings.bindings.find((b) => b.name === name);

test("artifact is deterministic, frozen and exactly equal to pinned SQL and final Node profiles", async () => {
  const source = readFileSync(
    new URL("../shared/storage-schema-profiles.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source, await renderStorageSchemaArtifact());
  assert.deepEqual(STORAGE_SCHEMA_PROFILES, nodeProfiles);
  const generated = compileStorageSchemaData();
  assert.equal(
    generated.definitions.length,
    new Set(generated.definitions.map((v) => JSON.stringify(v))).size,
  );
  assert.equal(Object.keys(STORAGE_SCHEMA_SOURCE_HASHES).length, 11);
  assert.ok(
    !Object.keys(STORAGE_SCHEMA_SOURCE_HASHES).some((v) => v.includes("012")),
  );
  assert.equal(
    STORAGE_SCHEMA_SOURCE_HASHES["migrations/011-storage-activation-v2.sql"],
    "db532d26cbe6dc3639cb9f5a32ae85ad6f0943ab7b2fc1fabe974bd1bfc3a0c3",
  );
  assert.equal((await artifactMain([])).requests, 0);
  for (const args of [
    ["--url", "https://example.invalid"],
    ["--write", "extra"],
    ["--execute"],
  ])
    await assert.rejects(artifactMain(args));
  for (const rows of [
    ...Object.values(STORAGE_SCHEMA_PROFILES),
    ...Object.values(DATABASE_SCHEMA_PROFILES),
  ]) {
    assert.ok(Object.isFrozen(rows));
    assert.ok(Object.isFrozen(rows[0]));
    assert.throws(() => (rows[0].sql = "changed"), TypeError);
  }
});

test("shared contract and artifact bundle for a Worker without any Node or IO dependency", async () => {
  const result = await build({
    entryPoints: ["shared/storage-deployment-contract.mjs"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(), [
    "shared/storage-deployment-contract.mjs",
    "shared/storage-schema-profiles.mjs",
  ]);
  assert.equal(result.warnings.length, 0);
  const source = readFileSync(
    new URL("../shared/storage-deployment-contract.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/\b(?:process|fetch|DatabaseSync)\b|node:/.test(source), false);
});

test("frozen layout hashes and full schema counts remain separate from migration source hashes", () => {
  const expected = {
    "legacy-v1": [
      44,
      "10fc23abed2c792337e28eecd7cb47c50f3731426c745b64989a11817d720350",
    ],
    "trial-v1": [
      51,
      "4b6c10339c1d74355254951d0168d936b6e3e159b8aa3704619342346d0d7e4e",
    ],
    "activation-v2": [
      75,
      "5208bcb2e9dcdf1d1d8aa0affec120c8ed3aa15350cd5245b705734e14c13dd2",
    ],
  };
  for (const [name, [count, hash]] of Object.entries(expected)) {
    assert.equal(STORAGE_SCHEMA_METADATA[name].objectCount, count);
    assert.equal(STORAGE_SCHEMA_METADATA[name].sha256, hash);
    assert.equal(sha(JSON.stringify(STORAGE_SCHEMA_PROFILES[name])), hash);
    assert.equal(
      validateStorageNamespaceSchema(STORAGE_SCHEMA_PROFILES[name]).layout,
      name,
    );
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(DATABASE_SCHEMA_METADATA).map(([name, v]) => [
        name,
        v.objectCount,
      ]),
    ),
    {
      "trial-009": 112,
      "trial-010": 125,
      "activation-011": 149,
      "trial-009-cf-metadata-v1": 113,
      "trial-010-cf-metadata-v1": 126,
      "activation-011-cf-metadata-v1": 150,
    },
  );
  assert.equal(
    Object.values(DATABASE_SCHEMA_PROFILES).every((rows) =>
      rows.some((v) => v.name === "admission_private"),
    ),
    true,
  );
  assert.equal(
    STORAGE_SCHEMA_PROFILES["activation-v2"].some(
      (v) => v.name === "admission_private",
    ),
    false,
  );
});

for (const profile of ["legacy-v1", "trial-v1", "authority-v2-closed"])
  test(`exact configuration profile ${profile} validates without changing its source identity`, () => {
    const args = argumentsFor(profile),
      contract = storageDeploymentContract(args);
    const before = clone(args);
    validateRemoteStorageBindings(settingsFor(contract), contract);
    assert.deepEqual(args, before);
    assert.equal(contract.identity.accountId, identity.accountId);
    assert.ok(Object.isFrozen(contract));
    assert.ok(Object.isFrozen(contract.vars));
    assert.ok(Object.isFrozen(contract.identity.legacyDatabases));
    assert.deepEqual(
      JSON.parse(contract.canonicalProfile).r2Bindings,
      contract.r2Bindings,
    );
    if (profile === "authority-v2-closed") {
      assert.equal(contract.vars.STORAGE_WRITE_MODE, "closed");
      assert.equal(contract.vars.R2_BUCKET, "the-shelf-books");
      assert.equal(
        contract.vars.TRIAL_R2_BUCKET,
        "the-shelf-first-book-20261023",
      );
      assert.deepEqual(
        contract.r2Bindings.map((v) => v.binding),
        ["BOOKS", "TRIAL_BOOKS"],
      );
      for (const name of [
        "SINGLE_TRIAL_MODE",
        "SINGLE_TRIAL_TARGET_SHA256",
        "NORMAL_UPLOAD_MODE",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
      ])
        assert.equal(Object.hasOwn(contract.vars, name), false);
      assert.deepEqual(contract.secretNames, [
        "OWNER_KEY_PEPPER",
        "SESSION_SECRET",
        "SINGLE_TRIAL_UPLOAD_SECRET",
        "FILENAME_AI_KEY",
      ]);
    }
  });

test("check legacy and every explicit trial filename/prepared extension has a fixed exact set", () => {
  const check = contractFor("legacy-v1", { scope: "check" });
  validateRemoteStorageBindings(settingsFor(check), check);
  assert.equal(check.assetBinding, null);
  assert.equal(check.d1Bindings[0].database_id, identity.legacyDatabases.check);
  for (const filenameAi of [false, true])
    for (const preparedText of [false, true]) {
      const c = contractFor("trial-v1", {
        filenameAi,
        preparedText,
        retainedSecrets: filenameAi
          ? "trial-retained-filename-v1"
          : "trial-retained-v1",
      });
      validateRemoteStorageBindings(settingsFor(c), c);
      assert.equal(
        c.r2Bindings[0].bucket_name,
        "the-shelf-first-book-20261023",
      );
      assert.equal(c.r2Bindings.length, preparedText ? 2 : 1);
    }
  const prepared = contractFor("authority-v2-closed", { preparedText: true });
  validateRemoteStorageBindings(settingsFor(prepared), prepared);
  assert.deepEqual(prepared.r2Bindings, [
    { binding: "BOOKS", bucket_name: "the-shelf-books" },
    { binding: "TRIAL_BOOKS", bucket_name: "the-shelf-first-book-20261023" },
    { binding: "PREPARED_BOOKS", bucket_name: "the-shelf-books" },
  ]);
});

test("configuration rejects weak booleans, arbitrary targets, secret lists and mixed profile modes", () => {
  for (const change of [
    { profile: "authority-v2" },
    { scope: "production-other" },
    { scope: "check" },
    { filenameAi: "true" },
    { preparedText: 1 },
    { filenameAi: false, retainedSecrets: "trial-retained-v1" },
    { retainedSecrets: "ordinary-v1" },
    { retainedSecrets: ["OWNER_KEY_PEPPER"] },
    { retainedSecrets: "__proto__" },
    { trialTargetSha256: undefined },
    { trialTargetSha256: "B".repeat(64) },
    { bucket: "elsewhere" },
    { url: "https://example.invalid" },
  ])
    rejects(() => storageDeploymentContract({ ...argumentsFor(), ...change }));
  for (const name of [
    "profile",
    "identity",
    "filenameAi",
    "preparedText",
    "retainedSecrets",
  ]) {
    const args = argumentsFor();
    delete args[name];
    rejects(() => storageDeploymentContract(args));
  }
  for (const change of [
    { trialTargetSha256: "b".repeat(64) },
    { filenameAi: true },
    { preparedText: true },
  ])
    rejects(() =>
      storageDeploymentContract({
        ...argumentsFor("legacy-v1"),
        ...change,
      }),
    );
  for (const mutate of [
    (v) => (v.identity.bucket = "other"),
    (v) => (v.identity.accountId = "B".repeat(32)),
    (v) => (v.identity.authorityId = "other"),
    (v) => (v.identity.schemaVersion = "1"),
    (v) => (v.identity.extra = true),
    (v) =>
      (v.identity.legacyDatabases.production =
        v.identity.legacyDatabases.check),
    (v) => (v.identity.legacyDatabases.production = "invalid"),
    (v) => (v.identity.legacyDatabases.extra = "invalid"),
  ]) {
    const args = argumentsFor();
    mutate(args);
    rejects(() => storageDeploymentContract(args));
  }
  const original = contractFor();
  rejects(() =>
    validateRemoteStorageBindings(settingsFor(original), clone(original)),
  );
});

for (const profile of ["trial-v1", "authority-v2-closed"])
  test(`${profile} cannot omit, remove or partially enable the prepared four-entry group`, () => {
    const c = contractFor(profile, { preparedText: true }),
      off = contractFor(profile);
    const full = settingsFor(c);
    for (const name of [
      "PREPARED_BOOKS",
      "PREPARED_TEXT_MODE",
      "PREPARED_R2_ACCOUNT_ID",
      "PREPARED_R2_BUCKET",
    ]) {
      const value = clone(full);
      value.bindings = value.bindings.filter((b) => b.name !== name);
      rejects(() => validateRemoteStorageBindings(value, c));
      rejects(() => validateRemoteStorageBindings(value, off));
    }
    rejects(() => validateRemoteStorageBindings(full, off));
    rejects(() => validateRemoteStorageBindings(settingsFor(off), c));
  });

for (const [label, mutate] of [
  [
    "BOOKS wrong bucket",
    (s) => (binding(s, "BOOKS").bucket_name = "the-shelf-first-book-20261023"),
  ],
  [
    "TRIAL_BOOKS wrong bucket",
    (s) => (binding(s, "TRIAL_BOOKS").bucket_name = "the-shelf-books"),
  ],
  [
    "PREPARED_BOOKS wrong bucket",
    (s) =>
      (binding(s, "PREPARED_BOOKS").bucket_name =
        "the-shelf-first-book-20261023"),
  ],
  [
    "wrong R2 account",
    (s) => (binding(s, "TRIAL_BOOKS").account_id = "b".repeat(32)),
  ],
  ["wrong jurisdiction", (s) => (binding(s, "BOOKS").jurisdiction = "eu")],
  [
    "extra r2 capability",
    (s) =>
      s.bindings.push({
        name: "OTHER",
        type: "r2_bucket",
        bucket_name: "the-shelf-books",
      }),
  ],
  [
    "duplicate binding",
    (s) => s.bindings.push(clone(binding(s, "TRIAL_BOOKS"))),
  ],
  [
    "unknown var",
    (s) => s.bindings.push({ name: "UNKNOWN", type: "plain_text", text: "x" }),
  ],
  ["json var", (s) => (binding(s, "STORAGE_WRITE_MODE").type = "json")],
  ["open gate", (s) => (binding(s, "STORAGE_WRITE_MODE").text = "open")],
  [
    "old trial mode",
    (s) =>
      s.bindings.push({
        name: "SINGLE_TRIAL_MODE",
        type: "plain_text",
        text: "first-book-20261023",
      }),
  ],
  [
    "old normal upload mode",
    (s) =>
      s.bindings.push({
        name: "NORMAL_UPLOAD_MODE",
        type: "plain_text",
        text: "authority-v1",
      }),
  ],
  [
    "general R2 secret",
    (s) => s.bindings.push({ name: "R2_ACCESS_KEY_ID", type: "secret_text" }),
  ],
  [
    "missing retained upload secret",
    (s) =>
      (s.bindings = s.bindings.filter(
        (b) => b.name !== "SINGLE_TRIAL_UPLOAD_SECRET",
      )),
  ],
  [
    "secret value field",
    (s) => (binding(s, "FILENAME_AI_KEY").text = "must-not-echo"),
  ],
  ["number var", (s) => (binding(s, "R2_ACCOUNT_ID").text = 123)],
  ["wrong DB", (s) => (binding(s, "DB").id = identity.legacyDatabases.check)],
  [
    "conflicting D1 aliases",
    (s) => (binding(s, "DB").database_id = identity.legacyDatabases.check),
  ],
  [
    "extra D1 field",
    (s) => (binding(s, "DB").database_name = "the-shelf-library"),
  ],
  [
    "extra R2 field",
    (s) => (binding(s, "BOOKS").preview_bucket_name = "the-shelf-books"),
  ],
  ["extra assets field", (s) => (binding(s, "ASSETS").other = true)],
  [
    "plain extra field",
    (s) => (binding(s, "STORAGE_MODE").value = "authority-v2"),
  ],
])
  test(`remote exact config rejects ${label}`, () => {
    const c = contractFor("authority-v2-closed", { preparedText: true }),
      settings = settingsFor(c);
    mutate(settings);
    assert.throws(
      () => validateRemoteStorageBindings(settings, c),
      (e) =>
        e.code?.startsWith("storage_deployment_") &&
        !e.message.includes("must-not-echo"),
    );
  });

test("accepted aliases/optional fields remain visible in complete observation snapshots", () => {
  const c = contractFor(),
    snapshots = [];
  for (const databaseAlias of ["id", "database_id", "both"])
    for (const r2Fields of [false, true]) {
      const observed = validateRemoteStorageBindings(
        settingsFor(c, { databaseAlias, r2Fields }),
        c,
      );
      snapshots.push(observed.canonicalSettingsJson);
      assert.ok(Object.isFrozen(observed.canonicalBindings));
      assert.equal(
        Object.hasOwn(
          observed.canonicalBindings.find((b) => b.name === "DB"),
          "id",
        ),
        databaseAlias !== "database_id",
      );
    }
  assert.equal(new Set(snapshots).size, 6);
  const source = settingsFor(c),
    before = validateRemoteStorageBindings(source, c);
  source.compatibility_date = "2026-10-16";
  const after = validateRemoteStorageBindings(source, c);
  assert.notEqual(before.canonicalSettingsJson, after.canonicalSettingsJson);
  assert.equal(before.canonicalBindingsJson, after.canonicalBindingsJson);
  assert.ok(before.canonicalSettingsJson.includes("2026-10-15"));
  source.bindings.reverse();
  assert.notEqual(
    after.canonicalSettingsJson,
    validateRemoteStorageBindings(source, c).canonicalSettingsJson,
  );
});

test("four-secret current trial prestate and v2 poststate have independent strict contracts", () => {
  const beforeContract = contractFor("trial-v1", {
      filenameAi: true,
      retainedSecrets: "trial-retained-filename-v1",
    }),
    afterContract = contractFor();
  const before = settingsFor(beforeContract),
    after = settingsFor(afterContract);
  assert.deepEqual(beforeContract.secretNames, afterContract.secretNames);
  validateRemoteStorageBindings(before, beforeContract);
  validateRemoteStorageBindings(after, afterContract);
  rejects(() => validateRemoteStorageBindings(before, afterContract));
  rejects(() => validateRemoteStorageBindings(after, beforeContract));
  const omittedFilename = contractFor("trial-v1");
  rejects(() => validateRemoteStorageBindings(before, omittedFilename));
});

test("static shape is explicit, assets plus exact retained secrets, with no dynamic acceptance", () => {
  for (const profile of ["legacy-v1", "trial-v1", "authority-v2-closed"]) {
    const c = contractFor(profile),
      settings = settingsFor(c, { staticOnly: true });
    validateRemoteStorageBindings(settings, c, { staticOnly: true });
    rejects(() => validateRemoteStorageBindings(settings, c));
    rejects(() =>
      validateRemoteStorageBindings(settingsFor(c), c, { staticOnly: true }),
    );
    settings.bindings.pop();
    rejects(() =>
      validateRemoteStorageBindings(settings, c, { staticOnly: true }),
    );
  }
  const c = contractFor();
  for (const options of [
    { staticOnly: 1 },
    { allowStatic: true },
    { staticOnly: true, extra: true },
  ])
    rejects(() => validateRemoteStorageBindings(settingsFor(c), c, options));
  const check = contractFor("legacy-v1", { scope: "check" });
  rejects(() =>
    validateRemoteStorageBindings(settingsFor(check), check, {
      staticOnly: true,
    }),
  );
});

test("non-JSON records, accessors and oversized observations are rejected without invoking getters", () => {
  const c = contractFor();
  let accessed = 0;
  const args = argumentsFor();
  Object.defineProperty(args, "retainedSecrets", {
    enumerable: true,
    get() {
      accessed++;
      throw Error("secret");
    },
  });
  rejects(() => storageDeploymentContract(args));
  const settings = settingsFor(c);
  Object.defineProperty(binding(settings, "SESSION_SECRET"), "text", {
    enumerable: true,
    get() {
      accessed++;
      throw Error("secret");
    },
  });
  rejects(() => validateRemoteStorageBindings(settings, c));
  assert.equal(accessed, 0);
  for (const value of [undefined, NaN, Infinity, -0, () => {}, 1n]) {
    const settings = settingsFor(c);
    settings.extra = value;
    rejects(() => validateRemoteStorageBindings(settings, c));
  }
  const cyclic = settingsFor(c);
  cyclic.self = cyclic;
  rejects(() => validateRemoteStorageBindings(cyclic, c));
  const oversized = settingsFor(c);
  oversized.extra = "x".repeat(STORAGE_DEPLOYMENT_LIMITS.responseBytes);
  assert.throws(
    () => validateRemoteStorageBindings(oversized, c),
    (e) => e.code === "storage_deployment_response_limit",
  );
});

test("database feature profiles match full exact 006/010/011 combinations and preserve column-order independence", () => {
  const ordinaryV2 = contractFor(),
    preparedV2 = contractFor("authority-v2-closed", { preparedText: true });
  for (const [name, rows] of Object.entries(DATABASE_SCHEMA_PROFILES)) {
    assert.equal(validateStorageDatabaseSchema(rows, ordinaryV2).profile, name);
    const reordered = rows.map((r) => ({
      sql: r.sql,
      tbl_name: r.tbl_name,
      name: r.name,
      type: r.type,
    }));
    assert.equal(
      validateStorageDatabaseSchema(reordered, ordinaryV2).schemaJson,
      JSON.stringify(rows),
    );
    const validated = validateStorageDatabaseSchema(rows, ordinaryV2);
    assert.equal(validated.sha256, sha(validated.schemaJson));
    assert.equal(validated.objectCount, rows.length);
    assert.equal(
      validated.schemaBytes,
      Buffer.byteLength(validated.schemaJson),
    );
    assert.equal(
      validated.projectedBytes,
      Buffer.byteLength(JSON.stringify({ schema_json: validated.schemaJson })),
    );
    assert.equal(
      validated.storageLayout,
      ["activation-011", "activation-011-cf-metadata-v1"].includes(name)
        ? "activation-v2"
        : "trial-v1",
    );
    if (["trial-009", "trial-009-cf-metadata-v1"].includes(name))
      rejects(() => validateStorageDatabaseSchema(rows, preparedV2));
    else validateStorageDatabaseSchema(rows, preparedV2);
    if (["activation-011", "activation-011-cf-metadata-v1"].includes(name))
      rejects(() =>
        validateStorageDatabaseSchema(rows, contractFor("trial-v1")),
      );
    else validateStorageDatabaseSchema(rows, contractFor("trial-v1"));
  }
  rejects(() =>
    validateStorageDatabaseSchema(
      DATABASE_SCHEMA_PROFILES["activation-011"],
      contractFor("trial-v1"),
    ),
  );
  rejects(() =>
    validateStorageDatabaseSchema(
      DATABASE_SCHEMA_PROFILES["trial-009"],
      contractFor("legacy-v1"),
    ),
  );
  const trimmed = DATABASE_SCHEMA_PROFILES["trial-009"].map((r) => ({
    ...r,
    sql: " \n" + r.sql + ";\n",
  }));
  validateStorageDatabaseSchema(trimmed, ordinaryV2);
});

test("platform variants retain exactly the observed metadata row and all original profile hashes", () => {
  const platformRow = {
    type: "table",
    name: "_cf_METADATA",
    tbl_name: "_cf_METADATA",
    sql: "CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )",
  };
  const hashes = {
    "trial-009":
      "9fb3a7409c7d57fce04eb1dac08caedd87928bd029533176d44f6dab514ced85",
    "trial-010":
      "0e7bfa53ca6a31644b66cede7fce8d187930e48d16d61d000859e0bbf39ef321",
    "activation-011":
      "3181e60747e177dc128b16a70bd305c1a3702506c5c276682bc7c8cba3952bb1",
  };
  for (const name of ["trial-009", "trial-010", "activation-011"]) {
    const rows = DATABASE_SCHEMA_PROFILES[`${name}-cf-metadata-v1`];
    assert.deepEqual(
      rows.filter((r) => r.name === "_cf_METADATA"),
      [platformRow],
    );
    assert.deepEqual(
      rows.filter((r) => r.name !== "_cf_METADATA"),
      DATABASE_SCHEMA_PROFILES[name],
    );
    assert.equal(DATABASE_SCHEMA_METADATA[name].sha256, hashes[name]);
  }
});

for (const [label, change] of [
  ["type", (row) => ({ ...row, type: "view" })],
  ["name", (row) => ({ ...row, name: "_cf_METADATA_extra" })],
  ["table name", (row) => ({ ...row, tbl_name: "_cf_OTHER" })],
  [
    "DDL",
    (row) => ({ ...row, sql: row.sql.replace("value BLOB", "value TEXT") }),
  ],
  [
    "extra column",
    (row) => ({
      ...row,
      sql: row.sql.replace("value BLOB", "value BLOB, extra TEXT"),
    }),
  ],
  [
    "internal whitespace",
    (row) => ({ ...row, sql: row.sql.replace("key INTEGER", "key  INTEGER") }),
  ],
])
  test(`platform metadata rejects changed ${label}`, () => {
    for (const name of ["trial-009", "trial-010", "activation-011"])
      rejects(() =>
        validateStorageDatabaseSchema(
          DATABASE_SCHEMA_PROFILES[`${name}-cf-metadata-v1`].map((row) =>
            row.name === "_cf_METADATA" ? change(row) : row,
          ),
          contractFor(),
        ),
      );
  });

for (const extra of [
  {
    type: "table",
    name: "_cf_OTHER",
    tbl_name: "_cf_OTHER",
    sql: "CREATE TABLE _cf_OTHER(v BLOB)",
  },
  {
    type: "trigger",
    name: "_cf_metadata_trigger",
    tbl_name: "_cf_METADATA",
    sql: "CREATE TRIGGER _cf_metadata_trigger AFTER INSERT ON _cf_METADATA BEGIN SELECT 1; END",
  },
  {
    type: "index",
    name: "_cf_metadata_index",
    tbl_name: "_cf_METADATA",
    sql: "CREATE INDEX _cf_metadata_index ON _cf_METADATA(value)",
  },
  {
    type: "view",
    name: "_cf_metadata_view",
    tbl_name: "_cf_metadata_view",
    sql: "CREATE VIEW _cf_metadata_view AS SELECT 1",
  },
  {
    ...DATABASE_SCHEMA_PROFILES["trial-010-cf-metadata-v1"].find(
      (r) => r.name === "_cf_METADATA",
    ),
  },
])
  test(`platform profile rejects extra ${extra.type} ${extra.name}`, () => {
    rejects(() =>
      validateStorageDatabaseSchema(
        [...DATABASE_SCHEMA_PROFILES["trial-010-cf-metadata-v1"], extra],
        contractFor(),
      ),
    );
  });

test("schema observations reject hidden, symbolic, sparse or accessor rows without evaluating them", () => {
  let accessed = 0;
  for (const mutate of [
    (rows) =>
      Object.defineProperty(rows[0], "sql", {
        enumerable: true,
        get() {
          accessed++;
          throw Error("must-not-read");
        },
      }),
    (rows) =>
      Object.defineProperty(rows, "0", {
        enumerable: true,
        get() {
          accessed++;
          throw Error("must-not-read");
        },
      }),
    (rows) => Object.defineProperty(rows, "0", { enumerable: false }),
    (rows) => Object.defineProperty(rows[0], "sql", { enumerable: false }),
    (rows) => {
      rows[Symbol("extra")] = true;
    },
    (rows) => {
      rows[0][Symbol("extra")] = true;
    },
    (rows) => {
      delete rows[0];
    },
    (rows) => Object.setPrototypeOf(rows, null),
  ]) {
    const rows = clone(DATABASE_SCHEMA_PROFILES["trial-010"]);
    mutate(rows);
    rejects(() => validateStorageDatabaseSchema(rows, contractFor()));
  }
  assert.equal(accessed, 0);
});

for (const [label, change] of [
  [
    "partial011",
    (rows) => rows.filter((r) => r.name !== "shelf_storage_activation_v2"),
  ],
  [
    "old005 mixed guard",
    (rows) =>
      rows.map((r) =>
        r.name === "shelf_single_trial_keep_imported"
          ? clone(
              STORAGE_SCHEMA_PROFILES["trial-v1"].find(
                (v) => v.name === r.name,
              ),
            )
          : r,
      ),
  ],
  [
    "internal SQL literal whitespace",
    (rows) =>
      rows.map((r) =>
        r.name === "shelf_storage_activation_v2"
          ? { ...r, sql: r.sql.replace("'closed'", "' closed'") }
          : r,
      ),
  ],
  [
    "extra012 object",
    (rows) => [
      ...rows,
      {
        type: "table",
        name: "shelf_job_control",
        tbl_name: "shelf_job_control",
        sql: "CREATE TABLE shelf_job_control(scope TEXT)",
      },
    ],
  ],
  [
    "unknown arbitrary object",
    (rows) => [
      ...rows,
      {
        type: "view",
        name: "unrelated",
        tbl_name: "unrelated",
        sql: "CREATE VIEW unrelated AS SELECT 1",
      },
    ],
  ],
  [
    "extra row field",
    (rows) => rows.map((r, i) => (i === 0 ? { ...r, extra: true } : r)),
  ],
  [
    "wrong primitive",
    (rows) => rows.map((r, i) => (i === 0 ? { ...r, sql: 1 } : r)),
  ],
  ["duplicate row", (rows) => [...rows, clone(rows[0])]],
  ["wrong result order", (rows) => rows.reverse()],
  [
    "no010 after011",
    (rows) => rows.filter((r) => !r.name.startsWith("shelf_prepared_")),
  ],
  [
    "wrong006",
    (rows) =>
      rows.map((r) =>
        r.name === "admission_private" ? { ...r, sql: r.sql + " drift" } : r,
      ),
  ],
])
  test(`whole DB profile rejects ${label}`, () =>
    rejects(() =>
      validateStorageDatabaseSchema(
        change(clone(DATABASE_SCHEMA_PROFILES["activation-011"])),
        contractFor(),
      ),
    ));

test("fixed SQL reads all application objects and ignores only declared platform/internal names", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const row of DATABASE_SCHEMA_PROFILES["trial-010"])
      if (row.type === "table") db.exec(row.sql);
    for (const row of DATABASE_SCHEMA_PROFILES["trial-010"])
      if (row.type !== "table") db.exec(row.sql);
    db.exec(
      "CREATE TABLE _cf_KV(key TEXT); CREATE TABLE d1_migrations(id INTEGER)",
    );
    validateStorageDatabaseSchema(
      db.prepare(STORAGE_DATABASE_SCHEMA_SQL).all(),
      contractFor(),
    );
    db.exec("CREATE TABLE shelf_job_control(scope TEXT)");
    assert.ok(
      db
        .prepare(STORAGE_DATABASE_SCHEMA_SQL)
        .all()
        .some((r) => r.name === "shelf_job_control"),
    );
    rejects(() =>
      validateStorageDatabaseSchema(
        db.prepare(STORAGE_DATABASE_SCHEMA_SQL).all(),
        contractFor(),
      ),
    );
    db.exec("DROP TABLE shelf_job_control");
    for (let i = 0; i < 300; i++) db.exec(`CREATE TABLE extra_${i}(v TEXT)`);
    const limited = db.prepare(STORAGE_DATABASE_SCHEMA_SQL).all();
    assert.equal(limited.length, 257);
    rejects(() => validateStorageDatabaseSchema(limited, contractFor()));
  } finally {
    db.close();
  }
});

test("fixed schema projection needs zero parameters and retains stated SQL/response bounds", () => {
  assert.ok(STORAGE_DATABASE_SCHEMA_SQL.startsWith("SELECT "));
  assert.equal(STORAGE_DATABASE_SCHEMA_SQL.includes("?"), false);
  assert.ok(
    Buffer.byteLength(STORAGE_DATABASE_SCHEMA_SQL) <
      STORAGE_DEPLOYMENT_LIMITS.sqlBytes,
  );
  for (const [name, rows] of Object.entries(DATABASE_SCHEMA_PROFILES)) {
    const metadata = DATABASE_SCHEMA_METADATA[name],
      schemaJson = JSON.stringify(rows);
    assert.equal(metadata.schemaBytes, Buffer.byteLength(schemaJson));
    assert.equal(
      metadata.projectedBytes,
      Buffer.byteLength(JSON.stringify({ schema_json: schemaJson })),
    );
    assert.ok(
      metadata.projectedBytes < STORAGE_DEPLOYMENT_LIMITS.responseBytes,
    );
    assert.equal(metadata.sha256, sha(schemaJson));
  }
});
