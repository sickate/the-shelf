#!/usr/bin/env node
// Batch CLC classification for The Shelf (POST /api/books/:id/class, see docs/classification-plan-2026-10-24.md).
// Sequential (concurrency 1); resumable via .local/mvp-classify-state.json.
// Covers uploaded and local_only books (classification works from the title). Manual classes are never overwritten.
import { parseArgs, REQUEST_TIMEOUT_MS, runCli, selectWith } from './lib/batch.mjs';

export { parseArgs };

/** Which books to process, in catalog order: no class yet (all with --force). */
export function selectBooks(books, state, o) {
  return selectWith(books, state, o, {
    eligible: (b) => b.status === 'uploaded' || b.status === 'local_only',
    needsWork: (b) => b.clc == null,
  });
}

/** With --force, a manual class must never be re-sent: look it up first and report a synthetic 409. */
export async function classifyCall(b, { request, opts }) {
  const id = encodeURIComponent(b.id);
  if (opts.force) {
    const cur = await request('GET', `/api/books/${id}`);
    if (cur.status === 200 && cur.json?.book?.clcSource === 'manual') return { status: 409, json: { error: 'manual_locked' } };
    if (cur.status !== 200) return cur;
  }
  return request('POST', `/api/books/${id}/class${opts.force ? '?force=1' : ''}`, { body: '{}', timeoutMs: REQUEST_TIMEOUT_MS });
}

export function classifySummary(c, outcomes, busy) {
  const tally = (k) => {
    const m = {};
    for (const o of outcomes) if (o.result === 'ready') m[o[k] || '?'] = (m[o[k] || '?'] || 0) + 1;
    return Object.entries(m).map(([a, n]) => `${a}=${n}`).join(' ') || '-';
  };
  return [
    `ready=${c.ready} failed=${c.failed} skipped=${c.skipped} busy_waits=${busy}`,
    `by_source: ${tally('source')}`,
    `by_confidence: ${tally('confidence')}`,
    `by_type: ${tally('docType')}`,
  ].join('\n');
}

if (import.meta.main) {
  runCli({
    usage: 'usage: mvp-classify.mjs [--limit N] [--ids a,b] [--dry-run] [--force] [--retry-failed]',
    stateFile: '.local/mvp-classify-state.json',
    parseArgs,
    listCheck: (books) =>
      books.length && !books.some((b) => 'clc' in b) ? 'book list has no clc field; is the server on the classification version?' : null,
    select: selectBooks,
    describeList: (books, todo) =>
      `books=${books.length} without_class=${books.filter((b) => (b.status === 'uploaded' || b.status === 'local_only') && b.clc == null).length} selected=${todo.length}`,
    call: classifyCall,
    onOk: (res) =>
      res.json?.clc
        ? {
            clc: res.json.clc,
            docType: res.json.docType ?? null,
            source: res.json.clcSource ?? res.json.source ?? null,
            confidence: res.json.clcConfidence ?? res.json.confidence ?? null,
          }
        : null,
    okExtra: (o) => `clc=${o.clc} type=${o.docType || '?'} source=${o.source || '?'} confidence=${o.confidence ?? '?'}`,
    summary: classifySummary,
  }).catch((e) => {
    console.error(`fatal: ${e.message}`);
    process.exit(1);
  });
}
