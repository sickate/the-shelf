export interface Book {
  id: string | number;
  title: string;
  category: string;
  format: string;
  sizeBytes: number;
  status: "uploaded" | "local_only";
  createdAt?: string;
  /** Owner-only list fields. */
  hasCover?: boolean;
  hasInfo?: boolean;
  authors?: string[];
  /** Public CLC (中图法) code, null when unclassified. */
  clc?: string | null;
  /** book | course | paper | articles | manual | other; null = unclassified. */
  docType?: string | null;
}

/** Public classification fields of GET /api/books/:id. */
export interface ClassFields {
  clc: string | null;
  clcPath: { code: string; name: string }[];
  clcSecondary: string[];
  clcSource: "cip" | "ai" | "manual" | null;
  clcConfidence: string | number | null;
  clcReason: string | null;
  clcEvidenceUrl: string | null;
  clcStatus: "none" | "generating" | "ready" | "failed";
  clcError?: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { credentials: "same-origin", ...init, headers });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `http_${res.status}`);
  return data as T;
}

export async function getOwner(): Promise<boolean> {
  showLoginError();
  try {
    const me = await api<{ owner: boolean }>("/api/me");
    return !!me.owner;
  } catch {
    return false;
  }
}

const LOGIN_ERROR_TEXT: Record<string, string> = {
  forbidden_email: "此 Google 账号无权访问",
  google_denied: "已取消 Google 登录",
  google_state: "登录已过期或校验失败，请重新登录",
  google_token: "无法连接 Google 完成登录，请稍后重试",
  google_claims: "Google 账号校验失败（邮箱未验证或凭据无效）",
  not_configured: "Google 登录尚未配置",
};

/** Google sign-in start URL that returns to the current page (minus any login_error). */
export function googleLoginUrl(): string {
  const url = new URL(location.href);
  url.searchParams.delete("login_error");
  return `/api/auth/google?next=${encodeURIComponent(url.pathname + url.search)}`;
}

let loginErrorShown = false;
/** Shows a `?login_error=` code from the Google callback once, then drops it from the URL. */
export function showLoginError(): void {
  if (loginErrorShown) return;
  loginErrorShown = true;
  const url = new URL(location.href);
  const code = url.searchParams.get("login_error");
  if (code === null) return;
  url.searchParams.delete("login_error");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  const text = LOGIN_ERROR_TEXT[code] || `登录失败（${code.slice(0, 40)}）`;
  const close = el("button", { type: "button", class: "link-btn", "aria-label": "关闭" }, "×");
  const bar = el("div", { class: "login-error notice error", role: "alert" }, el("span", {}, text), close);
  close.addEventListener("click", () => bar.remove());
  document.body.prepend(bar);
}

export async function login(password: string): Promise<void> {
  await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
}

export async function logout(): Promise<void> {
  await api("/api/logout", { method: "POST" });
}

export function humanSize(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const READABLE = new Set(["pdf", "epub", "mobi", "azw3", "azw", "txt", "md", "cbz"]);

export function fmt(b: Pick<Book, "format">): string {
  return String(b.format || "").toLowerCase().replace(/^\./, "");
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

const ERROR_TEXT: Record<string, string> = {
  unauthorized: "未登录或会话已过期",
  invalid_password: "密码错误",
  login_required: "需要登录",
  bad_origin: "来源校验失败",
  storage_unknown: "云端写入结果未知，请稍后重试",
  bad_sha256: "SHA-256 无效",
  empty_file: "空文件",
  not_configured: "服务未配置",
  not_found: "未找到",
  duplicate: "已存在（重复）",
  budget_exceeded: "超出 8 GB 上传预算",
  too_large: "文件超过 20,000,000 bytes",
  file_too_large: "文件超过 20,000,000 bytes",
  unsupported_format: "不支持的格式",
  hash_mismatch: "SHA-256 校验不一致",
  bad_path: "路径无效",
  rate_limited: "请求过于频繁，请稍后重试",
  unsupported_type: "不支持的图片类型",
  bad_image: "图片格式校验失败",
  bad_dimensions: "图片尺寸无效",
  bad_clc: "分类号不在分类表内",
  manual_locked: "已手动指定，重新归类将覆盖",
  generating: "正在归类中，请稍后再试",
  ai_busy: "AI 繁忙，请稍后重试",
  ai_failed: "AI 归类失败，请稍后重试",
  ai_bad_output: "AI 返回的分类号无法识别",
  bad_quote: "摘录原文为空",
  quote_too_long: "摘录原文超过 4,000 字",
  note_too_long: "笔记超过 10,000 字",
  label_too_long: "位置说明超过 200 字",
  bad_color: "颜色无效",
  bad_locator: "位置信息无效",
  locator_too_large: "位置信息过大",
  nothing_to_update: "没有要保存的修改",
  bad_format: "导出格式无效",
  q_too_long: "搜索词过长",
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401 && !ERROR_TEXT[e.code]) return ERROR_TEXT.unauthorized;
    return ERROR_TEXT[e.code] ? `${ERROR_TEXT[e.code]}（${e.code}）` : `错误：${e.code}`;
  }
  return `错误：${(e as Error)?.message || String(e)}`;
}

/** Inline login form. Calls onSuccess after successful login. */
export function loginForm(onSuccess: () => void): HTMLFormElement {
  const input = el("input", { type: "password", placeholder: "所有者密码", autocomplete: "current-password", required: "" });
  const btn = el("button", { type: "submit", class: "primary" }, "登录");
  const msg = el("span", { class: "msg", role: "status" });
  const google = el("a", { class: "button primary google-login", href: googleLoginUrl() }, "使用 Google 登录");
  // Recompute on click so the return path reflects the page's current URL.
  google.addEventListener("click", () => google.setAttribute("href", googleLoginUrl()));
  const or = el("span", { class: "login-or muted" }, "或使用所有者密码");
  const form = el("form", { class: "login" }, google, or, input, btn, msg);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    btn.disabled = true;
    msg.textContent = "";
    try {
      await login(input.value);
      input.value = "";
      onSuccess();
    } catch (e) {
      msg.textContent = e instanceof ApiError && e.status === 401 ? "密码错误" : errorText(e);
    } finally {
      btn.disabled = false;
    }
  });
  return form;
}

export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

/** Titles may encode a series path ("系列/卷 1"); the last segment is the book's own title. */
export function splitTitle(title: string): { main: string; series: string } {
  const parts = String(title || "").split("/").map((s) => s.trim()).filter(Boolean);
  const main = parts.pop() || String(title || "");
  return { main, series: parts.join(" / ") };
}

/** Category label without the sorting prefix ("01-计算机与技术" -> "计算机与技术"). */
export function categoryName(category: string): string {
  return String(category || "未分类").replace(/^\d+[-_.\s]+/, "") || String(category);
}

const COVER_COLORS = ["#9d4230", "#365749", "#4e5574", "#976a37", "#62544a", "#7b4657"];

/** Deterministic cover colour (same palette and hash as the original catalog). */
export function coverColor(id: string | number): string {
  return COVER_COLORS[Array.from(String(id)).reduce((a, c) => a + c.charCodeAt(0), 0) % COVER_COLORS.length];
}

/** Cover URL with a per-browser version so a regenerated cover bypasses the 1-day private cache. */
export function coverUrl(id: string | number): string {
  const v = store.get(`shelf:cover-v:${id}`) || "1";
  return `/api/books/${encodeURIComponent(String(id))}/cover?v=${encodeURIComponent(v)}`;
}

/**
 * Overlays a real thumbnail on a CSS cover. If the image fails to load it is removed, leaving
 * the typographic cover in place, and `onError` runs.
 */
export function addCoverImg(cover: HTMLElement, src: string, onError?: () => void, lazy = true): HTMLImageElement {
  cover.querySelector("img.cover-img")?.remove();
  const img = el("img", { class: "cover-img", loading: lazy ? "lazy" : "eager", decoding: "async", alt: "", src });
  img.addEventListener("load", () => cover.classList.add("has-img"), { once: true });
  img.addEventListener(
    "error",
    () => {
      img.remove();
      cover.classList.remove("has-img");
      onError?.();
    },
    { once: true },
  );
  cover.append(img);
  return img;
}

/** CSS-generated typographic cover, optionally with a real thumbnail (`img` URL) on top. */
export function coverEl(
  b: Book,
  opts: { num?: string; footer?: string; img?: string; onImgError?: () => void; eager?: boolean } = {},
): HTMLDivElement {
  const { main } = splitTitle(b.title);
  const cover = el(
    "div",
    { class: "cover", style: `--cover:${coverColor(b.id)}`, "aria-hidden": "true" },
    el("span", { class: "cover-category" }, `${categoryName(b.category)} / THE SHELF`),
    el("h2", {}, main),
  );
  if (opts.num) cover.append(el("span", { class: "cover-num" }, opts.num));
  cover.append(el("span", { class: "cover-author" }, opts.footer ?? (fmt(b).toUpperCase() || "—")));
  if (opts.img) addCoverImg(cover, opts.img, opts.onImgError, !opts.eager);
  return cover;
}

export const bookUrl = (id: string | number) => `/book.html?id=${encodeURIComponent(String(id))}`;
export const readUrl = (id: string | number) => `/read.html?id=${encodeURIComponent(String(id))}`;
export const notesUrl = (bookId?: string | number) =>
  bookId === undefined ? "/notes.html" : `/notes.html?book=${encodeURIComponent(String(bookId))}`;
export const downloadUrl = (id: string | number) => `/api/books/${encodeURIComponent(String(id))}/file?download=1`;

/** Topbar owner controls: a compact login popover, or the owner badge + logout. */
export function renderAuthBox(box: HTMLElement, owner: boolean, onChange: (owner: boolean) => void) {
  box.replaceChildren();
  if (owner) {
    const btn = el("button", { type: "button", class: "link-btn" }, "退出登录");
    btn.addEventListener("click", async () => {
      try {
        await logout();
      } catch {
        /* ignore */
      }
      onChange(false);
    });
    // Notes are owner-only, so the entry only appears with an owner session.
    const notes = el("a", { href: notesUrl() }, "笔记");
    if (location.pathname === "/notes.html") notes.setAttribute("aria-current", "page");
    box.append(notes, el("span", { class: "owner-badge" }, "所有者"), btn);
  } else {
    const details = el("details", { class: "login-pop" }, el("summary", {}, "所有者登录 ↗"));
    const form = loginForm(() => onChange(true));
    details.append(form);
    details.addEventListener("toggle", () => {
      if (details.open) (form.querySelector("input") as HTMLInputElement).focus();
    });
    box.append(details);
  }
}
