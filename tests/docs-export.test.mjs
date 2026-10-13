import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportDocs, PUBLIC_DOCS } from "../scripts/export-docs.mjs";

test("exports only the explicit public whitelist and preserves original markdown links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shelf-docs-"));
  try {
    await mkdir(path.join(root, "docs"));
    for (const [filename] of PUBLIC_DOCS) {
      await writeFile(
        path.join(root, "docs", filename),
        `# ${filename}\n\n更新日期：2026 年 10 月 13 日。阶段：设计。\n\nBody with [relative link](other.md).\n`,
      );
    }
    await writeFile(
      path.join(root, "docs", "private-ops.md"),
      "# private\nsecret\n",
    );
    const result = await exportDocs(root);
    assert.equal(result.count, PUBLIC_DOCS.length);
    const bundle = JSON.parse(
      await readFile(path.join(root, "data/docs.json"), "utf8"),
    );
    const index = JSON.parse(
      await readFile(path.join(root, "public/docs/index.json"), "utf8"),
    );
    assert.equal(bundle.documents.length, PUBLIC_DOCS.length);
    assert.equal(index.documents.length, PUBLIC_DOCS.length);
    assert.deepEqual(
      bundle.documents.map((d) => d.id),
      PUBLIC_DOCS.map(([, id]) => id),
    );
    assert.equal(bundle.documents[0].htmlPath, "docs");
    assert.equal(bundle.documents[0].rawPath, "docs/raw/overview.md");
    assert.match(
      bundle.documents[0].markdown,
      /\[relative link\]\(other\.md\)/,
    );
    assert.ok(bundle.documents.every((d) => d.version.length === 64));
    assert.ok(index.documents.every((d) => !("markdown" in d)));
    await exportDocs(root, {
      siteUrl: "https://example.com",
      basePath: "/the-shelf/",
    });
    const prefixedIndex = JSON.parse(
      await readFile(path.join(root, "public/docs/index.json"), "utf8"),
    );
    assert.equal(
      prefixedIndex.documents[0].htmlUrl,
      "https://example.com/the-shelf/docs/",
    );
    assert.equal(
      prefixedIndex.documents[0].rawPath,
      "/the-shelf/docs/raw/overview.md",
    );
    const all = await readFile(path.join(root, "public/docs/all.md"), "utf8");
    assert.doesNotMatch(all, /private-ops|secret/);
    assert.doesNotMatch(all, /\/Users\/|\/private\/|secret/);
    assert.equal(
      await readFile(path.join(root, "public/docs/raw/overview.md"), "utf8"),
      bundle.documents[0].markdown,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository export contains requested public docs without private manifest fields", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  await exportDocs(root);
  const raw = await readFile(path.join(root, "public/docs/all.md"), "utf8");
  assert.match(raw, /数据与接口契约/);
  assert.match(raw, /开发计划/);
  assert.doesNotMatch(
    raw,
    /\/Users\/paw\/code\/|\/private\/var\/|\/home\/[a-z0-9_-]+\//i,
  );
});
