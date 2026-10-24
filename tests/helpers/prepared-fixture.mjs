import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  buildPreparedIndex,
  preparedChunkRow,
  preparedDigest,
} from "../../shared/prepared-index.mjs";
import { loadPreparedForJob } from "../../cloudflare/library/prepared.mjs";
import { validatePreparedText } from "../../shared/prepared-text.mjs";
import {
  csrfForSession,
  randomKey,
} from "../../cloudflare/library/security.mjs";

export const migration = readFileSync(
  new URL(
    "../../cloudflare/library/migrations/010-prepared-index.sql",
    import.meta.url,
  ),
  "utf8",
);
export const FILE = "file_1234567890abcdef",
  BOOK = "book_1234567890abcdef",
  ACCOUNT = "a".repeat(32);
export const context = {
  scope: "production",
  origin: "https://the-shelf.iamzhutuo.workers.dev",
};
const encoder = new TextEncoder();
const sha = (value) =>
  preparedDigest(typeof value === "string" ? encoder.encode(value) : value);

// These upstream tables model established storage facts. The compatibility test below
// also parses 010 against the actual complete base/003/007 migrations without changes.
const upstream = `
 CREATE TABLE shelf_storage_authority(id INTEGER PRIMARY KEY,identity_json TEXT);
 CREATE TABLE shelf_storage_reservations(reservation_id TEXT PRIMARY KEY,state TEXT,content_verified INTEGER,descriptor_json TEXT,etag TEXT);
 CREATE TABLE shelf_storage_text_registry(logical_key TEXT PRIMARY KEY,reservation_id TEXT,enabled INTEGER,descriptor_json TEXT,etag TEXT);
 CREATE TABLE shelf_storage_original_registry(logical_key TEXT PRIMARY KEY,reservation_id TEXT,enabled INTEGER,descriptor_json TEXT,etag TEXT);
 CREATE TABLE file_registry(scope TEXT,file_id TEXT,book_id TEXT,state TEXT,object_key TEXT,etag TEXT,sha256 TEXT,size_bytes INTEGER,format TEXT,version INTEGER DEFAULT 1);
 CREATE TABLE catalog_books(scope TEXT,book_id TEXT,public_json TEXT);
 CREATE TABLE book_management(scope TEXT,book_id TEXT,trashed INTEGER,version INTEGER,visibility TEXT);
 CREATE TABLE sessions(scope TEXT,session_hash TEXT,generation INTEGER,revoked INTEGER,expires_at INTEGER);
 CREATE TABLE auth_config(scope TEXT,generation INTEGER,enabled INTEGER,origin TEXT);`;

export async function fixture(
  t,
  { count = 2, format = "PDF", publish = true } = {},
) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(upstream);
  db.exec(migration);
  const sourceSha256 = await sha("original synthetic source"),
    chunks = [];
  for (let index = 0; index < count; index++) {
    const text =
      count > 1000
        ? "a"
        : index === 0
          ? "磁流体发动机研究证据。"
          : "普通自然随笔。";
    chunks.push({
      index,
      locator:
        format === "PDF"
          ? {
              type: "pdf-page",
              page: index + 1,
              start: 0,
              end: [...text].length,
            }
          : {
              type: "epub-spine",
              spineIndex: index,
              start: 0,
              end: [...text].length,
            },
      text,
      sha256: await sha(text),
    });
  }
  const body = {
    schemaVersion: 1,
    kind: "shelf.prepared-text",
    preparation: {
      algorithm: "shelf-text-v1",
      normalization: "LF-NFC-trim-section",
      chunkCodepoints: 6000,
      offsetUnit: "unicode-code-point",
    },
    source: {
      fileId: FILE,
      bookId: BOOK,
      format,
      sizeBytes: 25,
      mtimeNs: "123",
      fingerprint: { algorithm: "sha256", value: sourceSha256 },
    },
    textBytes: chunks.reduce(
      (n, c) => n + encoder.encode(c.text).byteLength,
      0,
    ),
    contentHash: await sha(JSON.stringify(chunks)),
    chunks,
  };
  const versionHash = await sha(JSON.stringify(body)),
    value = { ...body, versionHash },
    bytes = encoder.encode(JSON.stringify(value) + "\n");
  const pin = {
    fileId: FILE,
    bookId: BOOK,
    format,
    sizeBytes: 25,
    mtimeNs: "123",
    versionHash,
    sourceSha256,
  };
  await validatePreparedText(bytes, pin);
  const index = await buildPreparedIndex(value),
    packageSha256 = await sha(bytes),
    etag = "package-etag";
  const descriptor = {
    kind: "prepared-text",
    scope: "production",
    fileId: FILE,
    bookId: BOOK,
    format: "JSON",
    sizeBytes: bytes.length,
    sha256: packageSha256,
    objectKey: `prepared-text/v1/production/${FILE}/${versionHash}/${packageSha256}.json`,
    versionHash,
    source: pin,
  };
  const original = {
    kind: "original",
    scope: "production",
    fileId: FILE,
    bookId: BOOK,
    format,
    sizeBytes: 25,
    sha256: sourceSha256,
    objectKey: `books/cf03/${FILE}/${sourceSha256}.${format.toLowerCase()}`,
    versionHash: null,
    source: null,
  };
  db.prepare("INSERT INTO shelf_storage_authority VALUES(1,?)").run(
    JSON.stringify({
      schemaVersion: 1,
      authorityId: "shelf-remote-storage-v1",
      accountId: ACCOUNT,
      bucket: "the-shelf-books",
      legacyDatabases: {},
    }),
  );
  db.prepare(
    "INSERT INTO shelf_storage_reservations VALUES('text','confirmed',1,?,?)",
  ).run(JSON.stringify(descriptor), etag);
  db.prepare(
    "INSERT INTO shelf_storage_reservations VALUES('original','confirmed',1,?,'original-etag')",
  ).run(JSON.stringify(original));
  const logical = `prepared-text:production:${FILE}:${versionHash}`;
  db.prepare(
    "INSERT INTO shelf_storage_text_registry VALUES(?,'text',1,?,?)",
  ).run(logical, JSON.stringify(descriptor), etag);
  db.prepare(
    "INSERT INTO shelf_storage_original_registry VALUES('original-key','original',1,?,'original-etag')",
  ).run(JSON.stringify(original));
  db.prepare(
    "INSERT INTO file_registry(scope,file_id,book_id,state,object_key,etag,sha256,size_bytes,format) VALUES('production',?,?,'confirmed',?,'original-etag',?,25,?)",
  ).run(FILE, BOOK, original.objectKey, sourceSha256, format);
  db.prepare("INSERT INTO catalog_books VALUES('production',?,?)").run(
    BOOK,
    JSON.stringify({
      files: [{ id: FILE, format, sizeBytes: 25, status: "candidate" }],
    }),
  );
  db.prepare(
    "INSERT INTO book_management VALUES('production',?,0,1,'private')",
  ).run(BOOK);
  const session = {
    session_hash: "b".repeat(64),
    generation: 1,
    token: randomKey(),
  };
  db.prepare("INSERT INTO sessions VALUES('production',?,1,0,?)").run(
    session.session_hash,
    Date.now() + 600000,
  );
  db.prepare("INSERT INTO auth_config VALUES('production',1,1,?)").run(
    context.origin,
  );
  const header = {
    scope: "production",
    file_id: FILE,
    version_hash: versionHash,
    book_id: BOOK,
    text_reservation_id: "text",
    text_logical_key: logical,
    package_sha256: packageSha256,
    source_sha256: sourceSha256,
    etag,
    format,
    chunk_count: count,
    text_bytes: index.textBytes,
    codepoint_count: index.codepointCount,
    index_sha256: index.indexSha256,
    created_at: Date.now(),
  };
  const insertHeader = () =>
    db
      .prepare(
        `INSERT INTO shelf_prepared_indexes(${Object.keys(header).join(",")}) VALUES(${Object.keys(
          header,
        )
          .map(() => "?")
          .join(",")})`,
      )
      .run(...Object.values(header));
  insertHeader();
  const insertChunk = (chunk) => {
    const row = {
      scope: "production",
      file_id: FILE,
      version_hash: versionHash,
      ...preparedChunkRow(chunk),
    };
    db.prepare(
      `INSERT INTO shelf_prepared_index_chunks(${Object.keys(row).join(",")}) VALUES(${Object.keys(
        row,
      )
        .map(() => "?")
        .join(",")})`,
    ).run(...Object.values(row));
  };
  for (const chunk of index.chunks) insertChunk(chunk);
  const publishIndex = () =>
    db
      .prepare(
        "INSERT INTO shelf_prepared_index_publications VALUES('production',?,?,?,?,?,?)",
      )
      .run(
        FILE,
        versionHash,
        index.indexSha256,
        count,
        index.textBytes,
        index.codepointCount,
      );
  if (publish) publishIndex();
  const calls = { d1: 0, head: 0, get: 0 };
  const binding = {
    prepare(sql) {
      return {
        bind(...args) {
          const stmt = db.prepare(sql);
          return {
            async first() {
              calls.d1++;
              return stmt.get(...args) ?? null;
            },
            async all() {
              calls.d1++;
              return { results: stmt.all(...args) };
            },
            async run() {
              calls.d1++;
              return { meta: stmt.run(...args) };
            },
            execute() {
              calls.d1++;
              return { results: stmt.all(...args) };
            },
          };
        },
      };
    },
    async batch(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    withSession(mode) {
      assert.equal(mode, "first-primary");
      return this;
    },
  };
  const env = {
    DB: binding,
    PREPARED_TEXT_MODE: "registry-v1",
    PREPARED_R2_ACCOUNT_ID: ACCOUNT,
    PREPARED_R2_BUCKET: "the-shelf-books",
    SESSION_SECRET: randomKey(),
    PREPARED_BOOKS: {
      async head(key) {
        calls.head++;
        assert.equal(key, descriptor.objectKey);
        return { size: bytes.length, etag };
      },
      async get(key, options) {
        calls.get++;
        assert.equal(key, descriptor.objectKey);
        assert.deepEqual(options, { onlyIf: { etagMatches: etag } });
        return { size: bytes.length, etag, body: new Response(bytes).body };
      },
    },
  };
  const grant = { context, session, bookId: BOOK },
    selected = { fileId: FILE, versionHash };
  const load = (options) => loadPreparedForJob(env, grant, selected, options);
  const request = async (search = false, overrides = {}) => {
    const headers = search
      ? {
          origin: context.origin,
          "content-type": "application/json",
          "x-csrf-token": await csrfForSession(
            session.token,
            env.SESSION_SECRET,
            context,
          ),
        }
      : {};
    return new Request(
      `${context.origin}/api/books/${BOOK}/prepared${search ? "/search" : `?fileId=${FILE}&versionHash=${versionHash}`}`,
      {
        method: search ? "POST" : "GET",
        headers: { ...headers, ...overrides.headers },
        ...(search
          ? { body: JSON.stringify({ ...selected, question: "磁流体发动机" }) }
          : {}),
        ...overrides,
      },
    );
  };
  return {
    db,
    env,
    header,
    index,
    value,
    bytes,
    descriptor,
    pin,
    grant,
    selected,
    session,
    calls,
    load,
    insertHeader,
    insertChunk,
    publishIndex,
    request,
  };
}
