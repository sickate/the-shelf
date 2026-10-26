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
import { ClassBook, ClassSection, mountBookClass } from "./lib/class-view";
import { DOC_LABELS, UNCLASSIFIED, isBookType } from "./lib/clc-tree";
import { addCoverImg, coverUrl } from "./lib/common";
import { canThumb, ensureThumb } from "./lib/thumb";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const id = new URLSearchParams(location.search).get("id") || "";
const loadStatus = $<HTMLParagraphElement>("load-status");
const content = $<HTMLDivElement>("book-content");
const actions = $<HTMLDivElement>("file-actions");
const fileLogin = $<HTMLDivElement>("file-login");
const fileMsg = $<HTMLParagraphElement>("file-message");
const authBox = $<HTMLDivElement>("auth");

let book: ClassBook;
let owner = false;
let infoSection: InfoSection | null = null;
let classSection: ClassSection | null = null;

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
    renderCover();
    renderActions();
    renderInfo();
    classSection?.render();
  }
}

const clcName = () => book.clcPath?.[book.clcPath.length - 1]?.name || (book.clc ? book.clc : "未分类");

/** 书架 / 一级 / … / 末级 / 书籍详情; every level filters the shelf. */
function renderCrumbs() {
  const nonBook = !isBookType(book.docType);
  const path = book.clc && book.clcPath?.length ? book.clcPath : nonBook ? [] : [{ code: UNCLASSIFIED, name: "未分类" }];
  $("crumb-path").replaceChildren(
    ...(nonBook ? [" / ", el("a", { href: `/?type=${encodeURIComponent(book.docType!)}` }, DOC_LABELS[book.docType!] || book.docType!)] : []),
    ...path.flatMap((p) => [" / ", el("a", { href: `/?clc=${encodeURIComponent(p.code)}` }, p.name)]),
  );
}

function renderByline() {
  $("book-byline").textContent = `${clcName()} · ${fmt(book).toUpperCase() || "—"} · ${humanSize(book.sizeBytes)}`;
  const facts = $("book-facts");
  const first = facts.querySelector("dd");
  const term = facts.querySelector("dt");
  if (term) term.textContent = isBookType(book.docType) ? "中图法" : "主题";
  if (first) first.textContent = book.clc ? `${book.clc} ${clcName()}` : "未分类";
  renderTags();
}

function renderTags() {
  const uploaded = book.status === "uploaded";
  $("book-tags").replaceChildren(
    ...(isBookType(book.docType) ? [] : [el("span", { class: "tag tag-type" }, DOC_LABELS[book.docType!] || book.docType!)]),
    el("span", { class: "tag" }, fmt(book).toUpperCase() || "—"),
    el("span", { class: uploaded ? "tag tag-ok" : "tag tag-local" }, uploaded ? "云端可读" : "仅本地"),
    el("span", { class: "tag" }, "私有收藏"),
  );
}

/** AI book info is owner-only: visitors see nothing of it. */
function renderInfo() {
  infoSection?.destroy();
  infoSection = null;
  if (owner) infoSection = mountBookInfo($("book-info"), book, () => setOwner(false));
}

/** CSS cover; for the owner the stored thumbnail on top, or a "生成缩略图" button when missing. */
function renderCover() {
  const slot = $("cover-slot");
  const { series } = splitTitle(book.title);
  // Covers are owner-only and are only generated for formats thumb.ts can parse.
  const showImg = owner && canThumb(book) && book.hasCover !== false;
  const cover = coverEl(book, {
    footer: series || "THE SHELF",
    img: showImg ? coverUrl(book.id) : undefined,
    eager: true,
    onImgError: () => {
      if (owner) slot.append(thumbButton(cover));
    },
  });
  slot.replaceChildren(cover);
  if (owner && canThumb(book) && book.hasCover === false) slot.append(thumbButton(cover));
}

function thumbButton(cover: HTMLElement): HTMLElement {
  const btn = el("button", { type: "button", class: "link-btn" }, "生成缩略图");
  const msg = el("span", { class: "muted small", role: "status" });
  const box = el("div", { class: "thumb-make" }, btn, msg);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    msg.textContent = "正在生成…";
    try {
      const r = await ensureThumb(book);
      if (r.ok) {
        addCoverImg(cover, coverUrl(book.id), undefined, false);
        box.remove();
      } else {
        msg.textContent = r.reason === "no_cover" ? "这本书没有可用的封面。" : "解析失败，无法生成缩略图。";
      }
    } catch (e) {
      msg.textContent = `生成失败：${errorText(e)}`;
      if (e instanceof ApiError && e.status === 401) setOwner(false);
    } finally {
      btn.disabled = false;
    }
  });
  return box;
}

function fact(term: string, value: string) {
  return [el("dt", {}, term), el("dd", {}, value)];
}

function renderBook() {
  const { main, series } = splitTitle(book.title);
  const f = fmt(book).toUpperCase() || "—";
  const uploaded = book.status === "uploaded";
  document.title = `${main} — The Shelf`;
  renderCrumbs();
  renderCover();
  $("book-title").textContent = main;
  const seriesEl = $("book-series");
  seriesEl.textContent = series ? `系列 / ${series}` : "";
  seriesEl.hidden = !series;
  $("book-byline").textContent = `${clcName()} · ${f} · ${humanSize(book.sizeBytes)}`;
  renderTags();
  const added = book.createdAt ? new Date(book.createdAt) : null;
  $("book-facts").replaceChildren(
    ...fact(isBookType(book.docType) ? "中图法" : "主题", book.clc ? `${book.clc} ${clcName()}` : "未分类"),
    ...fact("来源目录", book.category ? categoryName(book.category) : "未分类"),
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
  classSection ??= mountBookClass($("book-class"), book, {
    isOwner: () => owner,
    onChange: () => {
      renderCrumbs();
      renderByline();
    },
    onLoginLost: () => setOwner(false),
  });
  classSection.render();
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
      api<{ book: ClassBook } & ClassBook>(`/api/books/${encodeURIComponent(id)}`),
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
