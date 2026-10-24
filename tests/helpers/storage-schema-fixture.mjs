/** Synthetic N1 fixture copied without changing the frozen N1 test contract. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  StorageActivationV2,
  STORAGE_ACTIVATION_V2_SOURCE,
  STORAGE_ACTIVATION_V2_SQL,
  STORAGE_ACTIVATION_V2_SCHEMA_SHA256,
  validateStorageActivationReceiptV2,
} from "../../server/storage-activation-v2.mjs";
const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
const accountId = "a".repeat(32),
  identity = {
    schemaVersion: 1,
    authorityId: "shelf-remote-storage-v1",
    accountId,
    bucket: "the-shelf-books",
    legacyDatabases: {
      check: "11111111-1111-4111-8111-111111111111",
      production: "22222222-2222-4222-8222-222222222222",
    },
  };
const target = {
  accountId,
  databaseId: identity.legacyDatabases.production,
  databaseName: "the-shelf-library",
};
const trialTargetHash = sha("synthetic isolated trial configuration");
const desc = (fileId, sizeBytes) => ({
  kind: "original",
  scope: "production",
  fileId,
  bookId: "book_" + fileId,
  format: "PDF",
  sizeBytes,
  sha256: "1".repeat(64),
  objectKey: `books/cf03/${fileId}/${"1".repeat(64)}.pdf`,
  versionHash: null,
  source: null,
});
function journal() {
  const claims = [];
  return {
    claims,
    async claim(v) {
      if (claims.length) return false;
      claims.push(v);
      return true;
    },
  };
}
export async function fixture(
  t,
  {
    install = true,
    legacy = 0,
    connectionFile,
    trialDescriptor,
    confirmTrial = true,
    claimTrial = true,
  } = {},
) {
  const db = new DatabaseSync(connectionFile || ":memory:");
  t.after(() => db.close());
  let now = Date.now();
  db.function("unixepoch", { varargs: true }, () => now / 1000);
  for (const name of [
    "schema.sql",
    "migrations/003-storage-authority.sql",
    "migrations/004-freeze-legacy-storage.sql",
    "migrations/005-single-trial.sql",
  ])
    db.exec(
      readFileSync(
        new URL("../../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    );
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase)VALUES(1,?,'migration_required')",
  ).run(JSON.stringify(identity));
  db.prepare("INSERT INTO shelf_storage_legacy_freeze VALUES(1,?,?,?,?,?)").run(
    identity.authorityId,
    accountId,
    identity.bucket,
    "synthetic_freeze",
    now - 1000,
  );
  const oldUnknown = desc("old_unknown", 7),
    oldConfirmed = desc("old_confirmed", 9);
  db.prepare("INSERT INTO catalog_books VALUES('production',?,?)").run(
    oldConfirmed.bookId,
    JSON.stringify({ id: oldConfirmed.bookId }),
  );
  for (const [id, d, state, etag, enabled] of [
    ["old_unknown", oldUnknown, "uncertain", null, null],
    ["old_confirmed", oldConfirmed, "confirmed", "old_etag", 1],
  ])
    db.prepare(
      "INSERT INTO shelf_storage_staging VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      `original:production:${d.fileId}:original`,
      d.objectKey,
      JSON.stringify(d),
      d.sizeBytes,
      state,
      etag,
      enabled,
      now - 1000,
    );
  for (const scope of ["check", "production"])
    db.prepare(
      "INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      scope,
      "f".repeat(64),
      "e".repeat(64),
      "{}",
      "{}",
      scope === "production" ? 2 : 0,
      scope === "production" ? 1 : 0,
      scope === "production" ? 9 : 0,
      scope === "production" ? 7 : 0,
    );
  const imported = {
    schemaVersion: 1,
    verificationScope: "migration-at-import-time",
    migrationHash: "f".repeat(64),
    sourceHashes: ["check", "production"].map((scope) => ({
      scope,
      sha256: "e".repeat(64),
    })),
    importedReservations: 2,
    committedBytes: 9,
    reservedBytes: 7,
    readbackSha256: "d".repeat(64),
    cloudWriteFreezeProven: false,
    databaseWriteFreezeProven: true,
    sourceProjectionVerified: true,
    freezeProofs: [],
    verifiedAt: now - 1000,
  };
  db.prepare(
    "UPDATE shelf_storage_authority SET phase='imported',migration_hash=?,readback_hash=?,receipt_json=? WHERE id=1",
  ).run(
    imported.migrationHash,
    imported.readbackSha256,
    JSON.stringify(imported),
  );
  const d = trialDescriptor || desc("trial_file", 24582);
  db.prepare(
    "INSERT INTO shelf_storage_single_trial VALUES(1,?,'2026-10-23-first-book',?,?,?,?,?,?,?,'reserved',0,0,NULL,?)",
  ).run(
    "consumed_once",
    JSON.stringify(identity),
    JSON.stringify({ accountId, bucket: "the-shelf-first-book-20261023" }),
    JSON.stringify(d),
    trialTargetHash,
    d.sizeBytes,
    now - 100,
    now + 60000,
    now - 100,
  );
  if (claimTrial)
    db.prepare(
      "UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1,updated_at=? WHERE id=1",
    ).run(now);
  if (confirmTrial)
    db.prepare(
      "UPDATE shelf_storage_single_trial SET state='confirmed',content_verified=1,etag='trial_etag',updated_at=? WHERE id=1",
    ).run(now);
  if (install) db.exec(STORAGE_ACTIVATION_V2_SOURCE);
  const addLegacy = (bytes = 72, id = "legacy_one") =>
    db
      .prepare(
        "INSERT INTO shelf_storage_legacy_liabilities_v2 VALUES(?,?,?,?,?,?)",
      )
      .run(id, sha(id), sha("proof"), bytes, 1, 3);
  if (legacy) addLegacy(legacy);
  const mutations = [],
    reads = [],
    j = journal();
  const adapter = (sqlDb = db, extra = {}) => ({
    target: { ...target },
    async select(sql, params) {
      reads.push(sql);
      return sqlDb.prepare(sql).all(...params);
    },
    async mutate(sql, params) {
      mutations.push({ sql, params });
      extra.beforeMutate?.();
      const rows = sqlDb.prepare(sql).all(...params);
      if (extra.loseResponse)
        throw Error("synthetic lost reply with token-should-not-escape");
      return rows;
    },
  });
  const verifier = async ({ context, contextSha256 }) => ({
    contextSha256,
    verifiedAt: now,
    legacySafety: {
      method: "complete-terminal-closure",
      evidenceKind: "complete-persisted-terminal-set",
      identitySha256: context.identitySha256,
      snapshotSha256: context.snapshotSha256,
      verifiedAt: now,
      evidenceSha256: sha("independently verified synthetic terminal set"),
      details: {
        versionSetSha256: sha("complete synthetic versions"),
        durableLedgerSha256: sha("complete synthetic ledger"),
        possibleWrites: 2,
        terminalWrites: 2,
        coverageComplete: true,
      },
      databaseWriteFreezeProven: true,
      sourceProjectionVerified: true,
      legacyEntryPointsDisabled: true,
      legacyProcessesStopped: true,
      legacyConnectionsClosed: true,
      probeWriteCapabilityDisabled: true,
      allPossibleWritesTerminal: true,
    },
    deployment: {
      mode: "authority-v2",
      configurationSha256: sha("synthetic dual target deployment"),
      versionId: "33333333-3333-4333-8333-333333333333",
      productionDatabaseId: target.databaseId,
      trialTargetSha256: trialTargetHash,
      dualSourceReadVerified: true,
      trialOperatorClosed: true,
      normalWritesClosed: true,
    },
    evidence: {
      accountEvidence: {
        schemaVersion: 1,
        source: "cloudflare-account-aggregate",
        targetAccount: accountId,
        accountMatch: true,
        completeCoverage: true,
        plan: "free",
        storageClass: "Standard",
        storedBytes: 0,
        observedAt: new Date(now - 1).toISOString(),
        billingPeriod: new Date(now).toISOString().slice(0, 7),
        classAOperations: 0,
        classBOperations: 0,
      },
      provider: {
        schemaVersion: 1,
        contractSha256: sha("synthetic source contract"),
        observationSha256: sha("synthetic complete observation"),
        completeCoverageVerified: true,
        sourceTimeVerified: true,
        billingCountersVerified: true,
        freeStandardVerified: true,
      },
      observedAt: now - 1,
    },
  });
  const create = (options = {}) =>
    new StorageActivationV2({
      database: adapter(),
      identity,
      verifyExternal: verifier,
      journal: j,
      now: () => now,
      ...options,
    });
  const expected = async (a) => {
    const v = await a.inspect();
    return {
      migrationHash: v.migrationHash,
      snapshotSha256: v.snapshotSha256,
      schemaSha256: v.schemaSha256,
    };
  };
  return {
    db,
    create,
    adapter,
    verifier,
    journal: j,
    mutations,
    reads,
    expected,
    addLegacy,
    get now() {
      return now;
    },
    advance(n) {
      now += n;
    },
  };
}
export async function activate(f, options = {}) {
  const a = f.create(options);
  return a.activateImportedV2(await f.expected(a));
}

export { identity, desc };
