/** Private prepared-text v1 contract. Web platform APIs only (Node 24 / Workers). */
export const PREPARED_TEXT_LIMIT = 20_000_000;
const CHUNK_POINTS = 6000;
const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;
const FILE = /^file_[a-f0-9]{16}$/;
const BOOK = /^book_[a-f0-9]{16}$/;

export class PreparedTextError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreparedTextError";
    this.code = code;
  }
}
const fail = (code = "prepared_text_invalid") => {
  throw new PreparedTextError(code);
};
const exact = (value, keys) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail();
};
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const hash = async (value) => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** All expected fields are mandatory: a version alone never establishes its source. */
export async function validatePreparedText(bytes, expected) {
  if (!(bytes instanceof Uint8Array)) fail("prepared_text_invalid_bytes");
  if (!bytes.byteLength || bytes.byteLength > PREPARED_TEXT_LIMIT)
    fail("prepared_text_size_limit");
  if (
    !expected ||
    typeof expected !== "object" ||
    typeof expected.fileId !== "string" ||
    !FILE.test(expected.fileId) ||
    typeof expected.bookId !== "string" ||
    !BOOK.test(expected.bookId) ||
    !["PDF", "EPUB"].includes(expected.format) ||
    !integer(expected.sizeBytes, 1, PREPARED_TEXT_LIMIT) ||
    typeof expected.mtimeNs !== "string" ||
    !/^\d+$/.test(expected.mtimeNs) ||
    typeof expected.versionHash !== "string" ||
    !HASH.test(expected.versionHash) ||
    typeof expected.sourceSha256 !== "string" ||
    !HASH.test(expected.sourceSha256)
  )
    fail("prepared_text_invalid_expected");
  let serialized, value;
  try {
    // Preserve a BOM so the canonical-byte comparison rejects it too.
    serialized = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    value = JSON.parse(serialized);
  } catch {
    fail("prepared_text_invalid_encoding");
  }
  exact(value, [
    "schemaVersion",
    "kind",
    "preparation",
    "source",
    "textBytes",
    "contentHash",
    "chunks",
    "versionHash",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "shelf.prepared-text") fail();
  exact(value.preparation, [
    "algorithm",
    "normalization",
    "chunkCodepoints",
    "offsetUnit",
  ]);
  const preparation = {
    algorithm: "shelf-text-v1",
    normalization: "LF-NFC-trim-section",
    chunkCodepoints: CHUNK_POINTS,
    offsetUnit: "unicode-code-point",
  };
  for (const key of Object.keys(preparation)) {
    if (value.preparation[key] !== preparation[key]) fail();
  }
  exact(value.source, [
    "fileId",
    "bookId",
    "format",
    "sizeBytes",
    "mtimeNs",
    "fingerprint",
  ]);
  exact(value.source.fingerprint, ["algorithm", "value"]);
  const source = {
    fileId: expected.fileId,
    bookId: expected.bookId,
    format: expected.format,
    sizeBytes: expected.sizeBytes,
    mtimeNs: expected.mtimeNs,
    fingerprint: { algorithm: "sha256", value: expected.sourceSha256 },
  };
  for (const key of ["fileId", "bookId", "format", "sizeBytes", "mtimeNs"]) {
    if (value.source[key] !== source[key])
      fail("prepared_text_source_mismatch");
  }
  if (
    value.source.fingerprint.algorithm !== "sha256" ||
    value.source.fingerprint.value !== expected.sourceSha256
  )
    fail("prepared_text_source_mismatch");
  if (
    !Array.isArray(value.chunks) ||
    !integer(value.chunks.length, 1, 20_000) ||
    !integer(value.textBytes, 1, PREPARED_TEXT_LIMIT) ||
    typeof value.contentHash !== "string" ||
    !HASH.test(value.contentHash) ||
    typeof value.versionHash !== "string" ||
    !HASH.test(value.versionHash)
  )
    fail();

  const chunks = [];
  let textBytes = 0;
  let previousSection = -1,
    previousEnd = 0,
    previousText = "",
    priorSectionPoints = 0;
  const pdf = source.format === "PDF";
  for (let index = 0; index < value.chunks.length; index++) {
    const chunk = value.chunks[index];
    exact(chunk, ["index", "locator", "text", "sha256"]);
    exact(chunk.locator, ["type", pdf ? "page" : "spineIndex", "start", "end"]);
    const { start, end } = chunk.locator;
    const section = pdf ? chunk.locator.page : chunk.locator.spineIndex;
    if (
      chunk.index !== index ||
      chunk.locator.type !== (pdf ? "pdf-page" : "epub-spine") ||
      !integer(section, pdf ? 1 : 0, pdf ? PREPARED_TEXT_LIMIT : 9999) ||
      !integer(start, 0, PREPARED_TEXT_LIMIT) ||
      start % CHUNK_POINTS !== 0 ||
      !integer(end, start + 1, PREPARED_TEXT_LIMIT) ||
      end - start > CHUNK_POINTS ||
      typeof chunk.text !== "string" ||
      chunk.text.length > CHUNK_POINTS * 2 ||
      !chunk.text.trim() ||
      !chunk.text.isWellFormed() ||
      /[\r\u0000]/u.test(chunk.text) ||
      chunk.text.normalize("NFC") !== chunk.text ||
      Array.from(chunk.text).length !== end - start ||
      typeof chunk.sha256 !== "string" ||
      !HASH.test(chunk.sha256)
    )
      fail();
    if (section < previousSection) fail();
    if (section === previousSection) {
      // Missing all-whitespace windows are allowed, overlapping/short prior windows are not.
      if (start < previousEnd || previousEnd % CHUNK_POINTS !== 0) fail();
    } else {
      if (
        start !== 0 ||
        chunk.text.trimStart() !== chunk.text ||
        previousText.trimEnd() !== previousText
      )
        fail();
      priorSectionPoints += previousEnd;
    }
    // Skipped whitespace windows still count against the bounded extractor output.
    if (priorSectionPoints + end > PREPARED_TEXT_LIMIT)
      fail("prepared_text_size_limit");
    textBytes += encoder.encode(chunk.text).byteLength;
    if (textBytes > PREPARED_TEXT_LIMIT) fail("prepared_text_size_limit");
    if ((await hash(chunk.text)) !== chunk.sha256)
      fail("prepared_text_hash_mismatch");
    const locator = pdf
      ? { type: "pdf-page", page: section, start, end }
      : { type: "epub-spine", spineIndex: section, start, end };
    chunks.push({ index, locator, text: chunk.text, sha256: chunk.sha256 });
    previousSection = section;
    previousEnd = end;
    previousText = chunk.text;
  }
  if (previousText.trimEnd() !== previousText || value.textBytes !== textBytes)
    fail();
  if ((await hash(JSON.stringify(chunks))) !== value.contentHash)
    fail("prepared_text_hash_mismatch");
  const body = {
    schemaVersion: 1,
    kind: "shelf.prepared-text",
    preparation,
    source,
    textBytes,
    contentHash: value.contentHash,
    chunks,
  };
  if (
    (await hash(JSON.stringify(body))) !== value.versionHash ||
    value.versionHash !== expected.versionHash
  )
    fail("prepared_text_hash_mismatch");
  const validated = { ...body, versionHash: value.versionHash };
  // v1 producer writes exactly this representation. Reject duplicates, changed ordering,
  // numeric spellings, hidden fields and alternate encodings rather than hashing raw objects.
  if (JSON.stringify(validated) + "\n" !== serialized)
    fail("prepared_text_noncanonical");
  return validated;
}
