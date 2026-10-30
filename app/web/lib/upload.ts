// Owner upload flow: pick/drop files -> quick checks -> SHA-256 -> /api/upload/check -> review -> sequential PUT.
import { extractExcerpt } from "./excerpt";
import { api, ApiError, Book, bookUrl, el, humanSize } from "./common";

export const MAX_BYTES = 20_000_000;
const FORMATS = new Set("pdf epub mobi azw3 azw txt md doc docx ppt pptx xls xlsx chm djvu cbz".split(" "));
const CHECK_CHUNK = 200;

type Status = "queued" | "uploading" | "done" | "failed";
interface Item {
  file: File;
  path: string;
  category: string;
  sha?: string;
  ok: boolean; // may be uploaded
  reason?: string; // Chinese blocking reason (when !ok)
  link?: { href: string; text: string };
  warning?: string;
  status: Status;
  bar?: HTMLProgressElement;
  note?: HTMLElement;
}

/** Server/client reason codes -> Chinese. */
export const UPLOAD_ERRORS: Record<string, string> = {
  bad_path: "路径无效（含非法字符或过长）",
  unsupported_format: "不支持的格式",
  bad_size: "文件大小无效",
  empty_file: "空文件",
  too_large: "超过 20 MB 单本上限",
  bad_sha256: "校验值无效",
  duplicate: "书架里已有相同内容的书",
  duplicate_in_batch: "本批中有内容相同的文件",
  budget_exceeded: "剩余上传预算不足",
  hash_mismatch: "传输中文件损坏，请重试",
  storage_unknown: "存储结果未知：已保留预留，不会自动重传",
  login_required: "需要登录，请先登录后再上传",
  bad_origin: "来源校验失败，请刷新页面后重试",
  rate_limited: "请求过于频繁，请稍后重试",
  network: "网络错误，上传中断",
};

export function reasonText(code: string, size?: number): string {
  if (code === "too_large" && size !== undefined)
    return `超过单本上限 20,000,000 bytes（实际 ${size.toLocaleString("en-US")} bytes，约 ${humanSize(size)}）`;
  return UPLOAD_ERRORS[code] || `错误：${code}`;
}

type UploadedHook = (book: Book, file: File) => void | Promise<void>;
let uploadedHook: UploadedHook | null = null;
/** Register a callback run after each successful upload (e.g. thumbnail generation). */
export function onUploaded(fn: UploadedHook) {
  uploadedHook = fn;
}

// ---------- folder traversal ----------
export interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (e: FsEntry[]) => void, err: (e: unknown) => void): void };
}

/** Recursively collect files below an entry (readEntries returns batches until empty). Hidden names are skipped. */
export async function walkEntry(entry: FsEntry, out: File[] = []): Promise<File[]> {
  if (entry.isFile) {
    out.push(await new Promise<File>((res, rej) => entry.file!(res, rej)));
  } else if (entry.isDirectory) {
    const reader = entry.createReader!();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) if (!child.name.startsWith(".")) await walkEntry(child, out);
    }
  }
  return out;
}

interface Picked {
  file: File;
  folder?: string;
}

async function collectDrop(dt: DataTransfer): Promise<Picked[]> {
  // Entries must be read synchronously from dt.items before any await.
  const entries: (FsEntry | null)[] = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => (i as any).webkitGetAsEntry?.() ?? null);
  const plain = [...dt.files];
  if (!entries.length || entries.some((e) => !e))
    return plain.filter((f) => !f.name.startsWith(".")).map((file) => ({ file }));
  const out: Picked[] = [];
  for (const e of entries as FsEntry[]) {
    if (e.name.startsWith(".")) continue;
    const files = await walkEntry(e);
    // A dropped folder's top-level name is kept as the source folder; nested folders are flattened.
    for (const file of files) if (!file.name.startsWith(".")) out.push({ file, folder: e.isDirectory ? e.name : undefined });
  }
  return out;
}

// ---------- SHA-256 ----------
export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function quickCheck(path: string, file: File): string | null {
  if (path.length > 512 || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some((s) => !s || s === "." || s === ".."))
    return "bad_path";
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!FORMATS.has(ext)) return "unsupported_format";
  if (file.size === 0) return "empty_file";
  if (file.size > MAX_BYTES) return "too_large";
  return null;
}

// ---------- UI ----------
export interface UploadOptions {
  form: HTMLFormElement;
  fileInput: HTMLInputElement;
  review: HTMLElement;
  isOwner: () => boolean;
  onLoginLost: () => void;
  onDone: () => void; // refresh budget + list once after a run
}

export function initUpload(o: UploadOptions) {
  let items: Item[] = [];
  let busy = false;
  let remaining: number | null = null;
  const msg = el("p", { class: "muted small", role: "status" });
  const list = el("ul", { class: "review-list" });
  const summary = el("strong", { class: "review-summary" });
  const startBtn = el("button", { type: "button", class: "primary" }, "开始上传");
  const clearBtn = el("button", { type: "button" }, "清空");
  const bar = el("div", { class: "review-bar" }, summary, el("span", { class: "review-actions" }, startBtn, clearBtn));
  bar.hidden = true;
  o.review.replaceChildren(msg, bar, list);

  const overlay = el("div", { class: "drop-overlay", hidden: "" });
  document.body.append(overlay);

  const say = (t: string, err = false) => {
    msg.textContent = t;
    msg.className = err ? "error small" : "muted small";
  };

  function renderItem(it: Item): HTMLElement {
    const badge = el("span", {});
    const li = el("li", { class: "review-item" });
    const name = el("span", { class: "title", title: it.path }, it.file.name);
    const meta = el("span", { class: "muted" }, `${it.category || "自动归类"} · ${humanSize(it.file.size)}`);
    const note = el("span", {});
    it.note = note;
    if (!it.ok) {
      badge.className = "tag tag-bad";
      badge.textContent = "不能上传";
      note.className = "error";
      note.append(it.reason || "");
      if (it.link) note.append("：", el("a", { href: it.link.href, target: "_blank", rel: "noopener" }, `《${it.link.text}》`));
    } else {
      badge.className = it.warning ? "tag tag-warn" : "tag tag-ok";
      badge.textContent = it.warning ? "可上传（注意）" : "可上传";
      if (it.warning) {
        note.className = "warn";
        note.textContent = it.warning;
      }
    }
    it.bar = el("progress", { max: "100", value: "0", hidden: "" });
    li.append(name, badge, meta, note, it.bar);
    return li;
  }

  function renderReview() {
    list.replaceChildren(...items.map(renderItem));
    const ok = items.filter((i) => i.ok).length;
    summary.textContent = `${ok} 本可上传，${items.length - ok} 本不能上传`;
    bar.hidden = !items.length;
    startBtn.disabled = !ok;
  }

  function setResult(it: Item, text: string, cls: string) {
    if (it.note) {
      it.note.className = cls;
      it.note.textContent = text;
    }
  }

  async function prepare(picked: Picked[]) {
    if (busy) return say("正在处理上一批文件，请稍候", true);
    if (!picked.length) return say("没有可处理的文件");
    busy = true;
    say("");
    items = picked.map(({ file, folder }) => {
      const category = folder ?? "";
      const path = folder ? `${folder}/${file.name}` : file.name;
      const it: Item = { file, path, category, ok: false, status: "queued" };
      const bad = quickCheck(path, file);
      if (bad) it.reason = reasonText(bad, file.size);
      return it;
    });
    renderReview();
    try {
      const todo = items.filter((i) => !i.reason);
      for (const [n, it] of todo.entries()) {
        say(`计算校验 ${n + 1}/${todo.length}`);
        it.sha = await sha256Hex(it.file);
      }
      say(todo.length ? "正在检查是否可上传…" : "");
      for (let i = 0; i < todo.length; i += CHECK_CHUNK) {
        const chunk = todo.slice(i, i + CHECK_CHUNK);
        const res = await api<{ files: any[]; remainingBytes: number }>("/api/upload/check", {
          method: "POST",
          body: JSON.stringify({ files: chunk.map((c) => ({ path: c.path, sizeBytes: c.file.size, sha256: c.sha })) }),
        });
        remaining = res.remainingBytes;
        chunk.forEach((it, j) => {
          const r = res.files[j] || {};
          it.ok = !!r.ok;
          if (r.reason === "duplicate_deleted") it.warning = "在回收站中，上传后将恢复";
          else if (r.reason && !r.ok) it.reason = reasonText(r.reason, it.file.size);
          if (r.warning === "similar_title") it.warning = `书架里已有同名但内容不同的书《${r.existingTitle || ""}》`;
          if (r.reason === "duplicate" && r.existingBookId != null)
            it.link = { href: bookUrl(r.existingBookId), text: r.existingTitle || "查看" };
        });
      }
      say(remaining !== null && todo.length ? `剩余上传预算 ${humanSize(remaining)}` : "");
    } catch (e) {
      for (const i of items) if (!i.reason) (i.ok = false), (i.reason = "检查失败");
      if (e instanceof ApiError && e.status === 401) {
        say(reasonText("login_required"), true);
        o.onLoginLost();
      } else say(`检查失败：${e instanceof ApiError ? reasonText(e.code) : (e as Error).message}`, true);
    }
    busy = false;
    renderReview();
  }

  function putFile(it: Item): Promise<Book> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", "/api/upload");
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Shelf-Path", encodeURIComponent(it.path));
      xhr.setRequestHeader("X-Shelf-Sha256", it.sha!);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && it.bar) it.bar.value = Math.round((ev.loaded / ev.total) * 100);
      };
      xhr.onerror = xhr.ontimeout = () => reject(new ApiError(0, "network"));
      xhr.onload = () => {
        let data: any = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data?.book);
        else reject(new ApiError(xhr.status, data?.error || (xhr.status === 401 ? "login_required" : `http_${xhr.status}`)));
      };
      xhr.send(it.file);
    });
  }

  // ---------- auto classification (background, one at a time) ----------
  type Job = { it: Item; book: Book };
  const jobs: Job[] = [];
  let classifying = false;
  let uploading = false;
  let clsOk = 0;
  let clsTotal = 0;
  let clsDone = 0;
  let upSummary = "";

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** POST /class; returns the view or throws ApiError (with retryAfter for 503 ai_busy). */
  async function classifyCall(book: Book, excerpt: string): Promise<any> {
    const res = await fetch(`/api/books/${encodeURIComponent(book.id)}/class`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(excerpt ? { excerpt } : {}),
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = new ApiError(res.status, data?.error || `http_${res.status}`) as ApiError & { retryAfter?: number };
      err.retryAfter = Number(res.headers.get("Retry-After")) || undefined;
      throw err;
    }
    return data;
  }

  async function classifyOne({ it, book }: Job): Promise<boolean> {
    setResult(it, "已上传 ✓ · 正在自动归类…", "muted");
    let excerpt = "";
    try {
      excerpt = await extractExcerpt(book);
    } catch {
      /* best effort */
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const v = await classifyCall(book, excerpt);
        const names: any[] = Array.isArray(v?.clcPath) ? v.clcPath : [];
        const last = names[names.length - 1]?.name || "";
        if (v?.clc) {
          setResult(it, `已上传 ✓ · 已归类：${v.clc} ${last}`.trim(), "ok");
          return true;
        }
        setResult(it, "已上传 ✓ · 自动归类失败，可在详情页重试", "warn");
        return false;
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "";
        if (code === "ai_busy" && attempt < 2) {
          const s = Math.min(60, (e as ApiError & { retryAfter?: number }).retryAfter || 20);
          await sleep(s * 1000);
          continue;
        }
        if (code === "manual_locked") setResult(it, "已上传 ✓ · 已有手动分类", "ok");
        else if (code === "generating") setResult(it, "已上传 ✓ · 正在归类中", "muted");
        else setResult(it, "已上传 ✓ · 自动归类失败，可在详情页重试", "warn");
        return false;
      }
    }
  }

  function classifyStatus() {
    if (!uploading) say(`正在自动归类 ${clsDone}/${clsTotal}…`);
  }

  async function runClassifyQueue() {
    if (classifying) return;
    classifying = true;
    while (jobs.length) {
      classifyStatus();
      if (await classifyOne(jobs.shift()!)) clsOk++;
      clsDone++;
    }
    classifying = false;
    if (uploading) return; // upload loop finalizes
    finishClassify();
  }

  function finishClassify() {
    if (classifying || !clsTotal) return;
    say(`${upSummary}；自动归类 ${clsOk} 本`);
    if (clsOk) o.onDone();
    clsOk = clsTotal = clsDone = 0;
  }

  function enqueueClassify(it: Item, book: Book) {
    if (!book) return;
    jobs.push({ it, book });
    clsTotal++;
    void runClassifyQueue();
  }

  async function start() {
    if (busy) return;
    const queue = items.filter((i) => i.ok && i.status === "queued");
    if (!queue.length) return;
    busy = true;
    uploading = true;
    startBtn.disabled = clearBtn.disabled = true;
    let done = 0;
    let stopped = false;
    for (const [n, it] of queue.entries()) {
      say(`上传 ${n + 1}/${queue.length}`);
      it.status = "uploading";
      if (it.bar) it.bar.hidden = false;
      setResult(it, "上传中…", "muted");
      try {
        const book = await putFile(it);
        it.status = "done";
        done++;
        if (it.bar) it.bar.hidden = true;
        setResult(it, "已上传 ✓", "ok");
        enqueueClassify(it, book);
        if (uploadedHook && book) {
          try {
            await uploadedHook(book, it.file);
          } catch {
            /* hook failures never fail the upload */
          }
        }
      } catch (e) {
        it.status = "failed";
        const code = e instanceof ApiError ? e.code : "network";
        setResult(it, reasonText(code, it.file.size), "error");
        if (code === "login_required") {
          stopped = true;
          say("需要登录，已停止上传队列，请登录后重新选择文件", true);
          o.onLoginLost();
          break;
        }
      }
    }
    busy = false;
    uploading = false;
    clearBtn.disabled = false;
    upSummary = `上传完成：${done}/${queue.length} 本成功`;
    if (!stopped) say(upSummary);
    if (done) o.onDone();
    if (clsTotal) {
      if (classifying) classifyStatus();
      else finishClassify();
    }
  }

  startBtn.addEventListener("click", start);
  clearBtn.addEventListener("click", () => {
    if (busy) return;
    items = [];
    list.replaceChildren();
    bar.hidden = true;
    say("");
  });

  // File picker uses the same flow.
  o.form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const files = [...(o.fileInput.files || [])];
    o.fileInput.value = "";
    prepare(files.map((file) => ({ file })));
  });

  // Drag & drop anywhere on the page.
  let depth = 0;
  const hasFiles = (ev: DragEvent) => !!ev.dataTransfer && [...ev.dataTransfer.types].includes("Files");
  const hide = () => {
    depth = 0;
    overlay.hidden = true;
  };
  window.addEventListener("dragenter", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth++;
    overlay.textContent = o.isOwner() ? "松开以上传到书架" : "请先登录后再上传";
    overlay.classList.toggle("deny", !o.isOwner());
    overlay.hidden = false;
  });
  window.addEventListener("dragover", (ev) => {
    if (hasFiles(ev)) ev.preventDefault();
  });
  window.addEventListener("dragleave", (ev) => {
    if (!hasFiles(ev)) return;
    if (--depth <= 0) hide();
  });
  window.addEventListener("drop", async (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    hide();
    if (!o.isOwner()) return;
    o.form.closest("details")?.setAttribute("open", "");
    if (busy) return say("正在处理上一批文件，请稍候", true);
    prepare(await collectDrop(ev.dataTransfer!));
  });
}
