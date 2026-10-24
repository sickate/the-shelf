#!/usr/bin/env node
// Batch AI book info for The Shelf MVP (POST /api/books/:id/info, see docs/mvp-plan.md).
// Sequential (concurrency 1); resumable via .local/mvp-enrich-state.json.
// Sends no excerpt: the server then works from title/category/format + web search only.
// (Browser-side excerpt extraction is only done from the detail page; an --excerpt flag is out of scope.)
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_BUSY_WAITS_PER_BOOK = 5;
export const MAX_BUSY_WAITS_TOTAL = 30;
const MAX_WAIT_S = 600;
const STATE_FILE = path.resolve('.local/mvp-enrich-state.json');

export function parseArgs(argv) {
  const o = { limit: Infinity, ids: null, dryRun: false, force: false, retryFailed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--retry-failed') o.retryFailed = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error('--limit needs a non-negative integer');
      o.limit = n;
    } else if (a === '--ids') {
      const ids = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length || !ids.every((s) => /^[A-Za-z0-9_]{1,40}$/.test(s))) throw new Error('--ids needs a,b,c book ids');
      o.ids = ids;
    } else if (a === '--excerpt') throw new Error('--excerpt is not supported (extract excerpts from the detail page)');
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** Retry-After (delta seconds or HTTP-date) → seconds, clamped to [1, 600]; default 10. */
export function parseRetryAfter(value, now = Date.now()) {
  const v = String(value ?? '').trim();
  let s = NaN;
  if (/^\d{1,6}$/.test(v)) s = Number(v);
  else if (v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) s = Math.ceil((t - now) / 1000);
  }
  if (!Number.isFinite(s)) s = 10;
  return Math.min(MAX_WAIT_S, Math.max(1, s));
}

/** Wait before retrying a busy gateway: Retry-After plus 1–5 s of jitter. */
export function busyDelayMs(retryAfter, rand = Math.random) {
  return parseRetryAfter(retryAfter) * 1000 + 1000 + Math.floor(rand() * 4000);
}

/** Which books to process, in list order. */
export function selectBooks(books, state, o) {
  const wanted = o.ids ? new Set(o.ids) : null;
  const out = [];
  for (const b of books) {
    const id = String(b.id);
    if (wanted && !wanted.has(id)) continue;
    if (b.status !== 'uploaded') continue;
    if (!o.force) {
      if (b.hasInfo) continue;
      const s = state[id];
      if (s?.result === 'ready') continue; // done in an earlier run (list may lag)
      if (s?.result === 'failed' && !o.retryFailed && !wanted) continue;
    }
    out.push(b);
    if (out.length >= o.limit) break;
  }
  return out;
}

// ---------------- runtime ----------------
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error('usage: mvp-enrich.mjs [--limit N] [--ids a,b] [--dry-run] [--force] [--retry-failed]');
    process.exit(2);
  }
  const BASE = (process.env.SHELF_URL || 'https://the-shelf.iamzhutuo.workers.dev').replace(/\/+$/, '');
  const PASSWORD = process.env.SHELF_OWNER_PASSWORD || '';
  if (!PASSWORD) {
    console.error('SHELF_OWNER_PASSWORD is required (the owner book list is needed even for --dry-run)');
    process.exit(2);
  }

  let state = {};
  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8')).books || {};
  } catch {
    state = {};
  }
  let saving = Promise.resolve();
  const saveState = () => {
    saving = saving
      .then(async () => {
        const dir = path.dirname(STATE_FILE);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700).catch(() => {});
        const tmp = `${STATE_FILE}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ base: BASE, books: state }, null, 1), { mode: 0o600 });
        await rename(tmp, STATE_FILE);
      })
      .catch((e) => console.error('state write failed:', e.message));
    return saving;
  };

  let cookie = '';
  async function login() {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ password: PASSWORD }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const hit = sc.map((s) => /(?:^|[\s,])shelf_session=([^;]*)/.exec(s)).find(Boolean);
    if (!hit) throw new Error('login: no shelf_session cookie in response');
    cookie = `shelf_session=${hit[1]}`;
  }

  const stop = new AbortController();
  process.on('SIGINT', () => {
    if (stop.signal.aborted) process.exit(130);
    console.error('\ninterrupted: finishing state write (the server may still complete the current book)');
    stop.abort();
  });

  /** One HTTP call; relogs in once on 401. Network errors are returned, never retried. */
  async function request(method, urlPath, { body, timeoutMs = 60_000 } = {}) {
    for (let relogged = false; ; relogged = true) {
      let res;
      try {
        res = await fetch(`${BASE}${urlPath}`, {
          method,
          body,
          headers: { Cookie: cookie, Origin: BASE, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (e) {
        if (stop.signal.aborted) return { status: -1, json: { error: 'interrupted' } };
        return { status: 0, json: { error: e?.name === 'TimeoutError' ? 'client_timeout' : `network_${e.cause?.code || 'error'}` } };
      }
      if (res.status === 401 && !relogged) {
        await login();
        continue;
      }
      let json = {};
      try {
        json = JSON.parse(await res.text());
      } catch {
        /* non-JSON */
      }
      return { status: res.status, json, retryAfter: res.headers.get('Retry-After') };
    }
  }

  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      stop.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });

  await login();
  const list = await request('GET', '/api/books');
  if (list.status !== 200 || !Array.isArray(list.json?.books)) {
    console.error(`book list failed: HTTP ${list.status} ${list.json?.error || ''}`.trim());
    process.exit(1);
  }
  if (list.json.books.length && !list.json.books.some((b) => 'hasInfo' in b)) {
    console.error('book list has no owner fields (hasInfo); is the server on the 2026-10-24 version?');
    process.exit(1);
  }
  const todo = selectBooks(list.json.books, state, opts);
  const pending = list.json.books.filter((b) => b.status === 'uploaded' && !b.hasInfo).length;
  console.log(`base=${BASE} books=${list.json.books.length} uploaded_without_info=${pending} selected=${todo.length}${opts.force ? ' (force)' : ''}`);
  if (opts.dryRun) {
    for (const b of todo) console.log(`[dry-run] ${b.id} ${b.title}${state[b.id]?.result ? ` (state: ${state[b.id].result})` : ''}`);
    process.exit(0);
  }

  const counts = { ready: 0, failed: 0, skipped: 0 };
  let busyTotal = 0;
  let fatal = null;
  for (let i = 0; i < todo.length && !fatal && !stop.signal.aborted; i++) {
    const b = todo[i];
    const id = String(b.id);
    const started = Date.now();
    let busyWaits = 0;
    let outcome;
    for (;;) {
      const res = await request('POST', `/api/books/${encodeURIComponent(id)}/info${opts.force ? '?force=1' : ''}`, {
        body: '{}',
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (res.status === 200 && res.json?.status === 'ready') {
        outcome = { result: 'ready', model: res.json.model || null, confidence: res.json.info?.confidence || null, searchUsed: !!res.json.info?.searchUsed };
      } else if (res.status === 503 && res.json?.error === 'ai_busy') {
        if (busyWaits >= MAX_BUSY_WAITS_PER_BOOK || busyTotal >= MAX_BUSY_WAITS_TOTAL) {
          outcome = { result: 'failed', reason: 'ai_busy_gave_up' };
          if (busyTotal >= MAX_BUSY_WAITS_TOTAL) fatal = 'too many ai_busy responses; stopping';
        } else {
          busyWaits++;
          busyTotal++;
          const ms = busyDelayMs(res.retryAfter);
          console.log(`  ${id} ai_busy, waiting ${Math.round(ms / 1000)}s (${busyWaits}/${MAX_BUSY_WAITS_PER_BOOK}, total ${busyTotal}/${MAX_BUSY_WAITS_TOTAL})`);
          await sleep(ms);
          if (stop.signal.aborted) outcome = { result: 'skipped', reason: 'interrupted' };
          else continue;
        }
      } else if (res.status === 503 && res.json?.error === 'ai_not_configured') {
        outcome = { result: 'skipped', reason: 'ai_not_configured' };
        fatal = 'server has no AI configured (ai_not_configured); stopping';
      } else if (res.status === 409) {
        outcome = { result: 'skipped', reason: res.json?.error || 'conflict' };
      } else if (res.status === -1) {
        outcome = { result: 'skipped', reason: 'interrupted' };
      } else if (res.status === 401) {
        outcome = { result: 'skipped', reason: 'login_required' };
        fatal = 'login rejected after relogin; stopping';
      } else {
        const reason = res.json?.reason || res.json?.error || `http_${res.status}`;
        outcome = { result: 'failed', reason: res.status ? reason : res.json.error };
      }
      break;
    }
    counts[outcome.result]++;
    // "skipped" (409 / interrupted / config) is not final: the next run tries again.
    if (outcome.result !== 'skipped') state[id] = { ...outcome, at: new Date().toISOString() };
    await saveState();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const extra =
      outcome.result === 'ready'
        ? `model=${outcome.model || '?'} confidence=${outcome.confidence || '?'} search=${outcome.searchUsed ? 'yes' : 'no'}`
        : outcome.reason;
    console.log(`[${i + 1}/${todo.length}] ${outcome.result} ${id} ${secs}s ${extra} ${b.title}`);
  }
  await saveState();
  console.log('--- summary ---');
  console.log(`ready=${counts.ready} failed=${counts.failed} skipped=${counts.skipped} busy_waits=${busyTotal}`);
  if (fatal) console.error(`STOPPED: ${fatal}`);
  process.exit(fatal || counts.failed ? 1 : stop.signal.aborted ? 130 : 0);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`fatal: ${e.message}`);
    process.exit(1);
  });
}
