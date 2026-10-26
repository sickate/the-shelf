import test from "node:test";
import assert from "node:assert/strict";
import { parseBookPath, parseRange } from "../app/worker.mjs";
import { ORIGIN, PASSWORD, setup, sha } from "./helpers/mvp-fixture.mjs";

test("path parsing and range parsing", () => {
  assert.deepEqual(parseBookPath("09-漫画/Chainsaw Man/第一部/第001话.pdf"), {
    path: "09-漫画/Chainsaw Man/第一部/第001话.pdf",
    category: "09-漫画",
    title: "Chainsaw Man/第一部/第001话",
    format: "PDF",
  });
  assert.equal(parseBookPath("solo.EPUB").category, "90-综合");
  assert.equal(parseBookPath("solo.EPUB").title, "solo");
  for (const bad of ["/abs.pdf", "a/../b.pdf", "a//b.pdf", "", "x".repeat(513) + ".pdf"])
    assert.throws(() => parseBookPath(bad), { code: "bad_path" });
  assert.throws(() => parseBookPath("a/b.exe"), { code: "unsupported_format" });
  assert.deepEqual(parseRange("bytes=0-9", 100), { offset: 0, length: 10 });
  assert.deepEqual(parseRange("bytes=90-", 100), { offset: 90, length: 10 });
  assert.deepEqual(parseRange("bytes=-5", 100), { offset: 95, length: 5 });
  assert.deepEqual(parseRange("bytes=95-500", 100), { offset: 95, length: 5 });
  assert.throws(() => parseRange("bytes=100-", 100), { code: "range_not_satisfiable" });
});

test("MVP worker API end to end", async (t) => {
  const { db, bucket, fetch, login, upload } = await setup(t);

  await t.test("static assets and unknown api", async () => {
    assert.equal(await (await fetch("/")).text(), "static asset");
    const res = await fetch("/api/nope");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  });

  await t.test("login failure, bad origin, success cookie and me", async () => {
    const bad = await fetch("/api/login", {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ password: "wrong" }),
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("Set-Cookie"), null);
    const cross = await fetch("/api/login", {
      method: "POST",
      headers: { Origin: "https://evil.test" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(cross.status, 403);
    assert.deepEqual(await cross.json(), { error: "bad_origin" });
    const noOrigin = await fetch("/api/logout", { method: "POST" });
    assert.equal(noOrigin.status, 403);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = res.headers.get("Set-Cookie");
    assert.match(cookie, /^shelf_session=\d+\.[A-Za-z0-9_-]{43}; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Path=\/$/);
    const me = await fetch("/api/me", { headers: { Cookie: cookie.split(";")[0] } });
    assert.deepEqual(await me.json(), { owner: true });
    assert.deepEqual(await (await fetch("/api/me")).json(), { owner: false });
    const forged = cookie.split(";")[0].replace(/\.(.)/, (_, c) => `.${c === "A" ? "B" : "A"}`);
    assert.deepEqual(await (await fetch("/api/me", { headers: { Cookie: forged } })).json(), { owner: false });
  });

  const cookie = await login();
  const pdf = new TextEncoder().encode("%PDF-1.4 " + "0123456789".repeat(100));
  let bookId;

  await t.test("owner-only routes reject anonymous", async () => {
    assert.equal((await upload("", "a/b.pdf", pdf)).status, 401);
    assert.equal((await fetch("/api/budget")).status, 401);
  });

  await t.test("upload happy path and duplicate", async () => {
    const res = await upload(cookie, "01-计算机与技术/Deep Dive/书.pdf", pdf);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.duplicate, false);
    bookId = body.book.id;
    assert.equal(bookId, `b_${sha(pdf).slice(0, 16)}`);
    assert.equal(body.book.category, "01-计算机与技术");
    assert.equal(body.book.title, "Deep Dive/书");
    assert.equal(body.book.status, "uploaded");
    const obj = await bucket.head(`books/${sha(pdf)}`);
    assert.equal(obj.size, pdf.byteLength);
    assert.equal(obj.httpMetadata.contentType, "application/pdf");
    const dup = await (await upload(cookie, "other/copy.pdf", pdf)).json();
    assert.equal(dup.duplicate, true);
    assert.equal(dup.book.id, bookId);
  });

  await t.test("upload validation errors", async () => {
    const mismatch = await upload(cookie, "a/b.pdf", pdf, "0".repeat(64));
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), { error: "hash_mismatch" });
    const fmt = await upload(cookie, "a/b.exe", pdf);
    assert.equal(fmt.status, 415);
    assert.deepEqual(await fmt.json(), { error: "unsupported_format" });
    const big = new Uint8Array(20_000_001);
    const over = await upload(cookie, "a/big.pdf", big);
    assert.equal(over.status, 413);
    const declared = await upload(cookie, "a/c.pdf", pdf, sha(pdf), { "Content-Length": "20000001" });
    assert.equal(declared.status, 413);
    const badPath = await upload(cookie, "../x.pdf", pdf);
    assert.equal(badPath.status, 400);
  });

  await t.test("catalog registers local_only idempotently", async () => {
    const post = () =>
      fetch("/api/catalog", {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify({ path: "05-历史/大部头.pdf", sizeBytes: 300_000_000 }),
      });
    const a = await (await post()).json();
    const b = await (await post()).json();
    assert.equal(a.book.status, "local_only");
    assert.match(a.book.id, /^p_[0-9a-f]{16}$/);
    assert.deepEqual(a, b);
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM books WHERE status='local_only'").first();
    assert.equal(n, 1);
  });

  await t.test("list hides private fields; budget counts uploads only", async () => {
    const list = await (await fetch("/api/books")).json();
    assert.equal(list.books.length, 2);
    assert.deepEqual(list.categories, ["01-计算机与技术", "05-历史"]);
    for (const b of list.books)
      assert.deepEqual(Object.keys(b).sort(), ["category", "clc", "createdAt", "format", "id", "sizeBytes", "status", "title"]);
    assert.doesNotMatch(JSON.stringify(list), new RegExp(sha(pdf)));
    const one = await (await fetch(`/api/books/${bookId}`)).json();
    assert.equal(one.book.id, bookId);
    const budget = await (await fetch("/api/budget", { headers: { Cookie: cookie } })).json();
    assert.equal(budget.limitBytes, 8_000_000_000);
    assert.equal(budget.usedBytes, 100_000_000 + pdf.byteLength);
  });

  await t.test("file requires owner; full, range and HEAD", async () => {
    const anon = await fetch(`/api/books/${bookId}/file`);
    assert.equal(anon.status, 401);
    assert.deepEqual(await anon.json(), { error: "login_required" });
    const full = await fetch(`/api/books/${bookId}/file`, { headers: { Cookie: cookie } });
    assert.equal(full.status, 200);
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), pdf);
    assert.equal(full.headers.get("Content-Type"), "application/pdf");
    assert.equal(full.headers.get("Accept-Ranges"), "bytes");
    assert.equal(full.headers.get("Cache-Control"), "private, max-age=3600");
    assert.equal(full.headers.get("Content-Disposition"), `inline; filename*=UTF-8''${encodeURIComponent("书.pdf")}`);
    const part = await fetch(`/api/books/${bookId}/file?download=1`, { headers: { Cookie: cookie, Range: "bytes=2-6" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("Content-Range"), `bytes 2-6/${pdf.byteLength}`);
    assert.match(part.headers.get("Content-Disposition"), /^attachment;/);
    assert.equal(await part.text(), "DF-1.");
    const tail = await fetch(`/api/books/${bookId}/file`, { headers: { Cookie: cookie, Range: "bytes=-3" } });
    assert.equal(await tail.text(), "789");
    const head = await fetch(`/api/books/${bookId}/file`, { method: "HEAD", headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Length"), String(pdf.byteLength));
    const unsat = await fetch(`/api/books/${bookId}/file`, { headers: { Cookie: cookie, Range: "bytes=99999-" } });
    assert.equal(unsat.status, 416);
  });

  await t.test("soft delete hides book but keeps object and budget", async () => {
    const del = await fetch(`/api/books/${bookId}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: cookie } });
    assert.equal(del.status, 200);
    const list = await (await fetch("/api/books")).json();
    assert.ok(!list.books.some((b) => b.id === bookId));
    assert.equal((await fetch(`/api/books/${bookId}`)).status, 404);
    assert.equal((await fetch(`/api/books/${bookId}/file`, { headers: { Cookie: cookie } })).status, 404);
    assert.ok(await bucket.head(`books/${sha(pdf)}`));
    const budget = await (await fetch("/api/budget", { headers: { Cookie: cookie } })).json();
    assert.equal(budget.usedBytes, 100_000_000 + pdf.byteLength);
  });

  await t.test("budget exceeded returns 507 without writing", async () => {
    await db
      .prepare(
        "INSERT INTO books VALUES ('b_filler','f','x','PDF',7899999000,'f'||hex(randomblob(8)),'books/filler','x/f.pdf','uploaded','2026-01-01',NULL)",
      )
      .run();
    const bytes = new TextEncoder().encode("another book ".repeat(200));
    const res = await upload(cookie, "a/new.epub", bytes);
    assert.equal(res.status, 507);
    assert.deepEqual(await res.json(), { error: "budget_exceeded" });
    assert.equal(await bucket.head(`books/${sha(bytes)}`), null);
    const row = await db.prepare("SELECT * FROM books WHERE sha256 = ?").bind(sha(bytes)).first();
    assert.equal(row, null);
  });
});

test("R2 failure keeps reservation; retry re-puts without new budget", async (t) => {
  const { db, bucket, login, upload } = await setup(t);
  const cookie = await login();
  const bytes = new TextEncoder().encode("txt body");
  bucket.failPuts = true;
  const fail = await upload(cookie, "notes/a.txt", bytes);
  assert.equal(fail.status, 502);
  assert.deepEqual(await fail.json(), { error: "storage_unknown" });
  const row = await db.prepare("SELECT status FROM books WHERE sha256 = ?").bind(sha(bytes)).first();
  assert.equal(row.status, "reserved");
  bucket.failPuts = false;
  const ok = await (await upload(cookie, "notes/a.txt", bytes)).json();
  assert.equal(ok.duplicate, false);
  assert.equal(ok.book.status, "uploaded");
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM books").first();
  assert.equal(n, 1);
});

test("missing secrets return 503 not_configured", async (t) => {
  const { fetch } = await setup(t, {});
  const res = await fetch("/api/login", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "not_configured" });
});
