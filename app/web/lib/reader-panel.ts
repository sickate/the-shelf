// Reader toolbar controls: the 单页/双页 segmented switch and the "Aa" settings panel.
// State lives in read.ts; these widgets only render it and report changes.
import { el } from "./common";
import {
  DEFAULT_PREFS,
  FONT_MAX,
  FONT_MIN,
  FONT_STEP,
  LINE_MAX,
  LINE_MIN,
  LINE_STEP,
  NARROW_QUERY,
  ReaderPrefs,
  clampFont,
  clampLine,
} from "./reader-prefs";

export type PrefField = "font" | "fontPct" | "lineHeight" | "margin" | "theme" | "flow";
type Patch = Partial<ReaderPrefs>;

export const narrowMedia = () => window.matchMedia(NARROW_QUERY);

/** Page chrome follows the chosen theme; "system" leaves it to prefers-color-scheme. */
export function applyPageTheme(theme: ReaderPrefs["theme"]) {
  if (theme === "system") delete document.body.dataset.readerTheme;
  else document.body.dataset.readerTheme = theme;
}

/** Row of mutually exclusive buttons (aria-pressed); returns the group and a sync function. */
function segmented<T extends string>(label: string, options: [T, string][], onPick: (v: T) => void) {
  const buttons = options.map(([value, text]) => {
    const b = el("button", { type: "button", "aria-pressed": "false", "data-value": value }, text);
    b.addEventListener("click", () => onPick(value));
    return b;
  });
  const group = el("div", { class: "seg", role: "group", "aria-label": label }, ...buttons);
  const sync = (v: T) => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === v)));
  return { group, buttons, sync };
}

/**
 * 单页/双页 switch. On narrow screens it is disabled (single page forced) with a tooltip.
 * Call the returned `sync` after prefs or viewport width change.
 */
export function spreadSwitch(onPick: (v: ReaderPrefs["spread"]) => void) {
  const seg = segmented<ReaderPrefs["spread"]>("单页或双页", [["single", "单页"], ["double", "双页"]], onPick);
  seg.group.classList.add("spread-switch");
  const mq = narrowMedia();
  const sync = (p: ReaderPrefs) => {
    const narrow = mq.matches;
    seg.sync(narrow ? "single" : p.spread);
    for (const b of seg.buttons) b.disabled = narrow;
    seg.group.title = narrow ? "屏幕较窄，只能单页显示（宽度 ≥ 900px 时可选双页）" : "单页或双页显示";
  };
  return { el: seg.group, sync };
}

/** − value + stepper. */
function stepper(label: string, format: (v: number) => string, onStep: (d: -1 | 1) => void) {
  const value = el("output", { class: "step-value", "aria-live": "polite" });
  const dec = el("button", { type: "button", "aria-label": `减小${label}` }, "−");
  const inc = el("button", { type: "button", "aria-label": `增大${label}` }, "+");
  dec.addEventListener("click", () => onStep(-1));
  inc.addEventListener("click", () => onStep(1));
  const group = el("div", { class: "stepper", role: "group", "aria-label": label }, dec, value, inc);
  const sync = (v: number, min: number, max: number) => {
    value.textContent = format(v);
    dec.disabled = v <= min;
    inc.disabled = v >= max;
  };
  return { group, sync };
}

/**
 * "Aa" button plus its popover panel with the requested fields. `get` returns the current
 * prefs; `onChange` receives a patch (the caller saves and applies it, then calls `sync`).
 */
export function prefsPanel(fields: PrefField[], get: () => ReaderPrefs, onChange: (patch: Patch) => void) {
  const has = (f: PrefField) => fields.includes(f);
  const panelId = `reader-prefs-${Math.random().toString(36).slice(2, 8)}`;
  const toggle = el("button", {
    type: "button",
    class: "prefs-toggle",
    title: "阅读设置",
    "aria-label": "阅读设置",
    "aria-expanded": "false",
    "aria-controls": panelId,
    "aria-haspopup": "dialog",
  }, "Aa");
  const panel = el("div", { id: panelId, class: "prefs-panel", role: "dialog", "aria-label": "阅读设置", hidden: "" });
  const rows: HTMLElement[] = [];
  const syncs: ((p: ReaderPrefs) => void)[] = [];
  const row = (label: string, control: HTMLElement) => rows.push(el("div", { class: "prefs-row" }, el("span", { class: "prefs-label" }, label), control));

  if (has("font")) {
    const s = segmented<ReaderPrefs["font"]>("字体", [["default", "默认"], ["serif", "宋体"], ["sans", "黑体"], ["kai", "楷体"]], (font) => onChange({ font }));
    s.buttons[0].title = "使用书内字体";
    s.buttons[1].title = "宋体（衬线）";
    s.buttons[2].title = "黑体（无衬线）";
    row("字体", s.group);
    syncs.push((p) => s.sync(p.font));
  }
  if (has("fontPct")) {
    const s = stepper("字号", (v) => `${v}%`, (d) => onChange({ fontPct: clampFont(get().fontPct + d * FONT_STEP) }));
    row("字号", s.group);
    syncs.push((p) => s.sync(p.fontPct, FONT_MIN, FONT_MAX));
  }
  if (has("lineHeight")) {
    const s = stepper("行距", (v) => v.toFixed(1), (d) => onChange({ lineHeight: clampLine(get().lineHeight + d * LINE_STEP) }));
    row("行距", s.group);
    syncs.push((p) => s.sync(p.lineHeight, LINE_MIN, LINE_MAX));
  }
  if (has("margin")) {
    const s = segmented<ReaderPrefs["margin"]>("页边距", [["narrow", "窄"], ["medium", "中"], ["wide", "宽"]], (margin) => onChange({ margin }));
    row("页边距", s.group);
    syncs.push((p) => s.sync(p.margin));
  }
  if (has("theme")) {
    const s = segmented<ReaderPrefs["theme"]>("主题", [["system", "跟随系统"], ["light", "浅色"], ["sepia", "护眼"], ["dark", "深色"]], (theme) => onChange({ theme }));
    row("主题", s.group);
    syncs.push((p) => s.sync(p.theme));
  }
  if (has("flow")) {
    const s = segmented<ReaderPrefs["flow"]>("排版方式", [["paginated", "分页"], ["scrolled", "连续滚动"]], (flow) => onChange({ flow }));
    row("排版", s.group);
    syncs.push((p) => s.sync(p.flow));
  }
  const reset = el("button", { type: "button", class: "prefs-reset" }, "恢复默认");
  reset.addEventListener("click", () => {
    // Reset only what this panel shows; the spread switch keeps its own choice.
    const patch: Record<string, unknown> = {};
    for (const f of fields) patch[f] = DEFAULT_PREFS[f];
    onChange(patch as Patch);
  });
  panel.append(...rows, el("div", { class: "prefs-foot" }, reset));

  const sync = () => {
    const p = get();
    for (const s of syncs) s(p);
  };
  const setOpen = (open: boolean, focusToggle = false) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      sync();
      panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    } else if (focusToggle) toggle.focus();
  };
  toggle.addEventListener("click", () => setOpen(panel.hidden));
  // Keys inside the panel must not turn pages; Esc closes and returns focus to the toggle.
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      setOpen(false, true);
    }
    ev.stopPropagation();
  });
  panel.addEventListener("keyup", (ev) => ev.stopPropagation());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !panel.hidden) setOpen(false, true);
  });
  document.addEventListener("pointerdown", (ev) => {
    if (!panel.hidden && !wrap.contains(ev.target as Node)) setOpen(false);
  });
  const wrap = el("span", { class: "prefs" }, toggle, panel);
  return { el: wrap, sync };
}
