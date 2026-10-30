// Persistent cache of owner-read book files (EPUB/MOBI/TXT/CBZ) in the Cache Storage API, so
// reopening the reader does not download the file again. Every operation is best effort: any
// failure (private mode, no `caches`, quota) silently falls back to the network.

export const CACHE_NAME = "shelf-books-v1";
export const MAX_BYTES = 500 * 1024 * 1024;
export const MAX_BOOKS = 30;
const INDEX_KEY = "/__shelf-book-index";

export interface CacheEntry {
  key: string;
  id: string;
  size: number;
  used: number;
}

interface BookLike {
  id: string | number;
  sizeBytes: number;
  createdAt?: string;
}

/** Synthetic same-origin URL; a replaced file (other size / createdAt) gets another key. */
export function bookKey(book: BookLike): string {
  return `/__shelf-book/${encodeURIComponent(String(book.id))}/${book.sizeBytes || 0}/${encodeURIComponent(book.createdAt || "")}`;
}

/** Keys to delete so that `entries` fits the limits; least recently used go first. */
export function planEviction(entries: CacheEntry[], maxBytes = MAX_BYTES, maxBooks = MAX_BOOKS): string[] {
  const sorted = [...entries].sort((a, b) => a.used - b.used);
  let bytes = sorted.reduce((s, e) => s + e.size, 0);
  let count = sorted.length;
  const out: string[] = [];
  for (const e of sorted) {
    if (bytes <= maxBytes && count <= maxBooks) break;
    out.push(e.key);
    bytes -= e.size;
    count--;
  }
  return out;
}

let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    void navigator.storage?.persist?.()?.catch(() => {});
  } catch {
    /* ignore */
  }
}

async function open(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function readIndex(c: Cache): Promise<CacheEntry[]> {
  try {
    const r = await c.match(INDEX_KEY);
    const v = r ? await r.json() : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function writeIndex(c: Cache, entries: CacheEntry[]) {
  await c.put(INDEX_KEY, new Response(JSON.stringify(entries), { headers: { "Content-Type": "application/json" } }));
}

export async function getCachedBook(book: BookLike): Promise<ArrayBuffer | null> {
  const c = await open();
  if (!c) return null;
  const key = bookKey(book);
  try {
    const r = await c.match(key);
    if (!r) return null;
    const buf = await r.arrayBuffer();
    if (book.sizeBytes > 0 && buf.byteLength !== book.sizeBytes) {
      await c.delete(key);
      await writeIndex(c, (await readIndex(c)).filter((e) => e.key !== key));
      return null;
    }
    const idx = await readIndex(c);
    const hit = idx.find((e) => e.key === key);
    if (hit) hit.used = Date.now();
    else idx.push({ key, id: String(book.id), size: buf.byteLength, used: Date.now() });
    await writeIndex(c, idx);
    return buf;
  } catch {
    return null;
  }
}

export async function putCachedBook(book: BookLike, buf: ArrayBuffer): Promise<void> {
  if (book.sizeBytes > 0 && buf.byteLength !== book.sizeBytes) return;
  if (buf.byteLength > MAX_BYTES) return;
  const c = await open();
  if (!c) return;
  askPersist();
  const key = bookKey(book);
  try {
    let idx = await readIndex(c);
    // Drop other cached versions of this book.
    for (const e of idx.filter((e) => e.id === String(book.id) && e.key !== key)) await c.delete(e.key);
    idx = idx.filter((e) => e.id !== String(book.id) || e.key === key);
    await c.put(key, new Response(buf, { headers: { "Content-Type": "application/octet-stream" } }));
    idx = idx.filter((e) => e.key !== key);
    idx.push({ key, id: String(book.id), size: buf.byteLength, used: Date.now() });
    const drop = new Set(planEviction(idx).filter((k) => k !== key));
    for (const k of drop) await c.delete(k);
    await writeIndex(c, idx.filter((e) => !drop.has(e.key)));
  } catch {
    try {
      await c.delete(key);
    } catch {
      /* ignore */
    }
  }
}

/** Privacy: forget every cached book (called on logout). */
export async function clearBookCache(): Promise<void> {
  try {
    if (typeof caches !== "undefined") await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
}
