import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  CF01_CLOSE_GUARDS,
  CF01_CLOSE_SQL,
  CF01_CLOSE_LIMITS,
  Cf01CloseError,
  runCf01StorageClose,
  main,
} from "../scripts/cf01-storage-close.mjs";
const ACCOUNT = "a".repeat(32),
  DBID = "11111111-1111-4111-8111-111111111111",
  VERSION = "22222222-2222-4222-8222-222222222222",
  NEWVERSION = "33333333-3333-4333-8333-333333333333",
  DEPLOYMENT = "44444444-4444-4444-8444-444444444444",
  RUN = "55555555-5555-4555-8555-555555555555";
const TOKEN = "synthetic-private-token",
  SENTINEL = "never-retain-private-secret-value",
  ANNOTATION = "never-retain-private-annotation";
const envelope = (result) => Response.json({ success: true, result });
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cf01-close-test-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf01"), { mode: 0o700 });
  const write = (name, data) =>
    fs.writeFile(
      path.join(root, name),
      typeof data === "string" ? data : JSON.stringify(data),
      { mode: 0o600 },
    );
  await write(
    ".env",
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\n`,
  );
  await write(".local/cf01/resources.json", {
    accountId: ACCOUNT,
    databaseId: DBID,
    databaseName: "the-shelf-cf01",
    ownedWorkers: ["the-shelf-cf01", "the-shelf-cf01-mock"],
  });
  const config = {
    name: "the-shelf-cf01",
    account_id: ACCOUNT,
    d1_databases: [
      { binding: "CF_DB", database_id: DBID, database_name: "the-shelf-cf01" },
    ],
    r2_buckets: [{ binding: "CF_BUCKET", bucket_name: "the-shelf-books" }],
    services: [{ binding: "CF_MOCK", service: "the-shelf-cf01-mock" }],
    workflows: [
      {
        binding: "CF_WORKFLOW",
        name: "the-shelf-cf01",
        class_name: "Cf01Workflow",
      },
    ],
  };
  await write(".local/cf01/wrangler.json", config);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    await fs.readFile(
      new URL("../cloudflare/probe/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.prepare(
    "INSERT INTO cf01_budget VALUES (?,'storage',100,0,'success')",
  ).run(RUN);
  db.prepare("DELETE FROM cf01_runs WHERE run_id=?").run(RUN);
  const bindings = [
    { name: "CF_DB", type: "d1", id: DBID },
    { name: "CF_BUCKET", type: "r2_bucket", bucket_name: "the-shelf-books" },
    {
      name: "CF_MOCK",
      type: "service",
      service: "the-shelf-cf01-mock",
      environment: "production",
    },
    { name: "CF_PROBE_TOKEN", type: "secret_text", text: SENTINEL },
    {
      name: "CF_WORKFLOW",
      type: "workflow",
      workflow_name: "the-shelf-cf01",
      class_name: "Cf01Workflow",
    },
  ];
  const remote = {
    bindings,
    version: VERSION,
    annotations: {
      "workers/message": ANNOTATION,
      "workers/triggered_by": "upload",
    },
    compatibility_date: "2026-10-15",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: false },
  };
  const settings = () => ({
    bindings: remote.bindings,
    annotations: remote.annotations,
    compatibility_date: remote.compatibility_date,
    compatibility_flags: remote.compatibility_flags,
    observability: remote.observability,
  });
  const receipts = async () => {
    const names = (await fs.readdir(path.join(root, ".local/cf01"))).filter(
      (n) => /^storage-close-[a-f0-9-]{36}\.json$/.test(n),
    );
    return Promise.all(
      names.map(async (n) =>
        JSON.parse(
          await fs.readFile(path.join(root, ".local/cf01", n), "utf8"),
        ),
      ),
    );
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const receipt = (await receipts()).find(
      (r) => r.requests.at(-1)?.state === "dispatched",
    );
    assert.ok(receipt, "durable intent precedes network");
    assert.ok(receipt.requests.length <= 32);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(
      url.startsWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`,
      ),
    );
    if (url.endsWith(`/d1/database/${DBID}`))
      return envelope({ uuid: DBID, name: "the-shelf-cf01" });
    if (url.endsWith(`/d1/database/${DBID}/query`)) {
      assert.equal(options.method, "POST");
      const { sql, params } = JSON.parse(options.body);
      assert.ok(
        Object.values(CF01_CLOSE_SQL).includes(sql) ||
          CF01_CLOSE_GUARDS.some((g) => g.sql === sql),
      );
      assert.ok(sql.length <= 100_000);
      assert.ok(params.length <= 100);
      try {
        const rows = db.prepare(sql).all(...params);
        return envelope([{ success: true, results: rows }]);
      } catch (e) {
        if (sql === CF01_CLOSE_SQL.probe)
          return Response.json(
            {
              success: false,
              errors: [
                {
                  code: 7500,
                  message:
                    "D1_ERROR: cf01_storage_admission_closed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
                },
              ],
            },
            { status: 400 },
          );
        throw e;
      }
    }
    if (url.endsWith("/settings")) {
      if (options.method === "PATCH") {
        assert.ok(options.body instanceof FormData);
        const patch = JSON.parse(await options.body.get("settings").text());
        assert.deepEqual(Object.keys(patch).sort(), [
          "annotations",
          "bindings",
        ]);
        assert.equal(patch.bindings.length, 4);
        for (const b of patch.bindings)
          assert.deepEqual(b, {
            name: b.name,
            type: "inherit",
            version_id: VERSION,
          });
        assert.deepEqual(patch.annotations, { "workers/message": ANNOTATION });
        assert.ok(!JSON.stringify(patch).includes(SENTINEL));
        remote.bindings = remote.bindings.filter((b) => b.name !== "CF_BUCKET");
        remote.version = NEWVERSION;
      }
      return envelope(settings());
    }
    assert.equal(options.method, "GET");
    if (url.endsWith("/deployments"))
      return envelope({
        deployments: [
          {
            id: DEPLOYMENT,
            created_on: "2026-10-22T00:00:00Z",
            versions: [{ version_id: remote.version, percentage: 100 }],
          },
        ],
      });
    if (url.includes("/versions/"))
      return envelope({
        id: remote.version,
        bindings: remote.bindings,
        main_module: "worker.js",
        modules: [
          {
            name: "worker.js",
            content_type: "application/javascript+module",
            content_base64: Buffer.from(
              "// unchanged historical code",
            ).toString("base64"),
          },
        ],
      });
    if (url.endsWith("/subdomain"))
      return envelope({ enabled: true, previews_enabled: false });
    assert.fail("unexpected target");
  };
  let now = Date.now();
  const run = (overrides = {}) =>
    runCf01StorageClose({
      execute: true,
      action: "close",
      root,
      environment: {},
      fetchImpl,
      clock: () => now,
      ...overrides,
    });
  return {
    root,
    db,
    write,
    remote,
    config,
    settings,
    receipts,
    calls,
    fetchImpl,
    run,
    advance: (ms) => {
      now += ms;
    },
    state: async () =>
      JSON.parse(
        await fs.readFile(
          path.join(root, ".local/cf01/storage-close-state.json"),
          "utf8",
        ),
      ),
  };
}
test("preview is zero IO and invalid arbitrary actions are rejected", async () => {
  for (const action of ["status", "close"]) {
    const out = await runCf01StorageClose({
      action,
      root: "/does/not/exist",
      fetchImpl: () => assert.fail("network"),
    });
    assert.equal(out.requests, 0);
    assert.equal(out.uploadAllowed, false);
  }
  for (const args of [
    ["ready"],
    ["close", "--url"],
    ["close", "--execute", "--force"],
    ["--execute"],
  ])
    await assert.rejects(main(args), { code: "cf01_close_usage" });
});
test("close installs exact storage-only guards then removes only fixed R2 binding and independently reads back", async (t) => {
  const f = await fixture(t),
    out = await f.run();
  assert.equal(out.requests, 31);
  assert.equal(out.ddl, 6);
  assert.equal(out.patches, 1);
  assert.equal(out.storageAdmissionGuardsObserved, true);
  assert.equal(out.r2BindingAbsentObserved, true);
  assert.equal(out.cloudWriteFreezeProven, false);
  assert.equal(out.drainProven, false);
  assert.equal(out.routesCompleteness, "unknown");
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM cf01_budget").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM cf01_runs").get().n, 0);
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, ".local/cf01/wrangler.json"), "utf8"),
  );
  assert.deepEqual(saved, { ...f.config, r2_buckets: [] });
  const receipts = JSON.stringify(await f.receipts());
  for (const secret of [TOKEN, SENTINEL, ANNOTATION])
    assert.ok(!receipts.includes(secret));
  const state = await f.state();
  assert.equal(state.writes.length, 8);
  assert.ok(
    state.writes.every((w) => ["observed", "rejected"].includes(w.state)),
  );
  assert.equal(
    (await fs.stat(path.join(f.root, ".local/cf01/storage-close-state.json")))
      .mode & 0o777,
    0o600,
  );
});
test("status is fixed cloud read-only and cannot authorize closure", async (t) => {
  const f = await fixture(t),
    out = await f.run({ action: "status" });
  assert.equal(out.requests, 9);
  assert.equal(out.ddl, 0);
  assert.equal(out.patches, 0);
  assert.equal(out.storageAdmissionGuardsObserved, false);
  assert.equal(out.r2BindingAbsentObserved, false);
  assert.ok(
    f.calls.every(
      ({ options }) =>
        options.method === "GET" ||
        (options.method === "POST" &&
          JSON.parse(options.body).sql.startsWith("SELECT ")),
    ),
  );
});
test("guard matrix preserves tombstones and identities while allowing workflow and terminal storage updates", async (t) => {
  const f = await fixture(t);
  const db = f.db;
  const live = "66666666-6666-4666-8666-666666666666";
  db.prepare(
    "INSERT INTO cf01_budget VALUES (?,'storage',101,0,'success')",
  ).run(live);
  for (const g of CF01_CLOSE_GUARDS) db.exec(g.sql);
  const refused = [
    "INSERT INTO cf01_budget VALUES ('new','storage',1,0,'success')",
    `DELETE FROM cf01_budget WHERE run_id='${RUN}'`,
    `UPDATE cf01_budget SET kind='workflow' WHERE run_id='${RUN}'`,
    "INSERT INTO cf01_runs (run_id,kind,state,created_at,updated_at) VALUES ('new','storage','running',1,1)",
    `UPDATE cf01_runs SET run_id='replacement' WHERE run_id='${live}'`,
    `UPDATE cf01_runs SET kind='workflow' WHERE run_id='${live}'`,
    `DELETE FROM cf01_runs WHERE run_id='${live}'`,
  ];
  for (const sql of refused)
    assert.throws(() => db.exec(sql), /cf01_storage_admission_closed/);
  db.prepare(
    "UPDATE cf01_runs SET state='completed',updated_at=200 WHERE run_id=?",
  ).run(live);
  db.exec(
    "INSERT INTO cf01_budget VALUES ('workflow-id','workflow',1,65,'success')",
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE cf01_budget SET kind='storage' WHERE run_id='workflow-id'",
      ),
    /cf01_storage_admission_closed/,
  );
  assert.throws(
    () =>
      db.exec("UPDATE cf01_runs SET kind='storage' WHERE run_id='workflow-id'"),
    /cf01_storage_admission_closed/,
  );
  db.exec("DELETE FROM cf01_runs WHERE run_id='workflow-id'");
});
test("unknown DDL is never retried, partial guards require independent status, original unknown persists", async (t) => {
  const f = await fixture(t);
  let broke = false;
  const fetchImpl = async (url, options) => {
    const data = await f.fetchImpl(url, options);
    if (
      !broke &&
      options.method === "POST" &&
      JSON.parse(options.body).sql === CF01_CLOSE_GUARDS[0].sql
    ) {
      broke = true;
      throw new Error(SENTINEL);
    }
    return data;
  };
  await assert.rejects(f.run({ fetchImpl }), {
    code: "cf01_close_local_or_transport_failure",
  });
  const callCount = f.calls.length;
  assert.equal(callCount, 8);
  assert.equal((await f.state()).writes[0].state, "unknown");
  await assert.rejects(f.run(), { code: "cf01_close_status_required" });
  assert.equal(f.calls.length, callCount);
  await assert.rejects(f.run({ action: "status" }), {
    code: "cf01_close_unknown_write_quiescence_pending",
  });
  f.advance(31_001);
  await f.run({ action: "status" });
  const out = await f.run();
  assert.equal(out.ddl, 5);
  assert.equal(out.requests, 29);
  assert.equal((await f.state()).writes[0].state, "unknown");
  assert.equal(
    f.calls.filter(
      (c) =>
        c.options.method === "POST" &&
        JSON.parse(c.options.body).sql === CF01_CLOSE_GUARDS[0].sql,
    ).length,
    1,
  );
});
test("known partial DDL with failed independent readback still requires a separate status", async (t) => {
  const f = await fixture(t);
  let installed = false;
  await assert.rejects(
    f.run({
      fetchImpl: async (url, options) => {
        if (
          installed &&
          options.method === "POST" &&
          JSON.parse(options.body).sql === CF01_CLOSE_SQL.schema
        )
          throw new Error(SENTINEL);
        const response = await f.fetchImpl(url, options);
        if (
          options.method === "POST" &&
          JSON.parse(options.body).sql === CF01_CLOSE_GUARDS[0].sql
        )
          installed = true;
        return response;
      },
    }),
    { code: "cf01_close_local_or_transport_failure" },
  );
  assert.equal((await f.state()).writes[0].state, "observed");
  await assert.rejects(f.run(), { code: "cf01_close_status_required" });
  await f.run({ action: "status" });
  assert.equal((await f.run()).ddl, 5);
});
test("unknown PATCH keeps local config closed and requires status; successful cloud change is not resent", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      fetchImpl: async (url, options) => {
        const response = await f.fetchImpl(url, options);
        if (options.method === "PATCH") throw new Error(SENTINEL);
        return response;
      },
    }),
    { code: "cf01_close_local_or_transport_failure" },
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(f.root, ".local/cf01/wrangler.json"), "utf8"),
    ).r2_buckets,
    [],
  );
  assert.equal((await f.state()).writes.at(-1).state, "unknown");
  await assert.rejects(f.run(), { code: "cf01_close_status_required" });
  f.advance(31_001);
  await f.run({ action: "status" });
  const out = await f.run();
  assert.equal(out.patches, 0);
  assert.equal(out.ddl, 0);
  assert.equal(out.requests, 18);
  assert.equal(f.calls.filter((c) => c.options.method === "PATCH").length, 1);
  assert.equal(
    (await f.state()).writes.find((w) => w.kind === "patch").state,
    "unknown",
  );
});
test("unknown probe row is checked by status and never deleted or replayed", async (t) => {
  const f = await fixture(t);
  let probeId;
  await assert.rejects(
    f.run({
      fetchImpl: async (url, options) => {
        if (
          options.method === "POST" &&
          JSON.parse(options.body).sql === CF01_CLOSE_SQL.probe
        ) {
          probeId = JSON.parse(options.body).params[0];
          throw new Error(SENTINEL);
        }
        return f.fetchImpl(url, options);
      },
    }),
    { code: "cf01_close_local_or_transport_failure" },
  );
  f.advance(31_001);
  const out = await f.run({ action: "status" });
  assert.equal(out.requests, 10);
  const { sql } = CF01_CLOSE_GUARDS[0];
  f.db.exec(`DROP TRIGGER ${CF01_CLOSE_GUARDS[0].name}`);
  f.db.exec(`DROP TRIGGER ${CF01_CLOSE_GUARDS[3].name}`);
  f.db
    .prepare("INSERT INTO cf01_budget VALUES (?,'storage',1,0,'success')")
    .run(probeId);
  f.db.exec(sql);
  f.db.exec(CF01_CLOSE_GUARDS[3].sql);
  await assert.rejects(f.run({ action: "status" }), {
    code: "cf01_close_probe_row_present",
  });
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM cf01_budget WHERE run_id=?")
      .get(probeId).n,
    1,
  );
  assert.equal(
    (await f.state()).writes.find((w) => w.kind === "probe").state,
    "unknown",
  );
});
for (const failure of [
  "wrong-account",
  "wrong-database",
  "extended-config",
  "unsafe-mode",
  "symlink",
  "hardlink",
]) {
  test(`${failure} input fails before any cloud IO`, async (t) => {
    const f = await fixture(t);
    if (failure === "wrong-account")
      await f.write(
        ".env",
        `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_CF_ACCOUNT_ID=${"b".repeat(32)}\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\n`,
      );
    if (failure === "wrong-database")
      await f.write(".local/cf01/wrangler.json", {
        ...f.config,
        d1_databases: [{ ...f.config.d1_databases[0], database_id: RUN }],
      });
    if (failure === "extended-config")
      await f.write(".local/cf01/wrangler.json", {
        ...f.config,
        kv_namespaces: [{ binding: "other", id: "other" }],
      });
    if (failure === "unsafe-mode")
      await fs.chmod(path.join(f.root, ".env"), 0o644);
    if (failure === "symlink") {
      await f.write("other-env", "secret");
      await fs.unlink(path.join(f.root, ".env"));
      await fs.symlink(
        path.join(f.root, "other-env"),
        path.join(f.root, ".env"),
      );
    }
    if (failure === "hardlink")
      await fs.link(path.join(f.root, ".env"), path.join(f.root, "other-env"));
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  });
}
test("unknown remote bindings and differing service environments fail before writes without retaining values", async (t) => {
  for (const value of ["environment", "binding", "missing-secret"]) {
    await t.test(value, async (t) => {
      const f = await fixture(t);
      if (value === "environment")
        f.remote.bindings.find((b) => b.name === "CF_MOCK").environment =
          "development";
      if (value === "binding")
        f.remote.bindings.push({
          name: SENTINEL,
          type: "plain_text",
          text: SENTINEL,
        });
      if (value === "missing-secret")
        f.remote.bindings = f.remote.bindings.filter(
          (b) => b.name !== "CF_PROBE_TOKEN",
        );
      await assert.rejects(f.run(), { code: "cf01_close_bindings_invalid" });
      assert.equal((await f.state()).writes.length, 0);
      assert.ok(!JSON.stringify(await f.receipts()).includes(SENTINEL));
    });
  }
});
test("modified or extra D1 schema fails closed without repairs or writes", async (t) => {
  for (const kind of ["unknown-trigger", "modified-table", "modified-guard"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      if (kind === "unknown-trigger")
        f.db.exec(
          "CREATE TRIGGER unexpected AFTER INSERT ON cf01_budget BEGIN SELECT 1; END",
        );
      if (kind === "modified-table")
        f.db.exec("ALTER TABLE cf01_budget ADD COLUMN unexpected TEXT");
      if (kind === "modified-guard")
        f.db.exec(
          `CREATE TRIGGER ${CF01_CLOSE_GUARDS[0].name} BEFORE INSERT ON cf01_budget BEGIN SELECT 1; END`,
        );
      await assert.rejects(f.run(), { code: "cf01_close_schema_invalid" });
      assert.equal((await f.state()).writes.length, 0);
    });
  }
});
test("split or drifting deployments never reach PATCH", async (t) => {
  for (const kind of ["split", "drift"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      let seen = 0;
      await assert.rejects(
        f.run({
          fetchImpl: async (url, options) => {
            const response = await f.fetchImpl(url, options);
            if (!url.endsWith("/deployments")) return response;
            const data = await response.json();
            seen++;
            if (kind === "split")
              data.result.deployments[0].versions = [
                { version_id: VERSION, percentage: 50 },
                { version_id: NEWVERSION, percentage: 50 },
              ];
            else if (seen > 1) data.result.deployments[0].id = NEWVERSION;
            return Response.json(data);
          },
        }),
        {
          code:
            kind === "split"
              ? "cf01_close_deployment_invalid"
              : "cf01_close_settings_changed",
        },
      );
      assert.equal(
        f.calls.filter((c) => c.options.method === "PATCH").length,
        0,
      );
    });
  }
});
for (const stage of [
  "status400",
  "status500",
  "extra-prefix",
  "code-string",
  "success-true",
]) {
  test(`negative probe ${stage} remains unknown and is never retried`, async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    await assert.rejects(
      f.run({
        fetchImpl: async (url, options) => {
          if (
            options.method !== "POST" ||
            JSON.parse(options.body).sql !== CF01_CLOSE_SQL.probe
          )
            return f.fetchImpl(url, options);
          attempts++;
          let status = 400,
            data = {
              success: false,
              errors: [
                {
                  code: 7500,
                  message: "cf01_storage_admission_closed: SQLITE_CONSTRAINT",
                },
              ],
            };
          if (stage === "status400")
            data.errors[0].message = "other-private-error";
          if (stage === "status500") status = 500;
          if (stage === "extra-prefix")
            data.errors[0].message = "unknown-prefix " + data.errors[0].message;
          if (stage === "code-string") data.errors[0].code = "7500";
          if (stage === "success-true") data.success = true;
          return Response.json(data, { status });
        },
      }),
      { code: "cf01_close_rejection_unproven" },
    );
    assert.equal(attempts, 1);
    assert.equal((await f.state()).writes.at(-1).state, "unknown");
    await assert.rejects(f.run(), { code: "cf01_close_status_required" });
  });
}
for (const variant of [
  "redirect",
  "forbidden",
  "oversized-header",
  "oversized-stream",
  "invalid-json",
  "missing-page",
]) {
  test(`${variant} stops after one durable read intent without echoing platform text`, async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    await assert.rejects(
      f.run({
        fetchImpl: async () => {
          attempts++;
          if (variant === "redirect")
            return new Response(SENTINEL, { status: 302 });
          if (variant === "forbidden")
            return Response.json(
              { success: false, errors: [{ message: SENTINEL }] },
              { status: 403 },
            );
          if (variant === "oversized-header")
            return new Response("{}", {
              headers: { "content-length": "2000001" },
            });
          if (variant === "oversized-stream")
            return new Response("x".repeat(2000001));
          if (variant === "invalid-json") return new Response(SENTINEL);
          return Response.json({
            success: true,
            result: { uuid: DBID, name: "the-shelf-cf01" },
            result_info: { has_more: true },
          });
        },
      }),
    );
    assert.equal(attempts, 1);
    const receipts = await f.receipts();
    assert.equal(receipts[0].requests[0].state, "failed");
    assert.ok(!JSON.stringify(receipts).includes(SENTINEL));
  });
}
test("deadline includes transports ignoring AbortSignal and stalled body reads, cancelling without waiting", async (t) => {
  for (const variant of ["fetch", "body"]) {
    await t.test(variant, async (t) => {
      const f = await fixture(t);
      let cancelled = false;
      const started = Date.now();
      await assert.rejects(
        f.run({
          requestTimeoutMs: 25,
          fetchImpl: async () => {
            if (variant === "fetch") return new Promise(() => {});
            return new Response(
              new ReadableStream({
                start() {},
                cancel() {
                  cancelled = true;
                  return new Promise(() => {});
                },
              }),
            );
          },
        }),
        { code: "cf01_close_deadline" },
      );
      assert.ok(Date.now() - started < 1500);
      if (variant === "body") assert.equal(cancelled, true);
    });
  }
});
for (const relative of ["", ".local", ".local/cf01"]) {
  for (const replacement of ["directory", "symlink"]) {
    test(`pins ${relative || "root"} against ${replacement} replacement before another dispatch`, async (t) => {
      const f = await fixture(t);
      const dir = path.join(f.root, relative),
        held = dir + "-original";
      t.after(() => fs.rm(held, { recursive: true, force: true }));
      let attempts = 0;
      await assert.rejects(
        f.run({
          fetchImpl: async (url, options) => {
            attempts++;
            const response = await f.fetchImpl(url, options);
            await fs.rename(dir, held);
            if (replacement === "directory")
              await fs.mkdir(dir, { mode: 0o700 });
            else await fs.symlink(held, dir);
            return response;
          },
        }),
        { code: "cf01_close_private_directory_changed" },
      );
      assert.equal(attempts, 1);
      if (replacement === "directory")
        assert.deepEqual(await fs.readdir(dir), []);
    });
  }
}
test("ordinary 0600 receipt replacement stops subsequent IO", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  await assert.rejects(
    f.run({
      fetchImpl: async (url, options) => {
        attempts++;
        const response = await f.fetchImpl(url, options);
        const [name] = (
          await fs.readdir(path.join(f.root, ".local/cf01"))
        ).filter((n) => /^storage-close-[a-f0-9-]{36}\.json$/.test(n));
        const file = path.join(f.root, ".local/cf01", name),
          raw = await fs.readFile(file);
        await fs.rename(file, file + ".held");
        await fs.writeFile(file, raw, { mode: 0o600 });
        return response;
      },
    }),
    { code: "cf01_close_private_file_changed" },
  );
  assert.equal(attempts, 1);
});
test("operator lock blocks concurrent operations and no stale lock is guessed away", async (t) => {
  const f = await fixture(t);
  await f.write(".local/cf01/storage-close.lock", { pid: 99999999, id: RUN });
  await assert.rejects(f.run(), { code: "cf01_close_operator_locked" });
  assert.equal(f.calls.length, 0);
  assert.ok(await fs.stat(path.join(f.root, ".local/cf01/storage-close.lock")));
});
test("caller-controlled error text and mutable exported errors cannot enter diagnostic receipts", async (t) => {
  const f = await fixture(t);
  const error = new Cf01CloseError("cf01_close_deadline");
  error.code = SENTINEL;
  error.message = SENTINEL;
  await assert.rejects(
    f.run({
      fetchImpl: async () => {
        throw error;
      },
    }),
    { code: "cf01_close_local_or_transport_failure" },
  );
  assert.ok(!JSON.stringify(await f.receipts()).includes(SENTINEL));
});
test("PATCH cannot change preserved bindings, module code or unrelated metadata unnoticed", async (t) => {
  for (const variant of ["binding", "code", "metadata", "annotations"]) {
    await t.test(variant, async (t) => {
      const f = await fixture(t);
      let patched = false;
      await assert.rejects(
        f.run({
          fetchImpl: async (url, options) => {
            const response = await f.fetchImpl(url, options);
            if (options.method === "PATCH") {
              patched = true;
              if (variant === "binding") {
                f.remote.bindings.find(
                  (b) => b.name === "CF_MOCK",
                ).environment = "development";
                return envelope(f.settings());
              }
              if (variant === "metadata") {
                f.remote.observability = { enabled: true };
                return envelope(f.settings());
              }
              if (variant === "annotations") {
                f.remote.annotations = {
                  "workers/message": "changed-private-annotation",
                };
                return envelope(f.settings());
              }
            }
            if (variant === "code" && patched && url.includes("/versions/")) {
              const data = await response.json();
              data.result.modules[0].content_base64 =
                Buffer.from("// different code").toString("base64");
              return Response.json(data);
            }
            return response;
          },
        }),
      );
      assert.equal(
        f.calls.filter((c) => c.options.method === "PATCH").length,
        1,
      );
      assert.equal(
        f.remote.bindings.some((b) => b.name === "CF_BUCKET"),
        false,
      );
      assert.equal((await f.state()).failures.length, 1);
      await assert.rejects(f.run(), { code: "cf01_close_status_required" });
      assert.ok(
        !JSON.stringify(await f.receipts()).includes(
          "changed-private-annotation",
        ),
      );
    });
  }
});
test("unknown PATCH with binding still present stays blocked even after arbitrary waiting and status", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  await assert.rejects(
    f.run({
      fetchImpl: async (url, options) => {
        if (options.method === "PATCH") {
          attempts++;
          throw new Error(SENTINEL);
        }
        return f.fetchImpl(url, options);
      },
    }),
    { code: "cf01_close_local_or_transport_failure" },
  );
  f.advance(86_400_000);
  await assert.rejects(f.run({ action: "status" }), {
    code: "cf01_close_patch_resolution_required",
  });
  await assert.rejects(f.run(), { code: "cf01_close_status_required" });
  await assert.rejects(f.run({ action: "status" }), {
    code: "cf01_close_patch_resolution_required",
  });
  assert.equal(attempts, 1);
  assert.equal(
    (await f.state()).writes.find((w) => w.kind === "patch").state,
    "unknown",
  );
  assert.equal((await f.state()).checkpoint, null);
});
test("unknown PATCH status matches pre-dispatch capability hashes, rejects metadata drift and never reclassifies unknown", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({
      fetchImpl: async (url, options) => {
        const response = await f.fetchImpl(url, options);
        if (options.method === "PATCH") throw new Error(SENTINEL);
        return response;
      },
    }),
  );
  const unknown = (await f.state()).writes.find((w) => w.kind === "patch");
  assert.equal(Object.keys(unknown.expected).length, 5);
  // No D1 unknown remains: do not pretend 31 seconds bounds a Worker settings mutation.
  f.remote.observability = { enabled: true };
  await assert.rejects(f.run({ action: "status" }), {
    code: "cf01_close_patch_resolution_required",
  });
  assert.equal((await f.state()).checkpoint, null);
  f.remote.observability = { enabled: false };
  await f.run({ action: "status" });
  const state = await f.state();
  assert.equal(state.writes.find((w) => w.kind === "patch").state, "unknown");
  assert.equal(state.checkpoint.patchObservations.length, 1);
  assert.equal((await f.run()).patches, 0);
});
test("storage identity guard also protects delay, mode, creation time and rejects reentering running", async (t) => {
  const f = await fixture(t);
  const live = "66666666-6666-4666-8666-666666666666";
  f.db
    .prepare("INSERT INTO cf01_budget VALUES (?,'storage',101,0,'success')")
    .run(live);
  for (const guard of CF01_CLOSE_GUARDS) f.db.exec(guard.sql);
  for (const assignment of [
    "run_id=NULL,state='completed'",
    "kind=NULL,state='completed'",
    "delay_seconds=NULL,state='completed'",
    "mode=NULL,state='completed'",
    "created_at=NULL,state='completed'",
    "delay_seconds=65",
    "mode='uncertain'",
    "created_at=1",
    "state='running'",
  ])
    assert.throws(
      () =>
        f.db
          .prepare(`UPDATE cf01_runs SET ${assignment} WHERE run_id=?`)
          .run(live),
      /cf01_storage_admission_closed/,
    );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM cf01_runs WHERE run_id=?").get(live)
      .n,
    1,
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM cf01_runs WHERE run_id IS NULL")
      .get().n,
    0,
  );
  for (const state of ["completed", "failed", "uncertain"])
    f.db
      .prepare("UPDATE cf01_runs SET state=?,updated_at=200 WHERE run_id=?")
      .run(state, live);
});
test("legacy NULL storage run or tombstone identities block inventory before every cloud write", async (t) => {
  for (const kind of ["run", "budget", "both"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      if (kind === "run")
        f.db.exec(
          "INSERT INTO cf01_runs (run_id,kind,state,created_at,updated_at) VALUES (NULL,'storage','completed',1,1)",
        );
      else {
        f.db.exec(
          "INSERT INTO cf01_budget VALUES (NULL,'storage',1,0,'success')",
        );
        if (kind === "budget")
          f.db.exec("DELETE FROM cf01_runs WHERE run_id IS NULL");
      }
      const before = f.db.prepare(CF01_CLOSE_SQL.counts).get();
      assert.equal(before.null_storage_budget, kind === "run" ? 0 : 1);
      assert.equal(before.null_storage_runs, kind === "budget" ? 0 : 1);
      for (const action of ["status", "close"])
        await assert.rejects(f.run({ action }), {
          code: "cf01_close_counts_invalid",
        });
      assert.equal(f.calls.length, 6);
      assert.equal((await f.state()).writes.length, 0);
      assert.ok(
        f.calls.every(
          (c) =>
            c.options.method === "GET" ||
            JSON.parse(c.options.body).sql.startsWith("SELECT "),
        ),
      );
      assert.deepEqual(f.db.prepare(CF01_CLOSE_SQL.counts).get(), before);
    });
  }
});
test("contradictory success plus errors envelopes fail closed for reads, DDL and PATCH", async (t) => {
  for (const stage of ["read", "ddl", "patch"]) {
    for (const errors of [
      [{ message: SENTINEL }],
      null,
      { message: SENTINEL },
    ]) {
      await t.test(
        `${stage}-${Array.isArray(errors) ? "nonempty" : String(errors)}`,
        async (t) => {
          const f = await fixture(t);
          let poisoned = false;
          await assert.rejects(
            f.run({
              fetchImpl: async (url, options) => {
                const response = await f.fetchImpl(url, options);
                const sql =
                  options.method === "POST"
                    ? JSON.parse(options.body).sql
                    : null;
                const target =
                  (stage === "read" && url.endsWith(`/d1/database/${DBID}`)) ||
                  (stage === "ddl" && sql === CF01_CLOSE_GUARDS[0].sql) ||
                  (stage === "patch" && options.method === "PATCH");
                if (!target) return response;
                poisoned = true;
                const data = await response.json();
                data.errors = errors;
                return Response.json(data);
              },
            }),
            { code: "cf01_close_envelope_invalid" },
          );
          assert.equal(poisoned, true);
          const receipts = await f.receipts();
          assert.ok(!JSON.stringify(receipts).includes(SENTINEL));
          if (stage === "read") assert.equal(f.calls.length, 1);
          else assert.equal((await f.state()).writes.at(-1).state, "unknown");
        },
      );
    }
  }
});
