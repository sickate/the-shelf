import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  runStorageMigration,
  parseMigrationArgs,
  loadMigrationContext,
  MIGRATION_BUDGETS,
} from "../scripts/storage-migrate.mjs";

const ACCOUNT = "a".repeat(32),
  TOKEN = "synthetic-project-only-migration-token";
const IDS = {
  check: "11111111-1111-4111-8111-111111111111",
  production: "22222222-2222-4222-8222-222222222222",
};
const names = {
  check: "the-shelf-cf03-check",
  production: "the-shelf-library",
};
const files = [
  "cloudflare/library/schema.sql",
  "cloudflare/library/migrations/002-conservative-storage.sql",
  "cloudflare/library/migrations/003-storage-authority.sql",
  "cloudflare/library/migrations/004-freeze-legacy-storage.sql",
];
async function fixture(t) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "shelf-migration-"),
  );
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local/cf03"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(path.join(root, ".local"), 0o700);
  await fs.writeFile(
    path.join(root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_R2_BUCKET=the-shelf-books\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/manifest.json"),
    JSON.stringify({ files: {} }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: Object.fromEntries(
        Object.entries(IDS).map(([profile, databaseId]) => [
          profile,
          { databaseId, databaseName: names[profile] },
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(
      new URL(`../${file}`, import.meta.url),
      path.join(root, file),
    );
  }
  const dbs = {
    check: new DatabaseSync(":memory:"),
    production: new DatabaseSync(":memory:"),
  };
  t.after(() => {
    for (const db of Object.values(dbs)) db.close();
  });
  dbs.check.exec(await fs.readFile(path.join(root, files[0]), "utf8"));
  dbs.check.exec(await fs.readFile(path.join(root, files[1]), "utf8"));
  dbs.check
    .prepare(
      "INSERT INTO auth_config VALUES('check',?,'owner-access-key-v1',?,1,0,0)",
    )
    .run("https://the-shelf-cf03-check.iamzhutuo.workers.dev", "1".repeat(64));
  let fault;
  const calls = [];
  const response = (result) => Response.json({ success: true, result });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const profile =
      url.includes(IDS.check) ||
      url.includes("/workers/scripts/the-shelf-cf03-check/")
        ? "check"
        : "production";
    assert.equal(new URL(url).origin, "https://api.cloudflare.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    const directory = path.join(root, ".local/cf03/storage-migration");
    const runs = (await fs.readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory(),
    );
    const receipts = await Promise.all(
      runs.map(async (entry) =>
        JSON.parse(
          await fs.readFile(path.join(directory, entry.name, "receipt.json")),
        ),
      ),
    );
    assert.ok(
      receipts.some((receipt) => receipt.requests.at(-1)?.state === "pending"),
    );
    if (fault) {
      const out = await fault(url, options, dbs[profile]);
      if (out) return out;
    }
    if (url.includes("/workers/scripts/")) {
      if (url.endsWith("/settings"))
        return response({
          bindings:
            profile === "check"
              ? [
                  { name: "DB", type: "d1", id: IDS.check },
                  {
                    name: "BOOKS",
                    type: "r2_bucket",
                    bucket_name: "the-shelf-books",
                  },
                ]
              : [],
        });
      return response({
        enabled: profile === "production",
        previews_enabled: false,
      });
    }
    if (!url.endsWith("/query"))
      return response({ uuid: IDS[profile], name: names[profile] });
    const { sql, params } = JSON.parse(options.body);
    try {
      const results = dbs[profile].prepare(sql).all(...params);
      return response([{ success: true, results }]);
    } catch (error) {
      return Response.json(
        { success: false, errors: [{ message: error.message }] },
        { status: 400 },
      );
    }
  };
  return {
    root,
    dbs,
    calls,
    fetchImpl,
    fault(fn) {
      fault = fn;
    },
    run: (action, runId, extra = {}) =>
      runStorageMigration({
        action,
        runId,
        execute: true,
        root,
        environment: {},
        fetchImpl,
        ...extra,
      }),
    async state() {
      return JSON.parse(
        await fs.readFile(
          path.join(root, ".local/cf03/storage-migration/state.json"),
        ),
      );
    },
    async writeState(value) {
      await fs.writeFile(
        path.join(root, ".local/cf03/storage-migration/state.json"),
        JSON.stringify(value),
        { mode: 0o600 },
      );
    },
  };
}

test("preview and rejected CLI perform no file, process or network work", async () => {
  for (const action of ["schema-freeze", "import", "status", "ready"])
    assert.equal(
      (
        await runStorageMigration({
          action,
          root: "/does/not/exist",
          fetchImpl: () => assert.fail("preview network"),
        })
      ).status,
      "preview",
    );
  assert.deepEqual(
    parseMigrationArgs(["import", "--execute", "--run-id", "one"]),
    { action: "import", execute: true, runId: "one" },
  );
  for (const args of [
    ["status", "--sql", "DROP TABLE x"],
    ["import", "--root", "/tmp"],
    ["schema-freeze", "--run-id", "../escape"],
    ["status", "--execute", "--execute"],
  ])
    assert.throws(() => parseMigrationArgs(args));
  await assert.rejects(
    runStorageMigration({
      action: "ready",
      execute: true,
      root: "/does/not/exist",
    }),
    { code: "migration_write_closure_unproven" },
  );
});

test("fixed context pins project account, bucket and distinct production authority", async (t) => {
  const f = await fixture(t);
  const context = await loadMigrationContext({ root: f.root, environment: {} });
  assert.equal(context.identity.authorityId, "shelf-remote-storage-v1");
  assert.deepEqual(context.identity.legacyDatabases, IDS);
  await assert.rejects(
    loadMigrationContext({
      root: f.root,
      environment: { SHELF_CF_ACCOUNT_ID: "b".repeat(32) },
    }),
  );
  assert.equal(f.calls.length, 0);
});

test("fresh empty production proof, fixed DDL and permanent freeze preserve auth and leave import closed", async (t) => {
  const f = await fixture(t);
  const frozen = await f.run("schema-freeze", "freeze");
  t.diagnostic(
    `offline schema-freeze requests=${frozen.httpRequests}, DDL=${frozen.ddlStatements}`,
  );
  assert.equal(frozen.phase, "migration_required");
  assert.equal(frozen.uploadAllowed, false);
  assert.ok(
    frozen.httpRequests <= MIGRATION_BUDGETS["schema-freeze"].httpRequests,
  );
  assert.ok(
    frozen.ddlStatements <= MIGRATION_BUDGETS["schema-freeze"].ddlStatements,
  );
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM auth_config").get().n,
    0,
  );
  assert.equal(
    f.dbs.check.prepare("SELECT enabled FROM auth_config").get().enabled,
    0,
  );
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM public_state").get().n,
    2,
  );
  assert.equal(
    f.dbs.production.prepare("SELECT version FROM library_schema").get()
      .version,
    1,
  );
  const state = await f.state();
  assert.ok(state.productionEmptyProof);
  assert.equal(
    f.dbs.check.prepare("SELECT count(*) AS n FROM upload_reservations").get()
      .n,
    0,
  );
  const imported = await f.run("import", "import");
  t.diagnostic(
    `offline import requests=${imported.httpRequests}, DDL=${imported.ddlStatements}`,
  );
  assert.equal(imported.phase, "imported");
  assert.equal(imported.readyBlockedBy, "migration_write_closure_unproven");
  assert.equal(
    f.dbs.production.prepare("SELECT phase FROM shelf_storage_authority").get()
      .phase,
    "imported",
  );
  assert.equal((await f.run("status", "status")).phase, "imported");
  for (const file of [frozen.privateReceipt, imported.privateReceipt]) {
    const text = await fs.readFile(path.join(f.root, file), "utf8");
    assert.ok(!text.includes(TOKEN));
    assert.equal((await fs.stat(path.join(f.root, file))).mode & 0o777, 0o600);
  }
});

test("unknown executed DDL never retries inside a run; status then explicit resume reads before filling missing definitions", async (t) => {
  const f = await fixture(t);
  let once = true;
  f.fault((_url, options, db) => {
    if (
      once &&
      options.body?.includes("CREATE TABLE shelf_storage_authority")
    ) {
      once = false;
      const { sql, params } = JSON.parse(options.body);
      db.prepare(sql).all(...params);
      throw new Error(TOKEN);
    }
  });
  await assert.rejects(f.run("schema-freeze", "unknown"), {
    code: "migration_write_outcome_unknown",
  });
  const count = f.calls.length;
  await assert.rejects(f.run("schema-freeze", "no-status"), {
    code: "migration_status_required_before_resume",
  });
  assert.equal(f.calls.length, count);
  const early = await f.run("status", "before-deadline");
  assert.equal(
    early.recoveryBlockedBy,
    "migration_unknown_write_quiescence_pending",
  );
  assert.ok(early.retryStatusAfterMs > 0);
  await assert.rejects(f.run("schema-freeze", "still-no-recovery"), {
    code: "migration_status_required_before_resume",
  });
  const state = await f.state();
  state.operations.forEach((operation) => {
    if (["pending", "unknown"].includes(operation.state))
      operation.registeredAt -= 32000;
  });
  await f.writeState(state);
  const status = await f.run("status", "recover");
  assert.equal(status.recoveryObserved, true);
  const resumed = await f.run("schema-freeze", "explicit-resume");
  assert.equal(resumed.phase, "migration_required");
  const writes = f.calls.filter((call) =>
    call.options.body?.includes("CREATE TABLE shelf_storage_authority"),
  );
  assert.equal(writes.length, 1);
});

test("nonempty local legacy stops before cloud DDL", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, ".local/upload-reservations.json"),
    '{"legacy":{"state":"uncertain"}}',
    { mode: 0o600 },
  );
  await assert.rejects(f.run("schema-freeze", "legacy"), {
    code: "migration_inventory_not_closed_empty",
  });
  assert.ok(
    !f.calls.some(
      (call) =>
        call.options.body &&
        /CREATE|DROP/.test(JSON.parse(call.options.body).sql),
    ),
  );
});

test("status only reads fixed resources and preserves unknown until post-deadline readback", async (t) => {
  const f = await fixture(t);
  const out = await f.run("status", "read-only");
  assert.equal(out.phase, "schema_missing");
  for (const call of f.calls) {
    if (call.options.method === "POST")
      assert.match(JSON.parse(call.options.body).sql, /^SELECT /);
  }
  assert.equal(
    f.dbs.production
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
      .get().n,
    0,
  );
});

test("deadline cancels stalled JSON readers and late responses without leaking provider errors", async (t) => {
  const f = await fixture(t);
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"success":'));
    },
    cancel() {
      cancelled++;
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    f.run("status", "body-timeout", {
      requestTimeoutMs: 10,
      fetchImpl: async () => new Response(body),
    }),
    { code: "migration_deadline" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  let release;
  const pending = f.run("status", "late-fetch", {
    requestTimeoutMs: 10,
    fetchImpl: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await assert.rejects(pending, { code: "migration_deadline" });
  const late = new ReadableStream({
    cancel() {
      cancelled++;
      return new Promise(() => {});
    },
  });
  release(new Response(late));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 2);
  const error = new Error(TOKEN);
  error.code = `migration_${TOKEN}`;
  await assert.rejects(
    f.run("status", "scrub-error", {
      fetchImpl: async () => {
        throw error;
      },
    }),
    { code: "migration_operation_unknown" },
  );
  const receipt = await fs.readFile(
    path.join(f.root, ".local/cf03/storage-migration/scrub-error/receipt.json"),
    "utf8",
  );
  assert.ok(!receipt.includes(TOKEN));
});

test("unsafe private directories, hardlink state and unsupported project paths fail before network", async (t) => {
  const f = await fixture(t);
  const migration = path.join(f.root, ".local/cf03/storage-migration");
  await fs.symlink(os.tmpdir(), migration);
  await assert.rejects(f.run("schema-freeze", "symlink"), {
    code: "migration_private_directory_unsafe",
  });
  assert.equal(f.calls.length, 0);
  await fs.unlink(migration);
  await fs.mkdir(migration, { mode: 0o700 });
  await fs.writeFile(path.join(migration, "outside"), "{}", { mode: 0o600 });
  await fs.link(
    path.join(migration, "outside"),
    path.join(migration, "state.json"),
  );
  await assert.rejects(f.run("status", "hardlink"), {
    code: "migration_private_file_unsafe",
  });
  assert.equal(f.calls.length, 0);
});

test("preexisting production schema without preserved empty-source proof is blocked", async (t) => {
  const f = await fixture(t);
  f.dbs.production.exec(await fs.readFile(path.join(f.root, files[0]), "utf8"));
  await assert.rejects(f.run("schema-freeze", "unproven-original-empty"), {
    code: "migration_original_empty_source_unproven",
  });
  assert.ok(
    f.calls.every(
      (call) =>
        !call.options.body ||
        /^SELECT /.test(JSON.parse(call.options.body).sql),
    ),
  );
});

test("identity mismatch, schema drift and enabled auth never reach cloud DDL", async (t) => {
  for (const scenario of ["identity", "schema", "auth"]) {
    const f = await fixture(t);
    if (scenario === "identity")
      f.fault((url) => {
        if (url.endsWith(IDS.production))
          return Response.json({
            success: true,
            result: { uuid: IDS.check, name: names.production },
          });
      });
    if (scenario === "schema")
      f.dbs.check.exec("CREATE TABLE unexpected_private_schema(value TEXT)");
    if (scenario === "auth")
      f.dbs.check.exec("UPDATE auth_config SET enabled=1");
    await assert.rejects(f.run("schema-freeze", `reject-${scenario}`));
    assert.ok(
      f.calls.every(
        (call) =>
          !call.options.body ||
          /^SELECT /.test(JSON.parse(call.options.body).sql),
      ),
    );
  }
});

test("live operator lock rejects concurrent status before network", async (t) => {
  const f = await fixture(t);
  const migration = path.join(f.root, ".local/cf03/storage-migration");
  await fs.mkdir(migration, { mode: 0o700 });
  await fs.writeFile(
    path.join(migration, "operator.lock"),
    JSON.stringify({
      pid: process.pid,
      runId: "active",
      createdAt: Date.now(),
    }),
    { mode: 0o600 },
  );
  await assert.rejects(f.run("status", "contender"), {
    code: "migration_operator_busy",
  });
  assert.equal(f.calls.length, 0);
});

test("oversized API response stops bounded status without provider content", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run("status", "oversized", {
      fetchImpl: async () =>
        new Response(TOKEN, { headers: { "content-length": "1000001" } }),
    }),
    { code: "migration_response_limit" },
  );
});

test("schema definitions are compared without folding submitted whitespace", async (t) => {
  const f = await fixture(t);
  const original = f.dbs.check
    .prepare("SELECT sql FROM sqlite_master WHERE name='create_session'")
    .get().sql;
  f.dbs.check.exec("DROP TRIGGER create_session");
  f.dbs.check.exec(original.replace("BEGIN\n", "BEGIN\n\n"));
  await assert.rejects(f.run("schema-freeze", "definition-drift"), {
    code: "migration_schema_conflict",
  });
  assert.ok(
    f.calls.every(
      (call) =>
        !call.options.body ||
        /^SELECT /.test(JSON.parse(call.options.body).sql),
    ),
  );
});

test("an interrupted lock-acquisition guard is never guessed stale or removed", async (t) => {
  const f = await fixture(t);
  const guard = path.join(
    f.root,
    ".local/cf03/storage-migration/operator-acquire.lock",
  );
  await fs.mkdir(guard, { recursive: true, mode: 0o700 });
  await assert.rejects(f.run("status", "guarded"), {
    code: "migration_operator_busy",
  });
  assert.equal(f.calls.length, 0);
  assert.ok((await fs.stat(guard)).isDirectory());
});

test("simultaneous stale-lock recoverers cannot both dispatch", async (t) => {
  const f = await fixture(t);
  const migration = path.join(f.root, ".local/cf03/storage-migration");
  await fs.mkdir(migration, { mode: 0o700 });
  await fs.writeFile(
    path.join(migration, "operator.lock"),
    JSON.stringify({
      pid: 2147483647,
      runId: "interrupted",
      createdAt: 1,
    }),
    { mode: 0o600 },
  );
  const results = await Promise.allSettled([
    f.run("status", "recover-a"),
    f.run("status", "recover-b"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "migration_operator_busy");
  assert.equal((await fs.readdir(migration)).includes("operator.lock"), false);
  assert.equal(
    (await fs.readdir(migration)).includes("operator-acquire.lock"),
    false,
  );
});

test("lost atomic import response requires status and never republishes the unknown write", async (t) => {
  const f = await fixture(t);
  await f.run("schema-freeze", "before-import");
  let once = true;
  f.fault((_url, options, db) => {
    if (once && options.body?.includes("SET phase='imported'")) {
      once = false;
      const { sql, params } = JSON.parse(options.body);
      db.prepare(sql).all(...params);
      throw new Error(TOKEN);
    }
  });
  await assert.rejects(f.run("import", "import-unknown"));
  assert.equal(
    f.dbs.production.prepare("SELECT phase FROM shelf_storage_authority").get()
      .phase,
    "imported",
  );
  const count = f.calls.length;
  await assert.rejects(f.run("import", "import-no-status"), {
    code: "migration_status_required_before_resume",
  });
  assert.equal(f.calls.length, count);
  const state = await f.state();
  state.operations.forEach((operation) => {
    if (["pending", "unknown"].includes(operation.state))
      operation.registeredAt -= 32000;
  });
  await f.writeState(state);
  assert.equal(
    (await f.run("status", "import-recovery")).recoveryObserved,
    true,
  );
  const recovered = await f.run("import", "import-resume");
  assert.equal(recovered.phase, "imported");
  assert.equal(recovered.uploadAllowed, false);
  assert.equal(
    f.calls.filter((call) =>
      call.options.body?.includes("SET phase='imported'"),
    ).length,
    1,
  );
  assert.equal(
    (await f.state()).operations.filter(
      (operation) => operation.state === "unknown",
    ).length,
    1,
  );
});

test("unknown result between DROP and CREATE reserve trigger retains both immutable freezes", async (t) => {
  const f = await fixture(t);
  // Exercise the bounded known-base -> conservative replacement branch. The
  // current repository base already includes 002's semantics, so make its fixed
  // test source differ only in preserved SQL formatting.
  const basePath = path.join(f.root, files[0]);
  await fs.writeFile(
    basePath,
    (await fs.readFile(basePath, "utf8")).replace(
      "CREATE TRIGGER IF NOT EXISTS reserve_upload BEFORE",
      "CREATE TRIGGER IF NOT EXISTS reserve_upload\n BEFORE",
    ),
  );
  f.fault((_url, options, db) => {
    if (!options.body) return;
    const { sql, params } = JSON.parse(options.body);
    if (sql === "DROP TRIGGER reserve_upload") {
      db.prepare(sql).all(...params);
      throw new Error(TOKEN);
    }
  });
  await assert.rejects(f.run("schema-freeze", "between-ddl"), {
    code: "migration_write_outcome_unknown",
  });
  assert.equal(
    f.dbs.production
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='reserve_upload'",
      )
      .get().n,
    0,
  );
  for (const profile of ["check", "production"]) {
    assert.equal(
      f.dbs[profile]
        .prepare("SELECT count(*) AS n FROM shelf_storage_legacy_freeze")
        .get().n,
      1,
    );
    assert.throws(
      () =>
        f.dbs[profile]
          .prepare(
            "INSERT INTO upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,1,'PDF',?,'reserved',1,1)",
          )
          .run(
            "forbidden",
            profile,
            "file",
            "book",
            `${profile === "production" ? "books" : "cf03-check"}/forbidden`,
            "0".repeat(64),
          ),
      /legacy_storage_frozen/,
    );
  }
  const count = f.calls.length;
  await assert.rejects(f.run("ready", "still-closed"), {
    code: "migration_write_closure_unproven",
  });
  assert.equal(f.calls.length, count);
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM auth_config").get().n,
    0,
  );
  assert.equal(
    f.dbs.production
      .prepare(
        "SELECT count(*) AS n FROM shelf_storage_authority WHERE phase='ready'",
      )
      .get().n,
    0,
  );
});

test("lost base seed response is read back without resending the unknown INSERT", async (t) => {
  const f = await fixture(t);
  let once = true;
  f.fault((_url, options, db) => {
    if (!once || !options.body) return;
    const { sql, params } = JSON.parse(options.body);
    if (sql.startsWith("INSERT OR IGNORE INTO library_schema")) {
      once = false;
      db.prepare(sql).all(...params);
      throw new Error(TOKEN);
    }
  });
  await assert.rejects(f.run("schema-freeze", "seed-unknown"), {
    code: "migration_write_outcome_unknown",
  });
  const state = await f.state();
  state.operations.forEach((operation) => {
    if (["pending", "unknown"].includes(operation.state))
      operation.registeredAt -= 32000;
  });
  await f.writeState(state);
  await f.run("status", "seed-status");
  await f.run("schema-freeze", "seed-resume");
  assert.equal(
    f.calls.filter(
      (call) =>
        call.options.body &&
        JSON.parse(call.options.body).sql.startsWith(
          "INSERT OR IGNORE INTO library_schema",
        ),
    ).length,
    1,
  );
});

test("HTTP503 carrying a freeze error is an unknown write, never proven transaction rejection", async (t) => {
  const f = await fixture(t);
  f.fault((_url, options) => {
    if (
      options.body &&
      JSON.parse(options.body).sql.startsWith("INSERT INTO upload_reservations")
    )
      return Response.json(
        { success: false, errors: [{ message: "legacy_storage_frozen" }] },
        { status: 503 },
      );
  });
  await assert.rejects(f.run("schema-freeze", "untrusted-freeze-response"), {
    code: "migration_write_outcome_unknown",
  });
  const state = await f.state();
  assert.equal(state.schemaFrozen, null);
  assert.ok(
    state.operations.some((operation) => operation.state === "unknown"),
  );
});

test("import rechecks configured local manifest, ledger and lock after schema freeze before any cloud write", async (t) => {
  const f = await fixture(t);
  await f.run("schema-freeze", "before-local-change");
  // Use actual configured paths that differ from schema-freeze's default paths.
  const stateDir = path.join(f.root, ".local/other-state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  const manifestPath = path.join(stateDir, "manifest.json");
  const ledgerPath = path.join(stateDir, "upload-reservations.json");
  const lockPath = path.join(stateDir, "upload.lock");
  const environment = {
    SHELF_MANIFEST_PATH: ".local/other-state/manifest.json",
    SHELF_STATE_DIR: ".local/other-state",
  };
  for (const scenario of ["registered", "pending", "lock"]) {
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        files:
          scenario === "registered"
            ? { private: { storageKey: "books/private" } }
            : {},
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      ledgerPath,
      JSON.stringify(
        scenario === "pending" ? { legacy: { state: "uncertain" } } : {},
      ),
      { mode: 0o600 },
    );
    if (scenario === "lock")
      await fs.writeFile(lockPath, "held", { mode: 0o600 });
    const count = f.calls.length;
    await assert.rejects(
      f.run("import", `changed-local-${scenario}`, { environment }),
      {
        code: "migration_inventory_not_closed_empty",
      },
    );
    assert.equal(f.calls.length, count);
  }
  assert.equal(
    f.dbs.production
      .prepare("SELECT count(*) AS n FROM shelf_storage_authority")
      .get().n,
    0,
  );
});
