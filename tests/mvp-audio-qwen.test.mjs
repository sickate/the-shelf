import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_STYLE } from "../app/audio-text.mjs";
import {
  INFERENCE_URL,
  frameBytes,
  frameTag,
  MARKS_MAX_BYTES,
  TtsError,
  alignMarks,
  compactMarks,
  synthesizeQwenAudio,
} from "../app/audio-tts.mjs";
import { ORIGIN, setup } from "./helpers/mvp-fixture.mjs";
import { drain, fakeSynth, fakeWorkflows, mp3Frames } from "./helpers/audio-fixture.mjs";

// ---------------- fake DashScope sockets ----------------

const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** Inference-protocol socket; `script(ev, ws)` reacts to each sent JSON message. */
function inferenceSocket(script) {
  const listeners = {};
  const ws = {
    sent: [],
    closed: false,
    accept() {},
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    emit(type, ev) {
      for (const fn of listeners[type] ?? []) fn(ev);
    },
    json(o) {
      ws.emit("message", { data: JSON.stringify(o) });
    },
    binary(u8) {
      ws.emit("message", { data: buf(u8) });
    },
    send(raw) {
      const ev = JSON.parse(raw);
      ws.sent.push(ev);
      setTimeout(() => script(ev, ws), 0);
    },
    close() {
      ws.closed = true;
    },
  };
  return ws;
}

const ev = (event, payload = {}, extra = {}) => ({ header: { task_id: "t", event, ...extra }, payload });
const sentence = (type, words, index = 0) => ev("result-generated", { output: { type, sentence: { index, words } } });

/** Words like the service sends: one per CJK char / English word, punctuation glued to the next word. */
function serviceWords(text, stepMs = 100) {
  const words = [];
  let pending = "";
  for (const m of text.matchAll(/[A-Za-z']+|[\p{L}\p{N}]|[^\p{L}\p{N}]/gu)) {
    const t = m[0];
    if (/[\p{L}\p{N}]/u.test(t)) {
      words.push({ text: pending + t, begin_index: words.length, end_index: words.length + 1, begin_time: 80 + words.length * stepMs, end_time: 0 });
      pending = "";
    } else pending += t === "," ? "，" : t;
  }
  if (pending && words.length) words.at(-1).text += pending;
  return words;
}

/** A successful task: audio in two binary frames, growing word lists, sentence-end, task-finished. */
const okScript = (audio, { usage = 51, words } = {}) => (e, ws) => {
  if (e.header.action === "run-task") ws.json(ev("task-started"));
  if (e.header.action === "finish-task") {
    const text = ws.sent.find((x) => x.header.action === "continue-task").payload.input.text;
    const w = words ?? serviceWords(text);
    ws.json(sentence("sentence-begin", w.slice(0, 1)));
    ws.binary(audio.subarray(0, 100));
    ws.json(sentence("sentence-synthesis", w.slice(0, Math.ceil(w.length / 2))));
    ws.json(sentence("sentence-synthesis", [])); // empty pushes happen too
    ws.binary(audio.subarray(100));
    ws.json(sentence("sentence-end", w));
    ws.json(ev("task-finished", { output: {}, usage: { characters: usage } }));
  }
};

function fetchWith(script) {
  const fetchImpl = async (url, init) => {
    fetchImpl.seen.push({ url, auth: init.headers.Authorization, upgrade: init.headers.Upgrade });
    return { status: 101, webSocket: (fetchImpl.ws = inferenceSocket(fetchImpl.script)) };
  };
  fetchImpl.seen = [];
  fetchImpl.script = script;
  return fetchImpl;
}

// ---------------- client ----------------

test("qwen-audio client: run-task → continue → finish, binary frames, usage and marks", async () => {
  const audio = mp3Frames(Array(50).fill(8), { id3: 20 });
  const fetchImpl = fetchWith(okScript(audio));
  const text = "他说：你好, world! 今天\n第二段。";
  const r = await synthesizeQwenAudio("sk-test", { text, voice: "xunanchuan_v3.1", instruction: "温和的语气" }, { fetchImpl, uuid: () => "uuid-1" });
  assert.deepEqual(fetchImpl.seen, [{ url: INFERENCE_URL, auth: "Bearer sk-test", upgrade: "websocket" }]);
  assert.equal(INFERENCE_URL, "https://dashscope.aliyuncs.com/api-ws/v1/inference");
  const sent = fetchImpl.ws.sent;
  assert.deepEqual(sent.map((e) => e.header.action), ["run-task", "continue-task", "finish-task"]);
  assert.ok(sent.every((e) => e.header.task_id === "uuid-1" && e.header.streaming === "duplex"));
  const run = sent[0].payload;
  assert.deepEqual([run.task_group, run.task, run.function, run.model], ["audio", "tts", "SpeechSynthesizer", "qwen-audio-3.1-tts-flash"]);
  assert.deepEqual(run.parameters, {
    text_type: "PlainText",
    voice: "xunanchuan_v3.1",
    format: "mp3",
    sample_rate: 24000,
    bit_rate: 64,
    volume: 50,
    rate: 1,
    pitch: 1,
    word_timestamp_enabled: true,
    instruction: "温和的语气",
  });
  assert.equal(sent[1].payload.input.text, text); // one continue-task, newlines kept
  assert.deepEqual(r.audio, audio);
  assert.equal(r.billedChars, 51);
  assert.equal(r.durationMs, 50 * 24);
  assert.equal(r.frames, 2);
  assert.equal(fetchImpl.ws.closed, true);
  // Marks: every word located, offsets into `text`, both increasing.
  const words = serviceWords(text);
  assert.equal(r.marks.length, words.length * 2);
  assert.deepEqual(r.marks.slice(0, 6), [0, 80, 1, 180, 3, 280]); // 他 说 你
  assert.equal(text.slice(r.marks[8], r.marks[8] + 5), "world");
  assert.equal(text.slice(r.marks[12], r.marks[12] + 1), "天");
  for (let i = 2; i < r.marks.length; i += 2) assert.ok(r.marks[i] > r.marks[i - 2] && r.marks[i + 1] >= r.marks[i - 1]);

  // No instruction for tone plain.
  await synthesizeQwenAudio("k", { text: "好" }, { fetchImpl });
  assert.equal("instruction" in fetchImpl.ws.sent[0].payload.parameters, false);
});

test("qwen-audio client failures", async () => {
  const audio = mp3Frames([8, 8, 8]);
  const fetchImpl = fetchWith(null);
  const rejects = (code, opts = {}) =>
    assert.rejects(synthesizeQwenAudio("sk-abcdefghijklmnopqrstuvwx", { text: "x" }, { fetchImpl, ...opts }), (e) => {
      assert.ok(e instanceof TtsError);
      assert.equal(e.code, code);
      assert.ok(!e.message.includes("sk-"));
      return true;
    });
  // task-failed: error code sanitized, key never in the error.
  fetchImpl.script = (e, ws) =>
    e.header.action === "run-task" && ws.json(ev("task-failed", {}, { error_code: "InvalidParameter sk-abcdefghijklmnopqrstuvwx!", error_message: "bad" }));
  await rejects("tts_error_InvalidParameter");
  // Closed without task-finished (audio already received).
  fetchImpl.script = (e, ws) => {
    if (e.header.action === "run-task") ws.json(ev("task-started"));
    if (e.header.action === "finish-task") {
      ws.binary(audio);
      ws.emit("close", { code: 1006 });
    }
  };
  await rejects("tts_closed_1006");
  fetchImpl.script = (e, ws) => {
    if (e.header.action === "run-task") ws.json(ev("task-started"));
    if (e.header.action === "finish-task") ws.emit("error", {});
  };
  await rejects("tts_ws_error");
  // Overall timeout (started, never finished) and handshake timeout (never started).
  const fast = (match) => ({
    setTimeout: (fn, ms) => setTimeout(fn, match(ms) ? 5 : 60_000),
    clearTimeout: (h) => clearTimeout(h),
  });
  fetchImpl.script = (e, ws) => e.header.action === "run-task" && ws.json(ev("task-started"));
  await rejects("tts_timeout", { timers: fast((ms) => ms === 90_000) });
  // Handshake timeout reports the upgrade status and how many frames arrived (none / an unparsable one).
  fetchImpl.script = () => {};
  await rejects("tts_handshake_timeout_s101_f0", { timers: fast((ms) => ms < 90_000) });
  fetchImpl.script = (e, ws) => e.header.action === "run-task" && ws.binary(new Uint8Array([1, 2, 3]));
  await rejects("tts_handshake_timeout_s101_f1", { timers: fast((ms) => ms < 90_000) });
  // Finished without audio / not MP3.
  fetchImpl.script = (e, ws) => {
    if (e.header.action === "run-task") ws.json(ev("task-started"));
    if (e.header.action === "finish-task") ws.json(ev("task-finished", { usage: { characters: 1 } }));
  };
  await rejects("tts_no_audio_b0_none_j2");
  // Unrecognized binary frame types are counted and tagged.
  fetchImpl.script = (e, ws) => {
    if (e.header.action === "run-task") ws.json(ev("task-started"));
    if (e.header.action === "finish-task") {
      ws.emit("message", { data: { foo: 1 } });
      ws.emit("message", { data: { foo: 2 } });
      ws.json(ev("task-finished", { usage: { characters: 1 } }));
    }
  };
  await rejects("tts_no_audio_b2_object_j2");
  fetchImpl.script = okScript(new TextEncoder().encode("RIFF0000WAVEfmt " + "x".repeat(200)));
  await rejects("tts_bad_audio");
  fetchImpl.script = okScript(new Uint8Array([0xff, 0xf3, 0xf0, 0, ...new Uint8Array(300)])); // sync but no valid frame
  await rejects("tts_bad_audio");
  // Upgrade refused / network.
  await rejects("tts_upgrade_401", { fetchImpl: async () => ({ status: 401 }) });
  await rejects("tts_connect_failed", { fetchImpl: async () => Promise.reject(new TypeError("net")) });
});

// ---------------- marks ----------------

test("marks alignment: mixed zh/en, glued punctuation, spaces, number readings", () => {
  // Observed Q1 words (normalized text: full-width punctuation, "’", 2026 read as 二零二六).
  const text = '2026年10月，Alice说："Hello, world!" 她笑了。\nThe weather is nice. let\'s go！';
  const words = [
    ["二", 160], ["零", 320], ["二", 480], ["六", 560], ["年", 640], ["十", 880], ["月", 1120],
    ["，Alice", 1760], ["说", 2080], ["：“Hello", 2400], ["， world", 2880], ["！”她", 3680], ["笑", 3920], ["了", 4160],
    ["。The", 4640], [" weather", 4880], [" is", 5100], [" nice", 5300], [".let", 6000], ["’s go！", 6300],
  ].map(([t, ms], i) => ({ text: t, begin_index: i, end_index: i + 1, begin_time: ms, end_time: ms + 100 }));
  const marks = alignMarks(text, words);
  const at = (o) => text.slice(o, o + 5);
  const pairs = [];
  for (let i = 0; i < marks.length; i += 2) pairs.push([at(marks[i]), marks[i + 1]]);
  assert.deepEqual(pairs, [
    ["2026年", 160], // text before the first located word starts with the first word
    ["年10月，", 640],
    ["月，Ali", 1120],
    ["Alice", 1760],
    ['说："He', 2080],
    ["Hello", 2400],
    ["world", 2880],
    ["她笑了。\n", 3680],
    ["笑了。\nT", 3920],
    ["了。\nTh", 4160],
    ["The w", 4640],
    ["weath", 4880],
    ["is ni", 5100],
    ["nice.", 5300],
    ["let's", 6000],
    ["s go！", 6300],
  ]);
  for (let i = 2; i < marks.length; i += 2) assert.ok(marks[i] > marks[i - 2] && marks[i + 1] >= marks[i - 1]);
  // Unknown words are skipped without losing sync; decreasing times and garbage are dropped.
  assert.deepEqual(alignMarks("甲乙丙", [{ text: "甲", begin_time: 10 }, { text: "X", begin_time: 20 }, { text: "乙", begin_time: 5 }, { text: "丙", begin_time: 30 }, null, { text: "", begin_time: 1 }]), [0, 10, 2, 30]);
  assert.deepEqual(alignMarks("abc", "x"), []);
  assert.deepEqual(alignMarks("", [{ text: "a", begin_time: 1 }]), []);
  // Astral chars: UTF-16 offsets.
  assert.deepEqual(alignMarks("😀好𠀀", [{ text: "好", begin_time: 1 }, { text: "𠀀", begin_time: 2 }]), [0, 1, 2, 1, 3, 2]);
});

test("marks: linear time on long input, compacted to ≤ 2 KB", () => {
  const text = "这是一段很长的测试文字，用来检查标记的大小。".repeat(60); // 1,320 chars
  const words = [...text].filter((c) => /\p{L}/u.test(c)).map((c, i) => ({ text: c, begin_time: i * 150 }));
  const t0 = performance.now();
  const marks = alignMarks(text, words);
  assert.ok(performance.now() - t0 < 200);
  assert.equal(marks.length, words.length * 2);
  assert.ok(JSON.stringify(marks).length > MARKS_MAX_BYTES);
  const c = compactMarks(text, marks);
  assert.ok(JSON.stringify(c).length <= MARKS_MAX_BYTES && c.length >= 20);
  assert.equal(c[0], 0);
  for (let i = 2; i < c.length; i += 2) assert.ok(c[i] > c[i - 2] && c[i + 1] >= c[i - 1]);
  // Short lists are unchanged.
  assert.deepEqual(compactMarks("ab", [0, 1, 1, 2]), [0, 1, 1, 2]);
});

// ---------------- API and workflow ----------------

async function audioSetup(t) {
  const ctx = await setup(t, { SESSION_SECRET: "s".repeat(32) });
  ctx.env.DASHSCOPE_KEY = "dash-test";
  ctx.env.AUDIO_WORKFLOW = fakeWorkflows();
  const cookie = await ctx.login();
  const book = (await (await ctx.upload(cookie, "01-测试/朗读.pdf", new TextEncoder().encode("%PDF-1.4 q"))).json()).book;
  const owner = (path, init = {}) => ctx.fetch(path, { ...init, headers: { Origin: ORIGIN, Cookie: cookie, ...(init.headers ?? {}) } });
  const create = (body) => owner(`/api/books/${book.id}/audio`, { method: "POST", body: JSON.stringify(body) });
  const find = (q) => owner(`/api/books/${book.id}/audio?${new URLSearchParams(q)}`);
  const getJob = async (id) => (await (await owner(`/api/audio/${id}`)).json()).job;
  return { ...ctx, cookie, book, owner, create, find, getJob };
}

const TEXT = "第一段，Alice 说你好。今天天气很好。\n\n第二段 has some English words. 结束了。";

test("tone: validation, dedupe key, find filters; legacy voices map to the default", async (t) => {
  const c = await audioSetup(t);
  const bad = async (body, error) => {
    const res = await c.create(body);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error });
  };
  await bad({ chapterKey: "k", text: "y", tone: "loud" }, "bad_tone");
  await bad({ chapterKey: "k", text: "y", tone: 1 }, "bad_tone");
  await bad({ chapterKey: "k", text: "y", voice: "Nobody" }, "bad_voice");

  const auto = await c.create({ chapterKey: "ch", label: "章", text: TEXT });
  assert.equal(auto.status, 201);
  const a = (await auto.json()).job;
  assert.deepEqual([a.voice, a.tone, a.ttsModel], ["xunanchuan_v3.1", "auto", "qwen-audio-3.1-tts-flash"]);
  const plain = await c.create({ chapterKey: "ch", label: "章", text: TEXT, tone: "plain" });
  assert.equal(plain.status, 201);
  const p = (await plain.json()).job;
  assert.notEqual(p.id, a.id);
  assert.equal(p.tone, "plain");
  // Same key again: the existing job. A legacy voice maps to the default voice (no 400).
  const dup = await (await c.create({ chapterKey: "ch", label: "章", text: TEXT, tone: "plain", voice: "Cherry" })).json();
  assert.deepEqual([dup.duplicate, dup.job.id], [true, p.id]);
  const other = await (await c.create({ chapterKey: "ch", label: "章", text: TEXT, voice: "longanlingxin_v3.1" })).json();
  assert.equal(other.duplicate, false);

  // find: latest without filters; filtered by voice / tone; 404 when nothing matches; 400 for bad filters.
  assert.equal((await (await c.find({ chapterKey: "ch" })).json()).job.id, other.job.id);
  assert.equal((await (await c.find({ chapterKey: "ch", tone: "plain" })).json()).job.id, p.id);
  assert.equal((await (await c.find({ chapterKey: "ch", voice: "xunanchuan_v3.1", tone: "auto" })).json()).job.id, a.id);
  assert.equal((await (await c.find({ chapterKey: "ch", voice: "longanlingxin_v3.1" })).json()).job.id, other.job.id);
  assert.equal((await c.find({ chapterKey: "ch", voice: "longanfengyue_v3.1" })).status, 404);
  assert.equal((await c.find({ chapterKey: "ch", voice: "Cherry" })).status, 404);
  assert.equal((await c.find({ chapterKey: "ch", voice: "Nobody" })).status, 400);
  assert.equal((await c.find({ chapterKey: "ch", tone: "x" })).status, 400);

  // Regenerate: tone switch on the same voice; a legacy voice maps to the default voice.
  const sw = await c.owner(`/api/audio/${other.job.id}/regenerate`, { method: "POST", body: JSON.stringify({ tone: "plain" }) });
  assert.equal(sw.status, 201);
  assert.deepEqual([(await sw.json()).job.voice], ["longanlingxin_v3.1"]);
  const old = await c.owner(`/api/audio/${a.id}/regenerate`, { method: "POST", body: JSON.stringify({ voice: "Cherry", tone: "plain" }) });
  assert.equal(old.status, 200); // the live plain job of the default voice is reused
  assert.equal((await old.json()).job.id, p.id);
  assert.equal((await c.owner(`/api/audio/${a.id}/regenerate`, { method: "POST", body: JSON.stringify({ tone: "x" }) })).status, 400);
  assert.equal((await c.owner(`/api/audio/${a.id}/regenerate`, { method: "POST", body: JSON.stringify({ voice: "X" }) })).status, 400);

  // Visitors: 401 for find with filters and regenerate.
  assert.equal((await c.fetch(`/api/books/${c.book.id}/audio?chapterKey=ch&tone=plain`)).status, 401);
  assert.equal((await c.fetch(`/api/audio/${a.id}/regenerate`, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" })).status, 401);
});

test("workflow: instruction only for tone auto; marks stored and returned", async (t) => {
  const c = await audioSetup(t);
  const synth = fakeSynth({ marksFor: (text) => [0, 0, Math.min(2, text.length - 1), 150] });
  const a = (await (await c.create({ chapterKey: "ch", text: TEXT })).json()).job;
  const p = (await (await c.create({ chapterKey: "ch", text: TEXT, tone: "plain" })).json()).job;
  await drain(c.env, synth);
  const jobs = Object.fromEntries(
    await Promise.all([a, p].map(async (j) => [j.tone, await c.getJob(j.id)])),
  );
  assert.equal(jobs.auto.status, "ready");
  assert.equal(jobs.plain.status, "ready");
  assert.ok(synth.calls.every((x) => x.model === "qwen-audio-3.1-tts-flash"));
  const autoCalls = synth.calls.slice(0, jobs.auto.totalPieces);
  const plainCalls = synth.calls.slice(jobs.auto.totalPieces);
  assert.ok(autoCalls.length > 0 && autoCalls.every((x) => x.instruction === DEFAULT_STYLE));
  assert.ok(plainCalls.length > 0 && plainCalls.every((x) => x.instruction === null));
  for (const j of Object.values(jobs)) {
    const pieces = j.segments.flatMap((s) => s.pieces);
    assert.ok(pieces.every((q) => Array.isArray(q.marks) && q.marks[0] === 0 && q.marks[3] === 150));
  }
  const raw = await c.db.prepare("SELECT marks FROM audio_pieces WHERE job_id = ? LIMIT 1").bind(a.id).first();
  assert.equal(typeof raw.marks, "string");
});

/** Answers both DashScope protocols: realtime (legacy) and inference (qwen-audio). */
function dualFetch(audio) {
  const calls = [];
  const fetchImpl = async (url) => {
    if (url === INFERENCE_URL) {
      const ws = inferenceSocket(okScript(audio));
      calls.push({ url, ws });
      return { status: 101, webSocket: ws };
    }
    const listeners = {};
    const ws = {
      sent: [],
      accept() {
        setTimeout(() => ws.emit("message", { data: JSON.stringify({ type: "session.created" }) }), 0);
      },
      addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
      emit: (type, e) => (listeners[type] ?? []).forEach((fn) => fn(e)),
      send(raw) {
        const e = JSON.parse(raw);
        ws.sent.push(e);
        const msg = (o) => setTimeout(() => ws.emit("message", { data: JSON.stringify(o) }), 0);
        if (e.type === "session.update") msg({ type: "session.updated" });
        if (e.type === "session.finish") {
          msg({ type: "response.audio.delta", delta: Buffer.from(audio).toString("base64") });
          msg({ type: "response.done", response: { status: "completed", usage: { characters: 4 } } });
          msg({ type: "session.finished" });
        }
      },
      close() {},
    };
    calls.push({ url, ws });
    return { status: 101, webSocket: ws };
  };
  return { fetchImpl, calls };
}

test("a job from before 0008 (tts_model NULL) still synthesizes with the realtime client", async (t) => {
  const c = await audioSetup(t);
  const legacy = (await (await c.create({ chapterKey: "old", text: TEXT })).json()).job;
  await c.db.prepare("UPDATE audio_jobs SET tts_model = NULL, voice = 'Cherry' WHERE id = ?").bind(legacy.id).run();
  const fresh = (await (await c.create({ chapterKey: "new", text: TEXT })).json()).job;
  const { fetchImpl, calls } = dualFetch(mp3Frames(Array(40).fill(8)));
  await drain(c.env, { fetchImpl });
  const old = await c.getJob(legacy.id);
  const now = await c.getJob(fresh.id);
  assert.equal(old.status, "ready", old.error);
  assert.equal(now.status, "ready", now.error);
  assert.deepEqual([old.ttsModel, old.voice, old.tone], ["qwen3-tts-flash-realtime", "Cherry", "auto"]);
  assert.equal(now.ttsModel, "qwen-audio-3.1-tts-flash");
  const realtime = calls.filter((x) => x.url.includes("/realtime?model=qwen3-tts-flash-realtime"));
  const inference = calls.filter((x) => x.url === INFERENCE_URL);
  assert.equal(realtime.length, old.totalPieces);
  assert.equal(inference.length, now.totalPieces);
  assert.ok(realtime.every((x) => x.ws.sent[0].session.voice === "Cherry"));
  assert.ok(inference.every((x) => x.ws.sent[0].payload.parameters.voice === "xunanchuan_v3.1"));
  // Legacy pieces have no marks; new ones do (offsets into the piece text).
  assert.ok(old.segments.flatMap((s) => s.pieces).every((q) => !("marks" in q)));
  for (const q of now.segments.flatMap((s) => s.pieces)) {
    assert.ok(q.marks.length >= 2 && q.marks[0] === 0);
    for (let i = 0; i < q.marks.length; i += 2) assert.ok(q.marks[i] < q.text.length);
  }
  // Retrying the legacy job (old voice) creates a qwen-audio job with the default voice.
  const re = await c.owner(`/api/audio/${legacy.id}/regenerate`, { method: "POST", body: JSON.stringify({ voice: "Cherry" }) });
  assert.equal(re.status, 201);
  const j = (await re.json()).job;
  assert.deepEqual([j.voice, j.tone, j.ttsModel, j.style], ["xunanchuan_v3.1", "auto", "qwen-audio-3.1-tts-flash", old.style]);
});

// ---------------- migration ----------------

test("0008 migration: old rows default to auto / NULL model; the live unique key includes tone", async () => {
  const root = new URL("../app/", import.meta.url);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE books (id TEXT PRIMARY KEY, deleted_at TEXT)");
  db.exec(await readFile(new URL("migrations/0007_audio.sql", root), "utf8"));
  db.exec("INSERT INTO books (id) VALUES ('b1')");
  const insert = (id, tone) =>
    db
      .prepare(
        `INSERT INTO audio_jobs (id, book_id, chapter_key, source_sha256, voice, status, piece_chars, created_at, updated_at${tone ? ", tone" : ""})
         VALUES (?, 'b1', 'k', 's', 'Cherry', 'ready', 200, 'x', 'x'${tone ? ", ?" : ""})`,
      )
      .run(...(tone ? [id, tone] : [id]));
  insert("a_old");
  db.exec("INSERT INTO audio_pieces (job_id, seq, block, text, status, updated_at) VALUES ('a_old', 0, 0, 't', 'ready', 'x')");
  const migration = await readFile(new URL("migrations/0008_audio_tts.sql", root), "utf8");
  db.exec(migration);
  assert.deepEqual({ ...db.prepare("SELECT tone, tts_model FROM audio_jobs WHERE id = 'a_old'").get() }, { tone: "auto", tts_model: null });
  assert.equal(db.prepare("SELECT marks FROM audio_pieces").get().marks, null);
  assert.throws(() => insert("a_dup", "auto"), /UNIQUE/);
  insert("a_plain", "plain");
  assert.throws(() => insert("a_dup2", "plain"), /UNIQUE/);
  assert.throws(() => insert("a_bad", "loud"), /CHECK/);
  // Re-running only fails on the ALTERs (index statements are idempotent).
  assert.throws(() => db.exec(migration), /duplicate column/);
  db.exec(migration.split("\n").filter((l) => !l.startsWith("ALTER")).join("\n"));
  // schema.sql (fresh databases) has the same columns and index.
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(await readFile(new URL("schema.sql", root), "utf8"));
  for (const table of ["audio_jobs", "audio_pieces"]) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${table})`).all().map((r) => `${r.name}:${r.type}:${r.notnull}:${r.dflt_value}`).sort();
    assert.deepEqual(cols(fresh), cols(db), table);
  }
  const idx = (d) => d.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audio_jobs' ORDER BY name").all().map((r) => ({ ...r }));
  assert.deepEqual(idx(fresh), idx(db));
});

// ---------------- Workers frame types (2026-10-28 live failure: tts_no_audio) ----------------

test("binary frames: Blob, ArrayBuffer, views and JSON-as-binary, kept in arrival order", async () => {
  const audio = mp3Frames(Array(60).fill(8), { id3: 10 });
  const parts = [audio.subarray(0, 50), audio.subarray(50, 300), audio.subarray(300, 700), audio.subarray(700)];
  // A Blob whose read resolves late: later frames and task-finished must wait for it.
  const slowBlob = (u8) => {
    const b = new Blob([u8]);
    return { arrayBuffer: () => new Promise((r) => setTimeout(() => r(b.arrayBuffer()), 20)), size: u8.length };
  };
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  const fetchImpl = fetchWith((e, ws) => {
    if (e.header.action === "run-task") ws.emit("message", { data: buf(enc(ev("task-started"))) }); // JSON event as binary
    if (e.header.action === "finish-task") {
      ws.emit("message", { data: slowBlob(parts[0]) });
      ws.emit("message", { data: new Blob([parts[1]]) });
      ws.emit("message", { data: buf(parts[2]) });
      ws.emit("message", { data: new DataView(parts[3].buffer, parts[3].byteOffset, parts[3].byteLength) });
      ws.json(sentence("sentence-end", [{ text: "好", begin_time: 80 }]));
      ws.json(ev("task-finished", { usage: { characters: 2 } }));
      ws.emit("close", { code: 1000 });
    }
  });
  const r = await synthesizeQwenAudio("k", { text: "好" }, { fetchImpl });
  assert.deepEqual(r.audio, audio);
  assert.equal(r.frames, 4);
  assert.equal(r.durationMs, 60 * 24);
  assert.deepEqual(r.marks, [0, 80]);
  // A close that arrives while a Blob is still being read does not pre-empt task-finished.
  const late = fetchWith((e, ws) => {
    if (e.header.action === "run-task") ws.json(ev("task-started"));
    if (e.header.action === "finish-task") {
      ws.emit("message", { data: slowBlob(audio) });
      ws.json(ev("task-finished", { usage: { characters: 2 } }));
      ws.emit("close", { code: 1006 });
    }
  });
  assert.deepEqual((await synthesizeQwenAudio("k", { text: "好" }, { fetchImpl: late })).audio, audio);
});

test("frame helpers: duck-typed bytes and sanitized type tags", () => {
  const u8 = new Uint8Array([1, 2, 3]);
  assert.deepEqual(frameBytes(u8.buffer), u8);
  assert.deepEqual(frameBytes(new DataView(u8.buffer, 1, 2)), new Uint8Array([2, 3]));
  assert.deepEqual(frameBytes(new Uint16Array([0x0201])), new Uint8Array([1, 2]));
  assert.equal(frameBytes(new Blob([u8])), null);
  assert.equal(frameBytes(null), null);
  assert.equal(frameBytes("x"), null);
  assert.equal(frameTag(u8.buffer), "arraybuffer");
  assert.equal(frameTag(new Blob([u8])), "blob");
  assert.equal(frameTag(u8), "uint8array");
  assert.equal(frameTag({ [Symbol.toStringTag]: "Weird Type!<x>" }), "weirdtypex");
  assert.equal(frameTag(undefined), "undefined");
});

const LONG = ("这是一个足够长的句子，用来测试连接失败时不会降级" + "，继续".repeat(12) + "。").repeat(4);

test("qwen-audio jobs: tts_* connection errors retry without splitting or the global downgrade", async (t) => {
  const c = await audioSetup(t);
  const errors = ["tts_upgrade_520", "tts_handshake_timeout_s101_f0", "tts_no_audio_b0_none_j3", "tts_error_Throttling.RateQuota.exceeded"];
  let n = 0;
  const synth = fakeSynth({ fail: () => (n < 12 ? new Error(errors[n++ % errors.length]) : null) });
  const { job } = await (await c.create({ chapterKey: "long", text: LONG })).json();
  await drain(c.env, synth);
  const v = await c.getJob(job.id);
  const rows = (await c.db.prepare("SELECT status, error FROM audio_pieces WHERE job_id = ?").bind(job.id).all()).results;
  assert.ok(rows.every((r) => r.status !== "split"), JSON.stringify(rows));
  assert.equal(v.cpuDowngraded, false);
  assert.equal(v.pieceChars, 200);
  const settings = await c.db.prepare("SELECT piece_chars, downgrade_reason FROM audio_settings WHERE id = 1").first();
  assert.deepEqual({ ...settings }, { piece_chars: 200, downgrade_reason: null });
  // 3 rounds of 3 attempts all failed on the first piece → the job fails with the last code.
  assert.equal(v.status, "failed");
  assert.match(v.error, /^tts_failed: tts_/);
});

test("qwen-audio jobs: a real CPU-limit signal still splits; legacy jobs keep the repeated-failure rule", async (t) => {
  const c = await audioSetup(t);
  const cpu = fakeSynth({ fail: (s) => (s.length > 120 ? new Error("Worker exceeded CPU time limit.") : null) });
  const a = (await (await c.create({ chapterKey: "cpu", text: LONG })).json()).job;
  await drain(c.env, cpu);
  const va = await c.getJob(a.id);
  assert.equal(va.status, "ready");
  assert.equal(va.cpuDowngraded, true);
  assert.equal((await c.db.prepare("SELECT downgrade_reason FROM audio_settings WHERE id = 1").first()).downgrade_reason, "cpu_limit");

  // Legacy (tts_model NULL): two failed rounds of a connection error split the piece (A1 rule unchanged).
  await c.db.prepare("UPDATE audio_settings SET piece_chars = 200, downgrade_reason = NULL WHERE id = 1").run();
  const b = (await (await c.create({ chapterKey: "legacy", text: LONG })).json()).job;
  await c.db.prepare("UPDATE audio_jobs SET tts_model = NULL WHERE id = ?").bind(b.id).run();
  let drops = 6;
  const flaky = fakeSynth({ fail: () => (drops-- > 0 ? new Error("tts_closed_1006") : null) });
  await drain(c.env, flaky);
  const vb = await c.getJob(b.id);
  assert.equal(vb.status, "ready", vb.error);
  assert.equal(vb.cpuDowngraded, true);
  assert.equal((await c.db.prepare("SELECT downgrade_reason FROM audio_settings WHERE id = 1").first()).downgrade_reason, "repeated_failure");
});
