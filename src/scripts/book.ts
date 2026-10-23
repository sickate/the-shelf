import { base } from "../lib/client";
import { api, session, errorText, fetchFile, explainCode } from "../lib/api";
import { metadataEditor, selectCategory } from "../lib/metadata-editor.mjs";
import { buildJobInput } from "../lib/job-input.mjs";
import { fileActions } from "../lib/file-actions.mjs";
export async function initBook() {
  const bookRoot = document.querySelector<HTMLElement>("[data-book]")!;
  const book = bookRoot.dataset.book!;
  const downloadFile = async (id: string, button: HTMLButtonElement) => {
    button.disabled = true;
    const target = document.getElementById("file-message")!;
    try {
      await session();
      const { access, response } = await fetchFile(id);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${document
        .getElementById("book-title")!
        .textContent!.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .slice(0, 150)}.${access.format.toLowerCase()}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      target.textContent = "已开始下载。";
    } catch (e) {
      target.textContent = errorText(e);
    } finally {
      button.disabled = false;
    }
  };
  const fileController = fileActions({
    root: document,
    bookId: book,
    mode: bookRoot.dataset.fileMode || "",
    readBase: bookRoot.dataset.readBase || "",
    onDownload: (id, button) => downloadFile(id, button),
  });
  document
    .querySelectorAll<HTMLButtonElement>("[data-download]")
    .forEach((button) => {
      button.onclick = () => downloadFile(button.dataset.download!, button);
    });
  const history = document.getElementById("history")!,
    message = document.getElementById("ai-message")!,
    submit = document.getElementById("submit-job") as HTMLButtonElement;
  const jobs = new Map<string, any>(),
    timers = new Map<string, number>();
  let authenticated = false;
  let aiEnabled = false;
  let metadataVersion: number | null = null;
  let versionedMetadata = false;
  const editor = metadataEditor(
    document.getElementById("metadata-fields") as HTMLFieldSetElement,
  );
  let stopped = false;
  window.addEventListener("pagehide", () => {
    stopped = true;
    timers.forEach(clearTimeout);
  });
  function applyMetadata(updated: any) {
    if (!updated || updated.id !== book) return;
    fileController.apply(updated.files);
    const fields: Record<string, string> = {
      "metadata-title": updated.title || "",
      "metadata-author": updated.author || "",
      "metadata-description": updated.description || "",
      "metadata-tags": (updated.tags || []).join(", "),
      "metadata-category": updated.category || "",
    };
    for (const [id, value] of Object.entries(fields)) {
      if (id === "metadata-category")
        selectCategory(document.getElementById(id), value);
      else (document.getElementById(id) as HTMLInputElement).value = value;
    }
    document.getElementById("book-title")!.textContent = updated.title;
    document.getElementById("cover-title")!.textContent = updated.title;
    document.getElementById("cover-title")!.title = updated.title;
    document.getElementById("book-byline")!.textContent =
      `${updated.author || "作者未标注"} · ${updated.category}`;
    document.getElementById("cover-category")!.textContent = updated.category;
    const categoryLink = document.getElementById(
      "book-category-link",
    ) as HTMLAnchorElement;
    categoryLink.textContent = updated.category;
    categoryLink.href =
      base + "?category=" + encodeURIComponent(updated.categoryId);
    document.getElementById("book-description")!.textContent =
      updated.description || "暂无人工简介；目录记录不代表电子书已经上传。";
    const tags = document.getElementById("book-tags")!;
    tags.replaceChildren();
    for (const tag of updated.tags || []) {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = tag;
      tags.append(span);
    }
    document.title = `${updated.title} — The Shelf`;
  }
  document.getElementById("metadata-form")!.onsubmit = async (event) => {
    event.preventDefault();
    if (!authenticated || !editor.ready) return;
    await editor.save(async () => {
      if (versionedMetadata && !Number.isInteger(metadataVersion)) {
        document.getElementById("metadata-message")!.textContent =
          "元数据版本尚未读取，请重新载入页面后再编辑。";
        return;
      }
      const form = document.getElementById("metadata-form")!,
        button = form.querySelector("button")!,
        target = document.getElementById("metadata-message")!,
        value = (id: string) =>
          (document.getElementById(id) as HTMLInputElement).value.trim();
      button.disabled = true;
      try {
        const category = document.getElementById(
          "metadata-category",
        ) as HTMLSelectElement;
        const changes = {
          title: value("metadata-title"),
          author: value("metadata-author") || null,
          description: value("metadata-description"),
          category: category.value,
          tags: value("metadata-tags")
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
        };
        const data = await api(
          `/api/books/${book}/metadata`,
          versionedMetadata
            ? { expectedVersion: metadataVersion, changes }
            : changes,
        );
        if (Number.isInteger(data.metadataVersion))
          metadataVersion = data.metadataVersion;
        applyMetadata(data.book);
        target.textContent =
          "信息已保存，当前详情与后续 AI 任务会使用新信息。公开静态目录将在下次构建后更新。";
      } catch (e) {
        target.textContent = errorText(e);
        if ((e as any)?.code === "metadata_conflict") {
          try {
            const latest = await api(`/api/books/${book}`);
            metadataVersion = latest.metadataVersion;
            const current = latest.book || latest;
            const details = document.createElement("p");
            details.textContent = `最新内容：${current.title} · ${current.author || "作者未标注"} · ${current.category}；${current.description || "暂无简介"}；标签：${(current.tags || []).join("、")}。输入已保留，请核对后再次保存。`;
            target.append(details);
          } catch {
            metadataVersion = null;
            target.append(
              " 最新版本暂不可读取，请保留输入并稍后重新载入页面。",
            );
          }
        }
      } finally {
        button.disabled = false;
      }
    });
  };
  function result(job: any, personal: boolean) {
    const section = document.createElement("article");
    section.className = "result";
    const heading = document.createElement("strong");
    heading.textContent =
      (
        {
          question: "书内提问",
          chapter_summary: "章节总结",
          full_summary: "全书总结",
          author: "作者资料",
        } as any
      )[job.operation] || "整理结果";
    section.append(heading);
    const meta = document.createElement("small");
    const statuses: Record<string, string> = {
      queued: "排队中",
      running: "整理中",
      completed: "已完成",
      failed: "未完成",
      uncertain: "结果待确认",
    };
    meta.textContent = ` · ${statuses[job.status] || "待确认"} · ${new Date(job.createdAt).toLocaleDateString("zh-CN")}`;
    section.append(meta);
    const content = document.createElement("p");
    content.textContent =
      job.content ||
      (job.error
        ? explainCode(
            typeof job.error === "string"
              ? job.error
              : job.error.code || "任务失败",
          )
        : null) ||
      "任务处理中，结果会自动保存。";
    section.append(content);
    if (Array.isArray(job.sources)) {
      const seen = new Set<string>();
      for (const source of job.sources) {
        const label =
          typeof source === "string" ? source : source.label || "参考资料";
        const key = `${label}:${source.url || source.fileId || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = `来源：${label}`;
        let href = "";
        if (source.url) {
          try {
            const url = new URL(source.url);
            if (["http:", "https:"].includes(url.protocol)) href = url.href;
          } catch {}
        } else if (source.fileId) {
          const page = label.match(/PDF 第 (\d+) 页/)?.[1];
          href = `${base}read/?book=${encodeURIComponent(book)}&file=${encodeURIComponent(source.fileId)}${page ? `&page=${page}` : ""}`;
        }
        if (href) {
          const link = document.createElement("a");
          link.href = href;
          link.textContent = "查看来源 ↗";
          link.style.marginLeft = "8px";
          link.rel = "noopener noreferrer";
          if (source.url) link.target = "_blank";
          p.append(link);
        }
        section.append(p);
      }
    }
    if (personal && job.status === "completed") {
      const button = document.createElement("button");
      button.textContent = job.published ? "取消公开" : "发布到公开详情";
      button.onclick = async () => {
        button.disabled = true;
        try {
          const updated = await api(
            `/api/jobs/${encodeURIComponent(job.id)}/publish`,
            { published: !job.published },
          );
          jobs.set(job.id, updated.job || updated);
          await refreshHistory();
          await published();
        } catch (e) {
          message.textContent = errorText(e);
        } finally {
          button.disabled = false;
        }
      };
      section.append(button);
    }
    return section;
  }
  function render() {
    history.replaceChildren();
    if (!jobs.size) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "还没有个人记录。每一次主动生成都会保存在这里。";
      history.append(p);
    }
    [...jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .forEach((j) => history.append(result(j, true)));
  }
  async function poll(id: string, attempt = 0) {
    if (stopped || timers.has(id)) return;
    timers.set(
      id,
      window.setTimeout(
        async () => {
          timers.delete(id);
          try {
            const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
            const job = data.job || data;
            jobs.set(id, job);
            render();
            if (["queued", "running"].includes(job.status))
              poll(id, attempt + 1);
          } catch (e) {
            message.textContent = errorText(e);
            if (attempt < 5) poll(id, attempt + 1);
          }
        },
        Math.min(15000, 2000 * Math.pow(1.3, attempt)),
      ),
    );
  }
  async function refreshHistory() {
    const data = await api(`/api/books/${book}/history`);
    const list = Array.isArray(data)
      ? data
      : data.jobs || data.history || data.results || [];
    list.forEach((j: any) => {
      jobs.set(j.id, j);
      if (["queued", "running"].includes(j.status)) poll(j.id);
    });
    render();
  }
  async function published() {
    const target = document.getElementById("published")!;
    try {
      const data = await api(`/api/books/${book}/published`);
      const list = Array.isArray(data)
        ? data
        : data.jobs || data.results || data.published || [];
      target.replaceChildren();
      if (!list.length) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = "暂无公开结果。";
        target.append(p);
      }
      list.forEach((j: any) => target.append(result(j, false)));
    } catch (e) {
      target.textContent = errorText(e);
    }
  }
  try {
    const [s, c] = await Promise.all([session(), api("/api/config")]);
    authenticated = s.authenticated;
    aiEnabled = c.aiConfigured;
    if (aiEnabled) published();
    else
      document.getElementById("published")!.textContent =
        "AI 整理结果暂未启用。";
    versionedMetadata = c.authScheme === "owner-access-key";
    document.getElementById("ai-session")!.textContent = !authenticated
      ? "登录所有者账号后，可生成并查看私人记录。"
      : !aiEnabled
        ? "已登录 · AI 服务尚未配置，暂不能生成。"
        : "已登录 · 生成结果先保存为私人记录。";
    submit.disabled = !authenticated || !aiEnabled;
    if (authenticated) {
      document.getElementById("metadata-editor")!.hidden = false;
      try {
        await editor.load(async () => {
          const info = await api(`/api/books/${book}`);
          if (Number.isInteger(info.metadataVersion))
            metadataVersion = info.metadataVersion;
          applyMetadata(info.book || info);
        });
      } catch (e) {
        document.getElementById("metadata-message")!.textContent = errorText(e);
      }
      if (c.privateHistory !== false) await refreshHistory();
    }
  } catch (e) {
    document.getElementById("ai-session")!.textContent = errorText(e);
  }
  const op = document.getElementById("operation") as HTMLSelectElement;
  op.onchange = () => {
    document.getElementById("chapter-label")!.hidden =
      op.value !== "chapter_summary";
    document.getElementById("question-label")!.hidden = op.value !== "question";
  };
  document.getElementById("ai-form")!.onsubmit = async (e) => {
    e.preventDefault();
    if (!authenticated || !aiEnabled) return;
    const question = (
        document.getElementById("question") as HTMLTextAreaElement
      ).value.trim(),
      chapter = (
        document.getElementById("chapter") as HTMLInputElement
      ).value.trim();
    if (op.value === "question" && !question) {
      message.textContent = "请先输入一个问题。";
      return;
    }
    if (op.value === "chapter_summary" && !chapter) {
      message.textContent = "请输入需要总结的章节。";
      return;
    }
    submit.disabled = true;
    try {
      const data = await api(
        `/api/books/${book}/jobs`,
        buildJobInput({
          operation: op.value,
          question,
          chapter,
          model: (document.getElementById("model") as HTMLSelectElement).value,
        }),
      );
      const j = data.job || data;
      jobs.set(j.id, j);
      render();
      if (["queued", "running"].includes(j.status)) poll(j.id);
      message.textContent = "任务已保存。处理期间可以离开，返回后继续查看。";
    } catch (e) {
      message.textContent = errorText(e);
    } finally {
      submit.disabled = false;
    }
  };
}
