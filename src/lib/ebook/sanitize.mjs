// This function is serialized into a sandbox with opaque origin and no network.
// Publisher strings are only passed by postMessage, never interpolated into code.
export function sanitizeBook(input) {
  const parser = new DOMParser(),
    chapters = [];
  let nodes = 0,
    output = 0;
  const escape = (value) =>
    value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const allowed = new Set(
    "p div span section article header footer h1 h2 h3 h4 h5 h6 blockquote pre code strong em b i u s small sub sup ul ol li dl dt dd table thead tbody tfoot tr td th caption hr br ruby rt rp".split(
      " ",
    ),
  );
  const drop = new Set(
    "script style link meta base iframe frame frameset object embed applet svg math form input button select textarea video audio source track canvas template noscript".split(
      " ",
    ),
  );
  function clean(node, depth = 0) {
    if (++nodes > 100000 || depth > 64)
      throw new Error("电子书文档结构超出安全限制。");
    if (node.nodeType === 3) return escape(node.nodeValue || "");
    if (node.nodeType !== 1) return "";
    const tag = node.localName?.toLowerCase();
    if (drop.has(tag)) return "";
    if (tag === "img") return "<p>[图片已在安全文字模式中省略]</p>";
    const text = [...node.childNodes].map((n) => clean(n, depth + 1)).join("");
    if (
      !allowed.has(tag) ||
      (node.namespaceURI &&
        node.namespaceURI !== "http://www.w3.org/1999/xhtml")
    )
      return text;
    return ["br", "hr"].includes(tag) ? `<${tag}>` : `<${tag}>${text}</${tag}>`;
  }
  function normalized(source) {
    if (
      typeof source !== "string" ||
      source.length > 2_000_000 ||
      /<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source)
    )
      throw new Error("电子书文档无效、过大或含不支持的 XML 实体。");
    const result = source.replace(/<!DOCTYPE\s[^>]*>/gi, "");
    if (/<!DOCTYPE/i.test(result)) throw new Error("电子书文档类型声明无效。");
    return result;
  }
  function add(html, label) {
    html = normalized(html);
    const doc = parser.parseFromString(html, "text/html");
    const title = (
      label ||
      doc.querySelector("h1,h2,h3")?.textContent ||
      doc.querySelector("title")?.textContent ||
      `第 ${chapters.length + 1} 章`
    )
      .trim()
      .slice(0, 160);
    const result = [...doc.body.childNodes].map((n) => clean(n)).join("");
    output += result.length;
    if (output > 24_000_000 || chapters.length >= 1024)
      throw new Error("电子书正文超出安全限制。");
    chapters.push({ title, html: result });
  }
  const xml = (source) => {
    const doc = parser.parseFromString(normalized(source), "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("EPUB XML 损坏。");
    return doc;
  };
  function path(base, href) {
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(href))
      throw new Error("EPUB 章节必须位于书籍包内。");
    const decoded = decodeURIComponent(href.split("#")[0]);
    if (/[\\\0?#]/.test(decoded)) throw new Error("EPUB 路径无效。");
    const parts = base.split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (part === "..") {
        if (!parts.length) throw new Error("EPUB 路径越界。");
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  }
  if (input.format === "EPUB") {
    const files = new Map(input.files);
    const root = xml(files.get("META-INF/container.xml"))
      .getElementsByTagNameNS("*", "rootfile")[0]
      ?.getAttribute("full-path");
    if (!root || !files.has(root)) throw new Error("EPUB 缺少根包文件。");
    const opf = xml(files.get(root)),
      manifest = new Map();
    for (const item of opf.getElementsByTagNameNS("*", "item")) {
      const id = item.getAttribute("id"),
        href = item.getAttribute("href");
      if (manifest.has(id)) throw new Error("EPUB 清单包含重复标识。");
      if (id && href)
        manifest.set(id, {
          name: path(root, href),
          type: item.getAttribute("media-type"),
        });
    }
    for (const ref of opf.getElementsByTagNameNS("*", "itemref")) {
      if (ref.getAttribute("linear") === "no") continue;
      const item = manifest.get(ref.getAttribute("idref"));
      if (
        !item ||
        !["application/xhtml+xml", "text/html"].includes(item.type) ||
        !files.has(item.name)
      )
        throw new Error("EPUB 章节格式不支持或正文缺失。");
      add(files.get(item.name));
    }
  } else for (const chapter of input.chapters || []) add(chapter.html);
  if (!chapters.length) throw new Error("电子书没有可阅读的章节。");
  return chapters;
}
