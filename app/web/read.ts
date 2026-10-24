import { api, ApiError, Book, bookUrl, el, errorText, fmt, getOwner, humanSize, loginForm, splitTitle, store } from "./lib/common";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $<HTMLHeadingElement>("book-title");
const dlLink = $<HTMLAnchorElement>("download");
const toolbar = $<HTMLDivElement>("toolbar");
const msg = $<HTMLParagraphElement>("msg");
const loginBox = $<HTMLDivElement>("login");
const view = $<HTMLElement>("view");
const loading = $<HTMLElement>("loading");
const loadingText = $<HTMLParagraphElement>("loading-text");
const loadingDetail = $<HTMLParagraphElement>("loading-detail");
const progressBar = $<HTMLDivElement>("progress-bar");

const id = new URLSearchParams(location.search).get("id") || "";
const fileUrl = `/api/books/${encodeURIComponent(id)}/file`;
const posKey = `shelf:pos:${id}`;

// ---------------- Loading status ----------------
function setStage(text: string, detail = "") {
  loading.hidden = false;
  loadingText.textContent = text;
  loadingDetail.textContent = detail;
}

/** Determinate bar when the total is known; otherwise an indeterminate bar with bytes loaded. */
function setProgress(loaded: number, total?: number, determinate = true) {
  const known = !!total && total > 0 && determinate;
  progressBar.classList.toggle("indeterminate", !known);
  progressBar.style.width = known ? `${Math.min(100, (loaded / total!) * 100).toFixed(1)}%` : "";
  loadingDetail.textContent = known
    ? `${Math.floor(Math.min(100, (loaded / total!) * 100))}% · ${humanSize(loaded)} / ${humanSize(total!)}`
    : total
      ? `已加载 ${humanSize(loaded)} · 文件共 ${humanSize(total)}`
      : `已加载 ${humanSize(loaded)}`;
}

function hideLoading() {
  loading.hidden = true;
}

function showError(text: string) {
  hideLoading();
  msg.textContent = text;
  msg.hidden = false;
}

function requireLogin() {
  hideLoading();
  loginBox.replaceChildren(el("p", {}, "需要所有者登录后才能阅读。"), loginForm(() => location.reload()));
  loginBox.hidden = false;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { type: "button", title, "aria-label": title }, label);
  b.addEventListener("click", onClick);
  return b;
}

/** Downloads the whole file, streaming the body so progress can be shown. */
async function fetchFile(label: string): Promise<ArrayBuffer> {
  setStage(`正在下载${label}…`);
  setProgress(0);
  const res = await fetch(fileUrl, { credentials: "same-origin" });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      code = (await res.json()).error || code;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  setProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    setProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

// ---------------- PDF ----------------
async function readPdf(sizeBytes: number) {
  setStage("正在加载 PDF 阅读器…");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  setStage("正在打开 PDF…");
  setProgress(0, sizeBytes, false);
  // Range loading: with disableStream pdf.js aborts the initial full GET once it sees
  // Accept-Ranges/Content-Length and then fetches only the 256 KB chunks it needs, so the
  // first page appears without downloading the whole file. disableAutoFetch stops it from
  // prefetching the rest in the background. (Files <= 512 KB are simply fetched whole.)
  const loadingTask = pdfjs.getDocument({
    url: fileUrl,
    withCredentials: true,
    rangeChunkSize: 65536 * 4,
    disableStream: true,
    disableAutoFetch: true,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  });
  // In range mode "loaded" is just the chunks fetched so far, so show bytes, not a percentage.
  loadingTask.onProgress = ({ loaded, total }: { loaded: number; total?: number }) =>
    setProgress(loaded, total || sizeBytes, false);
  const pdf = await loadingTask.promise;

  const total = pdf.numPages;
  let pageNum = Math.min(Math.max(1, Number(store.get(posKey)) || 1), total);
  let zoom = 0; // 0 = fit width, else absolute scale
  let task: { cancel(): void; promise: Promise<void> } | null = null;
  let firstRender = true;
  const busy = el("span", { class: "busy muted small", "aria-live": "polite" });

  const canvas = el("canvas", { class: "pdf-page" });
  const wrap = el("div", { class: "pdf-wrap" }, canvas);
  view.replaceChildren(wrap);

  const pageInput = el("input", { type: "number", min: "1", max: String(total), class: "page-input", "aria-label": "页码" });
  const zoomLabel = el("span", { class: "muted small zoom-label" });
  const tocSelect = el("select", { "aria-label": "目录", hidden: "" });

  async function render() {
    task?.cancel();
    const n = pageNum;
    pageInput.value = String(n);
    store.set(posKey, String(n));
    if (firstRender) setStage(`正在渲染第 ${n} 页…`, `共 ${total} 页`);
    busy.textContent = `正在渲染第 ${n} 页…`;
    const page = await pdf.getPage(n);
    if (n !== pageNum) return; // superseded while loading
    const base = page.getViewport({ scale: 1 });
    const avail = Math.max(200, wrap.clientWidth - 16);
    const scale = zoom || avail / base.width;
    zoomLabel.textContent = zoom ? `${Math.round(scale * 100)}%` : "适合宽度";
    const vp = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    const t = page.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    task = t;
    try {
      await t.promise;
      if (n === pageNum) busy.textContent = "";
    } catch (e: any) {
      if (e?.name !== "RenderingCancelledException") {
        busy.textContent = "";
        showError(`第 ${n} 页渲染失败：${e?.message || e}`);
      }
    }
    if (firstRender) {
      firstRender = false;
      hideLoading();
    }
  }
  const go = (n: number) => {
    const next = Math.min(Math.max(1, n), total);
    if (next !== pageNum) {
      pageNum = next;
      render();
      wrap.scrollTop = 0;
    }
  };
  const currentScale = async () => {
    if (zoom) return zoom;
    const page = await pdf.getPage(pageNum);
    return Math.max(200, wrap.clientWidth - 16) / page.getViewport({ scale: 1 }).width;
  };

  pageInput.addEventListener("change", () => go(Number(pageInput.value) || 1));
  toolbar.replaceChildren(
    button("‹", "上一页", () => go(pageNum - 1)),
    pageInput,
    el("span", { class: "muted small" }, `/ ${total}`),
    button("›", "下一页", () => go(pageNum + 1)),
    el("span", { class: "sep" }),
    button("−", "缩小", async () => {
      zoom = Math.max(0.25, (await currentScale()) / 1.2);
      render();
    }),
    zoomLabel,
    button("+", "放大", async () => {
      zoom = Math.min(6, (await currentScale()) * 1.2);
      render();
    }),
    button("适宽", "适合宽度", () => {
      zoom = 0;
      render();
    }),
    tocSelect,
    busy,
  );
  toolbar.hidden = false;

  document.addEventListener("keydown", (ev) => {
    if ((ev.target as HTMLElement).tagName === "INPUT" || (ev.target as HTMLElement).tagName === "SELECT") return;
    if (ev.key === "ArrowLeft" || ev.key === "PageUp") go(pageNum - 1);
    else if (ev.key === "ArrowRight" || ev.key === "PageDown") go(pageNum + 1);
    else return;
    ev.preventDefault();
  });
  let rt: number | undefined;
  window.addEventListener("resize", () => {
    if (zoom) return;
    clearTimeout(rt);
    rt = window.setTimeout(render, 150);
  });

  await render();

  // Outline (TOC)
  try {
    const outline = await pdf.getOutline();
    if (outline?.length) {
      const opts: HTMLOptionElement[] = [el("option", { value: "" }, "目录")];
      const walk = (items: any[], depth: number) => {
        for (const it of items) {
          if (opts.length > 2000) return;
          const o = el("option", { value: String(opts.length) }, `${"　".repeat(depth)}${it.title}`);
          (o as any)._dest = it.dest;
          opts.push(o);
          if (it.items?.length) walk(it.items, depth + 1);
        }
      };
      walk(outline, 0);
      tocSelect.replaceChildren(...opts);
      tocSelect.hidden = false;
      tocSelect.addEventListener("change", async () => {
        const o = tocSelect.selectedOptions[0] as any;
        tocSelect.value = "";
        try {
          let dest = o?._dest;
          if (typeof dest === "string") dest = await pdf.getDestination(dest);
          if (!Array.isArray(dest)) return;
          const ref = dest[0];
          const idx = typeof ref === "number" ? ref : await pdf.getPageIndex(ref);
          go(idx + 1);
        } catch {
          /* ignore broken outline */
        }
      });
    }
  } catch {
    /* no outline */
  }
}

// ---------------- EPUB ----------------
async function readEpub() {
  const [{ default: ePub }, buf] = await Promise.all([import("epubjs"), fetchFile(" EPUB")]);
  setStage("正在解析 EPUB…");
  const book = ePub(buf as any);
  const area = el("div", { class: "epub-area" });
  view.replaceChildren(area);
  const rendition = book.renderTo(area, { width: "100%", height: "100%", flow: "paginated", spread: "none" } as any);

  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => {
    rendition.themes.override("color", dark.matches ? "#e6e2d6" : "#282820");
    rendition.themes.override("background", "transparent");
  };
  applyTheme();
  dark.addEventListener?.("change", applyTheme);

  let fontPct = Number(store.get("shelf:epub-font")) || 100;
  rendition.themes.fontSize(`${fontPct}%`);
  const setFont = (d: number) => {
    fontPct = Math.min(200, Math.max(60, fontPct + d));
    rendition.themes.fontSize(`${fontPct}%`);
    store.set("shelf:epub-font", String(fontPct));
  };

  const tocSelect = el("select", { "aria-label": "目录", hidden: "" });
  const loc = el("span", { class: "muted small" });
  toolbar.replaceChildren(
    button("‹", "上一页", () => rendition.prev()),
    button("›", "下一页", () => rendition.next()),
    el("span", { class: "sep" }),
    button("A−", "缩小字号", () => setFont(-10)),
    button("A+", "放大字号", () => setFont(10)),
    tocSelect,
    loc,
  );
  toolbar.hidden = false;

  rendition.on("relocated", (location: any) => {
    const cfi = location?.start?.cfi;
    if (cfi) store.set(posKey, cfi);
    const pct = location?.start?.percentage;
    if (typeof pct === "number" && pct > 0) loc.textContent = `${Math.round(pct * 100)}%`;
  });
  const onKey = (ev: KeyboardEvent) => {
    if ((ev.target as HTMLElement)?.tagName === "SELECT") return;
    if (ev.key === "ArrowLeft" || ev.key === "PageUp") rendition.prev();
    else if (ev.key === "ArrowRight" || ev.key === "PageDown") rendition.next();
  };
  rendition.on("keyup", onKey);
  document.addEventListener("keyup", onKey);

  const saved = store.get(posKey);
  setStage("正在排版…");
  try {
    await rendition.display(saved || undefined);
  } catch {
    await rendition.display();
  }
  hideLoading();

  book.loaded.navigation.then((nav: any) => {
    const opts: HTMLOptionElement[] = [el("option", { value: "" }, "目录")];
    const walk = (items: any[], depth: number) => {
      for (const it of items || []) {
        opts.push(el("option", { value: it.href }, `${"　".repeat(depth)}${String(it.label || "").trim()}`));
        walk(it.subitems, depth + 1);
      }
    };
    walk(nav?.toc, 0);
    if (opts.length > 1) {
      tocSelect.replaceChildren(...opts);
      tocSelect.hidden = false;
      tocSelect.addEventListener("change", () => {
        const href = tocSelect.value;
        tocSelect.value = "";
        if (href) rendition.display(href).catch(() => {});
      });
    }
  });
  // Generate locations in background for percentage display.
  book.ready.then(() => book.locations.generate(1600)).catch(() => {});
}

// ---------------- TXT / MD ----------------
function decode(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buf);
    } catch {
      return new TextDecoder("utf-8").decode(buf);
    }
  }
}

async function readText() {
  const text = decode(await fetchFile("文本"));
  hideLoading();
  const article = el("article", { class: "text-body" });
  article.textContent = text;
  view.replaceChildren(article);
  view.classList.add("text-view");
  toolbar.hidden = true;
  const saved = Number(store.get(posKey));
  if (saved > 0) {
    requestAnimationFrame(() => window.scrollTo(0, saved * (document.documentElement.scrollHeight - innerHeight)));
  }
  let t: number | undefined;
  window.addEventListener(
    "scroll",
    () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        if (max > 0) store.set(posKey, (scrollY / max).toFixed(5));
      }, 250);
    },
    { passive: true },
  );
}

// ---------------- main ----------------
(async () => {
  if (!id) {
    titleEl.textContent = "未指定书籍";
    showError("缺少参数 id。");
    return;
  }
  setStage("正在读取书籍信息…");
  let book: Book;
  let owner: boolean;
  try {
    const [data, isOwner] = await Promise.all([api<any>(`/api/books/${encodeURIComponent(id)}`), getOwner()]);
    book = data.book ?? data;
    owner = isOwner;
  } catch (e) {
    titleEl.textContent = "无法加载";
    showError(e instanceof ApiError && e.status === 404 ? "未找到这本书。" : `元数据加载失败：${errorText(e)}`);
    return;
  }
  const { main } = splitTitle(book.title);
  titleEl.textContent = main;
  titleEl.title = book.title;
  document.title = `${main} — The Shelf`;
  const back = $<HTMLAnchorElement>("back");
  back.href = bookUrl(book.id);
  back.addEventListener("click", (ev) => {
    if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) {
      ev.preventDefault();
      history.back();
    }
  });
  if (book.status !== "uploaded") {
    showError("这本书仅登记在本地目录（>20MB 未上传），无法在线阅读。");
    return;
  }
  if (!owner) {
    requireLogin();
    return;
  }
  dlLink.href = `${fileUrl}?download=1`;
  dlLink.hidden = false;

  const f = fmt(book);
  try {
    if (f === "pdf") await readPdf(Number(book.sizeBytes) || 0);
    else if (f === "epub") await readEpub();
    else if (f === "txt" || f === "md") await readText();
    else showError(`不支持在线阅读 ${f.toUpperCase() || "该"} 格式，请下载。`);
  } catch (e: any) {
    const status = e instanceof ApiError ? e.status : e?.status;
    if (status === 401 || /401/.test(String(e?.message))) {
      requireLogin();
      return;
    }
    showError(`打开失败：${e instanceof ApiError ? errorText(e) : e?.message || e}`);
  }
})();
