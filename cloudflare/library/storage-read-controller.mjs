/** Closed v2 owner reads. Source selection and all storage facts belong to grants. */
import { LibraryError, randomKey } from "./security.mjs";
import { normalizedEtag, objectHeadMatches } from "./core.mjs";
import {
  resolveConfirmedSource,
  readSourceAdapter,
  assertUnchangedSourceGrant,
  confirmedSourceGuard,
  STORAGE_SOURCE_GUARD_SQL,
} from "./storage-sources.mjs";

export const STORAGE_READ_LIMITS = Object.freeze({
  sqlBytes: 16_384,
  admissionParameters: 9,
  databaseStatements: 4,
  r2Operations: 1,
  responseBytes: 1_048_576,
  timeoutMs: 30_000,
});
// Numbered parameters reuse the guard's scope/file/session/generation/time.
// The guard is fixed source SQL, never supplied by a request or an environment.
export const STORAGE_READ_ADMISSION_SQL = `WITH source_guard AS (${STORAGE_SOURCE_GUARD_SQL})
INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id)
SELECT ?1,?8,'access',?9,?5,?3,?4,?2
WHERE EXISTS(SELECT unchanged FROM source_guard) RETURNING request_id`;
if (
  new TextEncoder().encode(STORAGE_READ_ADMISSION_SQL).byteLength >
  STORAGE_READ_LIMITS.sqlBytes
)
  throw Error("storage_read_sql_budget");
const fail = (code, status) => {
  throw new LibraryError(code, status);
};
function admissionFailure(error) {
  if (error instanceof LibraryError) throw error;
  const message = typeof error?.message === "string" ? error.message : "";
  if (/library_session_invalid/.test(message))
    fail("authentication_required", 401);
  if (/library_file_unavailable/.test(message)) fail("file_changed", 409);
  if (/count<=max_count|count <= max_count/.test(message))
    fail("rate_limited", 429);
  fail("service_unavailable", 503);
}
const mime = {
  PDF: "application/pdf",
  EPUB: "application/epub+zip",
  MOBI: "application/x-mobipocket-ebook",
  AZW: "application/vnd.amazon.ebook",
  AZW3: "application/vnd.amazon.ebook",
};
const discard = (object) => {
  try {
    void Promise.resolve(object?.body?.cancel()).catch(() => {});
  } catch {}
};
async function deadline(operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new LibraryError("service_unavailable", 503)),
          STORAGE_READ_LIMITS.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function selectedRange(request, size) {
  if (!request.headers.has("range")) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range"));
  if (!match) fail("range_not_satisfiable", 416);
  const start = Number(match[1]),
    end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    end >= size
  )
    fail("range_not_satisfiable", 416);
  return { offset: start, length: end - start + 1 };
}

export async function confirmedFileAccess(
  request,
  env,
  context,
  session,
  fileId,
  content,
) {
  if (!["GET", "HEAD"].includes(request.method))
    fail("method_not_allowed", 405);
  if (!session) fail("authentication_required", 401);
  // Pin the primary capability too; a changed env.DB cannot receive admission.
  const database = env.DB,
    withSession = database?.withSession;
  const grant = await resolveConfirmedSource(env, {
    context,
    session,
    fileId,
  });
  const file = grant.file,
    range = content ? selectedRange(request, file.size_bytes) : null,
    ifMatch = request.headers.get("if-match");
  if (content && ifMatch !== null && normalizedEtag(ifMatch) !== grant.etag)
    fail("precondition_failed", 412);
  let object,
    transferred = false;
  try {
    const store = readSourceAdapter(env, grant);
    object =
      content && request.method !== "HEAD"
        ? await store.get(range ? { range } : {})
        : await store.head();
    if (
      !objectHeadMatches(file, object) ||
      (content &&
        request.method !== "HEAD" &&
        (!object.body ||
          object.body.locked ||
          (range &&
            (object.range?.offset !== range.offset ||
              object.range?.length !== range.length))))
    )
      fail("file_changed", 409);
    await assertUnchangedSourceGrant(env, grant, {
      context,
      session,
      nowMs: Date.now(),
    });
    const guard = confirmedSourceGuard(grant, {
      context,
      session,
      nowMs: Date.now(),
    });
    const requestId = randomKey();
    const result = await deadline(() =>
      withSession
        .call(database, "first-primary")
        .prepare(STORAGE_READ_ADMISSION_SQL)
        .bind(...guard.parameters, requestId, context.ip)
        .first(),
    ).catch(admissionFailure);
    // This final primary read also checks env/binding/method identity after the
    // admission await. An admission response cannot authorize a changed grant.
    await assertUnchangedSourceGrant(env, grant, {
      context,
      session,
      nowMs: Date.now(),
    });
    if (
      !result ||
      Object.keys(result).length !== 1 ||
      result.request_id !== requestId ||
      new TextEncoder().encode(JSON.stringify(result)).byteLength >
        STORAGE_READ_LIMITS.responseBytes
    )
      fail("file_changed", 409);
    if (!content) {
      const value = JSON.stringify({
        url: `/api/files/${encodeURIComponent(fileId)}/content`,
        format: file.format,
        expiresAt: null,
        mode: "local",
      });
      return new Response(request.method === "HEAD" ? null : value, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    const headers = {
      "Content-Type": mime[file.format],
      "Content-Length": String(range?.length ?? file.size_bytes),
      ETag: `"${grant.etag}"`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    if (range)
      headers["Content-Range"] =
        `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size_bytes}`;
    const response = new Response(
      request.method === "HEAD" ? null : object.body,
      { status: range ? 206 : 200, headers },
    );
    transferred = request.method !== "HEAD";
    return response;
  } finally {
    if (!transferred) discard(object);
  }
}
