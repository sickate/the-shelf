// The Shelf MVP Worker: static assets + owner-only private book API.
// Contract: docs/mvp-plan.md
const MAX_FILE_BYTES = 20_000_000;
const BUDGET_LIMIT = 8_000_000_000;
const LEGACY_RESERVE = 100_000_000; // conservative allowance for old unknown responsibilities
const SESSION_DAYS = 30;
const COOKIE = "shelf_session";
const FORMATS = new Set(
  "pdf epub mobi azw3 azw txt md doc docx ppt pptx xls xlsx chm djvu cbz".split(" "),
);
const CONTENT_TYPES = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};
const SECURITY = { "X-Content-Type-Options": "nosniff" };
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY,
      ...headers,
    },
  });
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const sha256Hex = async (data) =>
  hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function requireConfig(env) {
  if (!env.OWNER_PASSWORD || !env.SESSION_SECRET) throw new HttpError(503, "not_configured");
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function isOwner(request, env) {
  requireConfig(env);
  const value = readCookie(request, COOKIE);
  const m = value && /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m || Number(m[1]) <= Date.now() / 1000) return false;
  const expected = b64url(await hmac(env.SESSION_SECRET, `owner:${m[1]}`));
  return bytesEqual(enc.encode(expected), enc.encode(m[2]));
}

async function requireOwner(request, env) {
  if (!(await isOwner(request, env))) throw new HttpError(401, "login_required");
}

async function sessionCookie(env) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = b64url(await hmac(env.SESSION_SECRET, `owner:${expiry}`));
  return `${COOKIE}=${expiry}.${sig}; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax; Path=/`;
}

// Validates a relative library path and derives category/title/format.
export function parseBookPath(raw) {
  if (typeof raw !== "string") throw new HttpError(400, "bad_path");
  const path = raw.normalize("NFC");
  const segments = path.split("/");
  if (
    !path ||
    path.length > 512 ||
    /[\\\u0000-\u001f\u007f]/.test(path) ||
    segments.some((s) => !s || s === "." || s === "..")
  )
    throw new HttpError(400, "bad_path");
  const name = segments.at(-1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!FORMATS.has(ext)) throw new HttpError(415, "unsupported_format");
  const withoutExt = path.slice(0, path.length - ext.length - 1);
  const category = segments.length > 1 ? segments[0] : "90-综合";
  const title = segments.length > 1 ? withoutExt.slice(segments[0].length + 1) : withoutExt;
  return { path, category, title, format: ext.toUpperCase() };
}

const publicBook = (r) => ({
  id: r.id,
  title: r.title,
  category: r.category,
  format: r.format,
  sizeBytes: r.size_bytes,
  status: r.status,
  createdAt: r.created_at,
});

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

const budgetUsed = async (env) =>
  (
    await env.DB.prepare(
      "SELECT COALESCE(SUM(size_bytes),0) AS used FROM books WHERE r2_key IS NOT NULL",
    ).first()
  ).used;

async function upload(request, env) {
  await requireOwner(request, env);
  let rawPath;
  try {
    rawPath = decodeURIComponent(request.headers.get("X-Shelf-Path") || "");
  } catch {
    throw new HttpError(400, "bad_path");
  }
  const info = parseBookPath(rawPath);
  const declared = (request.headers.get("X-Shelf-Sha256") || "").trim();
  if (!/^[0-9a-f]{64}$/.test(declared)) throw new HttpError(400, "bad_sha256");
  const length = request.headers.get("Content-Length");
  if (length !== null && !(Number(length) <= MAX_FILE_BYTES)) throw new HttpError(413, "too_large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, "too_large");
  if (bytes.byteLength === 0) throw new HttpError(400, "empty_file");
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== declared) throw new HttpError(400, "hash_mismatch");

  const id = `b_${sha256.slice(0, 16)}`;
  const key = `books/${sha256}`;
  const contentType = CONTENT_TYPES[info.format.toLowerCase()] || "application/octet-stream";
  const findBySha = () => env.DB.prepare("SELECT * FROM books WHERE sha256 = ?").bind(sha256).first();

  let row = await findBySha();
  if (row?.status === "uploaded") {
    if (row.deleted_at) {
      // Re-uploading a soft-deleted book restores it; the object and budget were never released.
      await env.DB.prepare("UPDATE books SET deleted_at = NULL WHERE id = ?").bind(row.id).run();
      row = { ...row, deleted_at: null };
    }
    return json({ book: publicBook(row), duplicate: true });
  }
  if (!row) {
    let changes = 0;
    try {
      const result = await env.DB.prepare(
        `INSERT INTO books (id, title, category, format, size_bytes, sha256, r2_key, source_path, status, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?
         WHERE (SELECT COALESCE(SUM(size_bytes),0) FROM books WHERE r2_key IS NOT NULL) + ? + ? <= ?`,
      )
        .bind(
          id,
          info.title,
          info.category,
          info.format,
          bytes.byteLength,
          sha256,
          key,
          info.path,
          new Date().toISOString(),
          LEGACY_RESERVE,
          bytes.byteLength,
          BUDGET_LIMIT,
        )
        .run();
      changes = result.meta.changes;
    } catch (error) {
      // A concurrent upload of the same bytes won the UNIQUE(sha256) race.
      row = await findBySha();
      if (!row) throw error;
      if (row.status === "uploaded") return json({ book: publicBook(row), duplicate: true });
    }
    if (!row && changes === 0) throw new HttpError(507, "budget_exceeded");
    row ??= await findBySha();
  }
  try {
    await env.BOOKS.put(key, bytes, { httpMetadata: { contentType }, sha256 });
  } catch {
    return json({ error: "storage_unknown" }, 502); // reservation kept; no automatic retry
  }
  await env.DB.prepare("UPDATE books SET status = 'uploaded', deleted_at = NULL WHERE id = ?")
    .bind(row.id)
    .run();
  return json({ book: publicBook({ ...row, status: "uploaded" }), duplicate: false });
}

async function catalog(request, env) {
  await requireOwner(request, env);
  const body = await readJson(request);
  const info = parseBookPath(body?.path);
  const size = body?.sizeBytes;
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "bad_size");
  const id = `p_${(await sha256Hex(info.path)).slice(0, 16)}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO books (id, title, category, format, size_bytes, source_path, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'local_only', ?)`,
  )
    .bind(id, info.title, info.category, info.format, size, info.path, new Date().toISOString())
    .run();
  const row = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
  return json({ book: publicBook(row) });
}

// Parses a single-range header against a known size. Returns null (full), {offset,length}, or throws 416.
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null; // ignore malformed/multi ranges
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) throw new HttpError(416, "range_not_satisfiable");
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== "" && Number(m[2]) < start) return null;
  }
  if (start >= size) throw new HttpError(416, "range_not_satisfiable");
  return { offset: start, length: end - start + 1 };
}

async function serveFile(request, env, row, url) {
  await requireOwner(request, env);
  if (!row || row.status !== "uploaded") throw new HttpError(404, "not_found");
  const ext = row.format.toLowerCase();
  const filename = `${row.title.split("/").at(-1)}.${ext}`;
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
  const size = row.size_bytes;
  let range;
  try {
    range = parseRange(request.headers.get("Range"), size);
  } catch (error) {
    if (error.status !== 416) throw error;
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store", ...SECURITY },
    });
  }
  const headers = {
    "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encoded}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Content-Length": String(range ? range.length : size),
    ...SECURITY,
  };
  if (range) headers["Content-Range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
  const status = range ? 206 : 200;
  if (request.method === "HEAD") {
    if (!(await env.BOOKS.head(row.r2_key))) throw new HttpError(404, "not_found");
    return new Response(null, { status, headers });
  }
  const object = await env.BOOKS.get(row.r2_key, range ? { range } : undefined);
  if (!object?.body) throw new HttpError(404, "not_found");
  return new Response(object.body, { status, headers });
}

async function handleApi(request, env, url) {
  const { method } = request;
  const path = url.pathname;
  if (["POST", "PUT", "DELETE"].includes(method) && request.headers.get("Origin") !== url.origin)
    throw new HttpError(403, "bad_origin");

  if (path === "/api/login" && method === "POST") {
    requireConfig(env);
    const body = await readJson(request);
    const password = typeof body?.password === "string" ? body.password : "";
    const [given, expected] = await Promise.all([
      hmac(env.SESSION_SECRET, `password:${password}`),
      hmac(env.SESSION_SECRET, `password:${env.OWNER_PASSWORD}`),
    ]);
    if (!bytesEqual(given, expected)) return json({ error: "invalid_password" }, 401);
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env) });
  }
  if (path === "/api/logout" && method === "POST")
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`,
    });
  if (path === "/api/me" && method === "GET") return json({ owner: await isOwner(request, env) });
  if (path === "/api/upload" && method === "PUT") return upload(request, env);
  if (path === "/api/catalog" && method === "POST") return catalog(request, env);
  if (path === "/api/budget" && method === "GET") {
    await requireOwner(request, env);
    return json({
      usedBytes: (await budgetUsed(env)) + LEGACY_RESERVE,
      limitBytes: BUDGET_LIMIT,
      legacyReserveBytes: LEGACY_RESERVE,
    });
  }
  if (path === "/api/books" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM books WHERE deleted_at IS NULL AND status != 'reserved' ORDER BY category, title`,
    ).all();
    const books = results.map(publicBook);
    return json({ books, categories: [...new Set(books.map((b) => b.category))].sort() });
  }
  const m = /^\/api\/books\/([A-Za-z0-9_]{1,40})(\/file)?$/.exec(path);
  if (m) {
    const row = await env.DB.prepare("SELECT * FROM books WHERE id = ? AND deleted_at IS NULL")
      .bind(m[1])
      .first();
    if (m[2] && (method === "GET" || method === "HEAD")) return serveFile(request, env, row, url);
    if (!m[2] && method === "GET") {
      if (!row || row.status === "reserved") throw new HttpError(404, "not_found");
      return json({ book: publicBook(row) });
    }
    if (!m[2] && method === "DELETE") {
      await requireOwner(request, env);
      if (!row) throw new HttpError(404, "not_found");
      await env.DB.prepare("UPDATE books SET deleted_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), row.id)
        .run();
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "not_found");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, error.status);
      console.error("api_error", error?.message);
      return json({ error: "internal_error" }, 500);
    }
  },
};
