import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SAMPLER_OBSERVABILITY_WRANGLER_VERSION,
  validateSamplerObservationSettings,
} from "../scripts/cf-cpu-sampler-manager.mjs";
const contract = { wranglerVersion: "4.151.0" };
const closed = () => ({ logpush: false, tail_consumers: [] });
const explicit = () => ({
  ...closed(),
  observability: {
    enabled: false,
    logs: { enabled: false },
    traces: { enabled: false },
  },
});

test("whole omitted remote observability means disabled only under the exact pinned version", () => {
  const settings = closed(),
    copy = structuredClone(settings);
  const result = validateSamplerObservationSettings(settings, contract);
  assert.equal(result.disabled, true);
  assert.equal(result.observabilitySource, "pinned-remote-default");
  assert.deepEqual(result.observability, {
    enabled: false,
    logs: { enabled: false },
    traces: { enabled: false },
  });
  assert.deepEqual(settings, copy);
  for (const version of [
    "4.150.0",
    "4.151.1",
    "4.152.0",
    "latest",
    undefined,
    null,
    4151,
  ])
    assert.throws(
      () =>
        validateSamplerObservationSettings(settings, {
          wranglerVersion: version,
        }),
      /observation_contract_version_mismatch/,
    );
  assert.throws(
    () => validateSamplerObservationSettings(settings),
    /observation_contract_version_mismatch/,
  );
  assert.throws(
    () =>
      validateSamplerObservationSettings(settings, {
        ...contract,
        allowEnabled: true,
      }),
    /observation_contract_version_mismatch/,
  );
});
test("explicit disabled objects accept known inactive metadata without mutation", () => {
  for (const observability of [
    { enabled: false },
    { enabled: false, logs: { enabled: false } },
    { enabled: false, traces: { enabled: false } },
    {
      enabled: false,
      head_sampling_rate: 1,
      redact_query_string: false,
      logs: {
        enabled: false,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true,
      },
      traces: { enabled: false, persist: true, head_sampling_rate: 0 },
    },
  ]) {
    const settings = { ...closed(), observability },
      copy = structuredClone(settings);
    const result = validateSamplerObservationSettings(settings, contract);
    assert.equal(result.observabilitySource, "explicit-disabled");
    assert.equal(result.disabled, true);
    assert.deepEqual(settings, copy);
  }
});
test("null, malformed or explicitly unknown observability never uses omission defaults", () => {
  for (const observability of [
    null,
    undefined,
    true,
    false,
    0,
    "false",
    [],
    new Date(),
    {},
    { enabled: undefined },
    { enabled: null },
    { enabled: "false" },
    { enabled: false, logs: null },
    { enabled: false, logs: undefined },
    { enabled: false, logs: [] },
    { enabled: false, logs: false },
    { enabled: false, logs: {} },
    { enabled: false, logs: { enabled: "false" } },
    { enabled: false, traces: null },
    { enabled: false, traces: [] },
    { enabled: false, traces: {} },
    { enabled: false, traces: { enabled: 0 } },
    { enabled: false, head_sampling_rate: null },
    { enabled: false, head_sampling_rate: NaN },
    { enabled: false, head_sampling_rate: Infinity },
    { enabled: false, head_sampling_rate: -1 },
    { enabled: false, head_sampling_rate: 2 },
    { enabled: false, redact_query_string: "false" },
    { enabled: false, logs: { enabled: false, persist: null } },
    { enabled: false, logs: { enabled: false, invocation_logs: "false" } },
    { enabled: false, traces: { enabled: false, head_sampling_rate: "0" } },
    { enabled: false, new_feature: { enabled: false } },
  ])
    assert.throws(
      () =>
        validateSamplerObservationSettings(
          { ...closed(), observability },
          contract,
        ),
      /observation_state_unknown_or_enabled/,
    );
});
test("every enabled flag or unknown logpush/tail-consumer state rejects safely", () => {
  for (const observability of [
    { enabled: true },
    { enabled: false, logs: { enabled: true } },
    { enabled: false, traces: { enabled: true } },
    { enabled: false, new_feature: { enabled: true } },
  ])
    assert.throws(
      () =>
        validateSamplerObservationSettings(
          { ...closed(), observability },
          contract,
        ),
      /observation_state_unknown_or_enabled/,
    );
  for (const logpush of [undefined, null, true, 0, "false", {}])
    assert.throws(
      () =>
        validateSamplerObservationSettings(
          { ...explicit(), logpush },
          contract,
        ),
      /observation_state_unknown_or_enabled/,
    );
  for (const tail_consumers of [
    undefined,
    null,
    {},
    false,
    "[]",
    [{ service: "PRIVATE-WORKER", url: "PRIVATE-BEARER" }],
  ])
    assert.throws(
      () =>
        validateSamplerObservationSettings(
          { ...explicit(), tail_consumers },
          contract,
        ),
      (error) =>
        String(error).includes("observation_state_unknown_or_enabled") &&
        !String(error).includes("PRIVATE"),
    );
  for (const settings of [
    null,
    undefined,
    [],
    new Date(),
    false,
    "secret",
    {},
    { tail_consumers: [] },
  ])
    assert.throws(() => validateSamplerObservationSettings(settings, contract));
});
test("checked-in and installed Wrangler versions stay pinned to the reviewed remote-default contract", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const installed = JSON.parse(
    await readFile(
      new URL("../node_modules/wrangler/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    lock.packages["node_modules/wrangler"].version,
    SAMPLER_OBSERVABILITY_WRANGLER_VERSION,
  );
  assert.equal(installed.version, SAMPLER_OBSERVABILITY_WRANGLER_VERSION);
  // Read source text only. Do not execute/import the Wrangler CLI to check it.
  const source = await readFile(
    new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function normalizeObservability(obs) {"),
    end = source.indexOf(
      "function normalizeRemoteConfigAsResolvedLocal",
      start,
    );
  const normalization = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(
    normalization,
    /const enabled = obs\?\.enabled === true \? true : false/,
  );
  assert.match(normalization, /traces: \{ enabled: false/);
  assert.match(
    normalization,
    /if \(!normalized\) \{\s*return fullObservabilityDefaults;/,
  );
  assert.match(
    source,
    /normalizedRemote\.observability = normalizeObservability\(/,
  );
  assert.match(
    source,
    /observability: worker\.observability \?\? \{ enabled: false \}/,
  );
});
