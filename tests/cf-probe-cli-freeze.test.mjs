import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SECRET = "ab".repeat(32);
const ID = "12345678-1234-4234-8234-123456789abc";
const ORIGIN = "https://shelf-fixture.invalid";
const REJECTION = "legacy_storage_migration_required";
const source = await fs.readFile(
  new URL("../scripts/cf-probe.mjs", import.meta.url),
);
const digest = (data) => createHash("sha256").update(data).digest("hex");

async function fixture(t, variant) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "shelf-probe-cli-freeze-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  const script = path.join(root, "scripts/cf-probe.mjs");
  await fs.writeFile(script, source);
  const stateDir = path.join(root, ".local/cf01");
  const evidencePath = path.join(stateDir, "evidence.json");
  if (variant !== "empty") {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      evidencePath,
      JSON.stringify({
        schemaVersion: 1,
        runs: [
          {
            label: "storage",
            runId: ID,
            origin: ORIGIN,
            createdAt: "2026-10-15T00:00:00Z",
            cleaned: false,
          },
        ],
        requests: [],
      }),
      { mode: 0o600 },
    );
    if (variant === "locked")
      await fs.writeFile(evidencePath + ".lock", "retained lock", {
        mode: 0o600,
      });
  }
  if (variant === "configured")
    await fs.writeFile(
      path.join(root, ".env"),
      `CF_PROBE_TOKEN=${SECRET}\nCF_PROBE_URL=${ORIGIN}\n`,
      { mode: 0o600 },
    );
  // A child can never reach the network, even if the freeze regresses.
  const preload = path.join(root, "network-fixture.mjs");
  await fs.writeFile(
    preload,
    `
    import { appendFile } from "node:fs/promises";
    const id = ${JSON.stringify(ID)};
    globalThis.fetch = async (url, init) => {
      await appendFile(new URL("./network-calls.jsonl", import.meta.url), JSON.stringify({url, method:init.method, body:init.body}) + "\\n");
      const input = init.body ? JSON.parse(init.body) : null;
      return Response.json(init.method === "DELETE" ? { cleaned: true, budgetTombstoneRetained: true } : {
        run: { run_id: input?.runId || id, kind: input?.kind || "storage", state: "completed", network_calls:0, mock_calls:0 }
      });
    };
  `,
  );
  return { root, script, preload, evidencePath };
}

async function snapshot(root) {
  const entries = [];
  async function visit(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const location = path.join(dir, name);
      const stat = await fs.lstat(location);
      entries.push([
        path.relative(root, location),
        stat.mode,
        stat.isDirectory() ? "directory" : digest(await fs.readFile(location)),
      ]);
      if (stat.isDirectory()) await visit(location);
    }
  }
  await visit(root);
  return digest(JSON.stringify(entries));
}

function cli(f, args) {
  return exec(process.execPath, ["--import", f.preload, f.script, ...args], {
    cwd: f.root,
    env: { NODE_NO_WARNINGS: "1" },
    timeout: 5000,
    maxBuffer: 16384,
  });
}

for (const variant of ["empty", "locked", "configured"]) {
  test(`exported main rejects legacy starts before config/files/lock/fetch (${variant})`, async (t) => {
    const f = await fixture(t, variant);
    const { main } = await import(pathToFileURL(f.script).href);
    const before = await snapshot(f.root);
    let fetchCalls = 0,
      configCalls = 0;
    t.mock.method(globalThis, "fetch", () => {
      fetchCalls++;
      throw new Error(SECRET);
    });
    t.mock.method(process, "loadEnvFile", () => {
      configCalls++;
      throw new Error(SECRET);
    });
    for (const args of [["start", "storage"], ["smoke"]]) {
      await assert.rejects(
        main(args),
        (e) => e.message === REJECTION && !String(e).includes(SECRET),
      );
      assert.equal(await snapshot(f.root), before);
    }
    assert.equal(fetchCalls, 0);
    assert.equal(configCalls, 0);
  });

  test(`real CLI rejects legacy starts with unchanged temporary project/evidence (${variant})`, async (t) => {
    const f = await fixture(t, variant);
    const before = await snapshot(f.root);
    for (const args of [["start", "storage"], ["smoke"]]) {
      await assert.rejects(cli(f, args), (e) => {
        assert.equal(e.code, 1);
        assert.equal(e.stdout, "");
        assert.equal(e.stderr.trim(), REJECTION);
        assert.ok(!(e.stdout + e.stderr).includes(SECRET));
        return true;
      });
      assert.equal(await snapshot(f.root), before);
    }
  });
}

test("historical storage poll/cleanup and other starts retain their fixed diagnostic calls", async (t) => {
  for (const args of [
    ["poll", "storage"],
    ["cleanup", "storage"],
    ["start", "short"],
    ["start", "long"],
    ["start", "uncertain"],
    ["start", "scrypt"],
    ["start", "pbkdf2"],
  ]) {
    const f = await fixture(t, "configured");
    const { stdout, stderr } = await cli(f, args);
    assert.equal(stderr, "");
    assert.ok(!stdout.includes(SECRET));
    const calls = (
      await fs.readFile(path.join(f.root, "network-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls.length, 1);
    const call = calls[0];
    const evidence = JSON.parse(await fs.readFile(f.evidencePath, "utf8"));
    assert.equal(evidence.requests.length, 1);
    if (args[0] === "start") {
      assert.equal(call.url, ORIGIN + "/v1/runs");
      assert.equal(call.method, "POST");
      const body = JSON.parse(call.body);
      const workflow = ["short", "long", "uncertain"].includes(args[1]);
      assert.equal(body.kind, workflow ? "workflow" : args[1]);
      if (workflow) {
        assert.equal(body.delaySeconds, args[1] === "long" ? 840 : 65);
        assert.equal(body.mode, args[1] === "uncertain" ? "uncertain" : "success");
      }
    } else {
      assert.equal(call.url, ORIGIN + "/v1/runs/" + ID);
      assert.equal(call.method, args[0] === "poll" ? "GET" : "DELETE");
      assert.equal(evidence.runs[0].cleaned, args[0] === "cleanup");
    }
  }
});
