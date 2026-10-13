import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildJobInput } from "../src/lib/job-input.mjs";
import { getConfig } from "../server/config.mjs";
import { createServer } from "../server/index.mjs";

test("chapter form text becomes a valid numeric backend request", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-client-"));
  const config = getConfig({
    SHELF_STATE_DIR: state,
    SHELF_OWNER_PASSWORD: "client-test-only",
    SHELF_OAI_BASE_URL: "https://unused.invalid",
    SHELF_OAI_KEY: "unused-test-key",
  });
  const server = await createServer(config, {
    catalog: { books: [{ id: "book1", title: "Fixture", files: [] }] },
    manifest: { files: {} },
    worker: false,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.shutdown();
    await fs.rm(state, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:4321",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: "client-test-only" }),
  });
  const csrf = (await login.json()).csrfToken;
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const payload = buildJobInput({
    operation: "chapter_summary",
    chapter: "3",
    question: "",
    model: "gpt-luna",
  });
  const response = await fetch(base + "/api/books/book1/jobs", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:4321",
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).job.status, "queued");
  assert.throws(() =>
    buildJobInput({
      operation: "chapter_summary",
      chapter: "章节三",
      model: "gpt-luna",
    }),
  );
});
