import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, NoOpLog, convertV4MiniflareOptions } from "miniflare";
import { fixture, context } from "./helpers/storage-read-fixture.mjs";
import {
  randomKey,
  sessionDigest,
  csrfForSession,
} from "../cloudflare/library/security.mjs";
const root = new URL("../", import.meta.url).pathname;
test("real workerd bounded book/list routes use both sources, strict owner privacy and keyset pages", async (t) => {
  const files = {
    normal: fixture(t),
    trial: fixture(t, { source: "trial" }),
    conflict: fixture(t, { source: "both" }),
  };
  const secret = randomKey(),
    pepper = randomKey(),
    token = randomKey(),
    digest = await sessionDigest(token, secret, context);
  const bundle = await build({
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
      workers: Object.entries(files).map(([name, f]) => ({
        name,
        // getWorker() passes through MF's /cdn-cgi proxy, whose own Origin
        // allowlist comes from configured routes. Keep the real product Origin.
        routes:
          name === "normal" ? [new URL(context.origin).hostname + "/*"] : [],
        modules: true,
        compatibilityDate: "2026-10-15",
        rootPath: root,
        scriptPath: root + "tests/synthetic-storage-book-" + name + ".mjs",
        script: bundle.outputFiles[0].text,
        bindings: {
          APP_SCOPE: "production",
          SITE_ORIGIN: context.origin,
          STORAGE_MODE: "authority-v2",
          STORAGE_WRITE_MODE: "closed",
          R2_ACCOUNT_ID: f.env.R2_ACCOUNT_ID,
          R2_BUCKET: f.env.R2_BUCKET,
          TRIAL_R2_ACCOUNT_ID: f.env.TRIAL_R2_ACCOUNT_ID,
          TRIAL_R2_BUCKET: f.env.TRIAL_R2_BUCKET,
          TRIAL_TARGET_SHA256: f.env.TRIAL_TARGET_SHA256,
          FILENAME_AI_MODE: "filename-v1",
          OWNER_KEY_PEPPER: pepper,
          SESSION_SECRET: secret,
        },
        d1Databases: { DB: "storage-book-" + name },
        r2Buckets: { BOOKS: "book-normal", TRIAL_BOOKS: "book-trial" },
        outboundService() {
          throw Error("unexpected external request");
        },
      })),
    }),
  );
  t.after(() => mf.dispose());
  for (const [name, f] of Object.entries(files)) {
    f.unsafe(() => {
      f.db.prepare("UPDATE sessions SET session_hash=?").run(digest);
      if (name !== "conflict")
        for (let i = 0; i < 105; i++) {
          const id = "book_" + String(i).padStart(4, "0");
          f.db
            .prepare("INSERT INTO catalog_books VALUES('production',?,?)")
            .run(id, JSON.stringify({ ...f.book, id, files: [] }));
        }
    });
    const d1 = await mf.getD1Database("DB", name);
    for (const type of ["table", "index", "view"])
      for (const row of f.schema)
        if (row.type === type) await d1.prepare(row.sql).run();
    const order = [
      "public_state",
      "auth_config",
      "catalog_books",
      "sessions",
      "book_management",
      "shelf_storage_authority",
      "shelf_storage_reservations",
      "shelf_storage_original_registry",
      "file_registry",
      "shelf_storage_single_trial",
    ];
    for (const table of f.schema
      .filter((r) => r.type === "table")
      .sort(
        (a, b) =>
          (order.indexOf(a.name) < 0 ? 999 : order.indexOf(a.name)) -
          (order.indexOf(b.name) < 0 ? 999 : order.indexOf(b.name)),
      ))
      for (const row of f.db.prepare("SELECT * FROM " + table.name).all()) {
        const columns = Object.keys(row);
        await d1
          .prepare(
            `INSERT INTO ${table.name}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...columns.map((k) => row[k]))
          .run();
      }
    for (const row of f.schema.filter((r) => r.type === "trigger"))
      await d1.prepare(row.sql).run();
    const worker = await mf.getWorker(name),
      headers = { cookie: "__Host-shelf_session=" + token };
    const csrf = await csrfForSession(token, secret, context);
    const fetch = (route, authenticated = true) =>
      worker.fetch(context.origin + route, {
        headers: authenticated ? headers : {},
      });
    const post = (route, body, extraHeaders = {}) =>
      worker.fetch(context.origin + route, {
        method: "POST",
        headers: {
          ...headers,
          origin: context.origin,
          "content-type": "application/json",
          "x-csrf-token": csrf,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    if (name === "conflict") {
      assert.equal((await fetch("/api/manage")).status, 409);
      assert.equal((await fetch("/api/books/book_shared")).status, 409);
      assert.equal(
        (
          await post("/api/books/book_shared/metadata", {
            expectedVersion: 0,
            changes: { title: "Edited" },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await post("/api/manage/books/book_shared/trash", {
            expectedVersion: 1,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await d1
            .prepare(
              "SELECT count(*) AS n FROM admissions WHERE kind='metadata'",
            )
            .first()
        ).n,
        0,
      );
      continue;
    }
    assert.equal((await fetch("/api/manage", false)).status, 401);
    assert.equal((await fetch("/api/books/book_shared", false)).status, 404);
    const detail = await fetch("/api/books/book_shared");
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).book.files[0].reason, "uploaded");
    const publicBook = await fetch("/api/books/book_0000", false);
    assert.equal(publicBook.status, 200);
    const firstResponse = await fetch("/api/manage");
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.books.length, 100);
    assert.equal(first.pagination.nextCursor, "book_0099");
    assert.deepEqual(first.upload.reasons, ["storage_write_closed"]);
    const secondResponse = await fetch(
      "/api/manage?cursor=" + first.pagination.nextCursor,
    );
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.books.length, 6);
    assert.equal(second.pagination.nextCursor, null);
    assert.equal(second.books.at(-1).book.id, "book_shared");
    assert.equal(second.books.at(-1).book.files[0].reason, "uploaded");
    assert.equal((await fetch("/api/manage?cursor=")).status, 400);
    assert.equal(
      (await fetch("/api/manage?cursor=book_1&cursor=book_2")).status,
      400,
    );
    assert.equal(
      (
        await d1
          .prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'")
          .first()
      ).n,
      0,
    );
    for (const [extraHeaders, code] of [
      [
        { origin: context.origin.replace("https:", "http:") },
        "origin_forbidden",
      ],
      [{ "x-csrf-token": "invalid-synthetic-token" }, "csrf_invalid"],
    ]) {
      const denied = await post(
        "/api/books/book_shared/metadata",
        {
          expectedVersion: 0,
          changes: { title: "Denied" },
        },
        extraHeaders,
      );
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, code);
    }
    const edited = await post("/api/books/book_shared/metadata", {
      expectedVersion: 0,
      changes: { title: "Edited by owner", category: "Synthetic" },
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    const saved = await edited.json();
    assert.equal(saved.metadataVersion, 1);
    assert.equal(saved.book.title, "Edited by owner");
    assert.equal(saved.book.files[0].reason, "uploaded");
    const stale = await post("/api/books/book_shared/metadata", {
      expectedVersion: 0,
      changes: { title: "Stale" },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).metadataVersion, 1);
    const trash = await post("/api/manage/books/book_shared/trash", {
      expectedVersion: 1,
    });
    assert.equal(trash.status, 200, await trash.clone().text());
    const trashed = await trash.json();
    assert.equal(trashed.trashed, true);
    assert.equal(trashed.managementVersion, 2);
    assert.equal(trashed.book.files[0].reason, "uploaded");
    assert.equal((await fetch("/api/books/book_shared")).status, 404);
    const restore = await post("/api/manage/books/book_shared/restore", {
      expectedVersion: 2,
    });
    assert.equal(restore.status, 200, await restore.clone().text());
    const restored = await restore.json();
    assert.equal(restored.trashed, false);
    assert.equal(restored.managementVersion, 3);
    assert.equal(restored.book.files[0].reason, "uploaded");
    assert.equal((await fetch("/api/books/book_shared")).status, 200);
    assert.equal(
      (
        await d1
          .prepare("SELECT count(*) AS n FROM admissions WHERE kind='metadata'")
          .first()
      ).n,
      3,
    );
    await d1
      .prepare("UPDATE sessions SET revoked=1 WHERE scope='production'")
      .run();
    assert.equal((await fetch("/api/manage")).status, 401);
    assert.equal((await fetch("/api/books/book_shared")).status, 404);
  }
});
