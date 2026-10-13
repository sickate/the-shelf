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
});
export const explainCode = (code: string) => messages[code] || code;
const configured = import.meta.env.PUBLIC_SHELF_API_URL;
const localHost =
  typeof location !== "undefined" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
export const apiBase = (
  configured || (localHost ? "http://127.0.0.1:8787" : "")
).replace(/\/$/, "");
export let csrfToken: string | null = null;
export async function api(route: string, body?: any) {
  if (!apiBase)
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
    throw new Error(
      configured
        ? "无法连接业务后端，请检查服务与网站来源设置。"
        : "业务后端尚未连接。请启动本机 127.0.0.1:8787 服务，或配置 PUBLIC_SHELF_API_URL。",
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code =
      typeof data.error === "string"
        ? data.error
        : data.error?.code || data.code;
    throw new Error(
      messages[code] ||
        data.error?.message ||
        data.message ||
        code ||
        `请求失败 (${response.status})`,
    );
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
