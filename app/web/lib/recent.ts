/**
 * Recent reading (docs/recent-reading-plan-2026-10-26.md).
 *
 * Reader side: `reportProgress(text)` may be called on every page turn from any format; it only
 * remembers the latest label until `reportOpened(bookId)` has been sent after a successful load,
 * then sends `PUT progress` at most once every 30 s (trailing), plus a final keepalive PUT on
 * pagehide / when the tab is hidden. Failures are ignored: this is a convenience, never a blocker.
 *
 * Homepage side: `mountRecent(section)` renders the owner-only "最近阅读" row.
 */
import { api, Book, coverEl, coverUrl, el, errorText, readUrl, splitTitle, store } from "./common";

export const PROGRESS_MAX = 40;
export const PROGRESS_INTERVAL_MS = 30_000;

/** Trims, strips control characters and cuts to the server limit (40 code points). */
export function cleanProgress(text: string): string {
  const s = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .trim();
  return [...s].slice(0, PROGRESS_MAX).join("");
}

let bookId = "";
let latest = "";
let sent = "";
let lastSentAt = 0;
let timer: number | undefined;
let hooked = false;

const progressPath = () => `/api/books/${encodeURIComponent(bookId)}/progress`;

function send(keepalive = false) {
  clearTimeout(timer);
  timer = undefined;
  if (!bookId || latest === sent) return;
  const progress = latest;
  sent = progress;
  lastSentAt = Date.now();
  fetch(progressPath(), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ progress }),
    keepalive,
  }).catch(() => {
    /* best effort */
  });
}

function flush() {
  send(true);
}

/** Latest human-readable position, e.g. "第 12 / 300 页" or "约 35%". */
export function reportProgress(text: string) {
  const next = cleanProgress(text);
  if (!next || next === latest) return;
  latest = next;
  if (!bookId) return; // sent with the "opened" report
  const wait = lastSentAt + PROGRESS_INTERVAL_MS - Date.now();
  if (wait <= 0) send();
  else if (timer === undefined) timer = window.setTimeout(() => send(), wait);
}

/** Call once after the book has loaded successfully in the reader. */
export async function reportOpened(id: string) {
  if (bookId || !id) return;
  try {
    await api(`/api/books/${encodeURIComponent(id)}/opened`, {
      method: "POST",
      body: JSON.stringify(latest ? { progress: latest } : {}),
    });
  } catch {
    return; // not recorded (e.g. session expired): no progress reports either
  }
  bookId = id;
  sent = latest;
  lastSentAt = Date.now();
  if (!hooked) {
    hooked = true;
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
  // A page turn while the POST was in flight.
  if (latest !== sent) reportProgress(latest);
}

// ---------------- Homepage section ----------------
export type RecentItem = Book & { lastOpenedAt: string; openCount: number; progress: string | null };

const SHOWN = 12;
const ALL = 100;
const COLLAPSE_KEY = "shelf:recent-collapsed";

/** "刚刚" / "5 分钟前" / "3 小时前" / "2 天前" / "2026-09-01". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Mounts the owner-only "最近阅读" section. Returns `refresh(owner)`: hides the section for
 * visitors, (re)loads it for the owner.
 */
export function mountRecent(section: HTMLElement, onUnauthorized: () => void) {
  const details = el("details", { class: "recent" });
  const count = el("span", { class: "muted small recent-count" });
  const summary = el("summary", {}, el("span", { class: "section-title" }, "最近阅读 / RECENT"), count);
  const row = el("div", { class: "recent-row", role: "list" });
  const status = el("p", { class: "muted small recent-status", role: "status" });
  const allBtn = el("button", { type: "button", class: "link-btn recent-all", hidden: "" }, "查看全部");
  details.append(summary, status, row, allBtn);
  section.replaceChildren(details);
  section.hidden = true;
  details.open = store.get(COLLAPSE_KEY) !== "1";
  details.addEventListener("toggle", () => store.set(COLLAPSE_KEY, details.open ? "0" : "1"));

  let items: RecentItem[] = [];
  let expanded = false;
  let gen = 0;

  const card = (b: RecentItem): HTMLElement => {
    const { main } = splitTitle(b.title);
    const href = readUrl(b.id);
    const remove = el("button", { type: "button", class: "recent-x", title: "从最近阅读中移除", "aria-label": `从最近阅读中移除《${main}》` }, "×");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api(`/api/recent/${encodeURIComponent(String(b.id))}`, { method: "DELETE" });
        items = items.filter((x) => x.id !== b.id);
        render();
      } catch (e: any) {
        remove.disabled = false;
        if (e?.status === 401) return onUnauthorized();
        if (e?.status === 404) {
          items = items.filter((x) => x.id !== b.id);
          render();
          return;
        }
        status.textContent = `移除失败：${errorText(e)}`;
      }
    });
    const meta = [relativeTime(b.lastOpenedAt), b.progress].filter(Boolean).join(" · ");
    return el(
      "article",
      { class: "recent-card", role: "listitem", "data-id": String(b.id) },
      el("a", { href, class: "recent-cover", tabindex: "-1", "aria-hidden": "true" }, coverEl(b, { footer: b.format, img: b.hasCover ? coverUrl(b.id) : undefined })),
      el("h3", { class: "recent-title", title: b.title }, main),
      el("p", { class: "recent-meta", title: new Date(b.lastOpenedAt).toLocaleString() }, meta),
      el("a", { href, class: "recent-go" }, "继续阅读 →"),
      remove,
    );
  };

  function render() {
    const list = expanded ? items : items.slice(0, SHOWN);
    row.replaceChildren(...list.map(card));
    row.hidden = !items.length;
    // Collapsed, at most SHOWN + 1 items are fetched: "13" only means "more than 12".
    const more = !expanded && items.length > SHOWN;
    count.textContent = items.length ? (more ? `${SHOWN}+ 本` : `${items.length.toLocaleString()} 本`) : "";
    if (!items.length && !status.textContent) status.textContent = "还没有阅读记录。在书的详情页点击“阅读”，读过的书会出现在这里。";
    else if (items.length) status.textContent = "";
    allBtn.hidden = !more;
  }

  async function load(limit: number) {
    const my = ++gen;
    try {
      const data = await api<{ recent: RecentItem[] }>(`/api/recent?limit=${limit}`);
      if (my !== gen) return;
      items = data.recent || [];
      status.textContent = "";
      render();
    } catch (e: any) {
      if (my !== gen) return;
      if (e?.status === 401) return onUnauthorized();
      items = [];
      status.textContent = `最近阅读加载失败：${errorText(e)}`;
      render();
    }
  }

  allBtn.addEventListener("click", async () => {
    expanded = true;
    allBtn.disabled = true;
    await load(ALL);
    allBtn.disabled = false;
  });

  let isOwner = false;
  // Coming back from the reader via the back/forward cache: the list has changed.
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted && isOwner) refresh(true);
  });

  function refresh(owner: boolean) {
    isOwner = owner;
    section.hidden = !owner;
    gen++;
    if (!owner) {
      items = [];
      row.replaceChildren();
      return;
    }
    // Collapsed, SHOWN + 1 tells whether "查看全部" is needed; the full list is only fetched on demand.
    load(expanded ? ALL : SHOWN + 1);
  }
  return refresh;
}
