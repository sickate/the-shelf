const BROWSER_READER_FORMATS = new Set(["PDF", "EPUB", "MOBI", "AZW", "AZW3"]);

export function supportsBrowserReader(format) {
  return BROWSER_READER_FORMATS.has(String(format || "").toUpperCase());
}
