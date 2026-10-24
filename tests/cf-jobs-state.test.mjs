import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import {
  createJobsState,
  assertJobsSchema,
  JOBS_SCHEMA_SHA256,
  jobsDigest,
} from "../cloudflare/library/jobs-state.mjs";
import {
  jobsFixture,
  SqlD1,
  readMigration,
  NOW,
  id,
  plan,
  ready,
  complete,
  uncertain,
} from "./helpers/jobs-fixture.mjs";
const HASH = "d".repeat(64);
function filename(f, n, { at = f.now, terminal = "completed" } = {}) {
  f.sql
    .prepare(
      "INSERT INTO filename_identifications VALUES('production',?,?,'filename-v1',?,1,?,?,?,1,'pending',NULL,NULL,NULL,?)",
    )
    .run(
      id(9000 + n),
      n.toString(16).padStart(64, "0"),
      f.grant.sessionHash,
      at,
      at + 60000,
      Math.floor(at / 86400000),
      at,
    );
  if (terminal) finishFilename(f, n, terminal, at + 1);
}
function finishFilename(f, n, state, at = f.now + 1) {
  f.sql.exec("BEGIN IMMEDIATE");
  try {
    f.sql
      .prepare(
        "INSERT INTO filename_identification_observations(scope,request_id,phase) VALUES('production',?,'completed')",
      )
      .run(id(9000 + n));
    f.sql
      .prepare(
        "UPDATE filename_identifications SET state=?,result_json=?,error_code=?,updated_at=? WHERE request_id=?",
      )
      .run(
        state,
        state === "completed" ? '{"title":"synthetic"}' : null,
        state === "completed" ? null : "synthetic",
        at,
        id(9000 + n),
      );
    f.sql.exec("COMMIT");
  } catch (e) {
    if (f.sql.isTransaction) f.sql.exec("ROLLBACK");
    throw e;
  }
}
const count = (f, table) =>
  f.sql.prepare("SELECT count(*) n FROM " + table).get().n;

test("012 parses after all actual existing migrations; fresh gate is closed and frozen files unchanged", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    for (const name of [
      "schema.sql",
      "migrations/002-conservative-storage.sql",
      "migrations/003-storage-authority.sql",
      "migrations/004-freeze-legacy-storage.sql",
      "migrations/005-single-trial.sql",
      "migrations/006-single-trial-admission.sql",
      "migrations/007-book-management.sql",
      "migrations/008-filename-identification.sql",
      "migrations/009-filename-identification-observations.sql",
      "migrations/010-prepared-index.sql",
      "migrations/011-storage-activation-v2.sql",
      "migrations/012-cloud-jobs.sql",
    ]) {
      if (name.includes("011-")) {
        sql.exec(
          "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,'{}','migration_required')",
        );
        for (const scope of ["check", "production"])
          sql
            .prepare(
              "INSERT INTO shelf_storage_sources VALUES(?,?,?,'{}','{}',0,0,0,0)",
            )
            .run(scope, "f".repeat(64), "e".repeat(64));
        sql
          .prepare(
            "UPDATE shelf_storage_authority SET phase='imported',migration_hash=?,readback_hash=?,receipt_json='{}' WHERE id=1",
          )
          .run("f".repeat(64), "d".repeat(64));
      }
      sql.exec(readMigration(name));
    }
    assert.equal(
      sql.prepare("SELECT mode FROM shelf_job_control").get().mode,
      "closed",
    );
    assert.equal(
      sql
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND (name GLOB 'shelf_job_*' OR name='filename_identification_shared_admit_v1')",
        )
        .get().n,
      34,
    );
    await assertJobsSchema(new SqlD1(sql));
    assert.match(JOBS_SCHEMA_SHA256, /^[a-f0-9]{64}$/);
  } finally {
    sql.close();
  }
});
test("closed gate refuses synthetic jobs and leaves old filename operation available", async (t) => {
  const f = await jobsFixture(t, { open: false });
  await assert.rejects(f.state.admitJob(f.input(), f.grant), {
    code: "jobs_grant_invalid",
  });
  filename(f, 1);
  assert.equal((await f.state.sharedBudget()).used, 1);
  assert.equal(count(f, "shelf_jobs"), 0);
});
test("question commits one permanent unit, private result and one-use permits", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f);
  assert.equal((await f.state.sharedBudget()).used, 1);
  assert.throws(() => filename(f, 1), /jobs_busy/);
  const c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  let sends = 0,
    ctx;
  assert.equal((await f.state.sharedBudget()).used, 1);
  await f.state.consumePermit(c.permit, async (context) => {
    sends++;
    ctx = context;
    assert.equal(
      (await f.state.finishCall(context, complete)).state,
      "completed",
    );
  });
  await assert.rejects(
    f.state.consumePermit(c.permit, async () => sends++),
    { code: "jobs_permit_invalid" },
  );
  await assert.rejects(f.state.finishCall(ctx, complete), {
    code: "jobs_permit_invalid",
  });
  assert.equal(sends, 1);
  assert.equal((await f.state.sharedBudget()).busy, false);
  assert.equal(count(f, "shelf_job_budget_releases"), 0);
  assert.equal(
    f.sql
      .prepare("SELECT content_text,usable FROM shelf_job_call_receipts")
      .get().usable,
    1,
  );
  assert.equal(
    JSON.stringify(await f.state.getJob(r.job.id)).includes(
      "Synthetic private",
    ),
    false,
  );
  filename(f, 2);
  assert.equal((await f.state.sharedBudget()).used, 2);
});
test("same request/fingerprint reads never supply permits; body conflict has no new reservation", async (t) => {
  const f = await jobsFixture(t),
    a = await f.state.admitJob(f.input(), f.grant);
  const same = await f.state.admitJob(f.input(), f.grant);
  assert.equal(same.job.id, a.job.id);
  assert.equal(same.permit, null);
  const otherId = { ...f.input(), requestId: id(2) };
  assert.equal((await f.state.admitJob(otherId, f.grant)).permit, null);
  await assert.rejects(
    f.state.admitJob({ ...f.input(), question: "different" }, f.grant),
    { code: "jobs_request_conflict" },
  );
  assert.equal(count(f, "shelf_jobs"), 1);
  assert.equal(count(f, "shelf_job_budget_units"), 1);
});
test("summary reserves four atomically and unused units release once on validated planning", async (t) => {
  const f = await jobsFixture(t);
  for (let n = 1; n <= 16; n++) filename(f, n);
  const r = await ready(f, 1, "full_summary", [plan("leaf")]);
  assert.equal((await f.state.sharedBudget()).used, 17);
  assert.equal(count(f, "shelf_job_budget_units"), 4);
  assert.equal(count(f, "shelf_job_budget_releases"), 3);
  const c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  await f.state.consumePermit(c.permit, (x) =>
    f.state.finishCall(x, uncertain),
  );
  assert.equal((await f.state.sharedBudget()).used, 17);
  assert.equal((await f.state.getJob(r.job.id)).state, "uncertain");
  await assert.rejects(
    f.state.savePlan(r.job.id, r.job.version, [plan("leaf")]),
    { code: "jobs_plan_invalid" },
  );
  assert.throws(
    () => f.sql.exec("DELETE FROM shelf_job_budget_releases"),
    /jobs_retained/,
  );
  assert.throws(
    () => f.sql.exec("UPDATE shelf_job_budget_units SET unit_no=unit_no"),
    /jobs_immutable/,
  );
});
test("four-unit reservation with only three remaining rejects without partial rows", async (t) => {
  const f = await jobsFixture(t);
  for (let n = 1; n <= 17; n++) filename(f, n);
  await assert.rejects(f.state.admitJob(f.input(1, "full_summary"), f.grant), {
    code: "jobs_daily_budget",
  });
  assert.equal(count(f, "shelf_jobs"), 0);
  assert.equal(count(f, "shelf_job_budget_units"), 0);
  assert.equal((await f.state.sharedBudget()).used, 17);
});
test("filename and job share the exact twentieth unit in either order", async (t) => {
  const f = await jobsFixture(t);
  for (let n = 1; n <= 19; n++) filename(f, n);
  const r = await ready(f);
  const c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  await f.state.consumePermit(c.permit, (x) => f.state.finishCall(x, complete));
  assert.equal((await f.state.sharedBudget()).used, 20);
  assert.throws(() => filename(f, 20), /identify_daily_budget/);
  await assert.rejects(f.state.admitJob(f.input(2), f.grant), {
    code: "jobs_daily_budget",
  });
});
test("filename observation and terminal rollback synchronize shared slot without mirrored writes", async (t) => {
  const f = await jobsFixture(t);
  filename(f, 1, { terminal: null });
  assert.equal((await f.state.sharedBudget()).busy, true);
  f.sql.exec("BEGIN IMMEDIATE");
  f.sql
    .prepare(
      "INSERT INTO filename_identification_observations(scope,request_id,phase) VALUES('production',?,'completed')",
    )
    .run(id(9001));
  f.sql
    .prepare(
      "UPDATE filename_identifications SET state='failed',error_code='synthetic',updated_at=? WHERE request_id=?",
    )
    .run(f.now + 1, id(9001));
  f.sql.exec("ROLLBACK");
  assert.equal((await f.state.sharedBudget()).busy, true);
  assert.equal(count(f, "filename_identification_observations"), 0);
  await assert.rejects(f.state.admitJob(f.input(), f.grant), {
    code: "jobs_busy",
  });
  finishFilename(f, 1, "uncertain");
  assert.equal((await f.state.sharedBudget()).busy, false);
  assert.equal((await f.state.sharedBudget()).used, 1);
  const a = await f.state.admitJob(f.input(), f.grant);
  assert.ok(a.permit);
  assert.equal((await f.state.sharedBudget()).used, 2);
});
for (const window of ["before_commit", "after_commit"])
  test(
    "job admission " + window + " cannot recover creation permission",
    async (t) => {
      const f = await jobsFixture(t);
      f.db.lost = window;
      if (window === "before_commit") {
        await assert.rejects(f.state.admitJob(f.input(), f.grant), {
          code: "jobs_state_unavailable",
        });
        assert.equal(count(f, "shelf_jobs"), 0);
        assert.equal(count(f, "shelf_job_budget_units"), 0);
      } else {
        const a = await f.state.admitJob(f.input(), f.grant);
        assert.equal(a.permit, null);
        assert.equal(a.job.state, "queued");
        assert.equal(count(f, "shelf_job_workflow_intents"), 1);
        assert.equal((await f.state.admitJob(f.input(), f.grant)).permit, null);
        assert.equal(
          (await f.state.cancelJob(a.job.id, a.job.version)).state,
          "cancelled",
        );
        assert.equal((await f.state.sharedBudget()).used, 0);
      }
    },
  );
for (const window of ["before_commit", "after_commit"])
  test(
    "dispatch " + window + " never recovers permission from old nonce",
    async (t) => {
      const f = await jobsFixture(t),
        r = await ready(f);
      f.db.lost = window;
      const a = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
      assert.equal(a.permit, null);
      assert.equal(
        count(f, "shelf_job_call_intents"),
        window === "after_commit" ? 1 : 0,
      );
      if (window === "after_commit") {
        const n = f.sql
          .prepare("SELECT dispatch_nonce FROM shelf_job_call_intents")
          .get().dispatch_nonce;
        for (const fake of [
          {},
          { nonce: n },
          JSON.parse(JSON.stringify({ nonce: n })),
        ])
          await assert.rejects(
            f.state.consumePermit(fake, () => assert.fail()),
            { code: "jobs_permit_invalid" },
          );
        const again = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
        assert.equal(again.permit, null);
        await assert.rejects(f.state.stopUnsent(r.job.id, again.job.version), {
          code: "jobs_event_invalid",
        });
        assert.equal((await f.state.sharedBudget()).busy, true);
      } else assert.equal((await f.state.getJob(r.job.id)).state, "ready");
    },
  );
test("permit clone and another module factory cannot consume a fresh winning token", async (t) => {
  const f = await jobsFixture(t),
    a = await f.state.admitJob(f.input(), f.grant),
    other = createJobsState(f.db, { clock: () => f.now });
  for (const fake of [
    JSON.parse(JSON.stringify(a.permit)),
    structuredClone(a.permit),
  ])
    await assert.rejects(
      f.state.consumePermit(fake, () => assert.fail()),
      { code: "jobs_permit_invalid" },
    );
  await assert.rejects(
    other.consumePermit(a.permit, () => assert.fail()),
    { code: "jobs_permit_invalid" },
  );
  let ctx;
  await f.state.consumePermit(a.permit, (x) => {
    ctx = x;
  });
  await assert.rejects(other.recordWorkflowOutcome(ctx, "created"), {
    code: "jobs_permit_invalid",
  });
  assert.equal(
    (await f.state.recordWorkflowOutcome(ctx, "created")).state,
    "queued",
  );
});

for (const [name, mutation] of [
  ["session revoke", (f) => f.sql.exec("UPDATE sessions SET revoked=1")],
  [
    "gate close",
    (f) =>
      f.sql.exec(
        "UPDATE shelf_job_control SET mode='closed',generation=3,updated_at=1792742400000",
      ),
  ],
  [
    "source change",
    (f) =>
      f.sql.exec(
        "INSERT INTO metadata_overrides VALUES('production','book_1234567890abcdef','{}',1,1792742400000)",
      ),
  ],
  ["cancel", async (f, c) => f.state.cancelJob(c.job.id, c.job.version)],
  ["deadline", (f) => f.advance(900001)],
])
  test("delayed dispatch permit rechecks fresh primary: " + name, async (t) => {
    const f = await jobsFixture(t),
      r = await ready(f);
    const c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
    await mutation(f, c);
    let sends = 0;
    await assert.rejects(
      f.state.consumePermit(c.permit, () => sends++),
      { code: "jobs_dispatch_revoked" },
    );
    await assert.rejects(
      f.state.consumePermit(c.permit, () => sends++),
      { code: "jobs_permit_invalid" },
    );
    assert.equal(sends, 0);
    assert.equal(count(f, "shelf_job_call_intents"), 1);
    assert.equal(count(f, "shelf_job_call_receipts"), 0);
    assert.equal((await f.state.sharedBudget()).busy, true);
  });

test("delayed creation permit rechecks cancellation and cannot regain permission", async (t) => {
  const f = await jobsFixture(t),
    a = await f.state.admitJob(f.input(), f.grant);
  await f.state.cancelJob(a.job.id, a.job.version);
  let creates = 0;
  await assert.rejects(
    f.state.consumePermit(a.permit, () => creates++),
    { code: "jobs_dispatch_revoked" },
  );
  assert.equal((await f.state.admitJob(f.input(), f.grant)).permit, null);
  assert.equal(creates, 0);
});

test("concurrent consumers and terminal finishers each consume their context once", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f),
    c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  let context,
    sends = 0;
  const consumers = await Promise.allSettled([
    f.state.consumePermit(c.permit, (v) => {
      sends++;
      context = v;
    }),
    f.state.consumePermit(c.permit, () => sends++),
  ]);
  assert.equal(consumers.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(sends, 1);
  assert.equal(context.deadlineAt, f.now + 900000);
  const finishers = await Promise.allSettled([
    f.state.finishCall(context, complete),
    f.state.finishCall(context, {
      ...complete,
      content: "A different synthetic answer",
    }),
  ]);
  assert.equal(finishers.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(
    finishers.find((v) => v.status === "rejected").reason.code,
    "jobs_permit_invalid",
  );
  assert.equal(count(f, "shelf_job_call_receipts"), 1);
  assert.equal(
    f.sql
      .prepare(
        "SELECT count(*) n FROM shelf_job_events WHERE kind='call_finished'",
      )
      .get().n,
    1,
  );
});
test("creation can run before ack; late unknown and cancel preserve attempted responsibility/current version", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f),
    c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  let ctx;
  await f.state.consumePermit(c.permit, (x) => {
    ctx = x;
  });
  const cancelled = await f.state.cancelJob(r.job.id, c.job.version);
  assert.equal(cancelled.state, "cancellation_requested");
  const observed = await f.state.recordWorkflowOutcome(
    r.workflowContext,
    "uncertain",
  );
  assert.equal(observed.state, "cancellation_requested");
  assert.equal(observed.version, cancelled.version + 1);
  const done = await f.state.finishCall(ctx, complete);
  assert.equal(done.state, "cancelled");
  assert.equal(done.cancelRequested, true);
  assert.equal(
    f.sql.prepare("SELECT usable FROM shelf_job_call_receipts").get().usable,
    0,
  );
  assert.equal((await f.state.sharedBudget()).used, 1);
  assert.equal((await f.state.sharedBudget()).busy, false);
});
test("late created ack after trusted completion cannot revert terminal state", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f),
    c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  await f.state.consumePermit(c.permit, (x) => f.state.finishCall(x, complete));
  assert.equal(
    (await f.state.recordWorkflowOutcome(r.workflowContext, "created")).state,
    "completed",
  );
});
test("creation unknown before any call terminalizes once and prevents later dispatch", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f);
  assert.equal(
    (await f.state.recordWorkflowOutcome(r.workflowContext, "uncertain")).state,
    "orchestration_unknown",
  );
  assert.equal((await f.state.sharedBudget()).used, 0);
  assert.equal(
    (await f.state.claimCall(r.job.id, 1, r.job.version, HASH)).permit,
    null,
  );
  assert.equal((await f.state.admitJob(f.input(), f.grant)).permit, null);
});
test("multi-step summary uses one unit per call; uncertain halts reducer and releases only unsent", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f, 1, "full_summary", [
      plan("leaf"),
      plan("leaf"),
      plan("reduce"),
    ]);
  let job = r.job;
  let a = await f.state.claimCall(job.id, 2, job.version, HASH);
  assert.equal(a.permit, null);
  a = await f.state.claimCall(job.id, 1, job.version, HASH);
  await f.state.consumePermit(a.permit, (x) => f.state.finishCall(x, complete));
  job = await f.state.getJob(job.id);
  assert.equal(job.state, "ready");
  a = await f.state.claimCall(job.id, 2, job.version, HASH);
  await f.state.consumePermit(a.permit, (x) =>
    f.state.finishCall(x, uncertain),
  );
  job = await f.state.getJob(job.id);
  assert.equal(job.state, "uncertain");
  assert.equal((await f.state.sharedBudget()).used, 2);
  assert.equal(count(f, "shelf_job_budget_releases"), 2);
  assert.equal(
    (await f.state.claimCall(job.id, 3, job.version, HASH)).permit,
    null,
  );
});
for (const [name, mutation] of [
  [
    "source",
    "INSERT INTO metadata_overrides VALUES('production','book_1234567890abcdef','{}',1,1792742400000)",
  ],
  ["session", "UPDATE sessions SET revoked=1"],
  [
    "gate",
    "UPDATE shelf_job_control SET mode='closed',generation=generation+1,updated_at=1792742400000",
  ],
])
  test(
    name +
      " drift blocks new dispatch and quarantines already returned success",
    async (t) => {
      const f = await jobsFixture(t),
        r = await ready(f);
      const c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
      let ctx;
      await f.state.consumePermit(c.permit, (x) => {
        ctx = x;
      });
      f.sql.exec(mutation);
      assert.equal((await f.state.finishCall(ctx, complete)).state, "failed");
      assert.equal(
        f.sql.prepare("SELECT usable FROM shelf_job_call_receipts").get()
          .usable,
        0,
      );
      assert.equal((await f.state.sharedBudget()).used, 1);
    },
  );
test("gate close/reopen cannot revive an old generation or logical fingerprint", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f);
  f.sql.exec(
    "UPDATE shelf_job_control SET mode='closed',generation=3,updated_at=1792742400000; UPDATE shelf_job_control SET mode='jobs-v1',generation=4,updated_at=1792742400000",
  );
  assert.equal(
    (await f.state.claimCall(r.job.id, 1, r.job.version, HASH)).permit,
    null,
  );
  await f.state.stopUnsent(r.job.id, r.job.version, "grant_invalid");
  assert.equal((await f.state.admitJob(f.input(), f.grant)).permit, null);
  assert.ok((await f.state.admitJob(f.input(2), f.grant)).permit);
});
test("bad plan/CAS rolls back all rows and releases; no zero-change CAS partial commit", async (t) => {
  const f = await jobsFixture(t),
    a = await f.state.admitJob(f.input(1, "full_summary"), f.grant),
    p = await f.state.startPlanning(a.job.id, 0);
  await assert.rejects(
    f.state.savePlan(a.job.id, p.version + 1, [plan("leaf")]),
    { code: "jobs_cas_conflict" },
  );
  assert.equal(count(f, "shelf_job_call_plans"), 0);
  assert.equal(count(f, "shelf_job_budget_releases"), 0);
  await assert.rejects(
    f.state.savePlan(a.job.id, p.version, [plan("question")]),
    { code: "jobs_event_invalid" },
  );
  assert.equal(count(f, "shelf_job_call_plans"), 0);
  assert.equal((await f.state.sharedBudget()).used, 4);
  assert.equal(
    (await f.state.cancelJob(a.job.id, p.version)).state,
    "cancelled",
  );
  assert.equal((await f.state.sharedBudget()).used, 0);
});
test("direct incomplete SQL intent locks conservatively and cannot produce usable receipt", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f);
  f.sql
    .prepare(
      "INSERT INTO shelf_job_call_intents VALUES('production',?,1,?,?,?, ?,?,?)",
    )
    .run(
      r.job.id,
      "f".repeat(64),
      r.job.version,
      Math.floor(f.now / 86400000),
      f.now,
      f.now + 900000,
      HASH,
    );
  assert.equal((await f.state.sharedBudget()).busy, true);
  assert.throws(
    () =>
      f.sql
        .prepare(
          "INSERT INTO shelf_job_call_receipts VALUES('production',?,1,?,?, 'completed',1,1,'completed','fake',?,NULL,'[]')",
        )
        .run(r.job.id, "f".repeat(64), f.now, HASH),
    /jobs_receipt_invalid/,
  );
  await assert.rejects(
    f.state.finishCall(
      { kind: "call", jobId: r.job.id, ordinal: 1 },
      { ...complete },
    ),
    { code: "jobs_permit_invalid" },
  );
  assert.throws(
    () => f.sql.exec("UPDATE shelf_jobs SET state='completed'"),
    /jobs_event_required/,
  );
  assert.throws(
    () => f.sql.exec("DELETE FROM shelf_job_call_intents"),
    /jobs_retained/,
  );
});
test("UTC deadline and existing pending remain effective across midnight without charging new day", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f),
    c = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  let ctx;
  await f.state.consumePermit(c.permit, (x) => {
    ctx = x;
  });
  const next = (Math.floor(NOW / 86400000) + 1) * 86400000 + 1000;
  f.setTime(next);
  f.sql
    .prepare("UPDATE sessions SET created_at=?,expires_at=?")
    .run(next - 100, next + 7200000);
  assert.deepEqual(await f.state.sharedBudget(), {
    billingDay: Math.floor(next / 86400000),
    used: 0,
    remaining: 20,
    busy: true,
  });
  await assert.rejects(f.state.admitJob(f.input(2), f.grant), {
    code: "jobs_busy",
  });
  await f.state.finishCall(ctx, uncertain);
  assert.equal((await f.state.sharedBudget()).busy, false);
  assert.equal((await f.state.admitJob(f.input(), f.grant)).permit, null);
  assert.ok((await f.state.admitJob(f.input(2), f.grant)).permit);
  assert.equal((await f.state.sharedBudget()).used, 1);
});
test("old filename pending blocks new UTC day, terminal unknown remains charged only to old day", async (t) => {
  const f = await jobsFixture(t);
  filename(f, 1, { terminal: null });
  const next = (Math.floor(NOW / 86400000) + 1) * 86400000 + 1000;
  f.setTime(next);
  f.sql
    .prepare("UPDATE sessions SET created_at=?,expires_at=?")
    .run(next - 100, next + 7200000);
  assert.throws(
    () => filename(f, 2, { terminal: null }),
    /identify_call_locked/,
  );
  finishFilename(f, 1, "uncertain", next);
  filename(f, 2);
  assert.equal((await f.state.sharedBudget()).used, 1);
  assert.equal(count(f, "filename_identifications"), 2);
});
test("insufficient remaining day/session and per-call margin cause zero sends", async (t) => {
  const f = await jobsFixture(t),
    r = await ready(f);
  f.advance(60001);
  assert.equal(
    (await f.state.claimCall(r.job.id, 1, r.job.version, HASH)).permit,
    null,
  );
  assert.equal(count(f, "shelf_job_call_intents"), 0);
  await f.state.stopUnsent(r.job.id, r.job.version, "deadline");
  const late = (Math.floor(NOW / 86400000) + 1) * 86400000 - 1000;
  f.setTime(late);
  f.sql
    .prepare("UPDATE sessions SET created_at=?,expires_at=?")
    .run(late - 100, late + 7200000);
  await assert.rejects(f.state.admitJob(f.input(2), f.grant), {
    code: "jobs_deadline",
  });
});
test("schema hash rejects tampered guard even when all names still exist", async (t) => {
  const f = await jobsFixture(t);
  f.sql.exec(
    "DROP TRIGGER shelf_job_call_intent_admit; CREATE TRIGGER shelf_job_call_intent_admit BEFORE INSERT ON shelf_job_call_intents BEGIN SELECT 1; END;",
  );
  await assert.rejects(assertJobsSchema(f.db), {
    code: "jobs_schema_unavailable",
  });
  assert.equal(count(f, "shelf_jobs"), 0);
});

for (const operation of ["question", "full_summary"])
  test(
    "late success past call deadline is quarantined before job expiry: " +
      operation,
    async (t) => {
      const f = await jobsFixture(t);
      const r = await ready(
        f,
        1,
        operation,
        operation === "question"
          ? [plan()]
          : [plan("leaf"), plan("leaf"), plan("reduce")],
      );
      const claim = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
      let context;
      await f.state.consumePermit(claim.permit, (v) => {
        context = v;
      });
      f.advance(900001);
      assert.ok(
        f.sql.prepare("SELECT deadline_at FROM shelf_jobs").get().deadline_at >
          f.now,
      );
      const intent = f.sql
        .prepare("SELECT dispatch_nonce FROM shelf_job_call_intents")
        .get();
      assert.throws(
        () =>
          f.sql
            .prepare(
              "INSERT INTO shelf_job_call_receipts VALUES('production',?,1,?,?, 'completed',1,1,'completed','late synthetic',?,NULL,'[]')",
            )
            .run(r.job.id, intent.dispatch_nonce, f.now, HASH),
        /jobs_grant_invalid/,
      );
      const finished = await f.state.finishCall(context, complete);
      assert.equal(finished.state, "failed");
      assert.equal(
        f.sql.prepare("SELECT usable FROM shelf_job_call_receipts").get()
          .usable,
        0,
      );
      assert.equal((await f.state.sharedBudget()).used, 1);
      assert.equal(
        (await f.state.claimCall(r.job.id, 2, finished.version, HASH)).permit,
        null,
      );
    },
  );

test("schema probe caps rows at fifty and oversized SQL responses before transfer", async (t) => {
  const f = await jobsFixture(t);
  let observed;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (text) => {
    const statement = prepare(text);
    if (!text.includes("sqlite_master")) return statement;
    assert.match(text, /LIMIT 50/);
    return {
      ...statement,
      async all() {
        const r = await statement.all();
        observed = r.results;
        return r;
      },
    };
  };
  f.sql.exec(
    "DROP TRIGGER shelf_job_call_intent_admit; CREATE TRIGGER shelf_job_call_intent_admit BEFORE INSERT ON shelf_job_call_intents BEGIN SELECT '" +
      "x".repeat(200000) +
      "'; END;",
  );
  await assert.rejects(assertJobsSchema(f.db), {
    code: "jobs_schema_unavailable",
  });
  assert.equal(observed.length, 49);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 131072);
  assert.ok(observed.every((r) => r.sql === null));
  for (let n = 0; n < 5; n++)
    f.sql.exec("CREATE TABLE shelf_job_probe_" + n + "(x)");
  await assert.rejects(assertJobsSchema(f.db), {
    code: "jobs_schema_unavailable",
  });
  assert.equal(observed.length, 50);
});
test("public input cannot select prompt/model/nonce or overrun bounded output; usage strict", async (t) => {
  const f = await jobsFixture(t);
  for (const input of [
    { ...f.input(), model: "other" },
    { ...f.input(), question: "a".repeat(4001) },
    { ...f.input(), source: { ...f.input().source, nonce: HASH } },
  ])
    await assert.rejects(f.state.admitJob(input, f.grant), {
      code: "jobs_input_invalid",
    });
  const r = await ready(f),
    a = await f.state.claimCall(r.job.id, 1, r.job.version, HASH);
  let ctx;
  await f.state.consumePermit(a.permit, (x) => {
    ctx = x;
  });
  await assert.rejects(
    f.state.finishCall(ctx, {
      ...complete,
      usage: { input_tokens: -1, output_tokens: 0 },
    }),
    { code: "jobs_usage_invalid" },
  );
  await assert.rejects(
    f.state.finishCall(ctx, { ...complete, content: "a".repeat(16001) }),
    { code: "jobs_content_limit" },
  );
  await f.state.finishCall(ctx, complete);
  assert.ok(f.db.calls.every((c) => c.args.length <= 32));
});
test("two SQLite connections converge same request with one creation permit", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "shelf-jobs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await jobsFixture(t, { file: path.join(dir, "db.sqlite") }),
    other = new DatabaseSync(path.join(dir, "db.sqlite"));
  t.after(() => other.close());
  const b = createJobsState(new SqlD1(other), { clock: () => f.now });
  const a = await Promise.all([
    f.state.admitJob(f.input(), f.grant),
    b.admitJob(f.input(), f.grant),
  ]);
  assert.equal(a.filter((x) => x.permit).length, 1);
  assert.equal(a[0].job.id, a[1].job.id);
  assert.equal(count(f, "shelf_jobs"), 1);
});
test("two SQLite connections race call and cancel with only one valid linearization", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "shelf-jobs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await jobsFixture(t, { file: path.join(dir, "db.sqlite") }),
    r = await ready(f),
    other = new DatabaseSync(path.join(dir, "db.sqlite"));
  t.after(() => other.close());
  const b = createJobsState(new SqlD1(other), { clock: () => f.now });
  const results = await Promise.allSettled([
    f.state.claimCall(r.job.id, 1, r.job.version, HASH),
    b.cancelJob(r.job.id, r.job.version),
  ]);
  const a = results[0],
    cancel = results[1];
  if (a.status === "fulfilled" && a.value.permit) {
    assert.equal(cancel.status, "rejected");
    assert.equal(count(f, "shelf_job_call_intents"), 1);
  } else {
    assert.equal(cancel.status, "fulfilled");
    assert.equal(cancel.value.state, "cancelled");
    assert.equal(count(f, "shelf_job_call_intents"), 0);
  }
});
test("two real Node threads race filename and job for last shared unit", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "shelf-jobs-threads-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "db.sqlite"),
    f = await jobsFixture(t, { file });
  for (let n = 1; n <= 19; n++) filename(f, n);
  const gate = new SharedArrayBuffer(4),
    workers = [];
  let readyCount = 0;
  const run = (kind) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./helpers/jobs-racer.mjs", import.meta.url),
        {
          workerData: {
            kind,
            file,
            gate,
            now: f.now,
            input: f.input(),
            grant: f.grant,
          },
        },
      );
      workers.push(worker);
      worker.on("message", (message) => {
        if (message.ready) {
          if (++readyCount === 2) {
            Atomics.store(new Int32Array(gate), 0, 1);
            Atomics.notify(new Int32Array(gate), 0);
          }
        } else resolve(message);
      });
      worker.on("error", reject);
    });
  t.after(() => Promise.all(workers.map((w) => w.terminate())));
  const results = await Promise.all([run("filename"), run("job")]);
  assert.equal(results.filter((r) => r.winner).length, 1);
  assert.equal((await f.state.sharedBudget()).used, 20);
  assert.equal(count(f, "shelf_job_call_intents"), 0);
});
