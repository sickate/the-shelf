import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, NoOpLog, convertV4MiniflareOptions } from "miniflare";
import { fixture, FILE, BOOK } from "./helpers/prepared-v2-fixture.mjs";
import { randomKey, sessionDigest } from "../cloudflare/library/security.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
test("real workerd v2 prepared normal 20k pages, trial and conflict: exact budgets and private output", async (t) => {
  const secret = randomKey(),
    pepper = randomKey(),
    token = randomKey();
  const fixtures = {
    normal: await fixture(t, { count: 20000, extraFile: true }),
    trial: await fixture(t, { source: "trial" }),
    both: await fixture(t, { source: "both" }),
  };
  const bundle = await build({
    stdin: {
      contents: `import {handleRequest} from ${JSON.stringify(path.join(ROOT, "cloudflare/library/worker.mjs"))};
export default {async fetch(request,env){const metrics={d1:0,sources:0,access:0,pages:0,r2:[]};
const wrapStatement=(statement,sql)=>({statement,bind(...args){return wrapStatement(statement.bind(...args),sql)},async first(){metrics.d1++;if(sql.includes('prepared_payload'))metrics.sources++;if(sql.includes('INSERT INTO admissions')&&sql.includes('current_source'))metrics.access++;return statement.first()},async all(){metrics.d1++;if(sql.includes('LIMIT 1000'))metrics.pages++;return statement.all()},async run(){metrics.d1++;return statement.run()}});
const wrapDB=db=>({prepare(sql){return wrapStatement(db.prepare(sql),sql)},batch(statements){metrics.d1+=statements.length;return db.batch(statements.map(s=>s.statement))},withSession(mode){return wrapDB(db.withSession(mode))}});
const wrapStore=(store,role)=>({head(...args){metrics.r2.push(role+':head');return store.head(...args)},get(...args){metrics.r2.push(role+':get');return store.get(...args)}});
const result=await handleRequest(request,{...env,DB:wrapDB(env.DB),BOOKS:wrapStore(env.BOOKS,'normal'),TRIAL_BOOKS:wrapStore(env.TRIAL_BOOKS,'trial'),PREPARED_BOOKS:wrapStore(env.PREPARED_BOOKS,'prepared')});
return Response.json({status:result.status,payload:await result.json(),metrics})}};`,
      resolveDir: ROOT,
      sourcefile: "synthetic-prepared-v2-harness.mjs",
    },
    platform: "neutral",
    bundle: true,
    write: false,
    format: "esm",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      log: new NoOpLog(),
      workers: Object.entries(fixtures).map(([name, f]) => ({
        name,
        modules: true,
        compatibilityDate: "2026-10-15",
        rootPath: ROOT,
        scriptPath: path.join(ROOT, "tests", `synthetic-prepared-${name}.mjs`),
        script: bundle.outputFiles[0].text,
        bindings: {
          APP_SCOPE: "production",
          SITE_ORIGIN: f.grant.context.origin,
          STORAGE_MODE: "authority-v2",
          STORAGE_WRITE_MODE: "closed",
          R2_ACCOUNT_ID: f.env.R2_ACCOUNT_ID,
          R2_BUCKET: f.env.R2_BUCKET,
          TRIAL_R2_ACCOUNT_ID: f.env.TRIAL_R2_ACCOUNT_ID,
          TRIAL_R2_BUCKET: f.env.TRIAL_R2_BUCKET,
          TRIAL_TARGET_SHA256: f.env.TRIAL_TARGET_SHA256,
          FILENAME_AI_MODE: "filename-v1",
          PREPARED_TEXT_MODE: "registry-v1",
          PREPARED_R2_ACCOUNT_ID: f.env.R2_ACCOUNT_ID,
          PREPARED_R2_BUCKET: "the-shelf-books",
          OWNER_KEY_PEPPER: pepper,
          SESSION_SECRET: secret,
        },
        d1Databases: { DB: `prepared-${name}` },
        r2Buckets: {
          BOOKS: `normal-${name}`,
          PREPARED_BOOKS: `normal-${name}`,
          TRIAL_BOOKS: `trial-${name}`,
        },
        outboundService() {
          throw Error("unexpected outbound request");
        },
      })),
    }),
  );
  t.after(() => mf.dispose());
  for (const [name, f] of Object.entries(fixtures)) {
    const digest = await sessionDigest(token, secret, f.grant.context),
      bucket = await mf.getR2Bucket("PREPARED_BOOKS", name),
      stored = await bucket.put(f.descriptor.objectKey, f.bytes);
    f.unsafe(() => {
      f.db
        .prepare("UPDATE sessions SET session_hash=?,expires_at=?")
        .run(digest, f.grant.context.now + 600000);
      f.db
        .prepare("UPDATE shelf_storage_text_registry SET etag=?")
        .run(stored.etag);
      f.db
        .prepare(
          "UPDATE shelf_storage_reservations SET etag=? WHERE reservation_id='text-reservation'",
        )
        .run(stored.etag);
      f.db.prepare("UPDATE shelf_prepared_indexes SET etag=?").run(stored.etag);
      // Skip the separately budgeted existing ordinal-maintenance branch.
      f.db
        .prepare(
          "INSERT INTO counters VALUES('production','api_day','global',?,1,1000)",
        )
        .run(Math.floor(Date.now() / 86400000));
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
      "shelf_storage_text_registry",
      "shelf_prepared_indexes",
      "shelf_prepared_index_chunks",
      "shelf_prepared_index_publications",
    ];
    const tables = f.schema
      .filter((r) => r.type === "table")
      .sort(
        (a, b) =>
          (order.includes(a.name) ? order.indexOf(a.name) : 100) -
          (order.includes(b.name) ? order.indexOf(b.name) : 100),
      );
    for (const table of tables) {
      const rows = f.db.prepare(`SELECT * FROM ${table.name}`).all();
      for (let start = 0; start < rows.length; start += 100) {
        await d1.batch(
          rows.slice(start, start + 100).map((row) => {
            const cols = Object.keys(row);
            return d1
              .prepare(
                `INSERT INTO ${table.name}(${cols.join(",")})VALUES(${cols.map(() => "?").join(",")})`,
              )
              .bind(...Object.values(row));
          }),
        );
      }
    }
    for (const row of f.schema.filter((r) => r.type === "trigger"))
      await d1.prepare(row.sql).run();
    const worker = await mf.getWorker(name),
      url = `${f.grant.context.origin}/api/books/${BOOK}/prepared?fileId=${FILE}&versionHash=${f.selected.versionHash}`;
    const response = await worker.fetch(url, {
        headers: { cookie: `__Host-shelf_session=${token}` },
      }),
      result = await response.json();
    assert.equal(
      result.status,
      name === "normal" ? 200 : 409,
      JSON.stringify(result),
    );
    const accesses = await d1
      .prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'")
      .first();
    if (name === "normal") {
      assert.equal(result.payload.chunkCount, 20000);
      assert.equal(result.payload.chapters.length, 32);
      assert.equal(result.payload.nextCursor, 32);
      assert.equal(accesses.n, 1);
      assert.deepEqual(result.metrics, {
        d1: 26,
        sources: 3,
        access: 1,
        pages: 20,
        r2: ["prepared:head", "prepared:get", "prepared:head"],
      });
      const body = JSON.stringify(result.payload);
      for (const forbidden of [
        f.descriptor.objectKey,
        f.pin.sourceSha256,
        f.header[6],
        "reservation",
        "etag",
        "mtimeNs",
        "text",
      ])
        assert.equal(body.includes(forbidden), false, forbidden);
    } else {
      assert.equal(accesses.n, 0);
      assert.deepEqual(result.metrics.r2, []);
      assert.deepEqual(Object.keys(result.payload), ["error"]);
    }
  }
});
