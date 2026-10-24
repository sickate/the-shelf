/** Pure fixed-project contracts. No transport, environment discovery or secret values. */
import {
  STORAGE_SCHEMA_PROFILES,
  DATABASE_SCHEMA_PROFILES,
  STORAGE_SCHEMA_METADATA,
  DATABASE_SCHEMA_METADATA,
  STORAGE_DATABASE_SCHEMA_SQL,
} from "./storage-schema-profiles.mjs";

export { STORAGE_DATABASE_SCHEMA_SQL };
export const STORAGE_DEPLOYMENT_LIMITS = Object.freeze({
  bindings: 32,
  databaseSchemaRows: 256,
  databaseSchemaQueryLimit: 257,
  storageSchemaRows: 128,
  responseBytes: 1_048_576,
  sqlBytes: 100_000,
  parameters: 100,
});
export const STORAGE_SECRET_PROFILES = Object.freeze({
  "ordinary-v1": Object.freeze([
    "OWNER_KEY_PEPPER",
    "SESSION_SECRET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ]),
  "trial-retained-v1": Object.freeze([
    "OWNER_KEY_PEPPER",
    "SESSION_SECRET",
    "SINGLE_TRIAL_UPLOAD_SECRET",
  ]),
  "trial-retained-filename-v1": Object.freeze([
    "OWNER_KEY_PEPPER",
    "SESSION_SECRET",
    "SINGLE_TRIAL_UPLOAD_SECRET",
    "FILENAME_AI_KEY",
  ]),
});
const NORMAL_BUCKET = "the-shelf-books";
const TRIAL_BUCKET = "the-shelf-first-book-20261023";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const contracts = new WeakSet();
const encoder = new TextEncoder();
export class StorageDeploymentContractError extends Error {
  constructor(code = "configuration") {
    super(`storage_deployment_${code}`);
    this.name = "StorageDeploymentContractError";
    this.code = `storage_deployment_${code}`;
  }
}
const fail = (code) => {
  throw new StorageDeploymentContractError(code);
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
};
// Parsed JSON records only. Reject accessors/symbols/non-enumerable fields rather
// than executing or silently dropping them during a purported exact observation.
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
  if (
    names.some(
      (name) =>
        typeof name !== "string" ||
        !descriptors[name].enumerable ||
        !Object.hasOwn(descriptors[name], "value"),
    )
  )
    return null;
  return names;
}
const exact = (value, names) => {
  const actual = keys(value);
  return (
    actual !== null &&
    actual.length === names.length &&
    actual.every((name) => names.includes(name))
  );
};
function canonical(value, ancestors = new Set(), depth = 0) {
  if (depth > 32) fail("observation");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  )
    return value;
  if (!value || typeof value !== "object" || ancestors.has(value))
    fail("observation");
  ancestors.add(value);
  let output;
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 4096 ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      fail("observation");
    output = Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        fail("observation");
      return canonical(descriptor.value, ancestors, depth + 1);
    });
  } else {
    const names = keys(value);
    if (names === null) fail("observation");
    output = Object.fromEntries(
      names
        .sort()
        .map((name) => [name, canonical(value[name], ancestors, depth + 1)]),
    );
  }
  ancestors.delete(value);
  return output;
}
function json(value) {
  const result = JSON.stringify(canonical(value));
  if (
    encoder.encode(result).byteLength > STORAGE_DEPLOYMENT_LIMITS.responseBytes
  )
    fail("response_limit");
  return result;
}
function identityValue(input) {
  if (
    !exact(input, [
      "schemaVersion",
      "authorityId",
      "accountId",
      "bucket",
      "legacyDatabases",
    ]) ||
    input.schemaVersion !== 1 ||
    input.authorityId !== "shelf-remote-storage-v1" ||
    typeof input.accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(input.accountId) ||
    input.bucket !== NORMAL_BUCKET ||
    !exact(input.legacyDatabases, ["check", "production"]) ||
    !Object.values(input.legacyDatabases).every(
      (value) => typeof value === "string" && UUID.test(value),
    ) ||
    input.legacyDatabases.check === input.legacyDatabases.production
  )
    fail("identity");
  return {
    schemaVersion: 1,
    authorityId: input.authorityId,
    accountId: input.accountId,
    bucket: NORMAL_BUCKET,
    legacyDatabases: {
      check: input.legacyDatabases.check,
      production: input.legacyDatabases.production,
    },
  };
}
function assertContract(contract) {
  if (!contract || !contracts.has(contract)) fail("configuration");
}

export function storageDeploymentContract(input) {
  const names = keys(input),
    required = [
      "profile",
      "identity",
      "filenameAi",
      "preparedText",
      "retainedSecrets",
    ];
  if (
    !names ||
    required.some((name) => !names.includes(name)) ||
    names.some(
      (name) => ![...required, "scope", "trialTargetSha256"].includes(name),
    )
  )
    fail("configuration");
  const { profile, filenameAi, preparedText, retainedSecrets } = input,
    scope = Object.hasOwn(input, "scope") ? input.scope : "production";
  if (
    !["legacy-v1", "trial-v1", "authority-v2-closed"].includes(profile) ||
    !["check", "production"].includes(scope) ||
    typeof filenameAi !== "boolean" ||
    typeof preparedText !== "boolean" ||
    typeof retainedSecrets !== "string" ||
    !Object.hasOwn(STORAGE_SECRET_PROFILES, retainedSecrets)
  )
    fail("configuration");
  const identity = identityValue(input.identity),
    trial = profile !== "legacy-v1",
    v2 = profile === "authority-v2-closed";
  if (
    (trial &&
      (scope !== "production" ||
        typeof input.trialTargetSha256 !== "string" ||
        !HASH.test(input.trialTargetSha256))) ||
    (!trial &&
      (filenameAi ||
        preparedText ||
        Object.hasOwn(input, "trialTargetSha256") ||
        retainedSecrets !== "ordinary-v1")) ||
    (trial &&
      retainedSecrets !==
        (filenameAi ? "trial-retained-filename-v1" : "trial-retained-v1")) ||
    (v2 && (!filenameAi || retainedSecrets !== "trial-retained-filename-v1"))
  )
    fail("configuration");
  const worker = scope === "production" ? "the-shelf" : "the-shelf-cf03-check",
    origin = `https://${worker}.iamzhutuo.workers.dev`;
  const vars = {
    APP_SCOPE: scope,
    SITE_ORIGIN: origin,
    R2_ACCOUNT_ID: identity.accountId,
    R2_BUCKET: trial && !v2 ? TRIAL_BUCKET : NORMAL_BUCKET,
    ...(v2
      ? {
          STORAGE_MODE: "authority-v2",
          STORAGE_WRITE_MODE: "closed",
          TRIAL_R2_ACCOUNT_ID: identity.accountId,
          TRIAL_R2_BUCKET: TRIAL_BUCKET,
          TRIAL_TARGET_SHA256: input.trialTargetSha256,
        }
      : trial
        ? {
            SINGLE_TRIAL_MODE: "first-book-20261023",
            SINGLE_TRIAL_TARGET_SHA256: input.trialTargetSha256,
          }
        : {}),
    ...(filenameAi ? { FILENAME_AI_MODE: "filename-v1" } : {}),
    ...(preparedText
      ? {
          PREPARED_TEXT_MODE: "registry-v1",
          PREPARED_R2_ACCOUNT_ID: identity.accountId,
          PREPARED_R2_BUCKET: NORMAL_BUCKET,
        }
      : {}),
  };
  const databaseSchemaProfiles = !trial
    ? []
    : v2
      ? preparedText
        ? ["trial-010", "activation-011"]
        : ["trial-009", "trial-010", "activation-011"]
      : preparedText
        ? ["trial-010"]
        : ["trial-009", "trial-010"];
  const completeDatabaseProfiles = {
    "trial-009": ["trial-009", "trial-009-cf-metadata-v1"],
    "trial-010": ["trial-010", "trial-010-cf-metadata-v1"],
    "activation-011": ["activation-011", "activation-011-cf-metadata-v1"],
  };
  const result = {
    schemaVersion: 1,
    profile,
    scope,
    worker,
    origin,
    identity,
    filenameAi,
    preparedText,
    retainedSecrets,
    vars,
    d1Bindings: [
      {
        binding: "DB",
        database_name:
          scope === "production" ? "the-shelf-library" : "the-shelf-cf03-check",
        database_id: identity.legacyDatabases[scope],
      },
    ],
    r2Bindings: [
      { binding: "BOOKS", bucket_name: vars.R2_BUCKET },
      ...(v2 ? [{ binding: "TRIAL_BOOKS", bucket_name: TRIAL_BUCKET }] : []),
      ...(preparedText
        ? [{ binding: "PREPARED_BOOKS", bucket_name: NORMAL_BUCKET }]
        : []),
    ],
    assetBinding: scope === "production" ? "ASSETS" : null,
    secretNames: [...STORAGE_SECRET_PROFILES[retainedSecrets]],
    allowedStorageLayouts: v2
      ? ["trial-v1", "activation-v2"]
      : [trial ? "trial-v1" : "legacy-v1"],
    schemaFeatures: {
      preparedRequired: preparedText,
      admission: trial ? "006-single-trial-admission" : "legacy",
      databaseSchemaProfiles: databaseSchemaProfiles.flatMap(
        (name) => completeDatabaseProfiles[name],
      ),
    },
    canonicalProfile: null,
  };
  const { canonicalProfile: _, ...snapshot } = result;
  result.canonicalProfile = json(snapshot);
  freeze(result);
  contracts.add(result);
  return result;
}

function bindingMatches(binding, contract, expected) {
  const names = keys(binding);
  if (
    names === null ||
    typeof binding.name !== "string" ||
    typeof binding.type !== "string"
  )
    return false;
  if (expected.type === "d1") {
    if (
      binding.type !== "d1" ||
      names.some(
        (name) => !["name", "type", "id", "database_id"].includes(name),
      ) ||
      (!Object.hasOwn(binding, "id") && !Object.hasOwn(binding, "database_id"))
    )
      return false;
    return ["id", "database_id"].every(
      (name) => !Object.hasOwn(binding, name) || binding[name] === expected.id,
    );
  }
  if (expected.type === "r2_bucket")
    return (
      binding.type === expected.type &&
      binding.bucket_name === expected.bucket_name &&
      names.every((name) =>
        ["name", "type", "bucket_name", "jurisdiction", "account_id"].includes(
          name,
        ),
      ) &&
      (!Object.hasOwn(binding, "jurisdiction") ||
        binding.jurisdiction === "default") &&
      (!Object.hasOwn(binding, "account_id") ||
        binding.account_id === contract.identity.accountId)
    );
  if (expected.type === "plain_text")
    return (
      exact(binding, ["name", "type", "text"]) &&
      binding.type === "plain_text" &&
      binding.text === expected.text
    );
  return exact(binding, ["name", "type"]) && binding.type === expected.type;
}

/** Explicit staticOnly never infers a rollback or accepts a partial dynamic set. */
export function validateRemoteStorageBindings(
  settings,
  contract,
  options = {},
) {
  assertContract(contract);
  if (!exact(options, []) && !exact(options, ["staticOnly"]))
    fail("configuration");
  const staticOnly = Object.hasOwn(options, "staticOnly")
    ? options.staticOnly
    : false;
  if (
    typeof staticOnly !== "boolean" ||
    (staticOnly && contract.scope !== "production")
  )
    fail("configuration");
  const expected = [
    ...(staticOnly
      ? []
      : [
          { name: "DB", type: "d1", id: contract.d1Bindings[0].database_id },
          ...contract.r2Bindings.map((b) => ({
            name: b.binding,
            type: "r2_bucket",
            bucket_name: b.bucket_name,
          })),
          ...Object.entries(contract.vars).map(([name, text]) => ({
            name,
            type: "plain_text",
            text,
          })),
        ]),
    ...(contract.assetBinding
      ? [{ name: contract.assetBinding, type: "assets" }]
      : []),
    ...contract.secretNames.map((name) => ({ name, type: "secret_text" })),
  ];
  if (
    keys(settings) === null ||
    !Array.isArray(settings.bindings) ||
    settings.bindings.length !== expected.length ||
    settings.bindings.length > STORAGE_DEPLOYMENT_LIMITS.bindings
  )
    fail("bindings");
  // Validate the complete observation before reading binding properties.
  const canonicalSettingsJson = json(settings),
    copy = JSON.parse(canonicalSettingsJson),
    seen = new Set();
  for (const binding of copy.bindings) {
    const name = binding?.name,
      wanted = expected.find((v) => v.name === name);
    if (!wanted || seen.has(name) || !bindingMatches(binding, contract, wanted))
      fail("bindings");
    seen.add(name);
  }
  const canonicalBindings = [...copy.bindings].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return freeze({
    canonicalBindings,
    canonicalBindingsJson: json(canonicalBindings),
    canonicalSettingsJson,
  });
}

function schemaRows(rows, limit) {
  if (!Array.isArray(rows) || rows.length > limit) fail("schema");
  const seen = new Set();
  const copy = JSON.parse(json(rows));
  return copy.map((row) => {
    if (
      !exact(row, ["type", "name", "tbl_name", "sql"]) ||
      !["table", "trigger", "view", "index"].includes(row.type) ||
      ![row.name, row.tbl_name, row.sql].every(
        (value) => typeof value === "string" && value.length > 0,
      ) ||
      seen.has(row.name)
    )
      fail("schema");
    seen.add(row.name);
    return {
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql: row.sql.trim().replace(/;$/, ""),
    };
  });
}
function equalRows(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((row, i) =>
      ["type", "name", "tbl_name", "sql"].every(
        (name) => row[name] === expected[i][name],
      ),
    )
  );
}
export function validateStorageNamespaceSchema(rows) {
  const actual = schemaRows(rows, STORAGE_DEPLOYMENT_LIMITS.storageSchemaRows);
  const layout = Object.keys(STORAGE_SCHEMA_PROFILES).find((name) =>
    equalRows(actual, STORAGE_SCHEMA_PROFILES[name]),
  );
  if (!layout) fail("schema");
  return freeze({
    layout,
    ...STORAGE_SCHEMA_METADATA[layout],
    schemaJson: JSON.stringify(actual),
  });
}

/** Whole DB comparison, including 006/010. 012 and all other unknown rows fail. */
export function validateStorageDatabaseSchema(rows, contract) {
  assertContract(contract);
  if (contract.schemaFeatures.databaseSchemaProfiles.length === 0)
    fail("schema_profile_unavailable");
  const actual = schemaRows(rows, STORAGE_DEPLOYMENT_LIMITS.databaseSchemaRows);
  const profile = contract.schemaFeatures.databaseSchemaProfiles.find((name) =>
    equalRows(actual, DATABASE_SCHEMA_PROFILES[name]),
  );
  if (!profile) fail("schema");
  return freeze({
    profile,
    storageLayout:
      profile === "activation-011" ||
      profile === "activation-011-cf-metadata-v1"
        ? "activation-v2"
        : "trial-v1",
    ...DATABASE_SCHEMA_METADATA[profile],
    schemaJson: JSON.stringify(actual),
  });
}
