import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  runPreparedIndex,
  parsePreparedIndexArgs,
  preparedBudgets,
  PREPARED_SCHEMA_DEFINITIONS,
  PREPARED_SCHEMA_SHA256,
} from "../scripts/prepared-index.mjs";
import { fixture, FILE } from "./helpers/prepared-fixture.mjs";
const DBID = "11111111-1111-4111-8111-111111111111";
async function operator(
  t,
  { count = 2, populated = true, schema = true } = {},
) {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), "shelf-prepared-operator-"),
  );
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let f;
  if (populated) {
    f = await fixture(t, { count, publish: false });
    f.db.exec(
      "DROP TRIGGER shelf_prepared_chunks_delete; DROP TRIGGER shelf_prepared_index_delete; DELETE FROM shelf_prepared_index_chunks; DELETE FROM shelf_prepared_indexes;",
    );
    for (const name of [
      "shelf_prepared_chunks_delete",
      "shelf_prepared_index_delete",
    ])
      f.db.exec(PREPARED_SCHEMA_DEFINITIONS.find((d) => d.name === name).sql);
  } else {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    for (const name of [
      "schema.sql",
      ...[
        "002-conservative-storage",
        "003-storage-authority",
        "004-freeze-legacy-storage",
        "005-single-trial",
        "006-single-trial-admission",
        "007-book-management",
        "008-filename-identification",
        "009-filename-identification-observations",
      ].map((n) => `migrations/${n}.sql`),
    ])
      db.exec(
        readFileSync(
          new URL(`../cloudflare/library/${name}`, import.meta.url),
          "utf8",
        ),
      );
    if (schema) for (const d of PREPARED_SCHEMA_DEFINITIONS) db.exec(d.sql);
    f = { db };
  }
  const identity = {
    schemaVersion: 1,
    authorityId: "shelf-remote-storage-v1",
    accountId: "a".repeat(32),
    bucket: "the-shelf-books",
    legacyDatabases: {},
  };
  // Fixture identity models the full production identity including both DB pins.
  identity.legacyDatabases = {
    check: "22222222-2222-4222-8222-222222222222",
    production: DBID,
  };
  if (populated)
    f.db
      .prepare("UPDATE shelf_storage_authority SET identity_json=?")
      .run(JSON.stringify(identity));
  else
    f.db
      .prepare(
        "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,'migration_required')",
      )
      .run(JSON.stringify(identity));
  const context = {
    root,
    identity,
    credentials: { accountId: identity.accountId, token: "synthetic-token" },
    resources: {
      profiles: {
        production: { databaseId: DBID, databaseName: "the-shelf-library" },
      },
    },
    fileEnvironment: {
      SHELF_R2_ACCESS_KEY_ID: "b".repeat(32),
      SHELF_R2_SECRET_ACCESS_KEY: "c".repeat(64),
    },
  };
  const requests = [],
    events = {
      lost: null,
      mutate: null,
      hang: false,
      before: null,
      after: null,
      read: null,
    };
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body });
    assert.equal(options.redirect, "manual");
    if (url.includes("r2.cloudflarestorage.com")) {
      assert.ok(["HEAD", "GET"].includes(options.method));
      if (events.hang) return new Promise(() => {});
      const headers = {
        "content-length": String(f.bytes.length),
        "x-amz-meta-sha256": f.descriptor.sha256,
        "content-type": "application/json",
        etag: '"package-etag"',
      };
      const result = new Response(options.method === "GET" ? f.bytes : null, {
        headers,
      });
      if (events.mutate) events.mutate(options.method);
      return result;
    }
    assert.equal(new URL(url).origin, "https://api.cloudflare.com");
    assert.match(
      url,
      new RegExp(
        `/accounts/${identity.accountId}/d1/database/${DBID}(?:/query)?$`,
      ),
    );
    if (options.method === "GET")
      return Response.json({
        success: true,
        result: { uuid: DBID, name: "the-shelf-library" },
      });
    const { sql, params } = JSON.parse(options.body);
    let results;
    if (events.before) events.before(sql);
    if (/^CREATE /.test(sql.trim())) {
      f.db.exec(sql);
      results = [];
    } else if (/^INSERT /.test(sql.trim())) {
      f.db.prepare(sql).run(...params);
      results = [];
    } else results = f.db.prepare(sql).all(...params);
    if (events.after) events.after(sql);
    if (events.read) results = events.read(sql, results);
    if (events.lost && events.lost(sql)) {
      events.lost = null;
      throw Error("synthetic lost response");
    }
    return Response.json({
      success: true,
      result: [{ success: true, results }],
    });
  };
  const selection = populated
    ? {
        fileId: FILE,
        versionHash: f.pin.versionHash,
        sha256: f.descriptor.sha256,
      }
    : {};
  const run = (action, overrides = {}) =>
    runPreparedIndex({
      root,
      fetchImpl,
      ...selection,
      action,
      execute: true,
      testing: {
        loadContext: async () => context,
        loadLocal: async () => ({ descriptor: f.descriptor, bytes: f.bytes }),
      },
      ...overrides,
    });
  return { ...f, root, run, requests, events, context, selection, fetchImpl };
}
test("default preview and argument parser perform zero provider/secret/network IO", async () => {
  const dead = () => {
    throw Error("must not call");
  };
  for (const action of ["schema-status", "schema-apply"])
    assert.equal(
      (
        await runPreparedIndex({
          action,
          testing: { loadContext: dead, loadLocal: dead },
          fetchImpl: dead,
        })
      ).status,
      "preview",
    );
  const selected = {
    fileId: FILE,
    versionHash: "a".repeat(64),
    sha256: "b".repeat(64),
  };
  for (const action of ["plan", "index-status", "index-publish"])
    assert.equal(
      (
        await runPreparedIndex({
          action,
          ...selected,
          testing: { loadContext: dead, loadLocal: dead },
          fetchImpl: dead,
        })
      ).http,
      0,
    );
  assert.equal(parsePreparedIndexArgs(["schema-status"]).execute, false);
  for (const args of [
    ["schema-status", "--database", "other"],
    ["schema-status", "--execute", "--execute"],
    ["index-publish", "--file", "../bad"],
    ["schema-status", "--url", "https://bad.invalid"],
  ])
    assert.throws(() => parsePreparedIndexArgs(args), {
      code: "prepared_invalid_arguments",
    });
  assert.equal(PREPARED_SCHEMA_DEFINITIONS.length, 13);
  assert.match(PREPARED_SCHEMA_SHA256, /^[a-f0-9]{64}$/);
  assert.deepEqual(preparedBudgets(20000).indexPublish, {
    d1: 253,
    r2: 6,
    http: 259,
  });
});
test("explicit plan only validates local package without cloud context or HTTP", async (t) => {
  const f = await operator(t);
  const result = await f.run("plan", {
    testing: {
      loadLocal: async () => ({ descriptor: f.descriptor, bytes: f.bytes }),
      loadContext: () => {
        throw Error("no secrets");
      },
    },
  });
  assert.equal(result.status, "planned-local");
  assert.equal(f.requests.length, 0);
});
test("schema status uses ten fixed reads and apply installs thirteen exact immutable objects preserving all old facts", async (t) => {
  const f = await operator(t, { populated: false, schema: false });
  assert.deepEqual((await f.run("schema-status")).counts, {
    d1: 10,
    r2: 0,
    ddl: 0,
  });
  const result = await f.run("schema-apply");
  assert.deepEqual(result.counts, { d1: 33, r2: 0, ddl: 13 });
  assert.equal(result.status, "installed");
  assert.equal((await f.run("schema-status")).objects, 13);
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
});
test("schema unknown DDL stops; status observes exact object and later apply skips attempted DDL", async (t) => {
  const f = await operator(t, { populated: false, schema: false });
  f.events.lost = (sql) =>
    sql.startsWith("CREATE TABLE shelf_prepared_indexes");
  await assert.rejects(f.run("schema-apply"), {
    code: "prepared_write_outcome_unknown",
  });
  assert.equal((await f.run("schema-status")).objects, 1);
  assert.equal((await f.run("schema-apply")).status, "installed");
  assert.equal(
    f.requests.filter(
      (r) =>
        r.body &&
        JSON.parse(r.body).sql.startsWith(
          "CREATE TABLE shelf_prepared_indexes",
        ),
    ).length,
    1,
  );
});
test("cold index publish creates immutable header, chunks, publication, six R2 reads and independent bounded status", async (t) => {
  const f = await operator(t, { count: 203 });
  const result = await f.run("index-publish");
  assert.equal(result.status, "published");
  assert.equal(result.counts.r2, 6);
  assert.ok(result.counts.d1 <= preparedBudgets(203).indexPublish.d1);
  const status = await f.run("index-status");
  assert.equal(status.status, "published");
  assert.equal(status.chunks, 203);
  assert.ok(status.counts.d1 <= preparedBudgets(203).indexStatus.d1);
  assert.equal(status.counts.r2, 3);
  const batches = f.requests.filter(
    (r) =>
      r.body &&
      JSON.parse(r.body).sql.startsWith(
        "INSERT INTO shelf_prepared_index_chunks",
      ),
  );
  assert.equal(batches.length, 3);
  for (const request of batches) {
    const p = JSON.parse(request.body).params;
    assert.equal(p.length, 4);
    assert.ok(JSON.parse(p[3]).length <= 100);
    assert.ok(Buffer.byteLength(p[3]) <= 65536);
  }
  assert.equal(
    f.requests.some((r) => ["PUT", "DELETE"].includes(r.method)),
    false,
  );
});
for (const [label, match] of [
  ["header", (sql) => sql.startsWith("INSERT INTO shelf_prepared_indexes")],
  ["batch", (sql) => sql.startsWith("INSERT INTO shelf_prepared_index_chunks")],
  [
    "publication",
    (sql) => sql.startsWith("INSERT INTO shelf_prepared_index_publications"),
  ],
])
  test(`lost ${label} response is resolved only by exact readback and never replayed across invocations`, async (t) => {
    const f = await operator(t, { count: 203 });
    f.events.lost = match;
    await assert.rejects(f.run("index-publish"), {
      code: "prepared_write_outcome_unknown",
    });
    const count = f.requests.filter(
      (r) => r.body && match(JSON.parse(r.body).sql),
    ).length;
    const status = await f.run("index-status");
    assert.ok(["staged", "published"].includes(status.status));
    assert.equal((await f.run("index-publish")).status, "published");
    const writes = f.requests.filter(
      (r) => r.body && match(JSON.parse(r.body).sql),
    );
    assert.equal(writes.length, label === "batch" ? 3 : count);
  });
for (const [label, match] of [
  ["header", (sql) => sql.startsWith("INSERT INTO shelf_prepared_indexes")],
  ["batch", (sql) => sql.startsWith("INSERT INTO shelf_prepared_index_chunks")],
  [
    "publication",
    (sql) => sql.startsWith("INSERT INTO shelf_prepared_index_publications"),
  ],
])
  test(`unseen unknown ${label} is retained and never replayed even after read-only status`, async (t) => {
    const f = await operator(t);
    let thrown = false;
    f.events.before = (sql) => {
      if (!thrown && match(sql)) {
        thrown = true;
        throw Error("synthetic request delivery unknown");
      }
    };
    await assert.rejects(f.run("index-publish"), {
      code: "prepared_write_outcome_unknown",
    });
    f.events.before = null;
    await f.run("index-status");
    await assert.rejects(f.run("index-publish"), {
      code: "prepared_write_outcome_unknown",
    });
    assert.equal(
      f.requests.filter((r) => r.body && match(JSON.parse(r.body).sql)).length,
      1,
    );
  });
test("unseen unknown DDL never retries even when status reports absent", async (t) => {
  const f = await operator(t, { populated: false, schema: false });
  let thrown = false;
  f.events.before = (sql) => {
    if (!thrown && sql.startsWith("CREATE TABLE shelf_prepared_indexes")) {
      thrown = true;
      throw Error("unknown delivery");
    }
  };
  await assert.rejects(f.run("schema-apply"), {
    code: "prepared_write_outcome_unknown",
  });
  f.events.before = null;
  assert.equal((await f.run("schema-status")).objects, 0);
  await assert.rejects(f.run("schema-apply"), {
    code: "prepared_write_outcome_unknown",
  });
  assert.equal(
    f.requests.filter(
      (r) =>
        r.body &&
        JSON.parse(r.body).sql.startsWith(
          "CREATE TABLE shelf_prepared_indexes",
        ),
    ).length,
    1,
  );
});
test("unknown partial batch refuses continuation and unpublished fragments never appear readable", async (t) => {
  const f = await operator(t, { count: 203 });
  f.events.lost = (sql) =>
    sql.startsWith("INSERT INTO shelf_prepared_index_chunks");
  await assert.rejects(f.run("index-publish"), {
    code: "prepared_write_outcome_unknown",
  });
  f.db.exec(
    "DROP TRIGGER shelf_prepared_chunks_delete; DELETE FROM shelf_prepared_index_chunks WHERE chunk_index=99",
  );
  f.db.exec(
    PREPARED_SCHEMA_DEFINITIONS.find(
      (d) => d.name === "shelf_prepared_chunks_delete",
    ).sql,
  );
  assert.equal((await f.run("index-status")).status, "staged");
  await assert.rejects(f.run("index-publish"), {
    code: "prepared_partial_batch",
  });
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM shelf_prepared_readable_sources")
      .get().n,
    0,
  );
});
test("status recovery uses original frozen package and never reloads changed current pins", async (t) => {
  const f = await operator(t);
  await f.run("index-publish");
  const result = await f.run("index-status", {
    testing: {
      loadContext: async () => f.context,
      loadLocal: () => {
        throw Error("must not reread current pin");
      },
    },
  });
  assert.equal(result.status, "published");
});
test("source withdrawal during first and second R2 rounds refuses publication/result", async (t) => {
  for (const round of [1, 2]) {
    const f = await operator(t);
    let gets = 0;
    f.events.mutate = (method) => {
      if (method === "GET" && ++gets === round)
        f.db.exec("UPDATE file_registry SET version=version+1");
    };
    await assert.rejects(f.run("index-publish"), {
      code: "prepared_source_changed",
    });
    if (round === 1)
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM shelf_prepared_index_publications",
          )
          .get().n,
        0,
      );
  }
});
test("status rechecks source after R2; source drift returns no successful status", async (t) => {
  const f = await operator(t);
  await f.run("index-publish");
  f.events.mutate = (method) => {
    if (method === "GET")
      f.db.exec("UPDATE file_registry SET version=version+1");
  };
  await assert.rejects(f.run("index-status"), {
    code: "prepared_source_changed",
  });
});
test("schema preserves frozen legacy data, and detects concurrent old fact mutations", async (t) => {
  const f = await operator(t, { populated: false, schema: false });
  let changed = false;
  f.events.after = (sql) => {
    if (!changed && sql.startsWith("CREATE TABLE shelf_prepared_indexes")) {
      changed = true;
      f.db.exec(
        "UPDATE public_state SET revision=revision+1 WHERE scope='production'",
      );
    }
  };
  await assert.rejects(f.run("schema-apply"), {
    code: "prepared_schema_preservation_failed",
  });
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name=?")
      .get("shelf_prepared_indexes").n,
    1,
  );
});
test("schema conflicts or authority identity mismatch cause zero DDL", async (t) => {
  const f = await operator(t, { populated: false, schema: false });
  f.db.exec("CREATE TABLE shelf_prepared_indexes(private_data TEXT)");
  await assert.rejects(f.run("schema-apply"), {
    code: "prepared_schema_conflict",
  });
  assert.equal(
    f.requests.some((r) => r.body && /^CREATE /.test(JSON.parse(r.body).sql)),
    false,
  );
  const g = await operator(t, { populated: false, schema: false });
  g.db.exec("DROP TRIGGER shelf_storage_identity_guard");
  // Exact old schema check already prevents this drift, without extending reads.
  await assert.rejects(g.run("schema-apply"), {
    code: "prepared_schema_incomplete",
  });
});
test("20,000 chunks publish completely within 259 total requests and zero PUT", async (t) => {
  const f = await operator(t, { count: 20000 }),
    result = await f.run("index-publish");
  assert.equal(result.status, "published");
  assert.ok(f.requests.length <= 259);
  assert.equal(result.counts.r2, 6);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM shelf_prepared_index_chunks").get()
      .n,
    20000,
  );
  assert.equal((await f.run("index-status")).chunks, 20000);
});
test("D1 malformed/oversized response after mutating request becomes durable unknown", async (t) => {
  const f = await operator(t);
  f.events.read = (sql, rows) =>
    sql.startsWith("INSERT INTO shelf_prepared_indexes")
      ? [{ private: "x".repeat(1100000) }]
      : rows;
  await assert.rejects(f.run("index-publish"), {
    code: "prepared_write_outcome_unknown",
  });
  f.events.read = null;
  assert.equal((await f.run("index-status")).status, "staged");
  assert.equal((await f.run("index-publish")).status, "published");
});
test("D1 named column reorder does not alter row equality or source authorization", async (t) => {
  const f = await operator(t, { count: 120 });
  f.events.read = (_sql, rows) =>
    rows.map((row) => Object.fromEntries(Object.entries(row).reverse()));
  assert.equal((await f.run("index-publish")).status, "published");
  assert.equal((await f.run("index-status")).chunks, 120);
});
test("extra staged chunk and corrupted primitive/hash fields fail before publication", async (t) => {
  for (const mutation of ["extra", "hash", "type"]) {
    const f = await operator(t);
    f.events.lost = (sql) =>
      sql.startsWith("INSERT INTO shelf_prepared_index_chunks");
    await assert.rejects(f.run("index-publish"), {
      code: "prepared_write_outcome_unknown",
    });
    if (mutation === "extra") {
      f.db.exec("DROP TRIGGER shelf_prepared_chunk_insert");
      f.db.exec(
        "INSERT INTO shelf_prepared_index_chunks SELECT scope,file_id,version_hash,2,locator_type,section_number,start_offset,end_offset,chunk_sha256,codepoints,utf8_bytes FROM shelf_prepared_index_chunks WHERE chunk_index=0",
      );
      f.db.exec(
        PREPARED_SCHEMA_DEFINITIONS.find(
          (d) => d.name === "shelf_prepared_chunk_insert",
        ).sql,
      );
    } else if (mutation === "hash") {
      f.db.exec("DROP TRIGGER shelf_prepared_chunks_update");
      f.db
        .prepare(
          "UPDATE shelf_prepared_index_chunks SET chunk_sha256=? WHERE chunk_index=0",
        )
        .run("a".repeat(64));
      f.db.exec(
        PREPARED_SCHEMA_DEFINITIONS.find(
          (d) => d.name === "shelf_prepared_chunks_update",
        ).sql,
      );
    } else
      f.events.read = (sql, rows) =>
        sql.includes("SELECT chunk_index,")
          ? rows.map((r) => ({ ...r, chunk_index: String(r.chunk_index) }))
          : rows;
    await assert.rejects(f.run("index-status"), (error) =>
      ["prepared_index_conflict", "prepared_index_mismatch"].includes(
        error.code,
      ),
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM shelf_prepared_index_publications")
        .get().n,
      0,
    );
  }
});
test("D1 deadline cancels late response and frozen unknown writes cannot replay", async (t) => {
  const f = await operator(t);
  let resolve,
    cancelled = 0;
  const custom = async (url, options) => {
    if (
      options.body &&
      JSON.parse(options.body).sql.startsWith(
        "INSERT INTO shelf_prepared_indexes",
      )
    )
      return new Promise((done) => {
        resolve = done;
      });
    return f.fetchImpl(url, options);
  };
  await assert.rejects(
    f.run("index-publish", { fetchImpl: custom, timeoutMs: 200 }),
    { code: "prepared_write_outcome_unknown" },
  );
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
    ),
  );
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(cancelled, 1);
  await assert.rejects(f.run("index-publish"), {
    code: "prepared_write_outcome_unknown",
  });
});
test("R2 late/hanging response is bounded, cancelled and never dispatches index writes", async (t) => {
  const f = await operator(t);
  let resolve,
    cancelled = 0;
  const custom = async (url, options) =>
    url.includes("r2.cloudflarestorage.com")
      ? new Promise((done) => {
          resolve = done;
        })
      : f.fetchImpl(url, options);
  await assert.rejects(
    f.run("index-publish", { fetchImpl: custom, timeoutMs: 200 }),
  );
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
    ),
  );
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(cancelled, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM shelf_prepared_indexes").get().n,
    0,
  );
});
test("redirects and truncated/tampered R2 bodies are rejected with zero D1 mutations", async (t) => {
  for (const variant of ["redirect", "tampered", "truncated"]) {
    const f = await operator(t);
    const custom = async (url, options) => {
      const result = await f.fetchImpl(url, options);
      if (!url.includes("r2.cloudflarestorage.com")) return result;
      if (variant === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://wrong.invalid" },
        });
      if (options.method !== "GET") return result;
      const bytes =
        variant === "truncated"
          ? f.bytes.slice(0, -1)
          : Uint8Array.from(f.bytes, (v, i) => (i === 8 ? 1 : v));
      return new Response(bytes, { headers: result.headers });
    };
    await assert.rejects(f.run("index-publish", { fetchImpl: custom }));
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM shelf_prepared_indexes").get().n,
      0,
    );
  }
});
test("the global tuple claim excludes alternate run/path flags and detects plan budget tampering", async (t) => {
  const f = await operator(t);
  f.events.lost = (sql) => sql.startsWith("INSERT INTO shelf_prepared_indexes");
  await assert.rejects(f.run("index-publish"), {
    code: "prepared_write_outcome_unknown",
  });
  const dirs = await fs.readdir(
    path.join(f.root, ".local/prepared-index/indexes"),
  );
  assert.equal(dirs.length, 1);
  const filename = path.join(
      f.root,
      ".local/prepared-index/indexes",
      dirs[0],
      "plan.json",
    ),
    plan = JSON.parse(await fs.readFile(filename, "utf8"));
  plan.budgets.indexStatus.http = 999;
  await fs.writeFile(filename, JSON.stringify(plan), { mode: 0o600 });
  await assert.rejects(f.run("index-status"), {
    code: "prepared_plan_conflict",
  });
  assert.throws(
    () => parsePreparedIndexArgs(["index-publish", "--run", "new"]),
    { code: "prepared_invalid_arguments" },
  );
});
test("current catalog and retained import rows fit separate bounded schema snapshots without truncation", async (t) => {
  const f = await operator(t, { populated: false, schema: false });
  const books = JSON.parse(
    readFileSync(new URL("../data/catalog.json", import.meta.url), "utf8"),
  ).books;
  const insert = f.db.prepare(
    "INSERT INTO catalog_books VALUES('production',?,?)",
  );
  const imported = f.db.prepare(
    "INSERT INTO catalog_import_rows VALUES('production',?,?,?,NULL,?)",
  );
  f.db
    .prepare(
      "INSERT INTO catalog_imports(scope,input_hash,base_hash,owner_token,state,book_count,patch_count,started_at,updated_at) VALUES('production',?,?,?,'active',?,0,1,1)",
    )
    .run("a".repeat(64), "a".repeat(64), "synthetic-writer", books.length);
  for (const book of books) {
    insert.run(book.id, JSON.stringify(book));
    imported.run(
      "a".repeat(64),
      book.id,
      JSON.stringify(book),
      "synthetic-writer",
    );
  }
  assert.equal((await f.run("schema-status")).counts.d1, 10);
});
test("published status requires complete ordered coverage after unexpected persisted corruption", async (t) => {
  const f = await operator(t);
  await f.run("index-publish");
  f.db.exec(
    "DROP TRIGGER shelf_prepared_chunks_delete; DELETE FROM shelf_prepared_index_chunks WHERE chunk_index=1",
  );
  f.db.exec(
    PREPARED_SCHEMA_DEFINITIONS.find(
      (d) => d.name === "shelf_prepared_chunks_delete",
    ).sql,
  );
  await assert.rejects(f.run("index-status"), {
    code: "prepared_index_incomplete",
  });
  const g = await operator(t);
  await g.run("index-publish");
  g.events.read = (sql, rows) =>
    sql.includes("SELECT chunk_index,") ? rows.toReversed() : rows;
  await assert.rejects(g.run("index-status"), {
    code: "prepared_index_mismatch",
  });
});
