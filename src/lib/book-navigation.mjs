import { canAccessFile } from "./file-availability.mjs";

export const canonicalId = (id) =>
  typeof id === "string" && /^[\w-]{1,128}$/.test(id) ? id : null;

export function queryId(search, key) {
  const values = new URLSearchParams(search).getAll(key);
  return values.length === 1 ? canonicalId(values[0]) : null;
}

// Build paths only from the configured application base, never a query parameter.
export function appBase(base = "/") {
  if (typeof base !== "string" || !/^\/(?:[\w-]+\/)*$/.test(base))
    throw new Error("网站路径配置无效。");
  return base;
}
export function bookDetailHref(id, base = "/") {
  if (!canonicalId(id)) throw new Error("书籍编号无效。");
  return `${appBase(base)}book/?id=${encodeURIComponent(id)}`;
}
export function readHref(bookId, fileId, base = "/") {
  if (!canonicalId(bookId) || !canonicalId(fileId))
    throw new Error("书籍或文件编号无效。");
  return `${appBase(base)}read/?book=${encodeURIComponent(bookId)}&file=${encodeURIComponent(fileId)}`;
}
export function apiBook(data, id) {
  const book = data?.book || data;
  if (!canonicalId(id) || book?.id !== id || !Array.isArray(book.files))
    throw new Error("书籍信息与当前页面不符，请重新载入。");
  return book;
}
export function currentBookFile(book, bookId, fileId, mode = "") {
  if (!canonicalId(bookId) || book?.id !== bookId || !canonicalId(fileId))
    return null;
  const matches = Array.isArray(book.files)
    ? book.files.filter((file) => file?.id === fileId)
    : [];
  return matches.length === 1 && canAccessFile(matches[0], mode)
    ? matches[0]
    : null;
}
