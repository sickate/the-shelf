#!/usr/bin/env node
// Batch uploader for The Shelf MVP. See docs/mvp-plan.md for the API contract.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const MAX_UPLOAD = 20_000_000;
const MIN_AGE_MS = 10 * 60 * 1000;
const EXTS = new Set('pdf epub mobi azw3 azw txt md doc docx ppt pptx xls xlsx chm djvu cbz'.split(' '));
const MANIFEST = '书目与迁移清单.csv';
const STATE_FILE = path.resolve('.local/mvp-upload-state.json');

function parseArgs(argv) {
  const o = { root: './books', concurrency: 3, dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--concurrency') o.concurrency = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (a === '--limit') o.limit = Math.max(0, parseInt(argv[++i], 10));
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const BASE = (process.env.SHELF_URL || 'https://the-shelf.iamzhutuo.workers.dev').replace(/\/+$/, '');
// Owner auth: SHELF_OWNER_API_TOKEN (Bearer, no /api/login) when set, else password login.
const TOKEN = process.env.SHELF_OWNER_API_TOKEN || '';
const PASSWORD = process.env.SHELF_OWNER_PASSWORD || '';
if (!opts.dryRun && !TOKEN && !PASSWORD) {
  console.error('SHELF_OWNER_API_TOKEN or SHELF_OWNER_PASSWORD is required (unless --dry-run)');
  process.exit(2);
}
const root = path.resolve(opts.root);

// ---------- manifest (CSV, quoted fields supported) ----------
function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function loadManifest() {
  try {
    let t = await readFile(path.join(root, MANIFEST), 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    const rows = parseCsv(t);
    const h = rows[0] || [];
    const pi = h.indexOf('整理后路径'), si = h.indexOf('字节数');
    if (pi < 0 || si < 0) return null;
    const m = new Map();
    for (const r of rows.slice(1)) if (r[pi]) m.set(r[pi].normalize('NFC'), Number(r[si]));
    return m;
  } catch { return null; }
}

// ---------- scan ----------
const skipped = { hidden: 0, recent: 0, symlink: 0, top_level_file: 0, incomplete: 0, skipped_format: 0 };

async function scan(manifest) {
  const files = [];
  async function walk(dir, depth) {
    const ents = await readdir(dir, { withFileTypes: true });
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) { skipped.hidden++; continue; }
      if (e.isSymbolicLink()) { skipped.symlink++; continue; }
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (depth === 0) { skipped.top_level_file++; continue; }
      const st = await lstat(full);
      if (Date.now() - st.mtimeMs < MIN_AGE_MS) { skipped.recent++; continue; }
      const rel = path.relative(root, full).split(path.sep).join('/');
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!EXTS.has(ext)) { skipped.skipped_format++; continue; }
      if (manifest) {
        const exp = manifest.get(rel.normalize('NFC'));
        if (exp !== undefined && exp !== st.size) { skipped.incomplete++; continue; }
      }
      files.push({ rel, full, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  await walk(root, 0);
  return files;
}

// ---------- state ----------
let state = {};
async function loadState() {
  try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { state = {}; }
}
let saving = Promise.resolve();
function saveState() {
  saving = saving.then(async () => {
    const dir = path.dirname(STATE_FILE);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    await rename(tmp, STATE_FILE);
  }).catch((e) => console.error('state write failed:', e.message));
  return saving;
}

// ---------- http ----------
let cookie = '';
let loginPromise = null;
async function login() {
  if (TOKEN) return;
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const hit = sc.map((s) => /(?:^|[\s,])shelf_session=([^;]*)/.exec(s)).find(Boolean);
  if (!hit) throw new Error('login: no shelf_session cookie in response');
  cookie = `shelf_session=${hit[1]}`;
}
function relogin(stale) {
  if (cookie !== stale) return Promise.resolve();
  loginPromise ??= login().finally(() => { loginPromise = null; });
  return loginPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function request(method, urlPath, { headers = {}, body } = {}) {
  let reloggedIn = false;
  for (let attempt = 0; ; attempt++) {
    const used = cookie;
    let res;
    try {
      res = await fetch(`${BASE}${urlPath}`, {
        method, body,
        headers: { ...headers, ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : { Cookie: used }), Origin: BASE },
      });
    } catch (e) {
      if (attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      return { status: 0, json: { error: `network: ${e.cause?.code || e.message}` } };
    }
    if (res.status === 401 && !reloggedIn && !TOKEN) { reloggedIn = true; await relogin(used); continue; }
    const txt = await res.text();
    let json = {};
    try { json = JSON.parse(txt); } catch { /* ignore */ }
    if ((res.status === 502 || res.status >= 500) && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
    return { status: res.status, json };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// ---------- main ----------
const manifest = await loadManifest();
await loadState();
let files = await scan(manifest);
const total = Math.min(files.length, opts.limit);

const counts = { uploaded: 0, duplicate: 0, cataloged: 0, already_done: 0, failed: 0, budget_blocked: 0 };
let uploadedBytes = 0;

if (opts.dryRun) {
  let up = 0, upB = 0, cat = 0, catB = 0, done = 0;
  for (const f of files.slice(0, total)) {
    const s = state[f.rel];
    if (s?.result && s.size === f.size && s.mtimeMs === f.mtimeMs) done++;
    else if (f.size <= MAX_UPLOAD) { up++; upB += f.size; } else { cat++; catB += f.size; }
  }
  console.log(`[dry-run] root=${root} manifest=${manifest ? 'yes' : 'no'}`);
  console.log(`[dry-run] candidates=${files.length} (limit applied: ${total})`);
  console.log(`[dry-run] would upload: ${up} files, ${upB} bytes`);
  console.log(`[dry-run] would catalog (>20MB): ${cat} files, ${catB} bytes`);
  console.log(`[dry-run] already done in state: ${done}`);
  console.log(`[dry-run] skipped: ${JSON.stringify(skipped)}`);
  process.exit(0);
}

await login();
let budgetStop = false;
let idx = 0, finished = 0;
let lastSave = Date.now();

async function processOne(f) {
  const s = state[f.rel];
  if (s?.result && s.size === f.size && s.mtimeMs === f.mtimeMs) return { r: 'already_done', bytes: 0 };
  const big = f.size > MAX_UPLOAD;
  if (!big && budgetStop) return { r: 'budget_blocked', bytes: 0 };
  let res, sha = s?.sha256 && s.size === f.size && s.mtimeMs === f.mtimeMs ? s.sha256 : null;
  if (big) {
    res = await request('POST', '/api/catalog', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.rel, sizeBytes: f.size }),
    });
  } else {
    sha ??= await sha256File(f.full);
    const body = await readFile(f.full);
    res = await request('PUT', '/api/upload', {
      headers: {
        'X-Shelf-Path': encodeURIComponent(f.rel),
        'X-Shelf-Sha256': sha,
        'Content-Type': 'application/octet-stream',
      },
      body,
    });
  }
  let r, bytes = 0;
  if (res.status === 200 || res.status === 201) {
    if (big) r = 'cataloged';
    else if (res.json?.duplicate) r = 'duplicate';
    else { r = 'uploaded'; bytes = f.size; }
  } else if (res.status === 507) {
    budgetStop = true; r = 'budget_blocked';
    return { r, bytes, note: 'budget_exceeded' };
  } else {
    r = 'failed';
    return { r, bytes, note: `HTTP ${res.status} ${res.json?.error || ''}`.trim() };
  }
  state[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, sha256: sha, result: r };
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveState(); }
  return { r, bytes };
}

async function worker() {
  while (idx < total) {
    const f = files[idx++];
    let out;
    try { out = await processOne(f); } catch (e) { out = { r: 'failed', bytes: 0, note: e.message }; }
    counts[out.r]++;
    uploadedBytes += out.bytes;
    finished++;
    console.log(`[${finished}/${total}] ${out.r} ${f.size}B ${f.rel}${out.note ? ` (${out.note})` : ''}`);
  }
}

await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(total, 1)) }, worker));
await saveState();

console.log('--- summary ---');
console.log(`uploaded=${counts.uploaded} duplicate=${counts.duplicate} cataloged=${counts.cataloged} already_done=${counts.already_done} failed=${counts.failed} budget_blocked=${counts.budget_blocked}`);
console.log(`skipped: ${JSON.stringify(skipped)}`);
console.log(`total uploaded bytes: ${uploadedBytes}`);
if (budgetStop) console.log('NOTE: stopped uploading due to 507 budget_exceeded');
process.exit(counts.failed > 0 || budgetStop ? 1 : 0);
