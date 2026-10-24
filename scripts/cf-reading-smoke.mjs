// Explicit production read validation. No CLI, configuration discovery, uploads or AI.
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privatePath } from "./cf-library-data.mjs";
import { objectDescriptor } from "../server/storage-authority.mjs";
import { isCanonicalKey } from "../cloudflare/library/security.mjs";
import { normalizedEtag } from "../cloudflare/library/core.mjs";
import {
  SINGLE_TRIAL_MODE,
  SINGLE_TRIAL_BUCKET,
} from "../cloudflare/library/single-trial.mjs";

export const READING_ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
export const READING_LIMITS = Object.freeze({
  requests: 11,
  trialRequests: 15,
  v2Requests: 20,
  timeoutMs: 30_000,
  objectBytes: 20_000_000,
  jsonBytes: 65_536,
  rangeBytes: 32,
  streamChunks: 65_536,
});
const CODES = new Set([
  "invalid_plan",
  "invalid_options",
  "private_evidence_failed",
  "request_budget",
  "request_unknown",
  "deadline_exceeded",
  "response_invalid",
  "response_limit",
  "response_chunk_limit",
  "http_rejected",
  "authentication_invalid",
  "catalog_mismatch",
  "signature_invalid",
  "object_mismatch",
  "range_mismatch",
]);
class ReadingError extends Error {
  constructor(code) {
    super(CODES.has(code) ? code : "request_unknown");
    this.code = this.message;
  }
}
const fail = (code) => {
  throw new ReadingError(code);
};
const safeCode = (error) =>
  error instanceof ReadingError ? error.code : "request_unknown";
const own = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  Object.keys(v).every((k) => keys.includes(k));
function planValue(p) {
  try {
    // v2 source/target is pinned private evidence supplied by the caller.
    // The same-origin HTTP surface does not independently prove a source bucket.
    const v2 = p?.schemaVersion === 2;
    if (
      !own(p, [
        "schemaVersion",
        "profile",
        "origin",
        "accountId",
        "bucket",
        "descriptor",
        "etag",
        ...(v2
          ? ["storageMode", "writeMode", "source"]
          : p?.mode === SINGLE_TRIAL_MODE
            ? ["mode"]
            : []),
      ]) ||
      (!v2 && p.schemaVersion !== 1) ||
      (v2 &&
        (p.storageMode !== "authority-v2" ||
          p.writeMode !== "closed" ||
          !["normal", "trial"].includes(p.source))) ||
      typeof p.profile !== "string" ||
      p.profile !== "production" ||
      typeof p.origin !== "string" ||
      p.origin !== READING_ORIGIN ||
      typeof p.accountId !== "string" ||
      !/^[a-f0-9]{32}$/.test(p.accountId) ||
      typeof p.bucket !== "string" ||
      p.bucket !==
        ((v2 ? p.source === "trial" : p.mode === SINGLE_TRIAL_MODE)
          ? SINGLE_TRIAL_BUCKET
          : "the-shelf-books") ||
      typeof p.etag !== "string" ||
      !normalizedEtag(p.etag)
    )
      fail("invalid_plan");
    const d = objectDescriptor(p.descriptor);
    if (
      d.kind !== "original" ||
      d.scope !== "production" ||
      !["PDF", "EPUB"].includes(d.format)
    )
      fail("invalid_plan");
    return { ...p, descriptor: d, etag: normalizedEtag(p.etag) };
  } catch {
    fail("invalid_plan");
  }
}
const localContent = (p) =>
  p.schemaVersion === 2 || p.mode === SINGLE_TRIAL_MODE;
const mimeFor = (d) =>
  d.format === "PDF" ? "application/pdf" : "application/epub+zip";
const same = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;

// privatePath provides the existing project private-path policy. Open handles and
// inode pins additionally prevent parent replacement and receipt reuse during IO.
async function journalValue(receipt, requestLimit = READING_LIMITS.requests) {
  const handles = [],
    files = [];
  let failed = false;
  try {
    if (
      !own(receipt, ["root", "directory"]) ||
      typeof receipt.root !== "string" ||
      typeof receipt.directory !== "string"
    )
      fail("private_evidence_failed");
    const root = path.resolve(receipt.root),
      directory = path.resolve(receipt.directory);
    if (
      (await fs.realpath(root)) !== root ||
      path.dirname(directory) !== path.join(root, ".local/cf03") ||
      !/^reading-smoke-[A-Za-z0-9_-]{1,80}$/.test(path.basename(directory))
    )
      fail("private_evidence_failed");
    await privatePath(
      path.join(path.dirname(directory), "unused-private-probe"),
      root,
      { existing: false },
    );
    const paths = [path.parse(root).root];
    for (const part of directory
      .slice(paths[0].length)
      .split(path.sep)
      .filter(Boolean))
      paths.push(path.join(paths.at(-1), part));
    for (const location of paths.slice(0, -1)) {
      const stat = await fs.lstat(location);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(location)) !== location
      )
        fail("private_evidence_failed");
      const handle = await fs.open(
        location,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push({ location, stat, handle });
      if (!same(stat, await handle.stat())) fail("private_evidence_failed");
    }
    const verify = async () => {
      if (failed) fail("private_evidence_failed");
      for (const p of handles) {
        const s = await fs.lstat(p.location);
        if (
          !s.isDirectory() ||
          s.isSymbolicLink() ||
          !same(s, p.stat) ||
          !same(await p.handle.stat(), p.stat)
        )
          fail("private_evidence_failed");
        if (
          p.location.startsWith(path.join(root, ".local")) &&
          ((s.mode & 0o777) !== 0o700 || s.uid !== process.getuid())
        )
          fail("private_evidence_failed");
      }
      for (const p of files) {
        const s = await fs.lstat(p.location);
        if (
          !s.isFile() ||
          s.isSymbolicLink() ||
          !same(s, p.stat) ||
          s.nlink !== 1 ||
          s.size !== p.stat.size ||
          s.mtimeMs !== p.stat.mtimeMs ||
          s.ctimeMs !== p.stat.ctimeMs ||
          (s.mode & 0o777) !== 0o600
        )
          fail("private_evidence_failed");
      }
    };
    await verify();
    await fs.mkdir(directory, { mode: 0o700 }); // exclusive run reservation, never removed
    await handles.at(-1).handle.sync();
    const stat = await fs.lstat(directory),
      handle = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    handles.push({ location: directory, stat, handle });
    async function write(name, value) {
      try {
        await verify();
        const location = await privatePath(path.join(directory, name), root, {
          existing: false,
        });
        const h = await fs.open(
          location,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await verify();
          const initial = await h.stat();
          if (
            !initial.isFile() ||
            initial.uid !== process.getuid() ||
            initial.nlink !== 1 ||
            (initial.mode & 0o777) !== 0o600
          )
            fail("private_evidence_failed");
          await h.writeFile(JSON.stringify(value) + "\n");
          await h.sync();
          files.push({ location, stat: await h.stat() });
        } finally {
          await h.close();
        }
        await handles.at(-1).handle.sync();
        await verify();
      } catch {
        failed = true;
        fail("private_evidence_failed");
      }
    }
    await write("run-start.json", {
      schemaVersion: 1,
      profile: "production",
      requestLimit,
    });
    return {
      write,
      verify: async () => {
        try {
          await verify();
        } catch {
          failed = true;
          fail("private_evidence_failed");
        }
      },
      close: async () => {
        await Promise.allSettled(handles.map((p) => p.handle.close()));
      },
    };
  } catch {
    await Promise.allSettled(handles.map((p) => p.handle.close()));
    fail("private_evidence_failed");
  }
}

function signatureUrl(access, p, now) {
  try {
    if (localContent(p)) {
      if (
        !own(access, ["url", "format", "expiresAt", "mode"]) ||
        access.mode !== "local" ||
        access.expiresAt !== null ||
        access.format !== p.descriptor.format ||
        access.url !==
          `/api/files/${encodeURIComponent(p.descriptor.fileId)}/content`
      )
        fail("signature_invalid");
      return READING_ORIGIN + access.url;
    }
    if (
      !Number.isSafeInteger(now) ||
      !own(access, ["url", "format", "expiresAt", "mode"]) ||
      access.format !== p.descriptor.format ||
      access.mode !== "r2" ||
      typeof access.url !== "string" ||
      access.url.length > 4096
    )
      fail("signature_invalid");
    const u = new URL(access.url),
      q = u.searchParams;
    const keys = [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-SignedHeaders",
      "X-Amz-Signature",
    ];
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.hash ||
      u.host !== `${p.accountId}.r2.cloudflarestorage.com` ||
      u.pathname !== `/${p.bucket}/${p.descriptor.objectKey}` ||
      [...q.keys()].length !== keys.length ||
      keys.some((k) => q.getAll(k).length !== 1) ||
      [...q.keys()].some((k) => !keys.includes(k)) ||
      q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
      q.get("X-Amz-SignedHeaders") !== "host" ||
      !/^[a-f0-9]{64}$/.test(q.get("X-Amz-Signature")) ||
      !/^[1-9][0-9]{0,2}$/.test(q.get("X-Amz-Expires")) ||
      Number(q.get("X-Amz-Expires")) > 300 ||
      !/^[0-9]{8}T[0-9]{6}Z$/.test(q.get("X-Amz-Date"))
    )
      fail("signature_invalid");
    const stamp = q.get("X-Amz-Date"),
      issued = Date.parse(
        `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
      );
    const credential = q.get("X-Amz-Credential");
    if (
      !new RegExp(
        `^[A-Za-z0-9_-]{10,256}/${stamp.slice(0, 8)}/auto/s3/aws4_request$`,
      ).test(credential) ||
      !Number.isFinite(issued) ||
      issued > now + 5000 ||
      issued + Number(q.get("X-Amz-Expires")) * 1000 <= now ||
      Date.parse(access.expiresAt) <
        issued + Number(q.get("X-Amz-Expires")) * 1000 ||
      Date.parse(access.expiresAt) >
        issued + Number(q.get("X-Amz-Expires")) * 1000 + 999 ||
      !Number.isFinite(Date.parse(access.expiresAt))
    )
      fail("signature_invalid");
    return u.href;
  } catch {
    fail("signature_invalid");
  }
}
function sessionCookie(response) {
  const list = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie"),
  ];
  if (list.length !== 1 || typeof list[0] !== "string")
    fail("authentication_invalid");
  const parts = list[0].split(";").map((s) => s.trim()),
    first = parts.shift();
  if (
    !first?.startsWith("__Host-shelf_session=") ||
    !isCanonicalKey(first.slice(21)) ||
    parts.length !== 5 ||
    !["Secure", "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=86400"].every(
      (p) => parts.includes(p),
    )
  )
    fail("authentication_invalid");
  return first;
}
const cancel = (body) => {
  try {
    Promise.resolve(body?.cancel()).catch(() => {});
  } catch {}
};

/** Preview is zero IO. Execute accepts only explicitly loaded private inputs. */
export async function runReadingSmoke(options = {}) {
  const p = planValue(options.plan);
  const requestLimit =
    p.schemaVersion === 2
      ? READING_LIMITS.v2Requests
      : p.mode === SINGLE_TRIAL_MODE
        ? READING_LIMITS.trialRequests
        : READING_LIMITS.requests;
  if (options.execute !== true)
    return {
      dryRun: true,
      profile: "production",
      requests:
        p.schemaVersion === 2 ? 19 : p.mode === SINGLE_TRIAL_MODE ? 14 : 10,
      requestLimit,
      browserVerified: false,
    };
  const timeout = options.timeoutMs ?? READING_LIMITS.timeoutMs,
    now = options.now ?? Date.now;
  if (
    !isCanonicalKey(options.accessKey) ||
    typeof (options.fetchImpl ?? fetch) !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > READING_LIMITS.timeoutMs ||
    (options.environment ?? process.env).CI
  )
    fail("invalid_options");
  const fetcher = options.fetchImpl ?? fetch,
    journal = await journalValue(options.receipt, requestLimit);
  let sequence = 0,
    cookie = null,
    csrf = null,
    logoutAttempted = false,
    loginUnknown = false,
    logoutUnknown = false,
    revocationUnverified = false,
    code = null,
    ok = false;
  async function send(
    label,
    url,
    {
      method = "GET",
      body,
      expected = 200,
      object = false,
      range = false,
      anonymous = false,
      negativeOrigin = false,
      negativeCsrf = false,
      operator = false,
    } = {},
  ) {
    if (++sequence > requestLimit) fail("request_budget");
    const ordinal = String(sequence).padStart(2, "0");
    await journal.write(`${ordinal}-intent.json`, {
      sequence,
      label,
      method,
      service: object && p.schemaVersion !== 2 ? "r2" : "api",
    });
    await journal.verify();
    let timer,
      reader,
      expired = false;
    const controller = new AbortController();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        try {
          Promise.resolve(reader?.cancel()).catch(() => {});
        } catch {}
        reject(new ReadingError("deadline_exceeded"));
      }, timeout);
    });
    let status = null;
    try {
      const headers = object
        ? {
            Origin: READING_ORIGIN,
            ...(localContent(p) && cookie ? { Cookie: cookie } : {}),
            ...(range
              ? {
                  Range: `bytes=0-${Math.min(31, p.descriptor.sizeBytes - 1)}`,
                  "If-Match": `"${p.etag}"`,
                }
              : {}),
          }
        : {
            ...(cookie && !anonymous ? { Cookie: cookie } : {}),
            ...(method === "POST"
              ? {
                  Origin: READING_ORIGIN,
                  "Content-Type": "application/json",
                  ...(csrf && !operator ? { "X-CSRF-Token": csrf } : {}),
                }
              : {}),
          };
      if (negativeOrigin)
        headers.Origin = "https://shelf-reading-negative.invalid";
      if (negativeCsrf) headers["X-CSRF-Token"] = "invalid-trial-csrf";
      const work = (async () => {
        const response = await fetcher(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: controller.signal,
        });
        if (expired) {
          cancel(response?.body);
          fail("deadline_exceeded");
        }
        if (
          !(response instanceof Response) ||
          response.redirected ||
          (response.url && response.url !== url)
        ) {
          cancel(response?.body);
          fail("response_invalid");
        }
        status = response.status;
        if (status !== expected) {
          cancel(response.body);
          fail("http_rejected");
        }
        const limit = object
          ? range
            ? Math.min(32, p.descriptor.sizeBytes)
            : p.descriptor.sizeBytes
          : READING_LIMITS.jsonBytes;
        const length = response.headers.get("content-length");
        if (
          (object && method === "HEAD" && length === null) ||
          (length !== null &&
            (!/^[0-9]+$/.test(length) ||
              Number(length) > limit ||
              (object && Number(length) !== limit)))
        ) {
          cancel(response.body);
          fail("response_limit");
        }
        const contentType = (response.headers.get("content-type") || "")
          .trim()
          .toLowerCase();
        if (
          object &&
          (contentType !== mimeFor(p.descriptor) ||
            normalizedEtag(response.headers.get("etag")) !== p.etag ||
            (response.headers.get("content-encoding") &&
              response.headers.get("content-encoding") !== "identity"))
        ) {
          cancel(response.body);
          fail("object_mismatch");
        }
        if (
          object &&
          method === "HEAD" &&
          (response.headers.get("accept-ranges") !== "bytes" ||
            response.headers.has("content-range") ||
            response.headers.get("cache-control") !== "private, no-store")
        ) {
          cancel(response.body);
          fail("object_mismatch");
        }
        if (object && !localContent(p)) {
          const exposed = new Set(
            (response.headers.get("access-control-expose-headers") || "")
              .toLowerCase()
              .split(",")
              .map((s) => s.trim()),
          );
          if (
            response.headers.get("access-control-allow-origin") !==
              READING_ORIGIN ||
            response.headers.has("access-control-allow-credentials") ||
            ["accept-ranges", "content-range", "content-length", "etag"].some(
              (h) => !exposed.has(h),
            )
          ) {
            cancel(response.body);
            fail("response_invalid");
          }
        }
        if (!object && !/^application\/json(?:\s*;|$)/.test(contentType)) {
          cancel(response.body);
          fail("response_invalid");
        }
        if (
          range &&
          response.headers.get("content-range") !==
            `bytes 0-${limit - 1}/${p.descriptor.sizeBytes}`
        ) {
          cancel(response.body);
          fail("range_mismatch");
        }
        reader = response.body?.getReader();
        if (method === "HEAD" && !reader) return { response };
        if (!reader) fail("response_invalid");
        let size = 0,
          chunkCount = 0;
        const chunks = [],
          hash = createHash("sha256"),
          prefix = Buffer.alloc(Math.min(32, limit));
        while (true) {
          const { done, value } = await reader.read();
          if (expired) fail("deadline_exceeded");
          if (done) break;
          // Byte and timer bounds alone cannot stop an immediately resolving
          // zero-byte stream from starving timer tasks in the microtask queue.
          if (++chunkCount > READING_LIMITS.streamChunks) {
            Promise.resolve(reader.cancel()).catch(() => {});
            fail("response_chunk_limit");
          }
          size += value.byteLength;
          if (size > (method === "HEAD" ? 0 : limit)) {
            Promise.resolve(reader.cancel()).catch(() => {});
            fail(method === "HEAD" ? "response_invalid" : "response_limit");
          }
          if (object) {
            hash.update(value);
            const start = size - value.byteLength;
            if (start < prefix.length)
              prefix.set(value.subarray(0, prefix.length - start), start);
          } else chunks.push(Buffer.from(value));
        }
        if (method === "HEAD") return { response };
        if (
          object &&
          (size !== limit ||
            (!range && hash.digest("hex") !== p.descriptor.sha256))
        )
          fail("object_mismatch");
        if (object) return { response, prefix };
        try {
          return {
            response,
            data: JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            ),
          };
        } catch {
          fail("response_invalid");
        }
      })();
      const result = await Promise.race([work, deadline]);
      await journal.write(`${ordinal}-outcome.json`, {
        sequence,
        label,
        status,
        state: "observed",
      });
      return result;
    } catch (error) {
      controller.abort();
      try {
        Promise.resolve(reader?.cancel()).catch(() => {});
      } catch {}
      await journal.write(`${ordinal}-outcome.json`, {
        sequence,
        label,
        status,
        state: status === null || expired ? "unknown" : "rejected",
        code: safeCode(error),
      });
      throw new ReadingError(safeCode(error));
    } finally {
      clearTimeout(timer);
    }
  }
  const accessPath = `${READING_ORIGIN}/api/files/${encodeURIComponent(p.descriptor.fileId)}/access`;
  async function logout(label) {
    logoutAttempted = true;
    logoutUnknown = true;
    const result = await send(label, `${READING_ORIGIN}/api/logout`, {
      method: "POST",
      body: {},
    });
    if (
      !own(result.data, ["authenticated", "csrfToken"]) ||
      result.data.authenticated !== false ||
      result.data.csrfToken !== null
    )
      fail("authentication_invalid");
    logoutUnknown = false;
  }
  try {
    const denied = await send("anonymous-access", accessPath, {
      expected: 401,
      anonymous: true,
    });
    if (denied.data?.error?.code !== "authentication_required")
      fail("authentication_invalid");
    const contentPath = `${READING_ORIGIN}/api/files/${encodeURIComponent(p.descriptor.fileId)}/content`;
    if (localContent(p)) {
      const deniedContent = await send("anonymous-content", contentPath, {
        expected: 401,
        anonymous: true,
      });
      if (deniedContent.data?.error?.code !== "authentication_required")
        fail("authentication_invalid");
    }
    loginUnknown = true;
    const auth = await send("login", `${READING_ORIGIN}/api/login`, {
      method: "POST",
      body: { accessKey: options.accessKey },
    });
    cookie = sessionCookie(auth.response);
    if (
      !own(auth.data, ["authenticated", "csrfToken"]) ||
      auth.data.authenticated !== true ||
      !isCanonicalKey(auth.data.csrfToken)
    )
      fail("authentication_invalid");
    csrf = auth.data.csrfToken;
    loginUnknown = false;
    if (localContent(p)) {
      const deniedCsrf = await send(
        "invalid-csrf-logout",
        `${READING_ORIGIN}/api/logout`,
        { method: "POST", body: {}, expected: 403, negativeCsrf: true },
      );
      if (deniedCsrf.data?.error?.code !== "csrf_invalid")
        fail("authentication_invalid");
    }
    const session = await send(
      "authenticated-session",
      `${READING_ORIGIN}/api/session`,
    );
    if (
      !own(session.data, ["authenticated", "csrfToken"]) ||
      session.data.authenticated !== true ||
      session.data.csrfToken !== csrf
    )
      fail("authentication_invalid");
    const book = await send(
      "catalog-descriptor",
      `${READING_ORIGIN}/api/books/${encodeURIComponent(p.descriptor.bookId)}`,
    );
    const files = book.data?.book?.files;
    if (
      book.data?.book?.id !== p.descriptor.bookId ||
      !Array.isArray(files) ||
      files.filter((f) => f?.id === p.descriptor.fileId).length !== 1 ||
      !files.some(
        (f) =>
          f?.id === p.descriptor.fileId &&
          f.format === p.descriptor.format &&
          f.sizeBytes === p.descriptor.sizeBytes &&
          f.status === "candidate" &&
          f.reason === "uploaded" &&
          f.visibility === "private",
      )
    )
      fail("catalog_mismatch");
    const access = await send("file-access", accessPath),
      url = signatureUrl(access.data, p, now());
    if (localContent(p)) {
      const deniedOrigin = await send("wrong-origin-content", url, {
        expected: 403,
        negativeOrigin: true,
      });
      if (deniedOrigin.data?.error?.code !== "origin_forbidden")
        fail("authentication_invalid");
    }
    if (p.schemaVersion === 2)
      await send("object-head", url, { method: "HEAD", object: true });
    const full = await send("object-full", url, { object: true });
    signatureUrl(access.data, p, now()); // do not dispatch a Range using an expired URL
    const range = await send("object-range", url, {
      object: true,
      range: true,
      expected: 206,
    });
    if (!full.prefix.equals(range.prefix)) fail("range_mismatch");
    if (p.schemaVersion === 2) {
      for (const [label, method, pathname] of [
        ["closed-operator-root", "GET", "/api/single-trial"],
        ["closed-operator-upload", "POST", "/api/single-trial/upload"],
        ["closed-operator-object", "HEAD", "/api/single-trial/object"],
        [
          "closed-operator-unknown",
          "OPTIONS",
          "/api/single-trial/unknown/deep",
        ],
      ]) {
        const closed = await send(label, READING_ORIGIN + pathname, {
          method,
          expected: 404,
          anonymous: true,
          operator: true,
          negativeOrigin: true,
          ...(method === "POST" ? { body: {} } : {}),
        });
        if (
          closed.response.headers.get("cache-control") !== "no-store" ||
          (method !== "HEAD" &&
            (!own(closed.data, ["error"]) ||
              !own(closed.data.error, ["code"]) ||
              closed.data.error.code !== "not_found"))
        )
          fail("response_invalid");
      }
    }
    await logout("logout");
    revocationUnverified = true;
    const anonymous = await send(
      "logged-out-session",
      `${READING_ORIGIN}/api/session`,
    );
    if (
      !own(anonymous.data, ["authenticated", "csrfToken"]) ||
      anonymous.data.authenticated !== false ||
      anonymous.data.csrfToken !== null
    )
      fail("authentication_invalid");
    const revoked = await send("revoked-access", accessPath, { expected: 401 });
    if (revoked.data?.error?.code !== "authentication_required")
      fail("authentication_invalid");
    if (localContent(p)) {
      const revokedContent = await send("revoked-content", contentPath, {
        expected: 401,
      });
      if (revokedContent.data?.error?.code !== "authentication_required")
        fail("authentication_invalid");
    }
    revocationUnverified = false;
    ok = true;
  } catch (error) {
    code = safeCode(error);
  } finally {
    if (!ok && cookie && csrf && !logoutAttempted) {
      try {
        await journal.verify();
        await logout("failure-logout");
      } catch (error) {
        code = safeCode(error);
      }
    }
  }
  const result = {
    schemaVersion: 1,
    ok,
    profile: "production",
    requests: sequence,
    code,
    loginUnknown,
    logoutUnknown,
    generationRevocationRequired:
      loginUnknown ||
      logoutUnknown ||
      revocationUnverified ||
      Boolean(cookie && !logoutAttempted),
    browserVerified: false,
  };
  try {
    await journal.write("result.json", result);
    return result;
  } finally {
    await journal.close();
  }
}
