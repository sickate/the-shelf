// "关于这本书" — owner-only AI book info on the detail page (GET/POST /api/books/:id/info).
// Model output is untrusted: everything is rendered with textContent / el(), links only http(s).
import { api, ApiError, Book, bookUrl, el, errorText, splitTitle } from "./common";
import { extractExcerpt } from "./excerpt";

export interface BookInfo {
  title: string;
  authors: { name: string; bio: string }[];
  summary: string;
  background: string;
  keyPoints: string[];
  audience: string;
  publishInfo: string;
  tags: string[];
  related: { title: string; reason: string }[];
  sources: { title: string; url: string }[];
  confidence: "high" | "medium" | "low";
  searchUsed: boolean;
}

export interface InfoView {
  status: "none" | "generating" | "ready" | "failed";
  info?: BookInfo;
  model?: string | null;
  inputKind?: "title" | "excerpt" | null;
  error?: string;
  updatedAt?: string;
}

const POLL_MS = 10_000;

const REASON_TEXT: Record<string, string> = {
  ai_busy: "AI 服务繁忙",
  ai_timeout: "AI 生成超时",
  ai_network: "无法连接 AI 服务",
  ai_bad_output: "AI 输出不符合格式要求，结果未保存",
  ai_bad_response: "AI 服务返回了无法解析的响应",
  ai_not_configured: "服务端尚未配置 AI 服务",
  lease_expired: "上次生成未在时限内完成",
  lease_lost: "生成结果未能保存（任务已被接管）",
  internal_error: "服务器内部错误",
  login_required: "需要所有者登录",
  too_large: "正文摘录过大",
  bad_json: "请求格式错误",
  bad_excerpt: "正文摘录格式错误",
  search_auth: "联网检索鉴权失败，本次未使用检索资料",
  search_balance: "联网检索余额不足，本次未使用检索资料",
};

export function reasonText(code: string | undefined | null): string {
  if (!code) return "未知错误";
  const http = /^ai_http_(\d{3})$/.exec(code);
  if (http) return `AI 服务返回 HTTP ${http[1]}`;
  return REASON_TEXT[code] ? `${REASON_TEXT[code]}（${code}）` : `错误：${code}`;
}

/** Normalised title keys for matching related books against the shelf. */
export function titleKeys(title: string): string[] {
  const base = String(title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[《》〈〉<>「」『』“”"'‘’]/g, "");
  const squash = (s: string) => s.replace(/[\s·・:：、,，.。!！?？;；\-—_–~～/\\|]+/g, "");
  const noParen = base.replace(/[(（\[【][^)）\]】]*[)）\]】]/g, "");
  // Main title before a subtitle / author separator: "人类简史：从动物到上帝", "脑科学讲义 — 王立铭".
  const head = noParen.split(/\s*[:：]\s*|\s+[—–-]+\s+|——/)[0];
  return [...new Set([base, noParen, head].map(squash).filter((k) => k.length >= 2))];
}

function safeHref(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function fmtTime(iso?: string): string {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(+d) ? d.toLocaleString("zh-CN", { hour12: false }) : "—";
}

const has = (s: unknown) => typeof s === "string" && s.trim().length > 0;

let shelfIndex: Promise<Map<string, Book>> | null = null;
/** /api/books is fetched at most once per page, and only when a ready result has related titles. */
function loadShelfIndex(): Promise<Map<string, Book>> {
  shelfIndex ??= api<{ books: Book[] }>("/api/books")
    .then(({ books }) => {
      const m = new Map<string, Book>();
      for (const b of books || []) {
        for (const t of [splitTitle(b.title).main, b.title]) for (const k of titleKeys(t)) if (!m.has(k)) m.set(k, b);
      }
      return m;
    })
    .catch(() => new Map());
  return shelfIndex;
}

class PostError extends Error {
  constructor(public status: number, public code: string, public reason?: string, public retryAfter?: number) {
    super(code);
  }
}

export interface InfoSection {
  destroy(): void;
}

/** Mounts the owner-only section. `onLoginLost` is called on 401. */
export function mountBookInfo(root: HTMLElement, book: Book, onLoginLost: () => void): InfoSection {
  let destroyed = false;
  let pollTimer: number | undefined;
  let tickTimer: number | undefined;
  let busy = false;
  let current: InfoView = { status: "none" };
  const unload = new AbortController();
  const onPageHide = () => unload.abort();
  window.addEventListener("pagehide", onPageHide);

  const bookPath = `/api/books/${encodeURIComponent(String(book.id))}/info`;
  const status = el("div", { class: "info-status", role: "status", "aria-live": "polite" });
  const body = el("div", { class: "info-body" });
  root.replaceChildren(
    el("div", { class: "info-head" }, el("h2", { class: "section-title" }, "关于这本书"), el("span", { class: "info-badge" }, "AI 生成 · 仅所有者可见")),
    status,
    body,
  );
  root.hidden = false;

  function stopTimers() {
    clearInterval(tickTimer);
    clearTimeout(pollTimer);
    tickTimer = pollTimer = undefined;
  }

  /** Spinner line with a live elapsed-seconds counter. */
  function showProgress(text: string, since = Date.now()) {
    clearInterval(tickTimer);
    const secs = el("span", { class: "info-elapsed" });
    const update = () => (secs.textContent = `已等待 ${Math.floor((Date.now() - since) / 1000)} 秒`);
    update();
    status.replaceChildren(el("div", { class: "info-progress" }, el("span", { class: "spinner", "aria-hidden": "true" }), el("span", {}, text), secs));
    tickTimer = window.setInterval(update, 1000);
  }

  function showMessage(text: string, kind: "error" | "note" = "error", action?: HTMLElement) {
    clearInterval(tickTimer);
    status.replaceChildren(el("div", { class: `info-msg ${kind}` }, el("span", {}, text), ...(action ? [action] : [])));
  }

  const clearStatus = () => {
    clearInterval(tickTimer);
    status.replaceChildren();
  };

  function generateButton(label: string, force: boolean, cls = "primary") {
    const b = el("button", { type: "button", class: cls }, label);
    b.addEventListener("click", () => generate(force));
    return b;
  }

  // ---------- states ----------
  function render(view: InfoView) {
    if (destroyed) return;
    current = view;
    stopTimers();
    if (view.status === "generating") {
      if (view.info) renderReady(view);
      else body.replaceChildren();
      return startPolling();
    }
    if (view.status === "ready" && view.info) {
      clearStatus();
      if (view.error) showMessage(`上次操作提示：${reasonText(view.error)}`, "note");
      return renderReady(view);
    }
    body.replaceChildren();
    if (view.status === "failed") {
      showMessage(`上次生成失败：${reasonText(view.error)}`, "error", generateButton("重试", false));
      return;
    }
    clearStatus();
    body.replaceChildren(
      el(
        "div",
        { class: "info-empty" },
        el(
          "p",
          {},
          "尚未生成 AI 简介。生成时会先从本书开头提取一段正文摘录，并联网检索（DeepSeek）作者、内容与出版背景，再由 AI 整理成资料卡。通常需要 1–3 分钟，请保持页面打开。",
        ),
        generateButton("生成 AI 简介", false),
      ),
    );
  }

  function block(title: string, ...children: (Node | string)[]) {
    return el("section", { class: "info-block" }, el("h3", {}, title), ...children);
  }

  function renderReady(view: InfoView) {
    const info = view.info!;
    const parts: HTMLElement[] = [];
    if (info.confidence === "low" || !info.searchUsed) {
      const why = [info.confidence === "low" ? "AI 自评置信度低" : "", !info.searchUsed ? "本次未能联网检索" : ""].filter(Boolean).join("，");
      parts.push(
        el(
          "div",
          { class: "info-caution", role: "note" },
          el("strong", {}, "请谨慎参考"),
          el("span", {}, `${why}，以下内容主要依据书名${view.inputKind === "excerpt" ? "和正文摘录" : ""}推测，作者、年份与出版信息可能不准确。`),
        ),
      );
    }
    if (has(info.summary)) parts.push(el("p", { class: "info-lead" }, info.summary));
    const authors = (info.authors || []).filter((a) => has(a?.name));
    if (authors.length)
      parts.push(
        block(
          "作者",
          el("ul", { class: "info-authors" }, ...authors.map((a) => el("li", {}, el("strong", {}, a.name), ...(has(a.bio) ? [el("p", {}, a.bio)] : [])))),
        ),
      );
    if (has(info.background)) parts.push(block("内容背景", el("p", {}, info.background)));
    const points = (info.keyPoints || []).filter(has);
    if (points.length) parts.push(block("要点", el("ul", { class: "info-points" }, ...points.map((p) => el("li", {}, p)))));
    if (has(info.audience)) parts.push(block("适合读者", el("p", {}, info.audience)));
    if (has(info.publishInfo)) parts.push(block("出版信息", el("p", {}, info.publishInfo)));
    const tags = (info.tags || []).filter(has);
    if (tags.length) parts.push(block("标签", el("div", { class: "tags info-tags" }, ...tags.map((t) => el("span", { class: "tag" }, t)))));
    const related = (info.related || []).filter((r) => has(r?.title));
    if (related.length) {
      const list = el("ul", { class: "info-related" });
      const items = related.map((r) => {
        const name = el("span", { class: "info-related-title" }, `《${r.title.replace(/^《|》$/g, "")}》`);
        const li = el("li", {}, name, ...(has(r.reason) ? [el("p", {}, r.reason)] : []));
        list.append(li);
        return { r, li, name };
      });
      parts.push(block("相关推荐", list));
      loadShelfIndex().then((index) => {
        for (const { r, li, name } of items) {
          const hit = titleKeys(r.title).map((k) => index.get(k)).find((b) => b && String(b.id) !== String(book.id));
          if (!hit || !li.isConnected) continue;
          const link = el("a", { href: bookUrl(hit.id), class: "info-related-title" }, name.textContent || "");
          name.replaceWith(link, el("span", { class: "tag tag-ok" }, "本书架"));
        }
      });
    }
    const sources = (info.sources || []).map((s) => ({ s, u: safeHref(s?.url) })).filter((x) => x.u);
    if (sources.length)
      parts.push(
        block(
          "参考来源",
          el(
            "ol",
            { class: "info-sources" },
            ...sources.map(({ s, u }) =>
              el(
                "li",
                {},
                el("a", { href: u!.href, target: "_blank", rel: "noopener noreferrer" }, has(s.title) ? s.title : u!.hostname),
                el("span", { class: "muted" }, ` · ${u!.hostname}`),
              ),
            ),
          ),
        ),
      );

    const regen = el("button", { type: "button", class: "link-btn info-regen" }, "重新生成");
    let armed: number | undefined;
    regen.addEventListener("click", () => {
      if (busy) return;
      if (armed === undefined) {
        regen.textContent = "确认重新生成？";
        regen.classList.add("armed");
        armed = window.setTimeout(() => {
          armed = undefined;
          regen.textContent = "重新生成";
          regen.classList.remove("armed");
        }, 5000);
        return;
      }
      clearTimeout(armed);
      armed = undefined;
      regen.textContent = "重新生成";
      regen.classList.remove("armed");
      generate(true);
    });
    const basis = view.inputKind === "excerpt" ? "书名 + 正文摘录" : "书名";
    parts.push(
      el(
        "div",
        { class: "info-foot" },
        el(
          "span",
          {},
          `AI 生成，可能不准确 · 模型 ${view.model || "未知"} · 更新于 ${fmtTime(view.updatedAt)} · 依据：${basis} · 联网检索：${info.searchUsed ? "是" : "否"}`,
        ),
        regen,
      ),
    );
    body.replaceChildren(...parts);
  }

  // ---------- network ----------
  async function fetchView(): Promise<InfoView> {
    return api<InfoView>(bookPath, { signal: unload.signal });
  }

  function handleLoadError(e: unknown) {
    if (destroyed || unload.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) return onLoginLost();
    showMessage(`读取 AI 简介失败：${errorText(e)}`, "error", retryLoad());
  }

  function retryLoad() {
    const b = el("button", { type: "button" }, "重新读取");
    b.addEventListener("click", load);
    return b;
  }

  async function load() {
    try {
      render(await fetchView());
    } catch (e) {
      handleLoadError(e);
    }
  }

  /** Another tab or the batch script holds the lease: check back every 10 s. */
  function startPolling(since = Date.now()) {
    showProgress("另一个页面或批量脚本正在生成，完成后自动显示…", since);
    const tick = async () => {
      if (destroyed) return;
      try {
        const view = await fetchView();
        if (view.status === "generating") {
          pollTimer = window.setTimeout(tick, POLL_MS);
          return;
        }
        render(view);
      } catch (e) {
        handleLoadError(e);
      }
    };
    clearTimeout(pollTimer);
    pollTimer = window.setTimeout(tick, POLL_MS);
  }

  async function post(force: boolean, excerpt: string): Promise<InfoView> {
    const res = await fetch(force ? `${bookPath}?force=1` : bookPath, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(excerpt ? { excerpt } : {}),
      signal: unload.signal,
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const ra = Number((res.headers.get("Retry-After") || "").trim());
      throw new PostError(res.status, data?.error || `http_${res.status}`, data?.reason, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return data as InfoView;
  }

  async function generate(force: boolean) {
    if (busy || destroyed) return;
    busy = true;
    stopTimers();
    root.querySelectorAll<HTMLButtonElement>(".info-body button, .info-status button").forEach((b) => (b.disabled = true));
    const started = Date.now();
    try {
      showProgress("正在提取正文摘录…", started);
      const excerpt = await extractExcerpt(book);
      if (destroyed) return;
      showProgress(
        `${excerpt ? `已提取 ${excerpt.length.toLocaleString()} 字摘录，` : "未能提取正文摘录，仅依据书名，"}正在联网检索并生成，通常需要 1–3 分钟…`,
        started,
      );
      const view = await post(force, excerpt);
      busy = false;
      render(view);
    } catch (e) {
      busy = false;
      if (destroyed || unload.signal.aborted) return;
      if (e instanceof PostError) {
        if (e.status === 401) return onLoginLost();
        if (e.code === "generating") {
          if (!current.info) body.replaceChildren();
          startPolling(started);
          return;
        }
        if (e.code === "ai_busy") {
          const n = e.retryAfter ?? 10;
          return failWith(`AI 服务繁忙，请 ${n} 秒后重试。`, force);
        }
        if (e.code === "ai_not_configured") return failWith(reasonText("ai_not_configured"), force, false);
        if (e.code === "ai_failed") return failWith(`生成失败：${reasonText(e.reason)}`, force);
        return failWith(`生成失败：${reasonText(e.code)}`, force);
      }
      failWith(`生成失败：${errorText(e)}`, force);
    }
  }

  /** Error after a POST; a forced regeneration keeps the previous result visible. */
  function failWith(text: string, force: boolean, retry = true) {
    if (current.status === "ready" && current.info) renderReady(current);
    else body.replaceChildren();
    showMessage(text, "error", retry ? generateButton("重试", force) : undefined);
  }

  load();

  return {
    destroy() {
      destroyed = true;
      stopTimers();
      unload.abort();
      window.removeEventListener("pagehide", onPageHide);
      root.replaceChildren();
      root.hidden = true;
    },
  };
}
