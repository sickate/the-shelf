import { audioMockEnabled, getAudioApi } from "./audio-api";
import { AudioPlayer, createAudioPlayer } from "./audio-player";
import { getChapterSource } from "./chapter-source";
import { el, errorText } from "./common";
import { createReadAlong } from "./read-along";

// The read-aloud backend (A1) is implemented (app/worker.mjs + AudioWorkflow); ?audioMock=1 still previews.
const AUDIO_BACKEND_READY = true;
export const audioAvailable = () => AUDIO_BACKEND_READY || audioMockEnabled();

const mockSource = async () => ({ chapterKey: "mock-chapter", label: "示例章节", text: "这是用于预览播放器的示例文字。", truncated: false });

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
  let player: AudioPlayer | null = null;
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
      if (player?.isOpenFor(ch.chapterKey)) return player.togglePlay();
      let job = await api.find(bookId, ch.chapterKey);
      if (!job) {
        job = await api.create(bookId, { chapterKey: ch.chapterKey, label: ch.label, text: ch.text });
        say(ch.truncated ? `章节过长，从当前位置朗读前 30 万字：${ch.label}` : `开始生成：${ch.label}`);
      }
      if (!player) {
        const readAlong = createReadAlong();
        player = createAudioPlayer({ api, bookId, bookTitle, readAlong, onPosition: readAlong.update });
      }
      player.open(job, ch.chapterKey);
    } catch (e) {
      say(`朗读失败：${errorText(e)}`);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  });
  return btn;
}
