import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareText } from "../scripts/prepare-text.mjs";
import { selectText } from "../scripts/select-text.mjs";
import { JobQueue, getChunks, publishedJob } from "../server/jobs.mjs";
import { createServer } from "../server/index.mjs";
import { getConfig } from "../server/config.mjs";
import {
  readPins,
  privateTextOperation,
  snapshotPreparedSource,
} from "../server/prepared-text.mjs";

const fileId = "file_1234567890abcdef",
  bookId = "book_1234567890abcdef";
const origin = "http://localhost:4321";
const hasPDF = spawnSync("pdftotext", ["-v"]).status === 0;
function pdf(pages) {
  const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ],
    kids = [];
  for (const text of pages) {
    const body = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`,
      number = objects.length + 1;
    kids.push(`${number} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${number + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let value = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const at = Buffer.byteLength(value);
  return (
    value +
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`
  );
}

async function fixture(
  t,
  {
    format = "EPUB",
    chapters = ["磁流体发动机的研究证据。", "普通章节的实验记录。"],
  } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-consume-")),
  );
  const projectRoot = path.join(root, "project"),
    sources = path.join(root, "sources"),
    closers = [];
  await fs.mkdir(projectRoot);
  await fs.mkdir(sources);
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourcePath = path.join(sources, `private.${format.toLowerCase()}`),
    manifestPath = path.join(root, "manifest.json");
  const manifest = { schemaVersion: 1, root: sources, files: {} };
  const entry = {
    bookId,
    format,
    path: sourcePath,
    eligibility: "candidate",
    visibility: "private",
    textPath: "/do-not-read-fallback",
    storageKey: "do-not-fetch-fallback",
  };
  manifest.files[fileId] = entry;
  const save = () =>
    fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  async function write(chapters) {
    if (format === "PDF") await fs.writeFile(sourcePath, pdf(chapters));
    else {
      const archive = {
        "META-INF/container.xml":
          '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
        "content.opf": `<package xmlns="http://www.idpf.org/2007/opf"><manifest>${chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`,
        ...Object.fromEntries(
          chapters.map((text, i) => [
            `c${i}.xhtml`,
            `<html><body><p>${text}</p></body></html>`,
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
    const stat = await fs.stat(sourcePath, { bigint: true });
    entry.sizeBytes = Number(stat.size);
    entry.mtimeNs = String(stat.mtimeNs);
    await save();
  }
  await write(chapters);
  const stateDir = path.join(projectRoot, ".local");
  const config = getConfig({
    SHELF_STATE_DIR: stateDir,
    SHELF_OWNER_PASSWORD: "private-password",
    SHELF_OAI_BASE_URL: "https://mock.invalid",
    SHELF_OAI_KEY: "mock-only",
  });
  const book = {
      id: bookId,
      title: "合成材料",
      author: null,
      files: [{ id: fileId, format }],
    },
    catalog = { books: [book] };
  const prepOptions = { fileId, projectRoot, manifestPath, execute: true };
  const prepared = await prepareText(prepOptions);
  const select = (options = {}) =>
    selectText({
      fileId,
      versionHash: prepared.versionHash,
      projectRoot,
      manifestPath,
      ...options,
    });
  const artifact = (version = prepared.versionHash) =>
    path.join(stateDir, "prepared-text", fileId, version + ".json");
  const payloads = [];
  const fetchImpl = async (url, request) => {
    assert.equal(url.href, "https://mock.invalid/v1/tasks");
    payloads.push(JSON.parse(JSON.parse(request.body).input));
    return new Response(JSON.stringify({ content: "仅依据材料的合成答复" }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const pin = async () => (await readPins(stateDir)).pins.files[fileId];
  function queue() {
    const value = new JobQueue(config, catalog, manifest, {
      worker: false,
      fetchImpl,
    });
    let open = true;
    const close = async () => {
      if (open) {
        open = false;
        await value.close();
      }
    };
    closers.push(close);
    return { value, close };
  }
  return {
    root,
    projectRoot,
    sourcePath,
    manifestPath,
    manifest,
    entry,
    stateDir,
    config,
    book,
    catalog,
    prepared,
    select,
    artifact,
    payloads,
    fetchImpl,
    pin,
    queue,
    write,
    save,
    prepOptions,
    closers,
  };
}

async function copiedCLI(f) {
  for (const name of [
    "scripts/select-text.mjs",
    "scripts/prepare-text.mjs",
    "scripts/prepare-text-helper.py",
    "server/prepared-text.mjs",
    "server/storage.mjs",
    "server/config.mjs",
    "shared/prepared-text.mjs",
  ]) {
    const target = path.join(f.projectRoot, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.resolve(name), target);
  }
  return path.join(f.projectRoot, "scripts/select-text.mjs");
}

test("standalone selection CLI validates real EPUB, dry-run writes nothing, activates immutable pin and preserves original files", async (t) => {
  const f = await fixture(t),
    cli = await copiedCLI(f),
    manifestBefore = await fs.readFile(f.manifestPath),
    bookBefore = await fs.readFile(f.sourcePath);
  const args = [
    cli,
    "--file",
    fileId,
    "--version",
    f.prepared.versionHash,
    "--manifest",
    f.manifestPath,
  ];
  let result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "dry-run");
  assert.deepEqual(await fs.readdir(path.join(f.stateDir, "prepared-text")), [
    fileId,
  ]);
  result = spawnSync(process.execPath, [...args, "--execute"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "selected");
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(f.root));
  assert.equal((await f.pin()).versionHash, f.prepared.versionHash);
  assert.equal(
    (await fs.stat(path.join(f.stateDir, "prepared-text/pins.json"))).mode &
      0o777,
    0o600,
  );
  assert.deepEqual(await fs.readFile(f.manifestPath), manifestBefore);
  assert.deepEqual(await fs.readFile(f.sourcePath), bookBefore);
  assert.equal((await f.select({ execute: true })).status, "reused");
  result = spawnSync(process.execPath, [...args, "--execute", "--execute"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { code: "invalid_arguments" });
  await assert.rejects(f.select({ execute: "false" }), {
    code: "invalid_execute",
  });
});

test("real HTTP auth/CSRF → selected EPUB question, chapter and multigroup summary → private history and explicit publish", async (t) => {
  const f = await fixture(t, {
    chapters: [
      "磁流体发动机的独有证据。".repeat(4000),
      "",
      "量子干涉实验记录。".repeat(1500),
    ],
  });
  const cli = await copiedCLI(f);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--file",
      fileId,
      "--version",
      f.prepared.versionHash,
      "--manifest",
      f.manifestPath,
      "--execute",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const sourceHash = (await f.pin()).sourceSha256;
  await fs.unlink(f.sourcePath); // Consumption cannot open an original book or extractor.
  const server = await createServer(f.config, {
    catalog: f.catalog,
    manifest: f.manifest,
    fetchImpl: f.fetchImpl,
    worker: false,
  });
  f.closers.push(() => server.shutdown());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "private-password" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0],
    csrf = (await login.json()).csrfToken;
  const headers = {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
  };
  const url = base + `/api/books/${bookId}/jobs`;
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": "wrong" },
        body: JSON.stringify({ operation: "full_summary" }),
      })
    ).status,
    403,
  );
  const ids = [];
  let fullSummaryStart;
  for (const input of [
    { operation: "question", question: "磁流体发动机有什么证据？" },
    { operation: "chapter_summary", chapter: 2 },
    { operation: "full_summary" },
  ]) {
    if (input.operation === "full_summary")
      fullSummaryStart = f.payloads.length;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 202);
    const data = await response.json();
    ids.push(data.job.id);
    assert.equal(data.job.preparedSource, undefined);
    assert.equal(data.job.input, undefined);
    await server.queue.pump();
    assert.equal(server.queue.get(data.job.id).status, "completed");
  }
  assert.equal((await fetch(base + "/api/jobs/" + ids[0])).status, 401);
  const question = f.payloads.find((p) => p.operation === "question");
  assert.ok(question.materials.every((chunk) => chunk.text.includes("磁流体")));
  assert.equal(question.materials[0].sourceLocator.spineIndex, 0);
  assert.equal(question.materials[0].versionHash, f.prepared.versionHash);
  assert.equal(typeof question.materials[0].locator, "string");
  const chapterSources = server.queue.get(ids[1]).sources;
  assert.ok(
    chapterSources.every((source) => source.sourceLocator.spineIndex === 2),
  );
  const summary = server.queue.get(ids[2]);
  assert.equal(summary.coverage.completedChunks, f.prepared.chunks);
  assert.ok(summary.coverage.requiredCalls >= 3);
  const summaryCalls = f.payloads.filter((p) => p.material);
  assert.ok(
    summaryCalls.every((p) =>
      p.material.sources.every((s) => s.versionHash === f.prepared.versionHash),
    ),
  );
  assert.ok(!JSON.stringify(summaryCalls).includes("[object Object]"));
  const fullCalls = f.payloads.slice(fullSummaryStart),
    raw = JSON.parse(await fs.readFile(f.artifact(), "utf8"));
  const fullGroups = fullCalls
    .filter((call) => call.material)
    .map((call) => call.material);
  const indexes = [];
  for (const group of fullGroups)
    for (const source of group.sources) {
      const chunk = raw.chunks[source.chunkIndex];
      indexes.push(source.chunkIndex);
      assert.ok(
        group.text.includes(
          `\n[${source.label} / ${source.locator}]\n${chunk.text}`,
        ),
      );
      assert.deepEqual(source.sourceLocator, chunk.locator);
    }
  assert.deepEqual(
    indexes,
    raw.chunks.map((chunk) => chunk.index),
  );
  assert.deepEqual(
    fullCalls
      .at(-1)
      .summaries.flatMap((part) => part.sources)
      .map((source) => source.chunkIndex),
    indexes,
  );
  const history = await (
    await fetch(base + `/api/books/${bookId}/history`, {
      headers: { Cookie: cookie },
    })
  ).text();
  for (const secret of [sourceHash, f.root, "preparedSource", '"input"'])
    assert.ok(!history.includes(secret), secret);
  assert.deepEqual(
    await (await fetch(base + `/api/books/${bookId}/published`)).json(),
    { jobs: [] },
  );
  assert.equal(
    (
      await fetch(base + `/api/jobs/${ids[0]}/publish`, {
        method: "POST",
        headers,
        body: JSON.stringify({ published: true }),
      })
    ).status,
    200,
  );
  const publicValue = await (
    await fetch(base + `/api/books/${bookId}/published`)
  ).json();
  assert.equal(publicValue.jobs.length, 1);
  assert.equal(
    publicValue.jobs[0].sources[0].versionHash,
    f.prepared.versionHash,
  );
  for (const secret of [sourceHash, f.root, "preparedSource", '"text"'])
    assert.ok(!JSON.stringify(publicValue).includes(secret), secret);
  assert.equal(f.manifest.files[fileId].preparedText, undefined); // Startup overlay did not mutate caller/manifest.
});

test(
  "selected real PDF preserves a blank page gap in question and chapter sources without local files",
  { skip: !hasPDF && "pdftotext is required for real PDF extraction" },
  async (t) => {
    const f = await fixture(t, {
      format: "PDF",
      chapters: ["first evidence", "", "third page magnetosphere evidence"],
    });
    await f.select({ execute: true });
    f.entry.preparedText = await f.pin();
    await fs.unlink(f.sourcePath);
    const { value: queue } = f.queue();
    const question = queue.create(f.book, {
      operation: "question",
      question: "magnetosphere",
    });
    const chapter = queue.create(f.book, {
      operation: "chapter_summary",
      chapter: 2,
    });
    await queue.pump();
    for (const id of [question.id, chapter.id]) {
      const value = queue.get(id);
      assert.equal(value.status, "completed");
      assert.equal(value.sources[0].sourceLocator.page, 3);
      assert.equal(value.sources[0].label, "PDF 第 3 页");
    }
    assert.equal(f.config.localFilesEnabled, false);
  },
);

test("frozen source versions deduplicate precisely, survive default changes and queued restart", async (t) => {
  const f = await fixture(t);
  await f.select({ execute: true });
  const firstPin = await f.pin();
  f.entry.preparedText = firstPin;
  let { value: queue, close } = f.queue();
  const input = { operation: "question", question: "磁流体" },
    first = queue.create(f.book, input);
  assert.equal(queue.create(f.book, input).id, first.id);
  await f.write(["磁流体第二版本的新研究。", "新的尾章证据。"]);
  const next = await prepareText(f.prepOptions);
  await assert.rejects(
    f.select({ versionHash: next.versionHash, execute: true }),
    { code: "prepared_replace_required" },
  );
  await assert.rejects(
    f.select({
      versionHash: next.versionHash,
      replaceVersion: "a".repeat(64),
      execute: true,
    }),
    { code: "prepared_selection_conflict" },
  );
  await f.select({
    versionHash: next.versionHash,
    replaceVersion: firstPin.versionHash,
    execute: true,
  });
  f.entry.preparedText = await f.pin();
  const second = queue.create(f.book, input);
  assert.notEqual(second.id, first.id);
  await close();
  ({ value: queue } = f.queue());
  await fs.unlink(f.sourcePath);
  await queue.pump();
  assert.equal(
    queue.get(first.id).sources[0].versionHash,
    firstPin.versionHash,
  );
  assert.equal(queue.get(second.id).sources[0].versionHash, next.versionHash);
  assert.equal(f.payloads[0].materials[0].text, "磁流体发动机的研究证据。");
  assert.equal(f.payloads[1].materials[0].text, "磁流体第二版本的新研究。");
  assert.deepEqual(f.payloads[1].conversation, []);
  const followup = queue.create(f.book, input);
  await queue.pump();
  assert.equal(queue.get(followup.id).status, "completed");
  assert.deepEqual(f.payloads[2].conversation, [
    { answer: "仅依据材料的合成答复" },
  ]);
  // Even a malformed newly declared pin cannot be mistaken for absence.
  f.entry.preparedText = { ...firstPin, versionHash: null };
  assert.throws(() => queue.create(f.book, input), {
    code: "prepared_pin_invalid",
  });
});

test("multiple selected formats follow catalog order and validate every declared pin", async (t) => {
  const f = await fixture(t);
  await f.select({ execute: true });
  const pin = await f.pin();
  f.entry.preparedText = pin;
  const secondId = "file_aaaaaaaaaaaaaaaa",
    second = { ...pin, fileId: secondId, format: "PDF" };
  f.manifest.files[secondId] = {
    ...f.entry,
    format: "PDF",
    preparedText: second,
  };
  f.book.files.push({ id: secondId, format: "PDF" });
  assert.equal(snapshotPreparedSource(f.book, f.manifest).fileId, fileId);
  assert.equal(
    snapshotPreparedSource(
      { ...f.book, files: f.book.files.toReversed() },
      f.manifest,
    ).fileId,
    secondId,
  );
  f.manifest.files[secondId].preparedText = {
    ...second,
    bookId: { toString: () => bookId },
  };
  assert.throws(() => snapshotPreparedSource(f.book, f.manifest), {
    code: "prepared_pin_invalid",
  });
});

test("missing, tampered and unsafe artifacts fail queued jobs before model calls and never read fallback", async (t) => {
  const f = await fixture(t);
  await f.select({ execute: true });
  f.entry.preparedText = await f.pin();
  const { value: queue } = f.queue(),
    bytes = await fs.readFile(f.artifact());
  async function failed(mutate, restore, expected) {
    await mutate();
    const job = queue.create(f.book, { operation: "full_summary" });
    await queue.pump();
    const value = queue.get(job.id);
    assert.equal(value.status, "failed");
    if (expected) assert.equal(value.error.code, expected);
    assert.equal(f.payloads.length, 0);
    await restore();
  }
  await failed(
    () => fs.rename(f.artifact(), f.artifact() + ".old"),
    () => fs.rename(f.artifact() + ".old", f.artifact()),
    "prepared_package_unavailable",
  );
  await failed(
    () =>
      fs.writeFile(f.artifact(), bytes.toString().replace("磁流体", "坏数据")),
    () => fs.writeFile(f.artifact(), bytes),
  );
  await failed(
    async () => {
      await fs.rename(f.artifact(), f.artifact() + ".old");
      await fs.symlink(f.artifact() + ".old", f.artifact());
    },
    async () => {
      await fs.unlink(f.artifact());
      await fs.rename(f.artifact() + ".old", f.artifact());
    },
    "prepared_unsafe_path",
  );
  await failed(
    () => fs.chmod(f.artifact(), 0o644),
    () => fs.chmod(f.artifact(), 0o600),
    "prepared_permissions",
  );
  await failed(
    () => fs.chmod(path.dirname(f.artifact()), 0o755),
    () => fs.chmod(path.dirname(f.artifact()), 0o700),
    "prepared_permissions",
  );
  await failed(
    () => fs.chmod(f.stateDir, 0o755),
    () => fs.chmod(f.stateDir, 0o700),
    "prepared_permissions",
  );
  for (const directory of [
    path.dirname(f.artifact()),
    path.join(f.stateDir, "prepared-text"),
    f.stateDir,
  ]) {
    await failed(
      async () => {
        await fs.rename(directory, directory + ".old");
        await fs.symlink(directory + ".old", directory);
      },
      async () => {
        await fs.unlink(directory);
        await fs.rename(directory + ".old", directory);
      },
      "prepared_unsafe_path",
    );
  }
  f.entry.preparedText = {
    ...f.entry.preparedText,
    sourceSha256: "b".repeat(64),
  };
  await failed(
    async () => {},
    async () => {},
  );
  f.entry.preparedText = await f.pin();
  f.entry.preparedText = {
    ...f.entry.preparedText,
    versionHash: "a".repeat(64),
  };
  await failed(
    async () => {},
    async () => {},
    "prepared_package_unavailable",
  );
  f.entry.preparedText = { ...(await f.pin()), mtimeNs: "0" };
  assert.throws(() => queue.create(f.book, { operation: "full_summary" }), {
    code: "prepared_source_mismatch",
  });
  const good = await f.pin();
  f.entry.preparedText = good;
  f.book.files.push({ id: "file_aaaaaaaaaaaaaaaa", format: "EPUB" });
  f.manifest.files.file_aaaaaaaaaaaaaaaa = { ...f.entry, preparedText: null };
  assert.throws(() => snapshotPreparedSource(f.book, f.manifest), {
    code: "prepared_pin_invalid",
  });
});

test("selection rejects source drift, unsafe pins/lock, duplicate keys and corrupt selection rather than silently disabling it", async (t) => {
  const f = await fixture(t);
  await f.select({ execute: true });
  const pinsPath = path.join(f.stateDir, "prepared-text/pins.json"),
    bytes = await fs.readFile(pinsPath);
  await fs.writeFile(
    pinsPath,
    bytes
      .toString()
      .replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1'),
  );
  await assert.rejects(readPins(f.stateDir), { code: "prepared_pin_invalid" });
  await assert.rejects(
    createServer(f.config, {
      catalog: f.catalog,
      manifest: f.manifest,
      worker: false,
    }),
    { code: "prepared_pin_invalid" },
  );
  await fs.writeFile(pinsPath, bytes);
  await fs.chmod(pinsPath, 0o644);
  await assert.rejects(readPins(f.stateDir), { code: "prepared_permissions" });
  await fs.chmod(pinsPath, 0o600);
  await fs.rename(pinsPath, pinsPath + ".old");
  await fs.symlink(pinsPath + ".old", pinsPath);
  await assert.rejects(readPins(f.stateDir), { code: "prepared_unsafe_path" });
  await fs.unlink(pinsPath);
  await fs.rename(pinsPath + ".old", pinsPath);
  const lock = path.join(f.stateDir, "prepared-text/.pins.lock");
  await fs.unlink(lock);
  await fs.symlink(pinsPath, lock);
  await assert.rejects(f.select({ execute: true }), {
    code: "prepared_unsafe_path",
  });
  await fs.unlink(lock);
  await fs.chmod(f.stateDir, 0o755);
  await assert.rejects(
    createServer(f.config, {
      catalog: f.catalog,
      manifest: f.manifest,
      worker: false,
    }),
    { code: "prepared_permissions" },
  );
  assert.equal((await fs.stat(f.stateDir)).mode & 0o777, 0o755);
  await fs.chmod(f.stateDir, 0o700);
  await fs.rename(f.sourcePath, f.sourcePath + ".old");
  await fs.symlink(f.sourcePath + ".old", f.sourcePath);
  await assert.rejects(f.select({ execute: true }), {
    code: "prepared_unsafe_path",
  });
  await fs.unlink(f.sourcePath);
  await fs.rename(f.sourcePath + ".old", f.sourcePath);
  await fs.appendFile(f.sourcePath, "drift");
  await assert.rejects(f.select({ execute: true }), { code: "source_changed" });
  assert.deepEqual(await fs.readFile(pinsPath), bytes);
});

test("startup ignores manifest-carried internal pins without an independent selection and retains legacy text", async (t) => {
  const f = await fixture(t),
    raw = JSON.parse(await fs.readFile(f.artifact(), "utf8"));
  f.entry.preparedText = {
    fileId,
    bookId,
    format: "EPUB",
    sizeBytes: f.entry.sizeBytes,
    mtimeNs: f.entry.mtimeNs,
    sourceSha256: raw.source.fingerprint.value,
    versionHash: raw.versionHash,
  };
  const textPath = path.join(f.stateDir, "legacy.txt");
  await fs.writeFile(textPath, "旧正文的证明材料。", { mode: 0o600 });
  f.entry.textPath = textPath;
  const server = await createServer(f.config, {
    catalog: f.catalog,
    manifest: f.manifest,
    fetchImpl: f.fetchImpl,
    worker: false,
  });
  f.closers.push(() => server.shutdown());
  const job = server.queue.create(f.book, {
    operation: "question",
    question: "旧正文",
  });
  await server.queue.pump();
  assert.equal(server.queue.get(job.id).status, "completed");
  assert.equal(f.payloads[0].materials[0].text, "旧正文的证明材料。");
  assert.equal(server.queue.get(job.id).sources[0].versionHash, undefined);
  assert.equal(f.entry.preparedText.versionHash, raw.versionHash);
});

test("whole-file CAS concurrently preserves unrelated selections and rejects the stale writer", async (t) => {
  const f = await fixture(t);
  await f.select({ execute: true });
  const { pins, sha256: expectedHash } = await readPins(f.stateDir),
    base = pins.files[fileId];
  const ids = ["file_aaaaaaaaaaaaaaaa", "file_bbbbbbbbbbbbbbbb"];
  const values = await Promise.allSettled(
    ids.map((id) =>
      privateTextOperation({
        operation: "pins-commit",
        stateDir: f.stateDir,
        expectedHash,
        pins:
          JSON.stringify({
            schemaVersion: 1,
            files: { ...pins.files, [id]: { ...base, fileId: id } },
          }) + "\n",
      }),
    ),
  );
  assert.equal(
    values.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    values.find((value) => value.status === "rejected").reason.code,
    "prepared_selection_conflict",
  );
  const latest = (await readPins(f.stateDir)).pins;
  assert.deepEqual(latest.files[fileId], base);
  assert.equal(Object.keys(latest.files).length, 2);
  assert.ok(ids.some((id) => latest.files[id]));
});

test("private and published source projection removes internal fields including nested locator injection", async (t) => {
  const f = await fixture(t);
  const { value: queue } = f.queue();
  const source = {
    label: "PDF 第 1 页",
    locator: "safe",
    fileId,
    versionHash: "a".repeat(64),
    chunkIndex: 0,
    sourceSha256: "private-hash",
    path: "/private/path",
    text: "private-text",
    sourceLocator: {
      type: "pdf-page",
      page: 1,
      start: 0,
      end: 3,
      sourceSha256: "private-hash",
      privatePath: "/private/path",
    },
  };
  const row = {
    id: "projection",
    bookId,
    status: "completed",
    sources: [
      source,
      {
        locator: { text: "private-text", path: "/private/path" },
        label: { sourceSha256: "private-hash" },
        chunkIndex: { path: "/private/path" },
      },
    ],
    preparedSource: { sourceSha256: "private-hash" },
    input: { source: "/private/path" },
    fingerprint: "internal",
    content: "answer",
  };
  queue.save(row);
  for (const value of [
    queue.get(row.id),
    queue.history(bookId)[0],
    publishedJob(row),
  ]) {
    const encoded = JSON.stringify(value);
    for (const secret of [
      "private-hash",
      "/private/path",
      "private-text",
      "preparedSource",
      "privatePath",
    ])
      assert.ok(!encoded.includes(secret), secret);
    assert.deepEqual(value.sources[0].sourceLocator, {
      type: "pdf-page",
      page: 1,
      start: 0,
      end: 3,
    });
  }
});
