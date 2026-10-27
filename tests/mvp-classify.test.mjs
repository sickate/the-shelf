import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCall, classifySummary, selectBooks } from "../scripts/mvp-classify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = { limit: Infinity, ids: null, force: false, retryFailed: false };
const ids = (books, state, o) => selectBooks(books, state, { ...base, ...o }).map((b) => b.id);

test("selectBooks: null clc only, uploaded + local_only, state, limit", () => {
  const books = [
    { id: "a", status: "uploaded", clc: null },
    { id: "b", status: "uploaded", clc: "TP312" },
    { id: "c", status: "local_only", clc: null },
    { id: "d", status: "reserved", clc: null },
    { id: "e", status: "uploaded" },
    { id: "f", status: "uploaded", clc: null },
    { id: "g", status: "uploaded", clc: null },
  ];
  const state = { f: { result: "ready" }, g: { result: "failed" } };
  assert.deepEqual(ids(books, state, {}), ["a", "c", "e"]);
  assert.deepEqual(ids(books, state, { retryFailed: true }), ["a", "c", "e", "g"]);
  assert.deepEqual(ids(books, state, { force: true }), ["a", "b", "c", "e", "f", "g"]);
  assert.deepEqual(ids(books, state, { limit: 2 }), ["a", "c"]);
  assert.deepEqual(ids(books, state, { ids: ["b", "c"] }), ["c"]);
});

test("classifyCall: force looks up first and never sends manual books", async () => {
  const calls = [];
  const mk = (clcSource) => async (m, p) => {
    calls.push(`${m} ${p}`);
    return m === "GET" ? { status: 200, json: { book: { clcSource } } } : { status: 200, json: { clc: "X" } };
  };
  let r = await classifyCall({ id: "a" }, { request: mk("manual"), opts: { force: true } });
  assert.deepEqual([r.status, r.json.error], [409, "manual_locked"]);
  assert.deepEqual(calls, ["GET /api/books/a"]);
  calls.length = 0;
  r = await classifyCall({ id: "a" }, { request: mk("ai"), opts: { force: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ["GET /api/books/a", "POST /api/books/a/class?force=1"]);
  calls.length = 0;
  await classifyCall({ id: "a" }, { request: mk("ai"), opts: { force: false } });
  assert.deepEqual(calls, ["POST /api/books/a/class"]);
});

test("classifySummary counts by source, confidence and type", () => {
  const out = classifySummary(
    { ready: 3, failed: 0, skipped: 1 },
    [
      { result: "ready", source: "cip", confidence: "high", docType: "book" },
      { result: "ready", source: "ai", confidence: "high", docType: "course" },
      { result: "ready", source: "ai", confidence: "low", docType: null },
      { result: "skipped", reason: "manual_locked" },
    ],
    2,
  );
  assert.match(out, /ready=3 failed=0 skipped=1 busy_waits=2/);
  assert.match(out, /by_source: cip=1 ai=2/);
  assert.match(out, /by_confidence: high=2 low=1/);
  assert.match(out, /by_type: book=1 course=1 \?=1/);
});

// ---- end-to-end against a fake server ----
function fakeServer(books, { manual = new Set() } = {}) {
  const log = [];
  const auth = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj, h = {}) => (res.writeHead(code, { "content-type": "application/json", ...h }), res.end(JSON.stringify(obj)));
    log.push(`${req.method} ${url.pathname}${url.search}`);
    auth.push(req.headers.authorization ? `bearer:${req.headers.authorization}` : `cookie:${req.headers.cookie || ""}`);
    if (url.pathname === "/api/books" && req.method === "GET") return send(200, { books });
    let m = /^\/api\/books\/(\w+)$/.exec(url.pathname);
    if (m) return send(200, { book: { id: m[1], clcSource: manual.has(m[1]) ? "manual" : "ai" } });
    m = /^\/api\/books\/(\w+)\/(class|info)$/.exec(url.pathname);
    if (m && req.method === "POST") {
      if (manual.has(m[1])) return send(409, { error: "manual_locked" });
      if (m[2] === "info") return send(200, { status: "ready", model: "m", info: { confidence: "high", searchUsed: true } });
      return send(200, {
        status: "ready",
        clc: "TP312",
        clcSource: m[1] === "b1" ? "cip" : "ai",
        clcConfidence: "high",
        ...(m[1] === "b2" ? { docType: "course" } : {}),
      });
    }
    send(404, { error: "not_found" });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, log, auth, url: `http://127.0.0.1:${srv.address().port}` })));
}

function run(script, cwd, url, args, extraEnv = { SHELF_OWNER_API_TOKEN: "k".repeat(40) }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd,
      env: { ...process.env, SHELF_URL: url, ...extraEnv },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("mvp-classify end to end (--limit 2, local_only included, state 0600)", async () => {
  const books = [
    { id: "b1", title: "Book One", status: "uploaded", clc: null, hasInfo: false },
    { id: "b2", title: "Local Two", status: "local_only", clc: null, hasInfo: false },
    { id: "b3", title: "Third", status: "uploaded", clc: null, hasInfo: false },
    { id: "b4", title: "Done", status: "uploaded", clc: "I247", hasInfo: false },
  ];
  const { srv, log, url } = await fakeServer(books);
  const cwd = await mkdtemp(path.join(tmpdir(), "classify-"));
  try {
    const r = await run("scripts/mvp-classify.mjs", cwd, url, ["--limit", "2"]);
    console.log(r.out);
    assert.equal(r.code, 0);
    assert.match(r.out, /selected=2/);
    assert.match(r.out, /\[1\/2\] ready b1 [\d.]+s clc=TP312 type=\? source=cip confidence=high Book One/);
    assert.match(r.out, /\[2\/2\] ready b2 [\d.]+s clc=TP312 type=course source=ai confidence=high Local Two/);
    assert.match(r.out, /by_source: cip=1 ai=1/);
    assert.match(r.out, /by_type: \?=1 course=1/);
    assert.equal(log.filter((l) => l.startsWith("POST /api/books/") && l.endsWith("/class")).length, 2);
    const f = path.join(cwd, ".local/mvp-classify-state.json");
    assert.equal((await stat(f)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(f, "utf8")).books.b1.result, "ready");
    // second run resumes with the remaining book only
    const r2 = await run("scripts/mvp-classify.mjs", cwd, url, ["--dry-run"]);
    assert.match(r2.out, /selected=1/);
    assert.match(r2.out, /\[dry-run\] b3 /);
  } finally {
    srv.close();
  }
});

test("mvp-classify --force skips manual books without POSTing them", async () => {
  const books = [
    { id: "b1", title: "Manual", status: "uploaded", clc: "A1" },
    { id: "b2", title: "Auto", status: "uploaded", clc: "B1" },
  ];
  const { srv, log, url } = await fakeServer(books, { manual: new Set(["b1"]) });
  const cwd = await mkdtemp(path.join(tmpdir(), "classify-"));
  try {
    const r = await run("scripts/mvp-classify.mjs", cwd, url, ["--force", "--limit", "2"]);
    console.log(r.out);
    assert.equal(r.code, 0);
    assert.match(r.out, /skipped manual_locked Manual|skipped b1 [\d.]+s manual_locked/);
    assert.match(r.out, /ready b2/);
    assert.ok(!log.includes("POST /api/books/b1/class?force=1"));
    assert.ok(log.includes("POST /api/books/b2/class?force=1"));
  } finally {
    srv.close();
  }
});

test("mvp-enrich still works end to end through the shared runner (--limit 2)", async () => {
  const books = [
    { id: "b1", title: "One", status: "uploaded", hasInfo: false },
    { id: "b2", title: "Two", status: "uploaded", hasInfo: false },
    { id: "b3", title: "Three", status: "uploaded", hasInfo: false },
  ];
  const { srv, url } = await fakeServer(books);
  const cwd = await mkdtemp(path.join(tmpdir(), "enrich-"));
  try {
    const r = await run("scripts/mvp-enrich.mjs", cwd, url, ["--limit", "2"]);
    console.log(r.out);
    assert.equal(r.code, 0);
    assert.match(r.out, /\[2\/2\] ready b2 [\d.]+s model=m confidence=high search=yes Two/);
    assert.match(r.out, /ready=2 failed=0 skipped=0 busy_waits=0/);
    assert.equal((await stat(path.join(cwd, ".local/mvp-enrich-state.json"))).mode & 0o777, 0o600);
  } finally {
    srv.close();
  }
});

test("batch scripts use SHELF_OWNER_API_TOKEN as Bearer", async () => {
  const books = [{ id: "b1", title: "One", status: "uploaded", hasInfo: false }];
  const { srv, log, auth, url } = await fakeServer(books);
  const cwd = await mkdtemp(path.join(tmpdir(), "enrich-"));
  try {
    const token = "k".repeat(40);
    const r = await run("scripts/mvp-enrich.mjs", cwd, url, ["--limit", "1"], {
      SHELF_OWNER_API_TOKEN: token,
    });
    assert.equal(r.code, 0, r.out);
    assert.ok(!log.some((l) => l.includes("/api/login")));
    assert.ok(auth.length >= 2);
    assert.ok(auth.every((a) => a === `bearer:Bearer ${token}`));
    assert.ok(!r.out.includes(token), "token never printed");
  } finally {
    srv.close();
  }
});

test("scripts fail without SHELF_OWNER_API_TOKEN (password fallback removed)", async () => {
  const { srv, log, url } = await fakeServer([]);
  const cwd = await mkdtemp(path.join(tmpdir(), "notoken-"));
  try {
    const env = { SHELF_OWNER_API_TOKEN: "", SHELF_OWNER_PASSWORD: "pw", OWNER_PASSWORD: "pw" };
    for (const [script, args] of [
      ["scripts/mvp-enrich.mjs", ["--limit", "1"]],
      ["scripts/mvp-classify.mjs", ["--limit", "1"]],
      ["scripts/mvp-upload.mjs", ["--root", cwd]],
    ]) {
      const r = await run(script, cwd, url, args, env);
      assert.equal(r.code, 2, `${script}: ${r.out}`);
      assert.match(r.out, /SHELF_OWNER_API_TOKEN/);
    }
    assert.deepEqual(log, [], "no request is made without a token");
  } finally {
    srv.close();
  }
});
