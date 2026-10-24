# MVP 计划（2026-10-24，Claude 接手）

## 目标

尽快上线一个可用、可测试的最小书库：

1. 所有者登录（单一密码）。
2. 书架：列出全部已登记书籍，按分类、关键字筛选；显示格式、大小、是否已上传云端。
3. 在线阅读：PDF（pdf.js）、EPUB（epub.js）、TXT；其他格式可下载。仅所有者可读/下载。
4. 批量上传：本机脚本把 `books/` 中已复制完整、≤20,000,000 bytes 的书籍传到私有 R2；超过 20 MB 的只登记目录、不上传。
5. 网页单本上传（所有者）。

## 明确不做

AI、正文准备、公开文件、多用户、旧 CF01/CF03/trial 迁移链路、旧 Astro 静态站的继续维护（保留代码作历史与回退，不删除）。

## 约束（来自 AGENTS.md，继续遵守）

- 单文件 ≤ 20,000,000 bytes；全部登记的上传责任合计 ≤ 8,000,000,000 bytes（含 100 MB 旧责任保守余量）。预算在 D1 中原子检查。
- 文件默认私有；所有读取需所有者会话。POST/PUT/DELETE 校验 Origin。
- 删除只做软删除，不释放对象或预算。
- 凭证只放被忽略的 `.env`（0600），不进 Git。

## 架构

- 新目录 `app/`，独立于旧代码：
  - `app/worker.mjs`：Cloudflare Worker（名称仍为 `the-shelf`，主站 URL 不变），静态资源 + `/api/*`。
  - `app/schema.sql`：D1 新库 `the-shelf-app`。
  - `app/web/`：前端源码（原生 TS/JS，esbuild 打包到 `app/dist/`），依赖已有的 `pdfjs-dist`、`epubjs`。
  - `app/wrangler.jsonc`：D1 绑定 `DB`、R2 绑定 `BOOKS`（隔离私有桶 `the-shelf-first-book-20261023`）、assets 绑定 `ASSETS`，`run_worker_first: ["/api/*"]`。
  - 机密：`OWNER_PASSWORD`、`SESSION_SECRET`（`wrangler secret put`）。
- `scripts/mvp-upload.mjs`：批量上传脚本，走 Worker HTTP API（与网页上传同一预算/去重路径）。

## API 契约

所有响应 JSON（文件除外），`Cache-Control: no-store`。错误 `{error:"code"}`。

| 方法 路径 | 权限 | 说明 |
| --- | --- | --- |
| POST /api/login `{password}` | 公开 | 成功设置 `shelf_session` cookie（HMAC 签名，30 天，HttpOnly Secure SameSite=Lax），返回 `{ok:true}`；失败 401 |
| POST /api/logout | 任意 | 清 cookie |
| GET /api/me | 公开 | `{owner:boolean}` |
| GET /api/books | 公开 | `{books:[{id,title,category,format,sizeBytes,status,createdAt}], categories:[...]}`，不含原始路径/哈希/key；status ∈ `uploaded`、`local_only` |
| GET /api/books/:id | 公开 | 单本元数据 |
| GET /api/books/:id/file | 所有者 | 从 R2 流式返回，支持 Range/HEAD，`Content-Disposition: inline`（`?download=1` 为 attachment） |
| PUT /api/upload | 所有者 | 原始字节 body；头 `X-Shelf-Path`（URL 编码的相对路径，如 `01-计算机与技术/x.pdf`），`X-Shelf-Sha256`。服务端校验大小、格式、hash，检查去重和预算后写 R2，返回 `{book, duplicate:boolean}` |
| POST /api/catalog `{path, sizeBytes}` | 所有者 | 只登记目录（`local_only`），用于 >20 MB 的书 |
| DELETE /api/books/:id | 所有者 | 软删除 |
| GET /api/budget | 所有者 | `{usedBytes, limitBytes}` |

脚本鉴权：先 POST /api/login 取得 cookie。

## 分工

| 任务 | 模型 | 依赖 |
| --- | --- | --- |
| A. Worker + schema + 单元测试（鉴权、预算、Range） | Opus 5.5 | 本契约 |
| B. 前端书架/阅读/上传页 + 构建脚本 | Opus 5.5 | 本契约 |
| C. 批量上传脚本 | Sonnet 5.5 | 本契约 |

主 Agent：review、本地 `wrangler dev` 联调、创建 D1/机密、部署、真实上传与阅读验收。

## 验收

- 本地：`node --test tests/mvp-*.test.mjs` 通过；`wrangler dev` 下登录、列表、上传、PDF/EPUB 阅读、Range、未登录 401。
- 线上：部署后同样流程；批量上传已完整的书；浏览器打开阅读。

## 部署与回退

`npm run app:deploy`（构建 + `wrangler deploy -c app/wrangler.jsonc`）。回退：`npx wrangler rollback efd364e0-c75d-495f-b717-fc55d74b5c99 --name the-shelf`（旧静态站版本）。

## 后续（第二天）

Garage 复制完成后再次运行 `node scripts/mvp-upload.mjs`，脚本自动跳过已上传（按 sha256 去重）。

## 上线状态（2026-10-24）

- 已部署 Worker 版本 `180fa0ab-9aaf-454b-b84a-16226db2e7ad` 到主站，D1 `the-shelf-app`，R2 隔离桶。
- 线上冒烟通过：未登录读文件 401、错误密码 401、登录、上传、重复去重、Range 206、全文 hash 一致。
- 本机 macOS 12 无法运行 workerd，单元测试使用 Node SQLite + 内存 R2 假实现（14/14）。
- 批量上传：已复制完整的书已开始上传；Garage 复制完成后重跑 `npm run app:upload`。
