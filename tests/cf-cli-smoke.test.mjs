import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ACCOUNT = "a".repeat(32),
  TOKEN = "fake-cli-smoke-only-project-token";
async function fixture(t, { legacy = false } = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-cli-smoke-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  // Original entrypoints execute with ROOT resolved into this synthetic project.
  // No source .env, .local, catalog, credentials or node_modules are copied.
  for (const name of [
    "cf-deploy.mjs",
    "cf-api-deploy.mjs",
    "cf-library-clients.mjs",
    "cf-library-data.mjs",
  ]) {
    let source = await fs.readFile(path.join(ROOT, "scripts", name), "utf8");
    if (legacy && name === "cf-deploy.mjs") {
      assert.match(source, /void main\(\);/);
      source = source.replace("void main();", "await main();");
    }
    await fs.writeFile(path.join(root, "scripts", name), source);
  }
  await fs.writeFile(
    path.join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "the-shelf",
      compatibility_date: "2026-10-15",
      workers_dev: true,
      preview_urls: false,
      assets: {
        directory: "./dist",
        html_handling: "force-trailing-slash",
        not_found_handling: "404-page",
      },
    }),
  );
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf03"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, ".local/cf03/deploy.json"),
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        check: {
          databaseId: "11111111-1111-4111-8111-111111111111",
          databaseName: "the-shelf-cf03-check",
        },
        production: {
          databaseId: "22222222-2222-4222-8222-222222222222",
          databaseName: "the-shelf-library",
        },
      },
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, "block-network.mjs"),
    `import fs from 'node:fs/promises';
    globalThis.fetch=async(url)=>{await fs.appendFile(new URL('./fetch-calls.txt',import.meta.url),String(url)+'\\n');throw new Error('synthetic network disabled');};`,
  );
  return root;
}
function cli(root, entry, args = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        "--import",
        path.join(root, "block-network.mjs"),
        path.join(root, "scripts", entry),
        ...args,
      ],
      {
        cwd: root,
        env: { SHELF_R2_ACCOUNT_ID: ACCOUNT, SHELF_CF_DEPLOY_TOKEN: TOKEN },
        timeout: 5000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) =>
        resolve({
          code: error?.code ?? 0,
          signal: error?.signal,
          killed: error?.killed,
          stdout,
          stderr,
        }),
    );
  });
}
function controlledFailure(result) {
  assert.equal(result.code, 1, result.stderr);
  assert.ok(
    !result.signal && !result.killed,
    "CLI must finish without timeout or termination",
  );
  assert.doesNotMatch(
    result.stderr,
    /unsettled|UnhandledPromiseRejection|uncaught|\n\s+at /i,
  );
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(ACCOUNT));
}

test("real static CLI reproduces legacy exit13, then reaches controlled offline preflight after module evaluation fix", async (t) => {
  const legacy = await fixture(t, { legacy: true }),
    broken = await cli(legacy, "cf-deploy.mjs");
  assert.equal(broken.code, 13, broken.stderr);
  assert.match(broken.stderr, /unsettled top-level await/i);
  await assert.rejects(
    fs.readFile(path.join(legacy, "fetch-calls.txt"), "utf8"),
    { code: "ENOENT" },
  );
  const root = await fixture(t),
    result = await cli(root, "cf-deploy.mjs");
  controlledFailure(result);
  assert.match(
    result.stderr,
    /Cloudflare Worker settings could not be verified/,
  );
  assert.equal(
    (await fs.readFile(path.join(root, "fetch-calls.txt"), "utf8")).trim(),
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/the-shelf/settings`,
  );
});

test("real API CLI completes module loading and reaches its precise D1 identity check offline", async (t) => {
  const root = await fixture(t),
    result = await cli(root, "cf-api-deploy.mjs", ["--profile", "check"]);
  controlledFailure(result);
  assert.match(
    result.stderr,
    /Cloudflare API operation stopped safely \(database_identity\)/,
  );
  assert.equal(
    (await fs.readFile(path.join(root, "fetch-calls.txt"), "utf8")).trim(),
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/11111111-1111-4111-8111-111111111111`,
  );
});

test("real legacy upload CLIs reject execution before filesystem, configuration and network use", async (t) => {
  const root = await fixture(t);
  for (const name of [
    "scripts/cf-library.mjs",
    "scripts/cf-library-operations.mjs",
    "cloudflare/library/core.mjs",
    "cloudflare/library/security.mjs",
    "server/upload.mjs",
    "server/storage.mjs",
    "server/config.mjs",
  ]) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.copyFile(path.join(ROOT, name), path.join(root, name));
  }
  await fs.writeFile(
    path.join(root, "refuse-effects.mjs"),
    `import fs from 'node:fs/promises';
    for (const key of Object.keys(fs)) if(typeof fs[key]==='function') fs[key]=()=>{throw new Error('filesystem_forbidden');};
    globalThis.fetch=()=>{throw new Error('network_forbidden');};`,
  );
  for (const [entry, args] of [
    ["server/upload.mjs", ["file_1", "--execute"]],
    [
      "scripts/cf-library.mjs",
      ["upload", "--profile", "production", "--file", "file_1", "--execute"],
    ],
    [
      "scripts/cf-library.mjs",
      ["reconcile", "--profile", "check", "--file", "file_1", "--execute"],
    ],
  ]) {
    const result = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [
          "--import",
          path.join(root, "refuse-effects.mjs"),
          path.join(root, entry),
          ...args,
        ],
        {
          cwd: root,
          env: { SHELF_PORT: "invalid" },
          timeout: 5000,
          encoding: "utf8",
        },
        (error, stdout, stderr) =>
          resolve({
            code: error?.code ?? 0,
            signal: error?.signal,
            killed: error?.killed,
            stdout,
            stderr,
          }),
      ),
    );
    controlledFailure(result);
    assert.match(result.stderr, /legacy_storage_migration_required/);
    assert.doesNotMatch(
      result.stderr,
      /filesystem_forbidden|network_forbidden|Invalid SHELF_PORT/,
    );
  }
});
