export const MANAGE_FORMATS = ["PDF", "EPUB", "MOBI", "AZW", "AZW3"];
export const MANAGE_MAX_BYTES = 20_000_000;

const EXTENSIONS = new Map(
  MANAGE_FORMATS.map((format) => [format.toLowerCase(), format]),
);

export function formatForFilename(name = "") {
  const extension = String(name).split(".").at(-1)?.toLowerCase();
  return EXTENSIONS.get(extension) || null;
}

export function validateUploadFile(
  file,
  formats = MANAGE_FORMATS,
  maxBytes = MANAGE_MAX_BYTES,
) {
  if (!file || typeof file.size !== "number") return "请选择一本书的文件。";
  if (file.size <= 0) return "空文件不能上传。";
  if (!Number.isSafeInteger(file.size) || file.size > maxBytes)
    return `文件超过 ${Math.floor(maxBytes / 1_000_000)} MB 单文件上限。`;
  const format = formatForFilename(file.name);
  if (!format || !formats.includes(format))
    return "仅支持 PDF、EPUB、MOBI、AZW 和 AZW3 文件。";
  return null;
}

export function canSubmitUploadBytes(intent) {
  return intent?.state === "reserved" && intent.canSubmit === true;
}

export function managementUploadStatus(upload) {
  const labels = {
    reserved: "上传记录已建立，文件内容尚未确认。页面不会自动重传。",
    uploading: "文件写入处理中，状态待确认；请勿再次提交。",
    uncertain: "上传结果不确定；请勿再次提交同一文件，需先核对服务端状态。",
    confirmed: "原件已完成私有存储确认。",
  };
  return labels[upload?.state] || "上传状态待核对。";
}

export function managementCapabilityText(upload) {
  const reasons = Array.isArray(upload?.reasons) ? upload.reasons : [];
  const labels = {
    authority_not_ready: "上传前的存储用量核对尚未完成",
    storage_target_mismatch: "普通上传存储尚未启用",
    account_evidence_stale: "账号存储用量证据已过期或尚未确认",
    storage_budget_exceeded: "项目总存储预算不足以容纳新文件",
    normal_upload_storage_unconfigured: "普通上传使用的私有存储尚未配置",
    authority_unavailable: "暂时无法核对存储用量",
    authority_accounting_mismatch: "存储用量暂时无法核实",
  };
  if (upload?.enabled === true && upload.code === "ready")
    return "上传能力已就绪。文件将逐本登记并写入私人书库。";
  if (reasons.length)
    return `上传暂不可用：${reasons.map((reason) => labels[reason] || "上传条件尚未满足").join("；")}。原文件内容不会发送。`;
  return "上传暂不可用：服务端尚未确认普通上传条件。原文件内容不会发送。";
}

export function managementIdentifyCapabilityText(identify) {
  const messages = {
    identify_unconfigured: "AI识别服务尚未配置。",
    ai_unconfigured: "AI识别服务尚未配置。",
    identify_daily_budget: "今日文件名识别额度已用完。",
    call_budget_exceeded: "今日文件名识别额度已用完。",
    identify_busy: "文件名识别服务正忙，请稍后再试。",
    identify_reconciliation_required:
      "已有识别任务状态待核对；页面不会自动重新提交。",
    identify_schema_unavailable: "文件名识别配置暂不可用。",
    identify_unavailable: "文件名识别服务暂不可用。",
  };
  if (identify?.enabled === true) return "文件名识别已就绪。";
  return `文件名识别暂不可用：${messages[identify?.code] || "服务端尚未开放识别。"}`;
}

export function filenameTitle(filename = "") {
  const name = String(filename).split(/[\\/]/).pop() || "";
  const title = name.replace(/\.[^.]+$/, "").trim();
  return title || "未命名书籍";
}

export function bookTitle(book) {
  return typeof book?.title === "string" && book.title.trim()
    ? book.title
    : "未命名书籍";
}
