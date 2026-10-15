// Private CF-03 data tooling. Never copy a manifest or a database row to public output.
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const LIMIT = 20_000_000;
export const CEILING = 8_000_000_000;
export class LibraryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new LibraryError(code);
};
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
export const validId = (v) => typeof v === "string" && /^[\w-]{1,100}$/.test(v);
const text = (v, max, nonempty = false) =>
  typeof v === "string" &&
  v.length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) &&
  (!nonempty || !!v.trim());
const formats = new Set(["PDF", "EPUB", "MOBI", "AZW", "AZW3", "AZW4"]);

export function metadataPatch(input) {
  if (
    !record(input) ||
    Object.keys(input).some(
      (k) =>
        !["title", "author", "description", "category", "tags"].includes(k),
    )
  )
    fail("invalid_metadata");
  const result = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "tags") {
      if (
        !Array.isArray(v) ||
        v.length > 20 ||
        v.some((t) => !text(t, 60, true) || /[\u0000-\u001f]/.test(t))
      )
        fail("invalid_metadata");
      result.tags = [...new Set(v.map((t) => t.trim()))];
    } else if (k === "author" && v === null) result.author = null;
    else {
      if (
        !text(
          v,
          { title: 300, author: 200, description: 4000, category: 100 }[k],
          ["title", "category"].includes(k),
        )
      )
        fail("invalid_metadata");
      result[k] = v.trim();
      if (k === "author" && !result[k]) result[k] = null;
    }
  }
  return result;
}

export function publicBook(input) {
  if (
    !record(input) ||
    !validId(input.id) ||
    !validId(input.categoryId) ||
    !Array.isArray(input.files)
  )
    fail("invalid_public_book");
  const patch = metadataPatch(
    Object.fromEntries(
      ["title", "author", "description", "category", "tags"].map((k) => [
        k,
        input[k],
      ]),
    ),
  );
  const ids = new Set();
  const files = input.files.map((f) => {
    if (
      !record(f) ||
      !validId(f.id) ||
      ids.has(f.id) ||
      !formats.has(f.format) ||
      !integer(f.sizeBytes) ||
      !["candidate", "local_only", "unavailable"].includes(f.status) ||
      ![
        "not_uploaded",
        "size",
        "empty",
        "changed",
        "uploaded",
        "unavailable",
        null,
      ].includes(f.reason) ||
      !["private", "public"].includes(f.visibility) ||
      typeof f.readable !== "boolean"
    )
      fail("invalid_public_file");
    ids.add(f.id);
    return {
      id: f.id,
      format: f.format,
      sizeBytes: f.sizeBytes,
      status: f.status,
      reason: f.reason,
      visibility: f.visibility,
      readable: f.readable,
    };
  });
  return {
    id: input.id,
    title: patch.title,
    author: patch.author,
    category: patch.category,
    categoryId: input.categoryId,
    tags: patch.tags,
    description: patch.description,
    files,
  };
}

export function publicCatalog(input, { now = new Date(), secrets = [] } = {}) {
  if (!record(input) || !Array.isArray(input.books)) fail("invalid_catalog");
  const ids = new Set(),
    fileIds = new Set(),
    categories = new Map();
  const stats = {
    books: 0,
    files: 0,
    totalBytes: 0,
    candidateBytes: 0,
    candidateFiles: 0,
    localOnlyFiles: 0,
    invalidFiles: 0,
  };
  const books = input.books
    .map(publicBook)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const b of books) {
    if (ids.has(b.id)) fail("duplicate_book_id");
    ids.add(b.id);
    stats.books++;
    const category = categories.get(b.categoryId) || {
      id: b.categoryId,
      name: b.category,
      count: 0,
    };
    if (category.name !== b.category) fail("category_conflict");
    category.count++;
    categories.set(b.categoryId, category);
    for (const f of b.files) {
      if (fileIds.has(f.id)) fail("duplicate_file_id");
      fileIds.add(f.id);
      stats.files++;
      stats.totalBytes += f.sizeBytes;
      if (!integer(stats.totalBytes)) fail("catalog_size_overflow");
      if (f.status === "candidate") {
        stats.candidateFiles++;
        stats.candidateBytes += f.sizeBytes;
      }
      if (f.status === "local_only") stats.localOnlyFiles++;
      if (f.status === "unavailable") stats.invalidFiles++;
    }
  }
  const result = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sourceStatus: "snapshot",
    thresholdBytes: LIMIT,
    stats,
    categories: [...categories.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    books,
  };
  assertPublic(result, secrets);
  return result;
}

export function assertPublic(value, secrets = []) {
  const encoded = JSON.stringify(value);
  if (
    /(?:\/Users\/[^/\s"'<>]+\/|\/Volumes\/[^/\s"'<>]+\/|\/home\/[^/\s"'<>]+\/|[A-Za-z]:\\\\)/.test(
      encoded,
    ) ||
    secrets.some(
      (s) =>
        typeof s === "string" &&
        s.length >= 8 &&
        [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)].some((v) =>
          encoded.includes(v),
        ),
    )
  )
    fail("public_privacy_rejected");
}

export async function privatePath(file, root, { existing = true } = {}) {
  const base = path.resolve(root, ".local"),
    target = path.resolve(file);
  const relative = path.relative(base, target);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    fail("private_path_required");
  const pieces = [
    base,
    ...relative
      .split(path.sep)
      .slice(0, -1)
      .map((_, i, parts) => path.join(base, ...parts.slice(0, i + 1))),
  ];
  for (const directory of pieces) {
    let stat;
    try {
      stat = await fs.lstat(directory);
    } catch {
      fail("private_directory_unavailable");
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700
    )
      fail("unsafe_private_directory");
  }
  try {
    const stat = await fs.lstat(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o600
    )
      fail("unsafe_private_file");
  } catch (e) {
    if (!(e.code === "ENOENT" && !existing)) throw e;
  }
  return target;
}

export async function readPrivateJson(file, root, maxBytes = 10_000_000) {
  const target = await privatePath(file, root);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes)
      fail("unsafe_private_file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export async function writePrivateJson(file, data, root) {
  const target = await privatePath(file, root, { existing: false });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function accountEvidence(input, accountId, now = Date.now()) {
  if (
    !record(input) ||
    input.schemaVersion !== 1 ||
    input.source !== "cloudflare-account-aggregate" ||
    input.targetAccount !== accountId ||
    input.accountMatch !== true ||
    input.completeCoverage !== true ||
    input.plan !== "free" ||
    input.storageClass !== "Standard"
  )
    fail("account_storage_unknown");
  const observed = Date.parse(input.observedAt);
  if (
    !Number.isFinite(observed) ||
    observed > now + 30_000 ||
    now - observed > 300_000
  )
    fail("account_storage_stale");
  if (
    !integer(input.storedBytes) ||
    !integer(input.classAOperations) ||
    !integer(input.classBOperations) ||
    input.billingPeriod !== new Date(now).toISOString().slice(0, 7)
  )
    fail("account_storage_unknown");
  if (input.classAOperations >= 800_000 || input.classBOperations >= 8_000_000)
    fail("account_operations_exceeded");
  return {
    observedBytes: input.storedBytes,
    observedAt: observed,
    evidenceSha256: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
  };
}

export async function selectedFile(
  manifest,
  fileId,
  { scope = "production" } = {},
) {
  if (!["production", "check"].includes(scope)) fail("invalid_scope");
  if (!validId(fileId) || !record(manifest) || !record(manifest.files))
    fail("invalid_file_selection");
  const entry = manifest.files[fileId];
  if (
    !record(entry) ||
    !validId(entry.bookId) ||
    !["EPUB", "PDF"].includes(entry.format) ||
    entry.eligibility !== "candidate" ||
    !integer(entry.sizeBytes, 1, LIMIT) ||
    typeof entry.path !== "string" ||
    typeof manifest.root !== "string" ||
    !/^\d+$/.test(entry.mtimeNs)
  )
    fail("file_ineligible");
  if (entry.storageKey) fail("local_already_uploaded");
  let root, real, handle;
  try {
    root = await fs.realpath(manifest.root);
    real = await fs.realpath(entry.path);
    const rel = path.relative(root, real);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(".." + path.sep) ||
      path.isAbsolute(rel) ||
      (await fs.lstat(entry.path)).isSymbolicLink()
    )
      fail("file_outside_root");
    handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const matches = (s) =>
      s.isFile() &&
      s.size === BigInt(entry.sizeBytes) &&
      String(s.mtimeNs) === entry.mtimeNs;
    if (!matches(before)) fail("file_changed");
    // Bound allocation even if another process starts extending the selected source.
    const buffer = Buffer.alloc(entry.sizeBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = buffer.subarray(0, length);
    const after = await handle.stat({ bigint: true });
    if (
      !matches(after) ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ctimeNs !== after.ctimeNs ||
      data.length !== entry.sizeBytes ||
      (await fs.realpath(entry.path)) !== real
    )
      fail("file_changed");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const prefix = scope === "production" ? "books/cf03" : "cf03-check";
    return {
      fileId,
      bookId: entry.bookId,
      format: entry.format,
      sizeBytes: entry.sizeBytes,
      sha256,
      objectKey: `${prefix}/${fileId}/${sha256}.${entry.format.toLowerCase()}`,
      data,
    };
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    fail("file_unavailable");
  } finally {
    await handle?.close();
  }
}
