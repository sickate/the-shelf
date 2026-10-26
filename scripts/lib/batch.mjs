// Shared machinery for the owner batch scripts (mvp-enrich, mvp-classify):
// arg parsing, login/relogin, HTTP with timeout, Retry-After + jitter, state file, sequential run loop.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_BUSY_WAITS_PER_BOOK = 5;
export const MAX_BUSY_WAITS_TOTAL = 30;
const MAX_WAIT_S = 600;

export function parseArgs(argv, onUnknown = (a) => { throw new Error(`unknown argument: ${a}`); }) {
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
    } else onUnknown(a);
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

/** Shared selection loop: ids filter, status filter, state resume, limit. */
export function selectWith(books, state, o, { eligible, needsWork }) {
  const wanted = o.ids ? new Set(o.ids) : null;
  const out = [];
  for (const b of books) {
    const id = String(b.id);
    if (wanted && !wanted.has(id)) continue;
    if (!eligible(b)) continue;
    if (!o.force) {
      if (!needsWork(b)) continue;
      const s = state[id];
      if (s?.result === 'ready') continue; // done in an earlier run (list may lag)
      if (s?.result === 'failed' && !o.retryFailed && !wanted) continue;
    }
    out.push(b);
    if (out.length >= o.limit) break;
  }
  return out;
}

export function createStateStore(file, base) {
  const stateFile = path.resolve(file);
  let books = {};
  let saving = Promise.resolve();
  return {
    async load() {
      try {
        books = JSON.parse(await readFile(stateFile, 'utf8')).books || {};
      } catch {
        books = {};
      }
      return books;
    },
    save() {
      saving = saving
        .then(async () => {
          const dir = path.dirname(stateFile);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await chmod(dir, 0o700).catch(() => {});
          const tmp = `${stateFile}.${process.pid}.tmp`;
          await writeFile(tmp, JSON.stringify({ base, books }, null, 1), { mode: 0o600 });
          await rename(tmp, stateFile);
        })
        .catch((e) => console.error('state write failed:', e.message));
      return saving;
    },
  };
}

export function createClient({ base, password, stop }) {
  let cookie = '';
  async function login() {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const hit = sc.map((s) => /(?:^|[\s,])shelf_session=([^;]*)/.exec(s)).find(Boolean);
    if (!hit) throw new Error('login: no shelf_session cookie in response');
    cookie = `shelf_session=${hit[1]}`;
  }

  /** One HTTP call; relogs in once on 401. Network errors are returned, never retried. */
  async function request(method, urlPath, { body, timeoutMs = 60_000 } = {}) {
    for (let relogged = false; ; relogged = true) {
      let res;
      try {
        res = await fetch(`${base}${urlPath}`, {
          method,
          body,
          headers: { Cookie: cookie, Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
  return { login, request };
}

/**
 * Full CLI run.
 * cfg: { usage, stateFile, parseArgs(argv), listCheck(books) → error|null,
 *        select(books, state, opts), describeList(books, selected, opts) → string,
 *        call(book, {request, opts}) → res, onOk(res, book) → fields|null,
 *        okExtra(outcome) → string, summary(counts, outcomes, busyTotal) → string }
 */
export async function runCli(cfg) {
  let opts;
  try {
    opts = cfg.parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(cfg.usage);
    process.exit(2);
  }
  const BASE = (process.env.SHELF_URL || 'https://the-shelf.iamzhutuo.workers.dev').replace(/\/+$/, '');
  const PASSWORD = process.env.SHELF_OWNER_PASSWORD || '';
  if (!PASSWORD) {
    console.error('SHELF_OWNER_PASSWORD is required (the owner book list is needed even for --dry-run)');
    process.exit(2);
  }
  const store = createStateStore(cfg.stateFile, BASE);
  const state = await store.load();
  const stop = new AbortController();
  process.on('SIGINT', () => {
    if (stop.signal.aborted) process.exit(130);
    console.error('\ninterrupted: finishing state write (the server may still complete the current book)');
    stop.abort();
  });
  const client = createClient({ base: BASE, password: PASSWORD, stop });
  const { request } = client;
  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      stop.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });

  await client.login();
  const list = await request('GET', '/api/books');
  if (list.status !== 200 || !Array.isArray(list.json?.books)) {
    console.error(`book list failed: HTTP ${list.status} ${list.json?.error || ''}`.trim());
    process.exit(1);
  }
  const bad = cfg.listCheck(list.json.books);
  if (bad) {
    console.error(bad);
    process.exit(1);
  }
  const todo = cfg.select(list.json.books, state, opts);
  console.log(`base=${BASE} ${cfg.describeList(list.json.books, todo, opts)}${opts.force ? ' (force)' : ''}`);
  if (opts.dryRun) {
    for (const b of todo) console.log(`[dry-run] ${b.id} ${b.title}${state[b.id]?.result ? ` (state: ${state[b.id].result})` : ''}`);
    process.exit(0);
  }

  const counts = { ready: 0, failed: 0, skipped: 0 };
  const outcomes = [];
  let busyTotal = 0;
  let fatal = null;
  for (let i = 0; i < todo.length && !fatal && !stop.signal.aborted; i++) {
    const b = todo[i];
    const id = String(b.id);
    const started = Date.now();
    let busyWaits = 0;
    let outcome;
    for (;;) {
      const res = await cfg.call(b, { request, opts });
      const ok = res.status === 200 ? cfg.onOk(res, b) : null;
      if (ok) {
        outcome = { result: 'ready', ...ok };
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
    outcomes.push(outcome);
    // "skipped" (409 / interrupted / config) is not final: the next run tries again.
    if (outcome.result !== 'skipped') state[id] = { ...outcome, at: new Date().toISOString() };
    await store.save();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const extra = outcome.result === 'ready' ? cfg.okExtra(outcome) : outcome.reason;
    console.log(`[${i + 1}/${todo.length}] ${outcome.result} ${id} ${secs}s ${extra} ${b.title}`);
  }
  await store.save();
  console.log('--- summary ---');
  console.log(cfg.summary(counts, outcomes, busyTotal));
  if (fatal) console.error(`STOPPED: ${fatal}`);
  process.exit(fatal || counts.failed ? 1 : stop.signal.aborted ? 130 : 0);
}
