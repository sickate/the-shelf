#!/usr/bin/env node
// Re-identify books whose AI info or auto-class is low-confidence from their opening text
// (docs/manga-reidentify-plan-2026-10-26.md §C). Sequential; resumable via .local/mvp-reidentify-state.json.
//
// Targets: uploaded/local_only books with a non-manual class whose class confidence or info confidence
// is "low" (read per book from the owner GET /api/books/:id and /info; the list has no confidence).
// The excerpt is extracted locally from books/<category>/<title>.<ext>, resolved through the upload
// state file (.local/mvp-upload-state.json, the real on-disk names) and checked against the size.
// Per book: info?force=1 {excerpt} → class?force=1 {excerpt, query:"<title> <author>"} → when info is
// still low and the identified title differs from the filename, info?force=1 {excerpt, query}.
// --dry-run reads the list and extracts excerpts locally only (no AI call).
import { execFile } from 'node:child_process';
import { readFile, stat, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs as parseBaseArgs, REQUEST_TIMEOUT_MS, runCli, selectWith } from './lib/batch.mjs';

export const EXCERPT_CHARS = 12000;
export const MIN_TEXT_CHARS = 40;
const PDF_PAGES = 8;
const EPUB_SECTIONS = 12;
const TEXT_BYTES = 65536;
const EXTRACT_TIMEOUT_MS = 120_000;
const DETAIL_CONCURRENCY = 6;
const MAX_QUERY_CHARS = 128;
const TEXTUTIL = new Set(['doc', 'docx', 'rtf', 'html', 'htm']);
const SUPPORTED = new Set(['pdf', 'epub', 'txt', 'md', ...TEXTUTIL]);

export function parseArgs(argv) {
  const extra = { root: 'books', uploadState: '.local/mvp-upload-state.json' };
  const flags = { '--root': 'root', '--upload-state': 'uploadState' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key) rest.push(argv[i]);
    else if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a path`);
    else extra[key] = argv[++i];
  }
  return { ...parseBaseArgs(rest), ...extra };
}

/** Collapses runs of spaces, keeps paragraph breaks (mirror of app/web/lib/excerpt.ts). */
export function normalizeText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g, '')
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const clip = (s, n = EXCERPT_CHARS) => Array.from(s).slice(0, n).join('');

/** UTF-8 first; GB18030 when UTF-8 yields many replacement characters (mirror of excerpt.ts). */
export function decodeText(bytes) {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const bad = (utf8.match(/�/g) || []).length;
  if (bad <= 2 || bad / Math.max(1, utf8.length) < 0.01) return utf8;
  try {
    const gb = new TextDecoder('gb18030').decode(bytes);
    return (gb.match(/�/g) || []).length < bad ? gb : utf8;
  } catch {
    return utf8;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** XHTML → plain text: drops head/style/script, breaks on block tags, decodes basic entities. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|section|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Joins non-empty normalized parts until the excerpt length is reached; clips the result. */
export function joinParts(parts) {
  const out = [];
  let len = 0;
  for (const p of parts) {
    if (len >= EXCERPT_CHARS) break;
    const t = normalizeText(p);
    if (!t) continue;
    out.push(t);
    len += t.length + 2;
  }
  return clip(normalizeText(out.join('\n\n')));
}

/** "format" (e.g. PDF) of a list item → lowercase extension. */
const extOf = (b) => String(b.format || '').toLowerCase();

/** Expected relative path of a catalog item: the server derives title/category from it. */
export const expectedPath = (b) => `${b.category}/${b.title}.${extOf(b)}`;
/** Comparison key: NFC, lowercase extension. */
export function pathKey(rel) {
  const s = String(rel).normalize('NFC');
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(0, dot) + s.slice(dot).toLowerCase() : s;
}

/** Map pathKey → on-disk relative path, from the upload state (keys are readdir names). */
export function buildIndex(uploadState) {
  const index = new Map();
  for (const rel of Object.keys(uploadState || {})) index.set(pathKey(rel), rel);
  return index;
}

/** Local file of a book: {rel} or {error}. Size must match the catalog. */
export async function locateSource(b, { root, index }) {
  const want = pathKey(expectedPath(b));
  const tries = [index.get(want), expectedPath(b), expectedPath(b).normalize('NFD')].filter(Boolean);
  for (const rel of [...new Set(tries)]) {
    try {
      const st = await stat(path.join(root, rel));
      if (!st.isFile()) continue;
      if (Number.isFinite(b.sizeBytes) && st.size !== b.sizeBytes) return { error: 'source_size_mismatch', rel };
      return { rel, full: path.join(root, rel) };
    } catch {
      /* next */
    }
  }
  return { error: 'source_missing' };
}

let pdfjsPromise = null;
const require = createRequire(import.meta.url);
function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfText(file) {
  const pdfjs = await loadPdfjs();
  const dir = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/';
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(file)),
    cMapUrl: `${dir}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${dir}standard_fonts/`,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const parts = [];
    for (let n = 1; n <= Math.min(pdf.numPages, PDF_PAGES); n++) {
      try {
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        let text = '';
        for (const item of tc.items) if (typeof item?.str === 'string') text += item.str + (item.hasEOL ? '\n' : '');
        page.cleanup();
        parts.push(text);
      } catch {
        /* skip unreadable page */
      }
    }
    return joinParts(parts);
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function epubText(file) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await readFile(file));
  const read = (name) => zip.file(name)?.async('string');
  const container = await read('META-INF/container.xml');
  const opfPath = /full-path\s*=\s*"([^"]+)"/.exec(container || '')?.[1];
  const opf = opfPath && (await read(opfPath));
  if (!opf) return '';
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
  const manifest = new Map();
  for (const [tag] of opf.matchAll(/<(?:\w+:)?item\b[^>]*>/g)) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id && href) manifest.set(id, href);
  }
  const parts = [];
  let len = 0;
  for (const [tag] of opf.matchAll(/<(?:\w+:)?itemref\b[^>]*>/g)) {
    if (parts.length >= EPUB_SECTIONS || len >= EXCERPT_CHARS) break;
    const href = manifest.get(attr(tag, 'idref'));
    if (!href) continue;
    let name = path.posix.normalize(base + decodeURIComponent(href.split('#')[0]));
    const html = await read(name).catch(() => null);
    if (!html) continue;
    const text = normalizeText(htmlToText(html));
    if (!text) continue;
    parts.push(text);
    len += text.length + 2;
  }
  return joinParts(parts);
}

function textutilText(file) {
  return new Promise((resolve) => {
    execFile('textutil', ['-convert', 'txt', '-stdout', file], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : joinParts([String(stdout).slice(0, EXCERPT_CHARS * 4)])),
    );
  });
}

async function plainText(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(TEXT_BYTES);
    const { bytesRead } = await fh.read(buf, 0, TEXT_BYTES, 0);
    return joinParts([decodeText(buf.subarray(0, bytesRead))]);
  } finally {
    await fh.close();
  }
}

/** Opening text of a local file: {text} or {error} (unsupported_format / no_text / extract_failed). */
export async function extractFile(file, ext) {
  if (!SUPPORTED.has(ext)) return { error: 'unsupported_format' };
  let timer;
  try {
    const work =
      ext === 'pdf' ? pdfText(file) : ext === 'epub' ? epubText(file) : TEXTUTIL.has(ext) ? textutilText(file) : plainText(file);
    const text = await Promise.race([
      work,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('extract_timeout')), EXTRACT_TIMEOUT_MS))),
    ]);
    return meaningfulChars(text) >= MIN_TEXT_CHARS ? { text } : { error: 'no_text' };
  } catch (e) {
    return { error: e?.message === 'extract_timeout' ? 'extract_timeout' : 'extract_failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** Letters/digits/CJK only: page numbers and punctuation from scans do not count as text. */
export const meaningfulChars = (s) => (String(s).match(/[\p{L}\p{N}]/gu) || []).length;

/** Loose title form for comparison: NFKC, lowercase, no brackets/punctuation/spaces/noise words. */
export function looseTitle(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(文字版|扫描版|高清版?|中文版|英文版|影印版|完整版|全本|带书签|图文版|第[0-9一二三四五六七八九十]+版|pdf|epub|mobi)/g, '')
    .replace(/[\s\p{P}\p{S}_]+/gu, '');
}

/** True when the identified title is neither contained in nor contains the filename title. */
export function titleDiffers(identified, filename) {
  const a = looseTitle(identified);
  const b = looseTitle(filename);
  if (!a || !b) return false;
  return !(a.includes(b) || b.includes(a));
}

/** Search query "<title> <first author>", control chars removed, ≤ 128 chars; "" if no title. */
export function buildQuery(info) {
  const clean = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const title = clean(info?.title);
  if (!title || title === '不详') return '';
  const author = clean(Array.isArray(info?.authors) ? info.authors[0]?.name : '');
  const q = author && author !== '不详' && !title.includes(author) ? `${title} ${author}` : title;
  return clip(q, MAX_QUERY_CHARS).trim();
}

/** Per-book state before re-identification, from the owner detail views. */
export function detailOf(bookJson, infoJson) {
  const k = bookJson?.book || {};
  const info = infoJson?.status === 'ready' ? infoJson.info : null;
  return {
    clc: k.clc ?? null,
    clcSource: k.clcSource ?? null,
    clcConfidence: k.clcConfidence ?? null,
    docType: k.docType ?? null,
    infoConfidence: info?.confidence ?? null,
    infoTitle: info?.title ?? null,
  };
}

/** Target rule: not manual, and the class or the info is low-confidence. */
export const isTarget = (d) => d.clcSource !== 'manual' && (d.clcConfidence === 'low' || d.infoConfidence === 'low');

/** Cheap list-level pre-filter (ids, status, state resume) before the per-book detail reads. */
export function preselect(books, state, o) {
  return selectWith(books, state, { ...o, limit: Infinity }, {
    eligible: (b) => (b.status === 'uploaded' || b.status === 'local_only') && (b.clc != null || b.hasInfo),
    needsWork: () => true,
  });
}

async function readDetail(request, b) {
  const id = encodeURIComponent(b.id);
  const [book, info] = await Promise.all([request('GET', `/api/books/${id}`), request('GET', `/api/books/${id}/info`)]);
  if (book.status !== 200 || info.status !== 200) return null;
  return detailOf(book.json, info.json);
}

/** Async selection: detail reads (bounded concurrency) until --limit targets are found. */
export async function selectBooks(books, state, o, { request, read = readDetail } = {}) {
  const pre = preselect(books, state, o);
  const out = [];
  for (let i = 0; i < pre.length && out.length < o.limit; i += DETAIL_CONCURRENCY) {
    const chunk = pre.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(chunk.map((b) => read(request, b)));
    chunk.forEach((b, j) => {
      if (details[j] && isTarget(details[j]) && out.length < o.limit) out.push({ ...b, before: details[j] });
    });
  }
  return out;
}

let sources = null;
async function sourceContext(opts) {
  if (!sources) {
    let upload = {};
    try {
      upload = JSON.parse(await readFile(path.resolve(opts.uploadState), 'utf8'));
    } catch {
      console.error(`note: upload state ${opts.uploadState} unreadable; matching by catalog path only`);
    }
    sources = { root: path.resolve(opts.root), index: buildIndex(upload) };
  }
  return sources;
}

/** Excerpt of a book: {text, rel} or {error}. */
export async function excerptFor(b, ctx) {
  if (!SUPPORTED.has(extOf(b))) return { error: 'unsupported_format' };
  const src = await locateSource(b, ctx);
  if (src.error) return src;
  const r = await extractFile(src.full, extOf(b));
  return { ...r, rel: src.rel };
}

// Per-run progress so a busy retry resumes at the failed step instead of repeating AI calls.
const progress = new Map();

export async function reidentifyCall(b, { request, opts }) {
  const id = encodeURIComponent(b.id);
  const p = progress.get(b.id) ?? {};
  progress.set(b.id, p);
  if (!p.excerpt) {
    const ex = await excerptFor(b, await sourceContext(opts));
    if (ex.error) return { status: 409, json: { error: ex.error } };
    p.excerpt = ex.text;
  }
  const post = (kind, body) =>
    request('POST', `/api/books/${id}/${kind}?force=1`, { body: JSON.stringify(body), timeoutMs: REQUEST_TIMEOUT_MS });
  if (!p.info) {
    const res = await post('info', { excerpt: p.excerpt });
    if (res.status !== 200 || res.json?.status !== 'ready') return res;
    p.info = res.json.info;
    p.query = buildQuery(p.info);
  }
  if (!p.klass) {
    // force=1 overrides a manual class on the server: re-check right before.
    const cur = await request('GET', `/api/books/${id}`);
    if (cur.status !== 200) return cur;
    if (cur.json?.book?.clcSource === 'manual') p.klass = { skipped: 'manual_locked' };
    else {
      const res = await post('class', p.query ? { excerpt: p.excerpt, query: p.query } : { excerpt: p.excerpt });
      if (res.status !== 200 || !res.json?.clc) return res;
      p.klass = res.json;
    }
  }
  if (!p.info2 && p.query && p.info.confidence === 'low' && titleDiffers(p.info.title, b.title)) {
    const res = await post('info', { excerpt: p.excerpt, query: p.query });
    if (res.status === 503 && res.json?.error === 'ai_busy') return res;
    if (res.status === -1) return res;
    // A failed rerun keeps the first result (the server keeps the previous info on forced failures).
    p.info2 = res.status === 200 && res.json?.status === 'ready' ? res.json.info : { error: res.json?.reason || res.json?.error || `http_${res.status}` };
  }
  progress.delete(b.id);
  const info = p.info2 && !p.info2.error ? p.info2 : p.info;
  return {
    status: 200,
    json: {
      ok: true,
      title: info.title,
      author: info.authors?.[0]?.name ?? null,
      infoConfidence: info.confidence,
      rerun: p.info2 ? (p.info2.error ? `failed:${p.info2.error}` : 'yes') : 'no',
      clc: p.klass.clc ?? null,
      docType: p.klass.docType ?? null,
      clcConfidence: p.klass.clcConfidence ?? null,
      clcSkipped: p.klass.skipped ?? null,
    },
  };
}

export function okFields(res, b) {
  if (!res.json?.ok) return null;
  const before = b.before || {};
  const { ok, ...after } = res.json;
  return { before: { clc: before.clc, docType: before.docType, clcConfidence: before.clcConfidence, infoConfidence: before.infoConfidence }, ...after };
}

const arrow = (a, b) => `${a ?? '-'}→${b ?? '-'}`;
export function okLine(o) {
  const b = o.before || {};
  return [
    `→ 《${o.title}》${o.author ? ` ${o.author}` : ''}`,
    o.clcSkipped ? `class=${o.clcSkipped}` : `clc ${arrow(b.clc, o.clc)} type ${arrow(b.docType, o.docType)} conf ${arrow(b.clcConfidence, o.clcConfidence)}`,
    `info ${arrow(b.infoConfidence, o.infoConfidence)} rerun=${o.rerun} |`,
  ].join(' | ');
}

export function reidentifySummary(c, outcomes, busy) {
  const tally = (pick) => {
    const m = {};
    for (const o of outcomes) {
      const k = pick(o);
      if (k != null) m[k] = (m[k] || 0) + 1;
    }
    return Object.entries(m).map(([a, n]) => `${a}=${n}`).join(' ') || '-';
  };
  const ready = (f) => (o) => (o.result === 'ready' ? f(o) : null);
  return [
    `ready=${c.ready} failed=${c.failed} skipped=${c.skipped} busy_waits=${busy}`,
    `skipped_by_reason: ${tally((o) => (o.result === 'skipped' ? o.reason : null))}`,
    `failed_by_reason: ${tally((o) => (o.result === 'failed' ? o.reason : null))}`,
    `class_confidence: ${tally(ready((o) => arrow(o.before?.clcConfidence, o.clcConfidence)))}`,
    `info_confidence: ${tally(ready((o) => arrow(o.before?.infoConfidence, o.infoConfidence)))}`,
    `clc_changed: ${tally(ready((o) => (o.clcSkipped ? 'manual' : o.clc !== o.before?.clc ? 'yes' : 'no')))}`,
    `type: ${tally(ready((o) => arrow(o.before?.docType, o.docType)))}`,
  ].join('\n');
}

/** --dry-run: excerpts are extracted locally only; prints per-book results and counts. */
export async function dryRun(todo, { opts }) {
  const ctx = await sourceContext(opts);
  const reasons = {};
  let ok = 0;
  for (const b of todo) {
    const r = await excerptFor(b, ctx);
    const d = b.before || {};
    const tag = `clc=${d.clc ?? '-'}/${d.clcConfidence ?? '-'} info=${d.infoConfidence ?? '-'}`;
    if (r.error) {
      reasons[r.error] = (reasons[r.error] || 0) + 1;
      console.log(`[dry-run] skip ${b.id} ${r.error} ${tag} ${b.title}.${extOf(b)}`);
    } else {
      ok++;
      console.log(`[dry-run] ok ${b.id} chars=${[...r.text].length} ${tag} ${b.title}.${extOf(b)}`);
    }
  }
  console.log('--- dry-run summary ---');
  console.log(`targets=${todo.length} extractable=${ok} skipped=${todo.length - ok}`);
  console.log(`skipped_by_reason: ${Object.entries(reasons).map(([k, n]) => `${k}=${n}`).join(' ') || '-'}`);
}

if (import.meta.main) {
  runCli({
    usage:
      'usage: mvp-reidentify.mjs [--limit N] [--ids a,b] [--dry-run] [--force] [--retry-failed] [--root books] [--upload-state .local/mvp-upload-state.json]',
    stateFile: '.local/mvp-reidentify-state.json',
    parseArgs,
    listCheck: (books) =>
      books.length && !books.some((b) => 'hasInfo' in b && 'clc' in b) ? 'book list has no owner fields (hasInfo/clc)' : null,
    select: selectBooks,
    describeList: (books, todo) => `books=${books.length} low_confidence_targets=${todo.length}`,
    dryRun,
    call: reidentifyCall,
    onOk: okFields,
    okExtra: okLine,
    summary: reidentifySummary,
  }).catch((e) => {
    console.error(`fatal: ${e.message}`);
    process.exit(1);
  });
}
