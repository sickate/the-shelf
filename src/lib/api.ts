import {
  resolveApi,
  fetchAuthorizedFile,
  runtimeMessages,
} from "./api-runtime.mjs";
const messages: Record<string, string> = {
  unauthorized: "请先登录所有者账号。",
  authentication_required: "请先登录所有者账号。",
  invalid_credentials: "密码不正确，或所有者密码尚未配置。",
  files_unconfigured: "文件服务尚未配置。待上传记录当前不能在线读取。",
  file_ineligible: "此文件不符合读取门槛，暂时只能查看目录信息。",
  file_not_found: "私人文件映射尚未准备，无法读取此文件。",
  ai_unconfigured: "AI 服务尚未配置。",
  text_unavailable: "此书尚未准备可用正文，暂时无法回答书内问题。",
  author_unknown: "目录未标注作者，无法整理作者资料。",
  call_budget_exceeded: "本次或今日调用额度已用完。",
};
Object.assign(messages, {
  csrf_invalid: "会话校验已失效，请重新登录。",
  origin_forbidden: "此网站来源尚未获后端允许，请检查来源配置。",
  invalid_metadata: "书籍信息格式不正确，请检查书名、作者、分类和标签。",
  metadata_conflict:
    "此书已在其他页面修改。你的输入已保留，请重新载入最新版本后再编辑。",
  rate_limited: "请求过于频繁，请稍后再试。",
  local_files_disabled: "后端尚未启用本机文件读取。",
  source_text_unavailable: "此书尚未准备可用正文，暂时无法生成书内总结。",
  author_source_unavailable: "暂时无法取得可靠作者资料，请稍后再试。",
  author_identity_unconfirmed:
    "来源尚不能确认作者与这本书的关系，请核对作者信息。",
  chapter_not_found: "未找到所选章节，请检查章节名称。",
  no_relevant_source: "未找到与问题相关的正文依据。",
  queue_full: "任务队列已满，请稍后重试。",
  upstream_uncertain: "上游任务状态不确定；结果已保存，请稍后检查。",
  pdf_extraction_unavailable: "PDF 正文提取工具尚未准备。",
  file_changed: "源文件与登记信息不一致，请重新导入后再试。",
  file_unavailable: "源文件当前不可用。",
  prepared_pin_invalid: "尚未准备并选定可用正文版本，请先准备并选择正文。",
  prepared_source_mismatch: "来源记录已变化，请重新准备正文。",
  prepared_selection_conflict: "正文选择刚刚发生变化，请刷新后重新选择。",
  prepared_replace_required: "已有正文版本需要明确替换后才能继续。",
  prepared_package_unavailable:
    "已选正文版本不可用或校验失败，请重新准备并选择。",
  prepared_permissions:
    "无法安全读取已选正文版本，请检查本机权限后重新准备并选择。",
  prepared_unsafe_path:
    "正文文件位置不安全，已停止读取；请重新准备并选择正文。",
  prepared_changed: "正文版本在读取时发生变化，请重新准备并选择。",
  prepared_io_failed: "读取正文版本时遇到本机错误，请稍后重新准备并选择。",
  prepared_text_invalid: "正文版本校验失败，请重新准备并选择。",
  prepared_text_invalid_bytes: "正文版本校验失败，请重新准备并选择。",
  prepared_text_size_limit: "正文版本超过可读取大小，请重新准备并选择。",
  prepared_text_invalid_expected:
    "尚未准备并选定可用正文版本，请先准备并选择正文。",
  prepared_text_invalid_encoding: "正文版本校验失败，请重新准备并选择。",
  prepared_text_source_mismatch: "来源记录已变化，请重新准备正文。",
  prepared_text_hash_mismatch: "已选正文版本校验失败，请重新准备并选择。",
  prepared_text_noncanonical: "已选正文版本校验失败，请重新准备并选择。",
  invalid_text_retrieval: "正文检索请求无效，请刷新后重试。",
});
export const explainCode = (code: string) => messages[code] || code;
const configured = import.meta.env.PUBLIC_SHELF_API_URL;
const runtime = resolveApi({
  mode: import.meta.env.PUBLIC_SHELF_API_MODE,
  configured,
  hostname: typeof location === "undefined" ? "" : location.hostname,
  origin: typeof location === "undefined" ? "" : location.origin,
});
const runtimeText = runtimeMessages(runtime, configured);
messages.invalid_credentials = runtimeText.invalidCredentials;
export const apiBase = runtime.base;
export const defaultAuthScheme = runtime.scheme;
export let csrfToken: string | null = null;
export async function api(route: string, body?: any) {
  if (!runtime.enabled)
    throw new Error(
      "在线服务尚未连接。公开目录与文档仍可阅读；所有者需配置业务后端地址。",
    );
  let response: Response;
  try {
    response = await fetch(apiBase + route, {
      credentials: "include",
      ...(body !== undefined
        ? {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
            },
            body: JSON.stringify(body),
          }
        : {}),
    });
  } catch {
    throw new Error(runtimeText.unreachable);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code =
      typeof data.error === "string"
        ? data.error
        : data.error?.code || data.code;
    const failure = new Error(
      messages[code] ||
        data.error?.message ||
        data.message ||
        code ||
        `请求失败 (${response.status})`,
    );
    Object.assign(failure, { code, status: response.status });
    throw failure;
  }
  if ("csrfToken" in data) csrfToken = data.csrfToken;
  return data;
}
export async function session() {
  return api("/api/session");
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const accessUrl = (url: string) => new URL(url, apiBase + "/").href;

export const fetchFile = (fileId: string) =>
  fetchAuthorizedFile(fileId, { api, resolveUrl: accessUrl });

// Binary mutation is limited to an API-returned same-origin upload route. Never retry.
export async function apiBinary(
  route: string,
  bytes: Uint8Array | ArrayBuffer | Blob,
) {
  if (!runtime.enabled) throw new Error("在线服务尚未连接。");
  if (!/^\/api\/manage\/uploads\/[\w-]{1,100}\/bytes$/.test(route))
    throw new Error("上传地址无效。");
  if (!csrfToken) throw new Error(messages.authentication_required);
  let response: Response;
  try {
    response = await fetch(apiBase + route, {
      method: "POST",
      credentials: "include",
      redirect: "error",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-CSRF-Token": csrfToken,
      },
      body:
        bytes instanceof Uint8Array ? new Blob([new Uint8Array(bytes)]) : bytes,
    });
  } catch {
    const failure = new Error(
      "上传结果尚未确认，请刷新管理页核对，勿再次提交文件。",
    );
    Object.assign(failure, { code: "upload_uncertain" });
    throw failure;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code =
      typeof data.error === "string"
        ? data.error
        : data.error?.code || data.code;
    const failure = new Error(
      messages[code] || code || `请求失败 (${response.status})`,
    );
    Object.assign(failure, { code, status: response.status, details: data });
    throw failure;
  }
  return data;
}
