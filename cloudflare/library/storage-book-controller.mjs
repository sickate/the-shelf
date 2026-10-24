/** Bounded v2 book display facts. No storage reads, fallback registry or write capability. */
import { LibraryError } from "./security.mjs";
import { STORAGE_DATABASE_SCHEMA_SQL } from "../../shared/storage-deployment-contract.mjs";
import {
  storageReadConfiguration,
  assertStorageReadConfiguration,
  decodeStorageBookProjection,
} from "./storage-sources.mjs";
const fields = {
  session: [
    "scope",
    "session_hash",
    "generation",
    "created_at",
    "expires_at",
    "revoked",
  ],
  management: [
    "scope",
    "book_id",
    "visibility",
    "trashed",
    "version",
    "updated_at",
  ],
  file: [
    "scope",
    "file_id",
    "book_id",
    "format",
    "size_bytes",
    "object_key",
    "sha256",
    "etag",
    "state",
    "version",
    "updated_at",
  ],
  registry: [
    "logical_key",
    "reservation_id",
    "descriptor_json",
    "etag",
    "enabled",
  ],
  reservation: [
    "reservation_id",
    "logical_key",
    "object_key",
    "descriptor_json",
    "size_bytes",
    "state",
    "put_attempted",
    "content_verified",
    "etag",
    "created_at",
    "updated_at",
  ],
  trial: [
    "id",
    "permit_id",
    "consent_id",
    "authority_identity_json",
    "target_json",
    "descriptor_json",
    "isolated_target_config_sha256",
    "size_bytes",
    "issued_at",
    "expires_at",
    "state",
    "put_attempted",
    "content_verified",
    "etag",
    "updated_at",
  ],
};
const row = (a, keys) =>
  `json_object(${keys.map((k) => `'${k}',${a}.${k}`).join(",")})`;
const oct = (x) => `length(CAST(${x} AS BLOB))`;
const qbytes = (x) => oct(`json_quote(${x})`);
const projectionSql = (
  detail = false,
) => `WITH input(scope,after_id,session_hash,generation,now_ms,origin) AS (VALUES(?,?,?,?,?,?)),
schema_rows AS MATERIALIZED (${STORAGE_DATABASE_SCHEMA_SQL}),
header AS MATERIALIZED (SELECT CASE WHEN (SELECT count(*) FROM schema_rows)>256 OR (SELECT COALESCE(sum(${oct("type")}+${oct("name")}+${oct("tbl_name")}+COALESCE(${oct("sql")},0)+64),0) FROM schema_rows)>262144 OR EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND (${oct("identity_json")}>2048 OR ${oct("phase")}>64)) THEN NULL ELSE json_object('schema',json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT * FROM schema_rows ORDER BY type,name))),'authority',json((SELECT json_object('identity_json',identity_json,'phase',phase) FROM shelf_storage_authority WHERE id=1))) END AS header_json),
live_session AS MATERIALIZED (SELECT json_object('session',json(${row("s", fields.session)}),'auth_origin',a.origin,'auth_generation',a.generation,'auth_updated_at',a.updated_at) AS session_json FROM sessions s JOIN auth_config a ON a.scope=s.scope,input i WHERE s.scope=i.scope AND s.session_hash=i.session_hash AND s.generation=i.generation AND s.revoked=0 AND s.expires_at>i.now_ms AND a.enabled=1 AND a.generation=s.generation AND a.origin=i.origin AND a.scheme='owner-access-key-v1' AND (COALESCE(${oct("s.scope")},0) + COALESCE(${oct("s.session_hash")},0) + COALESCE(${oct("s.generation")},0) + COALESCE(${oct("s.created_at")},0) + COALESCE(${oct("s.expires_at")},0) + COALESCE(${oct("s.revoked")},0) + COALESCE(${oct("a.origin")},0) + COALESCE(${oct("a.updated_at")},0))<=4096),
book_window AS MATERIALIZED (SELECT b.scope,b.book_id,b.public_json,row_number() OVER(ORDER BY b.book_id) AS ordinal,CASE WHEN ${oct("b.public_json")}>262144 OR ${oct("o.patch_json")}>32768 OR (COALESCE(${oct("b.scope")},0) + COALESCE(${oct("b.book_id")},0) + COALESCE(${oct("m.scope")},0) + COALESCE(${oct("m.book_id")},0) + COALESCE(${oct("m.visibility")},0) + COALESCE(${oct("m.trashed")},0) + COALESCE(${oct("m.version")},0) + COALESCE(${oct("m.updated_at")},0) + COALESCE(${oct("o.scope")},0) + COALESCE(${oct("o.book_id")},0) + COALESCE(${oct("o.version")},0))>4096 THEN 1 ELSE 0 END AS book_bad,CASE WHEN ${oct("b.public_json")}>262144 OR ${oct("o.patch_json")}>32768 OR (COALESCE(${oct("b.scope")},0) + COALESCE(${oct("b.book_id")},0) + COALESCE(${oct("m.scope")},0) + COALESCE(${oct("m.book_id")},0) + COALESCE(${oct("m.visibility")},0) + COALESCE(${oct("m.trashed")},0) + COALESCE(${oct("m.version")},0) + COALESCE(${oct("m.updated_at")},0) + COALESCE(${oct("o.scope")},0) + COALESCE(${oct("o.book_id")},0) + COALESCE(${oct("o.version")},0))>4096 THEN NULL ELSE json_object('scope',b.scope,'book_id',b.book_id,'catalog_json',b.public_json,'management',json(CASE WHEN m.scope IS NULL THEN NULL ELSE ${row("m", fields.management)} END),'metadata',json(CASE WHEN o.scope IS NULL THEN NULL ELSE json_object('scope',o.scope,'book_id',o.book_id,'patch_json',o.patch_json,'version',o.version) END)) END AS book_json FROM catalog_books b LEFT JOIN book_management m ON m.scope=b.scope AND m.book_id=b.book_id LEFT JOIN metadata_overrides o ON o.scope=b.scope AND o.book_id=b.book_id,input i WHERE b.scope=i.scope AND b.book_id${detail ? "=" : ">"}i.after_id ORDER BY b.book_id LIMIT ${detail ? 1 : 101}),
reference_ids AS MATERIALIZED (SELECT w.ordinal,w.scope,CASE WHEN j.type='object' THEN json_extract(j.value,'$.id') ELSE NULL END AS file_id FROM book_window w,json_each(CASE WHEN w.book_bad=0 THEN w.public_json ELSE '{"files":[]}' END,'$.files') j WHERE w.ordinal<=100 ORDER BY w.ordinal,file_id LIMIT 20001),
normal_claims AS MATERIALIZED (SELECT w.ordinal,f.scope,f.file_id FROM book_window w JOIN file_registry f ON f.scope=w.scope AND f.book_id=w.book_id WHERE w.ordinal<=100 AND f.state='confirmed' ORDER BY w.ordinal,f.file_id LIMIT 20001),
trial_claims AS MATERIALIZED (SELECT w.ordinal,w.scope,json_extract(t.descriptor_json,'$.fileId') AS file_id FROM book_window w JOIN shelf_storage_single_trial t ON json_extract(t.descriptor_json,'$.scope')=w.scope AND json_extract(t.descriptor_json,'$.bookId')=w.book_id WHERE w.ordinal<=100 AND t.state='confirmed' LIMIT 2),
associations AS MATERIALIZED (SELECT ordinal,scope,file_id FROM reference_ids UNION SELECT ordinal,scope,file_id FROM normal_claims UNION SELECT ordinal,scope,file_id FROM trial_claims),
targets AS MATERIALIZED (SELECT scope,file_id,min(ordinal) AS first_ordinal FROM associations GROUP BY scope,file_id ORDER BY first_ordinal,file_id LIMIT 20001),
raw_probe AS MATERIALIZED (SELECT 'normal' AS source,f.scope,f.file_id,x.first_ordinal FROM targets x JOIN file_registry f ON f.scope=x.scope AND f.file_id=x.file_id WHERE f.state='confirmed' UNION ALL SELECT 'trial',x.scope,x.file_id,x.first_ordinal FROM targets x JOIN shelf_storage_single_trial t ON json_extract(t.descriptor_json,'$.scope')=x.scope AND json_extract(t.descriptor_json,'$.fileId')=x.file_id WHERE t.state='confirmed' ORDER BY first_ordinal,file_id,source LIMIT 20001),
source_groups AS MATERIALIZED (SELECT x.scope,x.file_id,x.first_ordinal,CASE WHEN ${oct("g.descriptor_json")}>4096 OR ${oct("r.descriptor_json")}>4096 OR ${oct("t.descriptor_json")}>4096 OR ${oct("t.authority_identity_json")}>2048 OR ${oct("t.target_json")}>256 OR (COALESCE(${oct("x.scope")},0) + COALESCE(${oct("x.file_id")},0) + COALESCE(${oct("f.scope")},0) + COALESCE(${oct("f.file_id")},0) + COALESCE(${oct("f.book_id")},0) + COALESCE(${oct("f.format")},0) + COALESCE(${oct("f.size_bytes")},0) + COALESCE(${oct("f.object_key")},0) + COALESCE(${oct("f.sha256")},0) + COALESCE(${oct("f.etag")},0) + COALESCE(${oct("f.state")},0) + COALESCE(${oct("f.version")},0) + COALESCE(${oct("f.updated_at")},0) + COALESCE(${oct("g.logical_key")},0) + COALESCE(${oct("g.reservation_id")},0) + COALESCE(${oct("g.descriptor_json")},0) + COALESCE(${oct("g.etag")},0) + COALESCE(${oct("g.enabled")},0) + COALESCE(${oct("r.reservation_id")},0) + COALESCE(${oct("r.logical_key")},0) + COALESCE(${oct("r.object_key")},0) + COALESCE(${oct("r.descriptor_json")},0) + COALESCE(${oct("r.size_bytes")},0) + COALESCE(${oct("r.state")},0) + COALESCE(${oct("r.put_attempted")},0) + COALESCE(${oct("r.content_verified")},0) + COALESCE(${oct("r.etag")},0) + COALESCE(${oct("r.created_at")},0) + COALESCE(${oct("r.updated_at")},0) + COALESCE(${oct("t.id")},0) + COALESCE(${oct("t.permit_id")},0) + COALESCE(${oct("t.consent_id")},0) + COALESCE(${oct("t.authority_identity_json")},0) + COALESCE(${oct("t.target_json")},0) + COALESCE(${oct("t.descriptor_json")},0) + COALESCE(${oct("t.isolated_target_config_sha256")},0) + COALESCE(${oct("t.size_bytes")},0) + COALESCE(${oct("t.issued_at")},0) + COALESCE(${oct("t.expires_at")},0) + COALESCE(${oct("t.state")},0) + COALESCE(${oct("t.put_attempted")},0) + COALESCE(${oct("t.content_verified")},0) + COALESCE(${oct("t.etag")},0) + COALESCE(${oct("t.updated_at")},0))>32768 THEN 1 ELSE 0 END AS source_bad,
CASE WHEN ${oct("g.descriptor_json")}>4096 OR ${oct("r.descriptor_json")}>4096 OR ${oct("t.descriptor_json")}>4096 OR ${oct("t.authority_identity_json")}>2048 OR ${oct("t.target_json")}>256 OR (COALESCE(${oct("x.scope")},0) + COALESCE(${oct("x.file_id")},0) + COALESCE(${oct("f.scope")},0) + COALESCE(${oct("f.file_id")},0) + COALESCE(${oct("f.book_id")},0) + COALESCE(${oct("f.format")},0) + COALESCE(${oct("f.size_bytes")},0) + COALESCE(${oct("f.object_key")},0) + COALESCE(${oct("f.sha256")},0) + COALESCE(${oct("f.etag")},0) + COALESCE(${oct("f.state")},0) + COALESCE(${oct("f.version")},0) + COALESCE(${oct("f.updated_at")},0) + COALESCE(${oct("g.logical_key")},0) + COALESCE(${oct("g.reservation_id")},0) + COALESCE(${oct("g.descriptor_json")},0) + COALESCE(${oct("g.etag")},0) + COALESCE(${oct("g.enabled")},0) + COALESCE(${oct("r.reservation_id")},0) + COALESCE(${oct("r.logical_key")},0) + COALESCE(${oct("r.object_key")},0) + COALESCE(${oct("r.descriptor_json")},0) + COALESCE(${oct("r.size_bytes")},0) + COALESCE(${oct("r.state")},0) + COALESCE(${oct("r.put_attempted")},0) + COALESCE(${oct("r.content_verified")},0) + COALESCE(${oct("r.etag")},0) + COALESCE(${oct("r.created_at")},0) + COALESCE(${oct("r.updated_at")},0) + COALESCE(${oct("t.id")},0) + COALESCE(${oct("t.permit_id")},0) + COALESCE(${oct("t.consent_id")},0) + COALESCE(${oct("t.authority_identity_json")},0) + COALESCE(${oct("t.target_json")},0) + COALESCE(${oct("t.descriptor_json")},0) + COALESCE(${oct("t.isolated_target_config_sha256")},0) + COALESCE(${oct("t.size_bytes")},0) + COALESCE(${oct("t.issued_at")},0) + COALESCE(${oct("t.expires_at")},0) + COALESCE(${oct("t.state")},0) + COALESCE(${oct("t.put_attempted")},0) + COALESCE(${oct("t.content_verified")},0) + COALESCE(${oct("t.etag")},0) + COALESCE(${oct("t.updated_at")},0))>32768 THEN NULL ELSE json_object('scope',x.scope,'file_id',x.file_id,'raw_count',(CASE WHEN f.file_id IS NULL THEN 0 ELSE 1 END)+(CASE WHEN t.id IS NULL THEN 0 ELSE 1 END),'normal',json(CASE WHEN f.file_id IS NULL THEN '[]' ELSE json_array(json_object('file',json(${row("f", fields.file)}),'registry',json(CASE WHEN g.logical_key IS NULL THEN NULL ELSE ${row("g", fields.registry)} END),'reservation',json(CASE WHEN r.reservation_id IS NULL THEN NULL ELSE ${row("r", fields.reservation)} END))) END),'trial',json(CASE WHEN t.id IS NULL THEN '[]' ELSE json_array(${row("t", fields.trial)}) END)) END AS group_json FROM targets x LEFT JOIN file_registry f ON f.scope=x.scope AND f.file_id=x.file_id AND f.state='confirmed' LEFT JOIN shelf_storage_original_registry g ON g.logical_key=('original:'||f.scope||':'||f.file_id||':original') LEFT JOIN shelf_storage_reservations r ON r.reservation_id=g.reservation_id LEFT JOIN shelf_storage_single_trial t ON t.state='confirmed' AND json_extract(t.descriptor_json,'$.scope')=x.scope AND json_extract(t.descriptor_json,'$.fileId')=x.file_id),
spill AS MATERIALIZED (SELECT ordinal FROM (SELECT ordinal,file_id FROM reference_ids ORDER BY ordinal,file_id LIMIT 1 OFFSET 20000) UNION ALL SELECT ordinal FROM (SELECT ordinal FROM normal_claims ORDER BY ordinal,file_id LIMIT 1 OFFSET 20000) UNION ALL SELECT first_ordinal FROM (SELECT first_ordinal,file_id FROM targets ORDER BY first_ordinal,file_id LIMIT 1 OFFSET 20000) UNION ALL SELECT first_ordinal FROM (SELECT first_ordinal,file_id,source FROM raw_probe ORDER BY first_ordinal,file_id,source LIMIT 1 OFFSET 20000)),
running AS MATERIALIZED (SELECT w.*,sum(CASE WHEN w.book_bad=1 OR EXISTS(SELECT 1 FROM source_groups g JOIN associations a ON a.scope=g.scope AND a.file_id IS g.file_id WHERE a.ordinal=w.ordinal AND g.source_bad=1) THEN 1048577 ELSE ${qbytes("w.book_json")}+COALESCE((SELECT sum(${qbytes("g.group_json")}+2) FROM source_groups g JOIN associations a ON a.scope=g.scope AND a.file_id IS g.file_id WHERE a.ordinal=w.ordinal),0)+64 END) OVER(ORDER BY w.ordinal) AS cumulative FROM book_window w WHERE w.ordinal<=100),
selected AS MATERIALIZED (SELECT * FROM running WHERE (SELECT header_json FROM header) IS NOT NULL AND cumulative+(SELECT ${qbytes("header_json")} FROM header)+COALESCE((SELECT ${qbytes("session_json")} FROM live_session),4)+4096<=1048576 AND ordinal<COALESCE((SELECT min(ordinal) FROM spill),101)),
book_payload AS MATERIALIZED (SELECT json_group_array(json(book_json) ORDER BY ordinal) AS books_json,count(*) AS returned,max(book_id) AS last_id,max(ordinal) AS last_ordinal FROM selected),
source_payload AS MATERIALIZED (SELECT json_group_array(json(g.group_json) ORDER BY g.scope,g.file_id) AS sources_json FROM source_groups g,book_payload b WHERE g.first_ordinal<=COALESCE(b.last_ordinal,0)),
window_count AS MATERIALIZED (SELECT count(*) AS total FROM book_window)
SELECT CASE WHEN h.header_json IS NULL OR w.total>0 AND b.returned=0 THEN NULL ELSE json_object('header',json(h.header_json),'books',json(b.books_json),'sources',json(g.sources_json)) END AS projection_json,s.session_json,json_object('mode','keyset-v1','pageSize',100,'returned',b.returned,'nextCursor',CASE WHEN w.total>b.returned THEN b.last_id ELSE NULL END) AS page_json,CASE WHEN h.header_json IS NULL OR w.total>0 AND b.returned=0 THEN 1 ELSE 0 END AS overflow FROM header h,book_payload b,source_payload g,window_count w LEFT JOIN live_session s ON 1=1`;

export const STORAGE_BOOK_PAGE_SQL = projectionSql();
export const STORAGE_BOOK_DETAIL_SQL = projectionSql(true);
export const STORAGE_BOOK_READ_LIMITS = Object.freeze({
  sqlBytes: 16_384,
  parameters: 6,
  books: 100,
  responseBytes: 1_048_576,
  timeoutMs: 30_000,
});
const bytes = (value) => new TextEncoder().encode(value).byteLength;
for (const sql of [STORAGE_BOOK_PAGE_SQL, STORAGE_BOOK_DETAIL_SQL])
  if (bytes(sql) > STORAGE_BOOK_READ_LIMITS.sqlBytes)
    throw Error("storage_book_sql_budget");
const fail = (code = "service_unavailable", status = 503) => {
  throw new LibraryError(code, status);
};
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export function storageBookCursor(request) {
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some((key) => key !== "cursor") ||
    params.getAll("cursor").length > 1 ||
    (params.has("cursor") && !id(params.get("cursor")))
  )
    fail("invalid_cursor", 400);
  return params.get("cursor") ?? "";
}
export function assertStorageBookSession(raw, context, session, now) {
  if (raw === null) fail("authentication_required", 401);
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    fail();
  }
  const row = state?.session;
  if (
    !exact(state, [
      "session",
      "auth_origin",
      "auth_generation",
      "auth_updated_at",
    ]) ||
    !exact(row, fields.session) ||
    row.scope !== context.scope ||
    row.session_hash !== session.session_hash ||
    row.generation !== session.generation ||
    !integer(row.generation) ||
    row.generation < 1 ||
    row.revoked !== 0 ||
    !integer(row.created_at) ||
    !integer(row.expires_at) ||
    row.created_at > now ||
    row.expires_at <= now ||
    row.expires_at <= row.created_at ||
    state.auth_origin !== context.origin ||
    state.auth_generation !== row.generation ||
    !integer(state.auth_updated_at)
  )
    fail("authentication_required", 401);
}
export async function storageBookDeadline(operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new LibraryError("service_unavailable", 503)),
          STORAGE_BOOK_READ_LIMITS.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One primary SELECT; returned source facts confer no file access capability. */
export async function storageBooks(
  env,
  context,
  session,
  {
    cursor = "",
    bookId = null,
    configuration = storageReadConfiguration(env),
  } = {},
) {
  const detail = bookId !== null;
  if ((!detail && cursor !== "" && !id(cursor)) || (detail && !id(bookId)))
    fail(detail ? "book_not_found" : "invalid_cursor", detail ? 404 : 400);
  if (
    context.scope !== configuration.scope ||
    context.origin !== configuration.origin
  )
    fail();
  if (!detail && !session) fail("authentication_required", 401);
  assertStorageReadConfiguration(env, configuration);
  const database = env.DB,
    withSession = database.withSession;
  let primary, primaryPrepare, statement, first, observed;
  try {
    primary = withSession.call(database, "first-primary");
    primaryPrepare = primary?.prepare;
    if (typeof primaryPrepare !== "function") fail();
    statement = primaryPrepare
      .call(primary, detail ? STORAGE_BOOK_DETAIL_SQL : STORAGE_BOOK_PAGE_SQL)
      .bind(
        context.scope,
        detail ? bookId : cursor,
        session?.session_hash ?? "",
        session?.generation ?? 0,
        Date.now(),
        context.origin,
      );
    first = statement?.first;
    if (typeof first !== "function") fail();
    observed = await storageBookDeadline(() => first.call(statement));
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    fail();
  }
  assertStorageReadConfiguration(env, configuration);
  if (
    env.DB !== database ||
    database.withSession !== withSession ||
    primary.prepare !== primaryPrepare ||
    statement.first !== first
  )
    fail("file_changed", 409);
  if (
    !exact(observed, [
      "projection_json",
      "session_json",
      "page_json",
      "overflow",
    ]) ||
    bytes(JSON.stringify(observed)) > STORAGE_BOOK_READ_LIMITS.responseBytes
  )
    fail();
  if (session)
    assertStorageBookSession(observed.session_json, context, session, Date.now());
  const decoded = decodeStorageBookProjection(
    configuration,
    {
      projection_json: observed.projection_json,
      overflow: observed.overflow,
    },
    { audience: session ? "owner" : "anonymous", allowTrash: !detail },
  );
  let page;
  try {
    page = JSON.parse(observed.page_json);
  } catch {
    fail();
  }
  if (
    !exact(page, ["mode", "pageSize", "returned", "nextCursor"]) ||
    page.mode !== "keyset-v1" ||
    page.pageSize !== 100 ||
    !integer(page.returned) ||
    page.returned > 100 ||
    (!detail && page.returned !== decoded.books.length) ||
    (page.nextCursor !== null &&
      (!id(page.nextCursor) || page.nextCursor <= cursor))
  )
    fail();
  if (detail) {
    const item = decoded.books[0];
    if (!item || item.bookId !== bookId || item.trashed)
      fail("book_not_found", 404);
    return item;
  }
  return {
    books: decoded.books.map(
      ({ book, metadataVersion, trashed, managementVersion, deletedAt }) => ({
        book,
        metadataVersion,
        trashed: Boolean(trashed),
        managementVersion,
        deletedAt,
      }),
    ),
    pagination: page,
  };
}
