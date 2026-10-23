import { api, apiBinary, errorText } from "../lib/api";
import {
  bookTitle,
  canSubmitUploadBytes,
  managementCapabilityText,
  managementUploadStatus,
  validateUploadFile,
} from "../lib/manage-ui.mjs";
import { canAccessFile } from "../lib/file-availability.mjs";
import { supportsBrowserReader } from "../lib/reader-formats.mjs";

type ManagementEntry = {
  book: any;
  metadataVersion: number;
  trashed: boolean;
  managementVersion: number;
  deletedAt?: string | null;
  upload?: {
    id?: string;
    state?: string;
    canSubmit?: boolean;
  };
};

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function formatBytes(bytes: number) {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(bytes % 1_000_000 ? 1 : 0)} MB`
    : `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

function hashFile(file: File) {
  return file
    .arrayBuffer()
    .then((buffer) =>
      crypto.subtle
        .digest("SHA-256", buffer)
        .then((hash) =>
          [...new Uint8Array(hash)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        ),
    );
}

function makeButton(
  text: string,
  action: (event: MouseEvent) => void,
  className = "",
) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  if (className) button.className = className;
  button.addEventListener("click", action);
  return button;
}

function renderEntry(
  entry: ManagementEntry,
  container: HTMLElement,
  reload: () => Promise<void>,
) {
  const book = entry.book || {};
  const card = document.createElement("article");
  card.className = "manage-card";
  const title = document.createElement("h3");
  title.textContent = bookTitle(book);
  card.append(title);
  const details = document.createElement("p");
  details.className = "muted manage-book-meta";
  details.textContent =
    [book.author, book.category]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" · ") || "未填写作者或分类";
  card.append(details);

  const files = Array.isArray(book.files) ? book.files : [];
  const fileSummary = document.createElement("p");
  fileSummary.className = "manage-file-summary";
  fileSummary.textContent = files.length
    ? files
        .map(
          (file: any) =>
            `${file.format || "文件"} · ${formatBytes(Number(file.sizeBytes) || 0)}`,
        )
        .join(" / ")
    : "尚无可用文件";
  card.append(fileSummary);
  const upload = entry.upload || book.upload;
  if (upload) {
    const uploadNote = document.createElement("p");
    uploadNote.className = "manage-upload-state";
    uploadNote.setAttribute("role", "status");
    uploadNote.textContent = managementUploadStatus(upload);
    card.append(uploadNote);
  }

  if (!entry.trashed) {
    const readLinks = document.createElement("div");
    readLinks.className = "manage-read-links";
    for (const file of files) {
      if (
        !file ||
        !/^[\w-]{1,128}$/.test(file.id || "") ||
        !canAccessFile(file, "same-origin")
      )
        continue;
      const link = document.createElement("a");
      link.className = "button";
      link.href = `../read/?book=${encodeURIComponent(book.id)}&file=${encodeURIComponent(file.id)}`;
      link.textContent = supportsBrowserReader(file.format)
        ? `阅读 ${file.format} →`
        : `查看 ${file.format} →`;
      readLinks.append(link);
    }
    if (readLinks.childElementCount) card.append(readLinks);
  }

  const controls = document.createElement("div");
  controls.className = "manage-card-controls";
  const actionStatus = document.createElement("p");
  actionStatus.className = "status-text manage-card-status";
  actionStatus.setAttribute("role", "status");
  const review = document.createElement("div");
  review.className = "manage-confirm";
  review.hidden = true;
  review.setAttribute("role", "group");
  const reviewText = document.createElement("p");
  reviewText.textContent = `确认将《${bookTitle(book)}》移入回收站？它会从书库隐藏，恢复前不能访问文件；原文件会保留，移入回收站不会释放存储空间。`;
  review.append(reviewText);
  const confirm = makeButton(
    "确认移入回收站",
    async () => {
      confirm.disabled = true;
      try {
        await api(`/api/manage/books/${encodeURIComponent(book.id)}/trash`, {
          expectedVersion: entry.managementVersion,
        });
        await reload();
      } catch (error) {
        actionStatus.textContent = `${errorText(error)} 请重新载入当前状态后再试。`;
        confirm.disabled = false;
      }
    },
    "danger",
  );
  const cancel = makeButton("取消", () => {
    review.hidden = true;
  });
  review.append(confirm, cancel);

  if (entry.trashed) {
    controls.append(
      makeButton("恢复到书库", async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        if (button) button.disabled = true;
        try {
          await api(
            `/api/manage/books/${encodeURIComponent(book.id)}/restore`,
            {
              expectedVersion: entry.managementVersion,
            },
          );
          await reload();
        } catch (error) {
          actionStatus.textContent = `${errorText(error)} 请重新载入当前状态后再试。`;
          if (button) button.disabled = false;
        }
      }),
    );
  } else {
    const trash = makeButton("移入回收站", () => {
      review.hidden = false;
    });
    controls.append(trash, review);
  }
  card.append(controls);
  card.append(actionStatus);
  container.append(card);
}

export function initManage() {
  const capability = byId<HTMLParagraphElement>("manage-capability");
  const form = byId<HTMLFormElement>("upload-form");
  const fileInput = byId<HTMLInputElement>("book-file");
  const submit = byId<HTMLButtonElement>("upload-submit");
  const preview = byId<HTMLParagraphElement>("file-preview");
  const uploadStatus = byId<HTMLSpanElement>("upload-status");
  const booksStatus = byId<HTMLParagraphElement>("books-status");
  const booksList = byId<HTMLDivElement>("books-list");
  const trashList = byId<HTMLDivElement>("trash-list");
  let uploadReady = false;
  let busy = false;
  let requiresRefresh = false;
  let uploadFormats = ["PDF", "EPUB", "MOBI", "AZW", "AZW3"];
  let maxUploadBytes = 20_000_000;

  const showFile = () => {
    const file = fileInput.files?.[0];
    if (!file) {
      preview.textContent =
        "支持 PDF、EPUB、MOBI、AZW、AZW3。文件留在本机，直到服务端明确开放普通上传。";
      return;
    }
    preview.textContent =
      validateUploadFile(file, uploadFormats, maxUploadBytes) ||
      `${file.name} · ${formatBytes(file.size)} · ${uploadReady ? "待上传" : "服务端当前关闭上传，文件仍只在本机"}`;
  };
  fileInput.addEventListener("change", showFile);

  const loadBooks = async () => {
    const result = await api("/api/manage");
    booksList.replaceChildren();
    trashList.replaceChildren();
    const entries = Array.isArray(result.books) ? result.books : [];
    const current = entries.filter((entry: ManagementEntry) => !entry.trashed);
    const trashed = entries.filter((entry: ManagementEntry) => entry.trashed);
    byId<HTMLElement>("books-count").textContent = `${current.length} 本`;
    byId<HTMLElement>("trash-count").textContent = `${trashed.length} 本`;
    booksStatus.textContent = current.length
      ? "只对当前所有者会话显示。"
      : "书库还是空的，可以在上方登记新书。";
    byId<HTMLParagraphElement>("trash-status").textContent = trashed.length
      ? "书籍可恢复到当前书库。"
      : "回收站为空。";
    for (const entry of current) renderEntry(entry, booksList, loadBooks);
    for (const entry of trashed) renderEntry(entry, trashList, loadBooks);
    const upload = result.upload || {};
    uploadReady = upload.enabled === true && upload.code === "ready";
    if (Number.isSafeInteger(upload.maxBytes) && upload.maxBytes > 0)
      maxUploadBytes = Math.min(upload.maxBytes, 20_000_000);
    if (Array.isArray(upload.formats))
      uploadFormats = upload.formats.filter((format: unknown) =>
        ["PDF", "EPUB", "MOBI", "AZW", "AZW3"].includes(String(format)),
      );
    capability.textContent = managementCapabilityText(upload);
    capability.classList.toggle("notice-blocked", !uploadReady);
    requiresRefresh = false;
    submit.disabled = !uploadReady || busy || requiresRefresh;
    showFile();
  };

  byId<HTMLButtonElement>("manage-reload").addEventListener(
    "click",
    async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      booksStatus.textContent = "正在重新核对私人书库…";
      try {
        await loadBooks();
        booksStatus.textContent = "书库状态已重新核对。";
      } catch (error) {
        booksStatus.textContent = `${errorText(error)} 书库状态仍未确认。`;
        requiresRefresh = true;
      } finally {
        button.disabled = false;
        submit.disabled = !uploadReady || busy || requiresRefresh;
      }
    },
  );

  void (async () => {
    try {
      const current = await api("/api/session");
      if (current.authenticated !== true) {
        booksStatus.textContent =
          "私人书库需要所有者登录。请先登录后再打开管理页。";
        capability.textContent = "尚未登录。上传、列表与回收站均保持关闭。";
        return;
      }
      await loadBooks();
    } catch (error) {
      booksStatus.textContent = `${errorText(error)} 私人书库未加载，管理操作保持关闭。`;
      capability.textContent =
        "暂时无法确认后端能力；文件不会发送。请从账户页检查登录与连接。";
    }
  })();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!uploadReady || busy) {
      uploadStatus.textContent = "服务端尚未确认上传条件，文件未发送。";
      return;
    }
    if (requiresRefresh) {
      uploadStatus.textContent =
        "上传状态尚未核对。请先点击“重新核对书库”；文件不会发送。";
      return;
    }
    const file = fileInput.files?.[0];
    const fileError = validateUploadFile(file, uploadFormats, maxUploadBytes);
    if (fileError) {
      uploadStatus.textContent = fileError;
      return;
    }
    const title = byId<HTMLInputElement>("book-title").value.trim();
    if (!title) {
      uploadStatus.textContent = "请填写书名。";
      return;
    }
    busy = true;
    submit.disabled = true;
    uploadStatus.textContent = "正在本机计算文件校验值；尚未发送文件内容…";
    try {
      const sha256 = await hashFile(file!);
      const descriptor = await api("/api/manage/uploads", {
        title,
        author: byId<HTMLInputElement>("book-author").value.trim() || null,
        category: byId<HTMLInputElement>("book-category").value.trim(),
        file: {
          name: file!.name,
          format: file!.name.split(".").at(-1)?.toUpperCase(),
          sizeBytes: file!.size,
          sha256,
        },
      });
      const upload = descriptor.upload || {};
      if (upload.state === "confirmed") {
        uploadStatus.textContent =
          "这份文件已有确认记录，未再次发送内容。书库已刷新。";
        form.reset();
        try {
          await loadBooks();
        } catch (error) {
          booksStatus.textContent = `${errorText(error)} 文件确认记录已存在，列表暂未更新。`;
        }
      } else if (!canSubmitUploadBytes(upload)) {
        uploadStatus.textContent = `上传意图状态为“${upload.state || "待核对"}”。为避免重复写入，未发送文件内容；请点击“重新核对书库”。`;
        requiresRefresh = false;
      } else {
        if (
          typeof upload.bytesUrl !== "string" ||
          !/^\/api\/manage\/uploads\/[\w-]+\/bytes$/.test(upload.bytesUrl)
        )
          throw new Error("上传目标未通过同源路径核对，文件未发送。");
        uploadStatus.textContent =
          "正在发送这一次文件内容…如结果不确定，页面不会自动重试。";
        requiresRefresh = true;
        const result = await apiBinary(upload.bytesUrl, file!);
        if (result.upload?.state === "confirmed") {
          uploadStatus.textContent = "文件已确认入库。";
          form.reset();
          requiresRefresh = false;
          try {
            await loadBooks();
          } catch (error) {
            booksStatus.textContent = `${errorText(error)} 文件已确认入库，列表暂未更新。`;
          }
        } else {
          uploadStatus.textContent =
            "文件已发送但确认状态尚未完成。请刷新核对；页面不会自动重试。";
        }
      }
    } catch (error) {
      uploadStatus.textContent = `${errorText(error)} 如请求状态不确定，请先刷新书库核对，页面不会自动重试。`;
      if (
        uploadStatus.textContent.includes("不确定") ||
        uploadStatus.textContent.includes("勿再次提交") ||
        (error as any)?.code === "upload_uncertain"
      )
        requiresRefresh = true;
    } finally {
      busy = false;
      submit.disabled = !uploadReady || requiresRefresh;
      showFile();
    }
  });
}
