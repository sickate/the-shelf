import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-reader-prefs-")), "reader-prefs.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/reader-prefs.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const P = await import(pathToFileURL(out).href);

test("defaults for missing, corrupt or non-object input", () => {
  assert.deepEqual(P.parsePrefs(null), { ...P.DEFAULT_PREFS });
  assert.deepEqual(P.parsePrefs("{not json"), { ...P.DEFAULT_PREFS });
  assert.deepEqual(P.parsePrefs("42"), { ...P.DEFAULT_PREFS });
  assert.deepEqual(P.parsePrefs("null"), { ...P.DEFAULT_PREFS });
});

test("valid stored prefs round-trip", () => {
  const p = { spread: "double", font: "kai", fontPct: 130, lineHeight: 2, margin: "wide", theme: "sepia", flow: "scrolled" };
  assert.deepEqual(P.parsePrefs(JSON.stringify(p)), p);
});

test("unknown enum values fall back per field", () => {
  const p = P.parsePrefs(JSON.stringify({ spread: "triple", font: "comic", margin: 3, theme: "neon", flow: "auto", fontPct: 120 }));
  assert.equal(p.spread, "single");
  assert.equal(p.font, "default");
  assert.equal(p.margin, "medium");
  assert.equal(p.theme, "system");
  assert.equal(p.flow, "paginated");
  assert.equal(p.fontPct, 120);
});

test("font size and line height are clamped and snapped", () => {
  assert.equal(P.clampFont(10), 60);
  assert.equal(P.clampFont(999), 200);
  assert.equal(P.clampFont(114), 110);
  assert.equal(P.clampFont("130"), 130);
  assert.equal(P.clampFont("abc"), 100);
  assert.equal(P.clampFont(Number.NaN), 100);
  assert.equal(P.clampLine(0.5), 1.2);
  assert.equal(P.clampLine(9), 2.2);
  assert.equal(P.clampLine(1.66), 1.7);
  assert.equal(P.clampLine(1.4 + 0.1), 1.5); // no float drift
  assert.equal(P.clampLine(null), 1.7);
});

test("legacy shelf:epub-font is the fallback font size", () => {
  assert.equal(P.parsePrefs(null, "140").fontPct, 140);
  assert.equal(P.parsePrefs(null, "500").fontPct, 200);
  assert.equal(P.parsePrefs(null, "junk").fontPct, 100);
  // Stored v1 value wins over the legacy key.
  assert.equal(P.parsePrefs(JSON.stringify({ fontPct: 90 }), "140").fontPct, 90);
  // A broken v1 value falls back to the legacy size rather than 100.
  assert.equal(P.parsePrefs(JSON.stringify({ fontPct: "x" }), "140").fontPct, 140);
});

test("theme resolution and narrow-screen spread", () => {
  assert.equal(P.resolveScheme("system", true), "dark");
  assert.equal(P.resolveScheme("system", false), "light");
  assert.equal(P.resolveScheme("sepia", true), "sepia");
  assert.equal(P.effectiveSpread({ spread: "double" }, true), "single");
  assert.equal(P.effectiveSpread({ spread: "double" }, false), "double");
});

test("PDF spreads: cover alone, then 2–3, 4–5", () => {
  assert.deepEqual(P.spreadPages(1, 10, true), [1]);
  assert.deepEqual(P.spreadPages(2, 10, true), [2, 3]);
  assert.deepEqual(P.spreadPages(3, 10, true), [2, 3]);
  assert.deepEqual(P.spreadPages(10, 10, true), [10]); // last even page has no partner
  assert.deepEqual(P.spreadPages(9, 9, true), [8, 9]);
  assert.deepEqual(P.spreadPages(5, 10, false), [5]);
  assert.deepEqual(P.spreadPages(99, 10, false), [10]);
  assert.deepEqual(P.spreadPages(1, 1, true), [1]);
});

test("PDF spread stepping", () => {
  assert.equal(P.stepSpread(1, 10, true, 1), 2);
  assert.equal(P.stepSpread(2, 10, true, 1), 4);
  assert.equal(P.stepSpread(3, 10, true, 1), 4);
  assert.equal(P.stepSpread(10, 10, true, 1), 10);
  assert.equal(P.stepSpread(8, 9, true, 1), 8);
  assert.equal(P.stepSpread(4, 10, true, -1), 2);
  assert.equal(P.stepSpread(2, 10, true, -1), 1);
  assert.equal(P.stepSpread(1, 10, true, -1), 1);
  assert.equal(P.stepSpread(5, 10, false, 1), 6);
  assert.equal(P.stepSpread(10, 10, false, 1), 10);
  assert.equal(P.stepSpread(1, 10, false, -1), 1);
});

test("content CSS reflects font, size, line height and theme", () => {
  const css = P.contentCss({ ...P.DEFAULT_PREFS, font: "sans", fontPct: 130, lineHeight: 2 }, "sepia");
  assert.match(css, /font-size: 130% !important/);
  assert.match(css, /line-height: 2 !important/);
  assert.match(css, /PingFang SC/);
  assert.match(css, new RegExp(P.THEME_COLORS.sepia.fg));
  const plain = P.contentCss(P.DEFAULT_PREFS, "light");
  assert.doesNotMatch(plain, /font-family/); // "默认" keeps the book's own fonts
  assert.match(P.contentCss(P.DEFAULT_PREFS, "dark"), /color-scheme: dark/);
});
