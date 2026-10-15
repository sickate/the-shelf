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
