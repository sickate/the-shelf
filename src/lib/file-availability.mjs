import { supportsBrowserReader } from "./reader-formats.mjs";

// A cloud snapshot sets uploaded only after matching its confirmed descriptor.
export function canAccessFile(file, mode = "") {
  if (mode === "disabled") return false;
  // The local Node backend remains responsible for authorizing existing candidate formats.
  if (mode === "") return file?.status === "candidate";
  if (
    !file ||
    file.status !== "candidate" ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 0 ||
    file.sizeBytes > 20_000_000 ||
    !/^[\w-]{1,128}$/.test(file.id) ||
    !["PDF", "EPUB", "MOBI", "AZW", "AZW3"].includes(file.format) ||
    file.visibility !== "private"
  )
    return false;
  if (mode === "same-origin") return file.reason === "uploaded";
  return false;
}
export function fileStatus(file) {
  return file.status === "local_only"
    ? "仅本地 · 暂缓上传"
    : file.status === "unavailable"
      ? "文件异常"
      : file.status === "candidate" && file.reason === "uploaded"
        ? "已上传 · 私有"
        : file.reason === "not_uploaded" || file.status === "candidate"
          ? "待上传 · 私有"
          : "仅所有者可用";
}

export function fileExplanation(file, mode = "") {
  if (file?.reason === "size") return "超过 20 MB 门槛，暂不上传或在线读取。";
  if (file?.reason === "empty") return "文件为空，无法读取。";
  if (mode === "same-origin") {
    if (canAccessFile(file, mode))
      return "文件已确认上传；读取与下载仍需所有者会话授权。";
    if (file?.reason === "not_uploaded")
      return "等待上传；目前不能在线阅读或下载。";
  } else if (file?.reason === "not_uploaded" && mode) {
    return "等待上传；目前不能在线阅读或下载。";
  }
  if (supportsBrowserReader(file?.format)) {
    return ["MOBI", "AZW", "AZW3"].includes(file.format)
      ? "支持无 DRM 的浏览器文字阅读；HUFF/CDIC 压缩文件需先在本机转换。"
      : "支持浏览器阅读；打开时会核对文件格式与完整性。";
  }
  return "浏览器不直接支持此格式；可下载原文件，使用 Calibre 转为 EPUB。";
}
