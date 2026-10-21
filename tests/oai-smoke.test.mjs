import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  callTask,
  taskRequest,
  TASK_INSTRUCTIONS,
  JobQueue,
} from "../server/jobs.mjs";
import { getConfig } from "../server/config.mjs";
import { runOaiSmoke, parseSmokeArgs } from "../scripts/oai-smoke.mjs";

const config = {
  aiBase: "https://synthetic.invalid/v1",
  aiKey: "secret-not-for-evidence",
  aiTimeout: 1000,
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const facts = "The lantern is blue. There are seven stones.";
async function root(t) {
  const location = await fs.mkdtemp(
    path.join(os.tmpdir(), "shelf-ai-offline-"),
  );
  await fs.chmod(location, 0o700);
  t.after(() => fs.rm(location, { recursive: true, force: true }));
  return location;
}
async function records(location, runId) {
  const directory = path.join(location, "ai-smoke", runId);
  const names = await fs.readdir(directory);
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await fs.readFile(path.join(directory, name), "utf8"),
      mode: (await fs.stat(path.join(directory, name))).mode & 0o777,
    })),
  );
}

test("request contract uses explicit instructions and format; kind is only a label", () => {
  const body = JSON.parse(taskRequest("材料", "author", "gpt-pro"));
  assert.deepEqual(Object.keys(body).sort(), [
    "input",
    "instructions",
    "kind",
    "model",
    "output_format",
  ]);
  assert.equal(body.instructions, TASK_INSTRUCTIONS);
  assert.match(body.instructions, /不声称浏览网页/);
  assert.equal(body.output_format, "text");
  assert.equal(body.kind, "research_summary");
  assert.equal(
    JSON.parse(
      taskRequest("x", "question", "gpt-luna", {
        instructions: "Return an object",
        outputFormat: "json_object",
      }),
    ).output_format,
    "json_object",
  );
});

test("character and model limits fail locally; unicode uses characters and full JSON is bounded", async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return json({ content: facts });
  };
  for (const value of ["", null, "x".repeat(500_001)])
    await assert.rejects(
      callTask(config, value, "question", "gpt-luna", fake),
      { code: "input_budget_exceeded" },
    );
  for (const options of [
    { instructions: "x".repeat(50_001) },
    { outputFormat: "xml" },
  ])
    await assert.rejects(
      callTask(config, "x", "question", "gpt-luna", fake, undefined, options),
      { code: "invalid_task" },
    );
  await assert.rejects(callTask(config, "x", "question", "gpt-6-luna", fake), {
    code: "invalid_task",
  });
  assert.equal(calls, 0);
  assert.ok(
    Buffer.byteLength(
      taskRequest("😀".repeat(500_000), "question", "gpt-luna", {
        instructions: "x".repeat(50_000),
      }),
    ) <
      32 * 1024 * 1024,
  );
  assert.equal(
    (await callTask(config, "x", "question", "gpt-luna", fake)).usage,
    null,
  );
});

test("adapter accepts only complete JSON success and preserves full content/unknown usage", async () => {
  const content = "first\n" + "z".repeat(20000) + "\nlast";
  assert.deepEqual(
    await callTask(config, "x", "question", "gpt-sol", async (url, request) => {
      assert.equal(url.href, "https://synthetic.invalid/v1/tasks");
      assert.equal(request.redirect, "error");
      return json({ content, usage: null });
    }),
    { content, usage: null },
  );
  const bad = [
    json({ content: facts }, 202),
    json(null),
    json({ content: "" }),
    json({ content: "ok", error: {} }),
    new Response("sensitive HTML"),
    new Response("{", { headers: { "content-type": "application/json" } }),
  ];
  for (const response of bad)
    await assert.rejects(
      callTask(config, "x", "question", "gpt-luna", async () => response),
      (error) =>
        /^upstream_/.test(error.code) && !error.message.includes("sensitive"),
    );
  await assert.rejects(
    callTask(
      config,
      "x",
      "question",
      "gpt-luna",
      async () => json({ content: "[]" }),
      undefined,
      { outputFormat: "json_object" },
    ),
    { code: "upstream_invalid_response" },
  );
  assert.equal(
    (
      await callTask(
        config,
        "x",
        "question",
        "gpt-luna",
        async () =>
          json({
            content: '{"ok":true}',
            usage: { input_tokens: 0, output_tokens: -1, arbitrary: "secret" },
          }),
        undefined,
        { outputFormat: "json_object" },
      )
    ).usage.input_tokens,
    0,
  );
});

test("adapter rejects redirects and enforces deadline through response consumption without retry", async () => {
  let calls = 0;
  for (const result of [
    new Error("sensitive"),
    json({ detail: "Codex service is busy" }, 503),
    json({ detail: "secret" }, 502),
    json({ detail: "secret" }, 401),
  ]) {
    await assert.rejects(
      callTask(config, "x", "question", "gpt-luna", async () => {
        calls++;
        if (result instanceof Error) throw result;
        return result;
      }),
      (error) =>
        !error.message.includes("secret") &&
        !error.message.includes("sensitive"),
    );
  }
  assert.equal(calls, 4);
  const response = json({ content: facts });
  Object.defineProperty(response, "redirected", { value: true });
  await assert.rejects(
    callTask(config, "x", "question", "gpt-luna", async () => response),
    { code: "upstream_uncertain" },
  );
  const hangingBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"content":"'));
    },
  });
  await assert.rejects(
    callTask(
      { ...config, aiTimeout: 10 },
      "x",
      "question",
      "gpt-luna",
      async () =>
        new Response(hangingBody, {
          headers: { "content-type": "application/json" },
        }),
    ),
    { code: "upstream_uncertain" },
  );
});

test("adapter serializes process admission and does not send after invalid config or cancellation", async () => {
  let release;
  const first = callTask(
    config,
    "x",
    "question",
    "gpt-luna",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    callTask(config, "x", "question", "gpt-luna", () => assert.fail("overlap")),
    { code: "task_concurrency_exceeded" },
  );
  release(json({ content: facts }));
  await first;
  for (const aiBase of [
    "https://user:pass@synthetic.invalid",
    "https://synthetic.invalid/other",
    "http://synthetic.invalid",
    "https://synthetic.invalid/?key=secret",
  ])
    await assert.rejects(
      callTask({ ...config, aiBase }, "x", "question", "gpt-luna", () =>
        assert.fail("invalid config sent"),
      ),
      { code: "invalid_task_configuration" },
    );
  await assert.rejects(
    callTask(
      config,
      "x",
      "question",
      "gpt-luna",
      () => assert.fail("cancelled sent"),
      AbortSignal.abort(),
    ),
    { code: "task_cancelled" },
  );
});

test("smoke defaults to preview, validates CLI, and exposes service/client deadline separately", async () => {
  assert.equal(
    (await runOaiSmoke({ fetchImpl: () => assert.fail("preview sent") }))
      .deadlineMs,
    900000,
  );
  assert.equal((await runOaiSmoke()).serviceDeadlineMs, 840000);
  assert.deepEqual(parseSmokeArgs(["--execute", "--run-id", "synthetic-1"]), {
    execute: true,
    runId: "synthetic-1",
  });
  for (const args of [
    ["--execute", "--execute"],
    ["--run-id", "../escape"],
    ["--endpoint", "x"],
  ])
    assert.throws(() => parseSmokeArgs(args));
  assert.equal(getConfig({}).aiTimeout, 900000);
});

test("smoke registers each request before dispatch, verifies text and JSON, stores private sanitized evidence", async (t) => {
  const location = await root(t);
  let count = 0;
  const result = await runOaiSmoke({
    execute: true,
    runId: "happy",
    tempRoot: location,
    config,
    fetchImpl: async (_url, options) => {
      count++;
      const pending = JSON.parse(
        await fs.readFile(
          path.join(location, "ai-smoke", "happy", `${count}-pending.json`),
        ),
      );
      assert.equal(pending.status, "pending");
      assert.ok(pending.registeredAt);
      assert.equal(pending.authenticated, count !== 1);
      assert.equal(
        new Headers(options.headers).has("Authorization"),
        count !== 1,
      );
      const request = JSON.parse(options.body);
      assert.match(request.instructions, /supplied synthetic facts/);
      return count === 1
        ? json({ detail: "Unauthorized secret" }, 401)
        : json({
            content: count === 2 ? facts : JSON.stringify({ summary: facts }),
            usage: null,
          });
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.httpRequests, 3);
  assert.equal(result.keyedTasks, 2);
  assert.deepEqual(
    result.results.map((value) => value.status),
    ["pass", "pass", "pass"],
  );
  assert.equal(result.results[2].usage, null);
  const values = await records(location, "happy");
  assert.equal(values.length, 7);
  for (const { text, mode } of values) {
    assert.equal(mode, 0o600);
    assert.ok(!text.includes(config.aiKey));
    assert.ok(!text.includes(facts));
    assert.ok(!text.includes("Unauthorized secret"));
  }
  assert.equal(
    (await fs.stat(path.join(location, "ai-smoke", "happy"))).mode & 0o777,
    0o700,
  );
  await assert.rejects(
    runOaiSmoke({
      execute: true,
      runId: "happy",
      tempRoot: location,
      config,
      fetchImpl: () => assert.fail("duplicate sent"),
    }),
    { code: "run_exists" },
  );
});

test("smoke stops on every uncertain or failed result, no retry and usage remains unknown", async (t) => {
  const location = await root(t);
  const outcomes = [
    () => {
      throw new Error(config.aiKey);
    },
    () => json({ detail: config.aiKey }, 503),
    () => json({ content: "wrong facts" }),
    () => json({ content: null }),
    () => json({ detail: config.aiKey }, 422),
    () => new Promise(() => {}),
  ];
  for (let index = 0; index < outcomes.length; index++) {
    let calls = 0;
    const result = await runOaiSmoke({
      execute: true,
      runId: `stop-${index}`,
      tempRoot: location,
      config,
      timeoutMs: 20,
      fetchImpl: async () =>
        ++calls === 1 ? json({}, 401) : outcomes[index](),
    });
    assert.equal(result.status, "stopped");
    assert.equal(calls, 2);
    assert.equal(result.keyedTasks, 1);
    assert.equal(
      result.results[1].status,
      [2, 4].includes(index) ? "fail" : "unknown",
    );
    assert.equal(result.results[1].usage, null);
    const output =
      JSON.stringify(result) +
      (await records(location, `stop-${index}`))
        .map((value) => value.text)
        .join("");
    assert.ok(!output.includes(config.aiKey));
  }
});

test("smoke refuses unexpected auth success, symlink/unsafe evidence and never dispatches", async (t) => {
  const location = await root(t);
  const result = await runOaiSmoke({
    execute: true,
    runId: "bad-auth",
    tempRoot: location,
    config,
    fetchImpl: async () => json({ content: facts }),
  });
  assert.equal(result.httpRequests, 1);
  assert.equal(result.keyedTasks, 0);
  assert.equal(result.code, "auth_unexpected_success");
  const unsafe = await root(t);
  await fs.chmod(unsafe, 0o755);
  await assert.rejects(
    runOaiSmoke({
      execute: true,
      runId: "unsafe",
      tempRoot: unsafe,
      config,
      fetchImpl: () => assert.fail("unsafe sent"),
    }),
    { code: "evidence_unsafe" },
  );
  const symlinkRoot = await root(t);
  await fs.symlink(location, path.join(symlinkRoot, "ai-smoke"));
  await assert.rejects(
    runOaiSmoke({
      execute: true,
      runId: "symlink",
      tempRoot: symlinkRoot,
      config,
      fetchImpl: () => assert.fail("symlink sent"),
    }),
    { code: "evidence_unsafe" },
  );
});

test("queue retains uncertain state, counts once and never replays a 503", async (t) => {
  const stateDir = await root(t);
  let calls = 0;
  const queue = new JobQueue(
    { ...getConfig({}), ...config, stateDir },
    {
      books: [
        { id: "synthetic", title: "Synthetic", author: "Synthetic Author" },
      ],
    },
    {},
    {
      worker: false,
      fetchImpl: async () => {
        calls++;
        return json({ detail: "Codex service is busy" }, 503);
      },
    },
  );
  t.after(() => queue.close());
  queue.author = async () => ({
    text: "Synthetic biography",
    source: { label: "synthetic evidence" },
  });
  const job = queue.create({ id: "synthetic" }, { operation: "author" });
  await queue.pump();
  const stored = queue.get(job.id);
  assert.equal(calls, 1);
  assert.equal(stored.status, "uncertain");
  assert.equal(stored.usage.calls, 1);
  assert.equal(queue.db.prepare("SELECT count FROM calls").get().count, 1);
  await queue.pump();
  assert.equal(calls, 1);
});

test("timeout cancels locked response reader even if cancel hook never settles", async () => {
  let cancelled = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"content":"'));
    },
    cancel() {
      cancelled++;
      return new Promise(() => {});
    },
  });
  const response = new Response(stream, {
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    callTask(
      { ...config, aiTimeout: 10 },
      "x",
      "question",
      "gpt-luna",
      async () => response,
    ),
    { code: "upstream_uncertain" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test("late fetch response is cancelled without reading or returning a late success", async () => {
  let release;
  let cancelled = 0;
  const pending = callTask(
    { ...config, aiTimeout: 10 },
    "x",
    "question",
    "gpt-luna",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(pending, { code: "upstream_uncertain" });
  const stream = new ReadableStream({
    cancel() {
      cancelled++;
      return new Promise(() => {});
    },
  });
  release(
    new Response(stream, { headers: { "content-type": "application/json" } }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test("external cancellation returns promptly even when fetch ignores signal", async () => {
  const controller = new AbortController();
  const pending = callTask(
    config,
    "x",
    "question",
    "gpt-luna",
    () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { code: "upstream_uncertain" });
});

test("smoke rejects redirected or mismatched 401 before authorizing keyed tasks", async (t) => {
  const location = await root(t);
  for (const [index, field, value] of [
    [0, "redirected", true],
    [1, "url", "https://other.invalid/v1/tasks"],
  ]) {
    let count = 0;
    const result = await runOaiSmoke({
      execute: true,
      runId: `target-${index}`,
      tempRoot: location,
      config,
      fetchImpl: async () => {
        count++;
        const response = json({}, 401);
        Object.defineProperty(response, field, { value });
        return response;
      },
    });
    assert.equal(count, 1);
    assert.equal(result.keyedTasks, 0);
    assert.equal(result.code, "target_rejected");
    assert.equal(result.results[0].status, "unknown");
  }
  await assert.rejects(
    runOaiSmoke({
      execute: true,
      runId: "bad-base",
      tempRoot: location,
      config: { ...config, aiBase: "https://synthetic.invalid/other" },
      fetchImpl: () => assert.fail("configured bad path sent"),
    }),
    { code: "invalid_configuration" },
  );
});

test("queue local validation consumes no budget and uncertain pause survives restart", async (t) => {
  const stateDir = await root(t);
  const catalog = {
    books: [
      { id: "synthetic", title: "Synthetic", author: "Synthetic Author" },
    ],
  };
  let calls = 0;
  const options = {
    worker: false,
    fetchImpl: async () => {
      calls++;
      throw new Error("unknown");
    },
  };
  const conf = { ...getConfig({}), ...config, stateDir };
  let queue = new JobQueue(conf, catalog, {}, options);
  t.after(() => queue.close());
  const first = queue.create({ id: "synthetic" }, { operation: "author" });
  const raw = JSON.parse(
    queue.db.prepare("SELECT data FROM jobs WHERE id=?").get(first.id).data,
  );
  await assert.rejects(queue.invoke(raw, "x".repeat(500001)), {
    code: "input_budget_exceeded",
  });
  assert.equal(queue.db.prepare("SELECT count(*) AS n FROM calls").get().n, 0);
  assert.equal(queue.get(first.id).usage.calls, 0);
  assert.equal(calls, 0);
  const second = queue.create(
    { id: "synthetic" },
    { operation: "question", question: "second" },
  );
  queue.author = async () => ({ text: "Synthetic biography", source: {} });
  await queue.pump();
  assert.equal(calls, 1);
  assert.equal(queue.get(first.id).status, "uncertain");
  assert.equal(queue.get(second.id).status, "queued");
  assert.throws(
    () =>
      queue.create(
        { id: "synthetic" },
        { operation: "question", question: "third" },
      ),
    { code: "ai_reconciliation_required" },
  );
  await queue.close();
  queue = new JobQueue(conf, catalog, {}, options);
  await queue.pump();
  assert.equal(calls, 1);
  assert.equal(queue.get(second.id).status, "queued");
});

test("requested output format is pinned before dispatch despite caller mutation", async () => {
  const options = { outputFormat: "json_object" };
  let release;
  const pending = callTask(
    config,
    "x",
    "question",
    "gpt-luna",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    undefined,
    options,
  );
  options.outputFormat = "text";
  release(json({ content: "invalid JSON" }));
  await assert.rejects(pending, { code: "upstream_invalid_response" });
});
