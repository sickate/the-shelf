import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  publicCatalog,
  metadataPatch,
  accountEvidence,
  selectedFile,
  readPrivateJson,
  writePrivateJson,
} from "../scripts/cf-library-data.mjs";
import {
  bootstrap,
  makeFilePlan,
  reserve,
  uploadOne,
  reconcile,
  snapshot,
  saveSnapshot,
  conservativeStorageBudget,
  STORAGE_ADMISSION,
} from "../scripts/cf-library-operations.mjs";
import { d1Client, r2Client } from "../scripts/cf-library-clients.mjs";
import { parseArguments, runLibrary } from "../scripts/cf-library.mjs";

const now = Date.parse("2026-10-15T09:00:00Z");
const base = () => ({
  id: "book_1",
  title: "Book",
  author: null,
  category: "Books",
  categoryId: "cat_1",
  tags: [],
  description: "",
  files: [
    {
      id: "file_1",
      format: "EPUB",
      sizeBytes: 4,
      status: "candidate",
      reason: "not_uploaded",
      visibility: "private",
      readable: true,
    },
  ],
});
const evidence = () => ({
  schemaVersion: 1,
  source: "cloudflare-account-aggregate",
  targetAccount: "test-account",
  accountMatch: true,
  completeCoverage: true,
  plan: "free",
  storageClass: "Standard",
  storedBytes: 0,
  observedAt: new Date(now).toISOString(),
  billingPeriod: "2026-10",
  classAOperations: 0,
  classBOperations: 0,
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cf-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf03"), { mode: 0o700 });
  return root;
}

test("public catalog reconstructs every level from white lists and recomputes totals", () => {
  const book = base();
  book.object_key = "private-object";
  book.files[0].path = "/private/source";
  const catalog = publicCatalog(
    {
      books: [book],
      root: "/private/source",
      stats: { totalBytes: 999 },
      secret: "private-value",
    },
    { now: new Date(now) },
  );
  assert.deepEqual(Object.keys(catalog), [
    "schemaVersion",
    "generatedAt",
    "sourceStatus",
    "thresholdBytes",
    "stats",
    "categories",
    "books",
  ]);
  assert.equal(catalog.stats.totalBytes, 4);
  assert.equal(catalog.stats.candidateFiles, 1);
  assert.deepEqual(catalog.categories, [
    { id: "cat_1", name: "Books", count: 1 },
  ]);
  assert.ok(!JSON.stringify(catalog).includes("private" + "-object"));
  assert.ok(!JSON.stringify(catalog).includes("/private/source"));
  assert.throws(() => publicCatalog({ books: [book, book] }), {
    code: "duplicate_book_id",
  });
});

test("public strings reject private paths and secrets after field filtering", () => {
  const book = base();
  book.description = "From /Users/private/Library/book";
  assert.throws(() => publicCatalog({ books: [book] }), {
    code: "public_privacy_rejected",
  });
  book.description = "test-secret-with-length";
  assert.throws(
    () => publicCatalog({ books: [book] }, { secrets: [book.description] }),
    { code: "public_privacy_rejected" },
  );
  assert.throws(() => metadataPatch({ files: [] }), {
    code: "invalid_metadata",
  });
  assert.throws(() => metadataPatch({ tags: ["\u0001"] }), {
    code: "invalid_metadata",
  });
  assert.deepEqual(
    metadataPatch({ author: " ", title: " Title ", tags: ["one", "one"] }),
    { author: null, title: "Title", tags: ["one"] },
  );
});

test("account aggregate evidence fails closed on scope, coverage, freshness, plan and operation gaps", () => {
  assert.equal(
    accountEvidence(evidence(), "test-account", now).observedBytes,
    0,
  );
  const failures = [
    [{ source: "project-bucket-list" }, "account_storage_unknown"],
    [{ targetAccount: "another" }, "account_storage_unknown"],
    [{ completeCoverage: false }, "account_storage_unknown"],
    [{ accountMatch: false }, "account_storage_unknown"],
    [{ plan: "paid" }, "account_storage_unknown"],
    [{ storageClass: "InfrequentAccess" }, "account_storage_unknown"],
    [
      { observedAt: new Date(now - 300_001).toISOString() },
      "account_storage_stale",
    ],
    [
      { observedAt: new Date(now + 30_001).toISOString() },
      "account_storage_stale",
    ],
    [{ classAOperations: 800_000 }, "account_operations_exceeded"],
    [{ billingPeriod: "2026-09" }, "account_storage_unknown"],
    [{ storedBytes: -1 }, "account_storage_unknown"],
  ];
  for (const [patch, code] of failures)
    assert.throws(
      () => accountEvidence({ ...evidence(), ...patch }, "test-account", now),
      { code },
    );
  assert.throws(
    () => accountEvidence({ SHELF_R2_EXISTING_BYTES: 0 }, "test-account", now),
    { code: "account_storage_unknown" },
  );
});

test("private files enforce repo-local location, 0600, private parents and symlink rejection", async (t) => {
  const root = await fixture(t),
    file = path.join(root, ".local/cf03/evidence.json");
  await writePrivateJson(file, evidence(), root);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readPrivateJson(file, root), evidence());
  await fs.chmod(file, 0o644);
  await assert.rejects(readPrivateJson(file, root), {
    code: "unsafe_private_file",
  });
  await fs.chmod(file, 0o600);
  const link = path.join(root, ".local/cf03/link.json");
  await fs.symlink(file, link);
  await assert.rejects(readPrivateJson(link, root), {
    code: "unsafe_private_file",
  });
  await assert.rejects(readPrivateJson(path.join(root, "outside.json"), root), {
    code: "private_path_required",
  });
  await fs.chmod(path.join(root, ".local/cf03"), 0o755);
  await assert.rejects(readPrivateJson(file, root), {
    code: "unsafe_private_directory",
  });
});

test("single-file selection hashes only explicit candidate and preserves nanosecond timestamps", async (t) => {
  const root = await fixture(t),
    source = path.join(root, "source");
  await fs.mkdir(source);
  const file = path.join(source, "book.epub");
  await fs.writeFile(file, "book");
  const stat = await fs.stat(file, { bigint: true });
  const manifest = {
    root: source,
    files: {
      file_1: {
        bookId: "book_1",
        format: "EPUB",
        path: file,
        sizeBytes: 4,
        mtimeNs: String(stat.mtimeNs),
        eligibility: "candidate",
      },
    },
  };
  const selected = await selectedFile(manifest, "file_1");
  assert.equal(
    selected.sha256,
    createHash("sha256").update("book").digest("hex"),
  );
  assert.match(selected.objectKey, /^books\/cf03\/file_1\/[a-f0-9]{64}\.epub$/);
  assert.ok(BigInt(manifest.files.file_1.mtimeNs) > 2n ** 53n);
  manifest.files.file_1.mtimeNs = String(BigInt(stat.mtimeNs) - 1n);
  await assert.rejects(selectedFile(manifest, "file_1"), {
    code: "file_changed",
  });
  manifest.files.file_1.mtimeNs = String(stat.mtimeNs);
  manifest.files.file_1.sizeBytes = 20_000_001;
  await assert.rejects(selectedFile(manifest, "file_1"), {
    code: "file_ineligible",
  });
  manifest.files.file_1.sizeBytes = 4;
  const outside = path.join(root, "outside.epub");
  await fs.writeFile(outside, "book");
  manifest.files.file_1.path = outside;
  await assert.rejects(selectedFile(manifest, "file_1"), {
    code: "file_outside_root",
  });
});

async function sqlFixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    await fs.readFile(
      new URL("../cloudflare/library/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  t.after(() => sqlite.close());
  return {
    sqlite,
    verify: async () => {},
    query: async (sql, params = []) =>
      sqlite
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row })),
  };
}
async function sourceFixture(t) {
  const root = await fixture(t),
    source = path.join(root, "source");
  await fs.mkdir(source);
  const manifest = { root: source, files: {} },
    books = [];
  for (let i = 1; i <= 2; i++) {
    const format = i === 1 ? "EPUB" : "PDF",
      filename = path.join(source, `book${i}.${format.toLowerCase()}`);
    await fs.writeFile(filename, "book");
    const stat = await fs.stat(filename, { bigint: true });
    manifest.files[`file_${i}`] = {
      bookId: `book_${i}`,
      format,
      path: filename,
      sizeBytes: 4,
      mtimeNs: String(stat.mtimeNs),
      eligibility: "candidate",
    };
    const b = base();
    b.id = `book_${i}`;
    b.files[0].id = `file_${i}`;
    b.files[0].format = format;
    books.push(b);
  }
  return { root, manifest, catalog: { books } };
}
// Synthetic historical rows exercise the retained SQL contract without reopening a production write API.
async function legacySqlReservation(
  db,
  scope,
  accountId,
  file,
  observation,
  at,
) {
  const proof = accountEvidence(observation, accountId, at);
  await db.query(
    "INSERT INTO storage_state(id,account_id,observed_account_bytes,observed_at,ceiling_bytes,reserved_bytes,committed_bytes,evidence_hash,evidence_complete,updated_at) VALUES (1,?,?,?,8000000000,0,0,?,1,?) ON CONFLICT(id) DO NOTHING",
    [
      accountId,
      proof.observedBytes,
      proof.observedAt,
      proof.evidenceSha256,
      at,
    ],
  );
  const id = `historical-${scope}-${file.fileId}`;
  await db.query(
    "INSERT INTO upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'reserved',?,?)",
    [
      id,
      scope,
      file.fileId,
      file.bookId,
      file.objectKey,
      file.sizeBytes,
      file.format,
      file.sha256,
      at,
      at,
    ],
  );
  return id;
}

test("bootstrap reimports bases without resetting cloud overrides or registering private files", async (t) => {
  const db = await sqlFixture(t);
  const overrides = {
    schemaVersion: 1,
    books: {
      book_1: { title: "Manual", categoryId: "ignored", path: "never copied" },
    },
  };
  const initial = await bootstrap(
    db,
    "production",
    { books: [base()] },
    overrides,
    now,
  );
  assert.equal(initial.seededOverrides, 1);
  await db.query(
    "UPDATE metadata_overrides SET patch_json=?,version=2 WHERE scope='production' AND book_id='book_1'",
    [JSON.stringify({ title: "Cloud edit" })],
  );
  const book = base();
  book.description = "New base";
  const again = await bootstrap(
    db,
    "production",
    { books: [book] },
    overrides,
    now,
  );
  assert.equal(again.preservedOverrides, 1);
  const [saved] = await db.query(
    "SELECT patch_json,version FROM metadata_overrides WHERE scope='production'",
  );
  assert.deepEqual(JSON.parse(saved.patch_json), { title: "Cloud edit" });
  assert.equal(saved.version, 2);
  assert.equal((await db.query("SELECT * FROM file_registry")).length, 0);
  assert.equal(
    (await snapshot(db, "production", { now })).catalog.books[0].title,
    "Cloud edit",
  );
});

test("bootstrap rejects private override values before writing and exports derived category IDs consistently", async (t) => {
  const db = await sqlFixture(t);
  await assert.rejects(
    bootstrap(
      db,
      "production",
      { books: [base()] },
      {
        schemaVersion: 1,
        books: { book_1: { description: "From /Users/test/source/book" } },
      },
      now,
    ),
    { code: "public_privacy_rejected" },
  );
  assert.equal((await db.query("SELECT * FROM catalog_books")).length, 0);
  await bootstrap(
    db,
    "production",
    { books: [base()] },
    { schemaVersion: 1, books: { book_1: { category: "New shelf" } } },
    now,
  );
  const [saved] = await db.query(
    "SELECT patch_json FROM metadata_overrides WHERE scope='production'",
  );
  const patch = JSON.parse(saved.patch_json);
  assert.match(patch.categoryId, /^cat-[a-f0-9]{12}$/);
  assert.equal(
    (await snapshot(db, "production", { now })).catalog.books[0].categoryId,
    patch.categoryId,
  );
});

test("unknown shared account produces an exact dry plan with no reservation", async (t) => {
  const { manifest } = await sourceFixture(t);
  const plan = await makeFilePlan(
    manifest,
    "file_1",
    undefined,
    "test-account",
    { now },
  );
  assert.equal(plan.blockedReason, "account_storage_unknown");
  assert.equal(plan.uploadAllowed, false);
  assert.equal(plan.budget.accountObservedBytes, null);
  assert.equal(plan.budget.committedBytes, null);
  assert.equal(plan.budget.reservedBytes, null);
  assert.equal(plan.budget.projectedBytes, null);
  assert.equal(plan.budget.admissionFormula, STORAGE_ADMISSION);
  assert.equal(plan.budget.overlapDeductedBytes, 0);
  assert.match(plan.file.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!("data" in plan.file));
  const check = await makeFilePlan(
    manifest,
    "file_2",
    evidence(),
    "test-account",
    { now, scope: "check" },
  );
  assert.match(check.file.objectKey, /^cf03-check\//);
});

test("D1 reservation trigger admits only one competing file and does not erase pending bytes", async (t) => {
  const db = await sqlFixture(t),
    { manifest, catalog } = await sourceFixture(t);
  await bootstrap(db, "production", catalog, undefined, now);
  const first = await selectedFile(manifest, "file_1"),
    second = await selectedFile(manifest, "file_2");
  const nearlyFull = { ...evidence(), storedBytes: 7_999_999_996 };
  const results = await Promise.allSettled([
    legacySqlReservation(
      db,
      "production",
      "test-account",
      first,
      nearlyFull,
      now,
    ),
    legacySqlReservation(
      db,
      "production",
      "test-account",
      second,
      nearlyFull,
      now,
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (await db.query("SELECT reserved_bytes FROM storage_state"))[0]
      .reserved_bytes,
    4,
  );
  await assert.rejects(
    reserve(db, "production", "test-account", second, nearlyFull, now),
    { code: "legacy_storage_migration_required" },
  );
  assert.equal(
    (await db.query("SELECT reserved_bytes FROM storage_state"))[0]
      .reserved_bytes,
    4,
  );
});

test("twenty reservation transactions compete for the final four bytes without partial budget changes", async (t) => {
  const db = await sqlFixture(t),
    { manifest } = await sourceFixture(t);
  const file = await selectedFile(manifest, "file_1");
  const book = base();
  book.files = Array.from({ length: 20 }, (_, i) => ({
    ...book.files[0],
    id: `file_${i + 1}`,
  }));
  await bootstrap(db, "production", { books: [book] }, undefined, now);
  const candidates = book.files.map((f) => ({
    ...file,
    fileId: f.id,
    objectKey: `books/cf03/${f.id}/${file.sha256}.epub`,
  }));
  const results = await Promise.allSettled(
    candidates.map((f) =>
      legacySqlReservation(
        db,
        "production",
        "test-account",
        f,
        { ...evidence(), storedBytes: 7_999_999_996 },
        now,
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await db.query("SELECT * FROM upload_reservations")).length, 1);
  assert.equal(
    (await db.query("SELECT reserved_bytes FROM storage_state"))[0]
      .reserved_bytes,
    4,
  );
});

test("legacy reserve/upload/reconcile reject valid inputs without filesystem, database or R2 effects", async (t) => {
  const { root, manifest, catalog } = await sourceFixture(t);
  const db = await sqlFixture(t);
  await bootstrap(db, "production", catalog, undefined, now);
  const file = await selectedFile(manifest, "file_1");
  for (const [i, state] of [
    "reserved",
    "uploading",
    "uncertain",
    "confirmed",
  ].entries()) {
    const historical = {
      ...file,
      fileId: `historical_${i}`,
      objectKey: `books/cf03/historical_${i}/${file.sha256}.epub`,
    };
    await legacySqlReservation(
      db,
      "production",
      "test-account",
      historical,
      evidence(),
      now,
    );
    if (state !== "reserved")
      await db.query(
        "UPDATE upload_reservations SET state=?,content_verified=?,etag=? WHERE file_id=?",
        [
          state,
          state === "confirmed" ? 1 : 0,
          state === "confirmed" ? '"historic"' : null,
          historical.fileId,
        ],
      );
  }
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const beforeFiles = await Promise.all(
    [manifestPath, ...Object.values(manifest.files).map((f) => f.path)].map(
      (f) => fs.readFile(f),
    ),
  );
  const tables = ["storage_state", "upload_reservations", "file_registry"];
  const beforeLedger = await Promise.all(
    tables.map((table) => db.query(`SELECT * FROM ${table}`)),
  );
  let queries = 0,
    r2Calls = 0,
    persistence = 0,
    fsCalls = 0;
  const blockedDb = {
    query() {
      queries++;
      throw Error("must not query");
    },
  };
  const r2 = new Proxy(
    {},
    {
      get() {
        r2Calls++;
        throw Error("must not touch R2");
      },
    },
  );
  const originals = new Map();
  for (const key of Object.keys(fs))
    if (typeof fs[key] === "function") {
      originals.set(key, fs[key]);
      fs[key] = () => {
        fsCalls++;
        throw Error("must not use filesystem");
      };
    }
  try {
    await assert.rejects(
      reserve(blockedDb, "production", "test-account", file, evidence(), now),
      { code: "legacy_storage_migration_required" },
    );
    await assert.rejects(
      uploadOne(
        blockedDb,
        "production",
        "test-account",
        manifest,
        "file_1",
        evidence(),
        r2,
        {
          now,
          persist() {
            persistence++;
          },
        },
      ),
      { code: "legacy_storage_migration_required" },
    );
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        reconcile(blockedDb, "production", `historical_${i}`, r2, { now }),
        { code: "legacy_storage_migration_required" },
      );
    }
    for (const action of ["upload", "reconcile"]) {
      await assert.rejects(
        runLibrary(
          [action, "--profile", "production", "--file", "file_1", "--execute"],
          {
            root,
            environment: {},
            dbFactory() {
              queries++;
            },
            r2Factory() {
              r2Calls++;
            },
          },
        ),
        { code: "legacy_storage_migration_required" },
      );
    }
  } finally {
    for (const [key, original] of originals) fs[key] = original;
  }
  assert.deepEqual(
    { queries, r2Calls, persistence, fsCalls },
    { queries: 0, r2Calls: 0, persistence: 0, fsCalls: 0 },
  );
  assert.deepEqual(
    await Promise.all(
      [manifestPath, ...Object.values(manifest.files).map((f) => f.path)].map(
        (f) => fs.readFile(f),
      ),
    ),
    beforeFiles,
  );
  assert.deepEqual(
    await Promise.all(
      tables.map((table) => db.query(`SELECT * FROM ${table}`)),
    ),
    beforeLedger,
  );
});

test("snapshot retries revision changes, aborts persistent churn and preserves identical output mtime", async (t) => {
  const db = await sqlFixture(t),
    root = await fixture(t);
  await bootstrap(db, "production", { books: [base()] }, undefined, now);
  let changes = 0;
  const changing = {
    query: async (sql, params) => {
      const rows = await db.query(sql, params);
      if (sql.startsWith("SELECT b.book_id") && changes++ < 1)
        await db.query(
          "UPDATE public_state SET revision=revision+1 WHERE scope='production'",
        );
      return rows;
    },
  };
  const result = await snapshot(changing, "production", { now, pageSize: 1 });
  assert.equal(result.catalog.books.length, 1);
  assert.ok(changes > 1);
  const churn = {
    query: async (sql, params) => {
      const rows = await db.query(sql, params);
      if (sql.startsWith("SELECT b.book_id"))
        await db.query(
          "UPDATE public_state SET revision=revision+1 WHERE scope='production'",
        );
      return rows;
    },
  };
  await assert.rejects(snapshot(churn, "production", { now }), {
    code: "snapshot_revision_changed",
  });
  await fs.mkdir(path.join(root, "data"));
  assert.equal((await saveSnapshot(result, root)).changed, true);
  const before = await fs.stat(path.join(root, "data/catalog.json"), {
    bigint: true,
  });
  result.catalog.generatedAt = new Date(now + 60_000).toISOString();
  assert.equal((await saveSnapshot(result, root)).changed, false);
  assert.equal(
    (await fs.stat(path.join(root, "data/catalog.json"), { bigint: true }))
      .mtimeNs,
    before.mtimeNs,
  );
});

test("legacy R2 PUT rejects before fetch while isolated read signing remains available", async () => {
  const calls = [],
    digest = "a".repeat(64);
  const client = r2Client(
    {
      accountId: "a".repeat(32),
      bucket: "the-shelf-books",
      accessKey: "test-key",
      secretKey: "test-secret",
    },
    "check",
    {
      clock: () => new Date(now),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": "4",
            "x-amz-meta-sha256": digest,
            etag: '"test"',
          },
        });
      },
    },
  );
  await assert.rejects(
    client.put(`cf03-check/file_1/${digest}.epub`, Buffer.from("book"), {
      sha256: digest,
      format: "EPUB",
    }),
    { code: "legacy_storage_migration_required" },
  );
  const poison = new Proxy(
    {},
    {
      get() {
        throw Error("must not read upload input");
      },
    },
  );
  await assert.rejects(client.put(poison, poison, poison), {
    code: "legacy_storage_migration_required",
  });
  assert.equal(calls.length, 0);
  await client.head(`cf03-check/file_1/${digest}.epub`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "HEAD");
  assert.equal(calls[0].options.redirect, "error");
  assert.match(calls[0].options.headers.authorization, /SignedHeaders=/);
  await assert.rejects(client.head(`books/cf03/file_1/${digest}.epub`), {
    code: "invalid_storage_key",
  });
  assert.equal(calls.length, 1);
});

test("D1 adapter verifies exact allowlisted database identity and never retries uncertain writes", async () => {
  const resource = {
    databaseId: "11111111-1111-1111-1111-111111111111",
    databaseName: "the-shelf-library",
  };
  let requests = 0;
  const db = d1Client(
    { accountId: "a".repeat(32), token: "fake-token" },
    resource,
    {
      fetchImpl: async (_, options) => {
        requests++;
        if (options.method === "POST") throw Error("lost response");
        return Response.json({
          success: true,
          result: { uuid: resource.databaseId, name: resource.databaseName },
        });
      },
    },
  );
  await assert.rejects(db.query("SELECT 1"), {
    code: "database_identity_unverified",
  });
  await db.verify();
  await assert.rejects(db.query("INSERT INTO test VALUES (?)", [1]), {
    code: "d1_outcome_unknown",
  });
  assert.equal(requests, 2);
});

test("CLI parses explicit profile/single file and dry runs without creating network clients", async (t) => {
  assert.equal(
    parseArguments([
      "upload",
      "--profile",
      "production",
      "--file",
      "file_1",
      "--execute",
    ]).execute,
    true,
  );
  assert.throws(() => parseArguments(["upload", "--file", "file_1"]), {
    code: "profile_required",
  });
  assert.throws(
    () =>
      parseArguments([
        "upload",
        "--profile",
        "production",
        "--file",
        "file_1",
        "file_2",
      ]),
    { code: "usage" },
  );
  const { root, manifest } = await sourceFixture(t);
  await fs.writeFile(
    path.join(root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${"a".repeat(32)}\nSHELF_R2_BUCKET=the-shelf-books\n`,
    { mode: 0o600 },
  );
  await writePrivateJson(
    path.join(root, ".local/manifest.json"),
    manifest,
    root,
  );
  await writePrivateJson(
    path.join(root, ".local/cf03/deploy.json"),
    {
      schemaVersion: 1,
      profiles: {
        production: {
          databaseId: "11111111-1111-1111-1111-111111111111",
          databaseName: "the-shelf-library",
        },
        check: {
          databaseId: "22222222-2222-2222-2222-222222222222",
          databaseName: "the-shelf-cf03-check",
        },
      },
    },
    root,
  );
  const never = () => {
    throw Error("dry run must not create client");
  };
  const result = await runLibrary(
    ["plan", "--profile", "production", "--file", "file_1"],
    {
      root,
      environment: { SHELF_CF_DEPLOY_TOKEN: "fake-token-only-for-tests" },
      dbFactory: never,
      r2Factory: never,
      now,
    },
  );
  assert.equal(result.blockedReason, "account_storage_unknown");
  const plan = await readPrivateJson(path.join(root, result.privatePlan), root);
  assert.equal(plan.file.fileId, "file_1");
  assert.match(plan.file.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    runLibrary(
      ["upload", "--profile", "production", "--file", "file_1", "--execute"],
      {
        root,
        environment: { SHELF_CF_DEPLOY_TOKEN: "fake-token-only-for-tests" },
        dbFactory: never,
        r2Factory: never,
        now,
      },
    ),
    { code: "legacy_storage_migration_required" },
  );
});

const booksBatch = (title) => ({
  books: Array.from({ length: 31 }, (_, i) => {
    const id = String(i + 1).padStart(3, "0"),
      book = base();
    book.id = `book_${id}`;
    book.title = `${title}-${id}`;
    book.files[0].id = `file_${id}`;
    return book;
  }),
});

test("interrupted staged import blocks snapshots and other inputs until explicit same-input resume fences the old writer", async (t) => {
  const db = await sqlFixture(t),
    old = booksBatch("Old"),
    next = booksBatch("Next");
  await bootstrap(db, "production", old, undefined, now);
  const [previousState] = await db.query(
    "SELECT revision,base_revision FROM public_state WHERE scope='production'",
  );
  const interrupted = {
    query: async (sql, params) => {
      const rows = await db.query(sql, params);
      if (sql.startsWith("INSERT INTO catalog_import_rows"))
        throw Error("synthetic interruption after first staged batch");
      return rows;
    },
  };
  await assert.rejects(
    bootstrap(interrupted, "production", next, undefined, now),
  );
  const [lease] = await db.query(
    "SELECT * FROM catalog_imports WHERE scope='production'",
  );
  assert.equal(lease.state, "active");
  await assert.rejects(
    db.query(
      "UPDATE catalog_imports SET state='complete' WHERE scope=? AND owner_token=? RETURNING scope",
      ["production", lease.owner_token],
    ),
    /library_import_incomplete/,
  );
  assert.equal(
    (await db.query("SELECT * FROM catalog_import_rows")).length,
    15,
  );
  assert.ok(
    (await db.query("SELECT public_json FROM catalog_books")).every((r) =>
      JSON.parse(r.public_json).title.startsWith("Old-"),
    ),
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT revision,base_revision FROM public_state WHERE scope='production'",
      )
    )[0],
    previousState,
  );
  await assert.rejects(snapshot(db, "production"), {
    code: "catalog_import_incomplete",
  });
  await assert.rejects(
    bootstrap(db, "production", booksBatch("Other"), undefined, now),
    { code: "catalog_import_active" },
  );
  await assert.rejects(
    bootstrap(db, "production", booksBatch("Other"), undefined, now, {
      resume: true,
    }),
    { code: "catalog_import_resume_mismatch" },
  );
  await assert.rejects(bootstrap(db, "production", next, undefined, now), {
    code: "catalog_import_active",
  });
  const [staged] = await db.query("SELECT * FROM catalog_import_rows LIMIT 1");
  let fenced = false;
  const resumed = {
    query: async (sql, params) => {
      if (!fenced && sql.startsWith("INSERT INTO catalog_import_rows")) {
        fenced = true;
        await assert.rejects(
          db.query(
            "INSERT INTO catalog_import_rows(scope,input_hash,book_id,public_json,patch_json,writer_token) VALUES (?,?,?,?,?,?) ON CONFLICT(scope,book_id) DO UPDATE SET writer_token=excluded.writer_token",
            [
              staged.scope,
              staged.input_hash,
              staged.book_id,
              staged.public_json,
              staged.patch_json,
              lease.owner_token,
            ],
          ),
          /library_import_fenced/,
        );
        assert.equal(
          (
            await db.query(
              "UPDATE catalog_imports SET state='complete' WHERE scope=? AND owner_token=? AND state='active' RETURNING scope",
              ["production", lease.owner_token],
            )
          ).length,
          0,
        );
      }
      return db.query(sql, params);
    },
  };
  const result = await bootstrap(resumed, "production", next, undefined, now, {
    resume: true,
  });
  assert.ok(fenced);
  assert.equal(result.baseRevisionKind, "input-books-sha256");
  assert.ok(
    (await snapshot(db, "production")).catalog.books.every((b) =>
      b.title.startsWith("Next-"),
    ),
  );
  assert.equal(
    (
      await db.query(
        "SELECT base_revision FROM public_state WHERE scope='production'",
      )
    )[0].base_revision,
    result.baseRevision,
  );
});

test("failed atomic import publication rolls back live rows, overrides and revision while retaining resumable staging", async (t) => {
  const db = await sqlFixture(t),
    old = booksBatch("Old"),
    next = booksBatch("Next");
  await bootstrap(
    db,
    "production",
    old,
    { schemaVersion: 1, books: { book_001: { title: "Manual" } } },
    now,
  );
  await db.query(
    "INSERT INTO file_registry(scope,file_id,book_id,format,size_bytes,object_key,sha256,etag,state,version,updated_at) VALUES ('production','file_001','book_001','EPUB',4,?,?,'test-etag','confirmed',1,?)",
    [`books/cf03/file_001/${"a".repeat(64)}.epub`, "a".repeat(64), now],
  );
  const before = await db.query(
    "SELECT * FROM public_state WHERE scope='production'",
  );
  db.sqlite.exec(
    "CREATE TRIGGER synthetic_publish_failure BEFORE UPDATE ON catalog_books WHEN NEW.book_id='book_016' AND json_extract(NEW.public_json,'$.title')='Next-016' BEGIN SELECT RAISE(ABORT,'synthetic_publish_failure'); END;",
  );
  await assert.rejects(
    bootstrap(
      db,
      "production",
      next,
      { schemaVersion: 1, books: { book_002: { description: "New seed" } } },
      now,
    ),
    /synthetic_publish_failure/,
  );
  assert.deepEqual(
    await db.query("SELECT * FROM public_state WHERE scope='production'"),
    before,
  );
  assert.ok(
    (await db.query("SELECT public_json FROM catalog_books")).every((r) =>
      JSON.parse(r.public_json).title.startsWith("Old-"),
    ),
  );
  assert.equal((await db.query("SELECT * FROM metadata_overrides")).length, 1);
  assert.equal((await db.query("SELECT * FROM file_registry")).length, 1);
  assert.equal(
    (await db.query("SELECT state FROM catalog_imports"))[0].state,
    "active",
  );
  await assert.rejects(snapshot(db, "production"), {
    code: "catalog_import_incomplete",
  });
  db.sqlite.exec("DROP TRIGGER synthetic_publish_failure");
  await bootstrap(
    db,
    "production",
    next,
    { schemaVersion: 1, books: { book_002: { description: "New seed" } } },
    now,
    { resume: true },
  );
  // A subset means an input hash, and never removes books, overrides or registry.
  const subset = await bootstrap(
    db,
    "production",
    { books: [next.books[0]] },
    undefined,
    now,
  );
  assert.equal(subset.baseRevisionKind, "input-books-sha256");
  assert.equal((await db.query("SELECT * FROM catalog_books")).length, 31);
  assert.equal((await db.query("SELECT * FROM metadata_overrides")).length, 2);
  assert.equal((await db.query("SELECT * FROM file_registry")).length, 1);
});

test("snapshot retries an import committed between pages and fails closed if staging remains active", async (t) => {
  const db = await sqlFixture(t),
    old = booksBatch("Old"),
    next = booksBatch("Next");
  await bootstrap(db, "production", old, undefined, now);
  let published = false;
  const switching = {
    query: async (sql, params) => {
      const rows = await db.query(sql, params);
      if (!published && sql.startsWith("SELECT b.book_id")) {
        published = true;
        await bootstrap(db, "production", next, undefined, now);
      }
      return rows;
    },
  };
  assert.ok(
    (
      await snapshot(switching, "production", { pageSize: 10 })
    ).catalog.books.every((b) => b.title.startsWith("Next-")),
  );
  let started = false;
  const pendingImport = {
    query: async (sql, params) => {
      const rows = await db.query(sql, params);
      if (!started && sql.startsWith("SELECT b.book_id")) {
        started = true;
        await assert.rejects(
          bootstrap(
            {
              query: async (statement, bindings) => {
                const result = await db.query(statement, bindings);
                if (statement.startsWith("INSERT INTO catalog_import_rows"))
                  throw Error("stop");
                return result;
              },
            },
            "production",
            old,
            undefined,
            now,
          ),
        );
      }
      return rows;
    },
  };
  await assert.rejects(
    snapshot(pendingImport, "production", { pageSize: 10 }),
    { code: "catalog_import_incomplete" },
  );
});

async function cliFixture(t) {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "data"));
  const catalog = publicCatalog({ books: [base()] }, { now: new Date(now) });
  await fs.writeFile(
    path.join(root, "data/catalog.json"),
    JSON.stringify(catalog) + "\n",
  );
  await fs.writeFile(
    path.join(root, ".env"),
    `SHELF_R2_ACCOUNT_ID=${"a".repeat(32)}\nSHELF_R2_BUCKET=the-shelf-books\n`,
    { mode: 0o600 },
  );
  await writePrivateJson(
    path.join(root, ".local/cf03/deploy.json"),
    {
      schemaVersion: 1,
      profiles: {
        production: {
          databaseId: "11111111-1111-1111-1111-111111111111",
          databaseName: "the-shelf-library",
        },
        check: {
          databaseId: "22222222-2222-2222-2222-222222222222",
          databaseName: "the-shelf-cf03-check",
        },
      },
    },
    root,
  );
  const secrets = [];
  for (const profile of ["check", "production"]) {
    await fs.mkdir(path.join(root, `.local/cf03/${profile}`), { mode: 0o700 });
    for (const name of [
      "owner-access-key",
      "owner-key-pepper",
      "session-secret",
    ]) {
      const value = Buffer.alloc(32, secrets.length + 1).toString("base64url");
      secrets.push(value);
      await fs.writeFile(
        path.join(root, `.local/cf03/${profile}/${name}`),
        value + "\n",
        { mode: 0o600 },
      );
    }
  }
  return { root, secrets };
}

test("all six private-file-only keys block bootstrap and snapshot publication without changing the old catalog", async (t) => {
  const { root, secrets } = await cliFixture(t),
    db = await sqlFixture(t);
  const output = path.join(root, "data/catalog.json"),
    previous = await fs.readFile(output, "utf8"),
    stat = await fs.stat(output, { bigint: true });
  const environment = { SHELF_CF_DEPLOY_TOKEN: "fake-token-only-for-tests" };
  for (const secret of secrets) {
    await writePrivateJson(
      path.join(root, ".local/overrides.json"),
      { schemaVersion: 1, books: { book_1: { description: secret } } },
      root,
    );
    await assert.rejects(
      runLibrary(["bootstrap", "--profile", "production", "--execute"], {
        root,
        environment,
        dbFactory: () =>
          assert.fail("private override must reject before connection"),
        now,
      }),
      { code: "public_privacy_rejected" },
    );
    const book = base();
    book.description = secret;
    await bootstrap(db, "production", { books: [book] }, undefined, now);
    await assert.rejects(
      runLibrary(["snapshot", "--profile", "production", "--execute"], {
        root,
        environment,
        dbFactory: () => db,
        now,
      }),
      { code: "public_privacy_rejected" },
    );
    assert.equal(await fs.readFile(output, "utf8"), previous);
    assert.equal(
      (await fs.stat(output, { bigint: true })).mtimeNs,
      stat.mtimeNs,
    );
  }
});

test("snapshot passes complete confirmed descriptors and never republishes stale uploaded claims", async (t) => {
  const db = await sqlFixture(t),
    book = base();
  book.files[0].reason = "uploaded";
  await bootstrap(db, "production", { books: [book] }, undefined, now);
  assert.equal(
    (await snapshot(db, "production")).catalog.books[0].files[0].reason,
    "not_uploaded",
  );
  await db.query(
    "INSERT INTO file_registry(scope,file_id,book_id,format,size_bytes,object_key,sha256,etag,state,version,updated_at) VALUES ('production','file_1','book_1','EPUB',4,?,?,'test-etag','confirmed',1,?)",
    [`books/cf03/file_1/${"a".repeat(64)}.epub`, "a".repeat(64), now],
  );
  assert.equal(
    (await snapshot(db, "production")).catalog.books[0].files[0].reason,
    "uploaded",
  );
  await db.query(
    "UPDATE file_registry SET size_bytes=3 WHERE scope='production' AND file_id='file_1'",
  );
  assert.equal(
    (await snapshot(db, "production")).catalog.books[0].files[0].reason,
    "not_uploaded",
  );
  await db.query(
    "UPDATE file_registry SET size_bytes=4,state='disabled' WHERE scope='production' AND file_id='file_1'",
  );
  assert.equal(
    (await snapshot(db, "production")).catalog.books[0].files[0].reason,
    "not_uploaded",
  );
});

async function laggedMetricBoundary(t) {
  const db = await sqlFixture(t),
    { manifest, catalog } = await sourceFixture(t);
  for (const book of catalog.books) {
    const entry = manifest.files[book.files[0].id];
    await fs.writeFile(entry.path, Buffer.alloc(100, "x"));
    const stat = await fs.stat(entry.path, { bigint: true });
    entry.sizeBytes = book.files[0].sizeBytes = 100;
    entry.mtimeNs = String(stat.mtimeNs);
  }
  await bootstrap(db, "production", catalog, undefined, now);
  const oldEvidence = { ...evidence(), storedBytes: 100 };
  const observation = accountEvidence(oldEvidence, "test-account", now);
  await db.query(
    "INSERT INTO storage_state(id,account_id,observed_account_bytes,observed_at,ceiling_bytes,reserved_bytes,committed_bytes,evidence_hash,evidence_complete,updated_at) VALUES (1,?,100,?,250,0,0,?,1,?)",
    ["test-account", now, observation.evidenceSha256, now],
  );
  const first = await selectedFile(manifest, "file_1"),
    second = await selectedFile(manifest, "file_2");
  await legacySqlReservation(
    db,
    "production",
    "test-account",
    first,
    oldEvidence,
    now,
  );
  await db.query(
    "UPDATE upload_reservations SET state='confirmed',content_verified=1,etag='historical-etag' WHERE file_id='file_1'",
  );
  return {
    db,
    manifest,
    second,
    freshButLaggedEvidence: {
      ...oldEvidence,
      observedAt: new Date(now + 1).toISOString(),
    },
  };
}

test("other usage plus a recent confirmed upload stays additive even when fresh account metrics lag", async (t) => {
  const { db, manifest, second, freshButLaggedEvidence } =
    await laggedMetricBoundary(t);
  assert.deepEqual(conservativeStorageBudget(100, 0, 0, 100, 250), {
    projectedBytes: 200,
    admitted: true,
  });
  assert.deepEqual(conservativeStorageBudget(100, 100, 0, 100, 250), {
    projectedBytes: 300,
    admitted: false,
  });
  assert.deepEqual(
    (
      await db.query(
        "SELECT observed_account_bytes,committed_bytes,reserved_bytes FROM storage_state",
      )
    )[0],
    { observed_account_bytes: 100, committed_bytes: 100, reserved_bytes: 0 },
  );
  const plan = await makeFilePlan(
    manifest,
    "file_2",
    freshButLaggedEvidence,
    "test-account",
    {
      now: now + 1,
      budgetState: { committedBytes: 100, reservedBytes: 0, ceilingBytes: 250 },
    },
  );
  assert.equal(plan.blockedReason, "storage_budget_exceeded");
  assert.equal(plan.budget.projectedBytes, 300);
  assert.equal(plan.budget.overlapDeductedBytes, 0);
  await assert.rejects(
    legacySqlReservation(
      db,
      "production",
      "test-account",
      second,
      freshButLaggedEvidence,
      now + 1,
    ),
    /library_storage_budget/,
  );
  assert.equal(
    (
      await db.query("SELECT committed_bytes,reserved_bytes FROM storage_state")
    )[0].committed_bytes,
    100,
  );
  assert.equal(
    (
      await db.query("SELECT committed_bytes,reserved_bytes FROM storage_state")
    )[0].reserved_bytes,
    0,
  );
  assert.equal((await db.query("SELECT * FROM upload_reservations")).length, 1);
});

test("002 migration replaces only the old max-budget trigger and preserves ledger before rejecting a second upload", async (t) => {
  const { db, second, freshButLaggedEvidence } = await laggedMetricBoundary(t);
  const [current] = await db.query(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='reserve_upload'",
  );
  const oldTrigger = current.sql.replace(
    "observed_account_bytes+committed_bytes+reserved_bytes+NEW.size_bytes",
    "max(observed_account_bytes,committed_bytes)+reserved_bytes+NEW.size_bytes",
  );
  assert.notEqual(oldTrigger, current.sql);
  db.sqlite.exec(`BEGIN; DROP TRIGGER reserve_upload; ${oldTrigger}; COMMIT;`);
  assert.equal(
    (
      await db.query(
        "SELECT max(observed_account_bytes,committed_bytes)+100 AS unsafe_total FROM storage_state",
      )
    )[0].unsafe_total,
    200,
  );
  const tables = [
    "storage_state",
    "upload_reservations",
    "file_registry",
    "catalog_books",
    "metadata_overrides",
  ];
  const before = await Promise.all(
    tables.map((table) => db.query(`SELECT * FROM ${table}`)),
  );
  const [otherTriggerCount] = await db.query(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name<>'reserve_upload'",
  );
  const migration = await fs.readFile(
    new URL(
      "../cloudflare/library/migrations/002-conservative-storage.sql",
      import.meta.url,
    ),
    "utf8",
  );
  db.sqlite.exec(`BEGIN; ${migration} COMMIT;`);
  assert.deepEqual(
    await Promise.all(
      tables.map((table) => db.query(`SELECT * FROM ${table}`)),
    ),
    before,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name<>'reserve_upload'",
      )
    )[0],
    otherTriggerCount,
  );
  assert.equal(
    (
      await db.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='reserve_upload'",
      )
    )[0].sql,
    current.sql,
  );
  await assert.rejects(
    legacySqlReservation(
      db,
      "production",
      "test-account",
      second,
      freshButLaggedEvidence,
      now + 1,
    ),
    /library_storage_budget/,
  );
  // Running the complete migration again is harmless and still retains all data.
  db.sqlite.exec(`BEGIN; ${migration} COMMIT;`);
  assert.deepEqual(
    await db.query("SELECT * FROM upload_reservations"),
    before[1],
  );
});
