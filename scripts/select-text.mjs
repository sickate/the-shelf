#!/usr/bin/env node
/** Explicit one-file activation; never edits the original manifest or book. */
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  privateTextOperation,
  readPins,
  readPreparedPackage,
  validatePin,
  matchPinSource,
  rejectPrepared,
} from "../server/prepared-text.mjs";
import { ApiError } from "../server/storage.mjs";

const PROJECT = fileURLToPath(new URL("../", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;

export async function selectText({
  fileId,
  versionHash,
  replaceVersion,
  execute = false,
  projectRoot = PROJECT,
  manifestPath = path.join(projectRoot, ".local/manifest.json"),
  stateDir = path.join(projectRoot, ".local"),
} = {}) {
  if (typeof execute !== "boolean") rejectPrepared("invalid_execute");
  if (
    typeof fileId !== "string" ||
    !/^file_[a-f0-9]{16}$/.test(fileId) ||
    typeof versionHash !== "string" ||
    !HASH.test(versionHash) ||
    (replaceVersion !== undefined &&
      (typeof replaceVersion !== "string" || !HASH.test(replaceVersion))) ||
    typeof manifestPath !== "string" ||
    !path.isAbsolute(manifestPath) ||
    typeof stateDir !== "string" ||
    !path.isAbsolute(stateDir)
  )
    rejectPrepared("invalid_arguments");
  const { manifest } = await privateTextOperation({
    operation: "manifest",
    path: manifestPath,
  });
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.files ||
    typeof manifest.root !== "string"
  )
    rejectPrepared("manifest_invalid");
  const entry = manifest.files[fileId];
  const { pins, sha256: expectedHash } = await readPins(stateDir);
  // Reading through the helper verifies manifest size/mtime and holds nofollow fds.
  if (!entry || typeof entry.path !== "string")
    rejectPrepared("prepared_source_mismatch");
  const sourceRequest = {
    root: manifest.root,
    path: entry.path,
    bytes: entry.sizeBytes,
    mtimeNs: entry.mtimeNs,
  };
  // Validate source metadata before reading any original book content.
  const initial = validatePin({
    fileId,
    bookId: entry.bookId,
    format: entry.format,
    sizeBytes: entry.sizeBytes,
    mtimeNs: entry.mtimeNs,
    versionHash,
    sourceSha256: "0".repeat(64),
  });
  matchPinSource(initial, entry);
  const source = await privateTextOperation({
    ...sourceRequest,
    operation: "read",
  });
  const pin = {
    ...initial,
    sourceSha256: createHash("sha256")
      .update(Buffer.from(source.data, "base64"))
      .digest("hex"),
  };
  const value = await readPreparedPackage(stateDir, pin);
  const previous = pins.files[fileId];
  if (replaceVersion !== undefined && previous?.versionHash !== replaceVersion)
    rejectPrepared("prepared_selection_conflict");
  if (
    previous &&
    previous.versionHash !== versionHash &&
    replaceVersion === undefined
  )
    rejectPrepared("prepared_replace_required");
  if (
    previous?.versionHash === versionHash &&
    JSON.stringify(previous) !== JSON.stringify(pin)
  )
    rejectPrepared("prepared_source_mismatch");
  const result = {
    status: "dry-run",
    fileId,
    bookId: pin.bookId,
    versionHash,
    chunks: value.chunks.length,
    wouldReplace: Boolean(previous && previous.versionHash !== versionHash),
    selectionOrder: "catalog-file-order",
  };
  if (!execute) return result;
  await privateTextOperation({
    ...sourceRequest,
    operation: "verify",
    expected: source.snapshot,
  });
  const files = { ...pins.files, [fileId]: pin };
  await privateTextOperation({
    operation: "pins-commit",
    stateDir,
    expectedHash,
    pins: JSON.stringify({ schemaVersion: 1, files }) + "\n",
  });
  return {
    ...result,
    status: previous?.versionHash === versionHash ? "reused" : "selected",
  };
}

async function cli() {
  const args = process.argv.slice(2),
    options = {},
    seen = new Set();
  const names = {
    "--file": "fileId",
    "--version": "versionHash",
    "--manifest": "manifestPath",
    "--replace-version": "replaceVersion",
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) rejectPrepared("invalid_arguments");
    seen.add(arg);
    if (arg === "--execute") options.execute = true;
    else if (Object.hasOwn(names, arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) rejectPrepared("invalid_arguments");
      options[names[arg]] = arg === "--manifest" ? path.resolve(value) : value;
    } else rejectPrepared("invalid_arguments");
  }
  if (!options.fileId) rejectPrepared("file_required");
  if (!options.versionHash) rejectPrepared("version_required");
  console.log(JSON.stringify(await selectText(options)));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  cli().catch((error) => {
    console.error(
      JSON.stringify({
        code: error instanceof ApiError ? error.code : "prepared_io_failed",
      }),
    );
    process.exitCode = 1;
  });
}
