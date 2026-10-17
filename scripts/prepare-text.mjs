#!/usr/bin/env node
/** Offline, single-file preparation. Never reads env files or contacts a service. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = fileURLToPath(new URL("../", import.meta.url)).replace(
  /\/$/,
  "",
);
const HELPER = fileURLToPath(
  new URL("./prepare-text-helper.py", import.meta.url),
);
const EPUB = fileURLToPath(
  new URL("../server/extract-epub.py", import.meta.url),
);
export const PREPARED_TEXT_LIMIT = 20_000_000;
export const CHUNK_CODEPOINTS = 6000;
const TIMEOUT = 60_000;
const ID = /^file_[a-f0-9]{16}$/;
const BOOK_ID = /^book_[a-f0-9]{16}$/;
const SAFE_CODES = new Set([
  "unsafe_path",
  "output_permissions",
  "source_outside_root",
  "source_not_file",
  "empty_source",
  "source_too_large",
  "source_changed",
  "size_limit",
  "package_too_large",
  "existing_package_invalid",
  "manifest_invalid",
  "local_io_failed",
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value);
export class PreparationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new PreparationError(code);
};

/** Stream caps apply before buffering; stderr is drained and never surfaced. */
export function runBounded(
  command,
  args,
  input,
  { maxBytes, timeoutMs = TIMEOUT } = {},
) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 28_000_000 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > TIMEOUT
  )
    return Promise.reject(new PreparationError("invalid_process_limits"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const chunks = [];
    let bytes = 0,
      stderrBytes = 0,
      stopped = false;
    const stop = (code) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new PreparationError(code));
    };
    const timer = setTimeout(() => stop("extraction_timeout"), timeoutMs);
    child.on("error", () => stop("extractor_unavailable"));
    child.stdout.on("data", (data) => {
      bytes += data.length;
      if (bytes > maxBytes) return stop("extraction_output_limit");
      chunks.push(data);
    });
    child.stderr.on("data", (data) => {
      stderrBytes += data.length;
      if (stderrBytes > 65_536) stop("extraction_output_limit");
    });
    child.stdin.on("error", () => {}); // Invalid files may make a parser exit early.
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped) return;
      stopped = true;
      resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.stdin.end(input);
  });
}

async function local(request, timeoutMs) {
  const result = await runBounded("python3", [HELPER], json(request), {
    maxBytes: 28_000_000,
    timeoutMs,
  });
  let response;
  try {
    response = JSON.parse(result.output);
  } catch {
    fail("local_io_failed");
  }
  if (response.error || result.code !== 0)
    fail(SAFE_CODES.has(response.error) ? response.error : "local_io_failed");
  return response;
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .normalize("NFC")
    .trim();
}

function makeChunks(sections, format) {
  const chunks = [];
  let textBytes = 0;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    if (typeof section.text !== "string") fail("extraction_failed");
    if (format === "EPUB" && section.spineIndex !== sectionIndex)
      fail("extraction_failed");
    const points = Array.from(normalizeText(section.text));
    for (let start = 0; start < points.length; start += CHUNK_CODEPOINTS) {
      const text = points.slice(start, start + CHUNK_CODEPOINTS).join("");
      // Fixed code-point windows preserve text and offsets, including inter-chunk whitespace.
      if (!text.trim()) continue;
      textBytes += Buffer.byteLength(text);
      if (textBytes > PREPARED_TEXT_LIMIT) fail("text_too_large");
      if (chunks.length >= 20_000) fail("chunk_limit");
      chunks.push({
        index: chunks.length,
        locator: {
          type: format === "PDF" ? "pdf-page" : "epub-spine",
          ...(format === "PDF"
            ? { page: sectionIndex + 1 }
            : { spineIndex: sectionIndex }),
          start,
          end: start + Array.from(text).length,
        },
        text,
        sha256: sha256(text),
      });
    }
  }
  if (!chunks.length) fail("empty_text");
  return { chunks, textBytes };
}

/**
 * The returned result is safe to print, but the package on disk is PRIVATE.
 * projectRoot is injectable for synthetic fixtures; CLI output stays in this repo.
 */
export async function prepareText({
  fileId,
  manifestPath = path.join(PROJECT, ".local/manifest.json"),
  projectRoot = PROJECT,
  execute = false,
  timeoutMs = TIMEOUT,
} = {}) {
  if (typeof execute !== "boolean") fail("invalid_execute");
  if (typeof fileId !== "string" || !ID.test(fileId)) fail("invalid_file_id");
  if (
    typeof manifestPath !== "string" ||
    !manifestPath ||
    typeof projectRoot !== "string" ||
    !projectRoot
  )
    fail("invalid_arguments");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT)
    fail("invalid_timeout");
  const { manifest } = await local(
    { operation: "manifest", path: path.resolve(manifestPath) },
    timeoutMs,
  );
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    typeof manifest.root !== "string"
  )
    fail("manifest_invalid");
  const entry = manifest.files[fileId];
  if (!entry) fail("file_not_found");
  if (!["PDF", "EPUB"].includes(entry.format)) fail("unsupported_format");
  if (
    !BOOK_ID.test(entry.bookId ?? "") ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    typeof entry.mtimeNs !== "string" ||
    !/^\d+$/.test(entry.mtimeNs) ||
    typeof entry.path !== "string"
  )
    fail("manifest_invalid");
  if (entry.sizeBytes === 0) fail("empty_source");
  if (entry.sizeBytes < 0 || entry.sizeBytes > PREPARED_TEXT_LIMIT)
    fail("source_too_large");
  if (entry.eligibility !== "candidate" || entry.visibility !== "private")
    fail("file_ineligible");
  const sourceRequest = {
    root: manifest.root,
    path: entry.path,
    bytes: entry.sizeBytes,
    mtimeNs: entry.mtimeNs,
  };
  const inspected = await local(
    { ...sourceRequest, operation: "inspect" },
    timeoutMs,
  );
  if (!execute)
    return {
      status: "dry-run",
      fileId,
      bookId: entry.bookId,
      format: entry.format,
      sizeBytes: entry.sizeBytes,
      wouldPrepare: true,
    };
  const read = await local(
    { ...sourceRequest, operation: "read", expected: inspected.snapshot },
    timeoutMs,
  );
  const input = Buffer.from(read.data, "base64");
  if (input.length !== entry.sizeBytes) fail("source_changed");
  let extracted;
  if (entry.format === "PDF") {
    const response = await runBounded(
      "pdftotext",
      ["-enc", "UTF-8", "-", "-"],
      input,
      { maxBytes: PREPARED_TEXT_LIMIT, timeoutMs },
    );
    if (response.code !== 0) fail("pdf_extraction_failed");
    extracted = response.output.split("\f").map((text) => ({ text }));
  } else {
    const response = await runBounded(
      "python3",
      [EPUB, "--prepared-stdin"],
      input,
      { maxBytes: PREPARED_TEXT_LIMIT, timeoutMs },
    );
    if (response.code !== 0) fail("epub_extraction_failed");
    try {
      extracted = JSON.parse(response.output);
    } catch {
      fail("epub_extraction_failed");
    }
    if (!Array.isArray(extracted) || extracted.length > 10_000)
      fail("epub_extraction_failed");
  }
  await local(
    { ...sourceRequest, operation: "verify", expected: read.snapshot },
    timeoutMs,
  );
  const { chunks, textBytes } = makeChunks(extracted, entry.format);
  const contentHash = sha256(json(chunks));
  const body = {
    schemaVersion: 1,
    kind: "shelf.prepared-text",
    preparation: {
      algorithm: "shelf-text-v1",
      normalization: "LF-NFC-trim-section",
      chunkCodepoints: CHUNK_CODEPOINTS,
      offsetUnit: "unicode-code-point",
    },
    source: {
      fileId,
      bookId: entry.bookId,
      format: entry.format,
      sizeBytes: entry.sizeBytes,
      mtimeNs: entry.mtimeNs,
      fingerprint: { algorithm: "sha256", value: sha256(input) },
    },
    textBytes,
    contentHash,
    chunks,
  };
  const versionHash = sha256(json(body));
  const packageText = json({ ...body, versionHash }) + "\n";
  const packageBytes = Buffer.byteLength(packageText);
  if (packageBytes > PREPARED_TEXT_LIMIT) fail("package_too_large");
  // Recheck after normalization/hashing too, immediately before private publication.
  await local(
    { ...sourceRequest, operation: "verify", expected: read.snapshot },
    timeoutMs,
  );
  const published = await local(
    {
      operation: "publish",
      projectRoot: path.resolve(projectRoot),
      fileId,
      versionHash,
      package: packageText,
    },
    timeoutMs,
  );
  return {
    status: published.status,
    fileId,
    bookId: entry.bookId,
    format: entry.format,
    versionHash,
    contentHash,
    chunks: chunks.length,
    textBytes,
    packageBytes,
    artifact: `.local/prepared-text/${fileId}/${versionHash}.json`,
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const options = {};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail("invalid_arguments");
    seen.add(arg);
    if (arg === "--execute") options.execute = true;
    else if (arg === "--file" || arg === "--manifest") {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail("invalid_arguments");
      options[arg === "--file" ? "fileId" : "manifestPath"] = value;
    } else fail("invalid_arguments");
  }
  if (!options.fileId) fail("file_required");
  console.log(json(await prepareText(options)));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  cli().catch((error) => {
    console.error(
      json({
        code:
          error instanceof PreparationError ? error.code : "preparation_failed",
      }),
    );
    process.exitCode = 1;
  });
}
