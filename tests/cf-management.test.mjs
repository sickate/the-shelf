import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import { createOwnerVerifier } from "../cloudflare/library/security.mjs";
import {
  boundedUploadBytes,
  validateUploadMagic,
} from "../cloudflare/library/management.mjs";
import { snapshot } from "../scripts/cf-library-operations.mjs";
import {
  epubFixture,
  mobiFixture,
  kf8Fixture,
} from "./fixtures/ebook/synthetic.mjs";
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev",
  ACCOUNT = "a".repeat(32),
  BYTES = Buffer.from("%PDF-1.7\nSynthetic management fixture\n%%EOF");
const sha = (x) => createHash("sha256").update(x).digest("hex");
class D1 {
  constructor(sql) {
    this.sql = sql;
    this.failClaim = false;
  }
  prepare(sql) {
    const db = this;
    const make = (args = []) => ({
      bind: (...a) => make(a),
      first: async () => db.sql.prepare(sql).get(...args) || null,
      all: async () => ({ results: db.sql.prepare(sql).all(...args) }),
      run: async () => ({ meta: db.sql.prepare(sql).run(...args) }),
      execute: () => ({
        results: db.sql.prepare(sql).all(...args),
        claim: sql.includes("SET state='uploading'"),
      }),
    });
    return make();
  }
  async batch(statements) {
    this.sql.exec("BEGIN");
    let result;
    try {
      result = statements.map((s) => s.execute());
      this.sql.exec("COMMIT");
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
    if (this.failClaim && result.some((r) => r.claim)) {
      this.failClaim = false;
      throw Error("lost durable claim response");
    }
    return result;
  }
}
async function fixture(t, { ready = true, observedAt = Date.now() - 5 } = {}) {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  for (const p of [
    "schema.sql",
    "migrations/007-book-management.sql",
    "migrations/003-storage-authority.sql",
    "migrations/004-freeze-legacy-storage.sql",
  ])
    sql.exec(
      readFileSync(
        new URL("../cloudflare/library/" + p, import.meta.url),
        "utf8",
      ),
    );
  const identity = {
    schemaVersion: 1,
    authorityId: "shelf-remote-storage-v1",
    accountId: ACCOUNT,
    bucket: "the-shelf-books",
    legacyDatabases: {
      check: "11111111-1111-4111-8111-111111111111",
      production: "22222222-2222-4222-8222-222222222222",
    },
  };
  sql
    .prepare(
      "INSERT INTO shelf_storage_authority(id,identity_json,phase)VALUES(1,?,'migration_required')",
    )
    .run(JSON.stringify(identity));
  for (const scope of ["check", "production"])
    sql
      .prepare("INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run(scope, "f".repeat(64), "e".repeat(64), "{}", "{}", 0, 0, 0, 0);
  sql
    .prepare(
      "UPDATE shelf_storage_authority SET phase='imported',migration_hash=? WHERE id=1",
    )
    .run("f".repeat(64));
  const proof = {
    migrationHash: "f".repeat(64),
    readbackSha256: "d".repeat(64),
    cloudWriteFreezeProven: true,
    databaseWriteFreezeProven: true,
    sourceProjectionVerified: true,
    writeClosureProof: {
      schemaVersion: 1,
      legacyConnectionsClosed: true,
      legacyProcessesStopped: true,
      legacyEntryPointsDisabled: true,
      probeWriteCapabilityDisabled: true,
      connectionEvidenceSha256: "a".repeat(64),
      deadlineMs: 60000,
      stoppedAt: 1,
      drainedAt: 60001,
      drainBound: {
        source: "enforced-transport-deadline",
        configurationSha256: "b".repeat(64),
        maxRequestLifetimeMs: 60000,
      },
    },
  };
  if (ready)
    sql
      .prepare(
        "UPDATE shelf_storage_authority SET phase='ready',readback_hash=?,receipt_json=?,observed_bytes=0,observed_at=?,evidence_hash=?,billing_period=? WHERE id=1",
      )
      .run(
        "d".repeat(64),
        JSON.stringify(proof),
        observedAt,
        "c".repeat(64),
        new Date().toISOString().slice(0, 7),
      );
  const owner = Buffer.alloc(32, 1).toString("base64url"),
    pepper = Buffer.alloc(32, 2).toString("base64url"),
    secret = Buffer.alloc(32, 3).toString("base64url"),
    db = new D1(sql),
    objects = new Map();
  let puts = 0;
  let beforeGet = () => {},
    beforeHead = () => {};
  const head = (o) =>
    o
      ? {
          size: o.bytes.length,
          etag: "fixtureetag",
          httpEtag: '"fixtureetag"',
          httpMetadata: o.options.httpMetadata,
          customMetadata: o.options.customMetadata,
        }
      : null;
  const env = {
    APP_SCOPE: "production",
    SITE_ORIGIN: ORIGIN,
    DB: db,
    OWNER_KEY_PEPPER: pepper,
    SESSION_SECRET: secret,
    NORMAL_UPLOAD_MODE: "authority-v1",
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: "the-shelf-books",
    BOOKS: {
      async put(k, b, options) {
        puts++;
        objects.set(k, { bytes: Uint8Array.from(b), options });
        return head(objects.get(k));
      },
      async head(k) {
        await beforeHead();
        return head(objects.get(k));
      },
      async get(k, options) {
        await beforeGet();
        const o = objects.get(k);
        if (!o) return null;
        const r = options?.range;
        return {
          ...head(o),
          ...(r ? { range: r } : {}),
          body: new Response(
            r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes,
          ).body,
        };
      },
    },
  };
  sql.prepare("INSERT INTO auth_config VALUES(?,?,?,?,?,?,?)").run(
    "production",
    ORIGIN,
    "owner-access-key-v1",
    await createOwnerVerifier(owner, pepper, {
      scope: "production",
      origin: ORIGIN,
    }),
    1,
    1,
    Date.now(),
  );
  const send = (
    path,
    { body, binary, session = true, headers = {}, method } = {},
  ) =>
    handleRequest(
      new Request(ORIGIN + path, {
        method: method || (body !== undefined || binary ? "POST" : "GET"),
        headers: {
          Origin: ORIGIN,
          "CF-Connecting-IP": "192.0.2.1",
          ...(session && auth
            ? { Cookie: auth.cookie, "X-CSRF-Token": auth.csrf }
            : {}),
          ...(binary
            ? { "Content-Type": "application/octet-stream" }
            : body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          ...headers,
        },
        ...(binary
          ? { body: binary, duplex: "half" }
          : body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
      }),
      env,
    );
  let auth;
  const login = await send("/api/login", {
    body: { accessKey: owner },
    session: false,
  });
  assert.equal(login.status, 200);
  auth = {
    cookie: login.headers.get("set-cookie").split(";")[0],
    csrf: (await login.json()).csrfToken,
  };
  const descriptor = {
    title: "Private synthetic book",
    author: null,
    category: "Tests",
    file: {
      name: "synthetic.pdf",
      format: "PDF",
      sizeBytes: BYTES.length,
      sha256: sha(BYTES),
    },
  };
  async function intent() {
    const r = await send("/api/manage/uploads", { body: descriptor });
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  }
  return {
    sql,
    db,
    env,
    send,
    auth,
    descriptor,
    intent,
    puts: () => puts,
    objects,
    onGet: (f) => (beforeGet = f),
    onHead: (f) => (beforeHead = f),
  };
}
test("normal ready upload uses unique authority, keeps private catalog out of public snapshot, and proxies bytes", async (t) => {
  const f = await fixture(t),
    intent = await f.intent();
  assert.equal(intent.upload.canSubmit, true);
  const repeated = await f.send("/api/manage/uploads", { body: f.descriptor });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).upload.canSubmit, false);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM shelf_storage_reservations").get().n,
    1,
  );
  assert.equal(
    (await f.send("/api/books/" + intent.bookId, { session: false })).status,
    404,
  );
  const snap = await snapshot(
    { query: async (s, p = []) => f.sql.prepare(s).all(...p) },
    "production",
  );
  assert.equal(snap.catalog.books.length, 0);
  const response = await f.send(intent.upload.bytesUrl, { binary: BYTES });
  assert.equal(response.status, 201, await response.clone().text());
  const uploaded = await response.json();
  assert.equal(uploaded.book.files[0].reason, "uploaded");
  assert.equal(f.puts(), 1);
  assert.deepEqual(
    {
      ...f.sql
        .prepare(
          "SELECT reserved_bytes,committed_bytes FROM shelf_storage_authority",
        )
        .get(),
    },
    { reserved_bytes: 0, committed_bytes: BYTES.length },
  );
  assert.equal(
    f.sql
      .prepare(
        "SELECT count(*) n FROM shelf_storage_original_registry WHERE enabled=1",
      )
      .get().n,
    1,
  );
  const access = await f.send(`/api/files/${intent.fileId}/access`);
  assert.equal(access.status, 200);
  const link = await access.json();
  assert.equal(link.url, `/api/files/${intent.fileId}/content`);
  const content = await f.send(link.url);
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), BYTES);
  const range = await f.send(link.url, { headers: { Range: "bytes=0-4" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "%PDF-");
  assert.equal(
    (await f.send(intent.upload.bytesUrl, { binary: BYTES })).status,
    409,
  );
  assert.equal(f.puts(), 1);
});
test("unknown evidence, target mismatch, budget and invalid sizes never reserve or PUT", async (t) => {
  const f = await fixture(t, { ready: false });
  let r = await f.send("/api/manage/uploads", { body: f.descriptor });
  assert.equal(r.status, 409);
  assert.ok((await r.json()).upload.reasons.includes("authority_not_ready"));
  assert.equal(f.puts(), 0);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM shelf_storage_reservations").get().n,
    0,
  );
  const g = await fixture(t);
  g.env.R2_BUCKET = "the-shelf-first-book-20261023";
  r = await g.send("/api/manage/uploads", { body: g.descriptor });
  assert.equal(r.status, 409);
  assert.ok(
    (await r.json()).upload.reasons.includes("storage_target_mismatch"),
  );
  const h = await fixture(t, { observedAt: Date.now() - 300001 });
  assert.equal(
    (await h.send("/api/manage/uploads", { body: h.descriptor })).status,
    409,
  );
  const i = await fixture(t);
  i.sql.exec("UPDATE shelf_storage_authority SET observed_bytes=8000000000");
  assert.equal(
    (await i.send("/api/manage/uploads", { body: i.descriptor })).status,
    409,
  );
  const j = await fixture(t);
  for (const size of [0, 20000001]) {
    j.descriptor.file.sizeBytes = size;
    assert.equal(
      (await j.send("/api/manage/uploads", { body: j.descriptor })).status,
      400,
    );
  }
  assert.equal(j.puts(), 0);
});
test("auth, Origin and CSRF guard management and binary before mutation", async (t) => {
  const f = await fixture(t),
    intent = await f.intent();
  assert.equal((await f.send("/api/manage", { session: false })).status, 401);
  for (const headers of [
    { Origin: "https://evil.example" },
    { "X-CSRF-Token": "bad" },
  ]) {
    assert.equal(
      (
        await f.send("/api/manage/books/" + intent.bookId + "/trash", {
          body: { expectedVersion: 1 },
          headers,
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.send(intent.upload.bytesUrl, { binary: BYTES, headers })).status,
      403,
    );
  }
  assert.equal(f.puts(), 0);
  await f.send("/api/logout", { body: {} });
  assert.equal(
    (await f.send(intent.upload.bytesUrl, { binary: BYTES })).status,
    401,
  );
});
test("invalid hash/magic, concurrent bytes and lost durable claim cannot issue a second PUT", async (t) => {
  const f = await fixture(t),
    intent = await f.intent();
  assert.equal(
    (
      await f.send(intent.upload.bytesUrl, {
        binary: Buffer.alloc(BYTES.length),
      })
    ).status,
    400,
  );
  assert.equal(f.puts(), 0);
  const results = await Promise.all([
    f.send(intent.upload.bytesUrl, { binary: BYTES }),
    f.send(intent.upload.bytesUrl, { binary: BYTES }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(f.puts(), 1);
  const g = await fixture(t),
    second = await g.intent();
  g.db.failClaim = true;
  assert.equal(
    (await g.send(second.upload.bytesUrl, { binary: BYTES })).status,
    503,
  );
  assert.equal(g.puts(), 0);
  assert.equal(
    (await g.send(second.upload.bytesUrl, { binary: BYTES })).status,
    409,
  );
  assert.equal(g.puts(), 0);
  assert.equal(
    g.sql.prepare("SELECT reserved_bytes FROM shelf_storage_authority").get()
      .reserved_bytes,
    BYTES.length,
  );
  const h = await fixture(t);
  h.descriptor.file.sha256 = sha(Buffer.alloc(BYTES.length));
  const third = await h.intent();
  assert.equal(
    (
      await h.send(third.upload.bytesUrl, {
        binary: Buffer.alloc(BYTES.length),
      })
    ).status,
    400,
  );
  assert.equal(h.puts(), 0);
});
test("unverified or lost PUT stays uncertain and reserved without automatic retry or deletion", async (t) => {
  const f = await fixture(t),
    intent = await f.intent();
  f.env.BOOKS.put = async () => {
    throw Error("lost PUT response");
  };
  const r = await f.send(intent.upload.bytesUrl, { binary: BYTES });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).upload.state, "uncertain");
  assert.equal(
    f.sql.prepare("SELECT state FROM shelf_storage_reservations").get().state,
    "uncertain",
  );
  assert.equal(
    f.sql.prepare("SELECT reserved_bytes FROM shelf_storage_authority").get()
      .reserved_bytes,
    BYTES.length,
  );
  assert.equal(
    (await f.send(intent.upload.bytesUrl, { binary: BYTES })).status,
    409,
  );
  const g = await fixture(t),
    i = await g.intent();
  g.onGet(() => {
    for (const o of g.objects.values()) o.bytes[0] = 0;
  });
  assert.equal(
    (await g.send(i.upload.bytesUrl, { binary: BYTES })).status,
    409,
  );
  assert.equal(g.puts(), 1);
  assert.equal(
    g.sql.prepare("SELECT state FROM shelf_storage_reservations").get().state,
    "uncertain",
  );
});
test("trash and restore use CAS, hide metadata and proxy content, preserve original object and authority", async (t) => {
  const f = await fixture(t),
    intent = await f.intent();
  await f.send(intent.upload.bytesUrl, { binary: BYTES });
  const before = f.sql.prepare("SELECT * FROM shelf_storage_authority").get(),
    objectCount = f.objects.size;
  let r = await f.send("/api/manage/books/" + intent.bookId + "/trash", {
    body: { expectedVersion: 1 },
  });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).managementVersion, 2);
  assert.equal((await f.send("/api/books/" + intent.bookId)).status, 404);
  assert.equal(
    (await f.send(`/api/files/${intent.fileId}/content`)).status,
    409,
  );
  assert.equal(
    (
      await f.send("/api/books/" + intent.bookId + "/metadata", {
        body: { expectedVersion: 0, changes: { title: "Changed" } },
      })
    ).status,
    404,
  );
  const list = await (await f.send("/api/manage")).json();
  assert.equal(list.books[0].trashed, true);
  r = await f.send("/api/manage/books/" + intent.bookId + "/restore", {
    body: { expectedVersion: 1 },
  });
  assert.equal(r.status, 409);
  r = await f.send("/api/manage/books/" + intent.bookId + "/restore", {
    body: { expectedVersion: 2 },
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await f.send(`/api/files/${intent.fileId}/content`)).status,
    200,
  );
  assert.deepEqual(
    f.sql.prepare("SELECT * FROM shelf_storage_authority").get(),
    before,
  );
  assert.equal(f.objects.size, objectCount);
  assert.equal(f.puts(), 1);
});
test("post-storage-await rejects trash+restore generation changes and revoked sessions", async (t) => {
  for (const change of ["trash", "cycle", "revoke"]) {
    const f = await fixture(t),
      intent = await f.intent();
    await f.send(intent.upload.bytesUrl, { binary: BYTES });
    f.onGet(async () => {
      if (change === "revoke") f.sql.exec("UPDATE sessions SET revoked=1");
      else {
        f.sql
          .prepare(
            "UPDATE book_management SET trashed=?,version=version+1 WHERE book_id=?",
          )
          .run(change === "trash" ? 1 : 0, intent.bookId);
      }
    });
    const r = await f.send(`/api/files/${intent.fileId}/content`);
    assert.equal(r.status, change === "revoke" ? 401 : 409);
  }
});
test("body reader bounds chunks, bytes and timeout; EPUB/PalmDB magic rejects DRM", async () => {
  await assert.rejects(
    boundedUploadBytes(new Response(new Uint8Array([1, 2])).body, 1),
    (e) => e.code === "invalid_upload",
  );
  await assert.rejects(
    boundedUploadBytes(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
      1,
      { timeout: 5 },
    ),
    (e) => e.code === "upload_timeout",
  );
  const epub = new Uint8Array(58),
    v = new DataView(epub.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(26, 8, true);
  epub.set(new TextEncoder().encode("mimetypeapplication/epub+zip"), 30);
  validateUploadMagic(epub, "EPUB");
  const mobi = new Uint8Array(150),
    m = new DataView(mobi.buffer);
  mobi.set(new TextEncoder().encode("BOOKMOBI"), 60);
  m.setUint16(76, 1);
  m.setUint32(78, 86);
  mobi.set(new TextEncoder().encode("MOBI"), 102);
  for (const format of ["MOBI", "AZW", "AZW3"])
    validateUploadMagic(mobi, format);
  m.setUint16(98, 2);
  assert.throws(
    () => validateUploadMagic(mobi, "MOBI"),
    (e) => e.code === "drm_not_supported",
  );
});

test("normal authority accepts EPUB/MOBI/AZW/AZW3 original keys, content types and confirmations", async (t) => {
  for (const format of ["EPUB", "MOBI", "AZW", "AZW3"]) {
    const f = await fixture(t);
    const bytes =
      format === "EPUB"
        ? epubFixture()
        : format === "AZW3"
          ? kf8Fixture()
          : mobiFixture();
    f.descriptor.file = {
      name: "synthetic." + format.toLowerCase(),
      format,
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    };
    const i = await f.intent();
    const r = await f.send(i.upload.bytesUrl, { binary: bytes });
    assert.equal(r.status, 201, await r.clone().text());
    assert.equal(f.puts(), 1);
    assert.equal(
      f.sql.prepare("SELECT format FROM file_registry").get().format,
      format,
    );
  }
});
test("concurrent descriptor intents reserve only once and return existing intent safely", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([
    f.send("/api/manage/uploads", { body: f.descriptor }),
    f.send("/api/manage/uploads", { body: f.descriptor }),
  ]);
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM shelf_storage_reservations").get().n,
    1,
  );
  assert.equal(f.puts(), 0);
});

test("anonymous catalog-state reveals only public trash IDs, restoration removes overlay", async (t) => {
  const f = await fixture(t),
    i = await f.intent();
  await f.send("/api/manage/books/" + i.bookId + "/trash", {
    body: { expectedVersion: 1 },
  });
  const book = {
    id: "public_book",
    title: "Public",
    author: null,
    category: "Tests",
    categoryId: "cat-tests",
    description: "",
    tags: [],
    files: [],
  };
  f.sql
    .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
    .run(book.id, JSON.stringify(book));
  await f.send("/api/manage/books/public_book/trash", {
    body: { expectedVersion: 0 },
  });
  let r = await f.send("/api/catalog-state", { session: false });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { hiddenBookIds: ["public_book"] });
  await f.send("/api/manage/books/public_book/restore", {
    body: { expectedVersion: 1 },
  });
  r = await f.send("/api/catalog-state", { session: false });
  assert.deepEqual(await r.json(), { hiddenBookIds: [] });
});
test("private metadata response rechecks session after database await", async (t) => {
  const f = await fixture(t),
    i = await f.intent(),
    batch = f.db.batch.bind(f.db);
  let changed = false;
  f.db.batch = async (statements) => {
    const r = await batch(statements);
    if (!changed && r.some((v) => v.results.some((row) => row.public_json))) {
      changed = true;
      f.sql.exec("UPDATE sessions SET revoked=1");
    }
    return r;
  };
  const r = await f.send("/api/books/" + i.bookId);
  assert.equal(r.status, 401);
  assert.ok(!(await r.text()).includes("Private synthetic"));
});

test("upload success rechecks private session after final bookInfo await", async (t) => {
  const f = await fixture(t),
    i = await f.intent(),
    batch = f.db.batch.bind(f.db);
  let changed = false;
  f.db.batch = async (statements) => {
    const r = await batch(statements);
    if (!changed && r.some((v) => v.results.some((row) => row.public_json))) {
      changed = true;
      f.sql.exec("UPDATE sessions SET revoked=1");
    }
    return r;
  };
  const r = await f.send(i.upload.bytesUrl, { binary: BYTES });
  assert.equal(r.status, 401);
  assert.equal(f.puts(), 1);
  assert.equal(
    f.sql.prepare("SELECT state FROM shelf_storage_reservations").get().state,
    "confirmed",
  );
  assert.ok(!(await r.text()).includes("Private synthetic"));
});
