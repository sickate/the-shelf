// Private binary parsing happens only in a terminable Worker. No network IO.
export const LIMITS = Object.freeze({
  file: 20_000_000,
  entries: 2048,
  entry: 2_000_000,
  expanded: 32_000_000,
  chapters: 1024,
  text: 16_000_000,
});
const fail = (message) => {
  throw new Error(message);
};
export function checkBytes(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > LIMITS.file
  )
    fail("文件为空或超过在线阅读的 20 MB 限制。");
}
export function inspectMobi(bytes) {
  checkBytes(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (p, n) => new TextDecoder().decode(bytes.subarray(p, p + n));
  if (bytes.length < 86 || str(60, 8) !== "BOOKMOBI")
    fail("不是支持的 MOBI/KF8 文件；AZW 扩展名也必须包含此格式。");
  const count = v.getUint16(76);
  if (count < 2 || count > LIMITS.entries || 78 + count * 8 > bytes.length)
    fail("MOBI 记录表无效或超出限制。");
  const offsets = Array.from({ length: count }, (_, i) =>
    v.getUint32(78 + i * 8),
  );
  for (let i = 0; i < count; i++)
    if (
      offsets[i] < 78 + count * 8 ||
      offsets[i] >= (offsets[i + 1] ?? bytes.length)
    )
      fail("MOBI 记录位置无效。");
  // Inspect every embedded MOBI header, including the KF8 half of combo books.
  let headers = 0;
  for (let i = 0; i < count; i++) {
    const start = offsets[i],
      end = offsets[i + 1] ?? bytes.length,
      size = end - start;
    if (size > LIMITS.entry) fail("MOBI 单条记录超出限制。");
    if (str(start + 16, 4) !== "MOBI") continue;
    headers++;
    const minimum = size >= 40 && v.getUint32(start + 36) >= 8 ? 264 : 248;
    if (
      size < minimum ||
      v.getUint32(start + 20) < minimum - 16 ||
      v.getUint32(start + 20) + 16 > size
    )
      fail("MOBI 标头损坏。");
    if (
      v.getUint16(start + 12) !== 0 ||
      v.getUint32(start + 172) !== 0 ||
      v.getUint32(start + 176) !== 0
    )
      fail(
        "此 MOBI/AZW 文件受 DRM 加密保护；阅读器不支持解密，请使用合法取得的无 DRM EPUB/MOBI。",
      );
    if (![1, 2].includes(v.getUint16(start)))
      fail(
        "暂不支持 HUFF/CDIC 或未知压缩的 Kindle 文件，请在本机用 Calibre 转为无 DRM EPUB。",
      );
    const n = v.getUint16(start + 8),
      recordSize = v.getUint16(start + 10);
    if (!n || i + n >= count || recordSize > 4096 || !recordSize)
      fail("MOBI 文本记录无效。");
    let compressed = 0;
    for (let j = i + 1; j <= i + n; j++)
      compressed += (offsets[j + 1] ?? bytes.length) - offsets[j];
    // PalmDOC expands by at most 5x; reserve a deliberately larger 8x bound.
    if (compressed * 8 > LIMITS.text) fail("MOBI 解压文本超过安全限制。");
  }
  if (!headers || str(offsets[0] + 16, 4) !== "MOBI") fail("缺少 MOBI 标头。");
  return { offsets, count };
}
export async function unzipEpub(bytes) {
  checkBytes(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    dec = new TextDecoder("utf-8", { fatal: true });
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      v.getUint32(i, true) === 0x06054b50 &&
      i + 22 + v.getUint16(i + 20, true) === bytes.length
    ) {
      eocd = i;
      break;
    }
  if (eocd < 0 || v.getUint16(eocd + 4, true) || v.getUint16(eocd + 6, true))
    fail("EPUB ZIP 文件损坏或分卷格式不支持。");
  const count = v.getUint16(eocd + 10, true),
    cd = v.getUint32(eocd + 16, true),
    cdSize = v.getUint32(eocd + 12, true);
  if (
    !count ||
    count > LIMITS.entries ||
    v.getUint16(eocd + 8, true) !== count ||
    cd + cdSize !== eocd
  )
    fail("EPUB 目录无效或条目过多。");
  let pos = cd,
    total = 0;
  const files = new Map(),
    records = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || v.getUint32(pos, true) !== 0x02014b50)
      fail("EPUB 中央目录损坏。");
    const flags = v.getUint16(pos + 8, true),
      method = v.getUint16(pos + 10, true),
      packed = v.getUint32(pos + 20, true),
      size = v.getUint32(pos + 24, true),
      names = v.getUint16(pos + 28, true),
      extra = v.getUint16(pos + 30, true),
      comment = v.getUint16(pos + 32, true),
      offset = v.getUint32(pos + 42, true);
    if (pos + 46 + names + extra + comment > eocd) fail("EPUB 文件名损坏。");
    const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + names));
    pos += 46 + names + extra + comment;
    if (flags & 0x2041) fail("EPUB ZIP 已加密，暂不支持 DRM 或密码保护。");
    if (
      ![0, 8].includes(method) ||
      size > LIMITS.entry ||
      (total += size) > LIMITS.expanded ||
      packed > LIMITS.file
    )
      fail("EPUB 压缩方法或解压大小超出安全限制。");
    if (!name || /(^\/|\\|\0|(^|\/)\.\.($|\/))/.test(name) || files.has(name))
      fail("EPUB 包含不安全或重复路径。");
    if (
      offset + 30 > cd ||
      v.getUint32(offset, true) !== 0x04034b50 ||
      v.getUint16(offset + 6, true) !== flags ||
      v.getUint16(offset + 8, true) !== method
    )
      fail("EPUB 本地目录不匹配。");
    const nameLength = v.getUint16(offset + 26, true),
      start = offset + 30 + nameLength + v.getUint16(offset + 28, true);
    if (
      start + packed > cd ||
      dec.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)) !== name
    )
      fail("EPUB 压缩数据越界。");
    // Even ignored resources count towards the expansion budget, but are never decoded.
    files.set(name, null);
    records.push({ name, method, start, packed, size });
  }
  if (pos !== eocd) fail("EPUB 中央目录长度不匹配。");
  if (
    [...files.keys()].some(
      (name) => name.toLowerCase() === "meta-inf/encryption.xml",
    )
  )
    fail(
      "EPUB 包含加密资源（含字体混淆）；当前安全阅读模式暂不支持，请使用无加密 EPUB。",
    );
  for (const { name, method, start, packed, size } of records) {
    if (!/\.(xml|opf|xhtml|html|htm|ncx)$/i.test(name) && name !== "mimetype")
      continue;
    let raw = bytes.subarray(start, start + packed);
    if (method === 8) {
      const reader = new Blob([raw])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))
        .getReader();
      const chunks = [];
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > size || length > LIMITS.entry)
            fail("EPUB 实际解压大小超出限制。");
          chunks.push(value);
        }
      } finally {
        try {
          Promise.resolve(reader.cancel()).catch(() => {});
        } catch {}
      }
      raw = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) {
        raw.set(chunk, at);
        at += chunk.length;
      }
    }
    if (raw.length !== size) fail("EPUB 解压大小不匹配。");
    files.set(name, dec.decode(raw));
  }
  if (files.get("mimetype") !== "application/epub+zip")
    fail("不是有效的 EPUB 包。");
  return [...files].filter(([, text]) => text !== null);
}
