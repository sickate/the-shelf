// Minimal ZIP reader for CBZ comics: EOCD -> central directory -> image entries. Supports the
// two methods CBZ files use in practice (0 = stored, 8 = deflate via DecompressionStream).
// ZIP64 and encrypted archives are rejected with a CbzError instead of being misread.

export class CbzError extends Error {}

export interface CbzEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local file header. */
  offset: number;
}

export interface CbzArchive {
  /** Image entries in natural reading order. */
  pages: CbzEntry[];
  /** Decoded image of page `i` (0-based), typed by its magic bytes. */
  page(i: number): Promise<Blob>;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;

/** Natural order: "2.jpg" < "10.jpg", directories compared segment by segment. */
export function naturalCompare(a: string, b: string): number {
  if (collator) {
    const c = collator.compare(a, b);
    if (c) return c;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("latin1").decode(bytes);
    }
  }
}

/** MIME type from the first bytes of an image, or "" when unknown. */
export function sniffImageType(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/avif";
  return "";
}

/** Lists all file entries of a ZIP from its central directory. */
export function listZip(buf: ArrayBuffer): CbzEntry[] {
  const dv = new DataView(buf);
  const len = buf.byteLength;
  if (len < 22) throw new CbzError("文件太小，不是有效的 CBZ");
  // EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
  let eocd = -1;
  for (let p = len - 22; p >= Math.max(0, len - 22 - 0xffff); p--) {
    if (dv.getUint32(p, true) === EOCD_SIG) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new CbzError("找不到 ZIP 目录，文件可能不完整");
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new CbzError("不支持 ZIP64 格式的 CBZ");
  if (cdOffset + cdSize > len) throw new CbzError("ZIP 目录越界，文件可能不完整");
  const bytes = new Uint8Array(buf);
  const out: CbzEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > len || dv.getUint32(p, true) !== CEN_SIG) throw new CbzError("ZIP 目录损坏");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new CbzError("不支持 ZIP64 格式的 CBZ");
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    if (flags & 1) throw new CbzError("CBZ 已加密，无法在线阅读");
    out.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function isPage(e: CbzEntry): boolean {
  if (e.name.endsWith("/")) return false;
  const parts = e.name.split("/");
  if (parts.some((s) => s === "__MACOSX" || s.startsWith("."))) return false;
  return IMAGE_EXT.test(e.name);
}

function entryData(buf: ArrayBuffer, e: CbzEntry): Uint8Array {
  const dv = new DataView(buf);
  if (e.offset + 30 > buf.byteLength || dv.getUint32(e.offset, true) !== LOC_SIG) throw new CbzError(`条目 ${e.name} 损坏`);
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  if (start + e.compressedSize > buf.byteLength) throw new CbzError(`条目 ${e.name} 不完整`);
  return new Uint8Array(buf, start, e.compressedSize);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new CbzError("浏览器不支持解压 deflate 条目");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads one entry's decompressed bytes. */
export async function readEntry(buf: ArrayBuffer, e: CbzEntry): Promise<Uint8Array> {
  const data = entryData(buf, e);
  if (e.method === 0) return data;
  if (e.method === 8) return inflate(data);
  throw new CbzError(`不支持的压缩方式 ${e.method}（${e.name}）`);
}

const EXT_TYPE: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp" };

/** Opens a CBZ held in memory. Pages are decoded on demand. */
export function openCbz(buf: ArrayBuffer): CbzArchive {
  const pages = listZip(buf)
    .filter(isPage)
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!pages.length) throw new CbzError("CBZ 中没有图片");
  return {
    pages,
    async page(i: number) {
      const e = pages[i];
      if (!e) throw new CbzError(`没有第 ${i + 1} 页`);
      const bytes = await readEntry(buf, e);
      const type = sniffImageType(bytes) || EXT_TYPE[e.name.split(".").pop()!.toLowerCase()] || "application/octet-stream";
      return new Blob([bytes as BlobPart], { type });
    },
  };
}
