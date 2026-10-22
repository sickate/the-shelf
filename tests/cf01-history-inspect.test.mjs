import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CF01_HISTORY_LIMITS,
  Cf01HistoryError,
  projectCf01History,
  runCf01HistoryInspect,
  main,
} from "../scripts/cf01-history-inspect.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://the-shelf-cf01.iamzhutuo.workers.dev";
const AT = "2026-10-15T00:00:00.000Z";
const SENTINEL = "private-secret-do-not-retain";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const clone = (v) => structuredClone(v);
const exec = promisify(execFile);
const row = (run_id = ID) => ({
  run_id,
  kind: "storage",
  state: "completed",
  result_json: `{${SENTINEL}`,
  delay_seconds: 0,
  mode: "success",
  network_calls: 0,
  mock_calls: 0,
  created_at: 1,
  updated_at: 2,
});
const request = (
  method,
  pathname,
  outcome = "response",
  data = { run: row() },
) => ({
  method,
  pathname,
  at: AT,
  outcome,
  ...(outcome === "response" ? { status: 200, data } : {}),
});
function evidence() {
  return {
    schemaVersion: 1,
    runs: [
      {
        label: "storage",
        runId: ID,
        origin: ORIGIN,
        createdAt: AT,
        cleaned: true,
      },
    ],
    requests: [
      request("POST", "/v1/runs", "pending"),
      request("POST", "/v1/runs", "uncertain_no_resend"),
      request("POST", "/v1/runs"),
      request("GET", `/v1/runs/${ID}`),
      request("DELETE", `/v1/runs/${ID}`, "response", {
        cleaned: true,
        budgetTombstoneRetained: true,
      }),
      request("POST", "/v1/runs", "response", { error: SENTINEL }),
      request("POST", "/v1/runs", "response", {
        run: { ...row(OTHER), kind: "workflow", state: "running" },
        workflow: {
          status: "running",
          output: SENTINEL,
          error: { message: SENTINEL },
        },
      }),
      request("GET", `/v1/runs/${OTHER}`, "uncertain_no_resend"),
    ],
  };
}
const assertClosed = (result) => {
  assert.equal(result.readyEligible, false);
  assert.equal(result.drainProven, false);
  assert.equal(result.uploadAllowed, false);
};
const invalid = (fn) =>
  assert.throws(
    fn,
    (e) =>
      e instanceof Cf01HistoryError &&
      e.code === "cf01_history_evidence_invalid" &&
      !String(e).includes(SENTINEL),
  );

async function fixture(t, data = evidence()) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "shelf-cf01-history-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  const dir = path.join(root, ".local/cf01");
  await fs.mkdir(dir, { mode: 0o700 });
  const filename = path.join(dir, "evidence.json");
  await fs.writeFile(
    filename,
    typeof data === "string" ? data : JSON.stringify(data),
    { mode: 0o600 },
  );
  return { root, dir, filename };
}

test("all request indexes survive, including unattributed pending/unknown POSTs, without guessed attribution", () => {
  const p = projectCf01History(evidence());
  assertClosed(p);
  assert.deepEqual(
    p.requests.map((r) => r.index),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    p.requests.slice(0, 2).map((r) => [r.outcome, r.attribution, r.runRef]),
    [
      ["pending", "unattributed", null],
      ["unknown", "unattributed", null],
    ],
  );
  assert.equal(p.requests[2].attribution, "response");
  assert.equal(p.requests[3].attribution, "path_and_response");
  assert.equal(p.requests[4].attribution, "path");
  assert.equal(p.requests[6].localRunMatched, false);
  assert.equal(p.requests[7].runRef, hash(OTHER));
  assert.equal(p.requests[7].attribution, "path");
  assert.deepEqual(p.summary, {
    runs: 1,
    requests: 8,
    starts: 5,
    pendingRequests: 1,
    unknownRequests: 2,
    unattributedRequests: 3,
    unattributedStarts: 3,
    unresolvedStarts: 2,
    unresolvedMutations: 2,
    failedResponses: 0,
    storageCompletedResponses: 2,
    cleanupResponses: 1,
  });
  const output = JSON.stringify(p);
  for (const secret of [
    ID,
    OTHER,
    ORIGIN,
    AT,
    SENTINEL,
    "result_json",
    "workflow",
  ]) {
    // The finite kind "workflow" is allowed; provider workflow output is absent.
    if (secret !== "workflow") assert.ok(!output.includes(secret));
  }
  assert.ok(!output.includes("responseId"));
});

test("missing/extra fields, unknown enums, wrong shapes, conflicting IDs and caps fail with fixed errors", () => {
  const mutations = [
    (x) => {
      x.extra = SENTINEL;
    },
    (x) => {
      delete x.schemaVersion;
    },
    (x) => {
      x.runs = {};
    },
    (x) => {
      x.runs[0].label = SENTINEL;
    },
    (x) => {
      x.runs[0].origin += "/evil";
    },
    (x) => {
      x.runs[0].cleaned = 1;
    },
    (x) => {
      x.runs.push(clone(x.runs[0]));
    },
    (x) => {
      x.requests[0].method = SENTINEL;
    },
    (x) => {
      x.requests[0].pathname = "/v1/runs/" + SENTINEL;
    },
    (x) => {
      x.requests[0].outcome = SENTINEL;
    },
    (x) => {
      x.requests[0].data = {};
    },
    (x) => {
      x.requests[2].status = "200";
    },
    (x) => {
      delete x.requests[2].data;
    },
    (x) => {
      x.requests[2].data.extra = SENTINEL;
    },
    (x) => {
      x.requests[2].data.run.kind = SENTINEL;
    },
    (x) => {
      x.requests[2].data.run.state = SENTINEL;
    },
    (x) => {
      x.requests[2].data.run.mode = SENTINEL;
    },
    (x) => {
      x.requests[2].data.run.result_json = {};
    },
    (x) => {
      x.requests[2].data.run.run_id = "bad";
    },
    (x) => {
      x.requests[3].data.run.run_id = OTHER;
    },
    (x) => {
      x.requests[6].data.workflow.status = SENTINEL;
    },
    (x) => {
      x.requests[2].data.run.network_calls = -1;
    },
    (x) => {
      x.requests[2].body = SENTINEL;
    },
    (x) => {
      x.requests = Array(513).fill(x.requests[0]);
    },
    (x) => {
      x.runs = Array(513).fill(x.runs[0]);
    },
  ];
  for (const mutate of mutations) {
    const x = evidence();
    mutate(x);
    invalid(() => projectCf01History(x));
  }
  assert.equal(
    projectCf01History({ schemaVersion: 1, runs: [], requests: [] }).summary
      .requests,
    0,
  );
});

test("default preview and CLI main preview are zero IO/config/network and emit only closed metadata", async (t) => {
  let calls = 0;
  const blocked = () => {
    calls++;
    throw new Error(SENTINEL);
  };
  for (const method of [
    "lstat",
    "readFile",
    "open",
    "realpath",
    "mkdir",
    "rename",
    "writeFile",
  ])
    t.mock.method(fs, method, blocked);
  t.mock.method(process, "loadEnvFile", blocked);
  t.mock.method(globalThis, "fetch", blocked);
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(line));
  const p = await runCf01HistoryInspect();
  const q = await main([]);
  assert.equal(calls, 0);
  assertClosed(p);
  assertClosed(q);
  assert.equal(p.action, "preview");
  assert.equal(p.networkRequests, 0);
  assert.deepEqual(p.limits, CF01_HISTORY_LIMITS);
  assert.equal(lines.length, 1);
  await assert.rejects(main(["--path", SENTINEL]), /cf01_history_usage/);
  await assert.rejects(
    runCf01HistoryInspect({ execute: SENTINEL }),
    /cf01_history_options_invalid/,
  );
});

test("execute reads only fixed evidence, writes separate private safe receipt, leaves input hash/inode unchanged", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.filename),
    stat = await fs.stat(f.filename);
  const actualOpen = fs.open.bind(fs),
    opened = [];
  t.mock.method(fs, "open", async (name, ...args) => {
    opened.push(String(name));
    return actualOpen(name, ...args);
  });
  t.mock.method(process, "loadEnvFile", () => {
    throw new Error(SENTINEL);
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error(SENTINEL);
  });
  const result = await runCf01HistoryInspect({ execute: true, root: f.root });
  assertClosed(result);
  assert.equal(result.requests, 8);
  assert.equal(result.receiptWritten, true);
  assert.ok(
    opened.every((name) => name.startsWith(f.dir + path.sep) || name === f.dir),
  );
  const names = await fs.readdir(f.dir);
  const receiptName = names.find((n) =>
    /^history-inspect-[a-f0-9-]{36}\.json$/.test(n),
  );
  assert.equal(names.length, 2);
  assert.ok(receiptName);
  const receiptPath = path.join(f.dir, receiptName),
    raw = await fs.readFile(receiptPath, "utf8"),
    receipt = JSON.parse(raw);
  assertClosed(receipt);
  assert.equal(receipt.requests.length, 8);
  for (const secret of [SENTINEL, ID, OTHER, ORIGIN, AT, "result_json"])
    assert.ok(!raw.includes(secret));
  assert.equal(receipt.input.sha256, hash(before));
  assert.equal((await fs.stat(receiptPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.dir)).mode & 0o777, 0o700);
  assert.equal(hash(await fs.readFile(f.filename)), hash(before));
  assert.equal((await fs.stat(f.filename)).ino, stat.ino);
});

test("invalid JSON/shape/oversize fail closed without a receipt or input mutation", async (t) => {
  for (const raw of [
    "{",
    JSON.stringify({
      schemaVersion: 1,
      runs: [],
      requests: [{ secret: SENTINEL }],
    }),
    " ".repeat(CF01_HISTORY_LIMITS.inputBytes + 1),
  ]) {
    const f = await fixture(t, raw),
      before = hash(await fs.readFile(f.filename));
    await assert.rejects(
      runCf01HistoryInspect({ execute: true, root: f.root }),
      (e) =>
        /^cf01_history_(json_invalid|evidence_invalid|private_file_unsafe)$/.test(
          e.code,
        ) && !String(e).includes(SENTINEL),
    );
    assert.deepEqual(await fs.readdir(f.dir), ["evidence.json"]);
    assert.equal(hash(await fs.readFile(f.filename)), before);
  }
});

test("input above the byte limit is rejected before opening its contents", async (t) => {
  const f = await fixture(t, " ".repeat(CF01_HISTORY_LIMITS.inputBytes + 1));
  const actualOpen = fs.open.bind(fs);
  let inputOpens = 0;
  t.mock.method(fs, "open", async (filename, ...args) => {
    if (filename === f.filename) inputOpens++;
    return actualOpen(filename, ...args);
  });
  await assert.rejects(
    runCf01HistoryInspect({ execute: true, root: f.root }),
    /cf01_history_private_file_unsafe/,
  );
  assert.equal(inputOpens, 0);
});

test("lossy UTF-8 decoding is rejected before any digest receipt is written", async (t) => {
  const f = await fixture(t);
  const raw = Buffer.from(JSON.stringify(evidence()));
  raw[raw.indexOf(SENTINEL)] = 0xff;
  await fs.writeFile(f.filename, raw);
  await assert.rejects(
    runCf01HistoryInspect({ execute: true, root: f.root }),
    /cf01_history_evidence_invalid/,
  );
  assert.equal(hash(await fs.readFile(f.filename)), hash(raw));
  assert.deepEqual(await fs.readdir(f.dir), ["evidence.json"]);
});

test("real CLI preview and execution stay inside a synthetic project and never reach config/network", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "scripts"));
  for (const name of [
    "cf01-history-inspect.mjs",
    "cf01-storage-close.mjs",
    "cf-deploy.mjs",
  ])
    await fs.copyFile(
      new URL(`../scripts/${name}`, import.meta.url),
      path.join(f.root, "scripts", name),
    );
  const preload = path.join(f.root, "blocked.mjs");
  await fs.writeFile(
    preload,
    `
    process.loadEnvFile = () => { throw new Error(${JSON.stringify(SENTINEL)}); };
    globalThis.fetch = () => { throw new Error(${JSON.stringify(SENTINEL)}); };
  `,
  );
  const filename = path.join(f.root, "scripts/cf01-history-inspect.mjs");
  const original = hash(await fs.readFile(f.filename));
  for (const args of [[], ["--execute"]]) {
    const { stdout, stderr } = await exec(
      process.execPath,
      ["--import", preload, filename, ...args],
      { cwd: f.root, env: { NODE_NO_WARNINGS: "1" }, timeout: 5000 },
    );
    assert.equal(stderr, "");
    assert.ok(!stdout.includes(SENTINEL));
    const output = JSON.parse(stdout);
    assertClosed(output);
    assert.equal(output.action, args.length ? "inspect" : "preview");
    assert.equal(hash(await fs.readFile(f.filename)), original);
    assert.equal((await fs.readdir(f.dir)).length, args.length ? 2 : 1);
  }
});

test("unsafe file/directory permissions, symlinks and hardlinks are rejected", async (t) => {
  for (const variant of [
    "file-mode",
    "dir-mode",
    "file-symlink",
    "file-hardlink",
    "dir-symlink",
  ]) {
    const f = await fixture(t);
    if (variant === "file-mode") await fs.chmod(f.filename, 0o644);
    if (variant === "dir-mode") await fs.chmod(f.dir, 0o755);
    if (variant === "file-hardlink")
      await fs.link(f.filename, path.join(f.root, "linked"));
    if (variant === "file-symlink") {
      await fs.rename(f.filename, path.join(f.root, "original"));
      await fs.symlink(path.join(f.root, "original"), f.filename);
    }
    if (variant === "dir-symlink") {
      await fs.rename(f.dir, path.join(f.root, "original"));
      await fs.symlink(path.join(f.root, "original"), f.dir);
    }
    await assert.rejects(
      runCf01HistoryInspect({ execute: true, root: f.root }),
      (e) => /^cf01_history_private_(file|directory)_unsafe$/.test(e.code),
    );
  }
});

test("same-permission evidence replacement during read is detected without a receipt", async (t) => {
  const f = await fixture(t),
    original = fs.lstat.bind(fs);
  let seen = 0;
  t.mock.method(fs, "lstat", async (filename, ...args) => {
    if (filename === f.filename && ++seen === 2) {
      await fs.rename(f.filename, path.join(f.root, "old-evidence"));
      await fs.writeFile(f.filename, JSON.stringify(evidence()), {
        mode: 0o600,
      });
    }
    return original(filename, ...args);
  });
  await assert.rejects(
    runCf01HistoryInspect({ execute: true, root: f.root }),
    /cf01_history_private_file_changed/,
  );
  assert.deepEqual(await fs.readdir(f.dir), ["evidence.json"]);
});

test("same-permission private directory replacement after pin is detected", async (t) => {
  const f = await fixture(t),
    original = fs.lstat.bind(fs);
  let seen = 0;
  t.mock.method(fs, "lstat", async (filename, ...args) => {
    if (filename === f.dir && ++seen === 3) {
      await fs.rename(f.dir, path.join(f.root, "old-dir"));
      await fs.mkdir(f.dir, { mode: 0o700 });
      await fs.writeFile(f.filename, JSON.stringify(evidence()), {
        mode: 0o600,
      });
    }
    return original(filename, ...args);
  });
  await assert.rejects(
    runCf01HistoryInspect({ execute: true, root: f.root }),
    /cf01_history_private_directory_changed/,
  );
  assert.deepEqual(await fs.readdir(f.dir), ["evidence.json"]);
});

test("error types never preserve attacker controlled codes/messages", () => {
  const e = new Cf01HistoryError(SENTINEL);
  assert.equal(e.code, "cf01_history_local_failure");
  assert.equal(e.message, e.code);
  assert.ok(!JSON.stringify(e).includes(SENTINEL));
});
