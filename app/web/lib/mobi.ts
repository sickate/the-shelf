// MOBI / AZW / AZW3 (KF8) parsing via foliate-js. Import this module dynamically so the
// parser only loads for these formats.
// @ts-ignore -- foliate-js ships plain ES modules without type declarations
import { isMOBI, MOBI } from "foliate-js/mobi.js";
// @ts-ignore
import { unzlibSync } from "foliate-js/vendor/fflate.js";

/** Thrown when the file is DRM-encrypted or is not a MOBI/KF8 container (e.g. KFX). */
export class MobiUnsupportedError extends Error {
  constructor(public reason: "drm" | "format", message: string) {
    super(message);
    this.name = "MobiUnsupportedError";
  }
}

/** foliate-js book object (sections, toc, metadata, getCover(), resolveHref(), ...). */
export type FoliateBook = any;

/** PalmDOC encryption field of record 0 (0 = none, 1 = old Mobipocket, 2 = Mobipocket DRM). */
async function recordEncryption(blob: Blob, record = 0): Promise<number> {
  const head = new DataView(await blob.slice(0, 78 + 8 * (record + 1)).arrayBuffer());
  if (head.byteLength < 78 + 8 * (record + 1)) return 0;
  const off = head.getUint32(78 + 8 * record);
  const rec = new DataView(await blob.slice(off, off + 14).arrayBuffer());
  return rec.byteLength >= 14 ? rec.getUint16(12) : 0;
}

/** Opens a MOBI / AZW / AZW3 file and returns the foliate-js book object. */
export async function openMobi(blob: Blob): Promise<FoliateBook> {
  const file = blob instanceof File ? blob : new File([blob], "book.mobi");
  if (!file.size || !(await isMOBI(file))) throw new MobiUnsupportedError("format", "not a MOBI/KF8 file");
  if ((await recordEncryption(file)) !== 0) throw new MobiUnsupportedError("drm", "DRM-encrypted MOBI");
  let book: FoliateBook;
  try {
    book = await new MOBI({ unzlib: unzlibSync }).open(file);
  } catch (e: any) {
    throw new MobiUnsupportedError("format", e?.message || String(e));
  }
  // Combo MOBI/KF8 files carry a second header for the KF8 part; check that one too.
  if (book?.mobi?.headers?.palmdoc?.encryption) throw new MobiUnsupportedError("drm", "DRM-encrypted KF8");
  if (!book?.sections?.length) throw new MobiUnsupportedError("format", "no sections");
  return book;
}

/** Cover image of a MOBI / AZW3 file, or null when it has none or cannot be parsed. */
export async function mobiCover(blob: Blob): Promise<Blob | null> {
  try {
    const book = await openMobi(blob);
    const cover: Blob | null | undefined = await book.getCover?.();
    if (!cover || !cover.size) return null;
    if (cover.type) return cover;
    // foliate returns an untyped Blob; sniff the image type so it can be decoded/uploaded.
    const b = new Uint8Array(await cover.slice(0, 12).arrayBuffer());
    const type =
      b[0] === 0xff && b[1] === 0xd8
        ? "image/jpeg"
        : b[0] === 0x89 && b[1] === 0x50
          ? "image/png"
          : b[0] === 0x47 && b[1] === 0x49
            ? "image/gif"
            : b[8] === 0x57 && b[9] === 0x45
              ? "image/webp"
              : "";
    return type ? new Blob([cover], { type }) : cover;
  } catch {
    return null;
  }
}
