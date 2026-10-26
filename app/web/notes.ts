import { api, ApiError, bookUrl, el, errorText, getOwner, loginForm, renderAuthBox, splitTitle, store } from "./lib/common";

/** One row of GET /api/notes (docs/notes-plan-2026-10-26.md). */
export interface Note {
  id: string;
  bookId: string;
  bookTitle: string;
  bookFormat: string;
  quote: string;
  note: string | null;
  color: NoteColor;
  locator: Record<string, unknown> | null;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}
type NoteColor = "yellow" | "green" | "blue" | "pink";
const COLORS: { value: NoteColor; name: string }[] = [
  { value: "yellow", name: "黄色" },
  { value: "green", name: "绿色" },
  { value: "blue", name: "蓝色" },
  { value: "pink", name: "粉色" },
];
const PAGE = 200;
const VIEW_KEY = "shelf:notes-view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const authBox = $<HTMLDivElement>("auth");
const loginBox = $<HTMLDivElement>("notes-login");
const app = $<HTMLDivElement>("notes-app");
const qInput = $<HTMLInputElement>("notes-q");
const bookSelect = $<HTMLSelectElement>("notes-book");
const countEl = $<HTMLSpanElement>("notes-count");
const errorEl = $<HTMLParagraphElement>("notes-error");
const listEl = $<HTMLDivElement>("notes-list");
const emptyEl = $<HTMLDivElement>("notes-empty");
const moreBtn = $<HTMLButtonElement>("notes-more");
const viewBtns = [...document.querySelectorAll<HTMLButtonElement>(".notes-view button")];

const params = new URLSearchParams(location.search);
let owner = false;
let view: "book" | "time" = store.get(VIEW_KEY) === "time" ? "time" : "book";
let filterBook = params.get("book") || "";
let filterQ = params.get("q") || "";
let notes: Note[] = [];
let nextBefore: string | null = null;
let loadSeq = 0;
/** Every book seen so far (id -> title), for the filter select. */
const books = new Map<string, string>();

qInput.value = filterQ;

function setOwner(next: boolean) {
  owner = next;
  renderAuthBox(authBox, owner, setOwner);
  app.hidden = !owner;
  loginBox.hidden = owner;
  if (!owner) {
    notes = [];
    listEl.replaceChildren();
    loginBox.replaceChildren(el("p", {}, "摘录与笔记仅所有者可见，请先登录。"), loginForm(() => setOwner(true)));
    return;
  }
  loadBookTitle();
  reload();
}

const onLoginLost = (e: unknown) => {
  if (e instanceof ApiError && e.status === 401) {
    setOwner(false);
    return true;
  }
  return false;
};

// ---------------- Filters / URL state ----------------
function query(extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (filterBook) p.set("book", filterBook);
  if (filterQ) p.set("q", filterQ);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function syncUrl() {
  history.replaceState(null, "", `${location.pathname}${query()}`);
  for (const format of ["md", "csv", "json"]) {
    const p = new URLSearchParams({ format });
    if (filterBook) p.set("book", filterBook);
    if (filterQ) p.set("q", filterQ);
    $<HTMLAnchorElement>(`export-${format}`).href = `/api/notes/export?${p}`;
  }
}

function renderBookOptions() {
  const sorted = [...books].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  bookSelect.replaceChildren(
    el("option", { value: "" }, "全部书籍"),
    ...sorted.map(([id, title]) => el("option", { value: id }, splitTitle(title).main)),
  );
  if (filterBook && !books.has(filterBook)) bookSelect.append(el("option", { value: filterBook }, filterBook));
  bookSelect.value = filterBook;
}

/** A `?book=` link from the detail page: show its title even before any note of it is loaded. */
async function loadBookTitle() {
  if (!filterBook || books.has(filterBook)) return;
  try {
    const data = await api<{ book: { id: string; title: string } }>(`/api/books/${encodeURIComponent(filterBook)}`);
    books.set(String(data.book.id), data.book.title);
    renderBookOptions();
  } catch {
    /* unknown/deleted book: keep the raw id option */
  }
}

let qTimer = 0;
qInput.addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = window.setTimeout(() => {
    const next = qInput.value.trim();
    if (next === filterQ) return;
    filterQ = next;
    reload();
  }, 300);
});
$<HTMLFormElement>("notes-filters").addEventListener("submit", (ev) => {
  ev.preventDefault();
  clearTimeout(qTimer);
  filterQ = qInput.value.trim();
  reload();
});
bookSelect.addEventListener("change", () => {
  filterBook = bookSelect.value;
  reload();
});
for (const btn of viewBtns)
  btn.addEventListener("click", () => {
    view = btn.dataset.view === "time" ? "time" : "book";
    store.set(VIEW_KEY, view);
    render();
  });

// ---------------- Loading ----------------
async function reload() {
  notes = [];
  nextBefore = null;
  syncUrl();
  renderBookOptions();
  await load();
}

async function load() {
  const seq = ++loadSeq;
  errorEl.hidden = true;
  listEl.setAttribute("aria-busy", "true");
  moreBtn.disabled = true;
  if (!notes.length) countEl.textContent = "正在读取笔记…";
  try {
    const extra: Record<string, string> = { limit: String(PAGE) };
    if (nextBefore) extra.before = nextBefore;
    const data = await api<{ notes: Note[]; nextBefore: string | null }>(`/api/notes${query(extra)}`);
    if (seq !== loadSeq) return;
    const seen = new Set(notes.map((n) => n.id));
    notes.push(...data.notes.filter((n) => !seen.has(n.id)));
    nextBefore = data.nextBefore;
    let added = false;
    for (const n of data.notes)
      if (!books.has(n.bookId)) {
        books.set(n.bookId, n.bookTitle);
        added = true;
      }
    if (added) renderBookOptions();
    render();
  } catch (e) {
    if (seq !== loadSeq || onLoginLost(e)) return;
    errorEl.textContent = `读取失败：${errorText(e)}`;
    errorEl.hidden = false;
    countEl.textContent = "";
  } finally {
    if (seq === loadSeq) {
      listEl.setAttribute("aria-busy", "false");
      moreBtn.disabled = false;
    }
  }
}
moreBtn.addEventListener("click", () => load());

// ---------------- Rendering ----------------
const time = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const openUrl = (n: Note) => `/read.html?id=${encodeURIComponent(n.bookId)}&note=${encodeURIComponent(n.id)}`;

function render() {
  for (const b of viewBtns) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  const filtered = Boolean(filterBook || filterQ);
  countEl.textContent = notes.length
    ? `${filtered ? "筛选出" : "共"} ${notes.length}${nextBefore ? "+" : ""} 条`
    : filtered
      ? "没有匹配的笔记"
      : "";
  emptyEl.hidden = notes.length > 0;
  $("notes-empty-title").textContent = filtered ? "没有匹配的摘录或笔记。" : "还没有摘录或笔记。";
  $("notes-empty-text").textContent = filtered ? "换一个搜索词，或选择全部书籍。" : "在阅读页选中一段文字即可摘录或写笔记。";
  moreBtn.hidden = !nextBefore;
  if (view === "time") {
    listEl.replaceChildren(el("ol", { class: "note-items" }, ...notes.map((n) => noteItem(n, true))));
    return;
  }
  // Group by book; groups ordered by their newest note (the list is newest first).
  const groups = new Map<string, Note[]>();
  for (const n of notes) {
    if (!groups.has(n.bookId)) groups.set(n.bookId, []);
    groups.get(n.bookId)!.push(n);
  }
  listEl.replaceChildren(
    ...[...groups].map(([bookId, items]) => {
      const { main, series } = splitTitle(items[0].bookTitle);
      return el(
        "section",
        { class: "note-group" },
        el(
          "h2",
          { class: "note-group-title" },
          el("a", { href: bookUrl(bookId) }, main),
          ...(series ? [el("span", { class: "muted small" }, ` ${series}`)] : []),
          el("span", { class: "note-group-n" }, `${items.length} 条`),
        ),
        el("ol", { class: "note-items" }, ...items.map((n) => noteItem(n, false))),
      );
    }),
  );
}

function noteItem(n: Note, showBook: boolean): HTMLLIElement {
  const li = el("li", { class: `note-item note-${n.color}`, id: `note-${n.id}` });
  const quote = el("blockquote", { class: "note-quote" }, n.quote);
  const text = el("div", { class: "note-text" });
  const msg = el("span", { class: "muted small", role: "status" });
  const meta = el(
    "div",
    { class: "note-meta" },
    ...(showBook ? [el("a", { href: bookUrl(n.bookId), class: "note-book" }, splitTitle(n.bookTitle).main)] : []),
    ...(n.label ? [el("span", {}, n.label)] : []),
    el("time", { datetime: n.createdAt }, time(n.createdAt)),
  );

  const renderText = () => {
    text.replaceChildren(n.note ? el("p", {}, n.note) : el("p", { class: "muted small" }, "（仅摘录，无笔记）"));
  };
  renderText();

  const editBtn = el("button", { type: "button", class: "link-btn" }, n.note ? "编辑笔记" : "写笔记");
  editBtn.addEventListener("click", () => {
    const area = el("textarea", { rows: "4", maxlength: "10000", "aria-label": "笔记" });
    area.value = n.note || "";
    const save = el("button", { type: "button", class: "primary" }, "保存");
    const cancel = el("button", { type: "button" }, "取消");
    const doSave = async () => {
      save.disabled = true;
      msg.textContent = "正在保存…";
      try {
        const data = await api<{ note: Note }>(`/api/notes/${encodeURIComponent(n.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ note: area.value }),
        });
        Object.assign(n, data.note);
        msg.textContent = "已保存";
        editBtn.textContent = n.note ? "编辑笔记" : "写笔记";
        editBtn.hidden = false;
        renderText();
      } catch (e) {
        if (!onLoginLost(e)) msg.textContent = `保存失败：${errorText(e)}`;
        save.disabled = false;
      }
    };
    save.addEventListener("click", doSave);
    cancel.addEventListener("click", () => {
      editBtn.hidden = false;
      msg.textContent = "";
      renderText();
    });
    area.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) doSave();
      if (ev.key === "Escape") cancel.click();
    });
    editBtn.hidden = true;
    text.replaceChildren(area, el("div", { class: "note-edit-actions" }, save, cancel));
    area.focus();
  });

  const swatches = el(
    "span",
    { class: "note-colors", role: "group", "aria-label": "颜色" },
    ...COLORS.map((c) => {
      const b = el("button", {
        type: "button",
        class: `note-swatch note-${c.value}`,
        title: c.name,
        "aria-label": c.name,
        "aria-pressed": String(c.value === n.color),
      });
      b.addEventListener("click", async () => {
        if (c.value === n.color) return;
        msg.textContent = "";
        try {
          const data = await api<{ note: Note }>(`/api/notes/${encodeURIComponent(n.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ color: c.value }),
          });
          li.classList.remove(`note-${n.color}`);
          Object.assign(n, data.note);
          li.classList.add(`note-${n.color}`);
          for (const s of swatches.querySelectorAll("button")) s.setAttribute("aria-pressed", String(s === b));
        } catch (e) {
          if (!onLoginLost(e)) msg.textContent = `修改失败：${errorText(e)}`;
        }
      });
      return b;
    }),
  );

  const del = el("button", { type: "button", class: "link-btn note-del" }, "删除");
  del.addEventListener("click", async () => {
    const preview = [...n.quote].slice(0, 40).join("") + ([...n.quote].length > 40 ? "…" : "");
    if (!confirm(`确定删除这条摘录${n.note ? "及笔记" : ""}吗？\n\n“${preview}”`)) return;
    del.disabled = true;
    try {
      await api(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
      notes = notes.filter((x) => x.id !== n.id);
      render();
    } catch (e) {
      if (!onLoginLost(e)) msg.textContent = `删除失败：${errorText(e)}`;
      del.disabled = false;
    }
  });

  const actions = el(
    "div",
    { class: "note-actions" },
    swatches,
    editBtn,
    el("a", { href: openUrl(n), class: "link-btn" }, "在书中打开 →"),
    del,
    msg,
  );
  li.append(quote, text, meta, actions);
  return li;
}

// ---------------- Boot ----------------
(async () => {
  syncUrl();
  setOwner(await getOwner());
})();
