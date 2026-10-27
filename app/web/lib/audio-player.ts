import { AudioApi, AudioJob, DEFAULT_VOICE, VOICES } from "./audio-api";
import {
  firstNotReady,
  formatTime,
  isFullyReady,
  locate,
  nextSegment,
  pieceOffsets,
  prevSegment,
  progressPct,
  readyEndMs,
  timeOf,
  totalMs,
} from "./audio-timeline";
import { el, errorText, store } from "./common";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SPEED_KEY = "shelf:audio-speed";
const POLL_MS = 3000;
const SKIP_MS = 15000;
const DONE = new Set(["ready", "failed", "budget_exceeded"]);

export interface AudioPlayerOptions {
  api: AudioApi;
  bookId: string;
  bookTitle: string;
  /** Mount point (document.body by default). */
  parent?: HTMLElement;
}

export interface AudioPlayer {
  /** Opens the bar for a job (replaces the current one). */
  open(job: AudioJob, chapterKey: string): void;
  isOpenFor(chapterKey: string): boolean;
  togglePlay(): void;
  close(): void;
}

interface SavedPos { seg: number; t: number }

export function createAudioPlayer(opts: AudioPlayerOptions): AudioPlayer {
  const { api, bookId, bookTitle } = opts;
  const parent = opts.parent ?? document.body;

  let job: AudioJob | null = null;
  let chapterKey = "";
  let segPos = 0; // index into job.segments
  let curPiece = 0; // piece index within the segment
  let playing = false; // user intent
  let waiting = false; // want to play but the needed piece is not ready yet
  let pendingSeekMs: number | null = null; // offset within the current piece, applied on loadedmetadata
  let open = false;
  let pollTimer: number | undefined;
  let lastSave = 0;
  let speed = Number(store.get(SPEED_KEY)) || 1;
  if (!SPEEDS.includes(speed)) speed = 1;
  let dragging = false;

  const audios = [new Audio(), new Audio()];
  let cur = audios[0];
  let nxt = audios[1];
  for (const a of audios) {
    a.preload = "auto";
    a.preservesPitch = true;
    (a as any).webkitPreservesPitch = true;
  }
  const loadedKey = new WeakMap<HTMLAudioElement, string>();
  const keyOf = (seg: number, piece: number) => `${job!.id}:${seg}:${piece}`;

  // ---------- UI ----------
  const title = el("span", { class: "ap-title" });
  const collapseBtn = el("button", { type: "button", class: "ap-icon", title: "收起", "aria-label": "收起" }, "▾");
  const closeBtn = el("button", { type: "button", class: "ap-icon", title: "关闭朗读", "aria-label": "关闭朗读" }, "×");
  const status = el("div", { class: "ap-status", role: "status", "aria-live": "polite" });
  const retryBtn = el("button", { type: "button", class: "ap-retry", hidden: "" }, "重试");
  const elapsed = el("span", { class: "ap-time" }, "00:00");
  const total = el("span", { class: "ap-time" }, "00:00");
  const slider = el("input", { type: "range", class: "ap-slider", min: "0", max: "0", step: "1", value: "0", "aria-label": "播放进度" });
  const playBtn = el("button", { type: "button", class: "ap-play", title: "播放", "aria-label": "播放" }, "▶");
  const back = el("button", { type: "button", class: "ap-skip", title: "后退 15 秒", "aria-label": "后退 15 秒" }, "−15");
  const fwd = el("button", { type: "button", class: "ap-skip", title: "前进 15 秒", "aria-label": "前进 15 秒" }, "+15");
  const prevBtn = el("button", { type: "button", class: "ap-skip", title: "上一段", "aria-label": "上一段" }, "⏮");
  const nextBtn = el("button", { type: "button", class: "ap-skip", title: "下一段", "aria-label": "下一段" }, "⏭");
  const speedSel = el("select", { class: "ap-sel", "aria-label": "播放速度" });
  for (const s of SPEEDS) speedSel.append(el("option", { value: String(s) }, `${s}×`));
  speedSel.value = String(speed);
  const segSel = el("select", { class: "ap-sel", "aria-label": "选择段落" });
  const voiceSel = el("select", { class: "ap-sel", "aria-label": "音色" });
  for (const v of VOICES) voiceSel.append(el("option", { value: v }, v));

  const mini = el("button", { type: "button", class: "ap-mini", title: "展开朗读", "aria-label": "展开朗读", hidden: "" }, "朗读 ▴");
  const row1 = el("div", { class: "ap-row ap-head" }, title, collapseBtn, closeBtn);
  const row2 = el("div", { class: "ap-row ap-prog" }, elapsed, slider, total);
  const row3 = el("div", { class: "ap-row ap-ctl" }, prevBtn, back, playBtn, fwd, nextBtn);
  const row4 = el("div", { class: "ap-row ap-opts" }, segSel, speedSel, voiceSel);
  const body = el("div", { class: "ap-body" }, row1, status, retryBtn, row2, row3, row4);
  const bar = el("div", { class: "audio-bar", role: "region", "aria-label": "朗读播放器", hidden: "" }, body, mini);
  parent.append(bar);

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => syncHeight()) : null;
  ro?.observe(bar);
  function syncHeight() {
    document.documentElement.style.setProperty("--audio-h", open && !bar.hidden ? `${bar.offsetHeight}px` : "0px");
  }

  const seg = () => job?.segments[segPos] ?? null;

  function posKey() {
    return `shelf:audiopos:${bookId}:${chapterKey}:${job?.id}`;
  }
  function savePos(force = false) {
    if (!job) return;
    const now = Date.now();
    if (!force && now - lastSave < 2000) return;
    lastSave = now;
    store.set(posKey(), JSON.stringify({ seg: segPos, t: Math.round(currentMs()) } satisfies SavedPos));
  }
  function loadPos(): SavedPos | null {
    try {
      const v = JSON.parse(store.get(posKey()) || "null");
      if (v && Number.isFinite(v.seg) && Number.isFinite(v.t)) return v;
    } catch {
      /* ignore */
    }
    return null;
  }

  /** Current position on the segment's stitched timeline. */
  function currentMs(): number {
    const s = seg();
    if (!s) return 0;
    const base = pieceOffsets(s)[curPiece] ?? 0;
    const inPiece = pendingSeekMs ?? (cur.currentTime || 0) * 1000;
    return base + inPiece;
  }

  function render() {
    if (!job) return;
    const s = seg();
    title.textContent = `朗读 · ${job.chapterLabel || ""}`.trim();
    title.title = title.textContent;
    const nSeg = job.segments.length;
    // Segment selector
    if (segSel.options.length !== nSeg) {
      segSel.replaceChildren(...job.segments.map((_, i) => el("option", { value: String(i) }, `第 ${i + 1}/${nSeg} 段`)));
    }
    segSel.value = String(segPos);
    segSel.hidden = nSeg === 0;
    prevBtn.disabled = prevSegment(job.segments, segPos) === null;
    nextBtn.disabled = nextSegment(job.segments, segPos) === null;
    if (document.activeElement !== voiceSel) voiceSel.value = job.voice;

    // Timeline
    const tot = s ? totalMs(s) : 0;
    const end = s ? readyEndMs(s) : 0;
    slider.max = String(tot);
    slider.disabled = !s || end === 0;
    total.textContent = formatTime(tot) + (s && !isFullyReady(s) ? "+" : "");
    if (!dragging) {
      const t = Math.min(currentMs(), tot);
      slider.value = String(t);
      elapsed.textContent = formatTime(t);
    }
    const ratio = tot > 0 ? (end / tot) * 100 : 0;
    slider.style.setProperty("--ready", `${ratio}%`);
    playBtn.textContent = playing && !waiting ? "⏸" : "▶";
    playBtn.title = playing ? "暂停" : "播放";
    playBtn.setAttribute("aria-label", playBtn.title);
    bar.classList.toggle("waiting", waiting);

    // Status line
    retryBtn.hidden = true;
    let text = "";
    if (job.status === "failed") {
      text = `生成失败：${job.error || "未知错误"}`;
      retryBtn.hidden = false;
    } else if (job.status === "budget_exceeded") {
      text = "存储空间预算不足，无法继续生成";
    } else if (nSeg === 0 || job.totalPieces === 0) {
      text = job.status === "queued" ? "排队中…" : "正在整理文本…";
    } else if (job.status !== "ready") {
      const pct = progressPct(job.donePieces, job.totalPieces);
      const gi = firstNotReady(s || { index: 0, pieces: [] });
      const genSeg = job.segments.findIndex((x) => x.pieces.some((p) => !p.ready));
      text = `第 ${(genSeg < 0 ? segPos : genSeg) + 1} 段生成中 ${pct}%`;
      if (waiting) text += "，播放将在生成后继续";
      void gi;
    }
    if (waiting && job.status === "ready") text = "加载中…";
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle("err", job.status === "failed" || job.status === "budget_exceeded");
    updateMediaSession();
  }

  // ---------- Playback ----------
  function applyRate() {
    for (const a of audios) {
      a.playbackRate = speed;
      a.defaultPlaybackRate = speed;
      a.preservesPitch = true;
    }
  }

  function setSrc(a: HTMLAudioElement, seg: number, piece: number) {
    const k = keyOf(seg, piece);
    if (loadedKey.get(a) === k) return;
    loadedKey.set(a, k);
    const p = job!.segments[seg].pieces[piece];
    a.src = api.pieceUrl(job!.id, p.seq);
    a.load();
  }

  function preloadNext() {
    const s = seg();
    if (!s) return;
    const n = curPiece + 1;
    if (n < s.pieces.length && s.pieces[n].ready) setSrc(nxt, segPos, n);
  }

  /** Starts playing at a time of the current segment (clamped to what is ready). */
  function playAt(tMs: number, autoplay: boolean) {
    const s = seg();
    if (!s) return;
    const loc = locate(s, tMs);
    if (!loc) {
      curPiece = 0;
      pendingSeekMs = 0;
      waiting = autoplay;
      playing = autoplay;
      render();
      return;
    }
    // Seeking past the ready end while wanting to play: wait at the first not-ready piece.
    curPiece = loc.pieceIndex;
    pendingSeekMs = loc.offsetMs;
    setSrc(cur, segPos, curPiece);
    if (cur.readyState >= 1) applySeek();
    nxt.pause();
    preloadNext();
    playing = autoplay;
    waiting = false;
    if (autoplay) void startPlayback();
    render();
  }

  function applySeek() {
    if (pendingSeekMs === null) return;
    try {
      cur.currentTime = pendingSeekMs / 1000;
    } catch {
      return;
    }
    pendingSeekMs = null;
  }

  async function startPlayback() {
    applyRate();
    try {
      await cur.play();
    } catch {
      /* autoplay blocked or aborted; user can press play */
      if (cur.paused) {
        playing = false;
        render();
      }
    }
  }

  function pause() {
    playing = false;
    waiting = false;
    cur.pause();
    savePos(true);
    render();
  }

  function play() {
    const s = seg();
    if (!s) return;
    if (job && (job.status === "failed" || job.status === "budget_exceeded") && readyEndMs(s) === 0) return;
    let t = currentMs();
    if (readyEndMs(s) > 0 && t >= totalMs(s) - 200 && isFullyReady(s)) t = 0; // replay finished segment
    if (readyEndMs(s) === 0) {
      playing = true;
      waiting = true;
      render();
      return;
    }
    if (loadedKey.get(cur) === keyOf(segPos, curPiece) && t === currentMs() && pendingSeekMs === null) {
      playing = true;
      waiting = false;
      void startPlayback();
      render();
    } else {
      playAt(t, true);
    }
  }

  function togglePlay() {
    if (playing) pause();
    else play();
  }

  function seekTo(tMs: number) {
    const s = seg();
    if (!s) return;
    playAt(tMs, playing);
    if (!playing) {
      const end = readyEndMs(s);
      elapsed.textContent = formatTime(Math.min(tMs, end));
    }
    savePos(true);
  }

  function gotoSegment(i: number, autoplay: boolean, tMs = 0) {
    if (!job || i < 0 || i >= job.segments.length) return;
    cur.pause();
    nxt.pause();
    loadedKey.delete(cur);
    loadedKey.delete(nxt);
    segPos = i;
    curPiece = 0;
    pendingSeekMs = 0;
    playAt(tMs, autoplay);
    savePos(true);
  }

  function onEnded(a: HTMLAudioElement) {
    if (a !== cur) return;
    const s = seg();
    if (!s || !job) return;
    const n = curPiece + 1;
    if (n < s.pieces.length) {
      if (s.pieces[n].ready) {
        // Near-gapless: the preloaded element takes over immediately.
        setSrc(nxt, segPos, n);
        const prev = cur;
        cur = nxt;
        nxt = prev;
        curPiece = n;
        pendingSeekMs = null;
        applyRate();
        if (cur.readyState >= 1) cur.currentTime = 0;
        void startPlayback();
        preloadNext();
        render();
      } else {
        // Next piece is still being generated: wait for it.
        curPiece = n;
        pendingSeekMs = 0;
        waiting = true;
        render();
      }
      return;
    }
    // End of segment.
    const ns = nextSegment(job.segments, segPos);
    if (ns !== null) gotoSegment(ns, true);
    else {
      playing = false;
      savePos(true);
      render();
    }
  }

  function tryResumeWaiting() {
    if (!waiting || !job) return;
    const s = seg();
    if (!s) return;
    const p = s.pieces[curPiece];
    if (p?.ready) {
      loadedKey.delete(cur);
      playAt(timeOf(s, curPiece, pendingSeekMs ?? 0), true);
    }
  }

  for (const a of audios) {
    a.addEventListener("ended", () => onEnded(a));
    a.addEventListener("loadedmetadata", () => {
      if (a === cur) applySeek();
    });
    a.addEventListener("timeupdate", () => {
      if (a !== cur) return;
      savePos();
      if (!dragging) {
        const t = currentMs();
        slider.value = String(t);
        elapsed.textContent = formatTime(t);
      }
    });
    a.addEventListener("waiting", () => {
      if (a === cur && playing) bar.classList.add("waiting");
    });
    a.addEventListener("playing", () => {
      if (a === cur) bar.classList.remove("waiting");
    });
    a.addEventListener("error", () => {
      if (a !== cur || !loadedKey.has(a) || !a.src) return;
      status.textContent = "音频加载失败，请重试";
      status.classList.add("err");
      status.hidden = false;
      playing = false;
      playBtn.textContent = "▶";
    });
    a.addEventListener("play", () => {
      if (a === cur) {
        playing = true;
        playBtn.textContent = "⏸";
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      }
    });
    a.addEventListener("pause", () => {
      if (a === cur && "mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    });
  }

  // ---------- Job polling ----------
  function schedulePoll() {
    window.clearTimeout(pollTimer);
    // Keep polling in the background while listening (e.g. a locked phone) so playback can continue
    // into pieces that finish later; otherwise pause polling while the page is hidden.
    if (!open || !job || DONE.has(job.status) || (document.hidden && !playing)) return;
    pollTimer = window.setTimeout(poll, POLL_MS);
  }

  async function poll() {
    if (!open || !job) return;
    const id = job.id;
    try {
      const fresh = await api.get(id);
      if (!open || !job || job.id !== id) return;
      job = fresh;
      if (segPos >= job.segments.length) segPos = Math.max(0, job.segments.length - 1);
      tryResumeWaiting();
      if (playing && !waiting) preloadNext();
      render();
    } catch (e) {
      status.textContent = `状态刷新失败：${errorText(e)}`;
      status.hidden = false;
    }
    schedulePoll();
  }

  document.addEventListener("visibilitychange", () => {
    if (!open) return;
    if (document.hidden) {
      if (!playing) window.clearTimeout(pollTimer);
    }
    else if (job && !DONE.has(job.status)) void poll();
  });

  // ---------- Media Session ----------
  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !job) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: job.chapterLabel || "朗读",
        artist: bookTitle,
        album: job.segments.length > 1 ? `第 ${segPos + 1}/${job.segments.length} 段` : "The Shelf",
      });
    } catch {
      /* ignore */
    }
  }
  function bindMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const set = (name: MediaSessionAction, fn: () => void) => {
      try {
        navigator.mediaSession.setActionHandler(name, fn);
      } catch {
        /* unsupported action */
      }
    };
    set("play", () => play());
    set("pause", () => pause());
    set("seekbackward", () => seekTo(currentMs() - SKIP_MS));
    set("seekforward", () => seekTo(currentMs() + SKIP_MS));
    set("previoustrack", () => {
      const p = prevSegment(job?.segments ?? [], segPos);
      if (p !== null) gotoSegment(p, playing);
    });
    set("nexttrack", () => {
      const n = nextSegment(job?.segments ?? [], segPos);
      if (n !== null) gotoSegment(n, playing);
    });
  }
  function unbindMediaSession() {
    if (!("mediaSession" in navigator)) return;
    for (const n of ["play", "pause", "seekbackward", "seekforward", "previoustrack", "nexttrack"] as MediaSessionAction[]) {
      try {
        navigator.mediaSession.setActionHandler(n, null);
      } catch {
        /* ignore */
      }
    }
    navigator.mediaSession.metadata = null;
  }

  // ---------- Events ----------
  playBtn.addEventListener("click", togglePlay);
  back.addEventListener("click", () => seekTo(currentMs() - SKIP_MS));
  fwd.addEventListener("click", () => seekTo(currentMs() + SKIP_MS));
  prevBtn.addEventListener("click", () => {
    if (!job) return;
    // Like a music player: first rewind the current segment, then go to the previous one.
    if (currentMs() > 3000) return seekTo(0);
    const p = prevSegment(job.segments, segPos);
    if (p !== null) gotoSegment(p, playing);
    else seekTo(0);
  });
  nextBtn.addEventListener("click", () => {
    const n = job ? nextSegment(job.segments, segPos) : null;
    if (n !== null) gotoSegment(n, playing);
  });
  segSel.addEventListener("change", () => gotoSegment(Number(segSel.value), playing));
  speedSel.addEventListener("change", () => {
    speed = Number(speedSel.value) || 1;
    store.set(SPEED_KEY, String(speed));
    applyRate();
  });
  slider.addEventListener("pointerdown", () => (dragging = true));
  slider.addEventListener("input", () => {
    dragging = true;
    elapsed.textContent = formatTime(Math.min(Number(slider.value), readyEndMs(seg() ?? { index: 0, pieces: [] })));
  });
  slider.addEventListener("change", () => {
    dragging = false;
    seekTo(Number(slider.value));
    render();
  });
  slider.addEventListener("pointerup", () => (dragging = false));
  voiceSel.addEventListener("change", async () => {
    if (!job) return;
    const v = voiceSel.value;
    if (v === job.voice) return;
    if (!window.confirm(`更换音色为 ${v} 会重新生成本章语音，是否继续？`)) {
      voiceSel.value = job.voice;
      return;
    }
    await regenerate(v);
  });
  retryBtn.addEventListener("click", () => void regenerate(job?.voice));
  collapseBtn.addEventListener("click", () => setCollapsed(true));
  mini.addEventListener("click", () => setCollapsed(false));
  closeBtn.addEventListener("click", close);

  async function regenerate(voice?: string) {
    if (!job) return;
    status.textContent = "正在重新生成…";
    status.hidden = false;
    try {
      const fresh = await api.regenerate(job.id, voice);
      const wasPlaying = playing;
      stopAudio();
      setJob(fresh, false);
      playing = wasPlaying;
      waiting = wasPlaying;
      render();
      schedulePoll();
    } catch (e) {
      status.textContent = `重新生成失败：${errorText(e)}`;
      status.classList.add("err");
      if (job) voiceSel.value = job.voice;
    }
  }

  function setCollapsed(c: boolean) {
    body.hidden = c;
    mini.hidden = !c;
    bar.classList.toggle("collapsed", c);
    syncHeight();
  }

  function stopAudio() {
    for (const a of audios) {
      a.pause();
      a.removeAttribute("src");
      a.load();
      loadedKey.delete(a);
    }
    playing = false;
    waiting = false;
    pendingSeekMs = null;
  }

  function setJob(j: AudioJob, restore: boolean) {
    job = j;
    segPos = 0;
    curPiece = 0;
    pendingSeekMs = 0;
    const saved = restore ? loadPos() : null;
    if (saved && saved.seg < (j.segments.length || 1)) {
      segPos = saved.seg;
      const s = seg();
      if (s) {
        const loc = locate(s, saved.t);
        if (loc) {
          curPiece = loc.pieceIndex;
          pendingSeekMs = loc.offsetMs;
        }
      }
    }
    segSel.replaceChildren();
  }

  function open_(j: AudioJob, key: string) {
    if (open && job && job.id === j.id) {
      job = j;
      render();
      return;
    }
    stopAudio();
    chapterKey = key;
    open = true;
    applyRate();
    bar.hidden = false;
    document.body.classList.add("audio-open");
    setCollapsed(false);
    setJob(j, true);
    bindMediaSession();
    render();
    schedulePoll();
    syncHeight();
  }

  function close() {
    savePos(true);
    stopAudio();
    window.clearTimeout(pollTimer);
    open = false;
    job = null;
    bar.hidden = true;
    document.body.classList.remove("audio-open");
    unbindMediaSession();
    syncHeight();
  }

  return {
    open: open_,
    isOpenFor: (key) => open && chapterKey === key,
    togglePlay,
    close,
  };
}

export { DEFAULT_VOICE };
