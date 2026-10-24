import {
  canAccessFile,
  fileExplanation,
  fileStatus,
} from "./file-availability.mjs";
import { supportsBrowserReader } from "./reader-formats.mjs";

// Reconcile server state with the fixed descriptors rendered into the page.
export function fileActions({
  root = document,
  bookId,
  mode = "",
  readBase = "",
  onDownload,
  replaceInitial = false,
}) {
  const rows = [...root.querySelectorAll("[data-file-row]")];
  const ownerDocument = root.ownerDocument || document;
  const byId = new Map();
  for (const row of rows) {
    const id = row.dataset.fileId;
    if (!id) continue;
    const group = byId.get(id) || [];
    group.push(row);
    byId.set(id, group);
  }

  return {
    apply(files) {
      for (const row of rows) {
        row
          .querySelectorAll("[data-dynamic-file-action]")
          .forEach((el) => el.remove());
        if (mode === "same-origin" || replaceInitial)
          row
            .querySelectorAll("[data-file-initial-action]")
            .forEach((el) => el.remove());
      }
      if (mode === "same-origin") {
        for (const row of rows) {
          const status = row.querySelector("[data-file-status]");
          const explanation = row.querySelector("[data-file-explanation]");
          if (status) status.textContent = "状态待核对";
          if (explanation)
            explanation.textContent =
              "当前文件状态暂不可核对，在线授权入口已隐藏，请刷新后重试。";
        }
      }
      if (!Array.isArray(files)) return;

      const counts = new Map();
      for (const file of files) {
        if (file && typeof file.id === "string")
          counts.set(file.id, (counts.get(file.id) || 0) + 1);
      }
      for (const [id, matchingRows] of byId) {
        if (matchingRows.length !== 1 || counts.get(id) !== 1) continue;
        const row = matchingRows[0];
        const format = row.dataset.fileFormat;
        const sizeBytes = Number(row.dataset.fileSize);
        const file = files.find((item) => item?.id === id);
        if (!file || file.format !== format || file.sizeBytes !== sizeBytes)
          continue;

        const status = row.querySelector("[data-file-status]");
        if (status) status.textContent = fileStatus(file);
        const explanation = row.querySelector("[data-file-explanation]");
        if (explanation) explanation.textContent = fileExplanation(file, mode);
        if (
          (mode !== "same-origin" && !replaceInitial) ||
          !canAccessFile(file, mode)
        )
          continue;

        const actions = row.querySelector("[data-file-actions]");
        if (!actions) continue;
        const read = ownerDocument.createElement("a");
        read.className = "button";
        read.dataset.dynamicFileAction = "";
        read.href = `${readBase}read/?book=${encodeURIComponent(bookId)}&file=${encodeURIComponent(id)}`;
        read.textContent = supportsBrowserReader(file.format)
          ? "授权阅读 →"
          : "下载原文件 →";
        actions.append(read);

        const download = ownerDocument.createElement("button");
        download.type = "button";
        download.dataset.dynamicFileAction = "";
        download.dataset.download = id;
        download.textContent = "授权下载 ↓";
        download.onclick = () => onDownload?.(id, download);
        actions.append(download);
      }
    },
  };
}
