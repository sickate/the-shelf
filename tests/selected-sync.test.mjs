import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  runSelectedSync,
  parseSelectedSyncArgs,
} from "../scripts/selected-sync.mjs";
import { RemoteStorageAuthority } from "../server/remote-storage-authority.mjs";
import { bytesSha256 } from "../server/storage-authority.mjs";

const ACCOUNT = "a".repeat(32),
  TOKEN = "synthetic-selected-token";
const ACCESS = "b".repeat(32),
  SECRET = "c".repeat(64);
const IDS = {
  check: "11111111-1111-4111-8111-111111111111",
  production: "22222222-2222-4222-8222-222222222222",
};
const FILE = "file_1234567890abcdef",
  BOOK = "book_1234567890abcdef";
const NAMES = {
  check: "the-shelf-cf03-check",
  production: "the-shelf-library",
};
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: IDS,
};
function evidence() {
  const now = new Date();
  return {
    schemaVersion: 1,
    source: "cloudflare-account-aggregate",
    targetAccount: ACCOUNT,
    accountMatch: true,
    completeCoverage: true,
    plan: "free",
    storageClass: "Standard",
    storedBytes: 0,
    observedAt: now.toISOString(),
    billingPeriod: now.toISOString().slice(0, 7),
    classAOperations: 0,
    classBOperations: 0,
  };
}
async function filesUnder(directory) {
  let items;
  try {
    items = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return (
    await Promise.all(
      items.map(async (item) =>
        item.isDirectory()
          ? filesUnder(path.join(directory, item.name))
          : [path.join(directory, item.name)],
      ),
    )
  ).flat();
}
async function fixture(t, { ready = true } = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-selected-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, ".local/state"),
    manifestPath = path.join(root, ".local/private/manifest.json");
  for (const dir of [
    ".local",
    ".local/state",
    ".local/private",
    ".local/cf03",
    ".local/state/prepared-text",
    `.local/state/prepared-text/${FILE}`,
    "books",
  ])
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  const source = Buffer.from(
    "Synthetic selected source, never real private data.",
  );
  const sourcePath = path.join(root, "books/fixture.pdf");
  await fs.writeFile(sourcePath, source, { mode: 0o600 });
  const sourceStat = await fs.stat(sourcePath, { bigint: true });
  const entry = {
    bookId: BOOK,
    path: sourcePath,
    format: "PDF",
    sizeBytes: source.length,
    mtimeNs: String(sourceStat.mtimeNs),
    eligibility: "candidate",
    visibility: "private",
  };
  const manifest = {
    schemaVersion: 1,
    root: path.join(root, "books"),
    files: { [FILE]: entry },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const envText = `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_R2_BUCKET=the-shelf-books\nSHELF_CF_DEPLOY_TOKEN=${TOKEN}\nSHELF_R2_ACCESS_KEY_ID=${ACCESS}\nSHELF_R2_SECRET_ACCESS_KEY=${SECRET}\nSHELF_MANIFEST_PATH=.local/private/manifest.json\nSHELF_STATE_DIR=.local/state\n`;
  await fs.writeFile(path.join(root, ".env"), envText, { mode: 0o600 });
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: Object.fromEntries(
        Object.entries(IDS).map(([scope, databaseId]) => [
          scope,
          { databaseId, databaseName: NAMES[scope] },
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  const text = "Synthetic prepared text",
    chunks = [
      {
        index: 0,
        locator: { type: "pdf-page", page: 1, start: 0, end: text.length },
        text,
        sha256: bytesSha256(text),
      },
    ];
  const body = {
    schemaVersion: 1,
    kind: "shelf.prepared-text",
    preparation: {
      algorithm: "shelf-text-v1",
      normalization: "LF-NFC-trim-section",
      chunkCodepoints: 6000,
      offsetUnit: "unicode-code-point",
    },
    source: {
      fileId: FILE,
      bookId: BOOK,
      format: "PDF",
      sizeBytes: source.length,
      mtimeNs: entry.mtimeNs,
      fingerprint: { algorithm: "sha256", value: bytesSha256(source) },
    },
    textBytes: Buffer.byteLength(text),
    contentHash: bytesSha256(JSON.stringify(chunks)),
    chunks,
  };
  const versionHash = bytesSha256(JSON.stringify(body));
  // The strict contract requires canonical bytes, including its trailing newline.
  const packageBytes = Buffer.from(
    JSON.stringify({ ...body, versionHash }) + "\n",
  );
  const pin = {
    fileId: FILE,
    bookId: BOOK,
    format: "PDF",
    sizeBytes: source.length,
    mtimeNs: entry.mtimeNs,
    versionHash,
    sourceSha256: bytesSha256(source),
  };
  const packagePath = path.join(
    stateDir,
    `prepared-text/${FILE}/${versionHash}.json`,
  );
  const pinsPath = path.join(stateDir, "prepared-text/pins.json");
  await fs.writeFile(packagePath, packageBytes, { mode: 0o600 });
  await fs.writeFile(
    pinsPath,
    JSON.stringify({ schemaVersion: 1, files: { [FILE]: pin } }) + "\n",
    { mode: 0o600 },
  );
  const dbs = {
    check: new DatabaseSync(":memory:"),
    production: new DatabaseSync(":memory:"),
  };
  t.after(() => {
    for (const db of Object.values(dbs)) db.close();
  });
  const read = (name) =>
    fs.readFile(
      new URL(`../cloudflare/library/${name}`, import.meta.url),
      "utf8",
    );
  for (const db of Object.values(dbs)) {
    db.exec(await read("schema.sql"));
    db.prepare(
      "INSERT INTO catalog_books(scope,book_id,public_json) VALUES('production',?,?)",
    ).run(
      BOOK,
      JSON.stringify({
        id: BOOK,
        files: [
          {
            id: FILE,
            format: "PDF",
            sizeBytes: source.length,
            status: "candidate",
          },
        ],
      }),
    );
  }
  dbs.production.exec(await read("migrations/003-storage-authority.sql"));
  for (const [scope, db] of Object.entries(dbs)) {
    db.exec(await read("migrations/004-freeze-legacy-storage.sql"));
    db.prepare(
      "INSERT INTO shelf_storage_legacy_freeze VALUES(1,?,?,?,?,?)",
    ).run(
      identity.authorityId,
      ACCOUNT,
      identity.bucket,
      `freeze-${scope}`,
      Date.now() - 1000,
    );
  }
  const calls = [],
    objects = new Map();
  let failure = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    if (new URL(url).hostname === "api.cloudflare.com") {
      assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
      const scope = url.includes(IDS.check) ? "check" : "production";
      if (!url.endsWith("/query"))
        return Response.json({
          success: true,
          result: { uuid: IDS[scope], name: NAMES[scope] },
        });
      const { sql, params } = JSON.parse(options.body);
      const results = dbs[scope].prepare(sql).all(...params);
      if (
        failure === "claim-response" &&
        sql.startsWith(
          "UPDATE shelf_storage_reservations SET state='uploading'",
        )
      ) {
        failure = null;
        throw new Error(`transport intentionally lost ${TOKEN}`);
      }
      return Response.json({
        success: true,
        result: [{ success: true, results }],
      });
    }
    assert.equal(new URL(url).hostname, `${ACCOUNT}.r2.cloudflarestorage.com`);
    const key = decodeURIComponent(
      new URL(url).pathname.slice("/the-shelf-books/".length),
    );
    if (options.method === "PUT") {
      assert.equal(options.headers["if-none-match"], "*");
      assert.equal(objects.has(key), false);
      objects.set(key, {
        bytes: Buffer.from(options.body),
        sha256: options.headers["x-amz-meta-sha256"],
        type: options.headers["content-type"],
        etag: '"selected-synthetic-etag"',
      });
      if (failure === "put-response") {
        failure = null;
        throw new Error(`lost ${SECRET}`);
      }
      return new Response(null, {
        status: 200,
        headers: { etag: '"selected-synthetic-etag"' },
      });
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    if (options.method === "GET")
      assert.equal(options.headers["if-match"], object.etag);
    const headers = {
      "content-length": String(object.bytes.length),
      "x-amz-meta-sha256": object.sha256,
      "content-type": object.type,
      etag: object.etag,
    };
    return new Response(options.method === "HEAD" ? null : object.bytes, {
      status: 200,
      headers,
    });
  };
  const remote = new RemoteStorageAuthority({
    identity,
    credentials: { accountId: ACCOUNT, token: TOKEN },
    resource: { databaseId: IDS.production, databaseName: NAMES.production },
    fetchImpl,
    beforeRequest: async () => {},
    requestLimit: 256,
    verifyWriteClosure: async () => ({
      schemaVersion: 1,
      identitySha256: bytesSha256(JSON.stringify(identity)),
      entrypointSha256: bytesSha256("test entrypoints"),
      localStateSha256: bytesSha256("test local"),
      processEvidenceSha256: bytesSha256("test process"),
      connectionEvidenceSha256: bytesSha256("test connection"),
      probeClosureSha256: bytesSha256("test probe"),
      localLegacyEmpty: true,
      lockAbsent: true,
      legacyEntryPointsDisabled: true,
      legacyProcessesStopped: true,
      legacyConnectionsClosed: true,
      probeWriteCapabilityDisabled: true,
      drainBound: {
        source: "enforced-transport-deadline",
        maxRequestLifetimeMs: 60000,
        configurationSha256: bytesSha256("test deadline"),
      },
      stoppedAt: Date.now() - 61000,
      drainedAt: Date.now(),
      verifiedAt: Date.now(),
      deadlineMs: 60000,
    }),
  });
  await remote.initialize(identity);
  if (ready) {
    const snapshots = await remote.readFrozenSnapshots(identity);
    await remote.migrateFrozen(identity, snapshots);
    await remote.activateFrozen(identity, snapshots);
  }
  calls.length = 0;
  let journalDispatches = 0;
  const journalFetch = async (url, options) => {
    const journalFiles = await filesUnder(path.join(stateDir, "selected-sync"));
    const intents = journalFiles.filter((name) =>
      name.endsWith("-intent.json"),
    );
    assert.equal(
      intents.length,
      ++journalDispatches,
      "every dispatch must have a durable prior intent",
    );
    assert.ok(journalFiles.some((name) => name.endsWith("selection.json")));
    return fetchImpl(url, options);
  };
  const trustedOperator = async () => ({
    fetchImpl: journalFetch,
    storageReceipt: { uploadEligible: true, accountEvidence: evidence() },
  });
  const base = {
    root,
    environment: {},
    profile: "production",
    fileId: FILE,
    kind: "original",
  };
  return {
    root,
    stateDir,
    manifestPath,
    manifest,
    pinsPath,
    pin,
    packagePath,
    packageBytes,
    source,
    sourcePath,
    dbs,
    calls,
    objects,
    trustedOperator,
    base,
    versionHash,
    prepared: {
      ...base,
      kind: "prepared-text",
      versionHash,
      sha256: bytesSha256(packageBytes),
    },
    setFailure: (value) => {
      failure = value;
    },
  };
}
const r2calls = (f) =>
  f.calls.filter((c) =>
    new URL(c.url).hostname.endsWith(".r2.cloudflarestorage.com"),
  );

test("selected CLI forces one profile/file/kind and rejects all path, evidence, retry and clock overrides", () => {
  assert.equal(
    parseSelectedSyncArgs([
      "--profile",
      "check",
      "--file",
      FILE,
      "--kind",
      "original",
    ]).action,
    "plan",
  );
  for (const args of [
    [],
    [
      "sync",
      "--profile",
      "production",
      "--file",
      FILE,
      "--kind",
      "prepared-text",
    ],
    [
      "sync",
      "--profile",
      "production",
      "--file",
      FILE,
      "--kind",
      "original",
      "--file",
      "other",
    ],
  ])
    assert.throws(() => parseSelectedSyncArgs(args), {
      code: "selected_invalid_arguments",
    });
  for (const flag of [
    "--manifest",
    "--state-dir",
    "--evidence",
    "--provider",
    "--now",
    "--retry",
    "--force",
    "--account",
    "--bucket",
  ])
    assert.throws(
      () =>
        parseSelectedSyncArgs([
          "sync",
          "--profile",
          "production",
          "--file",
          FILE,
          "--kind",
          "original",
          flag,
          "anything",
        ]),
      { code: "selected_invalid_arguments" },
    );
});

test("default plan respects actual getConfig paths and public sync fails with zero remote requests", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.manifestPath);
  const result = await runSelectedSync(f.base);
  assert.equal(result.status, "planned");
  assert.equal(result.sha256, bytesSha256(f.source));
  await assert.rejects(runSelectedSync({ ...f.base, action: "sync" }), {
    code: "qualifying_storage_receipt_unavailable",
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readFile(f.manifestPath), before);
  assert.deepEqual(
    await filesUnder(path.join(f.stateDir, "selected-sync")),
    [],
  );
  const printed = JSON.stringify(result);
  for (const secret of [
    f.root,
    TOKEN,
    SECRET,
    "fixture.pdf",
    "Synthetic selected source",
  ])
    assert.equal(printed.includes(secret), false);
});

test("actual RemoteAuthority + R2 transport confirms one original, with private durable intents and idempotent repeat", async (t) => {
  const f = await fixture(t),
    pins = await fs.readFile(f.pinsPath),
    manifest = await fs.readFile(f.manifestPath);
  const result = await runSelectedSync({
    ...f.base,
    action: "sync",
    trustedOperator: f.trustedOperator,
  });
  assert.equal(result.status, "confirmed");
  assert.equal(result.contentVerified, true);
  assert.deepEqual(
    r2calls(f).map((c) => c.options.method),
    ["HEAD", "PUT", "HEAD", "GET", "HEAD"],
  );
  const repeat = await runSelectedSync({
    ...f.base,
    action: "sync",
    trustedOperator: f.trustedOperator,
  });
  assert.equal(repeat.reservationId, result.reservationId);
  assert.equal(r2calls(f).filter((c) => c.options.method === "PUT").length, 1);
  assert.equal(
    f.dbs.production
      .prepare("SELECT committed_bytes AS n FROM shelf_storage_authority")
      .get().n,
    f.source.length,
  );
  const journalFiles = await filesUnder(path.join(f.stateDir, "selected-sync"));
  assert.ok(journalFiles.some((name) => name.endsWith("-intent.json")));
  for (const name of journalFiles) {
    assert.equal((await fs.stat(name)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(name))).mode & 0o777, 0o700);
    const value = await fs.readFile(name, "utf8");
    for (const secret of [
      TOKEN,
      SECRET,
      f.sourcePath,
      "Synthetic selected source",
    ])
      assert.equal(value.includes(secret), false);
  }
  assert.deepEqual(await fs.readFile(f.pinsPath), pins);
  assert.deepEqual(await fs.readFile(f.manifestPath), manifest);
});

test("prepared selected version preserves exact package bytes and separates text/original registry", async (t) => {
  const f = await fixture(t),
    pins = await fs.readFile(f.pinsPath),
    manifest = await fs.readFile(f.manifestPath);
  const result = await runSelectedSync({
    ...f.prepared,
    action: "sync",
    trustedOperator: f.trustedOperator,
  });
  assert.equal(result.status, "confirmed");
  assert.deepEqual([...f.objects.values()][0].bytes, f.packageBytes);
  assert.equal(
    f.dbs.production
      .prepare("SELECT count(*) AS n FROM shelf_storage_text_registry")
      .get().n,
    1,
  );
  assert.equal(
    f.dbs.production
      .prepare("SELECT count(*) AS n FROM shelf_storage_original_registry")
      .get().n,
    0,
  );
  assert.equal(
    f.dbs.production.prepare("SELECT count(*) AS n FROM file_registry").get().n,
    0,
  );
  assert.deepEqual(await fs.readFile(f.pinsPath), pins);
  assert.deepEqual(await fs.readFile(f.manifestPath), manifest);
});

test("lost PUT response keeps uncertain reservation; reconcile confirms without upload evidence or a second PUT", async (t) => {
  const f = await fixture(t);
  f.setFailure("put-response");
  await assert.rejects(
    runSelectedSync({
      ...f.base,
      action: "sync",
      trustedOperator: f.trustedOperator,
    }),
    { code: "r2_transport_unknown" },
  );
  assert.equal(
    f.dbs.production
      .prepare("SELECT state FROM shelf_storage_reservations")
      .get().state,
    "uncertain",
  );
  const before = f.calls.length;
  const result = await runSelectedSync({
    ...f.base,
    action: "reconcile",
    trustedOperator: async () => ({
      fetchImpl: (await f.trustedOperator()).fetchImpl,
    }),
  });
  assert.equal(result.status, "confirmed");
  assert.equal(r2calls(f).filter((c) => c.options.method === "PUT").length, 1);
  const sql = f.calls
    .slice(before)
    .filter((c) => c.url.endsWith("/query"))
    .map((c) => JSON.parse(c.options.body).sql)
    .join("\n");
  assert.equal(sql.includes("INSERT INTO shelf_storage_reservations"), false);
  assert.equal(sql.includes("state='uploading'"), false);
  assert.equal(sql.includes("SET observed_bytes"), false);
});

test("lost durable claim response does not PUT; repeated sync and reconcile preserve uncertainty on 404", async (t) => {
  const f = await fixture(t);
  f.setFailure("claim-response");
  await assert.rejects(
    runSelectedSync({
      ...f.base,
      action: "sync",
      trustedOperator: f.trustedOperator,
    }),
    { code: "storage_remote_outcome_unknown" },
  );
  const result = await runSelectedSync({
    ...f.base,
    action: "sync",
    trustedOperator: f.trustedOperator,
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.blockedBy, "object_absence_unresolved");
  const again = await runSelectedSync({
    ...f.base,
    action: "reconcile",
    trustedOperator: async () => ({
      fetchImpl: (await f.trustedOperator()).fetchImpl,
    }),
  });
  assert.equal(again.status, "uncertain");
  assert.equal(
    r2calls(f).some((c) => c.options.method === "PUT"),
    false,
  );
});

test("unready authority and forged persisted receipt stop before R2", async (t) => {
  const f = await fixture(t, { ready: false });
  await assert.rejects(
    runSelectedSync({
      ...f.base,
      action: "sync",
      trustedOperator: f.trustedOperator,
    }),
    { code: "storage_migration_required" },
  );
  assert.equal(r2calls(f).length, 0);
  const g = await fixture(t);
  g.dbs.production
    .prepare("UPDATE shelf_storage_authority SET receipt_json=? WHERE id=1")
    .run(JSON.stringify({ schemaVersion: 1, cloudWriteFreezeProven: true }));
  await assert.rejects(
    runSelectedSync({
      ...g.base,
      action: "sync",
      trustedOperator: g.trustedOperator,
    }),
    { code: "migration_readback_failed" },
  );
  assert.equal(r2calls(g).length, 0);
});

test("prepared requires current independent pin, exact bytes, matching source and strict package contract", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { versionHash: "d".repeat(64) },
    { sha256: "d".repeat(64) },
  ])
    await assert.rejects(
      runSelectedSync({
        ...f.prepared,
        ...change,
        action: "sync",
        trustedOperator: f.trustedOperator,
      }),
    );
  await fs.writeFile(
    f.pinsPath,
    JSON.stringify({
      schemaVersion: 1,
      files: { [FILE]: { ...f.pin, sourceSha256: "d".repeat(64) } },
    }),
  );
  await assert.rejects(runSelectedSync(f.prepared), {
    code: "selected_pin_source_mismatch",
  });
  await fs.writeFile(
    f.pinsPath,
    JSON.stringify({ schemaVersion: 1, files: { [FILE]: f.pin } }),
  );
  const corrupt = JSON.parse(f.packageBytes);
  corrupt.extra = "rejected";
  const bytes = Buffer.from(JSON.stringify(corrupt));
  await fs.writeFile(f.packagePath, bytes);
  await assert.rejects(
    runSelectedSync({ ...f.prepared, sha256: bytesSha256(bytes) }),
  );
  assert.equal(f.calls.length, 0);
});

test("rejects escaped getConfig paths, private symlinks and unsafe journal before cloud writes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runSelectedSync({ ...f.base, environment: { SHELF_STATE_DIR: "books" } }),
    { code: "selected_configured_path_outside_private" },
  );
  await fs.rename(f.manifestPath, f.manifestPath + ".original");
  await fs.symlink(f.manifestPath + ".original", f.manifestPath);
  await assert.rejects(runSelectedSync(f.base), {
    code: "selected_manifest_unsafe",
  });
  await fs.unlink(f.manifestPath);
  await fs.rename(f.manifestPath + ".original", f.manifestPath);
  await fs.symlink(
    path.join(f.root, "books"),
    path.join(f.stateDir, "selected-sync"),
  );
  await assert.rejects(
    runSelectedSync({
      ...f.base,
      action: "sync",
      trustedOperator: f.trustedOperator,
    }),
    { code: "selected_private_directory_unsafe" },
  );
  assert.equal(f.calls.length, 0);
});

test("stale/unknown evidence and 8 GB budget cannot be bypassed by trusted transport", async (t) => {
  const f = await fixture(t),
    transport = (await f.trustedOperator()).fetchImpl;
  for (const account of [
    { ...evidence(), completeCoverage: false },
    { ...evidence(), observedAt: new Date(Date.now() - 600000).toISOString() },
  ])
    await assert.rejects(
      runSelectedSync({
        ...f.base,
        action: "sync",
        trustedOperator: async () => ({
          fetchImpl: transport,
          storageReceipt: { uploadEligible: true, accountEvidence: account },
        }),
      }),
    );
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    runSelectedSync({
      ...f.base,
      action: "sync",
      trustedOperator: async () => ({
        fetchImpl: transport,
        storageReceipt: {
          uploadEligible: true,
          accountEvidence: { ...evidence(), storedBytes: 8_000_000_000 },
        },
      }),
    }),
  );
  assert.equal(r2calls(f).length, 0);
});

test("check and production use separate keys but share the production authority budget", async (t) => {
  const f = await fixture(t);
  const check = await runSelectedSync({
    ...f.base,
    action: "sync",
    profile: "check",
    trustedOperator: f.trustedOperator,
  });
  const production = await runSelectedSync({
    ...f.base,
    action: "sync",
    trustedOperator: f.trustedOperator,
  });
  assert.notEqual(check.reservationId, production.reservationId);
  assert.deepEqual(
    [...f.objects.keys()].map((key) => key.split("/")[0]).sort(),
    ["books", "cf03-check"],
  );
  assert.equal(
    f.dbs.production
      .prepare("SELECT committed_bytes AS n FROM shelf_storage_authority")
      .get().n,
    2 * f.source.length,
  );
  assert.ok(
    f.calls
      .filter((c) => new URL(c.url).hostname === "api.cloudflare.com")
      .every((c) => c.url.includes(IDS.production)),
  );
  assert.equal(
    f.dbs.check.prepare("SELECT count(*) AS n FROM file_registry").get().n,
    0,
  );
});

test("original candidate, private visibility, 20 MB and source mtime gates reject before remote I/O", async (t) => {
  const f = await fixture(t);
  for (const change of [
    { eligibility: "local-only" },
    { visibility: "public" },
    { sizeBytes: 20_000_001 },
    { mtimeNs: "1" },
    { format: "MOBI" },
  ]) {
    await fs.writeFile(
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        files: { [FILE]: { ...f.manifest.files[FILE], ...change } },
      }),
    );
    await assert.rejects(
      runSelectedSync({
        ...f.base,
        action: "sync",
        trustedOperator: f.trustedOperator,
      }),
    );
  }
  assert.equal(f.calls.length, 0);
});
