import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { THRESHOLD } from "./config.mjs";
export class ApiError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export async function validateFile(manifest, id) {
  const entry = manifest.files?.[id];
  if (!entry) throw new ApiError("file_unavailable", 404);
  if (
    entry.eligibility !== "candidate" ||
    entry.sizeBytes <= 0 ||
    entry.sizeBytes > THRESHOLD
  )
    throw new ApiError("file_ineligible", 409);
  let root, real, stat;
  try {
    root = await fs.realpath(manifest.root);
    real = await fs.realpath(entry.path);
    stat = await fs.stat(real, { bigint: true });
  } catch {
    throw new ApiError("file_unavailable", 409);
  }
  const relative = path.relative(root, real);
  if (
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    !relative
  )
    throw new ApiError("file_outside_root", 403);
  if (
    !stat.isFile() ||
    stat.size !== BigInt(entry.sizeBytes) ||
    stat.size <= 0 ||
    stat.size > BigInt(THRESHOLD) ||
    (entry.mtimeNs && String(stat.mtimeNs) !== String(entry.mtimeNs))
  )
    throw new ApiError("file_changed", 409);
  return { entry, real, stat };
}
const hash = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (key, s) => createHmac("sha256", key).update(s).digest();
const encode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export function presign(c, key, method = "GET", now = new Date()) {
  if (
    typeof key !== "string" ||
    !key ||
    key.includes("..") ||
    key.startsWith("/")
  )
    throw new ApiError("invalid_storage_key");
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    day = date.slice(0, 8),
    scope = `${day}/auto/s3/aws4_request`,
    host = `${c.r2Account}.r2.cloudflarestorage.com`;
  const uri = "/" + [c.r2Bucket, ...key.split("/")].map(encode).join("/");
  const query = Object.entries({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${c.r2AccessKey}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
  })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join("&");
  const canonical = `${method}\n${uri}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const signing = hmac(
    hmac(hmac(hmac("AWS4" + c.r2Secret, day), "auto"), "s3"),
    "aws4_request",
  );
  return `https://${host}${uri}?${query}&X-Amz-Signature=${createHmac(
    "sha256",
    signing,
  )
    .update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`)
    .digest("hex")}`;
}
export const publicBook = (b) =>
  b && {
    id: b.id,
    title: b.title,
    author: b.author,
    category: b.category,
    categoryId: b.categoryId,
    tags: b.tags,
    description: b.description,
    files: (b.files || []).map((f) => ({
      id: f.id,
      format: f.format,
      sizeBytes: f.sizeBytes,
      status: f.status,
      reason: f.reason,
      visibility: f.visibility,
      readable: f.readable,
    })),
  };
