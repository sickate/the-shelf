import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, NoOpLog, convertV4MiniflareOptions } from "miniflare";
import { fixture, context, session } from "./helpers/storage-read-fixture.mjs";
import { randomKey, sessionDigest } from "../cloudflare/library/security.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
test("real workerd v2 Worker reads both bindings and atomically admits once, without browser_uploads or external requests", async (t) => {
  const files = { normal: fixture(t), trial: fixture(t, { source: "trial" }) };
  const secret = randomKey(),
    pepper = randomKey(),
    token = randomKey(),
    digest = await sessionDigest(token, secret, context);
  const bundle = await build({
    entryPoints: [path.join(ROOT, "cloudflare/library/worker.mjs")],
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
        modules: true,
        compatibilityDate: "2026-10-15",
        rootPath: ROOT,
        scriptPath: path.join(
          ROOT,
          "tests",
          `synthetic-storage-read-${name}.mjs`,
        ),
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
        d1Databases: { DB: `storage-read-${name}` },
        r2Buckets: {
          BOOKS: "storage-read-normal",
          TRIAL_BOOKS: "storage-read-trial",
        },
        outboundService() {
          throw Error("unexpected external request");
        },
      })),
    }),
  );
  t.after(() => mf.dispose());
  const stores = {
    normal: await mf.getR2Bucket("BOOKS", "normal"),
    trial: await mf.getR2Bucket("TRIAL_BOOKS", "normal"),
  };
  for (const [name, f] of Object.entries(files)) {
    const stored = await stores[name].put(
      f.d.objectKey,
      name === "normal" ? "normal original" : "trial isolated!",
      {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: { sha256: f.d.sha256 },
      },
    );
    f.unsafe(() => {
      f.db.prepare("UPDATE sessions SET session_hash=?").run(digest);
      for (const table of name === "normal"
        ? [
            "file_registry",
            "shelf_storage_original_registry",
            "shelf_storage_reservations",
          ]
        : ["shelf_storage_single_trial"])
        f.db.prepare(`UPDATE ${table} SET etag=?`).run(stored.etag);
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
    const tables = f.schema
      .filter((row) => row.type === "table")
      .sort((a, b) => {
        const rank = (name) =>
          order.includes(name) ? order.indexOf(name) : order.length;
        return rank(a.name) - rank(b.name);
      });
    for (const row of tables)
      for (const value of f.db.prepare(`SELECT * FROM ${row.name}`).all()) {
        const columns = Object.keys(value);
        await d1
          .prepare(
            `INSERT INTO ${row.name}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...columns.map((key) => value[key]))
          .run();
      }
    for (const row of f.schema.filter((row) => row.type === "trigger"))
      await d1.prepare(row.sql).run();
    const worker = await mf.getWorker(name),
      headers = { cookie: `__Host-shelf_session=${token}` },
      url = context.origin + "/api/files/file_shared/";
    let accesses = 0;
    for (const [action, method, range] of [
      ["access", "GET"],
      ["access", "HEAD"],
      ["content", "GET"],
      ["content", "HEAD"],
      ["content", "GET", "bytes=0-4"],
    ]) {
      const response = await worker.fetch(url + action, {
        method,
        headers: { ...headers, ...(range ? { range } : {}) },
      });
      assert.equal(
        response.status,
        range ? 206 : 200,
        `${name} ${action} ${method}: ${await response.clone().text()}`,
      );
      if (method === "HEAD") assert.equal(await response.text(), "");
      else if (action === "access")
        assert.equal(
          (await response.json()).url,
          "/api/files/file_shared/content",
        );
      else
        assert.equal(
          await response.text(),
          range
            ? name === "normal"
              ? "norma"
              : "trial"
            : name === "normal"
              ? "normal original"
              : "trial isolated!",
        );
      assert.equal(
        (
          await d1
            .prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'")
            .first()
        ).n,
        ++accesses,
      );
    }
    for (const [extra, status] of [
      [{ range: "bytes=100-" }, 416],
      [{ "if-match": "other" }, 412],
    ]) {
      const response = await worker.fetch(url + "content", {
        headers: { ...headers, ...extra },
      });
      assert.equal(response.status, status);
      assert.equal(
        (
          await d1
            .prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'")
            .first()
        ).n,
        accesses,
      );
    }
    // A source-specific absence cannot cause fallback to the same key in the other bucket.
    await stores[name].delete(f.d.objectKey);
    const missing = await worker.fetch(url + "content", { headers });
    assert.equal(missing.status, 409);
    assert.equal(
      (
        await d1
          .prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'")
          .first()
      ).n,
      accesses,
    );
    assert.equal(
      (await d1.prepare("SELECT count(*) AS n FROM browser_uploads").first()).n,
      0,
    );
  }
});
