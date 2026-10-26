#!/usr/bin/env node
// Packs comic image folders into CBZ files for upload (docs/manga-reidentify-plan-2026-10-26.md, B).
//
//   node scripts/pack-cbz.mjs [--root books] [--dry-run] [--concurrency 4]
//
// Every folder under <root>/09-漫画 that directly holds images (jpg/jpeg/png/webp/gif) becomes
// <parent>/<folder>.cbz: a ZIP with stored (uncompressed) entries 0001.jpg, 0002.png… in natural
// order of the source names; the extension follows the real image type (some ".png" files are
// WebP). Over the size limit (19,500,000 bytes) the pages are re-encoded into a temp dir with
// macOS sips (JPEG quality 80, longest edge <= 2000 px; a page keeps its original when that is
// smaller); still over the limit, pages are split into volumes <folder>（1／N）.cbz.
//
// Source images are never modified or deleted. Outputs carry a fingerprint of their sources in
// the ZIP comment, so re-runs skip folders that are already packed, and stale outputs of a
// folder (e.g. a different volume count) are replaced. Output mtime is the newest source mtime
// minus one hour so the uploader's 10-minute recency guard does not skip fresh outputs.
// --dry-run still re-encodes into the temp dir to report realistic sizes, but writes nothing
// under the root.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';

const run = promisify(execFile);
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const MANGA_DIR = '09-漫画';
const MAGIC = 'the-shelf pack-cbz v1';

function parseArgs(argv) {
  const o = { root: 'books', dryRun: false, limit: 19_500_000, concurrency: 4, maxEdge: 2000, quality: 80 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--limit') o.limit = Math.max(1, parseInt(argv[++i], 10)); // for tests
    else if (a === '--concurrency') o.concurrency = Math.max(1, parseInt(argv[++i], 10) || 4);
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

function sniffExt(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  return '';
}

async function headExt(file) {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(12);
    await fh.read(b, 0, 12, 0);
    return sniffExt(b);
  } finally {
    await fh.close();
  }
}

/** Limits concurrent async work. */
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// ---------- ZIP (stored entries only) ----------
const entryName = (i, ext) => `${String(i + 1).padStart(4, '0')}.${ext}`;
/** Exact size of a stored ZIP holding `pages` (names are ASCII), with `comment`. */
function zipSize(pages, comment) {
  let n = 22 + Buffer.byteLength(comment);
  pages.forEach((p, i) => {
    const name = entryName(i, p.ext).length;
    n += 30 + name + p.size + 46 + name;
  });
  return n;
}

const DOS_TIME = (12 << 11) | (0 << 5); // 12:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

async function writeZip(file, pages, comment) {
  const fh = await open(file, 'w', 0o644);
  const central = [];
  let offset = 0;
  try {
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const data = await readFile(p.path);
      if (data.length !== p.size) throw new Error(`${p.path} changed while packing`);
      const name = Buffer.from(entryName(i, p.ext), 'utf8');
      const crc = crc32(data);
      const loc = Buffer.alloc(30);
      loc.writeUInt32LE(0x04034b50, 0);
      loc.writeUInt16LE(10, 4); // version needed 1.0 (stored)
      loc.writeUInt16LE(0x800, 6); // UTF-8 names
      loc.writeUInt16LE(0, 8); // stored
      loc.writeUInt16LE(DOS_TIME, 10);
      loc.writeUInt16LE(DOS_DATE, 12);
      loc.writeUInt32LE(crc, 14);
      loc.writeUInt32LE(data.length, 18);
      loc.writeUInt32LE(data.length, 22);
      loc.writeUInt16LE(name.length, 26);
      await fh.write(Buffer.concat([loc, name]));
      await fh.write(data);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
      cen.writeUInt16LE(10, 6);
      cen.writeUInt16LE(0x800, 8);
      cen.writeUInt16LE(0, 10);
      cen.writeUInt16LE(DOS_TIME, 12);
      cen.writeUInt16LE(DOS_DATE, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(data.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      cen.writeUInt32LE(offset, 42);
      central.push(cen, name);
      offset += 30 + name.length + data.length;
    }
    const cd = Buffer.concat(central);
    const c = Buffer.from(comment, 'utf8');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(pages.length, 8);
    eocd.writeUInt16LE(pages.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(c.length, 20);
    await fh.write(Buffer.concat([cd, eocd, c]));
  } finally {
    await fh.close();
  }
  return offset + central.reduce((n, b) => n + b.length, 0) + 22 + Buffer.byteLength(comment);
}

/** ZIP comment of an existing file ("" when unreadable). */
async function zipComment(file) {
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, 22 + 0xffff);
    const b = Buffer.alloc(len);
    await fh.read(b, 0, len, size - len);
    for (let p = len - 22; p >= 0; p--) {
      if (b.readUInt32LE(p) === 0x06054b50) return b.toString('utf8', p + 22, p + 22 + b.readUInt16LE(p + 20));
    }
    return '';
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

// ---------- scan ----------
async function findFolders(dir, out = []) {
  const ents = await readdir(dir, { withFileTypes: true });
  const images = [];
  for (const e of ents) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    if (e.isDirectory()) await findFolders(path.join(dir, e.name), out);
    else if (e.isFile() && IMAGE.test(e.name)) images.push(e.name);
  }
  if (images.length) out.push({ dir, images: images.sort(naturalCompare) });
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Existing outputs of `folder` in its parent: the single file and/or volumes. */
async function existingOutputs(parent, folder) {
  const re = new RegExp(`^${escapeRe(folder)}(?:（(\\d+)／(\\d+)）)?\\.cbz$`);
  return (await readdir(parent)).filter((n) => re.test(n));
}

const volumeName = (folder, k, n) => (n === 1 ? `${folder}.cbz` : `${folder}（${k}／${n}）.cbz`);

/** Contiguous split into `n` volumes balanced by bytes; null if a volume would be empty or too big. */
function split(pages, n, limit, comment) {
  const total = pages.reduce((s, p) => s + p.size, 0);
  const vols = Array.from({ length: n }, () => []);
  let cum = 0;
  for (const p of pages) {
    const k = Math.min(n - 1, Math.floor(((cum + p.size / 2) / total) * n));
    vols[k].push(p);
    cum += p.size;
  }
  if (vols.some((v) => !v.length || zipSize(v, comment) > limit)) return null;
  return vols;
}

// ---------- sips ----------
async function reencode(page, tmp, idx, o) {
  const out = path.join(tmp, `${String(idx).padStart(5, '0')}.jpg`);
  try {
    const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', page.path]);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    if (!w || !h) return page;
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(o.quality)];
    if (Math.max(w, h) > o.maxEdge) args.push('-Z', String(o.maxEdge));
    await run('sips', [...args, page.path, '--out', out]);
    const { size } = await stat(out);
    if (!size || (await headExt(out)) !== 'jpg') return page;
    // Keep whichever is smaller (an already compact JPEG may grow when re-encoded).
    return size < page.size ? { ...page, path: out, size, ext: 'jpg', reencoded: true } : page;
  } catch {
    return page; // sips missing or undecodable image: keep the original bytes
  }
}

// ---------- main ----------
async function packFolder({ dir, images }, o, tmpRoot, limit) {
  const parent = path.dirname(dir);
  const folder = path.basename(dir);
  let pages = [];
  for (const name of images) {
    const full = path.join(dir, name);
    const st = await stat(full);
    const ext = (await headExt(full)) || path.extname(name).slice(1).toLowerCase().replace('jpeg', 'jpg');
    pages.push({ path: full, name, size: st.size, mtimeMs: st.mtimeMs, ext });
  }
  const newest = Math.max(...pages.map((p) => p.mtimeMs));
  const fp = createHash('sha256')
    .update(JSON.stringify([o.limit, o.maxEdge, o.quality, pages.map((p) => [p.name, p.size, Math.round(p.mtimeMs)])]))
    .digest('hex')
    .slice(0, 32);
  const comment = `${MAGIC} ${fp}`;
  const result = { rel: path.relative(o.rootAbs, dir), pages: pages.length, sourceBytes: pages.reduce((s, p) => s + p.size, 0) };

  const existing = await existingOutputs(parent, folder);
  if (existing.length) {
    const m = /（\d+／(\d+)）/.exec(existing[0]);
    const n = m ? Number(m[1]) : 1;
    const want = Array.from({ length: n }, (_, k) => volumeName(folder, k + 1, n));
    const complete = existing.length === n && want.every((w) => existing.includes(w));
    if (complete && (await Promise.all(want.map((w) => zipComment(path.join(parent, w))))).every((c) => c === comment)) {
      return { ...result, status: 'fresh', outputs: await Promise.all(want.map(async (w) => ({ name: w, size: (await stat(path.join(parent, w))).size }))) };
    }
  }

  let mode = 'stored';
  if (zipSize(pages, comment) > limit) {
    mode = 'reencoded';
    const tmp = await mkdtemp(path.join(tmpRoot, 'f-'));
    const lim = limiter(o.concurrency);
    pages = await Promise.all(pages.map((p, i) => lim(() => reencode(p, tmp, i, o))));
  }
  let vols = [pages];
  if (zipSize(pages, comment) > limit) {
    mode += '+split';
    vols = null;
    for (let n = Math.ceil(zipSize(pages, comment) / limit); n <= pages.length && !vols; n++) vols = split(pages, n, limit, comment);
    if (!vols) return { ...result, status: 'failed', error: `单页超过 ${limit} bytes，无法分卷` };
  }
  const outputs = vols.map((v, k) => ({ name: volumeName(folder, k + 1, vols.length), size: zipSize(v, comment), pages: v.length }));
  if (o.dryRun) return { ...result, status: 'would_pack', mode, outputs };

  const mtime = new Date(newest - 3600_000);
  for (let k = 0; k < vols.length; k++) {
    const final = path.join(parent, outputs[k].name);
    const partial = path.join(parent, `.${outputs[k].name}.partial`);
    try {
      const size = await writeZip(partial, vols[k], comment);
      if (size !== outputs[k].size) throw new Error(`size mismatch ${size} != ${outputs[k].size}`);
      await utimes(partial, mtime, mtime);
      await rename(partial, final);
    } catch (e) {
      await rm(partial, { force: true });
      throw e;
    }
  }
  // Remove this folder's previous outputs that the new layout no longer uses (generated files only).
  const keep = new Set(outputs.map((x) => x.name));
  for (const old of existing) if (!keep.has(old)) await rm(path.join(parent, old), { force: true });
  return { ...result, status: 'packed', mode, outputs };
}

const MB = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  o.rootAbs = path.resolve(o.root);
  const base = path.join(o.rootAbs, MANGA_DIR);
  const folders = (await findFolders(base)).sort((a, b) => naturalCompare(a.dir, b.dir));
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'shelf-pack-cbz-'));
  const results = [];
  try {
    for (const f of folders) {
      let r;
      try {
        r = await packFolder(f, o, tmpRoot, o.limit);
      } catch (e) {
        r = { rel: path.relative(o.rootAbs, f.dir), pages: f.images.length, status: 'failed', error: e.message };
      }
      results.push(r);
      const outs = (r.outputs || []).map((x) => `${x.name} ${MB(x.size)}${x.pages && r.outputs.length > 1 ? ` (${x.pages} 页)` : ''}`).join('; ');
      const label = { fresh: '已是最新', packed: '已打包', would_pack: '将打包', failed: '失败' }[r.status];
      console.log(`${label}\t${r.rel}\t${r.pages} 页 ${MB(r.sourceBytes || 0)}${r.mode ? `\t${r.mode}` : ''}\t${outs || r.error || ''}`);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const files = results.flatMap((r) => r.outputs || []);
  const splits = results.filter((r) => (r.outputs || []).length > 1).length;
  console.log(
    `\n${folders.length} 个图片文件夹：已是最新 ${count('fresh')}，${o.dryRun ? `将打包 ${count('would_pack')}` : `已打包 ${count('packed')}`}，失败 ${count('failed')}；` +
      `CBZ ${files.length} 个，合计 ${MB(files.reduce((s, x) => s + x.size, 0))}，分卷 ${splits} 个文件夹${o.dryRun ? '（dry run，未写入）' : ''}`,
  );
  if (count('failed')) process.exitCode = 1;
}

await main();
