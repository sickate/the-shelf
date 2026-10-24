/** Private prepared-text consumer; enabled only by its independent capability.
 * PREPARED_BOOKS is used only through head/get; a binding itself is not read-only.
 */
import { LibraryError, verifyCsrf, readJson } from "./security.mjs";
import { normalizedEtag } from "./core.mjs";
import { validatePreparedText } from "../../shared/prepared-text.mjs";
import { rankTextChunks } from "../../shared/text-retrieval.mjs";
import {
  hasPreparedV2Configuration,
  capturePreparedSource,
} from "./prepared-source.mjs";
import {
  PREPARED_INDEX_LIMITS as LIMITS,
  buildPreparedIndex,
  preparedChunkRow,
  preparedDigest,
  publicPreparedSource,
} from "../../shared/prepared-index.mjs";
const encoder = new TextEncoder();
const FILE = /^file_[a-f0-9]{16}$/;
const BOOK = /^book_[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code = "prepared_unavailable", status = 409) => {
  throw new LibraryError(code, status);
};
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
// D1 returns named columns; response object enumeration order is not a contract.
// Both row shapes contain only SQL primitives, so preserve strict field sets and
// primitive types while comparing values independently of property order.
const sameRow = (actual, expected) =>
  exact(actual, Object.keys(expected)) &&
  Object.keys(expected).every((key) => actual[key] === expected[key]);
function configured(env, context) {
  if (
    context.scope !== "production" ||
    env.PREPARED_TEXT_MODE !== "registry-v1" ||
    !env.DB ||
    typeof env.PREPARED_BOOKS?.head !== "function" ||
    typeof env.PREPARED_BOOKS?.get !== "function" ||
    !/^[a-f0-9]{32}$/.test(env.PREPARED_R2_ACCOUNT_ID || "") ||
    env.PREPARED_R2_BUCKET !== "the-shelf-books"
  )
    fail("prepared_unconfigured", 503);
}
function selection(input) {
  if (
    !exact(input, ["fileId", "versionHash"]) ||
    !FILE.test(input?.fileId || "") ||
    !HASH.test(input?.versionHash || "")
  )
    fail("invalid_prepared_selection", 400);
  return { fileId: input.fileId, versionHash: input.versionHash };
}
function parseDescriptor(row, env) {
  let descriptor, identity;
  try {
    descriptor = JSON.parse(row.descriptor_json);
    identity = JSON.parse(row.identity_json);
  } catch {
    fail();
  }
  const pin = descriptor?.source;
  if (
    !Number.isSafeInteger(row.chunk_count) ||
    row.chunk_count < 1 ||
    row.chunk_count > LIMITS.chunks ||
    !Number.isSafeInteger(row.text_bytes) ||
    row.text_bytes < 1 ||
    row.text_bytes > LIMITS.packageBytes ||
    !Number.isSafeInteger(row.codepoint_count) ||
    row.codepoint_count < 1 ||
    row.codepoint_count > LIMITS.packageBytes ||
    !HASH.test(row.index_sha256 || "") ||
    identity?.schemaVersion !== 1 ||
    identity.authorityId !== "shelf-remote-storage-v1" ||
    identity.accountId !== env.PREPARED_R2_ACCOUNT_ID ||
    identity.bucket !== env.PREPARED_R2_BUCKET ||
    !exact(descriptor, [
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
    descriptor.kind !== "prepared-text" ||
    descriptor.scope !== row.scope ||
    descriptor.fileId !== row.file_id ||
    descriptor.bookId !== row.book_id ||
    descriptor.versionHash !== row.version_hash ||
    descriptor.format !== "JSON" ||
    descriptor.sha256 !== row.package_sha256 ||
    !HASH.test(descriptor.sha256 || "") ||
    !Number.isSafeInteger(descriptor.sizeBytes) ||
    descriptor.sizeBytes < 1 ||
    descriptor.sizeBytes > LIMITS.packageBytes ||
    !exact(pin, [
      "fileId",
      "bookId",
      "format",
      "sizeBytes",
      "mtimeNs",
      "versionHash",
      "sourceSha256",
    ]) ||
    pin.fileId !== row.file_id ||
    pin.bookId !== row.book_id ||
    pin.versionHash !== row.version_hash ||
    pin.sourceSha256 !== row.source_sha256 ||
    !HASH.test(pin.sourceSha256 || "") ||
    pin.format !== row.format ||
    !Number.isSafeInteger(pin.sizeBytes) ||
    pin.sizeBytes < 1 ||
    pin.sizeBytes > LIMITS.packageBytes ||
    typeof pin.mtimeNs !== "string" ||
    !/^\d+$/.test(pin.mtimeNs) ||
    descriptor.objectKey !==
      `prepared-text/v1/${row.scope}/${row.file_id}/${row.version_hash}/${descriptor.sha256}.json` ||
    normalizedEtag(row.etag) === null
  )
    fail();
  return { descriptor, pin };
}
async function sourceRow(env, context, session, bookId, selected) {
  // Session, lifecycle and all source projections are read by a single primary statement.
  const db = env.DB.withSession ? env.DB.withSession("first-primary") : env.DB;
  try {
    return await db
      .prepare(
        `SELECT i.*,(SELECT count(*) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash) AS actual_chunk_count FROM shelf_prepared_readable_sources i
      JOIN sessions s ON s.scope=i.scope JOIN auth_config a ON a.scope=s.scope
      WHERE i.scope=? AND i.book_id=? AND i.file_id=? AND i.version_hash=?
      AND s.session_hash=? AND s.generation=? AND s.revoked=0 AND s.expires_at>?
      AND a.enabled=1 AND a.generation=s.generation AND a.origin=?`,
      )
      .bind(
        context.scope,
        bookId,
        selected.fileId,
        selected.versionHash,
        session.session_hash,
        session.generation,
        Date.now(),
        context.origin,
      )
      .first();
  } catch {
    fail("prepared_service_unavailable", 503);
  }
}
const cancel = (body) => {
  try {
    void Promise.resolve(body?.cancel()).catch(() => {});
  } catch {}
};
async function objectBytes(
  store,
  descriptor,
  etag,
  timeoutMs,
  assert = () => {},
) {
  let expired = false,
    reader,
    object,
    timer;
  const check = () => {
    assert();
    if (expired) fail("prepared_read_unknown", 503);
  };
  const stop = () => {
    expired = true;
    if (reader) cancel(reader);
    else cancel(object?.body);
  };
  const headMatches = (head) =>
    head &&
    head.size === descriptor.sizeBytes &&
    normalizedEtag(head.etag) === normalizedEtag(etag);
  const operation = (async () => {
    const before = await store.head(descriptor.objectKey);
    check();
    if (!headMatches(before)) fail("prepared_object_changed");
    object = await store.get(descriptor.objectKey, {
      onlyIf: { etagMatches: normalizedEtag(etag) },
    });
    if (expired) {
      cancel(object?.body);
      check();
    }
    if (!headMatches(object) || !object.body || object.body.locked) {
      cancel(object?.body);
      fail("prepared_object_changed");
    }
    reader = object.body.getReader();
    const parts = [];
    let length = 0,
      blocks = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        check();
        if (done) break;
        if (!(value instanceof Uint8Array) || ++blocks > LIMITS.streamBlocks)
          fail("prepared_read_limit");
        length += value.byteLength;
        if (length > descriptor.sizeBytes || length > LIMITS.packageBytes)
          fail("prepared_read_limit");
        parts.push(Uint8Array.from(value));
      }
    } finally {
      cancel(reader);
      try {
        reader.releaseLock();
      } catch {}
    }
    if (length !== descriptor.sizeBytes) fail("prepared_object_changed");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const digest = await preparedDigest(bytes);
    check();
    if (digest !== descriptor.sha256) fail("prepared_object_changed");
    check();
    const after = await store.head(descriptor.objectKey);
    check();
    if (!headMatches(after)) fail("prepared_object_changed");
    return bytes;
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stop();
      reject(new LibraryError("prepared_read_unknown", 503));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    stop();
    throw error instanceof LibraryError
      ? error
      : new LibraryError("prepared_read_unknown", 503);
  } finally {
    clearTimeout(timer);
  }
}
const CHUNK_COLUMNS =
  "chunk_index,locator_type,section_number,start_offset,end_offset,chunk_sha256,codepoints,utf8_bytes";
async function checkIndex(env, row, value, source) {
  const projection = await buildPreparedIndex(value);
  source?.assert();
  if (
    projection.indexSha256 !== row.index_sha256 ||
    projection.chunkCount !== row.chunk_count ||
    projection.textBytes !== row.text_bytes ||
    projection.codepointCount !== row.codepoint_count
  )
    fail("prepared_index_mismatch");
  let count = 0;
  for (let start = 0; start < row.chunk_count; start += LIMITS.pageRows) {
    let result;
    try {
      const sql = `SELECT ${CHUNK_COLUMNS} FROM shelf_prepared_index_chunks WHERE scope=? AND file_id=? AND version_hash=? AND chunk_index>=? ORDER BY chunk_index LIMIT 1000`,
        parameters = [row.scope, row.file_id, row.version_hash, start];
      result = source
        ? await source.all(sql, parameters)
        : await env.DB.prepare(sql)
            .bind(...parameters)
            .all();
    } catch {
      source?.assert();
      fail("prepared_service_unavailable", 503);
    }
    source?.assert();
    const rows = result.results;
    if (
      !Array.isArray(rows) ||
      rows.length !== Math.min(LIMITS.pageRows, row.chunk_count - start) ||
      encoder.encode(JSON.stringify(rows)).byteLength > LIMITS.pageBytes
    )
      fail("prepared_index_mismatch");
    for (let index = 0; index < rows.length; index++) {
      if (
        !sameRow(
          rows[index],
          preparedChunkRow(projection.chunks[start + index]),
        )
      )
        fail("prepared_index_mismatch");
      count++;
    }
  }
  if (count !== projection.chunkCount) fail("prepared_index_mismatch");
}
/** Internal full-text result; callers must never serialize it to public APIs or logs.
 * options.deadlineMs exists solely for bounded offline verification; it cannot increase 30s.
 */
export async function loadPreparedForJob(
  env,
  grant,
  exactSource,
  options = {},
) {
  const { context, session, bookId } = grant;
  configured(env, context);
  if (!session || !BOOK.test(bookId || ""))
    fail("authentication_required", 401);
  const selected = selection(exactSource);
  const source = hasPreparedV2Configuration(env)
    ? capturePreparedSource(env, context, session, bookId, selected)
    : null;
  const initial = source ? await source.read() : null;
  const row = source
    ? initial.row
    : await sourceRow(env, context, session, bookId, selected);
  if (!row) fail();
  if (row.actual_chunk_count !== row.chunk_count)
    fail("prepared_index_mismatch");
  const { descriptor, pin } = parseDescriptor(row, env);
  if (
    source &&
    (pin.fileId !== initial.source.descriptor.fileId ||
      pin.bookId !== initial.source.descriptor.bookId ||
      pin.format !== initial.source.descriptor.format ||
      pin.sizeBytes !== initial.source.descriptor.sizeBytes ||
      pin.sourceSha256 !== initial.source.descriptor.sha256)
  )
    fail();
  const timeoutMs = options.deadlineMs ?? LIMITS.timeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > LIMITS.timeoutMs
  )
    fail("invalid_prepared_limit", 400);
  if (!source && options.admitAccess !== undefined) {
    if (typeof options.admitAccess !== "function")
      fail("prepared_unconfigured", 503);
    await options.admitAccess(row.file_id);
  }
  const bytes = await objectBytes(
    source ? source.store : env.PREPARED_BOOKS,
    descriptor,
    row.etag,
    timeoutMs,
    source?.assert,
  );
  let value;
  try {
    value = await validatePreparedText(bytes, pin);
  } catch {
    source?.assert();
    fail("prepared_package_invalid");
  }
  source?.assert();
  await checkIndex(env, row, value, source);
  source?.assert();
  if (source) {
    await source.admit(initial);
    source.assert();
    const current = await source.read();
    source.assert();
    if (
      current.snapshotJson !== initial.snapshotJson ||
      current.preparedJson !== initial.preparedJson
    )
      fail("prepared_access_changed", 401);
  } else {
    const current = await sourceRow(env, context, session, bookId, selected);
    // No private bytes escape after any asynchronous work unless the entire grant is unchanged.
    if (!current || !sameRow(current, row))
      fail("prepared_access_changed", 401);
  }
  return {
    pin: { ...pin },
    value,
    chunks: value.chunks.map((chunk) => ({
      text: chunk.text,
      ...publicPreparedSource(chunk, pin),
    })),
  };
}
function privateResponse(value) {
  const body = JSON.stringify(value);
  if (encoder.encode(body).byteLength > LIMITS.responseBytes)
    fail("prepared_response_limit");
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export async function preparedRoute(
  request,
  env,
  context,
  session,
  dependencies,
) {
  const url = new URL(request.url),
    match = /^\/api\/books\/(book_[a-f0-9]{16})\/prepared(?:\/(search))?$/.exec(
      url.pathname,
    );
  if (!match) return null;
  if (!session) fail("authentication_required", 401);
  const origin = request.headers.get("origin");
  if (
    url.origin !== context.origin ||
    (origin && origin !== context.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    fail("origin_forbidden", 403);
  const search = match[2] === "search";
  if (request.method !== (search ? "POST" : "GET"))
    fail("method_not_allowed", 405);
  let input,
    cursor = 0;
  if (search) {
    if (url.search) fail("invalid_prepared_selection", 400);
    if (origin !== context.origin) fail("origin_forbidden", 403);
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("content-type") || "",
      )
    )
      fail("invalid_content_type", 403);
    if (
      !(await verifyCsrf(
        request.headers.get("x-csrf-token"),
        session.token,
        env.SESSION_SECRET,
        context,
      ))
    )
      fail("csrf_invalid", 403);
    input = await readJson(request);
    if (
      !exact(input, ["fileId", "versionHash", "question"]) ||
      typeof input.question !== "string" ||
      !input.question.trim() ||
      !input.question.isWellFormed() ||
      [...input.question].length > 4000 ||
      encoder.encode(input.question).byteLength > 16000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.question)
    )
      fail("invalid_question", 400);
  } else {
    if (
      [...url.searchParams.keys()].some(
        (key) => !["fileId", "versionHash", "cursor"].includes(key),
      ) ||
      [...new Set(url.searchParams.keys())].some(
        (key) => url.searchParams.getAll(key).length !== 1,
      )
    )
      fail("invalid_prepared_selection", 400);
    input = {
      fileId: url.searchParams.get("fileId"),
      versionHash: url.searchParams.get("versionHash"),
    };
    const raw = url.searchParams.get("cursor") || "0";
    if (!/^(0|[1-9]\d{0,4})$/.test(raw))
      fail("invalid_prepared_selection", 400);
    cursor = Number(raw);
  }
  if (
    !hasPreparedV2Configuration(env) &&
    typeof dependencies?.admitAccess !== "function"
  )
    fail("prepared_unconfigured", 503);
  const loaded = await loadPreparedForJob(
    env,
    { context, session, bookId: match[1] },
    { fileId: input.fileId, versionHash: input.versionHash },
    { admitAccess: dependencies?.admitAccess },
  );
  const base = {
    fileId: loaded.pin.fileId,
    versionHash: loaded.pin.versionHash,
    format: loaded.pin.format,
    chunkCount: loaded.value.chunks.length,
  };
  if (search) {
    const chosen = rankTextChunks(loaded.chunks, input.question);
    return privateResponse({
      ...base,
      matches: chosen.map((chunk) => ({
        ...publicPreparedSource(
          loaded.value.chunks[chunk.chunkIndex],
          loaded.pin,
        ),
        excerpt: [...chunk.text].slice(0, 1000).join(""),
      })),
    });
  }
  const chapters = [],
    seen = new Set();
  for (const chunk of loaded.value.chunks) {
    const number =
      chunk.locator.type === "pdf-page"
        ? chunk.locator.page
        : chunk.locator.spineIndex;
    if (!seen.has(number)) {
      seen.add(number);
      chapters.push({
        chapter: chapters.length + 1,
        ...publicPreparedSource(chunk, loaded.pin),
      });
    }
  }
  if (cursor > chapters.length) fail("invalid_prepared_selection", 400);
  return privateResponse({
    ...base,
    chapterCount: chapters.length,
    chapters: chapters.slice(cursor, cursor + 32),
    nextCursor: cursor + 32 < chapters.length ? cursor + 32 : null,
  });
}
