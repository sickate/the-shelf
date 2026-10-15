import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const verifier = fileURLToPath(
  new URL("../scripts/verify-public.mjs", import.meta.url),
);

function fixture(t, files = {}, catalog = { books: [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shelf-public-privacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(
    path.join(root, "data/catalog.json"),
    JSON.stringify(catalog),
  );
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return (env = {}) =>
    spawnSync(process.execPath, [verifier], {
      cwd: root,
      // Never inherit actual local credentials into a synthetic fixture.
      env,
      encoding: "utf8",
    });
}

test("public artifacts reject configured Cloudflare credentials and account identifiers", async (t) => {
  const names = [
    "SHELF_CF_OWNER_ACCESS_KEY",
    "OWNER_KEY_PEPPER",
    "SESSION_SECRET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "SHELF_CF_CHECK_OWNER_ACCESS_KEY",
    "SHELF_CF_CHECK_OWNER_KEY_PEPPER",
    "SHELF_CF_CHECK_SESSION_SECRET",
    "SHELF_CF_PRODUCTION_OWNER_ACCESS_KEY",
    "SHELF_CF_PRODUCTION_OWNER_KEY_PEPPER",
    "SHELF_CF_PRODUCTION_SESSION_SECRET",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "SHELF_CF_DEPLOY_TOKEN",
    "CF_PROBE_TOKEN",
    "SHELF_CF_PROBE_TOKEN",
    "SHELF_CF_ACCOUNT_ID",
    "SHELF_R2_ACCOUNT_ID",
  ];
  for (const [index, name] of names.entries()) {
    await t.test(name, (t) => {
      const secret = `fake-test-only-${index}-credential-value`;
      const run = fixture(t, { "dist/index.html": `<p>${secret}</p>` });
      const result = run({ [name]: secret });
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr.trim(),
        "public output contains a configured secret",
      );
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    });
  }
});

test("escaped secrets are rejected in exported documents and source maps", async (t) => {
  const secret = 'fake-test-only:+/"\\ credential';
  const examples = [
    ["public/docs/example.md", encodeURIComponent(secret)],
    ["dist/assets/app.js.map", JSON.stringify({ embedded: secret })],
  ];
  for (const [name, content] of examples) {
    await t.test(name, (t) => {
      assert.ok(!content.includes(secret));
      const result = fixture(t, { [name]: content })({
        SHELF_CF_DEPLOY_TOKEN: secret,
      });
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr.trim(),
        "public output contains a configured secret",
      );
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    });
  }
});

test("public instructions and Wrangler placeholders are permitted", (t) => {
  const run = fixture(t, {
    "public/docs/deploy.md":
      "Set CLOUDFLARE_API_TOKEN and SHELF_CF_DEPLOY_TOKEN privately; never publish their values.",
    "dist/config-example.json": JSON.stringify({
      account_id: "<ACCOUNT_ID>",
      database_id: "<D1_DATABASE_ID>",
    }),
    "dist/index.html": "<p>The Shelf</p>",
  });
  const result = run({
    CLOUDFLARE_API_TOKEN: "fake-test-only-actual-token",
    CLOUDFLARE_ACCOUNT_ID: "fake-test-only-actual-account",
    SHELF_CF_DEPLOY_TOKEN: "fake-test-only-deploy-token",
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.inspectedFiles, 3);
  assert.equal(result.stderr, "");
});

test("existing Shelf secrets and nested private catalog fields remain rejected", (t) => {
  const secret = "fake-test-only-existing-owner-password";
  const run = fixture(
    t,
    { "public/config.js": `const value = "${secret}";` },
    {
      books: [{ id: "example", files: [{ storageKey: "private-object" }] }],
    },
  );
  const result = run({ SHELF_OWNER_PASSWORD: secret });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private field storageKey/);
  assert.match(result.stderr, /public output contains a configured secret/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});
