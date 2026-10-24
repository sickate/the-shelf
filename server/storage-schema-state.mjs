/** Exact Node-only storage layouts. No credentials, transport or mutation API. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  bytesSha256,
  identityValue,
  StorageError,
  STORAGE_CEILING,
} from "./storage-authority.mjs";
import {
  STORAGE_ACTIVATION_V2_SCHEMA,
  STORAGE_ACTIVATION_V2_SQL,
  validateStorageActivationReceiptV2,
} from "./storage-activation-v2.mjs";

const fail = (code) => {
  throw new StorageError(code);
};
const normalize = (rows) =>
  rows.map((r) => ({
    type: r.type,
    name: r.name,
    tbl_name: r.tbl_name,
    sql: typeof r.sql === "string" ? r.sql.trim().replace(/;$/, "") : null,
  }));
const profiles = {};
// SQLite serializes these ordered rows in the same property order as the pinned
// manifest. SQL literal contents are compared byte-for-byte, never rewritten.
export const STORAGE_SCHEMA_MANIFEST_SQL =
  "(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB 'shelf_storage_*' OR name GLOB 'shelf_single_trial_*' OR name GLOB 'shelf_legacy_*') ORDER BY type,name LIMIT 129))";
const db = new DatabaseSync(":memory:");
try {
  for (const name of [
    "schema.sql",
    "migrations/003-storage-authority.sql",
    "migrations/004-freeze-legacy-storage.sql",
  ])
    db.exec(
      readFileSync(
        new URL("../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    );
  profiles["legacy-v1"] = normalize(
    db.prepare(STORAGE_ACTIVATION_V2_SQL.schema).all(),
  );
  db.exec(
    readFileSync(
      new URL(
        "../cloudflare/library/migrations/005-single-trial.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  profiles["trial-v1"] = normalize(
    db.prepare(STORAGE_ACTIVATION_V2_SQL.schema).all(),
  );
} finally {
  db.close();
}
profiles["activation-v2"] = STORAGE_ACTIVATION_V2_SCHEMA;
export const STORAGE_SCHEMA_PROFILES = Object.freeze(
  Object.fromEntries(
    Object.entries(profiles).map(([k, v]) => [
      k,
      Object.freeze(v.map((r) => Object.freeze({ ...r }))),
    ]),
  ),
);
const v2Names = new Set(
  STORAGE_ACTIVATION_V2_SCHEMA.filter(
    (r) => !profiles["trial-v1"].some((old) => old.name === r.name),
  ).map((r) => r.name),
);
export const STORAGE_SCHEMA_STATE_SQL = Object.freeze({
  schema: STORAGE_ACTIVATION_V2_SQL.schema,
  legacyAudit:
    "SELECT a.*,COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0) AS actual_committed,COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0) AS actual_reserved FROM shelf_storage_authority a WHERE id=1",
  trialAudit:
    "SELECT a.*,COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state='confirmed'),0) AS actual_committed,COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state<>'confirmed'),0) AS actual_reserved FROM shelf_storage_authority a WHERE id=1",
  v2Audit:
    "SELECT a.*,(SELECT normal_committed+trial_committed FROM shelf_storage_responsibility_v2) AS actual_committed,(SELECT normal_reserved+trial_reserved+legacy_reserved FROM shelf_storage_responsibility_v2) AS actual_reserved FROM shelf_storage_authority a WHERE id=1",
  publication:
    "SELECT v.*,r.receipt_hash AS published_receipt_hash,r.receipt_json AS published_receipt_json,r.snapshot_json AS published_snapshot_json,e.evidence_hash AS published_evidence_hash,e.evidence_json AS published_evidence_json FROM shelf_storage_activation_v2 v LEFT JOIN shelf_storage_activation_receipts_v2 r ON r.receipt_hash=v.receipt_hash LEFT JOIN shelf_storage_evidence_v2 e ON e.evidence_hash=v.evidence_hash WHERE v.id=1 LIMIT 2",
});

export async function readStorageSchemaState({
  query,
  expectedLayout,
  requireTrial = false,
}) {
  const rows = normalize(
    await query(
      STORAGE_SCHEMA_STATE_SQL.schema,
      [],
      "production",
      "verify-single-trial-schema",
    ),
  );
  const serialized = JSON.stringify(rows);
  const layout = Object.keys(profiles).find(
    (key) => serialized === JSON.stringify(profiles[key]),
  );
  if (!layout) {
    if (rows.some((r) => v2Names.has(r.name) || r.name.endsWith("_v2")))
      fail("storage_v2_schema_incomplete");
    if (
      rows.some(
        (r) =>
          r.name === "shelf_storage_single_trial" ||
          r.name.startsWith("shelf_single_trial_"),
      )
    )
      fail("single_trial_schema_invalid");
    fail("storage_schema_invalid");
  }
  if (expectedLayout && layout !== expectedLayout)
    fail("storage_schema_changed");
  if (requireTrial && layout === "legacy-v1")
    fail("single_trial_schema_required");
  return Object.freeze({ layout, schemaSha256: bytesSha256(serialized) });
}

export async function readStorageAuthorityState({
  query,
  identity: input,
  schema,
}) {
  const identity = identityValue(input);
  const sql =
    schema.layout === "activation-v2"
      ? STORAGE_SCHEMA_STATE_SQL.v2Audit
      : schema.layout === "trial-v1"
        ? STORAGE_SCHEMA_STATE_SQL.trialAudit
        : STORAGE_SCHEMA_STATE_SQL.legacyAudit;
  const rows = await query(
    sql.replace(
      "SELECT a.*",
      `SELECT a.*,${STORAGE_SCHEMA_MANIFEST_SQL} AS storage_schema_json`,
    ),
  );
  const a = rows[0];
  if (rows.length !== 1 || a.identity_json !== JSON.stringify(identity))
    fail("storage_identity_mismatch");
  if (a.storage_schema_json !== JSON.stringify(profiles[schema.layout]))
    fail("storage_schema_changed");
  if (
    ![
      a.actual_committed,
      a.actual_reserved,
      a.committed_bytes,
      a.reserved_bytes,
    ].every((v) => Number.isSafeInteger(v) && v >= 0) ||
    (a.observed_bytes !== null &&
      (!Number.isSafeInteger(a.observed_bytes) || a.observed_bytes < 0)) ||
    a.actual_committed !== a.committed_bytes ||
    a.actual_reserved !== a.reserved_bytes
  )
    fail("storage_ledger_mismatch");
  if (schema.layout === "activation-v2")
    await readActivationPublication({ query, identity, authority: a });
  return a;
}

export async function readActivationPublication({
  query,
  identity,
  authority: a,
}) {
  const rows = await query(STORAGE_SCHEMA_STATE_SQL.publication);
  const v = rows[0];
  if (
    rows.length !== 1 ||
    v.identity_json !== JSON.stringify(identity) ||
    v.migration_hash !== a.migration_hash
  )
    fail("storage_v2_publication_invalid");
  if (v.state === "closed") {
    if (
      v.generation !== 0 ||
      a.phase !== "imported" ||
      a.receipt_json !== v.imported_receipt_json ||
      a.readback_hash !== v.imported_readback_hash
    )
      fail("storage_v2_publication_invalid");
  } else if (v.state === "active") {
    if (
      v.generation !== 1 ||
      a.phase !== "ready" ||
      v.receipt_json !== v.published_receipt_json ||
      v.snapshot_json !== v.published_snapshot_json ||
      v.evidence_json !== v.published_evidence_json ||
      v.receipt_hash !== v.published_receipt_hash ||
      v.evidence_hash !== v.published_evidence_hash ||
      v.receipt_hash !== bytesSha256(v.receipt_json) ||
      v.evidence_hash !== bytesSha256(v.evidence_json) ||
      a.receipt_json !== v.receipt_json ||
      a.readback_hash !== bytesSha256(v.snapshot_json)
    )
      fail("storage_v2_publication_invalid");
    try {
      const evidence = JSON.parse(v.evidence_json);
      validateStorageActivationReceiptV2(JSON.parse(v.receipt_json), {
        identity,
        snapshotJson: v.snapshot_json,
        evidence,
        now: v.activated_at,
      });
      // This batch supplies no evidence refresh producer. The current authority
      // reference must still resolve to the exact immutable accepted evidence.
      if (
        a.evidence_hash !== v.evidence_hash ||
        a.observed_bytes !== evidence.accountEvidence.storedBytes ||
        a.observed_at !== evidence.observedAt ||
        a.billing_period !== evidence.accountEvidence.billingPeriod
      )
        fail("storage_v2_publication_invalid");
    } catch {
      fail("storage_v2_publication_invalid");
    }
    if (
      BigInt(a.observed_bytes) +
        BigInt(a.committed_bytes) +
        BigInt(a.reserved_bytes) >
      BigInt(STORAGE_CEILING)
    )
      fail("storage_budget_exceeded");
  } else fail("storage_v2_publication_invalid");
  return {
    state: v.state,
    generation: v.generation,
    receiptHash: v.receipt_hash,
  };
}
