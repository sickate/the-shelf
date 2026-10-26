#!/usr/bin/env node
// Batch AI book info for The Shelf MVP (POST /api/books/:id/info, see docs/mvp-plan.md).
// Sequential (concurrency 1); resumable via .local/mvp-enrich-state.json.
// Sends no excerpt: the server then works from title/category/format + web search only.
// (Browser-side excerpt extraction is only done from the detail page; an --excerpt flag is out of scope.)
// Shared machinery lives in scripts/lib/batch.mjs.
import { parseArgs as parseBaseArgs, REQUEST_TIMEOUT_MS, runCli, selectWith } from './lib/batch.mjs';

export { REQUEST_TIMEOUT_MS, MAX_BUSY_WAITS_PER_BOOK, MAX_BUSY_WAITS_TOTAL, parseRetryAfter, busyDelayMs } from './lib/batch.mjs';

export function parseArgs(argv) {
  return parseBaseArgs(argv, (a) => {
    if (a === '--excerpt') throw new Error('--excerpt is not supported (extract excerpts from the detail page)');
    throw new Error(`unknown argument: ${a}`);
  });
}

/** Which books to process, in list order. */
export function selectBooks(books, state, o) {
  return selectWith(books, state, o, { eligible: (b) => b.status === 'uploaded', needsWork: (b) => !b.hasInfo });
}

if (import.meta.main) {
  runCli({
    usage: 'usage: mvp-enrich.mjs [--limit N] [--ids a,b] [--dry-run] [--force] [--retry-failed]',
    stateFile: '.local/mvp-enrich-state.json',
    parseArgs,
    listCheck: (books) =>
      books.length && !books.some((b) => 'hasInfo' in b)
        ? 'book list has no owner fields (hasInfo); is the server on the 2026-10-24 version?'
        : null,
    select: selectBooks,
    describeList: (books, todo) =>
      `books=${books.length} uploaded_without_info=${books.filter((b) => b.status === 'uploaded' && !b.hasInfo).length} selected=${todo.length}`,
    call: (b, { request, opts }) =>
      request('POST', `/api/books/${encodeURIComponent(b.id)}/info${opts.force ? '?force=1' : ''}`, { body: '{}', timeoutMs: REQUEST_TIMEOUT_MS }),
    onOk: (res) =>
      res.json?.status === 'ready'
        ? { model: res.json.model || null, confidence: res.json.info?.confidence || null, searchUsed: !!res.json.info?.searchUsed }
        : null,
    okExtra: (o) => `model=${o.model || '?'} confidence=${o.confidence || '?'} search=${o.searchUsed ? 'yes' : 'no'}`,
    summary: (c, _o, busy) => `ready=${c.ready} failed=${c.failed} skipped=${c.skipped} busy_waits=${busy}`,
  }).catch((e) => {
    console.error(`fatal: ${e.message}`);
    process.exit(1);
  });
}
