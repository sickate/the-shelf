import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  StorageActivationV2,
  STORAGE_ACTIVATION_V2_SOURCE,
  STORAGE_ACTIVATION_V2_SQL,
  STORAGE_ACTIVATION_V2_SCHEMA_SHA256,
  validateStorageActivationReceiptV2,
} from "../server/storage-activation-v2.mjs";
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
async function fixture(t, { install = true, legacy = 0, connectionFile } = {}) {
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
        new URL("../cloudflare/library/" + name, import.meta.url),
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
  const d = desc("trial_file", 24582);
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
  db.prepare(
    "UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1,updated_at=? WHERE id=1",
  ).run(now);
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
async function activate(f, options = {}) {
  const a = f.create(options);
  return a.activateImportedV2(await f.expected(a));
}
const history = (db) =>
  JSON.stringify(
    [
      "shelf_storage_sources",
      "shelf_storage_staging",
      "shelf_storage_reservations",
      "shelf_storage_original_registry",
      "shelf_storage_text_registry",
      "shelf_storage_single_trial",
      "shelf_storage_legacy_freeze",
    ].map((name) => db.prepare(`SELECT * FROM ${name}`).all()),
  );

test("N1 is disconnected: default verifier refuses before any activation write", async (t) => {
  const f = await fixture(t),
    a = f.create({ verifyExternal: undefined });
  await assert.rejects(a.activateImportedV2({}), {
    code: "storage_v2_verifier_required",
  });
  assert.equal(f.mutations.length, 0);
  assert.equal(f.journal.claims.length, 0);
  assert.equal((await a.inspect()).state, "closed");
});
test("single CAS preserves all history and accounts normal + consumed trial + retained legacy once", async (t) => {
  const f = await fixture(t, { legacy: 72 }),
    before = history(f.db);
  const result = await activate(f);
  assert.equal(result.state, "active");
  assert.equal(f.mutations.length, 1);
  assert.equal(result.committedBytes, 24591);
  assert.equal(result.reservedBytes, 79);
  assert.equal(history(f.db), before);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM shelf_storage_activation_receipts_v2")
      .get().n,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT phase FROM shelf_storage_authority").get().phase,
    "ready",
  );
  assert.equal(
    (await f.create().inspect()).responsibilities.trialCommitted,
    24582,
  );
  await assert.rejects(activate(f), { code: "storage_v2_already_active" });
  assert.equal(f.mutations.length, 1);
});
test("legacy responsibility cannot be removed or admitted twice and never creates another balance", async (t) => {
  const f = await fixture(t, { legacy: 72 });
  assert.throws(() => f.addLegacy(), /UNIQUE/);
  for (const sql of [
    "DELETE FROM shelf_storage_legacy_liabilities_v2",
    "UPDATE shelf_storage_legacy_liabilities_v2 SET max_bytes=1",
    "UPDATE shelf_storage_authority SET reserved_bytes=7",
  ])
    assert.throws(() => f.db.exec(sql), /retained|accounting/);
  assert.equal((await f.create().inspect()).reservedBytes, 79);
});
test("direct old ready/receipt/evidence paths fail closed without v2 CAS", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.db.exec("UPDATE shelf_storage_authority SET phase='ready'"),
    /activation_required|keeps_imported/,
  );
  assert.throws(
    () =>
      f.db
        .prepare(
          "INSERT INTO shelf_storage_activation_receipts_v2 VALUES(?,?,?)",
        )
        .run("a".repeat(64), "{}", "{}"),
    /unbound/,
  );
  assert.throws(
    () =>
      f.db
        .prepare("INSERT INTO shelf_storage_evidence_v2 VALUES(?,?)")
        .run("a".repeat(64), "{}"),
    /unbound/,
  );
  assert.throws(
    () =>
      f.db.exec(
        "UPDATE shelf_storage_activation_v2 SET state='active',generation=1,receipt_json='{}'",
      ),
    /activation_invalid|CHECK/,
  );
});
for (const [label, change, code] of [
  [
    "bounded residual is not yet accepted",
    (p) => {
      p.legacySafety.method = "bounded-persisted-liability";
    },
    "storage_v2_write_safety_unproven",
  ],
  [
    "unknown terminal remains unknown",
    (p) => {
      p.legacySafety.allPossibleWritesTerminal = false;
    },
    "storage_v2_write_safety_unproven",
  ],
  [
    "caller true string is not true",
    (p) => {
      p.legacySafety.legacyProcessesStopped = "true";
    },
    "storage_v2_write_safety_unproven",
  ],
  [
    "proof cannot be rebound",
    (p) => {
      p.contextSha256 = "b".repeat(64);
    },
    "storage_v2_proof_unbound",
  ],
  [
    "normal binding mismatch",
    (p) => {
      p.deployment.productionDatabaseId = identity.legacyDatabases.check;
    },
    "storage_v2_deployment_unproven",
  ],
  [
    "trial target hash mismatch",
    (p) => {
      p.deployment.trialTargetSha256 = "b".repeat(64);
    },
    "storage_v2_deployment_unproven",
  ],
  [
    "trial operator left enabled",
    (p) => {
      p.deployment.trialOperatorClosed = false;
    },
    "storage_v2_deployment_unproven",
  ],
  [
    "old v1 mode",
    (p) => {
      p.deployment.mode = "authority-v1";
    },
    "storage_v2_deployment_unproven",
  ],
  [
    "observer is not a producer",
    (p) => {
      p.evidence.accountEvidence.completeCoverage = false;
    },
    "storage_v2_account_evidence_invalid",
  ],
  [
    "missing source contract",
    (p) => {
      p.evidence.provider.contractSha256 = null;
    },
    "storage_v2_account_evidence_invalid",
  ],
  [
    "sample rate cannot prove coverage",
    (p) => {
      p.evidence.provider.completeCoverageVerified = false;
    },
    "storage_v2_account_evidence_invalid",
  ],
  [
    "wrong account",
    (p) => {
      p.evidence.accountEvidence.targetAccount = "b".repeat(32);
    },
    "storage_v2_account_evidence_invalid",
  ],
  [
    "unknown plan",
    (p) => {
      p.evidence.accountEvidence.plan = "unknown";
    },
    "storage_v2_account_evidence_invalid",
  ],
  [
    "full month A guard",
    (p) => {
      p.evidence.accountEvidence.classAOperations = 800000;
    },
    "storage_v2_account_evidence_invalid",
  ],
  [
    "full month B guard",
    (p) => {
      p.evidence.accountEvidence.classBOperations = 8000000;
    },
    "storage_v2_account_evidence_invalid",
  ],
  [
    "unknown fields are rejected",
    (p) => {
      p.evidence.accountEvidence.fetchedAt = Date.now();
    },
    "storage_v2_proof_invalid",
  ],
])
  test(`zero-write verifier rejection: ${label}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      activate(f, {
        verifyExternal: async (c) => {
          const p = await f.verifier(c);
          change(p);
          return p;
        },
      }),
      { code },
    );
    assert.equal(f.mutations.length, 0);
    assert.equal(f.journal.claims.length, 0);
  });
test("future and stale source time fail; fetching now does not refresh source", async (t) => {
  const f = await fixture(t);
  for (const offset of [1, -300001]) {
    await assert.rejects(
      activate(f, {
        verifyExternal: async (c) => {
          const p = await f.verifier(c),
            at = f.now + offset;
          p.evidence.observedAt = at;
          p.evidence.accountEvidence.observedAt = new Date(at).toISOString();
          return p;
        },
      }),
      { code: "storage_v2_account_evidence_invalid" },
    );
  }
  assert.equal(f.mutations.length, 0);
});
test("journal absence/unknown/retained prevents all activation dispatches", async (t) => {
  const f = await fixture(t);
  for (const [j, code] of [
    [undefined, "storage_v2_verifier_required"],
    [{ claim: async () => false }, "storage_v2_attempt_retained"],
    [
      {
        claim: async () => {
          throw Error("secret");
        },
      },
      "storage_v2_journal_unknown",
    ],
  ])
    await assert.rejects(activate(f, { journal: j }), { code });
  assert.equal(f.mutations.length, 0);
});
test("source drift while external verifier awaits aborts before journal or CAS", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    activate(f, {
      verifyExternal: async (c) => {
        const p = await f.verifier(c);
        f.addLegacy();
        return p;
      },
    }),
    { code: "storage_v2_source_changed" },
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(f.journal.claims.length, 0);
});
test("source drift between final read and CAS is checked inside SQLite", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    activate(f, {
      database: f.adapter(f.db, { beforeMutate: () => f.addLegacy() }),
    }),
    { code: "storage_v2_outcome_unknown" },
  );
  assert.equal(f.mutations.length, 1);
  assert.equal((await f.create().inspect()).state, "closed");
  await assert.rejects(activate(f), { code: "storage_v2_attempt_retained" });
  assert.equal(f.mutations.length, 1);
});
test("CAS response loss is retained; fresh inspect proves publication without reactivation", async (t) => {
  const f = await fixture(t),
    a = f.create({ database: f.adapter(f.db, { loseResponse: true }) }),
    exp = await f.expected(a);
  await assert.rejects(a.activateImportedV2(exp), {
    code: "storage_v2_outcome_unknown",
  });
  await assert.rejects(a.activateImportedV2(exp), {
    code: "storage_v2_attempt_retained",
  });
  assert.equal(f.mutations.length, 1);
  assert.equal((await f.create().inspect()).state, "active");
  assert.equal(f.journal.claims.length, 1);
});
test("8GB exact accepted with full retained trial/unknown responsibility; +1 rejected before CAS", async (t) => {
  const f = await fixture(t, { legacy: 72 }),
    count = 24591 + 79;
  const withBytes = (bytes) => ({
    verifyExternal: async (c) => {
      const p = await f.verifier(c);
      p.evidence.accountEvidence.storedBytes = bytes;
      return p;
    },
  });
  await assert.rejects(activate(f, withBytes(8000000000 - count + 1)), {
    code: "storage_v2_budget_or_receipt_invalid",
  });
  assert.equal(f.mutations.length, 0);
  await activate(f, withBytes(8000000000 - count));
  assert.equal(f.mutations.length, 1);
});
test("regular last-byte reservations compete atomically; existing exact-full reservation can claim", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shelf-activation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.db"),
    f = await fixture(t, { connectionFile: file });
  await activate(f, {
    verifyExternal: async (c) => {
      const p = await f.verifier(c);
      p.evidence.accountEvidence.storedBytes = 8000000000 - 24598 - 1;
      return p;
    },
  });
  const second = new DatabaseSync(file);
  t.after(() => second.close());
  second.function("unixepoch", { varargs: true }, () => f.now / 1000);
  const insert = (db, id, bytes = 1) => {
    const d = desc(id, bytes);
    return db
      .prepare(
        "INSERT INTO shelf_storage_reservations VALUES(?,?,?,?,?,'reserved',0,0,NULL,?,?)",
      )
      .run(
        id,
        `original:production:${id}:original`,
        d.objectKey,
        JSON.stringify(d),
        bytes,
        f.now,
        f.now,
      );
  };
  const results = await Promise.allSettled([
    Promise.resolve().then(() => insert(f.db, "last_one")),
    Promise.resolve().then(() => insert(second, "last_two")),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /budget/,
  );
  const r = f.db
    .prepare(
      "SELECT reservation_id FROM shelf_storage_reservations WHERE state='reserved'",
    )
    .get();
  f.db
    .prepare(
      "UPDATE shelf_storage_reservations SET state='uploading',put_attempted=1 WHERE reservation_id=?",
    )
    .run(r.reservation_id);
  assert.equal(
    f.db
      .prepare(
        "SELECT observed_bytes+committed_bytes+reserved_bytes AS n FROM shelf_storage_authority",
      )
      .get().n,
    8000000000,
  );
  assert.throws(() => insert(second, "too_large", 20000001), /CHECK|budget/);
});
test("two independent activators use SQLite CAS and only one can win", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shelf-activation-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.db"),
    f = await fixture(t, { connectionFile: file }),
    second = new DatabaseSync(file);
  t.after(() => second.close());
  second.function("unixepoch", { varargs: true }, () => f.now / 1000);
  let release;
  const gate = new Promise((r) => (release = r));
  let arrivals = 0;
  const pausedJournal = () => ({
    async claim() {
      if (++arrivals === 2) release();
      await gate;
      return true;
    },
  });
  const a = f.create({ journal: pausedJournal() }),
    b = f.create({ database: f.adapter(second), journal: pausedJournal() }),
    exp = await f.expected(a);
  const results = await Promise.allSettled([
    a.activateImportedV2(exp),
    b.activateImportedV2(exp),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM shelf_storage_activation_receipts_v2")
      .get().n,
    1,
  );
  assert.equal((await f.create().inspect()).generation, 1);
});
test("partial installation always keeps ready/ordinary admission closed and is not silently repaired", async (t) => {
  const f = await fixture(t, { install: false });
  // Stop after the first durable guard, before the activation table exists.
  const cut = STORAGE_ACTIVATION_V2_SOURCE.indexOf(
    "CREATE TABLE shelf_storage_activation_v2",
  );
  f.db.exec(STORAGE_ACTIVATION_V2_SOURCE.slice(0, cut));
  assert.throws(
    () => f.db.exec("UPDATE shelf_storage_authority SET phase='ready'"),
    /no such table|keeps_imported/,
  );
  await assert.rejects(f.create().inspect(), {
    code: "storage_v2_schema_incomplete",
  });
  assert.equal(f.mutations.length, 0);
});
test("missing or changed protected schema blocks even a valid external verifier", async (t) => {
  const f = await fixture(t);
  f.db.exec("DROP TRIGGER shelf_storage_v2_accounting");
  await assert.rejects(activate(f), { code: "storage_v2_schema_incomplete" });
  assert.equal(f.mutations.length, 0);
});
test("installation requires imported and never re-installs on active ready", async (t) => {
  const f = await fixture(t);
  await activate(f);
  assert.throws(
    () => f.db.exec(STORAGE_ACTIVATION_V2_SOURCE),
    /malformed JSON/,
  );
  assert.equal((await f.create().inspect()).state, "active");
});
test("immutable publication, trial consumption and authority balance cannot be reset", async (t) => {
  const f = await fixture(t);
  await activate(f);
  for (const sql of [
    "DELETE FROM shelf_storage_activation_v2",
    "UPDATE shelf_storage_activation_v2 SET generation=0",
    "DELETE FROM shelf_storage_activation_receipts_v2",
    "UPDATE shelf_storage_evidence_v2 SET evidence_json='{}'",
    "DELETE FROM shelf_storage_single_trial",
    "UPDATE shelf_storage_single_trial SET state='reserved',put_attempted=0,content_verified=0,etag=NULL",
    "UPDATE shelf_storage_authority SET committed_bytes=0",
    "UPDATE shelf_storage_authority SET phase='imported'",
  ])
    assert.throws(() => f.db.exec(sql));
  assert.equal((await f.create().inspect()).committedBytes, 24591);
});
test("receipt validator binds immutable snapshot/evidence and cannot use a new current timestamp", async (t) => {
  const f = await fixture(t);
  await activate(f);
  const v = f.db.prepare("SELECT * FROM shelf_storage_activation_v2").get(),
    receipt = JSON.parse(v.receipt_json),
    evidence = JSON.parse(v.evidence_json);
  validateStorageActivationReceiptV2(receipt, {
    identity,
    snapshotJson: v.snapshot_json,
    evidence,
    now: v.activated_at,
  });
  assert.throws(
    () =>
      validateStorageActivationReceiptV2(
        { ...receipt, committedBytes: receipt.committedBytes - 24582 },
        {
          identity,
          snapshotJson: v.snapshot_json,
          evidence,
          now: v.activated_at,
        },
      ),
    { code: "storage_v2_receipt_invalid" },
  );
  assert.throws(
    () =>
      validateStorageActivationReceiptV2(receipt, {
        identity,
        snapshotJson: v.snapshot_json,
        evidence,
        now: v.activated_at + 300001,
      }),
    { code: "storage_v2_receipt_invalid" },
  );
  f.advance(300001);
  assert.equal((await f.create().inspect()).state, "active");
});
test("fixed adapter rejects check DB, other account and runtime arbitrary expected fields", async (t) => {
  const f = await fixture(t);
  for (const bad of [
    { ...target, databaseId: identity.legacyDatabases.check },
    { ...target, accountId: "b".repeat(32) },
    { ...target, databaseName: "other" },
  ])
    assert.throws(
      () => f.create({ database: { ...f.adapter(), target: bad } }),
      { code: "storage_v2_target_invalid" },
    );
  const a = f.create();
  await assert.rejects(
    a.activateImportedV2({ ...(await f.expected(a)), proof: {} }),
    { code: "storage_v2_expected_invalid" },
  );
  assert.equal(f.mutations.length, 0);
});

test("literal-internal whitespace drift is rejected, never collapsed by schema normalization", async (t) => {
  const f = await fixture(t),
    row = f.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name='shelf_storage_v2_activation_delete'",
      )
      .get();
  f.db.exec("DROP TRIGGER shelf_storage_v2_activation_delete");
  f.db.exec(row.sql.replace("'storage v2 retained'", "'storage  v2 retained'"));
  await assert.rejects(activate(f), { code: "storage_v2_schema_incomplete" });
  assert.equal(f.mutations.length, 0);
});
test("target identity is pinned across external awaits and journal before dispatch", async (t) => {
  const f = await fixture(t),
    adapter = f.adapter();
  await assert.rejects(
    activate(f, {
      database: adapter,
      verifyExternal: async (c) => {
        const p = await f.verifier(c);
        adapter.target.databaseId = identity.legacyDatabases.check;
        return p;
      },
    }),
    { code: "storage_v2_target_changed" },
  );
  assert.equal(f.mutations.length, 0);
  const other = f.adapter();
  await assert.rejects(
    activate(f, {
      database: other,
      journal: {
        async claim() {
          other.target.databaseName = "unrelated";
          return true;
        },
      },
    }),
    { code: "storage_v2_target_changed" },
  );
  assert.equal(f.mutations.length, 0);
});
test("whole proof-set or deadline details are required; hashes and terminal booleans alone fail", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    (p) => {
      p.legacySafety.details.terminalWrites = 1;
    },
    (p) => {
      p.legacySafety.details.coverageComplete = false;
    },
    (p) => {
      p.legacySafety.details.versionSetSha256 = null;
    },
    (p) => {
      p.legacySafety.evidenceKind = "enforced-transport-deadline";
      p.legacySafety.details = {
        configurationSha256: sha("configuration"),
        maxRequestLifetimeMs: 60000,
        stoppedAt: f.now - 60000,
        drainedAt: f.now - 1,
      };
    },
  ])
    await assert.rejects(
      activate(f, {
        verifyExternal: async (c) => {
          const p = await f.verifier(c);
          changes(p);
          return p;
        },
      }),
      { code: "storage_v2_write_safety_unproven" },
    );
  assert.equal(f.mutations.length, 0);
});
test("verifier and durable-journal hangs have bounded failure and dispatch no CAS", async (t) => {
  const f = await fixture(t),
    never = () => new Promise(() => {});
  await assert.rejects(activate(f, { verifyExternal: never, deadlineMs: 10 }), {
    code: "storage_v2_external_verification_failed",
  });
  await assert.rejects(
    activate(f, { journal: { claim: never }, deadlineMs: 10 }),
    { code: "storage_v2_journal_unknown" },
  );
  assert.equal(f.mutations.length, 0);
});
test("late CAS completion after timeout remains one attempt and can only be observed", async (t) => {
  const f = await fixture(t),
    underlying = f.adapter();
  let finish;
  const late = {
    target: { ...target },
    select: underlying.select,
    async mutate(sql, params) {
      await new Promise((r) => {
        finish = r;
      });
      return underlying.mutate(sql, params);
    },
  };
  const a = f.create({ database: late, deadlineMs: 10 }),
    exp = await f.expected(a);
  await assert.rejects(a.activateImportedV2(exp), {
    code: "storage_v2_outcome_unknown",
  });
  await assert.rejects(a.activateImportedV2(exp), {
    code: "storage_v2_attempt_retained",
  });
  assert.equal((await f.create().inspect()).state, "closed");
  finish();
  await new Promise((r) => setImmediate(r));
  assert.equal((await f.create().inspect()).state, "active");
  assert.equal(f.mutations.length, 1);
});
test("both replacement-guard interruption points remain closed", async (t) => {
  for (const marker of [
    "CREATE TRIGGER shelf_storage_ready_guard BEFORE UPDATE",
    "CREATE TRIGGER shelf_single_trial_keep_imported BEFORE UPDATE",
  ]) {
    const f = await fixture(t, { install: false });
    f.db.exec(
      STORAGE_ACTIVATION_V2_SOURCE.slice(
        0,
        STORAGE_ACTIVATION_V2_SOURCE.indexOf(marker),
      ),
    );
    assert.throws(
      () => f.db.exec("UPDATE shelf_storage_authority SET phase='ready'"),
      /activation_required|keeps_imported/,
    );
    await assert.rejects(f.create().inspect(), {
      code: "storage_v2_schema_incomplete",
    });
    assert.equal(f.mutations.length, 0);
  }
});
test("ordinary and prepared-text confirmation transfer exactly one responsibility", async (t) => {
  const f = await fixture(t);
  await activate(f);
  const fileId = "file_1234567890abcdef",
    bookId = "book_1234567890abcdef",
    versionHash = sha("version"),
    source = {
      fileId,
      bookId,
      format: "PDF",
      sizeBytes: 123,
      mtimeNs: "123456",
      versionHash,
      sourceSha256: sha("source"),
    };
  const prepared = {
    kind: "prepared-text",
    scope: "production",
    fileId,
    bookId,
    format: "JSON",
    sizeBytes: 12,
    sha256: sha("prepared"),
    versionHash,
    source,
    objectKey: `prepared-text/v1/production/${fileId}/${versionHash}/${sha("prepared")}.json`,
  };
  const original = desc("Upper_Case", 20000000);
  f.db
    .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
    .run(original.bookId, JSON.stringify({ id: original.bookId }));
  for (const [id, d] of [
    ["prepared", prepared],
    ["ordinary", original],
  ]) {
    f.db
      .prepare(
        "INSERT INTO shelf_storage_reservations VALUES(?,?,?,?,?,'reserved',0,0,NULL,?,?)",
      )
      .run(
        id,
        `${d.kind}:production:${d.fileId}:${d.versionHash ?? "original"}`,
        d.objectKey,
        JSON.stringify(d),
        d.sizeBytes,
        f.now,
        f.now,
      );
    f.db
      .prepare(
        "UPDATE shelf_storage_reservations SET state='uploading',put_attempted=1 WHERE reservation_id=?",
      )
      .run(id);
    f.db
      .prepare(
        "UPDATE shelf_storage_reservations SET state='confirmed',content_verified=1,etag='new_etag' WHERE reservation_id=?",
      )
      .run(id);
  }
  const current = await f.create().inspect();
  assert.equal(current.committedBytes, 24591 + 20000012);
  assert.equal(current.reservedBytes, 7);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM shelf_storage_text_registry").get()
      .n,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM file_registry").get().n,
    2,
  );
  f.advance(300001);
  const d = desc("stale_file", 1);
  assert.throws(
    () =>
      f.db
        .prepare(
          "INSERT INTO shelf_storage_reservations VALUES(?,?,?,?,?,'reserved',0,0,NULL,?,?)",
        )
        .run(
          "stale",
          `original:production:${d.fileId}:original`,
          d.objectKey,
          JSON.stringify(d),
          1,
          f.now,
          f.now,
        ),
    /budget_or_evidence_invalid/,
  );
  assert.equal((await f.create().inspect()).state, "active");
});
