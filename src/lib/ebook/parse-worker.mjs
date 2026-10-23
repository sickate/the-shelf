import { LIMITS, checkBytes, inspectMobi, unzipEpub } from "./archive.mjs";
import { MOBI } from "./vendor/mobi.js";
export async function extractBook(bytes, format) {
  checkBytes(bytes);
  if (format === "EPUB") return { format, files: await unzipEpub(bytes) };
  inspectMobi(bytes);
  const book = await new MOBI({ textOnly: true }).open(new Blob([bytes]));
  if (!book.sections?.length || book.sections.length > LIMITS.chapters)
    throw new Error("Kindle 章节数无效或超出限制。");
  let total = 0;
  const chapters = [];
  for (const section of book.sections) {
    if (!section.text || section.linear === "no") continue;
    const html = await section.text();
    total += html.length;
    if (html.length > LIMITS.entry || total > LIMITS.text)
      throw new Error("Kindle 文本超过安全限制。");
    chapters.push({ html });
  }
  if (!chapters.length)
    throw new Error("此 Kindle 变体没有可读取的章节，请在本机转换为 EPUB。");
  return { format, chapters };
}
if (
  typeof self !== "undefined" &&
  typeof WorkerGlobalScope !== "undefined" &&
  self instanceof WorkerGlobalScope
)
  self.onmessage = async (event) => {
    try {
      self.postMessage({
        ok: true,
        book: await extractBook(
          new Uint8Array(event.data.bytes),
          event.data.format,
        ),
      });
    } catch (e) {
      self.postMessage({ ok: false, error: e.message || "电子书解析失败。" });
    }
  };
