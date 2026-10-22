import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  CF01_AUDIT_LIMITS,
  CF01_AUDIT_SQL,
  Cf01AuditError,
  runCf01StorageAudit,
  main,
} from "../scripts/cf01-storage-audit.mjs";

const ACCOUNT = "a".repeat(32),
  TOKEN = "synthetic-private-project-token";
const DBID = "11111111-1111-4111-8111-111111111111";
const RUNID = "22222222-2222-4222-8222-222222222222";
const VERSIONS = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const bindings = [
  { name: "CF_DB", type: "d1", database_id: DBID },
  { name: "CF_BUCKET", type: "r2_bucket", bucket_name: "the-shelf-books" },
  {
    name: "CF_PROBE_TOKEN",
    type: "secret_text",
    text: "never-retain-secret-value",
  },
  { name: "CF_MOCK", type: "service", service: "the-shelf-cf01-mock" },
  {
    name: "CF_WORKFLOW",
    type: "workflow",
    workflow_name: "the-shelf-cf01",
    class_name: "Cf01Workflow",
  },
];
const envelope = (result) => Response.json({ success: true, result });
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cf01-audit-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf01"), { mode: 0o700 });
  const write = (relative, value) =>
    fs.writeFile(
      path.join(root, relative),
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
  await write(
    ".env",
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\n`,
  );
  const resources = {
    accountId: ACCOUNT,
    databaseId: DBID,
    databaseName: "the-shelf-cf01",
    ownedWorkers: ["the-shelf-cf01", "the-shelf-cf01-mock"],
  };
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
  await write(".local/cf01/resources.json", resources);
  await write(".local/cf01/wrangler.json", config);
  await write(
    ".local/cf01/wrangler-debug.log",
    [
      "Deployed the-shelf-cf01-mock triggers (1 sec)\nCurrent Version ID: 55555555-5555-4555-8555-555555555555",
      ...VERSIONS.map(
        (v) =>
          `Deployed the-shelf-cf01 triggers (1 sec)\n--- debug\nCurrent Version ID: ${v}\n`,
      ),
    ].join("\n"),
  );
  await write(
    ".local/cf01/deploy-the-shelf-cf01.log",
    `Deployed the-shelf-cf01 triggers (1 sec)\nCurrent Version ID: ${VERSIONS[1]}\n`,
  );
  const run = {
    run_id: RUNID,
    kind: "storage",
    state: "completed",
    delay_seconds: 0,
    mode: "success",
    network_calls: 0,
    mock_calls: 0,
    created_at: 100,
    updated_at: 200,
    result_json: '{"fullOk":true,"rangeOk":true,"bytes":72}',
  };
  await write(".local/cf01/evidence.json", {
    schemaVersion: 1,
    runs: [
      {
        label: "storage",
        runId: RUNID,
        origin: "https://the-shelf-cf01.iamzhutuo.workers.dev",
        cleaned: true,
      },
    ],
    requests: [
      {
        method: "POST",
        pathname: "/v1/runs",
        at: "2026-10-15T00:00:00Z",
        outcome: "response",
        status: 200,
        data: { run },
      },
    ],
  });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    await fs.readFile(
      new URL("../cloudflare/probe/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.prepare("INSERT INTO cf01_budget VALUES (?,?,?,?,?)").run(
    RUNID,
    "storage",
    100,
    0,
    "success",
  );
  db.prepare("DELETE FROM cf01_runs WHERE run_id=?").run(RUNID); // tombstone with only a historical receipt
  const receipts = async () => {
    const names = (await fs.readdir(path.join(root, ".local/cf01"))).filter(
      (v) => v.startsWith("storage-audit-") && v.endsWith(".json"),
    );
    return Promise.all(
      names.map(async (v) =>
        JSON.parse(
          await fs.readFile(path.join(root, ".local/cf01", v), "utf8"),
        ),
      ),
    );
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const [receipt] = await receipts();
    assert.equal(receipt.requests.length, calls.length);
    assert.equal(receipt.requests.at(-1).state, "dispatched");
    assert.equal(receipt.limits.requests, 16);
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
      assert.ok(Object.values(CF01_AUDIT_SQL).includes(sql));
      assert.deepEqual(params, []);
      assert.match(sql, /^SELECT /);
      return envelope([{ success: true, results: db.prepare(sql).all() }]);
    }
    assert.equal(options.method, "GET");
    if (url.endsWith("/workers/scripts/the-shelf-cf01/settings"))
      return envelope({ bindings });
    if (url.endsWith("/workers/scripts/the-shelf-cf01/subdomain"))
      return envelope({ enabled: false, previews_enabled: false });
    if (url.endsWith("/workers/workers/the-shelf-cf01"))
      return envelope({
        id: "fixed-worker-immutable-id",
        name: "the-shelf-cf01",
        updated_on: "2026-10-15T00:00:00Z",
        author_email: "never-retain@example.test",
      });
    for (const [i, id] of VERSIONS.entries())
      if (
        url.endsWith(
          `/workers/workers/the-shelf-cf01/versions/${id}?include=modules`,
        )
      )
        return envelope({
          id,
          number: i + 1,
          created_on: "2026-10-15T00:00:00Z",
          bindings,
          main_module: "worker.js",
          modules: [
            {
              name: "worker.js",
              content_type: "application/javascript+module",
              content_base64: Buffer.from(
                i === 0
                  ? "await CF_BUCKET.put('private-object-key', bytes);"
                  : "// different later code",
              ).toString("base64"),
            },
          ],
          author_email: "never-retain@example.test",
        });
    assert.fail("unexpected target");
  };
  return {
    root,
    db,
    write,
    resources,
    config,
    receipts,
    calls,
    fetchImpl,
    run: (overrides = {}) =>
      runCf01StorageAudit({
        execute: true,
        root,
        environment: {},
        fetchImpl,
        ...overrides,
      }),
  };
}

test("preview performs zero filesystem or network IO and rejects arbitrary CLI actions", async () => {
  const out = await runCf01StorageAudit({
    root: "/path-that-does-not-exist",
    fetchImpl: () => assert.fail("network"),
  });
  assert.equal(out.mode, "preview");
  assert.equal(out.requests, 0);
  assert.equal(out.uploadAllowed, false);
  await assert.rejects(main(["--worker", "other"]), {
    code: "cf01_audit_usage",
  });
});
test("fixed reads preregister intents, retain both historical modules privately, and never prove closure", async (t) => {
  const f = await fixture(t),
    out = await f.run(),
    [receipt] = await f.receipts();
  assert.equal(out.requests, 14);
  assert.ok(out.requests <= CF01_AUDIT_LIMITS.requests);
  assert.equal(out.storageReservations, 1);
  assert.equal(out.liveStorageRuns, 0);
  assert.deepEqual(receipt.knownVersions, VERSIONS);
  assert.equal(receipt.storageMappings[0].localCompletedReceiptObserved, true);
  assert.equal(receipt.storageMappings[0].tombstone, true);
  assert.equal(receipt.storageMappings[0].executionVersionMappingProven, false);
  assert.notEqual(
    receipt.versions[0].modules[0].sha256,
    receipt.versions[1].modules[0].sha256,
  );
  for (const key of [
    "executionVersionMappingProven",
    "cloudWriteFreezeProven",
    "drainProven",
    "uploadAllowed",
  ])
    assert.equal(out[key], false);
  for (const secret of [
    ACCOUNT,
    DBID,
    RUNID,
    TOKEN,
    ...VERSIONS,
    "private-object-key",
    "never-retain",
  ])
    assert.ok(!JSON.stringify(out).includes(secret));
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));
  assert.ok(!JSON.stringify(receipt).includes("never-retain"));
  const names = (await fs.readdir(path.join(f.root, ".local/cf01"))).filter(
    (v) => v.startsWith("storage-audit-"),
  );
  assert.equal(
    (await fs.stat(path.join(f.root, ".local/cf01", names[0]))).mode & 0o777,
    0o600,
  );
});
test("live failed or active storage stays inventory only, never a successful closure", async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(
      "INSERT INTO cf01_runs (run_id,kind,state,created_at,updated_at) VALUES (?,'storage','failed',100,200)",
    )
    .run(RUNID);
  const out = await f.run();
  assert.equal(out.liveStorageRuns, 1);
  assert.equal(out.cloudWriteFreezeProven, false);
  assert.equal((await f.receipts())[0].storageMappings[0].liveState, "failed");
});
for (const type of ["mode", "symlink", "hardlink", "directory"])
  test(`unsafe private ${type} blocks before all cloud IO`, async (t) => {
    const f = await fixture(t),
      file = path.join(f.root, ".local/cf01/resources.json");
    if (type === "mode") await fs.chmod(file, 0o644);
    if (type === "directory") await fs.chmod(path.dirname(file), 0o755);
    if (type === "hardlink") await fs.link(file, path.join(f.root, "linked"));
    if (type === "symlink") {
      await fs.rename(file, path.join(f.root, "outside"));
      await fs.symlink(path.join(f.root, "outside"), file);
    }
    await assert.rejects(f.run(), {
      code:
        type === "directory"
          ? "cf01_audit_private_directory_unsafe"
          : "cf01_audit_private_file_unsafe",
    });
    assert.equal(f.calls.length, 0);
  });
test("account and binding targets cannot be overridden by supplied config", async (t) => {
  const f = await fixture(t);
  await f.write(".local/cf01/wrangler.json", {
    ...f.config,
    r2_buckets: [{ binding: "CF_BUCKET", bucket_name: "other" }],
  });
  await assert.rejects(f.run(), { code: "cf01_audit_config_mismatch" });
  assert.equal(f.calls.length, 0);
});

for (const relative of ["", ".local", ".local/cf01"])
  for (const replacement of ["symlink", "directory"])
    test(`receipt pins ${relative || "root"} against ${replacement} replacement before further dispatch`, async (t) => {
      const f = await fixture(t);
      const target = path.join(f.root, relative),
        moved = `${target}-original`;
      const outside = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cf01-replacement-")),
      );
      await fs.chmod(outside, 0o700);
      t.after(() => fs.rm(outside, { recursive: true, force: true }));
      t.after(() => fs.rm(moved, { recursive: true, force: true }));
      const fetchImpl = async (url, options) => {
        const response = await f.fetchImpl(url, options);
        assert.equal(f.calls.length, 1);
        await fs.rename(target, moved);
        if (replacement === "symlink") await fs.symlink(outside, target);
        else await fs.mkdir(target, { mode: 0o700 });
        return response;
      };
      await assert.rejects(f.run({ fetchImpl }), {
        code: "cf01_audit_private_directory_changed",
      });
      assert.equal(f.calls.length, 1);
      assert.deepEqual(
        await fs.readdir(replacement === "symlink" ? outside : target),
        [],
      );
      const oldDir = path.join(
        moved,
        relative === "" ? ".local/cf01" : relative === ".local" ? "cf01" : "",
      );
      const receipts = (await fs.readdir(oldDir)).filter(
        (name) => name.startsWith("storage-audit-") && name.endsWith(".json"),
      );
      assert.equal(receipts.length, 1);
      const receipt = JSON.parse(
        await fs.readFile(path.join(oldDir, receipts[0]), "utf8"),
      );
      assert.equal(receipt.requests.length, 1);
      assert.equal(receipt.requests[0].state, "dispatched");
    });

test("exported audit errors cannot inject private messages or codes into receipt or returned diagnostics", async (t) => {
  const f = await fixture(t),
    sentinel = "PRIVATE-SENTINEL-untrusted-error-code";
  assert.equal(
    new Cf01AuditError(sentinel).code,
    "cf01_audit_local_or_transport_failure",
  );
  const error = new Cf01AuditError("cf01_audit_remote_rejected");
  error.code = sentinel;
  error.message = sentinel;
  error.privatePayload = sentinel;
  await assert.rejects(
    f.run({
      fetchImpl: () => {
        throw error;
      },
    }),
    (safe) => {
      assert.equal(safe.code, "cf01_audit_local_or_transport_failure");
      assert.ok(!String(safe).includes(sentinel));
      assert.ok(!JSON.stringify(safe).includes(sentinel));
      return true;
    },
  );
  const [receipt] = await f.receipts();
  assert.ok(!JSON.stringify(receipt).includes(sentinel));
  assert.equal(receipt.error, "cf01_audit_local_or_transport_failure");
  assert.equal(receipt.requests[0].state, "unknown");
});

test("replaced ordinary 0600 receipt is rejected before another dispatch", async (t) => {
  const f = await fixture(t);
  const fetchImpl = async (url, options) => {
    const response = await f.fetchImpl(url, options);
    const dir = path.join(f.root, ".local/cf01");
    const name = (await fs.readdir(dir)).find(
      (v) => v.startsWith("storage-audit-") && v.endsWith(".json"),
    );
    const filename = path.join(dir, name);
    await fs.rename(filename, `${filename}.original`);
    await fs.writeFile(filename, "{}", { mode: 0o600 });
    return response;
  };
  await assert.rejects(f.run({ fetchImpl }), {
    code: "cf01_audit_receipt_unsafe",
  });
  assert.equal(f.calls.length, 1);
});
test("missing earlier version cannot be substituted with current version", async (t) => {
  const f = await fixture(t);
  await f.write(
    ".local/cf01/wrangler-debug.log",
    `Deployed the-shelf-cf01 triggers (1 sec)\nCurrent Version ID: ${VERSIONS[1]}\n`,
  );
  await assert.rejects(f.run(), {
    code: "cf01_audit_known_versions_incomplete",
  });
  assert.equal(f.calls.length, 0);
});
test("excess storage history and missing D1 pages are failures, never empty sources", async (t) => {
  const f = await fixture(t);
  const fetchImpl = async (url, options) => {
    const normal = await f.fetchImpl(url, options);
    if (options.body && JSON.parse(options.body).sql === CF01_AUDIT_SQL.counts)
      return envelope([
        {
          success: true,
          results: [
            {
              budget_all: 5,
              budget_storage: 5,
              runs_storage: 0,
              orphan_storage: 0,
            },
          ],
        },
      ]);
    return normal;
  };
  await assert.rejects(f.run({ fetchImpl }), {
    code: "cf01_audit_history_incomplete",
  });
  assert.equal((await f.receipts())[0].status, "failed-closed");
});
test("orphan storage is explicitly retained and no version mapping is inferred", async (t) => {
  const f = await fixture(t);
  f.db
    .prepare(
      "INSERT INTO cf01_runs (run_id,kind,state,created_at,updated_at) VALUES (?,'storage','uncertain',100,200)",
    )
    .run("66666666-6666-4666-8666-666666666666");
  const out = await f.run();
  assert.equal(out.orphanStorageRuns, 1);
  assert.equal(out.drainProven, false);
  assert.equal((await f.receipts())[0].final.orphans[0].state, "uncertain");
});
test("changed snapshot fails closed without retry", async (t) => {
  const f = await fixture(t);
  const fetchImpl = async (url, options) => {
    const result = await f.fetchImpl(url, options);
    if (url.includes(`/versions/${VERSIONS[1]}`))
      f.db
        .prepare(
          "INSERT INTO cf01_runs (run_id,kind,state,created_at,updated_at) VALUES (?,'storage','running',100,200)",
        )
        .run(RUNID);
    return result;
  };
  await assert.rejects(f.run({ fetchImpl }), {
    code: "cf01_audit_snapshot_changed",
  });
  assert.equal(f.calls.length, 14);
});
for (const [label, response, code] of [
  [
    "redirect",
    () => new Response(null, { status: 302 }),
    "cf01_audit_redirect_rejected",
  ],
  [
    "forbidden",
    () => new Response(null, { status: 403 }),
    "cf01_audit_remote_rejected",
  ],
  [
    "oversized header",
    () => new Response("{}", { headers: { "content-length": "2000001" } }),
    "cf01_audit_response_limit",
  ],
  [
    "oversized stream",
    () => new Response("x".repeat(2_000_001)),
    "cf01_audit_response_limit",
  ],
  [
    "invalid json",
    () => new Response("private-sensitive-error"),
    "cf01_audit_json_invalid",
  ],
  [
    "missing page",
    () =>
      Response.json({
        success: true,
        result: {},
        result_info: { total_pages: 2 },
      }),
    "cf01_audit_envelope_invalid",
  ],
])
  test(`${label} stops after durable first intent and reports only safe code`, async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    await assert.rejects(
      f.run({
        fetchImpl: async () => {
          attempts++;
          return response();
        },
      }),
      { code },
    );
    assert.equal(attempts, 1);
    const [r] = await f.receipts();
    assert.equal(r.requests.length, 1);
    assert.equal(r.status, "failed-closed");
    assert.equal(r.error, code);
    assert.ok(!JSON.stringify(r).includes("private-sensitive-error"));
  });
test("hard deadline covers fetch even when transport ignores AbortSignal", async (t) => {
  const f = await fixture(t),
    started = Date.now();
  await assert.rejects(
    f.run({ requestTimeoutMs: 25, fetchImpl: () => new Promise(() => {}) }),
    { code: "cf01_audit_deadline" },
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal((await f.receipts())[0].requests[0].state, "unknown");
});
test("hard deadline includes stalled response body and cancels it", async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  await assert.rejects(
    f.run({
      requestTimeoutMs: 25,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    { code: "cf01_audit_deadline" },
  );
  assert.equal(cancelled, true);
  assert.equal((await f.receipts())[0].requests[0].state, "unknown");
});
test("missing historical modules fail closed and no later version can stand in", async (t) => {
  const f = await fixture(t);
  const fetchImpl = (url, options) =>
    url.includes(`/versions/${VERSIONS[0]}`)
      ? envelope({ id: VERSIONS[0], number: 1 })
      : f.fetchImpl(url, options);
  await assert.rejects(f.run({ fetchImpl }), {
    code: "cf01_audit_version_invalid",
  });
  assert.equal(
    (await f.receipts())[0].requests.at(-1).label,
    "known-worker-version",
  );
});
test("remote identity mismatch stops before any SQL", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  await assert.rejects(
    f.run({
      fetchImpl: async () => {
        attempts++;
        return envelope({ uuid: DBID, name: "another-project" });
      },
    }),
    { code: "cf01_audit_database_identity_mismatch" },
  );
  assert.equal(attempts, 1);
});
test("unknown remote binding refuses further resources and never stores its contents", async (t) => {
  const f = await fixture(t);
  const fetchImpl = (url, options) =>
    url.endsWith("/settings")
      ? envelope({
          bindings: [
            ...bindings,
            {
              name: "OTHER",
              type: "plain_text",
              text: "unrelated-private-value",
            },
          ],
        })
      : f.fetchImpl(url, options);
  await assert.rejects(f.run({ fetchImpl }), {
    code: "cf01_audit_bindings_unexpected",
  });
  const [receipt] = await f.receipts();
  assert.equal(receipt.requests.length, 6);
  assert.ok(!JSON.stringify(receipt).includes("unrelated-private-value"));
});
test("malformed historical module encoding cannot create a code receipt", async (t) => {
  const f = await fixture(t);
  const fetchImpl = (url, options) =>
    url.includes(`/versions/${VERSIONS[0]}`)
      ? envelope({
          id: VERSIONS[0],
          number: 1,
          created_on: "2026-10-15T00:00:00Z",
          main_module: "worker.js",
          bindings,
          modules: [
            {
              name: "worker.js",
              content_type: "application/javascript+module",
              content_base64: "not valid base64!",
            },
          ],
        })
      : f.fetchImpl(url, options);
  await assert.rejects(f.run({ fetchImpl }), {
    code: "cf01_audit_version_invalid",
  });
  assert.deepEqual((await f.receipts())[0].versions, []);
});
