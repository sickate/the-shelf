import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  preflightPreview,
  runReadonlyPreflight,
  createPreflightJournal,
} from "../scripts/cf-cpu-preflight.mjs";
import { CHECK } from "../scripts/cf-cpu-sampler.mjs";

const accountId = "a".repeat(32),
  token = "SYNTHETIC-TOKEN-NEVER-LOG-THIS";
const dbid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const versionId = "11111111-2222-4333-8444-555555555555";
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const worker = `${base}/workers/scripts/${CHECK.name}`,
  database = `${base}/d1/database/${dbid}`;
const deployConfig = {
  schemaVersion: 1,
  profiles: {
    check: { databaseId: dbid, databaseName: CHECK.databaseName },
    production: {
      databaseId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
      databaseName: "the-shelf-library",
    },
  },
};
function settings() {
  return {
    logpush: false,
    tail_consumers: [],
    bindings: [
      { name: "DB", type: "d1", id: dbid },
      { name: "BOOKS", type: "r2_bucket", bucket_name: "the-shelf-books" },
      ...[
        "OWNER_KEY_PEPPER",
        "SESSION_SECRET",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
      ].map((name) => ({ name, type: "secret_text" })),
      ...Object.entries({
        APP_SCOPE: "check",
        SITE_ORIGIN: CHECK.origin,
        R2_ACCOUNT_ID: accountId,
        R2_BUCKET: "the-shelf-books",
      }).map(([name, text]) => ({ name, type: "plain_text", text })),
    ],
  };
}
async function fixture(
  t,
  { migrate = true, override, query, checkpoint, sink } = {},
) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    await fs.readFile(
      new URL("../cloudflare/library/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  if (migrate)
    db.exec(
      await fs.readFile(
        new URL(
          "../cloudflare/library/migrations/002-conservative-storage.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  db.prepare("INSERT INTO auth_config VALUES(?,?,?,?,?,?,?)").run(
    "check",
    CHECK.origin,
    "owner-access-key-v1",
    "a".repeat(64),
    7,
    0,
    1,
  );
  const calls = [],
    checkpoints = [],
    evidence = [];
  const options = {
    execute: true,
    environment: {},
    accountId,
    token,
    versionId,
    deployConfig,
    wranglerVersion: "4.151.0",
    timeoutMs: 1000,
    checkpoint: async (receipt) => {
      checkpoints.push(structuredClone(receipt));
      await checkpoint?.(receipt);
    },
    evidenceSink: async (entry) => {
      evidence.push(structuredClone(entry));
      await sink?.(entry);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${options.token}`);
      assert.ok(init.signal instanceof AbortSignal);
      if (override) {
        const response = await override(url, init, { db, calls });
        if (response !== undefined) return response;
      }
      let result;
      if (url.endsWith("/settings")) result = settings();
      else if (url.endsWith("/tails")) result = [];
      else if (url.endsWith("/deployments"))
        result = {
          deployments: [
            { versions: [{ version_id: versionId, percentage: 100 }] },
          ],
        };
      else if (url === database)
        result = { uuid: dbid, name: CHECK.databaseName };
      else if (url.endsWith("/subdomain"))
        result = { enabled: false, previews_enabled: false };
      else if (url === database + "/query") {
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body), ["batch"]);
        assert.deepEqual(body.batch, preflightPreview().sql);
        result = body.batch.map((statement, index) => {
          const before = db.prepare("SELECT total_changes() n").get().n;
          const results = db.prepare(statement.sql).all(...statement.params);
          const written =
            db.prepare("SELECT total_changes() n").get().n - before;
          assert.equal(
            written,
            0,
            "each generated statement must actually be read only",
          );
          return {
            success: true,
            results,
            meta: { rows_read: index + 1, rows_written: written },
          };
        });
        if (query) return query(result);
      } else assert.fail(`unexpected target: ${url}`);
      return Response.json({ success: true, result });
    },
  };
  return {
    db,
    calls,
    checkpoints,
    evidence,
    options,
    run: (extra) => runReadonlyPreflight({ ...options, ...extra }),
  };
}

test("dry-run requires literal execute true and never discovers credentials or touches the network", async () => {
  for (const execute of [undefined, false, "false", 1, {}, null]) {
    const preview = await runReadonlyPreflight({
      execute,
      fetchImpl: () => assert.fail("dry-run fetched"),
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.sql.length, 17);
    assert.equal(preview.requests.length, 8);
    assert.equal(preview.readOnly, true);
  }
  const preview = preflightPreview();
  preview.sql[0].sql = "DELETE FROM sessions";
  assert.notEqual(
    preflightPreview().sql[0].sql,
    preview.sql[0].sql,
    "preview mutation cannot inject SQL",
  );
});

test("real SQLite schema plus 002 executes all 17 fixed queries with zero writes and eight exact management requests", async (t) => {
  const f = await fixture(t),
    before = f.db.prepare("SELECT total_changes() n").get().n;
  const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.db.prepare("SELECT total_changes() n").get().n, before);
  assert.deepEqual(
    f.calls.map(({ url, init }) => [url, init.method]),
    [
      [worker + "/settings", "GET"],
      [worker + "/tails", "GET"],
      [worker + "/deployments", "GET"],
      [database, "GET"],
      [database + "/query", "POST"],
      [worker + "/subdomain", "GET"],
      [worker + "/settings", "GET"],
      [worker + "/tails", "GET"],
    ],
  );
  assert.equal(result.ledger.management, 8);
  assert.equal(result.ledger.d1, 2);
  assert.equal(result.ledger.rowsRead, 153);
  assert.equal(result.ledger.rowsWritten, 0);
  assert.equal(result.ledger.metaComplete, true);
  assert.equal(result.database.schemaVersion, 2);
  assert.equal(result.database.generation, 7);
  assert.equal(result.database.authEnabled, false);
  assert.equal(result.entryClosed, true);
  assert.equal(result.rowsReadReservation, 20000);
  assert.equal(f.evidence.length, 8);
  assert.equal(
    f.checkpoints.find((r) => r.requests.at(-1)?.label === "database-query")
      .rowsReadReservation,
    20000,
    "reserve before dispatch",
  );
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("schema comparison ignores platform-owned tables but rejects pre-002 trigger and extra project index or trigger", async (t) => {
  const platform = await fixture(t);
  platform.db.exec(
    "CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB); CREATE INDEX platform_index ON _cf_KV(value)",
  );
  assert.equal((await platform.run()).ok, true);
  for (const sql of [
    "CREATE INDEX extra_project_index ON sessions(generation)",
    "CREATE TRIGGER extra_project_trigger AFTER INSERT ON catalog_books BEGIN SELECT 1; END",
  ]) {
    const f = await fixture(t);
    f.db.exec(sql);
    const result = await f.run();
    assert.equal(result.error, "schema_drift");
    assert.equal(f.calls.length, 5);
  }
  const old = await fixture(t, { migrate: false });
  const oldTrigger = old.db
    .prepare("SELECT sql FROM sqlite_master WHERE name='reserve_upload'")
    .get()
    .sql.replace("observed_account_bytes+committed_bytes", "committed_bytes");
  old.db.exec("DROP TRIGGER reserve_upload");
  old.db.exec(oldTrigger);
  const result = await old.run();
  assert.equal(result.error, "schema_drift");
  assert.equal(old.calls.length, 5);
});

test("1023 rows are complete; 1024 is an unknown truncated probe, never a usable full cardinality", async (t) => {
  for (const count of [1023, 1024]) {
    const f = await fixture(t);
    f.db.exec(
      `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<${count}) INSERT INTO catalog_books(scope,book_id,public_json) SELECT 'check','book-'||n,'{}' FROM seq`,
    );
    const result = await f.run();
    assert.equal(result.ok, count === 1023);
    assert.deepEqual(result.databaseProbes.catalog_books, {
      count,
      complete: count === 1023,
    });
    if (count === 1023)
      assert.equal(result.database.counts.catalog_books, 1023);
    else {
      assert.equal(result.error, "cardinality_truncated");
      assert.equal(result.database, null);
      assert.equal(f.calls.length, 5);
    }
  }
});

test("partial and provider-error D1 envelopes preserve every known read/write cost before stopping", async (t) => {
  for (const kind of ["partial", "provider-error", "write", "over-read"]) {
    const f = await fixture(t, {
      query: (result) => {
        if (kind === "partial") {
          delete result[1].meta.rows_read;
          result[2].meta.rows_written = 4;
        }
        if (kind === "provider-error") result[3].success = false;
        if (kind === "write") result[2].meta.rows_written = 1;
        if (kind === "over-read") result[0].meta.rows_read = 20000;
        return Response.json(
          {
            success: kind !== "provider-error",
            result,
            ...(kind === "provider-error"
              ? { errors: [{ message: token }] }
              : {}),
          },
          { status: kind === "provider-error" ? 400 : 200 },
        );
      },
    });
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 5);
    assert.equal(f.evidence.length, 5);
    assert.equal(
      result.ledger.rowsRead,
      kind === "partial" ? 151 : kind === "over-read" ? 20152 : 153,
    );
    assert.equal(
      result.ledger.rowsWritten,
      kind === "partial" ? 4 : kind === "write" ? 1 : 0,
    );
    assert.equal(result.ledger.metaComplete, kind !== "partial");
    if (kind === "provider-error")
      assert.equal(
        Object.values(result.databaseProbes).some((probe) => probe.complete),
        false,
      );
    assert.equal(
      result.error,
      kind === "partial"
        ? "d1_meta_incomplete"
        : kind === "provider-error"
          ? "provider_rejected"
          : "d1_cost_exceeded",
    );
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(f.checkpoints.at(-1).ledger.rowsRead, result.ledger.rowsRead);
  }
});

test("checkpoint and evidence failures are terminal and never send an unreserved next request", async (t) => {
  for (const kind of ["reserve", "received", "sink"]) {
    const f = await fixture(t, {
      checkpoint: (receipt) => {
        if (
          kind === "reserve" ||
          (kind === "received" && receipt.requests[0]?.outcome === "received")
        )
          throw new Error(token);
      },
      sink: () => {
        if (kind === "sink") throw new Error(token);
      },
    });
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(
      result.error,
      kind === "sink" ? "private_evidence_failed" : "private_journal_failed",
    );
    assert.equal(f.calls.length, kind === "reserve" ? 0 : 1);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test("version, identity, binding, entry and observation drift stop at the first invalid read", async (t) => {
  for (const [kind, expected, count] of [
    ["version", "deployed_version_mismatch", 3],
    ["identity", "database_identity_mismatch", 4],
    ["binding", "settings_unverified", 1],
    ["entry", "entry_not_closed", 6],
    ["observation", "settings_unverified", 7],
    ["tails", "tail_activity_or_invalid", 2],
  ]) {
    const f = await fixture(t, {
      override: (url, init, { calls }) => {
        let result;
        if (kind === "version" && url.endsWith("/deployments"))
          result = {
            deployments: [
              {
                versions: [
                  {
                    version_id: "22222222-2222-4333-8444-555555555555",
                    percentage: 100,
                  },
                ],
              },
            ],
          };
        if (kind === "identity" && url === database)
          result = {
            uuid: deployConfig.profiles.production.databaseId,
            name: CHECK.databaseName,
          };
        if (kind === "binding" && url.endsWith("/settings")) {
          result = settings();
          result.bindings[0].id = deployConfig.profiles.production.databaseId;
        }
        if (kind === "entry" && url.endsWith("/subdomain"))
          result = { enabled: false, previews_enabled: true };
        if (kind === "observation" && calls.length === 7) {
          result = settings();
          result.logpush = true;
        }
        if (kind === "tails" && url.endsWith("/tails"))
          result = [{ id: "synthetic-tail" }];
        if (result !== undefined)
          return Response.json({ success: true, result });
      },
    });
    const result = await f.run();
    assert.equal(result.error, expected, kind);
    assert.equal(f.calls.length, count, kind);
    assert.equal(
      f.calls.some(
        (c) => c.init.method !== "GET" && c.url !== database + "/query",
      ),
      false,
    );
  }
});

test("schema source saturation and invalid auth or active sessions are incomplete and stop before entry reads", async (t) => {
  for (const kind of [
    "schema-cap",
    "auth-enabled",
    "active-session",
    "marker",
  ]) {
    const f = await fixture(t);
    if (kind === "schema-cap")
      for (let i = 0; i < 128; i++)
        f.db.exec(`CREATE TABLE platform_${i}(value TEXT)`);
    if (kind === "auth-enabled")
      f.db.exec("UPDATE auth_config SET enabled=1 WHERE scope='check'");
    if (kind === "active-session") {
      f.db.exec("UPDATE auth_config SET enabled=1 WHERE scope='check'");
      f.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)")
        .run("check", "b".repeat(64), 7, 1, 100, 0);
      f.db.exec(
        "UPDATE auth_config SET enabled=0 WHERE scope='check'; UPDATE sessions SET revoked=0",
      );
    }
    if (kind === "marker") f.db.exec("UPDATE library_schema SET version=2");
    const result = await f.run();
    assert.equal(
      result.error,
      {
        "schema-cap": "schema_probe_truncated",
        "auth-enabled": "auth_preflight_invalid",
        "active-session": "sessions_preflight_invalid",
        marker: "schema_marker_invalid",
      }[kind],
    );
    assert.equal(f.calls.length, 5);
    if (kind === "schema-cap")
      assert.equal(
        f.evidence.at(-1).body.includes("platform_"),
        false,
        "never return platform schema SQL",
      );
  }
});

test("redirects, malformed JSON, oversized streams and declared oversize never retry or send a second request", async (t) => {
  for (const kind of [
    "redirect",
    "redirected",
    "json",
    "stream-size",
    "declared-size",
  ]) {
    const f = await fixture(t, {
      override: () => {
        if (kind === "redirect")
          return new Response("{}", {
            status: 302,
            headers: { location: "https://example.invalid/" + token },
          });
        if (kind === "redirected") {
          const response = Response.json({ success: true, result: settings() });
          Object.defineProperty(response, "redirected", { value: true });
          return response;
        }
        if (kind === "json") return new Response("{" + token);
        if (kind === "declared-size")
          return new Response("{}", {
            headers: { "content-length": "1048577" },
          });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(700000));
              controller.enqueue(new Uint8Array(400000));
              controller.close();
            },
          }),
        );
      },
    });
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(
      result.error,
      kind === "redirect"
        ? "provider_rejected"
        : kind === "redirected"
          ? "response_redirected"
          : kind === "json"
            ? "response_json_invalid"
            : "response_too_large",
    );
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("abort and timeout stop late fetch continuations from writing evidence, checkpoints or issuing requests", async (t) => {
  for (const kind of ["before", "abort", "timeout"]) {
    const held = deferred(),
      started = deferred(),
      controller = new AbortController();
    const f = await fixture(t, {
      override: () => {
        started.resolve();
        return held.promise;
      },
    });
    if (kind === "before") controller.abort();
    const pending = f.run({ signal: controller.signal, timeoutMs: 15 });
    if (kind !== "before") {
      await started.promise;
      if (kind === "abort") controller.abort();
    }
    const result = await pending;
    assert.equal(
      result.error,
      kind === "timeout" ? "request_timeout" : "preflight_aborted",
    );
    const writes = f.checkpoints.length,
      raw = f.evidence.length;
    held.resolve(Response.json({ success: true, result: settings() }));
    await tick();
    await tick();
    assert.equal(f.calls.length, kind === "before" ? 0 : 1);
    assert.equal(
      f.checkpoints.length,
      writes,
      "late fetch cannot persist ledger",
    );
    assert.equal(
      f.evidence.length,
      raw,
      "late fetch cannot persist raw evidence",
    );
  }
});

test("abort while persisting a reservation or evidence never launches the next operation", async (t) => {
  for (const kind of ["checkpoint", "evidence"]) {
    const held = deferred(),
      started = deferred(),
      controller = new AbortController();
    const f = await fixture(t, {
      checkpoint: async () => {
        if (kind === "checkpoint") {
          started.resolve();
          await held.promise;
        }
      },
      sink: async () => {
        if (kind === "evidence") {
          started.resolve();
          await held.promise;
        }
      },
    });
    const pending = f.run({ signal: controller.signal, timeoutMs: 1000 });
    await started.promise;
    controller.abort();
    held.resolve();
    const result = await pending;
    const writes = f.checkpoints.length;
    await tick();
    assert.equal(result.error, "preflight_aborted");
    assert.equal(f.calls.length, kind === "checkpoint" ? 0 : 1);
    assert.equal(f.evidence.length, kind === "checkpoint" ? 0 : 1);
    assert.equal(f.checkpoints.length, writes);
  }
});

test("CI and malformed credentials or target config are rejected before private IO and HTTP", async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { environment: { CI: "true" } },
    { environment: { GITHUB_ACTIONS: "true" } },
    { accountId: "wrong" },
    { token: "bad token with spaces" },
    { versionId: "wrong" },
    {
      deployConfig: {
        ...deployConfig,
        profiles: {
          ...deployConfig.profiles,
          check: deployConfig.profiles.production,
        },
      },
    },
    { checkpoint: undefined },
    { evidenceSink: undefined },
  ])
    await assert.rejects(f.run(extra));
  assert.equal(f.calls.length, 0);
  assert.equal(f.checkpoints.length, 0);
  f.options.token = "synthetic.token~with_supported-punctuation_123";
  const valid = await f.run();
  assert.equal(valid.ok, true);
  assert.equal(f.calls.length, 8);
});

async function privateRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-preflight-"));
  const directory = path.join(root, ".local", "preflight");
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory, manifest: { scope: "check", synthetic: true } };
}

test("private journal uses 0700 parents and 0600 exclusive files; run-start permanently blocks replay", async (t) => {
  const config = await privateRoot(t),
    journal = await createPreflightJournal(config);
  await journal.checkpoint({ ledger: { management: 1 } });
  await journal.evidenceSink({ sequence: 1, body: '{"synthetic":true}' });
  for (const name of await fs.readdir(config.directory)) {
    const stat = await fs.lstat(path.join(config.directory, name));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
  }
  assert.equal((await fs.stat(config.directory)).mode & 0o777, 0o700);
  await assert.rejects(createPreflightJournal(config));
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(config.directory, "ledger-1.json"), "utf8"),
    ).ledger.management,
    1,
  );
  await assert.rejects(
    journal.evidenceSink({ sequence: 1, body: "overwrite" }),
  );
  await assert.rejects(journal.checkpoint({ shouldNeverWrite: true }));
  assert.equal(
    await fs.readFile(path.join(config.directory, "response-1.json"), "utf8"),
    '{"synthetic":true}',
  );
  assert.equal(
    (await fs.readdir(config.directory)).some(
      (name) => name === "ledger-2.json",
    ),
    false,
  );
});

test("journal rejects unsafe parents, symlinks, outside paths and sticky exclusive-write failures", async (t) => {
  const unsafe = await privateRoot(t);
  await fs.chmod(unsafe.directory, 0o755);
  await assert.rejects(createPreflightJournal(unsafe));
  const linked = await privateRoot(t),
    outside = path.join(linked.root, "outside");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.rmdir(linked.directory);
  await fs.symlink(outside, linked.directory);
  await assert.rejects(createPreflightJournal(linked));
  const start = await privateRoot(t),
    target = path.join(start.root, ".local", "target");
  await fs.writeFile(target, "preserved", { mode: 0o600 });
  await fs.symlink(target, path.join(start.directory, "run-start.json"));
  await assert.rejects(createPreflightJournal(start));
  assert.equal(await fs.readFile(target, "utf8"), "preserved");
  await assert.rejects(
    createPreflightJournal({ ...start, directory: start.root }),
  );
  const collision = await privateRoot(t),
    journal = await createPreflightJournal(collision);
  await fs.mkdir(path.join(collision.directory, "ledger-1.json"), {
    mode: 0o700,
  });
  await assert.rejects(journal.checkpoint({}), /private_journal_failed/);
  await assert.rejects(
    journal.evidenceSink({ sequence: 1, body: "must not write" }),
    /private_journal_failed/,
  );
  await assert.rejects(
    fs.stat(path.join(collision.directory, "response-1.json")),
    (error) => error.code === "ENOENT",
  );
});
