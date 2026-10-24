import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  runIsolatedUpload,
  ISOLATED_OPERATOR_BUDGETS,
  ISOLATED_INSTALL_LOCKS,
  ISOLATED_INSTALL_STATEMENTS,
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
