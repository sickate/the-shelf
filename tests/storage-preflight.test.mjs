import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  runStoragePreflight,
  PREFLIGHT_REQUEST_LIMIT,
} from "../scripts/storage-preflight.mjs";

const ACCOUNT = "a".repeat(32),
  TOKEN = "synthetic-private-project-token";
const IDS = {
  check: "11111111-1111-4111-8111-111111111111",
  production: "22222222-2222-4222-8222-222222222222",
};
const names = {
  check: "the-shelf-cf03-check",
  production: "the-shelf-library",
};
const result = (value) => Response.json({ success: true, result: value });
const queryResult = (rows) => result([{ success: true, results: rows }]);

async function fixture(
  t,
  { stateDir = ".local", ledger, manifest = { files: {} } } = {},
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-preflight-")),
    root = await fs.realpath(tmp);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf03"), { mode: 0o700 });
  if (stateDir !== ".local")
    await fs.mkdir(path.join(root, stateDir), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\nSHELF_STATE_DIR=${stateDir}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: Object.fromEntries(
        Object.keys(IDS).map((p) => [
          p,
          { databaseId: IDS[p], databaseName: names[p] },
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  if (manifest !== null)
    await fs.writeFile(
      path.join(root, ".local/manifest.json"),
      JSON.stringify(manifest),
      { mode: 0o600 },
    );
  if (ledger !== undefined)
    await fs.writeFile(
      path.join(root, stateDir, "upload-reservations.json"),
      JSON.stringify(ledger),
      { mode: 0o600 },
    );
  const receipts = async () => {
    const files = (await fs.readdir(path.join(root, ".local/cf03"))).filter(
      (f) => f.startsWith("storage-preflight-"),
    );
    return Promise.all(
      files.map(async (f) =>
        JSON.parse(
          await fs.readFile(path.join(root, ".local/cf03", f), "utf8"),
        ),
      ),
    );
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const [receipt] = await receipts();
    assert.equal(receipt.requestLimit, PREFLIGHT_REQUEST_LIMIT);
    assert.equal(receipt.requests.length, calls.length);
    assert.equal(receipt.requests.at(-1).state, "dispatched");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal);
    const profile = url.includes(IDS.check) ? "check" : "production";
    if (url.endsWith("/query")) {
      const { sql, params } = JSON.parse(options.body);
      assert.deepEqual(params, []);
      assert.match(sql, /^SELECT /);
      assert.doesNotMatch(
        sql,
        /verifier|session_hash|\b(?:UPDATE|INSERT|DELETE|CREATE|DROP)\b/,
      );
      if (sql.includes("COUNT(*) AS count FROM sqlite_master"))
        return queryResult([{ count: 0 }]);
      return queryResult([]);
    }
    if (url.includes("/d1/database/"))
      return result({ uuid: IDS[profile], name: names[profile] });
    if (url.endsWith("/settings"))
      return result({
        bindings: [
          {
            name: "ASSETS",
            type: "assets",
            text: "do-not-copy-private-remote-field",
          },
        ],
      });
    if (url.endsWith("/subdomain"))
      return result({ enabled: false, previews_enabled: false });
    assert.fail("unexpected target");
  };
  return {
    root,
    calls,
    receipts,
    fetchImpl,
    run: (fetcher = fetchImpl, options = {}) =>
      runStoragePreflight({
        root,
        environment: {},
        fetchImpl: fetcher,
        clock: () => Date.parse("2026-10-21T04:00:00Z"),
        ...options,
      }),
  };
}

test("fixed-target preflight preregisters bounded requests and proves explicit empty schemas without claiming freeze", async (t) => {
  const f = await fixture(t),
    out = await f.run(),
    [receipt] = await f.receipts();
  assert.equal(out.requests, 10);
  assert.ok(out.requests <= out.requestLimit);
  assert.equal(out.legacyLocalEmpty, true);
  assert.equal(out.uploadAllowed, false);
  assert.equal(out.databases.production.emptySourceProven, true);
  assert.equal(receipt.cloudWriteFreezeProven, false);
  assert.equal(receipt.migrationComplete, false);
  assert.equal(receipt.local.writesStoppedProven, false);
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));
  assert.ok(
    !JSON.stringify(receipt).includes("do-not-copy-private-remote-field"),
  );
  assert.ok(!JSON.stringify(out).includes(ACCOUNT));
  assert.ok(!JSON.stringify(out).includes(IDS.check));
  assert.equal(
    (await fs.stat(path.join(f.root, out.privateReceipt))).mode & 0o777,
    0o600,
  );
});

test("read-only table counts distinguish unknown application tables from empty sources", async (t) => {
  const f = await fixture(t);
  const out = await f.run(async (url, options) => {
    const original = await f.fetchImpl(url, options);
    if (options.body?.includes("COUNT(*) AS count FROM sqlite_master"))
      return queryResult([{ count: 1 }]);
    return original;
  });
  assert.equal(out.databases.production.emptySourceProven, false);
  assert.equal(out.databases.production.sourceState, "unrecognized-schema");
});

test("real project schema SQL inventory reads only aggregate states within the exact maximum request budget", async (t) => {
  const f = await fixture(t),
    db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    await fs.readFile(
      new URL("../cloudflare/library/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.prepare(
    "INSERT INTO auth_config VALUES ('check','https://example.invalid','owner-access-key-v1',?,7,0,1)",
  ).run("f".repeat(64));
  const out = await f.run(async (url, options) => {
    const fallback = await f.fetchImpl(url, options);
    if (url.endsWith("/query")) {
      const { sql } = JSON.parse(options.body);
      return queryResult(db.prepare(sql).all());
    }
    return fallback;
  });
  assert.equal(out.requests, PREFLIGHT_REQUEST_LIMIT);
  assert.equal(out.databases.check.enabledAuthRows, 0);
  assert.equal(out.databases.production.emptySourceProven, false);
  const [receipt] = await f.receipts();
  assert.deepEqual(receipt.databases.check.storageState, []);
  assert.deepEqual(receipt.databases.check.reservations, []);
  assert.equal(receipt.databases.check.auth[0].generation, 7);
  assert.ok(!JSON.stringify(receipt).includes("f".repeat(64)));
});

test("database identity rejection or unavailable D1 never becomes empty-source evidence", async (t) => {
  for (const response of [
    result({ uuid: IDS.production, name: names.production }),
    new Response("secret upstream error", { status: 403 }),
  ]) {
    const f = await fixture(t);
    await assert.rejects(
      f.run(async () => response),
      { name: "PreflightError" },
    );
    const [receipt] = await f.receipts();
    assert.equal(receipt.status, "incomplete");
    assert.deepEqual(receipt.databases, {});
    assert.equal(receipt.requests.length, 1);
    assert.ok(!JSON.stringify(receipt).includes("secret upstream error"));
  }
});

test("configured local JSON reservations, registered objects and upload lock block legacy-empty claim", async (t) => {
  const f = await fixture(t, {
    stateDir: ".local/custom",
    ledger: { private_id: { sizeBytes: 17, key: "private-key" } },
    manifest: { files: { private_file: { storageKey: "private-book-key" } } },
  });
  await fs.writeFile(
    path.join(f.root, ".local/custom/upload.lock"),
    "private lock data",
    { mode: 0o600 },
  );
  const out = await f.run(),
    [receipt] = await f.receipts();
  assert.equal(out.legacyLocalEmpty, false);
  assert.equal(
    receipt.local.reservations.path,
    ".local/custom/upload-reservations.json",
  );
  assert.equal(receipt.local.reservations.count, 1);
  assert.equal(receipt.local.manifest.registered, 1);
  assert.equal(receipt.local.lock.state, "present");
  assert.ok(!JSON.stringify(receipt).includes("private-book-key"));
  assert.ok(!JSON.stringify(receipt).includes("private_id"));
});

test("missing manifest does not prove empty local legacy state", async (t) => {
  const f = await fixture(t, { manifest: null });
  assert.equal((await f.run()).legacyLocalEmpty, false);
});

test("configured external or symlinked private paths fail before remote requests", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(
    path.join(f.root, ".env"),
    "SHELF_MANIFEST_PATH=../external-manifest.json\n",
  );
  await assert.rejects(f.run(), {
    code: "preflight_configured_path_outside_private",
  });
  assert.equal(f.calls.length, 0);
  await fs.writeFile(
    path.join(f.root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\n`,
    { mode: 0o600 },
  );
  await fs.unlink(path.join(f.root, ".local/manifest.json"));
  await fs.symlink(
    path.join(f.root, ".env"),
    path.join(f.root, ".local/manifest.json"),
  );
  await assert.rejects(f.run(), { code: "preflight_local_file_unsafe" });
  assert.equal(f.calls.length, 0);
});

test("oversized response is canceled and reported safely with consumed request preserved", async (t) => {
  const f = await fixture(t);
  let canceled = false;
  await assert.rejects(
    f.run(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(1_000_001));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    ),
    { code: "preflight_response_limit" },
  );
  assert.equal(canceled, true);
  const [receipt] = await f.receipts();
  assert.equal(receipt.requests.length, 1);
  assert.equal(receipt.status, "incomplete");
});

test("transport failure records unknown without retry or leaking upstream message", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    f.run(async () => {
      calls++;
      throw new Error(TOKEN);
    }),
    { code: "preflight_transport_unknown" },
  );
  assert.equal(calls, 1);
  const [receipt] = await f.receipts();
  assert.equal(receipt.requests[0].state, "unknown");
  assert.ok(!JSON.stringify(receipt).includes(TOKEN));
});

test("whole-request deadline rejects ignored-signal fetch, stalled body and hung cancel without awaiting cleanup", async (t) => {
  for (const behavior of ["fetch", "body", "late"]) {
    const f = await fixture(t);
    let calls = 0,
      signal;
    const start = performance.now();
    await assert.rejects(
      f.run(
        async (_url, options) => {
          calls++;
          signal = options.signal;
          if (behavior === "fetch") return new Promise(() => {});
          if (behavior === "late") await new Promise((r) => setTimeout(r, 60));
          return new Response(
            new ReadableStream({
              pull() {
                return new Promise(() => {});
              },
              cancel() {
                return new Promise(() => {});
              },
            }),
          );
        },
        { requestTimeoutMs: 10 },
      ),
      { code: "preflight_deadline" },
    );
    assert.ok(performance.now() - start < 1000);
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    const [receipt] = await f.receipts();
    assert.equal(receipt.status, "incomplete");
    assert.equal(receipt.requests[0].state, "unknown");
    assert.deepEqual(receipt.databases, {});
  }
});

test("redirected responses and response URL mismatch fail before reading remote data", async (t) => {
  for (const fields of [
    { redirected: true },
    { url: "https://other.invalid/private" },
  ]) {
    const f = await fixture(t);
    const response = result({ uuid: IDS.check, name: names.check });
    for (const [k, v] of Object.entries(fields))
      Object.defineProperty(response, k, { value: v });
    await assert.rejects(
      f.run(async () => response),
      { code: "preflight_redirect_rejected" },
    );
    assert.deepEqual((await f.receipts())[0].databases, {});
  }
});

test("incomplete legacy ledger evidence preserves byte counts while unavailable evidence stays unknown", async (t) => {
  const f = await fixture(t);
  const out = await f.run(async (url, options) => {
    const fallback = await f.fetchImpl(url, options);
    if (!options.body) return fallback;
    const { sql } = JSON.parse(options.body);
    if (sql.startsWith("SELECT type,"))
      return queryResult([
        {
          type: "table",
          name: "storage_state",
          tbl_name: "storage_state",
          sql: "CREATE TABLE storage_state(id INTEGER)",
        },
      ]);
    if (sql.includes("COUNT(*) AS count FROM sqlite_master"))
      return queryResult([{ count: 1 }]);
    if (sql.startsWith("SELECT id,"))
      return queryResult([
        {
          id: 1,
          account_id: ACCOUNT,
          observed_account_bytes: 0,
          observed_at: 0,
          ceiling_bytes: 8_000_000_000,
          reserved_bytes: 17,
          committed_bytes: 23,
          evidence_hash: null,
          evidence_complete: 0,
          updated_at: 0,
        },
      ]);
    return fallback;
  });
  assert.equal(out.uploadAllowed, false);
  const row = (await f.receipts())[0].databases.check.storageState[0];
  assert.equal(row.evidenceHash, null);
  assert.equal(row.evidenceComplete, 0);
  assert.equal(row.reservedBytes, 17);
  assert.equal(row.committedBytes, 23);
});
