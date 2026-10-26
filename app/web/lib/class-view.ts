// Classification (中图法) section of the book detail page: public display + owner-only editing.
import { ApiError, Book, ClassFields, api, el, errorText } from "./common";
import { ClcIndex, ClcNode, DOC_LABELS, buildIndex, isBookType, pathNames, searchNodes } from "./clc-tree";

export type ClassBook = Book & Partial<ClassFields>;

const SOURCE_LABELS: Record<string, string> = { cip: "CIP 依据", ai: "AI 推断", manual: "手动指定" };
const CONFIDENCE_LABELS: Record<string, string> = { high: "高", medium: "中", low: "低" };

export function confidenceText(c: string | number | null | undefined): string {
  if (c === null || c === undefined || c === "") return "";
  if (typeof c === "number") return `${Math.round(c <= 1 ? c * 100 : c)}%`;
  return CONFIDENCE_LABELS[c] || c;
}

/** Only absolute http(s) links are rendered as links. */
export function safeHttpUrl(u: string | null | undefined): string | null {
  try {
    const url = new URL(String(u || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Maps the POST/PUT view ({clc, clcPath, secondary, source, ...}) onto the book's detail fields. */
export function applyClassView(book: ClassBook, v: any): void {
  Object.assign(book, {
    clc: v.clc ?? null,
    docType: v.docType ?? book.docType ?? null,
    clcPath: Array.isArray(v.clcPath) ? v.clcPath : [],
    clcSecondary: Array.isArray(v.secondary) ? v.secondary : [],
    clcSource: v.source ?? null,
    clcConfidence: v.confidence ?? null,
    clcReason: v.reason ?? null,
    clcEvidenceUrl: v.evidenceUrl ?? null,
    clcStatus: v.status ?? (v.clc ? "ready" : "none"),
    clcError: v.error,
  });
}

interface Hooks {
  isOwner: () => boolean;
  /** Called after the classification changed so the page can refresh breadcrumbs etc. */
  onChange: () => void;
  onLoginLost: () => void;
}

export interface ClassSection {
  render(): void;
}

export function mountBookClass(root: HTMLElement, book: ClassBook, hooks: Hooks): ClassSection {
  let table: ClcIndex | null = null;
  let tablePromise: Promise<ClcIndex> | null = null;
  let pickerOpen = false;
  let message = "";
  let query = "";
  /** Doc type chosen in the picker; null = keep the current one. */
  let pickType: string | null = null;
  let busy = false;

  const loadTable = () =>
    (tablePromise ??= api<{ nodes: ClcNode[] }>("/api/clc?all=1")
      .then((d) => (table = buildIndex(d.nodes || [])))
      .catch((e) => {
        tablePromise = null;
        throw e;
      }));

  /** Raw call so the Retry-After header is available. */
  async function call(method: "POST" | "PUT", url: string, body?: unknown): Promise<any> {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
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

  function failText(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 401 || e.code === "login_required" || e.code === "unauthorized") return "需要登录";
      if (e.code === "ai_busy") {
        const s = (e as ApiError & { retryAfter?: number }).retryAfter;
        return s ? `AI 繁忙，${s} 秒后重试` : "AI 繁忙，请稍后重试";
      }
    }
    return errorText(e);
  }

  async function run(method: "POST" | "PUT", url: string, body?: unknown, retryForce = false) {
    busy = true;
    message = method === "PUT" ? "正在保存…" : "正在归类，可能需要几十秒…";
    render();
    let again = false;
    try {
      applyClassView(book, await call(method, url, body));
      message = "";
      pickerOpen = false;
      pickType = null;
      hooks.onChange();
    } catch (e) {
      if (e instanceof ApiError && e.code === "manual_locked" && !retryForce) {
        again = confirm("已手动指定，重新归类将覆盖。\n\n确定重新归类吗？");
        message = "";
      } else {
        message = `操作失败：${failText(e)}`;
        if (e instanceof ApiError && e.status === 401) hooks.onLoginLost();
      }
    } finally {
      busy = false;
    }
    if (again) return run(method, `${url.split("?")[0]}?force=1`, body, true);
    render();
  }

  function autoButton(): HTMLElement {
    const replacing = !!book.clc;
    const btn = el("button", { type: "button" }, replacing ? "重新归类" : "自动归类");
    btn.disabled = busy || book.clcStatus === "generating";
    btn.addEventListener("click", () => {
      const force = replacing && book.clcSource !== "manual";
      run("POST", `/api/books/${encodeURIComponent(String(book.id))}/class${force ? "?force=1" : ""}`);
    });
    return btn;
  }

  function picker(): HTMLElement {
    const input = el("input", { type: "search", placeholder: "输入分类号或类名，例如 TP31 或 计算机", "aria-label": "搜索分类", autocomplete: "off" });
    input.value = query;
    const typeSel = el(
      "select",
      { "aria-label": "资料类型" },
      ...["book", "course", "paper", "articles", "manual", "other"].map((t) => el("option", { value: t }, DOC_LABELS[t])),
    );
    typeSel.value = pickType ?? (book.docType || "book");
    typeSel.addEventListener("change", () => (pickType = typeSel.value));
    const typeRow = el("label", { class: "class-type" }, "资料类型", typeSel);
    const list = el("ul", { class: "class-results" });
    const status = el("p", { class: "muted small", role: "status" });
    const box = el("div", { class: "class-picker" }, typeRow, input, status, list);

    function show() {
      if (!table) return;
      const idx = table;
      const found = searchNodes(idx, input.value, 50);
      status.textContent = input.value.trim() ? (found.length ? "" : "没有匹配的分类。") : "";
      list.replaceChildren(
        ...found.map((n) => {
          const b = el("button", { type: "button", class: "class-result" }, el("strong", {}, n.code), ` ${n.name}`);
          b.append(el("span", { class: "muted small" }, pathNames(idx, n.code).join(" › ")));
          b.disabled = busy;
          b.addEventListener("click", () => run("PUT", `/api/books/${encodeURIComponent(String(book.id))}/class`, { clc: n.code, docType: typeSel.value }));
          return el("li", {}, b);
        }),
      );
    }
    input.addEventListener("input", () => {
      query = input.value;
      show();
    });
    status.textContent = "正在读取分类表…";
    loadTable().then(
      () => {
        status.textContent = "";
        show();
      },
      (e) => (status.textContent = `分类表读取失败：${failText(e)}`),
    );
    queueMicrotask(() => input.focus());
    return box;
  }

  function render() {
    const parts: Node[] = [el("h2", { class: "section-title" }, "图书分类")];
    const nonBook = !isBookType(book.docType);
    if (book.clc) {
      const path = book.clcPath || [];
      const label = SOURCE_LABELS[book.clcSource || ""] || "";
      const conf = confidenceText(book.clcConfidence);
      const facts = el("dl", { class: "facts class-facts" });
      if (nonBook) facts.append(el("dt", {}, "资料类型"), el("dd", {}, DOC_LABELS[book.docType!] || String(book.docType)));
      facts.append(el("dt", {}, nonBook ? "主题分类号" : "分类号"), el("dd", {}, book.clc));
      if (path.length) facts.append(el("dt", {}, nonBook ? "主题" : "分类路径"), el("dd", {}, path.map((p) => p.name).join(" › ")));
      if (label) facts.append(el("dt", {}, "依据"), el("dd", {}, conf ? `${label}（可信度：${conf}）` : label));
      if (book.clcSecondary?.length) facts.append(el("dt", {}, "副分类号"), el("dd", {}, book.clcSecondary.join("、")));
      if (book.clcReason) facts.append(el("dt", {}, "理由"), el("dd", {}, book.clcReason));
      const href = safeHttpUrl(book.clcEvidenceUrl);
      if (href) facts.append(el("dt", {}, "出处"), el("dd", {}, el("a", { href, target: "_blank", rel: "noopener noreferrer" }, href)));
      parts.push(facts);
    } else {
      if (nonBook) parts.push(el("p", {}, `资料类型：${DOC_LABELS[book.docType!] || book.docType}`));
      parts.push(el("p", { class: "muted" }, book.clcStatus === "generating" ? "正在归类中…" : "尚未归类。"));
    }
    if (hooks.isOwner()) {
      if (book.clcError && !book.clc) parts.push(el("p", { class: "muted small" }, `上次归类失败：${book.clcError}`));
      const edit = el("button", { type: "button", "aria-expanded": String(pickerOpen) }, "修改分类");
      edit.disabled = busy;
      edit.addEventListener("click", () => {
        pickerOpen = !pickerOpen;
        render();
      });
      parts.push(el("div", { class: "class-actions" }, edit, autoButton()));
      if (pickerOpen) parts.push(picker());
    }
    if (message) parts.push(el("p", { class: message.startsWith("操作失败") ? "status-text error" : "status-text", role: "status" }, message));
    root.replaceChildren(...parts);
  }

  render();
  return { render };
}
