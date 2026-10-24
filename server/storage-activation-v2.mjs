/** Private, fixed-target activation protocol. No transport, credentials or upload path.
 * database.select/mutate and verifier/journal are trusted operator dependencies.
 * No production verifier or durable journal is supplied by this module.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { objectDescriptor } from "./storage-authority.mjs";
const logicalKey = (d) =>
  `${d.kind}:${d.scope}:${d.fileId}:${d.kind === "original" ? "original" : d.versionHash}`;

const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
const isHash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const clone = (v) => {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    fail("storage_v2_proof_invalid");
  }
};
const fail = (code) => {
  throw new StorageActivationV2Error(code);
};
export class StorageActivationV2Error extends Error {
  constructor(code) {
    super(code);
    this.name = "StorageActivationV2Error";
    this.code = code;
  }
}
function exact(v, keys, code = "storage_v2_proof_invalid") {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail(code);
}
function identityValue(v) {
  exact(
    v,
    ["schemaVersion", "authorityId", "accountId", "bucket", "legacyDatabases"],
    "storage_v2_identity_invalid",
  );
  exact(
    v.legacyDatabases,
    ["check", "production"],
    "storage_v2_identity_invalid",
  );
  if (
    v.schemaVersion !== 1 ||
    v.authorityId !== "shelf-remote-storage-v1" ||
    !/^[a-f0-9]{32}$/.test(v.accountId || "") ||
    v.bucket !== "the-shelf-books" ||
    !Object.values(v.legacyDatabases).every(uuid) ||
    v.legacyDatabases.check === v.legacyDatabases.production
  )
    fail("storage_v2_identity_invalid");
  return {
    schemaVersion: 1,
    authorityId: v.authorityId,
    accountId: v.accountId,
    bucket: v.bucket,
    legacyDatabases: {
      check: v.legacyDatabases.check,
      production: v.legacyDatabases.production,
    },
  };
}
const normalizeSchema = (rows) =>
  rows.map((r) => ({
    type: r.type,
    name: r.name,
    tbl_name: r.tbl_name,
    sql: r.sql.trim().replace(/;$/, ""),
  }));
const schemaSql =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB 'shelf_storage_*' OR name GLOB 'shelf_single_trial_*' OR name GLOB 'shelf_legacy_*') ORDER BY type,name LIMIT 129";
export const STORAGE_ACTIVATION_V2_SOURCE = readFileSync(
  new URL(
    "../cloudflare/library/migrations/011-storage-activation-v2.sql",
    import.meta.url,
  ),
  "utf8",
);
export const STORAGE_ACTIVATION_V2_MIGRATION_SHA256 =
  "db532d26cbe6dc3639cb9f5a32ae85ad6f0943ab7b2fc1fabe974bd1bfc3a0c3";
if (
  hash(STORAGE_ACTIVATION_V2_SOURCE) !== STORAGE_ACTIVATION_V2_MIGRATION_SHA256
)
  fail("storage_v2_source_invalid");
// Derive the exact expected final schema from trusted repository SQL, never remote input.
const schemaDb = new DatabaseSync(":memory:");
try {
  for (const name of [
    "schema.sql",
    "migrations/003-storage-authority.sql",
    "migrations/004-freeze-legacy-storage.sql",
    "migrations/005-single-trial.sql",
  ])
    schemaDb.exec(
      readFileSync(
        new URL("../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    );
  schemaDb
    .prepare(
      "INSERT INTO shelf_storage_authority(id,identity_json,phase)VALUES(1,?,'migration_required')",
    )
    .run("{}");
  for (const scope of ["check", "production"])
    schemaDb
      .prepare("INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run(scope, "a".repeat(64), "b".repeat(64), "{}", "{}", 0, 0, 0, 0);
  schemaDb
    .prepare(
      "UPDATE shelf_storage_authority SET phase='imported',migration_hash=?,readback_hash=?,receipt_json='{}' WHERE id=1",
    )
    .run("a".repeat(64), "b".repeat(64));
  schemaDb.exec(STORAGE_ACTIVATION_V2_SOURCE);
} catch {
  schemaDb.close();
  fail("storage_v2_source_invalid");
}
export const STORAGE_ACTIVATION_V2_SCHEMA = Object.freeze(
  normalizeSchema(schemaDb.prepare(schemaSql).all()).map(Object.freeze),
);
schemaDb.close();
export const STORAGE_ACTIVATION_V2_SCHEMA_SHA256 = hash(
  STORAGE_ACTIVATION_V2_SCHEMA,
);
export const STORAGE_ACTIVATION_V2_SQL = Object.freeze({
  schema: schemaSql,
  counts:
    "SELECT (SELECT count(*) FROM shelf_storage_sources) AS sources,(SELECT count(*) FROM shelf_storage_staging) AS staging,(SELECT count(*) FROM shelf_storage_reservations) AS reservations,(SELECT count(*) FROM shelf_storage_original_registry) AS originals,(SELECT count(*) FROM shelf_storage_text_registry) AS texts,(SELECT count(*) FROM file_registry) AS projections,(SELECT count(*) FROM shelf_storage_single_trial) AS trial,(SELECT count(*) FROM shelf_storage_legacy_liabilities_v2) AS legacy,(SELECT count(*) FROM shelf_storage_legacy_freeze) AS freeze",
  snapshot: "SELECT snapshot_json FROM shelf_storage_snapshot_v2 LIMIT 2",
  activation: "SELECT * FROM shelf_storage_activation_v2 WHERE id=1 LIMIT 2",
  published:
    "SELECT r.receipt_hash,r.receipt_json,r.snapshot_json,e.evidence_hash,e.evidence_json FROM shelf_storage_activation_v2 v JOIN shelf_storage_activation_receipts_v2 r ON r.receipt_hash=v.receipt_hash JOIN shelf_storage_evidence_v2 e ON e.evidence_hash=v.evidence_hash WHERE v.id=1 LIMIT 2",
  activate:
    "UPDATE shelf_storage_activation_v2 SET state='active',generation=1,snapshot_json=?,receipt_json=?,receipt_hash=?,evidence_json=?,evidence_hash=?,activated_at=? WHERE id=1 AND state='closed' AND generation=0 AND identity_json=? AND migration_hash=? AND imported_receipt_json=? AND imported_readback_hash=? AND EXISTS(SELECT 1 FROM shelf_storage_snapshot_v2 WHERE snapshot_json=?) RETURNING id,generation,receipt_hash",
});
function single(rows, code) {
  if (!Array.isArray(rows) || rows.length !== 1) fail(code);
  return rows[0];
}
const same = (a, b) => hash(a) === hash(b);
const binaryCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
async function bounded(operation, deadlineMs, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new StorageActivationV2Error(code)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function sums(s) {
  const result = {
    normalCommitted: 0,
    normalReserved: 0,
    trialCommitted: 0,
    trialReserved: 0,
    legacyReserved: 0,
  };
  for (const r of s.reservations) {
    if (
      !integer(r.size, 1, 20_000_000) ||
      !["reserved", "uploading", "uncertain", "confirmed"].includes(r.state)
    )
      fail("storage_v2_snapshot_invalid");
    result[r.state === "confirmed" ? "normalCommitted" : "normalReserved"] +=
      r.size;
  }
  for (const t of s.trial) {
    if (
      !integer(t.size, 1, 20_000_000) ||
      t.state !== "confirmed" ||
      t.attempted !== 1 ||
      t.verified !== 1
    )
      fail("storage_v2_trial_unresolved");
    result.trialCommitted += t.size;
  }
  for (const l of s.legacy) {
    if (!integer(l.bytes, 1, 8_000_000_000))
      fail("storage_v2_snapshot_invalid");
    result.legacyReserved += l.bytes;
  }
  return result;
}
function parseSnapshot(text, identity) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1_000_000)
    fail("storage_v2_snapshot_limit");
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    fail("storage_v2_snapshot_invalid");
  }
  exact(
    s,
    [
      "authority",
      "sources",
      "staging",
      "reservations",
      "original",
      "text",
      "projection",
      "trial",
      "legacy",
      "freeze",
    ],
    "storage_v2_snapshot_invalid",
  );
  for (const k of [
    "sources",
    "staging",
    "reservations",
    "original",
    "text",
    "projection",
    "trial",
    "legacy",
    "freeze",
  ])
    if (!Array.isArray(s[k]) || s[k].length > 1000)
      fail("storage_v2_snapshot_limit");
  if (
    s.authority.identity !== JSON.stringify(identity) ||
    !["imported", "ready"].includes(s.authority.phase) ||
    !isHash(s.authority.migrationHash) ||
    !isHash(s.authority.readback)
  )
    fail("storage_v2_identity_invalid");
  if (
    s.sources.length !== 2 ||
    s.sources[0].scope !== "check" ||
    s.sources[1].scope !== "production" ||
    s.sources.some(
      (v) =>
        v.migrationHash !== s.authority.migrationHash ||
        !isHash(v.snapshotHash),
    )
  )
    fail("storage_v2_source_changed");
  if (
    s.freeze.length !== 1 ||
    s.freeze[0].authority !== identity.authorityId ||
    s.freeze[0].account !== identity.accountId ||
    s.freeze[0].bucket !== identity.bucket
  )
    fail("storage_v2_freeze_unproven");
  if (s.trial.length !== 1) fail("storage_v2_trial_required");
  const t = s.trial[0];
  let target, descriptor;
  try {
    target = JSON.parse(t.target);
    descriptor = JSON.parse(t.descriptor);
  } catch {
    fail("storage_v2_trial_invalid");
  }
  try {
    objectDescriptor(descriptor);
  } catch {
    fail("storage_v2_trial_invalid");
  }
  if (
    t.identity !== JSON.stringify(identity) ||
    t.consent !== "2026-10-23-first-book" ||
    !isHash(t.targetHash) ||
    !same(target, {
      accountId: identity.accountId,
      bucket: "the-shelf-first-book-20261023",
    }) ||
    descriptor.sizeBytes !== t.size ||
    descriptor.kind !== "original" ||
    descriptor.scope !== "production"
  )
    fail("storage_v2_trial_invalid");
  if (
    !integer(t.issued) ||
    !integer(t.expires) ||
    t.expires <= t.issued ||
    t.expires > t.issued + 86400000 ||
    !integer(t.updated) ||
    t.updated < t.issued ||
    typeof t.etag !== "string" ||
    t.etag.length < 1
  )
    fail("storage_v2_trial_invalid");
  for (const r of s.reservations) {
    let d;
    try {
      d = objectDescriptor(JSON.parse(r.descriptor));
    } catch {
      fail("storage_v2_snapshot_invalid");
    }
    if (
      r.logical !== logicalKey(d) ||
      r.key !== d.objectKey ||
      r.size !== d.sizeBytes ||
      (r.state === "confirmed" &&
        (r.verified !== 1 || typeof r.etag !== "string" || !r.etag.length))
    )
      fail("storage_v2_snapshot_invalid");
  }
  const imported = new Map(s.staging.map((r) => [r.id, r]));
  if (
    imported.size !== s.staging.length ||
    (s.authority.phase === "imported" &&
      s.reservations.length !== s.staging.length)
  )
    fail("storage_v2_source_changed");
  for (const r of s.reservations) {
    const old = imported.get(r.id);
    if (!old) {
      if (s.authority.phase === "imported") fail("storage_v2_source_changed");
      continue;
    }
    if (
      ["logical", "key", "descriptor", "size", "created"].some(
        (k) => old[k] !== r[k],
      ) ||
      (s.authority.phase === "imported" &&
        (old.state !== r.state ||
          old.etag !== r.etag ||
          r.attempted !== 1 ||
          r.verified !== (old.state === "confirmed" ? 1 : 0)))
    )
      fail("storage_v2_source_changed");
  }
  for (const source of s.sources) {
    const rows = s.staging.filter(
      (r) => JSON.parse(r.descriptor).scope === source.scope,
    );
    if (
      rows.length !== source.reservations ||
      rows.filter((r) => r.state === "confirmed").length !== source.registry ||
      rows
        .filter((r) => r.state === "confirmed")
        .reduce((n, r) => n + r.size, 0) !== source.committed ||
      rows
        .filter((r) => r.state === "uncertain")
        .reduce((n, r) => n + r.size, 0) !== source.reserved
    )
      fail("storage_v2_source_changed");
  }
  if (s.authority.phase === "imported") {
    let receipt;
    try {
      receipt = JSON.parse(s.authority.receipt);
    } catch {
      fail("storage_v2_source_changed");
    }
    if (
      receipt.schemaVersion !== 1 ||
      receipt.verificationScope !== "migration-at-import-time" ||
      receipt.migrationHash !== s.authority.migrationHash ||
      receipt.readbackSha256 !== s.authority.readback ||
      receipt.databaseWriteFreezeProven !== true ||
      receipt.sourceProjectionVerified !== true ||
      receipt.importedReservations !== s.staging.length ||
      !same(
        receipt.sourceHashes,
        s.sources.map((r) => ({ scope: r.scope, sha256: r.snapshotHash })),
      )
    )
      fail("storage_v2_source_changed");
  }
  const expectedRegistry = (kind) =>
    s.reservations
      .filter(
        (r) =>
          r.state === "confirmed" && JSON.parse(r.descriptor).kind === kind,
      )
      .map((r) => ({
        logical: r.logical,
        id: r.id,
        descriptor: r.descriptor,
        etag: r.etag,
        enabled: imported.get(r.id)?.enabled ?? 1,
      }))
      .sort((a, b) => binaryCompare(a.logical, b.logical));
  if (
    !same(s.original, expectedRegistry("original")) ||
    !same(s.text, expectedRegistry("prepared-text"))
  )
    fail("storage_v2_projection_invalid");
  const projections = s.original
    .filter(
      (r) => r.enabled === 1 && JSON.parse(r.descriptor).scope === "production",
    )
    .map((r) => {
      const d = JSON.parse(r.descriptor);
      return {
        scope: d.scope,
        file: d.fileId,
        book: d.bookId,
        format: d.format,
        size: d.sizeBytes,
        key: d.objectKey,
        hash: d.sha256,
        etag: r.etag,
        state: "confirmed",
      };
    })
    .sort((a, b) => binaryCompare(a.file, b.file));
  if (
    !same(
      s.projection.map(({ version, updated, ...r }) => r),
      projections,
    )
  )
    fail("storage_v2_projection_invalid");
  const responsibility = sums(s),
    committed = responsibility.normalCommitted + responsibility.trialCommitted,
    reserved =
      responsibility.normalReserved +
      responsibility.trialReserved +
      responsibility.legacyReserved;
  if (
    !integer(committed) ||
    !integer(reserved) ||
    committed !== s.authority.committed ||
    reserved !== s.authority.reserved
  )
    fail("storage_v2_accounting_mismatch");
  if (committed + reserved > 8_000_000_000) fail("storage_v2_budget_exceeded");
  return { snapshot: s, responsibility, committed, reserved };
}
const evidenceKeys = [
  "schemaVersion",
  "source",
  "targetAccount",
  "accountMatch",
  "completeCoverage",
  "plan",
  "storageClass",
  "storedBytes",
  "observedAt",
  "billingPeriod",
  "classAOperations",
  "classBOperations",
];
function validateEvidence(e, identity, now) {
  exact(e, ["accountEvidence", "provider", "observedAt"]);
  exact(e.accountEvidence, evidenceKeys);
  exact(e.provider, [
    "schemaVersion",
    "contractSha256",
    "observationSha256",
    "completeCoverageVerified",
    "sourceTimeVerified",
    "billingCountersVerified",
    "freeStandardVerified",
  ]);
  const a = e.accountEvidence,
    p = e.provider,
    at = Date.parse(a.observedAt);
  if (
    a.schemaVersion !== 1 ||
    a.source !== "cloudflare-account-aggregate" ||
    a.targetAccount !== identity.accountId ||
    a.accountMatch !== true ||
    a.completeCoverage !== true ||
    a.plan !== "free" ||
    a.storageClass !== "Standard" ||
    !integer(a.storedBytes) ||
    !integer(a.classAOperations, 0, 799999) ||
    !integer(a.classBOperations, 0, 7999999) ||
    !integer(at) ||
    a.observedAt !== new Date(at).toISOString() ||
    e.observedAt !== at ||
    at > now ||
    at < now - 300000 ||
    a.billingPeriod !== new Date(now).toISOString().slice(0, 7) ||
    p.schemaVersion !== 1 ||
    !isHash(p.contractSha256) ||
    !isHash(p.observationSha256) ||
    [
      p.completeCoverageVerified,
      p.sourceTimeVerified,
      p.billingCountersVerified,
      p.freeStandardVerified,
    ].some((v) => v !== true)
  )
    fail("storage_v2_account_evidence_invalid");
  return clone(e);
}
const safetyFlags = [
  "databaseWriteFreezeProven",
  "sourceProjectionVerified",
  "legacyEntryPointsDisabled",
  "legacyProcessesStopped",
  "legacyConnectionsClosed",
  "probeWriteCapabilityDisabled",
  "allPossibleWritesTerminal",
];
function validateSafety(v, context, now) {
  exact(v, [
    "method",
    "evidenceKind",
    "identitySha256",
    "snapshotSha256",
    "verifiedAt",
    "evidenceSha256",
    "details",
    ...safetyFlags,
  ]);
  // B is a candidate design, never an accepted activation proof in N1.
  if (
    v.method !== "complete-terminal-closure" ||
    ![
      "enforced-transport-deadline",
      "complete-persisted-terminal-set",
    ].includes(v.evidenceKind) ||
    v.identitySha256 !== context.identitySha256 ||
    v.snapshotSha256 !== context.snapshotSha256 ||
    !isHash(v.evidenceSha256) ||
    !integer(v.verifiedAt) ||
    v.verifiedAt > now ||
    v.verifiedAt < now - 300000 ||
    safetyFlags.some((k) => v[k] !== true)
  )
    fail("storage_v2_write_safety_unproven");
  if (v.evidenceKind === "complete-persisted-terminal-set") {
    exact(v.details, [
      "versionSetSha256",
      "durableLedgerSha256",
      "possibleWrites",
      "terminalWrites",
      "coverageComplete",
    ]);
    if (
      !isHash(v.details.versionSetSha256) ||
      !isHash(v.details.durableLedgerSha256) ||
      !integer(v.details.possibleWrites) ||
      v.details.terminalWrites !== v.details.possibleWrites ||
      v.details.coverageComplete !== true
    )
      fail("storage_v2_write_safety_unproven");
  } else {
    exact(v.details, [
      "configurationSha256",
      "maxRequestLifetimeMs",
      "stoppedAt",
      "drainedAt",
    ]);
    if (
      !isHash(v.details.configurationSha256) ||
      !integer(v.details.maxRequestLifetimeMs, 1) ||
      !integer(v.details.stoppedAt) ||
      !integer(v.details.drainedAt) ||
      !integer(v.details.stoppedAt + v.details.maxRequestLifetimeMs) ||
      v.details.drainedAt <
        v.details.stoppedAt + v.details.maxRequestLifetimeMs ||
      v.details.drainedAt > v.verifiedAt
    )
      fail("storage_v2_write_safety_unproven");
  }
}
function validateDeployment(v, identity) {
  exact(v, [
    "mode",
    "configurationSha256",
    "versionId",
    "productionDatabaseId",
    "trialTargetSha256",
    "dualSourceReadVerified",
    "trialOperatorClosed",
    "normalWritesClosed",
  ]);
  if (
    v.mode !== "authority-v2" ||
    !isHash(v.configurationSha256) ||
    !uuid(v.versionId) ||
    v.productionDatabaseId !== identity.legacyDatabases.production ||
    !isHash(v.trialTargetSha256) ||
    v.dualSourceReadVerified !== true ||
    v.trialOperatorClosed !== true ||
    v.normalWritesClosed !== true
  )
    fail("storage_v2_deployment_unproven");
}
export function validateStorageActivationReceiptV2(
  receipt,
  { identity: input, snapshotJson, evidence, now = Date.now() } = {},
) {
  const identity = identityValue(input);
  if (!integer(now)) fail("storage_v2_clock_invalid");
  exact(receipt, [
    "schemaVersion",
    "verificationScope",
    "identitySha256",
    "migrationHash",
    "snapshotSha256",
    "schemaSha256",
    "verifiedSchemaSha256",
    "importedReceiptSha256",
    "normalTarget",
    "trialTarget",
    "sourceHashes",
    "trialSha256",
    "committedBytes",
    "reservedBytes",
    "responsibilities",
    "legacySafety",
    "deployment",
    "evidenceHash",
    "verifiedAt",
  ]);
  const v = parseSnapshot(snapshotJson, identity),
    s = v.snapshot;
  if (
    s.authority.phase !== "imported" ||
    receipt.schemaVersion !== 2 ||
    receipt.verificationScope !== "activation-at-imported" ||
    receipt.identitySha256 !== hash(identity) ||
    receipt.migrationHash !== s.authority.migrationHash ||
    receipt.snapshotSha256 !== hash(snapshotJson) ||
    receipt.schemaSha256 !== STORAGE_ACTIVATION_V2_SCHEMA_SHA256 ||
    receipt.verifiedSchemaSha256 !== STORAGE_ACTIVATION_V2_SCHEMA_SHA256 ||
    receipt.importedReceiptSha256 !== hash(s.authority.receipt) ||
    !same(receipt.normalTarget, {
      accountId: identity.accountId,
      bucket: identity.bucket,
    }) ||
    !same(receipt.trialTarget, {
      accountId: identity.accountId,
      bucket: "the-shelf-first-book-20261023",
    }) ||
    !same(
      receipt.sourceHashes,
      s.sources.map((r) => ({ scope: r.scope, sha256: r.snapshotHash })),
    ) ||
    receipt.trialSha256 !== hash(s.trial) ||
    receipt.committedBytes !== v.committed ||
    receipt.reservedBytes !== v.reserved ||
    !same(receipt.responsibilities, v.responsibility) ||
    !integer(receipt.verifiedAt) ||
    receipt.verifiedAt > now ||
    receipt.verifiedAt < now - 300000
  )
    fail("storage_v2_receipt_invalid");
  validateSafety(receipt.legacySafety, receipt, now);
  validateDeployment(receipt.deployment, identity);
  if (receipt.deployment.trialTargetSha256 !== s.trial[0].targetHash)
    fail("storage_v2_deployment_unproven");
  const e = validateEvidence(evidence, identity, now);
  if (
    receipt.verifiedAt < receipt.legacySafety.verifiedAt ||
    receipt.evidenceHash !== hash(e) ||
    e.accountEvidence.storedBytes + v.committed + v.reserved > 8_000_000_000
  )
    fail("storage_v2_budget_or_receipt_invalid");
  return clone(receipt);
}

export class StorageActivationV2 {
  #database;
  #identity;
  #target;
  #verifier;
  #journal;
  #now;
  #deadlineMs;
  #attempted = false;
  constructor({
    database,
    identity,
    verifyExternal,
    journal,
    now = Date.now,
    deadlineMs = 30000,
  } = {}) {
    this.#identity = identityValue(identity);
    exact(
      database?.target,
      ["accountId", "databaseId", "databaseName"],
      "storage_v2_target_invalid",
    );
    if (
      database.target.accountId !== this.#identity.accountId ||
      database.target.databaseId !==
        this.#identity.legacyDatabases.production ||
      database.target.databaseName !== "the-shelf-library" ||
      typeof database.select !== "function" ||
      typeof database.mutate !== "function" ||
      typeof now !== "function" ||
      !integer(deadlineMs, 1, 30000)
    )
      fail("storage_v2_target_invalid");
    this.#database = database;
    this.#target = clone(database.target);
    this.#verifier = verifyExternal;
    this.#journal = journal;
    this.#now = now;
    this.#deadlineMs = deadlineMs;
  }
  #assertTarget() {
    if (!same(this.#target, this.#database.target))
      fail("storage_v2_target_changed");
  }
  async #select(sql, params = []) {
    this.#assertTarget();
    let rows;
    try {
      rows = await bounded(
        () => this.#database.select(sql, params),
        this.#deadlineMs,
        "storage_v2_read_failed",
      );
    } catch {
      fail("storage_v2_read_failed");
    }
    this.#assertTarget();
    return rows;
  }
  async #read() {
    const schema = await this.#select(STORAGE_ACTIVATION_V2_SQL.schema);
    if (
      schema.length !== STORAGE_ACTIVATION_V2_SCHEMA.length ||
      !same(normalizeSchema(schema), STORAGE_ACTIVATION_V2_SCHEMA)
    )
      fail("storage_v2_schema_incomplete");
    const counts = single(
      await this.#select(STORAGE_ACTIVATION_V2_SQL.counts),
      "storage_v2_snapshot_invalid",
    );
    if (
      Object.values(counts).some((n) => !integer(n, 0, 1000)) ||
      counts.sources !== 2 ||
      counts.trial !== 1 ||
      counts.freeze !== 1
    )
      fail("storage_v2_snapshot_limit");
    const activation = single(
      await this.#select(STORAGE_ACTIVATION_V2_SQL.activation),
      "storage_v2_activation_missing",
    );
    const snapshotJson = single(
      await this.#select(STORAGE_ACTIVATION_V2_SQL.snapshot),
      "storage_v2_snapshot_invalid",
    ).snapshot_json;
    const parsed = parseSnapshot(snapshotJson, this.#identity),
      a = parsed.snapshot.authority;
    if (
      activation.identity_json !== JSON.stringify(this.#identity) ||
      activation.migration_hash !== a.migrationHash ||
      (activation.state === "closed" &&
        (a.phase !== "imported" ||
          a.receipt !== activation.imported_receipt_json ||
          a.readback !== activation.imported_readback_hash))
    )
      fail("storage_v2_source_changed");
    if (activation.state === "active") {
      const p = single(
        await this.#select(STORAGE_ACTIVATION_V2_SQL.published),
        "storage_v2_publication_invalid",
      );
      if (
        a.phase !== "ready" ||
        activation.generation !== 1 ||
        p.receipt_json !== activation.receipt_json ||
        p.snapshot_json !== activation.snapshot_json ||
        p.evidence_json !== activation.evidence_json ||
        p.receipt_hash !== hash(p.receipt_json) ||
        p.evidence_hash !== hash(p.evidence_json) ||
        a.receipt !== p.receipt_json ||
        a.readback !== hash(p.snapshot_json)
      )
        fail("storage_v2_publication_invalid");
      validateStorageActivationReceiptV2(JSON.parse(p.receipt_json), {
        identity: this.#identity,
        snapshotJson: p.snapshot_json,
        evidence: JSON.parse(p.evidence_json),
        now: activation.activated_at,
      });
    } else if (activation.state !== "closed" || activation.generation !== 0)
      fail("storage_v2_activation_invalid");
    return { activation, snapshotJson, ...parsed };
  }
  async inspect() {
    const r = await this.#read();
    return {
      state: r.activation.state,
      generation: r.activation.generation,
      migrationHash: r.snapshot.authority.migrationHash,
      snapshotSha256: hash(r.snapshotJson),
      schemaSha256: STORAGE_ACTIVATION_V2_SCHEMA_SHA256,
      committedBytes: r.committed,
      reservedBytes: r.reserved,
      responsibilities: clone(r.responsibility),
      receiptHash: r.activation.receipt_hash,
      activationAllowed: false,
    };
  }
  async activateImportedV2(expected) {
    // No proof argument, environment switch or caller JSON can stand in for a verifier.
    if (
      typeof this.#verifier !== "function" ||
      typeof this.#journal?.claim !== "function"
    )
      fail("storage_v2_verifier_required");
    if (this.#attempted) fail("storage_v2_attempt_retained");
    exact(
      expected,
      ["migrationHash", "snapshotSha256", "schemaSha256"],
      "storage_v2_expected_invalid",
    );
    const before = await this.#read();
    if (before.activation.state !== "closed") fail("storage_v2_already_active");
    const context = {
      identitySha256: hash(this.#identity),
      migrationHash: before.snapshot.authority.migrationHash,
      snapshotSha256: hash(before.snapshotJson),
      schemaSha256: STORAGE_ACTIVATION_V2_SCHEMA_SHA256,
    };
    if (
      expected.migrationHash !== context.migrationHash ||
      expected.snapshotSha256 !== context.snapshotSha256 ||
      expected.schemaSha256 !== context.schemaSha256
    )
      fail("storage_v2_expected_changed");
    let proof;
    try {
      proof = await bounded(
        () =>
          this.#verifier({
            identity: clone(this.#identity),
            context: clone(context),
            snapshot: clone(before.snapshot),
            contextSha256: hash(context),
          }),
        this.#deadlineMs,
        "storage_v2_external_verification_failed",
      );
    } catch {
      fail("storage_v2_external_verification_failed");
    }
    exact(proof, [
      "contextSha256",
      "verifiedAt",
      "legacySafety",
      "deployment",
      "evidence",
    ]);
    if (proof.contextSha256 !== hash(context)) fail("storage_v2_proof_unbound");
    const now = this.#now();
    if (!integer(now)) fail("storage_v2_clock_invalid");
    const evidence = validateEvidence(proof.evidence, this.#identity, now);
    const receipt = {
      schemaVersion: 2,
      verificationScope: "activation-at-imported",
      ...context,
      verifiedSchemaSha256: STORAGE_ACTIVATION_V2_SCHEMA_SHA256,
      importedReceiptSha256: hash(before.snapshot.authority.receipt),
      normalTarget: {
        accountId: this.#identity.accountId,
        bucket: this.#identity.bucket,
      },
      trialTarget: {
        accountId: this.#identity.accountId,
        bucket: "the-shelf-first-book-20261023",
      },
      sourceHashes: before.snapshot.sources.map((s) => ({
        scope: s.scope,
        sha256: s.snapshotHash,
      })),
      trialSha256: hash(before.snapshot.trial),
      committedBytes: before.committed,
      reservedBytes: before.reserved,
      responsibilities: before.responsibility,
      legacySafety: clone(proof.legacySafety),
      deployment: clone(proof.deployment),
      evidenceHash: hash(evidence),
      verifiedAt: proof.verifiedAt,
    };
    validateStorageActivationReceiptV2(receipt, {
      identity: this.#identity,
      snapshotJson: before.snapshotJson,
      evidence,
      now,
    });
    const final = await this.#read();
    if (
      final.snapshotJson !== before.snapshotJson ||
      final.activation.state !== "closed"
    )
      fail("storage_v2_source_changed");
    const receiptJson = JSON.stringify(receipt),
      evidenceJson = JSON.stringify(evidence),
      receiptHash = hash(receiptJson);
    // Trusted durable journal must claim this fixed authority operation exactly once.
    // It must not use a caller-selected run ID as the uniqueness key.
    this.#attempted = true;
    let claimed;
    try {
      claimed = await bounded(
        () =>
          this.#journal.claim({
            operation: "shelf-storage-activation-v2",
            identitySha256: context.identitySha256,
            target: clone(this.#target),
            receiptHash,
            snapshotSha256: context.snapshotSha256,
          }),
        this.#deadlineMs,
        "storage_v2_journal_unknown",
      );
    } catch {
      fail("storage_v2_journal_unknown");
    }
    if (claimed !== true) fail("storage_v2_attempt_retained");
    this.#assertTarget();
    let rows;
    try {
      rows = await bounded(
        () =>
          this.#database.mutate(STORAGE_ACTIVATION_V2_SQL.activate, [
            before.snapshotJson,
            receiptJson,
            receiptHash,
            evidenceJson,
            receipt.evidenceHash,
            now,
            JSON.stringify(this.#identity),
            context.migrationHash,
            before.activation.imported_receipt_json,
            before.activation.imported_readback_hash,
            before.snapshotJson,
          ]),
        this.#deadlineMs,
        "storage_v2_outcome_unknown",
      );
    } catch {
      fail("storage_v2_outcome_unknown");
    }
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0].id !== 1 ||
      rows[0].generation !== 1 ||
      rows[0].receipt_hash !== receiptHash
    )
      fail("storage_v2_outcome_unknown");
    let after;
    try {
      after = await this.#read();
    } catch {
      fail("storage_v2_outcome_unknown");
    }
    if (
      after.activation.state !== "active" ||
      after.activation.receipt_hash !== receiptHash
    )
      fail("storage_v2_outcome_unknown");
    return {
      state: "active",
      generation: 1,
      receiptHash,
      snapshotSha256: context.snapshotSha256,
      committedBytes: after.committed,
      reservedBytes: after.reserved,
    };
  }
}
