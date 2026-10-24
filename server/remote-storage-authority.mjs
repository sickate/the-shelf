/** Private fixed-project D1 authority. No CLI, arbitrary SQL endpoint or direct confirm method. */
import { readFileSync } from "node:fs";
import {
  identityValue,
  frozenSnapshot,
  objectDescriptor,
  validateObjectBytes,
  bytesSha256,
  snapshotObjectStore,
  verifyStoredObject,
  StorageError,
  STORAGE_CEILING,
} from "./storage-authority.mjs";
import { accountEvidence } from "../scripts/cf-library-data.mjs";
import {
  readStorageSchemaState,
  readStorageAuthorityState,
  STORAGE_SCHEMA_PROFILES,
  STORAGE_SCHEMA_MANIFEST_SQL,
} from "./storage-schema-state.mjs";

const json = JSON.stringify,
  clone = structuredClone;
const stableJson = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const same = (a, b) => stableJson(a) === stableJson(b);
const fail = (code) => {
  throw new StorageError(code);
};
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const logicalKey = (d) =>
  `${d.kind}:${d.scope}:${d.fileId}:${d.versionHash ?? "original"}`;
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// sqlite_master retains the submitted definition (without the final semicolon).
// Do not collapse whitespace: that would also rewrite SQL string literals.
const normalizeSql = (sql) => sql.trim().replace(/;$/, "");
const freezeSql = readFileSync(
  new URL(
    "../cloudflare/library/migrations/004-freeze-legacy-storage.sql",
    import.meta.url,
  ),
  "utf8",
);
const freezeDefinitions = [
  ...freezeSql.matchAll(
    /CREATE TRIGGER (shelf_legacy_[a-z_]+)\b[\s\S]*?\nEND;/g,
  ),
]
  .map((m) => ({ name: m[1], sql: normalizeSql(m[0]) }))
  .sort((a, b) => order(a.name, b.name));
if (freezeDefinitions.length !== 11)
  throw new Error("storage_freeze_definition_invalid");
const freezeSchemaHash = bytesSha256(json(freezeDefinitions));
export const SINGLE_TRIAL_BUCKET = "the-shelf-first-book-20261023";
const trialSql = readFileSync(
  new URL(
    "../cloudflare/library/migrations/005-single-trial.sql",
    import.meta.url,
  ),
  "utf8",
);
export const singleTrialSchemaDefinitions = Object.freeze(
  [
    ...trialSql.matchAll(
      /CREATE TABLE [a-z_]+\b[\s\S]*?\n\);|CREATE TRIGGER [a-z_]+\b[\s\S]*?\nEND;/g,
    ),
  ]
    .map((m) =>
      Object.freeze({
        name: m[0].match(/^CREATE (?:TABLE|TRIGGER) ([a-z_]+)/)[1],
        sql: normalizeSql(m[0]),
      }),
    )
    .sort((a, b) => order(a.name, b.name)),
);
if (singleTrialSchemaDefinitions.length !== 7)
  throw new Error("single_trial_schema_invalid");
export const singleTrialSchemaHash = bytesSha256(
  json(singleTrialSchemaDefinitions),
);
export const singleTrialAdmissionSql = readFileSync(
  new URL(
    "../cloudflare/library/migrations/006-single-trial-admission.sql",
    import.meta.url,
  ),
  "utf8",
);
export const singleTrialAdmissionDefinition = Object.freeze({
  name: "admission_private",
  sql: normalizeSql(
    singleTrialAdmissionSql.match(
      /CREATE TRIGGER admission_private\b[\s\S]*?\nEND;/,
    )[0],
  ),
});

/** Configuration fingerprint records the reviewed operator configuration, not proof
 * that capabilities were revoked. The operator must independently establish isolation. */
export function singleTrialPermit(input, identity, now = Date.now()) {
  const value = clone(input),
    pinned = identityValue(clone(identity));
  const keys = [
    "schemaVersion",
    "permitId",
    "consentId",
    "target",
    "descriptor",
    "isolatedTargetConfigSha256",
    "issuedAt",
    "expiresAt",
  ];
  if (
    !value ||
    Object.keys(value).sort().join() !== keys.sort().join() ||
    value.schemaVersion !== 1 ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.permitId ?? "") ||
    value.consentId !== "2026-10-23-first-book" ||
    !value.target ||
    Object.keys(value.target).sort().join() !== "accountId,bucket" ||
    value.target.accountId !== pinned.accountId ||
    value.target.bucket !== SINGLE_TRIAL_BUCKET ||
    !/^[a-f0-9]{64}$/.test(value.isolatedTargetConfigSha256 ?? "") ||
    ![now, value.issuedAt, value.expiresAt].every(integer) ||
    value.issuedAt > now ||
    value.expiresAt <= value.issuedAt ||
    value.expiresAt > value.issuedAt + 86400000
  )
    fail("single_trial_permit_invalid");
  const descriptor = objectDescriptor(value.descriptor);
  if (
    descriptor.kind !== "original" ||
    descriptor.scope !== "production" ||
    !["PDF", "EPUB"].includes(descriptor.format)
  )
    fail("single_trial_permit_invalid");
  return {
    schemaVersion: 1,
    permitId: value.permitId,
    consentId: value.consentId,
    target: { accountId: pinned.accountId, bucket: SINGLE_TRIAL_BUCKET },
    descriptor,
    isolatedTargetConfigSha256: value.isolatedTargetConfigSha256,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}
const PAGE = 100,
  MIGRATION_LIMIT = 1000,
  RESPONSE_LIMIT = 1_000_000;
const names = {
  check: "the-shelf-cf03-check",
  production: "the-shelf-library",
};
const cancel = (target) => {
  try {
    void target?.cancel().catch(() => {});
  } catch {}
};
const requestErrorCodes = new Set([
  "storage_remote_deadline",
  "storage_remote_redirect",
  "storage_remote_rejected",
  "storage_remote_response_limit",
  "storage_remote_response_invalid",
]);
const verificationErrorCodes = new Set([
  ...requestErrorCodes,
  "storage_remote_outcome_unknown",
  "storage_remote_request_budget",
  "storage_remote_journal_failed",
  "storage_remote_query_limit",
  "storage_reservation_missing",
  "storage_reservation_conflict",
  "object_verification_timeout",
  "object_stream_required",
  "object_identity_mismatch",
  "object_body_chunk_limit",
  "object_body_size_mismatch",
  "object_hash_mismatch",
  "object_changed",
  "r2_deadline_exceeded",
  "r2_response_invalid",
  "r2_request_failed",
  "r2_object_identity_mismatch",
  "r2_stream_required",
  "r2_body_size_mismatch",
  "r2_body_hash_mismatch",
  "r2_body_chunk_limit",
]);
const safeError = (error, allowed, fallback) =>
  new StorageError(
    error instanceof StorageError && allowed.has(error.code)
      ? error.code
      : fallback,
  );

function writeClosure(value, identity, now, requireFresh = false) {
  const closure = clone(value),
    hashFields = [
      "identitySha256",
      "entrypointSha256",
      "localStateSha256",
      "processEvidenceSha256",
      "connectionEvidenceSha256",
      "probeClosureSha256",
    ],
    hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (
    !closure ||
    closure.schemaVersion !== 1 ||
    hashFields.some((k) => !hash(closure[k])) ||
    closure.identitySha256 !== bytesSha256(json(identity)) ||
    closure.localLegacyEmpty !== true ||
    closure.lockAbsent !== true ||
    closure.legacyEntryPointsDisabled !== true ||
    closure.legacyProcessesStopped !== true ||
    closure.legacyConnectionsClosed !== true ||
    closure.probeWriteCapabilityDisabled !== true ||
    closure.drainBound?.source !== "enforced-transport-deadline" ||
    !hash(closure.drainBound.configurationSha256) ||
    !integer(closure.drainBound.maxRequestLifetimeMs) ||
    closure.drainBound.maxRequestLifetimeMs < 1 ||
    ![
      closure.stoppedAt,
      closure.drainedAt,
      closure.verifiedAt,
      closure.deadlineMs,
    ].every(integer) ||
    closure.deadlineMs <
      Math.max(60000, closure.drainBound.maxRequestLifetimeMs) ||
    !Number.isSafeInteger(closure.stoppedAt + closure.deadlineMs) ||
    closure.drainedAt < closure.stoppedAt + closure.deadlineMs ||
    closure.verifiedAt < closure.drainedAt ||
    closure.verifiedAt > now ||
    (requireFresh && closure.verifiedAt < now - 300000)
  )
    fail("migration_write_closure_unproven");
  return closure;
}

/** Validate the persisted ready proof; current budget counters may have grown since import.
 * The trusted verifier must establish closure from actual process/connection and provider
 * evidence. Hashes and fields alone do not create that evidence or revoke capabilities. */
export function validateMigrationReceipt(
  receipt,
  identity,
  inspection,
  now = Date.now(),
) {
  const pinned = identityValue(clone(identity)),
    hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (
    !integer(now) ||
    inspection?.phase !== "ready" ||
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.verificationScope !== "migration-at-import-time" ||
    !hash(receipt.migrationHash) ||
    inspection.migrationHash !== receipt.migrationHash ||
    !hash(receipt.readbackSha256) ||
    receipt.cloudWriteFreezeProven !== true ||
    receipt.databaseWriteFreezeProven !== true ||
    receipt.sourceProjectionVerified !== true ||
    ![
      receipt.importedReservations,
      receipt.committedBytes,
      receipt.reservedBytes,
      receipt.verifiedAt,
    ].every(integer) ||
    receipt.importedReservations > MIGRATION_LIMIT ||
    receipt.verifiedAt > now ||
    !Array.isArray(receipt.sourceHashes) ||
    receipt.sourceHashes.length !== 2 ||
    !Array.isArray(receipt.freezeProofs) ||
    receipt.freezeProofs.length !== 2
  )
    fail("migration_readback_failed");
  const closure = writeClosure(receipt.writeClosureProof, pinned, now);
  if (receipt.verifiedAt < closure.verifiedAt)
    fail("migration_readback_failed");
  for (const scope of ["check", "production"]) {
    const source = receipt.sourceHashes.filter((s) => s?.scope === scope),
      proofs = receipt.freezeProofs.filter((s) => s?.scope === scope),
      proof = proofs[0];
    if (
      source.length !== 1 ||
      proofs.length !== 1 ||
      !hash(source[0].sha256) ||
      proof.databaseId !== pinned.legacyDatabases[scope] ||
      typeof proof.freezeId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(proof.freezeId) ||
      !integer(proof.frozenAt) ||
      proof.frozenAt > receipt.verifiedAt ||
      proof.freezeSchemaHash !== freezeSchemaHash ||
      proof.sourceSnapshotHash !== source[0].sha256
    )
      fail("migration_readback_failed");
  }
  return clone(receipt);
}

async function responseJson(response, signal) {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)
  )
    fail("storage_remote_response_limit");
  if (!response.body) fail("storage_remote_response_invalid");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0,
    count = 0,
    complete = false;
  const abort = () => cancel(reader);
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) fail("storage_remote_deadline");
      if (done) {
        complete = true;
        break;
      }
      if (
        !(value instanceof Uint8Array) ||
        ++count > 10000 ||
        (size += value.length) > RESPONSE_LIMIT
      )
        fail("storage_remote_response_limit");
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } catch {
      fail("storage_remote_response_invalid");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) cancel(reader);
    try {
      reader.releaseLock();
    } catch {}
  }
}

// Reconciliation timeout closes the consumer stream immediately, does not await
// a hostile cancel hook, and suppresses later HEAD/GET dispatch. The trusted R2
// client separately bounds any request already in flight.
function cancellableStore(store, signal) {
  const check = () => {
    if (signal.aborted) fail("object_verification_timeout");
  };
  return {
    target: store.target,
    async head(key) {
      check();
      const head = await store.head(key);
      check();
      return head;
    },
    async get(key, options) {
      check();
      const body = await store.get(key, options);
      if (signal.aborted) {
        cancel(body);
        fail("object_verification_timeout");
      }
      if (!(body instanceof ReadableStream)) fail("object_stream_required");
      const reader = body.getReader();
      let controller,
        finished = false;
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        try {
          reader.releaseLock();
        } catch {}
      };
      const abort = () => {
        cancel(reader);
        try {
          controller.error(new StorageError("object_verification_timeout"));
        } catch {}
        cleanup();
      };
      return new ReadableStream({
        start(c) {
          controller = c;
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
        async pull(c) {
          try {
            const part = await reader.read();
            check();
            if (part.done) {
              finished = true;
              cleanup();
              c.close();
            } else c.enqueue(part.value);
          } catch (e) {
            if (!finished) cancel(reader);
            cleanup();
            try {
              c.error(e);
            } catch {}
          }
        },
        cancel() {
          if (!finished) cancel(reader);
          cleanup();
        },
      });
    },
    async put() {
      fail("object_verification_write_forbidden");
    },
  };
}

export class RemoteStorageAuthority {
  #identity;
  #credentials;
  #fetch;
  #clock;
  #before;
  #limit;
  #used = 0;
  #verified = new Set();
  #timeout;
  #verificationTimeout;
  #verifyClosure;
  #trialEnabled = false;
  constructor({
    identity,
    credentials,
    resource,
    fetchImpl = fetch,
    clock = Date.now,
    beforeRequest,
    requestLimit,
    requestTimeoutMs = 30000,
    verificationTimeoutMs = 60000,
    verifyWriteClosure,
    singleTrial = false,
  }) {
    this.#identity = identityValue(clone(identity));
    if (
      typeof singleTrial !== "boolean" ||
      !/^[a-f0-9]{32}$/.test(credentials?.accountId ?? "") ||
      credentials.accountId !== this.#identity.accountId ||
      typeof credentials.token !== "string" ||
      !credentials.token ||
      resource?.databaseId !== this.#identity.legacyDatabases.production ||
      resource?.databaseName !== names.production ||
      !Object.values(this.#identity.legacyDatabases).every((v) =>
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          v,
        ),
      ) ||
      typeof beforeRequest !== "function" ||
      typeof fetchImpl !== "function" ||
      typeof clock !== "function" ||
      !Number.isInteger(requestLimit) ||
      requestLimit < 1 ||
      requestLimit > 256 ||
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 30000 ||
      !Number.isInteger(verificationTimeoutMs) ||
      verificationTimeoutMs < 1 ||
      verificationTimeoutMs > 60000
    )
      fail("storage_remote_configuration_invalid");
    this.#credentials = {
      accountId: credentials.accountId,
      token: credentials.token,
    };
    this.#fetch = fetchImpl;
    this.#clock = clock;
    this.#before = beforeRequest;
    this.#limit = requestLimit;
    this.#timeout = requestTimeoutMs;
    this.#verificationTimeout = verificationTimeoutMs;
    this.#verifyClosure = verifyWriteClosure;
    this.#trialEnabled = singleTrial;
  }
  #assert(identity) {
    if (json(identityValue(clone(identity))) !== json(this.#identity))
      fail("storage_identity_mismatch");
  }
  #now() {
    const now = this.#clock();
    if (!integer(now)) fail("storage_invalid_clock");
    return now;
  }
  async #request(scope, operation, sql, params = []) {
    if (++this.#used > this.#limit) fail("storage_remote_request_budget");
    const intent = {
      sequence: this.#used,
      scope,
      operation,
      method: sql === undefined ? "GET" : "POST",
      ...(sql === undefined ? {} : { sqlSha256: bytesSha256(sql) }),
    };
    try {
      await this.#before(clone(intent));
    } catch {
      fail("storage_remote_journal_failed");
    } // Operator MUST durably persist intent before allowing dispatch.
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.#credentials.accountId}/d1/database/${this.#identity.legacyDatabases[scope]}${sql === undefined ? "" : "/query"}`;
    const controller = new AbortController();
    let response, timer;
    try {
      const attempt = (async () => {
        response = await this.#fetch(url, {
          method: intent.method,
          headers: {
            authorization: `Bearer ${this.#credentials.token}`,
            "content-type": "application/json",
          },
          ...(sql === undefined ? {} : { body: json({ sql, params }) }),
          redirect: "error",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          cancel(response.body);
          fail("storage_remote_deadline");
        }
        if (
          response.redirected ||
          (response.url && response.url !== url) ||
          (response.status >= 300 && response.status < 400)
        ) {
          cancel(response.body);
          fail("storage_remote_redirect");
        }
        if (!response.ok) {
          cancel(response.body);
          fail("storage_remote_rejected");
        }
        const body = await responseJson(response, controller.signal);
        if (controller.signal.aborted) fail("storage_remote_deadline");
        if (body.success !== true) fail("storage_remote_rejected");
        return body.result;
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          cancel(response?.body);
          reject(new StorageError("storage_remote_deadline"));
        }, this.#timeout);
      });
      return await Promise.race([attempt, deadline]);
    } catch (e) {
      controller.abort();
      cancel(response?.body);
      if (sql !== undefined) fail("storage_remote_outcome_unknown");
      throw safeError(e, requestErrorCodes, "storage_remote_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  async #verify(scope) {
    if (this.#verified.has(scope)) return;
    const data = await this.#request(scope, "verify-identity");
    if (
      data?.uuid !== this.#identity.legacyDatabases[scope] ||
      data?.name !== names[scope]
    )
      fail("storage_identity_mismatch");
    this.#verified.add(scope);
  }
  async #query(
    sql,
    params = [],
    scope = "production",
    operation = "authority-query",
  ) {
    if (sql.length > 100000 || params.length > 100)
      fail("storage_remote_query_limit");
    await this.#verify(scope);
    const result = await this.#request(scope, operation, sql, params);
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      result[0]?.success !== true ||
      !Array.isArray(result[0].results)
    )
      fail("storage_remote_outcome_unknown");
    return result[0].results;
  }
  async initialize(identity) {
    this.#assert(identity);
    const existing = await this.#query(
      "SELECT identity_json FROM shelf_storage_authority WHERE id=1 LIMIT 2",
    );
    if (
      existing.length > 1 ||
      (existing.length === 1 &&
        existing[0].identity_json !== json(this.#identity))
    )
      fail("storage_identity_mismatch");
    // A resumed operation observes an earlier unknown INSERT instead of replaying it.
    if (!existing.length) {
      const schema = await this.#schema();
      await this.#write(
        "INSERT INTO shelf_storage_authority(id,identity_json,phase) SELECT 1,?,'migration_required' WHERE NOT EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1)",
        [json(this.#identity)],
        schema.layout,
        "initialize-migration-required",
      );
    }
    return this.inspect(identity);
  }
  async #schema(required = false) {
    return readStorageSchemaState({
      query: (...args) => this.#query(...args),
      requireTrial: required || this.#trialEnabled,
    });
  }
  async #write(sql, params, layout, operation = "authority-query") {
    if (!["legacy-v1", "trial-v1"].includes(layout))
      fail("storage_v2_write_unavailable");
    const split = sql.indexOf(" RETURNING ");
    const statement = split < 0 ? sql : sql.slice(0, split);
    const suffix = split < 0 ? "" : sql.slice(split);
    return this.#query(
      `${statement} AND ${STORAGE_SCHEMA_MANIFEST_SQL}=?${suffix}`,
      [...params, json(STORAGE_SCHEMA_PROFILES[layout])],
      "production",
      operation,
    );
  }
  async #audit(requiredTrial = false, writable = false) {
    const schema = await this.#schema(requiredTrial);
    // No trusted current-evidence producer is wired in this compatibility batch.
    if (writable && schema.layout === "activation-v2")
      fail("storage_v2_write_unavailable");
    const s = await readStorageAuthorityState({
      query: (...args) => this.#query(...args),
      identity: this.#identity,
      schema,
    });
    return { ...s, storageLayout: schema.layout };
  }
  async #ready(identity, writable = false) {
    this.#assert(identity);
    const s = await this.#audit(false, writable);
    if (s.phase !== "ready") fail("storage_migration_required");
    return s;
  }
  async inspect(identity) {
    this.#assert(identity);
    const s = await this.#audit();
    return {
      phase: s.phase,
      committedBytes: s.committed_bytes,
      reservedBytes: s.reserved_bytes,
      observedBytes: s.observed_bytes,
      migrationHash: s.migration_hash,
    };
  }
  #decodeTrial(row) {
    if (!row) return null;
    if (row.id !== 1 || row.authority_identity_json !== json(this.#identity))
      fail("single_trial_identity_mismatch");
    const permit = singleTrialPermit(
      {
        schemaVersion: 1,
        permitId: row.permit_id,
        consentId: row.consent_id,
        target: JSON.parse(row.target_json),
        descriptor: JSON.parse(row.descriptor_json),
        isolatedTargetConfigSha256: row.isolated_target_config_sha256,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      },
      this.#identity,
      this.#now(),
    );
    if (
      row.size_bytes !== permit.descriptor.sizeBytes ||
      !["reserved", "uploading", "uncertain", "confirmed"].includes(
        row.state,
      ) ||
      ![0, 1].includes(row.put_attempted) ||
      ![0, 1].includes(row.content_verified) ||
      !integer(row.updated_at) ||
      (row.state === "reserved"
        ? row.put_attempted !== 0
        : row.put_attempted !== 1) ||
      (row.state === "confirmed"
        ? row.content_verified !== 1 ||
          typeof row.etag !== "string" ||
          row.etag.length < 1 ||
          row.etag.length > 256 ||
          /[\r\n\x00]/.test(row.etag)
        : row.content_verified !== 0 || row.etag !== null)
    )
      fail("single_trial_row_invalid");
    return {
      permit,
      state: row.state,
      putAttempted: !!row.put_attempted,
      contentVerified: !!row.content_verified,
      etag: row.etag,
      updatedAt: row.updated_at,
    };
  }
  async #trialRow() {
    const rows = await this.#query(
      "SELECT * FROM shelf_storage_single_trial WHERE id=1 LIMIT 2",
      [],
      "production",
      "read-single-trial",
    );
    if (rows.length > 1) fail("single_trial_row_invalid");
    return this.#decodeTrial(rows[0]);
  }
  async inspectSingleTrial(identity) {
    return this.#inspectTrial(identity, false);
  }
  async #inspectTrial(identity, writable) {
    this.#assert(identity);
    const state = await this.#audit(true, writable);
    const row = await this.#trialRow();
    return writable ? { row, layout: state.storageLayout } : row;
  }
  async issueSingleTrial(identity, input) {
    this.#assert(identity);
    const permit = singleTrialPermit(input, this.#identity, this.#now());
    const state = await this.#audit(true, true);
    if (
      state.phase !== "imported" ||
      permit.issuedAt < this.#now() - 300000 ||
      permit.expiresAt <= this.#now()
    )
      fail("single_trial_admission_invalid");
    // Deliberately not idempotent: a lost issuance response is recovered by inspect,
    // never by replaying INSERT (including OR REPLACE).
    await this.#write(
      "INSERT INTO shelf_storage_single_trial(id,permit_id,consent_id,authority_identity_json,target_json,descriptor_json,isolated_target_config_sha256,size_bytes,issued_at,expires_at,state,put_attempted,content_verified,etag,updated_at) SELECT 1,?,?,?,?,?,?,?,?,?,'reserved',0,0,NULL,? WHERE 1",
      [
        permit.permitId,
        permit.consentId,
        json(this.#identity),
        json(permit.target),
        json(permit.descriptor),
        permit.isolatedTargetConfigSha256,
        permit.descriptor.sizeBytes,
        permit.issuedAt,
        permit.expiresAt,
        permit.issuedAt,
      ],
      state.storageLayout,
      "issue-single-trial",
    );
    const saved = await this.#trialRow();
    if (!saved || !same(saved.permit, permit) || saved.state !== "reserved")
      fail("single_trial_conflict");
    await this.#audit();
    return saved;
  }
  async claimSingleTrialPut(identity, permitId, descriptor, bytes) {
    this.#assert(identity);
    const validated = await validateObjectBytes(descriptor, bytes);
    const { row, layout } = await this.#inspectTrial(identity, true);
    if (
      !row ||
      row.permit.permitId !== permitId ||
      !same(row.permit.descriptor, validated.descriptor)
    )
      fail("single_trial_conflict");
    const changed = await this.#write(
      "UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1,updated_at=? WHERE id=1 AND permit_id=? AND descriptor_json=? AND state='reserved' AND put_attempted=0 AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) RETURNING id",
      [this.#now(), permitId, json(validated.descriptor)],
      layout,
      "claim-single-trial-put",
    );
    if (changed.length !== 1) fail("single_trial_put_already_claimed");
    // The caller dispatches only after this entire method resolves. Losing CAS
    // or readback response consumes the grant; inspect never grants dispatch.
    const claimed = await this.#trialRow();
    if (!claimed || claimed.state !== "uploading" || !claimed.putAttempted)
      fail("single_trial_conflict");
    return claimed;
  }
  async markSingleTrialUncertain(identity, permitId) {
    const { row, layout } = await this.#inspectTrial(identity, true);
    if (!row || row.permit.permitId !== permitId) fail("single_trial_conflict");
    if (row.state === "uploading" || row.state === "uncertain")
      await this.#write(
        "UPDATE shelf_storage_single_trial SET state='uncertain',updated_at=? WHERE id=1 AND permit_id=? AND state IN ('uploading','uncertain') AND put_attempted=1",
        [this.#now(), permitId],
        layout,
        "uncertain-single-trial",
      );
    return this.#trialRow();
  }
  async reconcileSingleTrial(identity, permitId, adapter) {
    const { row, layout } = await this.#inspectTrial(identity, true);
    if (!row || row.permit.permitId !== permitId || !row.putAttempted)
      fail("single_trial_put_not_claimed");
    const store = snapshotObjectStore(row.permit.target, adapter);
    if (row.state === "confirmed") return row;
    let timer;
    const controller = new AbortController();
    try {
      const etag = await Promise.race([
        verifyStoredObject(
          row.permit.descriptor,
          cancellableStore(store, controller.signal),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new StorageError("object_verification_timeout"));
          }, this.#verificationTimeout);
        }),
      ]);
      clearTimeout(timer);
      if (etag === null)
        return {
          ...(await this.markSingleTrialUncertain(identity, permitId)),
          blockedReason: "object_absence_unresolved",
        };
      await this.#audit(true, true);
      await this.#write(
        "UPDATE shelf_storage_single_trial SET state='confirmed',content_verified=1,etag=?,updated_at=? WHERE id=1 AND permit_id=? AND descriptor_json=? AND state IN ('uploading','uncertain') AND put_attempted=1",
        [etag, this.#now(), permitId, json(row.permit.descriptor)],
        layout,
        "confirm-single-trial",
      );
      const confirmed = await this.#trialRow();
      if (confirmed?.state !== "confirmed" || confirmed.etag !== etag)
        fail("object_changed");
      await this.#audit();
      return confirmed;
    } catch (error) {
      try {
        await this.markSingleTrialUncertain(identity, permitId);
      } catch {}
      throw safeError(
        error,
        verificationErrorCodes,
        "object_verification_unknown",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  #decode(row) {
    if (!row) fail("storage_reservation_missing");
    const d = objectDescriptor(JSON.parse(row.descriptor_json));
    if (
      row.logical_key !== logicalKey(d) ||
      row.object_key !== d.objectKey ||
      row.size_bytes !== d.sizeBytes
    )
      fail("storage_reservation_conflict");
    return {
      reservationId: row.reservation_id,
      descriptor: d,
      state: row.state,
      putAttempted: !!row.put_attempted,
      contentVerified: !!row.content_verified,
      etag: row.etag,
    };
  }
  async #row(id) {
    if (typeof id !== "string" || id.length > 210)
      fail("storage_reservation_invalid");
    return this.#decode(
      (
        await this.#query(
          "SELECT * FROM shelf_storage_reservations WHERE reservation_id=? LIMIT 1",
          [id],
        )
      )[0],
    );
  }
  async get(identity, id) {
    await this.#ready(identity);
    return this.#row(id);
  }
  async #pages(table, columns, key = "reservation_id", scope = "production") {
    const all = [];
    let cursor = "";
    for (;;) {
      const rows = await this.#query(
        `SELECT ${columns} FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 100`,
        [cursor],
        scope,
        "bounded-readback-page",
      );
      if (rows.length > PAGE) fail("migration_incomplete");
      for (const row of rows) {
        if (typeof row[key] !== "string" || row[key] <= cursor)
          fail("migration_incomplete");
        cursor = row[key];
        all.push(row);
        if (all.length > MIGRATION_LIMIT) fail("migration_limit");
      }
      if (rows.length < PAGE) break;
    }
    return all;
  }
  async registry(identity, kind) {
    await this.#ready(identity);
    if (!["original", "prepared-text"].includes(kind))
      fail("storage_descriptor_invalid");
    return (
      await this.#pages(
        kind === "original"
          ? "shelf_storage_original_registry"
          : "shelf_storage_text_registry",
        "*",
        "logical_key",
      )
    ).map((r) => ({
      reservationId: r.reservation_id,
      descriptor: objectDescriptor(JSON.parse(r.descriptor_json)),
      etag: r.etag,
      enabled: !!r.enabled,
    }));
  }
  async reserve(identity, reservationId, descriptor, bytes, evidence) {
    const pinnedIdentity = clone(identity),
      pinnedEvidence = clone(evidence);
    this.#assert(pinnedIdentity);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(reservationId))
      fail("storage_reservation_invalid");
    // Identity/id rejection must not leave an already-rejected async byte
    // validation promise unconsumed. This call pins descriptor/bytes synchronously
    // before its first await, and still completes before any budget/network IO.
    const { descriptor: d } = await validateObjectBytes(descriptor, bytes);
    const initial = await this.#ready(pinnedIdentity, true);
    const matches = await this.#query(
      "SELECT * FROM shelf_storage_reservations WHERE reservation_id=? OR logical_key=? OR object_key=? LIMIT 4",
      [reservationId, logicalKey(d), d.objectKey],
    );
    if (
      matches.length &&
      (matches.length !== 1 ||
        matches[0].reservation_id !== reservationId ||
        matches[0].descriptor_json !== json(d))
    )
      fail("storage_reservation_conflict");
    if (
      matches.length &&
      (matches[0].state !== "reserved" || matches[0].put_attempted)
    )
      return this.#decode(matches[0]);
    const now = this.#now(),
      observation = accountEvidence(
        pinnedEvidence,
        this.#identity.accountId,
        now,
      );
    if (observation.observedAt > now) fail("account_storage_stale");
    const changed = await this.#write(
      "UPDATE shelf_storage_authority SET observed_bytes=?,observed_at=?,evidence_hash=?,billing_period=? WHERE id=1 AND identity_json=? AND phase='ready' RETURNING id",
      [
        observation.observedBytes,
        observation.observedAt,
        observation.evidenceSha256,
        pinnedEvidence.billingPeriod,
        json(this.#identity),
      ],
      initial.storageLayout,
    );
    if (changed.length !== 1) fail("storage_migration_required");
    const s = await this.#audit();
    if (
      BigInt(s.observed_bytes) +
        BigInt(s.committed_bytes) +
        BigInt(s.reserved_bytes) >
      BigInt(STORAGE_CEILING)
    )
      fail("storage_budget_exceeded");
    if (!matches.length)
      await this.#write(
        "INSERT INTO shelf_storage_reservations(reservation_id,logical_key,object_key,descriptor_json,size_bytes,state,put_attempted,content_verified,etag,created_at,updated_at) SELECT ?,?,?,?,?,'reserved',0,0,NULL,?,? WHERE NOT EXISTS(SELECT 1 FROM shelf_storage_reservations WHERE reservation_id=? OR logical_key=? OR object_key=?)",
        [
          reservationId,
          logicalKey(d),
          d.objectKey,
          json(d),
          d.sizeBytes,
          now,
          now,
          reservationId,
          logicalKey(d),
          d.objectKey,
        ],
        initial.storageLayout,
      );
    const row = await this.#row(reservationId);
    if (json(row.descriptor) !== json(d)) fail("storage_reservation_conflict");
    return row;
  }
  async claimPut(identity, id) {
    const state = await this.#ready(identity, true);
    const changed = await this.#write(
      "UPDATE shelf_storage_reservations SET state='uploading',put_attempted=1,updated_at=? WHERE reservation_id=? AND state='reserved' AND put_attempted=0 RETURNING reservation_id",
      [this.#now(), id],
      state.storageLayout,
    );
    if (changed.length !== 1) fail("storage_put_already_claimed");
    return this.#row(id);
  }
  async markUncertain(identity, id) {
    const state = await this.#ready(identity, true);
    await this.#write(
      "UPDATE shelf_storage_reservations SET state='uncertain',updated_at=? WHERE reservation_id=? AND put_attempted=1 AND state IN ('reserved','uploading')",
      [this.#now(), id],
      state.storageLayout,
    );
    return this.#row(id);
  }
  async reconcile(identity, id, adapter) {
    const pinned = clone(identity);
    this.#assert(pinned);
    const store = snapshotObjectStore(pinned, adapter);
    const initial = await this.#ready(pinned, true);
    const row = await this.#row(id);
    if (row.state === "confirmed") return row;
    let timer;
    const verificationController = new AbortController();
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          verificationController.abort();
          reject(new StorageError("object_verification_timeout"));
        }, this.#verificationTimeout);
      });
      const etag = await Promise.race([
        verifyStoredObject(
          row.descriptor,
          cancellableStore(store, verificationController.signal),
        ),
        deadline,
      ]);
      clearTimeout(timer);
      if (etag === null) {
        await this.markUncertain(pinned, id);
        return {
          ...(await this.#row(id)),
          blockedReason: "object_absence_unresolved",
        };
      }
      await this.#ready(pinned, true);
      await this.#write(
        "UPDATE shelf_storage_reservations SET state='confirmed',content_verified=1,etag=?,updated_at=? WHERE reservation_id=? AND descriptor_json=? AND state<>'confirmed'",
        [etag, this.#now(), id, json(row.descriptor)],
        initial.storageLayout,
      );
      const confirmed = await this.#row(id);
      if (confirmed.state !== "confirmed" || confirmed.etag !== etag)
        fail("object_changed");
      return confirmed;
    } catch (e) {
      try {
        await this.markUncertain(pinned, id);
      } catch {}
      throw safeError(e, verificationErrorCodes, "object_verification_unknown");
    } finally {
      clearTimeout(timer);
      verificationController.abort();
    }
  }
  async #frozenSource(scope, snapshotAt) {
    const markers = await this.#query(
      "SELECT id,authority_id,account_id,bucket,freeze_id,frozen_at FROM shelf_storage_legacy_freeze WHERE id=1 LIMIT 2",
      [],
      scope,
      "verify-legacy-freeze",
    );
    const marker = markers[0];
    if (
      markers.length !== 1 ||
      !marker ||
      marker.authority_id !== this.#identity.authorityId ||
      marker.account_id !== this.#identity.accountId ||
      marker.bucket !== this.#identity.bucket ||
      !integer(marker.frozen_at) ||
      marker.frozen_at > this.#now()
    )
      fail("migration_freeze_unproven");
    const definitions = await this.#query(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('shelf_legacy_marker_update','shelf_legacy_marker_delete','shelf_legacy_state_insert','shelf_legacy_state_update','shelf_legacy_state_delete','shelf_legacy_reservation_insert','shelf_legacy_reservation_update','shelf_legacy_reservation_delete','shelf_legacy_registry_insert','shelf_legacy_registry_update','shelf_legacy_registry_delete') ORDER BY name LIMIT 12",
      [],
      scope,
      "verify-freeze-schema",
    );
    if (
      definitions.length !== 11 ||
      definitions.some(
        (r) => typeof r.name !== "string" || typeof r.sql !== "string",
      ) ||
      json(
        definitions.map((r) => ({ name: r.name, sql: normalizeSql(r.sql) })),
      ) !== json(freezeDefinitions)
    )
      fail("migration_freeze_unproven");
    const counts = (
      await this.#query(
        "SELECT (SELECT count(*) FROM upload_reservations) AS reservations,(SELECT count(*) FROM file_registry) AS registry,(SELECT count(*) FROM storage_state) AS ledger",
        [],
        scope,
        "verify-source-counts",
      )
    )[0];
    if (
      !counts ||
      ![counts.reservations, counts.registry, counts.ledger].every(integer) ||
      counts.reservations > MIGRATION_LIMIT ||
      counts.registry > MIGRATION_LIMIT ||
      counts.ledger > 1
    )
      fail("migration_incomplete");
    const ledger = await this.#query(
      "SELECT account_id,committed_bytes,reserved_bytes FROM storage_state WHERE id=1 LIMIT 2",
      [],
      scope,
      "read-source-ledger",
    );
    if (
      ledger.length !== counts.ledger ||
      (!ledger.length && (counts.reservations || counts.registry)) ||
      (ledger.length && ledger[0].account_id !== this.#identity.accountId)
    )
      fail("migration_ledger_mismatch");
    const rows = await this.#pages(
      "upload_reservations",
      "reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,etag,content_verified,absence_verified",
      "reservation_id",
      scope,
    );
    const registry = await this.#pages(
      "file_registry",
      "scope,file_id,book_id,format,size_bytes,object_key,sha256,etag,state,version",
      "file_id",
      scope,
    );
    if (
      rows.length !== counts.reservations ||
      registry.length !== counts.registry ||
      rows.some(
        (r) =>
          ![0, 1].includes(r.content_verified) ||
          ![0, 1].includes(r.absence_verified),
      ) ||
      rows.some((r) => r.scope !== scope) ||
      registry.some((r) => r.scope !== scope)
    )
      fail("migration_incomplete");
    const descriptor = (r) =>
      objectDescriptor({
        kind: "original",
        scope,
        fileId: r.file_id,
        bookId: r.book_id,
        format: r.format,
        sizeBytes: r.size_bytes,
        sha256: r.sha256,
        objectKey: r.object_key,
        versionHash: null,
        source: null,
      });
    const body = {
      schemaVersion: 1,
      scope,
      databaseId: this.#identity.legacyDatabases[scope],
      accountId: this.#identity.accountId,
      bucket: this.#identity.bucket,
      frozen: {
        writesStopped: true,
        freezeId: marker.freeze_id,
        frozenAt: marker.frozen_at,
        snapshotAt: snapshotAt ?? this.#now(),
      },
      complete: true,
      counts: { reservations: rows.length, registry: registry.length },
      ledger: {
        committedBytes: ledger[0]?.committed_bytes ?? 0,
        reservedBytes: ledger[0]?.reserved_bytes ?? 0,
      },
      reservations: rows.map((r) => ({
        reservationId: r.reservation_id,
        descriptor: descriptor(r),
        state: r.state,
        etag: r.etag,
        contentVerified: !!r.content_verified,
        absenceVerified: !!r.absence_verified,
      })),
      registry: registry.map((r) => ({
        descriptor: descriptor(r),
        etag: r.etag,
        state: r.state,
        version: r.version,
      })),
    };
    if (body.frozen.snapshotAt > this.#now()) fail("migration_incomplete");
    const snapshot = frozenSnapshot(
      { ...body, sha256: bytesSha256(json(body)) },
      this.#identity,
    );
    return {
      snapshot,
      proof: {
        scope,
        databaseId: this.#identity.legacyDatabases[scope],
        freezeId: marker.freeze_id,
        frozenAt: marker.frozen_at,
        freezeSchemaHash,
        sourceSnapshotHash: snapshot.sha256,
      },
    };
  }
  async readFrozenSnapshots(identity) {
    this.#assert(identity);
    const all = [];
    for (const scope of ["check", "production"])
      all.push((await this.#frozenSource(scope)).snapshot);
    return all;
  }
  async migrationReceipt(identity) {
    this.#assert(identity);
    const state = await this.#audit();
    return state.receipt_json ? JSON.parse(state.receipt_json) : null;
  }
  async migrateFrozen(identity, input) {
    return this.#migrate(identity, input, false);
  }
  async activateFrozen(identity, input) {
    return this.#migrate(identity, input, true);
  }
  async #migrate(identity, input, activate) {
    this.#assert(identity);
    const schema = await this.#schema();
    if (schema.layout === "activation-v2") fail("storage_v2_write_unavailable");
    if (schema.layout === "trial-v1") {
      if (await this.#trialRow()) fail("single_trial_keeps_imported");
    }
    if (!Array.isArray(input) || input.length !== 2)
      fail("migration_incomplete");
    const snapshots = clone(input)
      .map((s) => frozenSnapshot(s, this.#identity))
      .sort((a, b) => order(a.scope, b.scope));
    if (
      snapshots[0].scope !== "check" ||
      snapshots[1].scope !== "production" ||
      snapshots.reduce((n, s) => n + s.reservations.length, 0) > MIGRATION_LIMIT
    )
      fail("migration_limit");
    const migrationHash = bytesSha256(
        json({ identity: this.#identity, snapshots }),
      ),
      state = await this.#audit();
    if (state.phase === "ready") {
      if (state.migration_hash !== migrationHash || !state.receipt_json)
        fail("migration_conflict");
      return JSON.parse(state.receipt_json);
    }
    const proofs = [];
    for (const s of snapshots) {
      const actual = await this.#frozenSource(s.scope, s.frozen.snapshotAt);
      if (json(actual.snapshot) !== json(s)) fail("migration_source_changed");
      proofs.push(actual.proof);
    }
    const expected = [],
      sources = [];
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i],
        byKey = new Map(s.registry.map((r) => [logicalKey(r.descriptor), r]));
      for (const r of s.reservations) {
        if (r.state === "aborted") continue;
        const d = r.descriptor,
          confirmed = r.state === "confirmed";
        expected.push({
          reservation_id: `${s.scope}:${r.reservationId}`,
          logical_key: logicalKey(d),
          object_key: d.objectKey,
          descriptor_json: json(d),
          size_bytes: d.sizeBytes,
          state: confirmed ? "confirmed" : "uncertain",
          etag: confirmed ? r.etag : null,
          enabled: confirmed
            ? Number(byKey.get(logicalKey(d)).state === "confirmed")
            : null,
          created_at: s.frozen.snapshotAt,
        });
      }
      const { reservations, registry, ...metadata } = s;
      sources.push({
        scope: s.scope,
        migration_hash: migrationHash,
        snapshot_hash: s.sha256,
        metadata_json: json(metadata),
        freeze_proof_json: json(proofs[i]),
        reservation_count: s.reservations.filter((r) => r.state !== "aborted")
          .length,
        registry_count: s.registry.length,
        committed_bytes: s.ledger.committedBytes,
        reserved_bytes: s.ledger.reservedBytes,
      });
    }
    expected.sort((a, b) => order(a.reservation_id, b.reservation_id));
    if (state.phase === "migration_required") {
      const existingSources = await this.#query(
        "SELECT * FROM shelf_storage_sources ORDER BY scope LIMIT 3",
      );
      for (const old of existingSources) {
        const expectedSource = sources.find((s) => s.scope === old.scope);
        if (!expectedSource || !same(old, expectedSource))
          fail("migration_conflict");
      }
      for (const s of sources.filter(
        (s) => !existingSources.some((old) => old.scope === s.scope),
      ))
        await this.#write(
          "INSERT INTO shelf_storage_sources(scope,migration_hash,snapshot_hash,metadata_json,freeze_proof_json,reservation_count,registry_count,committed_bytes,reserved_bytes) SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM shelf_storage_sources WHERE scope=?)",
          [...Object.values(s), s.scope],
          schema.layout,
        );
      const existingStage = await this.#pages("shelf_storage_staging", "*");
      for (const old of existingStage) {
        const expectedRow = expected.find(
          (r) => r.reservation_id === old.reservation_id,
        );
        if (!expectedRow || !same(old, expectedRow)) fail("migration_conflict");
      }
      const missing = expected.filter(
        (r) =>
          !existingStage.some((old) => old.reservation_id === r.reservation_id),
      );
      for (let start = 0; start < missing.length; start += 10) {
        const batch = missing.slice(start, start + 10);
        await this.#write(
          `INSERT OR IGNORE INTO shelf_storage_staging(reservation_id,logical_key,object_key,descriptor_json,size_bytes,state,etag,enabled,created_at) SELECT * FROM (VALUES ${batch.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")}) WHERE 1`,
          batch.flatMap(Object.values),
          schema.layout,
        );
      }
      const staged = await this.#pages("shelf_storage_staging", "*");
      const actualSources = await this.#query(
        "SELECT * FROM shelf_storage_sources ORDER BY scope LIMIT 3",
      );
      if (!same(staged, expected) || !same(actualSources, sources))
        fail("migration_readback_failed");
      const changed = await this.#write(
        "UPDATE shelf_storage_authority SET phase='imported',migration_hash=? WHERE id=1 AND phase='migration_required' RETURNING id",
        [migrationHash],
        schema.layout,
      );
      if (changed.length !== 1) fail("migration_conflict");
    } else if (
      state.phase !== "imported" ||
      state.migration_hash !== migrationHash
    )
      fail("migration_conflict");
    const actual = await this.#pages("shelf_storage_reservations", "*"),
      expectedLive = expected.map((r) => ({
        reservation_id: r.reservation_id,
        logical_key: r.logical_key,
        object_key: r.object_key,
        descriptor_json: r.descriptor_json,
        size_bytes: r.size_bytes,
        state: r.state,
        put_attempted: 1,
        content_verified: Number(r.state === "confirmed"),
        etag: r.etag,
        created_at: r.created_at,
        updated_at: r.created_at,
      }));
    const registry = await this.#pages(
        "shelf_storage_original_registry",
        "*",
        "logical_key",
      ),
      expectedRegistry = expected
        .filter((r) => r.state === "confirmed")
        .map((r) => ({
          logical_key: r.logical_key,
          reservation_id: r.reservation_id,
          descriptor_json: r.descriptor_json,
          etag: r.etag,
          enabled: r.enabled,
        }))
        .sort((a, b) => order(a.logical_key, b.logical_key));
    const text = await this.#pages(
        "shelf_storage_text_registry",
        "*",
        "logical_key",
      ),
      actualSources = await this.#query(
        "SELECT * FROM shelf_storage_sources ORDER BY scope LIMIT 3",
      ),
      staged = await this.#pages("shelf_storage_staging", "*");
    const projection = await this.#pages(
        "file_registry",
        "scope,file_id,book_id,format,size_bytes,object_key,sha256,etag,state,version",
        "file_id",
      ),
      expectedProjection = snapshots
        .find((s) => s.scope === "production")
        .registry.map((r) => ({
          scope: "production",
          file_id: r.descriptor.fileId,
          book_id: r.descriptor.bookId,
          format: r.descriptor.format,
          size_bytes: r.descriptor.sizeBytes,
          object_key: r.descriptor.objectKey,
          sha256: r.descriptor.sha256,
          etag: r.etag,
          state: r.state,
          version: r.version,
        }))
        .sort((a, b) => order(a.file_id, b.file_id));
    const audited = await this.#audit();
    if (
      !same(actual, expectedLive) ||
      !same(registry, expectedRegistry) ||
      text.length ||
      !same(actualSources, sources) ||
      !same(staged, expected) ||
      !same(projection, expectedProjection) ||
      audited.committed_bytes !==
        sources.reduce((n, s) => n + s.committed_bytes, 0) ||
      audited.reserved_bytes !==
        sources.reduce((n, s) => n + s.reserved_bytes, 0)
    )
      fail("migration_readback_failed");
    // Read legacy sources AGAIN after independent live readback, while all entrypoints stay closed.
    for (const s of snapshots) {
      const final = await this.#frozenSource(s.scope, s.frozen.snapshotAt);
      if (json(final.snapshot) !== json(s)) fail("migration_source_changed");
    }
    const readbackHash = bytesSha256(
      stableJson({ actual, registry, text, actualSources, staged, projection }),
    );
    const importedReceipt = {
      schemaVersion: 1,
      verificationScope: "migration-at-import-time",
      migrationHash,
      sourceHashes: snapshots.map((s) => ({
        scope: s.scope,
        sha256: s.sha256,
      })),
      importedReservations: actual.length,
      committedBytes: audited.committed_bytes,
      reservedBytes: audited.reserved_bytes,
      readbackSha256: readbackHash,
      cloudWriteFreezeProven: false,
      databaseWriteFreezeProven: true,
      sourceProjectionVerified: true,
      freezeProofs: proofs,
      verifiedAt: this.#now(),
    };
    if (!activate) {
      await this.#write(
        "UPDATE shelf_storage_authority SET readback_hash=?,receipt_json=? WHERE id=1 AND phase='imported' AND migration_hash=?",
        [readbackHash, json(importedReceipt), migrationHash],
        schema.layout,
      );
      const saved = await this.#audit();
      if (
        saved.phase !== "imported" ||
        saved.receipt_json !== json(importedReceipt)
      )
        fail("migration_readback_failed");
      return importedReceipt;
    }
    if (typeof this.#verifyClosure !== "function")
      fail("migration_write_closure_unproven");
    const closure = writeClosure(
      await this.#verifyClosure({
        identity: clone(this.#identity),
        freezeProofs: clone(proofs),
      }),
      this.#identity,
      this.#now(),
      true,
    );
    const receipt = {
      schemaVersion: 1,
      verificationScope: "migration-at-import-time",
      migrationHash,
      sourceHashes: snapshots.map((s) => ({
        scope: s.scope,
        sha256: s.sha256,
      })),
      importedReservations: actual.length,
      committedBytes: audited.committed_bytes,
      reservedBytes: audited.reserved_bytes,
      readbackSha256: readbackHash,
      cloudWriteFreezeProven: true,
      databaseWriteFreezeProven: true,
      sourceProjectionVerified: true,
      writeClosureProof: closure,
      freezeProofs: proofs,
      verifiedAt: this.#now(),
    };
    await this.#write(
      "UPDATE shelf_storage_authority SET phase='ready',readback_hash=?,receipt_json=? WHERE id=1 AND phase='imported' AND migration_hash=?",
      [readbackHash, json(receipt), migrationHash],
      schema.layout,
    );
    const ready = await this.#audit();
    if (ready.phase !== "ready" || ready.receipt_json !== json(receipt))
      fail("migration_readback_failed");
    return receipt;
  }
}
