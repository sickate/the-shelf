#!/usr/bin/env node
// Explicit, bounded synthetic validation of the production named-task adapter.
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { callTask, taskRequest } from "../server/jobs.mjs";

const PROJECT = fileURLToPath(new URL("../", import.meta.url));
const MODEL = "gpt-luna";
const DEADLINE = 900_000;
const SERVICE_DEADLINE = 840_000;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const MATERIAL =
  "Synthetic test material: The lantern is blue. There are seven stones. ";
const TASKS = [
  {
    operation: "question",
    kind: "topic_analysis",
    options: {
      instructions:
        "Use only the supplied synthetic facts. Answer the question briefly in English. Do not browse or call tools.",
      outputFormat: "text",
    },
    input:
      MATERIAL +
      "What color is the lantern and how many stones are there? Answer briefly in English.",
  },
  {
    operation: "full_summary",
    kind: "research_summary",
    options: {
      instructions:
        'Use only the supplied synthetic facts. Return a JSON object with one field "summary": a short English sentence containing both facts. Do not browse or call tools.',
      outputFormat: "json_object",
    },
    input: MATERIAL + "Summarize both facts in one short English sentence.",
  },
];
const CODES = new Set([
  "invalid_arguments",
  "invalid_configuration",
  "configuration_unavailable",
  "evidence_unsafe",
  "evidence_failed",
  "run_exists",
  "target_rejected",
  "auth_rejected",
  "auth_unexpected_success",
  "http_rejected",
  "upstream_unknown",
  "deadline_exceeded",
  "invalid_success",
  "content_check_failed",
  "complete",
]);
class SmokeError extends Error {
  constructor(code) {
    super(code);
    this.code = CODES.has(code) ? code : "upstream_unknown";
  }
}
const fail = (code) => {
  throw new SmokeError(code);
};
const safeCode = (error, fallback) =>
  error instanceof SmokeError ? error.code : fallback;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function checkedDirectory(location, privateMode = true) {
  const before = await fs.lstat(location);
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (privateMode &&
      ((before.mode & 0o777) !== 0o700 || before.uid !== process.getuid()))
  )
    fail("evidence_unsafe");
  const handle = await fs.open(
    location,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!same(before, opened)) fail("evidence_unsafe");
    return { location, handle, stat: opened, privateMode };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function checkDirectories(directories) {
  for (const directory of directories) {
    const current = await fs.lstat(directory.location);
    const opened = await directory.handle.stat();
    if (
      !same(current, directory.stat) ||
      !same(opened, directory.stat) ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (directory.privateMode &&
        ((current.mode & 0o777) !== 0o700 || current.uid !== process.getuid()))
    )
      fail("evidence_unsafe");
  }
}

async function openEvidence(tempRoot, runId) {
  const directories = [];
  const files = [];
  try {
    const root = tempRoot === undefined ? PROJECT : path.resolve(tempRoot);
    // The fixed project root is trusted; injected roots must already be private.
    directories.push(await checkedDirectory(root, tempRoot !== undefined));
    const components =
      tempRoot === undefined
        ? [".local", "ai-smoke", runId]
        : ["ai-smoke", runId];
    let current = root;
    for (let index = 0; index < components.length; index++) {
      await checkDirectories(directories);
      current = path.join(current, components[index]);
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (index === components.length - 1) fail("run_exists");
      }
      directories.push(await checkedDirectory(current));
      await directories.at(-2).handle.sync();
    }
    const verify = async () => {
      await checkDirectories(directories);
      for (const file of files) {
        const current = await fs.lstat(file.location);
        if (
          !same(current, file.stat) ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1 ||
          current.uid !== process.getuid() ||
          (current.mode & 0o777) !== 0o600
        )
          fail("evidence_unsafe");
      }
    };
    return {
      async write(name, value) {
        try {
          await verify();
          const location = path.join(current, name);
          const handle = await fs.open(
            location,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            const initial = await handle.stat();
            if (
              !initial.isFile() ||
              initial.nlink !== 1 ||
              (initial.mode & 0o777) !== 0o600 ||
              initial.uid !== process.getuid()
            )
              fail("evidence_unsafe");
            await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
            await handle.sync();
            files.push({ location, stat: initial });
          } finally {
            await handle.close();
          }
          await directories.at(-1).handle.sync();
          await verify();
        } catch (error) {
          fail(safeCode(error, "evidence_failed"));
        }
      },
      verify,
      async close() {
        await Promise.all(directories.map(({ handle }) => handle.close()));
      },
    };
  } catch (error) {
    await Promise.all(directories.map(({ handle }) => handle.close()));
    fail(safeCode(error, "evidence_failed"));
  }
}

function validateConfig(config, timeoutMs) {
  if (
    !config ||
    typeof config.aiBase !== "string" ||
    typeof config.aiKey !== "string" ||
    !config.aiKey ||
    /[\r\n]/.test(config.aiKey) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEADLINE
  )
    fail("invalid_configuration");
  let base;
  try {
    base = new URL(config.aiBase);
  } catch {
    fail("invalid_configuration");
  }
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !["/", "/v1", "/v1/"].includes(base.pathname) ||
    (base.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  )
    fail("invalid_configuration");
  // No path discovery: the adapter always resolves this exact endpoint.
  return { aiBase: base.origin, aiKey: config.aiKey, aiTimeout: timeoutMs };
}

async function loadConfiguration() {
  let handle;
  try {
    const location = path.join(PROJECT, ".env");
    handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 1_000_000
    )
      fail("configuration_unavailable");
    const env = parseEnv(await handle.readFile("utf8"));
    const after = await fs.lstat(location);
    if (
      !same(stat, after) ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs
    )
      fail("configuration_unavailable");
    return { aiBase: env.SHELF_OAI_BASE_URL, aiKey: env.SHELF_OAI_KEY };
  } catch {
    fail("configuration_unavailable");
  } finally {
    await handle?.close();
  }
}

function safeUsage(value) {
  const result = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "prompt_tokens",
      "completion_tokens",
    ])
      if (
        Number.isSafeInteger(value[key]) &&
        value[key] >= 0 &&
        value[key] <= 1_000_000_000
      )
        result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

/** Test dependencies are module-only; CLI has no configurable endpoint or output path. */
export async function runOaiSmoke({
  execute = false,
  runId = randomUUID(),
  tempRoot,
  config,
  fetchImpl = fetch,
  clock = () => performance.now(),
  timeoutMs = DEADLINE,
} = {}) {
  if (
    typeof execute !== "boolean" ||
    typeof runId !== "string" ||
    !RUN_ID.test(runId) ||
    (tempRoot !== undefined &&
      (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot))) ||
    typeof fetchImpl !== "function" ||
    typeof clock !== "function"
  )
    fail("invalid_arguments");
  const preview = {
    status: "dry-run",
    model: MODEL,
    maximumHttpRequests: 3,
    maximumKeyedTasks: 2,
    deadlineMs: DEADLINE,
    serviceDeadlineMs: SERVICE_DEADLINE,
    kinds: TASKS.map(({ kind }) => kind),
  };
  if (!execute) return preview;
  const checked = validateConfig(
    config ?? (await loadConfiguration()),
    timeoutMs,
  );
  const evidence = await openEvidence(tempRoot, runId);
  const results = [];
  let sent = 0;
  let keyed = 0;
  let finalStatus = "stopped";
  let finalCode = "upstream_unknown";
  try {
    for (let index = 0; index < 3; index++) {
      const preflight = index === 0;
      const task = TASKS[preflight ? 0 : index - 1];
      const entry = {
        sequence: index + 1,
        status: "pending",
        registeredAt: new Date().toISOString(),
        kind: task.kind,
        model: MODEL,
        authenticated: !preflight,
        inputCharacters: task.input.length,
      };
      // Immutable pending intent is durable before a potentially billable POST.
      await evidence.write(`${index + 1}-pending.json`, entry);
      let httpStatus = null;
      let responseValue;
      let caught;
      let expired = false;
      let targetRejected = false;
      let used = false;
      const started = clock();
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          reject(new SmokeError("deadline_exceeded"));
        }, timeoutMs);
      });
      const wrappedFetch = async (url, options) => {
        if (used || sent >= 3 || (!preflight && keyed >= 2))
          fail("target_rejected");
        const target = new URL(url);
        const expected = new URL("/v1/tasks", checked.aiBase);
        if (
          target.href !== expected.href ||
          options.method !== "POST" ||
          options.body !==
            taskRequest(task.input, task.operation, MODEL, task.options) ||
          new Headers(options.headers).get("Authorization") !==
            (preflight ? "Bearer" : `Bearer ${checked.aiKey}`)
        )
          fail("target_rejected");
        await evidence.verify();
        if (expired) fail("deadline_exceeded");
        used = true;
        sent++;
        if (!preflight) keyed++;
        const headers = new Headers(options.headers);
        if (preflight) headers.delete("Authorization");
        const response = await fetchImpl(expected, {
          ...options,
          headers,
          redirect: "error",
          signal: AbortSignal.any([options.signal, controller.signal]),
        });
        if (
          response.redirected ||
          (response.url && response.url !== expected.href)
        ) {
          targetRejected = true;
          if (!response.body?.locked)
            void response.body?.cancel().catch(() => {});
          fail("target_rejected");
        }
        httpStatus =
          Number.isInteger(response.status) &&
          response.status >= 100 &&
          response.status <= 599
            ? response.status
            : null;
        return response;
      };
      try {
        responseValue = await Promise.race([
          callTask(
            { ...checked, aiKey: preflight ? "" : checked.aiKey },
            task.input,
            task.operation,
            MODEL,
            wrappedFetch,
            controller.signal,
            task.options,
          ),
          deadline,
        ]);
      } catch (error) {
        caught = error;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      let status = "unknown";
      let code = expired ? "deadline_exceeded" : "upstream_unknown";
      const checks = {
        lanternBlue:
          typeof responseValue?.content === "string" &&
          /\bblue\b/i.test(responseValue.content),
        sevenStones:
          typeof responseValue?.content === "string" &&
          /\b(?:seven|7)\b/i.test(responseValue.content) &&
          /\bstones?\b/i.test(responseValue.content),
      };
      if (!expired && targetRejected) {
        code = "target_rejected";
      } else if (!expired && preflight && httpStatus === 401) {
        status = "pass";
        code = "auth_rejected";
      } else if (!expired && preflight && [200, 202].includes(httpStatus)) {
        status = "unknown";
        code = "auth_unexpected_success";
      } else if (!expired && httpStatus >= 400 && httpStatus < 500) {
        status = "fail";
        code = "http_rejected";
      } else if (!expired && httpStatus >= 300 && httpStatus < 400) {
        status = "unknown";
        code = "target_rejected";
      } else if (!expired && !preflight && responseValue) {
        status = checks.lanternBlue && checks.sevenStones ? "pass" : "fail";
        code = status === "pass" ? "complete" : "content_check_failed";
      } else if (!expired && caught?.code === "upstream_invalid_response")
        code = "invalid_success";
      const result = {
        ...entry,
        status,
        code,
        httpStatus,
        elapsedMs: Math.max(0, Math.round(clock() - started)),
        outputCharacters:
          typeof responseValue?.content === "string"
            ? responseValue.content.length
            : null,
        usage: safeUsage(responseValue?.usage),
        checks,
      };
      await evidence.write(`${index + 1}-result.json`, result);
      results.push(result);
      if (preflight ? code !== "auth_rejected" : status !== "pass") {
        finalCode = code;
        break;
      }
      if (index === 2) {
        finalStatus = "success";
        finalCode = "complete";
      }
    }
    const receipt = {
      status: finalStatus,
      code: finalCode,
      httpRequests: sent,
      keyedTasks: keyed,
      results,
    };
    await evidence.write("receipt.json", receipt);
    return receipt;
  } catch (error) {
    // A failed result write leaves the durable pending marker as unknown. Never retry.
    return {
      status: "stopped",
      code: safeCode(error, "evidence_failed"),
      httpRequests: sent,
      keyedTasks: keyed,
      results,
    };
  } finally {
    await evidence.close();
  }
}

export function parseSmokeArgs(args) {
  const result = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail("invalid_arguments");
    seen.add(arg);
    if (arg === "--execute") result.execute = true;
    else if (arg === "--run-id") {
      const value = args[++i];
      if (!value || !RUN_ID.test(value)) fail("invalid_arguments");
      result.runId = value;
    } else fail("invalid_arguments");
  }
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runOaiSmoke(parseSmokeArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    if (!["success", "dry-run"].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "stopped",
        code: safeCode(error, "evidence_failed"),
      }),
    );
    process.exitCode = 1;
  }
}
