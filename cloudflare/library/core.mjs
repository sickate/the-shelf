import { LibraryError } from "./security.mjs";

export const THRESHOLD = 20_000_000;
const fields = ["title", "author", "description", "tags", "category"];
const idPattern = /^[\w-]{1,128}$/;
export function safeId(value) {
  return typeof value === "string" && idPattern.test(value);
}
export function mergePublicBook(base, patch = {}, registrations = []) {
  if (
    !base ||
    typeof base !== "object" ||
    Array.isArray(base) ||
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch)
  )
    throw new LibraryError("service_unavailable", 503);
  const source = { ...base };
  for (const key of [...fields, "categoryId"])
    if (Object.hasOwn(patch, key)) source[key] = patch[key];
  if (
    !safeId(source.id) ||
    typeof source.title !== "string" ||
    !(source.author === null || typeof source.author === "string") ||
    typeof source.category !== "string" ||
    typeof source.categoryId !== "string" ||
    typeof source.description !== "string" ||
    !Array.isArray(source.tags) ||
    source.tags.some((t) => typeof t !== "string") ||
    !Array.isArray(base.files)
  )
    throw new LibraryError("service_unavailable", 503);
  return {
    id: source.id,
    title: source.title,
    author: source.author,
    category: source.category,
    categoryId: source.categoryId,
    tags: Array.isArray(source.tags)
      ? source.tags.filter((t) => typeof t === "string")
      : [],
    description: source.description,
    files: base.files.map((f) => {
      if (
        !f ||
        !safeId(f.id) ||
        typeof f.format !== "string" ||
        !Number.isSafeInteger(f.sizeBytes) ||
        f.sizeBytes < 0 ||
        !["candidate", "local_only", "unavailable"].includes(f.status) ||
        !(f.reason === null || typeof f.reason === "string") ||
        typeof f.visibility !== "string" ||
        typeof f.readable !== "boolean"
      )
        throw new LibraryError("service_unavailable", 503);
      const uploaded = registrations.some(
        (r) =>
          r.state === "confirmed" &&
          r.file_id === f.id &&
          r.book_id === source.id &&
          r.format === f.format &&
          r.size_bytes === f.sizeBytes &&
          f.status === "candidate" &&
          f.sizeBytes > 0 &&
          f.sizeBytes <= THRESHOLD,
      );
      return {
        id: f.id,
        format: f.format,
        sizeBytes: f.sizeBytes,
        status: f.status,
        reason: uploaded
          ? "uploaded"
          : f.reason === "uploaded"
            ? "not_uploaded"
            : f.reason,
        visibility: f.visibility,
        readable: f.readable,
      };
    }),
  };
}
const contentTypes = {
  EPUB: "application/epub+zip",
  PDF: "application/pdf",
  MOBI: "application/x-mobipocket-ebook",
  AZW: "application/vnd.amazon.ebook",
  AZW3: "application/vnd.amazon.ebook",
};
export function normalizedEtag(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const bare =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  // R2 exposes etag without quotes and httpEtag with quotes. Neither weak ETags
  // nor a partially quoted/empty value can establish immutable object identity.
  return /^[A-Za-z0-9_-]{1,128}$/.test(bare) ? bare : null;
}
export function objectHeadMatches(file, head) {
  const expectedEtag = normalizedEtag(file.etag);
  const etags =
    head && [head.etag, head.httpEtag].filter((v) => v !== undefined);
  return Boolean(
    head &&
    expectedEtag &&
    etags.length &&
    etags.every((value) => normalizedEtag(value) === expectedEtag) &&
    Number.isSafeInteger(head.size) &&
    head.size === file.size_bytes &&
    typeof file.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(file.sha256) &&
    head.customMetadata?.sha256 === file.sha256 &&
    typeof head.httpMetadata?.contentType === "string" &&
    head.httpMetadata.contentType.trim().toLowerCase() ===
      contentTypes[file.format],
  );
}
export function validateMetadataFields(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Object.keys(input).length ||
    Object.keys(input).some((k) => !fields.includes(k))
  )
    throw new LibraryError("invalid_metadata");
  const clean = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (key === "tags") {
      if (
        !Array.isArray(value) ||
        value.length > 20 ||
        value.some(
          (t) =>
            typeof t !== "string" ||
            !t.trim() ||
            t.length > 60 ||
            /[\u0000-\u001f]/.test(t),
        )
      )
        throw new LibraryError("invalid_metadata");
      clean.tags = [...new Set(value.map((t) => t.trim()))];
    } else if (key === "author" && value === null) clean.author = null;
    else {
      const limit = {
        title: 300,
        author: 200,
        description: 4000,
        category: 100,
      }[key];
      if (
        typeof value !== "string" ||
        value.length > limit ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
        (["title", "category"].includes(key) && !value.trim())
      )
        throw new LibraryError("invalid_metadata");
      clean[key] = value.trim();
      if (key === "author" && !clean[key]) clean[key] = null;
    }
  }
  return clean;
}
const categoryIdCache = new Map();
const CATEGORY_CACHE_LIMIT = 64;
export async function deriveCategoryId(category, existing = null) {
  if (
    typeof category !== "string" ||
    !category ||
    category.length > 100 ||
    category.trim() !== category ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(category)
  )
    throw new LibraryError("invalid_metadata");
  // An authoritative known ID always wins, including when an older hash for
  // this same public category is already cached or still being calculated.
  if (existing !== null && existing !== undefined) {
    if (!safeId(existing)) throw new LibraryError("service_unavailable", 503);
    return existing;
  }
  if (categoryIdCache.has(category)) return categoryIdCache.get(category);
  if (categoryIdCache.size >= CATEGORY_CACHE_LIMIT)
    categoryIdCache.delete(categoryIdCache.keys().next().value);
  const pending = (async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(category),
    );
    return `cat-${[...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 12)}`;
  })();
  categoryIdCache.set(category, pending);
  // A failed digest must be retryable. An evicted old promise must not erase a
  // newer entry for the same key; catch consumes its own derived rejection.
  pending.catch(() => {
    if (categoryIdCache.get(category) === pending)
      categoryIdCache.delete(category);
  });
  return pending;
}
export async function validateChanges(input, categoryIdFor = async () => null) {
  const clean = validateMetadataFields(input);
  if (clean.category)
    clean.categoryId = await deriveCategoryId(
      clean.category,
      await categoryIdFor(clean.category),
    );
  return clean;
}
const encode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(key, data) {
  const imported = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(data)),
  );
}
export function validObjectKey(key, scope, format) {
  const prefix = scope === "production" ? "books/" : "cf03-check/";
  return (
    typeof key === "string" &&
    key.length <= 512 &&
    key.startsWith(prefix) &&
    /^[A-Za-z0-9._/-]+$/.test(key) &&
    !key.split("/").some((s) => !s || s === "." || s === "..") &&
    key.endsWith(`.${String(format).toLowerCase()}`)
  );
}
export async function presignGet(env, key, format, now = new Date()) {
  if (!validObjectKey(key, env.APP_SCOPE, format))
    throw new LibraryError("file_unavailable", 409);
  if (
    !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID || "") ||
    env.R2_BUCKET !== "the-shelf-books" ||
    !/^[A-Za-z0-9_-]{10,256}$/.test(env.R2_ACCESS_KEY_ID || "") ||
    typeof env.R2_SECRET_ACCESS_KEY !== "string" ||
    env.R2_SECRET_ACCESS_KEY.length < 20 ||
    env.R2_SECRET_ACCESS_KEY.length > 256
  )
    throw new LibraryError("files_unconfigured", 503);
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    day = date.slice(0, 8),
    scope = `${day}/auto/s3/aws4_request`,
    host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const uri = "/" + [env.R2_BUCKET, ...key.split("/")].map(encode).join("/");
  const query = Object.entries({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${env.R2_ACCESS_KEY_ID}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
  })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join("&");
  const canonical = `GET\n${uri}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const hash = hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      ),
    ),
  );
  const signing = await hmac(
    await hmac(
      await hmac(await hmac("AWS4" + env.R2_SECRET_ACCESS_KEY, day), "auto"),
      "s3",
    ),
    "aws4_request",
  );
  const signature = hex(
    await hmac(signing, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash}`),
  );
  return `https://${host}${uri}?${query}&X-Amz-Signature=${signature}`;
}
