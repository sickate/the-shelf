// CBZ comic reader: single / double page spreads, right-to-left (manga, default) or
// left-to-right, fit width / fit height, keyboard and click-half page turning, ±2 page
// preloading and a remembered page per book. read.ts only hands over its page elements.
import { el, store } from "./common";
import { CbzError, openCbz } from "./cbz";

export interface ComicContext {
  view: HTMLElement;
  toolbar: HTMLElement;
  /** localStorage key for this book's position (1-based page number). */
  posKey: string;
  /** Downloads the whole file (with progress UI). */
  load: () => Promise<ArrayBuffer>;
  setStage: (text: string, detail?: string) => void;
  hideLoading: () => void;
  showError: (text: string) => void;
}

type Dir = "rtl" | "ltr";
type Fit = "width" | "height";

const DIR_KEY = "shelf:comic:dir";
const SPREAD_KEY = "shelf:comic:spread";
const FIT_KEY = "shelf:comic:fit";
const PRELOAD = 2;
const narrow = () => window.matchMedia("(max-width: 760px)").matches;

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { type: "button", title, "aria-label": title }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** First page index of the spread containing page `i` (page 0, the cover, stands alone). */
export function spreadStart(i: number, double: boolean): number {
  if (!double || i <= 0) return Math.max(0, i);
  return i % 2 === 1 ? i : i - 1;
}

export async function readComic(ctx: ComicContext): Promise<void> {
  const buf = await ctx.load();
  ctx.setStage("正在解析 CBZ…");
  let archive;
  try {
    archive = openCbz(buf);
  } catch (e) {
    if (e instanceof CbzError) {
      ctx.showError(`${e.message}，请下载后用其他阅读器打开。`);
      return;
    }
    throw e;
  }
  const total = archive.pages.length;

  let dir: Dir = store.get(DIR_KEY) === "ltr" ? "ltr" : "rtl";
  let wantDouble = store.get(SPREAD_KEY) === "2";
  let fit: Fit = store.get(FIT_KEY) === "width" ? "width" : "height";
  let cur = Math.min(Math.max(1, Number(store.get(ctx.posKey)) || 1), total) - 1;
  const double = () => wantDouble && !narrow() && total > 1;

  // Object URLs for decoded pages; only the current window (±PRELOAD) is kept.
  const urls = new Map<number, Promise<string>>();
  const live = new Set<string>();
  const url = (i: number): Promise<string> => {
    let p = urls.get(i);
    if (!p) {
      p = archive.page(i).then((blob) => {
        const u = URL.createObjectURL(blob);
        live.add(u);
        return u;
      });
      p.catch(() => urls.delete(i));
      urls.set(i, p);
    }
    return p;
  };
  const prune = (from: number, to: number) => {
    for (const [i, p] of urls) {
      if (i >= from && i <= to) continue;
      urls.delete(i);
      p.then((u) => {
        URL.revokeObjectURL(u);
        live.delete(u);
      }).catch(() => {});
    }
  };
  window.addEventListener("pagehide", () => {
    for (const u of live) URL.revokeObjectURL(u);
    live.clear();
    urls.clear();
  });

  const pages = el("div", { class: "comic-pages" });
  const wrap = el("div", { class: "comic-wrap" }, pages);
  ctx.view.replaceChildren(wrap);

  const pageInput = el("input", { type: "number", min: "1", max: String(total), class: "page-input", "aria-label": "页码" });
  const progress = el("span", { class: "muted small comic-progress" });
  const spreadBtn = button("", "单页 / 双页", () => {
    wantDouble = !wantDouble;
    store.set(SPREAD_KEY, wantDouble ? "2" : "1");
    render();
  });
  const dirBtn = button("", "翻页方向", () => {
    dir = dir === "rtl" ? "ltr" : "rtl";
    store.set(DIR_KEY, dir);
    render();
  });
  const fitBtn = button("", "适合宽度 / 适合高度", () => {
    fit = fit === "height" ? "width" : "height";
    store.set(FIT_KEY, fit);
    render();
  });

  const next = () => go(double() ? (spreadStart(cur, true) === 0 ? 1 : spreadStart(cur, true) + 2) : cur + 1);
  const prev = () => go(double() ? Math.max(0, spreadStart(cur, true) - 2) : cur - 1);
  // Spatial turning: in right-to-left books the left side moves forward.
  const left = () => (dir === "rtl" ? next() : prev());
  const right = () => (dir === "rtl" ? prev() : next());

  ctx.toolbar.replaceChildren(
    button("‹", "向左翻页", left),
    pageInput,
    progress,
    button("›", "向右翻页", right),
    el("span", { class: "sep" }),
    spreadBtn,
    dirBtn,
    fitBtn,
  );
  ctx.toolbar.hidden = false;
  pageInput.addEventListener("change", () => go((Number(pageInput.value) || 1) - 1));

  function go(i: number) {
    const n = Math.min(Math.max(0, i), total - 1);
    if (spreadStart(n, double()) === cur) return;
    cur = n;
    render();
  }

  const setHeight = () => {
    // The header and toolbar are sticky, so the page area is what lies below the toolbar.
    const top = Math.max(0, ctx.toolbar.getBoundingClientRect().bottom);
    wrap.style.setProperty("--comic-h", `${Math.max(240, Math.floor(window.innerHeight - top - 16))}px`);
  };

  let token = 0;
  let first = true;
  async function render() {
    const t = ++token;
    const dbl = double();
    const start = spreadStart(cur, dbl);
    const shown = dbl && start > 0 && start + 1 < total ? [start, start + 1] : [start];
    cur = start;
    store.set(ctx.posKey, String(cur + 1));
    pageInput.value = String(cur + 1);
    const last = shown[shown.length - 1] + 1;
    progress.textContent = shown.length > 1 ? `–${last} / ${total}` : `/ ${total}`;
    spreadBtn.textContent = dbl ? "双页" : "单页";
    spreadBtn.disabled = narrow() || total < 2;
    dirBtn.textContent = dir === "rtl" ? "右→左" : "左→右";
    fitBtn.textContent = fit === "height" ? "适高" : "适宽";
    wrap.className = `comic-wrap fit-${fit} ${dbl ? "double" : "single"} ${dir}`;
    setHeight();

    let srcs: string[];
    try {
      srcs = await Promise.all(shown.map(url));
    } catch (e: any) {
      if (t !== token) return;
      ctx.hideLoading();
      pages.replaceChildren(el("p", { class: "comic-missing" }, `第 ${cur + 1} 页无法解码：${e?.message || e}`));
      return;
    }
    if (t !== token) return;
    const imgs = srcs.map((src, k) => el("img", { src, alt: `第 ${shown[k] + 1} 页`, class: "comic-page", draggable: "false" }));
    // A lone page in double mode (cover or last page) is centred.
    pages.replaceChildren(...imgs);
    if (fit === "width") window.scrollTo(0, 0);
    wrap.scrollTop = 0;
    if (first) {
      first = false;
      await Promise.race([imgs[0].decode().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      ctx.hideLoading();
    }
    // Preload the neighbourhood, drop everything outside it.
    const from = Math.max(0, start - PRELOAD);
    const to = Math.min(total - 1, start + shown.length - 1 + PRELOAD);
    prune(from, to);
    for (let i = from; i <= to; i++) {
      url(i)
        .then((u) => {
          if (t === token) new Image().src = u;
        })
        .catch(() => {});
    }
  }

  wrap.addEventListener("click", (ev) => {
    if (window.getSelection()?.toString()) return;
    const r = wrap.getBoundingClientRect();
    if (ev.clientX - r.left < r.width / 2) left();
    else right();
  });
  document.addEventListener("keydown", (ev) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === "ArrowLeft") left();
    else if (ev.key === "ArrowRight") right();
    else if (ev.key === "PageDown" || (ev.key === " " && fit === "height")) next();
    else if (ev.key === "PageUp") prev();
    else if (ev.key === "Home") go(0);
    else if (ev.key === "End") go(total - 1);
    else return;
    ev.preventDefault();
  });
  let rt: number | undefined;
  let wasNarrow = narrow();
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      if (narrow() !== wasNarrow) {
        wasNarrow = narrow();
        render();
      } else setHeight();
    }, 150);
  });

  ctx.setStage(`正在显示第 ${cur + 1} 页…`, `共 ${total} 页`);
  await render();
}
