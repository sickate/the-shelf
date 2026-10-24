// Only synthetic SQLite, in-process Worker and local R2 fixtures; no cloud/AI/owner data.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import {
  sessionDigest,
  csrfForSession,
} from "../cloudflare/library/security.mjs";
import {
  ISOLATED_UPLOAD_TARGET,
  ISOLATED_UPLOAD_SCHEMA_HASHES,
  ISOLATED_UPLOAD_MIGRATION_SHA256,
  ISOLATED_UPLOAD_SCHEMA_SQL,
} from "../cloudflare/library/isolated-upload.mjs";
import {
  epubFixture,
  mobiFixture,
  kf8Fixture,
} from "./fixtures/ebook/synthetic.mjs";
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const ACCOUNT = "a".repeat(32),
  CONSENT = "c".repeat(64),
  TARGET = "b".repeat(64);
const sha = (v) => createHash("sha256").update(v).digest("hex");
const migration = readFileSync(
  new URL(
    "../cloudflare/library/migrations/013-isolated-upload.sql",
    import.meta.url,
  ),
  "utf8",
);
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");
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
class D1 {
  constructor(sql) {
    this.sql = sql;
    this.calls = [];
  }
  prepare(sql) {
    const db = this;
    const make = (args = []) => ({
      bind: (...a) => make(a),
      first: async () => {
        db.calls.push(sql);
        const r = db.sql.prepare(sql).get(...args) || null;
        await db.afterFirst?.(sql, args, r);
        return r;
      },
      all: async () => {
        db.calls.push(sql);
        return { results: db.sql.prepare(sql).all(...args) };
      },
      run: async () => {
        db.calls.push(sql);
        return { meta: db.sql.prepare(sql).run(...args) };
      },
      execute: () => {
        db.calls.push(sql);
        return {
          results: db.sql.prepare(sql).all(...args),
          claim: sql.includes("SET state='uploading'"),
        };
      },
    });
    return make();
  }
  async batch(statements) {
    this.sql.exec("BEGIN");
    let out;
    try {
      out = statements.map((s) => s.execute());
      this.sql.exec("COMMIT");
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
    await this.afterBatch?.(out);
    if (this.failClaim && out.some((r) => r.claim)) {
      this.failClaim = false;
      throw Error("synthetic lost durable response");
    }
    return out;
  }
}
async function fixture(
  t,
  {
    enabled = true,
    profile = "trial-009",
    legacyBytes = 72,
    legacyNormal = false,
  } = {},
) {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  const rows = DATABASE_SCHEMA_PROFILES[profile];
  for (const type of ["table", "index", "view"])
    for (const r of rows) if (r.type === type) sql.exec(r.sql);
  const now = Date.now(),
    desc = {
      kind: "original",
      scope: "production",
      fileId: "file_trial",
      bookId: "book_trial",
      format: "PDF",
      sizeBytes: PDF.length,
      sha256: sha(PDF),
      objectKey: `books/cf03/file_trial/${sha(PDF)}.pdf`,
      versionHash: null,
      source: null,
    };
  const book = {
    id: desc.bookId,
    title: "Synthetic retained trial",
    author: null,
    category: "Tests",
    categoryId: "tests",
    tags: [],
    description: "",
    files: [
      {
        id: desc.fileId,
        format: "PDF",
        sizeBytes: PDF.length,
        status: "candidate",
        reason: "not_uploaded",
        visibility: "private",
        readable: true,
      },
    ],
  };
  sql
    .prepare(
      "INSERT INTO public_state(scope,updated_at)VALUES('production',0),('check',0)",
    )
    .run();
  sql
    .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
    .run(book.id, JSON.stringify(book));
  sql
    .prepare(
      "INSERT INTO book_management VALUES('production',?,'private',0,1,?)",
    )
    .run(book.id, now - 1000);
  sql
    .prepare(
      "INSERT INTO shelf_storage_authority(id,identity_json,phase,migration_hash,committed_bytes,reserved_bytes)VALUES(1,?,'imported',?,?,?)",
    )
    .run(JSON.stringify(identity), "f".repeat(64), PDF.length, legacyBytes);
  for (const scope of ["check", "production"])
    sql
      .prepare("INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run(scope, "f".repeat(64), "e".repeat(64), "{}", "{}", 0, 0, 0, 0);
  for (let left = legacyBytes, i = 0; left > 0; i++) {
    const size = Math.min(left, 20_000_000);
    left -= size;
    sql
      .prepare(
        "INSERT INTO shelf_storage_reservations VALUES(?,?,?,?,?,'uncertain',1,0,NULL,?,?)",
      )
      .run(
        i ? "retained_unknown_" + i : "retained_unknown",
        "original:check:legacy" + i + ":original",
        "legacy" + i,
        JSON.stringify({
          kind: "original",
          scope: "check",
          fileId: "legacy" + i,
        }),
        size,
        now - 10000,
        now - 10000,
      );
  }
  if (legacyNormal) {
    const oldDesc = {
      ...desc,
      fileId: "file_old",
      bookId: "book_old",
      objectKey: `books/cf03/file_old/${sha(PDF)}.pdf`,
    };
    sql
      .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
      .run(
        "book_old",
        JSON.stringify({
          ...book,
          id: "book_old",
          files: [{ ...book.files[0], id: "file_old" }],
        }),
      );
    sql
      .prepare(
        "INSERT INTO book_management VALUES('production','book_old','private',0,1,?)",
      )
      .run(now - 1000);
    sql
      .prepare(
        "INSERT INTO browser_uploads VALUES('upload_old','production','book_old','file_old',?,'old_normal',?,?)",
      )
      .run(sha(PDF), JSON.stringify(oldDesc), now - 1000);
    sql
      .prepare(
        "INSERT INTO shelf_storage_reservations VALUES('old_normal','original:production:file_old:original',?,?,?,'confirmed',1,1,'syntheticetag',?,?)",
      )
      .run(
        oldDesc.objectKey,
        JSON.stringify(oldDesc),
        PDF.length,
        now - 1000,
        now - 1000,
      );
    sql
      .prepare(
        "INSERT INTO shelf_storage_original_registry VALUES('original:production:file_old:original','old_normal',?,'syntheticetag',1)",
      )
      .run(JSON.stringify(oldDesc));
    sql
      .prepare(
        "INSERT INTO file_registry VALUES('production','file_old','book_old','PDF',?,?,?,'syntheticetag','confirmed',1,?)",
      )
      .run(PDF.length, oldDesc.objectKey, sha(PDF), now - 1000);
    sql
      .prepare(
        "UPDATE shelf_storage_authority SET committed_bytes=committed_bytes+?",
      )
      .run(PDF.length);
  }
  sql
    .prepare(
      "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,?,?)",
    )
    .run(
      "consumed_permit",
      "2026-10-23-first-book",
      JSON.stringify(identity),
      JSON.stringify({
        accountId: ACCOUNT,
        bucket: "the-shelf-first-book-20261023",
      }),
      JSON.stringify(desc),
      TARGET,
      PDF.length,
      now - 10000,
      now - 5000,
      "syntheticetag",
      now - 6000,
    );
  sql
    .prepare(
      "INSERT INTO shelf_storage_legacy_freeze VALUES(1,?,?,?,'synthetic-freeze',?)",
    )
    .run(identity.authorityId, ACCOUNT, identity.bucket, now - 10000);
  const token = Buffer.alloc(32, 1).toString("base64url"),
    pepper = Buffer.alloc(32, 2).toString("base64url"),
    secret = Buffer.alloc(32, 3).toString("base64url"),
    context = { scope: "production", origin: ORIGIN };
  const digest = await sessionDigest(token, secret, context);
  sql
    .prepare(
      "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,1,?)",
    )
    .run(ORIGIN, "e".repeat(64), now);
  sql
    .prepare("INSERT INTO sessions VALUES('production',?,1,?,?,0)")
    .run(digest, now - 1000, now + 3600000);
  for (const r of rows) if (r.type === "trigger") sql.exec(r.sql);
  sql.exec(migration);
  sql
    .prepare(
      "INSERT INTO shelf_storage_isolated_upload_policy(target_id,authority_identity_json,account_id,bucket,trial_target_sha256,consent_sha256,budget_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,8000000000,?,?)",
    )
    .run(
      ISOLATED_UPLOAD_TARGET,
      JSON.stringify(identity),
      ACCOUNT,
      "the-shelf-first-book-20261023",
      TARGET,
      CONSENT,
      now,
      now,
    );
  function setEnabled(value) {
    sql
      .prepare(
        "UPDATE shelf_storage_isolated_upload_policy SET enabled=?,generation=generation+1,updated_at=? WHERE target_id=?",
      )
      .run(value ? 1 : 0, Date.now(), ISOLATED_UPLOAD_TARGET);
  }
  if (enabled) setEnabled(true);
  const db = new D1(sql),
    objects = new Map([[desc.objectKey, { bytes: PDF, format: "PDF" }]]),
    io = [];
  const types = {
    PDF: "application/pdf",
    EPUB: "application/epub+zip",
    MOBI: "application/x-mobipocket-ebook",
    AZW: "application/vnd.amazon.ebook",
    AZW3: "application/vnd.amazon.ebook",
  };
  const head = (key) => {
    const o = objects.get(key);
    return o
      ? {
          key,
          size: o.bytes.length,
          etag: "syntheticetag",
          httpEtag: '"syntheticetag"',
          httpMetadata: { contentType: types[o.format] },
          customMetadata: { sha256: sha(o.bytes) },
        }
      : null;
  };
  const env = {
    APP_SCOPE: "production",
    SITE_ORIGIN: ORIGIN,
    DB: db,
    OWNER_KEY_PEPPER: pepper,
    SESSION_SECRET: secret,
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: "the-shelf-first-book-20261023",
    SINGLE_TRIAL_MODE: "first-book-20261023",
    SINGLE_TRIAL_TARGET_SHA256: TARGET,
    ISOLATED_UPLOAD_MODE: "project-v1",
    ISOLATED_UPLOAD_CONSENT_SHA256: CONSENT,
    BOOKS: {
      async put(key, bytes, options) {
        io.push(["put", key]);
        await f.beforePut?.();
        if (f.putUnknown) throw Error("synthetic unknown write");
        assert.equal(options.onlyIf.get("if-none-match"), "*");
        if (objects.has(key)) return null;
        const format = Object.keys(types).find(
          (k) =>
            types[k] === options.httpMetadata.contentType &&
            key.endsWith("." + k.toLowerCase()),
        );
        objects.set(key, { bytes: Buffer.from(bytes), format });
        return head(key);
      },
      async head(key) {
        io.push(["head", key]);
        await f.beforeHead?.();
        return head(key);
      },
      async get(key, options) {
        io.push(["get", key]);
        await f.beforeGet?.();
        const h = head(key);
        if (!h) return null;
        const o = objects.get(key),
          r = options?.range;
        return {
          ...h,
          ...(r ? { range: r } : {}),
          body: new Response(
            r ? o.bytes.subarray(r.offset, r.offset + r.length) : o.bytes,
          ).body,
        };
      },
    },
  };
  const csrf = await csrfForSession(token, secret, context),
    cookie = "__Host-shelf_session=" + token;
  const send = (
    route,
    { body, binary, authenticated = true, headers = {}, method } = {},
  ) =>
    handleRequest(
      new Request(ORIGIN + route, {
        method: method || (binary || body !== undefined ? "POST" : "GET"),
        headers: {
          Origin: ORIGIN,
          "CF-Connecting-IP": "192.0.2.1",
          ...(authenticated ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
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
  const descriptor = (bytes = PDF, format = "PDF") => ({
    title: "New synthetic book",
    author: null,
    category: "Tests",
    file: {
      name: "new." + format.toLowerCase(),
      format,
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    },
  });
  const intent = async (bytes = PDF, format = "PDF") => {
    const r = await send("/api/manage/uploads", {
      body: descriptor(bytes, format),
    });
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  };
  const f = {
    sql,
    db,
    env,
    objects,
    io,
    send,
    descriptor,
    intent,
    setEnabled,
    token,
    csrf,
    cookie,
    secret,
    pepper,
    trial: desc,
    trialBook: book,
  };
  return f;
}

test("013 exact schema/migration pins independently match both public 009 profiles", async (t) => {
  assert.equal(sha(migration), ISOLATED_UPLOAD_MIGRATION_SHA256);
  for (const profile of ["trial-009", "trial-009-cf-metadata-v1"]) {
    const f = await fixture(t, { profile });
    const rows = f.sql
      .prepare(ISOLATED_UPLOAD_SCHEMA_SQL)
      .all()
      .map((r) => ({ ...r, sql: r.sql.trim().replace(/;$/, "") }));
    assert.ok(
      ISOLATED_UPLOAD_SCHEMA_HASHES.includes(sha(JSON.stringify(rows))),
    );
  }
});
test("isolated upload confirms within the existing imported authority, lists private book and reads Range", async (t) => {
  const f = await fixture(t),
    before = f.sql.prepare("SELECT * FROM shelf_storage_single_trial").get(),
    old = f.sql
      .prepare(
        "SELECT * FROM shelf_storage_reservations WHERE reservation_id='retained_unknown'",
      )
      .get();
  const intent = await f.intent();
  let r = await f.send(intent.upload.bytesUrl, { binary: PDF });
  assert.equal(r.status, 201, await r.clone().text());
  const uploaded = await r.json();
  assert.equal(uploaded.upload.state, "confirmed");
  assert.equal(uploaded.book.files[0].reason, "uploaded");
  assert.deepEqual(
    f.io.map((x) => x[0]),
    ["put", "head", "get", "head"],
  );
  assert.deepEqual(
    {
      ...f.sql
        .prepare(
          "SELECT committed_bytes,reserved_bytes,phase FROM shelf_storage_authority",
        )
        .get(),
    },
    { committed_bytes: PDF.length * 2, reserved_bytes: 72, phase: "imported" },
  );
  assert.deepEqual(
    f.sql.prepare("SELECT * FROM shelf_storage_single_trial").get(),
    before,
  );
  assert.deepEqual(
    f.sql
      .prepare(
        "SELECT * FROM shelf_storage_reservations WHERE reservation_id='retained_unknown'",
      )
      .get(),
    old,
  );
  const list = await (await f.send("/api/manage")).json();
  assert.equal(list.books.length, 2);
  assert.ok(list.books.every((x) => x.book.files[0].reason === "uploaded"));
  const detail = await (await f.send("/api/books/" + intent.bookId)).json();
  assert.equal(detail.book.id, intent.bookId);
  r = await f.send(`/api/files/${intent.fileId}/access`);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).mode, "local");
  r = await f.send(`/api/files/${intent.fileId}/content`, {
    headers: { Range: "bytes=0-4" },
  });
  assert.equal(r.status, 206, await r.clone().text());
  assert.equal(await r.text(), "%PDF-");
  r = await f.send(`/api/files/${f.trial.fileId}/content`);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF);
  r = await f.send("/api/books/" + intent.bookId, { authenticated: false });
  assert.equal(r.status, 404);
  assert.ok(
    !(
      await (
        await f.send("/api/catalog-state", { authenticated: false })
      ).text()
    ).includes(intent.bookId),
  );
});

test("default policy is closed; explicit configuration and complete exact 013 are required", async (t) => {
  const f = await fixture(t, { enabled: false });
  let r = await f.send("/api/manage/uploads", { body: f.descriptor() });
  assert.equal(r.status, 409);
  assert.equal(f.io.length, 0);
  const list = await (await f.send("/api/manage")).json();
  assert.equal(list.upload.enabled, false);
  assert.equal(list.books[0].book.files[0].reason, "uploaded");
  delete f.env.ISOLATED_UPLOAD_CONSENT_SHA256;
  r = await f.send("/api/manage");
  assert.equal(r.status, 503);
  f.env.ISOLATED_UPLOAD_CONSENT_SHA256 = CONSENT;
  f.sql.exec("DROP TRIGGER shelf_isolated_upload_immutable");
  r = await f.send("/api/manage/uploads", { body: f.descriptor() });
  assert.equal(r.status, 503);
  assert.equal(f.io.length, 0);
});
test("closing writes before bytes blocks PUT; closing after claim keeps confirmation and reads", async (t) => {
  const f = await fixture(t),
    intent = await f.intent();
  f.setEnabled(false);
  let r = await f.send(intent.upload.bytesUrl, { binary: PDF });
  assert.equal(r.status, 409);
  assert.equal(f.io.length, 0);
  f.setEnabled(true);
  f.beforePut = () => {
    f.setEnabled(false);
    f.beforePut = null;
  };
  r = await f.send(intent.upload.bytesUrl, { binary: PDF });
  assert.equal(r.status, 201, await r.clone().text());
  r = await f.send(`/api/files/${intent.fileId}/content`);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF);
  r = await f.send(`/api/files/${intent.fileId}/content`, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 0);
  assert.equal(r.headers.get("content-length"), String(PDF.length));
  const list = await (await f.send("/api/manage")).json();
  assert.equal(list.upload.enabled, false);
  assert.ok(
    list.books.some(
      (x) =>
        x.book.id === intent.bookId && x.book.files[0].reason === "uploaded",
    ),
  );
});
test("same hash dedupes without new responsibility and parallel bytes dispatch at most one PUT", async (t) => {
  const f = await fixture(t);
  const authorityBefore = f.sql
      .prepare("SELECT committed_bytes,reserved_bytes FROM shelf_storage_authority")
      .get(),
    reservationsBefore = f.sql
      .prepare("SELECT count(*) n FROM shelf_storage_reservations")
      .get().n;
  const responses = await Promise.all([
    f.send("/api/manage/uploads", { body: f.descriptor() }),
    f.send("/api/manage/uploads", { body: f.descriptor() }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  const first = await responses.find((r) => r.status === 201).json(),
    second = await responses.find((r) => r.status === 200).json();
  assert.equal(first.upload.state, "reserved");
  assert.equal(first.upload.canSubmit, true);
  assert.equal(second.upload.state, "reserved");
  assert.equal(second.upload.canSubmit, false);
  assert.equal(second.bookId, first.bookId);
  assert.equal(second.fileId, first.fileId);
  assert.equal(second.upload.id, first.upload.id);
  assert.equal(second.upload.bytesUrl, first.upload.bytesUrl);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM browser_uploads").get().n,
    1,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM shelf_storage_reservations").get().n,
    reservationsBefore + 1,
  );
  const authorityReserved = f.sql
    .prepare("SELECT committed_bytes,reserved_bytes FROM shelf_storage_authority")
    .get();
  assert.equal(authorityReserved.committed_bytes, authorityBefore.committed_bytes);
  assert.equal(
    authorityReserved.reserved_bytes,
    authorityBefore.reserved_bytes + PDF.length,
  );
  const rs = await Promise.all([
    f.send(first.upload.bytesUrl, { binary: PDF }),
    f.send(first.upload.bytesUrl, { binary: PDF }),
  ]);
  assert.ok(rs.some((r) => r.status === 201));
  assert.equal(f.io.filter((x) => x[0] === "put").length, 1);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM browser_uploads").get().n,
    1,
  );
  const again = await f.send("/api/manage/uploads", { body: f.descriptor() });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).upload.canSubmit, false);
  assert.equal(f.io.filter((x) => x[0] === "put").length, 1);
  const authorityConfirmed = f.sql
    .prepare("SELECT committed_bytes,reserved_bytes FROM shelf_storage_authority")
    .get();
  assert.equal(
    authorityConfirmed.committed_bytes,
    authorityBefore.committed_bytes + PDF.length,
  );
  assert.equal(authorityConfirmed.reserved_bytes, authorityBefore.reserved_bytes);
});
test("lost claim and PUT responses retain responsibility and never replay", async (t) => {
  for (const point of ["claim", "put"]) {
    const f = await fixture(t),
      i = await f.intent();
    if (point === "claim") f.db.failClaim = true;
    else f.putUnknown = true;
    let r = await f.send(i.upload.bytesUrl, { binary: PDF });
    assert.ok(r.status >= 400);
    const row = f.sql
      .prepare(
        "SELECT * FROM shelf_storage_reservations WHERE reservation_id<>'retained_unknown'",
      )
      .get();
    assert.equal(row.put_attempted, 1);
    assert.equal(row.state, point === "claim" ? "uploading" : "uncertain");
    const oldCalls = f.io.length;
    r = await f.send(i.upload.bytesUrl, { binary: PDF });
    assert.equal(r.status, 409);
    assert.equal(f.io.length, oldCalls);
    const a = f.sql
      .prepare("SELECT reserved_bytes FROM shelf_storage_authority")
      .get();
    assert.equal(a.reserved_bytes, 72 + PDF.length);
  }
});
test("whole authority includes retained trial and unknown responsibilities in atomic last-slot admission", async (t) => {
  const f = await fixture(t, { legacyBytes: 8_000_000_000 - PDF.length * 2 });
  const changed = Buffer.from(PDF);
  changed[changed.length - 1] = 32;
  const rs = await Promise.all([
    f.send("/api/manage/uploads", { body: f.descriptor() }),
    f.send("/api/manage/uploads", { body: f.descriptor(changed) }),
  ]);
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(
    f.sql
      .prepare(
        "SELECT committed_bytes+reserved_bytes n FROM shelf_storage_authority",
      )
      .get().n,
    8_000_000_000,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM browser_uploads").get().n,
    1,
  );
  const r = await f.send("/api/manage/uploads", {
    body: f.descriptor(Buffer.concat([PDF, Buffer.from(" ")])),
  });
  assert.equal(r.status, 409);
  assert.equal(f.io.length, 0);
});
test("accounting mismatch blocks both reservation and claim inside SQL", async (t) => {
  const f = await fixture(t),
    i = await f.intent();
  f.sql
    .prepare(
      "UPDATE shelf_storage_authority SET reserved_bytes=reserved_bytes+1",
    )
    .run();
  const r = await f.send(i.upload.bytesUrl, { binary: PDF });
  assert.equal(r.status, 409);
  assert.equal(f.io.length, 0);
  assert.throws(
    () =>
      f.sql
        .prepare(
          "UPDATE shelf_storage_reservations SET state='uploading',put_attempted=1 WHERE reservation_id=?",
        )
        .run("browser_" + i.upload.id),
    /account_storage_stale/,
  );
});
test("old NULL target stays immutable and is never read or deduped as an isolated object", async (t) => {
  const f = await fixture(t, { legacyNormal: true });
  assert.throws(
    () =>
      f.sql
        .prepare(
          "UPDATE browser_uploads SET target_id=? WHERE upload_id='upload_old'",
        )
        .run(ISOLATED_UPLOAD_TARGET),
    /isolated_upload_immutable/,
  );
  let r = await f.send("/api/files/file_old/content");
  assert.equal(r.status, 409);
  assert.equal(f.io.length, 0);
  r = await f.send("/api/manage/uploads/upload_old/bytes", { binary: PDF });
  assert.equal(r.status, 409);
  r = await f.send("/api/manage/uploads", { body: f.descriptor() });
  assert.equal(r.status, 409);
  assert.equal(f.io.length, 0);
  const list = await (await f.send("/api/manage")).json();
  const old = list.books.find((x) => x.book.id === "book_old");
  assert.equal(old.book.files[0].reason, "not_uploaded");
});
test("new target and policy immutable fields cannot be changed; old trial operator is closed", async (t) => {
  const f = await fixture(t),
    i = await f.intent();
  assert.throws(
    () =>
      f.sql
        .prepare("UPDATE browser_uploads SET target_id=NULL WHERE upload_id=?")
        .run(i.upload.id),
    /isolated_upload_immutable/,
  );
  assert.throws(
    () =>
      f.sql
        .prepare(
          "UPDATE shelf_storage_isolated_upload_policy SET consent_sha256=?",
        )
        .run("d".repeat(64)),
    /isolated_policy_immutable/,
  );
  for (const path of [
    "/api/single-trial/upload",
    "/api/single-trial/object",
    "/api/single-trial/deep/path",
  ]) {
    const r = await f.send(path, { body: {} });
    assert.equal(r.status, 404);
  }
  assert.equal(f.io.length, 0);
});
test("session, origin, CSRF, 20MB, bad hash and DRM rejections never dispatch PUT", async (t) => {
  const f = await fixture(t);
  for (const args of [
    { authenticated: false },
    { headers: { Origin: "https://wrong.invalid" } },
    { headers: { "X-CSRF-Token": "wrong" } },
  ]) {
    const r = await f.send("/api/manage/uploads", {
      body: f.descriptor(),
      ...args,
    });
    assert.ok([401, 403].includes(r.status));
  }
  const huge = f.descriptor();
  huge.file.sizeBytes = 20_000_001;
  assert.equal(
    (await f.send("/api/manage/uploads", { body: huge })).status,
    400,
  );
  const i = await f.intent();
  const bad = Buffer.from(PDF);
  bad[bad.length - 1] = 32;
  assert.equal((await f.send(i.upload.bytesUrl, { binary: bad })).status, 400);
  assert.equal(f.io.length, 0);
  const drm = Buffer.from(mobiFixture());
  const offset = drm.readUInt32BE(78);
  drm.writeUInt16BE(1, offset + 12);
  const k = await f.intent(drm, "MOBI");
  const r = await f.send(k.upload.bytesUrl, { binary: drm });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "drm_not_supported");
  assert.equal(f.io.length, 0);
});
test("all five accepted formats upload and use existing online content routes", async (t) => {
  for (const [format, bytes] of [
    ["PDF", PDF],
    ["EPUB", epubFixture()],
    ["MOBI", mobiFixture()],
    ["AZW", mobiFixture({ text: "<p>AZW synthetic</p>" })],
    ["AZW3", kf8Fixture()],
  ]) {
    const f = await fixture(t),
      i = await f.intent(bytes, format);
    let r = await f.send(i.upload.bytesUrl, { binary: bytes });
    assert.equal(r.status, 201, await r.clone().text());
    r = await f.send(`/api/files/${i.fileId}/content`);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(bytes));
  }
});
test("trash and restore retain accounting and immediately guard content", async (t) => {
  const f = await fixture(t),
    i = await f.intent();
  await f.send(i.upload.bytesUrl, { binary: PDF });
  const before = {
    ...f.sql
      .prepare(
        "SELECT committed_bytes,reserved_bytes FROM shelf_storage_authority",
      )
      .get(),
  };
  let r = await f.send(`/api/manage/books/${i.bookId}/trash`, {
    body: { expectedVersion: 1 },
  });
  assert.equal(r.status, 200, await r.clone().text());
  r = await f.send(`/api/files/${i.fileId}/content`);
  assert.equal(r.status, 409);
  r = await f.send(`/api/manage/books/${i.bookId}/restore`, {
    body: { expectedVersion: 2 },
  });
  assert.equal(r.status, 200, await r.clone().text());
  r = await f.send(`/api/files/${i.fileId}/content`);
  assert.equal(r.status, 200);
  await r.arrayBuffer();
  assert.deepEqual(
    {
      ...f.sql
        .prepare(
          "SELECT committed_bytes,reserved_bytes FROM shelf_storage_authority",
        )
        .get(),
    },
    before,
  );
});
test("after HEAD/GET private content is rejected on revocation, lifecycle or captured binding drift", async (t) => {
  for (const mutation of [
    (f) => f.sql.prepare("UPDATE sessions SET revoked=1").run(),
    (f) =>
      f.sql
        .prepare("UPDATE book_management SET trashed=1,version=version+1")
        .run(),
    (f) => {
      f.env.BOOKS = { ...f.env.BOOKS };
    },
    (f) => {
      f.env.ISOLATED_UPLOAD_CONSENT_SHA256 = "d".repeat(64);
    },
  ]) {
    const f = await fixture(t),
      i = await f.intent();
    await f.send(i.upload.bytesUrl, { binary: PDF });
    f.beforeGet = () => {
      f.beforeGet = null;
      mutation(f);
    };
    const r = await f.send(`/api/files/${i.fileId}/content`);
    assert.ok([401, 409, 503].includes(r.status), await r.clone().text());
  }
});

test("real workerd D1/R2 upload, retained trial, private directory, content/Range and lifecycle close loop", async (t) => {
  const { build } = await import("esbuild"),
    { Miniflare, NoOpLog, convertV4MiniflareOptions } =
      await import("miniflare"),
    root = new URL("../", import.meta.url).pathname;
  const f = await fixture(t),
    bundle = await build({
      entryPoints: [root + "cloudflare/library/worker.mjs"],
      platform: "neutral",
      bundle: true,
      write: false,
      format: "esm",
    });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new NoOpLog(),
      modules: true,
      compatibilityDate: "2026-10-15",
      rootPath: root,
      scriptPath: root + "tests/synthetic-isolated-upload-worker.mjs",
      script: bundle.outputFiles[0].text,
      routes: [new URL(ORIGIN).hostname + "/*"],
      bindings: {
        APP_SCOPE: "production",
        SITE_ORIGIN: ORIGIN,
        OWNER_KEY_PEPPER: f.pepper,
        SESSION_SECRET: f.secret,
        R2_ACCOUNT_ID: ACCOUNT,
        R2_BUCKET: f.env.R2_BUCKET,
        SINGLE_TRIAL_MODE: f.env.SINGLE_TRIAL_MODE,
        SINGLE_TRIAL_TARGET_SHA256: TARGET,
        ISOLATED_UPLOAD_MODE: "project-v1",
        ISOLATED_UPLOAD_CONSENT_SHA256: CONSENT,
      },
      d1Databases: { DB: "isolated-upload" },
      r2Buckets: { BOOKS: "isolated-only" },
      outboundService() {
        throw Error("unexpected outbound network");
      },
    }),
  );
  t.after(() => mf.dispose());
  const d1 = await mf.getD1Database("DB"),
    schema = f.sql.prepare(ISOLATED_UPLOAD_SCHEMA_SQL).all();
  const bucket = await mf.getR2Bucket("BOOKS");
  const storedTrial = await bucket.put(f.trial.objectKey, PDF, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { sha256: sha(PDF) },
  });
  for (const type of ["table", "index", "view"])
    for (const r of schema)
      if (r.type === type && !r.name.startsWith("_cf_"))
        await d1.prepare(r.sql).run();
  const order = [
    "public_state",
    "auth_config",
    "catalog_books",
    "book_management",
    "shelf_storage_authority",
    "shelf_storage_sources",
    "shelf_storage_isolated_upload_policy",
    "shelf_storage_reservations",
    "shelf_storage_single_trial",
    "sessions",
  ];
  for (const table of schema
    .filter((r) => r.type === "table" && !r.name.startsWith("_cf_"))
    .sort(
      (a, b) =>
        (order.indexOf(a.name) < 0 ? 999 : order.indexOf(a.name)) -
        (order.indexOf(b.name) < 0 ? 999 : order.indexOf(b.name)),
    ))
    for (const row of f.sql.prepare("SELECT * FROM " + table.name).all()) {
      if (table.name === "shelf_storage_single_trial")
        row.etag = storedTrial.etag;
      const cols = Object.keys(row);
      await d1
        .prepare(
          `INSERT INTO ${table.name}(${cols.join(",")})VALUES(${cols.map(() => "?").join(",")})`,
        )
        .bind(...cols.map((k) => row[k]))
        .run();
    }
  for (const r of schema)
    if (r.type === "trigger") await d1.prepare(r.sql).run();
  const worker = await mf.getWorker(),
    send = (
      route,
      { body, binary, method, headers = {}, authenticated = true } = {},
    ) =>
      worker.fetch(ORIGIN + route, {
        method: method || (body !== undefined || binary ? "POST" : "GET"),
        headers: {
          Origin: ORIGIN,
          ...(authenticated
            ? { Cookie: f.cookie, "X-CSRF-Token": f.csrf }
            : {}),
          ...(body !== undefined
            ? { "Content-Type": "application/json" }
            : binary
              ? { "Content-Type": "application/octet-stream" }
              : {}),
          ...headers,
        },
        ...(body !== undefined
          ? { body: JSON.stringify(body) }
          : binary
            ? { body: binary }
            : {}),
      });
  let r = await send("/api/manage/uploads", { body: f.descriptor() });
  assert.equal(r.status, 201, await r.clone().text());
  const i = await r.json();
  const parallel = await Promise.all([
    send(i.upload.bytesUrl, { binary: PDF }),
    send(i.upload.bytesUrl, { binary: PDF }),
  ]);
  assert.equal(
    parallel.filter((r) => r.status === 201).length,
    1,
    await Promise.all(parallel.map((r) => r.clone().text())),
  );
  r = await send("/api/manage");
  assert.equal(r.status, 200, await r.clone().text());
  const listed = await r.json();
  assert.equal(listed.books.length, 2);
  assert.ok(listed.books.every((x) => x.book.files[0].reason === "uploaded"));
  r = await send("/api/books/" + i.bookId);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).book.files[0].reason, "uploaded");
  for (const id of [i.fileId, f.trial.fileId]) {
    r = await send(`/api/files/${id}/access`);
    assert.equal(r.status, 200, await r.clone().text());
    r = await send(`/api/files/${id}/content`, {
      headers: { Range: "bytes=0-4" },
    });
    assert.equal(r.status, 206, await r.clone().text());
    assert.equal(await r.text(), "%PDF-");
  }
  r = await send(`/api/files/${i.fileId}/content`, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 0);
  r = await send(`/api/manage/books/${i.bookId}/trash`, {
    body: { expectedVersion: 1 },
  });
  assert.equal(r.status, 200, await r.clone().text());
  r = await send(`/api/files/${i.fileId}/content`);
  assert.equal(r.status, 409);
  r = await send(`/api/manage/books/${i.bookId}/restore`, {
    body: { expectedVersion: 2 },
  });
  assert.equal(r.status, 200, await r.clone().text());
  await d1
    .prepare(
      "UPDATE shelf_storage_isolated_upload_policy SET enabled=0,generation=generation+1,updated_at=?",
    )
    .bind(Date.now())
    .run();
  r = await send(`/api/files/${i.fileId}/content`);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF);
  r = await send("/api/manage/uploads", {
    body: f.descriptor(Buffer.concat([PDF, Buffer.from(" ")])),
  });
  assert.equal(r.status, 409);
  const counters = await d1
    .prepare(
      "SELECT phase,committed_bytes,reserved_bytes FROM shelf_storage_authority",
    )
    .first();
  assert.equal(counters.phase, "imported");
  assert.equal(counters.committed_bytes, PDF.length * 2);
  assert.equal(counters.reserved_bytes, 72);
  const objects = await bucket.list();
  assert.equal(objects.objects.length, 2);
  r = await send("/api/logout", { body: {} });
  assert.equal(r.status, 200);
  r = await send(`/api/files/${i.fileId}/content`);
  assert.equal(r.status, 401);
});

test("new mode markers close every trial operator method/path before configuration or IO", async () => {
  for (const env of [
    { ISOLATED_UPLOAD_MODE: "unknown" },
    { ISOLATED_UPLOAD_CONSENT_SHA256: "bad" },
  ]) {
    let touched = 0;
    for (const key of [
      "APP_SCOPE",
      "DB",
      "BOOKS",
      "SESSION_SECRET",
      "SINGLE_TRIAL_UPLOAD_SECRET",
    ])
      Object.defineProperty(env, key, {
        get() {
          touched++;
          throw Error("must not access");
        },
      });
    for (const method of ["GET", "POST", "PUT", "HEAD", "OPTIONS", "DELETE"])
      for (const path of [
        "/api/single-trial",
        "/api/single-trial/",
        "/api/single-trial/upload",
        "/api/single-trial/object",
        "/api/single-trial/unknown/deep",
      ]) {
        const r = await handleRequest(
          new Request(ORIGIN + path, { method }),
          env,
        );
        assert.equal(r.status, 404);
      }
    assert.equal(touched, 0);
  }
});
test("isolated schema checks run after ordinary API admission and valid POST CSRF", async (t) => {
  const f = await fixture(t);
  f.db.calls = [];
  let r = await f.send("/api/manage/uploads", {
    body: f.descriptor(),
    headers: { "X-CSRF-Token": "wrong" },
  });
  assert.equal(r.status, 403);
  assert.ok(f.db.calls.some((s) => s.includes("INSERT INTO admissions")));
  assert.ok(!f.db.calls.includes(ISOLATED_UPLOAD_SCHEMA_SQL));
  f.db.calls = [];
  r = await f.send("/api/manage", { authenticated: false });
  assert.equal(r.status, 401);
  const admission = f.db.calls.findIndex((s) =>
      s.includes("INSERT INTO admissions"),
    ),
    schema = f.db.calls.indexOf(ISOLATED_UPLOAD_SCHEMA_SQL);
  assert.ok(admission >= 0 && schema > admission);
});

test("upload final session validation follows the last target query on revocation or expiry", async (t) => {
  for (const change of ["revoked=1", "expires_at=created_at+1"]) {
    const f = await fixture(t),
      i = await f.intent();
    let heads = 0;
    f.beforeHead = () => {
      if (++heads === 2)
        f.db.afterFirst = (sql) => {
          if (sql.includes("FROM shelf_isolated_upload_targets u")) {
            f.db.afterFirst = null;
            f.sql.prepare("UPDATE sessions SET " + change).run();
          }
        };
    };
    const r = await f.send(i.upload.bytesUrl, { binary: PDF });
    assert.equal(r.status, 401, await r.clone().text());
    assert.equal(
      f.sql
        .prepare(
          "SELECT state FROM shelf_storage_reservations WHERE reservation_id=?",
        )
        .get("browser_" + i.upload.id).state,
      "confirmed",
    );
    assert.equal(f.io.filter((x) => x[0] === "put").length, 1);
  }
});
