import {
  LibraryError,
  isCanonicalKey,
  randomKey,
  verifyOwnerKey,
  sessionDigest,
  csrfForSession,
  verifyCsrf,
  ipDigest,
  readJson,
} from "./security.mjs";
import {
  THRESHOLD,
  mergePublicBook,
  validateMetadataFields,
  deriveCategoryId,
  presignGet,
  validObjectKey,
  normalizedEtag,
  objectHeadMatches,
} from "./core.mjs";
import {
  trialMode,
  loadTrial,
  trialOperatorRoute,
  trialObjectHeaders,
} from "./single-trial.mjs";

const cookieName = "__Host-shelf_session";
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const response = (status, value, extra = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, ...extra },
  });
function cookie(value, age = 86400) {
  return `${cookieName}=${value}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=${age}`;
}
function configuration(env) {
  if (!["check", "production"].includes(env.APP_SCOPE) || !env.DB)
    throw new LibraryError("service_unavailable", 503);
  const name =
    env.APP_SCOPE === "production" ? "the-shelf" : "the-shelf-cf03-check";
  if (env.SITE_ORIGIN !== `https://${name}.iamzhutuo.workers.dev`)
    throw new LibraryError("service_unavailable", 503);
  if (
    !isCanonicalKey(env.OWNER_KEY_PEPPER) ||
    !isCanonicalKey(env.SESSION_SECRET)
  )
    throw new LibraryError("service_unavailable", 503);
  if (env.OWNER_KEY_PEPPER === env.SESSION_SECRET)
    throw new LibraryError("service_unavailable", 503);
  trialMode(env);
  return { scope: env.APP_SCOPE, origin: env.SITE_ORIGIN };
}
function dbError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (/library_session_invalid/.test(message))
    return new LibraryError("authentication_required", 401);
  if (/library_session_limit/.test(message))
    return new LibraryError("session_limit", 429);
  if (/library_file_unavailable/.test(message))
    return new LibraryError("file_unavailable", 409);
  if (/count<=max_count|count <= max_count/.test(message))
    return new LibraryError("rate_limited", 429);
  return new LibraryError("service_unavailable", 503);
}
async function query(operation) {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof LibraryError ? error : dbError(error);
  }
}
const prepare = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
function admission(env, context, kind, session = null, file = null) {
  return prepare(
    env,
    "INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id) VALUES(?,?,?,?,?,?,?,?)",
    context.scope,
    randomKey(),
    kind,
    context.ip,
    context.now,
    session?.session_hash ?? null,
    session?.generation ?? null,
    file,
  );
}
async function admitApi(env, context, candidate) {
  // The primary D1 transaction owns both admission and the maintenance ordinal.
  // No isolate counter or randomness decides either authorization or cadence.
  const statements = [
    admission(env, context, "api"),
    prepare(
      env,
      "SELECT count FROM counters WHERE scope=? AND kind='api_day' AND bucket='global' AND window_start=?",
      context.scope,
      Math.floor(context.now / 86400000),
    ),
  ];
  if (candidate)
    statements.push(
      prepare(
        env,
        `SELECT s.session_hash,s.generation,s.expires_at FROM sessions s JOIN auth_config a ON a.scope=s.scope
    WHERE s.scope=? AND s.session_hash=? AND s.revoked=0 AND s.expires_at>? AND a.enabled=1 AND a.generation=s.generation AND a.origin=?`,
        context.scope,
        candidate.digest,
        context.now,
        context.origin,
      ),
    );
  const results = await query(() => env.DB.batch(statements));
  const ordinal = results[1].results?.[0]?.count;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 1000)
    throw new LibraryError("service_unavailable", 503);
  // Also run on the first admitted request of each UTC day so sparse traffic
  // still retires old state. Capacity per 32 admissions exceeds new row growth.
  const row = candidate ? results[2].results?.[0] : null;
  const session = row ? { ...row, token: candidate.token } : null;
  if (ordinal !== 1 && ordinal % 32 !== 0) return session;
  // A cleanup failure stops the request with its admission already consumed.
  await query(() =>
    env.DB.batch([
      prepare(
        env,
        "DELETE FROM admissions WHERE rowid IN (SELECT rowid FROM admissions WHERE scope=? AND created_at<? LIMIT 64)",
        context.scope,
        context.now - 172800000,
      ),
      prepare(
        env,
        `DELETE FROM counters WHERE rowid IN (SELECT rowid FROM counters WHERE scope=? AND kind IN ('api_day','login_day','access_day','metadata_day','session_day') AND window_start<? LIMIT 8)`,
        context.scope,
        Math.floor(context.now / 86400000) - 2,
      ),
      prepare(
        env,
        `DELETE FROM counters WHERE rowid IN (SELECT rowid FROM counters WHERE scope=? AND kind IN ('api_minute','api_ip','login_minute','login_ip','access_ip','metadata_ip') AND window_start<? LIMIT 128)`,
        context.scope,
        Math.floor(context.now / 60000) - 120,
      ),
      prepare(
        env,
        "DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE scope=? AND expires_at<? LIMIT 32)",
        context.scope,
        context.now - 86400000,
      ),
    ]),
  );
  return session;
}
async function sessionCandidate(request, env, context) {
  const found = (request.headers.get("cookie") || "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(cookieName + "="));
  if (found.length !== 1) return null;
  const token = found[0].slice(cookieName.length + 1);
  let digest;
  try {
    digest = await sessionDigest(token, env.SESSION_SECRET, context);
  } catch {
    return null;
  }
  return { token, digest };
}
function requireSession(session) {
  if (!session) throw new LibraryError("authentication_required", 401);
}
async function bookInfo(env, scope, bookId) {
  const results = await query(() =>
    env.DB.batch([
      prepare(
        env,
        `SELECT b.public_json,o.patch_json,o.version FROM catalog_books b LEFT JOIN metadata_overrides o ON o.scope=b.scope AND o.book_id=b.book_id WHERE b.scope=? AND b.book_id=?`,
        scope,
        bookId,
      ),
      prepare(
        env,
        `SELECT file_id,book_id,format,size_bytes,state FROM ${registrySource(env)} WHERE scope=? AND book_id=? AND state='confirmed'`,
        scope,
        bookId,
      ),
    ]),
  );
  const row = results[0].results?.[0];
  if (!row) throw new LibraryError("book_not_found", 404);
  try {
    return {
      book: mergePublicBook(
        JSON.parse(row.public_json),
        row.patch_json ? JSON.parse(row.patch_json) : {},
        results[1].results || [],
      ),
      metadataVersion: row.version || 0,
      patch: row.patch_json ? JSON.parse(row.patch_json) : {},
    };
  } catch {
    throw new LibraryError("service_unavailable", 503);
  }
}
function registrySource(env) {
  return trialMode(env)
    ? `(SELECT json_extract(descriptor_json,'$.scope') AS scope,json_extract(descriptor_json,'$.fileId') AS file_id,json_extract(descriptor_json,'$.bookId') AS book_id,json_extract(descriptor_json,'$.format') AS format,size_bytes,state FROM shelf_storage_single_trial WHERE id=1 AND state='confirmed' AND content_verified=1 AND put_attempted=1 AND isolated_target_config_sha256='${env.SINGLE_TRIAL_TARGET_SHA256}' AND json_extract(target_json,'$.accountId')='${env.R2_ACCOUNT_ID}' AND json_extract(target_json,'$.bucket')='${env.R2_BUCKET}')`
    : "file_registry";
}
async function trialFileAccess(request, env, context, session, id, content) {
  const t = await query(() => loadTrial(env));
  const file = t.file;
  if (file.file_id !== id) throw new LibraryError("file_unavailable", 409);
  let object,
    range = null;
  if (content && request.headers.has("range")) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range"));
    if (!match) throw new LibraryError("range_not_satisfiable", 416);
    const start = Number(match[1]),
      end = match[2] ? Number(match[2]) : file.size_bytes - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= file.size_bytes ||
      end < start ||
      end >= file.size_bytes
    )
      throw new LibraryError("range_not_satisfiable", 416);
    range = { offset: start, length: end - start + 1 };
  }
  const expected = normalizedEtag(file.etag),
    ifMatch = request.headers.get("if-match");
  if (content && ifMatch !== null && normalizedEtag(ifMatch) !== expected)
    throw new LibraryError("precondition_failed", 412);
  try {
    object =
      content && request.method !== "HEAD"
        ? await env.BOOKS.get(file.object_key, {
            onlyIf: { etagMatches: expected },
            ...(range ? { range } : {}),
          })
        : await env.BOOKS.head(file.object_key);
  } catch {
    throw new LibraryError("service_unavailable", 503);
  }
  const discard = () => {
    try {
      void Promise.resolve(object?.body?.cancel()).catch(() => {});
    } catch {}
  };
  if (
    !object ||
    !objectHeadMatches(file, object) ||
    (content &&
      request.method !== "HEAD" &&
      (!object.body ||
        (range &&
          (object.range?.offset !== range.offset ||
            object.range?.length !== range.length))))
  ) {
    discard();
    throw new LibraryError("file_changed", 409);
  }
  const now = Date.now();
  // The external R2 await is followed by one primary D1 transaction checking
  // the exact immutable trial, catalog candidate and current session generation.
  let results;
  try {
    results = await query(() =>
      env.DB.batch([
        prepare(
          env,
          `INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id)
      SELECT ?,?,'access',?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM shelf_storage_single_trial t JOIN catalog_books b ON b.scope='production' AND b.book_id=json_extract(t.descriptor_json,'$.bookId') JOIN json_each(b.public_json,'$.files') j
        WHERE t.id=1 AND t.state='confirmed' AND t.content_verified=1 AND t.put_attempted=1
          AND t.permit_id=? AND t.target_json=? AND t.descriptor_json=? AND t.etag=? AND t.isolated_target_config_sha256=? AND t.authority_identity_json=?
          AND json_extract(j.value,'$.id')=? AND json_extract(j.value,'$.format')=? AND json_extract(j.value,'$.sizeBytes')=? AND json_extract(j.value,'$.status')='candidate' AND json_extract(j.value,'$.visibility')='private' AND json_extract(j.value,'$.readable')=1
      ) RETURNING request_id`,
          context.scope,
          randomKey(),
          context.ip,
          now,
          session.session_hash,
          session.generation,
          id,
          t.row.permit_id,
          t.row.target_json,
          t.row.descriptor_json,
          t.row.etag,
          t.row.isolated_target_config_sha256,
          t.row.authority_identity_json,
          id,
          file.format,
          file.size_bytes,
        ),
        prepare(
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
  if (!results[1].results?.length) {
    discard();
    throw new LibraryError("authentication_required", 401);
  }
  if (!results[0].results?.length) {
    discard();
    throw new LibraryError("file_changed", 409);
  }
  if (!content)
    return response(200, {
      url: `/api/files/${encodeURIComponent(id)}/content`,
      format: file.format,
      expiresAt: null,
      mode: "local",
    });
  const out = trialObjectHeaders(file);
  if (range) {
    out["Content-Length"] = String(range.length);
    out["Content-Range"] =
      `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size_bytes}`;
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: range ? 206 : 200,
    headers: out,
  });
}
async function fileAccess(env, context, session, id) {
  const file = await query(() =>
    prepare(
      env,
      `SELECT file_id,book_id,object_key,format,size_bytes,sha256,etag,version FROM file_registry WHERE scope=? AND file_id=? AND state='confirmed'`,
      context.scope,
      id,
    ).first(),
  );
  if (
    !file ||
    !Number.isSafeInteger(file.version) ||
    file.version < 1 ||
    !Number.isSafeInteger(file.size_bytes) ||
    file.size_bytes <= 0 ||
    file.size_bytes > THRESHOLD ||
    !/^[a-f0-9]{64}$/.test(file.sha256 || "") ||
    !normalizedEtag(file.etag) ||
    !validObjectKey(file.object_key, context.scope, file.format)
  )
    throw new LibraryError("file_unavailable", 409);
  if (typeof env.BOOKS?.head !== "function")
    throw new LibraryError("files_unconfigured", 503);
  let head;
  try {
    head = await env.BOOKS.head(file.object_key);
  } catch {
    throw new LibraryError("service_unavailable", 503);
  }
  if (!head) throw new LibraryError("file_unavailable", 409);
  if (!objectHeadMatches(file, head))
    throw new LibraryError("file_changed", 409);

  // R2 HEAD is an external await. Re-check session/generation AND the exact
  // registry/catalog descriptor in one primary D1 transaction after it returns.
  // A concurrent disable, replacement or even a same-descriptor version change
  // cannot authorize the object that was checked before that change.
  const now = Date.now();
  const results = await query(() =>
    env.DB.batch([
      prepare(
        env,
        `INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id)
      SELECT ?,?,'access',?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM file_registry f JOIN catalog_books b ON b.scope=f.scope AND b.book_id=f.book_id
        JOIN json_each(b.public_json,'$.files') j
        WHERE f.scope=? AND f.file_id=? AND f.state='confirmed' AND f.version=?
          AND f.book_id=? AND f.object_key=? AND f.format=? AND f.size_bytes=? AND f.sha256=? AND f.etag IS ?
          AND json_extract(j.value,'$.id')=f.file_id AND json_extract(j.value,'$.format')=f.format
          AND json_extract(j.value,'$.sizeBytes')=f.size_bytes AND json_extract(j.value,'$.status')='candidate'
      ) RETURNING request_id`,
        context.scope,
        randomKey(),
        context.ip,
        now,
        session.session_hash,
        session.generation,
        id,
        context.scope,
        id,
        file.version,
        file.book_id,
        file.object_key,
        file.format,
        file.size_bytes,
        file.sha256,
        file.etag,
      ),
      prepare(
        env,
        `SELECT s.session_hash FROM sessions s JOIN auth_config a ON a.scope=s.scope
      WHERE s.scope=? AND s.session_hash=? AND s.generation=? AND s.revoked=0 AND s.expires_at>?
        AND a.generation=s.generation AND a.enabled=1 AND a.origin=?`,
        context.scope,
        session.session_hash,
        session.generation,
        now,
        context.origin,
      ),
    ]),
  );
  if (!results[1].results?.length)
    throw new LibraryError("authentication_required", 401);
  if (!results[0].results?.length) throw new LibraryError("file_changed", 409);
  return response(200, {
    url: await presignGet(env, file.object_key, file.format, new Date(now)),
    format: file.format,
    expiresAt: new Date(now + 300000).toISOString(),
    mode: "r2",
  });
}
async function metadata(request, env, context, session, bookId) {
  const input = await readJson(request);
  if (
    Object.keys(input).some(
      (k) => !["expectedVersion", "changes"].includes(k),
    ) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    throw new LibraryError("invalid_metadata");
  // Validate before binding category into SQL; no arbitrary JSON value reaches
  // the known-category lookup or its eventual stable-hash derivation.
  const clean = validateMetadataFields(input.changes);
  // A stale editor only needs the current version. Let SQL withhold the book
  // and patch payloads on that path rather than decoding an entire public book
  // and loading its file registry to return a two-field conflict response.
  const current = await query(() =>
    prepare(
      env,
      `SELECT COALESCE(o.version,0) AS version,
      CASE WHEN COALESCE(o.version,0)=? THEN o.patch_json ELSE NULL END AS patch_json,
      CASE WHEN COALESCE(o.version,0)=? AND ? IS NOT NULL THEN (
        SELECT json_extract(c.public_json,'$.categoryId') FROM catalog_books c
        WHERE c.scope=b.scope AND json_extract(c.public_json,'$.category')=? LIMIT 1
      ) ELSE NULL END AS category_id
      FROM catalog_books b LEFT JOIN metadata_overrides o ON o.scope=b.scope AND o.book_id=b.book_id
      WHERE b.scope=? AND b.book_id=?`,
      input.expectedVersion,
      input.expectedVersion,
      clean.category ?? null,
      clean.category ?? null,
      context.scope,
      bookId,
    ).first(),
  );
  if (!current) throw new LibraryError("book_not_found", 404);
  if (current.version !== input.expectedVersion)
    return response(409, {
      error: { code: "metadata_conflict" },
      metadataVersion: current.version,
    });
  if (clean.category)
    clean.categoryId = await deriveCategoryId(
      clean.category,
      current.category_id,
    );
  let savedPatch;
  try {
    savedPatch = current.patch_json ? JSON.parse(current.patch_json) : {};
  } catch {
    throw new LibraryError("service_unavailable", 503);
  }
  if (
    !savedPatch ||
    typeof savedPatch !== "object" ||
    Array.isArray(savedPatch)
  )
    throw new LibraryError("service_unavailable", 503);
  const patch = { ...savedPatch, ...clean };
  const mutationContext = { ...context, now: Date.now() };
  const results = await query(() =>
    env.DB.batch([
      admission(env, mutationContext, "metadata", session),
      prepare(
        env,
        `INSERT INTO metadata_overrides(scope,book_id,patch_json,version,updated_at)
      SELECT ?,?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM metadata_overrides WHERE scope=? AND book_id=? AND version=?)
      ON CONFLICT(scope,book_id) DO UPDATE SET patch_json=excluded.patch_json,version=metadata_overrides.version+1,updated_at=excluded.updated_at
      WHERE metadata_overrides.version=? RETURNING version,
        (SELECT public_json FROM catalog_books WHERE scope=? AND book_id=?) AS public_json,
        (SELECT json_group_array(json_object('file_id',file_id,'book_id',book_id,'format',format,'size_bytes',size_bytes,'state',state))
          FROM ${registrySource(env)} WHERE scope=? AND book_id=? AND state='confirmed') AS registry_json`,
        context.scope,
        bookId,
        JSON.stringify(patch),
        mutationContext.now,
        input.expectedVersion,
        context.scope,
        bookId,
        input.expectedVersion,
        input.expectedVersion,
        context.scope,
        bookId,
        context.scope,
        bookId,
      ),
      prepare(
        env,
        `SELECT version FROM metadata_overrides WHERE scope=? AND book_id=?`,
        context.scope,
        bookId,
      ),
    ]),
  );
  if (!results[1].results?.length) {
    const latest = results[2].results?.[0];
    return response(409, {
      error: { code: "metadata_conflict" },
      metadataVersion: latest?.version || 0,
    });
  }
  const updated = results[1].results[0];
  let book;
  try {
    book = mergePublicBook(
      JSON.parse(updated.public_json),
      patch,
      JSON.parse(updated.registry_json),
    );
  } catch {
    throw new LibraryError("service_unavailable", 503);
  }
  return response(200, {
    book,
    metadataVersion: updated.version,
  });
}
async function route(request, env, context) {
  const { pathname: path } = new URL(request.url);
  if (path.startsWith("/api/single-trial/")) {
    if (
      !trialMode(env) ||
      !["/api/single-trial/upload", "/api/single-trial/object"].includes(path)
    )
      throw new LibraryError("not_found", 404);
    if (
      request.headers.get("origin") !== context.origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new LibraryError("origin_forbidden", 403);
    return trialOperatorRoute(request, env);
  }
  if (request.method === "OPTIONS")
    throw new LibraryError("origin_forbidden", 403);
  if (!["GET", "POST", "HEAD"].includes(request.method))
    throw new LibraryError("method_not_allowed", 405);
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== context.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new LibraryError("origin_forbidden", 403);
  if (
    request.method === "POST" &&
    (origin !== context.origin ||
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("content-type") || "",
      ))
  )
    throw new LibraryError(
      origin !== context.origin ? "origin_forbidden" : "invalid_content_type",
      403,
    );
  const candidate = await sessionCandidate(request, env, context);
  const session = await admitApi(env, context, candidate);
  if (
    request.method === "POST" &&
    session &&
    !(await verifyCsrf(
      request.headers.get("x-csrf-token"),
      session.token,
      env.SESSION_SECRET,
      context,
    ))
  )
    throw new LibraryError("csrf_invalid", 403);
  if (request.method === "GET" && path === "/api/health")
    return response(200, { ok: true });
  if (request.method === "GET" && path === "/api/config")
    return response(200, {
      apiConfigured: true,
      aiConfigured: false,
      localFilesEnabled: false,
      r2Configured: Boolean(
        env.BOOKS &&
        env.R2_ACCOUNT_ID &&
        (trialMode(env) || (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY)),
      ),
      thresholdBytes: THRESHOLD,
      authScheme: "owner-access-key",
      privateHistory: false,
    });
  if (request.method === "GET" && path === "/api/session")
    return response(200, {
      authenticated: Boolean(session),
      csrfToken: session
        ? await csrfForSession(session.token, env.SESSION_SECRET, context)
        : null,
    });
  if (request.method === "POST" && path === "/api/login") {
    await query(() => admission(env, context, "login").run());
    const input = await readJson(request);
    const auth = await query(() =>
      prepare(
        env,
        "SELECT verifier,generation,origin,scheme,enabled FROM auth_config WHERE scope=?",
        context.scope,
      ).first(),
    );
    if (
      !auth ||
      auth.origin !== context.origin ||
      auth.scheme !== "owner-access-key-v1" ||
      auth.enabled !== 1
    )
      throw new LibraryError("service_unavailable", 503);
    if (
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, "accessKey") ||
      !(await verifyOwnerKey(
        input.accessKey,
        auth.verifier,
        env.OWNER_KEY_PEPPER,
        context,
      ))
    )
      throw new LibraryError("invalid_credentials", 401);
    const token = randomKey(),
      digest = await sessionDigest(token, env.SESSION_SECRET, context);
    await query(() =>
      prepare(
        env,
        "INSERT INTO sessions(scope,session_hash,generation,created_at,expires_at) VALUES(?,?,?,?,?)",
        context.scope,
        digest,
        auth.generation,
        context.now,
        context.now + 86400000,
      ).run(),
    );
    return response(
      200,
      {
        authenticated: true,
        csrfToken: await csrfForSession(token, env.SESSION_SECRET, context),
      },
      { "Set-Cookie": cookie(token) },
    );
  }
  if (request.method === "POST" && path === "/api/logout") {
    requireSession(session);
    await readJson(request);
    await query(() =>
      prepare(
        env,
        "UPDATE sessions SET revoked=1 WHERE scope=? AND session_hash=?",
        context.scope,
        session.session_hash,
      ).run(),
    );
    return response(
      200,
      { authenticated: false, csrfToken: null },
      { "Set-Cookie": cookie("", 0) },
    );
  }
  let match = path.match(
    /^\/api\/books\/([\w-]{1,128})(?:\/(metadata|published|history|jobs))?$/,
  );
  if (match) {
    const [, id, action] = match;
    if (request.method === "GET" && !action) {
      const info = await bookInfo(env, context.scope, id);
      return response(200, {
        book: info.book,
        metadataVersion: info.metadataVersion,
      });
    }
    if (request.method === "GET" && action === "published")
      return response(200, { jobs: [] });
    requireSession(session);
    if (request.method === "GET" && action === "history")
      return response(200, { jobs: [] });
    if (request.method === "POST" && action === "metadata")
      return metadata(request, env, context, session, id);
    if (action === "jobs") throw new LibraryError("ai_unconfigured", 503);
  }
  match = path.match(/^\/api\/files\/([\w-]{1,128})\/(access|content)$/);
  if (match) {
    requireSession(session);
    const [, id, action] = match;
    if (trialMode(env)) {
      if (!["GET", "HEAD"].includes(request.method))
        throw new LibraryError("method_not_allowed", 405);
      return trialFileAccess(
        request,
        env,
        context,
        session,
        id,
        action === "content",
      );
    }
    if (action === "content")
      throw new LibraryError("local_files_disabled", 403);
    if (request.method !== "GET")
      throw new LibraryError("method_not_allowed", 405);
    return fileAccess(env, context, session, id);
  }
  if (/^\/api\/jobs(?:\/|$)/.test(path)) {
    requireSession(session);
    throw new LibraryError("ai_unconfigured", 503);
  }
  throw new LibraryError("not_found", 404);
}
export async function handleRequest(request, env) {
  try {
    const path = new URL(request.url).pathname;
    if (path !== "/api" && !path.startsWith("/api/")) {
      if (env.APP_SCOPE === "production" && env.ASSETS)
        return env.ASSETS.fetch(request);
      return response(404, { error: { code: "not_found" } });
    }
    const context = configuration(env);
    if (new URL(request.url).origin !== context.origin)
      throw new LibraryError("origin_forbidden", 403);
    context.now = Date.now();
    context.ip = await ipDigest(
      request.headers.get("cf-connecting-ip"),
      env.SESSION_SECRET,
    );
    return await route(request, env, context);
  } catch (error) {
    const failure =
      error instanceof LibraryError
        ? error
        : new LibraryError("service_unavailable", 503);
    return response(
      failure.status,
      { error: { code: failure.code } },
      failure.status === 429 ? { "Retry-After": "60" } : {},
    );
  }
}
export default { fetch: handleRequest };
