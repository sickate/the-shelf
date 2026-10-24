import { canonicalId } from "./book-navigation.mjs";
import { fileExplanation, fileStatus } from "./file-availability.mjs";

// All strings from the single-book API become text nodes; no HTML parsing.
export function renderBookFiles(root, files, mode = "") {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const counts = new Map();
  for (const file of files)
    if (canonicalId(file?.id))
      counts.set(file.id, (counts.get(file.id) || 0) + 1);
  for (const file of files) {
    if (
      !canonicalId(file?.id) ||
      counts.get(file.id) !== 1 ||
      typeof file.format !== "string" ||
      !/^[A-Z0-9]{1,12}$/.test(file.format) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0
    )
      continue;
    const row = doc.createElement("div");
    row.className = "file-row";
    Object.assign(row.dataset, {
      fileRow: "",
      fileId: file.id,
      fileFormat: file.format,
      fileSize: String(file.sizeBytes),
    });
    const details = doc.createElement("div");
    const heading = doc.createElement("strong");
    heading.textContent = file.format;
    const size = doc.createElement("span");
    size.className = "muted";
    size.textContent = ` · ${(file.sizeBytes / 1_000_000).toFixed(2)} MB`;
    const note = doc.createElement("p");
    const status = doc.createElement("span");
    status.dataset.fileStatus = "";
    status.textContent = fileStatus(file);
    const explanation = doc.createElement("span");
    explanation.dataset.fileExplanation = "";
    explanation.textContent = fileExplanation(file, mode);
    note.append(status, doc.createElement("br"), explanation);
    details.append(heading, size, note);
    const actions = doc.createElement("div");
    actions.className = "file-actions";
    actions.dataset.fileActions = "";
    row.append(details, actions);
    root.append(row);
  }
}
