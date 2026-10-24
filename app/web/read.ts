import { api, ApiError, Book, el, errorText, fmt, getOwner, loginForm, store } from "./lib/common";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const titleEl = $<HTMLHeadingElement>("book-title");
const dlLink = $<HTMLAnchorElement>("download");
const toolbar = $<HTMLDivElement>("toolbar");
const msg = $<HTMLParagraphElement>("msg");
const loginBox = $<HTMLDivElement>("login");
const view = $<HTMLElement>("view");

const id = new URLSearchParams(location.search).get("id") || "";
const fileUrl = `/api/books/${encodeURIComponent(id)}/file`;
const posKey = `shelf:pos:${id}`;

function showError(text: string) {
  msg.textContent = text;
  msg.hidden = false;
}

function requireLogin() {
  loginBox.replaceChildren(el("p", {}, "需要所有者登录后才能阅读。"), loginForm(() => location.reload()));
  loginBox.hidden = false;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { type: "button", title, "aria-label": title }, label);
  b.addEventListener("click", onClick);
  return b;
}

async function fetchFile(): Promise<Response> {
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
  return res;
}

// ---------------- PDF ----------------
async function readPdf() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({
    url: fileUrl,
    withCredentials: true,
    rangeChunkSize: 65536 * 4,
    disableAutoFetch: true,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  }).promise;

  const total = pdf.numPages;
  let pageNum = Math.min(Math.max(1, Number(store.get(posKey)) || 1), total);
  let zoom = 0; // 0 = fit width, else absolute scale
  let task: { cancel(): void; promise: Promise<void> } | null = null;

  const canvas = el("canvas", { class: "pdf-page" });
  const wrap = el("div", { class: "pdf-wrap" }, canvas);
  view.replaceChildren(wrap);

  const pageInput = el("input", { type: "number", min: "1", max: String(total), class: "page-input", "aria-label": "页码" });
  const zoomLabel = el("span", { class: "muted small" });
  const tocSelect = el("select", { "aria-label": "目录", hidden: "" });

  async function render() {
    task?.cancel();
    pageInput.value = String(pageNum);
    store.set(posKey, String(pageNum));
    const page = await pdf.getPage(pageNum);
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
    } catch (e: any) {
      if (e?.name !== "RenderingCancelledException") showError(`渲染失败：${e?.message || e}`);
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
  const [{ default: ePub }, res] = await Promise.all([import("epubjs"), fetchFile()]);
  const buf = await res.arrayBuffer();
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
  try {
    await rendition.display(saved || undefined);
  } catch {
    await rendition.display();
  }

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
  const res = await fetchFile();
  const text = decode(await res.arrayBuffer());
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
  let book: Book;
  try {
    const data = await api<any>(`/api/books/${encodeURIComponent(id)}`);
    book = data.book ?? data;
  } catch (e) {
    titleEl.textContent = "无法加载";
    showError(e instanceof ApiError && e.status === 404 ? "未找到这本书。" : `元数据加载失败：${errorText(e)}`);
    return;
  }
  titleEl.textContent = book.title;
  document.title = `${book.title} · The Shelf`;
  if (book.status !== "uploaded") {
    showError("这本书仅登记在本地目录（>20MB 未上传），无法在线阅读。");
    return;
  }
  if (!(await getOwner())) {
    requireLogin();
    return;
  }
  dlLink.href = `${fileUrl}?download=1`;
  dlLink.hidden = false;

  const f = fmt(book);
  try {
    if (f === "pdf") await readPdf();
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
