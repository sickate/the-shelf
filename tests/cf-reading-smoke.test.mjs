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
import { presignGet } from "../cloudflare/library/core.mjs";

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
function plan() {
  const sha256 = hash(BYTES);
  return {
    schemaVersion: 1,
    profile: "production",
    origin: READING_ORIGIN,
    accountId: ACCOUNT,
    bucket: "the-shelf-books",
    etag: ETAG,
    descriptor: {
      kind: "original",
      scope: "production",
      fileId: "synthetic-file",
      bookId: "synthetic-book",
      format: "PDF",
      sizeBytes: BYTES.length,
      sha256,
      objectKey: `books/cf03/synthetic-file/${sha256}.pdf`,
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
async function fixture(t, modify = () => {}, trial = false) {
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
    p = plan(),
    calls = [];
  if (trial) {
    p.mode = "first-book-20261023";
    p.bucket = "the-shelf-first-book-20261023";
  }
  const url = trial
    ? `${READING_ORIGIN}/api/files/${p.descriptor.fileId}/content`
    : await presignGet(
        {
          APP_SCOPE: "production",
          R2_ACCOUNT_ID: ACCOUNT,
          R2_BUCKET: p.bucket,
          R2_ACCESS_KEY_ID: "synthetic-access-key",
          R2_SECRET_ACCESS_KEY: "synthetic-secret-do-not-record",
        },
        p.descriptor.objectKey,
        "PDF",
        new Date(NOW),
      );
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
    if (
      trial &&
      options.headers.Origin === "https://shelf-reading-negative.invalid"
    )
      return json({ error: { code: "origin_forbidden" } }, 403);
    if (trial && target === url && (!loggedIn || revoked))
      return json({ error: { code: "authentication_required" } }, 401);
    if (
      target.startsWith(`https://${ACCOUNT}.r2.cloudflarestorage.com/`) ||
      (trial && target === url)
    ) {
      assert.equal(target, url);
      assert.equal(
        options.headers.Cookie,
        trial ? `__Host-shelf_session=${TOKEN}` : undefined,
      );
      assert.equal(options.headers.Origin, READING_ORIGIN);
      const range = Boolean(options.headers.Range),
        bytes = range ? BYTES.subarray(0, 32) : BYTES;
      if (range) {
        assert.equal(options.headers.Range, "bytes=0-31");
        assert.equal(options.headers["If-Match"], `"${ETAG}"`);
      }
      return new Response(bytes, {
        status: range ? 206 : 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(bytes.length),
          "access-control-allow-origin": READING_ORIGIN,
          "access-control-expose-headers":
            "Accept-Ranges,Content-Range,Content-Length,ETag",
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
      if (trial && options.headers["X-CSRF-Token"] === "invalid-trial-csrf")
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
              format: "PDF",
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
            url: trial ? new URL(url).pathname : url,
            format: "PDF",
            mode: trial ? "local" : "r2",
            expiresAt: trial ? null : new Date(NOW + 300000).toISOString(),
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

test("preview is zero IO and rejects unsupported targets/descriptors before execute", async () => {
  let calls = 0;
  assert.equal(
    (
      await runReadingSmoke({
        plan: plan(),
        fetchImpl: () => calls++,
        receipt: { root: "/missing", directory: "/missing" },
      })
    ).dryRun,
    true,
  );
  assert.equal(calls, 0);
  for (const change of [
    (p) => (p.profile = "check"),
    (p) => (p.origin += ".evil"),
    (p) => (p.bucket = "other"),
    (p) => (p.descriptor.sizeBytes = 20_000_001),
    (p) => (p.descriptor.objectKey = "books/other.pdf"),
    (p) => (p.descriptor.format = "MOBI"),
    (p) => (p.extra = true),
  ]) {
    const p = plan();
    change(p);
    await assert.rejects(runReadingSmoke({ plan: p }), {
      code: "invalid_plan",
    });
  }
});

test("production single-file chain validates current catalog, object SHA/size/MIME/ETag and first32 Range then revocation", async (t) => {
  const f = await fixture(t),
    result = await runReadingSmoke(f.options);
  assert.deepEqual(result, {
    schemaVersion: 1,
    ok: true,
    profile: "production",
    requests: 10,
    code: null,
    loginUnknown: false,
    logoutUnknown: false,
    generationRevocationRequired: false,
    browserVerified: false,
  });
  const text = await evidence(f.directory);
  for (const secret of [
    KEY,
    TOKEN,
    CSRF,
    f.url,
    ACCOUNT,
    "PRIVATE_TITLE_SENTINEL",
    BYTES.toString(),
    f.options.plan.descriptor.fileId,
    f.options.plan.descriptor.sha256,
  ])
    assert.ok(!text.includes(secret), secret);
  for (const name of await fs.readdir(f.directory))
    assert.equal(
      (await fs.lstat(path.join(f.directory, name))).mode & 0o777,
      0o600,
    );
  const count = f.calls.length;
  await assert.rejects(runReadingSmoke(f.options), {
    code: "private_evidence_failed",
  });
  assert.equal(f.calls.length, count);
});
test("trial reading smoke verifies Origin and CSRF denial, surviving session, full+Range and revoked content", async (t) => {
  const f = await fixture(t, () => {}, true),
    result = await runReadingSmoke(f.options);
  assert.equal(result.ok, true, result.code);
  assert.equal(result.requests, 14);
  assert.equal(f.calls.filter((c) => c.target.endsWith("/content")).length, 5);
  assert.equal(f.calls.filter((c) => c.target.endsWith("/logout")).length, 2);
  const labels = await Promise.all(
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
  assert.equal(labels[3].label, "invalid-csrf-logout");
  assert.equal(labels[4].label, "authenticated-session");
  assert.equal(labels[7].label, "wrong-origin-content");
  assert.equal(labels[8].label, "object-full");
  assert.ok(f.calls.every((c) => new URL(c.target).origin === READING_ORIGIN));
});
test("trial negative probes require fixed error codes and do not report a false success", async (t) => {
  for (const code of ["csrf", "origin"]) {
    const f = await fixture(
      t,
      ({ options }) => {
        if (
          code === "csrf" &&
          options.headers["X-CSRF-Token"] === "invalid-trial-csrf"
        )
          return json({ error: { code: "origin_forbidden" } }, 403);
        if (
          code === "origin" &&
          options.headers.Origin === "https://shelf-reading-negative.invalid"
        )
          return json({ error: { code: "csrf_invalid" } }, 403);
      },
      true,
    );
    const result = await runReadingSmoke(f.options);
    assert.equal(result.ok, false);
    assert.equal(result.code, "authentication_invalid");
    assert.equal(f.calls.at(-1).target, READING_ORIGIN + "/api/logout");
  }
});

test("bad/unknown signature target and query fail before any R2 request and get one cleanup logout", async (t) => {
  for (const mutate of [
    (u) => (u.hostname = "evil.invalid"),
    (u) => (u.pathname += "/extra"),
    (u) => u.searchParams.set("X-Amz-Expires", "301"),
    (u) => u.searchParams.append("X-Amz-Signature", "a".repeat(64)),
    (u) => u.searchParams.set("extra", KEY),
    (u) => u.searchParams.set("X-Amz-SignedHeaders", "host;cookie"),
    (u) => u.searchParams.set("X-Amz-Credential", "wrong"),
    (u) => (u.username = "owner"),
  ]) {
    await t.test(mutate.toString(), async (t) => {
      const f = await fixture(t, ({ ordinal, url }) => {
        if (ordinal === 5) {
          const u = new URL(url);
          mutate(u);
          return json({
            url: u.href,
            format: "PDF",
            mode: "r2",
            expiresAt: new Date(NOW + 300000).toISOString(),
          });
        }
      });
      const r = await runReadingSmoke(f.options);
      assert.equal(r.code, "signature_invalid");
      assert.equal(r.ok, false);
      assert.equal(r.requests, 6);
      assert.equal(f.calls.at(-1).target, READING_ORIGIN + "/api/logout");
      assert.equal(r.generationRevocationRequired, false);
    });
  }
});

test("catalog mismatch is rejected before signing even with caller's valid local descriptor", async (t) => {
  const f = await fixture(t, ({ ordinal }) =>
    ordinal === 4
      ? json({
          book: {
            id: "synthetic-book",
            files: [
              {
                id: "synthetic-file",
                format: "PDF",
                sizeBytes: BYTES.length,
                status: "candidate",
                reason: "not_uploaded",
                visibility: "private",
              },
            ],
          },
        })
      : undefined,
  );
  const r = await runReadingSmoke(f.options);
  assert.equal(r.code, "catalog_mismatch");
  assert.equal(r.requests, 5);
  assert.equal(f.calls.at(-1).target, READING_ORIGIN + "/api/logout");
});

test("bad full hash/MIME/ETag/oversize and wrong Range fail without retries", async (t) => {
  for (const kind of [
    "hash",
    "mime",
    "etag",
    "oversize",
    "range-status",
    "range-header",
    "range-bytes",
  ]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t, ({ ordinal }) => {
        if (ordinal !== (kind.startsWith("range") ? 7 : 6)) return;
        const range = kind.startsWith("range"),
          bytes = range ? Buffer.alloc(32, 1) : Buffer.from(BYTES);
        if (kind === "hash") bytes[1] ^= 1;
        return new Response(
          kind === "oversize" ? Buffer.alloc(BYTES.length + 1) : bytes,
          {
            status: range && kind !== "range-status" ? 206 : 200,
            headers: {
              "content-type": kind === "mime" ? "text/html" : "application/pdf",
              etag: kind === "etag" ? "wrong" : ETAG,
              "access-control-allow-origin": READING_ORIGIN,
              "access-control-expose-headers":
                "Accept-Ranges,Content-Range,Content-Length,ETag",
              ...(range
                ? {
                    "content-range":
                      kind === "range-header"
                        ? "bytes 1-32/999"
                        : `bytes 0-31/${BYTES.length}`,
                  }
                : {}),
            },
          },
        );
      });
      const r = await runReadingSmoke(f.options);
      assert.equal(r.ok, false);
      assert.equal(r.requests, kind.startsWith("range") ? 8 : 7);
      assert.equal(
        r.code,
        kind === "oversize"
          ? "response_limit"
          : kind === "range-status"
            ? "http_rejected"
            : kind.startsWith("range")
              ? "range_mismatch"
              : "object_mismatch",
      );
      assert.equal(f.calls.at(-1).target, READING_ORIGIN + "/api/logout");
      assert.equal(r.generationRevocationRequired, false);
    });
  }
});

test("unknown login is never retried or cleaned with a late cookie and requires independent generation revocation", async (t) => {
  let late;
  const f = await fixture(t, ({ ordinal }) =>
    ordinal === 2
      ? new Promise((resolve) => {
          late = resolve;
        })
      : undefined,
  );
  const result = await runReadingSmoke({ ...f.options, timeoutMs: 20 });
  assert.equal(result.code, "deadline_exceeded");
  assert.equal(result.loginUnknown, true);
  assert.equal(result.generationRevocationRequired, true);
  assert.equal(result.requests, 2);
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
  assert.equal(f.calls.length, 2);
});

test("unknown logout is not repeated and stale-cookie final access is not falsely reported passed", async (t) => {
  const f = await fixture(t, ({ ordinal }) => {
    if (ordinal === 8) throw new Error("PRIVATE_ERROR_SENTINEL");
  });
  const r = await runReadingSmoke(f.options);
  assert.equal(r.logoutUnknown, true);
  assert.equal(r.generationRevocationRequired, true);
  assert.equal(r.requests, 8);
  assert.equal(f.calls.filter((c) => c.target.endsWith("/logout")).length, 1);
  assert.ok(!(await evidence(f.directory)).includes("PRIVATE_ERROR_SENTINEL"));
});

test("stalled object body times out, cancels and performs one separately journaled logout", async (t) => {
  let canceled = false;
  const f = await fixture(t, ({ ordinal }) =>
    ordinal === 6
      ? new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(BYTES.subarray(0, 3));
            },
            cancel() {
              canceled = true;
              return new Promise(() => {});
            },
          }),
          {
            headers: {
              "content-type": "application/pdf",
              etag: ETAG,
              "access-control-allow-origin": READING_ORIGIN,
              "access-control-expose-headers":
                "Accept-Ranges,Content-Range,Content-Length,ETag",
            },
          },
        )
      : undefined,
  );
  const r = await runReadingSmoke({ ...f.options, timeoutMs: 30 });
  assert.equal(r.code, "deadline_exceeded");
  assert.equal(canceled, true);
  assert.equal(r.requests, 7);
  assert.equal(r.generationRevocationRequired, false);
});

test("evidence parent replacement or new hardlink stops all further dispatch including cleanup", async (t) => {
  for (const mode of ["parent", "hardlink", "symlink"])
    await t.test(mode, async (t) => {
      const f = await fixture(t, async ({ ordinal, directory }) => {
        if (ordinal === 4) {
          if (mode === "parent") {
            await fs.rename(directory, directory + "-old");
            await fs.mkdir(directory, { mode: 0o700 });
          }
          if (mode === "hardlink")
            await fs.link(
              path.join(directory, "run-start.json"),
              path.join(directory, "evil-link"),
            );
          if (mode === "symlink") {
            await fs.rename(
              path.join(directory, "run-start.json"),
              path.join(directory, "start-old"),
            );
            await fs.symlink(
              path.join(directory, "start-old"),
              path.join(directory, "run-start.json"),
            );
          }
        }
      });
      await assert.rejects(runReadingSmoke(f.options), {
        code: "private_evidence_failed",
      });
      assert.equal(f.calls.length, 4);
    });
});

test("simultaneous identical receipt admits a single run and private-path symlinks fail before network", async (t) => {
  const f = await fixture(t);
  const r = await Promise.allSettled([
    runReadingSmoke(f.options),
    runReadingSmoke(f.options),
  ]);
  assert.equal(
    r.filter((x) => x.status === "fulfilled" && x.value.ok).length,
    1,
  );
  assert.equal(
    r.filter(
      (x) =>
        x.status === "rejected" && x.reason.code === "private_evidence_failed",
    ).length,
    1,
  );
  assert.equal(f.calls.length, 10);
  const other = await fixture(t);
  await fs.rename(
    path.join(other.root, ".local/cf03"),
    path.join(other.root, ".local/original"),
  );
  await fs.symlink(
    path.join(other.root, ".local/original"),
    path.join(other.root, ".local/cf03"),
  );
  await assert.rejects(runReadingSmoke(other.options), {
    code: "private_evidence_failed",
  });
  assert.equal(other.calls.length, 0);
});

test("CORS rejects wildcard origin, credentials or missing exposed headers before Range", async (t) => {
  for (const kind of ["origin", "credentials", "exposure"])
    await t.test(kind, async (t) => {
      const f = await fixture(t, ({ ordinal }) =>
        ordinal === 6
          ? new Response(BYTES, {
              headers: {
                "content-type": "application/pdf",
                etag: ETAG,
                "access-control-allow-origin":
                  kind === "origin" ? "*" : READING_ORIGIN,
                "access-control-expose-headers":
                  kind === "exposure"
                    ? "ETag"
                    : "ETag,Content-Range,Content-Length,Accept-Ranges",
                ...(kind === "credentials"
                  ? { "access-control-allow-credentials": "true" }
                  : {}),
              },
            })
          : undefined,
      );
      const r = await runReadingSmoke(f.options);
      assert.equal(r.code, "response_invalid");
      assert.equal(r.requests, 7);
      assert.equal(f.calls.at(-1).target, READING_ORIGIN + "/api/logout");
    });
});

test("invalid login cookie and oversized JSON never gain a usable session", async (t) => {
  for (const kind of ["cookie", "json-limit"])
    await t.test(kind, async (t) => {
      const f = await fixture(t, ({ ordinal }) =>
        ordinal === 2
          ? kind === "cookie"
            ? json({ authenticated: true, csrfToken: CSRF }, 200, {
                "set-cookie": `__Host-shelf_session=${TOKEN}; Path=/`,
              })
            : json({ secret: "x".repeat(70_000) })
          : undefined,
      );
      const r = await runReadingSmoke(f.options);
      assert.equal(r.ok, false);
      assert.equal(r.requests, 2);
      assert.equal(r.generationRevocationRequired, true);
      assert.equal(
        f.calls.filter((c) => c.target.endsWith("/logout")).length,
        0,
      );
    });
});

test("successful logout response cannot hide failed old-cookie revocation verification", async (t) => {
  const f = await fixture(t, ({ ordinal }) =>
    ordinal === 9 ? json({ authenticated: true, csrfToken: CSRF }) : undefined,
  );
  const r = await runReadingSmoke(f.options);
  assert.equal(r.ok, false);
  assert.equal(r.code, "authentication_invalid");
  assert.equal(r.requests, 9);
  assert.equal(r.generationRevocationRequired, true);
  assert.equal(f.calls.filter((c) => c.target.endsWith("/logout")).length, 1);
});

test("plan string identities reject coercible objects before invoking their conversion", async () => {
  for (const field of ["accountId", "profile", "origin", "bucket", "etag"]) {
    const p = plan();
    let converted = false;
    const original = p[field];
    p[field] = {
      toString() {
        converted = true;
        return original;
      },
    };
    await assert.rejects(runReadingSmoke({ plan: p }), {
      code: "invalid_plan",
    });
    assert.equal(converted, false);
  }
});

test("immediate zero-byte chunk floods stop by a hard chunk bound without relying on timers", async (t) => {
  for (const kind of ["json", "object"])
    await t.test(kind, async (t) => {
      let produced = 0,
        canceled = false;
      const ordinal = kind === "json" ? 1 : 6;
      const f = await fixture(t, ({ ordinal: current }) =>
        current === ordinal
          ? new Response(
              new ReadableStream({
                pull(controller) {
                  produced++;
                  controller.enqueue(new Uint8Array(0));
                },
                cancel() {
                  canceled = true;
                  return new Promise(() => {});
                },
              }),
              {
                headers:
                  kind === "json"
                    ? { "content-type": "application/json" }
                    : {
                        "content-type": "application/pdf",
                        etag: ETAG,
                        "access-control-allow-origin": READING_ORIGIN,
                        "access-control-expose-headers":
                          "Accept-Ranges,Content-Range,Content-Length,ETag",
                      },
                status: kind === "json" ? 401 : 200,
              },
            )
          : undefined,
      );
      const r = await runReadingSmoke(f.options);
      assert.equal(r.ok, false);
      assert.equal(r.code, "response_chunk_limit");
      assert.equal(canceled, true);
      assert.ok(produced > READING_LIMITS.streamChunks);
      assert.ok(produced <= READING_LIMITS.streamChunks + 2);
      assert.equal(r.requests, kind === "json" ? 1 : 7);
      assert.equal(r.generationRevocationRequired, false);
      assert.equal(
        f.calls.filter((c) => c.target.endsWith("/logout")).length,
        kind === "json" ? 0 : 1,
      );
      const persisted = JSON.parse(
        await fs.readFile(
          path.join(
            f.directory,
            `${String(ordinal).padStart(2, "0")}-outcome.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(persisted.code, "response_chunk_limit");
    });
});
