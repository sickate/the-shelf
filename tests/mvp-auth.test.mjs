import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { checkGoogleClaims, safeNext } from "../app/worker.mjs";
import { ORIGIN, googleCookie, setup } from "./helpers/mvp-fixture.mjs";

// Google sign-in (G1), owner API token and session-format transition.
const SECRET = "s".repeat(32);
const CLIENT_ID = "client-123.apps.googleusercontent.com";
const OWNER = "owner@example.com";
const TOKEN = "t".repeat(40);
const CONFIG = {
  SESSION_SECRET: SECRET,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "client-secret-value",
  OWNER_EMAILS: ` Other@Example.com , ${OWNER.toUpperCase()} `,
  OWNER_API_TOKEN: TOKEN,
};
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.${b64("sig")}`;
const cookieOf = (res, name) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`));

async function authSetup(t, secrets = CONFIG) {
  const ctx = await setup(t, secrets);
  const calls = [];
  let tokenReply = () => Response.json({ id_token: jwt(ctx.claims) });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    return tokenReply();
  });
  ctx.calls = calls;
  ctx.setTokenReply = (fn) => (tokenReply = fn);
  ctx.start = async (next) => {
    const res = await ctx.fetch(`/api/auth/google${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("Location"));
    const state = cookieOf(res, "shelf_oauth");
    ctx.claims = {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: loc.searchParams.get("nonce"),
      email: OWNER,
      email_verified: true,
    };
    return { res, loc, state };
  };
  ctx.callback = (query, cookie) =>
    ctx.fetch(`/api/auth/google/callback?${new URLSearchParams(query)}`, cookie ? { headers: { Cookie: cookie } } : {});
  return ctx;
}

const loginError = (res) => {
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("Location"));
  assert.equal(loc.origin, ORIGIN);
  assert.equal(loc.pathname, "/");
  // The state cookie is always cleared, and no session is issued.
  assert.match(res.headers.getSetCookie().join("\n"), /shelf_oauth=; Max-Age=0;.*Path=\/api\/auth\/google/);
  assert.equal(cookieOf(res, "shelf_session"), undefined);
  return loc.searchParams.get("login_error");
};

test("google start: redirect parameters and signed state cookie", async (t) => {
  const { start } = await authSetup(t);
  const { res, loc } = await start("/read.html?id=b_1");
  assert.equal(`${loc.origin}${loc.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = loc.searchParams;
  assert.equal(p.get("client_id"), CLIENT_ID);
  assert.equal(p.get("redirect_uri"), `${ORIGIN}/api/auth/google/callback`);
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("scope"), "openid email");
  assert.equal(p.get("prompt"), "select_account");
  assert.equal(p.get("code_challenge_method"), "S256");
  for (const k of ["state", "nonce", "code_challenge"]) assert.match(p.get(k), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(p.get("state"), p.get("nonce"));
  assert.equal(p.get("client_secret"), null);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("shelf_oauth="));
  assert.match(raw, /; Max-Age=600; HttpOnly; Secure; SameSite=Lax; Path=\/api\/auth\/google$/);
  // The verifier lives only in the signed cookie and matches the S256 challenge.
  const payload = JSON.parse(Buffer.from(raw.split("=")[1].split(".")[0], "base64url"));
  assert.equal(payload.s, p.get("state"));
  assert.equal(payload.r, "/read.html?id=b_1");
  assert.equal(createHash("sha256").update(payload.v).digest("base64url"), p.get("code_challenge"));
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("google start honours GOOGLE_REDIRECT_URI", async (t) => {
  const { start } = await authSetup(t, { ...CONFIG, GOOGLE_REDIRECT_URI: "https://x.test/api/auth/google/callback" });
  const { loc } = await start();
  assert.equal(loc.searchParams.get("redirect_uri"), "https://x.test/api/auth/google/callback");
});

test("google not configured", async (t) => {
  for (const missing of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "OWNER_EMAILS", "SESSION_SECRET"]) {
    const { fetch, callback } = await authSetup(t, { ...CONFIG, [missing]: missing === "OWNER_EMAILS" ? " , " : "" });
    const res = await fetch("/api/auth/google");
    assert.equal(res.status, 503, missing);
    assert.deepEqual(await res.json(), { error: "not_configured" });
    assert.equal(loginError(await callback({ state: "x", code: "y" })), "not_configured");
  }
});

test("google callback: successful login sets session and redirects to safe next", async (t) => {
  const { fetch, start, callback, calls } = await authSetup(t);
  const { loc, state } = await start("/book.html?id=b_1#x");
  const res = await callback({ state: loc.searchParams.get("state"), code: "auth-code" }, state);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), `${ORIGIN}/book.html?id=b_1#x`);
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  const all = res.headers.getSetCookie();
  assert.ok(all.some((c) => /^shelf_oauth=; Max-Age=0;/.test(c)));
  const raw = all.find((c) => c.startsWith("shelf_session="));
  assert.match(raw, /^shelf_session=\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Path=\/$/);
  const session = raw.split(";")[0];
  assert.deepEqual(await (await fetch("/api/me", { headers: { Cookie: session } })).json(), { owner: true, email: OWNER });
  assert.equal((await fetch("/api/budget", { headers: { Cookie: session } })).status, 200);
  // Token request: one POST with the PKCE verifier and no redirect following.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get("code"), "auth-code");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_id"), CLIENT_ID);
  assert.equal(form.get("client_secret"), "client-secret-value");
  assert.equal(form.get("redirect_uri"), `${ORIGIN}/api/auth/google/callback`);
  const payload = JSON.parse(Buffer.from(state.split("=")[1].split(".")[0], "base64url"));
  assert.equal(form.get("code_verifier"), payload.v);

  // Tampered e-mail in the cookie breaks the signature.
  const [exp, , sig] = session.split("=")[1].split(".");
  const forged = `shelf_session=${exp}.${b64("other@example.com")}.${sig}`;
  assert.deepEqual(await (await fetch("/api/me", { headers: { Cookie: forged } })).json(), { owner: false });
});

test("google session is revoked when its e-mail leaves OWNER_EMAILS", async (t) => {
  const ctx = await authSetup(t);
  const { loc, state } = await ctx.start();
  const res = await ctx.callback({ state: loc.searchParams.get("state"), code: "c" }, state);
  const session = cookieOf(res, "shelf_session");
  const other = await setup(t, { ...CONFIG, OWNER_EMAILS: "other@example.com" });
  assert.deepEqual(await (await other.fetch("/api/me", { headers: { Cookie: session } })).json(), { owner: false });
});

test("google callback: open redirect attempts fall back to /", async (t) => {
  for (const next of ["//evil.test/x", "https://evil.test/", "/\\evil.test", "evil", "/a b", "javascript:alert(1)"]) {
    const { start, callback } = await authSetup(t);
    const { loc, state } = await start(next);
    const res = await callback({ state: loc.searchParams.get("state"), code: "c" }, state);
    assert.equal(res.headers.get("Location"), `${ORIGIN}/`, next);
    assert.ok(cookieOf(res, "shelf_session"));
  }
  assert.equal(safeNext("/notes.html?book=b_1"), "/notes.html?book=b_1");
  assert.equal(safeNext(null), "/");
  assert.equal(safeNext("/" + "a".repeat(2000)), "/");
});

test("google callback: state failures", async (t) => {
  const { start, callback, calls } = await authSetup(t);
  const { loc, state } = await start();
  const good = loc.searchParams.get("state");
  assert.equal(loginError(await callback({ state: good, code: "c" })), "google_state", "missing cookie");
  assert.equal(loginError(await callback({ state: "wrong", code: "c" }, state)), "google_state", "mismatch");
  assert.equal(loginError(await callback({ code: "c" }, state)), "google_state", "no state param");
  const [payload, sig] = state.split("=")[1].split(".");
  const flipped = `shelf_oauth=${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  assert.equal(loginError(await callback({ state: good, code: "c" }, flipped)), "google_state", "bad sig");
  // A re-signed payload with another key, and an expired (validly signed) payload.
  const data = JSON.parse(Buffer.from(payload, "base64url"));
  const sign = (obj, key = SECRET) => {
    const p = b64(obj);
    return `shelf_oauth=${p}.${createHmac("sha256", key).update(`oauth:${p}`).digest("base64url")}`;
  };
  assert.equal(loginError(await callback({ state: good, code: "c" }, sign(data, "x".repeat(32)))), "google_state");
  const expired = sign({ ...data, x: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(loginError(await callback({ state: good, code: "c" }, expired)), "google_state", "expired");
  assert.equal(calls.length, 0, "no token request without a valid state");
  // Sanity: the same helper with a fresh expiry is accepted.
  const ok = await callback({ state: good, code: "c" }, sign(data));
  assert.ok(cookieOf(ok, "shelf_session"));
});

test("google callback: error param and missing code", async (t) => {
  const { start, callback, calls } = await authSetup(t);
  const { loc, state } = await start();
  const s = loc.searchParams.get("state");
  assert.equal(loginError(await callback({ error: "access_denied", state: s }, state)), "google_denied");
  assert.equal(loginError(await callback({ state: s }, state)), "google_denied");
  assert.equal(calls.length, 0);
});

test("google callback: token endpoint failures", async (t) => {
  const ctx = await authSetup(t);
  const replies = [
    () => new Response("nope", { status: 400 }),
    () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
    () => new Response("not json", { status: 200 }),
    () => Response.json({ access_token: "x" }),
    () => {
      throw new TypeError("network");
    },
  ];
  for (const reply of replies) {
    const { loc, state } = await ctx.start();
    ctx.setTokenReply(reply);
    const res = await ctx.callback({ state: loc.searchParams.get("state"), code: "c" }, state);
    assert.equal(loginError(res), "google_token");
  }
  const { loc, state } = await ctx.start();
  ctx.setTokenReply(() => Response.json({ id_token: "garbage" }));
  assert.equal(loginError(await ctx.callback({ state: loc.searchParams.get("state"), code: "c" }, state)), "google_claims");
});

test("google callback: id_token claim checks", async (t) => {
  const ctx = await authSetup(t);
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    [{ aud: "other-client" }, "google_claims"],
    [{ aud: [CLIENT_ID] }, "google_claims"],
    [{ iss: "https://evil.test" }, "google_claims"],
    [{ iss: undefined }, "google_claims"],
    [{ exp: now - 10 }, "google_claims"],
    [{ exp: String(now + 100) }, "google_claims"],
    [{ nonce: "wrong" }, "google_claims"],
    [{ nonce: undefined }, "google_claims"],
    [{ email_verified: false }, "google_claims"],
    [{ email_verified: "true" }, "google_claims"],
    [{ email: undefined }, "google_claims"],
    [{ email: "stranger@example.com" }, "forbidden_email"],
    [{ iss: "accounts.google.com", email: " Owner@Example.COM " }, null],
  ];
  for (const [patch, expected] of cases) {
    const { loc, state } = await ctx.start();
    const claims = { ...ctx.claims, ...patch };
    ctx.setTokenReply(() => Response.json({ id_token: jwt(claims) }));
    const res = await ctx.callback({ state: loc.searchParams.get("state"), code: "c" }, state);
    if (expected) assert.equal(loginError(res), expected, JSON.stringify(patch));
    else {
      assert.equal(res.headers.get("Location"), `${ORIGIN}/`);
      const me = await ctx.fetch("/api/me", { headers: { Cookie: cookieOf(res, "shelf_session") } });
      assert.deepEqual(await me.json(), { owner: true, email: OWNER });
    }
  }
  assert.deepEqual(checkGoogleClaims(null, { clientId: CLIENT_ID, nonce: "n" }), { error: "google_claims" });
});

test("session cookie: only the Google format is accepted", async (t) => {
  const { fetch, login } = await setup(t, CONFIG);
  const me = async (cookie) => (await fetch("/api/me", { headers: { Cookie: cookie } })).json();
  const cookie = await login(OWNER);
  assert.match(cookie, /^shelf_session=\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await me(cookie), { owner: true, email: OWNER });
  // A correctly signed legacy cookie (`<expiry>.<sig>` over `owner:<expiry>`) is rejected.
  const legacy = (exp) => `shelf_session=${exp}.${createHmac("sha256", SECRET).update(`owner:${exp}`).digest("base64url")}`;
  const future = Math.floor(Date.now() / 1000) + 600;
  assert.deepEqual(await me(legacy(future)), { owner: false });
  // Expired Google cookie.
  assert.deepEqual(await me(googleCookie(SECRET, OWNER, Math.floor(Date.now() / 1000) - 1)), { owner: false });
  // Signed with another secret.
  assert.deepEqual(await me(googleCookie("x".repeat(32), OWNER)), { owner: false });
});

test("google cookie is rejected once its email leaves OWNER_EMAILS", async (t) => {
  const { fetch, env, login } = await setup(t, CONFIG);
  const cookie = await login(OWNER);
  const status = async () => (await (await fetch("/api/me", { headers: { Cookie: cookie } })).json()).owner;
  assert.equal(await status(), true);
  env.OWNER_EMAILS = "other@example.com";
  assert.equal(await status(), false);
  assert.equal((await fetch("/api/budget", { headers: { Cookie: cookie } })).status, 401);
});

test("POST /api/login is gone; sessions need only SESSION_SECRET", async (t) => {
  const { fetch } = await setup(t, CONFIG);
  const res = await fetch("/api/login", { method: "POST", headers: { Origin: ORIGIN }, body: JSON.stringify({ password: "x" }) });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.deepEqual(await (await fetch("/api/me")).json(), { owner: false });
  const bearer = await fetch("/api/me", { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(await bearer.json(), { owner: true });
  const none = await setup(t, { OWNER_API_TOKEN: TOKEN });
  assert.equal((await none.fetch("/api/me")).status, 503);
});

test("owner API token", async (t) => {
  const { fetch, login } = await setup(t, CONFIG);
  const auth = (v) => ({ Authorization: v });
  assert.deepEqual(await (await fetch("/api/me", { headers: auth(`Bearer ${TOKEN}`) })).json(), { owner: true });
  assert.equal((await fetch("/api/budget", { headers: auth(`Bearer ${TOKEN}`) })).status, 200);
  assert.equal((await fetch("/api/budget", { headers: auth(`Bearer ${TOKEN}x`) })).status, 401);
  assert.equal((await fetch("/api/budget", { headers: auth(`bearer ${TOKEN}`) })).status, 401);
  assert.equal((await fetch("/api/budget", { headers: auth("Bearer ") })).status, 401);
  // A wrong bearer never falls back to a valid cookie.
  const cookie = await login();
  const mixed = await fetch("/api/budget", { headers: { ...auth("Bearer wrong-token"), Cookie: cookie } });
  assert.equal(mixed.status, 401);

  // Valid bearer writes skip the Origin check; cookie and invalid-bearer writes do not.
  const body = JSON.stringify({ path: "05-历史/大部头.pdf", sizeBytes: 300_000_000 });
  const viaBearer = await fetch("/api/catalog", { method: "POST", headers: auth(`Bearer ${TOKEN}`), body });
  assert.equal(viaBearer.status, 200);
  const crossBearer = await fetch("/api/catalog", {
    method: "POST",
    headers: { ...auth(`Bearer ${TOKEN}`), Origin: "https://evil.test" },
    body,
  });
  assert.equal(crossBearer.status, 200);
  const viaCookie = await fetch("/api/catalog", { method: "POST", headers: { Cookie: cookie }, body });
  assert.equal(viaCookie.status, 403);
  assert.deepEqual(await viaCookie.json(), { error: "bad_origin" });
  const badBearer = await fetch("/api/catalog", { method: "POST", headers: auth("Bearer nope"), body });
  assert.equal(badBearer.status, 403);
  // Bearer requests never receive a session cookie.
  assert.equal(viaBearer.headers.get("Set-Cookie"), null);
});

test("owner API token shorter than 32 chars is disabled", async (t) => {
  const short = "x".repeat(31);
  const { fetch } = await setup(t, { ...CONFIG, OWNER_API_TOKEN: short });
  assert.deepEqual(await (await fetch("/api/me", { headers: { Authorization: `Bearer ${short}` } })).json(), {
    owner: false,
  });
  const write = await fetch("/api/catalog", { method: "POST", headers: { Authorization: `Bearer ${short}` }, body: "{}" });
  assert.equal(write.status, 403);
  const unset = await setup(t, { ...CONFIG, OWNER_API_TOKEN: undefined });
  assert.equal((await unset.fetch("/api/budget", { headers: { Authorization: "Bearer " } })).status, 401);
});
