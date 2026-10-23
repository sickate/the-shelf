// Tiny original fixtures assembled from public format structures; no private book content.
const enc = new TextEncoder();
function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function header(version, n = 1) {
  const a = new Uint8Array(280),
    v = new DataView(a.buffer);
  v.setUint16(0, 1);
  v.setUint32(4, 4096);
  v.setUint16(8, n);
  v.setUint16(10, 4096);
  a.set(enc.encode("MOBI"), 16);
  v.setUint32(20, 248);
  v.setUint32(24, 2);
  v.setUint32(28, 65001);
  v.setUint32(32, 1);
  v.setUint32(36, version);
  v.setUint32(84, 264);
  v.setUint32(88, 4);
  v.setUint32(108, 0xffffffff);
  v.setUint32(244, 0xffffffff);
  a.set(enc.encode("Test"), 264);
  return a;
}
function pdb(records) {
  const a = new Uint8Array(78 + 8 * records.length + 2),
    v = new DataView(a.buffer);
  a.set(enc.encode("Synthetic"));
  a.set(enc.encode("BOOKMOBI"), 60);
  v.setUint16(76, records.length);
  let at = a.length;
  records.forEach((r, i) => {
    v.setUint32(78 + 8 * i, at);
    at += r.length;
  });
  return join([a, ...records]);
}
export function mobiFixture({ compressed = false, text } = {}) {
  const h = header(6);
  if (compressed) new DataView(h.buffer).setUint16(0, 2);
  const raw = enc.encode(
    text ??
      "<html><body><h1>Synthetic chapter one</h1><p>Original MOBI text.</p><mbp:pagebreak/><h2>Second chapter</h2><p>Safe text.</p></body></html>",
  );
  const records = [];
  for (let i = 0; i < raw.length; i += 4096)
    records.push(raw.subarray(i, i + 4096));
  new DataView(h.buffer).setUint16(8, records.length);
  return pdb([h, ...records]);
}
function vl(n) {
  const a = [n & 127];
  while ((n >>= 7)) a.unshift(n & 127);
  a[a.length - 1] |= 128;
  return a;
}
function indexRecords(tags, name, values) {
  const meta = new Uint8Array(68 + 4 * tags.length),
    v = new DataView(meta.buffer);
  meta.set(enc.encode("INDX"));
  v.setUint32(4, 56);
  v.setUint32(24, 1);
  v.setUint32(28, 65001);
  meta.set(enc.encode("TAGX"), 56);
  v.setUint32(60, 12 + 4 * tags.length);
  v.setUint32(64, 1);
  tags.forEach((t, i) => meta.set(t, 68 + 4 * i));
  const label = enc.encode(name),
    data = Uint8Array.from([label.length, ...label, 7, ...values.flatMap(vl)]),
    rec = new Uint8Array(56 + data.length + 6),
    r = new DataView(rec.buffer);
  rec.set(enc.encode("INDX"));
  r.setUint32(4, 56);
  r.setUint32(20, 56 + data.length);
  r.setUint32(24, 1);
  rec.set(data, 56);
  rec.set(enc.encode("IDXT"), 56 + data.length);
  r.setUint16(60 + data.length, 56);
  return [meta, rec];
}
export function kf8Fixture({
  skelLength,
  skelOffset = 0,
  fragmentOffset = 0,
  insertOffset = 12,
} = {}) {
  const skeleton = "<html><body></body></html>",
    fragment = "<h1>Synthetic KF8</h1><p>Original AZW3 fragment.</p>",
    h = header(8),
    v = new DataView(h.buffer);
  v.setUint32(108, 6);
  v.setUint32(192, 0xffffffff);
  v.setUint32(248, 4);
  v.setUint32(252, 2);
  v.setUint32(260, 0xffffffff);
  const skel = indexRecords(
    [
      [1, 1, 1, 0],
      [6, 2, 2, 0],
    ],
    "0",
    [1, skelOffset, skelLength ?? skeleton.length],
  );
  const frag = indexRecords(
    [
      [2, 1, 1, 0],
      [4, 1, 2, 0],
      [6, 2, 4, 0],
    ],
    String(insertOffset),
    [0, 0, fragmentOffset, fragment.length],
  );
  return pdb([h, enc.encode(skeleton + fragment), ...skel, ...frag]);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFixture(entries, deflate) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const n = enc.encode(name),
      text = enc.encode(value),
      packed = deflate ? deflate(text) : text,
      a = new Uint8Array(30 + n.length + packed.length),
      v = new DataView(a.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(8, deflate ? 8 : 0, true);
    v.setUint32(14, crc32(text), true);
    v.setUint32(18, packed.length, true);
    v.setUint32(22, text.length, true);
    v.setUint16(26, n.length, true);
    a.set(n, 30);
    a.set(packed, 30 + n.length);
    locals.push(a);
    const c = new Uint8Array(46 + n.length),
      cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(16, crc32(text), true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, text.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    c.set(n, 46);
    central.push(c);
    offset += a.length;
  }
  const e = new Uint8Array(22),
    v = new DataView(e.buffer),
    c = join(central);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, c.length, true);
  v.setUint32(16, offset, true);
  return join([...locals, c, e]);
}
export function epubEntries() {
  return [
    ["mimetype", "application/epub+zip"],
    [
      "META-INF/container.xml",
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    ],
    [
      "OPS/book.opf",
      '<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    ],
    [
      "OPS/one.xhtml",
      "<html><head><title>Original EPUB</title></head><body><h1>EPUB first chapter</h1><p>Original synthetic content.</p></body></html>",
    ],
    [
      "OPS/two.xhtml",
      '<html><body><h2>EPUB second chapter</h2><script>parent.postMessage({pwned:true},"*")</script><img src="https://invalid.example/private"><a href="https://invalid.example/leak">External link text</a><svg onload="alert(1)"></svg><form action="https://invalid.example"><input></form><p style="background:url(https://invalid.example)" onclick="alert(1)">Safe paragraph.</p></body></html>',
    ],
  ];
}
export const epubFixture = () => zipFixture(epubEntries());

export function palmDocAmplificationFixture() {
  const h = header(6),
    v = new DataView(h.buffer);
  v.setUint16(0, 2);
  v.setUint16(10, 32);
  return pdb([
    h,
    Uint8Array.from([
      65,
      66,
      ...Array.from({ length: 10 }, () => [128, 23]).flat(),
    ]),
  ]);
}
