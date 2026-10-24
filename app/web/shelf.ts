import { initUpload } from "./lib/upload";
import {
  api,
  Book,
  bookUrl,
  categoryName,
  coverEl,
  el,
  errorText,
  fmt,
  getOwner,
  humanSize,
  renderAuthBox,
  splitTitle,
} from "./lib/common";

const PAGE = 60;

type Entry = Book & { _t: string; _main: string; _series: string; _created: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const authBox = $<HTMLDivElement>("auth");
const ownerPanel = $<HTMLDetailsElement>("owner-panel");
const budgetEl = $<HTMLSpanElement>("budget");
const qInput = $<HTMLInputElement>("q");
const catSelect = $<HTMLSelectElement>("category");
const catNav = $<HTMLElement>("categories");
const statusSelect = $<HTMLSelectElement>("status");
const sortSelect = $<HTMLSelectElement>("sort");
const sortLabel = $<HTMLSpanElement>("sort-label");
const countEl = $<HTMLSpanElement>("count");
const grid = $<HTMLDivElement>("books");
const emptyEl = $<HTMLDivElement>("empty");
const listError = $<HTMLParagraphElement>("list-error");
const moreBtn = $<HTMLButtonElement>("more");
const categoryList = $<HTMLDataListElement>("category-list");

let owner = false;
let byTitle: Entry[] = [];
let byRecent: Entry[] = [];
let categories: string[] = [];
let filtered: Entry[] = [];
let shown = 0;

// ---------------- URL / history state ----------------
const initial = new URLSearchParams(location.search);
qInput.value = initial.get("q") || "";
statusSelect.value = initial.get("status") || "";
sortSelect.value = initial.get("sort") === "recent" ? "recent" : "title";
let category = initial.get("category") || "";
const restore: { shown?: number; scrollY?: number } = history.state || {};
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

function saveState() {
  const p = new URLSearchParams();
  if (qInput.value.trim()) p.set("q", qInput.value.trim());
  if (category) p.set("category", category);
  if (statusSelect.value) p.set("status", statusSelect.value);
  if (sortSelect.value !== "title") p.set("sort", sortSelect.value);
  const qs = p.toString();
  history.replaceState({ shown, scrollY: window.scrollY }, "", location.pathname + (qs ? `?${qs}` : ""));
}
let scrollTimer: number | undefined;
window.addEventListener(
  "scroll",
  () => {
    clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(saveState, 250);
  },
  { passive: true },
);
window.addEventListener("pagehide", saveState);

// ---------------- Auth / budget ----------------
function setOwner(next: boolean) {
  owner = next;
  renderAuthBox(authBox, owner, setOwner);
  ownerPanel.hidden = !owner;
  if (owner) loadBudget();
}

async function loadBudget() {
  try {
    const b = await api<{ usedBytes: number; limitBytes: number }>("/api/budget");
    const pct = b.limitBytes ? ((b.usedBytes / b.limitBytes) * 100).toFixed(1) : "0";
    budgetEl.textContent = `预算已用 ${humanSize(b.usedBytes)} / ${humanSize(b.limitBytes)}（${pct}%）`;
  } catch (e) {
    budgetEl.textContent = `预算读取失败：${errorText(e)}`;
  }
}

// ---------------- Catalog ----------------
async function loadBooks() {
  listError.hidden = true;
  try {
    const data = await api<{ books: Book[]; categories?: string[] }>("/api/books");
    const entries: Entry[] = (data.books || []).map((b) => {
      const { main, series } = splitTitle(b.title);
      return {
        ...b,
        _main: main,
        _series: series,
        _t: `${b.title} ${b.category} ${categoryName(b.category)}`.toLowerCase(),
        _created: Date.parse(b.createdAt || "") || 0,
      };
    });
    const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
    byTitle = entries.slice().sort((a, b) => collator.compare(a.title, b.title));
    byRecent = entries.slice().sort((a, b) => b._created - a._created || collator.compare(a.title, b.title));
    categories = [...new Set([...(data.categories || []), ...entries.map((b) => b.category).filter(Boolean)])].sort(
      collator.compare,
    );
    categoryList.replaceChildren(...categories.map((c) => el("option", { value: c })));
    renderStats();
  } catch (e) {
    listError.textContent = `书目加载失败：${errorText(e)}`;
    listError.hidden = false;
  }
  grid.setAttribute("aria-busy", "false");
  render(true);
}

function renderStats() {
  const total = byTitle.reduce((s, b) => s + (Number(b.sizeBytes) || 0), 0);
  $("stat-books").textContent = byTitle.length.toLocaleString();
  $("stat-cats").textContent = String(categories.length);
  $("stat-size").textContent = humanSize(total);
  $("stat-cloud").textContent = byTitle.filter((b) => b.status === "uploaded").length.toLocaleString();
}

/** Books matching search + status (category applied separately so counts stay useful). */
function baseMatches(): Entry[] {
  const q = qInput.value.trim().toLowerCase();
  const status = statusSelect.value;
  const list = sortSelect.value === "recent" ? byRecent : byTitle;
  if (!q && !status) return list;
  return list.filter((b) => (!q || b._t.includes(q)) && (!status || b.status === status));
}

function renderCategories(base: Entry[]) {
  const counts = new Map<string, number>();
  for (const b of base) counts.set(b.category, (counts.get(b.category) || 0) + 1);
  const link = (value: string, label: string, n: number) => {
    const a = el("a", { href: value ? `?category=${encodeURIComponent(value)}` : "/", "data-category": value }, label);
    a.append(el("span", {}, n.toLocaleString()));
    if (value === category) {
      a.classList.add("active");
      a.setAttribute("aria-current", "true");
    }
    return a;
  };
  catNav.replaceChildren(
    link("", "全部藏书", base.length),
    ...categories.map((c) => link(c, categoryName(c), counts.get(c) || 0)),
  );
  catSelect.replaceChildren(
    el("option", { value: "" }, `全部藏书 (${base.length})`),
    ...categories.map((c) => el("option", { value: c }, `${categoryName(c)} (${counts.get(c) || 0})`)),
  );
  catSelect.value = category;
}

function card(b: Entry, i: number): HTMLElement {
  const uploaded = b.status === "uploaded";
  const f = fmt(b).toUpperCase() || "—";
  const link = el(
    "a",
    { href: bookUrl(b.id) },
    coverEl(b, { num: String(i + 1).padStart(2, "0"), footer: b._series || `${f} · ${humanSize(b.sizeBytes)}` }),
    el("h3", { class: "book-title", title: b.title }, b._main),
  );
  return el(
    "article",
    { class: "book-card" },
    link,
    el("div", { class: "book-meta" }, b._series ? `${b._series} · ${categoryName(b.category)}` : categoryName(b.category)),
    el(
      "div",
      { class: "tags" },
      el("span", { class: "tag" }, f),
      el("span", { class: "tag" }, humanSize(b.sizeBytes)),
      el("span", { class: uploaded ? "tag tag-ok" : "tag tag-local" }, uploaded ? "云端可读" : "仅本地"),
    ),
  );
}

function render(reset: boolean) {
  if (reset) {
    const base = baseMatches();
    renderCategories(base);
    filtered = category ? base.filter((b) => b.category === category) : base;
    shown = 0;
    grid.replaceChildren();
  }
  const frag = document.createDocumentFragment();
  const next = filtered.slice(shown, shown + PAGE);
  next.forEach((b, j) => frag.append(card(b, shown + j)));
  grid.append(frag);
  shown += next.length;
  const rest = filtered.length - shown;
  moreBtn.hidden = rest <= 0;
  moreBtn.textContent = `显示更多（剩余 ${rest.toLocaleString()} 本）`;
  emptyEl.hidden = filtered.length > 0 || !byTitle.length;
  countEl.textContent = `${filtered.length.toLocaleString()} 本藏书${filtered.length ? ` · 已显示 ${shown.toLocaleString()}` : ""}`;
  sortLabel.firstChild!.textContent = sortSelect.value === "recent" ? "最近添加在前 " : "按书名排列 ";
  saveState();
}

function update() {
  render(true);
}

let qTimer: number | undefined;
qInput.addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = window.setTimeout(update, 150);
});
statusSelect.addEventListener("change", update);
sortSelect.addEventListener("change", update);
catSelect.addEventListener("change", () => {
  category = catSelect.value;
  update();
});
catNav.addEventListener("click", (ev) => {
  const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>("a[data-category]");
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  ev.preventDefault();
  category = a.dataset.category || "";
  update();
  $("filters").scrollIntoView({ block: "nearest" });
});
$("filters").addEventListener("submit", (ev) => ev.preventDefault());
$("clear").addEventListener("click", () => {
  qInput.value = statusSelect.value = "";
  category = "";
  update();
});
moreBtn.addEventListener("click", () => render(false));

// ---------------- Upload ----------------
initUpload({
  form: $<HTMLFormElement>("upload-form"),
  fileInput: $<HTMLInputElement>("upload-files"),
  catInput: $<HTMLInputElement>("upload-category"),
  review: $("upload-review"),
  isOwner: () => owner,
  onLoginLost: () => setOwner(false),
  onDone: () => {
    loadBudget();
    loadBooks();
  },
});

// ---------------- Boot ----------------
(async () => {
  const [isOwner] = await Promise.all([getOwner(), loadBooks()]);
  setOwner(isOwner);
  // Restore "显示更多" depth and scroll position when coming back from a detail page.
  if (restore.shown && restore.shown > shown) {
    while (shown < Math.min(restore.shown, filtered.length)) render(false);
  }
  if (restore.scrollY) window.scrollTo(0, restore.scrollY);
})();
