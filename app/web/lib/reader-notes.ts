// Reader notes (docs/notes-plan-2026-10-26.md, N2): selection toolbar (摘录 / 写笔记 / 颜色),
// note editor, highlights, the "笔记 (n)" drawer and `read.html?id=..&note=..` deep links.
// The controller is format-agnostic; epubNotes / mobiNotes / textNotes / pdfNotes anchor and
// draw highlights for each reader. Pure helpers live in reader-notes-core.ts.
import { api, ApiError, el, errorText, notesUrl } from "./common";
import {
  checkQuote,
  chapterLabel,
  compareLocators,
  excerpt,
  HL_HEX,
  Locator,
  MAX_NOTE,
  NOTE_COLORS,
  NoteColor,
  pageLabel,
  parseLocator,
  percentLabel,
  prefixSums,
  segments,
  sliceRanges,
  trimSpan,
} from "./reader-notes-core";

/** One row of /api/notes (app/worker.mjs noteView). */
export interface Note {
  id: string;
  bookId: string;
  quote: string;
  note: string | null;
  color: NoteColor;
  locator: Record<string, unknown> | null;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Where a selection is in the book; `quote` overrides the range text (clamped selections). */
export interface Located {
  locator: Locator;
  label: string | null;
  quote?: string;
}
type Locate = (range: Range) => Located | null;

/** Per-format drawing and navigation. */
export interface Adapter {
  /** (Re)draw one highlight; `emphasis` is the deep-link / drawer flash. */
  draw(n: Note, emphasis?: boolean): void;
  erase(n: Note): void;
  /** Navigate so the note is visible. */
  show(n: Note): Promise<void>;
  /** Viewport rect of the highlight (for placing the editor), if it is rendered. */
  rectOf?(n: Note): Box | null;
}
type Box = { left: number; top: number; right: number; bottom: number };

interface Pending {
  doc: Document;
  range: Range;
  locate: Locate;
}

const coarse = () => window.matchMedia("(pointer: coarse)").matches;
const narrowSheet = () => window.matchMedia("(max-width: 600px)").matches;

/** Rect of a range in the top-level viewport (adds the iframe offset for section documents). */
function rangeBox(range: Range): Box | null {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  if (!rects.length) return null;
  const box = {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
  if (frame) {
    const f = frame.getBoundingClientRect();
    box.left += f.left + frame.clientLeft;
    box.right += f.left + frame.clientLeft;
    box.top += f.top + frame.clientTop;
    box.bottom += f.top + frame.clientTop;
  }
  return box;
}

/** Positions a fixed element above (or below) a rect, clamped to the viewport. */
function place(node: HTMLElement, r: Box | null, prefer: "above" | "below") {
  node.style.left = "0px";
  node.style.top = "0px";
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  if (!r) {
    node.style.left = `${Math.max(8, (vw - w) / 2)}px`;
    node.style.top = `${Math.max(8, (vh - h) / 3)}px`;
    return;
  }
  const x = Math.min(Math.max(8, (r.left + r.right) / 2 - w / 2), Math.max(8, vw - w - 8));
  let y = prefer === "above" ? r.top - h - 10 : r.bottom + 10;
  if (prefer === "above" && y < 64) y = r.bottom + 10;
  if (y + h > vh - 8) y = r.top - h - 10;
  y = Math.min(Math.max(8, y), Math.max(8, vh - h - 8));
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
}

function swatchGroup(onPick: (c: NoteColor) => void, label = "颜色") {
  const buttons = NOTE_COLORS.map((c) => {
    const b = el("button", { type: "button", class: `note-swatch note-${c.value}`, title: c.name, "aria-label": c.name, "data-color": c.value });
    b.addEventListener("click", () => onPick(c.value));
    return b;
  });
  const group = el("span", { class: "note-colors", role: "group", "aria-label": label }, ...buttons);
  const sync = (c: NoteColor | null) => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.color === c)));
  return { group, sync };
}

// =====================================================================================
// Controller
// =====================================================================================
export type ReaderNotes = ReturnType<typeof createReaderNotes>;

export function createReaderNotes(bookId: string) {
  let adapter: Adapter | null = null;
  const notes = new Map<string, Note>();
  const docs = new Set<Document>();
  let pending: Pending | null = null;
  let loaded = false;

  // ---------- toast ----------
  const toastEl = el("div", { class: "rn-toast", role: "status", "aria-live": "polite", hidden: "" });
  let toastTimer = 0;
  const toast = (text: string, ms = 3200) => {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
  };
  const failText = (what: string, e: unknown) =>
    e instanceof ApiError && e.status === 401 ? "登录已失效，请刷新页面重新登录后再操作。" : `${what}失败：${errorText(e)}`;

  // ---------- selection bar ----------
  const quickBtn = el("button", { type: "button", class: "rn-quick" }, "摘录");
  const noteBtn = el("button", { type: "button" }, "写笔记");
  const barColors = swatchGroup((c) => pending && create(pending, c), "摘录为颜色");
  const bar = el("div", { class: "rn-bar", role: "toolbar", "aria-label": "摘录或写笔记", hidden: "" }, quickBtn, noteBtn, barColors.group);
  barColors.sync(null);
  // Keep the selection (main-document readers) when pressing the bar.
  bar.addEventListener("pointerdown", (ev) => ev.preventDefault());
  bar.addEventListener("mousedown", (ev) => ev.preventDefault());
  quickBtn.addEventListener("click", () => pending && create(pending, "yellow"));
  noteBtn.addEventListener("click", () => pending && openEditor({ mode: "new", pending }));
  const hideBar = () => {
    bar.hidden = true;
  };
  const placeBar = () => {
    if (!pending || bar.hidden) return;
    const box = rangeBox(pending.range);
    if (!box) return hideBar();
    place(bar, box, coarse() ? "below" : "above");
  };

  // ---------- editor ----------
  type EditorState = { mode: "new"; pending: Pending } | { mode: "edit"; note: Note };
  let editing: EditorState | null = null;
  let editColor: NoteColor = "yellow";
  const edQuote = el("blockquote", { class: "rn-quote" });
  const edArea = el("textarea", { rows: "4", maxlength: String(MAX_NOTE), placeholder: "写下笔记或评论（可留空，仅摘录）", "aria-label": "笔记" });
  const edColors = swatchGroup((c) => {
    editColor = c;
    edColors.sync(c);
    edQuote.className = `rn-quote note-${c}`;
  });
  const edStatus = el("span", { class: "rn-status muted small", role: "status" });
  const edSave = el("button", { type: "button", class: "primary" }, "保存");
  const edCancel = el("button", { type: "button" }, "取消");
  const edDelete = el("button", { type: "button", class: "link-btn rn-del" }, "删除");
  const edTitle = el("div", { class: "rn-ed-title" });
  const editor = el(
    "div",
    { class: "rn-editor", role: "dialog", "aria-label": "笔记", hidden: "" },
    edTitle,
    edQuote,
    edArea,
    el("div", { class: "rn-ed-row" }, edColors.group, edStatus),
    el("div", { class: "rn-ed-actions" }, edDelete, el("span", { class: "rn-spacer" }), edCancel, edSave),
  );
  // Typing must not turn pages (reader key handlers listen on document).
  for (const type of ["keydown", "keyup", "keypress"]) editor.addEventListener(type, (ev) => ev.stopPropagation());
  editor.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeEditor();
    } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      saveEditor();
    }
  });
  edCancel.addEventListener("click", () => closeEditor());
  edSave.addEventListener("click", () => saveEditor());
  edDelete.addEventListener("click", () => deleteEditing());

  function openEditor(state: EditorState, box?: Box | null) {
    editing = state;
    hideBar();
    edStatus.textContent = "";
    edSave.disabled = false;
    edDelete.disabled = false;
    if (state.mode === "new") {
      const quote = (safeLocate(state.pending)?.quote ?? state.pending.range.toString()).trim();
      edTitle.textContent = "写笔记";
      edQuote.textContent = excerpt(quote, 160);
      edArea.value = "";
      editColor = "yellow";
      edDelete.hidden = true;
      box ??= rangeBox(state.pending.range);
    } else {
      edTitle.textContent = state.note.label ? `编辑笔记 · ${state.note.label}` : "编辑笔记";
      edQuote.textContent = excerpt(state.note.quote, 160);
      edArea.value = state.note.note || "";
      editColor = state.note.color;
      edDelete.hidden = false;
    }
    edColors.sync(editColor);
    edQuote.className = `rn-quote note-${editColor}`;
    editor.hidden = false;
    editor.classList.toggle("rn-sheet", narrowSheet());
    if (narrowSheet()) {
      editor.style.left = "";
      editor.style.top = "";
    } else place(editor, box ?? null, "below");
    edArea.focus({ preventScroll: true });
  }
  function closeEditor() {
    editor.hidden = true;
    editing = null;
  }

  async function saveEditor() {
    const state = editing;
    if (!state || edSave.disabled) return;
    edSave.disabled = true;
    edStatus.textContent = "正在保存…";
    if (state.mode === "new") {
      const ok = await create(state.pending, editColor, edArea.value, (t) => (edStatus.textContent = t));
      if (ok) closeEditor();
      else edSave.disabled = false;
      return;
    }
    const n = state.note;
    const patch: { note?: string; color?: NoteColor } = {};
    if ((n.note || "") !== edArea.value.trim()) patch.note = edArea.value;
    if (n.color !== editColor) patch.color = editColor;
    if (!Object.keys(patch).length) {
      closeEditor();
      return;
    }
    try {
      const data = await api<{ note: Note }>(`/api/notes/${encodeURIComponent(n.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      put(data.note);
      closeEditor();
      toast("已保存");
    } catch (e) {
      edStatus.textContent = failText("保存", e);
      edSave.disabled = false;
    }
  }

  async function deleteEditing() {
    if (editing?.mode !== "edit") return;
    const n = editing.note;
    if (!confirm(`确定删除这条摘录${n.note ? "及笔记" : ""}吗？\n\n“${excerpt(n.quote, 40)}”`)) return;
    edDelete.disabled = true;
    try {
      await api(`/api/notes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
      remove(n.id);
      closeEditor();
      toast("已删除");
    } catch (e) {
      edStatus.textContent = failText("删除", e);
      edDelete.disabled = false;
    }
  }

  // ---------- drawer ----------
  const button = el("button", { type: "button", class: "rn-open", title: "本书摘录与笔记", "aria-expanded": "false", "aria-haspopup": "dialog" }, "笔记");
  const drawerList = el("ol", { class: "rn-list" });
  const drawerEmpty = el("p", { class: "muted small rn-empty" }, "还没有摘录或笔记。选中一段文字即可摘录。");
  const drawerClose = el("button", { type: "button", class: "link-btn rn-close", "aria-label": "关闭" }, "×");
  const drawerTitle = el("h2", {}, "本书笔记");
  const drawer = el(
    "aside",
    { class: "rn-drawer", role: "dialog", "aria-label": "本书笔记", hidden: "" },
    el("div", { class: "rn-drawer-head" }, drawerTitle, drawerClose),
    drawerEmpty,
    drawerList,
    el("div", { class: "rn-drawer-foot" }, el("a", { href: notesUrl(bookId) }, "在笔记页查看、搜索与导出 →")),
  );
  for (const type of ["keydown", "keyup"]) drawer.addEventListener(type, (ev) => ev.stopPropagation());
  drawer.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") setDrawer(false, true);
  });
  const setDrawer = (open: boolean, focusButton = false) => {
    drawer.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      renderDrawer();
      drawerClose.focus();
    } else if (focusButton) button.focus();
  };
  button.addEventListener("click", () => setDrawer(drawer.hidden));
  drawerClose.addEventListener("click", () => setDrawer(false, true));

  const sorted = () => [...notes.values()].sort((a, b) => compareLocators(parseLocator(a.locator), parseLocator(b.locator)) || a.createdAt.localeCompare(b.createdAt));

  function renderDrawer() {
    const list = sorted();
    drawerTitle.textContent = `本书笔记（${list.length}）`;
    drawerEmpty.hidden = list.length > 0;
    drawerList.replaceChildren(
      ...list.map((n) => {
        const item = el(
          "button",
          { type: "button", class: `rn-item note-${n.color}` },
          el("span", { class: "rn-item-quote" }, excerpt(n.quote, 120)),
          ...(n.note ? [el("span", { class: "rn-item-note" }, excerpt(n.note, 160))] : []),
          ...(n.label ? [el("span", { class: "rn-item-label muted small" }, n.label)] : []),
        );
        item.addEventListener("click", () => {
          if (narrowSheet()) setDrawer(false);
          show(n.id);
        });
        return el("li", {}, item);
      }),
    );
  }
  const updateCount = () => {
    button.textContent = loaded ? `笔记 (${notes.size})` : "笔记";
    if (!drawer.hidden) renderDrawer();
  };

  // ---------- model ----------
  function put(n: Note) {
    notes.set(n.id, n);
    adapter?.draw(n);
    updateCount();
  }
  function remove(id: string) {
    const n = notes.get(id);
    if (!n) return;
    notes.delete(id);
    adapter?.erase(n);
    updateCount();
  }

  const safeLocate = (p: Pending) => {
    try {
      return p.locate(p.range);
    } catch (e) {
      console.warn(e);
      return null;
    }
  };

  /** Saves the pending selection as a new note. `report` shows errors in the editor instead of a toast. */
  async function create(p: Pending, color: NoteColor, noteText = "", report?: (t: string) => void): Promise<boolean> {
    const say = report ?? ((t: string) => toast(t, 5000));
    const located = safeLocate(p);
    if (!located) {
      say("无法定位这段文字，未保存。");
      return false;
    }
    const { quote, error } = checkQuote(located.quote ?? p.range.toString());
    if (error) {
      say(errorText(new ApiError(400, error)));
      return false;
    }
    const body: Record<string, unknown> = { quote, color, locator: located.locator };
    if (located.label) body.label = located.label;
    if (noteText.trim()) body.note = noteText;
    try {
      const data = await api<{ note: Note }>(`/api/books/${encodeURIComponent(bookId)}/notes`, { method: "POST", body: JSON.stringify(body) });
      p.doc.getSelection()?.removeAllRanges();
      if (pending === p) pending = null;
      hideBar();
      put(data.note);
      toast(noteText.trim() ? "已保存笔记" : "已摘录");
      return true;
    } catch (e) {
      say(failText("保存", e));
      return false;
    }
  }

  // ---------- selection watching ----------
  const selecting = () => [...docs].some((d) => {
    const s = d.defaultView ? d.getSelection() : null;
    return !!s && !s.isCollapsed && !!s.toString().trim();
  });

  /** Listen for text selections in one document (the page itself or a section iframe). */
  function watch(doc: Document, locate: Locate) {
    if (docs.has(doc)) return;
    docs.add(doc);
    let timer = 0;
    let down = false;
    const evaluate = () => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
        if (pending?.doc === doc) {
          pending = null;
          hideBar();
        }
        return;
      }
      if (!editor.hidden) return; // finishing an edit first
      const range = sel.getRangeAt(0).cloneRange();
      pending = { doc, range, locate };
      bar.hidden = false;
      placeBar();
    };
    const check = (ms: number) => {
      clearTimeout(timer);
      timer = window.setTimeout(evaluate, ms);
    };
    doc.addEventListener("selectionchange", () => check(down ? 900 : 350));
    doc.addEventListener("pointerdown", (ev) => {
      if (bar.contains(ev.target as Node)) return;
      down = true;
      if (pending?.doc === doc) hideBar();
    });
    // A mouse/touch release ends the selection: show the bar on the next frame. Later
    // selectionchange events (touch handles, keyboard) go through the debounce above.
    const up = () => {
      down = false;
      clearTimeout(timer);
      requestAnimationFrame(evaluate);
    };
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
    doc.addEventListener("touchend", up);
    doc.addEventListener("keyup", (ev) => {
      if (ev.shiftKey || ev.key === "Shift") check(150);
    });
  }

  // ---------- open / show ----------
  async function show(id: string) {
    const n = notes.get(id);
    if (!n || !adapter) return;
    try {
      await adapter.show(n);
    } catch (e) {
      console.warn(e);
    }
    flash(n);
  }
  function flash(n: Note) {
    if (!adapter) return;
    let count = 0;
    const tick = () => {
      if (!notes.has(n.id)) return;
      adapter!.draw(notes.get(n.id)!, count % 2 === 0);
      if (++count < 4) window.setTimeout(tick, 450);
    };
    tick();
  }

  /** Opens the editor for an existing note (highlight clicked). Ignored while text is selected. */
  let lastEdit = 0;
  function edit(id: string, box?: Box | null) {
    const n = notes.get(id);
    if (!n || selecting()) return;
    if (Date.now() - lastEdit < 300 && editing?.mode === "edit" && editing.note.id === id) return;
    lastEdit = Date.now();
    openEditor({ mode: "edit", note: n }, box ?? adapter?.rectOf?.(n) ?? null);
  }

  /** Fetches this book's notes, draws them, and follows a `?note=` deep link. */
  async function start() {
    try {
      let before: string | null = null;
      const all: Note[] = [];
      for (let i = 0; i < 20; i++) {
        const p = new URLSearchParams({ book: bookId, limit: "1000" });
        if (before) p.set("before", before);
        const data: { notes: Note[]; nextBefore: string | null } = await api(`/api/notes?${p}`);
        all.push(...data.notes);
        before = data.nextBefore;
        if (!before) break;
      }
      loaded = true;
      for (const n of all) notes.set(n.id, n);
      for (const n of all) adapter?.draw(n);
      updateCount();
    } catch (e) {
      toast(failText("读取笔记", e), 6000);
      return;
    }
    const target = new URLSearchParams(location.search).get("note");
    if (target) {
      if (notes.has(target)) await show(target);
      else toast("未找到这条笔记（可能已删除）。", 5000);
    }
  }

  // ---------- global wiring ----------
  document.body.append(bar, editor, drawer, toastEl);
  window.addEventListener("scroll", () => placeBar(), { capture: true, passive: true });
  window.addEventListener("resize", () => {
    placeBar();
    if (editor.hidden) return;
    editor.classList.toggle("rn-sheet", narrowSheet());
    if (narrowSheet()) editor.style.left = editor.style.top = "";
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!bar.hidden) hideBar();
    else if (!drawer.hidden) setDrawer(false, true);
  });
  updateCount();

  return {
    button,
    watch,
    start,
    edit,
    get: (id: string) => notes.get(id),
    list: () => [...notes.values()],
    setAdapter(a: Adapter) {
      adapter = a;
    },
  };
}

// =====================================================================================
// EPUB (epub.js): CFI ranges, rendition.annotations highlights
// =====================================================================================
export function epubNotes(bookId: string, rendition: any, book: any) {
  const rn = createReaderNotes(bookId);
  const toc: { path: string; label: string }[] = [];
  book.loaded?.navigation
    ?.then((nav: any) => {
      const walk = (items: any[]) => {
        for (const it of items || []) {
          const label = String(it.label || "").trim();
          if (it.href && label) toc.push({ path: String(it.href).split("#")[0], label });
          walk(it.subitems);
        }
      };
      walk(nav?.toc);
    })
    .catch(() => {});

  const labelFor = (cfi: string) => {
    let href = "";
    try {
      href = book.spine.get(cfi)?.href || "";
    } catch {
      /* ignore */
    }
    const item = href ? toc.find((t) => t.path === href) || toc.find((t) => href.endsWith(t.path) || t.path.endsWith(href)) : undefined;
    let frac: number | undefined;
    try {
      if (book.locations?.length?.()) frac = book.locations.percentageFromCfi(cfi);
    } catch {
      /* ignore */
    }
    if (frac === undefined && rendition.location?.start?.percentage > 0) frac = rendition.location.start.percentage;
    return chapterLabel(item?.label, frac);
  };

  rendition.hooks.content.register((contents: any) => {
    rn.watch(contents.document, (range) => {
      const cfi = contents.cfiFromRange(range);
      return cfi ? { locator: { type: "cfi", cfi: String(cfi) }, label: labelFor(String(cfi)) } : null;
    });
  });

  const drawn = new Map<string, string>(); // note id -> cfi
  const cfiOf = (n: Note) => {
    const loc = parseLocator(n.locator);
    return loc?.type === "cfi" ? loc.cfi : null;
  };
  rn.setAdapter({
    draw(n, emphasis) {
      const cfi = cfiOf(n);
      if (!cfi) return;
      const old = drawn.get(n.id);
      if (old) rendition.annotations.remove(old, "highlight");
      rendition.annotations.highlight(
        cfi,
        { id: n.id },
        (e: Event) => {
          if (e?.type !== "touchstart") rn.edit(n.id); // a tap also sends click
        },
        "rn-epub-hl",
        { fill: HL_HEX[n.color], "fill-opacity": emphasis ? "0.75" : "0.35", "mix-blend-mode": "normal" },
      );
      drawn.set(n.id, cfi);
    },
    erase(n) {
      const cfi = drawn.get(n.id);
      if (cfi) rendition.annotations.remove(cfi, "highlight");
      drawn.delete(n.id);
    },
    async show(n) {
      const cfi = cfiOf(n);
      if (cfi) await rendition.display(cfi);
    },
    rectOf(n) {
      const cfi = cfiOf(n);
      try {
        const range = cfi ? rendition.getRange(cfi) : null;
        return range ? rangeBox(range) : null;
      } catch {
        return null;
      }
    },
  });
  return rn;
}

// =====================================================================================
// MOBI / AZW3 (foliate-js): view.getCFI + overlayer highlights
// =====================================================================================
export async function mobiNotes(bookId: string, fv: any) {
  // @ts-ignore -- untyped vendored module
  const { Overlayer } = await import("foliate-js/overlayer.js");
  const rn = createReaderNotes(bookId);
  const byCfi = new Map<string, string>(); // cfi -> note id
  const cfiOf = (n: Note) => {
    const loc = parseLocator(n.locator);
    return loc?.type === "cfi" ? loc.cfi : null;
  };
  const indexOf = (cfi: string) => {
    try {
      return fv.resolveNavigation(cfi)?.index as number | undefined;
    } catch {
      return undefined;
    }
  };

  fv.addEventListener("load", (ev: CustomEvent) => {
    const { doc, index } = ev.detail || {};
    if (!doc) return;
    rn.watch(doc, (range) => {
      const cfi = fv.getCFI(index, range);
      if (!cfi) return null;
      let toc: any;
      try {
        toc = fv.getProgressOf?.(index, range)?.tocItem;
      } catch {
        /* ignore */
      }
      return { locator: { type: "cfi", cfi: String(cfi) }, label: chapterLabel(toc?.label, fv.lastLocation?.fraction) };
    });
  });
  fv.addEventListener("draw-annotation", (ev: CustomEvent) => {
    const { draw, annotation } = ev.detail;
    draw((rects: unknown, opts: unknown) => {
      const g = Overlayer.highlight(rects, opts);
      g.style.opacity = annotation.emphasis ? "0.65" : "0.32";
      return g;
    }, { color: HL_HEX[annotation.color as NoteColor] ?? HL_HEX.yellow });
  });
  // A section's overlayer is created when it loads: draw the notes that live in it.
  fv.addEventListener("create-overlay", (ev: CustomEvent) => {
    const index = ev.detail?.index;
    setTimeout(() => {
      for (const n of rn.list()) {
        const cfi = cfiOf(n);
        if (cfi && indexOf(cfi) === index) adapter.draw(n);
      }
    });
  });
  fv.addEventListener("show-annotation", (ev: CustomEvent) => {
    const id = byCfi.get(ev.detail?.value);
    if (id) rn.edit(id, ev.detail?.range ? rangeBox(ev.detail.range) : null);
  });

  const adapter: Adapter = {
    draw(n, emphasis) {
      const cfi = cfiOf(n);
      if (!cfi) return;
      byCfi.set(cfi, n.id);
      Promise.resolve(fv.addAnnotation({ value: cfi, color: n.color, emphasis: !!emphasis })).catch(() => {});
    },
    erase(n) {
      const cfi = cfiOf(n);
      if (!cfi) return;
      byCfi.delete(cfi);
      Promise.resolve(fv.deleteAnnotation({ value: cfi })).catch(() => {});
    },
    async show(n) {
      const cfi = cfiOf(n);
      if (cfi) await fv.goTo(cfi);
    },
    rectOf(n) {
      const cfi = cfiOf(n);
      if (!cfi) return null;
      try {
        const { index, anchor } = fv.resolveNavigation(cfi);
        const doc = fv.renderer.getContents().find((x: any) => x.index === index)?.doc;
        const range = doc ? anchor(doc) : null;
        return range instanceof Range ? rangeBox(range) : null;
      } catch {
        return null;
      }
    },
  };
  rn.setAdapter(adapter);
  return rn;
}

// =====================================================================================
// TXT / MD: offsets into the decoded text, <mark> wrapping
// =====================================================================================
export function textNotes(bookId: string, article: HTMLElement, text: string) {
  const rn = createReaderNotes(bookId);
  const emph = new Set<string>();
  const drawnColor = new Map<string, NoteColor>();
  let dirty = false;

  const textLoc = (n: Note) => {
    const loc = parseLocator(n.locator);
    return loc?.type === "text" ? loc : null;
  };
  const rebuild = () => {
    dirty = false;
    drawnColor.clear();
    const marks: { id: string; start: number; end: number }[] = [];
    for (const n of rn.list()) {
      const loc = textLoc(n);
      if (loc) marks.push({ id: n.id, start: loc.start, end: loc.end });
    }
    const frag = document.createDocumentFragment();
    for (const s of segments(text.length, marks)) {
      const t = text.slice(s.start, s.end);
      const id = s.ids[s.ids.length - 1];
      const n = id ? rn.get(id) : undefined;
      if (!n) {
        frag.append(t);
        continue;
      }
      drawnColor.set(n.id, n.color);
      frag.append(el("mark", { class: `rn-hl note-${n.color}${emph.has(n.id) ? " rn-flash" : ""}`, "data-note": n.id }, t));
    }
    article.replaceChildren(frag);
  };
  const schedule = () => {
    if (dirty) return;
    dirty = true;
    queueMicrotask(() => dirty && rebuild());
  };
  const marksOf = (id: string) => article.querySelectorAll<HTMLElement>(`mark[data-note="${CSS.escape(id)}"]`);

  /** Offset of a DOM point inside the article, in UTF-16 units of `text`. */
  const offsetOf = (node: Node, offset: number) => {
    const r = document.createRange();
    r.selectNodeContents(article);
    r.setEnd(node, offset);
    return r.toString().length;
  };
  rn.watch(document, (range) => {
    if (!range.intersectsNode(article)) return null;
    const { start, end } = trimSpan(
      text,
      article.contains(range.startContainer) ? offsetOf(range.startContainer, range.startOffset) : 0,
      article.contains(range.endContainer) ? offsetOf(range.endContainer, range.endOffset) : text.length,
    );
    if (end <= start) return null;
    return { locator: { type: "text", start, end }, label: percentLabel(start / Math.max(1, text.length)), quote: text.slice(start, end) };
  });
  article.addEventListener("click", (ev) => {
    const m = (ev.target as Element).closest?.("mark.rn-hl") as HTMLElement | null;
    if (m?.dataset.note) rn.edit(m.dataset.note, m.getBoundingClientRect());
  });

  rn.setAdapter({
    draw(n, emphasis) {
      if (!textLoc(n)) return;
      if (emphasis) emph.add(n.id);
      else emph.delete(n.id);
      if (!dirty && drawnColor.get(n.id) === n.color) {
        marksOf(n.id).forEach((m) => m.classList.toggle("rn-flash", !!emphasis));
      } else schedule();
    },
    erase() {
      schedule();
    },
    async show(n) {
      if (dirty) rebuild();
      marksOf(n.id)[0]?.scrollIntoView({ block: "center" });
    },
    rectOf(n) {
      return marksOf(n.id)[0]?.getBoundingClientRect() ?? null;
    },
  });
  return rn;
}

// =====================================================================================
// PDF (pdf.js): text layer per shown page, offsets into the page's concatenated text items
// =====================================================================================
interface PdfSlot {
  box: HTMLElement;
  layer: HTMLDivElement;
  hl: HTMLDivElement;
  page: number;
  gen: number;
  ready: boolean;
  task: { cancel(): void } | null;
  divs: HTMLElement[];
  strs: string[];
  sums: number[];
  /** strs.join(""): the page text the offsets index. */
  text: string;
  index: Map<Element, number>;
}

/**
 * `boxes` are the page containers (canvas inside, position: relative). Call `renderPage`
 * for every shown page on each render and `clearSlot` for an unused box. Text comes from
 * `page.streamTextContent({ includeMarkedContent: true, disableNormalization: true })`;
 * offsets index `textContentItemsStr.join("")` of that page.
 */
export function pdfNotes(bookId: string, pdfjs: any, boxes: HTMLElement[], go: (page: number) => void) {
  const rn = createReaderNotes(bookId);
  const emph = new Set<string>();
  const waiters = new Map<number, ((s: PdfSlot | null) => void)[]>();
  const slots: PdfSlot[] = boxes.map((box) => {
    const hl = el("div", { class: "rn-pdf-hls", "aria-hidden": "true" });
    const layer = el("div", { class: "textLayer" });
    box.append(hl, layer);
    const s: PdfSlot = { box, layer, hl, page: 0, gen: 0, ready: false, task: null, divs: [], strs: [], sums: [0], text: "", index: new Map() };
    layer.addEventListener("pointerdown", () => layer.classList.add("selecting"));
    box.addEventListener("click", (ev) => {
      if (!document.getSelection()?.isCollapsed) return;
      for (const d of s.hl.children) {
        const r = d.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          rn.edit((d as HTMLElement).dataset.note || "", r);
          return;
        }
      }
    });
    return s;
  });
  document.addEventListener("pointerup", () => slots.forEach((s) => s.layer.classList.remove("selecting")));

  const pdfLoc = (n: Note) => {
    const loc = parseLocator(n.locator);
    return loc?.type === "pdf" ? loc : null;
  };
  const resolveWaiters = (page: number, s: PdfSlot | null) => {
    for (const w of waiters.get(page) || []) w(s);
    waiters.delete(page);
  };

  function drawSlot(s: PdfSlot) {
    s.hl.replaceChildren();
    if (!s.ready) return;
    const base = s.box.getBoundingClientRect();
    for (const n of rn.list()) {
      const loc = pdfLoc(n);
      if (!loc || loc.page !== s.page || loc.start === undefined || loc.end === undefined) continue;
      for (const { index, from, to } of sliceRanges(s.sums, loc.start, loc.end)) {
        const node = s.divs[index]?.firstChild;
        if (!node || !s.divs[index].isConnected) continue;
        const r = document.createRange();
        r.setStart(node, Math.min(from, node.textContent!.length));
        r.setEnd(node, Math.min(to, node.textContent!.length));
        for (const rect of r.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const d = el("div", { class: `rn-pdf-hl note-${n.color}${emph.has(n.id) ? " rn-flash" : ""}`, "data-note": n.id });
          d.style.left = `${rect.left - base.left}px`;
          d.style.top = `${rect.top - base.top}px`;
          d.style.width = `${rect.width}px`;
          d.style.height = `${rect.height}px`;
          s.hl.append(d);
        }
      }
    }
  }

  function clearSlot(i: number) {
    const s = slots[i];
    s.task?.cancel();
    s.task = null;
    s.gen++;
    s.ready = false;
    s.page = 0;
    s.layer.replaceChildren();
    s.hl.replaceChildren();
  }

  function renderPage(i: number, page: any, viewport: any, num: number) {
    clearSlot(i);
    const s = slots[i];
    const gen = s.gen;
    s.page = num;
    s.layer.style.setProperty("--total-scale-factor", String(viewport.scale));
    s.layer.style.setProperty("--scale-round-x", "1px");
    s.layer.style.setProperty("--scale-round-y", "1px");
    // pdf.js sizes each span by measuring it on a canvas whose `lang` is the PDF's language
    // ("" when unset). The layer must resolve fonts the same way, not as the page's zh-CN
    // (a CJK fallback font has different Latin widths and the spans drift off the glyphs).
    s.layer.setAttribute("lang", "");
    const layer = s.layer;
    const source = page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }).pipeThrough(
      new TransformStream({
        transform(chunk: any, ctl) {
          if (chunk?.lang && gen === s.gen) layer.setAttribute("lang", String(chunk.lang));
          ctl.enqueue(chunk);
        },
      }),
    );
    let tl: any;
    try {
      tl = new pdfjs.TextLayer({
        textContentSource: source,
        container: s.layer,
        viewport,
      });
    } catch (e) {
      console.warn(e);
      resolveWaiters(num, null);
      return;
    }
    s.task = tl;
    tl.render().then(
      () => {
        if (gen !== s.gen) return;
        s.task = null;
        s.divs = tl.textDivs;
        s.strs = tl.textContentItemsStr;
        s.sums = prefixSums(s.strs.map((x: string) => x.length));
        s.text = s.strs.join("");
        s.index = new Map(s.divs.map((d: HTMLElement, k: number) => [d, k]));
        s.layer.append(el("div", { class: "endOfContent" }));
        s.ready = true;
        drawSlot(s);
        resolveWaiters(num, s);
      },
      (e: any) => {
        if (gen !== s.gen) return;
        if (e?.name !== "AbortException") console.warn(e);
        resolveWaiters(num, null);
      },
    );
  }

  const waitPage = (page: number) =>
    new Promise<PdfSlot | null>((resolve) => {
      const ready = slots.find((s) => s.ready && s.page === page);
      if (ready) return resolve(ready);
      const list = waiters.get(page) || [];
      list.push(resolve);
      waiters.set(page, list);
      setTimeout(() => resolve(null), 15000);
    });

  /** Offset of a DOM point in a slot's text (start of the next text item for element boundaries). */
  function pointOffset(s: PdfSlot, node: Node, offset: number): number {
    if (node.nodeType === Node.TEXT_NODE) {
      const k = node.parentElement ? s.index.get(node.parentElement) : undefined;
      if (k !== undefined) return s.sums[k] + Math.min(offset, s.strs[k].length);
    } else {
      const k = s.index.get(node as Element);
      if (k !== undefined) return offset > 0 ? s.sums[k + 1] : s.sums[k];
    }
    const point = document.createRange();
    point.setStart(node, offset);
    const connected = s.divs.map((d, k) => [d, k] as const).filter(([d]) => d.isConnected);
    let lo = 0;
    let hi = connected.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (point.comparePoint(connected[mid][0], 0) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < connected.length ? s.sums[connected[lo][1]] : s.sums[s.sums.length - 1];
  }

  /** Quote for [start, end): the item texts, with a line break where an item ends a line. */
  function quoteOf(s: PdfSlot, start: number, end: number) {
    const parts = sliceRanges(s.sums, start, end);
    return parts
      .map((p, k) => {
        const t = s.strs[p.index].slice(p.from, p.to);
        const eol = k < parts.length - 1 && s.divs[p.index]?.nextSibling?.nodeName === "BR";
        return eol && !/\s$/.test(t) ? `${t}\n` : t;
      })
      .join("");
  }

  rn.watch(document, (range) => {
    const s = slots.find((x) => x.ready && x.layer.contains(range.startContainer));
    if (!s) return null;
    const total = s.sums[s.sums.length - 1];
    // A selection running onto the next page or the margin is clamped to this page.
    const { start, end } = trimSpan(
      s.text,
      pointOffset(s, range.startContainer, range.startOffset),
      s.layer.contains(range.endContainer) ? pointOffset(s, range.endContainer, range.endOffset) : total,
    );
    if (end <= start) return null;
    return { locator: { type: "pdf", page: s.page, start, end }, label: pageLabel(s.page), quote: quoteOf(s, start, end) };
  });

  rn.setAdapter({
    draw(n, emphasis) {
      const loc = pdfLoc(n);
      if (!loc) return;
      if (emphasis) emph.add(n.id);
      else emph.delete(n.id);
      for (const s of slots) if (s.ready && s.page === loc.page) drawSlot(s);
    },
    erase(n) {
      const loc = pdfLoc(n);
      for (const s of slots) if (s.ready && loc && s.page === loc.page) drawSlot(s);
    },
    async show(n) {
      const loc = pdfLoc(n);
      if (!loc) return;
      go(loc.page);
      const s = await waitPage(loc.page);
      const first = s?.hl.querySelector<HTMLElement>(`[data-note="${CSS.escape(n.id)}"]`);
      (first ?? s?.box)?.scrollIntoView({ block: "center", inline: "nearest" });
    },
    rectOf(n) {
      for (const s of slots) {
        const d = s.hl.querySelector<HTMLElement>(`[data-note="${CSS.escape(n.id)}"]`);
        if (d) return d.getBoundingClientRect();
      }
      return null;
    },
  });
  return Object.assign(rn, { renderPage, clearSlot });
}
