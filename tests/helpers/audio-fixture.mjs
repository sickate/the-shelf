import { runAudioWorkflow } from "../../app/worker.mjs";

/**
 * Synthetic MP3: Layer III frames (MPEG-2 24 kHz mono by default; `mpeg1` = MPEG-1 44.1 kHz),
 * one per bitrate index, optional ID3v2 tag of `id3` payload bytes. No Xing frame.
 */
export function mp3Frames(bitrateIdx, { id3 = 0, pad = false, mpeg1 = false } = {}) {
  const parts = [];
  if (id3) {
    const tag = new Uint8Array(10 + id3);
    tag.set([0x49, 0x44, 0x33, 3, 0, 0, (id3 >> 21) & 0x7f, (id3 >> 14) & 0x7f, (id3 >> 7) & 0x7f, id3 & 0x7f]);
    parts.push(tag);
  }
  const kbps2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const kbps1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  for (const b of bitrateIdx) {
    const len = mpeg1 ? Math.floor((144 * kbps1[b] * 1000) / 44100) + (pad ? 1 : 0) : 3 * kbps2[b] + (pad ? 1 : 0);
    const f = new Uint8Array(len);
    f.set([0xff, mpeg1 ? 0xfb : 0xf3, (b << 4) | ((mpeg1 ? 0 : 1) << 2) | ((pad ? 1 : 0) << 1), 0xc4]);
    parts.push(f);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Workflows binding fake: records instances; ids are unique like the real binding. */
export function fakeWorkflows() {
  const instances = new Map();
  return {
    instances,
    failCreate: false,
    terminated: [],
    async create({ id, params }) {
      if (this.failCreate) throw new Error("workflow create failed");
      if (instances.has(id)) throw new Error("instance.already_exists");
      instances.set(id, { id, params, ran: false });
      return { id };
    },
    async get(id) {
      if (!instances.has(id)) throw new Error("instance.not_found");
      return { id, terminate: async () => this.terminated.push(id) };
    },
  };
}

/** step fake: cached by name (replay semantics), honours retries.limit, records the step log. */
export function fakeStep() {
  const cache = new Map();
  const log = [];
  return {
    log,
    async do(name, config, fn) {
      if (typeof config === "function") fn = config;
      if (cache.has(name)) return cache.get(name);
      const limit = config?.retries?.limit ?? 5;
      let last;
      for (let attempt = 0; attempt <= limit; attempt++) {
        try {
          const r = await fn();
          cache.set(name, r);
          log.push(name);
          return r;
        } catch (error) {
          last = error;
        }
      }
      log.push(`${name}!`);
      throw last;
    },
    async sleep(name, ms) {
      log.push(`sleep:${name}:${ms > 0}`);
    },
  };
}

/** Runs every created-but-not-run instance (continuations included) until none is left. */
export async function drain(env, deps = {}, { max = 1000 } = {}) {
  const runs = [];
  for (let i = 0; i < max; i++) {
    const inst = [...env.AUDIO_WORKFLOW.instances.values()].find((x) => !x.ran);
    if (!inst) return runs;
    inst.ran = true;
    const step = fakeStep();
    const before = deps.calls?.length ?? 0;
    const result = await runAudioWorkflow(env, { payload: inst.params }, step, deps);
    runs.push({ id: inst.id, result, steps: step.log.filter((s) => !s.startsWith("sleep:")).length, log: step.log, synth: (deps.calls?.length ?? 0) - before });
  }
  throw new Error("drain did not finish");
}

/** Synthesizer fake: duration from text length (or `durationFor`), small valid MP3 bytes; `marksFor` adds marks. */
export function fakeSynth({ fail, durationFor, sizeFor, marksFor } = {}) {
  const calls = [];
  const synthesize = async (key, { text, voice, model, instruction, instructions }) => {
    calls.push({ key, text, voice, model, instruction: instruction ?? instructions ?? null });
    const f = fail?.(text, calls.length);
    if (f) throw f;
    const frames = Math.max(1, Math.min(400, text.length));
    let audio = mp3Frames(Array(frames).fill(8));
    if (sizeFor) {
      const padded = new Uint8Array(Math.max(audio.length, sizeFor(text)));
      padded.set(audio);
      audio = padded;
    }
    return {
      audio,
      billedChars: text.length * 2,
      durationMs: durationFor ? durationFor(text, calls.length) : frames * 24,
      ...(marksFor ? { marks: marksFor(text) } : {}),
    };
  };
  return { synthesize, calls };
}

/** oai /v1/tasks fake installed on globalThis.fetch; `respond(input, n)` returns {status, headers, body}. */
export function fakeOai(t, respond) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("/v1/tasks")) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    requests.push(body);
    const r = respond(body, requests.length);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers ?? { "Content-Type": "application/json" },
    });
  };
  t.after(() => (globalThis.fetch = original));
  return requests;
}

/** The block text inside <正文> tags of a cleanup request. */
export const cleanupText = (input) => /<正文>\n([\s\S]*)\n<\/正文>/.exec(input)[1];
export const oaiOk = (text) => ({ body: { task_id: "t", model: "gpt-6-luna", content: JSON.stringify({ text }) } });
