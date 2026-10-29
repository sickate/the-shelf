import { api, ApiError, Book, bookUrl, el, errorText, fmt, getOwner, humanSize, loginForm, splitTitle, store } from "./lib/common";
import { applyPageTheme, narrowMedia, PrefField, prefsPanel, spreadSwitch } from "./lib/reader-panel";
import { reportOpened, reportProgress } from "./lib/recent";
import {
  clampFont,
  contentCss,
  effectiveSpread,
  FONT_STACKS,
  FOLIATE_MARGIN,
  FONT_STEP,
  loadPrefs,
  MARGIN_PX,
  ReaderPrefs,
  resolveScheme,
  savePrefs,
  spreadPages,
  spreadStart,
  stepSpread,
} from "./lib/reader-prefs";
import { setChapterNav, setChapterSource } from "./lib/chapter-source";
import {
  epubChapterNav,
  epubChapterSource,
  mobiChapterNav,
  mobiChapterSource,
  pdfChapterNav,
  pdfChapterSource,
  textChapter,
  textChapterForKey,
  textChapterNav,
} from "./lib/chapter-text";
import { mountPageButtons, scrollPage } from "./lib/page-buttons";
import { pdfReadAlongFactory } from "./lib/read-along-pdf";
import { ReadAlongTarget, setReadAlongTarget, windowTextTarget } from "./lib/read-along";
import { epubReadAlong, mobiReadAlong } from "./lib/read-along-books";
import { audioAvailable, audioButton } from "./lib/audio-reader";
import { epubNotes, mobiNotes, pdfNotes, textNotes } from "./lib/reader-notes";

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

// ---------------- Reader preferences (shared by all formats) ----------------
let prefs: ReaderPrefs = loadPrefs();
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const narrow = narrowMedia();
const scheme = () => resolveScheme(prefs.theme, systemDark.matches);
const isDouble = () => effectiveSpread(prefs, narrow.matches) === "double";
/** Side padding for EPUB / TXT: the chosen margin, but never more than 8vw on small screens. */
const sidePad = () => `max(8px, min(${MARGIN_PX[prefs.margin]}px, 8vw))`;
applyPageTheme(prefs.theme);

/**
 * Builds the spread switch and/or "Aa" panel for a reader. `apply` receives what changed
 * (also called with `{ spread }` when the viewport crosses the narrow breakpoint and with
 * `{ theme }` when the system colour scheme flips). Returns the toolbar nodes and `update`.
 */
function readerControls(withSpread: boolean, fields: PrefField[], apply: (changed: Partial<ReaderPrefs>) => void) {
  const update = (patch: Partial<ReaderPrefs>) => {
    prefs = { ...prefs, ...patch };
    savePrefs(prefs);
    if ("theme" in patch) applyPageTheme(prefs.theme);
    sw?.sync(prefs);
    panel?.sync();
    apply(patch);
  };
  const sw = withSpread ? spreadSwitch((spread) => update({ spread })) : null;
  const panel = fields.length ? prefsPanel(fields, () => prefs, update) : null;
  sw?.sync(prefs);
  if (withSpread) {
    narrow.addEventListener?.("change", () => {
      sw?.sync(prefs);
      if (prefs.spread === "double") apply({ spread: prefs.spread });
    });
  }
  systemDark.addEventListener?.("change", () => {
    if (prefs.theme === "system") apply({ theme: prefs.theme });
  });
  const nodes = [sw?.el, panel?.el].filter((n): n is HTMLElement => !!n);
  return { nodes, update };
}

const REFLOW_FIELDS: PrefField[] = ["font", "fontPct", "lineHeight", "margin", "theme", "flow"];

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
  // Range loading (see lib/pdf.ts): only the chunks the shown pages need are fetched, so the
  // first page appears without downloading the whole file. A damaged (truncated) PDF is
  // downloaded once and repaired in memory so its surviving pages can still be read.
  const { openPdf, PdfUnreadableError } = await import("./lib/pdf");
  let opened;
  try {
    // In range mode "loaded" is just the chunks fetched so far, so show bytes, not a percentage.
    opened = await openPdf(pdfjs, fileUrl, ({ loaded, total }) => setProgress(loaded, total || sizeBytes, false));
  } catch (e) {
    if (e instanceof PdfUnreadableError) {
      showError(`${e.message}，无法在线阅读，请下载后用其他阅读器打开。`);
      return;
    }
    throw e;
  }
  const { pdf } = opened;

  const total = pdf.numPages;
  let pageNum = Math.min(Math.max(1, Number(store.get(posKey)) || 1), total); // first page of the shown spread
  let zoom = 0; // 0 = fit width, else absolute scale
  let tasks: { cancel(): void; promise: Promise<void> }[] = [];
  let gen = 0; // bumps on every render so a superseded one stops early
  let firstRender = true;
  const busy = el("span", { class: "busy muted small", "aria-live": "polite" });

  // Double mode shows two pages side by side (page 1 alone as the cover); only the shown
  // pages are requested, so range loading still fetches just what is needed.
  const PAIR_GAP = 8;
  const canvases = [el("canvas", { class: "pdf-page" }), el("canvas", { class: "pdf-page" })];
  // Each canvas sits in a box that also holds the notes text layer and highlights.
  const boxes = canvases.map((c) => el("div", { class: "pdf-box" }, c));
  const spreadEl = el("div", { class: "pdf-spread" }, ...boxes);
  const wrap = el("div", { class: "pdf-wrap" }, spreadEl);
  view.replaceChildren(wrap);
  const notes = pdfNotes(id, pdfjs, boxes, (n) => go(n));

  const pageInput = el("input", { type: "number", min: "1", max: String(total), class: "page-input", "aria-label": "页码" });
  const zoomLabel = el("span", { class: "muted small zoom-label" });
  const tocSelect = el("select", { "aria-label": "目录", hidden: "" });

  /** Fit-width scale: one page fills the width, or a pair (cover: half the width) in double mode. */
  const fitScale = (pages: { getViewport(o: { scale: number }): { width: number } }[], double: boolean) => {
    const avail = Math.max(200, wrap.clientWidth - 16);
    const widths = pages.map((p) => p.getViewport({ scale: 1 }).width);
    if (!double) return avail / widths[0];
    const slot = avail - PAIR_GAP;
    return widths.length === 2 ? slot / (widths[0] + widths[1]) : slot / 2 / widths[0];
  };

  async function render() {
    for (const t of tasks) t.cancel();
    tasks = [];
    const my = ++gen;
    const double = isDouble();
    pageNum = spreadStart(pageNum, total, double);
    const nums = spreadPages(pageNum, total, double);
    const label = nums.join("–");
    pageInput.value = String(pageNum);
    store.set(posKey, String(pageNum));
    reportProgress(`第 ${label} / ${total} 页`);
    if (firstRender) setStage(`正在渲染第 ${label} 页…`, `共 ${total} 页`);
    busy.textContent = `正在渲染第 ${label} 页…`;
    const pages = await Promise.all(nums.map((n) => pdf.getPage(n)));
    if (my !== gen) return; // superseded while loading
    const scale = zoom || fitScale(pages, double);
    zoomLabel.textContent = zoom ? `${Math.round(scale * 100)}%` : "适合宽度";
    const dpr = window.devicePixelRatio || 1;
    spreadEl.classList.toggle("double", double);
    boxes[1].hidden = pages.length < 2;
    if (pages.length < 2) notes.clearSlot(1);
    const run = pages.map((page, i) => {
      const canvas = canvases[i];
      const vp = page.getViewport({ scale });
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      notes.renderPage(i, page, vp, nums[i]);
      return page.render({
        canvas,
        canvasContext: canvas.getContext("2d")!,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
    });
    tasks = run;
    try {
      await Promise.all(run.map((t) => t.promise));
      if (my === gen) busy.textContent = "";
    } catch (e: any) {
      if (e?.name !== "RenderingCancelledException") {
        busy.textContent = "";
        showError(`第 ${label} 页渲染失败：${e?.message || e}`);
      }
    }
    if (firstRender) {
      firstRender = false;
      hideLoading();
    }
  }
  const userPageCbs: (() => void)[] = [];
  // user=false is for programmatic jumps (read-along), which must not fire onUserPage.
  const go = (n: number, user = true) => {
    const next = spreadStart(n, total, isDouble());
    if (next !== pageNum) {
      pageNum = next;
      render();
      wrap.scrollTop = 0;
      if (user) for (const cb of userPageCbs) cb();
    }
  };
  const step = (dir: 1 | -1) => go(stepSpread(pageNum, total, isDouble(), dir));
  const currentScale = async () => {
    if (zoom) return zoom;
    const double = isDouble();
    const pages = await Promise.all(spreadPages(pageNum, total, double).map((n) => pdf.getPage(n)));
    return fitScale(pages, double);
  };

  // PDF is not reflowable: the panel only offers the theme (page background).
  const controls = readerControls(true, ["theme"], (changed) => {
    if ("spread" in changed) {
      render();
      wrap.scrollTop = 0;
    }
  });

  pageInput.addEventListener("change", () => go(Number(pageInput.value) || 1));
  toolbar.replaceChildren(
    button("‹", "上一页", () => step(-1)),
    pageInput,
    el("span", { class: "muted small" }, `/ ${total}`),
    button("›", "下一页", () => step(1)),
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
    el("span", { class: "sep" }),
    ...controls.nodes,
    notes.button,
    tocSelect,
    busy,
  );
  if (opened.repaired) {
    toolbar.append(el("span", { class: "muted small", title: "文件缺少结尾的索引，已在浏览器内修复" }, "文件不完整，仅能显示保留下来的页面"));
  }
  toolbar.hidden = false;

  mountPageButtons({ action: () => step(-1), label: () => "上一页" }, { action: () => step(1), label: () => "下一页" });
  document.addEventListener("keydown", (ev) => {
    if ((ev.target as HTMLElement).tagName === "INPUT" || (ev.target as HTMLElement).tagName === "SELECT") return;
    if (ev.key === "ArrowLeft" || ev.key === "PageUp") step(-1);
    else if (ev.key === "ArrowRight" || ev.key === "PageDown") step(1);
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
  void notes.start();
  setChapterSource(pdfChapterSource(pdf, () => pageNum));
  setChapterNav(pdfChapterNav(pdf, () => pageNum));
  setReadAlongTarget(pdfReadAlongFactory(pdf, { goTo: (n) => go(n, false), onUserPage: (cb) => userPageCbs.push(cb) }));

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
  area.classList.toggle("double", isDouble());
  area.style.paddingInline = sidePad();
  view.replaceChildren(area);
  const epubFlow = () => (prefs.flow === "scrolled" ? "scrolled-doc" : "paginated");
  const epubSpread = () => (isDouble() ? "always" : "none");
  const rendition = book.renderTo(area, { width: "100%", height: "100%", flow: epubFlow(), spread: epubSpread() } as any);
  const notes = epubNotes(id, rendition, book);

  // All typography/colour goes through one keyed stylesheet per section document, so a
  // change replaces it in place (hooks.content covers sections rendered later).
  const inject = (contents: any) => contents.addStylesheetCss?.(contentCss(prefs, scheme()), "shelf-prefs");
  rendition.hooks.content.register(inject);
  const restyle = () => (rendition.getContents() as unknown as any[]).forEach(inject);

  /**
   * Spread / flow / margin change: re-layout and stay at the same CFI. epub.js already
   * clears and re-displays the current location on flow() and on a stage resize (the area's
   * width/padding changes with spread and margin); only when neither happened do we do it
   * here. Clearing while one of those queued displays runs leaves a blank page.
   */
  let flowNow = epubFlow();
  const relayout = () => {
    const r = rendition as any;
    const cfi = r.location?.start?.cfi;
    const sizeBefore = r.manager?._stageSize;
    area.classList.toggle("double", isDouble());
    area.style.paddingInline = sidePad();
    rendition.spread(epubSpread());
    if (epubFlow() !== flowNow) {
      flowNow = epubFlow();
      rendition.flow(flowNow); // re-displays by itself; a resize now would race with it
      return;
    }
    if (!cfi) return; // not displayed yet; the initial display picks up the settings
    r.resize(); // re-measure the stage
    if (r.manager?._stageSize === sizeBefore) {
      r.manager?.clear?.();
      rendition.display(cfi).catch(() => {});
    }
  };
  const controls = readerControls(true, REFLOW_FIELDS, (changed) => {
    if ("spread" in changed || "flow" in changed || "margin" in changed) relayout();
    if ("font" in changed || "fontPct" in changed || "lineHeight" in changed || "theme" in changed) restyle();
  });
  const bumpFont = (d: number) => controls.update({ fontPct: clampFont(prefs.fontPct + d) });

  const tocSelect = el("select", { "aria-label": "目录", hidden: "" });
  const loc = el("span", { class: "muted small" });
  toolbar.replaceChildren(
    button("‹", "上一页", () => rendition.prev()),
    button("›", "下一页", () => rendition.next()),
    el("span", { class: "sep" }),
    button("A−", "缩小字号", () => bumpFont(-FONT_STEP)),
    button("A+", "放大字号", () => bumpFont(FONT_STEP)),
    ...controls.nodes,
    notes.button,
    tocSelect,
    loc,
  );
  toolbar.hidden = false;

  // Exact percentage needs book.locations (generated in the background, slow for big books);
  // until then estimate from the spine position and the page within the current section.
  const percentOf = (start: any): number | null => {
    const pct = start?.percentage;
    if (typeof pct === "number" && pct > 0) return pct;
    const n = (book.spine as any)?.spineItems?.length || (book.spine as any)?.length || 0;
    const i = start?.index;
    if (!n || typeof i !== "number") return null;
    const { page = 1, total = 1 } = start?.displayed || {};
    return Math.min(1, (i + (Math.max(1, page) - 1) / Math.max(1, total)) / n);
  };
  const showPct = (start: any) => {
    const pct = percentOf(start);
    if (pct === null) return;
    loc.textContent = `${Math.round(pct * 100)}%`;
    reportProgress(`约 ${Math.round(pct * 100)}%`);
  };
  rendition.on("relocated", (location: any) => {
    const cfi = location?.start?.cfi;
    if (cfi) store.set(posKey, cfi);
    showPct(location?.start);
  });
  mountPageButtons({ action: () => rendition.prev(), label: () => "上一页" }, { action: () => rendition.next(), label: () => "下一页" });
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
  void notes.start();
  const epubHref = () => (rendition as any).currentLocation?.()?.start?.href ?? null;
  setChapterSource(epubChapterSource(book, epubHref));
  setChapterNav(epubChapterNav(book, epubHref));
  setReadAlongTarget(epubReadAlong(book, rendition, area));

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
  book.ready
    .then(() => book.locations.generate(1600))
    .then(() => {
      // Swap the estimate for the exact value once locations exist.
      const start = (rendition as any).currentLocation?.()?.start;
      if (start?.cfi) showPct({ ...start, percentage: book.locations.percentageFromCfi(start.cfi) });
    })
    .catch(() => {});
}

// ---------------- MOBI / AZW / AZW3 ----------------
const MOBI_UNSUPPORTED = "该文件受 DRM 保护或格式不受支持，请下载原文件。";

/** Stylesheet injected into each foliate section: the shared reader prefs plus MOBI fix-ups. */
function mobiCss(p: ReaderPrefs, dark: boolean): string {
  return `
    ${contentCss(p, resolveScheme(p.theme, dark))}
    img, svg { max-width: 100%; height: auto; }
    pre { white-space: pre-wrap !important; }
  `;
}

async function readMobi(format: string) {
  const [{ openMobi }, buf] = await Promise.all([import("./lib/mobi"), fetchFile(` ${format.toUpperCase()}`)]);
  setStage(`正在解析 ${format.toUpperCase()}…`);
  let book: any;
  try {
    book = await openMobi(new File([buf], `book.${format}`, { type: "application/x-mobipocket-ebook" }));
  } catch (e) {
    console.warn(e);
    showError(MOBI_UNSUPPORTED);
    return;
  }
  setStage("正在加载阅读器…");
  // @ts-ignore -- defines <foliate-view>
  await import("foliate-js/view.js");
  const area = el("div", { class: "epub-area mobi-area" });
  const fv = document.createElement("foliate-view") as any;
  area.append(fv);
  view.replaceChildren(area);
  await fv.open(book);
  const notes = await mobiNotes(id, fv);
  const r = fv.renderer;
  // The paginator keeps its anchor across attribute changes, so the position survives.
  const applyLayout = () => {
    const double = isDouble();
    area.classList.toggle("double", double);
    const m = FOLIATE_MARGIN[prefs.margin];
    r.setAttribute("flow", prefs.flow);
    r.setAttribute("max-column-count", double ? "2" : "1");
    r.setAttribute("margin", m.margin);
    r.setAttribute("gap", m.gap);
  };
  applyLayout();
  const applyStyles = () => r.setStyles?.(mobiCss(prefs, systemDark.matches));
  applyStyles();
  const controls = readerControls(true, REFLOW_FIELDS, (changed) => {
    if ("spread" in changed || "flow" in changed || "margin" in changed) applyLayout();
    if ("font" in changed || "fontPct" in changed || "lineHeight" in changed || "theme" in changed) applyStyles();
  });
  const bumpFont = (d: number) => controls.update({ fontPct: clampFont(prefs.fontPct + d) });

  const tocSelect = el("select", { "aria-label": "目录", hidden: "" });
  const loc = el("span", { class: "muted small" });
  toolbar.replaceChildren(
    button("‹", "上一页", () => fv.goLeft()),
    button("›", "下一页", () => fv.goRight()),
    el("span", { class: "sep" }),
    button("A−", "缩小字号", () => bumpFont(-FONT_STEP)),
    button("A+", "放大字号", () => bumpFont(FONT_STEP)),
    ...controls.nodes,
    notes.button,
    tocSelect,
    loc,
  );
  toolbar.hidden = false;

  fv.addEventListener("relocate", (ev: CustomEvent) => {
    const { cfi, fraction, tocItem } = ev.detail || {};
    if (cfi) store.set(posKey, cfi);
    if (typeof fraction === "number") loc.textContent = `${Math.round(fraction * 100)}%`;
    if (typeof fraction === "number") reportProgress(`约 ${Math.round(fraction * 100)}%`);
    if (tocItem?.label) loc.title = String(tocItem.label).trim();
  });
  // goLeft / goRight are spatial: in RTL books the left button moves forward.
  const mobiRtl = () => fv.book?.dir === "rtl";
  const mobiBtns = mountPageButtons(
    { action: () => fv.goLeft(), label: () => (mobiRtl() ? "下一页" : "上一页") },
    { action: () => fv.goRight(), label: () => (mobiRtl() ? "上一页" : "下一页") },
  );
  fv.addEventListener("load", () => mobiBtns.refresh());
  const onKey = (ev: KeyboardEvent) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "SELECT" || tag === "INPUT") return;
    if (ev.key === "ArrowLeft" || ev.key === "PageUp") fv.goLeft();
    else if (ev.key === "ArrowRight" || ev.key === "PageDown") fv.goRight();
    else return;
    ev.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  // Keys pressed while focus is inside a section iframe.
  fv.addEventListener("load", (ev: CustomEvent) => ev.detail?.doc?.addEventListener("keydown", onKey));

  setStage("正在排版…");
  const saved = store.get(posKey);
  try {
    await fv.init({ lastLocation: saved && saved.startsWith("epubcfi(") ? saved : null, showTextStart: !saved });
  } catch {
    await fv.goToTextStart().catch(() => fv.next());
  }
  hideLoading();
  void notes.start();
  setChapterSource(mobiChapterSource(fv));
  setChapterNav(mobiChapterNav(fv));
  setReadAlongTarget(mobiReadAlong(fv));

  const opts: HTMLOptionElement[] = [el("option", { value: "" }, "目录")];
  const walk = (items: any[], depth: number) => {
    for (const it of items || []) {
      if (opts.length > 2000) return;
      if (it.href) opts.push(el("option", { value: it.href }, `${"　".repeat(depth)}${String(it.label || "").trim()}`));
      walk(it.subitems, depth + 1);
    }
  };
  walk(book.toc, 0);
  if (opts.length > 1) {
    tocSelect.replaceChildren(...opts);
    tocSelect.hidden = false;
    tocSelect.addEventListener("change", () => {
      const href = tocSelect.value;
      tocSelect.value = "";
      if (href) fv.goTo(href).catch(() => {});
    });
  }
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

/** Character offset in the article text at the top of the viewport (scroll fraction as fallback). */
function textOffsetAtTop(article: HTMLElement, len: number, y = 4): number {
  const max = document.documentElement.scrollHeight - innerHeight;
  const byFraction = max > 0 ? Math.round((scrollY / max) * len) : 0;
  try {
    const r = article.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + 4, 0), innerWidth - 1);
    const range = (document as any).caretRangeFromPoint?.(x, y) as Range | null;
    const pos = (document as any).caretPositionFromPoint?.(x, y) as { offsetNode: Node; offset: number } | null;
    const node = range?.startContainer ?? pos?.offsetNode;
    const off = range?.startOffset ?? pos?.offset;
    if (node && typeof off === "number" && article.contains(node)) {
      const pre = document.createRange(); // survives highlight spans the notes layer may add
      pre.setStart(article, 0);
      pre.setEnd(node, off);
      return pre.toString().length;
    }
  } catch {
    /* fall back */
  }
  return byFraction;
}

async function readText() {
  const text = decode(await fetchFile("文本"));
  hideLoading();
  const article = el("article", { class: "text-body" });
  article.textContent = text;
  view.replaceChildren(article);
  view.classList.add("text-view");
  const notes = textNotes(id, article, text);
  mountPageButtons({ action: () => scrollPage(-1), label: () => "上一页" }, { action: () => scrollPage(1), label: () => "下一页" });
  // Plain text always scrolls; the panel restyles the container (colours follow the page theme).
  const TEXT_WIDTH = { narrow: "52em", medium: "42em", wide: "34em" };
  const applyText = () => {
    article.style.fontFamily = FONT_STACKS[prefs.font];
    article.style.fontSize = `${(17 * prefs.fontPct) / 100}px`;
    article.style.lineHeight = String(prefs.lineHeight);
    article.style.maxWidth = TEXT_WIDTH[prefs.margin];
    article.style.paddingInline = sidePad();
  };
  applyText();
  const controls = readerControls(false, ["font", "fontPct", "lineHeight", "margin", "theme"], (changed) => {
    if ("theme" in changed) return;
    // Keep the reading position (as a fraction) across the reflow.
    const max = document.documentElement.scrollHeight - innerHeight;
    const frac = max > 0 ? scrollY / max : 0;
    applyText();
    window.scrollTo(0, frac * (document.documentElement.scrollHeight - innerHeight));
  });
  toolbar.replaceChildren(notes.button, ...controls.nodes);
  toolbar.classList.add("toolbar-end");
  toolbar.hidden = false;
  void notes.start();
  setChapterSource(() => Promise.resolve(textChapter(text, textOffsetAtTop(article, text.length))));
  // Follow chapter: offsets at the top and middle of the view, recomputed only after scrolling.
  let probe = { at: "", offs: [] as number[] };
  setChapterNav(
    textChapterNav(text, () => {
      const at = `${scrollY}:${innerHeight}:${document.documentElement.scrollHeight}`;
      if (probe.at !== at) probe = { at, offs: [textOffsetAtTop(article, text.length), textOffsetAtTop(article, text.length, innerHeight / 2)] };
      return probe.offs;
    }),
  );
  // Read-along: chapterKey "text:<start>" names the chapter; one target per chapter.
  const targets = new Map<string, ReadAlongTarget>();
  setReadAlongTarget((key) => {
    const m = /^text:(\d+)$/.exec(key);
    if (!m) return null;
    if (!targets.has(key)) {
      const c = textChapterForKey(text, Number(m[1]));
      targets.set(key, windowTextTarget(article, c.start, c.end));
    }
    return targets.get(key)!;
  });
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
        if (max > 0) reportProgress(`约 ${Math.round((scrollY / max) * 100)}%`);
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
    else if (f === "mobi" || f === "azw3" || f === "azw") await readMobi(f);
    else if (f === "txt" || f === "md") await readText();
    else if (f === "cbz") await (await import("./lib/comic-reader")).readComic({ view, toolbar, posKey, load: () => fetchFile(" CBZ"), setStage, hideLoading, showError });
    else showError(`不支持在线阅读 ${f.toUpperCase() || "该"} 格式，请下载。`);
    if (f !== "cbz" && !toolbar.hidden && audioAvailable()) toolbar.append(audioButton(String(book.id), main));
    if (msg.hidden) reportOpened(String(book.id)); // loaded without an error: record it in 最近阅读
  } catch (e: any) {
    const status = e instanceof ApiError ? e.status : e?.status;
    if (status === 401 || /401/.test(String(e?.message))) {
      requireLogin();
      return;
    }
    showError(`打开失败：${e instanceof ApiError ? errorText(e) : e?.message || e}`);
  }
})();
