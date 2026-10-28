import { api, ApiError, store } from "./common";

export type AudioStatus = "queued" | "cleaning" | "synthesizing" | "ready" | "failed" | "budget_exceeded";
export type AudioTone = "auto" | "plain";
export const VOICES: readonly { id: string; label: string }[] = [
  { id: "xunanchuan_v3.1", label: "许南川（男）" },
  { id: "longanhuan_v3.1", label: "龙安欢（女）" },
  { id: "longanlingxin_v3.1", label: "龙安灵心（女）" },
  { id: "longanfengyue_v3.1", label: "龙安风悦（女）" },
];
export const DEFAULT_VOICE = "xunanchuan_v3.1";
export const TONES: readonly { id: AudioTone; label: string }[] = [
  { id: "auto", label: "自动语气" },
  { id: "plain", label: "不加语气" },
];
export const DEFAULT_TONE: AudioTone = "auto";
export const VOICE_KEY = "shelf:audio-voice";
export const TONE_KEY = "shelf:audio-tone";

/** The user's last chosen voice/tone (falls back to the defaults when unset or no longer offered). */
export function savedVoice(): string {
  const v = store.get(VOICE_KEY);
  return v && VOICES.some((x) => x.id === v) ? v : DEFAULT_VOICE;
}
export function savedTone(): AudioTone {
  return store.get(TONE_KEY) === "plain" ? "plain" : DEFAULT_TONE;
}

export interface AudioPiece { seq: number; durationMs: number | null; ready: boolean; /** Cleaned text of the piece (read-along). */ text?: string; /** Word marks [charOffset, ms, ...]: UTF-16 offsets into `text`, ms within this piece audio. */ marks?: number[] }
export interface AudioSegment { index: number; durationMs: number | null; pieces: AudioPiece[] }
export interface AudioJob {
  id: string;
  status: AudioStatus;
  voice: string;
  tone?: AudioTone;
  ttsModel?: string;
  chapterLabel: string;
  estSeconds: number | null;
  donePieces: number;
  totalPieces: number;
  error?: string | null;
  segments: AudioSegment[];
  /** Server extras (A1): narration style, piece length and whether a CPU downgrade happened. */
  style?: string | null;
  pieceChars?: number;
  cpuDowngraded?: boolean;
  llmFallbackBlocks?: number;
}

export interface AudioApi {
  find(bookId: string, chapterKey: string, opts?: { voice?: string; tone?: AudioTone }): Promise<AudioJob | null>;
  create(bookId: string, body: { chapterKey: string; label: string; text: string; voice?: string; tone?: AudioTone }): Promise<AudioJob>;
  get(jobId: string): Promise<AudioJob>;
  regenerate(jobId: string, voice?: string, tone?: AudioTone): Promise<AudioJob>;
  pieceUrl(jobId: string, seq: number): string;
}

const enc = encodeURIComponent;

export const realAudioApi: AudioApi = {
  async find(bookId, chapterKey, opts) {
    try {
      let q = `chapterKey=${enc(chapterKey)}`;
      if (opts?.voice) q += `&voice=${enc(opts.voice)}`;
      if (opts?.tone) q += `&tone=${enc(opts.tone)}`;
      return (await api<{ job: AudioJob }>(`/api/books/${enc(bookId)}/audio?${q}`)).job;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  async create(bookId, body) {
    return (await api<{ job: AudioJob }>(`/api/books/${enc(bookId)}/audio`, { method: "POST", body: JSON.stringify(body) })).job;
  },
  async get(jobId) {
    return (await api<{ job: AudioJob }>(`/api/audio/${enc(jobId)}`)).job;
  },
  async regenerate(jobId, voice, tone) {
    const body: { voice?: string; tone?: AudioTone } = {};
    if (voice) body.voice = voice;
    if (tone) body.tone = tone;
    return (await api<{ job: AudioJob }>(`/api/audio/${enc(jobId)}/regenerate`, { method: "POST", body: JSON.stringify(body) })).job;
  },
  pieceUrl: (jobId, seq) => `/api/audio/${enc(jobId)}/pieces/${seq}`,
};

// ---------------- Mock (enabled with ?audioMock=1) ----------------

/** 16-bit mono PCM WAV of a quiet tone burst (so progress is audible) of the given length. */
export function makeWav(durationMs: number, freq = 330, rate = 8000): Blob {
  const n = Math.max(1, Math.round((durationMs / 1000) * rate));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // Short 0.25 s beep every 2 s, silent otherwise.
    const t = i / rate;
    const on = t % 2 < 0.25;
    v.setInt16(44 + i * 2, on ? Math.round(Math.sin(2 * Math.PI * freq * t) * 3000) : 0, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

interface MockJob {
  id: string;
  chapterKey: string;
  label: string;
  voice: string;
  tone: AudioTone;
  createdAt: number;
  layout: number[][]; // per segment: piece durations (ms)
  readyAt: number[]; // per flattened piece: ms after creation when ready
}

/** Plausible word marks: one mark per ~2 chars, spread evenly over the audio ("plain" tone is a bit faster). */
export function mockMarks(text: string, durationMs: number, tone: AudioTone = "auto"): number[] {
  const out: number[] = [];
  const n = text.length;
  if (!n) return out;
  const span = durationMs * (tone === "plain" ? 0.95 : 1);
  for (let i = 0; i < n; i += 2) out.push(i, Math.round((i / n) * span));
  return out;
}

export function createMockAudioApi(opts: { pieceEveryMs?: number } = {}): AudioApi {
  const every = opts.pieceEveryMs ?? 1500;
  const jobs = new Map<string, MockJob>();
  const byChapter = new Map<string, string[]>();
  const blobUrls = new Map<string, string>();
  const MOCK_TEXTS = [
    "清晨的雾还没有散去。他站在窗前，望着远处的山。山上有一座旧塔！那是谁建的呢？",
    "书架上落满了灰尘。她抽出一本旧书，翻开第一页。字迹已经模糊，却依然温柔。",
    "雨下了整整一夜。街道安静得出奇！他撑着伞走过桥，心里想着明天的事。你还记得那个约定吗？",
    "故事就这样开始了。没有人知道结局会是什么。风从海上吹来，带着咸味。",
  ];
  let counter = 0;

  const make = (chapterKey: string, label: string, voice: string, tone: AudioTone): MockJob => {
    const layout = [
      [20000, 25000, 18000, 22000],
      [24000, 21000, 19000],
      [15000, 12000],
    ];
    const total = layout.flat().length;
    const job: MockJob = {
      id: `a_mock${++counter}`,
      chapterKey,
      label,
      voice,
      tone,
      createdAt: Date.now(),
      layout,
      readyAt: Array.from({ length: total }, (_, i) => 800 + i * every),
    };
    jobs.set(job.id, job);
    byChapter.set(chapterKey, [...(byChapter.get(chapterKey) ?? []), job.id]);
    return job;
  };

  const view = (j: MockJob): AudioJob => {
    const age = Date.now() - j.createdAt;
    let seq = 0;
    let done = 0;
    const segments = j.layout.map((durs, index) => {
      const pieces = durs.map((d) => {
        const ready = age >= j.readyAt[seq];
        if (ready) done++;
        const text = MOCK_TEXTS[seq % MOCK_TEXTS.length];
        return { seq: seq++, durationMs: ready ? d : Math.round(d * 1.05), ready, text, marks: mockMarks(text, d, j.tone) };
      });
      return { index, durationMs: pieces.reduce((a, p) => a + (p.durationMs || 0), 0), pieces };
    });
    const total = seq;
    const status: AudioStatus = done >= total ? "ready" : done === 0 ? "cleaning" : "synthesizing";
    return { id: j.id, status, voice: j.voice, chapterLabel: j.label, tone: j.tone, ttsModel: "qwen-audio-3.1-tts-flash", estSeconds: 270, donePieces: done, totalPieces: total, segments };
  };

  const durationOf = (j: MockJob, seq: number) => j.layout.flat()[seq];

  return {
    async find(_b, chapterKey, opts) {
      const ids = byChapter.get(chapterKey) ?? [];
      // Newest first; with voice/tone given only a matching job is returned (like the real API).
      for (const id of [...ids].reverse()) {
        const j = jobs.get(id)!;
        if ((!opts?.voice || j.voice === opts.voice) && (!opts?.tone || j.tone === opts.tone)) return view(j);
      }
      return null;
    },
    async create(_b, body) {
      return view(make(body.chapterKey, body.label, body.voice || DEFAULT_VOICE, body.tone || DEFAULT_TONE));
    },
    async get(jobId) {
      const j = jobs.get(jobId);
      if (!j) throw new ApiError(404, "not_found");
      return view(j);
    },
    async regenerate(jobId, voice, tone) {
      const old = jobs.get(jobId);
      if (!old) throw new ApiError(404, "not_found");
      return view(make(old.chapterKey, old.label, voice || old.voice, tone || old.tone));
    },
    pieceUrl(jobId, seq) {
      const key = `${jobId}/${seq}`;
      let url = blobUrls.get(key);
      if (!url) {
        const j = jobs.get(jobId);
        url = URL.createObjectURL(makeWav(j ? durationOf(j, seq) : 10000, 330 + (seq % 5) * 40));
        blobUrls.set(key, url);
      }
      return url;
    },
  };
}

export function audioMockEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).get("audioMock") === "1";
  } catch {
    return false;
  }
}

let instance: AudioApi | null = null;
/** The API to use: the mock with `?audioMock=1`, otherwise the real backend. */
export function getAudioApi(): AudioApi {
  return (instance ??= audioMockEnabled() ? createMockAudioApi() : realAudioApi);
}
