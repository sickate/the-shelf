import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), "shelf-cbz-"));
const out = join(tmp, "cbz.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/cbz.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const Z = await import(pathToFileURL(out).href);
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** Builds a ZIP; entries are { name, data, deflate?, utf8? }. */
function zip(entries, { comment = "" } = {}) {
  const locals = [];
  const cens = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, e.utf8 === false ? "latin1" : "utf8");
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const flags = e.utf8 === false ? 0 : 0x800;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(e.deflate ? 8 : 0, 8);
    loc.writeUInt32LE(crc32(e.data), 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(e.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    const extra = Buffer.from([0xaa, 0xbb, 2, 0, 1, 2]); // local extra field differs from central
    loc.writeUInt16LE(extra.length, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cen.writeUInt32LE(crc32(e.data), 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, extra, body);
    cens.push(cen, name);
    offset += loc.length + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(cens);
  const c = Buffer.from(comment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, eocd, c]);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(64, 3)]);

test("natural sort orders numbered pages numerically", () => {
  const names = ["10.jpg", "2.jpg", "1.jpg", "第10话/1.jpg", "第2话/1.jpg", "page 100.png", "page 20.png", "a/b.jpg"];
  assert.deepEqual([...names].sort(Z.naturalCompare), ["1.jpg", "2.jpg", "10.jpg", "a/b.jpg", "page 20.png", "page 100.png", "第2话/1.jpg", "第10话/1.jpg"]);
  assert.ok(Z.naturalCompare("0009.jpg", "0010.jpg") < 0);
});

test("opens stored and deflate entries, filters non-images, natural order", async () => {
  const buf = zip(
    [
      { name: "10.jpg", data: JPEG },
      { name: "2.png", data: PNG, deflate: true },
      { name: "__MACOSX/._2.png", data: Buffer.from("junk") },
      { name: "info.txt", data: Buffer.from("hello"), deflate: true },
      { name: "sub/", data: Buffer.alloc(0) },
      { name: ".DS_Store", data: Buffer.from("x") },
      { name: "1.webp", data: WEBP, deflate: true },
    ],
    { comment: "a zip comment" },
  );
  const a = Z.openCbz(ab(buf));
  assert.deepEqual(a.pages.map((p) => p.name), ["1.webp", "2.png", "10.jpg"]);
  const p0 = await a.page(0);
  assert.equal(p0.type, "image/webp");
  assert.deepEqual(Buffer.from(await p0.arrayBuffer()), WEBP);
  const p1 = await a.page(1);
  assert.equal(p1.type, "image/png");
  assert.deepEqual(Buffer.from(await p1.arrayBuffer()), PNG);
  const p2 = await a.page(2);
  assert.equal(p2.type, "image/jpeg");
  assert.deepEqual(Buffer.from(await p2.arrayBuffer()), JPEG);
  await assert.rejects(a.page(3), Z.CbzError);
});

test("content type comes from magic bytes, not the extension", async () => {
  const a = Z.openCbz(ab(zip([{ name: "001.png", data: WEBP }])));
  assert.equal((await a.page(0)).type, "image/webp");
});

test("non-UTF-8 names fall back to GB18030", () => {
  const gbk = Buffer.from([0xb5, 0xda, 0x31, 0xbb, 0xb0]); // "第1话"
  const raw = zip([{ name: gbk.toString("latin1") + ".jpg", data: JPEG, utf8: false }]);
  assert.deepEqual(Z.listZip(ab(raw)).map((e) => e.name), ["第1话.jpg"]);
});

test("fails cleanly on broken, empty, ZIP64 and unsupported archives", async () => {
  assert.throws(() => Z.openCbz(ab(Buffer.from("not a zip at all, definitely not"))), Z.CbzError);
  assert.throws(() => Z.openCbz(ab(Buffer.alloc(5))), Z.CbzError);
  assert.throws(() => Z.openCbz(ab(zip([{ name: "a.txt", data: Buffer.from("x") }]))), /没有图片/);
  const z64 = Buffer.from(zip([{ name: "1.jpg", data: JPEG }]));
  z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
  assert.throws(() => Z.openCbz(ab(z64)), /ZIP64/);
  const truncated = zip([{ name: "1.jpg", data: JPEG }]).subarray(0, 100);
  assert.throws(() => Z.openCbz(ab(truncated)), Z.CbzError);
  const bzip = Buffer.from(zip([{ name: "1.jpg", data: JPEG }]));
  // method 12 (bzip2) in both headers
  bzip.writeUInt16LE(12, 8);
  bzip.writeUInt16LE(12, bzip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  await assert.rejects(Z.openCbz(ab(bzip)).page(0), /压缩方式/);
});

// ---------------- scripts/pack-cbz.mjs ----------------
const hasSips = (() => {
  try {
    execFileSync("sips", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function fixture() {
  const dir = await mkdtemp(join(tmp, "books-"));
  const manga = join(dir, "09-漫画");
  const ch = (n) => join(manga, "作品 — 作者", `第00${n}话`);
  await mkdir(ch(1), { recursive: true });
  await mkdir(ch(2), { recursive: true });
  await mkdir(join(manga, "单本"), { recursive: true });
  await mkdir(join(manga, "PDF 作品"), { recursive: true });
  for (const n of [1, 2, 10]) await writeFile(join(ch(1), `${n}.jpg`), JPEG);
  await writeFile(join(ch(1), "notes.txt"), "ignore");
  await writeFile(join(ch(2), "0001.jpg"), JPEG);
  await writeFile(join(manga, "单本", "Look back 000.png"), WEBP);
  await writeFile(join(manga, "单本", "Look back 001.png"), PNG);
  await writeFile(join(manga, "PDF 作品", "第1话.pdf"), "%PDF-1.4");
  const old = new Date(Date.now() - 3 * 86400_000);
  for (const d of [ch(1), ch(2), join(manga, "单本")])
    for (const f of await readdir(d)) await utimes(join(d, f), old, old);
  return { dir, manga, ch, old };
}

const pack = (args) => execFileSync(process.execPath, [join(root, "scripts/pack-cbz.mjs"), ...args], { encoding: "utf8" });

test("pack-cbz: dry run writes nothing", async () => {
  const { dir, manga } = await fixture();
  const report = pack(["--root", dir, "--dry-run"]);
  assert.match(report, /3 个图片文件夹/);
  assert.deepEqual((await readdir(manga)).sort(), ["PDF 作品", "作品 — 作者", "单本"].sort());
});

test("pack-cbz: packs each image folder beside itself, idempotent, mtime in the past", async () => {
  const { dir, manga, ch, old } = await fixture();
  pack(["--root", dir]);
  const cbz = join(manga, "作品 — 作者", "第001话.cbz");
  const a = Z.openCbz(ab(await readFile(cbz)));
  assert.deepEqual(a.pages.map((p) => p.name), ["0001.jpg", "0002.jpg", "0003.jpg"]);
  assert.equal(a.pages[0].method, 0);
  const one = Z.openCbz(ab(await readFile(join(manga, "单本.cbz"))));
  assert.deepEqual(one.pages.map((p) => p.name), ["0001.webp", "0002.png"]);
  assert.deepEqual(Buffer.from(await (await one.page(0)).arrayBuffer()), WEBP);
  await stat(join(manga, "作品 — 作者", "第002话.cbz"));
  const st = await stat(cbz);
  assert.ok(Math.abs(st.mtimeMs - (old.getTime() - 3600_000)) < 2000, "mtime = newest source - 1h");
  // Sources untouched.
  assert.deepEqual((await readdir(ch(1))).sort(), ["1.jpg", "10.jpg", "2.jpg", "notes.txt"]);
  const again = pack(["--root", dir]);
  assert.match(again, /已是最新 3/);
  // A newer source image triggers a rebuild of that folder only.
  const newer = new Date(old.getTime() + 60_000);
  await writeFile(join(ch(2), "0002.jpg"), JPEG);
  await utimes(join(ch(2), "0002.jpg"), newer, newer);
  const third = pack(["--root", dir]);
  assert.match(third, /已是最新 2/);
  const b = Z.openCbz(ab(await readFile(join(manga, "作品 — 作者", "第002话.cbz"))));
  assert.equal(b.pages.length, 2);
});

test("pack-cbz: splits into volumes when over the limit (undecodable pages keep their bytes)", async () => {
  const { dir, manga } = await fixture();
  // Tiny limit forces the re-encode path and then a split.
  const report = pack(["--root", dir, "--limit", "700"]);
  assert.match(report, /reencoded\+split/);
  const names = (await readdir(join(manga, "作品 — 作者"))).filter((n) => n.startsWith("第001话") && n.endsWith(".cbz"));
  assert.ok(names.length >= 2, names.join(","));
  assert.ok(names.every((n) => /^第001话（\d／\d）\.cbz$/.test(n)), names.join(","));
  let pages = 0;
  for (const n of names) {
    const buf = await readFile(join(manga, "作品 — 作者", n));
    assert.ok(buf.length <= 700, `${n} ${buf.length}`);
    pages += Z.openCbz(ab(buf)).pages.length;
  }
  assert.equal(pages, 3);
});
