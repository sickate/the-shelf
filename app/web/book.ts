import {
  api,
  ApiError,
  Book,
  categoryName,
  coverEl,
  downloadUrl,
  el,
  errorText,
  fmt,
  getOwner,
  humanSize,
  loginForm,
  READABLE,
  readUrl,
  renderAuthBox,
  splitTitle,
} from "./lib/common";
import { InfoSection, mountBookInfo } from "./lib/info-view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const id = new URLSearchParams(location.search).get("id") || "";
const loadStatus = $<HTMLParagraphElement>("load-status");
const content = $<HTMLDivElement>("book-content");
const actions = $<HTMLDivElement>("file-actions");
const fileLogin = $<HTMLDivElement>("file-login");
const fileMsg = $<HTMLParagraphElement>("file-message");
const authBox = $<HTMLDivElement>("auth");

let book: Book;
let owner = false;
let infoSection: InfoSection | null = null;

// Going "back" to the shelf should restore its filters, depth and scroll position.
const fromShelf = (() => {
  try {
    const ref = new URL(document.referrer);
    return ref.origin === location.origin && ref.pathname === "/";
  } catch {
    return false;
  }
})();
$<HTMLAnchorElement>("back").addEventListener("click", (ev) => {
  if (fromShelf && history.length > 1) {
    ev.preventDefault();
    history.back();
  }
});

function setOwner(next: boolean) {
  owner = next;
  renderAuthBox(authBox, owner, setOwner);
  if (book) {
    renderActions();
    renderInfo();
  }
}

/** AI book info is owner-only: visitors see nothing of it. */
function renderInfo() {
  infoSection?.destroy();
  infoSection = null;
  if (owner) infoSection = mountBookInfo($("book-info"), book, () => setOwner(false));
}

function fact(term: string, value: string) {
  return [el("dt", {}, term), el("dd", {}, value)];
}

function renderBook() {
  const { main, series } = splitTitle(book.title);
  const f = fmt(book).toUpperCase() || "—";
  const uploaded = book.status === "uploaded";
  document.title = `${main} — The Shelf`;
  const crumb = $<HTMLAnchorElement>("crumb-category");
  crumb.textContent = categoryName(book.category);
  crumb.href = `/?category=${encodeURIComponent(book.category)}`;
  $("cover-slot").replaceChildren(coverEl(book, { footer: series || "THE SHELF" }));
  $("book-title").textContent = main;
  const seriesEl = $("book-series");
  seriesEl.textContent = series ? `系列 / ${series}` : "";
  seriesEl.hidden = !series;
  $("book-byline").textContent = `${categoryName(book.category)} · ${f} · ${humanSize(book.sizeBytes)}`;
  $("book-tags").replaceChildren(
    el("span", { class: "tag" }, f),
    el("span", { class: uploaded ? "tag tag-ok" : "tag tag-local" }, uploaded ? "云端可读" : "仅本地"),
    el("span", { class: "tag" }, "私有收藏"),
  );
  const added = book.createdAt ? new Date(book.createdAt) : null;
  $("book-facts").replaceChildren(
    ...fact("分类", book.category || "未分类"),
    ...fact("格式", f),
    ...fact("大小", `${humanSize(book.sizeBytes)}（${Number(book.sizeBytes).toLocaleString()} bytes）`),
    ...fact("状态", uploaded ? "已上传至私有云端" : "仅登记在本地目录"),
    ...(added && !isNaN(+added) ? fact("添加时间", added.toLocaleString("zh-CN", { hour12: false })) : []),
  );
  $("file-format").textContent = f;
  $("file-size").textContent = `· ${humanSize(book.sizeBytes)}`;
  $("file-explanation").textContent = uploaded
    ? READABLE.has(fmt(book))
      ? "已上传 · 可在浏览器中直接阅读，也可下载原文件。"
      : "已上传 · 该格式不支持在线阅读，请下载原文件。"
    : "仅本地 · 文件超过 20 MB 或尚未上传，只登记目录信息，无法在线阅读或下载。";
  renderActions();
  renderInfo();
  loadStatus.hidden = true;
  content.hidden = false;
}

function renderActions() {
  actions.replaceChildren();
  fileLogin.hidden = true;
  if (book.status !== "uploaded") return;
  if (!owner) {
    fileLogin.replaceChildren(el("p", {}, "阅读与下载需要所有者登录。"), loginForm(() => setOwner(true)));
    fileLogin.hidden = false;
    return;
  }
  if (READABLE.has(fmt(book))) actions.append(el("a", { class: "button primary", href: readUrl(book.id) }, "阅读 →"));
  actions.append(el("a", { class: "button", href: downloadUrl(book.id) }, "下载原文件 ↓"));
  const del = el("button", { type: "button", class: "danger" }, "移到回收站");
  del.addEventListener("click", deleteBook);
  actions.append(del);
}

async function deleteBook() {
  const { main } = splitTitle(book.title);
  if (!confirm(`确定将《${main}》从书架移除吗？\n\n这是软删除：书目会从书架隐藏，但云端对象与上传预算不会释放。`)) return;
  fileMsg.textContent = "正在移除…";
  try {
    await api(`/api/books/${encodeURIComponent(String(book.id))}`, { method: "DELETE" });
    fileMsg.textContent = "已移除，正在返回书架…";
    setTimeout(() => location.replace(`/?category=${encodeURIComponent(book.category)}`), 600);
  } catch (e) {
    fileMsg.textContent = `移除失败：${errorText(e)}`;
    if (e instanceof ApiError && e.status === 401) setOwner(false);
  }
}

(async () => {
  if (!id) {
    renderAuthBox(authBox, false, setOwner);
    loadStatus.textContent = "缺少参数 id。";
    loadStatus.classList.add("error");
    return;
  }
  try {
    const [data, isOwner] = await Promise.all([
      api<{ book: Book } & Book>(`/api/books/${encodeURIComponent(id)}`),
      getOwner(),
    ]);
    book = data.book ?? data;
    owner = isOwner;
    renderAuthBox(authBox, owner, setOwner);
    renderBook();
  } catch (e) {
    loadStatus.textContent = e instanceof ApiError && e.status === 404 ? "未找到这本书，它可能已被移除。" : `读取失败：${errorText(e)}`;
    loadStatus.classList.add("error");
  }
})();
