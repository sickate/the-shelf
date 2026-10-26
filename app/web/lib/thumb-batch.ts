// Owner panel: "补全缩略图" — generates missing covers one book at a time (concurrency 1).
import { ApiError, Book, el, errorText, splitTitle, store } from "./common";
import { canThumb, ensureThumb } from "./thumb";

const REASON_TEXT: Record<string, string> = {
  no_cover: "无封面",
  parse_failed: "解析失败",
  budget_exceeded: "预算不足",
  storage_unknown: "写入结果未知",
  upload_failed: "上传失败",
  timeout: "超时",
};

/** A book whose parser never settles must not stall the whole batch. */
const BOOK_TIMEOUT_MS = 120_000;

export interface ThumbPanelOptions {
  /** Current catalog (owner view, with hasCover). */
  books: () => Book[];
  /** Called after a cover was stored for `book`. */
  onCover: (book: Book) => void;
  /** Called on 401: the session is gone. */
  onUnauthorized: () => void;
}

export function mountThumbPanel(root: HTMLElement, opts: ThumbPanelOptions) {
  const start = el("button", { type: "button" }, "补全缩略图");
  const pause = el("button", { type: "button", class: "link-btn", hidden: "" }, "暂停");
  const progress = el("span", { class: "muted small thumb-progress", role: "status", "aria-live": "polite" });
  const failSummary = el("summary", {}, "");
  const failList = el("ul", { class: "thumb-fails" });
  const fails = el("details", { class: "thumb-fail-box", hidden: "" }, failSummary, failList);
  root.replaceChildren(el("div", { class: "thumb-row" }, start, pause, progress), fails);

  const failed = new Map<string, string>(); // id -> reason (not retried within this page view)
  // Books that produced no thumbnail at all ("no_cover") are skipped in later runs too (detail
  // page can retry). Versioned: v1 entries predate the first-page / designed-cover fallback.
  const NO_COVER_KEY = "shelf:thumb-no-cover:v2";
  try {
    localStorage.removeItem("shelf:thumb-no-cover");
  } catch {
    /* ignore */
  }
  const noCover = new Set<string>((store.get(NO_COVER_KEY) || "").split(",").filter(Boolean));
  let running = false;
  let paused = false;
  let resume: (() => void) | null = null;

  const missing = () =>
    opts.books().filter((b) => canThumb(b) && !b.hasCover && !failed.has(String(b.id)) && !noCover.has(String(b.id)));

  function refresh() {
    const n = missing().length;
    start.textContent = `补全缩略图（${n.toLocaleString()} 本缺失）`;
    start.disabled = running || n === 0;
    root.hidden = !opts.books().some(canThumb);
  }

  function renderFails() {
    const counts = new Map<string, number>();
    for (const r of failed.values()) counts.set(r, (counts.get(r) || 0) + 1);
    failSummary.textContent = `失败 ${failed.size} 本：${[...counts].map(([r, n]) => `${REASON_TEXT[r] || r} ${n}`).join("，")}`;
    fails.hidden = failed.size === 0;
  }

  function fail(b: Book, reason: string) {
    failed.set(String(b.id), reason);
    if (reason === "no_cover") {
      noCover.add(String(b.id));
      store.set(NO_COVER_KEY, [...noCover].join(","));
    }
    failList.append(el("li", {}, el("span", { class: "title" }, splitTitle(b.title).main), el("span", { class: "error" }, REASON_TEXT[reason] || reason)));
    renderFails();
  }

  pause.addEventListener("click", () => {
    paused = !paused;
    pause.textContent = paused ? "继续" : "暂停";
    if (!paused) {
      resume?.();
      resume = null;
    }
  });

  start.addEventListener("click", async () => {
    if (running) return;
    running = true;
    paused = false;
    pause.textContent = "暂停";
    pause.hidden = false;
    refresh();
    const queue = missing();
    let done = 0;
    let stopped = "";
    for (const b of queue) {
      if (paused) {
        progress.textContent = `已暂停 ${done}/${queue.length}`;
        await new Promise<void>((r) => (resume = r));
      }
      if (b.hasCover) {
        done++;
        continue;
      }
      progress.textContent = `正在生成 ${done + 1}/${queue.length}：${splitTitle(b.title).main}`;
      try {
        let timer = 0;
        const r = await Promise.race([
          ensureThumb(b),
          new Promise<{ ok: false; reason: "timeout" }>((res) => (timer = window.setTimeout(() => res({ ok: false, reason: "timeout" }), BOOK_TIMEOUT_MS))),
        ]).finally(() => clearTimeout(timer));
        if (r.ok) opts.onCover(b);
        else fail(b, r.reason);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          stopped = "登录已失效，请重新登录后继续。";
          opts.onUnauthorized();
          break;
        }
        if (e instanceof ApiError && e.status === 507) {
          fail(b, "budget_exceeded");
          stopped = "已停止：超出 8 GB 上传预算。";
          break;
        }
        // storage_unknown etc.: keep the server's conservative state, never auto-retry.
        fail(b, e instanceof ApiError && e.code === "storage_unknown" ? "storage_unknown" : "upload_failed");
        console.warn(`cover upload ${b.id}: ${errorText(e)}`);
      }
      done++;
    }
    running = false;
    pause.hidden = true;
    const ok = queue.filter((b) => b.hasCover).length;
    progress.textContent = stopped || `完成：${done}/${queue.length}，新增缩略图 ${ok} 本${failed.size ? `，失败 ${failed.size} 本` : ""}。`;
    if (stopped) progress.classList.add("error");
    else progress.classList.remove("error");
    refresh();
  });

  refresh();
  return { refresh };
}
