import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  runSingleTrial,
  parseSingleTrialArgs,
  SINGLE_TRIAL_BUDGETS,
} from "../scripts/single-trial.mjs";
import {
  bytesSha256,
  objectContentType,
} from "../server/storage-authority.mjs";
const ACCOUNT = "a".repeat(32),
  TOKEN = "synthetic-trial-token-not-real",
  SECRET = Buffer.alloc(32, 7).toString("base64url");
const IDS = {
  check: "11111111-1111-4111-8111-111111111111",
  production: "22222222-2222-4222-8222-222222222222",
};
const FILE = "private_fixture_file",
  BOOK = "private_fixture_book";
const IDENTITY = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: IDS,
};
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-trial-operator-")),
  );
  const db = new DatabaseSync(":memory:");
  db.function("unixepoch", { varargs: true }, () => Date.now() / 1000);
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const dir of [
    ".local",
    ".local/state",
    ".local/private",
    ".local/single-trial",
    ".local/cf03",
    ".local/cf03/production",
    "books",
    "data",
  ])
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  const bytes = Buffer.from(
    "%PDF-1.7\nSynthetic private fixture text\n%%EOF\n",
  );
  const source = path.join(root, "books/fixture.pdf");
  await fs.writeFile(source, bytes, { mode: 0o600 });
  const publicBook = {
    id: BOOK,
    title: "Synthetic book",
    author: null,
    description: "Synthetic fixture",
    category: "Test",
    categoryId: "test-category",
    tags: [],
    files: [
      {
        id: FILE,
        format: "PDF",
        sizeBytes: bytes.length,
        status: "candidate",
        reason: "not_uploaded",
        visibility: "private",
        readable: false,
      },
    ],
  };
  await fs.writeFile(
    path.join(root, "data/catalog.json"),
    JSON.stringify({ books: [publicBook] }),
  );
  const st = await fs.stat(source, { bigint: true });
  await fs.writeFile(
    path.join(root, ".local/private/manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      root: path.join(root, "books"),
      files: {
        [FILE]: {
          bookId: BOOK,
          path: source,
          format: "PDF",
          sizeBytes: bytes.length,
          mtimeNs: String(st.mtimeNs),
          eligibility: "candidate",
          visibility: "private",
        },
      },
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/single-trial/selection.json"),
    JSON.stringify({ schemaVersion: 1, fileId: FILE }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_R2_BUCKET=the-shelf-books\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\nSHELF_MANIFEST_PATH=.local/private/manifest.json\nSHELF_STATE_DIR=.local/state\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        check: { databaseId: IDS.check, databaseName: "the-shelf-cf03-check" },
        production: {
          databaseId: IDS.production,
          databaseName: "the-shelf-library",
        },
      },
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/production/single-trial-upload-secret"),
    SECRET,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, ".local/cf03/production/single-trial-target.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "first-book-20261023",
      accountId: ACCOUNT,
      bucket: "the-shelf-first-book-20261023",
      worker: "the-shelf",
      origin: "https://the-shelf.iamzhutuo.workers.dev",
      uploadSecretSha256: bytesSha256(SECRET),
    }),
    { mode: 0o600 },
  );
  for (const name of [
    "schema.sql",
    "migrations/003-storage-authority.sql",
    "migrations/004-freeze-legacy-storage.sql",
  ])
    db.exec(
      await fs.readFile(
        new URL("../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    );
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase) VALUES(1,?,'migration_required')",
  ).run(JSON.stringify(IDENTITY));
  for (const scope of ["check", "production"])
    db.prepare(
      "INSERT INTO shelf_storage_sources VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(scope, "f".repeat(64), "e".repeat(64), "{}", "{}", 0, 0, 0, 0);
  db.prepare(
    "UPDATE shelf_storage_authority SET phase='imported',migration_hash=? WHERE id=1",
  ).run("f".repeat(64));
  db.prepare(
    "INSERT INTO auth_config(scope,origin,scheme,verifier,generation,enabled,updated_at) VALUES(?,?,'owner-access-key-v1',?,1,0,?)",
  ).run(
    "production",
    "https://the-shelf.iamzhutuo.workers.dev",
    "a".repeat(64),
    Date.now(),
  );
  db.prepare(
    "INSERT INTO catalog_books(scope,book_id,public_json) VALUES(?,?,?)",
  ).run(
    "production",
    BOOK,
    JSON.stringify({
      id: BOOK,
      files: [
        {
          id: FILE,
          format: "PDF",
          sizeBytes: bytes.length,
          status: "candidate",
        },
      ],
    }),
  );
  const calls = [];
  let fault,
    object = null,
    corrupted = false,
    health = 404;
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(options.redirect, "error");
    if (new URL(url).hostname === "api.cloudflare.com") {
      assert.ok(url.includes(IDS.production));
      assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
      if (!url.endsWith("/query"))
        return Response.json({
          success: true,
          result: { uuid: IDS.production, name: "the-shelf-library" },
        });
      const { sql, params } = JSON.parse(options.body),
        results = db.prepare(sql).all(...params);
      if (fault?.(sql)) throw new Error(`secret failure ${TOKEN}`);
      return Response.json({
        success: true,
        result: [{ success: true, results }],
      });
    }
    assert.equal(
      new URL(url).origin,
      "https://the-shelf.iamzhutuo.workers.dev",
    );
    if (url.endsWith("/api/health"))
      return new Response(null, { status: health });
    assert.equal(
      options.headers.origin,
      "https://the-shelf.iamzhutuo.workers.dev",
    );
    assert.equal(options.headers["x-shelf-trial-secret"], SECRET);
    assert.equal(
      options.headers["x-shelf-trial-permit"],
      "first-book-20261023",
    );
    assert.equal(options.headers.cookie, undefined);
    const row = db.prepare("SELECT * FROM shelf_storage_single_trial").get();
    const descriptor = JSON.parse(row.descriptor_json),
      etag = '"synthetic-trial-etag"';
    if (url.endsWith("/api/single-trial/upload")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["content-length"], String(bytes.length));
      assert.equal(bytesSha256(options.body), descriptor.sha256);
      const changed = db
        .prepare(
          "UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1,updated_at=? WHERE id=1 AND state='reserved' AND put_attempted=0 RETURNING id",
        )
        .all(Date.now());
      assert.equal(changed.length, 1);
      object = Buffer.from(options.body);
      if (fault?.("upload-response")) throw new Error(`lost ${SECRET}`);
      return Response.json({
        state: "uploaded",
        permitId: row.permit_id,
        etag,
      });
    }
    assert.ok(url.endsWith("/api/single-trial/object"));
    assert.ok(["HEAD", "GET"].includes(options.method));
    if (!object) return new Response(null, { status: 404 });
    if (options.method === "GET")
      assert.equal(options.headers["if-match"], etag);
    return new Response(
      options.method === "HEAD"
        ? null
        : corrupted
          ? Buffer.alloc(object.length)
          : object,
      {
        headers: {
          "content-length": String(object.length),
          "content-type": objectContentType(descriptor),
          "x-amz-meta-sha256": descriptor.sha256,
          etag,
        },
      },
    );
  };
  let seq = 0;
  const run = async (action, extra = {}) => {
    const before = calls.length;
    try {
      return await runSingleTrial({
        root,
        environment: {},
        fetchImpl,
        action,
        ...(action === "plan" ? {} : { runId: `run_${++seq}` }),
        ...extra,
      });
    } finally {
      assert.ok(
        calls.length - before <=
          (action === "plan" ? 0 : SINGLE_TRIAL_BUDGETS[action].http),
      );
    }
  };
  return {
    root,
    db,
    bytes,
    calls,
    source,
    run,
    fault: (fn) => {
      fault = fn;
    },
    corrupt: () => {
      corrupted = true;
    },
    health: (value) => {
      health = value;
    },
  };
}
async function ready(f) {
  assert.equal((await f.run("schema")).status, "schema-installed");
  assert.equal((await f.run("issue")).status, "reserved");
}
test("default plan is local only, output omits private identifiers/hash/root, and parser rejects arbitrary scope", async (t) => {
  const f = await fixture(t),
    result = await f.run("plan");
  assert.equal(result.status, "planned");
  assert.equal(result.uploadAllowed, false);
  assert.equal(f.calls.length, 0);
  for (const secret of [FILE, BOOK, f.root, bytesSha256(f.bytes), SECRET])
    assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(parseSingleTrialArgs([]), {
    action: "plan",
    fileId: undefined,
    runId: undefined,
  });
  for (const args of [
    ["--bucket", "x"],
    ["upload"],
    ["status", "--run", "../bad"],
    ["ready", "--run", "x"],
  ])
    assert.throws(() => parseSingleTrialArgs(args));
});
test("schema verifies disabled/API404, installs exact definitions once and reports catalog, then status stays read only", async (t) => {
  const f = await fixture(t),
    result = await f.run("schema");
  assert.equal(result.status, "schema-installed");
  assert.equal(result.catalogAvailable, true);
  assert.equal(f.calls.length, 17);
  assert.ok(f.calls.length <= SINGLE_TRIAL_BUDGETS.schema.http);
  const count = f.calls.length;
  assert.equal((await f.run("schema")).status, "schema-verified");
  assert.equal(f.calls.length - count, 4);
  assert.equal((await f.run("status")).status, "not-issued");
});
test("schema requires exact old trigger and disabled auth and absent API before any cloud mutation", async (t) => {
  for (const failure of ["trigger", "auth", "api"]) {
    const f = await fixture(t);
    if (failure === "trigger") f.db.exec("DROP TRIGGER admission_private");
    if (failure === "auth")
      f.db.exec("UPDATE auth_config SET enabled=1 WHERE scope='production'");
    if (failure === "api") f.health(200);
    await assert.rejects(f.run("schema"));
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='shelf_storage_single_trial'",
        )
        .get().n,
      0,
    );
  }
});
test("lost schema mutation stops, partial schema is never automatically replayed", async (t) => {
  const f = await fixture(t);
  f.fault((sql) => sql.startsWith("CREATE TABLE shelf_storage_single_trial"));
  await assert.rejects(f.run("schema"), {
    code: "single_trial_write_outcome_unknown",
  });
  f.fault(null);
  const before = f.calls.length;
  await assert.rejects(f.run("schema"), {
    code: "single_trial_partial_schema_requires_review",
  });
  assert.equal(f.calls.length - before, 4);
});
test("issue requires real matching catalog candidate and lost issuance is read-only recoverable without replay", async (t) => {
  const f = await fixture(t);
  await f.run("schema");
  f.db.exec("DELETE FROM catalog_books");
  await assert.rejects(f.run("issue"), {
    code: "single_trial_catalog_required",
  });
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM shelf_storage_single_trial").get()
      .n,
    0,
  );
  const g = await fixture(t);
  await g.run("schema");
  g.fault((sql) => sql.startsWith("INSERT INTO shelf_storage_single_trial"));
  await assert.rejects(g.run("issue"), {
    code: "storage_remote_outcome_unknown",
  });
  g.fault(null);
  assert.equal((await g.run("status")).status, "reserved");
  await assert.rejects(g.run("issue"), { code: "single_trial_already_issued" });
});
test("one upload POST is independent from confirmation; reconciliation uses only fixed HEAD GET HEAD and same authority", async (t) => {
  const f = await fixture(t);
  await ready(f);
  assert.equal((await f.run("upload")).status, "uploaded-unverified");
  const before = f.calls.length,
    result = await f.run("reconcile");
  assert.equal(result.status, "confirmed");
  assert.equal(result.contentVerified, true);
  assert.deepEqual(
    f.calls
      .slice(before)
      .filter((c) => !c.url.includes("api.cloudflare.com"))
      .map((c) => c.method),
    ["HEAD", "GET", "HEAD"],
  );
  assert.equal(
    f.db.prepare("SELECT committed_bytes FROM shelf_storage_authority").get()
      .committed_bytes,
    f.bytes.length,
  );
  assert.equal(
    f.db.prepare("SELECT phase FROM shelf_storage_authority").get().phase,
    "imported",
  );
  await assert.rejects(f.run("upload"), {
    code: "single_trial_attempt_already_recorded",
  });
  assert.equal(
    f.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/api/single-trial/upload"),
    ).length,
    1,
  );
});
test("lost upload response is unknown and cannot be re-dispatched, explicit bounded reconcile can confirm it", async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.fault((sql) => sql === "upload-response");
  await assert.rejects(f.run("upload"), {
    code: "single_trial_upload_outcome_unknown",
  });
  f.fault(null);
  await assert.rejects(f.run("upload"), {
    code: "single_trial_attempt_already_recorded",
  });
  assert.equal((await f.run("reconcile")).status, "confirmed");
});
test("changed source before upload and changed target config stop before POST", async (t) => {
  const f = await fixture(t);
  await ready(f);
  await fs.writeFile(f.source, Buffer.alloc(f.bytes.length), { mode: 0o600 });
  await assert.rejects(f.run("upload"));
  assert.equal(
    f.calls.filter((c) => c.url.endsWith("/api/single-trial/upload")).length,
    0,
  );
  const g = await fixture(t);
  await ready(g);
  const filename = path.join(
    g.root,
    ".local/cf03/production/single-trial-target.json",
  );
  const config = JSON.parse(await fs.readFile(filename));
  config.worker = "other";
  await fs.writeFile(filename, JSON.stringify(config));
  await assert.rejects(g.run("upload"), {
    code: "single_trial_target_configuration_invalid",
  });
});
test("corrupt verification never confirms or repeats upload; reserved bytes retained", async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.run("upload");
  f.corrupt();
  await assert.rejects(f.run("reconcile"));
  assert.equal((await f.run("status")).status, "uncertain");
  assert.equal(
    f.db.prepare("SELECT reserved_bytes FROM shelf_storage_authority").get()
      .reserved_bytes,
    f.bytes.length,
  );
});
test("journals are immutable 0600 and never persist secret, bytes, URL, or authorization", async (t) => {
  const f = await fixture(t);
  await ready(f);
  await f.run("upload");
  const inspect = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        assert.equal((await fs.stat(filename)).mode & 0o777, 0o700);
        await inspect(filename);
      } else {
        assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
        const text = await fs.readFile(filename, "utf8");
        for (const secret of [
          TOKEN,
          SECRET,
          f.bytes.toString(),
          "Authorization",
          "https://",
        ])
          assert.ok(!text.includes(secret));
      }
    }
  };
  await inspect(path.join(f.root, ".local/single-trial"));
  await assert.rejects(f.run("status", { runId: "run_1" }), {
    code: "single_trial_run_exists",
  });
});

test("clean issue and reconcile plus lost confirm response stay within explicit budgets", async (t) => {
  const f = await fixture(t);
  await f.run("schema");
  let before = f.calls.length;
  await f.run("issue");
  assert.equal(f.calls.length - before, 9);
  before = f.calls.length;
  await f.run("upload");
  assert.equal(f.calls.length - before, 1);
  f.fault((sql) =>
    sql.startsWith("UPDATE shelf_storage_single_trial SET state='confirmed'"),
  );
  before = f.calls.length;
  await assert.rejects(f.run("reconcile"));
  assert.ok(f.calls.length - before <= 16);
  f.fault(null);
  assert.equal((await f.run("status")).status, "confirmed");
  before = f.calls.length;
  assert.equal((await f.run("reconcile")).status, "confirmed");
  assert.equal(f.calls.length - before, 4);
});

function hostileResponse(kind) {
  if (kind === "fetch-ignores-abort") return new Promise(() => {});
  if (kind === "malformed-json")
    return new Response("fake200<body>", { status: 200 });
  if (kind === "large") return new Response(new Uint8Array(1_000_001));
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (kind === "read-ignores-abort") return new Promise(() => {});
        controller.enqueue(
          kind === "bad-chunk" ? "not a byte array" : new Uint8Array(0),
        );
      },
      cancel() {
        return new Promise(() => {});
      },
    }),
  );
}
test(
  "D1 body/fetch ignores abort, malformed200, untyped/zero-byte floods and never-settling cancellation are bounded",
  { timeout: 5000 },
  async (t) => {
    for (const kind of [
      "fetch-ignores-abort",
      "read-ignores-abort",
      "malformed-json",
      "large",
      "bad-chunk",
      "zero-flood",
    ]) {
      const f = await fixture(t);
      let requests = 0;
      await assert.rejects(
        f.run("schema", {
          requestTimeoutMs: 20,
          fetchImpl: async () => {
            requests++;
            return hostileResponse(kind);
          },
        }),
        { code: "single_trial_read_failed" },
      );
      assert.equal(requests, 1);
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name='shelf_storage_single_trial'",
          )
          .get().n,
        0,
      );
    }
  },
);
test(
  "upload fake200/malformed stream, ignored abort and hung cancellation consume exactly one dispatch with no retry",
  { timeout: 10000 },
  async (t) => {
    for (const kind of [
      "fetch-ignores-abort",
      "read-ignores-abort",
      "malformed-json",
      "large",
      "bad-chunk",
      "zero-flood",
    ]) {
      const f = await fixture(t);
      await ready(f);
      let requests = 0;
      const fetchImpl = async () => {
        requests++;
        return hostileResponse(kind);
      };
      await assert.rejects(
        f.run("upload", { requestTimeoutMs: 20, fetchImpl }),
        { code: "single_trial_upload_outcome_unknown" },
      );
      await assert.rejects(
        f.run("upload", { requestTimeoutMs: 20, fetchImpl }),
        { code: "single_trial_attempt_already_recorded" },
      );
      assert.equal(requests, 1);
    }
  },
);

test("catalog action uses existing bootstrap for exactly selected real book with empty overrides and independent hashes/readback", async (t) => {
  const f = await fixture(t);
  f.db.exec("DELETE FROM catalog_books");
  const before = f.calls.length,
    result = await f.run("catalog");
  assert.equal(result.status, "catalog-imported");
  assert.equal(f.calls.length - before, 7);
  assert.equal(result.books, 1);
  const row = f.db
    .prepare("SELECT * FROM catalog_imports WHERE scope='production'")
    .get();
  assert.equal(row.state, "complete");
  assert.equal(row.book_count, 1);
  assert.equal(row.patch_count, 0);
  const imported = JSON.parse(
    f.db.prepare("SELECT public_json FROM catalog_books").get().public_json,
  );
  assert.equal(imported.id, BOOK);
  assert.equal(imported.files[0].id, FILE);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM metadata_overrides").get().n,
    0,
  );
  for (const privateValue of [FILE, BOOK, row.input_hash, row.base_hash])
    assert.ok(!JSON.stringify(result).includes(privateValue));
});
test("catalog rejects existing rows, active lease, enabled auth and public candidate mismatch before mutation", async (t) => {
  for (const kind of ["nonempty", "active", "enabled", "candidate", "size"]) {
    const f = await fixture(t);
    if (kind !== "nonempty") f.db.exec("DELETE FROM catalog_books");
    if (kind === "active")
      f.db
        .prepare(
          "INSERT INTO catalog_imports VALUES('production',?,?,?,'active',1,0,0,?,?)",
        )
        .run(
          "a".repeat(64),
          "b".repeat(64),
          "synthetic-owner",
          Date.now(),
          Date.now(),
        );
    if (kind === "enabled")
      f.db.exec("UPDATE auth_config SET enabled=1 WHERE scope='production'");
    if (["candidate", "size"].includes(kind)) {
      const filename = path.join(f.root, "data/catalog.json"),
        value = JSON.parse(await fs.readFile(filename));
      if (kind === "candidate") value.books[0].files[0].status = "local_only";
      else value.books[0].files[0].sizeBytes++;
      await fs.writeFile(filename, JSON.stringify(value));
    }
    await assert.rejects(f.run("catalog"));
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM catalog_import_rows").get().n,
      0,
    );
    assert.equal(
      f.calls.some((call) => call.url.endsWith("/api/single-trial/upload")),
      false,
    );
  }
});
test("lost catalog lease/staging/complete response stops once and never resumes or resets", async (t) => {
  for (const mutation of [
    "INSERT INTO catalog_imports(",
    "INSERT INTO catalog_import_rows(",
    "UPDATE catalog_imports SET state='complete'",
  ]) {
    const f = await fixture(t);
    f.db.exec("DELETE FROM catalog_books");
    f.fault((sql) => sql.startsWith(mutation));
    await assert.rejects(f.run("catalog"), {
      code: "single_trial_write_outcome_unknown",
    });
    f.fault(null);
    const state = f.db.prepare("SELECT state FROM catalog_imports").get().state;
    const before = f.calls.length;
    await assert.rejects(f.run("catalog"));
    assert.ok(f.calls.length - before <= 2);
    assert.equal(
      f.db.prepare("SELECT state FROM catalog_imports").get().state,
      state,
    );
  }
});
