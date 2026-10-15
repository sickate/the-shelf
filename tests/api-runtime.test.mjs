import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveApi,
  fetchAuthorizedFile,
  runtimeMessages,
} from "../src/lib/api-runtime.mjs";

test("disabled, local and explicit same-origin API modes remain distinct", () => {
  assert.equal(
    resolveApi({
      mode: "disabled",
      configured: "https://other.example",
      hostname: "localhost",
    }).enabled,
    false,
  );
  assert.equal(
    resolveApi({ hostname: "localhost" }).base,
    "http://127.0.0.1:8787",
  );
  assert.equal(resolveApi({ hostname: "example.com" }).enabled, false);
  assert.deepEqual(
    resolveApi({ mode: "same-origin", origin: "https://the-shelf.example" }),
    {
      enabled: true,
      base: "https://the-shelf.example",
      scheme: "owner-access-key",
    },
  );
});
const expiry = (n) => new Date(n).toISOString();
async function scenario(
  status,
  { age = 300_000, advance = 0, secondStatus = 200 } = {},
) {
  let calls = 0,
    reads = 0,
    clock = 0;
  const options = {
    api: async () => ({
      url: `https://r2.invalid/${++calls}`,
      mode: "r2",
      expiresAt: expiry(calls === 1 ? age : 300_000),
      format: "PDF",
    }),
    resolveUrl: (u) => u,
    now: () => clock,
    fetcher: async (_url, opts) => {
      assert.equal(opts.credentials, "omit");
      assert.equal(opts.referrerPolicy, "no-referrer");
      clock += advance;
      return new Response("bytes", {
        status: ++reads === 1 ? status : secondStatus,
        headers: { "content-type": "application/pdf" },
      });
    },
  };
  let result, error;
  try {
    result = await fetchAuthorizedFile("f1", options);
  } catch (e) {
    error = e;
  }
  return { calls, reads, result, error };
}
test("expires before fetch gets one fresh URL; healthy URL is fetched once", async () => {
  assert.equal((await scenario(200, { age: 20_000 })).calls, 2);
  assert.equal((await scenario(200)).calls, 1);
});
test("expired R2 403 refreshes once and failures do not loop", async () => {
  const pass = await scenario(403, { advance: 280_000 });
  assert.equal(pass.calls, 2);
  assert.equal(pass.reads, 2);
  assert.ok(pass.result);
  const fail = await scenario(403, { advance: 280_000, secondStatus: 403 });
  assert.equal(fail.calls, 2);
  assert.equal(fail.reads, 2);
  assert.match(fail.error.message, /403/);
});
test("policy, login, rate, unavailable and revoked file errors never refresh", async () => {
  for (const code of [401, 403, 410, 429, 503]) {
    const r = await scenario(code);
    assert.equal(r.calls, 1);
    assert.equal(r.reads, 1);
    assert.ok(r.error);
  }
});

test("cloud errors describe an access key and online service, retaining local password hints only for local mode", () => {
  const cloud = runtimeMessages(
    resolveApi({ mode: "same-origin", origin: "https://the-shelf.example" }),
  );
  assert.match(cloud.invalidCredentials, /访问密钥/);
  assert.doesNotMatch(
    cloud.invalidCredentials + cloud.unreachable,
    /密码|127\.0\.0\.1|localhost|PUBLIC_SHELF_API_URL/,
  );
  const local = runtimeMessages(resolveApi({ hostname: "localhost" }));
  assert.match(local.invalidCredentials, /密码/);
  assert.match(local.unreachable, /127\.0\.0\.1/);
});
