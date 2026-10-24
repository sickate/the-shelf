import { api, session, errorText, fetchFile } from "../lib/api";
import { base } from "../lib/client";
import {
  apiBook,
  currentBookFile,
  queryId,
  bookDetailHref,
} from "../lib/book-navigation.mjs";
import { privateView } from "../lib/private-view.mjs";
import {
  supportsReader,
  readBoundedResponse,
  mountTextReader,
} from "../lib/ebook/reader.mjs";
export async function initReader() {
  const params = new URLSearchParams(location.search),
    bookId = queryId(location.search, "book"),
    fileId = queryId(location.search, "file"),
    status = document.getElementById("reader-status")!,
    container = document.getElementById("reader")!,
    position = document.getElementById("position")!;
  if (!bookId || !fileId) {
    status.textContent = "请从书籍详情选择一个可用文件。";
    return;
  }
  const bookLink = document.getElementById("book-link") as HTMLAnchorElement;
  bookLink.href = bookDetailHref(bookId, base);
  const search = location.search;
  const scope = privateView({
    checkSession: session,
    clear() {
      container.replaceChildren();
      container.hidden = true;
      document.getElementById("reader-tools")!.hidden = true;
      document.getElementById("toc")!.replaceChildren();
      document.getElementById("reader-title")!.textContent = "在线阅读";
      bookLink.textContent = "书籍详情";
      document.title = "在线阅读 — The Shelf";
      position.textContent = "";
      status.textContent = "页面会话已结束，阅读内容已清除。请重新载入。";
    },
  });
  const guard = () => {
    scope.assert();
    if (location.search !== search) {
      scope.close();
      scope.assert();
    }
  };
  const onNavigation = () => {
    if (location.search !== search) scope.close();
  };
  window.addEventListener("popstate", onNavigation);
  scope.cleanup(() => window.removeEventListener("popstate", onNavigation));
  const progressKey = `shelf-progress-${fileId}`;
  let progress = "";
  try {
    progress = localStorage.getItem(progressKey) || "";
  } catch {}
  function save(value: string) {
    try {
      localStorage.setItem(progressKey, value);
    } catch {}
  }
  const prev = document.getElementById("prev")!,
    next = document.getElementById("next")!,
    zoom = document.getElementById("zoom") as HTMLSelectElement,
    toc = document.getElementById("toc") as HTMLSelectElement,
    download = document.getElementById("download-reader")!;
  const keydown = (event: KeyboardEvent) => {
    if (!scope.active) return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement
    )
      return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev.click();
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      next.click();
    }
  };
  document.addEventListener("keydown", keydown);
  scope.cleanup(() => document.removeEventListener("keydown", keydown));
  try {
    const s = await session();
    guard();
    scope.setAuthenticated(s.authenticated);
    if (!s.authenticated)
      throw new Error("请先登录所有者账号，再返回本页阅读。");
    const metadata = await api(`/api/books/${encodeURIComponent(bookId)}`);
    guard();
    const bookInfo = apiBook(metadata, bookId);
    if (
      !currentBookFile(
        bookInfo,
        bookId,
        fileId,
        import.meta.env.PUBLIC_SHELF_API_MODE || "",
      )
    )
      throw new Error("此文件不属于当前书籍或暂不可读取。");
    const bookTitle = bookInfo.title || "私人藏书";
    bookLink.textContent = bookTitle;
    document.title = `${bookTitle} — 在线阅读 · The Shelf`;
    document.getElementById("reader-title")!.textContent = bookTitle;
    const filename = bookTitle
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .slice(0, 150);
    const { access, response } = await fetchFile(fileId, guard, scope.signal);
    const format = access.format.toUpperCase(),
      mime = response.headers.get("content-type") || "";
    let bytes = await readBoundedResponse(response, {
      guard,
      signal: scope.signal,
    });
    scope.cleanup(() => {
      bytes = new ArrayBuffer(0);
    });
    guard();
    const downloadUrls = new Set<string>();
    scope.cleanup(() => {
      for (const url of downloadUrls) URL.revokeObjectURL(url);
      downloadUrls.clear();
    });
    download.onclick = () => {
      if (!scope.active) return;
      guard();
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      downloadUrls.add(url);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename}.${format.toLowerCase()}`;
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadUrls.delete(url);
      }, 30000);
    };
    document.getElementById("reader-title")!.textContent =
      `${bookTitle} · ${format} 阅读`;
    document.getElementById("reader-tools")!.hidden = false;
    if (!supportsReader(format)) {
      status.textContent = `${format} 不支持浏览器直接阅读。请下载原文件，使用 Calibre 转为 EPUB 后再导入。`;
      for (const id of ["prev", "next", "zoom", "toc", "pdf-page-label"])
        document.getElementById(id)!.hidden = true;
      return;
    }
    container.hidden = false;
    status.textContent = "已授权 · 阅读进度仅保存在此浏览器。";
    if (format === "PDF") {
      const pdfjs = await import("pdfjs-dist");
      guard();
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      guard();
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
      });
      // Destroy the loading task as well as an already opened document. Its
      // asynchronous cleanup can reject after the private view is gone.
      scope.cleanup(() => {
        void loadingTask.destroy().catch(() => {});
      });
      const pdf = await loadingTask.promise;
      guard();
      let page = Math.min(
          pdf.numPages,
          Math.max(1, Number(params.get("page")) || Number(progress) || 1),
        ),
        renderTask: any = null;
      const pageInput = document.getElementById("pdf-page") as HTMLInputElement;
      pageInput.max = String(pdf.numPages);
      let seq = 0;
      async function render() {
        if (!scope.active) return;
        guard();
        const current = ++seq;
        if (renderTask) {
          renderTask.cancel();
          renderTask = null;
        }
        const p = await pdf.getPage(page);
        if (!scope.active || current !== seq) return;
        guard();
        const view = p.getViewport({ scale: 1 }),
          scale =
            (Math.max(200, container.clientWidth - 30) / view.width) *
            Number(zoom.value),
          viewport = p.getViewport({ scale });
        const canvas = document.createElement("canvas"),
          ratio = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.maxWidth = "none";
        canvas.setAttribute(
          "aria-label",
          `第 ${page} 页，共 ${pdf.numPages} 页`,
        );
        container.replaceChildren(canvas);
        renderTask = p.render({
          canvas,
          canvasContext: canvas.getContext("2d")!,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        try {
          await renderTask.promise;
        } catch (e) {
          if ((e as any).name !== "RenderingCancelledException") throw e;
        }
        if (!scope.active || current !== seq) return;
        guard();
        position.textContent = `${page} / ${pdf.numPages}`;
        pageInput.value = String(page);
        (prev as HTMLButtonElement).disabled = page === 1;
        (next as HTMLButtonElement).disabled = page === pdf.numPages;
        save(String(page));
      }
      prev.onclick = () => {
        page = Math.max(1, page - 1);
        render();
      };
      next.onclick = () => {
        page = Math.min(pdf.numPages, page + 1);
        render();
      };
      pageInput.onchange = () => {
        page = Math.min(
          pdf.numPages,
          Math.max(1, Number(pageInput.value) || 1),
        );
        render();
      };
      zoom.onchange = () => render();
      scope.cleanup(() => {
        seq++;
        renderTask?.cancel();
      });
      const outline = await pdf.getOutline();
      guard();
      async function addOutline(items: any[], depth = 0) {
        for (const item of items || []) {
          guard();
          const option = document.createElement("option");
          option.textContent = " ".repeat(depth * 2) + item.title;
          let dest =
            typeof item.dest === "string"
              ? await pdf.getDestination(item.dest)
              : item.dest;
          guard();
          if (dest && dest[0] !== null && dest[0] !== undefined) {
            const idx =
              typeof dest[0] === "number"
                ? dest[0]
                : await pdf.getPageIndex(dest[0]);
            guard();
            option.value = String(idx + 1);
            toc.append(option);
          }
          if (item.items) await addOutline(item.items, depth + 1);
        }
      }
      await addOutline(outline || []);
      guard();
      toc.onchange = () => {
        if (toc.value) {
          page = Number(toc.value);
          render();
        }
      };
      await render();
      guard();
      let resizeTimer: number;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => render(), 180);
      });
      observer.observe(container);
      scope.cleanup(() => {
        clearTimeout(resizeTimer);
        observer.disconnect();
      });
    } else {
      document.getElementById("pdf-page-label")!.hidden = true;
      container.classList.add("epub");
      const theme = document.getElementById("theme") as HTMLSelectElement;
      theme.hidden = false;
      await mountTextReader({
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
        guard,
        cleanup: scope.cleanup,
        signal: scope.signal,
      });
      guard();
      status.textContent =
        "已授权 · 安全文字模式：省略图片及原书样式；章节进度仅保存在此浏览器。无 DRM MOBI/KF8 可读，HUFF/CDIC 压缩需先在本机转换。";
    }
  } catch (e) {
    if (!scope.active) return;
    status.textContent = errorText(e);
    status.classList.add("error");
  }
}
