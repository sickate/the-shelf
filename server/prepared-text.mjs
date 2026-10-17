/** Private Node adapter. Package validation itself is shared with future Workers. */
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { runBounded } from "../scripts/prepare-text.mjs";
import {
  validatePreparedText,
  PreparedTextError,
} from "../shared/prepared-text.mjs";
import { ApiError } from "./storage.mjs";

const HELPER = fileURLToPath(
  new URL("../scripts/prepare-text-helper.py", import.meta.url),
);
const ID = /^file_[a-f0-9]{16}$/;
const BOOK = /^book_[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = [
  "fileId",
  "bookId",
  "format",
  "sizeBytes",
  "mtimeNs",
  "versionHash",
  "sourceSha256",
];
const SAFE = new Set([
  "prepared_permissions",
  "prepared_unsafe_path",
  "prepared_package_unavailable",
  "prepared_changed",
  "prepared_selection_conflict",
  "prepared_pin_invalid",
  "unsafe_path",
  "source_changed",
  "source_outside_root",
  "source_not_file",
  "empty_source",
  "source_too_large",
  "size_limit",
  "manifest_invalid",
]);
export const rejectPrepared = (code) => {
  throw new ApiError(code, 409);
};

export async function privateTextOperation(request) {
  try {
    const result = await runBounded(
      "python3",
      [HELPER],
      JSON.stringify(request),
      { maxBytes: 28_000_000 },
    );
    let value;
    try {
      value = JSON.parse(result.output);
    } catch {
      rejectPrepared("prepared_io_failed");
    }
    if (result.code !== 0 || value.error) {
      const code = SAFE.has(value.error) ? value.error : "prepared_io_failed";
      rejectPrepared(code === "unsafe_path" ? "prepared_unsafe_path" : code);
    }
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    rejectPrepared("prepared_io_failed");
  }
}

export function validatePin(pin, fileId = pin?.fileId) {
  if (
    !pin ||
    typeof pin !== "object" ||
    Array.isArray(pin) ||
    Object.keys(pin).length !== FIELDS.length ||
    FIELDS.some((key) => !Object.hasOwn(pin, key)) ||
    typeof fileId !== "string" ||
    !ID.test(fileId) ||
    pin.fileId !== fileId ||
    typeof pin.bookId !== "string" ||
    !BOOK.test(pin.bookId) ||
    !["PDF", "EPUB"].includes(pin.format) ||
    !Number.isSafeInteger(pin.sizeBytes) ||
    pin.sizeBytes < 1 ||
    pin.sizeBytes > 20_000_000 ||
    typeof pin.mtimeNs !== "string" ||
    !/^\d+$/.test(pin.mtimeNs) ||
    typeof pin.versionHash !== "string" ||
    !HASH.test(pin.versionHash) ||
    typeof pin.sourceSha256 !== "string" ||
    !HASH.test(pin.sourceSha256)
  )
    rejectPrepared("prepared_pin_invalid");
  return Object.fromEntries(FIELDS.map((key) => [key, pin[key]]));
}

export function matchPinSource(pin, entry, bookId = pin.bookId) {
  if (
    !entry ||
    entry.eligibility !== "candidate" ||
    entry.visibility !== "private" ||
    pin.bookId !== bookId ||
    ["bookId", "format", "sizeBytes", "mtimeNs"].some(
      (key) => pin[key] !== entry[key],
    )
  )
    rejectPrepared("prepared_source_mismatch");
}

export function validatePins(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    !value.files ||
    typeof value.files !== "object" ||
    Array.isArray(value.files) ||
    Object.keys(value.files).length > 5000
  )
    rejectPrepared("prepared_pin_invalid");
  const files = Object.create(null);
  for (const [fileId, pin] of Object.entries(value.files))
    files[fileId] = validatePin(pin, fileId);
  return { schemaVersion: 1, files };
}

export async function readPins(stateDir) {
  // No selection and no artifact directory is the existing server's legacy case.
  // Do not traverse or read any private file in that case.
  try {
    await fs.lstat(path.join(stateDir, "prepared-text"));
  } catch (error) {
    if (error.code === "ENOENT")
      return { pins: { schemaVersion: 1, files: {} }, sha256: null };
    rejectPrepared("prepared_io_failed");
  }
  const value = await privateTextOperation({
    operation: "pins-read",
    stateDir,
  });
  if (value.data === null)
    return { pins: { schemaVersion: 1, files: {} }, sha256: null };
  let parsed;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(value.data, "base64"),
      ),
    );
  } catch {
    rejectPrepared("prepared_pin_invalid");
  }
  return { pins: validatePins(parsed), sha256: value.sha256 };
}

export async function overlayPreparedPins(manifest, stateDir) {
  const { pins } = await readPins(stateDir);
  const files = Object.fromEntries(
    Object.entries(manifest.files || {}).map(([id, entry]) => {
      const copy = { ...entry };
      delete copy.preparedText; // Only the independent selection snapshot activates a server pin.
      return [id, copy];
    }),
  );
  for (const [fileId, pin] of Object.entries(pins.files)) {
    matchPinSource(pin, files[fileId]);
    files[fileId] = { ...files[fileId], preparedText: pin };
  }
  return { ...manifest, files };
}

/** Synchronous selection so queue creation freezes its version before persistence. */
export function snapshotPreparedSource(book, manifest) {
  let selected = null;
  for (const file of book.files || []) {
    const entry = manifest.files?.[file.id];
    if (!entry || !Object.hasOwn(entry, "preparedText")) continue;
    const pin = validatePin(entry.preparedText, file.id);
    matchPinSource(pin, entry, book.id ?? pin.bookId);
    if (file.format !== undefined && file.format !== pin.format)
      rejectPrepared("prepared_source_mismatch");
    selected ??= pin;
  }
  return selected;
}

export async function readPreparedPackage(stateDir, pin) {
  const expected = validatePin(pin);
  const result = await privateTextOperation({
    operation: "prepared-read",
    stateDir,
    fileId: pin.fileId,
    versionHash: pin.versionHash,
  });
  try {
    return await validatePreparedText(
      Buffer.from(result.data, "base64"),
      expected,
    );
  } catch (error) {
    // Shared validator errors carry only fixed, safe codes.
    throw new ApiError(
      error instanceof PreparedTextError ? error.code : "prepared_io_failed",
      409,
    );
  }
}

export async function preparedChunks(stateDir, pin) {
  const value = await readPreparedPackage(stateDir, pin);
  return value.chunks.map((chunk) => ({
    text: chunk.text,
    label:
      chunk.locator.type === "pdf-page"
        ? `PDF 第 ${chunk.locator.page} 页`
        : `EPUB 第 ${chunk.locator.spineIndex + 1} 节`,
    locator: `${pin.fileId}:${pin.versionHash}:${chunk.index + 1}`,
    fileId: pin.fileId,
    sourceLocator: { ...chunk.locator },
    versionHash: pin.versionHash,
    chunkIndex: chunk.index,
  }));
}
