// B1 (docs/audio-fixes-plan-2026-10-28.md): no nested Workflow creation, CPU-limit classification,
// resume instead of redo, create dedupe, job view without parsing marks.
import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  MAX_FAILED_PIECES,
  MAX_PARTS,
  PIECE_RETRY_MS,
  audioCron,
  isCpuLimit,
  runAudioWorkflow,
} from "../app/worker.mjs";
import { nextSegmentIndex } from "../app/audio-text.mjs";
import { ORIGIN, setup } from "./helpers/mvp-fixture.mjs";
import { drain, fakeStep, fakeSynth, fakeWorkflows } from "./helpers/audio-fixture.mjs";

async function audioSetup(t) {
  const ctx = await setup(t, { SESSION_SECRET: "s".repeat(32) });
  const wf = fakeWorkflows();
  ctx.env.DASHSCOPE_KEY = "dash-test";
  ctx.env.AUDIO_WORKFLOW = wf;
  const cookie = await ctx.login();
  const book = (await (await ctx.upload(cookie, "01-测试/朗读.pdf", new TextEncoder().encode("%PDF-1.4 b1"))).json()).book;
  const owner = (path, init = {}) => ctx.fetch(path, { ...init, headers: { Origin: ORIGIN, Cookie: cookie, ...(init.headers ?? {}) } });
  const create = (body) => owner(`/api/books/${book.id}/audio`, { method: "POST", body: JSON.stringify(body) });
  const getJob = async (id) => (await (await owner(`/api/audio/${id}`)).json()).job;
  const row = (id) => ctx.db.prepare("SELECT * FROM audio_jobs WHERE id = ?").bind(id).first();
  const pieces = async (id) => (await ctx.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ? ORDER BY seq").bind(id).all()).results;
  return { ...ctx, wf, cookie, book, owner, create, getJob, row, pieces };
}

/** Fails the test if AUDIO_WORKFLOW.create is called while a Workflow body is running. */
function guardNested(wf) {
  let inside = 0;
  const create = wf.create.bind(wf);
  wf.create = async (arg) => {
    if (inside) throw new Error(`nested_create:${arg.id}`);
    return create(arg);
  };
  return async (fn) => {
    inside++;
    try {
      return await fn();
    } finally {
      inside--;
    }
  };
}

const LONG = Array.from({ length: 40 }, (_, i) => `第${i}句话，` + "内容".repeat(80) + "。").join("\n\n");

test("long jobs hand off without creating instances inside the Workflow; cron and GET start them idempotently", async (t) => {
  const c = await audioSetup(t);
  const inWorkflow = guardNested(c.wf);
  const synth = fakeSynth();
  const { job } = await (await c.create({ chapterKey: "long", text: LONG })).json();
  const run = async (id) => {
    const inst = c.wf.instances.get(id);
    inst.ran = true;
    return inWorkflow(() => runAudioWorkflow(c.env, { payload: inst.params }, fakeStep(), synth));
  };
  assert.equal(await run(`${job.id}-p0`), "continued");
  // Only the hand-off was recorded: no new instance yet.
  assert.deepEqual([...c.wf.instances.keys()], [`${job.id}-p0`]);
  assert.equal((await c.row(job.id)).next_part, 1);

  // The job GET (top level) starts part 1; repeated GETs and the cron do not duplicate it.
  const v = await c.getJob(job.id);
  assert.equal(v.status, "synthesizing");
  assert.deepEqual([...c.wf.instances.keys()], [`${job.id}-p0`, `${job.id}-p1`]);
  let r = await c.row(job.id);
  assert.deepEqual([r.next_part, r.workflow_id], [null, `${job.id}-p1`]);
  await c.getJob(job.id);
  assert.equal(await audioCron(c.env), 0);
  assert.equal(c.wf.instances.size, 2);

  // Part 1 hands off; an instance already created by a concurrent starter counts as started.
  assert.equal(await run(`${job.id}-p1`), "continued");
  assert.equal((await c.row(job.id)).next_part, 2);
  await c.wf.create({ id: `${job.id}-p2`, params: { jobId: job.id, part: 2 } });
  // The scheduled handler (Cron Trigger) runs audioCron.
  const waits = [];
  await worker.scheduled({ cron: "* * * * *" }, c.env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  r = await c.row(job.id);
  assert.deepEqual([r.next_part, r.workflow_id], [null, `${job.id}-p2`]);
  assert.equal(c.wf.instances.size, 3);

  // Create failures leave next_part for the next try.
  assert.equal(await run(`${job.id}-p2`), "continued");
  c.wf.failCreate = true;
  assert.equal(await audioCron(c.env), 0);
  assert.equal((await c.row(job.id)).next_part, 3);
  c.wf.failCreate = false;

  // Everything else via the cron path, still never nested.
  const runs = await drain(c.env, synth);
  assert.equal(runs.at(-1).result, "done");
  const done = await c.getJob(job.id);
  assert.equal(done.status, "ready");
  assert.equal(done.donePieces, 40);
  assert.equal((await c.row(job.id)).next_part, null);

  // Deleted jobs are not continued.
  const { job: j2 } = await (await c.create({ chapterKey: "long2", text: LONG })).json();
  assert.equal(await run(`${j2.id}-p0`), "continued");
  await c.owner(`/api/audio/${j2.id}`, { method: "DELETE" });
  assert.equal(await audioCron(c.env), 0);
  assert.ok(!c.wf.instances.has(`${j2.id}-p1`));
});

test("MAX_PARTS still bounds a job", async (t) => {
  const c = await audioSetup(t);
  const { job } = await (await c.create({ chapterKey: "long", text: LONG })).json();
  c.wf.instances.get(`${job.id}-p0`).ran = true;
  const result = await runAudioWorkflow(c.env, { payload: { jobId: job.id, part: MAX_PARTS } }, fakeStep(), fakeSynth());
  assert.equal(result, "continued");
  const r = await c.row(job.id);
  assert.deepEqual([r.status, r.error, r.next_part], ["failed", "too_many_parts", null]);
});

test("CPU downgrade only on a genuine CPU-limit signal", async (t) => {
  for (const yes of ["Worker exceeded CPU time limit.", "exceededCpu", "Error: exceeded CPU", "cpu_time_limit"]) assert.ok(isCpuLimit(yes), yes);
  for (const no of [
    "The request exceeded the maximum Workers subrequest depth (10034)",
    "put: The request exceeded the maximum Workers subrequest depth (10034)",
    "put: exceeded CPU time limit",
    "tts_error_Throttling.RateQuota.exceeded",
    "tts_handshake_timeout_s101_f0",
    "Too many subrequests; exceeded",
    "time limit",
    "resource limit",
    "network",
  ])
    assert.equal(isCpuLimit(no), false, no);

  // Live 2026-10-28: the R2 put failing with the subrequest depth error must not split or downgrade.
  const c = await audioSetup(t);
  const text = ("这是一个用于测试的长句子，内容足够长" + "，继续".repeat(20) + "。").repeat(3);
  const { job } = await (await c.create({ chapterKey: "depth", text })).json();
  const realPut = c.bucket.put.bind(c.bucket);
  let fails = 3; // one full round (1 + 2 step retries)
  c.bucket.put = async (key, value, opts) => {
    if (key.startsWith("audio/") && fails-- > 0) throw new Error("The request exceeded the maximum Workers subrequest depth (10034)");
    return realPut(key, value, opts);
  };
  await drain(c.env, fakeSynth());
  const v = await c.getJob(job.id);
  assert.equal(v.status, "ready");
  assert.equal(v.cpuDowngraded, false);
  assert.equal(v.pieceChars, 200);
  assert.ok((await c.pieces(job.id)).every((p) => p.status === "ready" && p.cpu_split === 0));
  const s = await c.db.prepare("SELECT piece_chars, downgrade_reason FROM audio_settings WHERE id = 1").first();
  assert.deepEqual({ ...s }, { piece_chars: 200, downgrade_reason: null });
});

test("a failing piece backs off 30 s / 2 min / 5 min, fails alone; retry resumes only it on the same job", async (t) => {
  const c = await audioSetup(t);
  const text = Array.from({ length: 5 }, (_, i) => `第${i}段，` + "文字".repeat(60) + "。").join("\n\n");
  let broken = true;
  const synth = fakeSynth({ fail: (s) => (broken && s.startsWith("第2段") ? new Error("tts_handshake_timeout_s101_f0") : null) });
  const { job } = await (await c.create({ chapterKey: "res", text })).json();
  const runs = await drain(c.env, synth);
  const failedPiece = synth.calls.filter((x) => x.text.startsWith("第2段"));
  assert.equal(failedPiece.length, 4 * 3); // 4 rounds × (1 + 2 step retries)
  assert.deepEqual(runs.flatMap((r) => r.sleeps), PIECE_RETRY_MS);
  assert.deepEqual(PIECE_RETRY_MS, [30_000, 120_000, 300_000]);

  // The job ends failed; the other pieces were still synthesized and stay playable.
  const v = await c.getJob(job.id);
  assert.equal(v.status, "failed");
  assert.match(v.error, /^tts_failed: tts_handshake_timeout_s101_f0/);
  const all = v.segments.flatMap((s) => s.pieces);
  assert.equal(all.length, 5);
  assert.equal(all.filter((p) => p.ready).length, 4);
  const ready = all.find((p) => p.ready);
  assert.equal((await c.owner(`/api/audio/${job.id}/pieces/${ready.seq}`)).status, 200);
  const before = await c.pieces(job.id);
  const failed = before.find((p) => p.status === "failed");
  assert.ok(failed.reserved_bytes > 0 && failed.size_bytes === null);
  const budget0 = (await (await c.owner("/api/budget")).json()).audioBytes;

  // Create on the same key returns the failed job (no new job, no new instance).
  const instances = c.wf.instances.size;
  const dup = await c.create({ chapterKey: "res", text });
  assert.equal(dup.status, 200);
  const dupBody = await dup.json();
  assert.deepEqual([dupBody.job.id, dupBody.duplicate], [job.id, true]);
  assert.equal(c.wf.instances.size, instances);

  // Retry (same voice and tone): the same job resumes; only the failed piece is synthesized again.
  broken = false;
  const calls = synth.calls.length;
  const res = await c.owner(`/api/audio/${job.id}/regenerate`, { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.job.id, body.resumed, body.job.error], [job.id, true, null]);
  assert.equal(body.job.status, "synthesizing");
  assert.equal(c.wf.instances.size, instances + 1); // started directly (top-level request)
  // A second click while it runs neither resumes again nor starts another instance.
  const again = await (await c.owner(`/api/audio/${job.id}/regenerate`, { method: "POST", body: "{}" })).json();
  assert.equal(again.resumed, false);
  assert.equal(c.wf.instances.size, instances + 1);
  await drain(c.env, synth);
  assert.deepEqual(synth.calls.slice(calls).map((x) => x.text), [failed.text]);
  const after = await c.pieces(job.id);
  const done = await c.getJob(job.id);
  assert.equal(done.status, "ready");
  assert.equal(done.error, null);
  // Ready pieces untouched; the failed piece reused its reservation (no double reservation).
  for (const p of before.filter((x) => x.status === "ready"))
    assert.deepEqual({ ...after.find((x) => x.seq === p.seq) }, { ...p });
  const healed = after.find((x) => x.seq === failed.seq);
  assert.equal(healed.reserved_bytes, failed.reserved_bytes);
  const budget1 = (await (await c.owner("/api/budget")).json()).audioBytes;
  assert.equal(budget1, budget0 - failed.reserved_bytes + healed.size_bytes);
  // No soft-deleted copy was created.
  const { n } = await c.db.prepare("SELECT COUNT(*) AS n FROM audio_jobs WHERE chapter_key = 'res'").first();
  assert.equal(n, 1);
});

test("systemic failures stop the job after MAX_FAILED_PIECES; retry resumes the rest", async (t) => {
  const c = await audioSetup(t);
  const text = Array.from({ length: 8 }, (_, i) => `第${i}段，` + "文字".repeat(60) + "。").join("\n\n");
  let broken = true;
  const synth = fakeSynth({ fail: () => (broken ? new Error("tts_error_InvalidApiKey") : null) });
  const { job } = await (await c.create({ chapterKey: "sys", text })).json();
  await drain(c.env, synth);
  const rows = await c.pieces(job.id);
  assert.equal(rows.filter((p) => p.status === "failed").length, MAX_FAILED_PIECES);
  assert.equal(rows.filter((p) => p.status === "pending").length, 8 - MAX_FAILED_PIECES);
  assert.equal((await c.getJob(job.id)).status, "failed");
  broken = false;
  await c.owner(`/api/audio/${job.id}/regenerate`, { method: "POST", body: "{}" });
  await drain(c.env, synth);
  const v = await c.getJob(job.id);
  assert.equal(v.status, "ready");
  assert.equal(v.donePieces, 8);
});

test("budget_exceeded resumes in place too; switching to another key with a failed job resumes it", async (t) => {
  const c = await audioSetup(t);
  const { job } = await (await c.create({ chapterKey: "b", text: "一句话。" })).json();
  await c.db
    .prepare(
      "INSERT INTO books (id, title, category, format, size_bytes, r2_key, source_path, status, created_at) VALUES ('b_fill','f','c','PDF',?, 'books/fill','f.pdf','uploaded','2026')",
    )
    .bind(7_900_000_000 - 30)
    .run();
  await drain(c.env, fakeSynth());
  assert.equal((await c.getJob(job.id)).status, "budget_exceeded");
  await c.db.prepare("DELETE FROM books WHERE id = 'b_fill'").run();
  const res = await (await c.owner(`/api/audio/${job.id}/regenerate`, { method: "POST", body: "{}" })).json();
  assert.equal(res.resumed, true);
  await drain(c.env, fakeSynth());
  assert.equal((await c.getJob(job.id)).status, "ready");

  // Another tone whose job failed: regenerate returns and resumes that job instead of replacing it.
  const synth = fakeSynth({ fail: () => new Error("tts_closed_1006") });
  const plain = (await (await c.create({ chapterKey: "b", text: "一句话。", tone: "plain" })).json()).job;
  await drain(c.env, synth);
  assert.equal((await c.getJob(plain.id)).status, "failed");
  const sw = await c.owner(`/api/audio/${job.id}/regenerate`, { method: "POST", body: JSON.stringify({ tone: "plain" }) });
  assert.equal(sw.status, 200);
  const swb = await sw.json();
  assert.deepEqual([swb.job.id, swb.reused, swb.resumed], [plain.id, true, true]);
  await drain(c.env, fakeSynth());
  assert.equal((await c.getJob(plain.id)).status, "ready");
});

/** The job view as built before B1 (JSON.parse of every piece's marks). */
function referenceView(job, rows) {
  const segs = [];
  let seg = null;
  let segMs = 0;
  for (const p of rows) {
    const ready = p.status === "ready" && p.segment !== null && p.duration_ms !== null;
    const d = ready ? p.duration_ms : Math.max(0, p.est_ms ?? 0);
    const s = ready ? p.segment : nextSegmentIndex(seg, segMs, d);
    segMs = s === seg ? segMs + d : d;
    seg = s;
    const out = (segs[s] ??= { index: s, durationMs: 0, pieces: [] });
    const piece = { seq: p.seq, durationMs: d, ready, text: p.text ?? "" };
    if (ready && p.marks) {
      try {
        const marks = JSON.parse(p.marks);
        if (Array.isArray(marks) && marks.length) piece.marks = marks;
      } catch {}
    }
    out.pieces.push(piece);
    out.durationMs += d;
  }
  return {
    id: job.id,
    status: job.status,
    voice: job.voice,
    tone: job.tone === "plain" ? "plain" : "auto",
    ttsModel: job.tts_model ?? "qwen3-tts-flash-realtime",
    chapterLabel: job.chapter_label ?? "",
    style: job.style ?? null,
    estSeconds: job.est_seconds ?? null,
    donePieces: job.done_pieces ?? 0,
    totalPieces: job.total_pieces ?? 0,
    error: job.error ?? null,
    segments: segs.filter(Boolean).map((s, index) => ({ ...s, index })),
    pieceChars: job.piece_chars,
    cpuDowngraded: Boolean(job.cpu_downgraded),
    llmFallbackBlocks: job.llm_fallback_blocks ?? 0,
    billedChars: job.billed_chars ?? 0,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

test("job view splices stored marks (≥ 150 pieces): identical output, no JSON.parse of marks", async (t) => {
  const c = await audioSetup(t);
  const { job } = await (await c.create({ chapterKey: "view", label: "长“章”\\节", text: "一句话。" })).json();
  await c.db.prepare("DELETE FROM audio_pieces WHERE job_id = ?").bind(job.id).run();
  const N = 160;
  const insert = c.db.prepare(
    `INSERT INTO audio_pieces (job_id, seq, block, segment, text, est_ms, status, duration_ms, marks, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'x')`,
  );
  const marksOf = (i) => JSON.stringify(Array.from({ length: 160 }, (_, k) => (k % 2 ? k * 37 + i : k)));
  for (let i = 0; i < N; i++) {
    const ready = i < 120;
    // Variety: ready with marks, ready without, empty / malformed marks, pending, split, quotes in text.
    const marks = !ready ? null : i % 10 === 3 ? null : i % 10 === 5 ? "[]" : i % 10 === 7 ? "[1,2" : marksOf(i);
    const status = i === 130 ? "split" : ready ? "ready" : i === 140 ? "failed" : "pending";
    await insert
      .bind(job.id, i * 16, ready ? Math.floor(i / 50) : null, `第${i}片 “引号” \\ 反斜杠\n换行 ${"字".repeat(i % 7)}`, 30_000 + i, status, ready ? 40_000 + i : null, marks)
      .run();
  }
  await c.db.prepare("UPDATE audio_jobs SET style = ?, error = ?, done_pieces = 120, total_pieces = 159 WHERE id = ?").bind('带"引号"的语气', "x y", job.id).run();
  const row = await c.row(job.id);
  const rows = (await c.db.prepare("SELECT * FROM audio_pieces WHERE job_id = ? AND status != 'split' ORDER BY seq").bind(job.id).all()).results;
  const stored = new Set(rows.map((r) => r.marks).filter(Boolean));

  const parse = JSON.parse;
  const parsedMarks = [];
  JSON.parse = function (text, ...rest) {
    if (typeof text === "string" && stored.has(text)) parsedMarks.push(text);
    return parse.call(this, text, ...rest);
  };
  let res;
  try {
    res = await c.owner(`/api/audio/${job.id}`);
  } finally {
    JSON.parse = parse;
  }
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const raw = await res.text();
  assert.deepEqual(parsedMarks, []);
  const got = parse(raw);
  assert.deepEqual(got, { job: referenceView(row, rows) });
  // Byte-identical to stringifying the reference view (same key order).
  assert.equal(raw, JSON.stringify({ job: referenceView(row, rows) }));
  assert.ok(got.job.segments.flatMap((s) => s.pieces).length >= 150);
  // Find returns the same view.
  const found = await (await c.owner(`/api/books/${c.book.id}/audio?chapterKey=view`)).text();
  assert.equal(found, raw);
});
