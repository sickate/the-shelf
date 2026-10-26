import { initUpload, onUploaded } from "./lib/upload";
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
import {
  ADDED_LABELS,
  ADDED_VALUES,
  FORMAT_GROUPS,
  FORMAT_LABELS,
  Facet,
  FilterState,
  SIZE_BUCKETS,
  SIZE_LABELS,
  SortKey,
  Tri,
  effective,
  emptyFilters,
  facetCounts,
  filterEntries,
  hasActive,
  parseFilters,
  parseSort,
  serializeFilters,
  sortEntries,
  summarize,
} from "./lib/filters";
import { addCoverImg, coverUrl } from "./lib/common";
import {
  ClcIndex,
  ClcNode,
  Counts,
  UNCLASSIFIED,
  buildIndex,
  buildRows,
  chainLabel,
  countBooks,
  deepestName,
  DOC_LABELS,
  DOC_TYPES,
  matchesView,
  parseType,
  serializeType,
  typeCounts,
  parseSelection,
  serializeSelection,
  serverCounts,
} from "./lib/clc-tree";
import { mountThumbPanel } from "./lib/thumb-batch";
import { canThumb, ensureThumb } from "./lib/thumb";

const PAGE = 60;
const SORT_LABELS: Record<SortKey, string> = {
  title: "按书名排列 ",
  recent: "最近添加在前 ",
  size: "按大小（大→小）排列 ",
  format: "按格式排列 ",
};

type Entry = Book & { _t: string; _main: string; _series: string; _created: number };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const authBox = $<HTMLDivElement>("auth");
const ownerPanel = $<HTMLDetailsElement>("owner-panel");
const budgetEl = $<HTMLSpanElement>("budget");
const qInput = $<HTMLInputElement>("q");
const clcSelect = $<HTMLSelectElement>("clc-select");
const clcNav = $<HTMLElement>("clc-tree");
const statusSelect = $<HTMLSelectElement>("status");
const sortSelect = $<HTMLSelectElement>("sort");
const sortLabel = $<HTMLSpanElement>("sort-label");
const countEl = $<HTMLSpanElement>("count");
const grid = $<HTMLDivElement>("books");
const emptyEl = $<HTMLDivElement>("empty");
const listError = $<HTMLParagraphElement>("list-error");
const moreBtn = $<HTMLButtonElement>("more");
const categoryList = $<HTMLDataListElement>("category-list");
const moreFilters = $<HTMLDetailsElement>("more-filters");
const moreBadge = $<HTMLSpanElement>("more-badge");
const mfBody = $<HTMLDivElement>("mf-body");
const summaryEl = $<HTMLParagraphElement>("filter-summary");
const summaryText = $<HTMLSpanElement>("filter-summary-text");

let owner = false;
let all: Entry[] = [];
const sorted = new Map<SortKey, Entry[]>();
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
let categories: string[] = [];
let clcIdx: ClcIndex = buildIndex([]);
let clcServer: Counts | null = null;
/** Explicit expand/collapse choices of the CLC tree, keyed by row code. */
const toggled = new Map<string, boolean>();
let filtered: Entry[] = [];
let shown = 0;
// Resolved before the first render so owner-only filters/fields are right from the start.
const ownerReady: Promise<boolean> = getOwner().then((v) => (owner = v));

// ---------------- URL / history state ----------------
const initial = new URLSearchParams(location.search);
qInput.value = initial.get("q") || "";
statusSelect.value = initial.get("status") || "";
sortSelect.value = parseSort(initial.get("sort"));
let filters: FilterState = parseFilters(initial);
moreFilters.open = hasActive(filters);
/** "" = all, UNCLASSIFIED, or a CLC node code. The legacy `category=` link is the folder filter (filters.category). */
let selected = parseSelection(initial);
/** Non-book material type (`type=` URL param); mutually exclusive with the CLC selection. */
let typeSel = parseType(initial);
if (typeSel) selected = "";
let serverTypes: Record<string, number> = {};
const restore: { shown?: number; scrollY?: number } = history.state || {};
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

function saveState() {
  const p = new URLSearchParams();
  if (qInput.value.trim()) p.set("q", qInput.value.trim());
  serializeSelection(selected, p);
  serializeType(typeSel, p);
  if (statusSelect.value) p.set("status", statusSelect.value);
  if (sortSelect.value !== "title") p.set("sort", sortSelect.value);
  serializeFilters(filters, p);
  const qs = p.toString().replace(/%2C/gi, ",");
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
  const changed = next !== owner;
  owner = next;
  renderAuthBox(authBox, owner, setOwner);
  ownerPanel.hidden = !owner;
  if (owner) loadBudget();
  // Owner-only list fields (hasCover/hasInfo/authors) appear or vanish with the session.
  if (changed) loadBooks();
  else thumbs.refresh();
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
    await ownerReady;
    const [data] = await Promise.all([api<{ books: Book[]; categories?: string[] }>("/api/books"), loadClc()]);
    const entries: Entry[] = (data.books || []).map((b) => {
      const { main, series } = splitTitle(b.title);
      return {
        ...b,
        _main: main,
        _series: series,
        _t: `${b.title} ${b.category} ${categoryName(b.category)} ${b.clc || ""} ${deepestName(clcIdx, b.clc)} ${(b.authors || []).join(" ")}`.toLowerCase(),
        _created: Date.parse(b.createdAt || "") || 0,
      };
    });
    all = entries;
    sorted.clear();
    categories = [...new Set([...(data.categories || []), ...entries.map((b) => b.category).filter(Boolean)])].sort(
      collator.compare,
    );
    categoryList.replaceChildren(...categories.map((c) => el("option", { value: c })));
    renderStats();
    thumbs.refresh();
  } catch (e) {
    listError.textContent = `书目加载失败：${errorText(e)}`;
    listError.hidden = false;
  }
  grid.setAttribute("aria-busy", "false");
  render(true);
}

/** The public CLC table in use; failure keeps the previous one (the tree then falls back to what it has). */
async function loadClc() {
  try {
    const d = await api<{ nodes: ClcNode[]; unclassified: number; total: number; docTypes?: Record<string, number> }>("/api/clc");
    clcIdx = buildIndex(d.nodes || []);
    serverTypes = d.docTypes || {};
    clcServer = serverCounts(d.nodes || [], d.unclassified || 0, d.total || 0);
    if (selected && selected !== UNCLASSIFIED && clcIdx.byCode.size && !clcIdx.byCode.has(selected)) selected = "";
  } catch {
    /* tree is optional */
  }
}

function renderStats() {
  const total = all.reduce((s, b) => s + (Number(b.sizeBytes) || 0), 0);
  $("stat-books").textContent = all.length.toLocaleString();
  $("stat-cats").textContent = String(categories.length);
  $("stat-size").textContent = humanSize(total);
  $("stat-cloud").textContent = all.filter((b) => b.status === "uploaded").length.toLocaleString();
}

function sortedList(): Entry[] {
  const key = parseSort(sortSelect.value);
  let list = sorted.get(key);
  if (!list) sorted.set(key, (list = sortEntries(all, key, collator)));
  return list;
}

/** Books matching search + status (other filters applied separately so counts stay useful). */
function searchMatches(): Entry[] {
  const q = qInput.value.trim().toLowerCase();
  const status = statusSelect.value;
  const list = sortedList();
  if (!q && !status) return list;
  return list.filter((b) => (!q || b._t.includes(q)) && (!status || b.status === status));
}

const filterOpts = () => ({ owner, now: Date.now() });

/** Books matching search + status + the extra filters incl. folder (the CLC selection is applied separately). */
function baseMatches(): Entry[] {
  return filterEntries(searchMatches(), filters, filterOpts());
}

// ---------------- More filters UI ----------------
function chip(label: string, count: number | null, on: boolean, onClick: () => void): HTMLButtonElement {
  const b = el("button", { type: "button", class: on ? "tag chip on" : "tag chip", "aria-pressed": String(on) }, label);
  if (count !== null) b.append(el("span", { class: "chip-n" }, count.toLocaleString()));
  if (count === 0 && !on) b.classList.add("zero");
  b.addEventListener("click", onClick);
  return b;
}

function group(label: string, ...items: Node[]): HTMLElement {
  return el("div", { class: "mf-group" }, el("span", { class: "mf-label" }, label), el("div", { class: "mf-chips" }, ...items));
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function renderMoreFilters() {
  // Facet counts: books matching search/status/CLC selection and every OTHER active filter.
  const pool = selected || typeSel ? searchMatches().filter((b) => matchesView(clcIdx, b, selected, typeSel)) : searchMatches();
  const opts = filterOpts();
  const counts = (f: Facet) => facetCounts(pool, filters, opts, f);
  const fmtC = counts("fmt");
  const sizeC = counts("size");
  const addedC = counts("added");
  const change = (patch: Partial<FilterState>) => {
    filters = { ...filters, ...patch };
    update();
  };
  const tri = (key: "cover" | "info", yes: string, no: string) => {
    const set = (v: Tri) => change({ [key]: filters[key] === v ? "" : v });
    return [chip(yes, null, filters[key] === "1", () => set("1")), chip(no, null, filters[key] === "0", () => set("0"))];
  };
  const catC = counts("category");
  const folderSelect = el(
    "select",
    { "aria-label": "来源目录" },
    el("option", { value: "" }, "全部目录"),
    ...[...new Set([...categories, filters.category].filter(Boolean))].map((c) =>
      el("option", { value: c }, `${categoryName(c)} (${(catC.get(c) || 0).toLocaleString()})`),
    ),
  );
  folderSelect.value = filters.category;
  folderSelect.addEventListener("change", () => change({ category: folderSelect.value }));
  const groups: HTMLElement[] = [
    group("来源目录", folderSelect),
    group("格式", ...FORMAT_GROUPS.map((f) => chip(FORMAT_LABELS[f], fmtC.get(f) || 0, filters.fmt.includes(f), () => change({ fmt: toggle(filters.fmt, f) })))),
    group("大小", ...SIZE_BUCKETS.map((k) => chip(SIZE_LABELS[k], sizeC.get(k) || 0, filters.size.includes(k), () => change({ size: toggle(filters.size, k) })))),
    group(
      "添加时间",
      chip("全部", null, !filters.added, () => change({ added: "" })),
      ...ADDED_VALUES.map((v) => chip(ADDED_LABELS[v], addedC.get(v) || 0, filters.added === v, () => change({ added: filters.added === v ? "" : v }))),
    ),
    group("阅读", chip("可在线阅读", null, filters.readable, () => change({ readable: !filters.readable }))),
  ];
  if (owner) {
    groups.push(group("缩略图", ...tri("cover", "有缩略图", "无缩略图")), group("AI 简介", ...tri("info", "有 AI 简介", "无 AI 简介")));
    const authorC = counts("author");
    const names = new Set(authorC.keys());
    if (filters.author) names.add(filters.author);
    if (names.size) {
      const select = el(
        "select",
        { "aria-label": "作者" },
        el("option", { value: "" }, "全部作者"),
        ...[...names].sort(collator.compare).map((n) => el("option", { value: n }, `${n} (${authorC.get(n) || 0})`)),
      );
      select.value = filters.author;
      select.addEventListener("change", () => change({ author: select.value }));
      groups.push(group("作者", select));
    }
  }
  mfBody.replaceChildren(...groups);
}

function renderSummary() {
  const active = hasActive(filters, owner);
  const e = effective(filters, owner);
  const k = [e.category, e.fmt.length, e.size.length, e.added, e.readable, e.cover, e.info, e.author].filter(Boolean).length;
  moreBadge.textContent = active ? `（已选 ${k}）` : "";
  const sel = typeSel
    ? [`类型：${DOC_LABELS[typeSel]}`]
    : selected
      ? [`分类：${selected === UNCLASSIFIED ? "未分类" : deepestName(clcIdx, selected)}`]
      : [];
  summaryEl.hidden = !active && !sel.length;
  summaryText.textContent = active || sel.length ? summarize(filters, owner, filtered.length, sel) : "";
}

function renderTree(pool: Entry[]) {
  const loaded = all.length > 0;
  const counts = loaded ? countBooks(clcIdx, pool) : clcServer || countBooks(clcIdx, []);
  const total = loaded ? pool.length : clcServer?.total || 0;
  const tCounts = loaded ? typeCounts(pool) : new Map(Object.entries(serverTypes));
  const none = !selected && !typeSel;
  const rows = buildRows(clcIdx, counts, selected, toggled);
  const link = (code: string, label: string, n: number, title: string, active: boolean) => {
    const href = code.startsWith("type:") ? `?type=${encodeURIComponent(code.slice(5))}` : code ? `?clc=${encodeURIComponent(code)}` : "/";
    const a = el("a", { href, "data-clc": code, title }, el("span", { class: "tree-name" }, label));
    a.append(el("span", { class: "tree-n" }, n.toLocaleString()));
    if (active) a.setAttribute("aria-current", "true");
    return a;
  };
  const line = (depth: number, active: boolean, lead: HTMLElement, a: HTMLElement) => {
    const row = el("div", { class: active ? "tree-row active" : "tree-row" }, lead, a);
    row.style.paddingLeft = `${depth * 14}px`;
    return row;
  };
  const spacer = () => el("span", { class: "tree-toggle spacer", "aria-hidden": "true" });
  const items: HTMLElement[] = [
    line(0, none, spacer(), link("", "全部藏书", total, "全部藏书", none)),
    el("h3", { class: "tree-heading" }, "图书"),
  ];
  for (const r of rows) {
    const name = r.chain[r.chain.length - 1].name;
    const lead = r.hasChildren
      ? el("button", { type: "button", class: "tree-toggle", "data-toggle": r.code, "aria-expanded": String(r.expanded), "aria-label": `${r.expanded ? "折叠" : "展开"}${name}` }, r.expanded ? "▾" : "▸")
      : spacer();
    items.push(line(r.depth, r.active, lead, link(r.code, name, r.count, `${chainLabel(r.chain)}（${r.code}）`, r.active)));
  }
  if (counts.unclassified || selected === UNCLASSIFIED) {
    const on = selected === UNCLASSIFIED;
    items.push(line(0, on, spacer(), link(UNCLASSIFIED, "未分类", counts.unclassified, "尚未归类的书", on)));
  }
  const types = DOC_TYPES.filter((t) => (tCounts.get(t) || 0) > 0 || t === typeSel);
  if (types.length) {
    items.push(el("h3", { class: "tree-heading" }, "资料"));
    for (const t of types) items.push(line(0, t === typeSel, spacer(), link(`type:${t}`, DOC_LABELS[t], tCounts.get(t) || 0, DOC_LABELS[t], t === typeSel)));
  }
  clcNav.replaceChildren(...items);
  const flat = buildRows(clcIdx, counts, selected, toggled, true);
  const bookGroup = el(
    "optgroup",
    { label: "图书" },
    ...flat.map((r) => el("option", { value: r.code }, `${"\u3000".repeat(r.depth)}${r.chain[r.chain.length - 1].name} (${r.count.toLocaleString()})`)),
    el("option", { value: UNCLASSIFIED }, `未分类 (${counts.unclassified.toLocaleString()})`),
  );
  clcSelect.replaceChildren(el("option", { value: "" }, `全部藏书 (${total.toLocaleString()})`), bookGroup);
  if (types.length) {
    clcSelect.append(
      el("optgroup", { label: "资料" }, ...types.map((t) => el("option", { value: `type:${t}` }, `${DOC_LABELS[t]} (${(tCounts.get(t) || 0).toLocaleString()})`))),
    );
  }
  clcSelect.value = typeSel ? `type:${typeSel}` : flat.find((r) => r.active)?.code ?? selected;
}

function card(b: Entry, i: number): HTMLElement {
  const uploaded = b.status === "uploaded";
  const f = fmt(b).toUpperCase() || "—";
  const link = el(
    "a",
    { href: bookUrl(b.id) },
    coverEl(b, {
      num: String(i + 1).padStart(2, "0"),
      footer: b._series || `${f} · ${humanSize(b.sizeBytes)}`,
      img: b.hasCover ? coverUrl(b.id) : undefined,
    }),
    el("h3", { class: "book-title", title: b.title }, b._main),
  );
  return el(
    "article",
    { class: "book-card", "data-id": String(b.id) },
    link,
    el("div", { class: "book-meta" }, b._series ? `${b._series} · ${deepestName(clcIdx, b.clc)}` : deepestName(clcIdx, b.clc)),
    el(
      "div",
      { class: "tags" },
      ...(b.docType && b.docType !== "book" ? [el("span", { class: "tag tag-type" }, DOC_LABELS[b.docType] || b.docType)] : []),
      ...(b.clc ? [el("span", { class: "tag", title: "中图法分类号" }, b.clc)] : []),
      el("span", { class: "tag" }, f),
      el("span", { class: "tag" }, humanSize(b.sizeBytes)),
      el("span", { class: uploaded ? "tag tag-ok" : "tag tag-local" }, uploaded ? "云端可读" : "仅本地"),
    ),
  );
}

function render(reset: boolean) {
  if (reset) {
    const base = baseMatches();
    renderTree(base);
    filtered = selected || typeSel ? base.filter((b) => matchesView(clcIdx, b, selected, typeSel)) : base;
    shown = 0;
    grid.replaceChildren();
    renderMoreFilters();
    renderSummary();
  }
  const frag = document.createDocumentFragment();
  const next = filtered.slice(shown, shown + PAGE);
  next.forEach((b, j) => frag.append(card(b, shown + j)));
  grid.append(frag);
  shown += next.length;
  const rest = filtered.length - shown;
  moreBtn.hidden = rest <= 0;
  moreBtn.textContent = `显示更多（剩余 ${rest.toLocaleString()} 本）`;
  emptyEl.hidden = filtered.length > 0 || !all.length;
  countEl.textContent = `${filtered.length.toLocaleString()} 本藏书${filtered.length ? ` · 已显示 ${shown.toLocaleString()}` : ""}`;
  sortLabel.firstChild!.textContent = SORT_LABELS[parseSort(sortSelect.value)];
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
const select = (code: string) => {
  typeSel = code.startsWith("type:") ? code.slice(5) : "";
  selected = typeSel ? "" : code;
  update();
};
clcSelect.addEventListener("change", () => select(clcSelect.value));
clcNav.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  const t = target.closest<HTMLButtonElement>("button[data-toggle]");
  if (t) {
    toggled.set(t.dataset.toggle!, t.getAttribute("aria-expanded") !== "true");
    render(true);
    return;
  }
  const a = target.closest<HTMLAnchorElement>("a[data-clc]");
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  ev.preventDefault();
  const code = a.dataset.clc || "";
  if (a.parentElement?.querySelector("button[data-toggle]")) toggled.set(code, true);
  select(code);
  $("filters").scrollIntoView({ block: "nearest" });
});
$("filters").addEventListener("submit", (ev) => ev.preventDefault());
function clearAll() {
  qInput.value = statusSelect.value = "";
  selected = "";
  typeSel = "";
  filters = emptyFilters();
  update();
}
$("clear").addEventListener("click", clearAll);
$("clear-all").addEventListener("click", clearAll);
moreBtn.addEventListener("click", () => render(false));

// ---------------- Thumbnails ----------------
const thumbPanel = $<HTMLDivElement>("thumb-panel");
const thumbs = mountThumbPanel(thumbPanel, {
  books: () => (owner ? all : []),
  onCover: (b) => {
    const cover = grid.querySelector<HTMLElement>(`article[data-id="${CSS.escape(String(b.id))}"] .cover`);
    if (cover) addCoverImg(cover, coverUrl(b.id));
  },
  onUnauthorized: () => setOwner(false),
});

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
  const [isOwner] = await Promise.all([ownerReady, loadBooks()]);
  setOwner(isOwner);
  // Restore "显示更多" depth and scroll position when coming back from a detail page.
  if (restore.shown && restore.shown > shown) {
    while (shown < Math.min(restore.shown, filtered.length)) render(false);
  }
  if (restore.scrollY) window.scrollTo(0, restore.scrollY);
})();

// New uploads get their thumbnail right away; failures are left for "补全缩略图".
onUploaded(async (book) => {
  if (canThumb(book)) await ensureThumb(book).catch(() => {});
});
