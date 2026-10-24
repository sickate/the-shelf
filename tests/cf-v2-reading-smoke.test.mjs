import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  runReadingSmoke,
  READING_ORIGIN,
  READING_LIMITS,
} from "../scripts/cf-reading-smoke.mjs";

const KEY = Buffer.alloc(32, 11).toString("base64url"),
  TOKEN = Buffer.alloc(32, 12).toString("base64url"),
  CSRF = Buffer.alloc(32, 13).toString("base64url");
const ACCOUNT = "a".repeat(32),
  ETAG = "fixed-test-etag",
  NOW = Date.UTC(2026, 9, 22, 12, 0, 0, 123);
const BYTES = Buffer.from(
  "Synthetic reading test fixture with enough bytes for Range. No private book.",
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
function plan(source = "trial", format = "PDF") {
  const sha256 = hash(BYTES);
  return {
    schemaVersion: 2,
    storageMode: "authority-v2",
    writeMode: "closed",
    source,
    profile: "production",
    origin: READING_ORIGIN,
    accountId: ACCOUNT,
    bucket:
      source === "trial" ? "the-shelf-first-book-20261023" : "the-shelf-books",
    etag: ETAG,
    descriptor: {
      kind: "original",
      scope: "production",
      fileId: "synthetic-file",
      bookId: "synthetic-book",
      format,
      sizeBytes: BYTES.length,
      sha256,
      objectKey: `books/cf03/synthetic-file/${sha256}.${format.toLowerCase()}`,
      versionHash: null,
      source: null,
    },
  };
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
async function fixture(t, modify = () => {}, source = "trial", format = "PDF") {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-reading-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local/cf03"), {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(path.join(root, ".local"), 0o700);
  const directory = path.join(root, ".local/cf03/reading-smoke-test"),
    p = plan(source, format),
    calls = [];
  const url = `${READING_ORIGIN}/api/files/${p.descriptor.fileId}/content`;
  let loggedIn = false,
    revoked = false;
  const fetchImpl = async (target, options) => {
    const ordinal = calls.length + 1;
    calls.push({ target, options });
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    // The fsynced intent must exist before the transport is entered.
    const intent = JSON.parse(
      await fs.readFile(
        path.join(directory, `${String(ordinal).padStart(2, "0")}-intent.json`),
        "utf8",
      ),
    );
    assert.equal(intent.sequence, ordinal);
    const changed = await modify({
      target,
      options,
      ordinal,
      directory,
      root,
      url,
      plan: p,
    });
    if (changed !== undefined) return changed;
    if (new URL(target).pathname.startsWith("/api/single-trial")) {
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers["X-CSRF-Token"], undefined);
      assert.equal(
        options.headers.Origin,
        "https://shelf-reading-negative.invalid",
      );
      return options.method === "HEAD"
        ? new Response(null, {
            status: 404,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          })
        : json({ error: { code: "not_found" } }, 404, {
            "cache-control": "no-store",
          });
    }
    if (options.headers.Origin === "https://shelf-reading-negative.invalid")
      return json({ error: { code: "origin_forbidden" } }, 403);
    if (target === url && (!loggedIn || revoked))
      return json({ error: { code: "authentication_required" } }, 401);
    if (target === url) {
      assert.equal(target, url);
      assert.equal(options.headers.Cookie, `__Host-shelf_session=${TOKEN}`);
      assert.equal(options.headers.Origin, READING_ORIGIN);
      const range = Boolean(options.headers.Range),
        bytes = range ? BYTES.subarray(0, 32) : BYTES;
      if (range) {
        assert.equal(options.headers.Range, "bytes=0-31");
        assert.equal(options.headers["If-Match"], `"${ETAG}"`);
      }
      return new Response(options.method === "HEAD" ? null : bytes, {
        status: range ? 206 : 200,
        headers: {
          "content-type":
            format === "PDF" ? "application/pdf" : "application/epub+zip",
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
          "content-length": String(bytes.length),
          etag: `"${ETAG}"`,
          ...(range ? { "content-range": `bytes 0-31/${BYTES.length}` } : {}),
        },
      });
    }
    assert.ok(target.startsWith(READING_ORIGIN + "/api/"));
    const pathname = new URL(target).pathname;
    if (options.method === "POST") {
      assert.equal(options.headers.Origin, READING_ORIGIN);
      assert.equal(options.headers["Content-Type"], "application/json");
    }
    if (pathname === "/api/login") {
      assert.deepEqual(JSON.parse(options.body), { accessKey: KEY });
      loggedIn = true;
      return json({ authenticated: true, csrfToken: CSRF }, 200, {
        "set-cookie": `__Host-shelf_session=${TOKEN}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
      });
    }
    if (pathname === "/api/logout") {
      assert.equal(options.headers.Cookie, `__Host-shelf_session=${TOKEN}`);
      if (options.headers["X-CSRF-Token"] === "invalid-trial-csrf")
        return json({ error: { code: "csrf_invalid" } }, 403);
      assert.equal(options.headers["X-CSRF-Token"], CSRF);
      revoked = true;
      return json({ authenticated: false, csrfToken: null });
    }
    if (pathname === "/api/session")
      return json({
        authenticated: loggedIn && !revoked,
        csrfToken: loggedIn && !revoked ? CSRF : null,
      });
    if (pathname.includes("/books/"))
      return json({
        book: {
          id: p.descriptor.bookId,
          title: "PRIVATE_TITLE_SENTINEL",
          files: [
            {
              id: p.descriptor.fileId,
              format,
              sizeBytes: BYTES.length,
              status: "candidate",
              reason: "uploaded",
              visibility: "private",
            },
          ],
        },
        metadataVersion: 0,
      });
    if (pathname.endsWith("/access"))
      return !loggedIn || revoked
        ? json({ error: { code: "authentication_required" } }, 401)
        : json({
            url: new URL(url).pathname,
            format,
            mode: "local",
            expiresAt: null,
          });
    throw new Error("PRIVATE_ERROR_SENTINEL");
  };
  return {
    root,
    directory,
    calls,
    url,
    options: {
      execute: true,
      environment: {},
      plan: p,
      accessKey: KEY,
      receipt: { root, directory },
      fetchImpl,
      now: () => NOW,
    },
  };
}
async function evidence(directory) {
  return (
    await Promise.all(
      (await fs.readdir(directory)).map((f) =>
        fs.readFile(path.join(directory, f), "utf8"),
      ),
    )
  ).join("\n");
}

const headHeaders = (p = plan()) => ({
  "content-type":
    p.descriptor.format === "PDF" ? "application/pdf" : "application/epub+zip",
  "content-length": String(p.descriptor.sizeBytes),
  etag: `"${p.etag}"`,
  "accept-ranges": "bytes",
  "cache-control": "private, no-store",
});

test("v2 preview is zero IO with explicit 19 HTTP / cap20 and no source provenance claim", async () => {
  for (const source of ["normal", "trial"]) {
    const result = await runReadingSmoke({
      plan: plan(source),
      receipt: { root: "/missing", directory: "/missing" },
      fetchImpl: () => assert.fail("preview dispatch"),
      now: () => assert.fail("preview clock"),
      environment: new Proxy(
        {},
        { get: () => assert.fail("preview environment") },
      ),
    });
    assert.deepEqual(result, {
      dryRun: true,
      profile: "production",
      requests: 19,
      requestLimit: 20,
      browserVerified: false,
    });
  }
  assert.equal(READING_LIMITS.v2Requests, 20);
});

for (const source of ["normal", "trial"])
  for (const format of ["PDF", "EPUB"])
    test(`v2 ${source} ${format} reads only same-origin and completes exact 19 HTTP sequence`, async (t) => {
      const f = await fixture(t, () => {}, source, format);
      const result = await runReadingSmoke(f.options);
      assert.deepEqual(result, {
        schemaVersion: 1,
        ok: true,
        profile: "production",
        requests: 19,
        code: null,
        loginUnknown: false,
        logoutUnknown: false,
        generationRevocationRequired: false,
        browserVerified: false,
      });
      const intents = await Promise.all(
        f.calls.map((_, i) =>
          fs
            .readFile(
              path.join(
                f.directory,
                `${String(i + 1).padStart(2, "0")}-intent.json`,
              ),
              "utf8",
            )
            .then(JSON.parse),
        ),
      );
      assert.deepEqual(
        intents.map((x) => x.label),
        [
          "anonymous-access",
          "anonymous-content",
          "login",
          "invalid-csrf-logout",
          "authenticated-session",
          "catalog-descriptor",
          "file-access",
          "wrong-origin-content",
          "object-head",
          "object-full",
          "object-range",
          "closed-operator-root",
          "closed-operator-upload",
          "closed-operator-object",
          "closed-operator-unknown",
          "logout",
          "logged-out-session",
          "revoked-access",
          "revoked-content",
        ],
      );
      assert.ok(intents.every((x) => x.service === "api"));
      assert.deepEqual(
        f.calls.map((c) => c.options.method),
        [
          "GET",
          "GET",
          "POST",
          "POST",
          "GET",
          "GET",
          "GET",
          "GET",
          "HEAD",
          "GET",
          "GET",
          "GET",
          "POST",
          "HEAD",
          "OPTIONS",
          "POST",
          "GET",
          "GET",
          "GET",
        ],
      );
      assert.ok(
        f.calls.every((c) => new URL(c.target).origin === READING_ORIGIN),
      );
      assert.deepEqual(JSON.parse(f.calls[12].options.body), {});
      assert.equal(
        f.calls[8].options.headers.Cookie,
        `__Host-shelf_session=${TOKEN}`,
      );
      const journal = await evidence(f.directory);
      for (const value of [
        KEY,
        TOKEN,
        CSRF,
        ACCOUNT,
        f.url,
        BYTES.toString(),
        "PRIVATE_TITLE_SENTINEL",
        f.options.plan.descriptor.fileId,
        f.options.plan.descriptor.sha256,
      ])
        assert.equal(journal.includes(value), false, value);
      assert.equal(
        JSON.parse(await fs.readFile(path.join(f.directory, "run-start.json")))
          .requestLimit,
        20,
      );
      assert.ok(
        (await fs.readdir(f.directory)).every(
          (name) => !name.includes("source"),
        ),
      );
      for (const name of await fs.readdir(f.directory))
        assert.equal(
          (await fs.stat(path.join(f.directory, name))).mode & 0o777,
          0o600,
        );
      await assert.rejects(runReadingSmoke(f.options), {
        code: "private_evidence_failed",
      });
      assert.equal(f.calls.length, 19);
    });

test("v2 plan rejects mixed modes, unknown fields, wrong source-target and descriptors before IO", async () => {
  for (const mutate of [
    (p) => {
      delete p.source;
    },
    (p) => {
      delete p.storageMode;
    },
    (p) => {
      delete p.writeMode;
    },
    (p) => {
      p.schemaVersion = 3;
    },
    (p) => {
      p.schemaVersion = 1;
    },
    (p) => {
      p.mode = "first-book-20261023";
    },
    (p) => {
      p.extra = true;
    },
    (p) => {
      p.storageMode = "authority-v1";
    },
    (p) => {
      p.writeMode = "open";
    },
    (p) => {
      p.source = "other";
    },
    (p) => {
      p.source = "normal";
    },
    (p) => {
      p.bucket = "the-shelf-books";
    },
    (p) => {
      p.bucket += "-other";
    },
    (p) => {
      p.origin += ".evil";
    },
    (p) => {
      p.profile = "check";
    },
    (p) => {
      p.accountId = "b".repeat(31);
    },
    (p) => {
      p.etag = "";
    },
    (p) => {
      p.descriptor.format = "MOBI";
    },
    (p) => {
      p.descriptor.sizeBytes = 20000001;
    },
    (p) => {
      p.descriptor.objectKey = "books/other.pdf";
    },
    (p) => {
      p.descriptor.source = "trial";
    },
  ]) {
    const p = plan();
    mutate(p);
    await assert.rejects(
      runReadingSmoke({
        plan: p,
        fetchImpl: () => assert.fail("invalid plan dispatch"),
      }),
      { code: "invalid_plan" },
    );
  }
  for (const key of [
    "source",
    "storageMode",
    "writeMode",
    "bucket",
    "accountId",
  ]) {
    const p = plan();
    p[key] = { toString: () => assert.fail("coercion") };
    await assert.rejects(runReadingSmoke({ plan: p }), {
      code: "invalid_plan",
    });
  }
});

for (const [kind, code] of [
  ["missing-length", "response_limit"],
  ["wrong-length", "response_limit"],
  ["malformed-length", "response_limit"],
  ["mime", "object_mismatch"],
  ["etag", "object_mismatch"],
  ["ranges", "object_mismatch"],
  ["content-range", "object_mismatch"],
  ["encoding", "object_mismatch"],
  ["cache", "object_mismatch"],
  ["body", "response_invalid"],
  ["status", "http_rejected"],
])
  test(`v2 HEAD rejects ${kind} before full GET and cleans up once`, async (t) => {
    const f = await fixture(t, ({ ordinal, plan: p }) => {
      if (ordinal !== 9) return;
      const h = headHeaders(p);
      if (kind === "missing-length") delete h["content-length"];
      if (kind === "wrong-length") h["content-length"] = "0";
      if (kind === "malformed-length") h["content-length"] = "abc";
      if (kind === "mime") h["content-type"] = "text/html";
      if (kind === "etag") h.etag = '"other"';
      if (kind === "ranges") delete h["accept-ranges"];
      if (kind === "content-range")
        h["content-range"] = `bytes 0-31/${BYTES.length}`;
      if (kind === "encoding") h["content-encoding"] = "gzip";
      if (kind === "cache") h["cache-control"] = "public";
      return new Response(kind === "body" ? "unexpected" : null, {
        status: kind === "status" ? 206 : 200,
        headers: h,
      });
    });
    const result = await runReadingSmoke(f.options);
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assert.equal(result.requests, 10);
    assert.equal(result.generationRevocationRequired, false);
    assert.ok(f.calls.at(-1).target.endsWith("/logout"));
    assert.equal(
      f.calls.filter(
        (c) =>
          c.target === f.url &&
          c.options.method === "GET" &&
          !c.options.headers.Range &&
          c.options.headers.Origin === READING_ORIGIN,
      ).length,
      0,
      "no full body dispatch after failed HEAD",
    );
  });

test("v2 HEAD accepts empty stream but bounds empty chunk flood and stalled body", async (t) => {
  for (const kind of ["empty", "flood", "stall"]) {
    let canceled = false;
    const f = await fixture(t, ({ ordinal, plan: p }) => {
      if (ordinal !== 9) return;
      return new Response(
        new ReadableStream({
          start(c) {
            if (kind === "empty") c.close();
          },
          pull(c) {
            if (kind === "flood") c.enqueue(new Uint8Array(0));
          },
          cancel() {
            canceled = true;
            return new Promise(() => {});
          },
        }),
        { headers: headHeaders(p) },
      );
    });
    const r = await runReadingSmoke({ ...f.options, timeoutMs: 30 });
    assert.equal(r.ok, kind === "empty", r.code);
    if (kind !== "empty") {
      assert.equal(
        r.code,
        kind === "flood" ? "response_chunk_limit" : "deadline_exceeded",
      );
      assert.equal(canceled, true);
      assert.equal(r.requests, 10);
    }
  }
});

for (const kind of ["status", "code", "extra", "cache", "head-body"])
  test(`v2 operator ${kind} rejects with one cleanup and no upload bytes`, async (t) => {
    const ordinal = kind === "head-body" ? 14 : 12;
    const f = await fixture(t, ({ ordinal: current }) => {
      if (current !== ordinal) return;
      if (kind === "head-body")
        return new Response("unexpected", {
          status: 404,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      return json(
        kind === "extra"
          ? { error: { code: "not_found" }, extra: true }
          : {
              error: {
                code: kind === "code" ? "authentication_required" : "not_found",
              },
            },
        kind === "status" ? 401 : 404,
        { "cache-control": kind === "cache" ? "public" : "no-store" },
      );
    });
    const r = await runReadingSmoke(f.options);
    assert.equal(r.ok, false);
    assert.equal(
      r.code,
      kind === "status" ? "http_rejected" : "response_invalid",
    );
    assert.equal(r.requests, ordinal + 1);
    assert.ok(f.calls.at(-1).target.endsWith("/logout"));
    assert.ok(f.calls.every((c) => c.options.method !== "PUT"));
    assert.ok(
      f.calls
        .filter((c) => c.target.includes("/single-trial"))
        .every(
          (c) =>
            c.options.headers.Cookie === undefined &&
            c.options.headers["X-CSRF-Token"] === undefined,
        ),
    );
  });

test("v2 access rejects signed, absolute, wrong-file and extra-field responses before object HEAD", async (t) => {
  for (const mutate of [
    (a) => {
      a.url = READING_ORIGIN + a.url;
    },
    (a) => {
      a.url = "https://evil.invalid/content";
    },
    (a) => {
      a.url += "?x=1";
    },
    (a) => {
      a.url = "/api/files/other/content";
    },
    (a) => {
      a.mode = "r2";
    },
    (a) => {
      a.expiresAt = "2026-10-24";
    },
    (a) => {
      a.extra = true;
    },
  ]) {
    const f = await fixture(t, ({ ordinal, url }) => {
      if (ordinal !== 7) return;
      const a = {
        url: new URL(url).pathname,
        mode: "local",
        format: "PDF",
        expiresAt: null,
      };
      mutate(a);
      return json(a);
    });
    const r = await runReadingSmoke(f.options);
    assert.equal(r.code, "signature_invalid");
    assert.equal(r.requests, 8);
    assert.ok(
      f.calls.every((c) => new URL(c.target).origin === READING_ORIGIN),
    );
    assert.ok(f.calls.every((c) => c.options.method !== "HEAD"));
  }
});

for (const kind of ["throw", "hang", "malformed"])
  test(`v2 unknown logout ${kind} stops at16 without replay or revocation probes`, async (t) => {
    let late;
    const f = await fixture(t, ({ ordinal }) => {
      if (ordinal !== 16) return;
      if (kind === "throw") throw Error("PRIVATE_ERROR_SENTINEL");
      if (kind === "malformed")
        return json({ authenticated: true, csrfToken: CSRF });
      return new Promise((resolve) => {
        late = resolve;
      });
    });
    const r = await runReadingSmoke({ ...f.options, timeoutMs: 20 });
    assert.equal(r.ok, false);
    assert.equal(r.logoutUnknown, true);
    assert.equal(r.generationRevocationRequired, true);
    assert.equal(r.requests, 16);
    assert.equal(
      f.calls.filter((c) => c.target.endsWith("/logout")).length,
      2,
      "one negative CSRF probe plus exactly one actual logout",
    );
    if (late) {
      let canceled = false;
      late(
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(canceled, true);
      assert.equal(f.calls.length, 16);
    }
    assert.equal(
      (await evidence(f.directory)).includes("PRIVATE_ERROR_SENTINEL"),
      false,
    );
  });

test("v2 unknown login never accepts late cookie or dispatches cleanup", async (t) => {
  let late;
  const f = await fixture(t, ({ ordinal }) =>
    ordinal === 3
      ? new Promise((resolve) => {
          late = resolve;
        })
      : undefined,
  );
  const r = await runReadingSmoke({ ...f.options, timeoutMs: 20 });
  assert.equal(r.loginUnknown, true);
  assert.equal(r.generationRevocationRequired, true);
  assert.equal(r.requests, 3);
  let canceled = false;
  late(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: {
          "set-cookie": `__Host-shelf_session=${TOKEN}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`,
        },
      },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(canceled, true);
  assert.equal(f.calls.length, 3);
});

for (const ordinal of [17, 18, 19])
  test(`v2 revocation failure at${ordinal} requires generation revocation and never repeats logout`, async (t) => {
    const f = await fixture(t, ({ ordinal: current }) =>
      current === ordinal
        ? json({ authenticated: true, csrfToken: CSRF })
        : undefined,
    );
    const r = await runReadingSmoke(f.options);
    assert.equal(r.ok, false);
    assert.equal(r.requests, ordinal);
    assert.equal(r.generationRevocationRequired, true);
    assert.equal(f.calls.filter((c) => c.target.endsWith("/logout")).length, 2);
  });

test("v2 journal replacement blocks all subsequent dispatch including failure logout", async (t) => {
  const f = await fixture(t, async ({ ordinal, directory }) => {
    if (ordinal !== 9) return;
    await fs.rename(directory, directory + "-old");
    await fs.mkdir(directory, { mode: 0o700 });
  });
  await assert.rejects(runReadingSmoke(f.options), {
    code: "private_evidence_failed",
  });
  assert.equal(f.calls.length, 9);
});
