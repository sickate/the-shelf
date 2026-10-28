import test from "node:test";
import assert from "node:assert/strict";
import { INSTANCE_BUDGET, SEQ_GAP, STEP_COST, AUDIO_BYTES_PER_CHAR, runAudioWorkflow } from "../app/worker.mjs";
import { DEFAULT_STYLE, precleanText, splitPieces } from "../app/audio-text.mjs";
import { ORIGIN, setup } from "./helpers/mvp-fixture.mjs";
import { cleanupText, drain, fakeOai, fakeStep, fakeSynth, fakeWorkflows, oaiOk } from "./helpers/audio-fixture.mjs";

const CHAPTER = [
  "第一章 起点",
  "",
  "他说[1]：“今天我们讨论 machine learning 里的 gradient descent 方法①。”",
  "参考 https://example.com/paper 以及（见第 12 页）。",
  "12",
  "——————",
  "这是一段较长的正文，用于测试朗读。".repeat(20),
].join("\n");

async function audioSetup(t, { oai = true, key = true } = {}) {
  const ctx = await setup(t, { SESSION_SECRET: "s".repeat(32), ...(oai ? { OAI_KEY: "oai-test" } : {}) });
  const wf = fakeWorkflows();
  if (key) ctx.env.DASHSCOPE_KEY = "dash-test";
  ctx.env.AUDIO_WORKFLOW = wf;
  const cookie = await ctx.login();
  const pdf = new TextEncoder().encode("%PDF-1.4 audio test book");
  const book = (await (await ctx.upload(cookie, "01-测试/朗读.pdf", pdf)).json()).book;
  const owner = (path, init = {}) =>
    ctx.fetch(path, { ...init, headers: { Origin: ORIGIN, Cookie: cookie, ...(init.headers ?? {}) } });
  const create = (body) => owner(`/api/books/${book.id}/audio`, { method: "POST", body: JSON.stringify(body) });
  const getJob = async (id) => (await (await owner(`/api/audio/${id}`)).json()).job;
  const used = async () => (await (await owner("/api/budget")).json());
  return { ...ctx, wf, cookie, book, owner, create, getJob, used };
}

test("auth, origin, configuration and validation", async (t) => {
  const c = await audioSetup(t);
  const path = `/api/books/${c.book.id}/audio`;
  // Guest is rejected before any body validation; cross-origin writes before auth.
  assert.equal((await c.fetch(path, { method: "POST", headers: { Origin: ORIGIN }, body: "not json" })).status, 401);
  assert.equal((await c.fetch(path, { method: "POST", headers: { Cookie: c.cookie }, body: "{}" })).status, 403);
  assert.equal((await c.fetch(path, { method: "POST", headers: { Cookie: c.cookie, Origin: "https://evil.test" }, body: "{}" })).status, 403);
  for (const p of [`${path}?chapterKey=x`, "/api/audio/a_000000000000000000000000", "/api/audio/a_000000000000000000000000/pieces/0"])
    assert.equal((await c.fetch(p)).status, 401, p);
  assert.equal((await c.fetch("/api/audio/a_000000000000000000000000", { method: "DELETE", headers: { Origin: ORIGIN } })).status, 401);

  const bad = async (body, status, error) => {
    const res = await c.create(body);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await res.json(), { error });
  };
  await bad({ label: "x", text: "y" }, 400, "bad_chapter_key");
  await bad({ chapterKey: "k".repeat(501), text: "y" }, 400, "bad_chapter_key");
  await bad({ chapterKey: "好".repeat(167), text: "y" }, 400, "bad_chapter_key"); // 501 bytes
  await bad({ chapterKey: "k", text: "  " }, 400, "empty_text");
  await bad({ chapterKey: "k", text: 5 }, 400, "bad_text");
  await bad({ chapterKey: "k", text: "y", voice: "Nobody" }, 400, "bad_voice");
  await bad({ chapterKey: "k", text: "a".repeat(300_001) }, 413, "text_too_long");
  await bad({ chapterKey: "k", text: "好".repeat(400_001) }, 413, "too_large"); // body > 1.2 MB
  const raw = await c.owner(path, { method: "POST", body: "[1]" });
  assert.equal(raw.status, 400);
  // 300,000 code points with astral chars (> 300,000 UTF-16 units) is accepted.
  const astral = "😀".repeat(1000) + "a".repeat(299_000);
  assert.equal((await c.create({ chapterKey: "astral", text: astral })).status, 201);
  // Unknown or unreadable book.
  assert.equal((await c.owner("/api/books/b_missing/audio", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await c.owner(`${path}?chapterKey=none`)).status, 404);
  assert.equal((await c.owner(path)).status, 400);

  delete c.env.DASHSCOPE_KEY;
  await bad({ chapterKey: "k", text: "y" }, 503, "not_configured");
  c.env.DASHSCOPE_KEY = "dash-test";
  delete c.env.AUDIO_WORKFLOW;
  await bad({ chapterKey: "k", text: "y" }, 503, "not_configured");
});

test("create, dedupe, generate, play and budget end to end", async (t) => {
  const c = await audioSetup(t);
  const requests = fakeOai(t, (body) => ({
    body: { content: JSON.stringify({ text: cleanupText(body.input), style: "平稳、客观的讲解语气" }) },
  }));
  const synth = fakeSynth();
  const res = await c.create({ chapterKey: "epub:ch1", label: "第一章", text: CHAPTER });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const { job } = await res.json();
  assert.match(job.id, /^a_[0-9a-f]{24}$/);
  assert.equal(job.status, "queued");
  assert.equal(job.voice, "Cherry");
  assert.equal(job.chapterLabel, "第一章");
  assert.ok(job.estSeconds > 60);
  assert.ok(job.totalPieces > 0);
  assert.deepEqual(job.segments, []);
  assert.deepEqual([...c.wf.instances.keys()], [`${job.id}-p0`]);

  // Same text + chapter + voice: the existing job; another voice is a new job.
  const dup = await (await c.create({ chapterKey: "epub:ch1", label: "第一章", text: CHAPTER })).json();
  assert.equal(dup.job.id, job.id);
  assert.equal(dup.duplicate, true);
  assert.equal(c.wf.instances.size, 1);
  const found = await (await c.owner(`/api/books/${c.book.id}/audio?chapterKey=${encodeURIComponent("epub:ch1")}`)).json();
  assert.equal(found.job.id, job.id);

  const runs = await drain(c.env, synth);
  assert.equal(runs.at(-1).result, "done");
  const done = await c.getJob(job.id);
  assert.equal(done.status, "ready");
  assert.equal(done.error, null);
  assert.equal(done.style, "平稳、客观的讲解语气");
  assert.equal(done.donePieces, done.totalPieces);
  assert.equal(done.llmFallbackBlocks, 0);
  const pieces = done.segments.flatMap((s) => s.pieces);
  assert.equal(pieces.length, done.totalPieces);
  assert.ok(pieces.every((p) => p.ready && p.durationMs > 0));
  assert.equal(done.segments[0].durationMs, pieces.reduce((a, p) => a + p.durationMs, 0));
  assert.equal(done.billedChars, synth.calls.reduce((a, x) => a + x.text.length * 2, 0));

  // LLM: gpt-luna, low effort, JSON; input already pre-cleaned (footnotes/URL/page refs gone).
  assert.equal(requests.length, 1);
  assert.deepEqual([requests[0].model, requests[0].effort, requests[0].output_format], ["gpt-luna", "low", "json_object"]);
  const spoken = synth.calls.map((x) => x.text).join("");
  for (const gone of ["[1]", "①", "https://", "见第 12 页", "——", "\n12\n"]) assert.ok(!spoken.includes(gone), gone);
  assert.ok(spoken.includes("machine learning"));
  assert.ok(synth.calls.every((x) => x.text.length <= 200 && x.key === "dash-test" && x.voice === "Cherry"));
  // Raw chapter text is not kept once cleaned.
  const { raws } = await c.db.prepare("SELECT COUNT(*) AS raws FROM audio_blocks WHERE raw IS NOT NULL").first();
  assert.equal(raws, 0);

  // Pieces: R2 key, budget settled to actual bytes.
  const rows = (await c.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ? ORDER BY seq").bind(job.id).all()).results;
  assert.ok(rows.every((r) => r.r2_key === `audio/${job.id}/${r.seq}.mp3` && r.seq % SEQ_GAP === 0));
  assert.ok(rows.every((r) => r.reserved_bytes >= r.size_bytes && r.reserved_bytes === Math.max(65_536, r.text.length * AUDIO_BYTES_PER_CHAR)));
  const total = rows.reduce((a, r) => a + r.size_bytes, 0);
  const budget = await c.used();
  assert.equal(budget.audioBytes, total);
  assert.equal(budget.usedBytes, 100_000_000 + 24 + total);

  // Piece audio: full, Range, HEAD, cache headers; owner only.
  const seq = pieces[0].seq;
  const piecePath = `/api/audio/${job.id}/pieces/${seq}`;
  const full = await c.owner(piecePath);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Content-Type"), "audio/mpeg");
  assert.equal(full.headers.get("Cache-Control"), "private, max-age=86400");
  assert.equal(full.headers.get("Accept-Ranges"), "bytes");
  const bytes = new Uint8Array(await full.arrayBuffer());
  assert.deepEqual(bytes, c.bucket.objects.get(`audio/${job.id}/${seq}.mp3`).bytes);
  const part = await c.owner(piecePath, { headers: { Range: "bytes=0-9" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), `bytes 0-9/${bytes.length}`);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.slice(0, 10));
  const head = await c.owner(piecePath, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(bytes.length));
  assert.equal((await c.owner(piecePath, { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
  assert.equal((await c.owner(`/api/audio/${job.id}/pieces/1`)).status, 404);
  assert.equal((await c.fetch(piecePath)).status, 401);

  // Delete: soft, keeps objects and budget; job and pieces disappear.
  const del = await c.owner(`/api/audio/${job.id}`, { method: "DELETE" });
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal((await c.owner(`/api/audio/${job.id}`)).status, 404);
  assert.equal((await c.owner(piecePath)).status, 404);
  assert.equal((await c.owner(`/api/books/${c.book.id}/audio?chapterKey=epub%3Ach1`)).status, 404);
  assert.equal((await c.used()).audioBytes, total);
  assert.ok(c.bucket.objects.has(`audio/${job.id}/${seq}.mp3`));
  assert.equal((await c.owner(`/api/audio/${job.id}`, { method: "DELETE" })).status, 404);
  // After deletion the same chapter can be created again (new job).
  const again = await (await c.create({ chapterKey: "epub:ch1", label: "第一章", text: CHAPTER })).json();
  assert.notEqual(again.job.id, job.id);
});

test("regenerate reuses cleaned text, switches voice and keeps budget", async (t) => {
  const c = await audioSetup(t);
  const requests = fakeOai(t, (body) => ({ body: { content: JSON.stringify({ text: cleanupText(body.input), style: "沉稳的语气" }) } }));
  const synth = fakeSynth();
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: CHAPTER })).json();
  await drain(c.env, synth);
  const before = (await c.used()).audioBytes;
  const res = await c.owner(`/api/audio/${job.id}/regenerate`, { method: "POST", body: JSON.stringify({ voice: "Ethan" }) });
  assert.equal(res.status, 201);
  const fresh = (await res.json()).job;
  assert.equal(fresh.voice, "Ethan");
  assert.equal(fresh.style, "沉稳的语气");
  assert.equal((await c.owner(`/api/audio/${job.id}`)).status, 404);
  assert.ok(c.wf.terminated.includes(`${job.id}-p0`));
  await drain(c.env, synth);
  const ready = await c.getJob(fresh.id);
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(requests.length, 1); // cleaned blocks reused: no second LLM call
  assert.ok(synth.calls.slice(-ready.totalPieces).every((x) => x.voice === "Ethan"));
  assert.equal((await c.used()).audioBytes, before + (await c.db.prepare("SELECT SUM(size_bytes) AS s FROM audio_pieces WHERE job_id = ?").bind(fresh.id).first()).s);
  // Same voice again also works (old one soft-deleted first).
  const same = await c.owner(`/api/audio/${fresh.id}/regenerate`, { method: "POST", body: "" });
  assert.equal(same.status, 201);
  assert.equal((await same.json()).job.voice, "Ethan");
  assert.equal((await c.owner(`/api/audio/${fresh.id}/regenerate`, { method: "POST", body: JSON.stringify({ voice: "X" }) })).status, 404);
  assert.equal((await c.owner("/api/audio/a_000000000000000000000000/regenerate", { method: "POST", body: "{}" })).status, 404);
});

test("LLM output failing validation falls back to the rules; style falls back to the default", async (t) => {
  const c = await audioSetup(t);
  fakeOai(t, () => ({ body: { content: JSON.stringify({ text: "完全改写过的内容，与原文无关。".repeat(30), style: "欢快" }) } }));
  const synth = fakeSynth();
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: CHAPTER })).json();
  await drain(c.env, synth);
  const done = await c.getJob(job.id);
  assert.equal(done.status, "ready");
  assert.equal(done.llmFallbackBlocks, 1);
  assert.equal(done.style, DEFAULT_STYLE);
  assert.ok(synth.calls.map((x) => x.text).join("").includes("这是一段较长的正文"));
});

test("LLM busy retries with Retry-After backoff; other errors fall back without retry", async (t) => {
  const c = await audioSetup(t);
  let busy = 2;
  const requests = fakeOai(t, (body) =>
    busy-- > 0
      ? { status: 503, headers: { "Retry-After": "7" }, body: { error: "busy" } }
      : { body: { content: JSON.stringify({ text: cleanupText(body.input) }) } },
  );
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: CHAPTER })).json();
  const runs = await drain(c.env, fakeSynth());
  assert.equal(requests.length, 3);
  assert.equal(runs[0].log.filter((s) => s.startsWith("sleep:llm-wait-0-")).length, 2);
  const done = await c.getJob(job.id);
  assert.equal(done.status, "ready");
  assert.equal(done.llmFallbackBlocks, 0);
  assert.equal(done.style, DEFAULT_STYLE); // valid output but no style

  // A 500 is not retried.
  const d = await audioSetup(t);
  const r2 = fakeOai(t, () => ({ status: 500, body: { error: "x" } }));
  const j2 = (await (await d.create({ chapterKey: "c", label: "章", text: CHAPTER })).json()).job;
  await drain(d.env, fakeSynth());
  assert.equal(r2.length, 1);
  assert.equal((await d.getJob(j2.id)).llmFallbackBlocks, 1);

  // Always busy: 6 attempts, then the rules.
  const e = await audioSetup(t);
  const r3 = fakeOai(t, () => ({ status: 503, headers: { "Retry-After": "1" }, body: {} }));
  const j3 = (await (await e.create({ chapterKey: "c", label: "章", text: CHAPTER })).json()).job;
  await drain(e.env, fakeSynth());
  assert.equal(r3.length, 6);
  const v3 = await e.getJob(j3.id);
  assert.equal(v3.status, "ready");
  assert.equal(v3.llmFallbackBlocks, 1);
});

test("over budget stops at budget_exceeded without writing R2", async (t) => {
  const c = await audioSetup(t, { oai: false });
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: CHAPTER })).json();
  // Leave room for exactly the first piece's reservation.
  const pieces = splitPieces(precleanText(CHAPTER), 200);
  const first = pieces[0].length * AUDIO_BYTES_PER_CHAR;
  assert.ok(pieces[1].length * AUDIO_BYTES_PER_CHAR > 1000);
  const { used } = await c.db.prepare("SELECT SUM(size_bytes) AS used FROM books").first();
  await c.db.prepare(
    "INSERT INTO books (id, title, category, format, size_bytes, r2_key, source_path, status, created_at) VALUES ('b_fill','f','c','PDF',?, 'books/fill','f.pdf','uploaded','2026')",
  )
    .bind(8_000_000_000 - 100_000_000 - used - first - 1000)
    .run();
  // Audio as large as its reservation, so settling frees nothing.
  const synth = fakeSynth({ sizeFor: (text) => text.length * AUDIO_BYTES_PER_CHAR });
  await drain(c.env, synth);
  const v = await c.getJob(job.id);
  assert.equal(v.status, "budget_exceeded");
  assert.equal(v.error, "budget_exceeded");
  assert.equal(synth.calls.length, 1);
  const rows = (await c.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ? ORDER BY seq").bind(job.id).all()).results;
  assert.equal(rows.filter((r) => r.reserved_bytes !== null).length, 1);
  assert.equal(c.bucket.puts - 1, 1); // 1 = the book upload; no put without a reservation
  assert.ok((await c.used()).usedBytes <= 8_000_000_000);

  // Nothing fits at all: no TTS call, no put.
  const d = await audioSetup(t, { oai: false });
  await d.db.prepare(
    "INSERT INTO books (id, title, category, format, size_bytes, r2_key, source_path, status, created_at) VALUES ('b_fill','f','c','PDF',?, 'books/fill','f.pdf','uploaded','2026')",
  )
    .bind(7_900_000_000 - 30)
    .run();
  const j2 = (await (await d.create({ chapterKey: "c", label: "章", text: CHAPTER })).json()).job;
  const s2 = fakeSynth();
  await drain(d.env, s2);
  assert.equal((await d.getJob(j2.id)).status, "budget_exceeded");
  assert.equal(s2.calls.length, 0);
  assert.equal(d.bucket.puts, 1);
});

test("R2 failure keeps the reservation; the retry re-puts the same key without new budget", async (t) => {
  const c = await audioSetup(t, { oai: false });
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: "短短的一句话，用来测试存储失败。" }) ).json();
  const realPut = c.bucket.put.bind(c.bucket);
  let failures = 2;
  c.bucket.put = async (key, value, opts) => {
    if (key.startsWith("audio/") && failures-- > 0) throw new Error("network");
    return realPut(key, value, opts);
  };
  await drain(c.env, fakeSynth());
  const row = await c.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ?").bind(job.id).first();
  assert.equal(row.status, "ready");
  assert.equal(row.reserved_bytes, 65_536);
  assert.equal((await c.used()).audioBytes, row.size_bytes);

  // All attempts fail: job failed, reservation kept and counted (unknown outcome).
  const { job: j2 } = await (await c.create({ chapterKey: "c2", label: "章", text: "另一句话。" })).json();
  failures = 1e9;
  await drain(c.env, fakeSynth());
  const v = await c.getJob(j2.id);
  assert.equal(v.status, "failed");
  assert.match(v.error, /^tts_failed: network/);
  const r2 = await c.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ?").bind(j2.id).first();
  assert.equal(r2.size_bytes, null);
  assert.equal(r2.reserved_bytes, 65_536);
  assert.equal((await c.used()).audioBytes, row.size_bytes + 65_536);
});

test("transient TTS failures retry in later rounds, then fail the job", async (t) => {
  const c = await audioSetup(t, { oai: false });
  let drops = 4; // 3 attempts in round 0, 1 in round 1, then success
  const synth = fakeSynth({ fail: () => (drops-- > 0 ? new Error("tts_closed_1006") : null) });
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: "一句短话。" })).json();
  const runs = await drain(c.env, synth);
  assert.equal((await c.getJob(job.id)).status, "ready");
  assert.ok(runs[0].log.some((s) => s.startsWith("sleep:piece-")));
  assert.equal(synth.calls.length, 5);
  const piece = await c.db.prepare("SELECT attempts, error FROM audio_pieces WHERE job_id = ?").bind(job.id).first();
  assert.equal(piece.attempts, 1);
  assert.equal(piece.error, null);
});

test("CPU-limit failure splits the piece into ≤ 120-char sub-pieces and lowers the global length", async (t) => {
  const c = await audioSetup(t, { oai: false });
  const text = ("这是一个用于测试 CPU 降级的句子，内容足够长" + "，继续".repeat(10) + "。").repeat(8);
  const synth = fakeSynth({ fail: (s) => (s.length > 120 ? new Error("Worker exceeded CPU time limit.") : null) });
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text })).json();
  assert.equal(job.pieceChars, 200);
  await drain(c.env, synth);
  const v = await c.getJob(job.id);
  assert.equal(v.status, "ready");
  assert.equal(v.cpuDowngraded, true);
  assert.equal(v.pieceChars, 120);
  const rows = (await c.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ? ORDER BY seq").bind(job.id).all()).results;
  const split = rows.filter((r) => r.status === "split");
  const live = rows.filter((r) => r.status !== "split");
  assert.ok(split.length >= 1);
  assert.ok(live.every((r) => r.status === "ready" && r.text.length <= 120));
  assert.ok(live.every((r) => r.cpu_split === 1 || r.text.length <= 120));
  // Splitting keeps the text and order; parent rows keep their reservation in the budget.
  assert.equal(live.map((r) => r.text).join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  // The failed parent keeps its reservation; preemptively split ones were never reserved.
  assert.ok(split.some((r) => r.reserved_bytes > 0 && r.error.includes("CPU")));
  assert.ok(split.filter((r) => r.error === "split_preemptive").every((r) => r.reserved_bytes === null));
  const b = await c.used();
  assert.equal(b.audioBytes, rows.reduce((a, r) => a + (r.size_bytes ?? r.reserved_bytes ?? 0), 0));
  assert.equal(v.segments.flatMap((s) => s.pieces).length, live.length);
  const settings = await c.db.prepare("SELECT * FROM audio_settings WHERE id = 1").first();
  assert.equal(settings.piece_chars, 120);
  assert.equal(settings.downgrade_reason, "cpu_limit");
  // New jobs use 120-char pieces from the start.
  const next = (await (await c.create({ chapterKey: "c2", label: "章", text })).json()).job;
  assert.equal(next.pieceChars, 120);
  synth.calls.length = 0;
  await drain(c.env, synth);
  assert.ok(synth.calls.every((x) => x.text.length <= 120));
  assert.equal((await c.getJob(next.id)).cpuDowngraded, false);
});

test("long chapters continue in new instances within the per-instance budget; segments ≤ 20:00", async (t) => {
  const c = await audioSetup(t, { oai: false });
  // ~60 pieces, random durations up to 2 minutes so several segments are needed.
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const synth = fakeSynth({ durationFor: () => 30_000 + Math.floor(rand() * 90_000) });
  const text = Array.from({ length: 60 }, (_, i) => `第${i}句话，` + "内容".repeat(80) + "。").join("\n\n");
  const { job } = await (await c.create({ chapterKey: "c", label: "长章", text })).json();
  const runs = await drain(c.env, synth);
  assert.ok(runs.length > 2);
  assert.equal(runs.at(-1).result, "done");
  assert.ok(runs.slice(0, -1).every((r) => r.result === "continued"));
  assert.deepEqual(runs.map((r) => r.id), runs.map((_, i) => `${job.id}-p${i}`));
  const maxPieces = Math.floor(INSTANCE_BUDGET.ext / STEP_COST.piece.ext);
  assert.ok(runs.every((r) => r.synth <= maxPieces && r.steps < 1024));
  const v = await c.getJob(job.id);
  assert.equal(v.status, "ready");
  assert.equal(v.donePieces, 60);
  assert.ok(v.segments.length >= 2);
  for (const s of v.segments) assert.ok(s.durationMs <= 1_200_000, `segment ${s.index} ${s.durationMs}`);
  // A new segment starts only when the next piece would not fit.
  for (let i = 1; i < v.segments.length; i++)
    assert.ok(v.segments[i - 1].durationMs + v.segments[i].pieces[0].durationMs > 1_200_000);
  const job0 = await c.db.prepare("SELECT workflow_id FROM audio_jobs WHERE id = ?").bind(job.id).first();
  assert.equal(job0.workflow_id, runs.at(-1).id);
});

test("pending pieces get provisional segments from estimates", async (t) => {
  const c = await audioSetup(t, { oai: false });
  const text = Array.from({ length: 30 }, () => "内容".repeat(90) + "。").join("\n\n");
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text })).json();
  // Run one instance only, so some pieces are still pending.
  const inst = c.wf.instances.get(`${job.id}-p0`);
  inst.ran = true;
  await runAudioWorkflow(c.env, { payload: inst.params }, fakeStep(), fakeSynth({ durationFor: () => 300_000 }));
  const v = await c.getJob(job.id);
  assert.equal(v.status, "synthesizing");
  const all = v.segments.flatMap((s) => s.pieces);
  assert.equal(all.length, 30);
  assert.ok(all.some((p) => p.ready) && all.some((p) => !p.ready));
  assert.ok(all.filter((p) => !p.ready).every((p) => p.durationMs === 37_800));
  for (const s of v.segments) assert.ok(s.durationMs <= 1_200_000);
  assert.deepEqual(v.segments.map((s) => s.index), v.segments.map((_, i) => i));
});

test("deleted job stops its workflow; bad payloads and workflow start failures", async (t) => {
  const c = await audioSetup(t, { oai: false });
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: CHAPTER })).json();
  await c.owner(`/api/audio/${job.id}`, { method: "DELETE" });
  const synth = fakeSynth();
  const runs = await drain(c.env, synth);
  assert.equal(runs[0].result, "stop");
  assert.equal(synth.calls.length, 0);
  assert.equal(await runAudioWorkflow(c.env, { payload: { jobId: "x" } }, fakeStep()), "bad_payload");
  c.wf.failCreate = true;
  const res = await c.create({ chapterKey: "c3", label: "章", text: "文字。" });
  assert.equal(res.status, 201);
  const v = (await res.json()).job;
  assert.equal(v.status, "failed");
  assert.equal(v.error, "workflow_start_failed");
});

test("empty cleaned text fails the job with empty_text", async (t) => {
  const c = await audioSetup(t, { oai: false });
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: "12\n——\nhttps://example.com/only" })).json();
  await drain(c.env, fakeSynth());
  const v = await c.getJob(job.id);
  assert.equal(v.status, "failed");
  assert.equal(v.error, "empty_text");
});

test("audio larger than its reservation grows the reservation atomically before the put", async (t) => {
  const c = await audioSetup(t, { oai: false });
  const { job } = await (await c.create({ chapterKey: "c", label: "章", text: "短句。" })).json();
  await drain(c.env, fakeSynth({ sizeFor: () => 100_000 }));
  const row = await c.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ?").bind(job.id).first();
  assert.equal(row.status, "ready");
  assert.equal(row.reserved_bytes, 100_000);
  assert.equal(row.size_bytes, 100_000);
  assert.equal((await c.used()).audioBytes, 100_000);
});
