import { base } from "../lib/client";
import {
  bookDetailHref,
  readHref,
  canonicalId,
} from "../lib/book-navigation.mjs";
import { api, apiBinary, errorText } from "../lib/api";
import {
  bookTitle,
  canSubmitUploadBytes,
  managementCapabilityText,
  managementIdentifyCapabilityText,
  managementUploadStatus,
  filenameTitle,
  validateUploadFile,
} from "../lib/manage-ui.mjs";
import { canAccessFile } from "../lib/file-availability.mjs";
import { supportsBrowserReader } from "../lib/reader-formats.mjs";
import { privateView } from "../lib/private-view.mjs";

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
  if (!entry.trashed && canonicalId(book.id)) {
    const link = document.createElement("a");
    link.href = bookDetailHref(book.id, base);
    link.textContent = bookTitle(book);
    title.append(link);
  } else title.textContent = bookTitle(book);
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
      if (!canonicalId(book.id)) continue;
      link.href = readHref(book.id, file.id, base);
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
  const identifyStatus = byId<HTMLParagraphElement>("identify-status");
  const metadataPreview = byId<HTMLParagraphElement>("metadata-preview");
  const booksStatus = byId<HTMLParagraphElement>("books-status");
  const booksList = byId<HTMLDivElement>("books-list");
  const trashList = byId<HTMLDivElement>("trash-list");
  const loginCta = byId<HTMLAnchorElement>("manage-login-cta");
  const titleInput = byId<HTMLInputElement>("book-title");
  const authorInput = byId<HTMLInputElement>("book-author");
  const categoryInput = byId<HTMLInputElement>("book-category");
  const metadataInputs = [titleInput, authorInput, categoryInput];
  let uploadReady = false;
  let authenticated = false;
  let authEpoch = 0;
  let sessionChecked = false;
  let identifyConfig: any = null;
  let busy = false;
  let identifyPending = false;
  let requiresRefresh = false;
  let selectionGeneration = 0;
  let currentFileKey = "";
  let currentFile: File | null = null;
  let activeIdentifyKey = "";
  const dirtyFields = new Set<HTMLInputElement>();
  const identificationRequests = new Map<string, Promise<any>>();
  let uploadFormats = ["PDF", "EPUB", "MOBI", "AZW", "AZW3"];
  let maxUploadBytes = 20_000_000;
  let pageGeneration = 0;
  let currentCursor = "";
  let cursorHistory: string[] = [];
  let nextCursor: string | null = null;
  const pagination = byId<HTMLElement>("manage-pagination");
  const previousPage = byId<HTMLButtonElement>("manage-previous");
  const nextPage = byId<HTMLButtonElement>("manage-next");
  const pageLabel = byId<HTMLElement>("manage-page-label");
  const scope = privateView({
    checkSession: () => api("/api/session"),
    clear: () => {
      authEpoch++;
      pageGeneration++;
      authenticated = false;
      uploadReady = false;
      identifyPending = false;
      identifyConfig = null;
      currentCursor = "";
      cursorHistory = [];
      nextCursor = null;
      booksList.replaceChildren();
      trashList.replaceChildren();
      byId<HTMLElement>("books-count").textContent = "—";
      byId<HTMLElement>("trash-count").textContent = "—";
      pagination.hidden = true;
      previousPage.disabled = true;
      nextPage.disabled = true;
      booksStatus.textContent = "会话已结束，请重新登录后载入私人书库。";
      byId<HTMLElement>("trash-status").textContent = "登录后加载回收站。";
      capability.textContent = "登录状态已失效。请重新登录后再操作。";
      loginCta.hidden = false;
      fileInput.value = "";
      currentFile = null;
      currentFileKey = "";
      activeIdentifyKey = "";
      identificationRequests.clear();
      dirtyFields.clear();
      metadataInputs.forEach((input) => {
        input.value = "";
      });
      preview.textContent = "";
      metadataPreview.textContent = "";
      identifyStatus.textContent = "会话已结束。";
      uploadStatus.textContent = "";
      submit.disabled = true;
      byId<HTMLButtonElement>("manage-reload").disabled = true;
    },
  });

  const keyForFile = (file: File) =>
    `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
  const identifyKeyForFile = (file: File) => file.name.normalize("NFC").trim();

  const updateMetadataPreview = () => {
    if (!currentFile) {
      metadataPreview.textContent = "";
      return;
    }
    const title = titleInput.value.trim() || filenameTitle(currentFile.name);
    const extras = [
      authorInput.value.trim(),
      categoryInput.value.trim(),
    ].filter(Boolean);
    metadataPreview.textContent = [title, ...extras].join(" · ");
  };

  const updateSubmit = () => {
    const fileError = validateUploadFile(
      fileInput.files?.[0],
      uploadFormats,
      maxUploadBytes,
    );
    submit.textContent = !sessionChecked
      ? "正在核对登录状态…"
      : !authenticated
        ? "先登录后上传"
        : !uploadReady
          ? "上传暂不可用"
          : identifyPending
            ? "正在识别…"
            : "登记并上传 →";
    submit.disabled =
      !sessionChecked ||
      !authenticated ||
      !uploadReady ||
      busy ||
      identifyPending ||
      requiresRefresh ||
      Boolean(fileError);
    fileInput.disabled = busy;
    for (const input of metadataInputs) input.disabled = busy;
  };

  const showFile = () => {
    const file = fileInput.files?.[0];
    if (!file) {
      preview.textContent =
        "支持 PDF、EPUB、MOBI、AZW、AZW3。选择文件后仅发送文件名用于识别，不发送文件正文。";
      updateSubmit();
      return;
    }
    const fileError = validateUploadFile(file, uploadFormats, maxUploadBytes);
    preview.textContent =
      fileError ||
      `${file.name} · ${formatBytes(file.size)} · ${uploadReady ? "待上传" : "原文件内容留在设备；文件名将用于AI识别"}`;
    updateSubmit();
  };

  const applyFallbackTitle = (file: File) => {
    if (!dirtyFields.has(titleInput))
      titleInput.value = filenameTitle(file.name).slice(0, 240);
    updateMetadataPreview();
  };

  const applyIdentification = (file: File, result: any) => {
    const metadata = result?.metadata || {};
    const title =
      typeof metadata.title === "string" ? metadata.title.trim() : "";
    const author =
      typeof metadata.author === "string" ? metadata.author.trim() : "";
    const category =
      typeof metadata.category === "string" ? metadata.category.trim() : "";
    if (!dirtyFields.has(titleInput))
      titleInput.value = (title || filenameTitle(file.name)).slice(0, 240);
    if (!dirtyFields.has(authorInput)) authorInput.value = author.slice(0, 160);
    if (!dirtyFields.has(categoryInput))
      categoryInput.value = category.slice(0, 80);
    identifyStatus.textContent = title
      ? result.cached
        ? "已使用缓存的AI识别结果，可在下方修改。"
        : "AI已根据文件名识别，可在下方修改。"
      : "AI未提供书名，文件名暂作书名；可在下方修改。";
    updateMetadataPreview();
  };

  const identifyFile = async (file: File, requestId: string, epoch: number) => {
    if (!authenticated || epoch !== authEpoch)
      throw Object.assign(new Error("登录状态已失效。"), {
        code: "authentication_required",
      });
    const started = await api("/api/manage/identify", {
      filename: file.name,
      requestId,
    });
    const canonicalId = started.requestId;
    if (
      typeof canonicalId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(canonicalId)
    )
      throw new Error("识别请求编号无效，状态待核对。");
    if (started.status === "completed") return started;
    const expectedPollUrl = `/api/manage/identify/${canonicalId}`;
    if (
      started.status !== "pending" ||
      started.pollUrl !== expectedPollUrl ||
      !/^\/api\/manage\/identify\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
        started.pollUrl,
      )
    )
      throw new Error("识别任务地址无效，状态待核对。");

    const timeout = Math.min(
      60_000,
      Number.isSafeInteger(identifyConfig?.timeoutMs)
        ? identifyConfig.timeoutMs
        : 60_000,
    );
    const deadline = Date.now() + timeout;
    for (let count = 0; count < 35 && Date.now() < deadline; count++) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2000, Math.max(0, deadline - Date.now()))),
      );
      if (Date.now() >= deadline) break;
      if (!authenticated || epoch !== authEpoch)
        throw Object.assign(new Error("登录状态已失效。"), {
          code: "authentication_required",
        });
      const status = await api(expectedPollUrl);
      if (status.requestId !== canonicalId)
        throw new Error("识别请求编号不匹配，状态待核对。");
      if (status.status === "completed") return status;
      if (status.status !== "pending")
        throw new Error("识别任务返回了无法确认的状态。");
    }
    const timeoutError = new Error(
      "识别仍在处理中，状态待核对；页面不会重新提交。文件名暂作书名。",
    );
    Object.assign(timeoutError, { code: "identify_pending" });
    throw timeoutError;
  };

  const maybeIdentifyCurrentFile = () => {
    const file = currentFile;
    const key = currentFileKey;
    const generation = selectionGeneration;
    if (!file || !key || busy) return;
    if (!sessionChecked) {
      identifyPending = false;
      identifyStatus.textContent =
        "正在核对登录状态；文件名暂作书名，不会发送文件名或原文件内容。";
      return;
    }
    if (!authenticated) {
      identifyPending = false;
      identifyStatus.textContent =
        "文件名暂作书名；先登录所有者账号，再识别文件名。原文件内容不会发送。";
      return;
    }
    if (!identifyConfig) {
      identifyPending = false;
      identifyStatus.textContent = "正在核对文件名识别能力…";
      return;
    }
    if (identifyConfig.enabled !== true) {
      identifyPending = false;
      identifyStatus.textContent = `${managementIdentifyCapabilityText(identifyConfig)} 文件名暂作书名，可在下方修改。`;
      return;
    }
    const fileError = validateUploadFile(file, uploadFormats, maxUploadBytes);
    if (fileError) {
      identifyPending = false;
      identifyStatus.textContent = `${fileError} 文件名未发送。`;
      return;
    }
    const maxCharacters = Number.isSafeInteger(
      identifyConfig.maxFilenameCharacters,
    )
      ? identifyConfig.maxFilenameCharacters
      : 255;
    if (Array.from(file.name).length > maxCharacters) {
      identifyPending = false;
      identifyStatus.textContent = `文件名超过 ${maxCharacters} 个字符，无法识别；可修改书籍信息后继续。`;
      applyFallbackTitle(file);
      return;
    }

    const identifyKey = identifyKeyForFile(file);
    if (activeIdentifyKey && activeIdentifyKey !== identifyKey) {
      identifyPending = true;
      identifyStatus.textContent =
        "等待前一本识别结束…只保留当前文件，不会排队重发旧文件名。";
      updateSubmit();
      return;
    }

    let request = identificationRequests.get(identifyKey);
    if (!request) {
      const requestId = crypto.randomUUID();
      identifyPending = true;
      activeIdentifyKey = identifyKey;
      updateSubmit();
      request = identifyFile(file, requestId, authEpoch);
      identificationRequests.set(identifyKey, request);
    } else {
      identifyPending = true;
      updateSubmit();
    }
    identifyStatus.textContent =
      "正在根据文件名识别书名、作者和分类…只发送文件名，不发送文件正文。";
    request
      .then(
        (result) => {
          if (
            generation !== selectionGeneration ||
            key !== currentFileKey ||
            !currentFile ||
            busy
          )
            return;
          identifyPending = false;
          applyIdentification(file, result);
          updateSubmit();
        },
        (error) => {
          const code = (error as any)?.code;
          if (code === "unauthorized" || code === "authentication_required") {
            authenticated = false;
            authEpoch++;
            loginCta.hidden = false;
            capability.textContent = "登录状态已失效。请重新登录后再操作。";
            updateSubmit();
          }
          if (
            generation !== selectionGeneration ||
            key !== currentFileKey ||
            !currentFile ||
            busy
          )
            return;
          identifyPending = false;
          applyFallbackTitle(file);
          if (code === "unauthorized" || code === "authentication_required") {
            identifyStatus.textContent =
              "登录状态已失效，请先登录；原文件内容未发送。";
            updateSubmit();
            return;
          }
          identifyStatus.textContent =
            code === "identify_reconciliation_required" ||
            code === "identify_pending"
              ? `${errorText(error)} 文件名暂作书名，可编辑后继续。`
              : `AI识别未完成：${errorText(error)} 文件名暂作书名，可编辑后继续。`;
          updateSubmit();
        },
      )
      .finally(() => {
        if (activeIdentifyKey === identifyKey) {
          activeIdentifyKey = "";
          if (currentFile && identifyKeyForFile(currentFile) !== identifyKey)
            maybeIdentifyCurrentFile();
        }
      });
  };

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0] || null;
    if (busy) return;
    const key = file ? keyForFile(file) : "";
    if (key && key === currentFileKey) return;
    selectionGeneration++;
    identifyPending = false;
    currentFile = file;
    currentFileKey = key;
    dirtyFields.clear();
    for (const input of metadataInputs) input.value = "";
    if (file) applyFallbackTitle(file);
    updateMetadataPreview();
    uploadStatus.textContent = "";
    showFile();
    if (!file) {
      identifyStatus.textContent = "选择文件后识别书名、作者和分类。";
      return;
    }
    maybeIdentifyCurrentFile();
  });
  for (const input of metadataInputs)
    input.addEventListener("input", () => {
      dirtyFields.add(input);
      updateMetadataPreview();
    });

  const loadBooks = async (cursor = currentCursor, history = cursorHistory) => {
    if (!scope.active || !authenticated) return;
    const epoch = authEpoch;
    const generation = ++pageGeneration;
    previousPage.disabled = true;
    nextPage.disabled = true;
    let result;
    try {
      result = await api(
        `/api/manage${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
    } catch (error) {
      if (
        !scope.active ||
        !authenticated ||
        epoch !== authEpoch ||
        generation !== pageGeneration
      )
        return;
      throw error;
    }
    if (
      !scope.active ||
      !authenticated ||
      epoch !== authEpoch ||
      generation !== pageGeneration
    )
      return;
    const page = result.pagination;
    const paginated = page?.mode === "keyset-v1";
    if (
      paginated &&
      (!Number.isSafeInteger(page.returned) ||
        page.returned < 0 ||
        page.returned > 100 ||
        page.pageSize !== 100 ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(page.nextCursor) ||
            page.nextCursor <= cursor)))
    )
      throw new Error("分页状态无法核对，请重新载入。 ");
    currentCursor = paginated ? cursor : "";
    cursorHistory = paginated ? [...history] : [];
    nextCursor = paginated ? page.nextCursor : null;
    pagination.hidden = !paginated;
    previousPage.disabled = !cursorHistory.length;
    nextPage.disabled = nextCursor === null;
    pageLabel.textContent = `第 ${cursorHistory.length + 1} 页 · 每页最多 100 本`;
    booksList.replaceChildren();
    trashList.replaceChildren();
    const entries = Array.isArray(result.books) ? result.books : [];
    const current = entries.filter((entry: ManagementEntry) => !entry.trashed);
    const trashed = entries.filter((entry: ManagementEntry) => entry.trashed);
    byId<HTMLElement>("books-count").textContent =
      `${paginated ? "本页 " : ""}${current.length} 本`;
    byId<HTMLElement>("trash-count").textContent =
      `${paginated ? "本页 " : ""}${trashed.length} 本`;
    booksStatus.textContent = current.length
      ? "只对当前所有者会话显示。"
      : paginated
        ? "本页没有当前书籍，可翻页查看。"
        : "书库还是空的，可以在上方登记新书。";
    byId<HTMLParagraphElement>("trash-status").textContent = trashed.length
      ? "书籍可恢复到当前书库。"
      : paginated
        ? "本页没有回收站书籍。"
        : "回收站为空。";
    for (const entry of current)
      renderEntry(entry, booksList, () => loadBooks());
    for (const entry of trashed)
      renderEntry(entry, trashList, () => loadBooks());
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
    identifyConfig = result.identify || {
      enabled: false,
      code: "identify_unavailable",
    };
    identifyStatus.textContent =
      managementIdentifyCapabilityText(identifyConfig);
    requiresRefresh = false;
    showFile();
    maybeIdentifyCurrentFile();
  };

  const navigate = async (cursor: string, history: string[]) => {
    try {
      await loadBooks(cursor, history);
    } catch (error) {
      if (!scope.active) return;
      booksStatus.textContent = `${errorText(error)} 本页状态未确认，请重新核对书库。`;
      requiresRefresh = true;
      updateSubmit();
    }
  };
  previousPage.addEventListener("click", () => {
    if (previousPage.disabled || !cursorHistory.length) return;
    void navigate(cursorHistory.at(-1)!, cursorHistory.slice(0, -1));
  });
  nextPage.addEventListener("click", () => {
    if (nextPage.disabled || nextCursor === null) return;
    void navigate(nextCursor, [...cursorHistory, currentCursor]);
  });

  byId<HTMLButtonElement>("manage-reload").addEventListener(
    "click",
    async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      booksStatus.textContent = "正在重新核对私人书库…";
      const pending = loadBooks();
      const generation = pageGeneration;
      try {
        await pending;
        if (!scope.active || generation !== pageGeneration) return;
        booksStatus.textContent = "书库状态已重新核对。";
      } catch (error) {
        if (!scope.active) return;
        booksStatus.textContent = `${errorText(error)} 书库状态仍未确认。`;
        requiresRefresh = true;
        if (
          (error as any)?.code === "unauthorized" ||
          (error as any)?.code === "authentication_required"
        ) {
          authEpoch++;
          authenticated = false;
          loginCta.hidden = false;
          capability.textContent = "登录状态已失效。请重新登录后再操作。";
        }
      } finally {
        button.disabled = !scope.active;
        updateSubmit();
      }
    },
  );

  void (async () => {
    const epoch = authEpoch;
    try {
      const current = await api("/api/session");
      if (!scope.active || epoch !== authEpoch) return;
      sessionChecked = true;
      if (current.authenticated !== true) {
        authEpoch++;
        authenticated = false;
        booksStatus.textContent =
          "私人书库需要所有者登录。请先登录后再打开管理页。";
        capability.textContent = "先登录所有者账号后才能识别文件名或上传。";
        loginCta.hidden = false;
        updateSubmit();
        maybeIdentifyCurrentFile();
        return;
      }
      authenticated = true;
      scope.setAuthenticated(true);
      loginCta.hidden = true;
      updateSubmit();
      await loadBooks();
    } catch (error) {
      if (!scope.active || epoch !== authEpoch) return;
      sessionChecked = true;
      authenticated = false;
      booksStatus.textContent = `${errorText(error)} 私人书库未加载，管理操作保持关闭。`;
      capability.textContent =
        "暂时无法确认后端能力；文件不会发送。请从账户页检查登录与连接。";
      loginCta.hidden = false;
      updateSubmit();
      maybeIdentifyCurrentFile();
    }
  })();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (identifyPending) {
      uploadStatus.textContent =
        "正在识别文件名，请稍候；识别完成前不会登记上传。";
      return;
    }
    if (!authenticated) {
      uploadStatus.textContent = "请先登录所有者账号。文件未发送。";
      loginCta.hidden = false;
      return;
    }
    if (!uploadReady || busy) {
      uploadStatus.textContent =
        "上传暂不可用；文件未发送。请查看上方具体原因。";
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
    const title = (titleInput.value.trim() || filenameTitle(file!.name)).slice(
      0,
      240,
    );
    busy = true;
    updateSubmit();
    uploadStatus.textContent = "正在本机计算文件校验值；尚未发送文件内容…";
    try {
      const sha256 = await hashFile(file!);
      const descriptor = await api("/api/manage/uploads", {
        title,
        author: authorInput.value.trim() || null,
        category: categoryInput.value.trim(),
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
        selectionGeneration++;
        currentFile = null;
        currentFileKey = "";
        dirtyFields.clear();
        identifyStatus.textContent = "选择文件后识别书名、作者和分类。";
        identifyPending = false;
        updateMetadataPreview();
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
          selectionGeneration++;
          currentFile = null;
          currentFileKey = "";
          dirtyFields.clear();
          identifyStatus.textContent = "选择文件后识别书名、作者和分类。";
          updateMetadataPreview();
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
      if (
        (error as any)?.code === "unauthorized" ||
        (error as any)?.code === "authentication_required"
      ) {
        authEpoch++;
        authenticated = false;
        loginCta.hidden = false;
        capability.textContent = "登录状态已失效。请重新登录后再操作。";
      }
      uploadStatus.textContent = `${errorText(error)} 如请求状态不确定，请先刷新书库核对，页面不会自动重试。`;
      if (
        uploadStatus.textContent.includes("不确定") ||
        uploadStatus.textContent.includes("勿再次提交") ||
        (error as any)?.code === "upload_uncertain"
      )
        requiresRefresh = true;
    } finally {
      busy = false;
      updateSubmit();
      showFile();
      maybeIdentifyCurrentFile();
    }
  });
}
