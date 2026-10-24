import { api, Book, el, errorText, fmt, getOwner, humanSize, loginForm, logout, READABLE, ApiError } from "./lib/common";

const MAX_BYTES = 20_000_000;
const PAGE = 200;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const authBox = $<HTMLDivElement>("auth");
const ownerPanel = $<HTMLElement>("owner-panel");
const budgetEl = $<HTMLSpanElement>("budget");
const qInput = $<HTMLInputElement>("q");
const catSelect = $<HTMLSelectElement>("cat");
const statusSeg = $<HTMLDivElement>("status");
const countsEl = $<HTMLParagraphElement>("counts");
const listEl = $<HTMLUListElement>("list");
const listError = $<HTMLParagraphElement>("list-error");
const moreBtn = $<HTMLButtonElement>("more");
const categoryList = $<HTMLDataListElement>("category-list");

let owner = false;
let books: (Book & { _t: string })[] = [];
let categories: string[] = [];
let filtered: typeof books = [];
let shown = 0;
let statusFilter = "";

function renderAuth() {
  authBox.replaceChildren();
  if (owner) {
    const btn = el("button", { type: "button" }, "退出登录");
    btn.addEventListener("click", async () => {
      try {
        await logout();
      } catch {
        /* ignore */
      }
      owner = false;
      afterAuthChange();
    });
    authBox.append(el("span", { class: "muted small" }, "所有者"), btn);
  } else {
    authBox.append(loginForm(() => {
      owner = true;
      afterAuthChange();
    }));
  }
}

function afterAuthChange() {
  renderAuth();
  ownerPanel.hidden = !owner;
  if (owner) loadBudget();
  renderList(true);
}

async function loadBudget() {
  try {
    const b = await api<{ usedBytes: number; limitBytes: number }>("/api/budget");
    const pct = b.limitBytes ? ((b.usedBytes / b.limitBytes) * 100).toFixed(1) : "0";
    budgetEl.textContent = `预算：已用 ${humanSize(b.usedBytes)} / ${humanSize(b.limitBytes)}（${pct}%）`;
  } catch (e) {
    budgetEl.textContent = `预算读取失败：${errorText(e)}`;
  }
}

async function loadBooks() {
  listError.hidden = true;
  try {
    const data = await api<{ books: Book[]; categories: string[] }>("/api/books");
    books = (data.books || []).map((b) => ({ ...b, _t: String(b.title || "").toLowerCase() }));
    categories = data.categories?.length
      ? data.categories
      : [...new Set(books.map((b) => b.category).filter(Boolean))].sort();
    const cur = catSelect.value;
    catSelect.replaceChildren(el("option", { value: "" }, "全部分类"), ...categories.map((c) => el("option", { value: c }, c)));
    catSelect.value = categories.includes(cur) ? cur : "";
    categoryList.replaceChildren(...categories.map((c) => el("option", { value: c })));
  } catch (e) {
    listError.textContent = `书目加载失败：${errorText(e)}`;
    listError.hidden = false;
  }
  renderList(true);
}

function row(b: Book): HTMLLIElement {
  const f = fmt(b);
  const uploaded = b.status === "uploaded";
  const actions = el("span", { class: "actions" });
  if (owner && uploaded) {
    if (READABLE.has(f)) actions.append(el("a", { href: `/read.html?id=${encodeURIComponent(String(b.id))}`, class: "btn" }, "阅读"));
    actions.append(el("a", { href: `/api/books/${encodeURIComponent(String(b.id))}/file?download=1`, class: "btn" }, "下载"));
  }
  return el(
    "li",
    {},
    el("span", { class: "title" }, b.title),
    el(
      "span",
      { class: "meta" },
      el("span", { class: "cat" }, b.category || "未分类"),
      el("span", { class: "fmt" }, f.toUpperCase() || "—"),
      el("span", {}, humanSize(b.sizeBytes)),
      el("span", { class: uploaded ? "badge ok" : "badge local" }, uploaded ? "云端" : "仅本地，>20MB 未上传"),
    ),
    actions,
  );
}

function renderList(reset: boolean) {
  if (reset) {
    const q = qInput.value.trim().toLowerCase();
    const cat = catSelect.value;
    filtered = books.filter(
      (b) => (!q || b._t.includes(q)) && (!cat || b.category === cat) && (!statusFilter || b.status === statusFilter),
    );
    shown = 0;
    listEl.replaceChildren();
  }
  const frag = document.createDocumentFragment();
  const next = filtered.slice(shown, shown + PAGE);
  for (const b of next) frag.append(row(b));
  listEl.append(frag);
  shown += next.length;
  moreBtn.hidden = shown >= filtered.length;
  moreBtn.textContent = `显示更多（剩余 ${filtered.length - shown}）`;
  const up = books.filter((b) => b.status === "uploaded").length;
  countsEl.textContent = `共 ${books.length} 本（云端 ${up}，仅本地 ${books.length - up}）· 匹配 ${filtered.length} 本，显示 ${shown}`;
  if (!filtered.length && books.length) listEl.append(el("li", { class: "empty muted" }, "没有匹配的书"));
}

let qTimer: number | undefined;
qInput.addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = window.setTimeout(() => renderList(true), 120);
});
catSelect.addEventListener("change", () => renderList(true));
statusSeg.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button");
  if (!btn) return;
  statusFilter = btn.dataset.v || "";
  for (const b of statusSeg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
  renderList(true);
});
moreBtn.addEventListener("click", () => renderList(false));

// ---- Upload ----
const uploadForm = $<HTMLFormElement>("upload-form");
const fileInput = $<HTMLInputElement>("upload-files");
const catInput = $<HTMLInputElement>("upload-category");
const uploadLog = $<HTMLUListElement>("upload-log");

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

uploadForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const category = catInput.value.trim().replace(/^\/+|\/+$/g, "");
  const files = [...(fileInput.files || [])];
  if (!category || !files.length) return;
  const submit = uploadForm.querySelector("button") as HTMLButtonElement;
  submit.disabled = true;
  let changed = false;
  for (const file of files) {
    const status = el("span", { class: "muted" }, "等待中");
    uploadLog.prepend(el("li", {}, el("span", { class: "title" }, file.name), el("span", { class: "muted" }, humanSize(file.size)), status));
    const set = (text: string, cls = "muted") => {
      status.textContent = text;
      status.className = cls;
    };
    if (file.size > MAX_BYTES) {
      set("跳过：超过 20,000,000 bytes", "error");
      continue;
    }
    if (file.size === 0) {
      set("跳过：空文件", "error");
      continue;
    }
    try {
      set("计算 SHA-256…");
      const hex = await sha256Hex(file);
      set("上传中…");
      const res = await api<{ book: Book; duplicate: boolean }>("/api/upload", {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Shelf-Path": encodeURIComponent(`${category}/${file.name}`),
          "X-Shelf-Sha256": hex,
        },
      });
      if (res.duplicate) set("已存在（按 SHA-256 去重）", "muted");
      else {
        set("已上传 ✓", "ok");
        changed = true;
      }
    } catch (e) {
      set(errorText(e), "error");
      if (e instanceof ApiError && e.status === 401) {
        owner = false;
        afterAuthChange();
        break;
      }
    }
  }
  submit.disabled = false;
  fileInput.value = "";
  if (changed) {
    loadBudget();
    loadBooks();
  }
});

(async () => {
  owner = await getOwner();
  renderAuth();
  ownerPanel.hidden = !owner;
  if (owner) loadBudget();
  await loadBooks();
})();
