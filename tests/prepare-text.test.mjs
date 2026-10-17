import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  prepareText,
  runBounded,
  PREPARED_TEXT_LIMIT,
} from "../scripts/prepare-text.mjs";

const fileId = "file_1234567890abcdef";
const bookId = "book_1234567890abcdef";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const cli = path.resolve("scripts/prepare-text.mjs");
const hasPDF = spawnSync("pdftotext", ["-v"]).status === 0;
function pdf(pages) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const children = [];
  for (const text of pages) {
    const content = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
    const pageNumber = objects.length + 1;
    children.push(`${pageNumber} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${children.join(" ")}] /Count ${pages.length} >>`;
  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return result;
}
async function fixture(
  t,
  {
    format = "EPUB",
    chapters = ["First chapter.", "第二章 😀正文。"],
    raw,
    files,
  } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-prepared-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "private-sources");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(projectRoot);
  const sourcePath = path.join(
    sourceRoot,
    `secret-book.${format.toLowerCase()}`,
  );
  if (raw !== undefined || format !== "EPUB")
    await fs.writeFile(sourcePath, raw ?? pdf(chapters));
  else {
    const archive = files ?? {
      "META-INF/container.xml":
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      "OEBPS/content.opf": `<package xmlns="http://www.idpf.org/2007/opf"><manifest>${chapters.map((_, i) => `<item id="c${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`,
      ...Object.fromEntries(
        chapters.map((chapter, i) => [
          `OEBPS/chapter${i}.xhtml`,
          `<html><head><style>SECRET CSS</style></head><body><p>${chapter}</p><script>SECRET JS</script></body></html>`,
        ]),
      ),
    };
    execFileSync(
      "python3",
      [
        "-c",
        'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.load(sys.stdin).items()]; z.close()',
        sourcePath,
      ],
      { input: JSON.stringify(archive) },
    );
  }
  const info = await fs.stat(sourcePath, { bigint: true });
  const manifest = {
    schemaVersion: 1,
    root: sourceRoot,
    files: {
      [fileId]: {
        path: sourcePath,
        bookId,
        format,
        sizeBytes: Number(info.size),
        mtimeNs: String(info.mtimeNs),
        eligibility: "candidate",
        visibility: "private",
        textPath: "/do/not/read/old-text",
        storageKey: "do/not/contact/r2",
      },
    },
  };
  const manifestPath = path.join(root, "private-manifest.json");
  const save = () =>
    fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await save();
  const options = { fileId, manifestPath, projectRoot };
  return {
    root,
    sourceRoot,
    sourcePath,
    projectRoot,
    manifestPath,
    manifest,
    save,
    options,
  };
}
async function readPackage(f, result) {
  return JSON.parse(
    await fs.readFile(path.join(f.projectRoot, result.artifact), "utf8"),
  );
}
const code = (expected) => (error) => error.code === expected;

test("dry-run selects exactly one file, only stats even corrupt input, and writes nothing", async (t) => {
  const f = await fixture(t, { format: "PDF", raw: "not a PDF PRIVATE BODY" });
  f.manifest.files.file_aaaaaaaaaaaaaaaa = { path: "/must/not/be/opened" };
  await f.save();
  const sourceBefore = await fs.readFile(f.sourcePath);
  const manifestBefore = await fs.readFile(f.manifestPath);
  assert.deepEqual(await prepareText(f.options), {
    status: "dry-run",
    fileId,
    bookId,
    format: "PDF",
    sizeBytes: sourceBefore.length,
    wouldPrepare: true,
  });
  assert.deepEqual(await fs.readdir(f.projectRoot), []);
  assert.deepEqual(await fs.readFile(f.sourcePath), sourceBefore);
  assert.deepEqual(await fs.readFile(f.manifestPath), manifestBefore);
  const result = spawnSync(
    process.execPath,
    [cli, "--file", fileId, "--manifest", f.manifestPath],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "dry-run");
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(f.root));
});

test("real EPUB has spine locators, stable Unicode chunks, verifiable hashes and private immutable packages", async (t) => {
  const chapter = "开篇😀".repeat(2500);
  const f = await fixture(t, { chapters: [chapter, "Second chapter."] });
  const oldManifest = await fs.readFile(f.manifestPath);
  const source = await fs.readFile(f.sourcePath);
  const result = await prepareText({ ...f.options, execute: true });
  assert.equal(result.status, "prepared");
  const body = await readPackage(f, result);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.source.fileId, fileId);
  assert.equal(body.source.bookId, bookId);
  assert.equal(body.source.sizeBytes, source.length);
  assert.equal(body.source.fingerprint.value, sha(source));
  assert.equal(body.source.mtimeNs, f.manifest.files[fileId].mtimeNs);
  assert.equal(
    body.chunks
      .filter((c) => c.locator.spineIndex === 0)
      .map((c) => c.text)
      .join(""),
    chapter,
  );
  assert.equal(body.chunks.at(-1).locator.spineIndex, 1);
  assert.equal(body.chunks[0].locator.end, 6000);
  assert.equal(body.chunks[1].locator.start, 6000);
  assert.equal(body.chunks[0].locator.type, "epub-spine");
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  assert.ok(!JSON.stringify(body).includes(f.root));
  assert.ok(!JSON.stringify(body).includes("secret-book"));
  for (const chunk of body.chunks) assert.equal(chunk.sha256, sha(chunk.text));
  assert.equal(body.contentHash, sha(JSON.stringify(body.chunks)));
  const { versionHash, ...unhashed } = body;
  assert.equal(versionHash, sha(JSON.stringify(unhashed)));
  for (const relative of [
    ".local",
    ".local/prepared-text",
    `.local/prepared-text/${fileId}`,
  ])
    assert.equal(
      (await fs.stat(path.join(f.projectRoot, relative))).mode & 0o777,
      0o700,
    );
  const artifact = path.join(f.projectRoot, result.artifact);
  assert.equal((await fs.stat(artifact)).mode & 0o777, 0o600);
  const before = await fs.stat(artifact, { bigint: true });
  assert.equal(
    (await prepareText({ ...f.options, execute: true })).status,
    "reused",
  );
  const after = await fs.stat(artifact, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.deepEqual(await fs.readFile(f.manifestPath), oldManifest);
  assert.deepEqual(await fs.readFile(f.sourcePath), source);
  assert.deepEqual(await fs.readdir(f.projectRoot), [".local"]);
  // Same name, modified payload must be rejected rather than overwritten or trusted by its filename.
  const tampered = JSON.stringify({
    ...body,
    chunks: [{ ...body.chunks[0], text: "tampered" }],
  });
  await fs.writeFile(artifact, tampered);
  await assert.rejects(
    prepareText({ ...f.options, execute: true }),
    code("existing_package_invalid"),
  );
  assert.equal(await fs.readFile(artifact, "utf8"), tampered);
});

test(
  "real PDF extraction preserves page numbers, including a blank page",
  { skip: !hasPDF && "pdftotext unavailable" },
  async (t) => {
    const f = await fixture(t, {
      format: "PDF",
      chapters: ["First page proof", "", "Third page proof"],
    });
    const result = await prepareText({ ...f.options, execute: true });
    const body = await readPackage(f, result);
    assert.deepEqual(
      body.chunks.map((chunk) => chunk.locator.page),
      [1, 3],
    );
    assert.equal(body.chunks[0].text, "First page proof");
    assert.equal(body.chunks[1].text, "Third page proof");
    assert.equal(body.chunks[1].locator.type, "pdf-page");
  },
);

test("empty text, corrupt EPUB/PDF and unsupported format fail without packages", async (t) => {
  for (const [settings, expected] of [
    [{ chapters: ["   "] }, "empty_text"],
    [{ raw: "corrupt PRIVATE EPUB" }, "epub_extraction_failed"],
    ...(hasPDF
      ? [
          [{ format: "PDF", chapters: [""] }, "empty_text"],
          [
            { format: "PDF", raw: "corrupt PRIVATE PDF" },
            "pdf_extraction_failed",
          ],
        ]
      : []),
    [{ format: "MOBI", raw: "mobi" }, "unsupported_format"],
  ]) {
    const f = await fixture(t, settings);
    await assert.rejects(
      prepareText({ ...f.options, execute: true }),
      code(expected),
    );
    assert.deepEqual(await fs.readdir(f.projectRoot), []);
  }
});

test("manifest mismatch, oversized and zero-byte sources are rejected before extraction", async (t) => {
  const f = await fixture(t);
  f.manifest.files[fileId].mtimeNs = "0";
  await f.save();
  await assert.rejects(prepareText(f.options), code("source_changed"));
  f.manifest.files[fileId].sizeBytes = PREPARED_TEXT_LIMIT + 1;
  await f.save();
  await assert.rejects(prepareText(f.options), code("source_too_large"));
  f.manifest.files[fileId].sizeBytes = 0;
  await f.save();
  await assert.rejects(prepareText(f.options), code("empty_source"));
  assert.deepEqual(await fs.readdir(f.projectRoot), []);
});

test("source boundary, leaf and ancestor symlinks are refused", async (t) => {
  const f = await fixture(t);
  const original = f.manifest.files[fileId].path;
  f.manifest.files[fileId].path = f.manifestPath;
  await f.save();
  await assert.rejects(prepareText(f.options), code("source_outside_root"));
  const alias = path.join(f.sourceRoot, "alias.epub");
  await fs.symlink(original, alias);
  f.manifest.files[fileId].path = alias;
  await f.save();
  await assert.rejects(prepareText(f.options), code("unsafe_path"));
  const dirAlias = path.join(f.root, "linked-sources");
  await fs.symlink(f.sourceRoot, dirAlias);
  f.manifest.root = dirAlias;
  f.manifest.files[fileId].path = path.join(dirAlias, path.basename(original));
  await f.save();
  await assert.rejects(prepareText(f.options), code("unsafe_path"));
  assert.deepEqual(await fs.readdir(f.projectRoot), []);
});

test("every private output directory layer and artifact rejects symlinks", async (t) => {
  for (const layer of [
    ".local",
    ".local/prepared-text",
    `.local/prepared-text/${fileId}`,
  ]) {
    const f = await fixture(t);
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside, { mode: 0o700 });
    const target = path.join(f.projectRoot, layer);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.symlink(outside, target);
    await assert.rejects(
      prepareText({ ...f.options, execute: true }),
      code("unsafe_path"),
    );
    assert.deepEqual(await fs.readdir(outside), []);
  }
  const f = await fixture(t);
  const result = await prepareText({ ...f.options, execute: true });
  const artifact = path.join(f.projectRoot, result.artifact);
  const outside = path.join(f.root, "outside-artifact");
  await fs.rename(artifact, outside);
  await fs.symlink(outside, artifact);
  const before = await fs.readFile(outside);
  await assert.rejects(
    prepareText({ ...f.options, execute: true }),
    code("existing_package_invalid"),
  );
  assert.deepEqual(await fs.readFile(outside), before);
});

test("source drift during extraction rejects the otherwise successful extracted output", async (t) => {
  const f = await fixture(t, { format: "PDF", raw: "synthetic placeholder" });
  const tools = path.join(f.root, "tools");
  await fs.mkdir(tools);
  await fs.writeFile(
    path.join(tools, "pdftotext"),
    `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(f.sourcePath)}, 'changed');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write('apparently valid extraction\\f'));\n`,
    { mode: 0o700 },
  );
  const previous = process.env.PATH;
  process.env.PATH = tools + path.delimiter + previous;
  try {
    await assert.rejects(
      prepareText({ ...f.options, execute: true }),
      code("source_changed"),
    );
  } finally {
    process.env.PATH = previous;
  }
  assert.deepEqual(await fs.readdir(f.projectRoot), []);
});

test("bounded child processes terminate on timeout, stdout and stderr floods", async () => {
  await assert.rejects(
    runBounded(process.execPath, ["-e", "setInterval(()=>{},1000)"], "", {
      maxBytes: 100,
      timeoutMs: 30,
    }),
    code("extraction_timeout"),
  );
  await assert.rejects(
    runBounded(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(100000))'],
      "",
      { maxBytes: 100, timeoutMs: 2000 },
    ),
    code("extraction_output_limit"),
  );
  await assert.rejects(
    runBounded(
      process.execPath,
      ["-e", 'process.stderr.write("PRIVATE".repeat(20000))'],
      "",
      { maxBytes: 100, timeoutMs: 2000 },
    ),
    code("extraction_output_limit"),
  );
});

test("CLI errors contain only safe codes and never source paths, parser stderr or text", async (t) => {
  const f = await fixture(t, { raw: "SECRET_PRIVATE_BODY" });
  const before = await fs.readFile(f.manifestPath);
  const result = spawnSync(
    process.execPath,
    [cli, "--file", fileId, "--manifest", f.manifestPath, "--execute"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, '{"code":"epub_extraction_failed"}\n');
  assert.ok(!result.stderr.includes(f.root));
  assert.deepEqual(await fs.readFile(f.manifestPath), before);
  const noFile = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(noFile.stderr, '{"code":"file_required"}\n');
});

test("execute must be a boolean; malformed module arguments cannot create output", async (t) => {
  const f = await fixture(t);
  for (const execute of ["false", "true", 1, null, {}])
    await assert.rejects(
      prepareText({ ...f.options, execute }),
      code("invalid_execute"),
    );
  await assert.rejects(
    prepareText({ ...f.options, projectRoot: {} }),
    code("invalid_arguments"),
  );
  await assert.rejects(
    prepareText({ ...f.options, manifestPath: null }),
    code("invalid_arguments"),
  );
  assert.deepEqual(await fs.readdir(f.projectRoot), []);
  await assert.rejects(
    runBounded(process.execPath, [], "", {}),
    code("invalid_process_limits"),
  );
});

test("standard EPUB XHTML DOCTYPE is supported without loading external resources; XML DTD rejected", async (t) => {
  const files = {
    "META-INF/container.xml":
      '<container><rootfile full-path="content.opf"/></container>',
    "content.opf":
      '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>',
    "chapter.xhtml":
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "https://invalid.invalid/never-download.dtd"><html><body><p>Standard EPUB text &amp; proof.</p></body></html>',
  };
  const f = await fixture(t, { files });
  const result = await prepareText({ ...f.options, execute: true });
  assert.equal(
    (await readPackage(f, result)).chunks[0].text,
    "Standard EPUB text & proof.",
  );
  const poisoned = await fixture(t, {
    files: {
      ...files,
      "META-INF/container.xml":
        '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///private/secret">]><container><rootfile full-path="content.opf"/></container>',
    },
  });
  await assert.rejects(
    prepareText({ ...poisoned.options, execute: true }),
    code("epub_extraction_failed"),
  );
  assert.deepEqual(await fs.readdir(poisoned.projectRoot), []);
  // Legacy server invocation still yields only its original label/text contract.
  const legacy = JSON.parse(
    execFileSync("python3", ["server/extract-epub.py", f.sourcePath], {
      encoding: "utf8",
    }),
  );
  assert.deepEqual(Object.keys(legacy[0]), ["label", "text"]);
  assert.equal(legacy[0].text.trim(), "Standard EPUB text & proof.");
});

test("EPUB expansion and final JSON package limits reject without publishing partial output", async (t) => {
  const huge = await fixture(t, {
    chapters: ["A".repeat(PREPARED_TEXT_LIMIT + 1)],
  });
  await assert.rejects(
    prepareText({ ...huge.options, execute: true }),
    code("epub_extraction_failed"),
  );
  assert.deepEqual(await fs.readdir(huge.projectRoot), []);
  // PDF output can fit its 20MB stream bound while chunk metadata pushes its final package over it.
  const f = await fixture(t, { format: "PDF", raw: "synthetic placeholder" });
  const tools = path.join(f.root, "tools");
  await fs.mkdir(tools);
  await fs.writeFile(
    path.join(tools, "pdftotext"),
    `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write('A'.repeat(19_500_000)));\n`,
    { mode: 0o700 },
  );
  const previous = process.env.PATH;
  process.env.PATH = tools + path.delimiter + previous;
  try {
    await assert.rejects(
      prepareText({ ...f.options, execute: true }),
      code("package_too_large"),
    );
  } finally {
    process.env.PATH = previous;
  }
  assert.deepEqual(await fs.readdir(f.projectRoot), []);
});

test("standalone CLI execute prepares and reuses a real EPUB entirely inside a synthetic project", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.projectRoot, "scripts"));
  await fs.mkdir(path.join(f.projectRoot, "server"));
  for (const relative of [
    "scripts/prepare-text.mjs",
    "scripts/prepare-text-helper.py",
    "server/extract-epub.py",
  ])
    await fs.copyFile(
      path.resolve(relative),
      path.join(f.projectRoot, relative),
    );
  const args = [
    path.join(f.projectRoot, "scripts/prepare-text.mjs"),
    "--file",
    fileId,
    "--manifest",
    f.manifestPath,
    "--execute",
  ];
  const execute = () =>
    spawnSync(process.execPath, args, { encoding: "utf8", cwd: f.projectRoot });
  const first = execute();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  const result = JSON.parse(first.stdout);
  assert.equal(result.status, "prepared");
  assert.match(result.versionHash, /^[a-f0-9]{64}$/);
  const artifact = path.join(f.projectRoot, result.artifact);
  assert.equal((await fs.stat(artifact)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(artifact))).mode & 0o777, 0o700);
  const body = await readPackage(f, result);
  assert.equal(body.source.fileId, fileId);
  assert.equal(body.contentHash, result.contentHash);
  assert.equal(body.chunks[0].text, "First chapter.");
  assert.ok(!first.stdout.includes(f.root));
  const second = execute();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, "reused");
  assert.equal(JSON.parse(second.stdout).versionHash, result.versionHash);
});

test("insecure existing private directory is rejected without changing its permissions or contents", async (t) => {
  const f = await fixture(t);
  const local = path.join(f.projectRoot, ".local");
  await fs.mkdir(local, { mode: 0o755 });
  await fs.chmod(local, 0o755);
  await fs.writeFile(path.join(local, "preserve"), "existing state");
  await assert.rejects(
    prepareText({ ...f.options, execute: true }),
    code("output_permissions"),
  );
  assert.equal((await fs.stat(local)).mode & 0o777, 0o755);
  assert.equal(
    await fs.readFile(path.join(local, "preserve"), "utf8"),
    "existing state",
  );
});
