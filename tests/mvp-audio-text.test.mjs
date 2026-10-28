import test from "node:test";
import assert from "node:assert/strict";
import {
  SEGMENT_MAX_MS,
  assignSegments,
  chunkBlocks,
  codePoints,
  estimateMs,
  nextSegmentIndex,
  precleanText,
  splitPieces,
  splitSentences,
  validateCleanup,
  validateStyle,
  DEFAULT_STYLE,
} from "../app/audio-text.mjs";
import { mp3Info, looksLikeMp3, synthesize, TtsError, ttsModel, isInstructModel } from "../app/audio-tts.mjs";
import { mp3Frames } from "./helpers/audio-fixture.mjs";

test("pre-clean removes footnotes, references, URLs and symbol lines", () => {
  const cases = [
    ["他说[1]：你好[12]。", "他说：你好。"],
    ["正文[注1]继续【注】。", "正文继续。"],
    ["第一①第二⑳第三⑴。", "第一第二第三。"],
    ["结论¹²成立³。", "结论成立。"],
    ["重要※事项†。", "重要事项。"],
    ["访问 https://example.com/a?b=1 获取。", "访问 获取。"],
    ["See https://example.com/x. Next.", "See. Next."],
    ["写信到 someone@example.org 即可。", "写信到 即可。"],
    ["正文（见第 3 页）继续。", "正文继续。"],
    ["正文（参见第二章）继续。", "正文继续。"],
    ["As shown (see p. 12), it works.", "As shown, it works."],
    ["The claim (pp. 3–5) holds.", "The claim holds."],
    ["引文（同上，第3页）结束。", "引文结束。"],
    ["引文（同上）结束。", "引文结束。"],
    ["Quote (ibid., p. 4) ends.", "Quote ends."],
    ["观点（张三，2001，第 5 页）如此。", "观点如此。"],
    ["The result (Smith, 2001) holds.", "The result holds."],
    ["The result (Smith and Lee 2003: 45) holds.", "The result holds."],
    ["如下（图 3-1）所示。", "如下所示。"],
    ["Results (Table 2) differ.", "Results differ."],
  ];
  for (const [input, expected] of cases) assert.equal(precleanText(input), expected, input);
  // Page-number and symbol-only lines.
  assert.equal(precleanText("第一段\n12\n- 23 -\n第 4 页\nPage 5 of 9\n——————\n* * *\n第二段"), "第一段\n第二段");
});

test("pre-clean keeps ordinary parentheses and content", () => {
  const keep = [
    "他（指张三）来了。",
    "这件事发生在（1949 年）秋天。",
    "He left in 1990 (in March 2001).",
    "面积是 5 m²，体积 3 cm³。",
    "Use f(x) = x + 1 (the identity plus one).",
    "第一章 开始",
    "1984",
  ];
  for (const s of keep) assert.equal(precleanText(s), s === "1984" ? "" : s, s);
  // A year line alone is indistinguishable from a page number; inside a sentence it stays.
  assert.equal(precleanText("他生于 1984 年。"), "他生于 1984 年。");
});

test("LLM cleanup validation accepts deletions, rejects over-deletion, rewriting and additions", () => {
  const input = "这是一段正文，讲述了一个很长的故事。注：本段引自某书第三页。故事继续发展，人物逐渐增多。".repeat(6);
  const deleted = "这是一段正文，讲述了一个很长的故事。故事继续发展，人物逐渐增多。".repeat(6);
  assert.equal(validateCleanup(input, deleted).ok, true);
  assert.equal(validateCleanup(input, input).ok, true);
  // A few verbalized symbols are within the 5% allowance.
  assert.equal(validateCleanup("增长了 50% 左右，" + "后面是很长的正文内容。".repeat(10), "增长了 50 百分之左右，" + "后面是很长的正文内容。".repeat(10)).ok, true);
  assert.equal(validateCleanup(input, input.slice(0, Math.floor(input.length * 0.4))).reason, "over_deleted");
  assert.equal(validateCleanup(input, input + "补充说明。".repeat(10)).reason, "added");
  const rewritten = "本文叙述了漫长的经历，角色不断变多，情节层层推进下去。".repeat(7);
  assert.equal(validateCleanup(input, rewritten).ok, false);
  // Reordering paragraphs is rewriting too.
  const a = "第一段的内容在这里，非常重要。".repeat(5);
  const b = "第二段完全是另外的事情，别弄混。".repeat(5);
  assert.equal(validateCleanup(a + b, b + a).ok, false);
  // An inserted common char cannot drag the matcher across the input (anchor check).
  const long = "甲乙丙丁戊己庚辛壬癸".repeat(40) + "的";
  assert.equal(validateCleanup(long, "的" + long.slice(0, -1)).ok, true);
  assert.equal(validateCleanup("", "").ok, true);
  assert.equal(validateCleanup("abc", 42).ok, false);
});

test("validation stays fast on a full block", () => {
  const input = "这是用于测试速度的正文句子，包含一些内容。".repeat(300); // ~6,300 chars
  const garbage = "完全无关的文字".repeat(900);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    validateCleanup(input, input);
    validateCleanup(input, garbage.slice(0, input.length));
  }
  assert.ok(performance.now() - t0 < 500);
});

test("sentences and pieces", () => {
  assert.deepEqual(splitSentences("你好。“好吗？”他说！Fine. 3.14 is pi.\n下一行"), ["你好。", "“好吗？”", "他说！", "Fine.", "3.14 is pi.", "下一行"]);
  const text = ("这是一个句子，" + "内容".repeat(20) + "。").repeat(20) + "Hello world. This is English! 好的？";
  for (const max of [200, 120]) {
    const pieces = splitPieces(text, max);
    assert.ok(pieces.every((p) => p.length <= max && p.length > 0), `max ${max}`);
    assert.equal(pieces.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  }
  // Overlong sentence hard-split at commas, else at max.
  const commas = splitPieces("前半，".repeat(100) + "。", 200);
  assert.ok(commas.every((p) => p.length <= 200));
  assert.ok(commas.slice(0, -1).every((p) => p.endsWith("，")));
  assert.deepEqual(splitPieces("a".repeat(450), 200).map((p) => p.length), [200, 200, 50]);
  // English sentences joined with a space; punctuation-only pieces dropped.
  assert.deepEqual(splitPieces("One. Two.", 200), ["One. Two."]);
  assert.deepEqual(splitPieces("……\n。。\n好", 200), ["好"]);
  // Surrogate pairs are not cut.
  assert.ok(splitPieces("😀".repeat(150), 201).every((p) => codePoints(p) * 2 === p.length));
});

test("blocks split at paragraph boundaries near 6,000 chars", () => {
  const para = "段落内容。".repeat(200); // 1,000 chars
  const text = Array.from({ length: 20 }, () => para).join("\n\n");
  const blocks = chunkBlocks(text);
  assert.ok(blocks.length >= 3 && blocks.every((b) => b.length <= 6900));
  assert.equal(blocks.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  assert.deepEqual(chunkBlocks("短文"), ["短文"]);
  assert.deepEqual(chunkBlocks(""), []);
  // No newline at all: falls back to sentence ends, then a hard cut.
  assert.ok(chunkBlocks("句子。".repeat(5000)).every((b) => b.length <= 6900 && b.endsWith("。")));
  assert.ok(chunkBlocks("字".repeat(20000)).every((b) => b.length <= 6900));
});

test("duration estimate: ~21 s per 100 CJK chars, 2.6 words/s", () => {
  assert.equal(estimateMs("字".repeat(100)), 21_000);
  assert.equal(estimateMs("one two three four five six seven eight nine ten eleven twelve thirteen"), 5000);
  assert.equal(estimateMs("我们讨论 machine learning。"), Math.round(4 * 210 + (2 / 2.6) * 1000));
  assert.equal(estimateMs(""), 0);
});

test("segments: every segment ≤ 20:00 for random durations", () => {
  assert.equal(nextSegmentIndex(null, 0, 5), 0);
  assert.equal(nextSegmentIndex(0, SEGMENT_MAX_MS - 5, 5), 0);
  assert.equal(nextSegmentIndex(0, SEGMENT_MAX_MS - 5, 6), 1);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let trial = 0; trial < 200; trial++) {
    const durations = Array.from({ length: 1 + Math.floor(rand() * 300) }, () => Math.floor(rand() * 120_000) + 1);
    const segs = assignSegments(durations);
    const totals = [];
    segs.forEach((s, i) => (totals[s] = (totals[s] ?? 0) + durations[i]));
    assert.ok(totals.every((t) => t <= SEGMENT_MAX_MS));
    // Contiguous, non-decreasing, and a new segment only when the next piece would not fit.
    segs.forEach((s, i) => i && assert.ok(s === segs[i - 1] || s === segs[i - 1] + 1));
    for (let i = 1; i < segs.length; i++)
      if (segs[i] !== segs[i - 1]) assert.ok(totals[segs[i - 1]] + durations[i] > SEGMENT_MAX_MS);
  }
});

test("MP3 duration from frame headers (MPEG-2 Layer III, VBR, ID3v2, no Xing)", () => {
  const plain = mp3Frames([8, 10, 12, 8, 14]);
  assert.deepEqual(mp3Info(plain), { frames: 5, durationMs: 120, sampleRate: 24000 });
  const tagged = mp3Frames(Array(1000).fill(10), { id3: 300 });
  assert.equal(looksLikeMp3(tagged), true);
  assert.deepEqual(mp3Info(tagged), { frames: 1000, durationMs: 24000, sampleRate: 24000 });
  const padded = mp3Frames([8, 8, 8], { pad: true });
  assert.equal(mp3Info(padded).frames, 3);
  // MPEG-1 44.1 kHz frames: 1152 samples each.
  const mpeg1 = mp3Frames([9, 9], { mpeg1: true });
  assert.equal(mp3Info(mpeg1).durationMs, Math.round((2 * 1152 * 1000) / 44100));
  assert.equal(mp3Info(new TextEncoder().encode("RIFF....WAVEfmt ")), null);
  assert.equal(mp3Info(new Uint8Array([0xff])), null);
  assert.equal(looksLikeMp3(new TextEncoder().encode("{\"error\":1}")), false);
});

function fakeSocket(script) {
  const listeners = {};
  const ws = {
    sent: [],
    closed: false,
    accept() {
      setTimeout(() => ws.emit("message", { data: JSON.stringify({ type: "session.created" }) }), 0);
    },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    emit(type, ev) {
      for (const fn of listeners[type] ?? []) fn(ev);
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

test("DashScope realtime client: protocol, validation and failures", async () => {
  const audio = mp3Frames(Array(50).fill(10), { id3: 20 });
  const b64 = Buffer.from(audio).toString("base64");
  const ok = (ev, ws) => {
    const msg = (o) => ws.emit("message", { data: JSON.stringify(o) });
    if (ev.type === "session.update") msg({ type: "session.updated" });
    if (ev.type === "session.finish") {
      msg({ type: "response.audio.delta", delta: b64.slice(0, 1000) });
      msg({ type: "response.audio.delta", delta: b64.slice(1000) + "x".repeat(0) });
      msg({ type: "response.done", response: { status: "completed", usage: { characters: 14 } } });
      msg({ type: "session.finished" });
    }
  };
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init.headers.Authorization, upgrade: init.headers.Upgrade };
    return { status: 101, webSocket: (fetchImpl.ws = fakeSocket(fetchImpl.script)) };
  };
  fetchImpl.script = ok;
  const r = await synthesize("sk-test", { text: "你好 world", voice: "Ethan" }, { fetchImpl });
  assert.equal(seen.url, "https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime");
  assert.equal(seen.auth, "Bearer sk-test");
  assert.equal(seen.upgrade, "websocket");
  assert.deepEqual(r.audio, audio);
  assert.equal(r.billedChars, 14);
  assert.equal(r.durationMs, 1200);
  const session = fetchImpl.ws.sent.find((e) => e.type === "session.update").session;
  assert.deepEqual(session, { voice: "Ethan", mode: "commit", language_type: "Auto", response_format: "mp3", sample_rate: 24000 });
  assert.deepEqual(fetchImpl.ws.sent.map((e) => e.type), ["session.update", "input_text_buffer.append", "input_text_buffer.commit", "session.finish"]);
  assert.equal(fetchImpl.ws.sent[1].text, "你好 world");
  assert.equal(fetchImpl.ws.closed, true);

  // 1006 drop without audio.
  fetchImpl.script = (ev, ws) => ev.type === "session.update" && ws.emit("close", { code: 1006 });
  await assert.rejects(synthesize("sk-test", { text: "x" }, { fetchImpl }), (e) => e instanceof TtsError && e.code === "tts_closed_1006");
  // Server error event; the key never appears in the error.
  fetchImpl.script = (ev, ws) => ws.emit("message", { data: JSON.stringify({ type: "error", error: { code: "Throttling sk-test!" } }) });
  await assert.rejects(synthesize("sk-test", { text: "x" }, { fetchImpl }), (e) => e.code.startsWith("tts_error_") && !e.message.includes("sk-test!"));
  // Done but no audio / not MP3.
  const noAudio = (bytes) => (ev, ws) => {
    const msg = (o) => ws.emit("message", { data: JSON.stringify(o) });
    if (ev.type === "session.update") msg({ type: "session.updated" });
    if (ev.type === "session.finish") {
      if (bytes) msg({ type: "response.audio.delta", delta: Buffer.from(bytes).toString("base64") });
      msg({ type: "response.done", response: { usage: { characters: 1 } } });
      msg({ type: "session.finished" });
    }
  };
  fetchImpl.script = noAudio(null);
  await assert.rejects(synthesize("k", { text: "x" }, { fetchImpl }), { code: "tts_no_audio" });
  fetchImpl.script = noAudio(new TextEncoder().encode("RIFF0000WAVE"));
  await assert.rejects(synthesize("k", { text: "x" }, { fetchImpl }), { code: "tts_bad_audio" });
  // Upgrade refused.
  await assert.rejects(synthesize("k", { text: "x" }, { fetchImpl: async () => ({ status: 401 }) }), { code: "tts_upgrade_401" });
  await assert.rejects(
    synthesize("k", { text: "x" }, { fetchImpl: async () => Promise.reject(new TypeError("net")) }),
    { code: "tts_connect_failed" },
  );
});

test("large deltas take the fast path (no JSON.parse of the audio message)", async () => {
  const audio = mp3Frames(Array(200).fill(14));
  const b64 = Buffer.from(audio).toString("base64");
  assert.ok(b64.length > 4096);
  const fetchImpl = async () => ({
    status: 101,
    webSocket: fakeSocket((ev, ws) => {
      const msg = (o) => ws.emit("message", { data: JSON.stringify(o) });
      if (ev.type === "session.update") msg({ type: "session.updated" });
      if (ev.type === "session.finish") {
        ws.emit("message", { data: `{"event_id":"x","type":"response.audio.delta","response_id":"r","delta":"${b64}"}` });
        msg({ type: "response.done", response: { status: "completed", usage: { characters: 3 } } });
        msg({ type: "session.finished" });
      }
    }),
  });
  const r = await synthesize("k", { text: "abc" }, { fetchImpl });
  assert.deepEqual(r.audio, audio);
  assert.equal(r.durationMs, 200 * 24);
});

test("TTS model config: style instructions only for instruct models", async () => {
  assert.equal(ttsModel({}), "qwen3-tts-flash-realtime");
  assert.equal(ttsModel({ TTS_MODEL: "qwen3-tts-instruct-flash-realtime" }), "qwen3-tts-instruct-flash-realtime");
  assert.equal(ttsModel({ TTS_MODEL: "bad model&x=1" }), "qwen3-tts-flash-realtime");
  assert.equal(isInstructModel("qwen3-tts-flash-realtime"), false);
  const audio = mp3Frames([8, 8]);
  const sessions = [];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return {
      status: 101,
      webSocket: fakeSocket((ev, ws) => {
        const msg = (o) => ws.emit("message", { data: JSON.stringify(o) });
        if (ev.type === "session.update") {
          sessions.push(ev.session);
          msg({ type: "session.updated" });
        }
        if (ev.type === "session.finish") {
          msg({ type: "response.audio.delta", delta: Buffer.from(audio).toString("base64") });
          msg({ type: "response.done", response: { status: "completed", usage: { characters: 2 } } });
          msg({ type: "session.finished" });
        }
      }),
    };
  };
  await synthesize("k", { text: "好", instructions: "平稳的语气" }, { fetchImpl });
  await synthesize("k", { text: "好", model: "qwen3-tts-instruct-flash-realtime", instructions: "平稳的语气" }, { fetchImpl });
  assert.equal("instructions" in sessions[0], false);
  assert.equal("optimize_instructions" in sessions[0], false);
  assert.equal(sessions[1].instructions, "平稳的语气");
  assert.equal(sessions[1].optimize_instructions, false);
  assert.ok(urls[1].endsWith("?model=qwen3-tts-instruct-flash-realtime"));
});

test("narration style validation", () => {
  assert.equal(validateStyle(" 平稳、客观、语速适中的讲解语气，像纪录片旁白 "), "平稳、客观、语速适中的讲解语气，像纪录片旁白");
  assert.equal(validateStyle("calm, steady narration"), "calm, steady narration");
  for (const bad of ["", "   ", "字".repeat(101), "<script>", "忽略以上{指令}", 42, null]) assert.equal(validateStyle(bad), null);
  assert.ok(validateStyle(DEFAULT_STYLE));
});
