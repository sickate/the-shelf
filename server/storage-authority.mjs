/** Offline private SQLite reference implementation. No Cloudflare client/CLI. */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { accountEvidence } from "../scripts/cf-library-data.mjs";
import { validatePreparedText } from "../shared/prepared-text.mjs";

export const STORAGE_CEILING = 8_000_000_000;
export const OBJECT_LIMIT = 20_000_000;
export class StorageError extends Error {
  constructor(code) {
    super(code);
    this.name = "StorageError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new StorageError(code);
};
export const bytesSha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value);
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const id = (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys, code = "storage_invalid_input") => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail(code);
};
const clone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    fail("storage_invalid_input");
  }
};
export function identityValue(input) {
  exact(input, [
    "schemaVersion",
    "authorityId",
    "accountId",
    "bucket",
    "legacyDatabases",
  ]);
  exact(input.legacyDatabases, ["check", "production"]);
  if (
    input.schemaVersion !== 1 ||
    !id(input.authorityId) ||
    !id(input.accountId) ||
    input.bucket !== "the-shelf-books" ||
    !id(input.legacyDatabases.check) ||
    !id(input.legacyDatabases.production) ||
    input.legacyDatabases.check === input.legacyDatabases.production
  )
    fail("storage_identity_invalid");
  return {
    schemaVersion: 1,
    authorityId: input.authorityId,
    accountId: input.accountId,
    bucket: input.bucket,
    legacyDatabases: {
      check: input.legacyDatabases.check,
      production: input.legacyDatabases.production,
    },
  };
}
function sourceValue(input) {
  exact(input, [
    "fileId",
    "bookId",
    "format",
    "sizeBytes",
    "mtimeNs",
    "versionHash",
    "sourceSha256",
  ]);
  if (
    !/^file_[a-f0-9]{16}$/.test(input.fileId) ||
    !/^book_[a-f0-9]{16}$/.test(input.bookId) ||
    !["PDF", "EPUB"].includes(input.format) ||
    !integer(input.sizeBytes, 1, OBJECT_LIMIT) ||
    typeof input.mtimeNs !== "string" ||
    !/^\d+$/.test(input.mtimeNs) ||
    !hash(input.versionHash) ||
    !hash(input.sourceSha256)
  )
    fail("storage_source_invalid");
  return Object.fromEntries(
    [
      "fileId",
      "bookId",
      "format",
      "sizeBytes",
      "mtimeNs",
      "versionHash",
      "sourceSha256",
    ].map((k) => [k, input[k]]),
  );
}
export function objectDescriptor(input) {
  exact(input, [
    "kind",
    "scope",
    "fileId",
    "bookId",
    "format",
    "sizeBytes",
    "sha256",
    "objectKey",
    "versionHash",
    "source",
  ]);
  const {
    kind,
    scope,
    fileId,
    bookId,
    format,
    sizeBytes,
    sha256,
    objectKey,
    versionHash,
  } = input;
  if (
    !["original", "prepared-text"].includes(kind) ||
    !["check", "production"].includes(scope) ||
    !id(fileId) ||
    !id(bookId) ||
    !integer(sizeBytes, 1, OBJECT_LIMIT) ||
    !hash(sha256)
  )
    fail("storage_descriptor_invalid");
  let source = null,
    expectedKey;
  if (kind === "original") {
    if (
      !["PDF", "EPUB", "MOBI", "AZW", "AZW3"].includes(format) ||
      versionHash !== null ||
      input.source !== null
    )
      fail("storage_descriptor_invalid");
    expectedKey = `${scope === "production" ? "books/cf03" : "cf03-check"}/${fileId}/${sha256}.${format.toLowerCase()}`;
  } else {
    source = sourceValue(input.source);
    if (
      format !== "JSON" ||
      !hash(versionHash) ||
      source.versionHash !== versionHash ||
      source.fileId !== fileId ||
      source.bookId !== bookId
    )
      fail("storage_descriptor_invalid");
    expectedKey = `prepared-text/v1/${scope}/${fileId}/${versionHash}/${sha256}.json`;
  }
  if (objectKey !== expectedKey) fail("storage_descriptor_invalid");
  return {
    kind,
    scope,
    fileId,
    bookId,
    format,
    sizeBytes,
    sha256,
    objectKey,
    versionHash,
    source,
  };
}
const logicalKey = (d) =>
  `${d.kind}:${d.scope}:${d.fileId}:${d.versionHash ?? "original"}`;
export const objectContentType = (d) =>
  d.kind === "prepared-text"
    ? "application/json"
    : d.format === "PDF"
      ? "application/pdf"
      : d.format === "EPUB"
        ? "application/epub+zip"
        : "application/octet-stream";

/** Copy caller-owned values before the first await; hashes never use ETag. */
export async function prepareObject({
  kind,
  scope,
  fileId,
  bookId,
  format,
  bytes,
  source = null,
}) {
  if (
    !(bytes instanceof Uint8Array) ||
    !integer(bytes.byteLength, 1, OBJECT_LIMIT)
  )
    fail("storage_bytes_invalid");
  const data = Uint8Array.from(bytes),
    pinned = source === null ? null : sourceValue(clone(source));
  const sha256 = bytesSha256(data),
    versionHash = kind === "prepared-text" ? pinned?.versionHash : null;
  const descriptor = objectDescriptor({
    kind,
    scope,
    fileId,
    bookId,
    format,
    sizeBytes: data.length,
    sha256,
    objectKey:
      kind === "prepared-text"
        ? `prepared-text/v1/${scope}/${fileId}/${versionHash}/${sha256}.json`
        : `${scope === "production" ? "books/cf03" : "cf03-check"}/${fileId}/${sha256}.${String(format).toLowerCase()}`,
    versionHash,
    source: pinned,
  });
  if (kind === "prepared-text") await validatePreparedText(data, pinned);
  return { descriptor, bytes: data };
}
export async function validateObjectBytes(input, bytes) {
  const descriptor = objectDescriptor(clone(input));
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== descriptor.sizeBytes ||
    bytes.byteLength > OBJECT_LIMIT
  )
    fail("storage_bytes_invalid");
  const data = Uint8Array.from(bytes);
  if (bytesSha256(data) !== descriptor.sha256) fail("object_hash_mismatch");
  if (descriptor.kind === "prepared-text")
    await validatePreparedText(data, descriptor.source);
  return { descriptor, bytes: data };
}

export function frozenSnapshot(input, identity) {
  exact(
    input,
    [
      "schemaVersion",
      "scope",
      "databaseId",
      "accountId",
      "bucket",
      "frozen",
      "complete",
      "counts",
      "ledger",
      "reservations",
      "registry",
      "sha256",
    ],
    "migration_incomplete",
  );
  exact(
    input.frozen,
    ["writesStopped", "freezeId", "frozenAt", "snapshotAt"],
    "migration_incomplete",
  );
  exact(input.counts, ["reservations", "registry"], "migration_incomplete");
  exact(
    input.ledger,
    ["committedBytes", "reservedBytes"],
    "migration_incomplete",
  );
  if (
    input.schemaVersion !== 1 ||
    !["check", "production"].includes(input.scope) ||
    input.databaseId !== identity.legacyDatabases[input.scope] ||
    input.accountId !== identity.accountId ||
    input.bucket !== identity.bucket ||
    input.complete !== true ||
    input.frozen.writesStopped !== true ||
    !id(input.frozen.freezeId) ||
    !integer(input.frozen.frozenAt) ||
    !integer(input.frozen.snapshotAt, input.frozen.frozenAt) ||
    !Array.isArray(input.reservations) ||
    !Array.isArray(input.registry) ||
    input.reservations.length > 100000 ||
    input.registry.length > 100000 ||
    input.counts.reservations !== input.reservations.length ||
    input.counts.registry !== input.registry.length ||
    !integer(input.ledger.committedBytes) ||
    !integer(input.ledger.reservedBytes) ||
    !hash(input.sha256)
  )
    fail("migration_incomplete");
  const seenIds = new Set(),
    seenKeys = new Set(),
    confirmed = new Map();
  let committed = 0,
    reserved = 0;
  const reservations = input.reservations.map((row) => {
    exact(
      row,
      [
        "reservationId",
        "descriptor",
        "state",
        "etag",
        "contentVerified",
        "absenceVerified",
      ],
      "migration_incomplete",
    );
    const descriptor = objectDescriptor(row.descriptor);
    if (
      descriptor.kind !== "original" ||
      descriptor.scope !== input.scope ||
      !id(row.reservationId) ||
      seenIds.has(row.reservationId) ||
      !["reserved", "uploading", "uncertain", "confirmed", "aborted"].includes(
        row.state,
      ) ||
      typeof row.contentVerified !== "boolean" ||
      typeof row.absenceVerified !== "boolean" ||
      !(
        row.etag === null ||
        (typeof row.etag === "string" &&
          row.etag.length > 0 &&
          row.etag.length <= 256)
      )
    )
      fail("migration_conflict");
    seenIds.add(row.reservationId);
    if (row.state === "aborted") {
      if (!row.absenceVerified) fail("migration_incomplete");
    } else {
      if (seenKeys.has(logicalKey(descriptor))) fail("migration_conflict");
      seenKeys.add(logicalKey(descriptor));
      if (row.state === "confirmed") {
        if (!row.contentVerified || !row.etag) fail("migration_incomplete");
        committed += descriptor.sizeBytes;
        confirmed.set(logicalKey(descriptor), { descriptor, etag: row.etag });
      } else reserved += descriptor.sizeBytes;
    }
    return {
      reservationId: row.reservationId,
      descriptor,
      state: row.state,
      etag: row.etag,
      contentVerified: row.contentVerified,
      absenceVerified: row.absenceVerified,
    };
  });
  const registryKeys = new Set();
  const registry = input.registry.map((row) => {
    exact(
      row,
      ["descriptor", "etag", "state", "version"],
      "migration_incomplete",
    );
    const descriptor = objectDescriptor(row.descriptor),
      existing = confirmed.get(logicalKey(descriptor));
    if (
      !existing ||
      descriptor.scope !== input.scope ||
      registryKeys.has(logicalKey(descriptor)) ||
      json(existing.descriptor) !== json(descriptor) ||
      row.etag !== existing.etag ||
      !["confirmed", "disabled"].includes(row.state) ||
      !integer(row.version, 1)
    )
      fail("migration_conflict");
    registryKeys.add(logicalKey(descriptor));
    return {
      descriptor,
      etag: row.etag,
      state: row.state,
      version: row.version,
    };
  });
  if (
    registryKeys.size !== confirmed.size ||
    committed !== input.ledger.committedBytes ||
    reserved !== input.ledger.reservedBytes ||
    !integer(committed) ||
    !integer(reserved)
  )
    fail("migration_ledger_mismatch");
  const body = {
    schemaVersion: 1,
    scope: input.scope,
    databaseId: input.databaseId,
    accountId: input.accountId,
    bucket: input.bucket,
    frozen: {
      writesStopped: true,
      freezeId: input.frozen.freezeId,
      frozenAt: input.frozen.frozenAt,
      snapshotAt: input.frozen.snapshotAt,
    },
    complete: true,
    counts: { reservations: reservations.length, registry: registry.length },
    ledger: { committedBytes: committed, reservedBytes: reserved },
    reservations,
    registry,
  };
  if (bytesSha256(json(body)) !== input.sha256) fail("migration_hash_mismatch");
  return { ...body, sha256: input.sha256 };
}

/** Caller supplies an explicit private directory; no .local discovery or CLI. */
function privateDatabase(filename, privateRoot) {
  const root = path.resolve(privateRoot),
    target = path.resolve(filename),
    relative = path.relative(root, target);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    fail("storage_private_path_required");
  let current = path.parse(root).root;
  for (const part of path
    .relative(current, root)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("storage_private_path_unsafe");
  }
  if (realpathSync(root) !== root || (lstatSync(root).mode & 0o777) !== 0o700)
    fail("storage_private_path_unsafe");
  current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700
    )
      fail("storage_private_path_unsafe");
  }
  try {
    const stat = lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600
    )
      fail("storage_private_file_unsafe");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    closeSync(openSync(target, "wx", 0o600));
  }
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      const stat = lstatSync(target + suffix);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600
      )
        fail("storage_private_file_unsafe");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}

export class StorageAuthority {
  #db;
  #identity;
  #clock;
  constructor({ filename, privateRoot, identity, clock = Date.now }) {
    this.#identity = identityValue(clone(identity));
    if (typeof clock !== "function") fail("storage_invalid_clock");
    this.#clock = clock;
    this.#db = new DatabaseSync(privateDatabase(filename, privateRoot));
    try {
      this.#db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      this.#transaction(() => {
        if (
          !this.#db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='authority'",
            )
            .get()
        ) {
          if (
            this.#db
              .prepare(
                "SELECT count(*) AS n FROM sqlite_master WHERE type='table'",
              )
              .get().n
          )
            fail("storage_database_not_empty");
          this.#db.exec(
            readFileSync(
              new URL("./storage-authority.sql", import.meta.url),
              "utf8",
            ),
          );
          this.#db
            .prepare(
              "INSERT INTO authority(id,identity_json,phase) VALUES(1,?,'migration_required')",
            )
            .run(json(this.#identity));
        }
        this.#assertIdentity(this.#identity);
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close() {
    this.#db.close();
  }
  #transaction(action) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  #time() {
    const now = this.#clock();
    if (!integer(now)) fail("storage_invalid_clock");
    return now;
  }
  #assertIdentity(identity) {
    if (
      json(identityValue(identity)) !== json(this.#identity) ||
      this.#db.prepare("SELECT identity_json FROM authority WHERE id=1").get()
        ?.identity_json !== json(this.#identity)
    )
      fail("storage_identity_mismatch");
  }
  #ready(identity) {
    this.#assertIdentity(identity);
    if (
      this.#db.prepare("SELECT phase FROM authority WHERE id=1").get().phase !==
      "ready"
    )
      fail("storage_migration_required");
  }
  #row(reservationId) {
    if (typeof reservationId !== "string" || reservationId.length > 210)
      fail("storage_reservation_invalid");
    const row = this.#db
      .prepare("SELECT * FROM reservations WHERE reservation_id=?")
      .get(reservationId);
    if (!row) fail("storage_reservation_missing");
    return {
      reservationId: row.reservation_id,
      descriptor: JSON.parse(row.descriptor_json),
      state: row.state,
      putAttempted: !!row.put_attempted,
      contentVerified: !!row.content_verified,
      etag: row.etag,
    };
  }
  #audit() {
    // A single SELECT also makes inspect consistent across independent connections.
    const state = this.#db
      .prepare(
        `SELECT a.*,
      COALESCE((SELECT sum(size_bytes) FROM reservations WHERE state='confirmed'),0) AS actual_committed,
      COALESCE((SELECT sum(size_bytes) FROM reservations WHERE state<>'confirmed'),0) AS actual_reserved
      FROM authority a WHERE id=1`,
      )
      .get();
    if (
      state.actual_committed !== state.committed_bytes ||
      state.actual_reserved !== state.reserved_bytes
    )
      fail("storage_ledger_mismatch");
    return state;
  }

  inspect(identity) {
    this.#assertIdentity(identity);
    const state = this.#audit();
    return {
      phase: state.phase,
      committedBytes: state.committed_bytes,
      reservedBytes: state.reserved_bytes,
      observedBytes: state.observed_bytes,
      migrationHash: state.migration_hash,
    };
  }
  get(identity, reservationId) {
    this.#ready(identity);
    return this.#row(reservationId);
  }
  registry(identity, kind) {
    this.#ready(identity);
    if (!["original", "prepared-text"].includes(kind))
      fail("storage_descriptor_invalid");
    return this.#db
      .prepare(
        `SELECT reservation_id,descriptor_json,etag,enabled FROM ${kind === "original" ? "original_registry" : "text_registry"} ORDER BY logical_key`,
      )
      .all()
      .map((row) => ({
        reservationId: row.reservation_id,
        descriptor: JSON.parse(row.descriptor_json),
        etag: row.etag,
        enabled: !!row.enabled,
      }));
  }
  /** Synthetic explicit projections only: frozen is an assertion, not remote proof. */
  migrateFrozen(identity, snapshots) {
    const pinnedIdentity = identityValue(clone(identity));
    this.#assertIdentity(pinnedIdentity);
    if (!Array.isArray(snapshots) || snapshots.length !== 2)
      fail("migration_incomplete");
    const canonical = clone(snapshots)
      .map((s) => frozenSnapshot(s, this.#identity))
      .sort((a, b) => a.scope.localeCompare(b.scope));
    if (canonical[0].scope !== "check" || canonical[1].scope !== "production")
      fail("migration_incomplete");
    const migrationHash = bytesSha256(
      json({ identity: this.#identity, snapshots: canonical }),
    );
    return this.#transaction(() => {
      const state = this.#audit();
      if (state.phase === "ready") {
        if (state.migration_hash !== migrationHash) fail("migration_conflict");
        const receipt = this.#db
          .prepare("SELECT receipt_json FROM migration_receipt WHERE id=1")
          .get();
        if (!receipt) fail("migration_readback_failed");
        return JSON.parse(receipt.receipt_json);
      }
      if (
        state.committed_bytes ||
        state.reserved_bytes ||
        this.#db.prepare("SELECT count(*) AS n FROM reservations").get().n
      )
        fail("migration_conflict");
      let committed = 0,
        reserved = 0,
        imported = 0;
      const expectedRows = [];
      for (const snapshot of canonical) {
        this.#db
          .prepare("INSERT INTO migration_sources VALUES(?,?,?)")
          .run(snapshot.scope, json(snapshot), snapshot.sha256);
        committed += snapshot.ledger.committedBytes;
        reserved += snapshot.ledger.reservedBytes;
        for (const old of snapshot.reservations) {
          if (old.state === "aborted") continue;
          const d = old.descriptor,
            confirmed = old.state === "confirmed",
            key = logicalKey(d),
            reservationId = `${snapshot.scope}:${old.reservationId}`;
          const row = {
            reservationId,
            descriptor: d,
            state: confirmed ? "confirmed" : "uncertain",
            putAttempted: true,
            contentVerified: confirmed,
            etag: confirmed ? old.etag : null,
          };
          this.#db
            .prepare("INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              reservationId,
              key,
              d.objectKey,
              json(d),
              d.sizeBytes,
              row.state,
              1,
              Number(confirmed),
              row.etag,
              snapshot.frozen.snapshotAt,
              snapshot.frozen.snapshotAt,
            );
          expectedRows.push(row);
          imported++;
          if (confirmed) {
            const registry = snapshot.registry.find(
              (r) => logicalKey(r.descriptor) === key,
            );
            this.#db
              .prepare("INSERT INTO original_registry VALUES(?,?,?,?,?)")
              .run(
                key,
                reservationId,
                json(d),
                old.etag,
                Number(registry.state === "confirmed"),
              );
          }
        }
      }
      if (!integer(committed) || !integer(reserved))
        fail("migration_ledger_mismatch");
      this.#db
        .prepare(
          "UPDATE authority SET committed_bytes=?,reserved_bytes=? WHERE id=1",
        )
        .run(committed, reserved);
      this.#audit();
      const readbackRows = this.#db
        .prepare(
          "SELECT reservation_id FROM reservations ORDER BY reservation_id",
        )
        .all()
        .map((row) => this.#row(row.reservation_id));
      expectedRows.sort((a, b) =>
        a.reservationId.localeCompare(b.reservationId),
      );
      // SQL binary ordering, not locale ordering, is used for deterministic readback.
      expectedRows.sort((a, b) =>
        a.reservationId < b.reservationId
          ? -1
          : a.reservationId > b.reservationId
            ? 1
            : 0,
      );
      if (json(readbackRows) !== json(expectedRows))
        fail("migration_readback_failed");
      for (const snapshot of canonical) {
        const stored = this.#db
          .prepare(
            "SELECT snapshot_json,snapshot_hash FROM migration_sources WHERE scope=?",
          )
          .get(snapshot.scope);
        if (
          stored?.snapshot_json !== json(snapshot) ||
          stored.snapshot_hash !== snapshot.sha256
        )
          fail("migration_readback_failed");
        for (const entry of snapshot.registry) {
          const row = this.#db
            .prepare(
              "SELECT descriptor_json,etag,enabled FROM original_registry WHERE logical_key=?",
            )
            .get(logicalKey(entry.descriptor));
          if (
            row?.descriptor_json !== json(entry.descriptor) ||
            row.etag !== entry.etag ||
            row.enabled !== Number(entry.state === "confirmed")
          )
            fail("migration_readback_failed");
        }
      }
      const receipt = {
        schemaVersion: 1,
        migrationHash,
        sourceHashes: canonical.map((s) => ({
          scope: s.scope,
          sha256: s.sha256,
        })),
        importedReservations: imported,
        committedBytes: committed,
        reservedBytes: reserved,
        readbackSha256: bytesSha256(json(readbackRows)),
        cloudWriteFreezeProven: false,
      };
      this.#db
        .prepare("INSERT INTO migration_receipt VALUES(1,?)")
        .run(json(receipt));
      if (
        this.#db
          .prepare("SELECT receipt_json FROM migration_receipt WHERE id=1")
          .get()?.receipt_json !== json(receipt)
      )
        fail("migration_readback_failed");
      this.#db
        .prepare(
          "UPDATE authority SET phase='ready',migration_hash=? WHERE id=1",
        )
        .run(migrationHash);
      return receipt;
    });
  }
  /** Only descriptors produced/validated against actual bytes may be admitted. */
  async reserve(identity, reservationId, descriptor, bytes, evidence) {
    const pinnedIdentity = identityValue(clone(identity)),
      pinnedEvidence = clone(evidence);
    const validated = await validateObjectBytes(descriptor, bytes);
    if (!id(reservationId)) fail("storage_reservation_invalid");
    return this.#transaction(() => {
      this.#ready(pinnedIdentity);
      const d = validated.descriptor,
        serialized = json(d),
        existing = this.#db
          .prepare(
            "SELECT * FROM reservations WHERE reservation_id=? OR logical_key=? OR object_key=?",
          )
          .all(reservationId, logicalKey(d), d.objectKey);
      if (existing.length) {
        if (
          existing.length !== 1 ||
          existing[0].reservation_id !== reservationId ||
          existing[0].descriptor_json !== serialized
        )
          fail("storage_reservation_conflict");
        if (existing[0].state !== "reserved" || existing[0].put_attempted)
          return this.#row(reservationId);
      }
      const requestedBytes = existing.length ? 0 : d.sizeBytes;
      const now = this.#time(),
        observation = accountEvidence(
          pinnedEvidence,
          this.#identity.accountId,
          now,
        ),
        state = this.#audit();
      if (observation.observedAt > now) fail("account_storage_stale");
      if (
        state.observed_at !== null &&
        (observation.observedAt < state.observed_at ||
          (observation.observedAt === state.observed_at &&
            observation.evidenceSha256 !== state.evidence_hash))
      )
        fail("account_storage_conflict");
      const total =
        BigInt(observation.observedBytes) +
        BigInt(state.committed_bytes) +
        BigInt(state.reserved_bytes) +
        BigInt(requestedBytes);
      if (total > BigInt(STORAGE_CEILING)) fail("storage_budget_exceeded");
      this.#db
        .prepare(
          "UPDATE authority SET observed_bytes=?,observed_at=?,evidence_hash=?,billing_period=?,reserved_bytes=reserved_bytes+? WHERE id=1",
        )
        .run(
          observation.observedBytes,
          observation.observedAt,
          observation.evidenceSha256,
          pinnedEvidence.billingPeriod,
          requestedBytes,
        );
      if (!existing.length)
        this.#db
          .prepare(
            "INSERT INTO reservations VALUES(?,?,?,?,?, 'reserved',0,0,NULL,?,?)",
          )
          .run(
            reservationId,
            logicalKey(d),
            d.objectKey,
            serialized,
            d.sizeBytes,
            now,
            now,
          );
      this.#audit();
      return this.#row(reservationId);
    });
  }
  claimPut(identity, reservationId) {
    return this.#transaction(() => {
      this.#ready(identity);
      const row = this.#row(reservationId),
        state = this.#audit(),
        now = this.#time();
      if (row.state !== "reserved" || row.putAttempted)
        fail("storage_put_already_claimed");
      if (
        state.observed_at === null ||
        state.observed_at > now ||
        state.observed_at < now - 300000 ||
        state.billing_period !== new Date(now).toISOString().slice(0, 7)
      )
        fail("account_storage_stale");
      const changed = this.#db
        .prepare(
          "UPDATE reservations SET state='uploading',put_attempted=1,updated_at=? WHERE reservation_id=? AND state='reserved' AND put_attempted=0 RETURNING reservation_id",
        )
        .all(now, reservationId);
      if (changed.length !== 1) fail("storage_put_already_claimed");
      return this.#row(reservationId);
    });
  }
  markUncertain(identity, reservationId) {
    return this.#transaction(() => {
      this.#ready(identity);
      this.#db
        .prepare(
          "UPDATE reservations SET state='uncertain',updated_at=? WHERE reservation_id=? AND put_attempted=1 AND state IN ('reserved','uploading')",
        )
        .run(this.#time(), reservationId);
      return this.#row(reservationId);
    });
  }
  async reconcile(identity, reservationId, adapter) {
    const pinnedIdentity = identityValue(clone(identity));
    this.#ready(pinnedIdentity);
    const row = this.#row(reservationId);
    if (row.state === "confirmed") return row;
    const store = snapshotObjectStore(pinnedIdentity, adapter);
    try {
      const etag = await verifyStoredObject(row.descriptor, store);
      if (etag === null) {
        this.markUncertain(pinnedIdentity, reservationId);
        return {
          ...this.#row(reservationId),
          blockedReason: "object_absence_unresolved",
        };
      }
      return this.#confirmVerified(
        pinnedIdentity,
        reservationId,
        row.descriptor,
        etag,
      );
    } catch (error) {
      try {
        this.markUncertain(pinnedIdentity, reservationId);
      } catch {
        /* Existing state retains all bytes. */
      }
      throw error instanceof StorageError
        ? error
        : new StorageError("object_verification_unknown");
    }
  }
  #confirmVerified(identity, reservationId, descriptor, etag) {
    const d = objectDescriptor(clone(descriptor));
    if (
      typeof etag !== "string" ||
      !etag.length ||
      etag.length > 256 ||
      /[\r\n\x00]/.test(etag)
    )
      fail("object_identity_mismatch");
    return this.#transaction(() => {
      this.#ready(identity);
      const row = this.#row(reservationId);
      if (json(row.descriptor) !== json(d))
        fail("storage_reservation_conflict");
      if (row.state === "confirmed") {
        if (row.etag !== etag) fail("object_changed");
        return row;
      }
      this.#db
        .prepare(
          "UPDATE reservations SET state='confirmed',content_verified=1,etag=?,updated_at=? WHERE reservation_id=? AND state<>'confirmed'",
        )
        .run(etag, this.#time(), reservationId);
      this.#db
        .prepare(
          `INSERT INTO ${d.kind === "original" ? "original_registry" : "text_registry"} VALUES(?,?,?,?,1)`,
        )
        .run(logicalKey(d), reservationId, json(d), etag);
      this.#db
        .prepare(
          "UPDATE authority SET reserved_bytes=reserved_bytes-?,committed_bytes=committed_bytes+? WHERE id=1",
        )
        .run(d.sizeBytes, d.sizeBytes);
      this.#audit();
      return this.#row(reservationId);
    });
  }
}

/** Pin target and methods before awaits; an adapter is trusted I/O, never a ledger. */
export function snapshotObjectStore(identity, adapter) {
  if (!adapter || typeof adapter !== "object") fail("object_adapter_invalid");
  exact(adapter, ["target", "head", "get", "put"], "object_adapter_invalid");
  const target = clone(adapter.target);
  exact(target, ["accountId", "bucket"], "object_target_mismatch");
  if (
    target.accountId !== identity.accountId ||
    target.bucket !== identity.bucket ||
    ["head", "get", "put"].some((k) => typeof adapter[k] !== "function")
  )
    fail("object_target_mismatch");
  const receiver = Object.freeze({
    target: Object.freeze(target),
    head: adapter.head,
    get: adapter.get,
    put: adapter.put,
  });
  return Object.freeze({
    target: receiver.target,
    head: receiver.head.bind(receiver),
    get: receiver.get.bind(receiver),
    put: receiver.put.bind(receiver),
  });
}
function headValue(value, descriptor) {
  const head = clone(value);
  exact(
    head,
    ["size", "sha256", "etag", "contentType"],
    "object_identity_mismatch",
  );
  if (
    head.size !== descriptor.sizeBytes ||
    head.sha256 !== descriptor.sha256 ||
    head.contentType !== objectContentType(descriptor) ||
    typeof head.etag !== "string" ||
    !head.etag.length ||
    head.etag.length > 256 ||
    /[\r\n\x00]/.test(head.etag)
  )
    fail("object_identity_mismatch");
  return {
    size: head.size,
    sha256: head.sha256,
    etag: head.etag,
    contentType: head.contentType,
  };
}
async function boundedObjectBody(body, size) {
  if (!(body instanceof ReadableStream)) fail("object_stream_required");
  const reader = body.getReader(),
    result = new Uint8Array(size);
  let offset = 0,
    chunks = 0,
    complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (++chunks > 100000) fail("object_body_chunk_limit");
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength > size - offset ||
        value.byteLength > OBJECT_LIMIT - offset
      )
        fail("object_body_size_mismatch");
      result.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) fail("object_body_size_mismatch");
    complete = true;
    return result;
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        /* Bound exceeded: do not continue reading. */
      }
    }
    reader.releaseLock();
  }
}
export async function verifyStoredObject(input, store) {
  const descriptor = objectDescriptor(clone(input));
  const initial = await store.head(descriptor.objectKey);
  if (initial === null) return null;
  const before = headValue(initial, descriptor);
  const body = await store.get(descriptor.objectKey, {
    maxBytes: descriptor.sizeBytes,
    ifMatch: before.etag,
  });
  const bytes = await boundedObjectBody(body, descriptor.sizeBytes);
  await validateObjectBytes(descriptor, bytes);
  const after = headValue(await store.head(descriptor.objectKey), descriptor);
  if (json(before) !== json(after)) fail("object_changed");
  return before.etag;
}
