import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  validatePreparedText,
  PreparedTextError,
  PREPARED_TEXT_LIMIT,
} from "../shared/prepared-text.mjs";
import { prepareText } from "../scripts/prepare-text.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex");
const fileId = "file_1234567890abcdef",
  bookId = "book_1234567890abcdef";
const encode = (v) => new TextEncoder().encode(JSON.stringify(v) + "\n");
function seal(value) {
  for (const chunk of value.chunks) chunk.sha256 = sha(chunk.text);
  value.textBytes = value.chunks.reduce(
    (total, chunk) => total + Buffer.byteLength(chunk.text),
    0,
  );
  value.contentHash = sha(JSON.stringify(value.chunks));
  const { versionHash: ignored, ...body } = value;
  value.versionHash = sha(JSON.stringify(body));
  return value;
}
function fixture({
  format = "EPUB",
  sections = ["这是正文😀。", "第二节。"],
} = {}) {
  const chunks = [];
  for (let section = 0; section < sections.length; section++) {
    const points = Array.from(sections[section]);
    for (let start = 0; start < points.length; start += 6000) {
      const text = points.slice(start, start + 6000).join("");
      if (!text.trim()) continue;
      chunks.push({
        index: chunks.length,
        locator: {
          type: format === "PDF" ? "pdf-page" : "epub-spine",
          ...(format === "PDF"
            ? { page: section + 1 }
            : { spineIndex: section }),
          start,
          end: start + Array.from(text).length,
        },
        text,
        sha256: "",
      });
    }
  }
  return seal({
    schemaVersion: 1,
    kind: "shelf.prepared-text",
    preparation: {
      algorithm: "shelf-text-v1",
      normalization: "LF-NFC-trim-section",
      chunkCodepoints: 6000,
      offsetUnit: "unicode-code-point",
    },
    source: {
      fileId,
      bookId,
      format,
      sizeBytes: 1234,
      mtimeNs: "1234567890123456789",
      fingerprint: { algorithm: "sha256", value: sha("source bytes") },
    },
    textBytes: 0,
    contentHash: "",
    chunks,
  });
}
function expected(value) {
  const { fileId, bookId, format, sizeBytes, mtimeNs, fingerprint } =
    value.source;
  return {
    fileId,
    bookId,
    format,
    sizeBytes,
    mtimeNs,
    versionHash: value.versionHash,
    sourceSha256: fingerprint.value,
  };
}
const safeError = (error) =>
  error instanceof PreparedTextError &&
  /^[a-z_]+$/.test(error.code) &&
  error.message === error.code;
const rejected = async (value, pin = expected(value)) =>
  assert.rejects(validatePreparedText(encode(value), pin), safeError);

test("strict contract accepts Unicode point offsets, empty sections and omitted whitespace windows", async () => {
  for (const format of ["PDF", "EPUB"]) {
    const value = fixture({
      format,
      sections: ["😀".repeat(6000) + " ".repeat(6000) + "尾声", "", "末章"],
    });
    const result = await validatePreparedText(encode(value), expected(value));
    assert.deepEqual(result, value);
    assert.equal(result.chunks[1].locator.start, 12000);
    assert.equal(result.chunks[0].locator.end, 6000);
  }
});

test("every expected source and version pin is required, typed and compared", async () => {
  const value = fixture(),
    pin = expected(value);
  for (const key of Object.keys(pin)) {
    const missing = { ...pin };
    delete missing[key];
    await rejected(value, missing);
    await rejected(value, { ...pin, [key]: null });
  }
  const replacements = {
    fileId: "file_aaaaaaaaaaaaaaaa",
    bookId: "book_aaaaaaaaaaaaaaaa",
    format: "PDF",
    sizeBytes: 100,
    mtimeNs: "100",
    versionHash: sha("wrong"),
    sourceSha256: sha("wrong"),
  };
  for (const [key, replacement] of Object.entries(replacements))
    await rejected(value, { ...pin, [key]: replacement });
  await rejected(value, { ...pin, sizeBytes: PREPARED_TEXT_LIMIT + 1 });
  await rejected(value, { ...pin, fileId: { toString: () => fileId } });
});

test("unknown fields at every schema layer are rejected even with recomputed hashes and pins", async () => {
  const paths = [
    [],
    ["preparation"],
    ["source"],
    ["source", "fingerprint"],
    ["chunks", 0],
    ["chunks", 0, "locator"],
  ];
  for (const keys of paths) {
    const value = fixture();
    let target = value;
    for (const key of keys) target = target[key];
    target.unexpected = "PRIVATE text /private/source";
    seal(value);
    await rejected(value);
  }
});

test("schema, preparation algorithms and fingerprint algorithms are strict", async () => {
  for (const mutate of [
    (v) => {
      v.schemaVersion = 2;
    },
    (v) => {
      v.kind = "other";
    },
    (v) => {
      v.preparation.algorithm = "shelf-text-v2";
    },
    (v) => {
      v.preparation.normalization = "NFKC";
    },
    (v) => {
      v.preparation.chunkCodepoints = 6001;
    },
    (v) => {
      v.preparation.offsetUnit = "utf16";
    },
    (v) => {
      v.source.fingerprint.algorithm = "sha1";
    },
  ]) {
    const value = fixture();
    mutate(value);
    seal(value);
    await rejected(value);
  }
});

test("tampered text, chunk/content/version hashes and byte counts cannot bypass pinned verification", async () => {
  for (const mutate of [
    (v) => {
      v.chunks[0].text = "另些正文😀。";
    },
    (v) => {
      v.chunks[0].sha256 = sha("wrong");
    },
    (v) => {
      v.contentHash = sha("wrong");
    },
    (v) => {
      v.versionHash = sha("wrong");
    },
    (v) => {
      v.textBytes += 1;
    },
  ]) {
    const value = fixture();
    mutate(value);
    await rejected(value);
  }
  const original = fixture(),
    value = structuredClone(original);
  value.chunks[0].text = "篡改正文😀。";
  seal(value);
  await rejected(value, expected(original));
  const wrongSource = fixture();
  wrongSource.source.mtimeNs = "999";
  seal(wrongSource);
  await rejected(wrongSource, expected(original));
});

test("rehashed locator/index/order/Unicode alterations violate extraction invariants", async () => {
  for (const mutate of [
    (v) => {
      v.chunks[0].index = 1;
    },
    (v) => {
      v.chunks[0].locator.type = "pdf-page";
    },
    (v) => {
      v.chunks[0].locator.start = 1;
      v.chunks[0].locator.end += 1;
    },
    (v) => {
      v.chunks[0].locator.end += 1;
    },
    (v) => {
      v.chunks[0].locator.end = v.chunks[0].text.length;
    },
    (v) => {
      v.chunks[0].locator.spineIndex = -1;
    },
    (v) => {
      v.chunks[1].locator.spineIndex = 0;
    },
    (v) => {
      v.chunks[0].locator.spineIndex = 2;
    },
    (v) => {
      v.chunks[1].locator.spineIndex = 10000;
    },
    (v) => {
      v.chunks.reverse();
      v.chunks.forEach((c, i) => {
        c.index = i;
      });
    },
    (v) => {
      v.chunks[0].text = "e\u0301";
      v.chunks[0].locator.end = 2;
    },
    (v) => {
      v.chunks[0].text = "\ud800";
      v.chunks[0].locator.end = 1;
    },
    (v) => {
      v.chunks[0].text = "a\rb";
      v.chunks[0].locator.end = 3;
    },
    (v) => {
      v.chunks[0].text = "a\u0000b";
      v.chunks[0].locator.end = 3;
    },
    (v) => {
      v.chunks[0].text = "   ";
      v.chunks[0].locator.end = 3;
    },
    (v) => {
      v.chunks[0].text = " text";
      v.chunks[0].locator.end = 5;
    },
    (v) => {
      v.chunks[0].text = "text ";
      v.chunks[0].locator.end = 5;
    },
  ]) {
    const value = fixture();
    mutate(value);
    seal(value);
    await rejected(value);
  }
  const overlap = fixture({ sections: ["a".repeat(6001)] });
  overlap.chunks[1].locator.start = 0;
  overlap.chunks[1].locator.end = 1;
  seal(overlap);
  await rejected(overlap);
  const shortPrior = fixture({ sections: ["a".repeat(6001)] });
  shortPrior.chunks[0].text = "a";
  shortPrior.chunks[0].locator.end = 1;
  seal(shortPrior);
  await rejected(shortPrior);
});

test("byte, chunk, text and locator limits reject before unsafe consumption", async () => {
  await assert.rejects(
    validatePreparedText(new Uint8Array(PREPARED_TEXT_LIMIT + 1), {}),
    safeError,
  );
  await assert.rejects(validatePreparedText(new Uint8Array(), {}), safeError);
  await assert.rejects(validatePreparedText("not bytes", {}), safeError);
  const hugeChunk = fixture({ sections: ["a"] });
  hugeChunk.chunks[0].text = "a".repeat(6001);
  hugeChunk.chunks[0].locator.end = 6001;
  seal(hugeChunk);
  await rejected(hugeChunk);
  const manyChunks = fixture();
  manyChunks.chunks = Array(20001).fill(manyChunks.chunks[0]);
  seal(manyChunks);
  await rejected(manyChunks);
  const textLimit = fixture();
  textLimit.textBytes = PREPARED_TEXT_LIMIT + 1;
  await rejected(textLimit);
  const empty = fixture();
  empty.chunks = [];
  seal(empty);
  await rejected(empty);
  const hugeOffset = fixture();
  hugeOffset.chunks[0].locator.start = Number.MAX_SAFE_INTEGER;
  seal(hugeOffset);
  await rejected(hugeOffset);
  const hiddenWhitespace = fixture({
    sections: ["a".repeat(6001), "b".repeat(6001)],
  });
  for (const index of [1, 3]) {
    hiddenWhitespace.chunks[index].locator.start = 12_000_000;
    hiddenWhitespace.chunks[index].locator.end = 12_000_001;
  }
  seal(hiddenWhitespace);
  await rejected(hiddenWhitespace);
});

test("fatal UTF8 and canonical JSON reject duplicates, BOM, reorderings and alternate numeric spellings", async () => {
  const value = fixture(),
    pin = expected(value),
    json = JSON.stringify(value);
  const variants = [
    Uint8Array.from([0xff, 0xfe]),
    Uint8Array.from([0xc0, 0xaf]),
    new TextEncoder().encode("\ufeff" + json + "\n"),
    new TextEncoder().encode(
      json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1') +
        "\n",
    ),
    new TextEncoder().encode(
      json.replace('"schemaVersion":1', '"schemaVersion":1.0') + "\n",
    ),
    new TextEncoder().encode(json + "\n\n"),
    new TextEncoder().encode(json),
    new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n"),
  ];
  const reordered = { kind: value.kind, ...value };
  variants.push(encode(reordered));
  const chunkReorder = structuredClone(value);
  const c = chunkReorder.chunks[0];
  chunkReorder.chunks[0] = {
    text: c.text,
    index: c.index,
    locator: c.locator,
    sha256: c.sha256,
  };
  seal(chunkReorder);
  variants.push(encode(chunkReorder));
  for (const bytes of variants)
    await assert.rejects(validatePreparedText(bytes, pin), safeError);
});

test("real prepareText EPUB output is accepted with Unicode chunks and empty-spine positions", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-contract-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(projectRoot);
  const sourcePath = path.join(root, "synthetic.epub");
  const chapters = [
    "😀".repeat(6000) + " ".repeat(6000) + "结尾",
    "",
    "最终章节。",
  ];
  const archive = {
    "META-INF/container.xml":
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
    "content.opf": `<package xmlns="http://www.idpf.org/2007/opf"><manifest>${chapters.map((_, i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((_, i) => `<itemref idref="s${i}"/>`).join("")}</spine></package>`,
    ...Object.fromEntries(
      chapters.map((text, i) => [
        `s${i}.xhtml`,
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
  const stat = await fs.stat(sourcePath, { bigint: true });
  const manifestPath = path.join(root, "manifest.json");
  const entry = {
    path: sourcePath,
    bookId,
    format: "EPUB",
    sizeBytes: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    eligibility: "candidate",
    visibility: "private",
  };
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, root, files: { [fileId]: entry } }),
    { mode: 0o600 },
  );
  const prepared = await prepareText({
    fileId,
    projectRoot,
    manifestPath,
    execute: true,
  });
  const bytes = await fs.readFile(path.join(projectRoot, prepared.artifact));
  const validated = await validatePreparedText(bytes, {
    fileId,
    bookId,
    format: entry.format,
    sizeBytes: entry.sizeBytes,
    mtimeNs: entry.mtimeNs,
    sourceSha256: sha(await fs.readFile(sourcePath)),
    versionHash: prepared.versionHash,
  });
  assert.equal(validated.chunks[0].locator.end, 6000);
  assert.equal(validated.chunks.at(-1).locator.spineIndex, 2);
  assert.equal(validated.versionHash, prepared.versionHash);
});

test("shared validator has no Node-only imports and runs with only Web platform globals", async () => {
  const source = await fs.readFile(
    new URL("../shared/prepared-text.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /(?:node:|\bBuffer\b|\bprocess\b|\brequire\s*\()/,
  );
  const value = fixture();
  const script = `const {validatePreparedText}=await import(${JSON.stringify(new URL("../shared/prepared-text.mjs", import.meta.url).href)});globalThis.Buffer=undefined;globalThis.process=undefined;await validatePreparedText(new TextEncoder().encode(${JSON.stringify(JSON.stringify(value) + "\n")}),${JSON.stringify(expected(value))});`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
