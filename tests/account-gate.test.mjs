import test from "node:test";
import assert from "node:assert/strict";
import { accountGate } from "../src/lib/account-gate.mjs";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(loadConfig, loadSession) {
  const fieldset = {},
    retryButton = {},
    states = [],
    errors = [];
  const gate = accountGate({
    fieldset,
    retryButton,
    loadConfig,
    loadSession,
    onReady: (c, s) => states.push(s.authenticated),
    onFailure: (e) => errors.push(e),
  });
  return { gate, fieldset, retryButton, states, errors };
}

test("slow initialization blocks authentication writes until both startup responses have settled", async () => {
  const config = deferred(),
    session = deferred();
  let csrf = "initial",
    writes = 0;
  const f = fixture(
    () => config.promise,
    async () => {
      const data = await session.promise;
      csrf = data.csrfToken;
      return data;
    },
  );
  const starting = f.gate.initialize();
  config.resolve({ apiConfigured: true, authScheme: "owner-access-key" });
  await turn();
  assert.equal(f.fieldset.disabled, true);
  await f.gate.run(() => writes++);
  assert.equal(writes, 0);
  assert.deepEqual(f.states, []);
  session.resolve({ authenticated: false, csrfToken: null });
  await starting;
  await f.gate.run(() => {
    writes++;
    csrf = "login-csrf";
    f.states.push(true);
  });
  await turn();
  assert.equal(writes, 1);
  assert.equal(csrf, "login-csrf");
  assert.deepEqual(f.states, [false, true]);
  assert.equal(f.fieldset.disabled, false);
});

test("partial startup failure waits for the outstanding session and can recover through explicit retry", async () => {
  const old = deferred();
  let attempt = 0,
    sessionCalls = 0;
  const f = fixture(
    () =>
      ++attempt === 1
        ? Promise.reject(new Error("fixture unavailable"))
        : { apiConfigured: true },
    () => {
      sessionCalls++;
      return attempt === 1
        ? old.promise
        : { authenticated: true, csrfToken: "restored" };
    },
  );
  const starting = f.gate.initialize();
  await turn();
  assert.equal(f.retryButton.disabled, true);
  assert.equal(f.errors.length, 0);
  await f.gate.initialize();
  assert.equal(sessionCalls, 1);
  old.resolve({ authenticated: false, csrfToken: null });
  await starting;
  assert.equal(f.gate.ready, false);
  assert.equal(f.fieldset.disabled, true);
  assert.equal(f.retryButton.hidden, false);
  assert.equal(f.retryButton.disabled, false);
  assert.deepEqual(f.states, []);
  await f.gate.initialize();
  assert.equal(f.gate.ready, true);
  assert.deepEqual(f.states, [true]);
  assert.equal(f.retryButton.hidden, true);
});

test("unknown session payload never unlocks actions or announces anonymous success", async () => {
  const f = fixture(
    () => ({ apiConfigured: true }),
    () => ({}),
  );
  await f.gate.initialize();
  assert.equal(f.fieldset.disabled, true);
  assert.deepEqual(f.states, []);
  assert.equal(f.errors.length, 1);
});

test("authentication actions serialize with retry initialization and other actions", async () => {
  let startups = 0;
  const f = fixture(
    () => {
      startups++;
      return { apiConfigured: true };
    },
    () => ({ authenticated: true, csrfToken: "token" }),
  );
  await f.gate.initialize();
  const pending = deferred();
  let writes = 0;
  const first = f.gate.run(async () => {
    writes++;
    await pending.promise;
    f.states.push(false);
  });
  await f.gate.initialize();
  await f.gate.run(() => writes++);
  assert.equal(startups, 1);
  assert.equal(writes, 1);
  assert.equal(f.fieldset.disabled, true);
  pending.resolve();
  await first;
  assert.equal(f.fieldset.disabled, false);
  assert.deepEqual(f.states, [true, false]);
});
