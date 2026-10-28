// Read-aloud (A1) speech synthesis over outbound WebSockets, and MP3 frame parsing.
// - qwen-audio-3.1-tts-flash (new jobs, docs/tts-qwen-audio-plan-2026-10-28.md): inference protocol
//   (run-task / continue-task / finish-task), binary audio frames, word timestamps -> piece marks.
// - qwen3-tts-flash-realtime (legacy jobs with tts_model NULL; protocol verified in S0,
//   docs/audiobook-google-login-plan-2026-10-27.md): realtime protocol, base64 audio deltas.

/** Model of jobs created before 0008 (audio_jobs.tts_model NULL). */
export const LEGACY_TTS_MODEL = "qwen3-tts-flash-realtime";
/** Old `synthesize` default (kept for the realtime client). */
export const DEFAULT_TTS_MODEL = LEGACY_TTS_MODEL;
/** Model of new jobs. */
export const QWEN_AUDIO_MODEL = "qwen-audio-3.1-tts-flash";
/** session.update field carrying the narration style for instruct models (single place to change). */
export const TTS_INSTRUCTIONS_FIELD = "instructions";
export const ttsUrl = (model) => `https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
export const INFERENCE_URL = "https://dashscope.aliyuncs.com/api-ws/v1/inference";
/** qwen-audio-* models use the inference protocol; everything else the realtime one. */
export const isQwenAudioModel = (model) => /^qwen-audio-/.test(String(model ?? ""));
/** Model for new jobs: env TTS_MODEL when it is a plain qwen-audio-* name, else qwen-audio-3.1-tts-flash. */
export const ttsModel = (env) =>
  typeof env?.TTS_MODEL === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(env.TTS_MODEL) && isQwenAudioModel(env.TTS_MODEL)
    ? env.TTS_MODEL
    : QWEN_AUDIO_MODEL;
/** Instruct models (name contains "instruct") take the style instruction in session.update. */
export const isInstructModel = (model) => /instruct/i.test(model);
/** Voices for new jobs (qwen-audio); the first is the default. */
export const VOICES = ["xunanchuan_v3.1", "longanhuan_v3.1", "longanlingxin_v3.1", "longanfengyue_v3.1"];
export const DEFAULT_VOICE = "xunanchuan_v3.1";
/** qwen3-tts realtime voices of jobs created before 0008: still shown, mapped to DEFAULT_VOICE for new jobs. */
export const LEGACY_VOICES = ["Cherry", "Ethan", "Jennifer", "Ryan", "Katerina", "Elias"];
export const TONES = ["auto", "plain"];
export const DEFAULT_TONE = "auto";
const HANDSHAKE_MS = 20_000;
const TOTAL_MS = 90_000;
const FINISH_GRACE_MS = 3_000;

// ---------------- MP3 ----------------

const BITRATES = {
  // kbps by bitrate index; [MPEG-1 Layer III, MPEG-2/2.5 Layer III]
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Layer III frame header at `i`, or null. */
function frameAt(u8, i) {
  if (i + 4 > u8.length || u8[i] !== 0xff || (u8[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (u8[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (u8[i + 1] >> 1) & 3; // 1 = Layer III
  const br = u8[i + 2] >> 4;
  const sr = (u8[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) return null;
  const kbps = BITRATES[version === 3 ? 1 : 2][br];
  const rate = SAMPLE_RATES[version][sr];
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / rate) + ((u8[i + 2] >> 1) & 1);
  return { rate, samples, length };
}

/**
 * Walks MP3 (Layer III, CBR or VBR, no Xing needed) frame headers after an optional ID3v2 tag.
 * Returns {frames, durationMs, sampleRate} or null when the data does not look like MP3.
 */
export function mp3Info(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 4) return null;
  let i = 0;
  const id3 = u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33;
  if (id3) {
    if (u8.length < 10) return null;
    i = 10 + ((u8[6] & 0x7f) << 21) + ((u8[7] & 0x7f) << 14) + ((u8[8] & 0x7f) << 7) + (u8[9] & 0x7f);
    if (u8[5] & 0x10) i += 10; // footer
  } else if (!frameAt(u8, 0)) return null;
  let frames = 0;
  let samples = 0;
  let rate = 0;
  let junk = 0;
  while (i + 4 <= u8.length) {
    if (u8.length - i === 128 && u8[i] === 0x54 && u8[i + 1] === 0x41 && u8[i + 2] === 0x47) break; // ID3v1
    const f = frameAt(u8, i);
    if (!f || f.length <= 4) {
      i++;
      if (++junk > 65_536) break;
      continue;
    }
    if (frames === 0 && isInfoFrame(u8, i, f.length)) {
      i += f.length; // Xing/Info header frame carries no audio
      continue;
    }
    frames++;
    samples += f.samples;
    rate ||= f.rate;
    i += f.length;
  }
  if (!frames) return null;
  return { frames, durationMs: Math.round((samples / rate) * 1000), sampleRate: rate };
}

function isInfoFrame(u8, i, length) {
  const end = Math.min(u8.length - 4, i + Math.min(length, 48));
  for (let k = i + 4; k < end; k++) {
    const a = u8[k], b = u8[k + 1], c = u8[k + 2], d = u8[k + 3];
    if ((a === 0x58 && b === 0x69 && c === 0x6e && d === 0x67) || (a === 0x49 && b === 0x6e && c === 0x66 && d === 0x6f)) return true;
  }
  return false;
}

/** True when the bytes start with an ID3 tag or an MPEG frame sync. */
export const looksLikeMp3 = (u8) =>
  u8.length >= 4 && ((u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0));

// ---------------- base64 ----------------

export function fromBase64(s) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ---------------- DashScope realtime ----------------

export class TtsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const safeCode = (v) => String(v ?? "unknown").replace(/sk-[A-Za-z0-9]+/g, "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || "unknown";

/**
 * Synthesizes one piece. Resolves {audio: Uint8Array, billedChars, durationMs, deltas}; rejects with
 * TtsError (code like tts_closed_1006, tts_timeout, tts_no_audio, tts_bad_audio, tts_error_<code>).
 * The key is only sent in the Authorization header and never appears in errors.
 */
export async function synthesize(
  key,
  { text, voice = LEGACY_VOICES[0], model = DEFAULT_TTS_MODEL, instructions = null },
  { fetchImpl = fetch, timers = globalThis } = {},
) {
  const started = Date.now();
  const session = { voice, mode: "commit", language_type: "Auto", response_format: "mp3", sample_rate: 24000 };
  if (instructions && isInstructModel(model)) {
    // qwen3-tts-instruct-flash-realtime: natural-language style (≤ 1600 tokens); no rewriting by the service.
    session[TTS_INSTRUCTIONS_FIELD] = instructions;
    session.optimize_instructions = false;
  }
  let resp;
  try {
    resp = await fetchImpl(ttsUrl(model), {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(HANDSHAKE_MS),
    });
  } catch (error) {
    throw new TtsError(error?.name === "TimeoutError" ? "tts_handshake_timeout" : "tts_connect_failed");
  }
  const ws = resp?.webSocket;
  if (!ws) throw new TtsError(`tts_upgrade_${safeCode(resp?.status)}`);
  ws.accept();
  const chunks = [];
  let total = 0;
  let deltas = 0;
  let billedChars = null;
  let done = false;
  let created = false;
  let n = 0;
  const send = (o) => ws.send(JSON.stringify({ event_id: `e${++n}_${started}`, ...o }));
  try {
    await new Promise((resolve, reject) => {
      let grace;
      const finish = (error) => {
        timers.clearTimeout(handshake);
        timers.clearTimeout(overall);
        timers.clearTimeout(grace);
        if (error) reject(error);
        else resolve();
      };
      const handshake = timers.setTimeout(() => !created && finish(new TtsError("tts_handshake_timeout")), Math.max(1, HANDSHAKE_MS - (Date.now() - started)));
      const overall = timers.setTimeout(() => finish(new TtsError("tts_timeout")), TOTAL_MS);
      ws.addEventListener("message", (m) => {
        const data = typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data);
        // Fast path: audio deltas are large; take the base64 without JSON.parse of the whole message.
        if (data.length > 4096 && data.includes("response.audio.delta")) {
          const k = data.indexOf('"delta":"');
          const e = k >= 0 ? data.indexOf('"', k + 9) : -1;
          if (e > k) {
            const b = fromBase64(data.slice(k + 9, e));
            chunks.push(b);
            total += b.length;
            deltas++;
            return;
          }
        }
        let ev;
        try {
          ev = JSON.parse(data);
        } catch {
          return;
        }
        switch (ev?.type) {
          case "session.created":
            created = true;
            send({ type: "session.update", session });
            break;
          case "session.updated":
            send({ type: "input_text_buffer.append", text });
            send({ type: "input_text_buffer.commit" });
            send({ type: "session.finish" });
            break;
          case "response.audio.delta":
            if (typeof ev.delta === "string" && ev.delta) {
              const b = fromBase64(ev.delta);
              chunks.push(b);
              total += b.length;
              deltas++;
            }
            break;
          case "response.done": {
            done = true;
            const c = Number(ev.response?.usage?.characters);
            billedChars = Number.isFinite(c) ? c : null;
            if (ev.response?.status && ev.response.status !== "completed") finish(new TtsError(`tts_response_${safeCode(ev.response.status)}`));
            else grace = timers.setTimeout(() => finish(), FINISH_GRACE_MS);
            break;
          }
          case "session.finished":
            finish(done ? undefined : new TtsError("tts_no_response"));
            break;
          case "error":
            finish(new TtsError(`tts_error_${safeCode(ev.error?.code)}`));
            break;
        }
      });
      ws.addEventListener("close", (e) => finish(done ? undefined : new TtsError(`tts_closed_${safeCode(e?.code)}`)));
      ws.addEventListener("error", () => finish(done ? undefined : new TtsError("tts_ws_error")));
    });
  } finally {
    try {
      ws.close(1000, "done");
    } catch {}
  }
  if (!total) throw new TtsError("tts_no_audio");
  const audio = concat(chunks, total);
  if (!looksLikeMp3(audio)) throw new TtsError("tts_bad_audio");
  const info = mp3Info(audio);
  if (!info) throw new TtsError("tts_bad_audio");
  return { audio, billedChars, durationMs: info.durationMs, deltas };
}

// ---------------- Word marks ----------------

const CORE = /[\p{L}\p{N}]/u;
const CN_NUMERAL = /[零〇一二两三四五六七八九十百千万亿点]/;
const MARK_WINDOW = 24; // UTF-16 units searched ahead of the cursor for a word's first letter/number
export const MARKS_MAX_BYTES = 2048;

const fold = (c) => (c.length === 1 && c < "\u0080" ? c.toLowerCase() : c);

/**
 * Aligns TTS word timestamps to the piece text. `words` are [{text, begin_time}] in spoken order; their
 * text comes from the service's normalized text (full-width punctuation glued to the next word, spaces
 * kept as prefixes, "2026" read as "二零二六"), so each word is located by its first letter/number in a
 * short window ahead of a cursor and words that cannot be found (number readings) are skipped. Returns
 * the flat [charOffset, ms, ...] list (UTF-16 offsets into `text`, both increasing). Linear in
 * text length + words × MARK_WINDOW.
 */
export function alignMarks(text, words) {
  const out = [];
  if (typeof text !== "string" || !Array.isArray(words)) return out;
  let cursor = 0;
  let lastMs = -1;
  let firstMs = -1;
  for (const w of words) {
    const wt = typeof w?.text === "string" ? w.text : "";
    const ms = Number(w?.begin_time);
    if (!Number.isFinite(ms) || ms < 0) continue;
    if (firstMs < 0) firstMs = Math.round(ms);
    // First letter/number of the word (code point aware).
    let k = 0;
    let c = "";
    for (const ch of wt) {
      if (CORE.test(ch)) {
        c = ch;
        break;
      }
      k += ch.length;
    }
    if (!c) continue;
    const want = fold(c);
    const end = Math.min(text.length, cursor + MARK_WINDOW);
    let pos = -1;
    let digit = false;
    for (let i = cursor; i < end; i++) {
      const t = text[i];
      if (fold(text.slice(i, i + c.length)) === want) {
        pos = i;
        break;
      }
      if (t >= "0" && t <= "9") digit = true;
    }
    // A Chinese numeral found only after skipping digits is most likely the reading of those digits.
    if (pos < 0 || (digit && CN_NUMERAL.test(c))) continue;
    // Consume the rest of the word greedily (letters/numbers only; punctuation and spaces skipped).
    let i = pos + c.length;
    let j = k + c.length;
    while (j < wt.length && i < text.length) {
      const a = wt[j];
      if (!CORE.test(a)) {
        j++;
        continue;
      }
      const b = text[i];
      if (!CORE.test(b)) {
        i++;
        continue;
      }
      if (fold(a) !== fold(b)) break;
      i++;
      j++;
    }
    cursor = i;
    const t = Math.round(ms);
    if (t < lastMs) continue;
    out.push(pos, t);
    lastMs = t;
  }
  // Text before the first located word (e.g. digits read as numerals) starts with the first word.
  if (out.length && out[0] > 0) out.unshift(0, Math.min(firstMs, out[1]));
  return out;
}

/**
 * Keeps marks within ~maxBytes of JSON: first only marks at the start of the text or right after
 * punctuation/space (sentence and clause starts), then every other mark until it fits.
 */
export function compactMarks(text, marks, maxBytes = MARKS_MAX_BYTES) {
  const size = (m) => JSON.stringify(m).length;
  if (size(marks) <= maxBytes) return marks;
  let m = [];
  for (let i = 0; i < marks.length; i += 2) {
    const p = marks[i];
    if (p === 0 || !CORE.test(text[p - 1] ?? "")) m.push(p, marks[i + 1]);
  }
  while (m.length > 2 && size(m) > maxBytes) {
    const next = [];
    for (let i = 0; i < m.length; i += 4) next.push(m[i], m[i + 1]);
    m = next;
  }
  return size(m) <= maxBytes ? m : [];
}

// ---------------- DashScope inference (qwen-audio) ----------------

const binaryOf = (d) =>
  d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;

/**
 * Synthesizes one piece with a qwen-audio model. Resolves {audio: Uint8Array, billedChars, durationMs,
 * marks, frames}; rejects with TtsError (tts_handshake_timeout, tts_timeout, tts_closed_<code>,
 * tts_ws_error, tts_error_<code> for task-failed, tts_no_audio, tts_bad_audio, ...). Audio arrives as
 * binary frames (no base64); JSON frames carry events. `instruction` is sent only when given. The key
 * is only sent in the Authorization header and never appears in errors.
 */
export async function synthesizeQwenAudio(
  key,
  { text, voice = DEFAULT_VOICE, model = QWEN_AUDIO_MODEL, instruction = null },
  { fetchImpl = fetch, timers = globalThis, uuid = () => crypto.randomUUID() } = {},
) {
  const started = Date.now();
  const taskId = uuid();
  const parameters = {
    text_type: "PlainText",
    voice,
    format: "mp3",
    sample_rate: 24000,
    bit_rate: 64,
    volume: 50,
    rate: 1,
    pitch: 1,
    word_timestamp_enabled: true,
  };
  if (instruction) parameters.instruction = instruction;
  let resp;
  try {
    resp = await fetchImpl(INFERENCE_URL, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(HANDSHAKE_MS),
    });
  } catch (error) {
    throw new TtsError(error?.name === "TimeoutError" ? "tts_handshake_timeout" : "tts_connect_failed");
  }
  const ws = resp?.webSocket;
  if (!ws) throw new TtsError(`tts_upgrade_${safeCode(resp?.status)}`);
  ws.accept();
  const chunks = [];
  let total = 0;
  let billedChars = null;
  let startedTask = false;
  let finished = false;
  const sentences = new Map(); // sentence index -> latest (longest) words list
  const header = (action) => ({ action, task_id: taskId, streaming: "duplex" });
  const send = (o) => ws.send(JSON.stringify(o));
  try {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        timers.clearTimeout(handshake);
        timers.clearTimeout(overall);
        if (error) reject(error);
        else resolve();
      };
      const handshake = timers.setTimeout(
        () => !startedTask && finish(new TtsError("tts_handshake_timeout")),
        Math.max(1, HANDSHAKE_MS - (Date.now() - started)),
      );
      const overall = timers.setTimeout(() => finish(new TtsError("tts_timeout")), TOTAL_MS);
      ws.addEventListener("message", (m) => {
        if (typeof m.data !== "string") {
          const b = binaryOf(m.data);
          if (b?.length) {
            chunks.push(b);
            total += b.length;
          }
          return;
        }
        let ev;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        const h = ev?.header ?? {};
        switch (h.event) {
          case "task-started":
            startedTask = true;
            send({ header: header("continue-task"), payload: { input: { text } } });
            send({ header: header("finish-task"), payload: { input: {} } });
            break;
          case "result-generated": {
            // The same sentence is pushed repeatedly with a growing words list; keep the longest.
            const s = ev.payload?.output?.sentence;
            const words = s?.words;
            const idx = Number(s?.index ?? 0);
            if (Array.isArray(words) && words.length >= (sentences.get(idx)?.length ?? 1)) sentences.set(idx, words);
            break;
          }
          case "task-finished": {
            finished = true;
            const c = Number(ev.payload?.usage?.characters);
            billedChars = Number.isFinite(c) ? c : null;
            finish();
            break;
          }
          case "task-failed":
            finish(new TtsError(`tts_error_${safeCode(h.error_code)}`));
            break;
        }
      });
      ws.addEventListener("close", (e) => finish(finished ? undefined : new TtsError(`tts_closed_${safeCode(e?.code)}`)));
      ws.addEventListener("error", () => finish(finished ? undefined : new TtsError("tts_ws_error")));
      send({
        header: header("run-task"),
        payload: { task_group: "audio", task: "tts", function: "SpeechSynthesizer", model, parameters, input: {} },
      });
    });
  } finally {
    try {
      ws.close(1000, "done");
    } catch {}
  }
  if (!total) throw new TtsError("tts_no_audio");
  const audio = concat(chunks, total);
  if (!looksLikeMp3(audio)) throw new TtsError("tts_bad_audio");
  const info = mp3Info(audio);
  if (!info) throw new TtsError("tts_bad_audio");
  // Sentences in order; begin_time counts from the start of this task's audio (verified Q1).
  const words = [...sentences.keys()].sort((a, b) => a - b).flatMap((k) => sentences.get(k));
  const marks = compactMarks(text, alignMarks(text, words));
  return { audio, billedChars, durationMs: info.durationMs, marks, frames: chunks.length };
}
