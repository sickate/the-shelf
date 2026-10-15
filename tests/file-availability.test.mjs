import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { canAccessFile, fileStatus } from "../src/lib/file-availability.mjs";
import { mergePublicBook } from "../cloudflare/library/core.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const file = (id, format, reason = "not_uploaded") => ({
  id,
  format,
  sizeBytes: 100,
  status: "candidate",
  reason,
  visibility: "private",
  readable: ["PDF", "EPUB"].includes(format),
});
const base = {
  id: "fixture_book",
  title: "Public fixture",
  author: null,
  category: "Fixture",
  categoryId: "fixture_category",
  tags: [],
  description: "Synthetic public catalog only",
  files: [
    file("uploaded_epub", "EPUB"),
    file("pending_pdf", "PDF"),
    file("stale_pdf", "PDF", "uploaded"),
  ],
};
const publicBook = mergePublicBook(base, {}, [
  {
    file_id: "uploaded_epub",
    book_id: base.id,
    format: "EPUB",
    size_bytes: 100,
    state: "confirmed",
  },
  {
    file_id: "stale_pdf",
    book_id: base.id,
    format: "PDF",
    size_bytes: 101,
    state: "confirmed",
  },
]);
test("cloud availability requires a matching confirmed descriptor; Pages disables and local preserves candidates", () => {
  assert.equal(publicBook.files[0].reason, "uploaded");
  assert.equal(publicBook.files[2].reason, "not_uploaded");
  assert.deepEqual(
    publicBook.files.map((f) => canAccessFile(f, "same-origin")),
    [true, false, false],
  );
  assert.ok(publicBook.files.every((f) => !canAccessFile(f, "disabled")));
  assert.ok(publicBook.files.every((f) => canAccessFile(f, "")));
  assert.equal(fileStatus(publicBook.files[0]), "已上传 · 私有");
  assert.equal(fileStatus(publicBook.files[1]), "待上传 · 私有");
  for (const patch of [
    { status: "local_only" },
    { sizeBytes: 0 },
    { sizeBytes: 20_000_001 },
    { format: "UNKNOWN" },
  ])
    assert.equal(
      canAccessFile({ ...publicBook.files[0], ...patch }, "same-origin"),
      false,
    );
});

function runFixture(root, mode) {
  const source = `import {build} from 'astro';await build({root:process.argv[1],configFile:false,output:'static',site:'https://the-shelf.iamzhutuo.workers.dev',trailingSlash:'always',base:process.env.PUBLIC_SHELF_API_MODE==='disabled'?'/the-shelf/':'/',logLevel:'error',vite:{envDir:process.argv[1]}});`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source, root],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          ASTRO_TELEMETRY_DISABLED: "1",
          PUBLIC_SHELF_API_MODE: mode,
          PUBLIC_SHELF_API_URL: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Synthetic Astro fixture failed: ${output}`)),
    );
  });
}
test("actual book template builds cloud, Pages and local actions from only synthetic public input", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-file-actions-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // No real catalog, .env, .local, private files or public artifacts are copied.
  await fs.cp(path.join(ROOT, "src"), path.join(root, "src"), {
    recursive: true,
  });
  await fs.symlink(
    path.join(ROOT, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await fs.mkdir(path.join(root, "data"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  await fs.writeFile(
    path.join(root, "data/catalog.json"),
    JSON.stringify({
      books: [publicBook],
      categories: [{ id: base.categoryId, name: base.category, count: 1 }],
      stats: {
        books: 1,
        files: 3,
        totalBytes: 300,
        candidateBytes: 300,
        candidateFiles: 3,
        localOnlyFiles: 0,
        invalidFiles: 0,
      },
      sourceStatus: "snapshot",
    }),
  );
  await fs.writeFile(
    path.join(root, "data/docs.json"),
    JSON.stringify({ documents: [] }),
  );
  for (const [mode, ids] of [
    ["same-origin", ["uploaded_epub"]],
    ["disabled", []],
    ["", ["uploaded_epub", "pending_pdf", "stale_pdf"]],
  ]) {
    await runFixture(root, mode);
    const html = await fs.readFile(
      path.join(root, "dist/books/fixture_book/index.html"),
      "utf8",
    );
    assert.deepEqual(
      [...html.matchAll(/data-download="([^"]+)"/g)].map((m) => m[1]),
      ids,
      `download actions in ${mode || "local"} mode`,
    );
    for (const f of publicBook.files)
      assert.equal(
        html.includes(`file=${f.id}`),
        ids.includes(f.id),
        `reader action for ${f.id} in ${mode || "local"}`,
      );
    assert.match(html, /已上传 · 私有/);
    if (mode) assert.match(html, /等待上传/);
  }
});
