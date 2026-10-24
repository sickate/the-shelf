import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  runIsolatedUpload,
  ISOLATED_OPERATOR_BUDGETS,
  ISOLATED_INSTALL_LOCKS,
  ISOLATED_INSTALL_STATEMENTS,
  ISOLATED_FINISH_INSTALL_RUN,
  isolatedDdlStatement,
  classifyIsolatedInstallPrefix,
  validateIsolatedInstallFinishHistory,
  validateIsolatedConsent,
  isolatedConsentRecord,
  ISOLATED_DEPLOY_SQL,
} from "../scripts/isolated-upload.mjs";
import {
  ISOLATED_UPLOAD_SCHEMA_SQL,
  ISOLATED_UPLOAD_SCHEMA_HASHES,
} from "../cloudflare/library/isolated-upload.mjs";
import {
  isolatedFixture,
  identity,
  sha,
} from "./helpers/isolated-operator-fixture.mjs";
const run = (f, action, runId, extra = {}) =>
  runIsolatedUpload({
    action,
    runId,
    execute: true,
    context: f.context,
    fetchImpl: f.fetchImpl,
    ...extra,
  });
const code = (expected) => (e) => e.code === expected;
const ddlCalls = (f) =>
  f.calls.filter((c) => c.sql && /^(CREATE|ALTER|DROP)/.test(c.sql));
async function finishFixture(t, { prefix = 6, profile = "trial-009" } = {}) {
  const f = await isolatedFixture(t, { profile });
  f.beforeQuery = (sql) => {
    if (sql === isolatedDdlStatement(ISOLATED_INSTALL_STATEMENTS[6]))
      throw Error("old D1 parser response lost");
  };
  await assert.rejects(
    run(f, "install", ISOLATED_FINISH_INSTALL_RUN),
    code("isolated_write_unknown"),
  );
  f.beforeQuery = null;
  const dir = path.join(f.root, ".local/isolated-upload"),
    oldRun = path.join(dir, ISOLATED_FINISH_INSTALL_RUN);
  // Reconstruct only the old journal format: it predated status observations
  // and sent statement7 with its original trailing comment.
  for (const name of await fs.readdir(oldRun))
    if (
      name.endsWith("-http-status.json") ||
      name.endsWith("-error-codes.json")
    )
      await fs.unlink(path.join(oldRun, name));
  const lastIntent = path.join(oldRun, "021-intent.json"),
    intent = JSON.parse(await fs.readFile(lastIntent));
  intent.sqlSha256 = sha(ISOLATED_INSTALL_STATEMENTS[6]);
  await fs.writeFile(lastIntent, JSON.stringify(intent));
  if (prefix === 7) f.db.exec(ISOLATED_INSTALL_STATEMENTS[6]);
  f.calls.length = 0;
  const oldRecords = {};
  for (const name of await fs.readdir(oldRun))
    oldRecords[name] = await fs.readFile(path.join(oldRun, name), "utf8");
  return Object.assign(f, {
    dir,
    oldRun,
    oldRecords,
    finish: (id = "finish") => run(f, "finish-install", id),
  });
}
test("preview has zero private/config/network IO; consent has fixed wording, exact keys and identity", async () => {
  assert.equal(
    (
      await runIsolatedUpload({
        root: "/absent",
        fetchImpl: () => assert.fail(),
        action: "install",
      })
    ).requests,
    0,
  );
  const record = isolatedConsentRecord(identity);
  assert.match(
    validateIsolatedConsent(record, identity).sha256,
    /^[a-f0-9]{64}$/,
  );
  for (const value of [
    { ...record, statement: "arbitrary approval" },
    { ...record, extra: 1 },
    { ...record, accountId: "b".repeat(32) },
  ])
    assert.throws(
      () => validateIsolatedConsent(value, identity),
      code("isolated_consent_invalid"),
    );
  assert.throws(
    () => isolatedConsentRecord({ ...identity, accountId: "_".repeat(32) }),
    code("isolated_consent_invalid"),
  );
});
for (const profile of ["trial-009", "trial-009-cf-metadata-v1"])
  test(`fixed installer locks every guard replacement and preserves all old facts: ${profile}`, async (t) => {
    const f = await isolatedFixture(t, { profile });
    let ddl = 0;
    f.beforeQuery = (sql) => {
      if (/^(?:CREATE|ALTER|DROP)/.test(sql)) {
        ddl++;
        const locks = f.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'shelf_isolated_install_%'",
          )
          .all();
        if (ddl > 3 && ddl <= 17) {
          assert.equal(locks.length, 3);
          for (const bad of [
            "INSERT INTO shelf_storage_reservations VALUES('attack','a','a','{}',1,'reserved',0,0,NULL,0,0)",
            "UPDATE shelf_storage_reservations SET state='uploading' WHERE reservation_id='retained_unknown'",
            "INSERT INTO shelf_storage_original_registry VALUES('a','a','{}','etag',1)",
          ])
            assert.throws(() => f.db.exec(bad));
        }
      }
    };
    const result = await run(f, "install", "install");
    assert.equal(result.requests, 41);
    assert.equal(result.ddl, 20);
    assert.equal(ddl, 20);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) n FROM browser_uploads WHERE target_id IS NOT NULL",
        )
        .get().n,
      0,
    );
    const schema = f.db
      .prepare(ISOLATED_UPLOAD_SCHEMA_SQL)
      .all()
      .map((r) => ({ ...r, sql: r.sql.trim().replace(/;$/, "") }));
    assert.ok(ISOLATED_UPLOAD_SCHEMA_HASHES.includes(sha(schema)));
    assert.equal(
      f.db.prepare("SELECT reserved_bytes FROM shelf_storage_authority").get()
        .reserved_bytes,
      72,
    );
    assert.equal(
      f.db.prepare("SELECT state FROM shelf_storage_single_trial").get().state,
      "confirmed",
    );
    assert.equal((await run(f, "seed", "seed")).enabled, 0);
    assert.equal((await run(f, "status", "status")).requests, 2);
    assert.equal(
      (await run(f, "enable", "enable", { expectedGeneration: 0 })).requests,
      6,
    );
    assert.equal(
      (await run(f, "close", "close", { expectedGeneration: 1 })).requests,
      4,
    );
  });
test("unknown DDL leaves locks, immutable install claim, and never replays", async (t) => {
  const f = await isolatedFixture(t);
  f.beforeQuery = (sql) => {
    if (sql === ISOLATED_INSTALL_STATEMENTS[2]) throw Error("lost response");
  };
  await assert.rejects(
    run(f, "install", "first"),
    code("isolated_write_unknown"),
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name LIKE 'shelf_isolated_install_%'",
      )
      .get().n,
    3,
  );
  assert.ok(
    await fs.stat(
      path.join(f.root, ".local/isolated-upload/install-claim.json"),
    ),
  );
  const before = f.calls.filter(
    (c) => c.sql && /^(CREATE|ALTER|DROP)/.test(c.sql),
  ).length;
  f.beforeQuery = null;
  await assert.rejects(run(f, "install", "second"));
  assert.equal(
    f.calls.filter((c) => c.sql && /^(CREATE|ALTER|DROP)/.test(c.sql)).length,
    before,
  );
});
test("installer refuses full/partial/alien schema and open auth before DDL", async (t) => {
  for (const mutation of [
    (f) => f.db.exec("CREATE TABLE alien(x)"),
    (f) => f.db.exec(ISOLATED_INSTALL_STATEMENTS[0]),
    (f) => f.db.exec("UPDATE auth_config SET enabled=1"),
  ]) {
    const f = await isolatedFixture(t);
    mutation(f);
    await assert.rejects(run(f, "install", "blocked"));
    assert.equal(
      f.calls.some((c) => c.sql && /^(CREATE|ALTER|DROP)/.test(c.sql)),
      false,
    );
  }
});
test("enable CAS binds initial schema, accounting, trial, policy and auth observation", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  let changed = false;
  f.beforeQuery = (sql) => {
    if (sql.startsWith("WITH isolated_guard")) {
      changed = true;
      f.db.exec("CREATE TABLE alien(x)");
    }
  };
  await assert.rejects(
    run(f, "enable", "drift", { expectedGeneration: 0 }),
    code("isolated_policy_cas_failed"),
  );
  assert.equal(changed, true);
  assert.equal(
    f.db
      .prepare("SELECT enabled FROM shelf_storage_isolated_upload_policy")
      .get().enabled,
    0,
  );
  assert.equal(
    f.calls.filter((c) => c.sql?.startsWith("WITH isolated_guard")).length,
    1,
  );
});
test("enable rejects malformed/missing settings and unknown mutation never retries generation", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  f.settings.bindings = f.settings.bindings.filter(
    (b) => b.name !== "ISOLATED_UPLOAD_CONSENT_SHA256",
  );
  await assert.rejects(
    run(f, "enable", "bad-settings", { expectedGeneration: 0 }),
    code("isolated_worker_invalid"),
  );
  assert.equal(
    f.calls.some((c) => c.sql?.startsWith("WITH isolated_guard")),
    false,
  );
  const g = await isolatedFixture(t, { installed: true, seeded: true });
  g.beforeQuery = (sql) => {
    if (sql.startsWith("WITH isolated_guard")) throw Error("lost write");
  };
  await assert.rejects(
    run(g, "enable", "unknown", { expectedGeneration: 0 }),
    code("isolated_write_unknown"),
  );
  g.beforeQuery = null;
  await assert.rejects(run(g, "enable", "retry", { expectedGeneration: 0 }));
  assert.equal(
    g.calls.filter((c) => c.sql?.startsWith("WITH isolated_guard")).length,
    1,
  );
});
test("close succeeds despite schema, accounting and Worker configuration drift", async (t) => {
  const f = await isolatedFixture(t, {
    installed: true,
    seeded: true,
    enabled: 1,
  });
  // Simulate administrator schema damage without allowing the runtime to accept it.
  f.db.exec("CREATE TABLE alien(x)");
  f.db.exec("UPDATE shelf_storage_authority SET reserved_bytes=7999999984");
  f.settings = { bindings: [] };
  const result = await run(f, "close", "emergency-close", {
    expectedGeneration: 1,
  });
  assert.equal(result.enabled, 0);
  assert.equal(result.requests, 4);
  assert.equal(
    f.calls.some(
      (c) => c.url.endsWith("/settings") || c.sql === ISOLATED_DEPLOY_SQL,
    ),
    false,
  );
});
test("operator budgets remain fixed and no object/secret/AI endpoints exist", () => {
  assert.deepEqual(ISOLATED_OPERATOR_BUDGETS.enable, {
    http: 6,
    ddl: 0,
    d1Writes: 1,
  });
  assert.equal(ISOLATED_INSTALL_LOCKS.length, 3);
  assert.equal(ISOLATED_INSTALL_STATEMENTS.length, 14);
  assert.deepEqual(ISOLATED_OPERATOR_BUDGETS["finish-install"], {
    http: 32,
    ddl: 11,
    d1Writes: 0,
  });
});

test("fixed DDL wire strips trailing line comments for a D1-like parser without changing source/schema", async (t) => {
  const f = await isolatedFixture(t),
    fetcher = f.fetchImpl;
  const rejectsTail = (sql) => /;\s*--[^]*$/.test(sql);
  assert.equal(rejectsTail(ISOLATED_INSTALL_STATEMENTS[6]), true);
  f.fetchImpl = async (url, init) => {
    if (url.endsWith("/query") && rejectsTail(JSON.parse(init.body).sql))
      return Response.json(
        {
          success: false,
          errors: [
            { code: 7500, message: "SQL code did not contain a statement" },
          ],
          result: null,
        },
        { status: 400 },
      );
    return fetcher(url, init);
  };
  const result = await run(f, "install", "d1-parser");
  assert.equal(result.ddl, 20);
  assert.equal(
    ddlCalls(f).some((call) => rejectsTail(call.sql)),
    false,
  );
  assert.match(ISOLATED_INSTALL_STATEMENTS[6], /-- No enabled filter/);
  assert.equal(classifyIsolatedInstallPrefix instanceof Function, true);
});
for (const prefix of [6, 7])
  for (const profile of ["trial-009", "trial-009-cf-metadata-v1"])
    test(`finish-install precisely completes ${profile} prefix${prefix} and retains original records/claim`, async (t) => {
      const f = await finishFixture(t, { prefix, profile });
      const before = await validateIsolatedInstallFinishHistory(
          f.root,
          identity,
        ),
        oldClaim = await fs.readFile(
          path.join(f.dir, "install-claim.json"),
          "utf8",
        );
      assert.equal(
        classifyIsolatedInstallPrefix(
          f.db.prepare(ISOLATED_UPLOAD_SCHEMA_SQL).all(),
        ).prefix,
        prefix,
      );
      const result = await f.finish();
      assert.equal(result.requests, prefix === 6 ? 32 : 30);
      assert.equal(result.ddl, prefix === 6 ? 11 : 10);
      assert.equal(result.d1Writes, 0);
      assert.equal(result.protectedFactsSha256, before.protectedFactsSha256);
      assert.equal(result.policySeeded, false);
      assert.equal(result.uploadAllowed, false);
      assert.equal(
        await fs.readFile(path.join(f.dir, "install-claim.json"), "utf8"),
        oldClaim,
      );
      for (const [name, value] of Object.entries(f.oldRecords))
        assert.equal(
          await fs.readFile(path.join(f.oldRun, name), "utf8"),
          value,
        );
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM shelf_storage_isolated_upload_policy",
          )
          .get().n,
        0,
      );
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'shelf_isolated_install_%'",
          )
          .get().n,
        0,
      );
      const schema = f.db
        .prepare(ISOLATED_UPLOAD_SCHEMA_SQL)
        .all()
        .map((r) => ({ ...r, sql: r.sql.trim().replace(/;$/, "") }));
      assert.ok(ISOLATED_UPLOAD_SCHEMA_HASHES.includes(sha(schema)));
      const ddl = ddlCalls(f);
      assert.equal(
        ddl.some((call) => /^CREATE TABLE|^ALTER TABLE/.test(call.sql)),
        false,
      );
      assert.equal(
        ddl.filter((call) =>
          call.sql.includes("shelf_isolated_upload_immutable"),
        ).length,
        prefix === 6 ? 1 : 0,
      );
      if (prefix === 6)
        assert.match(
          ddl[0].sql,
          /^CREATE TRIGGER IF NOT EXISTS shelf_isolated_upload_immutable/,
        );
      const count = ddl.length;
      await assert.rejects(
        f.finish("again"),
        code("isolated_finish_already_claimed"),
      );
      assert.equal(ddlCalls(f).length, count);
    });
for (const drift of [
  "missing-lock",
  "bad-lock",
  "prefix5",
  "prefix8",
  "foreign-schema",
  "open-auth",
  "old-fact",
  "policy",
])
  test(`finish-install ${drift} prestate drift sends zero DDL`, async (t) => {
    const f = await finishFixture(t);
    if (drift === "missing-lock")
      f.db.exec("DROP TRIGGER shelf_isolated_install_claim_closed");
    if (drift === "bad-lock")
      f.db.exec(
        "DROP TRIGGER shelf_isolated_install_claim_closed; CREATE TRIGGER shelf_isolated_install_claim_closed BEFORE UPDATE ON shelf_storage_reservations BEGIN SELECT 1; END",
      );
    if (drift === "prefix5")
      f.db.exec("DROP TRIGGER shelf_isolated_upload_admit");
    if (drift === "prefix8")
      f.db.exec(ISOLATED_INSTALL_STATEMENTS.slice(6, 8).join("\n"));
    if (drift === "foreign-schema") f.db.exec("CREATE TABLE alien(x)");
    if (drift === "open-auth") f.db.exec("UPDATE auth_config SET enabled=1");
    if (drift === "old-fact")
      f.db.exec("UPDATE auth_config SET generation=generation+1");
    if (drift === "policy") {
      const now = Date.now();
      f.db
        .prepare(
          "INSERT INTO shelf_storage_isolated_upload_policy VALUES(?,?,?,?,?,?,8000000000,0,0,?,?)",
        )
        .run(
          "isolated-project-20261024",
          JSON.stringify(identity),
          identity.accountId,
          "the-shelf-first-book-20261023",
          f.target.configSha256,
          f.consent.sha256,
          now,
          now,
        );
    }
    await assert.rejects(f.finish());
    assert.equal(ddlCalls(f).length, 0);
    await assert.rejects(
      fs.stat(path.join(f.dir, "finish-install-claim.json")),
      { code: "ENOENT" },
    );
  });
for (const drift of [
  "run",
  "result",
  "intent",
  "outcome",
  "missing",
  "extra",
  "claim",
  "unsafe",
])
  test(`finish-install original ${drift} history drift rejects before HTTP/new journal`, async (t) => {
    const f = await finishFixture(t);
    const filename = path.join(
      drift === "claim" ? f.dir : f.oldRun,
      drift === "claim"
        ? "install-claim.json"
        : drift === "run"
          ? "run.json"
          : drift === "intent"
            ? "021-intent.json"
            : drift === "outcome"
              ? "021-outcome.json"
              : "result.json",
    );
    if (drift === "missing") await fs.unlink(filename);
    else if (drift === "unsafe") await fs.chmod(filename, 0o644);
    else if (drift === "extra")
      await fs.writeFile(path.join(f.oldRun, "022-intent.json"), "{}", {
        mode: 0o600,
      });
    else {
      const value = JSON.parse(await fs.readFile(filename));
      if (drift === "run") value.action = "finish-install";
      if (drift === "result") value.requests = 22;
      if (drift === "intent") value.sqlSha256 = "a".repeat(64);
      if (drift === "outcome") value.state = "response-validated";
      if (drift === "claim") value.runId = "another-run";
      await fs.writeFile(filename, JSON.stringify(value));
    }
    const names = (await fs.readdir(f.dir)).sort();
    await assert.rejects(f.finish());
    assert.equal(f.calls.length, 0);
    assert.deepEqual((await fs.readdir(f.dir)).sort(), names);
  });
test("finish-install concurrently claims one missing segment and never repeats DDL", async (t) => {
  const f = await finishFixture(t);
  const results = await Promise.allSettled([f.finish("a"), f.finish("b")]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(ddlCalls(f).length, 11);
  assert.equal(
    ddlCalls(f).filter((call) =>
      call.sql.includes("CREATE TRIGGER IF NOT EXISTS"),
    ).length,
    1,
  );
});
test("late original statement7 of identical definition is safe and independently checked before next DDL", async (t) => {
  const f = await finishFixture(t);
  let late = false,
    checked = false;
  f.beforeQuery = (sql) => {
    if (sql.startsWith("CREATE TRIGGER IF NOT EXISTS")) {
      f.db.exec(ISOLATED_INSTALL_STATEMENTS[6]);
      late = true;
    } else if (late && sql === ISOLATED_UPLOAD_SCHEMA_SQL) checked = true;
    if (sql.startsWith("CREATE VIEW")) assert.equal(checked, true);
  };
  assert.equal((await f.finish()).ddl, 11);
});
test("late same-name different statement7 definition rejects before missing view or lock drops", async (t) => {
  const f = await finishFixture(t);
  f.beforeQuery = (sql) => {
    if (sql.startsWith("CREATE TRIGGER IF NOT EXISTS"))
      f.db.exec(
        "CREATE TRIGGER shelf_isolated_upload_immutable BEFORE UPDATE ON browser_uploads BEGIN SELECT 1; END",
      );
  };
  await assert.rejects(f.finish());
  assert.equal(ddlCalls(f).length, 1);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'shelf_isolated_install_%'",
      )
      .get().n,
    3,
  );
});
for (const stage of ["create7", "later-ddl", "drop-lock"])
  test(`unknown finish ${stage} retains claim, safe remaining locks and cannot replay`, async (t) => {
    const f = await finishFixture(t);
    const matches = (sql) =>
      stage === "create7"
        ? sql.startsWith("CREATE TRIGGER IF NOT EXISTS")
        : stage === "later-ddl"
          ? sql.startsWith("CREATE VIEW")
          : sql.startsWith("DROP TRIGGER shelf_isolated_install_");
    f.beforeQuery = (sql) => {
      if (matches(sql)) throw Error("synthetic lost DDL response");
    };
    await assert.rejects(f.finish(), code("isolated_write_unknown"));
    const count = f.calls.length;
    f.beforeQuery = null;
    await assert.rejects(
      f.finish("retry"),
      code("isolated_finish_already_claimed"),
    );
    assert.equal(f.calls.length, count);
    assert.equal(
      f.calls.filter((call) => call.sql && matches(call.sql)).length,
      1,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'shelf_isolated_install_%'",
        )
        .get().n,
      3,
    );
  });
test("finish errors retain only numeric status/code without raw D1 message or credential", async (t) => {
  const f = await finishFixture(t),
    fetcher = f.fetchImpl;
  f.fetchImpl = async (url, init) => {
    if (
      url.endsWith("/query") &&
      JSON.parse(init.body).sql.startsWith("CREATE TRIGGER IF NOT EXISTS")
    )
      return Response.json(
        {
          success: false,
          errors: [{ code: 7500, message: "synthetic-private-value" }],
          result: null,
        },
        { status: 400 },
      );
    return fetcher(url, init);
  };
  await assert.rejects(f.finish(), code("isolated_write_unknown"));
  const dir = path.join(f.dir, "finish");
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, "011-http-status.json"))),
    { httpStatus: 400 },
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, "011-error-codes.json"))),
    { cloudflareErrorCodes: [7500] },
  );
  for (const name of await fs.readdir(dir)) {
    const text = await fs.readFile(path.join(dir, name), "utf8");
    assert.equal(text.includes("synthetic-private-value"), false);
    assert.equal(text.includes(f.context.credentials.token), false);
  }
});

test("close rotates disabled generation and fences a delayed unknown enable without clearing old claim", async (t) => {
  const f = await isolatedFixture(t, { installed: true, seeded: true });
  let late;
  f.beforeQuery = (sql, params) => {
    if (sql.startsWith("WITH isolated_guard")) {
      late = { sql, params };
      throw Error("delayed unknown enable");
    }
  };
  await assert.rejects(
    run(f, "enable", "late-enable", { expectedGeneration: 0 }),
    code("isolated_write_unknown"),
  );
  f.beforeQuery = null;
  const closed = await run(f, "close", "fence-disabled", {
    expectedGeneration: 0,
  });
  assert.equal(closed.enabled, 0);
  assert.equal(closed.generation, 1);
  assert.equal(closed.requests, 4);
  assert.deepEqual(f.db.prepare(late.sql).all(...late.params), []);
  assert.equal(
    f.db
      .prepare("SELECT enabled FROM shelf_storage_isolated_upload_policy")
      .get().enabled,
    0,
  );
  assert.ok(
    await fs.stat(
      path.join(
        f.root,
        ".local/isolated-upload/enable-generation-0-claim.json",
      ),
    ),
  );
  assert.throws(
    () =>
      f.db.exec(
        "UPDATE shelf_storage_isolated_upload_policy SET enabled=1,generation=generation+1; UPDATE shelf_storage_isolated_upload_policy SET enabled=1,generation=generation+1",
      ),
    /isolated_policy_immutable/,
  );
});
