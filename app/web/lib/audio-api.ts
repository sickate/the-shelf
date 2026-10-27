import { api, ApiError } from "./common";

export type AudioStatus = "queued" | "cleaning" | "synthesizing" | "ready" | "failed" | "budget_exceeded";
export const VOICES = ["Cherry", "Ethan", "Jennifer", "Ryan", "Katerina", "Elias"] as const;
export const DEFAULT_VOICE = "Cherry";

export interface AudioPiece { seq: number; durationMs: number | null; ready: boolean }
export interface AudioSegment { index: number; durationMs: number | null; pieces: AudioPiece[] }
export interface AudioJob {
  id: string;
  status: AudioStatus;
  voice: string;
  chapterLabel: string;
  estSeconds: number | null;
  donePieces: number;
  totalPieces: number;
  error?: string | null;
  segments: AudioSegment[];
}

export interface AudioApi {
  find(bookId: string, chapterKey: string): Promise<AudioJob | null>;
  create(bookId: string, body: { chapterKey: string; label: string; text: string; voice?: string }): Promise<AudioJob>;
  get(jobId: string): Promise<AudioJob>;
  regenerate(jobId: string, voice?: string): Promise<AudioJob>;
  pieceUrl(jobId: string, seq: number): string;
}

const enc = encodeURIComponent;

export const realAudioApi: AudioApi = {
  async find(bookId, chapterKey) {
    try {
      return (await api<{ job: AudioJob }>(`/api/books/${enc(bookId)}/audio?chapterKey=${enc(chapterKey)}`)).job;
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
  async regenerate(jobId, voice) {
    return (await api<{ job: AudioJob }>(`/api/audio/${enc(jobId)}/regenerate`, { method: "POST", body: JSON.stringify(voice ? { voice } : {}) })).job;
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
  createdAt: number;
  layout: number[][]; // per segment: piece durations (ms)
  readyAt: number[]; // per flattened piece: ms after creation when ready
}

export function createMockAudioApi(opts: { pieceEveryMs?: number } = {}): AudioApi {
  const every = opts.pieceEveryMs ?? 1500;
  const jobs = new Map<string, MockJob>();
  const byChapter = new Map<string, string>();
  const blobUrls = new Map<string, string>();
  let counter = 0;

  const make = (chapterKey: string, label: string, voice: string): MockJob => {
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
      createdAt: Date.now(),
      layout,
      readyAt: Array.from({ length: total }, (_, i) => 800 + i * every),
    };
    jobs.set(job.id, job);
    byChapter.set(chapterKey, job.id);
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
        return { seq: seq++, durationMs: ready ? d : Math.round(d * 1.05), ready };
      });
      return { index, durationMs: pieces.reduce((a, p) => a + (p.durationMs || 0), 0), pieces };
    });
    const total = seq;
    const status: AudioStatus = done >= total ? "ready" : done === 0 ? "cleaning" : "synthesizing";
    return { id: j.id, status, voice: j.voice, chapterLabel: j.label, estSeconds: 270, donePieces: done, totalPieces: total, segments };
  };

  const durationOf = (j: MockJob, seq: number) => j.layout.flat()[seq];

  return {
    async find(_b, chapterKey) {
      const id = byChapter.get(chapterKey);
      return id ? view(jobs.get(id)!) : null;
    },
    async create(_b, body) {
      return view(make(body.chapterKey, body.label, body.voice || DEFAULT_VOICE));
    },
    async get(jobId) {
      const j = jobs.get(jobId);
      if (!j) throw new ApiError(404, "not_found");
      return view(j);
    },
    async regenerate(jobId, voice) {
      const old = jobs.get(jobId);
      if (!old) throw new ApiError(404, "not_found");
      return view(make(old.chapterKey, old.label, voice || old.voice));
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
