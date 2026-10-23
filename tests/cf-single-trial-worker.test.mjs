import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import { createOwnerVerifier } from "../cloudflare/library/security.mjs";
import { prepareObject } from "../server/storage-authority.mjs";
import { validateSingleTrialTarget } from "../scripts/single-trial-config.mjs";

const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev",
  ACCOUNT = "a".repeat(32),
  BUCKET = "the-shelf-first-book-20261023";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const key = (n) => Buffer.alloc(32, n).toString("base64url");
const BYTES = Buffer.from(
  "%PDF-1.7\nSynthetic first book only. No private material.\n",
);
class D1 {
  constructor(sql) {
    this.sql = sql;
    this.trace = [];
    this.lostClaim = false;
  }
  prepare(sql) {
    this.trace.push(sql);
    const db = this;
    const make = (args) => ({
      bind: (...a) => make(a),
      first: async () => db.sql.prepare(sql).get(...args) || null,
      all: async () => {
        const results = db.sql.prepare(sql).all(...args);
        if (
          db.lostClaim &&
          sql.startsWith(
            "UPDATE shelf_storage_single_trial SET state='uploading'",
          )
        )
          throw new Error("lost CAS");
        return { success: true, results };
      },
      run: async () => ({
        success: true,
        results: [],
        meta: db.sql.prepare(sql).run(...args),
      }),
      execute: () => ({
        success: true,
        results: db.sql.prepare(sql).all(...args),
      }),
    });
    return make([]);
  }
  async batch(statements) {
    this.sql.exec("BEGIN");
    try {
      const r = statements.map((s) => s.execute());
      this.sql.exec("COMMIT");
      return r;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
}
async function fixture(t, { confirmed = false } = {}) {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  for (const name of [
    "schema.sql",
    "migrations/003-storage-authority.sql",
    "migrations/004-freeze-legacy-storage.sql",
    "migrations/005-single-trial.sql",
    "migrations/006-single-trial-admission.sql",
  ])
    sql.exec(
      readFileSync(
        new URL("../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    );
  const db = new D1(sql),
    now = Date.now(),
    owner = key(11),
    pepper = key(22),
    session = key(33),
    upload = key(44);
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
      "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,'migration_required')",
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
  const { descriptor: d } = await prepareObject({
    kind: "original",
    scope: "production",
    fileId: "trial_file",
    bookId: "trial_book",
    format: "PDF",
    bytes: BYTES,
  });
  const target = validateSingleTrialTarget(
    {
      schemaVersion: 1,
      mode: "first-book-20261023",
      accountId: ACCOUNT,
      bucket: BUCKET,
      worker: "the-shelf",
      origin: ORIGIN,
      uploadSecretSha256: sha(upload),
    },
    ACCOUNT,
    upload,
  );
  sql
    .prepare(
      "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'reserved',0,0,NULL,?)",
    )
    .run(
      "first-book",
      "2026-10-23-first-book",
      JSON.stringify(identity),
      JSON.stringify({ accountId: ACCOUNT, bucket: BUCKET }),
      JSON.stringify(d),
      target.configSha256,
      d.sizeBytes,
      now,
      now + 60000,
      now,
    );
  const book = {
    id: d.bookId,
    title: "Synthetic",
    author: null,
    description: "",
    category: "Tests",
    categoryId: "tests",
    tags: [],
    files: [
      {
        id: d.fileId,
        format: d.format,
        sizeBytes: d.sizeBytes,
        status: "candidate",
        reason: "not_uploaded",
        visibility: "private",
        readable: true,
      },
    ],
  };
  sql
    .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
    .run(d.bookId, JSON.stringify(book));
  sql
    .prepare(
      "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,1,?)",
    )
    .run(
      ORIGIN,
      await createOwnerVerifier(owner, pepper, {
        scope: "production",
        origin: ORIGIN,
      }),
      now,
    );
  let puts = 0,
    reads = 0,
    stored = confirmed;
  const head = () => ({
    size: BYTES.length,
    etag: "syntheticetag",
    httpEtag: '"syntheticetag"',
    customMetadata: { sha256: d.sha256 },
    httpMetadata: { contentType: "application/pdf" },
  });
  const env = {
    APP_SCOPE: "production",
    SITE_ORIGIN: ORIGIN,
    OWNER_KEY_PEPPER: pepper,
    SESSION_SECRET: session,
    DB: db,
    SINGLE_TRIAL_MODE: "first-book-20261023",
    SINGLE_TRIAL_TARGET_SHA256: target.configSha256,
    SINGLE_TRIAL_UPLOAD_SECRET: upload,
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: BUCKET,
    BOOKS: {
      put: async (k, bytes, options) => {
        puts++;
        assert.equal(k, d.objectKey);
        assert.deepEqual(Buffer.from(bytes), BYTES);
        assert.equal(options.sha256, d.sha256);
        stored = true;
        return head();
      },
      head: async (k) => {
        reads++;
        assert.equal(k, d.objectKey);
        return stored ? head() : null;
      },
      get: async (k, options) => {
        reads++;
        assert.equal(k, d.objectKey);
        assert.equal(options.onlyIf.etagMatches, "syntheticetag");
        if (!stored) return null;
        const r = options.range;
        return {
          ...head(),
          ...(r ? { range: r } : {}),
          body: new Response(
            r ? BYTES.subarray(r.offset, r.offset + r.length) : BYTES,
          ).body,
        };
      },
    },
  };
  if (confirmed) {
    sql
      .prepare(
        "UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1 WHERE id=1",
      )
      .run();
    sql
      .prepare(
        "UPDATE shelf_storage_single_trial SET state='confirmed',content_verified=1,etag=? WHERE id=1",
      )
      .run('"syntheticetag"');
  }
  return {
    sql,
    db,
    env,
    owner,
    upload,
    d,
    book,
    puts: () => puts,
    reads: () => reads,
  };
}
const req = (path, { method = "GET", headers = {}, body } = {}) =>
  new Request(ORIGIN + path, {
    method,
    headers: { Origin: ORIGIN, "CF-Connecting-IP": "192.0.2.1", ...headers },
    ...(body === undefined ? {} : { body, duplex: "half" }),
  });
const operator = (f, method = "POST", body = BYTES, headers = {}) =>
  req(
    method === "POST" ? "/api/single-trial/upload" : "/api/single-trial/object",
    {
      method,
      body: method === "POST" ? body : undefined,
      headers: {
        "x-shelf-trial-secret": f.upload,
        "x-shelf-trial-permit": "first-book",
        ...(method === "POST"
          ? {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(BYTES.length),
            }
          : { "If-Match": '"syntheticetag"' }),
        ...headers,
      },
    },
  );
async function login(f) {
  const r = await handleRequest(
    req("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: f.owner }),
    }),
    f.env,
  );
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
}

test("trial upload claims real SQL once under two concurrent valid bodies", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([
    handleRequest(operator(f), f.env),
    handleRequest(operator(f), f.env),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.puts(), 1);
  assert.equal(
    f.sql.prepare("SELECT state FROM shelf_storage_single_trial").get().state,
    "uploading",
  );
  assert.equal((await handleRequest(operator(f), f.env)).status, 409);
  assert.equal(f.puts(), 1);
  assert.equal(
    f.sql.prepare("SELECT phase FROM shelf_storage_authority").get().phase,
    "imported",
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM file_registry").get().n,
    0,
  );
});
test("lost claim response consumes SQL reservation and performs zero PUT, including replay", async (t) => {
  const f = await fixture(t);
  f.db.lostClaim = true;
  assert.equal((await handleRequest(operator(f), f.env)).status, 503);
  f.db.lostClaim = false;
  assert.equal((await handleRequest(operator(f), f.env)).status, 409);
  assert.equal(f.puts(), 0);
  assert.equal(
    f.sql.prepare("SELECT put_attempted FROM shelf_storage_single_trial").get()
      .put_attempted,
    1,
  );
});
test("lost PUT stays consumed and never retried or deleted", async (t) => {
  const f = await fixture(t);
  let puts = 0;
  f.env.BOOKS.put = async () => {
    puts++;
    throw new Error("response lost");
  };
  assert.equal((await handleRequest(operator(f), f.env)).status, 503);
  assert.equal((await handleRequest(operator(f), f.env)).status, 409);
  assert.equal(puts, 1);
});
test("operator auth, origin, exact permit and body identity fail before PUT", async (t) => {
  for (const headers of [
    { "x-shelf-trial-secret": key(55) },
    { "x-shelf-trial-permit": "other" },
    { Origin: "" },
    { Origin: "https://other.invalid" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Content-Length": String(BYTES.length + 1) },
    { "Content-Type": "application/json" },
  ]) {
    const f = await fixture(t);
    const r = await handleRequest(operator(f, "POST", BYTES, headers), f.env);
    assert.ok([400, 401, 403, 409].includes(r.status), await r.text());
    assert.equal(f.puts(), 0);
    assert.equal(
      f.sql
        .prepare("SELECT put_attempted FROM shelf_storage_single_trial")
        .get().put_attempted,
      0,
    );
  }
  const f = await fixture(t);
  assert.equal(
    (
      await handleRequest(
        operator(f, "POST", Buffer.alloc(BYTES.length)),
        f.env,
      )
    ).status,
    400,
  );
  assert.equal(f.puts(), 0);
});
test("upload rejects zero-byte chunk flood and suppresses rejecting cancellation", async (t) => {
  const f = await fixture(t);
  let count = 0;
  const body = new ReadableStream({
    pull(c) {
      if (++count <= 65537) c.enqueue(new Uint8Array());
      else c.close();
    },
    cancel() {
      return Promise.reject(new Error("synthetic cancel"));
    },
  });
  assert.equal(
    (await handleRequest(operator(f, "POST", body), f.env)).status,
    400,
  );
  assert.equal(f.puts(), 0);
});
test("operator object endpoints are fixed read-only and require secret even for HEAD", async (t) => {
  const f = await fixture(t);
  await handleRequest(operator(f), f.env);
  for (const method of ["HEAD", "GET"]) {
    const r = await handleRequest(operator(f, method), f.env);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-amz-meta-sha256"), f.d.sha256);
    if (method === "GET")
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), BYTES);
  }
  assert.equal(f.puts(), 1);
  assert.equal(
    (
      await handleRequest(
        operator(f, "GET", null, { "x-shelf-trial-secret": key(55) }),
        f.env,
      )
    ).status,
    401,
  );
});
test("trial private reading uses session for full, Range, IfMatch and immutable metadata", async (t) => {
  const f = await fixture(t, { confirmed: true }),
    path = `/api/files/${f.d.fileId}`;
  assert.equal(
    (await handleRequest(req(path + "/content"), f.env)).status,
    401,
  );
  assert.equal(f.reads(), 0);
  const cookie = await login(f);
  const access = await handleRequest(
    req(path + "/access", { headers: { Cookie: cookie } }),
    f.env,
  );
  assert.deepEqual(await access.json(), {
    url: path + "/content",
    format: "PDF",
    expiresAt: null,
    mode: "local",
  });
  let r = await handleRequest(
    req(path + "/content", { headers: { Cookie: cookie } }),
    f.env,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), BYTES);
  assert.match(r.headers.get("cache-control"), /no-store/);
  r = await handleRequest(
    req(path + "/content", {
      headers: {
        Cookie: cookie,
        Range: "bytes=1-10",
        "If-Match": '"syntheticetag"',
      },
    }),
    f.env,
  );
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 1-10/${BYTES.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), BYTES.subarray(1, 11));
  assert.equal(
    (
      await handleRequest(
        req(path + "/content", {
          headers: { Cookie: cookie, "If-Match": '"stale"' },
        }),
        f.env,
      )
    ).status,
    412,
  );
  assert.equal(
    (
      await handleRequest(
        req(path + "/content", {
          headers: { Cookie: cookie, Range: "bytes=999-" },
        }),
        f.env,
      )
    ).status,
    416,
  );
  const book = await handleRequest(req(`/api/books/${f.d.bookId}`), f.env);
  assert.equal((await book.json()).book.files[0].reason, "uploaded");
  f.sql.exec("UPDATE auth_config SET enabled=0");
  assert.equal(
    (
      await handleRequest(
        req(path + "/content", { headers: { Cookie: cookie } }),
        f.env,
      )
    ).status,
    401,
  );
});
test("trial R2 awaits cannot race session, catalog or descriptor changes into stream", async (t) => {
  for (const [change, status] of [
    [(f) => f.sql.exec("UPDATE sessions SET revoked=1"), 401],
    [(f) => f.sql.exec("UPDATE auth_config SET generation=generation+1"), 401],
    [(f) => f.sql.exec("DELETE FROM catalog_books"), 409],
    [
      (f) => {
        const book = structuredClone(f.book);
        book.files = [];
        f.sql
          .prepare("UPDATE catalog_books SET public_json=?")
          .run(JSON.stringify(book));
      },
      409,
    ],
    [
      (f) => {
        f.sql.exec("DROP TRIGGER shelf_single_trial_transition");
        f.sql
          .prepare("UPDATE shelf_storage_single_trial SET etag=?")
          .run('"changed"');
      },
      409,
    ],
  ]) {
    const f = await fixture(t, { confirmed: true }),
      cookie = await login(f);
    let cancelled = false;
    const get = f.env.BOOKS.get;
    f.env.BOOKS.get = async (...args) => {
      const o = await get(...args);
      o.body = new ReadableStream({
        cancel() {
          cancelled = true;
          return Promise.reject(new Error("synthetic cancel"));
        },
      });
      change(f);
      return o;
    };
    const r = await handleRequest(
      req(`/api/files/${f.d.fileId}/content`, { headers: { Cookie: cookie } }),
      f.env,
    );
    assert.equal(r.status, status, await r.clone().text());
    assert.equal(cancelled, true);
  }
});
test("trial refuses old credentials, wrong target binding and wrong target config", async (t) => {
  for (const patch of [
    { R2_ACCESS_KEY_ID: "old" },
    { R2_SECRET_ACCESS_KEY: "old" },
    { R2_BUCKET: "the-shelf-books" },
    { SINGLE_TRIAL_TARGET_SHA256: "b".repeat(64) },
  ]) {
    const f = await fixture(t);
    Object.assign(f.env, patch);
    assert.ok((await handleRequest(operator(f), f.env)).status >= 400);
    assert.equal(f.puts(), 0);
  }
});
