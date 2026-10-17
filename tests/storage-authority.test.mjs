import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { prepareText } from "../scripts/prepare-text.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  StorageAuthority,
  prepareObject,
  bytesSha256,
  objectContentType,
  STORAGE_CEILING,
  OBJECT_LIMIT,
} from "../server/storage-authority.mjs";
import { syncObject } from "../server/object-sync.mjs";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const identity = () => ({
  schemaVersion: 1,
  authorityId: "shelf-offline-budget-v1",
  accountId: "test-account",
  bucket: "the-shelf-books",
  legacyDatabases: { check: "old-check-db", production: "old-production-db" },
});
const evidence = (now = NOW, storedBytes = 0) => ({
  schemaVersion: 1,
  source: "cloudflare-account-aggregate",
  targetAccount: "test-account",
  accountMatch: true,
  completeCoverage: true,
  plan: "free",
  storageClass: "Standard",
  storedBytes,
  observedAt: new Date(now).toISOString(),
  billingPeriod: new Date(now).toISOString().slice(0, 7),
  classAOperations: 0,
  classBOperations: 0,
});
function snapshot(scope, rows = [], registry = []) {
  const body = {
    schemaVersion: 1,
    scope,
    databaseId: identity().legacyDatabases[scope],
    accountId: "test-account",
    bucket: "the-shelf-books",
    frozen: {
      writesStopped: true,
      freezeId: "synthetic-freeze",
      frozenAt: NOW - 1000,
      snapshotAt: NOW,
    },
    complete: true,
    counts: { reservations: rows.length, registry: registry.length },
    ledger: {
      committedBytes: rows
        .filter((r) => r.state === "confirmed")
        .reduce((n, r) => n + r.descriptor.sizeBytes, 0),
      reservedBytes: rows
        .filter((r) => !["confirmed", "aborted"].includes(r.state))
        .reduce((n, r) => n + r.descriptor.sizeBytes, 0),
    },
    reservations: rows,
    registry,
  };
  return { ...body, sha256: bytesSha256(JSON.stringify(body)) };
}
const reseal = (value) => {
  const { sha256: ignored, ...body } = value;
  return { ...body, sha256: bytesSha256(JSON.stringify(body)) };
};
async function fixture(t, { ready = true, clock = () => NOW } = {}) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "shelf-storage-authority-"),
  );
  const root = await fs.realpath(temp);
  await fs.chmod(root, 0o700);
  const filename = path.join(root, "authority.sqlite"),
    handles = [];
  const open = () => {
    const a = new StorageAuthority({
      filename,
      privateRoot: root,
      identity: identity(),
      clock,
    });
    handles.push(a);
    return a;
  };
  const authority = open();
  t.after(async () => {
    for (const handle of handles) {
      try {
        handle.close();
      } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  if (ready)
    authority.migrateFrozen(identity(), [
      snapshot("check"),
      snapshot("production"),
    ]);
  return { root, filename, authority, open };
}
const original = (
  scope = "production",
  fileId = "file_one",
  bytes = new TextEncoder().encode("book"),
) =>
  prepareObject({
    kind: "original",
    scope,
    fileId,
    bookId: "book_one",
    format: "PDF",
    bytes,
  });
function objectStore(initial) {
  const objects = new Map(),
    calls = [];
  const install = (object) =>
    objects.set(object.descriptor.objectKey, {
      bytes: Uint8Array.from(object.bytes),
      head: {
        size: object.bytes.length,
        sha256: object.descriptor.sha256,
        etag: '"etag-v1"',
        contentType: objectContentType(object.descriptor),
      },
    });
  if (initial) install(initial);
  const store = {
    target: { accountId: "test-account", bucket: "the-shelf-books" },
    async head(key) {
      calls.push(["HEAD", key, this.target.bucket]);
      return objects.has(key) ? { ...objects.get(key).head } : null;
    },
    async get(key, options) {
      calls.push(["GET", key, options]);
      const bytes = Uint8Array.from(objects.get(key).bytes);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async put(key, bytes, options) {
      calls.push(["PUT", key, options]);
      assert.equal(options.ifNoneMatch, "*");
      if (objects.has(key)) throw new Error("precondition");
      objects.set(key, {
        bytes: Uint8Array.from(bytes),
        head: {
          size: bytes.length,
          sha256: options.sha256,
          etag: '"etag-v1"',
          contentType: options.contentType,
        },
      });
    },
  };
  return { store, objects, calls, install };
}
const request = (authority, object, store, more = {}) =>
  syncObject({
    authority,
    identity: identity(),
    reservationId: "reservation-one",
    descriptor: object.descriptor,
    bytes: object.bytes,
    evidence: evidence(),
    store,
    ...more,
  });

test("new SQLite requires both explicit snapshots; migration receipt survives reopening and is idempotent", async (t) => {
  const { authority, open } = await fixture(t, { ready: false });
  assert.equal(authority.inspect(identity()).phase, "migration_required");
  const object = await original();
  await assert.rejects(
    authority.reserve(
      identity(),
      "r",
      object.descriptor,
      object.bytes,
      evidence(),
    ),
    { code: "storage_migration_required" },
  );
  assert.throws(
    () => authority.migrateFrozen(identity(), [snapshot("check")]),
    { code: "migration_incomplete" },
  );
  const receipt = authority.migrateFrozen(identity(), [
    snapshot("production"),
    snapshot("check"),
  ]);
  assert.equal(receipt.cloudWriteFreezeProven, false);
  assert.deepEqual(
    open().migrateFrozen(identity(), [
      snapshot("check"),
      snapshot("production"),
    ]),
    receipt,
  );
  assert.equal(authority.inspect(identity()).phase, "ready");
});

test("real SQLite single-object success confirms atomically, registries and replay never PUT twice", async (t) => {
  const { authority, open } = await fixture(t),
    object = await original(),
    mock = objectStore();
  const result = await request(authority, object, mock.store);
  assert.equal(result.state, "confirmed");
  assert.deepEqual(
    mock.calls.map((c) => c[0]),
    ["HEAD", "PUT", "HEAD", "GET", "HEAD"],
  );
  assert.equal(authority.registry(identity(), "original").length, 1);
  assert.equal(authority.registry(identity(), "prepared-text").length, 0);
  assert.equal(authority.inspect(identity()).committedBytes, 4);
  assert.equal(authority.inspect(identity()).reservedBytes, 0);
  assert.deepEqual(await request(open(), object, mock.store), result);
  assert.equal(mock.calls.filter((c) => c[0] === "PUT").length, 1);
  assert.equal(typeof authority.confirmVerified, "undefined");
});

function preparedFixture(format = "PDF", suffix = "1234567890abcdef") {
  const source = {
    fileId: `file_${suffix}`,
    bookId: "book_1234567890abcdef",
    format,
    sizeBytes: 1234,
    mtimeNs: "123456789",
    fingerprint: {
      algorithm: "sha256",
      value: bytesSha256("synthetic source"),
    },
  };
  const text = "合成正文：宇宙与引力。",
    chunks = [
      {
        index: 0,
        locator: {
          type: format === "PDF" ? "pdf-page" : "epub-spine",
          ...(format === "PDF" ? { page: 2 } : { spineIndex: 1 }),
          start: 0,
          end: Array.from(text).length,
        },
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
    source,
    textBytes: Buffer.byteLength(text),
    contentHash: bytesSha256(JSON.stringify(chunks)),
    chunks,
  };
  const value = { ...body, versionHash: bytesSha256(JSON.stringify(body)) };
  return {
    bytes: new TextEncoder().encode(JSON.stringify(value) + "\n"),
    source: {
      fileId: source.fileId,
      bookId: source.bookId,
      format,
      sizeBytes: source.sizeBytes,
      mtimeNs: source.mtimeNs,
      versionHash: value.versionHash,
      sourceSha256: source.fingerprint.value,
    },
  };
}
async function prepared(format = "PDF", scope = "production", suffix) {
  const fixture = preparedFixture(format, suffix);
  return prepareObject({
    kind: "prepared-text",
    scope,
    fileId: fixture.source.fileId,
    bookId: fixture.source.bookId,
    format: "JSON",
    ...fixture,
  });
}
const legacyRow = (
  object,
  state = "uncertain",
  reservationId = "legacy-one",
) => ({
  reservationId,
  descriptor: object.descriptor,
  state,
  etag: state === "confirmed" ? '"legacy-etag"' : null,
  contentVerified: state === "confirmed",
  absenceVerified: state === "aborted",
});

test("synthetic PDF/EPUB packages use shared validation, JSON keys and dedicated version registry", async (t) => {
  const { authority } = await fixture(t);
  let total = 0;
  for (const format of ["PDF", "EPUB"]) {
    const object = await prepared(format),
      mock = objectStore();
    total += object.bytes.length;
    const result = await request(authority, object, mock.store, {
      reservationId: `text-${format}`,
    });
    assert.equal(result.state, "confirmed");
    assert.match(
      result.descriptor.objectKey,
      /^prepared-text\/v1\/production\/.*\.json$/,
    );
    assert.equal(
      mock.calls.find((c) => c[0] === "PUT")[2].contentType,
      "application/json",
    );
  }
  assert.equal(authority.registry(identity(), "prepared-text").length, 2);
  assert.equal(authority.registry(identity(), "original").length, 0);
  assert.equal(authority.inspect(identity()).committedBytes, total);
  const object = await prepared(),
    bad = Uint8Array.from(object.bytes);
  bad[0] = 0;
  await assert.rejects(
    authority.reserve(identity(), "bad", object.descriptor, bad, evidence()),
    { code: "object_hash_mismatch" },
  );
  const arbitrary = new TextEncoder().encode(
    '{"secret":"not a prepared package"}\n',
  );
  await assert.rejects(
    prepareObject({
      kind: "prepared-text",
      scope: "check",
      fileId: object.descriptor.fileId,
      bookId: object.descriptor.bookId,
      format: "JSON",
      bytes: arbitrary,
      source: object.descriptor.source,
    }),
  );
});

test("nonempty migration retains all pending bytes, disabled committed entries and proves projected readback", async (t) => {
  const { authority } = await fixture(t, { ready: false }),
    check = await original("check"),
    production = await original(),
    aborted = await original("check", "old_aborted");
  const pending = legacyRow(check),
    committed = legacyRow(production, "confirmed"),
    dead = legacyRow(aborted, "aborted", "dead");
  const receipt = authority.migrateFrozen(identity(), [
    snapshot("check", [pending, dead]),
    snapshot(
      "production",
      [committed],
      [
        {
          descriptor: production.descriptor,
          etag: committed.etag,
          state: "disabled",
          version: 2,
        },
      ],
    ),
  ]);
  assert.equal(receipt.importedReservations, 2);
  assert.equal(receipt.reservedBytes, 4);
  assert.equal(receipt.committedBytes, 4);
  assert.deepEqual(authority.get(identity(), "check:legacy-one"), {
    reservationId: "check:legacy-one",
    descriptor: check.descriptor,
    state: "uncertain",
    putAttempted: true,
    contentVerified: false,
    etag: null,
  });
  assert.equal(authority.registry(identity(), "original")[0].enabled, false);
  assert.throws(() => authority.claimPut(identity(), "check:legacy-one"), {
    code: "storage_put_already_claimed",
  });
  const mock = objectStore();
  const missing = await authority.reconcile(
    identity(),
    "check:legacy-one",
    mock.store,
  );
  assert.equal(missing.blockedReason, "object_absence_unresolved");
  assert.equal(authority.inspect(identity()).reservedBytes, 4);
  mock.install(check);
  await authority.reconcile(identity(), "check:legacy-one", mock.store);
  assert.equal(authority.inspect(identity()).committedBytes, 8);
  assert.equal(authority.inspect(identity()).reservedBytes, 0);
});

test("migration missing/unknown/inconsistent data and conflicting replay fail closed without partial rows", async (t) => {
  const { authority } = await fixture(t, { ready: false }),
    object = await original("check"),
    pending = legacyRow(object);
  const valid = snapshot("check", [pending]);
  const changes = [
    (s) => {
      delete s.ledger;
    },
    (s) => {
      s.complete = false;
    },
    (s) => {
      s.frozen.writesStopped = false;
    },
    (s) => {
      s.counts.reservations = 0;
    },
    (s) => {
      s.ledger.reservedBytes = 0;
    },
    (s) => {
      s.reservations[0].state = "unknown";
    },
    (s) => {
      s.reservations[0].descriptor.path = "/private/synthetic";
    },
    (s) => {
      s.reservations[0].unexpected = "hidden";
    },
    (s) => {
      s.sha256 = "a".repeat(64);
    },
    (s) => {
      s.databaseId = "wrong-db";
    },
  ];
  for (const change of changes) {
    const invalid = structuredClone(valid);
    change(invalid);
    assert.throws(() =>
      authority.migrateFrozen(identity(), [invalid, snapshot("production")]),
    );
    assert.equal(authority.inspect(identity()).phase, "migration_required");
    assert.equal(authority.inspect(identity()).reservedBytes, 0);
  }
  const committed = legacyRow(object, "confirmed");
  assert.throws(
    () =>
      authority.migrateFrozen(identity(), [
        snapshot("check", [committed]),
        snapshot("production"),
      ]),
    { code: "migration_ledger_mismatch" },
  );
  assert.throws(
    () =>
      authority.migrateFrozen(identity(), [
        snapshot("check"),
        snapshot("check"),
      ]),
    { code: "migration_incomplete" },
  );
  authority.migrateFrozen(identity(), [valid, snapshot("production")]);
  assert.throws(
    () =>
      authority.migrateFrozen(identity(), [
        snapshot("check"),
        snapshot("production"),
      ]),
    { code: "migration_conflict" },
  );
});

test("account evidence gaps, stale/future/month/operations and rollback never allocate budget", async (t) => {
  const { authority } = await fixture(t),
    object = await original();
  const invalid = [
    null,
    {},
    ...[
      { completeCoverage: false },
      { accountMatch: false },
      { source: "bucket-list" },
      { targetAccount: "other" },
      { observedAt: new Date(NOW - 300001).toISOString() },
      { observedAt: new Date(NOW + 1).toISOString() },
      { billingPeriod: "2026-09" },
      { classAOperations: 800000 },
      { classBOperations: 8000000 },
      { storedBytes: -1 },
      { plan: "unknown" },
    ].map((patch) => ({ ...evidence(), ...patch })),
  ];
  for (const e of invalid) {
    await assert.rejects(
      authority.reserve(identity(), "r", object.descriptor, object.bytes, e),
    );
    assert.equal(authority.inspect(identity()).reservedBytes, 0);
  }
  await authority.reserve(
    identity(),
    "r",
    object.descriptor,
    object.bytes,
    evidence(),
  );
  const next = await original("check");
  await assert.rejects(
    authority.reserve(identity(), "next", next.descriptor, next.bytes, {
      ...evidence(),
      storedBytes: 1,
    }),
    { code: "account_storage_conflict" },
  );
  assert.equal(authority.inspect(identity()).reservedBytes, 4);
});

test("8 GB exact boundary shares original/text and check/production with no guessed overlap deduction", async (t) => {
  const { authority } = await fixture(t),
    book = await original("check"),
    text = await prepared();
  const remaining = book.bytes.length + text.bytes.length,
    e = evidence(NOW, STORAGE_CEILING - remaining);
  await authority.reserve(identity(), "book", book.descriptor, book.bytes, e);
  await authority.reserve(identity(), "text", text.descriptor, text.bytes, e);
  assert.equal(authority.inspect(identity()).reservedBytes, remaining);
  const next = await original("production", "another");
  await assert.rejects(
    authority.reserve(identity(), "next", next.descriptor, next.bytes, e),
    { code: "storage_budget_exceeded" },
  );
  const mock = objectStore(book);
  await authority.reconcile(identity(), "book", mock.store);
  await assert.rejects(
    authority.reserve(identity(), "next", next.descriptor, next.bytes, e),
    { code: "storage_budget_exceeded" },
  );
  assert.equal(authority.inspect(identity()).committedBytes, 4);
  assert.equal(authority.inspect(identity()).reservedBytes, text.bytes.length);
});

test("reservation replay is idempotent and rejects changed descriptor, identity, id or object namespace", async (t) => {
  const { authority, filename, root } = await fixture(t),
    object = await original();
  const first = await authority.reserve(
    identity(),
    "r",
    object.descriptor,
    object.bytes,
    evidence(),
  );
  assert.deepEqual(
    await authority.reserve(
      identity(),
      "r",
      object.descriptor,
      object.bytes,
      evidence(),
    ),
    first,
  );
  await assert.rejects(
    authority.reserve(
      identity(),
      "r2",
      object.descriptor,
      object.bytes,
      evidence(),
    ),
    { code: "storage_reservation_conflict" },
  );
  const changed = await original(
    "production",
    "file_one",
    new TextEncoder().encode("else"),
  );
  await assert.rejects(
    authority.reserve(
      identity(),
      "r",
      changed.descriptor,
      changed.bytes,
      evidence(),
    ),
    { code: "storage_reservation_conflict" },
  );
  await assert.rejects(
    authority.reserve(
      identity(),
      "wrong",
      { ...object.descriptor, objectKey: "prepared-text/fake.json" },
      object.bytes,
      evidence(),
    ),
    { code: "storage_descriptor_invalid" },
  );
  assert.throws(
    () => authority.inspect({ ...identity(), authorityId: "different" }),
    { code: "storage_identity_mismatch" },
  );
  assert.throws(
    () =>
      new StorageAuthority({
        filename,
        privateRoot: root,
        identity: { ...identity(), accountId: "other" },
      }),
    { code: "storage_identity_mismatch" },
  );
  assert.equal(authority.inspect(identity()).reservedBytes, 4);
});

test("reserved crash before PUT safely resumes after evidence expires using fresh evidence without double charge", async (t) => {
  let clock = NOW;
  const { authority, open } = await fixture(t, { clock: () => clock }),
    object = await original();
  await authority.reserve(
    identity(),
    "reservation-one",
    object.descriptor,
    object.bytes,
    evidence(),
  );
  clock += 300001;
  assert.throws(() => authority.claimPut(identity(), "reservation-one"), {
    code: "account_storage_stale",
  });
  assert.equal(authority.get(identity(), "reservation-one").state, "reserved");
  const mock = objectStore();
  const result = await request(open(), object, mock.store, {
    evidence: evidence(clock),
  });
  assert.equal(result.state, "confirmed");
  assert.equal(authority.inspect(identity()).committedBytes, 4);
  assert.equal(authority.inspect(identity()).reservedBytes, 0);
  assert.equal(mock.calls.filter((c) => c[0] === "PUT").length, 1);
});

test("pre-PUT HEAD failure retains reserved and retry remains safe; month boundary requires new evidence", async (t) => {
  let clock = Date.parse("2026-10-31T23:59:59Z");
  const { authority } = await fixture(t, { clock: () => clock }),
    object = await original(),
    mock = objectStore();
  const head = mock.store.head;
  let fail = true;
  mock.store.head = async function (key) {
    if (fail) {
      fail = false;
      throw new Error("read disconnected");
    }
    return head.call(this, key);
  };
  await assert.rejects(
    request(authority, object, mock.store, { evidence: evidence(clock) }),
    { code: "object_sync_unknown" },
  );
  assert.equal(authority.get(identity(), "reservation-one").state, "reserved");
  assert.equal(
    authority.get(identity(), "reservation-one").putAttempted,
    false,
  );
  clock += 2000;
  assert.throws(() => authority.claimPut(identity(), "reservation-one"), {
    code: "account_storage_stale",
  });
  assert.equal(
    (
      await request(authority, object, mock.store, {
        evidence: evidence(clock),
      })
    ).state,
    "confirmed",
  );
});

test("durable PUT claim crash never sends a second PUT even after reopen and long time", async (t) => {
  let clock = NOW;
  const { authority, open } = await fixture(t, { clock: () => clock }),
    object = await original(),
    mock = objectStore();
  await authority.reserve(
    identity(),
    "reservation-one",
    object.descriptor,
    object.bytes,
    evidence(),
  );
  authority.claimPut(identity(), "reservation-one"); // Process dies here before sending bytes.
  clock += 86400000;
  const result = await request(open(), object, mock.store, {
    evidence: evidence(clock),
  });
  assert.equal(result.state, "uncertain");
  assert.equal(result.blockedReason, "object_absence_unresolved");
  assert.equal(mock.calls.filter((c) => c[0] === "PUT").length, 0);
  assert.equal(authority.inspect(identity()).reservedBytes, 4);
  assert.throws(() => authority.claimPut(identity(), "reservation-one"), {
    code: "storage_put_already_claimed",
  });
});

test("lost PUT response retains full uncertain budget; HEAD GET HEAD recovery confirms once without rePUT", async (t) => {
  const { authority, open } = await fixture(t),
    object = await prepared(),
    mock = objectStore();
  const put = mock.store.put;
  mock.store.put = async function (...args) {
    await put.apply(this, args);
    throw new Error("response lost");
  };
  await assert.rejects(request(authority, object, mock.store), {
    code: "object_sync_unknown",
  });
  assert.equal(authority.get(identity(), "reservation-one").state, "uncertain");
  assert.equal(
    authority.inspect(identity()).reservedBytes,
    object.bytes.length,
  );
  assert.equal(authority.inspect(identity()).committedBytes, 0);
  const result = await request(open(), object, mock.store);
  assert.equal(result.state, "confirmed");
  assert.equal(mock.calls.filter((c) => c[0] === "PUT").length, 1);
  assert.equal(
    authority.inspect(identity()).committedBytes,
    object.bytes.length,
  );
  await request(authority, object, mock.store);
  assert.equal(
    authority.inspect(identity()).committedBytes,
    object.bytes.length,
  );
});

test("existing correct object is verified with actual bytes and never overwritten", async (t) => {
  const { authority } = await fixture(t),
    object = await original(),
    mock = objectStore(object);
  const result = await request(authority, object, mock.store);
  assert.equal(result.state, "confirmed");
  assert.deepEqual(
    mock.calls.map((c) => c[0]),
    ["HEAD", "HEAD", "GET", "HEAD"],
  );
});

test("wrong hash, metadata, second HEAD changes, truncation and oversize stream never confirm or release", async (t) => {
  for (const fault of [
    "hash",
    "mime",
    "metadata-hash",
    "size",
    "etag",
    "second-etag",
    "second-missing",
    "short",
    "oversize",
    "nonstream",
    "read-error",
  ]) {
    await t.test(fault, async (sub) => {
      const { authority } = await fixture(sub),
        object = await original(),
        mock = objectStore(object);
      await authority.reserve(
        identity(),
        "reservation-one",
        object.descriptor,
        object.bytes,
        evidence(),
      );
      authority.claimPut(identity(), "reservation-one");
      const stored = mock.objects.get(object.descriptor.objectKey),
        head = mock.store.head;
      if (fault === "hash") stored.bytes.fill(0);
      if (fault === "mime") stored.head.contentType = "text/plain";
      if (fault === "metadata-hash") stored.head.sha256 = "0".repeat(64);
      if (fault === "size") stored.head.size++;
      if (fault === "etag") stored.head.etag = "";
      if (fault.startsWith("second-")) {
        let heads = 0;
        mock.store.head = async function (key) {
          const value = await head.call(this, key);
          return ++heads === 2
            ? fault === "second-missing"
              ? null
              : { ...value, etag: "different" }
            : value;
        };
      }
      if (["short", "oversize", "nonstream", "read-error"].includes(fault))
        mock.store.get = async () =>
          fault === "nonstream"
            ? new Uint8Array(4)
            : new ReadableStream({
                start(c) {
                  if (fault === "read-error") c.error(new Error("GET lost"));
                  else {
                    c.enqueue(new Uint8Array(fault === "short" ? 3 : 5));
                    c.close();
                  }
                },
              });
      await assert.rejects(
        authority.reconcile(identity(), "reservation-one", mock.store),
      );
      assert.equal(
        authority.get(identity(), "reservation-one").state,
        "uncertain",
      );
      assert.equal(authority.inspect(identity()).reservedBytes, 4);
      assert.equal(authority.inspect(identity()).committedBytes, 0);
      assert.equal(authority.registry(identity(), "original").length, 0);
    });
  }
});

test("descriptor, bytes, evidence and ordinary adapter this.target stay pinned across await", async (t) => {
  const { authority } = await fixture(t),
    object = await prepared(),
    mock = objectStore();
  const originalDescriptor = structuredClone(object.descriptor),
    e = evidence(),
    ident = identity();
  const resultPromise = request(authority, object, mock.store, {
    identity: ident,
    evidence: e,
  });
  object.descriptor.objectKey = "wrong-key";
  object.descriptor.source.fileId = "file_aaaaaaaaaaaaaaaa";
  object.bytes.fill(0);
  e.storedBytes = STORAGE_CEILING;
  e.completeCoverage = false;
  ident.accountId = "other";
  mock.store.target.accountId = "other";
  mock.store.target.bucket = "wrong-bucket";
  mock.store.put = async () => {
    throw new Error("mutated method must not be used");
  };
  const result = await resultPromise;
  assert.equal(result.state, "confirmed");
  assert.deepEqual(result.descriptor, originalDescriptor);
  assert.ok(
    mock.calls
      .filter((c) => c[0] === "HEAD")
      .every((c) => c[2] === "the-shelf-books"),
  );
  assert.equal(mock.calls.filter((c) => c[0] === "PUT").length, 1);
});

test("equal HEAD fields with reordered properties remain the same object identity", async (t) => {
  const { authority } = await fixture(t),
    object = await original(),
    mock = objectStore(object),
    head = mock.store.head;
  let count = 0;
  mock.store.head = async function (key) {
    const h = await head.call(this, key);
    return ++count % 2
      ? h
      : {
          contentType: h.contentType,
          etag: h.etag,
          sha256: h.sha256,
          size: h.size,
        };
  };
  assert.equal(
    (await request(authority, object, mock.store)).state,
    "confirmed",
  );
});

test("20 MB is inclusive and bytes exceeding that limit or zero are rejected", async (t) => {
  const { authority } = await fixture(t),
    large = await original("check", "large", new Uint8Array(OBJECT_LIMIT));
  await authority.reserve(
    identity(),
    "large",
    large.descriptor,
    large.bytes,
    evidence(),
  );
  assert.equal(authority.inspect(identity()).reservedBytes, OBJECT_LIMIT);
  await assert.rejects(original("check", "empty", new Uint8Array()), {
    code: "storage_bytes_invalid",
  });
  await assert.rejects(
    original("check", "oversize", new Uint8Array(OBJECT_LIMIT + 1)),
    { code: "storage_bytes_invalid" },
  );
});

test("disk paths and SQLite sidecars require private modes and reject symlinks without chmod", async (t) => {
  const { authority, filename, root } = await fixture(t);
  authority.close();
  const construct = () =>
    new StorageAuthority({ filename, privateRoot: root, identity: identity() });
  await fs.chmod(filename, 0o644);
  assert.throws(construct, { code: "storage_private_file_unsafe" });
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o644);
  await fs.chmod(filename, 0o600);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = filename + suffix;
    await fs.symlink(filename, sidecar);
    assert.throws(construct, { code: "storage_private_file_unsafe" });
    await fs.unlink(sidecar);
    await fs.writeFile(sidecar, "", { mode: 0o644 });
    assert.throws(construct, { code: "storage_private_file_unsafe" });
    await fs.unlink(sidecar);
  }
  const link = path.join(root, "linked.sqlite");
  await fs.symlink(filename, link);
  assert.throws(
    () =>
      new StorageAuthority({
        filename: link,
        privateRoot: root,
        identity: identity(),
      }),
    { code: "storage_private_file_unsafe" },
  );
  const directory = path.join(root, "unsafe");
  await fs.mkdir(directory, { mode: 0o755 });
  assert.throws(
    () =>
      new StorageAuthority({
        filename: path.join(directory, "db"),
        privateRoot: root,
        identity: identity(),
      }),
    { code: "storage_private_path_unsafe" },
  );
});

test("migration receipt readback failure rolls back sources, imported rows, registries and ready state", async (t) => {
  const { authority, filename } = await fixture(t, { ready: false }),
    object = await original("check"),
    row = legacyRow(object, "confirmed");
  const fault = new DatabaseSync(filename);
  t.after(() => fault.close());
  fault.exec(
    "CREATE TRIGGER break_receipt AFTER INSERT ON migration_receipt BEGIN UPDATE migration_receipt SET receipt_json='{}' WHERE id=NEW.id; END;",
  );
  const snapshots = [
    snapshot(
      "check",
      [row],
      [
        {
          descriptor: object.descriptor,
          etag: row.etag,
          state: "confirmed",
          version: 1,
        },
      ],
    ),
    snapshot("production"),
  ];
  assert.throws(() => authority.migrateFrozen(identity(), snapshots), {
    code: "migration_readback_failed",
  });
  assert.equal(authority.inspect(identity()).phase, "migration_required");
  assert.equal(authority.inspect(identity()).committedBytes, 0);
  for (const table of [
    "migration_sources",
    "migration_receipt",
    "reservations",
    "original_registry",
    "text_registry",
  ])
    assert.equal(
      fault.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
      0,
    );
  fault.exec("DROP TRIGGER break_receipt");
  assert.equal(
    authority.migrateFrozen(identity(), snapshots).committedBytes,
    4,
  );
});

test("failed claim or atomic confirm keeps durable reservation and permits verification-only recovery", async (t) => {
  const { authority, filename } = await fixture(t),
    object = await original(),
    mock = objectStore(object);
  await authority.reserve(
    identity(),
    "r",
    object.descriptor,
    object.bytes,
    evidence(),
  );
  const fault = new DatabaseSync(filename);
  t.after(() => fault.close());
  fault.exec(
    "CREATE TRIGGER fail_claim BEFORE UPDATE ON reservations WHEN NEW.state='uploading' BEGIN SELECT RAISE(ABORT,'synthetic disk fault'); END;",
  );
  assert.throws(() => authority.claimPut(identity(), "r"));
  assert.equal(authority.get(identity(), "r").state, "reserved");
  assert.equal(authority.get(identity(), "r").putAttempted, false);
  fault.exec("DROP TRIGGER fail_claim");
  authority.claimPut(identity(), "r");
  fault.exec(
    "CREATE TRIGGER fail_registry BEFORE INSERT ON original_registry BEGIN SELECT RAISE(ABORT,'synthetic disk fault'); END;",
  );
  await assert.rejects(authority.reconcile(identity(), "r", mock.store));
  assert.equal(authority.get(identity(), "r").state, "uncertain");
  assert.equal(authority.inspect(identity()).reservedBytes, 4);
  assert.equal(authority.inspect(identity()).committedBytes, 0);
  fault.exec("DROP TRIGGER fail_registry");
  assert.equal(
    (await authority.reconcile(identity(), "r", mock.store)).state,
    "confirmed",
  );
  assert.equal(authority.inspect(identity()).committedBytes, 4);
  assert.equal(mock.calls.filter((c) => c[0] === "PUT").length, 0);
});

test("database and sidecar hardlinks are rejected without changing the external file", async (t) => {
  const { authority, filename, root } = await fixture(t);
  authority.close();
  const outside = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-storage-outside-")),
  );
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const construct = (candidate = filename) =>
    new StorageAuthority({
      filename: candidate,
      privateRoot: root,
      identity: identity(),
    });
  for (const suffix of ["database", "-journal", "-wal", "-shm"]) {
    const external = path.join(outside, suffix),
      candidate =
        suffix === "database"
          ? path.join(root, "hardlinked.sqlite")
          : filename + suffix,
      contents = Buffer.from(`synthetic external file ${suffix}`);
    await fs.writeFile(external, contents, { mode: 0o600 });
    await fs.link(external, candidate);
    const before = await fs.stat(external, { bigint: true });
    try {
      assert.equal(before.nlink, 2n);
      assert.throws(
        () => construct(suffix === "database" ? candidate : filename),
        { code: "storage_private_file_unsafe" },
      );
      assert.deepEqual(await fs.readFile(external), contents);
      const after = await fs.stat(external, { bigint: true });
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.equal(after.mode, before.mode);
      assert.equal(after.nlink, 2n);
    } finally {
      await fs.unlink(candidate);
    }
  }
});

test(
  "real Worker threads atomically compete for one final shared SQLite allocation",
  { timeout: 15000 },
  async (t) => {
    const { authority, filename, root } = await fixture(t);
    const contenders = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        index % 2 === 0
          ? original("check", `worker_${index}`, new Uint8Array(1024))
          : prepared(
              "EPUB",
              "production",
              index.toString(16).padStart(16, "0"),
            ),
      ),
    );
    const allowance = Math.max(
      ...contenders.map((object) => object.bytes.length),
    );
    assert.ok(
      contenders.every((object) => object.bytes.length * 2 > allowance),
      "any two contenders must exceed the remaining capacity",
    );
    const gate = new Int32Array(new SharedArrayBuffer(4)),
      workers = [],
      sharedEvidence = evidence(NOW, STORAGE_CEILING - allowance);
    const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { StorageAuthority } = await import(workerData.module);
      const authority = new StorageAuthority({ ...workerData.options, clock: () => workerData.now });
      try {
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        const result = await authority.reserve(
          workerData.options.identity, workerData.reservationId,
          workerData.object.descriptor, workerData.object.bytes, workerData.evidence
        );
        parentPort.postMessage({ result: { state: result.state, bytes: result.descriptor.sizeBytes } });
      } catch (error) {
        parentPort.postMessage({ result: { error: error.code ?? error.message } });
      } finally { authority.close(); }
    })().catch(error => { throw error; });
  `;
    try {
      const runs = contenders.map((object, index) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: {
            module: new URL("../server/storage-authority.mjs", import.meta.url)
              .href,
            options: {
              filename,
              privateRoot: root,
              identity: identity(),
            },
            now: NOW,
            object,
            reservationId: `worker-${index}`,
            evidence: sharedEvidence,
            gate: gate.buffer,
          },
        });
        workers.push(worker);
        let readyResolve, resultResolve, rejectRun;
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve;
          rejectRun = reject;
        });
        const result = new Promise((resolve, reject) => {
          resultResolve = resolve;
          const previousReject = rejectRun;
          rejectRun = (error) => {
            previousReject(error);
            reject(error);
          };
        });
        worker.on("message", (message) => {
          if (message.ready) readyResolve();
          if (message.result) resultResolve(message.result);
        });
        worker.once("error", rejectRun);
        worker.once("exit", (code) => {
          if (code !== 0) rejectRun(new Error(`worker exited ${code}`));
        });
        return { ready, result };
      });
      await Promise.all(runs.map((run) => run.ready));
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0, workers.length);
      const results = await Promise.all(runs.map((run) => run.result)),
        admitted = results.filter((result) => result.state === "reserved");
      assert.equal(admitted.length, 1);
      assert.equal(
        results.filter((result) => result.error === "storage_budget_exceeded")
          .length,
        7,
      );
      assert.equal(
        authority.inspect(identity()).reservedBytes,
        admitted[0].bytes,
      );
      assert.ok(authority.inspect(identity()).reservedBytes <= allowance);
      assert.equal(authority.inspect(identity()).committedBytes, 0);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0, workers.length);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
);

test("concurrent same-reservation sync keeps one delayed uncertain PUT and recovers by verification", async (t) => {
  const { authority, open } = await fixture(t),
    object = await prepared(),
    mock = objectStore();
  let releasePut, signalPut;
  const putStarted = new Promise((resolve) => {
      signalPut = resolve;
    }),
    putReleased = new Promise((resolve) => {
      releasePut = resolve;
    }),
    put = mock.store.put;
  mock.store.put = async function (...args) {
    signalPut();
    await putReleased;
    await put.apply(this, args);
    throw new Error("synthetic lost PUT response");
  };
  const first = request(authority, object, mock.store);
  const failedFirst = assert.rejects(first, { code: "object_sync_unknown" });
  await putStarted;
  try {
    const concurrent = await request(open(), object, mock.store);
    assert.equal(concurrent.state, "uncertain");
    assert.equal(concurrent.blockedReason, "object_absence_unresolved");
    assert.equal(
      authority.inspect(identity()).reservedBytes,
      object.bytes.length,
    );
    assert.equal(authority.inspect(identity()).committedBytes, 0);
  } finally {
    releasePut();
  }
  await failedFirst;
  assert.equal(mock.calls.filter((call) => call[0] === "PUT").length, 1);
  assert.equal(authority.get(identity(), "reservation-one").state, "uncertain");
  assert.equal(
    authority.inspect(identity()).reservedBytes,
    object.bytes.length,
  );
  assert.equal(
    (await authority.reconcile(identity(), "reservation-one", mock.store))
      .state,
    "confirmed",
  );
  assert.equal(mock.calls.filter((call) => call[0] === "PUT").length, 1);
  assert.equal(authority.inspect(identity()).reservedBytes, 0);
  assert.equal(
    authority.inspect(identity()).committedBytes,
    object.bytes.length,
  );
  assert.equal(authority.registry(identity(), "prepared-text").length, 1);
});

test("real synthetic EPUB preparation synchronizes the validated package and exact version registry", async (t) => {
  const { authority, root } = await fixture(t),
    sources = path.join(root, "synthetic-sources"),
    projectRoot = path.join(root, "synthetic-project"),
    fileId = "file_1234567890abcdef",
    bookId = "book_1234567890abcdef";
  await fs.mkdir(sources, { mode: 0o700 });
  await fs.mkdir(projectRoot, { mode: 0o700 });
  const sourcePath = path.join(sources, "synthetic.epub"),
    archive = {
      "META-INF/container.xml":
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      "content.opf":
        '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
      "one.xhtml": "<html><body><p>合成星际引力研究。😀</p></body></html>",
      "two.xhtml":
        "<html><body><p>Second chapter with experimental evidence.</p></body></html>",
    };
  execFileSync(
    "python3",
    [
      "-c",
      'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()',
      sourcePath,
    ],
    { input: JSON.stringify(archive) },
  );
  await fs.chmod(sourcePath, 0o600);
  const stat = await fs.stat(sourcePath, { bigint: true }),
    originalBytes = await fs.readFile(sourcePath),
    manifestPath = path.join(root, "synthetic-manifest.json"),
    manifest = {
      schemaVersion: 1,
      root: sources,
      files: {
        [fileId]: {
          bookId,
          format: "EPUB",
          path: sourcePath,
          sizeBytes: Number(stat.size),
          mtimeNs: String(stat.mtimeNs),
          eligibility: "candidate",
          visibility: "private",
        },
      },
    };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const result = await prepareText({
      fileId,
      projectRoot,
      manifestPath,
      execute: true,
    }),
    bytes = await fs.readFile(path.join(projectRoot, result.artifact)),
    value = JSON.parse(bytes),
    source = {
      fileId,
      bookId,
      format: "EPUB",
      sizeBytes: originalBytes.length,
      mtimeNs: String(stat.mtimeNs),
      versionHash: result.versionHash,
      sourceSha256: bytesSha256(originalBytes),
    },
    object = await prepareObject({
      kind: "prepared-text",
      scope: "production",
      fileId,
      bookId,
      format: "JSON",
      bytes,
      source,
    }),
    mock = objectStore();
  assert.equal(result.status, "prepared");
  assert.deepEqual(
    value.chunks.map((chunk) => chunk.locator.spineIndex),
    [0, 1],
  );
  assert.match(value.chunks[0].text, /星际引力/);
  assert.equal(value.source.fingerprint.value, source.sourceSha256);
  assert.equal(
    (await request(authority, object, mock.store)).state,
    "confirmed",
  );
  assert.deepEqual(authority.registry(identity(), "prepared-text"), [
    {
      reservationId: "reservation-one",
      descriptor: object.descriptor,
      etag: '"etag-v1"',
      enabled: true,
    },
  ]);
  assert.equal(authority.registry(identity(), "original").length, 0);
  assert.deepEqual(
    mock.objects.get(object.descriptor.objectKey).bytes,
    Uint8Array.from(bytes),
  );
  assert.equal(object.descriptor.versionHash, result.versionHash);
  assert.equal(object.descriptor.sha256, bytesSha256(bytes));
  await assert.rejects(
    prepareObject({
      kind: "prepared-text",
      scope: "production",
      fileId,
      bookId,
      format: "JSON",
      bytes,
      source: { ...source, sourceSha256: "0".repeat(64) },
    }),
    { code: "prepared_text_source_mismatch" },
  );
  assert.deepEqual(await fs.readFile(sourcePath), originalBytes);
  assert.deepEqual(await fs.readFile(manifestPath), manifestBytes);
});
