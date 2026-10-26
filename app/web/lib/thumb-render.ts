// Fallback covers for books without an embedded cover image (F1):
//  - rasterizeDocument: renders an EPUB / MOBI content page (XHTML) to a canvas through an SVG
//    <foreignObject> image. Images and stylesheets are inlined (data URLs / <style>) because an
//    SVG image may not load anything external; scripts never run in an image context.
//  - typographicCover: a designed title/author cover in the shelf's CSS cover style.
import { Book, categoryName, coverColor, splitTitle } from "./common";

const XHTML = "http://www.w3.org/1999/xhtml";
/** Layout size of the rendered page (CSS px) and the rasterised output size. */
const PAGE_W = 480;
const PAGE_H = 640;
const OUT_W = 360;
const OUT_H = 480;
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_IMAGES = 12;
const MAX_SVG_CHARS = 12_000_000;

export interface PageResources {
  /** Bytes of an image referenced by `src` (already as written in the document), or null. */
  image(src: string): Promise<Blob | null>;
  /** Text of a stylesheet referenced by `href`, or null. */
  css(href: string): Promise<string | null>;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Strips what an SVG image cannot load anyway and maps html/body rules to the page wrapper. */
function cleanCss(css: string): string {
  return css
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/@import[^;]*;/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "")
    .replace(/url\([^)]*\)/gi, "none")
    .replace(/(^|[\s,}>])(html|body)(?=[\s,{.#:[>])/gi, "$1.shelf-page");
}

/** Whether the document has anything visible (text or an image). */
export function hasVisibleContent(doc: Document): boolean {
  const body = doc.body || doc.documentElement;
  if (!body) return false;
  if ((body.textContent || "").replace(/\s+/g, "").length > 0) return true;
  return !!body.querySelector("img, image, svg");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("svg render failed"));
    img.src = src;
  });
}

/** Share of (sampled) pixels that differ clearly from white. Throws on a tainted canvas. */
export function inkRatio(canvas: HTMLCanvasElement): number {
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (765 - data[i] - data[i + 1] - data[i + 2] > 90) ink++;
  }
  return ink / (data.length / 16);
}

/**
 * Renders `doc` as a 360x480 page image, or returns null when it renders blank or the browser
 * refuses (e.g. Safari taints canvases drawn from foreignObject SVG).
 */
export async function rasterizeDocument(doc: Document, res: PageResources): Promise<HTMLCanvasElement | null> {
  const body = doc.body || doc.documentElement;
  if (!body) return null;
  let css = "";
  for (const node of Array.from(doc.querySelectorAll("style, link"))) {
    if (node.localName === "style") css += `${node.textContent || ""}\n`;
    else if (/stylesheet/i.test(node.getAttribute("rel") || "") && node.getAttribute("href")) {
      css += `${(await res.css(node.getAttribute("href")!).catch(() => null)) || ""}\n`;
    }
  }
  const page = document.createElementNS(XHTML, "div");
  page.setAttribute("class", "shelf-page");
  for (const child of Array.from(body.childNodes)) page.append(document.importNode(child, true));
  for (const bad of Array.from(page.querySelectorAll("script, style, link, meta, iframe, object, embed, video, audio, form"))) bad.remove();
  // Only presentational attributes survive; event handlers would be inert anyway.
  for (const node of Array.from(page.querySelectorAll("*"))) {
    for (const a of Array.from(node.attributes)) if (/^on/i.test(a.name)) node.removeAttribute(a.name);
  }
  let images = 0;
  for (const img of Array.from(page.querySelectorAll("img, image"))) {
    const attr = img.localName === "img" ? "src" : img.hasAttribute("href") ? "href" : "xlink:href";
    const src = img.getAttribute(attr) || img.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
    const blob = src && images < MAX_IMAGES ? await res.image(src).catch(() => null) : null;
    if (!blob || blob.size > MAX_IMAGE_BYTES || !/^image\//.test(blob.type)) {
      img.remove();
      continue;
    }
    images++;
    const url = await dataUrl(blob);
    if (img.localName === "img") img.setAttribute("src", url);
    else img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", url);
    img.removeAttribute("srcset");
  }
  const style = document.createElementNS(XHTML, "style");
  style.textContent =
    `.shelf-page{box-sizing:border-box;width:${PAGE_W}px;height:${PAGE_H}px;overflow:hidden;padding:32px 36px;` +
    `background:#fff;color:#1d1d1d;font:16px/1.5 Georgia,"Songti SC","Noto Serif CJK SC",serif;overflow-wrap:anywhere}` +
    `.shelf-page *{max-width:100%}.shelf-page img,.shelf-page svg{height:auto;max-height:${PAGE_H - 64}px}` +
    `.shelf-page a{color:inherit;text-decoration:none}\n${cleanCss(css)}`;
  page.prepend(style);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}">` +
    `<foreignObject x="0" y="0" width="${PAGE_W}" height="${PAGE_H}">${new XMLSerializer().serializeToString(page)}</foreignObject></svg>`;
  if (svg.length > MAX_SVG_CHARS) return null;
  // A data: URL, not a blob: URL: Chrome taints canvases drawn from blob-URL foreignObject SVGs.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, OUT_W, OUT_H);
    return inkRatio(canvas) > 0.002 ? canvas : null; // getImageData throws on a tainted canvas
  } catch {
    return null;
  }
}

/** Splits text into lines no wider than `max`, breaking between words or CJK characters. */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const tokens = text.match(/[A-Za-z0-9À-ɏ'’.,:;!?&()\-]+\s*|\s+|./gsu) || [];
  const lines: string[] = [];
  let line = "";
  for (const tok of tokens) {
    if (ctx.measureText(line + tok).width <= max) {
      line += tok;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = "";
    const t = tok.trimStart();
    if (ctx.measureText(t).width <= max) {
      line = t;
      continue;
    }
    // A single token wider than the line: break it by characters.
    for (const ch of Array.from(t)) {
      if (line && ctx.measureText(line + ch).width > max) {
        lines.push(line);
        line = "";
      }
      line += ch;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

function clampLines(ctx: CanvasRenderingContext2D, lines: string[], n: number, max: number): string[] {
  if (lines.length <= n) return lines;
  const out = lines.slice(0, n);
  let last = out[n - 1];
  while (last && ctx.measureText(`${last}…`).width > max) last = Array.from(last).slice(0, -1).join("");
  out[n - 1] = `${last.trimEnd()}…`;
  return out;
}

/** A typographic cover (title, author, category) in the colours of the shelf's CSS covers. */
export function typographicCover(b: Book, author = ""): HTMLCanvasElement {
  const W = OUT_W;
  const H = Math.round(OUT_W / 0.73);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = coverColor(b.id);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.13)";
  ctx.fillRect(0, 0, 9, H);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(22.5, 22.5, W - 45, H - 45);
  const ink = "#fff9eb";
  const pad = 40;
  const max = W - pad * 2;
  ctx.textBaseline = "top";
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.7;
  ctx.font = '600 11px -apple-system, "Helvetica Neue", "PingFang SC", sans-serif';
  const cat = `${categoryName(b.category)} / THE SHELF`;
  ctx.fillText(clampLines(ctx, wrap(ctx, cat, max), 1, max)[0] || "", pad, pad);
  ctx.globalAlpha = 1;
  const title = splitTitle(b.title).main.replace(/\s+/g, " ").trim() || "—";
  const serif = 'Georgia, "Songti SC", "Noto Serif CJK SC", serif';
  let size = 36;
  let lines: string[] = [];
  for (; size >= 22; size -= 2) {
    ctx.font = `500 ${size}px ${serif}`;
    lines = wrap(ctx, title, max);
    if (lines.length <= 6) break;
  }
  ctx.font = `500 ${size}px ${serif}`;
  lines = clampLines(ctx, lines, 7, max);
  const lh = Math.round(size * 1.4);
  lines.forEach((l, i) => ctx.fillText(l, pad, pad + 42 + i * lh));
  if (author) {
    ctx.globalAlpha = 0.85;
    ctx.font = '14px -apple-system, "Helvetica Neue", "PingFang SC", sans-serif';
    const a = clampLines(ctx, wrap(ctx, author, max), 2, max);
    a.forEach((l, i) => ctx.fillText(l, pad, H - pad - 18 - (a.length - 1 - i) * 20));
    ctx.globalAlpha = 1;
  }
  return canvas;
}
