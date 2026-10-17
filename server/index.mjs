import http from "node:http";
import path from "node:path";
import { validateMetadata, atomicJson, publicCatalog } from "./metadata.mjs";
import { promises as fs, createReadStream } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getConfig, aiConfigured, r2Configured, THRESHOLD } from "./config.mjs";
import {
  ApiError,
  loadJson,
  validateFile,
  presign,
  publicBook,
} from "./storage.mjs";
import { JobQueue, publishedJob } from "./jobs.mjs";
import { overlayPreparedPins } from "./prepared-text.mjs";
const mime = {
  PDF: "application/pdf",
  EPUB: "application/epub+zip",
  MOBI: "application/x-mobipocket-ebook",
  AZW: "application/vnd.amazon.ebook",
  AZW3: "application/vnd.amazon.ebook",
};
async function body(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16384) throw new ApiError("body_too_large", 413);
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw new ApiError("invalid_json");
  }
}
export async function createServer(config = getConfig(), options = {}) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const catalog =
      options.catalog || (await loadJson(config.catalogPath, { books: [] })),
    manifest = await overlayPreparedPins(
      options.manifest || (await loadJson(config.manifestPath, { files: {} })),
      config.stateDir,
    );
  await fs.chmod(config.stateDir, 0o700);
  const overridePath = path.join(config.stateDir, "overrides.json");
  let overrides = await loadJson(overridePath, { schemaVersion: 1, books: {} });
  for (const book of catalog.books) {
    const saved = overrides.books?.[book.id];
    if (saved) {
      const clean = {};
      for (const k of ["title", "author", "description", "tags", "category"])
        if (Object.hasOwn(saved, k)) clean[k] = saved[k];
      if (Object.keys(clean).length)
        Object.assign(book, validateMetadata(clean, catalog));
    }
  }
  let metadataTail = Promise.resolve();
  const queue = new JobQueue(config, catalog, manifest, options),
    sessions = new Map(),
    rates = new Map();
  const salt = randomBytes(32),
    passwordHash = scryptSync(config.password, salt, 32);
  const rate = (key, limit, window = 60000) => {
    const now = Date.now();
    let r = rates.get(key);
    if (!r || now - r.time > window) {
      r = { time: now, count: 0 };
      rates.set(key, r);
    }
    if (++r.count > limit) throw new ApiError("rate_limited", 429);
  };
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
    for (const [k, r] of rates) if (now - r.time > 3600000) rates.delete(k);
  }, 60000);
  maintenance.unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const send = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const origin = req.headers.origin;
      if (origin) {
        if (!config.origins.includes(origin))
          throw new ApiError("origin_forbidden", 403);
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, Range",
          "Access-Control-Max-Age": "600",
        });
        return res.end();
      }
      rate(req.socket.remoteAddress, 240);
      const token = (req.headers.cookie || "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("shelf_session="))
        ?.slice(14);
      const session = sessions.get(token);
      const authenticated = Boolean(session && session.expires > Date.now());
      const auth = () => {
        if (!authenticated) throw new ApiError("authentication_required", 401);
      };
      if (req.method === "POST") {
        if (!origin || !config.origins.includes(origin))
          throw new ApiError("origin_forbidden", 403);
        if (authenticated && req.headers["x-csrf-token"] !== session.csrf)
          throw new ApiError("csrf_invalid", 403);
      }
      const url = new URL(req.url, "http://localhost"),
        p = url.pathname;
      let match;
      if (req.method === "GET" && p === "/api/health")
        return send(200, { ok: true });
      if (req.method === "GET" && p === "/api/config")
        return send(200, {
          apiConfigured: true,
          aiConfigured: aiConfigured(config),
          r2Configured: r2Configured(config),
          localFilesEnabled: config.localFilesEnabled,
          thresholdBytes: THRESHOLD,
        });
      if (req.method === "GET" && p === "/api/session")
        return send(200, {
          authenticated,
          csrfToken: authenticated ? session.csrf : null,
        });
      if (req.method === "POST" && p === "/api/login") {
        rate(`login:${req.socket.remoteAddress}`, 5, 60000);
        const input = await body(req);
        if (
          typeof input.password !== "string" ||
          input.password.length > 1000 ||
          !config.password ||
          !timingSafeEqual(scryptSync(input.password, salt, 32), passwordHash)
        )
          throw new ApiError("invalid_credentials", 401);
        if (sessions.size >= 1000) throw new ApiError("session_limit", 429);
        const id = randomBytes(32).toString("hex"),
          csrf = randomBytes(32).toString("hex");
        sessions.set(id, { csrf, expires: Date.now() + 86400000 });
        res.setHeader(
          "Set-Cookie",
          `shelf_session=${id}; HttpOnly; Path=/api; SameSite=${config.secureCookie ? "None" : "Lax"}; Max-Age=86400${config.secureCookie ? "; Secure" : ""}`,
        );
        return send(200, { authenticated: true, csrfToken: csrf });
      }
      if (req.method === "POST" && p === "/api/logout") {
        auth();
        sessions.delete(token);
        res.setHeader(
          "Set-Cookie",
          `shelf_session=; HttpOnly; Path=/api; SameSite=${config.secureCookie ? "None" : "Lax"}; Max-Age=0${config.secureCookie ? "; Secure" : ""}`,
        );
        return send(200, { authenticated: false, csrfToken: null });
      }
      if (
        (match = p.match(
          /^\/api\/books\/([\w-]+)(?:\/(jobs|history|published|metadata))?$/,
        ))
      ) {
        const book = catalog.books.find((b) => b.id === match[1]);
        if (!book) throw new ApiError("book_not_found", 404);
        const action = match[2];
        if (req.method === "GET" && !action) return send(200, publicBook(book));
        if (req.method === "GET" && action === "published")
          return send(200, {
            jobs: queue
              .history(book.id)
              .filter((j) => j.published && j.status === "completed")
              .map(publishedJob),
          });
        auth();
        if (req.method === "POST" && action === "metadata") {
          const input = validateMetadata(await body(req), catalog);
          const mutate = async () => {
            const next = {
              schemaVersion: 1,
              books: {
                ...overrides.books,
                [book.id]: { ...overrides.books?.[book.id], ...input },
              },
            };
            await atomicJson(overridePath, next);
            overrides = next;
            Object.assign(book, input);
            if (!options.catalog)
              await atomicJson(
                config.catalogPath,
                publicCatalog(catalog),
                0o644,
              );
            return publicBook(book);
          };
          const pending = metadataTail.then(mutate);
          metadataTail = pending.catch(() => {});
          return send(200, { book: await pending });
        }
        if (req.method === "POST" && action === "jobs")
          return send(202, { job: queue.create(book, await body(req)) });
        if (req.method === "GET" && action === "history")
          return send(200, { jobs: queue.history(book.id) });
      }
      if ((match = p.match(/^\/api\/jobs\/([\w-]+)(?:\/(publish))?$/))) {
        auth();
        const job = queue.get(match[1]);
        if (!job) throw new ApiError("job_not_found", 404);
        if (req.method === "GET" && !match[2]) return send(200, { job });
        if (req.method === "POST" && match[2]) {
          const input = await body(req);
          if (typeof input.published !== "boolean")
            throw new ApiError("invalid_publish");
          return send(200, { job: queue.publish(job.id, input.published) });
        }
      }
      if ((match = p.match(/^\/api\/files\/([\w-]+)\/(access|content)$/))) {
        auth();
        const id = match[1],
          entry = manifest.files[id];
        if (!entry) throw new ApiError("file_not_found", 404);
        if (
          entry.eligibility !== "candidate" ||
          entry.sizeBytes <= 0 ||
          entry.sizeBytes > THRESHOLD
        )
          throw new ApiError("file_ineligible", 409);
        if (match[2] === "access" && req.method === "GET") {
          if (entry.storageKey && r2Configured(config)) {
            queue.r2Access();
            return send(200, {
              url: presign(config, entry.storageKey),
              format: entry.format,
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              mode: "r2",
            });
          }
          if (!config.localFilesEnabled)
            throw new ApiError("files_unconfigured", 503);
          await validateFile(manifest, id);
          return send(200, {
            url: `/api/files/${id}/content`,
            format: entry.format,
            expiresAt: new Date(session.expires).toISOString(),
            mode: "local",
          });
        }
        if (match[2] === "content" && ["GET", "HEAD"].includes(req.method)) {
          if (!config.localFilesEnabled)
            throw new ApiError("local_files_disabled", 403);
          const { real, stat } = await validateFile(manifest, id);
          const size = Number(stat.size);
          let start = 0,
            end = size - 1,
            status = 200;
          const range = req.headers.range;
          if (range) {
            const r = range.match(/^bytes=(\d*)-(\d*)$/);
            if (!r || (!r[1] && !r[2])) {
              res.setHeader("Content-Range", `bytes */${size}`);
              throw new ApiError("invalid_range", 416);
            }
            if (!r[1]) start = Math.max(0, size - Number(r[2]));
            else {
              start = Number(r[1]);
              if (r[2]) end = Math.min(end, Number(r[2]));
            }
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start > end ||
              start >= size
            ) {
              res.setHeader("Content-Range", `bytes */${size}`);
              throw new ApiError("invalid_range", 416);
            }
            status = 206;
            res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          }
          res.writeHead(status, {
            "Content-Type": mime[entry.format] || "application/octet-stream",
            "Content-Length": end - start + 1,
            "Accept-Ranges": "bytes",
            "Content-Disposition": `inline; filename="${id}.${String(
              entry.format,
            )
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "")}"`,
          });
          if (req.method === "HEAD") return res.end();
          const stream = createReadStream(real, { start, end });
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
          return;
        }
      }
      throw new ApiError("not_found", 404);
    } catch (error) {
      if (!res.headersSent)
        send(error.status || 500, {
          error: { code: error.code || "internal_error" },
        });
      else res.destroy();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxConnections = 100;
  server.shutdown = async () => {
    clearInterval(maintenance);
    await new Promise((resolve) =>
      server.listening ? server.close(resolve) : resolve(),
    );
    await queue.close();
  };
  server.queue = queue;
  return server;
}
export const createApp = createServer;
export async function startServer(config = getConfig(), options = {}) {
  const server = await createServer(config, options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = getConfig();
  const server = await startServer(config);
  console.log(
    `The Shelf backend listening on http://${config.host}:${config.port}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      server.shutdown().then(() => process.exit(0));
    });
}
