import test from "node:test";
import assert from "node:assert/strict";
import { applyCatalogVisibility } from "../src/lib/catalog-visibility.mjs";

const books = [
  { id: "book_a", title: "公开书" },
  { id: "book_b", title: "另一册" },
];

test("catalog visibility hides only known public snapshot IDs", () => {
  const result = applyCatalogVisibility(books, {
    hiddenBookIds: ["book_b", "book_private"],
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.books, [books[0]]);
});

test("duplicate or malformed hidden ID responses fail closed to the static catalog", () => {
  for (const hiddenBookIds of [
    ["book_a", "book_a"],
    [null],
    ["bad/id"],
    "book_a",
  ]) {
    const result = applyCatalogVisibility(books, { hiddenBookIds });
    assert.equal(result.available, false);
    assert.equal(result.books, books);
  }
  assert.equal(applyCatalogVisibility(books, null).books, books);
});
