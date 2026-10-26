// Reader display preferences: parsing, clamping, defaults and the CSS injected into
// reflowable books. Pure apart from load/save (try/catch-safe localStorage via `store`);
// no DOM access at import time so it can be unit tested under Node.
import { store } from "./common";

export type Spread = "single" | "double";
export type FontChoice = "default" | "serif" | "sans" | "kai";
export type MarginChoice = "narrow" | "medium" | "wide";
export type ThemeChoice = "system" | "light" | "sepia" | "dark";
export type FlowChoice = "paginated" | "scrolled";
/** A resolved theme ("system" mapped through prefers-color-scheme). */
export type Scheme = "light" | "sepia" | "dark";

export interface ReaderPrefs {
  spread: Spread;
  font: FontChoice;
  /** Font size in percent of the book's own size, 60–200. */
  fontPct: number;
  /** Unitless line height, 1.2–2.2. */
  lineHeight: number;
  margin: MarginChoice;
  theme: ThemeChoice;
  flow: FlowChoice;
}

export const PREFS_KEY = "shelf:reader-prefs:v1";
/** Font size key used before the shared prefs existed; still read as a fallback and kept in sync. */
export const LEGACY_FONT_KEY = "shelf:epub-font";

export const FONT_MIN = 60;
export const FONT_MAX = 200;
export const FONT_STEP = 10;
export const LINE_MIN = 1.2;
export const LINE_MAX = 2.2;
export const LINE_STEP = 0.1;

export const DEFAULT_PREFS: Readonly<ReaderPrefs> = Object.freeze({
  spread: "single",
  font: "default",
  fontPct: 100,
  lineHeight: 1.7,
  margin: "medium",
  theme: "system",
  flow: "paginated",
});

/** Below this viewport width two pages do not fit: single page is forced and the switch disabled. */
export const NARROW_QUERY = "(max-width: 899px)";

// System font stacks only (no web fonts are loaded). "default" keeps the book's own fonts.
export const FONT_STACKS: Record<FontChoice, string> = {
  default: "",
  serif: `"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", Georgia, serif`,
  sans: `"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", system-ui, sans-serif`,
  kai: `"Kaiti SC", "STKaiti", "KaiTi", "Kaiti", "AR PL UKai CN", serif`,
};

export const THEME_COLORS: Record<Scheme, { bg: string; fg: string; link: string }> = {
  light: { bg: "#fffdf8", fg: "#282820", link: "#2f5d8a" },
  sepia: { bg: "#f4ecd8", fg: "#5b4636", link: "#8a5a2b" },
  dark: { bg: "#1b1a17", fg: "#e6e2d6", link: "#9cc3e6" },
};

const SPREADS: Spread[] = ["single", "double"];
const FONTS: FontChoice[] = ["default", "serif", "sans", "kai"];
const MARGINS: MarginChoice[] = ["narrow", "medium", "wide"];
const THEMES: ThemeChoice[] = ["system", "light", "sepia", "dark"];
const FLOWS: FlowChoice[] = ["paginated", "scrolled"];

const pick = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** Clamps to [min, max] and snaps to the step grid; non-numbers fall back. */
function clampStep(v: unknown, min: number, max: number, step: number, fallback: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  const snapped = Math.round(n / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(2));
}

export const clampFont = (v: unknown, fallback = DEFAULT_PREFS.fontPct) => clampStep(v, FONT_MIN, FONT_MAX, FONT_STEP, fallback);
export const clampLine = (v: unknown, fallback = DEFAULT_PREFS.lineHeight) => clampStep(v, LINE_MIN, LINE_MAX, LINE_STEP, fallback);

/** Normalises any partial/garbage object into valid prefs. */
export function normalizePrefs(input: unknown, legacyFont?: string | null): ReaderPrefs {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const legacy = clampFont(legacyFont, DEFAULT_PREFS.fontPct);
  return {
    spread: pick(o.spread, SPREADS, DEFAULT_PREFS.spread),
    font: pick(o.font, FONTS, DEFAULT_PREFS.font),
    fontPct: "fontPct" in o ? clampFont(o.fontPct, legacy) : legacy,
    lineHeight: clampLine(o.lineHeight),
    margin: pick(o.margin, MARGINS, DEFAULT_PREFS.margin),
    theme: pick(o.theme, THEMES, DEFAULT_PREFS.theme),
    flow: pick(o.flow, FLOWS, DEFAULT_PREFS.flow),
  };
}

/** Parses the stored JSON; broken JSON yields defaults (with the legacy font size if any). */
export function parsePrefs(raw: string | null | undefined, legacyFont?: string | null): ReaderPrefs {
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      /* corrupt: defaults */
    }
  }
  return normalizePrefs(data, legacyFont);
}

export function loadPrefs(): ReaderPrefs {
  return parsePrefs(store.get(PREFS_KEY), store.get(LEGACY_FONT_KEY));
}

export function savePrefs(p: ReaderPrefs) {
  store.set(PREFS_KEY, JSON.stringify(p));
  store.set(LEGACY_FONT_KEY, String(p.fontPct));
}

export function resolveScheme(theme: ThemeChoice, systemDark: boolean): Scheme {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

/** Spread actually shown: narrow viewports always get a single page. */
export function effectiveSpread(p: Pick<ReaderPrefs, "spread">, narrow: boolean): Spread {
  return narrow ? "single" : p.spread;
}

// ---------------- PDF spreads ----------------
// Double mode shows page 1 alone (the cover), then 2–3, 4–5, ...

/** First page of the spread containing page n. */
export function spreadStart(n: number, total: number, double: boolean): number {
  const p = Math.min(Math.max(1, Math.floor(n) || 1), Math.max(1, total));
  if (!double || p === 1) return p;
  return p % 2 === 0 ? p : p - 1;
}

/** Pages shown for the spread containing page n. */
export function spreadPages(n: number, total: number, double: boolean): number[] {
  const s = spreadStart(n, total, double);
  return double && s > 1 && s + 1 <= total ? [s, s + 1] : [s];
}

/** Start page of the next (+1) or previous (-1) spread; stays put at either end. */
export function stepSpread(n: number, total: number, double: boolean, dir: 1 | -1): number {
  const s = spreadStart(n, total, double);
  if (!double) return Math.min(Math.max(1, s + dir), Math.max(1, total));
  if (dir > 0) {
    const next = s === 1 ? 2 : s + 2;
    return next > total ? s : next;
  }
  return s <= 1 ? 1 : s === 2 ? 1 : s - 2;
}

// ---------------- Reflowable content CSS ----------------

/** Side padding of the reader area (EPUB / TXT). */
export const MARGIN_PX: Record<MarginChoice, number> = { narrow: 8, medium: 24, wide: 64 };
/** foliate-js paginator attributes per margin choice. */
export const FOLIATE_MARGIN: Record<MarginChoice, { margin: string; gap: string }> = {
  narrow: { margin: "16px", gap: "3%" },
  medium: { margin: "24px", gap: "5%" },
  wide: { margin: "40px", gap: "9%" },
};

/**
 * Stylesheet injected into each EPUB/MOBI section document. Colours follow the resolved
 * scheme; font family and line height are forced only where the reader asked for them.
 */
export function contentCss(p: ReaderPrefs, scheme: Scheme): string {
  const c = THEME_COLORS[scheme];
  const stack = FONT_STACKS[p.font];
  return `
    html { color-scheme: ${scheme === "dark" ? "dark" : "light"}; }
    html, body { color: ${c.fg} !important; background: transparent !important; }
    body { font-size: ${p.fontPct}% !important; line-height: ${p.lineHeight} !important; }
    p, li, blockquote, dd, dt, td, div { line-height: inherit !important; }
    ${stack ? `body { font-family: ${stack} !important; } body *:not(code, pre, kbd, samp, tt) { font-family: inherit !important; }` : ""}
    ${scheme !== "light" ? "font[color] { color: inherit !important; }" : ""}
    a[href], a[href] * { color: ${c.link} !important; }
  `;
}
