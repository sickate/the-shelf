// Explicit first-book capability. This module has no environment discovery or retries.
import { LibraryError, isCanonicalKey } from "./security.mjs";
import { normalizedEtag, objectHeadMatches, THRESHOLD } from "./core.mjs";

export const SINGLE_TRIAL_MODE = "first-book-20261023";
export const SINGLE_TRIAL_BUCKET = "the-shelf-first-book-20261023";
const hash = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9_-]{1,100}$/;
const fail = (code = "file_unavailable", status = 409) => {
  throw new LibraryError(code, status);
};
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const hex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export async function trialSha256(bytes) {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
export function trialMode(env) {
  if (env.SINGLE_TRIAL_MODE === undefined) return false;
  if (
    env.SINGLE_TRIAL_MODE !== SINGLE_TRIAL_MODE ||
    env.APP_SCOPE !== "production" ||
    env.R2_BUCKET !== SINGLE_TRIAL_BUCKET ||
    !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID || "") ||
    !hash.test(env.SINGLE_TRIAL_TARGET_SHA256 || "") ||
    !env.BOOKS ||
    ["put", "head", "get"].some(
      (method) => typeof env.BOOKS[method] !== "function",
    ) ||
    env.R2_ACCESS_KEY_ID !== undefined ||
    env.R2_SECRET_ACCESS_KEY !== undefined
  )
    fail("files_unconfigured", 503);
  return true;
}
export const trialMime = (d) =>
  d.format === "PDF" ? "application/pdf" : "application/epub+zip";
export function decodeTrialRow(row, env, { confirmed = true } = {}) {
  try {
    if (
      !trialMode(env) ||
      !row ||
      row.id !== 1 ||
      row.consent_id !== "2026-10-23-first-book" ||
      !id.test(row.permit_id || "") ||
      ![row.issued_at, row.expires_at, row.updated_at].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      row.updated_at < row.issued_at ||
      row.expires_at <= row.issued_at ||
      row.expires_at > row.issued_at + 86400000 ||
      row.isolated_target_config_sha256 !== env.SINGLE_TRIAL_TARGET_SHA256
    )
      fail();
    const target = JSON.parse(row.target_json),
      d = JSON.parse(row.descriptor_json),
      authority = JSON.parse(row.authority_identity_json);
    if (
      !exact(target, ["accountId", "bucket"]) ||
      target.accountId !== env.R2_ACCOUNT_ID ||
      target.bucket !== SINGLE_TRIAL_BUCKET ||
      !exact(authority, [
        "schemaVersion",
        "authorityId",
        "accountId",
        "bucket",
        "legacyDatabases",
      ]) ||
      authority.schemaVersion !== 1 ||
      authority.authorityId !== "shelf-remote-storage-v1" ||
      !exact(authority.legacyDatabases, ["check", "production"]) ||
      !Object.values(authority.legacyDatabases).every(
        (v) =>
          typeof v === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            v,
          ),
      ) ||
      authority.legacyDatabases.check ===
        authority.legacyDatabases.production ||
      authority.accountId !== target.accountId ||
      authority.bucket !== "the-shelf-books" ||
      !exact(d, [
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
      ]) ||
      d.kind !== "original" ||
      d.scope !== "production" ||
      !id.test(d.fileId || "") ||
      !id.test(d.bookId || "") ||
      !["PDF", "EPUB"].includes(d.format) ||
      !Number.isSafeInteger(d.sizeBytes) ||
      d.sizeBytes < 1 ||
      d.sizeBytes > THRESHOLD ||
      d.sizeBytes !== row.size_bytes ||
      !hash.test(d.sha256 || "") ||
      d.versionHash !== null ||
      d.source !== null ||
      d.objectKey !==
        `books/cf03/${d.fileId}/${d.sha256}.${d.format.toLowerCase()}` ||
      !["reserved", "uploading", "uncertain", "confirmed"].includes(row.state)
    )
      fail();
    if (
      (row.state === "reserved" &&
        (row.put_attempted !== 0 ||
          row.content_verified !== 0 ||
          row.etag !== null)) ||
      (["uploading", "uncertain"].includes(row.state) &&
        (row.put_attempted !== 1 ||
          row.content_verified !== 0 ||
          row.etag !== null))
    )
      fail();
    if (
      confirmed &&
      (row.state !== "confirmed" ||
        row.content_verified !== 1 ||
        row.put_attempted !== 1 ||
        !normalizedEtag(row.etag))
    )
      fail();
    return {
      row,
      descriptor: d,
      file: {
        file_id: d.fileId,
        book_id: d.bookId,
        object_key: d.objectKey,
        format: d.format,
        size_bytes: d.sizeBytes,
        sha256: d.sha256,
        etag: row.etag,
        state: row.state,
      },
    };
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    fail();
  }
}
export async function loadTrial(env, options) {
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT * FROM shelf_storage_single_trial WHERE id=1",
    ).first();
  } catch {
    fail("service_unavailable", 503);
  }
  return decodeTrialRow(row, env, options);
}
export async function trialOperatorAuthorized(request, env) {
  const expected = env.SINGLE_TRIAL_UPLOAD_SECRET,
    supplied = request.headers.get("x-shelf-trial-secret");
  if (!isCanonicalKey(expected) || !isCanonicalKey(supplied))
    fail("authentication_required", 401);
  // WebCrypto verification compares a fixed-length MAC without a JS string equality.
  const key = async (value) =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(value),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  const message = new TextEncoder().encode("the-shelf:first-book:operator:v1");
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(supplied),
    message,
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await key(expected),
      signature,
      message,
    ))
  )
    fail("authentication_required", 401);
  const config = {
    accountId: env.R2_ACCOUNT_ID,
    bucket: SINGLE_TRIAL_BUCKET,
    mode: SINGLE_TRIAL_MODE,
    origin: env.SITE_ORIGIN,
    schemaVersion: 1,
    uploadSecretSha256: await trialSha256(new TextEncoder().encode(expected)),
    worker: "the-shelf",
  };
  if (
    (await trialSha256(new TextEncoder().encode(JSON.stringify(config)))) !==
    env.SINGLE_TRIAL_TARGET_SHA256
  )
    fail("files_unconfigured", 503);
}
async function boundedBytes(request, size) {
  if (
    request.headers.get("content-length") !== String(size) ||
    request.headers.get("content-type") !== "application/octet-stream" ||
    !request.body
  )
    fail("invalid_upload", 400);
  const reader = request.body.getReader(),
    chunks = [];
  let length = 0,
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
      cancel();
      reject(new LibraryError("invalid_upload", 408));
    }, 30000);
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
        (length += next.value.length) > size
      )
        fail("invalid_upload", 400);
      chunks.push(next.value);
    }
    if (length !== size) fail("invalid_upload", 400);
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
function objectHeaders(file) {
  return {
    "Content-Type": trialMime({ format: file.format }),
    "Content-Length": String(file.size_bytes),
    ETag: `"${normalizedEtag(file.etag)}"`,
    "x-amz-meta-sha256": file.sha256,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
export async function trialOperatorRoute(request, env) {
  trialMode(env);
  await trialOperatorAuthorized(request, env);
  const t = await loadTrial(env, { confirmed: false });
  if (request.headers.get("x-shelf-trial-permit") !== t.row.permit_id)
    fail("file_unavailable", 409);
  const path = new URL(request.url).pathname;
  if (path === "/api/single-trial/upload") {
    if (request.method !== "POST") fail("method_not_allowed", 405);
    if (
      t.row.state !== "reserved" ||
      t.row.put_attempted !== 0 ||
      t.row.expires_at <= Date.now()
    )
      fail("single_trial_already_attempted", 409);
    const bytes = await boundedBytes(request, t.descriptor.sizeBytes);
    if ((await trialSha256(bytes)) !== t.descriptor.sha256)
      fail("invalid_upload", 400);
    let result;
    try {
      result = await env.DB.prepare(
        "UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1,updated_at=? WHERE id=1 AND permit_id=? AND descriptor_json=? AND isolated_target_config_sha256=? AND state='reserved' AND put_attempted=0 AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) RETURNING id",
      )
        .bind(
          Date.now(),
          t.row.permit_id,
          t.row.descriptor_json,
          env.SINGLE_TRIAL_TARGET_SHA256,
        )
        .all();
    } catch {
      fail("single_trial_outcome_unknown", 503);
    }
    if (result.results?.length !== 1 || result.results[0].id !== 1)
      fail("single_trial_already_attempted", 409);
    // This is the only object mutation. CAS response loss, PUT loss and failures
    // retain the consumed claim; no catch path retries, deletes, or changes key.
    let stored;
    try {
      stored = await env.BOOKS.put(t.descriptor.objectKey, bytes, {
        sha256: t.descriptor.sha256,
        httpMetadata: { contentType: trialMime(t.descriptor) },
        customMetadata: { sha256: t.descriptor.sha256 },
      });
    } catch {
      fail("single_trial_outcome_unknown", 503);
    }
    if (!normalizedEtag(stored?.etag))
      fail("single_trial_outcome_unknown", 503);
    return new Response(
      JSON.stringify({
        state: "uploaded",
        permitId: t.row.permit_id,
        etag: `"${normalizedEtag(stored.etag)}"`,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (
    path !== "/api/single-trial/object" ||
    !["HEAD", "GET"].includes(request.method)
  )
    fail("method_not_allowed", 405);
  if (
    !["uploading", "uncertain", "confirmed"].includes(t.row.state) ||
    t.row.put_attempted !== 1
  )
    fail();
  let object;
  try {
    if (request.method === "HEAD")
      object = await env.BOOKS.head(t.descriptor.objectKey);
    else {
      const match = normalizedEtag(request.headers.get("if-match"));
      if (!match) fail("precondition_failed", 412);
      object = await env.BOOKS.get(t.descriptor.objectKey, {
        onlyIf: { etagMatches: match },
      });
    }
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    fail("service_unavailable", 503);
  }
  if (!object)
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  const etag = normalizedEtag(object.etag ?? object.httpEtag);
  const file = { ...t.file, etag };
  if (
    !etag ||
    !objectHeadMatches(file, object) ||
    (request.method === "GET" &&
      (!object.body ||
        normalizedEtag(request.headers.get("if-match")) !== etag))
  ) {
    try {
      void Promise.resolve(object?.body?.cancel()).catch(() => {});
    } catch {}
    fail("file_changed", 409);
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: objectHeaders(file),
  });
}
export { objectHeaders as trialObjectHeaders };
