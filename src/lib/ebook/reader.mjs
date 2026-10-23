import { LIMITS } from "./archive.mjs";
import { sanitizeBook } from "./sanitize.mjs";
import { supportsBrowserReader } from "../reader-formats.mjs";
export const supportsReader = supportsBrowserReader;
export async function readBoundedResponse(
  response,
  { timeoutMs = 45000 } = {},
) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > LIMITS.file) {
    try {
      Promise.resolve(response.body?.cancel()).catch(() => {});
    } catch {}
    throw new Error("文件超过在线阅读的 20 MB 限制。");
  }
  if (!response.body) throw new Error("文件响应为空。");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0,
    reads = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("文件读取超时，请稍后重新打开阅读。")),
      timeoutMs,
    );
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (++reads > 20000 || (size += value.length) > LIMITS.file)
        throw new Error("文件响应超过安全限制。");
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    // Cancellation is best effort: a broken source cannot mask the original error
    // or keep the reader pending forever.
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  }
  if (!size) throw new Error("文件为空。");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}
async function parseBinary(bytes, format) {
  const worker = new Worker(new URL("./parse-worker.mjs", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("电子书解析超时；请在本机转换为 EPUB 后重试。")),
      15000,
    );
    function finish(error, value) {
      clearTimeout(timer);
      window.removeEventListener("pagehide", cancel);
      worker.terminate();
      error ? reject(error) : resolve(value);
    }
    function cancel() {
      finish(new Error("阅读页面已关闭。"));
    }
    window.addEventListener("pagehide", cancel, { once: true });
    worker.onmessage = (event) =>
      event.data.ok
        ? finish(null, event.data.book)
        : finish(new Error(event.data.error));
    worker.onerror = () =>
      finish(
        new Error("电子书解析失败；文件可能损坏或是不支持的 Kindle 变体。"),
      );
    const copy = bytes.slice(0);
    worker.postMessage({ bytes: copy, format }, [copy]);
  });
}
export function sanitizeIsolated(book) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  const nonce = crypto.randomUUID().replaceAll("-", ""),
    token = crypto.randomUUID();
  const source = `const sanitizeBook=${sanitizeBook.toString()};addEventListener('message',e=>{if(e.source!==parent||e.data.token!==${JSON.stringify(token)})return;try{parent.postMessage({token:e.data.token,chapters:sanitizeBook(e.data.book)},'*')}catch(error){parent.postMessage({token:e.data.token,error:error.message},'*')}});parent.postMessage({token:${JSON.stringify(token)},ready:true},'*');`;
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; base-uri 'none'; form-action 'none'"><script nonce="${nonce}">${source.replaceAll("</script", "<\\/script")}<\/script>`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("电子书文档处理超时。")),
      15000,
    );
    function finish(error, value) {
      clearTimeout(timer);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("message", receive);
      frame.remove();
      error ? reject(error) : resolve(value);
    }
    function cancel() {
      finish(new Error("阅读页面已关闭。"));
    }
    window.addEventListener("pagehide", cancel, { once: true });
    function receive(event) {
      if (event.source !== frame.contentWindow || event.data?.token !== token)
        return;
      if (event.data.ready)
        frame.contentWindow.postMessage({ token, book }, "*");
      else
        event.data.error
          ? finish(new Error(event.data.error))
          : finish(null, event.data.chapters);
    }
    window.addEventListener("message", receive);
    document.body.append(frame);
  });
}
export async function mountTextReader({
  bytes,
  format,
  container,
  prev,
  next,
  zoom,
  toc,
  theme,
  position,
  progress,
  save,
}) {
  const book = await parseBinary(bytes, format),
    chapters = await sanitizeIsolated(book);
  const frame = document.createElement("iframe");
  frame.className = "ebook-text-frame";
  frame.title = "安全文字阅读区域";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  container.replaceChildren(frame);
  let chapter = Math.max(
    0,
    Math.min(
      chapters.length - 1,
      Number(/^chapter:(\d+)$/.exec(progress)?.[1]) || 0,
    ),
  );
  for (let i = 0; i < chapters.length; i++) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = chapters[i].title;
    toc.append(option);
  }
  function render() {
    const dark = theme.value === "dark";
    frame.srcdoc = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html{background:${dark ? "#262820" : "#fffdf8"};color:${dark ? "#f7f4ed" : "#282820"};font-size:${Number(zoom.value) * 100}%}body{max-width:48rem;padding:1.5rem;margin:auto;font-family:serif;line-height:1.9;overflow-wrap:anywhere}h1,h2,h3{line-height:1.4}pre{white-space:pre-wrap}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid;padding:.3em}img{display:none}</style></head><body>${chapters[chapter].html}</body></html>`;
    position.textContent = `${chapter + 1} / ${chapters.length} · 章节`;
    prev.disabled = chapter === 0;
    next.disabled = chapter === chapters.length - 1;
    toc.value = String(chapter);
    save(`chapter:${chapter}`);
  }
  prev.textContent = "← 上一章";
  next.textContent = "下一章 →";
  prev.setAttribute("aria-label", "上一章");
  next.setAttribute("aria-label", "下一章");
  prev.onclick = () => {
    chapter = Math.max(0, chapter - 1);
    render();
  };
  next.onclick = () => {
    chapter = Math.min(chapters.length - 1, chapter + 1);
    render();
  };
  toc.onchange = () => {
    if (toc.value !== "") {
      chapter = Number(toc.value);
      render();
    }
  };
  zoom.onchange = render;
  theme.hidden = false;
  theme.onchange = render;
  render();
  window.addEventListener("pagehide", () => frame.remove(), { once: true });
}
