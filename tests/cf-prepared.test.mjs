import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { preparedChunkRow } from "../shared/prepared-index.mjs";
import {
  loadPreparedForJob,
  preparedRoute as rawPreparedRoute,
} from "../cloudflare/library/prepared.mjs";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import { randomKey, sessionDigest } from "../cloudflare/library/security.mjs";
import {
  fixture,
  migration,
  FILE,
  BOOK,
  context,
} from "./helpers/prepared-fixture.mjs";
const encoder = new TextEncoder();
const preparedRoute = (...args) =>
  rawPreparedRoute(...args, { admitAccess: async () => {} });

test("010 parses against actual existing base/003/007 without modifying frozen migrations", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of [
      "schema.sql",
      "migrations/003-storage-authority.sql",
      "migrations/007-book-management.sql",
    ])
      db.exec(
        readFileSync(
          new URL(`../cloudflare/library/${file}`, import.meta.url),
          "utf8",
        ),
      );
    db.exec(migration);
  } finally {
    db.close();
  }
});
for (const format of ["PDF", "EPUB"])
  test(`confirmed ${format} loads exact private package and text-free index`, async (t) => {
    const f = await fixture(t, { format });
    const result = await f.load();
    assert.equal(result.value.versionHash, f.pin.versionHash);
    assert.equal(result.chunks.length, 2);
    assert.equal(
      result.chunks[0].sourceLocator.type,
      format === "PDF" ? "pdf-page" : "epub-spine",
    );
    assert.deepEqual(f.calls, { d1: 3, head: 2, get: 1 });
    const columns = f.db
      .prepare("PRAGMA table_info(shelf_prepared_index_chunks)")
      .all()
      .map((r) => r.name);
    assert.equal(columns.includes("text"), false);
  });
test("D1 row column order is irrelevant for chunk data and final authorization snapshots", async (t) => {
  const f = await fixture(t),
    prepare = f.env.DB.prepare.bind(f.env.DB);
  let snapshots = 0;
  const reordered = (row) =>
    row && Object.fromEntries(Object.entries(row).reverse());
  f.env.DB.prepare = (sql) => ({
    bind(...args) {
      const statement = prepare(sql).bind(...args);
      return {
        async first() {
          const row = await statement.first();
          return ++snapshots % 2 === 0 ? reordered(row) : row;
        },
        async all() {
          const result = await statement.all();
          return { ...result, results: result.results.map(reordered) };
        },
      };
    },
  });
  assert.equal((await f.load()).chunks.length, 2);
  assert.equal(snapshots, 2);
});
for (const transform of [
  (row) => ({ ...row, unexpected: "private-data" }),
  (row) => {
    const copy = { ...row };
    delete copy.chunk_sha256;
    return copy;
  },
  (row) => ({ ...row, chunk_index: String(row.chunk_index) }),
])
  test("semantic row equality still rejects missing/extra fields and primitive type changes", async (t) => {
    const f = await fixture(t),
      prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = (sql) => ({
      bind(...args) {
        const statement = prepare(sql).bind(...args);
        return {
          ...statement,
          async all() {
            const result = await statement.all();
            return { ...result, results: result.results.map(transform) };
          },
        };
      },
    });
    await assert.rejects(f.load(), { code: "prepared_index_mismatch" });
  });
test("20,000 legal chunks survive twenty bounded pages without coverage truncation", async (t) => {
  const f = await fixture(t, { count: 20000 });
  const result = await f.load();
  assert.equal(result.chunks.length, 20000);
  assert.equal(result.chunks.at(-1).sourceLocator.page, 20000);
  assert.equal(f.calls.d1, 22);
  assert.equal(f.calls.get, 1);
});
test("unpublished complete or partial staging is never readable", async (t) => {
  const f = await fixture(t, { publish: false });
  await assert.rejects(f.load(), { code: "prepared_unavailable" });
  assert.equal(f.calls.get, 0);
  f.db.exec(
    "DROP TRIGGER shelf_prepared_chunks_delete; DELETE FROM shelf_prepared_index_chunks WHERE chunk_index=1",
  );
  assert.throws(f.publishIndex, /prepared_index_incomplete/);
});
test("header, chunks and publications are immutable and publication closes admission", async (t) => {
  const f = await fixture(t);
  for (const table of [
    "shelf_prepared_indexes",
    "shelf_prepared_index_chunks",
    "shelf_prepared_index_publications",
  ]) {
    assert.throws(
      () => f.db.exec(`DELETE FROM ${table}`),
      /prepared_index_immutable/,
    );
    assert.throws(
      () => f.db.exec(`UPDATE ${table} SET scope=scope`),
      /prepared_index_immutable/,
    );
  }
  assert.throws(
    () => f.insertChunk(f.index.chunks[0]),
    /prepared_index_invalid/,
  );
});
test("all persisted counts, offsets and time reject fractional and null SQL values", async (t) => {
  const f = await fixture(t, { publish: false });
  const insert = (table, row) =>
    f.db
      .prepare(
        `INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
      )
      .run(...Object.values(row));
  for (const key of [
    "chunk_count",
    "text_bytes",
    "codepoint_count",
    "created_at",
  ]) {
    for (const value of [1.5, null])
      assert.throws(
        () => insert("shelf_prepared_indexes", { ...f.header, [key]: value }),
        /CHECK|NOT NULL|prepared_/,
      );
  }
  const row = {
    scope: "production",
    file_id: FILE,
    version_hash: f.pin.versionHash,
    ...preparedChunkRow(f.index.chunks[0]),
  };
  for (const key of [
    "chunk_index",
    "section_number",
    "start_offset",
    "end_offset",
    "codepoints",
    "utf8_bytes",
  ]) {
    for (const value of [1.5, null])
      assert.throws(
        () => insert("shelf_prepared_index_chunks", { ...row, [key]: value }),
        /CHECK|NOT NULL|prepared_/,
      );
  }
  const publication = {
    scope: "production",
    file_id: FILE,
    version_hash: f.pin.versionHash,
    index_sha256: f.index.indexSha256,
    chunk_count: f.index.chunkCount,
    text_bytes: f.index.textBytes,
    codepoint_count: f.index.codepointCount,
  };
  for (const key of ["chunk_count", "text_bytes", "codepoint_count"]) {
    for (const value of [1.5, null])
      assert.throws(
        () =>
          insert("shelf_prepared_index_publications", {
            ...publication,
            [key]: value,
          }),
        /CHECK|NOT NULL|prepared_/,
      );
  }
  for (const key of [
    "file_id",
    "version_hash",
    "package_sha256",
    "source_sha256",
    "etag",
    "index_sha256",
  ])
    assert.throws(
      () => insert("shelf_prepared_indexes", { ...f.header, [key]: null }),
      /CHECK|NOT NULL|prepared_/,
    );
});
for (const [label, mutation] of [
  ["disabled original", "UPDATE shelf_storage_original_registry SET enabled=0"],
  ["original hash drift", "UPDATE file_registry SET sha256='bad'"],
  [
    "text unverified",
    "UPDATE shelf_storage_reservations SET content_verified=0 WHERE reservation_id='text'",
  ],
  ["wrong book", "UPDATE file_registry SET book_id='book_aaaaaaaaaaaaaaaa'"],
  [
    "removed catalog file",
    "UPDATE catalog_books SET public_json='{\"files\":[]}'",
  ],
  [
    "catalog ineligible",
    "UPDATE catalog_books SET public_json=json_set(public_json,'$.files[0].status','metadata-only')",
  ],
  [
    "catalog source size drift",
    "UPDATE catalog_books SET public_json=json_set(public_json,'$.files[0].sizeBytes',26)",
  ],
  ["trash", "UPDATE book_management SET trashed=1"],
  ["logout", "UPDATE sessions SET revoked=1"],
  ["generation", "UPDATE auth_config SET generation=2"],
])
  test(`${label} refuses before R2 and prevents new projection`, async (t) => {
    const f = await fixture(t);
    f.db.exec(mutation);
    await assert.rejects(f.load(), { code: "prepared_unavailable" });
    assert.equal(f.calls.get + f.calls.head, 0);
  });
for (const field of [
  "PREPARED_TEXT_MODE",
  "PREPARED_BOOKS",
  "PREPARED_R2_ACCOUNT_ID",
  "PREPARED_R2_BUCKET",
])
  test(`missing ${field} fails with zero R2`, async (t) => {
    const f = await fixture(t);
    delete f.env[field];
    await assert.rejects(f.load(), { code: "prepared_unconfigured" });
    assert.equal(f.calls.head, 0);
  });
test("authority target drift and cross-book/version selection have zero R2", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadPreparedForJob(
      f.env,
      { ...f.grant, bookId: "book_aaaaaaaaaaaaaaaa" },
      f.selected,
    ),
    { code: "prepared_unavailable" },
  );
  await assert.rejects(
    loadPreparedForJob(f.env, f.grant, {
      ...f.selected,
      versionHash: "a".repeat(64),
    }),
    { code: "prepared_unavailable" },
  );
  f.db.exec(
    `UPDATE shelf_storage_authority SET identity_json='{"schemaVersion":1,"authorityId":"shelf-remote-storage-v1","accountId":"${"a".repeat(32)}","bucket":"the-shelf-first-book-20261023"}'`,
  );
  await assert.rejects(f.load(), { code: "prepared_unavailable" });
  assert.equal(f.calls.head, 0);
});
test("exact selection rejects hidden keys and malformed IDs before R2", async (t) => {
  const f = await fixture(t);
  for (const selected of [
    { ...f.selected, objectKey: "other" },
    { ...f.selected, fileId: "../private" },
    { ...f.selected, versionHash: "bad" },
  ]) {
    await assert.rejects(loadPreparedForJob(f.env, f.grant, selected), {
      code: "invalid_prepared_selection",
    });
  }
  assert.equal(f.calls.head, 0);
});
for (const mutation of [
  "UPDATE sessions SET revoked=1",
  "UPDATE book_management SET version=version+1",
  "UPDATE file_registry SET state='disabled'",
  "UPDATE file_registry SET version=version+1",
  "UPDATE catalog_books SET public_json=json_set(public_json,'$.files[0].status','metadata-only')",
  "UPDATE shelf_storage_text_registry SET enabled=0",
])
  test(`authorization changes during R2 await discard complete result: ${mutation}`, async (t) => {
    const f = await fixture(t),
      get = f.env.PREPARED_BOOKS.get;
    f.env.PREPARED_BOOKS.get = async (...args) => {
      const result = await get(...args);
      f.db.exec(mutation);
      return result;
    };
    await assert.rejects(f.load(), { code: "prepared_access_changed" });
  });
test("post-read snapshot includes exact original descriptor and etag facts", async (t) => {
  const f = await fixture(t),
    get = f.env.PREPARED_BOOKS.get;
  f.env.PREPARED_BOOKS.get = async (...args) => {
    const result = await get(...args);
    f.db
      .exec(`UPDATE shelf_storage_original_registry SET descriptor_json=json_set(descriptor_json,'$.newInternalField',1),etag='changed-etag';
      UPDATE shelf_storage_reservations SET descriptor_json=json_set(descriptor_json,'$.newInternalField',1),etag='changed-etag' WHERE reservation_id='original';
      UPDATE file_registry SET etag='changed-etag'`);
    return result;
  };
  await assert.rejects(f.load(), { code: "prepared_access_changed" });
});
for (const mutation of [
  "DELETE FROM shelf_prepared_index_chunks WHERE chunk_index=1",
  "UPDATE shelf_prepared_index_chunks SET chunk_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
  "UPDATE shelf_prepared_index_chunks SET section_number=8",
])
  test(`independent row comparison rejects corrupt index: ${mutation}`, async (t) => {
    const f = await fixture(t);
    f.db.exec(
      "DROP TRIGGER shelf_prepared_chunks_update; DROP TRIGGER shelf_prepared_chunks_delete;",
    );
    f.db.exec(mutation);
    await assert.rejects(f.load(), { code: "prepared_index_mismatch" });
  });
test("extra out-of-range rows cannot hide beyond the last bounded page", async (t) => {
  const f = await fixture(t);
  f.db.exec("DROP TRIGGER shelf_prepared_chunk_insert");
  const row = {
    scope: "production",
    file_id: FILE,
    version_hash: f.pin.versionHash,
    ...preparedChunkRow(f.index.chunks[0]),
    chunk_index: 2,
  };
  f.db
    .prepare(
      `INSERT INTO shelf_prepared_index_chunks(${Object.keys(row).join(",")}) VALUES(${Object.keys(
        row,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(row));
  await assert.rejects(f.load(), { code: "prepared_index_mismatch" });
  assert.equal(f.calls.head, 0);
});
test("wrong and changed HEAD refuse and never dispatch a PUT", async (t) => {
  const f = await fixture(t);
  f.env.PREPARED_BOOKS.head = async () => ({ size: 1, etag: "wrong" });
  await assert.rejects(f.load(), { code: "prepared_object_changed" });
  assert.equal(f.calls.get, 0);
});
test("second HEAD drift discards fully read and hashed bytes", async (t) => {
  const f = await fixture(t),
    head = f.env.PREPARED_BOOKS.head;
  f.env.PREPARED_BOOKS.head = async (...args) => {
    const result = await head(...args);
    return f.calls.head === 2 ? { ...result, etag: "changed" } : result;
  };
  await assert.rejects(f.load(), { code: "prepared_object_changed" });
  assert.equal(f.calls.get, 1);
});
test("tampered object, oversized stream and truncated stream fail safely", async (t) => {
  const f = await fixture(t);
  for (const body of [
    Uint8Array.from(f.bytes, (v, i) => (i === 8 ? 1 : v)),
    new Uint8Array(f.bytes.length + 1),
    f.bytes.slice(0, -1),
  ]) {
    f.env.PREPARED_BOOKS.get = async () => ({
      size: f.bytes.length,
      etag: f.header.etag,
      body: new Response(body).body,
    });
    await assert.rejects(f.load(), (e) =>
      ["prepared_object_changed", "prepared_read_limit"].includes(e.code),
    );
  }
});
test("deadline covers a hanging body and never waits for a hanging cancel", async (t) => {
  const f = await fixture(t);
  let cancelled = 0;
  f.env.PREPARED_BOOKS.get = async () => ({
    size: f.bytes.length,
    etag: f.header.etag,
    body: new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled++;
        return new Promise(() => {});
      },
    }),
  });
  await assert.rejects(f.load({ deadlineMs: 10 }), {
    code: "prepared_read_unknown",
  });
  assert.equal(cancelled, 1);
});
test("response arriving after deadline is cancelled without returning private data", async (t) => {
  const f = await fixture(t);
  let resolve,
    cancelled = 0;
  f.env.PREPARED_BOOKS.get = () =>
    new Promise((done) => {
      resolve = done;
    });
  await assert.rejects(f.load({ deadlineMs: 10 }), {
    code: "prepared_read_unknown",
  });
  resolve({
    size: f.bytes.length,
    etag: f.header.etag,
    body: new ReadableStream({
      cancel() {
        cancelled++;
      },
    }),
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, 1);
});
test("owner chapters and authenticated search expose only bounded source projections", async (t) => {
  const f = await fixture(t);
  for (const search of [false, true]) {
    const response = await preparedRoute(
        await f.request(search),
        f.env,
        context,
        f.session,
      ),
      raw = await response.text(),
      value = JSON.parse(raw);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(encoder.encode(raw).length <= 65536);
    assert.equal(value.fileId, FILE);
    for (const forbidden of [
      "sourceSha256",
      "source_sha256",
      "package_sha256",
      "objectKey",
      "etag",
      "mtimeNs",
      "descriptor",
      "reservation",
      f.pin.sourceSha256,
      f.descriptor.objectKey,
    ])
      assert.equal(raw.includes(forbidden), false, forbidden);
    if (search) {
      assert.equal(value.matches.length, 1);
      assert.match(value.matches[0].excerpt, /磁流体/);
    } else assert.equal(value.chapters.length, 2);
  }
});
test("anonymous, CSRF and foreign Origin requests refuse before R2", async (t) => {
  const f = await fixture(t);
  await assert.rejects(preparedRoute(await f.request(), f.env, context, null), {
    code: "authentication_required",
  });
  const search = await f.request(true);
  search.headers.set("x-csrf-token", "wrong");
  await assert.rejects(preparedRoute(search, f.env, context, f.session), {
    code: "csrf_invalid",
  });
  const foreign = await f.request();
  foreign.headers.set("origin", "https://foreign.invalid");
  await assert.rejects(preparedRoute(foreign, f.env, context, f.session), {
    code: "origin_forbidden",
  });
  assert.equal(f.calls.head, 0);
});
test("duplicate query fields, invalid chapter cursor and unexpected search fields fail closed", async (t) => {
  const f = await fixture(t),
    base = `${context.origin}/api/books/${BOOK}/prepared?fileId=${FILE}&versionHash=${f.pin.versionHash}`;
  for (const suffix of [`&fileId=${FILE}`, "&cursor=1.5", "&key=secret"])
    await assert.rejects(
      preparedRoute(new Request(base + suffix), f.env, context, f.session),
      { code: "invalid_prepared_selection" },
    );
  const original = await f.request(true),
    headers = original.headers;
  await assert.rejects(
    preparedRoute(
      new Request(original.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...f.selected,
          question: "topic",
          objectKey: "arbitrary",
        }),
      }),
      f.env,
      context,
      f.session,
    ),
    { code: "invalid_question" },
  );
  assert.equal(f.calls.head, 0);
});
test("chapter pagination preserves real page/spine locators and unrelated queries return no snippets", async (t) => {
  const f = await fixture(t, { count: 40 });
  const url = (await f.request()).url + "&cursor=32";
  const data = await (
    await preparedRoute(new Request(url), f.env, context, f.session)
  ).json();
  assert.equal(data.chapterCount, 40);
  assert.equal(data.chapters.length, 8);
  assert.equal(data.chapters[0].sourceLocator.page, 33);
  assert.equal(data.nextCursor, null);
  const original = await f.request(true);
  const request = new Request(original.url, {
    method: "POST",
    headers: original.headers,
    body: JSON.stringify({ ...f.selected, question: "毫不相关的宇宙话题" }),
  });
  const search = await (
    await preparedRoute(request, f.env, context, f.session)
  ).json();
  assert.deepEqual(search.matches, []);
});

async function workerFixture(t) {
  const f = await fixture(t);
  // Install the production admission tables and triggers verbatim from SQLite's
  // parsed base schema. Existing source fixtures remain independent of budgets.
  const base = new DatabaseSync(":memory:");
  try {
    base.exec(
      readFileSync(
        new URL("../cloudflare/library/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    for (const name of [
      "counters",
      "admissions",
      "admit_api",
      "admission_private",
      "admit_access",
    ])
      f.db.exec(
        base.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)
          .sql,
      );
  } finally {
    base.close();
  }
  Object.assign(f.env, {
    APP_SCOPE: "production",
    SITE_ORIGIN: context.origin,
    OWNER_KEY_PEPPER: randomKey(),
  });
  const digest = await sessionDigest(
    f.session.token,
    f.env.SESSION_SECRET,
    context,
  );
  f.db.prepare("UPDATE sessions SET session_hash=?").run(digest);
  f.session.session_hash = digest;
  f.route = async (search = false, headers = {}) => {
    const req = await f.request(search);
    req.headers.set("cookie", `__Host-shelf_session=${f.session.token}`);
    for (const [key, value] of Object.entries(headers))
      value === null ? req.headers.delete(key) : req.headers.set(key, value);
    return handleRequest(req, f.env);
  };
  f.count = (kind) =>
    f.db.prepare("SELECT count(*) AS n FROM admissions WHERE kind=?").get(kind)
      .n;
  return f;
}
for (const search of [false, true])
  test(`Worker ${search ? "search" : "chapters"} admits API/access exactly once with real SQLite budgets`, async (t) => {
    const f = await workerFixture(t),
      result = await f.route(search),
      raw = await result.text();
    assert.equal(result.status, 200, raw);
    assert.equal(f.count("api"), 1);
    assert.equal(f.count("access"), 1);
    assert.equal(
      f.db.prepare("SELECT count FROM counters WHERE kind='api_day'").get()
        .count,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT count FROM counters WHERE kind='access_day'").get()
        .count,
      1,
    );
    assert.deepEqual([f.calls.head, f.calls.get], [2, 1]);
    for (const forbidden of [
      f.descriptor.objectKey,
      f.pin.sourceSha256,
      f.header.package_sha256,
      "reservation",
      "etag",
      "mtimeNs",
    ])
      assert.equal(raw.includes(forbidden), false, forbidden);
  });
for (const [label, prepare, search, headers, status] of [
  ["anonymous", () => {}, false, { cookie: null }, 401],
  ["foreign Origin", () => {}, false, { origin: "https://wrong.invalid" }, 403],
  ["CSRF", () => {}, true, { "x-csrf-token": "wrong" }, 403],
  ["missing capability", (f) => delete f.env.PREPARED_BOOKS, false, {}, 503],
  [
    "source drift",
    (f) =>
      f.db.exec(
        "UPDATE file_registry SET version=version+1; UPDATE file_registry SET state='disabled'",
      ),
    false,
    {},
    409,
  ],
  [
    "revoked session",
    (f) => f.db.exec("UPDATE sessions SET revoked=1"),
    false,
    {},
    401,
  ],
  [
    "access budget",
    (f) =>
      f.db
        .prepare(
          "INSERT INTO counters VALUES('production','access_day','global',?,1000,1000)",
        )
        .run(Math.floor(Date.now() / 86400000)),
    false,
    {},
    429,
  ],
  [
    "API budget",
    (f) =>
      f.db
        .prepare(
          "INSERT INTO counters VALUES('production','api_day','global',?,1000,1000)",
        )
        .run(Math.floor(Date.now() / 86400000)),
    false,
    {},
    429,
  ],
])
  test(`Worker ${label} rejects without R2 or private output`, async (t) => {
    const f = await workerFixture(t);
    prepare(f);
    const response = await f.route(search, headers),
      raw = await response.text();
    assert.equal(response.status, status, raw);
    assert.deepEqual([f.calls.head, f.calls.get], [0, 0]);
    assert.equal(f.count("access"), 0);
    assert.deepEqual(Object.keys(JSON.parse(raw)), ["error"]);
    assert.equal(raw.includes(f.descriptor.objectKey), false);
  });
for (const search of [false, true])
  test(`Worker missing 010 ${search ? "search" : "chapters"} fails closed with zero R2`, async (t) => {
    const f = await workerFixture(t);
    f.db.exec(
      "DROP VIEW shelf_prepared_readable_sources; DROP TABLE shelf_prepared_index_publications; DROP TABLE shelf_prepared_index_chunks; DROP TABLE shelf_prepared_indexes;",
    );
    const response = await f.route(search),
      raw = await response.text();
    assert.equal(response.status, 503, raw);
    assert.deepEqual([f.calls.head, f.calls.get], [0, 0]);
    assert.equal(f.count("api"), 1);
    assert.equal(f.count("access"), 0);
    assert.deepEqual(Object.keys(JSON.parse(raw)), ["error"]);
    assert.equal(raw.includes(f.descriptor.objectKey), false);
  });
test("Worker drops private result after source changes during object read and keeps one admission", async (t) => {
  const f = await workerFixture(t),
    get = f.env.PREPARED_BOOKS.get;
  f.env.PREPARED_BOOKS.get = async (...args) => {
    const result = await get(...args);
    f.db.exec("UPDATE file_registry SET version=version+1");
    return result;
  };
  const response = await f.route(),
    raw = await response.text();
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(raw), {
    error: { code: "prepared_access_changed" },
  });
  assert.equal(f.count("api"), 1);
  assert.equal(f.count("access"), 1);
});
