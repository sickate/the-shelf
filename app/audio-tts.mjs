// Read-aloud (A1) speech synthesis: DashScope qwen3-tts-flash-realtime over an outbound WebSocket
// (protocol verified in S0, docs/audiobook-google-login-plan-2026-10-27.md) and MP3 frame parsing.

export const DEFAULT_TTS_MODEL = "qwen3-tts-flash-realtime";
/** session.update field carrying the narration style for instruct models (single place to change). */
export const TTS_INSTRUCTIONS_FIELD = "instructions";
export const ttsUrl = (model) => `https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
/** env TTS_MODEL when it is a plain model name, else the default. */
export const ttsModel = (env) =>
  typeof env?.TTS_MODEL === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(env.TTS_MODEL) ? env.TTS_MODEL : DEFAULT_TTS_MODEL;
/** Instruct models (name contains "instruct") take the style instruction in session.update. */
export const isInstructModel = (model) => /instruct/i.test(model);
export const VOICES = ["Cherry", "Ethan", "Jennifer", "Ryan", "Katerina", "Elias"];
export const DEFAULT_VOICE = "Cherry";
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

const safeCode = (v) => String(v ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || "unknown";

/**
 * Synthesizes one piece. Resolves {audio: Uint8Array, billedChars, durationMs, deltas}; rejects with
 * TtsError (code like tts_closed_1006, tts_timeout, tts_no_audio, tts_bad_audio, tts_error_<code>).
 * The key is only sent in the Authorization header and never appears in errors.
 */
export async function synthesize(
  key,
  { text, voice = DEFAULT_VOICE, model = DEFAULT_TTS_MODEL, instructions = null },
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
