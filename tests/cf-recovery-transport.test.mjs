import test from "node:test";
import assert from "node:assert/strict";
import {
  observedRecoveryResponse,
  RECOVERY_TRANSPORT_LIMITS,
} from "../scripts/cf-recovery-transport.mjs";
const URL = "https://api.cloudflare.com/client/v4/fixed-project-test";
const unknown = (e) => e.code === "recovery_transport_unknown";
const options = (observations, extra = {}) => ({
  observe: async (value) => observations.push(value),
  ...extra,
});
test("successful response is unchanged while observations contain only status and numeric codes", async () => {
  const observations = [],
    input = {
      success: true,
      errors: null,
      result: { binding: "synthetic-private-value" },
    };
  const response = await observedRecoveryResponse(
    async (_url, init) => {
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json(input);
    },
    URL,
    {},
    options(observations),
  );
  assert.deepEqual(await response.json(), input);
  assert.deepEqual(observations, [
    { httpStatus: 200 },
    { cloudflareErrorCodes: [] },
  ]);
});
for (const status of [201, 400, 500])
  test(`HTTP ${status} preserves status and only numeric API codes before rejection, without retry`, async () => {
    const observations = [];
    let calls = 0;
    await assert.rejects(
      observedRecoveryResponse(
        async () => {
          calls++;
          return Response.json(
            {
              success: status === 201,
              errors: [
                {
                  code: 10057,
                  message: "synthetic-private-value",
                  error_chain: [{ code: 10058 }],
                },
                { code: "synthetic-private-value" },
                { code: "10059" },
                { code: -1 },
              ],
              result: { private: "synthetic-private-value" },
            },
            { status, headers: { "cf-ray": "synthetic-private-value" } },
          );
        },
        URL,
        { method: "POST" },
        options(observations),
      ),
      unknown,
    );
    assert.equal(calls, 1);
    assert.deepEqual(observations, [
      { httpStatus: status },
      { cloudflareErrorCodes: [10057] },
    ]);
  });
test("error-code observation is bounded and does not decide business envelope success", async () => {
  const observations = [],
    input = {
      success: false,
      errors: Array.from({ length: 40 }, (_, i) => ({ code: 10000 + i })),
    },
    result = await observedRecoveryResponse(
      async () => Response.json(input),
      URL,
      {},
      options(observations),
    );
  assert.deepEqual(await result.json(), input);
  assert.equal(observations[1].cloudflareErrorCodes.length, 32);
});
test("only the explicit asset-created option accepts HTTP201", async () => {
  const observations = [];
  const result = await observedRecoveryResponse(
    async () => Response.json({ success: true, result: {} }, { status: 201 }),
    URL,
    {},
    options(observations, { allowAssetCreated: true }),
  );
  assert.equal(result.status, 201);
  assert.deepEqual(observations, [
    { httpStatus: 201 },
    { cloudflareErrorCodes: [] },
  ]);
  await assert.rejects(
    observedRecoveryResponse(
      async () => Response.json({ success: true, result: {} }, { status: 202 }),
      URL,
      {},
      options([], { allowAssetCreated: true }),
    ),
    unknown,
  );
});
for (const kind of [
  "content-type",
  "oversize-header",
  "oversize-body",
  "malformed-json",
  "redirect",
])
  test(`${kind} retains only status and rejects without raw diagnostics`, async () => {
    const observations = [];
    let cancelled = false;
    const response =
      kind === "oversize-body"
        ? new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(600_000));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          )
        : new Response(kind === "malformed-json" ? "private invalid" : "{}", {
            status: 400,
            headers: {
              "Content-Type":
                kind === "content-type" ? "text/plain" : "application/json",
              ...(kind === "oversize-header"
                ? { "Content-Length": "1048577" }
                : {}),
            },
          });
    if (kind === "redirect")
      Object.defineProperty(response, "redirected", { value: true });
    await assert.rejects(
      observedRecoveryResponse(
        async () => response,
        URL,
        {},
        options(observations),
      ),
      unknown,
    );
    assert.deepEqual(observations, [{ httpStatus: 400 }]);
    if (kind === "oversize-body") assert.equal(cancelled, true);
  });
test("deadline covers ignored fetch and ignored body reads, retaining status if received", async () => {
  for (const phase of ["fetch", "body"]) {
    const observations = [];
    let calls = 0,
      cancelled = false;
    await assert.rejects(
      observedRecoveryResponse(
        async () => {
          calls++;
          if (phase === "fetch") return new Promise(() => {});
          return new Response(
            new ReadableStream({
              pull: () => new Promise(() => {}),
              cancel() {
                cancelled = true;
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        },
        URL,
        {},
        options(observations, { timeoutMs: 10 }),
      ),
      unknown,
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      observations,
      phase === "fetch" ? [] : [{ httpStatus: 400 }],
    );
    if (phase === "body") assert.equal(cancelled, true);
  }
});
test("transport limits remain fixed", () => {
  assert.deepEqual(RECOVERY_TRANSPORT_LIMITS, {
    timeoutMs: 30_000,
    responseBytes: 1_048_576,
    responseChunks: 4096,
    errorCodes: 32,
  });
});
