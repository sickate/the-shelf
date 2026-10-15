import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyLocal } from "../scripts/verify-static.mjs";

async function fixture(basePath = "/", options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shelf-static-"));
  const dist = path.join(root, "dist");
  const catalogFile = path.join(root, "catalog.json");
  const site = "https://example.test";
  const write = async (relative, contents) => {
    const target = path.join(dist, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };
  const markdown = "# Public\n";
  const rawPath = `${basePath}docs/raw/overview.md`;
  const htmlPath = `${basePath}docs/overview/`;
  const html = (title, links = "") => `<!doctype html><html><head><title>${title}</title><script src="${basePath}_astro/reader.js"></script></head><body><a href="${basePath}">Home</a>${links}</body></html>`;
  await write("index.html", html("The Shelf", `<a href="${basePath}docs/overview/">Docs</a><a href="${basePath}books/book_1/">Book</a>`));
  await write("books/book_1/index.html", html("Book", "在线阅读"));
  await write("docs/index.html", html("Docs"));
  await write("docs/overview/index.html", html("Overview", '<a href="../">Docs index</a>'));
  await write("docs/raw/overview.md", markdown);
  await write("docs/all.md", markdown);
  await write("read/index.html", html("Reader"));
  const workerModule = `${basePath}_astro/pdf.worker.test.mjs`;
  await write("_astro/reader.js", options.readerMissing ? "console.log('no readers')" : 'import("./pdf.worker.test.js"); const epubjs = {}; const pdfjsLib = {};');
  await write("_astro/pdf.worker.test.js", `export default "${workerModule}";`);
  await write("_astro/pdf.worker.test.mjs", "export const worker = true;");
  const index = {
    basePath,
    version: "bundle-version",
    documents: [{
      id: "overview",
      htmlPath,
      rawPath,
      htmlUrl: `${site}${htmlPath}`,
      rawUrl: `${site}${rawPath}`,
      version: createHash("sha256").update(markdown).digest("hex"),
    }],
  };
  if (options.badDocBase) index.basePath = "/wrong/";
  await write("docs/index.json", JSON.stringify(index));
  await writeFile(catalogFile, JSON.stringify({ books: [{ id: "book_1" }] }));
  return { root, dist, catalogFile, cleanup: () => rm(root, { recursive: true, force: true }) };
}

for (const basePath of ["/", "/the-shelf/"]) {
  test(`validates complete static contract at base path ${basePath}`, async () => {
    const f = await fixture(basePath);
    try {
      const result = await verifyLocal({ dist: f.dist, catalogFile: f.catalogFile });
      assert.equal(result.basePath, basePath);
      assert.equal(result.books, 1);
    } finally {
      await f.cleanup();
    }
  });
}

test("rejects broken links in generated HTML", async () => {
  const f = await fixture("/");
  try {
    await writeFile(path.join(f.dist, "docs/overview/index.html"), '<a href="/missing/">bad</a>');
    await assert.rejects(verifyLocal({ dist: f.dist, catalogFile: f.catalogFile }), /broken internal links/);
  } finally {
    await f.cleanup();
  }
});

test("rejects a docs index whose base path disagrees with its links", async () => {
  const f = await fixture("/the-shelf/", { badDocBase: true });
  try {
    await assert.rejects(verifyLocal({ dist: f.dist, catalogFile: f.catalogFile }), /does not use docs index basePath/);
  } finally {
    await f.cleanup();
  }
});

test("rejects a reader page without both local reader libraries", async () => {
  const f = await fixture("/", { readerMissing: true });
  try {
    await assert.rejects(verifyLocal({ dist: f.dist, catalogFile: f.catalogFile }), /EPUB reader implementation is absent/);
  } finally {
    await f.cleanup();
  }
});

test("rejects a reader bundle whose PDF worker module is missing", async () => {
  const f = await fixture("/");
  try {
    await rm(path.join(f.dist, "_astro/pdf.worker.test.mjs"));
    await assert.rejects(verifyLocal({ dist: f.dist, catalogFile: f.catalogFile }), /PDF.js worker module is missing/);
  } finally {
    await f.cleanup();
  }
});

test("rejects a catalog entry without its detail page", async () => {
  const f = await fixture("/");
  try {
    await rm(path.join(f.dist, "books/book_1"), { recursive: true, force: true });
    await assert.rejects(verifyLocal({ dist: f.dist, catalogFile: f.catalogFile }), /has no static detail page/);
  } finally {
    await f.cleanup();
  }
});
