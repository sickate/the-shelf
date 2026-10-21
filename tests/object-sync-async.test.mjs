import test from "node:test";
import assert from "node:assert/strict";
import { syncObject } from "../server/object-sync.mjs";
import { prepareObject, StorageError } from "../server/storage-authority.mjs";

async function fixture() {
  const identity = { accountId: "test-account", bucket: "the-shelf-books" };
  const object = await prepareObject({
    kind: "original",
    scope: "production",
    fileId: "file_one",
    bookId: "book_one",
    format: "PDF",
    bytes: new TextEncoder().encode("synthetic book"),
  });
  const events = [];
  const authority = {
    async reserve() {
      return { state: "reserved", putAttempted: false };
    },
    async claimPut() {
      events.push("claim");
    },
    async markUncertain() {
      events.push("uncertain");
    },
    async reconcile() {
      events.push("reconcile");
      return { state: "confirmed" };
    },
  };
  const store = {
    target: identity,
    async head() {
      return null;
    },
    async get() {
      assert.fail("not called");
    },
    async put() {
      events.push("put");
    },
  };
  return {
    events,
    authority,
    store,
    input: {
      identity,
      authority,
      store,
      ...object,
      reservationId: "one",
      evidence: {},
    },
  };
}

test("asynchronous durable claim must finish before the only PUT", async () => {
  const f = await fixture();
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  f.authority.claimPut = async () => {
    entered();
    await new Promise((r) => {
      release = r;
    });
    f.events.push("claim-durable");
  };
  const operation = syncObject(f.input);
  await started;
  assert.deepEqual(f.events, []);
  release();
  assert.equal((await operation).state, "confirmed");
  assert.deepEqual(f.events, ["claim-durable", "put", "reconcile"]);
});

test("delayed rejected or unknown claim sends zero PUT and waits for uncertain persistence", async () => {
  for (const failure of [
    new StorageError("storage_put_already_claimed"),
    new Error("private upstream error"),
  ]) {
    const f = await fixture();
    let release;
    f.authority.claimPut = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      throw failure;
    };
    let entered;
    const marking = new Promise((r) => {
      entered = r;
    });
    f.authority.markUncertain = async () => {
      entered();
      await new Promise((r) => {
        release = r;
      });
      f.events.push("uncertain-durable");
    };
    let settled = false;
    const result = syncObject(f.input).catch((e) => {
      settled = true;
      return e;
    });
    await marking;
    assert.equal(settled, false);
    assert.deepEqual(f.events, []);
    release();
    assert.equal((await result).code, failure.code ?? "object_sync_unknown");
    assert.deepEqual(f.events, ["uncertain-durable"]);
  }
});

test("asynchronous uncertainty write failure is contained and original PUT outcome retained", async () => {
  const f = await fixture();
  f.store.put = async () => {
    f.events.push("put");
    throw new StorageError("object_put_unknown");
  };
  f.authority.markUncertain = async () => {
    await Promise.resolve();
    throw new Error("private DB fault");
  };
  await assert.rejects(syncObject(f.input), { code: "object_put_unknown" });
  assert.deepEqual(f.events, ["claim", "put"]);
});
