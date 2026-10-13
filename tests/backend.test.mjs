import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../server/config.mjs";
import { createServer } from "../server/index.mjs";
import { callTask } from "../server/jobs.mjs";
import { validateFile, presign } from "../server/storage.mjs";
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-test-"));
  await fs.writeFile(path.join(root, "book.pdf"), "0123456789");
  const stat = await fs.stat(path.join(root, "book.pdf"), { bigint: true });
  const config = {
    ...getConfig({
      SHELF_OWNER_PASSWORD: "test-password",
      SHELF_STATE_DIR: root,
      SHELF_MANIFEST_PATH: path.join(root, "manifest.json"),
      SHELF_CATALOG_PATH: path.join(root, "catalog.json"),
      SHELF_LOCAL_FILES_ENABLED: "true",
      SHELF_OAI_KEY: "mock-key",
      SHELF_OAI_BASE_URL: "https://mock.invalid",
    }),
    ...overrides,
  };
  const manifest = {
    root,
    files: {
      f1: {
        path: path.join(root, "book.pdf"),
        bookId: "b1",
        format: "PDF",
        sizeBytes: 10,
        mtimeNs: String(stat.mtimeNs),
        eligibility: "candidate",
      },
    },
  };
  const catalog = {
    books: [
      {
        id: "b1",
        title: "测试",
        author: null,
        sourcePath: "/private/secret",
        files: [
          {
            id: "f1",
            format: "PDF",
            sizeBytes: 10,
            status: "candidate",
            sourcePath: "/secret",
          },
        ],
      },
    ],
  };
  const server = await createServer(config, {
    catalog,
    manifest,
    worker: false,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await server.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    server,
    config,
    manifest,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}
const origin = "http://127.0.0.1:4321";
async function login(base) {
  const res = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);
  return {
    cookie: res.headers.get("set-cookie").split(";")[0],
    csrf: (await res.json()).csrfToken,
  };
}
test("owner auth, strict origin, CSRF, public privacy, private byte ranges", async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(base + "/api/files/f1/content")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/login", {
        method: "POST",
        headers: { Origin: "https://evil.invalid" },
        body: "{}",
      })
    ).status,
    403,
  );
  const session = await login(base);
  const headers = { Cookie: session.cookie, Origin: origin };
  const data = await (await fetch(base + "/api/books/b1")).json();
  assert.equal(JSON.stringify(data).includes("/secret"), false);
  const partial = await fetch(base + "/api/files/f1/content", {
    headers: { ...headers, Range: "bytes=2-5" },
  });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), "2345");
  const head = await fetch(base + "/api/files/f1/content", {
    method: "HEAD",
    headers,
  });
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  assert.equal(
    (
      await fetch(base + "/api/files/f1/content", {
        headers: { ...headers, Range: "bytes=50-" },
      })
    ).status,
    416,
  );
  assert.equal(
    (await fetch(base + "/api/logout", { method: "POST", headers })).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/logout", {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": session.csrf },
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(base + "/api/files/f1/content", { headers })).status,
    401,
  );
});
test("threshold, empty, mismatch, and symlink escape cannot bypass validation", async (t) => {
  const { manifest, config } = await fixture(t);
  for (const size of [0, 20000001, 11]) {
    manifest.files.f1.sizeBytes = size;
    await assert.rejects(validateFile(manifest, "f1"));
  }
  manifest.files.f1.sizeBytes = 10;
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret"), "0123456789");
  await fs.symlink(
    path.join(outside, "secret"),
    path.join(config.stateDir, "link"),
  );
  manifest.files.f1.path = path.join(config.stateDir, "link");
  await assert.rejects(validateFile(manifest, "f1"), {
    code: "file_outside_root",
  });
});
test("local files disabled by default", async (t) => {
  const { base } = await fixture(t, { localFilesEnabled: false });
  const s = await login(base);
  assert.equal(
    (
      await fetch(base + "/api/files/f1/content", {
        headers: { Cookie: s.cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/files/f1/access", {
        headers: { Cookie: s.cookie },
      })
    ).status,
    503,
  );
});
test("in-flight jobs deduplicate, persist, remain private, and unconfigured fails", async (t) => {
  const { base, server } = await fixture(t);
  const s = await login(base);
  const headers = {
    Origin: origin,
    Cookie: s.cookie,
    "X-CSRF-Token": s.csrf,
    "Content-Type": "application/json",
  };
  const create = () =>
    fetch(base + "/api/books/b1/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "question", question: "测试问题" }),
    });
  const a = await (await create()).json(),
    b = await (await create()).json();
  assert.equal(a.job.id, b.job.id);
  assert.equal(a.job.input, undefined);
  assert.equal(a.job.status, "queued");
  assert.equal((await fetch(base + "/api/jobs/" + a.job.id)).status, 401);
  assert.deepEqual(
    await (await fetch(base + "/api/books/b1/published")).json(),
    { jobs: [] },
  );
  assert.equal(
    server.queue.db.prepare("SELECT count(*) AS n FROM jobs").get().n,
    1,
  );
});
test("task adapter uses named nonstream tasks and never retries ambiguous failures", async () => {
  const config = getConfig({
    SHELF_OAI_BASE_URL: "https://mock.invalid/v1",
    SHELF_OAI_KEY: "private",
  });
  let count = 0;
  const fake = async (url, request) => {
    count++;
    assert.equal(url.pathname, "/v1/tasks");
    const input = JSON.parse(request.body);
    assert.equal(input.kind, "topic_analysis");
    assert.equal(input.model, "gpt-luna");
    return {
      ok: true,
      json: async () => ({
        content: "依据材料的答复",
        usage: { input_tokens: 3 },
      }),
    };
  };
  assert.equal(
    (await callTask(config, "材料", "question", "gpt-luna", fake)).content,
    "依据材料的答复",
  );
  await assert.rejects(
    callTask(config, "x", "question", "gpt-luna", async () => {
      count++;
      throw new Error("timeout");
    }),
    { code: "upstream_uncertain" },
  );
  assert.equal(count, 2);
  await assert.rejects(
    callTask(config, "x", "question", "gpt-luna", async () => ({
      ok: true,
      json: async () => ({ content: null }),
    })),
    { code: "upstream_invalid_response" },
  );
});
test("SigV4 presigned URLs are limited to configured bucket and five minutes", () => {
  const url = new URL(
    presign(
      {
        r2Account: "account",
        r2Bucket: "private",
        r2AccessKey: "id",
        r2Secret: "secret",
      },
      "books/f1.pdf",
      "GET",
      new Date("2026-10-13T00:00:00Z"),
    ),
  );
  assert.equal(url.hostname, "account.r2.cloudflarestorage.com");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(url.pathname, "/private/books/f1.pdf");
  assert.equal(url.searchParams.get("X-Amz-Signature").length, 64);
});
test("summary maps genuine source chunks, call budget preserves partials, restart marks running uncertain", async (t) => {
  const { server, manifest, config } = await fixture(t);
  const { JobQueue } = await import("../server/jobs.mjs");
  await fs.writeFile(
    path.join(config.stateDir, "book.txt"),
    "第一章证据。".repeat(12000),
  );
  manifest.files.f1.textPath = path.join(config.stateDir, "book.txt");
  const workerRoot = path.join(config.stateDir, "worker");
  await fs.mkdir(workerRoot);
  const worker = new JobQueue(
    { ...config, stateDir: workerRoot, jobCalls: 1 },
    {
      books: [
        { id: "b1", title: "测试", files: [{ id: "f1", format: "PDF" }] },
      ],
    },
    manifest,
    {
      worker: false,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ content: "已总结片段" }),
      }),
    },
  );
  worker.config.stateDir = config.stateDir;
  const j = worker.create(
    { id: "b1", files: [{ id: "f1" }] },
    { operation: "full_summary" },
  );
  await worker.pump();
  const result = worker.get(j.id);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "call_budget_exceeded");
  assert.equal(result.coverage.completedChunks, 0);
  assert.ok(result.coverage.totalChunks > 1);
  assert.equal(
    worker.db.prepare("SELECT count(*) AS n FROM partials").get().n,
    0,
  );
  const row = JSON.parse(
    worker.db.prepare("SELECT data FROM jobs WHERE id=?").get(j.id).data,
  );
  row.status = "running";
  worker.save(row);
  await worker.close();
  const restarted = new JobQueue(
    { ...config, stateDir: workerRoot },
    { books: [] },
    manifest,
    { worker: false },
  );
  assert.equal(restarted.get(j.id).status, "uncertain");
  assert.equal(restarted.get(j.id).error.code, "restart_uncertain");
  await restarted.close();
  assert.throws(
    () =>
      server.queue.create(
        { id: "b1", files: [] },
        { operation: "question", question: "x", model: "invented" },
      ),
    { code: "invalid_job" },
  );
});
test("unconfigured model and upload budget reject before any network request", async (t) => {
  const { config, server, manifest } = await fixture(t, { aiKey: "" });
  assert.throws(
    () => server.queue.create({ id: "b1", files: [] }, { operation: "author" }),
    { code: "ai_unconfigured" },
  );
  const { uploadSelected } = await import("../server/upload.mjs");
  await fs.writeFile(config.manifestPath, JSON.stringify(manifest));
  const plan = await uploadSelected(config, ["f1"], {
    fetchImpl: () => {
      throw Error("must not fetch");
    },
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.bytes, 10);
  await assert.rejects(uploadSelected({ ...config, r2Budget: 9 }, ["f1"]), {
    code: "storage_budget_exceeded",
  });
});
test("prepared private text works without source mount; R2 acquisition rejects oversized response", async (t) => {
  const { config, manifest } = await fixture(t);
  const { getChunks } = await import("../server/jobs.mjs");
  assert.ok(
    BigInt(manifest.files.f1.mtimeNs) > BigInt(Number.MAX_SAFE_INTEGER),
  );
  await validateFile(manifest, "f1");
  await fs.writeFile(
    path.join(config.stateDir, "prepared.txt"),
    "中文证据与章节材料。",
  );
  manifest.files.f1.textPath = path.join(config.stateDir, "prepared.txt");
  manifest.files.f1.path = "/missing/source/on/remote-host";
  const chunks = await getChunks(
    { files: [{ id: "f1", format: "PDF" }] },
    manifest,
    { ...config, localFilesEnabled: false },
  );
  assert.match(chunks[0].text, /中文证据/);
  delete manifest.files.f1.textPath;
  manifest.files.f1.storageKey = "books/f1.pdf";
  let requests = 0;
  await assert.rejects(
    getChunks(
      { files: [{ id: "f1", format: "PDF" }] },
      manifest,
      {
        ...config,
        localFilesEnabled: false,
        r2Account: "account",
        r2Bucket: "books",
        r2AccessKey: "test",
        r2Secret: "test",
      },
      async (url) => {
        requests++;
        assert.equal(new URL(url).hostname, "account.r2.cloudflarestorage.com");
        return {
          ok: true,
          body: (async function* () {
            yield Buffer.alloc(11);
          })(),
        };
      },
    ),
    { code: "source_size_mismatch" },
  );
  assert.equal(requests, 1);
});
test("full summary persists every packed partial and reports real total coverage", async (t) => {
  const { config, manifest } = await fixture(t);
  const { JobQueue } = await import("../server/jobs.mjs");
  await fs.writeFile(
    path.join(config.stateDir, "text.txt"),
    "中文正文证据。".repeat(10000),
  );
  manifest.files.f1.textPath = path.join(config.stateDir, "text.txt");
  let calls = 0;
  const worker = new JobQueue(
    config,
    {
      books: [
        { id: "b1", title: "测试", files: [{ id: "f1", format: "PDF" }] },
      ],
    },
    manifest,
    {
      worker: false,
      fetchImpl: async () => {
        calls++;
        return { ok: true, json: async () => ({ content: "完整材料总结" }) };
      },
    },
  );
  const j = worker.create(
    { id: "b1", files: [{ id: "f1" }] },
    { operation: "full_summary" },
  );
  await worker.pump();
  const result = worker.get(j.id);
  assert.equal(result.status, "completed");
  assert.equal(result.coverage.completedChunks, result.coverage.totalChunks);
  assert.equal(calls, result.coverage.requiredCalls);
  assert.equal(
    worker.db
      .prepare("SELECT count(*) AS n FROM partials WHERE job=?")
      .get(j.id).n,
    calls - 1,
  );
  await worker.close();
});
test("metadata owner writes validate fields, require CSRF, persist overrides and sanitize public catalog", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-metadata-"));
  const config = getConfig({
    SHELF_STATE_DIR: root,
    SHELF_CATALOG_PATH: path.join(root, "catalog.json"),
    SHELF_MANIFEST_PATH: path.join(root, "manifest.json"),
    SHELF_OWNER_PASSWORD: "test-password",
  });
  const initial = {
    schemaVersion: 1,
    root: "/secret",
    stats: { books: 1, secret: "hidden" },
    categories: [{ id: "old", name: "原分类", count: 1 }],
    books: [
      {
        id: "b1",
        title: "原题",
        author: null,
        category: "原分类",
        categoryId: "old",
        files: [],
        sourcePath: "/secret",
      },
    ],
  };
  await fs.writeFile(config.catalogPath, JSON.stringify(initial));
  let server = await createServer(config, { worker: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await server.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  let base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (
      await fetch(base + "/api/books/b1/metadata", {
        method: "POST",
        headers: { Origin: origin },
        body: "{}",
      })
    ).status,
    401,
  );
  const s = await login(base);
  const headers = {
    Origin: origin,
    Cookie: s.cookie,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await fetch(base + "/api/books/b1/metadata", {
        method: "POST",
        headers,
        body: '{"author":"作者"}',
      })
    ).status,
    403,
  );
  headers["X-CSRF-Token"] = s.csrf;
  for (const input of [
    { sourcePath: "/private" },
    { author: 5 },
    { title: "" },
    { tags: ["x", 4] },
    { description: "x".repeat(4001) },
  ])
    assert.equal(
      (
        await fetch(base + "/api/books/b1/metadata", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
      400,
    );
  const saved = await fetch(base + "/api/books/b1/metadata", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "新题",
      author: "真实作者",
      tags: ["中文", "中文"],
      category: "新分类",
    }),
  });
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.book.author, "真实作者");
  assert.deepEqual(result.book.tags, ["中文"]);
  assert.equal(
    (await (await fetch(base + "/api/books/b1")).json()).title,
    "新题",
  );
  const overrides = JSON.parse(
    await fs.readFile(path.join(root, "overrides.json"), "utf8"),
  );
  assert.equal(overrides.books.b1.author, "真实作者");
  assert.equal(
    (await fs.stat(path.join(root, "overrides.json"))).mode & 0o777,
    0o600,
  );
  const publicData = JSON.parse(await fs.readFile(config.catalogPath, "utf8"));
  assert.equal(publicData.books[0].author, "真实作者");
  assert.equal(JSON.stringify(publicData).includes("/secret"), false);
  assert.equal(publicData.stats.secret, undefined);
  await server.shutdown();
  await fs.writeFile(config.catalogPath, JSON.stringify(initial));
  server = await createServer(config, { worker: false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (await (await fetch(base + "/api/books/b1")).json()).author,
    "真实作者",
  );
});
test("existing private state permissions tightened without changing source directory", async (t) => {
  const { server, config, manifest } = await fixture(t);
  const { JobQueue, getChunks } = await import("../server/jobs.mjs");
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-source-"));
  await fs.chmod(sourceRoot, 0o755);
  manifest.root = sourceRoot;
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));
  await fs.chmod(config.stateDir, 0o755);
  const queue = new JobQueue(config, { books: [] }, manifest, {
    worker: false,
  });
  assert.equal((await fs.stat(config.stateDir)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(config.stateDir, "jobs.sqlite"))).mode & 0o777,
    0o600,
  );
  const text = path.join(config.stateDir, "permissions.txt");
  await fs.writeFile(text, "可读正文", { mode: 0o644 });
  manifest.files.f1.textPath = text;
  await getChunks({ files: [{ id: "f1", format: "PDF" }] }, manifest, config);
  assert.equal((await fs.stat(text)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(sourceRoot)).mode & 0o777, 0o755);
  await queue.close();
});
test("task adapter refuses oversized upstream JSON before unbounded accumulation", async () => {
  const config = getConfig({
    SHELF_OAI_BASE_URL: "https://mock.invalid",
    SHELF_OAI_KEY: "private",
  });
  await assert.rejects(
    callTask(config, "材料", "question", "gpt-luna", async () => ({
      ok: true,
      body: (async function* () {
        yield Buffer.alloc(1_000_001);
      })(),
    })),
    { code: "upstream_response_too_large" },
  );
});
