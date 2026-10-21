import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createR2ObjectStore } from "../server/r2-object-store.mjs";
import {
  prepareObject,
  StorageAuthority,
  StorageError,
  bytesSha256,
  snapshotObjectStore,
  OBJECT_LIMIT,
  objectContentType,
} from "../server/storage-authority.mjs";
import { syncObject } from "../server/object-sync.mjs";

const NOW = Date.parse("2026-10-18T01:02:03.000Z");
const ACCOUNT = "a".repeat(32),
  ACCESS = "b".repeat(32),
  SECRET = "c".repeat(64);
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-r2-transport-test",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: { check: "legacy-check", production: "legacy-production" },
};
const object = (more = {}) =>
  prepareObject({
    kind: "original",
    scope: "production",
    fileId: "file_one",
    bookId: "book_one",
    format: "PDF",
    bytes: new TextEncoder().encode("synthetic book"),
    ...more,
  });
const putOptions = (d) => ({
  ifNoneMatch: "*",
  sha256: d.sha256,
  contentType: objectContentType(d),
});
const getOptions = (d) => ({ maxBytes: d.sizeBytes, ifMatch: '"r2-etag"' });
function create(d, fetchImpl, more = {}) {
  return createR2ObjectStore({
    accountId: ACCOUNT,
    bucket: "the-shelf-books",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    descriptors: [d],
    fetchImpl,
    clock: () => new Date(NOW),
    ...more,
  });
}
function response(d, { status = 200, body, headers = {}, ...rest } = {}) {
  return {
    status,
    redirected: false,
    url: "",
    headers: new Headers({
      "content-length": String(d.sizeBytes),
      "content-type": objectContentType(d),
      "x-amz-meta-sha256": d.sha256,
      etag: '"r2-etag"',
      ...headers,
    }),
    body: body ?? null,
    ...rest,
  };
}
const stream = (bytes) =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
async function consume(body) {
  const chunks = [];
  for await (const part of body) chunks.push(Buffer.from(part));
  return Buffer.concat(chunks);
}
const rejectsCode = (promise, code) =>
  assert.rejects(
    promise,
    (error) =>
      error instanceof StorageError &&
      error.message === code &&
      error.code === code,
  );

// Independently reconstruct the request using WebCrypto, rather than the adapter's crypto helpers.
async function verifySignature(url, request) {
  const encoder = new TextEncoder(),
    subtle = globalThis.crypto.subtle;
  const sha = async (value) =>
    Buffer.from(
      await subtle.digest(
        "SHA-256",
        typeof value === "string" ? encoder.encode(value) : value,
      ),
    ).toString("hex");
  const mac = async (key, value) =>
    new Uint8Array(
      await subtle.sign(
        "HMAC",
        await subtle.importKey(
          "raw",
          typeof key === "string" ? encoder.encode(key) : key,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
        encoder.encode(value),
      ),
    );
  const parsed = new URL(url),
    headers = request.headers,
    match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8}\/auto\/s3\/aws4_request), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(
        headers.authorization,
      );
  assert.ok(match);
  assert.equal(match[1], ACCESS);
  const keys = match[3].split(";");
  assert.deepEqual(
    keys,
    Object.keys(headers)
      .filter((key) => key !== "authorization")
      .sort(),
  );
  assert.equal(headers.host, parsed.hostname);
  assert.equal(
    headers["x-amz-content-sha256"],
    await sha(request.body ?? new Uint8Array()),
  );
  const canonical = [
    request.method,
    parsed.pathname,
    parsed.searchParams.toString(),
    keys.map((key) => `${key}:${headers[key]}`).join("\n") + "\n",
    match[3],
    headers["x-amz-content-sha256"],
  ].join("\n");
  let key = `AWS4${SECRET}`;
  for (const value of [match[2].slice(0, 8), "auto", "s3", "aws4_request"])
    key = await mac(key, value);
  const signature = await mac(
    key,
    `AWS4-HMAC-SHA256\n${headers["x-amz-date"]}\n${match[2]}\n${await sha(canonical)}`,
  );
  assert.equal(Buffer.from(signature).toString("hex"), match[4]);
}

test("fixed target and real SigV4 HEAD GET PUT requests have independently verified signatures", async () => {
  const { descriptor: d, bytes } = await object(),
    calls = [];
  const store = create(d, async (url, req) => {
    calls.push(req.method);
    assert.equal(
      url,
      `https://${ACCOUNT}.r2.cloudflarestorage.com/the-shelf-books/${d.objectKey}`,
    );
    assert.equal(req.redirect, "error");
    assert.ok(req.signal instanceof AbortSignal);
    assert.equal(req.headers["x-amz-date"], "20261018T010203Z");
    await verifySignature(url, req);
    if (req.method === "PUT") {
      assert.equal(req.headers["if-none-match"], "*");
      assert.equal(req.headers["content-length"], String(bytes.length));
      assert.equal(req.headers["x-amz-meta-sha256"], d.sha256);
      assert.equal(req.headers["content-type"], "application/pdf");
      assert.equal(req.headers["cache-control"], "private, no-store");
      assert.deepEqual(req.body, bytes);
    } else if (req.method === "GET")
      assert.equal(req.headers["if-match"], '"r2-etag"');
    return response(d, { body: req.method === "GET" ? stream(bytes) : null });
  });
  assert.deepEqual(Object.keys(store).sort(), ["get", "head", "put", "target"]);
  assert.ok(Object.isFrozen(store) && Object.isFrozen(store.target));
  assert.deepEqual(store.target, {
    accountId: ACCOUNT,
    bucket: "the-shelf-books",
  });
  snapshotObjectStore(identity, store);
  assert.equal((await store.head(d.objectKey)).sha256, d.sha256);
  assert.deepEqual(
    await consume(await store.get(d.objectKey, getOptions(d))),
    Buffer.from(bytes),
  );
  await store.put(d.objectKey, bytes, putOptions(d));
  assert.deepEqual(calls, ["HEAD", "GET", "PUT"]);
});

test("factory requires explicit fetch and exact account, fixed bucket and descriptor allowlist", async () => {
  const { descriptor: d } = await object();
  for (const more of [
    { accountId: "wrong" },
    { bucket: "other" },
    { accessKeyId: "bad" },
    { secretAccessKey: "bad" },
    { fetchImpl: undefined },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { endpoint: "https://other.invalid" },
    { descriptors: [] },
  ]) {
    assert.throws(() => create(d, () => {}, more), /r2_config_invalid/);
  }
  assert.throws(
    () =>
      create(d, () => {}, { descriptors: [{ ...d, objectKey: "arbitrary" }] }),
    /storage_descriptor_invalid/,
  );
  assert.throws(
    () => create(d, () => {}, { descriptors: [d, d] }),
    /r2_descriptor_duplicate/,
  );
  let calls = 0;
  const store = create(d, () => {
    calls++;
  });
  for (const key of [
    "",
    "../escape",
    d.objectKey + "?list-type=2",
    "other/" + d.objectKey,
  ]) {
    await rejectsCode(store.head(key), "r2_key_forbidden");
    await rejectsCode(store.get(key, getOptions(d)), "r2_key_forbidden");
    await rejectsCode(
      store.put(key, new Uint8Array(1), putOptions(d)),
      "r2_key_forbidden",
    );
  }
  assert.equal(calls, 0);
});

test("configuration, descriptor, PUT bytes and GET conditions stay pinned across awaits", async () => {
  const { descriptor: d, bytes } = await object(),
    input = structuredClone(d),
    calls = [];
  const config = {
    accountId: ACCOUNT,
    bucket: "the-shelf-books",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    descriptors: [input],
    clock: () => new Date(NOW),
    fetchImpl: async (url, req) => {
      calls.push({ url, req });
      return response(d, { body: req.method === "GET" ? stream(bytes) : null });
    },
  };
  const store = createR2ObjectStore(config);
  input.objectKey = "arbitrary";
  config.accountId = "d".repeat(32);
  config.secretAccessKey = "e".repeat(64);
  const copied = Uint8Array.from(bytes),
    pending = store.put(d.objectKey, copied, putOptions(d));
  copied.fill(0);
  await pending;
  assert.deepEqual(calls[0].req.body, bytes);
  const opts = getOptions(d),
    get = store.get(d.objectKey, opts);
  opts.ifMatch = '"changed"';
  assert.deepEqual(await consume(await get), Buffer.from(bytes));
  assert.ok(calls.every(({ url }) => url.includes(ACCOUNT)));
});

test("GET/PUT reject missing, extra, weak and mismatched conditions before fetch", async () => {
  const { descriptor: d, bytes } = await object();
  let calls = 0;
  const store = create(d, () => {
    calls++;
  });
  for (const options of [
    {},
    { maxBytes: d.sizeBytes, ifMatch: "*" },
    { ...getOptions(d), ifMatch: 'W/"weak"' },
    { ...getOptions(d), maxBytes: OBJECT_LIMIT + 1 },
    { ...getOptions(d), other: true },
  ])
    await rejectsCode(
      store.get(d.objectKey, options),
      "r2_get_options_invalid",
    );
  for (const options of [
    {},
    { ...putOptions(d), ifNoneMatch: undefined },
    { ...putOptions(d), sha256: "0".repeat(64) },
    { ...putOptions(d), contentType: "text/plain" },
    { ...putOptions(d), retry: true },
  ])
    await rejectsCode(
      store.put(d.objectKey, bytes, options),
      "r2_put_options_invalid",
    );
  await rejectsCode(
    store.put(d.objectKey, new Uint8Array(d.sizeBytes), putOptions(d)),
    "object_hash_mismatch",
  );
  await rejectsCode(
    store.put(d.objectKey, new Uint8Array(OBJECT_LIMIT + 1), putOptions(d)),
    "storage_bytes_invalid",
  );
  assert.equal(calls, 0);
});

for (const status of [
  301, 302, 307, 308, 400, 401, 403, 409, 412, 429, 500, 503,
]) {
  test(`HTTP ${status} fails closed and never retries`, async () => {
    const { descriptor: d, bytes } = await object();
    let calls = 0;
    const store = create(d, async () => {
      calls++;
      return response(d, { status });
    });
    await rejectsCode(store.head(d.objectKey), "r2_request_failed");
    await rejectsCode(
      store.get(d.objectKey, getOptions(d)),
      "r2_request_failed",
    );
    await rejectsCode(
      store.put(d.objectKey, bytes, putOptions(d)),
      "r2_request_failed",
    );
    assert.equal(calls, 3);
  });
}

test("only a real HEAD 404 returns null; redirect responses and malformed response fail", async () => {
  const { descriptor: d, bytes } = await object();
  const missing = create(d, async () => response(d, { status: 404 }));
  assert.equal(await missing.head(d.objectKey), null);
  await rejectsCode(
    missing.get(d.objectKey, getOptions(d)),
    "r2_request_failed",
  );
  await rejectsCode(
    missing.put(d.objectKey, bytes, putOptions(d)),
    "r2_request_failed",
  );
  for (const rest of [
    { redirected: true, status: 404 },
    { url: "https://other.invalid" },
    { status: null },
  ]) {
    const store = create(d, async () => response(d, rest));
    await rejectsCode(store.head(d.objectKey), "r2_response_invalid");
  }
});

for (const headers of [
  { "content-length": "" },
  { "content-length": "0" },
  { "content-length": "20000001" },
  { "content-length": "0013" },
  { "x-amz-meta-sha256": "0".repeat(64) },
  { "content-type": "text/plain" },
  { "content-type": "application/pdf; charset=utf-8" },
  { etag: "" },
  { etag: 'W/"weak"' },
  { "content-encoding": "gzip" },
  { "content-range": "bytes 0-12/13" },
]) {
  test(`HEAD and GET reject malformed or mismatched identity ${JSON.stringify(headers)}`, async () => {
    const { descriptor: d, bytes } = await object();
    const store = create(d, async () =>
      response(d, { headers, body: stream(bytes) }),
    );
    await rejectsCode(store.head(d.objectKey), "r2_object_identity_mismatch");
    await rejectsCode(
      store.get(d.objectKey, getOptions(d)),
      "r2_object_identity_mismatch",
    );
  });
}

test("GET rejects returned ETag drift and missing stream; PUT requires response ETag", async () => {
  const { descriptor: d, bytes } = await object();
  await rejectsCode(
    create(d, async () => response(d, { headers: { etag: '"changed"' } })).get(
      d.objectKey,
      getOptions(d),
    ),
    "r2_object_identity_mismatch",
  );
  await rejectsCode(
    create(d, async () => response(d)).get(d.objectKey, getOptions(d)),
    "r2_stream_required",
  );
  await rejectsCode(
    create(d, async () => response(d, { headers: { etag: "" } })).put(
      d.objectKey,
      bytes,
      putOptions(d),
    ),
    "r2_object_identity_mismatch",
  );
});

test("transport and header errors never expose injected secrets, even via StorageError", async () => {
  const { descriptor: d } = await object();
  for (const error of [new Error(SECRET), new StorageError(SECRET)]) {
    await rejectsCode(
      create(d, () => {
        throw error;
      }).head(d.objectKey),
      "r2_transport_unknown",
    );
    await rejectsCode(
      create(d, async () => ({
        status: 200,
        headers: {
          get() {
            throw error;
          },
        },
      })).head(d.objectKey),
      "r2_response_invalid",
    );
  }
});

for (const mode of ["overlong", "truncated", "wrong-type", "body-error"]) {
  test(`GET rejects ${mode}, cancels source, aborts fetch and never retries`, async () => {
    const { descriptor: d, bytes } = await object();
    let cancelled = false,
      signal,
      calls = 0;
    const body = new ReadableStream(
      {
        pull(c) {
          if (mode === "body-error") throw new Error(SECRET);
          c.enqueue(
            mode === "wrong-type"
              ? "secret"
              : mode === "overlong"
                ? new Uint8Array(d.sizeBytes + 1)
                : bytes.slice(0, -1),
          );
          if (mode === "truncated") c.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const store = create(d, async (_, req) => {
      signal = req.signal;
      calls++;
      return response(d, { body });
    });
    await rejectsCode(
      consume(await store.get(d.objectKey, getOptions(d))),
      mode === "body-error" ? "r2_body_unavailable" : "r2_body_size_mismatch",
    );
    if (["overlong", "wrong-type"].includes(mode)) assert.ok(cancelled);
    assert.ok(signal.aborted);
    assert.equal(calls, 1);
  });
}

test("GET rejects actual bytes that contradict valid metadata and ETag", async () => {
  const { descriptor: d, bytes } = await object();
  const wrong = Uint8Array.from(bytes);
  wrong[0] ^= 1;
  let signal;
  const store = create(d, async (_, req) => {
    signal = req.signal;
    return response(d, { body: stream(wrong) });
  });
  await rejectsCode(
    consume(await store.get(d.objectKey, getOptions(d))),
    "r2_body_hash_mismatch",
  );
  assert.ok(signal.aborted);
});

test("GET hash spans chunks and pins bytes against producer and consumer mutation", async () => {
  const { descriptor: d, bytes } = await object();
  let offset = 0;
  const reusable = new Uint8Array(1);
  const body = new ReadableStream(
    {
      pull(c) {
        if (offset === bytes.length) return c.close();
        reusable[0] = bytes[offset++];
        c.enqueue(reusable);
      },
    },
    { highWaterMark: 0 },
  );
  const reader = (
    await create(d, async () => response(d, { body })).get(
      d.objectKey,
      getOptions(d),
    )
  ).getReader();
  for (const byte of bytes) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    assert.equal(value[0], byte);
    reusable.fill(0);
    value.fill(0);
  }
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test("GET preserves backpressure, consumer cancel aborts and never awaits hung cancellation", async () => {
  const { descriptor: d } = await object();
  let pulls = 0,
    cancelled = false,
    signal;
  const body = new ReadableStream(
    {
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const store = create(d, async (_, req) => {
    signal = req.signal;
    return response(d, { body });
  });
  const result = await store.get(d.objectKey, getOptions(d));
  assert.equal(pulls, 0);
  const reader = result.getReader();
  await reader.read();
  assert.equal(pulls, 1);
  await reader.cancel();
  assert.ok(cancelled);
  assert.ok(signal.aborted);
});

test("fetch deadline is bounded even when transport ignores abort; late bodies are cancelled", async () => {
  const { descriptor: d } = await object();
  let resolveFetch,
    signal,
    cancelled = false,
    calls = 0;
  const store = create(
    d,
    (_, req) => {
      signal = req.signal;
      calls++;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
    { timeoutMs: 10 },
  );
  await rejectsCode(store.head(d.objectKey), "r2_deadline_exceeded");
  assert.ok(signal.aborted);
  assert.equal(calls, 1);
  resolveFetch(
    response(d, {
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(cancelled);
});

test("GET deadline includes idle time, stalled read and stalled cancellation", async () => {
  const { descriptor: d } = await object();
  for (const read of [true, false]) {
    let signal,
      cancelled = false;
    const body = new ReadableStream(
      {
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const store = create(
      d,
      async (_, req) => {
        signal = req.signal;
        return response(d, { body });
      },
      { timeoutMs: 10 },
    );
    const result = await store.get(d.objectKey, getOptions(d));
    if (!read) await new Promise((resolve) => setTimeout(resolve, 25));
    await rejectsCode(consume(result), "r2_deadline_exceeded");
    assert.ok(signal.aborted);
    assert.ok(cancelled);
  }
});

function snapshot(scope) {
  const value = {
    schemaVersion: 1,
    scope,
    databaseId: identity.legacyDatabases[scope],
    accountId: ACCOUNT,
    bucket: "the-shelf-books",
    frozen: {
      writesStopped: true,
      freezeId: "synthetic-r2-freeze",
      frozenAt: NOW - 1000,
      snapshotAt: NOW,
    },
    complete: true,
    counts: { reservations: 0, registry: 0 },
    ledger: { committedBytes: 0, reservedBytes: 0 },
    reservations: [],
    registry: [],
  };
  return { ...value, sha256: bytesSha256(JSON.stringify(value)) };
}
const evidence = {
  schemaVersion: 1,
  source: "cloudflare-account-aggregate",
  targetAccount: ACCOUNT,
  accountMatch: true,
  completeCoverage: true,
  plan: "free",
  storageClass: "Standard",
  storedBytes: 0,
  observedAt: new Date(NOW).toISOString(),
  billingPeriod: "2026-10",
  classAOperations: 0,
  classBOperations: 0,
};
async function authorityFixture(t, { reopenable = false } = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-r2-adapter-test-")),
  );
  await fs.chmod(root, 0o700);
  const config = {
    filename: path.join(root, "authority.sqlite"),
    privateRoot: root,
    identity,
    clock: () => NOW,
  };
  let authority = new StorageAuthority(config);
  t.after(async () => {
    authority.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  authority.migrateFrozen(identity, [
    snapshot("check"),
    snapshot("production"),
  ]);
  return reopenable
    ? {
        authority,
        reopen() {
          authority.close();
          authority = new StorageAuthority(config);
          return authority;
        },
      }
    : authority;
}
for (const lost of [false, true]) {
  test(`real SQLite authority → signed single PUT → full HEAD GET HEAD reconciliation${lost ? " after lost response" : ""}`, async (t) => {
    const authority = await authorityFixture(t),
      prepared = await object(),
      { descriptor: d, bytes } = prepared;
    let uploaded = false,
      putCalls = 0;
    const calls = [];
    const store = create(d, async (url, req) => {
      await verifySignature(url, req);
      calls.push(req.method);
      if (req.method === "HEAD")
        return response(d, { status: uploaded ? 200 : 404 });
      if (req.method === "PUT") {
        putCalls++;
        uploaded = true;
        if (lost) throw new Error(SECRET);
        return response(d);
      }
      return response(d, { body: stream(bytes) });
    });
    const request = () =>
      syncObject({
        authority,
        identity,
        reservationId: "reservation-one",
        descriptor: d,
        bytes,
        evidence,
        store,
      });
    if (lost) {
      await rejectsCode(request(), "r2_transport_unknown");
      assert.equal(
        authority.get(identity, "reservation-one").state,
        "uncertain",
      );
      assert.equal(authority.inspect(identity).reservedBytes, bytes.length);
      assert.equal(authority.registry(identity, "original").length, 0);
    }
    const result = await request();
    assert.equal(result.state, "confirmed");
    assert.equal(putCalls, 1);
    assert.equal(authority.inspect(identity).reservedBytes, 0);
    assert.equal(authority.inspect(identity).committedBytes, bytes.length);
    assert.equal(authority.registry(identity, "original").length, 1);
    assert.deepEqual(calls, ["HEAD", "PUT", "HEAD", "GET", "HEAD"]);
    await request();
    assert.equal(putCalls, 1);
  });
}

test("unknown PUT 5xx retains full SQLite budget and subsequent sync never retransmits", async (t) => {
  const authority = await authorityFixture(t),
    { descriptor: d, bytes } = await object();
  let puts = 0;
  const store = create(d, async (_, req) => {
    if (req.method === "PUT") {
      puts++;
      return response(d, { status: 503 });
    }
    return response(d, { status: 404 });
  });
  const run = () =>
    syncObject({
      authority,
      identity,
      reservationId: "reservation-unknown",
      descriptor: d,
      bytes,
      evidence,
      store,
    });
  await rejectsCode(run(), "r2_request_failed");
  assert.equal(
    authority.get(identity, "reservation-unknown").state,
    "uncertain",
  );
  const result = await run();
  assert.equal(result.state, "uncertain");
  assert.equal(puts, 1);
  assert.equal(authority.inspect(identity).reservedBytes, bytes.length);
  assert.equal(authority.registry(identity, "original").length, 0);
});

for (const mode of ["hash-mismatch", "missing-eof", "changed-final-head"]) {
  test(`SQLite registration stays disabled on ${mode} after a successful PUT`, async (t) => {
    const authority = await authorityFixture(t),
      { descriptor: d, bytes } = await object();
    let uploaded = false,
      puts = 0,
      heads = 0;
    const store = create(
      d,
      async (_, req) => {
        if (req.method === "PUT") {
          puts++;
          uploaded = true;
          return response(d);
        }
        if (req.method === "HEAD") {
          heads++;
          return response(d, {
            status: uploaded ? 200 : 404,
            headers:
              mode === "changed-final-head" && heads >= 3
                ? { etag: '"changed"' }
                : {},
          });
        }
        const data = Uint8Array.from(bytes);
        if (mode === "hash-mismatch") data[0] ^= 1;
        return response(d, {
          body:
            mode === "missing-eof"
              ? new ReadableStream({
                  start(c) {
                    c.enqueue(data);
                  },
                })
              : stream(data),
        });
      },
      { timeoutMs: mode === "missing-eof" ? 10 : 60_000 },
    );
    await rejectsCode(
      syncObject({
        authority,
        identity,
        reservationId: "invalid-object",
        descriptor: d,
        bytes,
        evidence,
        store,
      }),
      mode === "hash-mismatch"
        ? "r2_body_hash_mismatch"
        : mode === "missing-eof"
          ? "r2_deadline_exceeded"
          : "object_changed",
    );
    assert.equal(puts, 1);
    assert.equal(authority.get(identity, "invalid-object").state, "uncertain");
    assert.equal(authority.inspect(identity).reservedBytes, bytes.length);
    assert.equal(authority.inspect(identity).committedBytes, 0);
    assert.equal(authority.registry(identity, "original").length, 0);
  });
}

for (const scope of ["check", "production"]) {
  for (const format of ["PDF", "EPUB", "MOBI", "AZW", "AZW3"]) {
    test(`original descriptor fixes ${scope}/${format} key and MIME`, async () => {
      const { descriptor: d, bytes } = await object({ scope, format });
      const store = create(d, async (url, req) => {
        assert.ok(
          url.includes(scope === "check" ? "/cf03-check/" : "/books/cf03/"),
        );
        assert.ok(url.endsWith("." + format.toLowerCase()));
        assert.equal(req.headers["content-type"], objectContentType(d));
        await verifySignature(url, req);
        return response(d);
      });
      await store.put(d.objectKey, bytes, putOptions(d));
    });
  }
}

function preparedFixture(format, scope) {
  const source = {
    fileId: "file_1234567890abcdef",
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
    kind: "prepared-text",
    scope,
    fileId: source.fileId,
    bookId: source.bookId,
    format: "JSON",
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
for (const format of ["PDF", "EPUB"]) {
  for (const scope of ["check", "production"]) {
    test(`strict ${format} prepared-text ${scope} reaches SQLite text registry through signed transport`, async (t) => {
      const authority = await authorityFixture(t);
      const { descriptor: d, bytes } = await prepareObject(
        preparedFixture(format, scope),
      );
      let uploaded = false;
      const store = create(d, async (url, req) => {
        await verifySignature(url, req);
        assert.ok(url.includes(`/prepared-text/v1/${scope}/`));
        if (req.method === "HEAD")
          return response(d, { status: uploaded ? 200 : 404 });
        if (req.method === "PUT") {
          assert.equal(req.headers["content-type"], "application/json");
          uploaded = true;
          return response(d);
        }
        return response(d, { body: stream(bytes) });
      });
      const result = await syncObject({
        authority,
        identity,
        reservationId: "prepared-one",
        descriptor: d,
        bytes,
        evidence,
        store,
      });
      assert.equal(result.state, "confirmed");
      assert.equal(authority.registry(identity, "original").length, 0);
      assert.equal(authority.registry(identity, "prepared-text").length, 1);
    });
  }
}

test("PUT independently validates prepared-text contract before sending any request", async () => {
  const valid = await prepareObject(preparedFixture("PDF", "production"));
  const broken = new TextEncoder().encode('{"private":true}\n'),
    d = {
      ...valid.descriptor,
      sizeBytes: broken.length,
      sha256: bytesSha256(broken),
      objectKey: valid.descriptor.objectKey.replace(
        valid.descriptor.sha256,
        bytesSha256(broken),
      ),
    };
  let calls = 0;
  const store = create(d, async () => {
    calls++;
  });
  await assert.rejects(
    store.put(d.objectKey, broken, putOptions(d)),
    /prepared_text_invalid/,
  );
  assert.equal(calls, 0);
});

test("GET chunk count is bounded even for empty chunks", async () => {
  const { descriptor: d } = await object();
  let reads = 0,
    cancelled = false;
  const body = new ReadableStream(
    {
      pull(c) {
        reads++;
        c.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const store = create(d, async () => response(d, { body }));
  await rejectsCode(
    consume(await store.get(d.objectKey, getOptions(d))),
    "r2_body_chunk_limit",
  );
  assert.equal(reads, 100_001);
  assert.ok(cancelled);
});

for (const outcome of ["timeout", "lost", "response-error"]) {
  test(`PUT ${outcome} leaves full SQLite reservation and can only reconcile after restart`, async (t) => {
    const fixture = await authorityFixture(t, { reopenable: true }),
      { descriptor: d, bytes } = await object();
    let authority = fixture.authority;
    let puts = 0,
      putSignal;
    const store = create(
      d,
      async (_, req) => {
        if (req.method !== "PUT") return response(d, { status: 404 });
        puts++;
        putSignal = req.signal;
        if (outcome === "timeout") return new Promise(() => {});
        if (outcome === "lost") throw new Error(SECRET);
        return {
          status: 200,
          headers: {
            get() {
              throw new Error(SECRET);
            },
          },
        };
      },
      { timeoutMs: 10 },
    );
    const run = () =>
      syncObject({
        authority,
        identity,
        reservationId: "unknown-one",
        descriptor: d,
        bytes,
        evidence,
        store,
      });
    await assert.rejects(
      run(),
      (error) =>
        error instanceof StorageError && !String(error).includes(SECRET),
    );
    assert.equal(authority.get(identity, "unknown-one").state, "uncertain");
    assert.equal(authority.inspect(identity).reservedBytes, bytes.length);
    assert.equal(authority.registry(identity, "original").length, 0);
    authority = fixture.reopen();
    assert.equal(authority.get(identity, "unknown-one").state, "uncertain");
    assert.equal(authority.get(identity, "unknown-one").putAttempted, true);
    assert.equal(authority.inspect(identity).reservedBytes, bytes.length);
    await run();
    assert.equal(puts, 1);
    if (outcome === "timeout") assert.ok(putSignal.aborted);
  });
}
