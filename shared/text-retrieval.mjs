/** Retrieval operates on normalized copies; callers retain original text and locators. */
export class TextRetrievalError extends Error {
  constructor(code) {
    super(code);
    this.name = "TextRetrievalError";
    this.code = code;
  }
}
const fail = () => {
  throw new TextRetrievalError("invalid_text_retrieval");
};

function terms(text) {
  // Upper/lower closure expands caseless forms (ß, final sigma, Greek iota
  // subscripts), after compatibility normalization. Preserve dotless i, which
  // Unicode's default, non-Turkic folding intentionally keeps distinct.
  const normalized = Array.from(
    text.normalize("NFKC").toLowerCase(),
    (point) => (point === "ı" ? point : point.toUpperCase().toLowerCase()),
  ).join("");
  const result = new Set();
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) {
    const run = match[0];
    for (const word of run.matchAll(/[^\p{Script=Han}]+/gu))
      result.add(word[0]);
    for (const sequence of run.matchAll(/\p{Script=Han}+/gu)) {
      const points = Array.from(sequence[0]);
      if (points.length === 1) result.add(points[0]);
      for (let index = 0; index + 1 < points.length; index++)
        result.add(points[index] + points[index + 1]);
    }
  }
  return result;
}

export function rankTextChunks(chunks, query, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail();
  const { limit = 5 } = options;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 5 ||
    !Array.isArray(chunks) ||
    typeof query !== "string"
  )
    fail();
  const queryTerms = terms(query);
  if (!queryTerms.size || !chunks.length) return [];
  const documents = chunks.map((chunk, index) => {
    if (!chunk || typeof chunk.text !== "string") fail();
    return { chunk, index, terms: terms(chunk.text) };
  });
  const frequencies = new Map();
  let totalLength = 0;
  for (const document of documents) {
    totalLength += document.terms.size;
    for (const term of queryTerms) {
      if (document.terms.has(term))
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  const averageLength = totalLength / documents.length || 1;
  return documents
    .map((document) => {
      let score = 0;
      for (const term of queryTerms) {
        if (document.terms.has(term)) {
          const df = frequencies.get(term);
          score += Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        }
      }
      // A mild bounded length adjustment avoids making a short generic chunk dominate.
      score /= 0.8 + 0.2 * Math.min(3, document.terms.size / averageLength);
      return { ...document, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ chunk }) => chunk);
}
