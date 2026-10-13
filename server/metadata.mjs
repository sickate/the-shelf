import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ApiError, publicBook } from "./storage.mjs";
const fields = ["title", "author", "description", "tags", "category"];
export function validateMetadata(input, catalog) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Object.keys(input).length ||
    Object.keys(input).some((k) => !fields.includes(k))
  )
    throw new ApiError("invalid_metadata");
  const output = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (key === "tags") {
      if (
        !Array.isArray(value) ||
        value.length > 20 ||
        value.some((t) => typeof t !== "string" || !t.trim() || t.length > 60)
      )
        throw new ApiError("invalid_metadata");
      output.tags = [...new Set(value.map((t) => t.trim()))];
      continue;
    }
    if (key === "author" && value === null) {
      output.author = null;
      continue;
    }
    const limit = { title: 300, author: 200, description: 4000, category: 100 }[
      key
    ];
    if (
      typeof value !== "string" ||
      value.length > limit ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
      ((key === "title" || key === "category") && !value.trim())
    )
      throw new ApiError("invalid_metadata");
    output[key] = value.trim();
    if (key === "author" && !output.author) output.author = null;
  }
  if (output.category)
    output.categoryId =
      catalog.categories?.find((c) => c.name === output.category)?.id ||
      catalog.books.find((b) => b.category === output.category)?.categoryId ||
      `cat-${createHash("sha256").update(output.category).digest("hex").slice(0, 12)}`;
  return output;
}
export async function atomicJson(file, data, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export function publicCatalog(catalog) {
  const categories = new Map();
  for (const b of catalog.books) {
    const c = categories.get(b.categoryId) || {
      id: b.categoryId,
      name: b.category,
      count: 0,
    };
    c.count++;
    categories.set(b.categoryId, c);
  }
  const stats = {};
  for (const k of [
    "books",
    "files",
    "totalBytes",
    "candidateBytes",
    "candidateFiles",
    "localOnlyFiles",
    "invalidFiles",
  ])
    if (typeof catalog.stats?.[k] === "number") stats[k] = catalog.stats[k];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceStatus: catalog.sourceStatus === "scanned" ? "scanned" : "snapshot",
    thresholdBytes: 20000000,
    stats,
    categories: [...categories.values()],
    books: catalog.books.map(publicBook),
  };
}
