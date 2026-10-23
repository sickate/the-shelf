import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  runIdentifyObservationSchema,
  IDENTIFY_OBSERVATION_SCHEMA,
  IDENTIFY_OBSERVATION_SCHEMA_SQL,
} from "../scripts/identify-observation-schema.mjs";
const ACCOUNT = "a".repeat(32),
  IDS = {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  };
async function fixture(t) {
  const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "shelf-identification-schema-")),
    ),
    db = new DatabaseSync(":memory:");
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = await fs.readFile(
    new URL("../cloudflare/library/schema.sql", import.meta.url),
    "utf8",
  );
  db.exec(base);
  for (const n of [
    "003-storage-authority",
    "004-freeze-legacy-storage",
    "005-single-trial",
    "006-single-trial-admission",
    "007-book-management",
    "008-filename-identification",
  ])
    db.exec(
      await fs.readFile(
        new URL(
          "../cloudflare/library/migrations/" + n + ".sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const identity = {
    schemaVersion: 1,
    authorityId: "shelf-remote-storage-v1",
    accountId: ACCOUNT,
    bucket: "the-shelf-books",
    legacyDatabases: IDS,
  };
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,'migration_required')",
  ).run(JSON.stringify(identity));
  for (const scope of ["check", "production"])
    db.prepare(
      "INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(scope, "f".repeat(64), "e".repeat(64), "{}", "{}", 0, 0, 0, 0);
  db.prepare(
    "UPDATE shelf_storage_authority SET phase='imported',migration_hash=? WHERE id=1",
  ).run("f".repeat(64));
  const now = Date.now(),
    descriptor = {
      kind: "original",
      scope: "production",
      fileId: "trial_file",
      bookId: "trial_book",
      format: "PDF",
      sizeBytes: 5,
      sha256: "a".repeat(64),
      objectKey: "books/cf03/trial_file/" + "a".repeat(64) + ".pdf",
      versionHash: null,
      source: null,
    };
  db.prepare(
    "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'reserved',0,0,NULL,?)",
  ).run(
    "first-book",
    "2026-10-23-first-book",
    JSON.stringify(identity),
    JSON.stringify({
      accountId: ACCOUNT,
      bucket: "the-shelf-first-book-20261023",
    }),
    JSON.stringify(descriptor),
    "b".repeat(64),
    5,
    now,
    now + 60000,
    now,
  );
  db.exec(
    "UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1; UPDATE shelf_storage_single_trial SET state='confirmed',content_verified=1,etag='synthetic'",
  );
  db.prepare(
    "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,1,?)",
  ).run("https://the-shelf.iamzhutuo.workers.dev", "c".repeat(64), now);
  db.prepare("INSERT INTO sessions VALUES('production',?,1,?,?,0)").run(
    "d".repeat(64),
    now,
    now + 60000,
  );
  db.prepare(
    "INSERT INTO filename_identifications VALUES('production',?,?,'filename-v1',?,1,?,?,?,12,'pending',NULL,NULL,NULL,?)",
  ).run(
    "11111111-aaaa-4aaa-8aaa-111111111111",
    "9".repeat(64),
    "d".repeat(64),
    now,
    now + 60000,
    Math.floor(now / 86400000),
    now,
  );
  db.prepare(
    "UPDATE filename_identifications SET state='uncertain',error_code='identify_reconciliation_required' WHERE scope='production'",
  ).run();
  const context = {
    root,
    identity,
    credentials: { accountId: ACCOUNT, token: "synthetic-private-token" },
    resources: {
      profiles: {
        production: {
          databaseId: IDS.production,
          databaseName: "the-shelf-library",
        },
      },
    },
  };
  let requests = 0,
    ddl = 0,
    fault = null;
  const fetchImpl = async (url, options) => {
    requests++;
    assert.ok(
      url.startsWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${IDS.production}`,
      ),
    );
    assert.equal(options.redirect, "error");
    if (!url.endsWith("/query"))
      return Response.json({
        success: true,
        result: { uuid: IDS.production, name: "the-shelf-library" },
      });
    const { sql, params } = JSON.parse(options.body);
    if (/^(?:CREATE|DROP)/.test(sql)) ddl++;
    const results = db.prepare(sql).all(...params);
    if (fault) await fault(sql);
    return Response.json({
      success: true,
      result: [{ success: true, results }],
    });
  };
  let sequence = 0;
  const run = (action = "apply", options = {}) =>
    runIdentifyObservationSchema({
      action,
      execute: true,
      runId: "run-" + ++sequence,
      root,
      context,
      fetchImpl,
      ...options,
    });
  return {
    root,
    db,
    run,
    requests: () => requests,
    ddl: () => ddl,
    transport: fetchImpl,
    setFault: (f) => (fault = f),
  };
}
test("fixed009 preview has no credential/network/journal operations", async () => {
  let fetches = 0;
  const r = await runIdentifyObservationSchema({
    action: "apply",
    fetchImpl: () => {
      fetches++;
      throw Error("network");
    },
    root: "/missing",
  });
  assert.equal(r.requests, 0);
  assert.equal(fetches, 0);
  assert.equal(r.uploadAllowed, false);
});
test("fixed009 installs new guard before old guard removal and preserves every008 row", async (t) => {
  const f = await fixture(t),
    before = f.db.prepare("SELECT * FROM shelf_storage_authority").get(),
    oldRows = f.db
      .prepare(
        "SELECT * FROM filename_identifications ORDER BY scope,request_id",
      )
      .all();
  const r = await f.run();
  assert.equal(r.schema, "complete");
  assert.equal(r.ddl, 6);
  assert.equal(r.requests, 25);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT * FROM filename_identifications ORDER BY scope,request_id",
      )
      .all(),
    oldRows,
  );
  assert.equal(f.ddl(), 6);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM shelf_storage_authority").get(),
    before,
  );
  assert.equal(
    (
      await fs.stat(
        path.join(
          f.root,
          ".local/identify-observation-schema/apply-claim.json",
        ),
      )
    ).mode & 0o777,
    0o600,
  );
  const status = await f.run("status");
  assert.equal(status.schema, "complete");
  assert.equal(status.requests, 9);
  assert.equal((await f.run()).ddl, 0);
  assert.equal(f.ddl(), 6);
});
test("unknown DDL retains immutable global claim and another run never replays", async (t) => {
  const f = await fixture(t);
  f.setFault((sql) => {
    if (sql.startsWith("CREATE")) throw Error("lost response");
  });
  await assert.rejects(
    f.run(),
    (e) => e.code === "observation_schema_write_unknown",
  );
  assert.equal(f.ddl(), 1);
  f.setFault(null);
  assert.equal((await f.run("status")).schema, "partial");
  await assert.rejects(
    f.run(),
    (e) => e.code === "observation_schema_partial_requires_review",
  );
  assert.equal(f.ddl(), 1);
});
test("first DDL not committed still prevents a new apply through durable global claim", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run("apply", {
      fetchImpl: async (url, options) => {
        if (options.body && JSON.parse(options.body).sql.startsWith("CREATE"))
          throw Error("not dispatched");
        return f.transport(url, options);
      },
    }),
    (e) => e.code === "observation_schema_write_unknown",
  );
  assert.equal(f.ddl(), 0);
  assert.equal((await f.run("status")).schema, "original");
  await assert.rejects(
    f.run(),
    (e) => e.code === "single_trial_attempt_already_recorded",
  );
  assert.equal(f.ddl(), 0);
});
test("incompatible existing name refuses all schema writes", async (t) => {
  const f = await fixture(t);
  f.db.exec("CREATE TABLE filename_identification_observations(bad TEXT)");
  await assert.rejects(f.run(), (e) => e.code === "observation_schema_invalid");
  assert.equal(f.ddl(), 0);
});
test("auth mutation during apply is detected and original single-trial stays retained", async (t) => {
  const f = await fixture(t);
  f.setFault((sql) => {
    if (sql.startsWith("CREATE"))
      f.db.exec("UPDATE auth_config SET enabled=0 WHERE scope='production'");
  });
  await assert.rejects(
    f.run(),
    (e) => e.code === "observation_schema_protected_facts_changed",
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT put_attempted,content_verified FROM shelf_storage_single_trial",
      )
      .get().put_attempted,
    1,
  );
});
test("request deadline remains bounded even when a transport ignores AbortSignal", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run("status", {
      fetchImpl: () => new Promise(() => {}),
      requestTimeoutMs: 5,
    }),
    (e) => e.code === "observation_schema_read_failed",
  );
  assert.equal(f.ddl(), 0);
});
test("every DDL step retains an admission guard and exact dual guards are read before DROP", async (t) => {
  const f = await fixture(t),
    events = [];
  f.setFault((sql) => {
    if (/^(CREATE|DROP)/.test(sql)) {
      const guards = f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('filename_identification_admit','filename_identification_admit_v2')",
        )
        .all();
      assert.ok(guards.length >= 1);
    }
    if (sql === IDENTIFY_OBSERVATION_SCHEMA_SQL.schema)
      events.push("read-schema");
    if (sql.startsWith("CREATE TRIGGER filename_identification_admit_v2"))
      events.push("create-v2");
    if (sql.startsWith("DROP TRIGGER")) {
      assert.deepEqual(events.slice(-2), ["create-v2", "read-schema"]);
      events.push("drop-v1");
    }
  });
  await f.run();
  assert.equal(events.filter((e) => e === "drop-v1").length, 1);
});
test("changed new guard prevents old guard DROP even after all five CREATE responses", async (t) => {
  const f = await fixture(t);
  f.setFault((sql) => {
    if (sql.startsWith("CREATE TRIGGER filename_identification_admit_v2"))
      f.db.exec(
        "DROP TRIGGER filename_identification_admit_v2; CREATE TRIGGER filename_identification_admit_v2 BEFORE INSERT ON filename_identifications BEGIN SELECT RAISE(ABORT,'changed'); END",
      );
  });
  await assert.rejects(f.run(), (e) => e.code === "observation_schema_invalid");
  assert.equal(f.ddl(), 5);
  assert.ok(
    f.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='filename_identification_admit'",
      )
      .get(),
  );
});
test("unknown final DROP can be independently status-read but never repeats DDL", async (t) => {
  const f = await fixture(t);
  f.setFault((sql) => {
    if (sql.startsWith("DROP TRIGGER")) throw Error("unknown-drop");
  });
  await assert.rejects(
    f.run(),
    (e) => e.code === "observation_schema_write_unknown",
  );
  f.setFault(null);
  assert.equal((await f.run("status")).schema, "complete");
  assert.equal(f.ddl(), 6);
});
function addPending(f, suffix = "2") {
  const now = Date.now(),
    id = `22222222-aaaa-4aaa-8aaa-${suffix.repeat(12)}`;
  f.db
    .prepare(
      "INSERT INTO filename_identifications VALUES('production',?,?,'filename-v1',?,1,?,?,?,12,'pending',NULL,NULL,NULL,?)",
    )
    .run(
      id,
      suffix.repeat(64),
      "d".repeat(64),
      now,
      now + 60000,
      Math.floor(now / 86400000),
      now,
    );
  return id;
}
test("a concurrent008 row change is detected without clearing old uncertain responsibility", async (t) => {
  const f = await fixture(t);
  f.setFault((sql) => {
    if (sql.startsWith("DROP TRIGGER")) addPending(f);
  });
  await assert.rejects(
    f.run(),
    (e) => e.code === "observation_schema_protected_facts_changed",
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT state FROM filename_identifications WHERE request_id='11111111-aaaa-4aaa-8aaa-111111111111'",
      )
      .get().state,
    "uncertain",
  );
});
test("status accepts preserved diagnostic history; apply refuses it without further DDL", async (t) => {
  const f = await fixture(t);
  await f.run();
  const id = addPending(f);
  f.db
    .prepare(
      "INSERT INTO filename_identification_observations(scope,request_id,phase) VALUES('production',?,'fetch_error')",
    )
    .run(id);
  f.db
    .prepare(
      "UPDATE filename_identifications SET state='uncertain' WHERE request_id=?",
    )
    .run(id);
  const status = await f.run("status");
  assert.equal(status.schema, "complete");
  assert.equal(status.requests, 9);
  await assert.rejects(
    f.run(),
    (e) => e.code === "observation_schema_diagnostics_invalid",
  );
  assert.equal(f.ddl(), 6);
});
