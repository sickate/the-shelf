import { AudioApi, AudioJob, AudioTone, audioMockEnabled, getAudioApi, savedTone, savedVoice } from "./audio-api";
import { CONTINUOUS_KEY, continuousOn, followStep, shouldPrefetch } from "./audio-follow";
import { AudioPlayer, createAudioPlayer, PlayerProgress } from "./audio-player";
import { getChapterNav, getChapterSource, type ChapterText } from "./chapter-source";
import { el, errorText, store } from "./common";
import { createReadAlong } from "./read-along";

// The read-aloud backend (A1) is implemented (app/worker.mjs + AudioWorkflow); ?audioMock=1 still previews.
const AUDIO_BACKEND_READY = true;
export const audioAvailable = () => AUDIO_BACKEND_READY || audioMockEnabled();

const mockSource = async () => ({ chapterKey: "mock-chapter", label: "示例章节", text: "这是用于预览播放器的示例文字。", truncated: false });

const FOLLOW_TICK_MS = 1000;
/** After the reader's chapter resolved to the playing one anyway, don't re-extract for a while. */
const FOLLOW_COOLDOWN_MS = 10_000;

interface Next {
  ch: ChapterText;
  job: AudioJob;
}

/**
 * Player + read-along for one book, with "follow chapter" and continuous playback.
 * Jobs are only ever found-or-created (never regenerated) here, and each chapter + voice + tone is
 * requested at most once at a time.
 */
function createSession(api: AudioApi, bookId: string, bookTitle: string, say: (t: string) => void) {
  const readAlong = createReadAlong();
  const inflight = new Map<string, Promise<AudioJob>>();
  const nextOf = new Map<string, Promise<Next | null>>();
  /** Chapter continuous playback just left: the reader still being there is not a chapter change. */
  let prevKey: string | null = null;
  let awaySince: number | null = null;
  let cooldownUntil = 0;
  let switching = false;
  let ticking = false;
  let timer = 0;

  const toneOf = (j: AudioJob): AudioTone => (j.tone === "plain" ? "plain" : "auto");

  /** Finds the job for chapter + voice + tone, creating it only when none exists. */
  function findOrCreate(ch: ChapterText, voice: string, tone: AudioTone): Promise<AudioJob> {
    const k = `${ch.chapterKey}\n${voice}\n${tone}`;
    let p = inflight.get(k);
    if (!p) {
      p = (async () => {
        const found = await api.find(bookId, ch.chapterKey, { voice, tone });
        return found ?? (await api.create(bookId, { chapterKey: ch.chapterKey, label: ch.label, text: ch.text, voice, tone }));
      })();
      inflight.set(k, p);
      p.then(
        () => inflight.delete(k),
        () => inflight.delete(k),
      );
    }
    return p;
  }

  /** The next chapter's job (same voice + tone); memoized, null at the end of the book. */
  function nextJob(key: string, voice: string, tone: AudioTone): Promise<Next | null> {
    const k = `${key}\n${voice}\n${tone}`;
    let p = nextOf.get(k);
    if (!p) {
      const nav = getChapterNav();
      p = (async () => {
        const ch = nav ? await nav.next(key) : null;
        if (!ch || !ch.text.trim()) return null;
        return { ch, job: await findOrCreate(ch, voice, tone) };
      })();
      nextOf.set(k, p);
      p.catch(() => nextOf.delete(k)); // a failed request may be tried again at the chapter end
    }
    return p;
  }

  function onProgress(info: PlayerProgress) {
    const k = `${info.chapterKey}\n${info.job.voice}\n${toneOf(info.job)}`;
    const go = shouldPrefetch({
      continuous: continuousOn(store.get(CONTINUOUS_KEY)),
      playing: info.playing,
      status: info.job.status,
      remainingMs: info.remainingMs,
      requested: nextOf.has(k),
    });
    if (go) void nextJob(info.chapterKey, info.job.voice, toneOf(info.job)).catch(() => {});
  }

  async function onChapterEnd(key: string, job: AudioJob) {
    if (!continuousOn(store.get(CONTINUOUS_KEY))) return;
    let nx: Next | null;
    try {
      nx = await nextJob(key, job.voice, toneOf(job));
    } catch (e) {
      say(`下一章朗读失败：${errorText(e)}`);
      return;
    }
    if (!nx) return say("已读完最后一章"); // last chapter: just stop
    const cur = player.current();
    // The user started something else meanwhile (another chapter, or replaying this one).
    if (!cur || cur.chapterKey !== key || cur.job.id !== job.id || cur.playing) return;
    prevKey = key;
    awaySince = null;
    player.open(nx.job, nx.ch.chapterKey, { fromStart: true, autoplay: true });
  }

  /** Switches the player to the reader's current chapter (saved voice + tone), from its start. */
  async function readHere(auto: boolean) {
    if (switching) return;
    const source = getChapterSource();
    const before = player.current();
    if (!source || !before) return;
    switching = true;
    try {
      const ch = await source();
      if (!ch || !ch.text.trim()) {
        if (!auto) say("本章没有可朗读的文字");
        cooldownUntil = Date.now() + FOLLOW_COOLDOWN_MS;
        return;
      }
      const now = player.current();
      if (!now || now.job.id !== before.job.id) return; // changed meanwhile
      if (ch.chapterKey === now.chapterKey) {
        cooldownUntil = Date.now() + FOLLOW_COOLDOWN_MS;
        return;
      }
      const job = await findOrCreate(ch, savedVoice(), savedTone());
      const after = player.current();
      if (!after || after.job.id !== before.job.id) return;
      prevKey = null;
      awaySince = null;
      player.open(job, ch.chapterKey, { fromStart: true, autoplay: true });
      if (readAlong.follow && readAlong.paused) readAlong.resume();
    } catch (e) {
      say(`朗读失败：${errorText(e)}`);
    } finally {
      switching = false;
    }
  }

  /** Every second while open: is the reader still in the playing chapter? (debounced 2 s) */
  async function tick() {
    if (ticking) return;
    const cur = player.current();
    const nav = getChapterNav();
    if (!cur || !nav || switching || Date.now() < cooldownUntil) {
      awaySince = null;
      if (!cur || !nav) player.setReadHere(false);
      return;
    }
    ticking = true;
    try {
      const inPlaying = await nav.contains(cur.chapterKey).catch(() => null);
      let inPrevious = false;
      if (inPlaying === true) prevKey = null;
      else if (prevKey) inPrevious = (await nav.contains(prevKey).catch(() => null)) === true;
      const now = player.current();
      if (!now || now.job.id !== cur.job.id) return;
      const r = followStep(awaySince, { now: Date.now(), inPlaying, inPrevious });
      awaySince = r.awaySince;
      // Auto-switch only while listening with follow on; otherwise offer the button.
      const auto = readAlong.follow && now.playing;
      if (r.away && auto) {
        awaySince = null;
        void readHere(true);
      }
      player.setReadHere(r.away && !auto);
    } finally {
      ticking = false;
    }
  }

  const player: AudioPlayer = createAudioPlayer({
    api,
    bookId,
    bookTitle,
    readAlong,
    onPosition: readAlong.update,
    onProgress,
    onChapterEnd: (k, j) => void onChapterEnd(k, j),
    onReadHere: () => void readHere(false),
  });
  timer = window.setInterval(() => void tick(), FOLLOW_TICK_MS);
  void timer;

  return {
    player,
    findOrCreate,
    /** Opened from the toolbar: forget continuous-playback state. */
    opened() {
      prevKey = null;
      awaySince = null;
      cooldownUntil = 0;
    },
  };
}

/** The "朗读" toolbar button: fetches the current chapter text, finds/creates the job and opens the player. */
export function audioButton(bookId: string, bookTitle: string): HTMLButtonElement {
  const btn = el("button", { type: "button", class: "audio-btn", title: "朗读本章", "aria-label": "朗读本章" }, "朗读");
  const note = el("div", { class: "audio-note", role: "status", "aria-live": "polite", hidden: "" });
  document.body.append(note);
  let timer = 0;
  const say = (text: string, ms = 4500) => {
    note.textContent = text;
    note.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (note.hidden = true), ms);
  };

  const api = getAudioApi();
  let session: ReturnType<typeof createSession> | null = null;
  let busy = false;

  btn.addEventListener("click", async () => {
    if (busy) return;
    // With ?audioMock=1 a sample chapter stands in when no format source is registered.
    const source = getChapterSource() ?? (audioMockEnabled() ? mockSource : null);
    if (!source) return say("该格式暂不支持朗读");
    busy = true;
    btn.disabled = true;
    try {
      const ch = await source();
      if (!ch || !ch.text.trim()) return say("本章没有可朗读的文字");
      if (session?.player.isOpenFor(ch.chapterKey)) return session.player.togglePlay();
      session ??= createSession(api, bookId, bookTitle, say);
      const voice = savedVoice();
      const tone = savedTone();
      const job = await session.findOrCreate(ch, voice, tone);
      if (job.donePieces === 0 && (job.status === "queued" || job.status === "cleaning")) say(ch.truncated ? `章节过长，从当前位置朗读前 30 万字：${ch.label}` : `开始生成：${ch.label}`);
      session.opened();
      session.player.open(job, ch.chapterKey);
    } catch (e) {
      say(`朗读失败：${errorText(e)}`);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });
  return btn;
}
