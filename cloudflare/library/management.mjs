// Owner-only library management. No environment discovery, retries or object deletion.
import { LibraryError, randomKey, readJson } from "./security.mjs";
import {
  THRESHOLD,
  mergePublicBook,
  validateMetadataFields,
  deriveCategoryId,
  normalizedEtag,
  objectHeadMatches,
} from "./core.mjs";
import { trialSha256 } from "./single-trial.mjs";
import { identifyCapability, identifyRoute } from "./identify.mjs";
import { storageReadConfiguration } from "./storage-sources.mjs";
import { storageBooks, storageBookCursor } from "./storage-book-controller.mjs";
import { storageLifecycle } from "./storage-book-mutations.mjs";
import {
  ISOLATED_UPLOAD_TARGET,
  ISOLATED_CONFIRMED_SQL,
  isolatedUploadConfiguration,
  assertIsolatedConfiguration,
  loadIsolatedPolicy,
  isolatedPolicyTuple,
  assertIsolatedUploadRow,
} from "./isolated-upload.mjs";
const FORMATS = ["PDF", "EPUB", "MOBI", "AZW", "AZW3"];
const fail = (code, status = 400) => {
  throw new LibraryError(code, status);
};
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const mime = (f) =>
  ({
    PDF: "application/pdf",
    EPUB: "application/epub+zip",
    MOBI: "application/x-mobipocket-ebook",
    AZW: "application/vnd.amazon.ebook",
    AZW3: "application/vnd.amazon.ebook",
  })[f];
const validNumber = (n) => Number.isSafeInteger(n) && n >= 0;
const closedUpload = (env) =>
  env.STORAGE_MODE === "authority-v2"
    ? {
        enabled: false,
        code: "normal_upload_unavailable",
        reasons: ["storage_write_closed"],
        maxBytes: THRESHOLD,
        formats: FORMATS,
      }
    : null;
const uploadBlocked = (d, upload) =>
  d.response(409, { error: { code: "upload_blocked" }, upload });
export async function uploadCapability(env, context, d, { claimUpload } = {}) {
  const closed = closedUpload(env);
  if (closed) return closed;
  const isolated = isolatedUploadConfiguration(env);
  if (isolated) {
    const reasons = [];
    try {
      const p = await loadIsolatedPolicy(env, d, isolated, { write: true });
      if (claimUpload) {
        const current = await assertIsolatedUploadRow(
          env,
          d,
          isolated,
          claimUpload,
        );
        if (
          current.state !== "reserved" ||
          current.put_attempted !== 0 ||
          current.content_verified !== 0 ||
          current.etag !== null
        )
          reasons.push("authority_accounting_mismatch");
      } else if (p.committed_bytes + p.reserved_bytes === p.budget_bytes)
        reasons.push("storage_budget_exceeded");
    } catch {
      reasons.push("storage_write_closed");
    }
    return {
      enabled: reasons.length === 0,
      code: reasons.length ? "normal_upload_unavailable" : "ready",
      reasons,
      maxBytes: THRESHOLD,
      formats: FORMATS,
    };
  }
  const reasons = [];
  if (
    env.NORMAL_UPLOAD_MODE !== "authority-v1" ||
    env.APP_SCOPE !== "production" ||
    env.SINGLE_TRIAL_MODE !== undefined ||
    ["put", "head", "get"].some((k) => typeof env.BOOKS?.[k] !== "function")
  )
    reasons.push("normal_upload_storage_unconfigured");
  let a;
  try {
    a = await d
      .prepare(
        env,
        `SELECT a.*,COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0) AS actual_committed,COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0) AS actual_reserved FROM shelf_storage_authority a WHERE id=1`,
      )
      .first();
    // The trial is an additive, retained responsibility in the same authority.
    const table = await d
      .prepare(
        env,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='shelf_storage_single_trial'",
      )
      .first();
    if (table && a) {
      const t = await d
        .prepare(
          env,
          "SELECT COALESCE(sum(CASE WHEN state='confirmed' THEN size_bytes ELSE 0 END),0) AS committed,COALESCE(sum(CASE WHEN state<>'confirmed' THEN size_bytes ELSE 0 END),0) AS reserved FROM shelf_storage_single_trial",
        )
        .first();
      a.actual_committed += t.committed;
      a.actual_reserved += t.reserved;
    }
  } catch {
    reasons.push("authority_unavailable");
  }
  let identity;
  try {
    identity = JSON.parse(a?.identity_json);
  } catch {}
  if (
    !identity ||
    identity.schemaVersion !== 1 ||
    !/^[a-f0-9]{32}$/.test(identity.accountId || "") ||
    !/^[a-f0-9-]{36}$/.test(identity.legacyDatabases?.production || "") ||
    !/^[a-f0-9-]{36}$/.test(identity.legacyDatabases?.check || "") ||
    identity.authorityId !== "shelf-remote-storage-v1" ||
    identity.accountId !== env.R2_ACCOUNT_ID ||
    identity.bucket !== "the-shelf-books" ||
    identity.bucket !== env.R2_BUCKET ||
    identity.legacyDatabases?.production === identity.legacyDatabases?.check
  )
    reasons.push("storage_target_mismatch");
  if (
    !a ||
    a.phase !== "ready" ||
    !hash(a.migration_hash) ||
    !hash(a.readback_hash) ||
    !a.receipt_json
  )
    reasons.push("authority_not_ready");
  const now = Date.now();
  if (
    !a ||
    !validNumber(a.observed_bytes) ||
    !validNumber(a.observed_at) ||
    a.observed_at > now ||
    a.observed_at < now - 300000 ||
    !hash(a.evidence_hash) ||
    a.billing_period !== new Date(now).toISOString().slice(0, 7)
  )
    reasons.push("account_evidence_stale");
  if (
    a &&
    (!validNumber(a.committed_bytes) ||
      !validNumber(a.reserved_bytes) ||
      a.committed_bytes !== a.actual_committed ||
      a.reserved_bytes !== a.actual_reserved)
  )
    reasons.push("authority_accounting_mismatch");
  // A claimed upload consumes an existing responsibility, rather than reserving
  // more bytes. Verify its persisted relationship before allowing an exact-full
  // budget; an ID supplied by itself cannot establish that responsibility.
  if (claimUpload) {
    let reservation;
    try {
      reservation = await d
        .prepare(
          env,
          `SELECT r.size_bytes FROM browser_uploads u JOIN shelf_storage_reservations r ON r.reservation_id=u.reservation_id JOIN book_management m ON m.scope=u.scope AND m.book_id=u.book_id WHERE u.scope=? AND u.upload_id=? AND u.reservation_id=? AND u.descriptor_json=? AND r.descriptor_json=u.descriptor_json AND r.state='reserved' AND r.put_attempted=0 AND r.content_verified=0 AND r.etag IS NULL AND r.logical_key=('original:'||u.scope||':'||u.file_id||':original') AND r.object_key=json_extract(u.descriptor_json,'$.objectKey') AND r.size_bytes=json_extract(u.descriptor_json,'$.sizeBytes') AND json_extract(u.descriptor_json,'$.kind')='original' AND json_extract(u.descriptor_json,'$.scope')=u.scope AND json_extract(u.descriptor_json,'$.bookId')=u.book_id AND json_extract(u.descriptor_json,'$.fileId')=u.file_id AND json_extract(u.descriptor_json,'$.sha256')=u.sha256 AND m.trashed=0 AND m.version=?`,
          context.scope,
          claimUpload.upload_id,
          claimUpload.reservation_id,
          claimUpload.descriptor_json,
          claimUpload.management_version,
        )
        .first();
    } catch {}
    if (
      !reservation ||
      !validNumber(reservation.size_bytes) ||
      reservation.size_bytes < 1 ||
      reservation.size_bytes > THRESHOLD ||
      !a ||
      reservation.size_bytes > a.reserved_bytes
    )
      reasons.push("authority_accounting_mismatch");
  }
  const total = a && a.observed_bytes + a.committed_bytes + a.reserved_bytes;
  if (
    a &&
    (!validNumber(total) ||
      total > 8000000000 ||
      (!claimUpload && total === 8000000000))
  )
    reasons.push("storage_budget_exceeded");
  return {
    enabled: reasons.length === 0,
    code: reasons.length ? "normal_upload_unavailable" : "ready",
    reasons,
    maxBytes: THRESHOLD,
    formats: FORMATS,
  };
}
const stateInfo = (row) => ({
  id: row.upload_id,
  state: row.state,
  canSubmit: row.state === "reserved" && row.put_attempted === 0,
  bytesUrl: `/api/manage/uploads/${row.upload_id}/bytes`,
});
async function uploadRow(env, id, d) {
  return d.query(() =>
    d
      .prepare(
        env,
        `SELECT u.*,r.state,r.put_attempted,r.etag,m.version AS management_version FROM browser_uploads u JOIN shelf_storage_reservations r ON r.reservation_id=u.reservation_id JOIN book_management m ON m.scope=u.scope AND m.book_id=u.book_id WHERE u.scope='production' AND u.upload_id=?`,
        id,
      )
      .first(),
  );
}
export async function assertCurrent(
  env,
  context,
  session,
  d,
  bookId = null,
  expectedVersion = null,
) {
  const s = await d.query(() =>
    d
      .prepare(
        env,
        `SELECT s.session_hash FROM sessions s JOIN auth_config a ON a.scope=s.scope WHERE s.scope=? AND s.session_hash=? AND s.generation=? AND s.revoked=0 AND s.expires_at>? AND a.enabled=1 AND a.generation=s.generation AND a.origin=? AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM book_management WHERE scope=? AND book_id=? AND trashed=1)) AND (? IS NULL OR EXISTS(SELECT 1 FROM book_management WHERE scope=? AND book_id=? AND version=?))`,
        context.scope,
        session.session_hash,
        session.generation,
        Date.now(),
        context.origin,
        bookId,
        context.scope,
        bookId,
        expectedVersion,
        context.scope,
        bookId,
        expectedVersion,
      )
      .first(),
  );
  if (!s) fail("authentication_required", 401);
}
export async function boundedUploadBytes(
  body,
  size,
  { declared = null, timeout = 30000 } = {},
) {
  if (
    !body ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > THRESHOLD ||
    (declared !== null && declared !== String(size))
  )
    fail("invalid_upload");
  const reader = body.getReader(),
    chunks = [];
  let total = 0,
    count = 0,
    done = false,
    timer;
  const cancel = () => {
    try {
      void Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new LibraryError("upload_timeout", 408));
      cancel();
    }, timeout);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) {
        done = true;
        break;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        ++count > 65536 ||
        (total += next.value.length) > size
      )
        fail("invalid_upload");
      chunks.push(next.value);
    }
    if (total !== size) fail("invalid_upload");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    if (!done) cancel();
  }
}
export function validateUploadMagic(bytes, format) {
  const ascii = (start, length) =>
    new TextDecoder("ascii").decode(bytes.subarray(start, start + length));
  if (format === "PDF") {
    if (ascii(0, 5) !== "%PDF-") fail("invalid_file_format");
    return;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "EPUB") {
    if (
      bytes.length < 58 ||
      v.getUint32(0, true) !== 0x04034b50 ||
      v.getUint16(8, true) !== 0 ||
      v.getUint16(26, true) !== 8 ||
      v.getUint16(28, true) !== 0 ||
      ascii(30, 8) !== "mimetype" ||
      ascii(38, 20) !== "application/epub+zip"
    )
      fail("invalid_file_format");
    return;
  }
  if (
    !FORMATS.includes(format) ||
    bytes.length < 100 ||
    ascii(60, 8) !== "BOOKMOBI" ||
    v.getUint16(76, false) < 1
  )
    fail("invalid_file_format");
  const offset = v.getUint32(78, false);
  if (
    offset < 86 ||
    offset + 40 > bytes.length ||
    ascii(offset + 16, 4) !== "MOBI"
  )
    fail("invalid_file_format");
  if (v.getUint16(offset + 12, false) !== 0) fail("drm_not_supported");
}
async function intent(request, env, context, session, d) {
  const isolated = isolatedUploadConfiguration(env);
  const closed = closedUpload(env);
  if (closed) return uploadBlocked(d, closed);
  const capability = await uploadCapability(env, context, d);
  if (!capability.enabled)
    return d.response(409, {
      error: { code: "upload_blocked" },
      upload: capability,
    });
  const input = await readJson(request),
    f = input.file;
  if (
    Object.keys(input).some(
      (k) => !["title", "author", "category", "file"].includes(k),
    ) ||
    !f ||
    Object.keys(f).some(
      (k) => !["name", "format", "sizeBytes", "sha256"].includes(k),
    ) ||
    typeof f.name !== "string" ||
    f.name.length < 1 ||
    f.name.length > 255 ||
    !FORMATS.includes(f.format) ||
    !Number.isSafeInteger(f.sizeBytes) ||
    f.sizeBytes < 1 ||
    f.sizeBytes > THRESHOLD ||
    !hash(f.sha256)
  )
    fail("invalid_upload");
  if (!f.name.toLowerCase().endsWith("." + f.format.toLowerCase()))
    fail("invalid_file_format");
  const clean = validateMetadataFields({
    title: input.title,
    author: input.author,
    category: input.category,
  });
  const existing = await d.query(() =>
    d
      .prepare(
        env,
        `SELECT u.*,r.state,r.put_attempted FROM browser_uploads u JOIN shelf_storage_reservations r ON r.reservation_id=u.reservation_id WHERE u.scope=? AND u.sha256=?`,
        context.scope,
        f.sha256,
      )
      .first(),
  );
  if (existing) {
    if (isolated) await assertIsolatedUploadRow(env, d, isolated, existing);
    else if (existing.target_id != null) fail("upload_target_conflict", 409);
    await assertCurrent(env, context, session, d, existing.book_id);
    if (isolated) assertIsolatedConfiguration(env, isolated, session);
    return d.response(200, {
      upload: { ...stateInfo(existing), canSubmit: false },
      bookId: existing.book_id,
      fileId: existing.file_id,
    });
  }
  const uploadId = randomKey(),
    bookId = "book_" + randomKey(),
    fileId = "file_" + randomKey(),
    now = Date.now(),
    reservationId = "browser_" + uploadId;
  const descriptor = {
    kind: "original",
    scope: context.scope,
    fileId,
    bookId,
    format: f.format,
    sizeBytes: f.sizeBytes,
    sha256: f.sha256,
    objectKey: `books/cf03/${fileId}/${f.sha256}.${f.format.toLowerCase()}`,
    versionHash: null,
    source: null,
  };
  const book = {
    id: bookId,
    title: clean.title,
    author: clean.author,
    category: clean.category,
    categoryId: await deriveCategoryId(clean.category),
    tags: [],
    description: "",
    files: [
      {
        id: fileId,
        format: f.format,
        sizeBytes: f.sizeBytes,
        status: "candidate",
        reason: "not_uploaded",
        visibility: "private",
        readable: true,
      },
    ],
  };
  try {
    await d.query(() =>
      env.DB.batch([
        d.admission(env, { ...context, now }, "metadata", session),
        d.prepare(
          env,
          "INSERT INTO catalog_books(scope,book_id,public_json) VALUES(?,?,?)",
          context.scope,
          bookId,
          JSON.stringify(book),
        ),
        d.prepare(
          env,
          "INSERT INTO book_management(scope,book_id,visibility,trashed,version,updated_at) VALUES(?,?,'private',0,1,?)",
          context.scope,
          bookId,
          now,
        ),
        d.prepare(
          env,
          isolated
            ? "INSERT INTO browser_uploads(upload_id,scope,book_id,file_id,sha256,reservation_id,descriptor_json,created_at,target_id) VALUES(?,?,?,?,?,?,?,?,?)"
            : "INSERT INTO browser_uploads(upload_id,scope,book_id,file_id,sha256,reservation_id,descriptor_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          uploadId,
          context.scope,
          bookId,
          fileId,
          f.sha256,
          reservationId,
          JSON.stringify(descriptor),
          now,
          ...(isolated ? [ISOLATED_UPLOAD_TARGET] : []),
        ),
        d.prepare(
          env,
          "INSERT INTO shelf_storage_reservations(reservation_id,logical_key,object_key,descriptor_json,size_bytes,state,put_attempted,content_verified,etag,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',0,0,NULL,?,?)",
          reservationId,
          `original:${context.scope}:${fileId}:original`,
          descriptor.objectKey,
          JSON.stringify(descriptor),
          f.sizeBytes,
          now,
          now,
        ),
      ]),
    );
  } catch (error) {
    const concurrent = await d.query(() =>
      d
        .prepare(
          env,
          `SELECT u.*,r.state,r.put_attempted FROM browser_uploads u JOIN shelf_storage_reservations r ON r.reservation_id=u.reservation_id WHERE u.scope=? AND u.sha256=?`,
          context.scope,
          f.sha256,
        )
        .first(),
    );
    if (!concurrent) throw error;
    if (isolated) await assertIsolatedUploadRow(env, d, isolated, concurrent);
    else if (concurrent.target_id != null) fail("upload_target_conflict", 409);
    await assertCurrent(env, context, session, d, concurrent.book_id);
    if (isolated) assertIsolatedConfiguration(env, isolated, session);
    return d.response(200, {
      upload: { ...stateInfo(concurrent), canSubmit: false },
      bookId: concurrent.book_id,
      fileId: concurrent.file_id,
    });
  }
  if (isolated) {
    await assertCurrent(env, context, session, d, bookId, 1);
    assertIsolatedConfiguration(env, isolated, session);
  }
  return d.response(201, {
    upload: {
      id: uploadId,
      state: "reserved",
      canSubmit: true,
      bytesUrl: `/api/manage/uploads/${uploadId}/bytes`,
    },
    bookId,
    fileId,
  });
}
async function bytes(request, env, context, session, id, d) {
  const isolated = isolatedUploadConfiguration(env);
  const closed = closedUpload(env);
  if (closed) return uploadBlocked(d, closed);
  let row = await uploadRow(env, id, d);
  if (!row) fail("upload_not_found", 404);
  if (isolated) row = await assertIsolatedUploadRow(env, d, isolated, row);
  else if (row.target_id != null) fail("upload_target_conflict", 409);
  const lifecycleVersion = row.management_version;
  if (row.state !== "reserved" || row.put_attempted)
    fail(
      row.state === "confirmed"
        ? "upload_already_confirmed"
        : "upload_uncertain",
      409,
    );
  let capability = await uploadCapability(env, context, d, {
    claimUpload: row,
  });
  if (!capability.enabled)
    return d.response(409, {
      error: { code: "upload_blocked" },
      upload: capability,
    });
  const descriptor = JSON.parse(row.descriptor_json),
    data = await boundedUploadBytes(request.body, descriptor.sizeBytes, {
      declared: request.headers.get("content-length"),
    });
  if ((await trialSha256(data)) !== descriptor.sha256)
    fail("file_hash_mismatch");
  validateUploadMagic(data, descriptor.format);
  if (isolated) assertIsolatedConfiguration(env, isolated, session);
  capability = await uploadCapability(env, context, d, { claimUpload: row });
  if (!capability.enabled)
    return d.response(409, {
      error: { code: "upload_blocked" },
      upload: capability,
    });
  // This transaction is the only nonrepeatable PUT claim. A lost response stops before PUT.
  const claim = await d.query(() =>
    env.DB.batch([
      d.admission(env, { ...context, now: Date.now() }, "metadata", session),
      d.prepare(
        env,
        `UPDATE shelf_storage_reservations SET state='uploading',put_attempted=1,updated_at=? WHERE reservation_id=? AND descriptor_json=? AND state='reserved' AND put_attempted=0 AND NOT EXISTS(SELECT 1 FROM book_management WHERE scope=? AND book_id=? AND trashed=1) AND EXISTS(SELECT 1 FROM book_management WHERE scope=? AND book_id=? AND version=?) AND EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND json_extract(identity_json,'$.accountId')=? AND json_extract(identity_json,'$.bucket')=?) RETURNING reservation_id`,
        Date.now(),
        row.reservation_id,
        row.descriptor_json,
        context.scope,
        row.book_id,
        context.scope,
        row.book_id,
        lifecycleVersion,
        env.R2_ACCOUNT_ID,
        isolated ? "the-shelf-books" : env.R2_BUCKET,
      ),
    ]),
  );
  if (isolated) assertIsolatedConfiguration(env, isolated, session);
  if (!claim[1].results?.length) fail("upload_uncertain", 409);
  let etag;
  try {
    const file = {
      size_bytes: descriptor.sizeBytes,
      sha256: descriptor.sha256,
      format: descriptor.format,
    };
    // A timeout does not cancel an uncertain remote write or grant another claim.
    const stored = await deadline(
      env.BOOKS.put(descriptor.objectKey, data, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: mime(descriptor.format) },
        customMetadata: { sha256: descriptor.sha256 },
        sha256: descriptor.sha256,
      }),
    );
    etag = normalizedEtag(stored?.etag);
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      stored.key !== descriptor.objectKey ||
      !etag ||
      !objectHeadMatches({ ...file, etag }, stored)
    )
      throw Error("verification");
    const first = await deadline(env.BOOKS.head(descriptor.objectKey));
    if (!objectHeadMatches({ ...file, etag }, first))
      throw Error("verification");
    const object = await deadline(
      env.BOOKS.get(descriptor.objectKey, { onlyIf: { etagMatches: etag } }),
    );
    if (!objectHeadMatches({ ...file, etag }, object)) {
      try {
        void object?.body?.cancel();
      } catch {}
      throw Error("verification");
    }
    const actual = await boundedUploadBytes(object.body, descriptor.sizeBytes);
    if ((await trialSha256(actual)) !== descriptor.sha256)
      throw Error("verification");
    const last = await deadline(env.BOOKS.head(descriptor.objectKey));
    if (!objectHeadMatches({ ...file, etag }, last))
      throw Error("verification");
    // Content confirmation is retained even if the owner revoked/trashes during verification.
    if (isolated) {
      assertIsolatedConfiguration(env, isolated);
      await assertIsolatedUploadRow(env, d, isolated, row);
    }
    await d.query(() =>
      d
        .prepare(
          env,
          "UPDATE shelf_storage_reservations SET state='confirmed',content_verified=1,etag=?,updated_at=? WHERE reservation_id=? AND descriptor_json=? AND state='uploading' AND put_attempted=1 RETURNING reservation_id",
          etag,
          Date.now(),
          row.reservation_id,
          row.descriptor_json,
        )
        .all(),
    );
  } catch {
    try {
      await d.query(() =>
        d
          .prepare(
            env,
            "UPDATE shelf_storage_reservations SET state='uncertain',updated_at=? WHERE reservation_id=? AND state='uploading' AND put_attempted=1",
            Date.now(),
            row.reservation_id,
          )
          .run(),
      );
    } catch {}
    return d.response(409, {
      error: { code: "upload_uncertain" },
      upload: { id, state: "uncertain", canSubmit: false },
    });
  }
  await assertCurrent(env, context, session, d, row.book_id, lifecycleVersion);
  row = await uploadRow(env, id, d);
  if (row.state !== "confirmed") fail("upload_uncertain", 409);
  const info = await d.bookInfo(env, context.scope, row.book_id, true);
  if (isolated) await assertIsolatedUploadRow(env, d, isolated, row);
  await assertCurrent(env, context, session, d, row.book_id, lifecycleVersion);
  if (isolated) assertIsolatedConfiguration(env, isolated, session);
  return d.response(201, {
    upload: stateInfo(row),
    book: info.book,
    bookId: row.book_id,
    fileId: row.file_id,
  });
}
async function deadline(operation, timeout = 30000) {
  let timer,
    expired = false;
  const tracked = Promise.resolve(operation).then((value) => {
    if (expired) {
      try {
        void Promise.resolve(value?.body?.cancel()).catch(() => {});
      } catch {}
    }
    return value;
  });
  try {
    return await Promise.race([
      tracked,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("storage_timeout"));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function lifecycle(request, env, context, session, bookId, trashed, d) {
  if (env.STORAGE_MODE === "authority-v2")
    return storageLifecycle(request, env, context, session, bookId, trashed, d);
  const input = await readJson(request);
  if (
    Object.keys(input).length !== 1 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    fail("invalid_management");
  const info = await d.bookInfo(env, context.scope, bookId, true, true),
    now = Date.now();
  const result = await d.query(() =>
    env.DB.batch([
      d.admission(env, { ...context, now }, "metadata", session),
      d.prepare(
        env,
        `INSERT INTO book_management(scope,book_id,visibility,trashed,version,updated_at) SELECT ?,?,'public',?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM book_management WHERE scope=? AND book_id=? AND version=?) ON CONFLICT(scope,book_id) DO UPDATE SET trashed=excluded.trashed,version=book_management.version+1,updated_at=excluded.updated_at WHERE book_management.version=? RETURNING trashed,version,updated_at`,
        context.scope,
        bookId,
        trashed,
        now,
        input.expectedVersion,
        context.scope,
        bookId,
        input.expectedVersion,
        input.expectedVersion,
      ),
      d.prepare(
        env,
        "SELECT version FROM book_management WHERE scope=? AND book_id=?",
        context.scope,
        bookId,
      ),
    ]),
  );
  const row = result[1].results?.[0];
  if (!row)
    return d.response(409, {
      error: { code: "management_conflict" },
      managementVersion: result[2].results?.[0]?.version ?? 0,
    });
  return d.response(200, {
    book: info.book,
    trashed: Boolean(row.trashed),
    managementVersion: row.version,
    deletedAt: row.trashed ? row.updated_at : null,
  });
}
export async function managementRoute(request, env, context, session, d) {
  const path = new URL(request.url).pathname;
  if (
    path === "/api/manage/identify" ||
    path.startsWith("/api/manage/identify/")
  )
    return identifyRoute(request, env, context, session, d);
  if (path === "/api/manage" && request.method === "GET") {
    if (env.STORAGE_MODE === "authority-v2") {
      const cursor = storageBookCursor(request);
      const configuration = storageReadConfiguration(env);
      // Capability has at most two SELECTs. The primary book projection is last,
      // so no further await can make its private session/source snapshot stale.
      const identify = await identifyCapability(env, d);
      const page = await storageBooks(env, context, session, {
        cursor,
        configuration,
      });
      return d.response(200, { ...page, upload: closedUpload(env), identify });
    }
    const result = await d.query(() =>
      env.DB.batch([
        d.prepare(
          env,
          `SELECT b.book_id,b.public_json,o.patch_json,o.version AS metadata_version,COALESCE(m.trashed,0) AS trashed,COALESCE(m.version,0) AS version,m.updated_at FROM catalog_books b LEFT JOIN book_management m ON m.scope=b.scope AND m.book_id=b.book_id LEFT JOIN metadata_overrides o ON o.scope=b.scope AND o.book_id=b.book_id WHERE b.scope=? ORDER BY b.book_id LIMIT 10001`,
          context.scope,
        ),
        d.prepare(
          env,
          `SELECT file_id,book_id,format,size_bytes,state FROM ${d.registrySource(env)} WHERE scope=? AND state='confirmed'`,
          context.scope,
        ),
      ]),
    );
    if (result[0].results.length > 10000) fail("management_limit", 503);
    const registrationsByBook = new Map();
    for (const file of result[1].results) {
      if (!registrationsByBook.has(file.book_id))
        registrationsByBook.set(file.book_id, []);
      registrationsByBook.get(file.book_id).push(file);
    }
    const books = result[0].results.map((row) => ({
      book: mergePublicBook(
        JSON.parse(row.public_json),
        row.patch_json ? JSON.parse(row.patch_json) : {},
        registrationsByBook.get(row.book_id) ?? [],
      ),
      metadataVersion: row.metadata_version ?? 0,
      trashed: Boolean(row.trashed),
      managementVersion: row.version,
      deletedAt: row.trashed ? row.updated_at : null,
    }));
    if (
      env.NORMAL_UPLOAD_MODE === "authority-v1" ||
      isolatedUploadConfiguration(env)
    ) {
      const uploads = await d.query(() =>
        d
          .prepare(
            env,
            `SELECT u.book_id,u.upload_id,r.state,r.put_attempted FROM browser_uploads u JOIN shelf_storage_reservations r ON r.reservation_id=u.reservation_id WHERE u.scope=?${isolatedUploadConfiguration(env) ? " AND u.target_id='isolated-project-20261024'" : ""}`,
            context.scope,
          )
          .all(),
      );
      const uploadsByBook = new Map(uploads.results.map((u) => [u.book_id, u]));
      for (const item of books) {
        const pending = uploadsByBook.get(item.book.id);
        if (pending) item.upload = { ...stateInfo(pending), canSubmit: false };
      }
    }
    const upload = await uploadCapability(env, context, d);
    const identify = await identifyCapability(env, d);
    await assertCurrent(env, context, session, d);
    return d.response(200, { books, upload, identify });
  }
  if (path === "/api/manage/uploads" && request.method === "POST")
    return intent(request, env, context, session, d);
  let match = path.match(/^\/api\/manage\/uploads\/([\w-]{1,100})\/bytes$/);
  if (match && request.method === "POST")
    return bytes(request, env, context, session, match[1], d);
  match = path.match(/^\/api\/manage\/books\/([\w-]{1,128})\/(trash|restore)$/);
  if (match && request.method === "POST")
    return lifecycle(
      request,
      env,
      context,
      session,
      match[1],
      match[2] === "trash" ? 1 : 0,
      d,
    );
  fail("not_found", 404);
}

export async function managedFileAccess(
  request,
  env,
  context,
  session,
  id,
  content,
  d,
) {
  const isolated = isolatedUploadConfiguration(env);
  if (
    !isolated &&
    (env.NORMAL_UPLOAD_MODE !== "authority-v1" ||
      env.SINGLE_TRIAL_MODE !== undefined ||
      env.R2_BUCKET !== "the-shelf-books")
  )
    fail("files_unconfigured", 503);
  const policy = isolated ? await loadIsolatedPolicy(env, d, isolated) : null;
  const row = isolated
    ? await d.query(() =>
        d
          .prepare(
            env,
            `${ISOLATED_CONFIRMED_SQL} AND f.scope=? AND f.file_id=? AND u.account_id=? AND u.bucket=? AND u.consent_sha256=? AND u.trial_target_sha256=?`,
            context.scope,
            id,
            isolated.accountId,
            isolated.bucket,
            isolated.consent,
            isolated.trialTarget,
          )
          .first(),
      )
    : await d.query(() =>
        d
          .prepare(
            env,
            `SELECT f.*,m.version AS management_version,u.descriptor_json FROM file_registry f JOIN browser_uploads u ON u.scope=f.scope AND u.file_id=f.file_id JOIN book_management m ON m.scope=f.scope AND m.book_id=f.book_id JOIN shelf_storage_authority a ON a.id=1 WHERE f.scope=? AND f.file_id=? AND f.state='confirmed' AND m.trashed=0 AND json_extract(a.identity_json,'$.accountId')=? AND json_extract(a.identity_json,'$.bucket')=?`,
            context.scope,
            id,
            env.R2_ACCOUNT_ID,
            env.R2_BUCKET,
          )
          .first(),
      );
  if (!row || (isolated && row.target_tuple !== isolatedPolicyTuple(policy)))
    fail("file_unavailable", 409);
  if (isolated) assertIsolatedConfiguration(env, isolated, session);
  let range = null;
  const expected = normalizedEtag(row.etag);
  if (!expected) fail("file_unavailable", 409);
  if (
    request.headers.has("if-match") &&
    normalizedEtag(request.headers.get("if-match")) !== expected
  )
    fail("precondition_failed", 412);
  if (content && request.headers.has("range")) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range"));
    if (!m) fail("range_not_satisfiable", 416);
    const start = Number(m[1]),
      end = m[2] ? Number(m[2]) : row.size_bytes - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= row.size_bytes ||
      end < start ||
      end >= row.size_bytes
    )
      fail("range_not_satisfiable", 416);
    range = { offset: start, length: end - start + 1 };
  }
  let object;
  try {
    object = await deadline(
      content && request.method !== "HEAD"
        ? env.BOOKS.get(row.object_key, {
            onlyIf: { etagMatches: expected },
            ...(range ? { range } : {}),
          })
        : env.BOOKS.head(row.object_key),
    );
  } catch {
    fail("service_unavailable", 503);
  }
  const discard = () => {
    try {
      void Promise.resolve(object?.body?.cancel()).catch(() => {});
    } catch {}
  };
  if (
    !objectHeadMatches(row, object) ||
    (content &&
      request.method !== "HEAD" &&
      (!object.body ||
        (range &&
          (object.range?.offset !== range.offset ||
            object.range?.length !== range.length))))
  ) {
    discard();
    fail("file_changed", 409);
  }
  if (isolated) {
    try {
      assertIsolatedConfiguration(env, isolated, session);
      await loadIsolatedPolicy(env, d, isolated);
      assertIsolatedConfiguration(env, isolated, session);
    } catch (error) {
      discard();
      throw error;
    }
  }
  const now = Date.now();
  let result;
  try {
    result = await d.query(() =>
      env.DB.batch([
        d.prepare(
          env,
          `INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id) SELECT ?,?,'access',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM file_registry f JOIN book_management m ON m.scope=f.scope AND m.book_id=f.book_id JOIN catalog_books b ON b.scope=f.scope AND b.book_id=f.book_id JOIN json_each(b.public_json,'$.files') j WHERE f.scope=? AND f.file_id=? AND f.state='confirmed' AND f.version=? AND f.object_key=? AND f.sha256=? AND f.etag=? AND f.size_bytes=? AND f.format=? AND m.trashed=0 AND m.version=? AND json_extract(j.value,'$.id')=f.file_id AND json_extract(j.value,'$.format')=f.format AND json_extract(j.value,'$.sizeBytes')=f.size_bytes AND json_extract(j.value,'$.status')='candidate'${isolated ? ` AND EXISTS(SELECT 1 FROM (${ISOLATED_CONFIRMED_SQL}) mapped WHERE mapped.file_id=? AND mapped.descriptor_json=? AND mapped.target_tuple=?)` : ""}) RETURNING request_id`,
          context.scope,
          randomKey(),
          context.ip,
          now,
          session.session_hash,
          session.generation,
          id,
          context.scope,
          id,
          row.version,
          row.object_key,
          row.sha256,
          row.etag,
          row.size_bytes,
          row.format,
          row.management_version,
          ...(isolated ? [id, row.descriptor_json, row.target_tuple] : []),
        ),
        d.prepare(
          env,
          `SELECT s.session_hash FROM sessions s JOIN auth_config a ON a.scope=s.scope WHERE s.scope=? AND s.session_hash=? AND s.generation=? AND s.revoked=0 AND s.expires_at>? AND a.generation=s.generation AND a.enabled=1 AND a.origin=?`,
          context.scope,
          session.session_hash,
          session.generation,
          now,
          context.origin,
        ),
      ]),
    );
  } catch (e) {
    discard();
    throw e;
  }
  if (isolated) {
    try {
      assertIsolatedConfiguration(env, isolated, session);
    } catch (error) {
      discard();
      throw error;
    }
  }
  if (!result[1].results?.length) {
    discard();
    fail("authentication_required", 401);
  }
  if (!result[0].results?.length) {
    discard();
    fail("file_changed", 409);
  }
  if (!content)
    return d.response(200, {
      url: `/api/files/${encodeURIComponent(id)}/content`,
      format: row.format,
      expiresAt: null,
      mode: "local",
    });
  const headers = {
    "Content-Type": mime(row.format),
    "Content-Length": String(range ? range.length : row.size_bytes),
    ETag: `"${expected}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (range)
    headers["Content-Range"] =
      `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size_bytes}`;
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: range ? 206 : 200,
    headers,
  });
}
