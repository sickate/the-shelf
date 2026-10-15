import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import {
  createOwnerVerifier,
  verifyOwnerKey,
  decodeKey,
  isCanonicalKey,
  sessionDigest,
  csrfForSession,
  canonicalIp,
  encodeKey,
  readJson,
} from "../cloudflare/library/security.mjs";
import {
  mergePublicBook,
  presignGet,
  deriveCategoryId,
} from "../cloudflare/library/core.mjs";
import { presign as nodePresign } from "../server/storage.mjs";

const schema = readFileSync(
  new URL("../cloudflare/library/schema.sql", import.meta.url),
  "utf8",
);
const origin = "https://the-shelf-cf03-check.iamzhutuo.workers.dev";
const fixtureBook = {
  id: "book-1",
  title: "Test Book",
  author: null,
  category: "Tests",
  categoryId: "cat-tests",
  tags: [],
  description: "Test",
  files: [
    {
      id: "file-1",
      format: "EPUB",
      sizeBytes: 100,
      status: "candidate",
      reason: "not_uploaded",
      visibility: "private",
      readable: true,
    },
  ],
};
class D1 {
  constructor() {
    this.sql = new DatabaseSync(":memory:");
    this.sql.exec(schema);
    this.trace = [];
    this.roundTrips = 0;
  }
  prepare(sql) {
    this.trace.push(sql);
    const database = this;
    const make = (args) => ({
      sourceSql: sql,
      bind: (...next) => make(next),
      first: async () => {
        database.roundTrips++;
        return database.sql.prepare(sql).get(...args) || null;
      },
      all: async () => {
        database.roundTrips++;
        return {
          success: true,
          results: database.sql.prepare(sql).all(...args),
        };
      },
      run: async () => {
        database.roundTrips++;
        const result = database.sql.prepare(sql).run(...args);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        };
      },
      execute: () => ({
        success: true,
        results: database.sql.prepare(sql).all(...args),
      }),
    });
    return make([]);
  }
  async batch(statements) {
    this.roundTrips++;
    this.sql.exec("BEGIN");
    try {
      const results = statements.map((s) => s.execute());
      this.sql.exec("COMMIT");
      return results;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }
}
async function fixture() {
  const key = encodeKey(new Uint8Array(32).fill(11));
  const pepper = encodeKey(new Uint8Array(32).fill(22));
  const secret = encodeKey(new Uint8Array(32).fill(33));
  const db = new D1();
  const env = {
    APP_SCOPE: "check",
    SITE_ORIGIN: origin,
    OWNER_KEY_PEPPER: pepper,
    SESSION_SECRET: secret,
    DB: db,
    BOOKS: {
      head: async () => ({
        size: 100,
        etag: "etag",
        httpEtag: '"etag"',
        customMetadata: { sha256: "b".repeat(64) },
        httpMetadata: { contentType: "application/epub+zip" },
      }),
    },
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_BUCKET: "the-shelf-books",
    R2_ACCESS_KEY_ID: "neutral-access-key",
    R2_SECRET_ACCESS_KEY: "neutral-secret-for-tests-only",
  };
  const verifier = await createOwnerVerifier(key, pepper, {
    scope: "check",
    origin,
  });
  db.sql
    .prepare("INSERT INTO auth_config VALUES(?,?,?,?,?,?,?)")
    .run("check", origin, "owner-access-key-v1", verifier, 1, 1, Date.now());
  db.sql
    .prepare("INSERT INTO catalog_books VALUES(?,?,?)")
    .run("check", "book-1", JSON.stringify(fixtureBook));
  return { env, db, key, pepper, secret };
}
function req(
  path,
  { body, cookie, csrf, ip = "192.0.2.1", source = origin, headers = {} } = {},
) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "CF-Connecting-IP": ip,
      ...(body !== undefined
        ? { Origin: source, "Content-Type": "application/json" }
        : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function login(f) {
  const r = await handleRequest(
    req("/api/login", { body: { accessKey: f.key } }),
    f.env,
  );
  assert.equal(r.status, 200, await r.clone().text());
  return {
    cookie: r.headers.get("set-cookie").split(";")[0],
    csrf: (await r.json()).csrfToken,
  };
}
function putRegistry(db) {
  db.sql
    .prepare("INSERT INTO file_registry VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "check",
      "file-1",
      "book-1",
      "EPUB",
      100,
      "cf03-check/file-1.epub",
      "b".repeat(64),
      '"etag"',
      "confirmed",
      1,
      Date.now(),
    );
}

test("CF03 HMAC domain encoding agrees with independent Node HMAC and binds origin/scope", async () => {
  const f = await fixture();
  const options = { scope: "check", origin };
  const actual = await createOwnerVerifier(f.key, f.pepper, options);
  const expected = createHmac("sha256", Buffer.from(f.pepper, "base64url"))
    .update(`the-shelf/cf03/v1/owner\ncheck\n${origin}\n${f.key}`)
    .digest("hex");
  assert.equal(actual, expected);
  assert.equal(await verifyOwnerKey(f.key, actual, f.pepper, options), true);
  assert.equal(
    await verifyOwnerKey("a human password", actual, f.pepper, options),
    false,
  );
  assert.equal(
    await verifyOwnerKey(f.key, actual, f.pepper, {
      scope: "production",
      origin,
    }),
    false,
  );
  assert.notEqual(
    await sessionDigest(f.key, f.secret, options),
    await sessionDigest(f.key, f.secret, {
      scope: "check",
      origin: "https://example.test",
    }),
  );
  assert.notEqual(
    await csrfForSession(f.key, f.secret, options),
    await sessionDigest(f.key, f.secret, options),
  );
  assert.equal(
    canonicalIp("2001:db8::1"),
    canonicalIp("2001:0db8:0000:0000:1:2:3:4"),
  );
  assert.equal(canonicalIp("999.0.0.1"), "unknown");
});

test("CF03 malformed owner keys avoid decoding yet always verify a dummy with exact canonical padding bits", async () => {
  const f = await fixture(),
    options = { scope: "check", origin };
  const verifier = await createOwnerVerifier(f.key, f.pepper, options);
  const originalVerify = crypto.subtle.verify,
    originalAtob = globalThis.atob;
  const messages = [];
  let decodes = 0;
  crypto.subtle.verify = async function (_algorithm, _key, _signature, bytes) {
    messages.push(new TextDecoder().decode(bytes));
    return true;
  };
  globalThis.atob = function (...args) {
    decodes++;
    return originalAtob.apply(this, args);
  };
  try {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const last of alphabet) {
      const candidate = f.key.slice(0, -1) + last;
      const canonical =
        Buffer.from(candidate, "base64url").toString("base64url") === candidate;
      assert.equal(
        await verifyOwnerKey(candidate, verifier, f.pepper, options),
        canonical,
      );
      if (!canonical)
        assert.ok(messages.at(-1).endsWith("\n" + "A".repeat(43)));
    }
    const malformed = [
      "",
      "ordinary password",
      f.key + "=",
      f.key.slice(1),
      "+" + f.key.slice(1),
      null,
      {},
      [],
      1,
    ];
    for (const candidate of malformed) {
      assert.equal(
        await verifyOwnerKey(candidate, verifier, f.pepper, options),
        false,
      );
      assert.ok(messages.at(-1).endsWith("\n" + "A".repeat(43)));
    }
    assert.equal(messages.length, 64 + malformed.length);
    assert.equal(
      decodes,
      0,
      "normal owner-key format rejection must not construct a decode exception",
    );
  } finally {
    crypto.subtle.verify = originalVerify;
    globalThis.atob = originalAtob;
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias =
    f.key.slice(0, -1) + alphabet[alphabet.indexOf(f.key.at(-1)) + 1];
  assert.deepEqual(
    Buffer.from(f.key, "base64url"),
    Buffer.from(alias, "base64url"),
  );
  assert.equal(decodeKey(f.key).length, 32);
  assert.throws(() => decodeKey(alias), {
    code: "invalid_credentials",
    status: 401,
  });
  assert.throws(() => decodeKey("human password"), {
    code: "invalid_credentials",
    status: 401,
  });
  assert.equal(await verifyOwnerKey(alias, verifier, f.pepper, options), false);
});

test("CF03 concurrent unknown category derivation shares one SHA while a known database ID always wins", async () => {
  const category = "Memo concurrent category fixture",
    original = crypto.subtle.digest;
  let hashes = 0,
    release;
  crypto.subtle.digest = function (...args) {
    hashes++;
    return new Promise((resolve, reject) => {
      release = () => original.apply(this, args).then(resolve, reject);
    });
  };
  try {
    const first = deriveCategoryId(category),
      second = deriveCategoryId(category);
    const known = deriveCategoryId(category, "cat-authoritative-db");
    assert.equal(hashes, 1);
    release();
    const [a, b, real] = await Promise.all([first, second, known]);
    const expected =
      "cat-" + createHash("sha256").update(category).digest("hex").slice(0, 12);
    assert.equal(a, expected);
    assert.equal(b, expected);
    assert.equal(real, "cat-authoritative-db");
    assert.equal(
      await deriveCategoryId(category, "cat-current-db"),
      "cat-current-db",
    );
    assert.equal(await deriveCategoryId(category), expected);
    assert.equal(hashes, 1);
  } finally {
    crypto.subtle.digest = original;
  }
});

test("CF03 category derivation caches at most 64 public names and validates exported-function inputs", async () => {
  const original = crypto.subtle.digest;
  let hashes = 0;
  crypto.subtle.digest = function (...args) {
    hashes++;
    return original.apply(this, args);
  };
  try {
    for (let i = 0; i <= 64; i++)
      await deriveCategoryId(`Cache capacity fixture ${i}`);
    assert.equal(hashes, 65);
    for (let i = 1; i <= 64; i++)
      await deriveCategoryId(`Cache capacity fixture ${i}`);
    assert.equal(hashes, 65);
    await deriveCategoryId("Cache capacity fixture 0");
    assert.equal(hashes, 66);
    for (const invalid of [
      null,
      {},
      "",
      " ",
      " padded ",
      "x".repeat(101),
      "bad\u0000category",
    ]) {
      await assert.rejects(() => deriveCategoryId(invalid), {
        code: "invalid_metadata",
      });
      await assert.rejects(() => deriveCategoryId(invalid, "cat-known"), {
        code: "invalid_metadata",
      });
    }
    assert.equal(hashes, 66);
  } finally {
    crypto.subtle.digest = original;
  }
});

test("CF03 failed category digests are retryable and an evicted rejection cannot erase a replacement", async () => {
  const original = crypto.subtle.digest,
    attempts = new Map(),
    rejectors = new Map();
  const failing = "Cache failed then fresh fixture",
    evicted = "Cache evicted original fixture";
  crypto.subtle.digest = function (...args) {
    const name = new TextDecoder().decode(args[1]);
    const attempt = (attempts.get(name) || 0) + 1;
    attempts.set(name, attempt);
    if ([failing, evicted].includes(name) && attempt === 1)
      return new Promise((_resolve, reject) => rejectors.set(name, reject));
    return original.apply(this, args);
  };
  try {
    const first = deriveCategoryId(failing),
      second = deriveCategoryId(failing);
    assert.equal(attempts.get(failing), 1);
    const failures = Promise.allSettled([first, second]);
    rejectors.get(failing)(new Error("synthetic digest failure"));
    assert.ok((await failures).every((r) => r.status === "rejected"));
    const recovered = await deriveCategoryId(failing);
    assert.equal(await deriveCategoryId(failing), recovered);
    assert.equal(attempts.get(failing), 2);

    const old = deriveCategoryId(evicted).catch(() => null);
    for (let i = 0; i < 64; i++)
      await deriveCategoryId(`Eviction filler fixture ${i}`);
    const replacement = await deriveCategoryId(evicted);
    assert.equal(attempts.get(evicted), 2);
    rejectors.get(evicted)(new Error("old evicted digest failure"));
    await old;
    assert.equal(await deriveCategoryId(evicted), replacement);
    assert.equal(
      attempts.get(evicted),
      2,
      "old rejection must not delete the replacement promise",
    );
  } finally {
    crypto.subtle.digest = original;
  }
});

test("CF03 login, cookie, Origin, CSRF and durable logout", async () => {
  const f = await fixture();
  let r = await handleRequest(
    req("/api/login", { body: { accessKey: "ordinary password" } }),
    f.env,
  );
  assert.equal(r.status, 401);
  r = await handleRequest(
    req("/api/login", {
      body: { accessKey: f.key },
      source: "https://evil.test",
    }),
    f.env,
  );
  assert.equal(r.status, 403);
  r = await handleRequest(
    req("/api/login", { body: { accessKey: f.key } }),
    f.env,
  );
  assert.match(
    r.headers.get("set-cookie"),
    /^__Host-shelf_session=[\w-]{43}; Secure; HttpOnly; Path=\/; SameSite=Strict; Max-Age=86400$/,
  );
  assert.equal(r.headers.get("cache-control"), "no-store");
  const auth = {
    cookie: r.headers.get("set-cookie").split(";")[0],
    csrf: (await r.json()).csrfToken,
  };
  r = await handleRequest(
    req("/api/logout", { body: {}, cookie: auth.cookie }),
    f.env,
  );
  assert.equal(r.status, 403);
  r = await handleRequest(req("/api/session", { cookie: auth.cookie }), f.env);
  assert.equal((await r.json()).authenticated, true);
  r = await handleRequest(req("/api/logout", { body: {}, ...auth }), f.env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /Max-Age=0$/);
  r = await handleRequest(req("/api/session", { cookie: auth.cookie }), f.env);
  assert.equal((await r.json()).authenticated, false);
});

test("CF03 shared/IP login budgets roll back together and incorrect keys spend quota", async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await handleRequest(
          req("/api/login", { body: { accessKey: "wrong" } }),
          f.env,
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await handleRequest(
        req("/api/login", { body: { accessKey: f.key } }),
        f.env,
      )
    ).status,
    429,
  );
  const day = f.db.sql
    .prepare("SELECT count FROM counters WHERE kind='login_day'")
    .get().count;
  assert.equal(day, 5);
  assert.equal(
    f.db.sql
      .prepare("SELECT count(*) n FROM admissions WHERE kind='login'")
      .get().n,
    5,
  );
  const other = await handleRequest(
    req("/api/login", { body: { accessKey: f.key }, ip: "192.0.2.2" }),
    f.env,
  );
  assert.equal(other.status, 200);
  // One remaining global slot, twenty simultaneous contenders: SQL constraints,
  // not preflight reads, decide exactly one winner.
  f.db.sql
    .prepare("UPDATE counters SET count=19 WHERE kind='login_minute'")
    .run();
  const replies = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      handleRequest(
        req("/api/login", {
          body: { accessKey: "wrong" },
          ip: `198.51.100.${i + 1}`,
        }),
        f.env,
      ),
    ),
  );
  assert.equal(replies.filter((r) => r.status === 401).length, 1);
  assert.equal(replies.filter((r) => r.status === 429).length, 19);
  assert.equal(
    f.db.sql
      .prepare("SELECT count FROM counters WHERE kind='login_minute'")
      .get().count,
    20,
  );
});

test("CF03 generation rotation revokes sessions and prevents stale-generation INSERT", async () => {
  const f = await fixture(),
    auth = await login(f);
  f.db.sql
    .prepare(
      "UPDATE auth_config SET generation=generation+1 WHERE scope='check'",
    )
    .run();
  assert.equal(
    (await handleRequest(req("/api/files/file-1/access", auth), f.env)).status,
    401,
  );
  assert.throws(
    () =>
      f.db.sql
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)")
        .run("check", "d".repeat(64), 1, Date.now(), Date.now() + 10000, 0),
    /library_session_invalid/,
  );
  assert.equal(
    f.db.sql.prepare("SELECT revoked FROM sessions").get().revoked,
    1,
  );
});

test("CF03 metadata CAS preserves concurrent updates and only exposes public fields", async () => {
  const f = await fixture(),
    auth = await login(f);
  const changes = [{ title: "First" }, { title: "Second" }];
  const replies = await Promise.all(
    changes.map((changes) =>
      handleRequest(
        req("/api/books/book-1/metadata", {
          ...auth,
          body: { expectedVersion: 0, changes },
        }),
        f.env,
      ),
    ),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  let r = await handleRequest(req("/api/books/book-1"), f.env),
    data = await r.json();
  assert.equal(data.metadataVersion, 1);
  const title = data.book.title;
  r = await handleRequest(
    req("/api/books/book-1/metadata", {
      ...auth,
      body: { expectedVersion: 1, changes: { tags: ["new"] } },
    }),
    f.env,
  );
  assert.equal(r.status, 200);
  data = await r.json();
  assert.equal(data.book.title, title);
  assert.deepEqual(data.book.tags, ["new"]);
  r = await handleRequest(
    req("/api/books/book-1/metadata", {
      ...auth,
      body: { expectedVersion: 2, changes: { storageKey: "private" } },
    }),
    f.env,
  );
  assert.equal(r.status, 400);
  f.db.sql
    .prepare("UPDATE catalog_books SET public_json=? WHERE book_id=?")
    .run(
      JSON.stringify({
        ...fixtureBook,
        sourcePath: "/private/path",
        files: [{ ...fixtureBook.files[0], storageKey: "secret" }],
      }),
      "book-1",
    );
  r = await handleRequest(req("/api/books/book-1"), f.env);
  assert.doesNotMatch(await r.text(), /private\/path|storageKey|secret/);
  assert.equal(
    f.db.sql
      .prepare("SELECT revision FROM public_state WHERE scope='check'")
      .get().revision,
    4,
  );
});

test("CF03 stale metadata conflicts avoid book/registry payloads and CAS rechecks generation", async () => {
  const f = await fixture(),
    auth = await login(f);
  let r = await handleRequest(
    req("/api/books/book-1/metadata", {
      ...auth,
      body: { expectedVersion: 0, changes: { title: "Saved" } },
    }),
    f.env,
  );
  assert.equal(r.status, 200);
  f.db.trace.length = 0;
  r = await handleRequest(
    req("/api/books/book-1/metadata", {
      ...auth,
      body: { expectedVersion: 0, changes: { title: "Stale" } },
    }),
    f.env,
  );
  assert.equal(r.status, 409);
  assert.equal((await r.json()).metadataVersion, 1);
  assert.ok(f.db.trace.length <= 4);
  assert.ok(
    !f.db.trace.some(
      (sql) =>
        sql.includes("AS public_json") || sql.includes("FROM file_registry"),
    ),
  );

  const batch = f.db.batch.bind(f.db);
  f.db.batch = async (statements) => {
    if (
      statements.some((s) =>
        s.sourceSql.startsWith("INSERT INTO metadata_overrides"),
      )
    ) {
      f.db.sql
        .prepare(
          "UPDATE auth_config SET generation=generation+1 WHERE scope='check'",
        )
        .run();
    }
    return batch(statements);
  };
  r = await handleRequest(
    req("/api/books/book-1/metadata", {
      ...auth,
      body: { expectedVersion: 1, changes: { title: "Revoked" } },
    }),
    f.env,
  );
  assert.equal(r.status, 401);
  const saved = f.db.sql
    .prepare(
      "SELECT version,patch_json FROM metadata_overrides WHERE scope='check'",
    )
    .get();
  assert.equal(saved.version, 1);
  assert.equal(JSON.parse(saved.patch_json).title, "Saved");
});

test("CF03 metadata folds category and CAS conflict reads into three primary calls without losing another patch", async () => {
  const f = await fixture(),
    auth = await login(f);
  const originalDigest = crypto.subtle.digest;
  let hashes = 0;
  crypto.subtle.digest = function (...args) {
    hashes++;
    return originalDigest.apply(this, args);
  };
  try {
    f.db.roundTrips = 0;
    let r = await handleRequest(
      req("/api/books/book-1/metadata", {
        ...auth,
        body: {
          expectedVersion: 0,
          changes: { title: "Known", category: " Tests " },
        },
      }),
      f.env,
    );
    assert.equal(r.status, 200, await r.clone().text());
    let result = await r.json();
    assert.equal(result.book.categoryId, "cat-tests");
    assert.equal(hashes, 0, "known category should not do a discarded SHA-256");
    assert.equal(f.db.roundTrips, 3);

    f.db.roundTrips = 0;
    r = await handleRequest(
      req("/api/books/book-1/metadata", {
        ...auth,
        body: { expectedVersion: 1, changes: { category: "New category" } },
      }),
      f.env,
    );
    assert.equal(r.status, 200);
    result = await r.json();
    assert.equal(
      result.book.categoryId,
      "cat-" +
        createHash("sha256").update("New category").digest("hex").slice(0, 12),
    );
    assert.equal(
      hashes,
      1,
      "new categories still use the stable SHA-256 identifier",
    );
    assert.equal(f.db.roundTrips, 3);

    f.db.roundTrips = 0;
    const batch = f.db.batch.bind(f.db);
    f.db.batch = async (statements) => {
      if (
        statements.some((s) =>
          s.sourceSql.startsWith("INSERT INTO metadata_overrides"),
        )
      ) {
        const saved = JSON.parse(
          f.db.sql
            .prepare(
              "SELECT patch_json FROM metadata_overrides WHERE scope='check'",
            )
            .get().patch_json,
        );
        f.db.sql
          .prepare(
            "UPDATE metadata_overrides SET patch_json=?,version=version+1 WHERE scope='check'",
          )
          .run(JSON.stringify({ ...saved, title: "Concurrent winner" }));
      }
      return batch(statements);
    };
    r = await handleRequest(
      req("/api/books/book-1/metadata", {
        ...auth,
        body: {
          expectedVersion: 2,
          changes: { author: "Must not be saved", category: "Tests" },
        },
      }),
      f.env,
    );
    assert.equal(r.status, 409);
    assert.equal((await r.json()).metadataVersion, 3);
    assert.equal(
      f.db.roundTrips,
      3,
      "CAS loser must not make a separate latest-version request",
    );
    const saved = JSON.parse(
      f.db.sql
        .prepare(
          "SELECT patch_json FROM metadata_overrides WHERE scope='check'",
        )
        .get().patch_json,
    );
    assert.equal(saved.title, "Concurrent winner");
    assert.equal(saved.author, undefined);
    assert.equal(saved.category, "New category");

    f.db.roundTrips = 0;
    r = await handleRequest(
      req("/api/books/book-1/metadata", {
        ...auth,
        body: {
          expectedVersion: 3,
          changes: { category: { injected: "object" } },
        },
      }),
      f.env,
    );
    assert.equal(r.status, 400);
    assert.equal(
      f.db.roundTrips,
      1,
      "invalid category never reaches a SQL category parameter",
    );
  } finally {
    crypto.subtle.digest = originalDigest;
  }
});

test("CF03 private file lookup fails anonymously and signs only confirmed scoped GET", async () => {
  const f = await fixture();
  putRegistry(f.db);
  for (const id of ["file-1", "unknown"])
    assert.equal(
      (await handleRequest(req(`/api/files/${id}/access`), f.env)).status,
      401,
    );
  const auth = await login(f);
  let r = await handleRequest(req("/api/files/file-1/access", auth), f.env);
  assert.equal(r.status, 200);
  const data = await r.json();
  const url = new URL(data.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(url.pathname, /cf03-check\/file-1\.epub$/);
  assert.equal(data.mode, "r2");
  assert.ok(Date.parse(data.expiresAt) > Date.now());
  const signature = await presignGet(
    f.env,
    "cf03-check/file-1.epub",
    "EPUB",
    new Date("2026-10-15T00:00:00Z"),
  );
  assert.match(signature, /X-Amz-Signature=[a-f0-9]{64}$/);
  assert.equal(
    signature,
    nodePresign(
      {
        r2Account: f.env.R2_ACCOUNT_ID,
        r2Bucket: f.env.R2_BUCKET,
        r2AccessKey: f.env.R2_ACCESS_KEY_ID,
        r2Secret: f.env.R2_SECRET_ACCESS_KEY,
      },
      "cf03-check/file-1.epub",
      "GET",
      new Date("2026-10-15T00:00:00Z"),
    ),
  );
  await assert.rejects(
    () => presignGet(f.env, "books/private.epub", "EPUB"),
    /file_unavailable/,
  );
  f.db.sql.prepare("UPDATE file_registry SET state='disabled'").run();
  r = await handleRequest(req("/api/files/file-1/access", auth), f.env);
  assert.equal(r.status, 409);
  r = await handleRequest(req("/api/files/file-1/content", auth), f.env);
  assert.equal(r.status, 403);
});

test("CF03 access checks real R2 metadata, normalizes quoted ETags and never probes anonymously", async () => {
  const f = await fixture();
  putRegistry(f.db);
  const original = f.env.BOOKS.head;
  let calls = 0;
  f.env.BOOKS.head = async (key) => {
    calls++;
    assert.equal(key, "cf03-check/file-1.epub");
    return original(key);
  };
  assert.equal(
    (await handleRequest(req("/api/files/file-1/access"), f.env)).status,
    401,
  );
  assert.equal(calls, 0);
  const auth = await login(f);
  for (const change of [
    () => null,
    (head) => ({ ...head, size: 101 }),
    (head) => ({ ...head, etag: "other" }),
    (head) => ({ ...head, httpEtag: '"other"' }),
    (head) => ({ ...head, customMetadata: {} }),
    (head) => ({ ...head, customMetadata: { sha256: "c".repeat(64) } }),
    (head) => ({ ...head, httpMetadata: { contentType: "application/pdf" } }),
    (head) => ({ ...head, httpMetadata: {} }),
    (head) => ({ ...head, etag: undefined, httpEtag: undefined }),
  ]) {
    f.env.BOOKS.head = async () => change(await original());
    const r = await handleRequest(req("/api/files/file-1/access", auth), f.env);
    assert.equal(r.status, 409, await r.clone().text());
    assert.equal(Object.hasOwn(await r.json(), "url"), false);
  }
  assert.equal(
    f.db.sql
      .prepare("SELECT count(*) n FROM admissions WHERE kind='access'")
      .get().n,
    0,
  );
  for (const pick of [
    (head) => ({ ...head, httpEtag: undefined }),
    (head) => ({ ...head, etag: undefined }),
  ]) {
    f.env.BOOKS.head = async () => pick(await original());
    assert.equal(
      (await handleRequest(req("/api/files/file-1/access", auth), f.env))
        .status,
      200,
    );
  }
});

test("CF03 HEAD awaits cannot race a revoked session, generation or file descriptor into a signature", async () => {
  const races = [
    ["UPDATE file_registry SET state='disabled'", 409],
    ["DELETE FROM file_registry", 409],
    ["UPDATE file_registry SET version=version+1", 409],
    ["UPDATE file_registry SET object_key='cf03-check/replaced.epub'", 409],
    ["UPDATE file_registry SET sha256='" + "c".repeat(64) + "'", 409],
    ["UPDATE file_registry SET etag='new-etag'", 409],
    ["UPDATE file_registry SET size_bytes=101", 409],
    ["UPDATE sessions SET revoked=1", 401],
    ["UPDATE auth_config SET generation=generation+1 WHERE scope='check'", 401],
  ];
  for (const [sql, status] of races) {
    const f = await fixture();
    putRegistry(f.db);
    const auth = await login(f);
    const original = f.env.BOOKS.head;
    f.env.BOOKS.head = async () => {
      const head = await original();
      f.db.sql.exec(sql);
      return head;
    };
    const r = await handleRequest(req("/api/files/file-1/access", auth), f.env);
    assert.equal(r.status, status, sql + ": " + (await r.clone().text()));
    assert.equal(Object.hasOwn(await r.json(), "url"), false);
    assert.equal(
      f.db.sql
        .prepare("SELECT count(*) n FROM admissions WHERE kind='access'")
        .get().n,
      0,
    );
  }
  const f = await fixture();
  putRegistry(f.db);
  const auth = await login(f);
  const original = f.env.BOOKS.head;
  f.env.BOOKS.head = async () => {
    const head = await original();
    const changed = structuredClone(fixtureBook);
    changed.files[0].sizeBytes = 101;
    f.db.sql
      .prepare("UPDATE catalog_books SET public_json=?")
      .run(JSON.stringify(changed));
    return head;
  };
  assert.equal(
    (await handleRequest(req("/api/files/file-1/access", auth), f.env)).status,
    409,
  );
});

test("CF03 uploaded projection requires the current complete confirmed descriptor", async () => {
  const book = structuredClone(fixtureBook);
  book.files[0].reason = "uploaded";
  const registration = {
    file_id: "file-1",
    book_id: "book-1",
    format: "EPUB",
    size_bytes: 100,
    state: "confirmed",
  };
  assert.equal(mergePublicBook(book).files[0].reason, "not_uploaded");
  assert.equal(
    mergePublicBook(book, {}, [registration]).files[0].reason,
    "uploaded",
  );
  for (const mismatch of [
    { state: "disabled" },
    { file_id: "other" },
    { book_id: "other" },
    { format: "PDF" },
    { size_bytes: 101 },
  ]) {
    assert.equal(
      mergePublicBook(book, {}, [{ ...registration, ...mismatch }]).files[0]
        .reason,
      "not_uploaded",
    );
  }
  const f = await fixture();
  f.db.sql
    .prepare("UPDATE catalog_books SET public_json=?")
    .run(JSON.stringify(book));
  let r = await handleRequest(req("/api/books/book-1"), f.env);
  assert.equal((await r.json()).book.files[0].reason, "not_uploaded");
  putRegistry(f.db);
  r = await handleRequest(req("/api/books/book-1"), f.env);
  assert.equal((await r.json()).book.files[0].reason, "uploaded");
  f.db.sql.prepare("UPDATE file_registry SET state='disabled'").run();
  r = await handleRequest(req("/api/books/book-1"), f.env);
  assert.equal((await r.json()).book.files[0].reason, "not_uploaded");
});

test("CF03 streaming JSON cap and fixed failure responses", async () => {
  const f = await fixture();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(
        new TextEncoder().encode('{"accessKey":"' + "x".repeat(17000) + '"}'),
      );
      c.close();
    },
  });
  const r = await handleRequest(
    new Request(origin + "/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    }),
    f.env,
  );
  assert.equal(r.status, 413);
  const broken = {
    ...f.env,
    DB: {
      prepare() {
        throw new Error("SQL secret=private-value");
      },
    },
  };
  const failure = await handleRequest(req("/api/session"), broken);
  assert.equal(failure.status, 503);
  assert.equal(
    await failure.text(),
    '{"error":{"code":"service_unavailable"}}',
  );
  assert.equal(
    (await handleRequest(req("/api/no-such-route"), f.env)).status,
    404,
  );
  const nonApi = await handleRequest(req("/"), f.env);
  assert.equal(nonApi.status, 404);
});

test("CF03 storage reservation triggers retain uncertainty and atomically confirm content", async () => {
  const f = await fixture(),
    now = Date.now();
  f.db.sql
    .prepare("INSERT INTO storage_state VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      1,
      "a".repeat(32),
      7999999850,
      now,
      8000000000,
      0,
      0,
      "e".repeat(64),
      1,
      now,
    );
  const reserve = (id, file = "file-1") =>
    f.db.sql
      .prepare(
        "INSERT INTO upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "check",
        file,
        "book-1",
        `cf03-check/${id}.epub`,
        100,
        "EPUB",
        "f".repeat(64),
        "reserved",
        now,
        now,
      );
  reserve("one");
  assert.throws(() => reserve("two", "file-2"), /library_storage_budget/);
  assert.equal(
    f.db.sql.prepare("SELECT reserved_bytes FROM storage_state").get()
      .reserved_bytes,
    100,
  );
  f.db.sql
    .prepare(
      "UPDATE upload_reservations SET state='uncertain' WHERE reservation_id='one'",
    )
    .run();
  assert.throws(
    () =>
      f.db.sql
        .prepare(
          "UPDATE upload_reservations SET state='uploading' WHERE reservation_id='one'",
        )
        .run(),
    /library_upload_state/,
  );
  assert.throws(
    () =>
      f.db.sql
        .prepare("DELETE FROM upload_reservations WHERE reservation_id='one'")
        .run(),
    /library_upload_retained/,
  );
  assert.throws(
    () =>
      f.db.sql
        .prepare(
          "UPDATE upload_reservations SET state='confirmed' WHERE reservation_id='one'",
        )
        .run(),
    /library_upload_unverified/,
  );
  f.db.sql
    .prepare(
      "UPDATE upload_reservations SET state='confirmed',content_verified=1,etag='matched' WHERE reservation_id='one'",
    )
    .run();
  const state = f.db.sql
    .prepare("SELECT reserved_bytes,committed_bytes FROM storage_state")
    .get();
  assert.equal(state.reserved_bytes, 0);
  assert.equal(state.committed_bytes, 100);
  assert.equal(
    f.db.sql.prepare("SELECT state FROM file_registry").get().state,
    "confirmed",
  );
  assert.equal(
    mergePublicBook(
      fixtureBook,
      {},
      f.db.sql.prepare("SELECT * FROM file_registry").all(),
    ).files[0].reason,
    "uploaded",
  );
});

test("CF03 expiry, missing Origin, cross-origin replay and private disabled AI fail safely", async () => {
  const f = await fixture(),
    auth = await login(f);
  let r = await handleRequest(
    new Request(origin + "/api/logout", {
      method: "POST",
      headers: {
        Cookie: auth.cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": auth.csrf,
      },
      body: "{}",
    }),
    f.env,
  );
  assert.equal(r.status, 403);
  r = await handleRequest(req("/api/jobs/unknown"), f.env);
  assert.equal(r.status, 401);
  r = await handleRequest(req("/api/jobs/unknown", auth), f.env);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "ai_unconfigured");
  const other = {
    ...f.env,
    APP_SCOPE: "production",
    SITE_ORIGIN: "https://the-shelf.iamzhutuo.workers.dev",
  };
  r = await handleRequest(
    new Request(other.SITE_ORIGIN + "/api/session", {
      headers: { Cookie: auth.cookie },
    }),
    other,
  );
  assert.equal((await r.json()).authenticated, false);
  f.db.sql
    .prepare("UPDATE sessions SET created_at=?,expires_at=?")
    .run(Date.now() - 2000, Date.now() - 1000);
  r = await handleRequest(req("/api/session", auth), f.env);
  assert.equal((await r.json()).authenticated, false);
});

test("CF03 budget denial does not partially spend IP and cleanup is bounded", async () => {
  const f = await fixture();
  await handleRequest(req("/api/health"), f.env);
  f.db.sql
    .prepare(
      "UPDATE counters SET count=1000 WHERE scope='check' AND kind='api_day'",
    )
    .run();
  const r = await handleRequest(
    req("/api/health", { ip: "198.51.100.77" }),
    f.env,
  );
  assert.equal(r.status, 429);
  assert.equal(
    f.db.sql
      .prepare("SELECT count(*) n FROM counters WHERE kind='api_ip'")
      .get().n,
    1,
  );
  f.db.sql.prepare("UPDATE counters SET count=1 WHERE kind='api_day'").run();
  for (let i = 0; i < 80; i++)
    f.db.sql
      .prepare("INSERT INTO admissions VALUES(?,?,?,?,?,?,?,?)")
      .run(
        "check",
        `old-${i}`,
        "api",
        "a".repeat(64),
        Date.now() - 259200000 - i,
        null,
        null,
        null,
      );
  await handleRequest(req("/api/health"), f.env);
  assert.equal(
    f.db.sql
      .prepare(
        "SELECT count(*) n FROM admissions WHERE request_id LIKE 'old-%'",
      )
      .get().n,
    80,
  );
  f.db.sql
    .prepare(
      "UPDATE counters SET count=31 WHERE kind='api_day' AND window_start=?",
    )
    .run(Math.floor(Date.now() / 86400000));
  await handleRequest(req("/api/health"), f.env);
  assert.equal(
    f.db.sql
      .prepare(
        "SELECT count(*) n FROM admissions WHERE request_id LIKE 'old-%'",
      )
      .get().n,
    16,
  );
});

test("CF03 deterministic maintenance retires full bounded batches and failures keep admission charged", async () => {
  const f = await fixture();
  assert.equal((await handleRequest(req("/api/health"), f.env)).status, 200);
  const now = Date.now();
  for (let i = 0; i < 32; i++) {
    const created = now - (40 - i) * 86400000;
    f.db.sql
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,0)")
      .run(
        "check",
        i.toString(16).padStart(64, "0"),
        1,
        created,
        created + 3600000,
      );
  }
  for (let i = 0; i < 64; i++) {
    f.db.sql
      .prepare("INSERT INTO admissions VALUES(?,?,?,?,?,?,?,?)")
      .run(
        "check",
        `expired-${i}`,
        "api",
        "a".repeat(64),
        now - 259200000 - i,
        null,
        null,
        null,
      );
  }
  for (let i = 0; i < 128; i++) {
    f.db.sql
      .prepare("INSERT INTO counters VALUES(?,?,?,?,?,?)")
      .run(
        "check",
        "api_ip",
        `expired-bucket-${i}`,
        Math.floor(now / 60000) - 300,
        1,
        240,
      );
  }
  f.db.sql
    .prepare(
      "UPDATE counters SET count=31 WHERE kind='api_day' AND window_start=?",
    )
    .run(Math.floor(now / 86400000));
  const before = f.db.sql.prepare("SELECT total_changes() n").get().n;
  assert.equal((await handleRequest(req("/api/health"), f.env)).status, 200);
  // Four table-row writes for admission/counters, then the four maximum
  // maintenance batches. D1 index accounting is additional and budgeted apart.
  assert.equal(
    f.db.sql.prepare("SELECT total_changes() n").get().n - before,
    4 + 64 + 8 + 128 + 32,
  );
  assert.equal(
    f.db.sql
      .prepare(
        "SELECT count(*) n FROM admissions WHERE request_id LIKE 'expired-%'",
      )
      .get().n,
    0,
  );
  assert.equal(f.db.sql.prepare("SELECT count(*) n FROM sessions").get().n, 0);

  const broken = await fixture(),
    batch = broken.db.batch.bind(broken.db);
  broken.db.batch = async (statements) => {
    if (
      statements.some((s) => s.sourceSql.startsWith("DELETE FROM admissions"))
    )
      throw new Error("cleanup unavailable");
    return batch(statements);
  };
  assert.equal(
    (await handleRequest(req("/api/health"), broken.env)).status,
    503,
  );
  assert.equal(
    broken.db.sql
      .prepare("SELECT count FROM counters WHERE kind='api_day'")
      .get().count,
    1,
  );
  assert.equal(
    (await handleRequest(req("/api/health"), broken.env)).status,
    200,
  );
  assert.equal(
    broken.db.sql
      .prepare("SELECT count FROM counters WHERE kind='api_day'")
      .get().count,
    2,
  );
});

test("CF03 stale/unknown storage evidence blocks upload and release requires absence proof", async () => {
  const f = await fixture(),
    now = Date.now();
  f.db.sql
    .prepare("INSERT INTO storage_state VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      1,
      "a".repeat(32),
      0,
      now - 900001,
      8000000000,
      0,
      0,
      "e".repeat(64),
      1,
      now,
    );
  const insert = () =>
    f.db.sql
      .prepare(
        "INSERT INTO upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "one",
        "check",
        "file-1",
        "book-1",
        "cf03-check/one.epub",
        100,
        "EPUB",
        "f".repeat(64),
        "reserved",
        now,
        now,
      );
  assert.throws(insert, /library_storage_budget/);
  f.db.sql
    .prepare("UPDATE storage_state SET observed_at=?,evidence_complete=0")
    .run(now);
  assert.throws(insert, /library_storage_budget/);
  f.db.sql.prepare("UPDATE storage_state SET evidence_complete=1").run();
  insert();
  assert.throws(
    () =>
      f.db.sql.prepare("UPDATE upload_reservations SET state='aborted'").run(),
    /library_upload_unverified/,
  );
  assert.equal(
    f.db.sql.prepare("SELECT reserved_bytes FROM storage_state").get()
      .reserved_bytes,
    100,
  );
  f.db.sql
    .prepare(
      "UPDATE upload_reservations SET state='aborted',absence_verified=1",
    )
    .run();
  assert.equal(
    f.db.sql.prepare("SELECT reserved_bytes FROM storage_state").get()
      .reserved_bytes,
    0,
  );
});

test("CF03 canonical key predicate agrees with independent Buffer encoding and the unchanged decoder", () => {
  const oracle = (value) => {
    if (typeof value !== "string") return false;
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  };
  const check = (value) => {
    const expected = oracle(value);
    assert.equal(isCanonicalKey(value), expected);
    if (expected)
      assert.deepEqual(
        Buffer.from(decodeKey(value)),
        Buffer.from(value, "base64url"),
      );
    else
      assert.throws(() => decodeKey(value), {
        code: "invalid_credentials",
        status: 401,
      });
  };
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < 64; i++) {
    const bytes = randomBytes(32),
      key = bytes.toString("base64url");
    check(key);
    assert.deepEqual(Buffer.from(decodeKey(key)), bytes);
    for (const last of alphabet) check(key.slice(0, -1) + last);
  }
  const key = Buffer.alloc(32).toString("base64url");
  for (let position = 0; position < 43; position++)
    for (const invalid of [
      "=",
      "+",
      "/",
      " ",
      "\t",
      "\r",
      "\n",
      "\0",
      "\u2028",
      "\u2029",
      "中",
      "💡",
    ])
      check(key.slice(0, position) + invalid + key.slice(position + 1));
  for (const affix of [
    "=",
    "==",
    " ",
    "\t",
    "\r",
    "\n",
    "\r\n",
    "\u2028",
    "\u2029",
  ]) {
    check(key + affix);
    check(affix + key);
  }
  for (let bytes = 0; bytes <= 64; bytes++)
    check(Buffer.alloc(bytes).toString("base64url"));
  for (const value of [
    undefined,
    null,
    false,
    0,
    NaN,
    {},
    [],
    new String(key),
    Buffer.alloc(32),
    Symbol("fixture"),
    1n,
  ])
    check(value);
});

test("CF03 invalid trusted secrets and equal secrets fail before any database call", async () => {
  const valid = Buffer.alloc(32, 71).toString("base64url");
  let calls = 0;
  const database = {
    prepare() {
      calls++;
      throw new Error("database must not run");
    },
    batch() {
      calls++;
      throw new Error("database must not run");
    },
  };
  const environment = {
    APP_SCOPE: "check",
    SITE_ORIGIN: origin,
    DB: database,
    OWNER_KEY_PEPPER: valid,
    SESSION_SECRET: Buffer.alloc(32, 72).toString("base64url"),
  };
  const noncanonical = valid.slice(0, -1) + "B";
  for (const field of ["OWNER_KEY_PEPPER", "SESSION_SECRET"])
    for (const value of [
      undefined,
      null,
      {},
      "",
      valid + "=",
      valid + "\n",
      noncanonical,
    ]) {
      const result = await handleRequest(req("/api/health"), {
        ...environment,
        [field]: value,
      });
      assert.equal(result.status, 503);
      assert.equal(
        await result.text(),
        '{"error":{"code":"service_unavailable"}}',
      );
    }
  const equal = await handleRequest(req("/api/health"), {
    ...environment,
    SESSION_SECRET: valid,
  });
  assert.equal(equal.status, 503);
  assert.equal(calls, 0);
});

test("CF03 warm configuration skips decoding while a cold HMAC import still decodes real key bytes", () => {
  // Isolate global instrumentation in a separate process, with no inherited
  // environment or private fixtures. The parent test process is never patched.
  const workerUrl = new URL("../cloudflare/library/worker.mjs", import.meta.url)
    .href;
  const source = `
    import assert from 'node:assert/strict';
    import {randomBytes} from 'node:crypto';
    const {handleRequest}=await import(${JSON.stringify(workerUrl)});
    const session=randomBytes(32),pepper=randomBytes(32);
    const env={APP_SCOPE:'check',SITE_ORIGIN:'https://the-shelf-cf03-check.iamzhutuo.workers.dev',OWNER_KEY_PEPPER:pepper.toString('base64url'),SESSION_SECRET:session.toString('base64url'),DB:{prepare(){return{bind(){return this;}};},async batch(){return[{results:[]},{results:[{count:2}]}];}}};
    const originalAtob=globalThis.atob,originalImport=crypto.subtle.importKey;
    let decodes=0,imports=0;
    try {
      globalThis.atob=function(...args){decodes++;return originalAtob.apply(this,args);};
      crypto.subtle.importKey=function(...args){imports++;assert.equal(args[0],'raw');assert.deepEqual(Buffer.from(args[1]),session);return originalImport.apply(this,args);};
      const request=()=>new Request(env.SITE_ORIGIN+'/api/health',{headers:{'CF-Connecting-IP':'192.0.2.1'}});
      assert.equal((await handleRequest(request(),env)).status,200);
      assert.equal(decodes,1,'cold HMAC key must still use the real decoder');
      assert.equal(imports,1,'cold HMAC key must still be imported by Web Crypto');
      assert.equal((await handleRequest(request(),env)).status,200);
      assert.equal(decodes,1,'warm request must not decode trusted configuration again');
      assert.equal(imports,1,'existing imported HMAC key cache stays unchanged');
    } finally {globalThis.atob=originalAtob;crypto.subtle.importKey=originalImport;}
    assert.equal(globalThis.atob,originalAtob);assert.equal(crypto.subtle.importKey,originalImport);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { env: {}, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
});
