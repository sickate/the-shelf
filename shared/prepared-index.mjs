/** Private, text-free projection of a fully validated prepared-text package. */
export const PREPARED_INDEX_LIMITS = Object.freeze({
  packageBytes: 20_000_000,
  chunks: 20_000,
  pageRows: 1000,
  pageBytes: 524288,
  responseBytes: 65536,
  streamBlocks: 65536,
  timeoutMs: 30000,
});
export async function preparedDigest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const encoder = new TextEncoder();
export async function buildPreparedIndex(value) {
  const chunks = value.chunks.map((chunk) => ({
    chunkIndex: chunk.index,
    locator: { ...chunk.locator },
    sha256: chunk.sha256,
    codepoints: chunk.locator.end - chunk.locator.start,
    utf8Bytes: encoder.encode(chunk.text).byteLength,
  }));
  const body = {
    schemaVersion: 1,
    fileId: value.source.fileId,
    bookId: value.source.bookId,
    versionHash: value.versionHash,
    format: value.source.format,
    chunkCount: chunks.length,
    textBytes: value.textBytes,
    codepointCount: chunks.reduce((sum, chunk) => sum + chunk.codepoints, 0),
    chunks,
  };
  return {
    ...body,
    indexSha256: await preparedDigest(encoder.encode(JSON.stringify(body))),
  };
}
export function preparedChunkRow(chunk) {
  return {
    chunk_index: chunk.chunkIndex,
    locator_type: chunk.locator.type,
    section_number:
      chunk.locator.type === "pdf-page"
        ? chunk.locator.page
        : chunk.locator.spineIndex,
    start_offset: chunk.locator.start,
    end_offset: chunk.locator.end,
    chunk_sha256: chunk.sha256,
    codepoints: chunk.codepoints,
    utf8_bytes: chunk.utf8Bytes,
  };
}
export function publicPreparedSource(chunk, pin) {
  return {
    fileId: pin.fileId,
    versionHash: pin.versionHash,
    chunkIndex: chunk.index,
    locator: `${pin.fileId}:${pin.versionHash}:${chunk.index + 1}`,
    sourceLocator: { ...chunk.locator },
    label:
      chunk.locator.type === "pdf-page"
        ? `PDF 第 ${chunk.locator.page} 页`
        : `EPUB 第 ${chunk.locator.spineIndex + 1} 节`,
  };
}
