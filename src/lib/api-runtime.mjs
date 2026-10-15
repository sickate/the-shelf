// Public runtime selection is explicit: an empty URL never enables production API.
export function resolveApi({
  mode = "",
  configured = "",
  hostname = "",
  origin = "",
} = {}) {
  if (mode === "disabled")
    return { enabled: false, base: "", scheme: "password" };
  if (mode === "same-origin")
    return { enabled: true, base: origin, scheme: "owner-access-key" };
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  const base = (configured || (local ? "http://127.0.0.1:8787" : "")).replace(
    /\/$/,
    "",
  );
  return { enabled: Boolean(base), base, scheme: "password" };
}

export async function fetchAuthorizedFile(
  fileId,
  { api, resolveUrl, fetcher = fetch, now = Date.now } = {},
) {
  const route = `/api/files/${encodeURIComponent(fileId)}/access`;
  let access = await api(route);
  let refreshed = false;
  const nearExpiry = () =>
    Number.isFinite(Date.parse(access.expiresAt)) &&
    Date.parse(access.expiresAt) <= now() + 30_000;
  if (nearExpiry()) {
    access = await api(route);
    refreshed = true;
  }
  let response = await fetcher(resolveUrl(access.url), {
    credentials: access.mode === "r2" ? "omit" : "include",
    referrerPolicy: "no-referrer",
  });
  // Only an expiring bearer URL may be refreshed. Revocation and policy failures are final.
  if (response.status === 403 && !refreshed && nearExpiry()) {
    await response.body?.cancel();
    access = await api(route);
    refreshed = true;
    response = await fetcher(resolveUrl(access.url), {
      credentials: access.mode === "r2" ? "omit" : "include",
      referrerPolicy: "no-referrer",
    });
  }
  if (!response.ok) throw new Error(`文件读取失败 (${response.status})`);
  const mime = response.headers.get("content-type") || "";
  if (mime.includes("json") || mime.includes("text/html"))
    throw new Error("文件入口返回了错误的内容类型，无法打开。");
  return { response, access };
}

export function runtimeMessages(runtime, configured) {
  return runtime.scheme === "owner-access-key"
    ? {
        invalidCredentials: "所有者访问密钥不正确，或在线登录尚未启用。",
        unreachable: "在线服务暂时无法连接，请稍后再试。",
      }
    : {
        invalidCredentials: "密码不正确，或所有者密码尚未配置。",
        unreachable: configured
          ? "无法连接业务后端，请检查服务与网站来源设置。"
          : "业务后端尚未连接。请启动本机 127.0.0.1:8787 服务，或配置 PUBLIC_SHELF_API_URL。",
      };
}
