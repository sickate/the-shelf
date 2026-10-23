const ID = /^[\w-]{1,128}$/;

export function applyCatalogVisibility(books, response) {
  if (
    !Array.isArray(books) ||
    !response ||
    !Array.isArray(response.hiddenBookIds) ||
    response.hiddenBookIds.length > 10_000
  )
    return { books, available: false };

  const hidden = new Set();
  for (const id of response.hiddenBookIds) {
    if (typeof id !== "string" || !ID.test(id) || hidden.has(id))
      return { books, available: false };
    hidden.add(id);
  }

  const knownIds = new Set(
    books.map((book) => book?.id).filter((id) => typeof id === "string"),
  );
  return {
    books: books.filter(
      (book) => !knownIds.has(book?.id) || !hidden.has(book.id),
    ),
    available: true,
  };
}
