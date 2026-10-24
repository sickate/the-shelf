/** Closed v2 metadata/lifecycle writes. No upload, storage mutation, retries or AI. */
import { LibraryError, randomKey, readJson } from "./security.mjs";
import { validateMetadataFields, deriveCategoryId } from "./core.mjs";
import {
  storageReadConfiguration,
  assertStorageReadConfiguration,
  decodeStorageBookProjection,
} from "./storage-sources.mjs";
import {
  STORAGE_BOOK_DETAIL_SQL,
  STORAGE_BOOK_READ_LIMITS,
  assertStorageBookSession,
  storageBookDeadline,
} from "./storage-book-controller.mjs";
const fail = (code = "service_unavailable", status = 503) => {
  throw new LibraryError(code, status);
};
const bytes = (value) => new TextEncoder().encode(value).byteLength;
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const tail =
  " FROM header h,book_payload b,source_payload g,window_count w LEFT JOIN live_session s ON 1=1";
function replaceOnce(sql, oldText, newText) {
  if (sql.split(oldText).length !== 2)
    throw Error("storage_mutation_sql_shape");
  return sql.replace(oldText, newText);
}
// These forms are compiled only from the fixed book SQL. No request contributes
// SQL text. Keep default list/detail SQL unchanged and fail on a changed shape.
const invariant = replaceOnce(
  STORAGE_BOOK_DETAIL_SQL,
  "LEFT JOIN metadata_overrides o ON o.scope=b.scope AND o.book_id=b.book_id",
  "",
).replaceAll(/\bo\.(patch_json|scope|book_id|version)\b/g, "NULL");
if (/\bo\./.test(invariant)) throw Error("storage_mutation_metadata_guard");
const category = `(SELECT CASE WHEN length(CAST(json_extract(c.public_json,'$.categoryId') AS BLOB))<=128 THEN json_extract(c.public_json,'$.categoryId') ELSE NULL END FROM catalog_books c,input i WHERE c.scope=i.scope AND length(CAST(c.public_json AS BLOB))<=262144 AND ?7 IS NOT NULL AND json_extract(c.public_json,'$.category')=?7 ORDER BY c.book_id LIMIT 1) AS category_id`;
export const STORAGE_METADATA_INITIAL_SQL = replaceOnce(
  STORAGE_BOOK_DETAIL_SQL,
  tail,
  `,${category}${tail}`,
);
export const STORAGE_METADATA_UPDATE_SQL = `WITH source_guard AS (${invariant})
INSERT INTO metadata_overrides(scope,book_id,patch_json,version,updated_at)
SELECT ?1,?2,?9,1,?5 FROM source_guard
WHERE overflow=0 AND projection_json=?7 AND session_json=?8 AND session_json IS NOT NULL
 AND (?10=0 OR EXISTS(SELECT 1 FROM metadata_overrides WHERE scope=?1 AND book_id=?2 AND version=?10))
ON CONFLICT(scope,book_id) DO UPDATE SET patch_json=excluded.patch_json,version=metadata_overrides.version+1,updated_at=excluded.updated_at
WHERE metadata_overrides.version=?10 RETURNING version`;
export const STORAGE_METADATA_FINAL_SQL = replaceOnce(
  STORAGE_BOOK_DETAIL_SQL,
  tail,
  `,COALESCE((SELECT version FROM metadata_overrides WHERE scope=?1 AND book_id=?2),0) AS latest_version${tail}`,
);
export const STORAGE_LIFECYCLE_UPDATE_SQL = `WITH source_guard AS (${STORAGE_BOOK_DETAIL_SQL})
INSERT INTO book_management(scope,book_id,visibility,trashed,version,updated_at)
SELECT ?1,?2,'public',?9,1,?5 FROM source_guard
WHERE overflow=0 AND projection_json=?7 AND session_json=?8 AND session_json IS NOT NULL
 AND COALESCE((SELECT version FROM book_management WHERE scope=?1 AND book_id=?2),0)=?10
ON CONFLICT(scope,book_id) DO UPDATE SET trashed=excluded.trashed,version=book_management.version+1,updated_at=excluded.updated_at
WHERE book_management.version=?10 RETURNING trashed,version,updated_at`;
export const STORAGE_LIFECYCLE_FINAL_SQL = replaceOnce(
  STORAGE_BOOK_DETAIL_SQL,
  tail,
  `,COALESCE((SELECT version FROM book_management WHERE scope=?1 AND book_id=?2),0) AS latest_version${tail}`,
);
export const STORAGE_BOOK_MUTATION_LIMITS = Object.freeze({
  sqlBytes: 16384,
  parameters: 10,
  statements: 4,
  patchBytes: 32768,
  responseBytes: 1048576,
});
for (const sql of [
  STORAGE_METADATA_INITIAL_SQL,
  STORAGE_METADATA_UPDATE_SQL,
  STORAGE_METADATA_FINAL_SQL,
  STORAGE_LIFECYCLE_UPDATE_SQL,
  STORAGE_LIFECYCLE_FINAL_SQL,
])
  if (bytes(sql) > STORAGE_BOOK_MUTATION_LIMITS.sqlBytes)
    throw Error("storage_mutation_sql_budget");
const admissionSql =
  "INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation,file_id)VALUES(?,?,?,?,?,?,?,?)";
function databaseError(error) {
  if (error instanceof LibraryError) throw error;
  const message = typeof error?.message === "string" ? error.message : "";
  if (/library_session_invalid/.test(message))
    fail("authentication_required", 401);
  if (/library_file_unavailable/.test(message)) fail("file_unavailable", 409);
  if (/count<=max_count|count <= max_count/.test(message))
    fail("rate_limited", 429);
  fail();
}
function mutationDatabase(env, context, session, bookId) {
  if (!session) fail("authentication_required", 401);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(bookId)) fail("book_not_found", 404);
  const configuration = storageReadConfiguration(env),
    database = env.DB,
    withSession = database.withSession;
  if (
    context.scope !== configuration.scope ||
    context.origin !== configuration.origin
  )
    fail();
  const primary = withSession.call(database, "first-primary"),
    prepare = primary?.prepare,
    batch = primary?.batch;
  if (typeof prepare !== "function" || typeof batch !== "function") fail();
  const statements = [];
  const assert = () => {
    assertStorageReadConfiguration(env, configuration);
    if (
      env.DB !== database ||
      database.withSession !== withSession ||
      primary.prepare !== prepare ||
      primary.batch !== batch ||
      statements.some(
        (s) =>
          s.unbound.bind !== s.bind ||
          s.bound.first !== s.first ||
          s.bound.all !== s.all ||
          s.bound.run !== s.run,
      )
    )
      fail("file_changed", 409);
  };
  const statement = (sql, parameters) => {
    assert();
    const unbound = prepare.call(primary, sql),
      bind = unbound?.bind;
    if (typeof bind !== "function") fail();
    const bound = bind.call(unbound, ...parameters);
    if (!bound || typeof bound.first !== "function") fail();
    statements.push({
      unbound,
      bind,
      bound,
      first: bound.first,
      all: bound.all,
      run: bound.run,
    });
    return bound;
  };
  const parameters = (now) => [
    context.scope,
    bookId,
    session.session_hash,
    session.generation,
    now,
    context.origin,
  ];
  return {
    configuration,
    assert,
    parameters,
    async first(sql, params) {
      const bound = statement(sql, params),
        first = bound.first;
      let row;
      try {
        row = await storageBookDeadline(() => first.call(bound));
      } catch (e) {
        databaseError(e);
      }
      assert();
      return row;
    },
    async batch(entries) {
      const bound = entries.map(([sql, params]) => statement(sql, params));
      let result;
      try {
        result = await storageBookDeadline(() => batch.call(primary, bound));
      } catch (e) {
        databaseError(e);
      }
      assert();
      if (
        !Array.isArray(result) ||
        result.length !== 3 ||
        result.some((r) => !Array.isArray(r?.results)) ||
        result[0].results.length !== 0 ||
        result[1].results.length > 1 ||
        result[2].results.length !== 1 ||
        bytes(JSON.stringify(result)) >
          STORAGE_BOOK_MUTATION_LIMITS.responseBytes
      )
        fail();
      return result;
    },
    admission(now) {
      return [
        admissionSql,
        [
          context.scope,
          randomKey(),
          "metadata",
          context.ip,
          now,
          session.session_hash,
          session.generation,
          null,
        ],
      ];
    },
  };
}
function decode(
  row,
  db,
  context,
  session,
  { allowTrash = false, extra = [] } = {},
) {
  if (
    !exact(row, [
      "projection_json",
      "session_json",
      "page_json",
      "overflow",
      ...extra,
    ]) ||
    bytes(JSON.stringify(row)) > STORAGE_BOOK_READ_LIMITS.responseBytes
  )
    fail();
  assertStorageBookSession(row.session_json, context, session, Date.now());
  const result = decodeStorageBookProjection(
    db.configuration,
    { projection_json: row.projection_json, overflow: row.overflow },
    { audience: "owner", allowTrash },
  );
  if (result.books.length !== 1) fail("book_not_found", 404);
  const item = result.books[0];
  if (item.bookId !== db.parameters(0)[1]) fail();
  return item;
}
function conflict(response, kind, version) {
  return response(409, {
    error: {
      code: kind === "metadata" ? "metadata_conflict" : "management_conflict",
    },
    [kind === "metadata" ? "metadataVersion" : "managementVersion"]: version,
  });
}
const mutationVersion = (row) => {
  if (!integer(row?.latest_version)) fail();
  return row.latest_version;
};
export async function storageMetadata(
  request,
  env,
  context,
  session,
  bookId,
  { response },
) {
  const db = mutationDatabase(env, context, session, bookId),
    input = await readJson(request);
  db.assert();
  if (
    Object.keys(input).some(
      (k) => !["expectedVersion", "changes"].includes(k),
    ) ||
    !integer(input.expectedVersion)
  )
    fail("invalid_metadata", 400);
  const clean = validateMetadataFields(input.changes);
  const row = await db.first(STORAGE_METADATA_INITIAL_SQL, [
    ...db.parameters(Date.now()),
    clean.category ?? null,
  ]);
  const initial = decode(row, db, context, session, { extra: ["category_id"] });
  if (initial.metadataVersion !== input.expectedVersion)
    return conflict(response, "metadata", initial.metadataVersion);
  if (clean.category)
    clean.categoryId = await deriveCategoryId(clean.category, row.category_id);
  db.assert();
  assertStorageBookSession(row.session_json, context, session, Date.now());
  if (input.expectedVersion === Number.MAX_SAFE_INTEGER)
    fail("invalid_metadata", 400);
  const patch = { ...initial.patch, ...clean },
    patchJson = JSON.stringify(patch);
  if (bytes(patchJson) > STORAGE_BOOK_MUTATION_LIMITS.patchBytes)
    fail("invalid_metadata", 400);
  // Reject a predictably oversized or invalid response before consuming admission.
  const proposed = JSON.parse(row.projection_json);
  proposed.books[0].metadata = {
    scope: context.scope,
    book_id: bookId,
    patch_json: patchJson,
    version: input.expectedVersion + 1,
  };
  decode(
    { ...row, projection_json: JSON.stringify(proposed) },
    db,
    context,
    session,
    { extra: ["category_id"] },
  );
  const quoted = (value) => bytes(JSON.stringify(JSON.stringify(value)));
  const cost =
    quoted(proposed.header) +
    quoted(proposed.books[0]) +
    proposed.sources.reduce((sum, group) => sum + quoted(group) + 2, 0) +
    bytes(JSON.stringify(row.session_json)) +
    64 +
    4096;
  if (cost > STORAGE_BOOK_MUTATION_LIMITS.responseBytes)
    fail("invalid_metadata", 400);
  const guard = JSON.parse(row.projection_json);
  guard.books[0].metadata = null;
  const now = Date.now(),
    result = await db.batch([
      db.admission(now),
      [
        STORAGE_METADATA_UPDATE_SQL,
        [
          ...db.parameters(now),
          JSON.stringify(guard),
          row.session_json,
          patchJson,
          input.expectedVersion,
        ],
      ],
      [STORAGE_METADATA_FINAL_SQL, db.parameters(now)],
    ]);
  const finalRow = result[2].results[0],
    latest = mutationVersion(finalRow),
    updated = result[1].results[0];
  const final = decode(finalRow, db, context, session, {
    extra: ["latest_version"],
  });
  if (!updated) return conflict(response, "metadata", latest);
  if (
    !exact(updated, ["version"]) ||
    !integer(updated.version) ||
    updated.version !== latest ||
    final.metadataVersion !== latest ||
    latest !== input.expectedVersion + 1
  )
    fail();
  return response(200, {
    book: final.book,
    metadataVersion: final.metadataVersion,
  });
}
export async function storageLifecycle(
  request,
  env,
  context,
  session,
  bookId,
  trashed,
  { response },
) {
  const db = mutationDatabase(env, context, session, bookId),
    input = await readJson(request);
  db.assert();
  if (
    ![0, 1].includes(trashed) ||
    Object.keys(input).length !== 1 ||
    !integer(input.expectedVersion)
  )
    fail("invalid_management", 400);
  const row = await db.first(
    STORAGE_BOOK_DETAIL_SQL,
    db.parameters(Date.now()),
  );
  const initial = decode(row, db, context, session, { allowTrash: true });
  if (initial.managementVersion !== input.expectedVersion)
    return conflict(response, "management", initial.managementVersion);
  if (input.expectedVersion === Number.MAX_SAFE_INTEGER)
    fail("invalid_management", 400);
  const now = Date.now(),
    result = await db.batch([
      db.admission(now),
      [
        STORAGE_LIFECYCLE_UPDATE_SQL,
        [
          ...db.parameters(now),
          row.projection_json,
          row.session_json,
          trashed,
          input.expectedVersion,
        ],
      ],
      [STORAGE_LIFECYCLE_FINAL_SQL, db.parameters(now)],
    ]);
  const finalRow = result[2].results[0],
    latest = mutationVersion(finalRow),
    updated = result[1].results[0];
  const final = decode(finalRow, db, context, session, {
    allowTrash: true,
    extra: ["latest_version"],
  });
  if (!updated) return conflict(response, "management", latest);
  if (
    !exact(updated, ["trashed", "version", "updated_at"]) ||
    updated.trashed !== trashed ||
    !integer(updated.updated_at) ||
    !integer(updated.version) ||
    updated.version !== latest ||
    final.managementVersion !== latest ||
    latest !== input.expectedVersion + 1 ||
    final.trashed !== trashed
  )
    fail();
  return response(200, {
    book: final.book,
    trashed: Boolean(final.trashed),
    managementVersion: final.managementVersion,
    deletedAt: final.deletedAt,
  });
}
