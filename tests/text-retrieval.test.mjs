import test from "node:test";
import assert from "node:assert/strict";
import {
  rankTextChunks,
  TextRetrievalError,
} from "../shared/text-retrieval.mjs";

const chunk = (text, index) => ({
  index,
  text,
  locator: {
    type: "pdf-page",
    page: index + 1,
    start: 0,
    end: Array.from(text).length,
  },
});

test("rare Chinese topic beats repetition of a generic query term", () => {
  const chunks = [
    chunk("学习".repeat(2000), 0),
    chunk("量子纠缠能够解释相关性。", 1),
    chunk("学习是一种日常活动。", 2),
    chunk("持续学习，天天学习。", 3),
  ];
  const ranked = rankTextChunks(chunks, "学习量子纠缠");
  assert.equal(ranked[0], chunks[1]);
});

test("deduplicated words prevent keyword repetition boosting and preserve stable input ties", () => {
  const chunks = [
    chunk("topic".repeat(1), 12),
    chunk("topic ".repeat(200), 2),
    chunk("different", 3),
  ];
  assert.deepEqual(
    rankTextChunks(chunks, "TOPIC topic TOPIC"),
    chunks.slice(0, 2),
  );
  assert.equal(rankTextChunks(chunks, "topic", { limit: 1 })[0], chunks[0]);
});

test("NFKC and casefold match fullwidth Latin, digits, sharp-s, Greek and Chinese without changing originals", () => {
  const chunks = [
    chunk("ＡＰＩ １２３ Straße ΟΣ ᾀ 量子纠缠😀", 0),
    chunk("other passage", 1),
  ];
  const before = structuredClone(chunks);
  for (const query of ["api 123", "Ａｐｉ", "STRASSE", "ος", "ἀι", "纠缠"])
    assert.equal(rankTextChunks(chunks, query)[0], chunks[0]);
  assert.deepEqual(rankTextChunks([chunk("ı", 0)], "i"), []);
  assert.deepEqual(chunks, before);
  assert.deepEqual(
    rankTextChunks(chunks, "api"),
    rankTextChunks(chunks, "api"),
  );
  assert.deepEqual(Object.keys(rankTextChunks(chunks, "api")[0]), [
    "index",
    "text",
    "locator",
  ]);
});

test("empty and unrelated queries never fall back to arbitrary chunks", () => {
  const chunks = [chunk("这是一段量子力学正文", 0), chunk("apple banana", 1)];
  for (const query of ["", " \n", "！ 😀", "火山喷发", "pineapple", "Quantum"])
    assert.deepEqual(rankTextChunks(chunks, query), []);
  assert.deepEqual(rankTextChunks([], "正文"), []);
});

test("limit is capped at five and malformed limits are rejected with a safe code", () => {
  const chunks = Array.from({ length: 8 }, (_, i) => chunk("topic", i));
  assert.deepEqual(rankTextChunks(chunks, "topic"), chunks.slice(0, 5));
  for (const limit of [0, -1, 6, 1.1, NaN, Infinity, "2", null])
    assert.throws(
      () => rankTextChunks(chunks, "topic", { limit }),
      (error) =>
        error instanceof TextRetrievalError &&
        error.code === "invalid_text_retrieval",
    );
  for (const options of [null, [], "5"])
    assert.throws(
      () => rankTextChunks(chunks, "topic", options),
      TextRetrievalError,
    );
});
