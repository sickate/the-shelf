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
| GET /api/me | 公开 | `{owner:boolean}`（2026-10-27 起 Google 会话另含 `email`） |
| GET /api/books | 公开 | `{books:[{id,title,category,format,sizeBytes,status,createdAt}], categories:[...]}`，不含原始路径/哈希/key；status ∈ `uploaded`、`local_only` |
| GET /api/books/:id | 公开 | 单本元数据 |
| GET /api/books/:id/file | 所有者 | 从 R2 流式返回，支持 Range/HEAD，`Content-Disposition: inline`（`?download=1` 为 attachment） |
| PUT /api/upload | 所有者 | 原始字节 body；头 `X-Shelf-Path`（URL 编码的相对路径，如 `01-计算机与技术/x.pdf`），`X-Shelf-Sha256`。服务端校验大小、格式、hash，检查去重和预算后写 R2，返回 `{book, duplicate:boolean}` |
| POST /api/catalog `{path, sizeBytes}` | 所有者 | 只登记目录（`local_only`），用于 >20 MB 的书 |
| DELETE /api/books/:id | 所有者 | 软删除 |
| GET /api/budget | 所有者 | `{usedBytes, limitBytes, legacyReserveBytes, coverBytes}`；used = 有 r2_key 的书 + 封面 + 100 MB 旧责任余量 |

### 2026-10-24 功能增量（`docs/features-plan-2026-10-24.md`，迁移 `app/migrations/0002_features.sql`）

| 方法 路径 | 权限 | 说明 |
| --- | --- | --- |
| GET /api/books | 公开 | 所有者会话下每本额外返回 `hasCover`、`hasInfo`（有可读 AI 详情）、`authors`（AI 详情作者名数组）；访客响应形状不变 |
| POST /api/upload/check `{files:[{path,sizeBytes,sha256}]}` | 所有者 | 1–200 条，返回 `{files:[{path,ok,reason?,warning?,existingBookId?,existingTitle?}], remainingBytes}`。reason：`bad_path`、`unsupported_format`、`bad_size`、`empty_file`、`too_large`、`bad_sha256`、`duplicate`、`duplicate_in_batch`、`budget_exceeded`（按批内顺序累计）；`duplicate_deleted` 为 ok:true 提示（上传即恢复，不占新预算）；`warning: similar_title`（同名不同内容）。只是预判，不写入 |
| PUT /api/books/:id/cover | 所有者 | body 为 `image/webp` 或 `image/jpeg`，≤200,000 bytes，校验魔数；可选头 `X-Shelf-Width/Height`（1–4000）。书须为 uploaded 且未删除。首写 key `covers/<id>.webp|.jpg`，之后覆盖写沿用同一 key（Content-Type 存在 R2 元数据）。预算原子检查：覆盖只计增量，R2 确认前按 max(旧,新) 保留；失败 502 `storage_unknown` 不自动重试；超预算 507 |
| GET /api/books/:id/cover | 所有者 | 正确 Content-Type，`Cache-Control: private, max-age=86400`，ETag（大小+时间），`If-None-Match` → 304 |
| GET /api/books/:id/info | 所有者 | `{status:'none'|'generating'|'ready'|'failed', info?, model?, inputKind?, error?, updatedAt?}`；过期租约按 failed（或保留的旧 ready）显示 |
| POST /api/books/:id/info[?force=1] `{excerpt?}` | 所有者 | body ≤64 KB，摘录截断 12,000 字。已 ready 且非 force 直接返回。单飞租约 15 分钟，冲突 409 `generating`。先 DeepSeek Search（`DEEPSEEK_KEY`，2 次、每次 20 s，失败降级，401/402 记 `search_auth`/`search_balance`），再 oai `/v1/tasks`（`gpt-luna` medium json_object，600 s）。503 → 释放租约、返回 503 `ai_busy` 并透传 `Retry-After`（默认 10）；其他失败 502 `{error:'ai_failed', reason}`（`ai_bad_output`、`ai_http_<n>`、`ai_timeout`、`ai_network`、`ai_bad_response`）。服务端严格校验输出，sources 只保留检索资料中的 URL；失败不写半截结果，force 重生成失败时保留旧结果。均不自动重试 |

### 2026-10-25 中图法分级分类（`docs/classification-plan-2026-10-24.md`，迁移 `app/migrations/0003_classification.sql`、`0004_doc_type.sql`）

分类信息对访客公开（AI 简介仍仅所有者可见）。分类表 `app/clc.json`（§10 契约）随 Worker 打包；写入的分类号都按表内最长前缀解析。

| 方法 路径 | 权限 | 说明 |
| --- | --- | --- |
| GET /api/books | 公开 | 每本增加 `clc`（主分类号或 null）与 `docType`（资料类型，未归类为 null；迁移前已归类的条目也为 null，按图书处理），访客与所有者相同；所有者附加字段不变 |
| GET /api/books/:id | 公开 | 增加 `clc`、`clcPath:[{code,name}]`（根→节点）、`clcSecondary`、`clcSource`（`cip`/`ai`/`manual`）、`clcConfidence`、`clcReason`、`clcEvidenceUrl`、`clcStatus`（`none`/`generating`/`ready`/`failed`）、`docType`；所有者另有 `clcError`。不含 AI 简介 |
| GET /api/clc | 公开 | `{edition, nodes:[{code,name,parent,count}], docTypes:{book,course,paper,articles,manual,other}, unclassified, total}`：只含可见书目（未删除、非 reserved）用到的节点及其祖先，count 含子孙；`nodes`（含其是否出现）只统计 `docType` 为 `book` 或 null 的条目，非书资料只计入 `docTypes`；`docTypes` 各项之和 + `unclassified` = `total`；`Cache-Control: public, max-age=60` |
| GET /api/clc?all=1 | 所有者 | 完整分类表 `{edition, nodes:[{code,name,parent}]}`，供手动选择器 |
| POST /api/books/:id/class[?force=1] | 所有者 | 自动归类。已有 `manual` 且非 force → 409 `manual_locked`；已 ready 且非 force 直接返回。单飞租约 15 分钟，冲突 409 `generating`。DeepSeek Search 1 次（`<书名> 中图分类号`，count 8，20 s，失败降级，401/402 记 `search_auth`/`search_balance`），从 title/snippet/summary 中按“中图分类号/分类号/CLC”标签抽取候选号；再 oai `/v1/tasks`（`gpt-luna` medium json_object，600 s），输入书名、来源目录、已有 AI 简介 summary/tags/keyPoints、候选号及来源、限定的候选类目列表，以及格式与大小（弱参考）；同一次调用给出 `docType`（§11：`book`/`course`/`paper`/`articles`/`manual`/`other`），非法或缺失记 `other`，非书资料仍有主题分类号。响应即 classView：`status`、`clc`、`clcPath`、`secondary`、`source`/`clcSource`、`confidence`/`clcConfidence`、`docType`、`reason`、`evidenceUrl`、`rawCode`、`updatedAt`、`error?`。服务端解析：主号不可解析 → 502 `ai_bad_output`；副号不可解析则丢弃（最多 2 个）；`basis:"cip"` 仅当主号（原号或解析后）出现在检索候选中才记 `source:'cip'` 并保存 `evidence_url`，否则降为 `ai`。503 `ai_busy` 透传 `Retry-After`，其他错误与 AI 详情相同；均不自动重试，force 失败保留旧结果 |
| PUT /api/books/:id/class `{clc, secondary?, docType?}` | 所有者 | 手动指定：`clc` 与每个副号（≤2）必须正好是表内节点，否则 400 `bad_clc`；`docType` 可选，必须是上述枚举之一，否则 400 `bad_doc_type`，省略时保留原资料类型；写入 `source:'manual'`、ready，覆盖进行中的自动归类（其结果因租约丢失不再写入） |

### 2026-10-26 笔记摘要（`docs/notes-plan-2026-10-26.md`，迁移 `app/migrations/0005_notes.sql`）

全部仅所有者：访客一律 401 `login_required`（先于参数校验）；写操作（POST/PATCH/DELETE）沿用同源 `Origin` 校验，否则 403 `bad_origin`。只返回“活”笔记：笔记未删除，且所属书未软删除、非 reserved（书移到回收站后其笔记随之隐藏，恢复书即恢复）。笔记行形状：`{id, bookId, bookTitle, bookFormat, quote, note, color, locator, label, createdAt, updatedAt}`，`locator` 为对象。

| 方法 路径 | 权限 | 说明 |
| --- | --- | --- |
| GET /api/notes?book=&q=&limit=&before= | 所有者 | `{notes:[...], nextBefore}`，按 `created_at` 倒序（同刻按 id 倒序）。`book` 可选（`[A-Za-z0-9_]{1,40}`，否则 400 `bad_book`）；`q` 去首尾空白后对原文与笔记做 LIKE（`%`、`_`、`\` 转义，≤200 字，否则 400 `q_too_long`）；`limit` 默认 200、上限 1000（超出按 1000），非正整数 400 `bad_limit`；`before` 为上一页 `nextBefore`（严格早于该 `created_at`）；返回条数等于 limit 时 `nextBefore` 为最后一条的 `createdAt`，否则 null |
| POST /api/books/:id/notes `{quote, note?, color?, locator, label?}` | 所有者 | 书须存在、未删除、非 reserved，否则 404。`quote` 去首尾空白后 1–4,000 字（按码点；空或非字符串 `bad_quote`，超长 `quote_too_long`）；`note` ≤10,000 字（`bad_note`/`note_too_long`），`label` ≤200 字（`bad_label`/`label_too_long`），二者去空白后为空即 null；`color` ∈ `yellow`/`green`/`blue`/`pink`，默认 yellow（`bad_color`）；`locator` 必须是对象且恰为 `{type:'cfi',cfi}`（非空字符串）、`{type:'pdf',page≥1,start?,end?}`（非负整数，end≥start）或 `{type:'text',start,end}`（非负整数，end≥start）之一，不允许多余字段（`bad_locator`），按固定键序重新序列化后 ≤2,000 bytes（`locator_too_large`）。id 为 `n_` + 24 位随机 hex。201 `{note}` |
| PATCH /api/notes/:id `{note?, color?}` | 所有者 | 只改笔记正文与颜色（原文与位置不可改）；`note` 传空串或 null 清空；两者都没有 → 400 `nothing_to_update`；不存在/已删除 → 404。返回 `{note}` 并更新 `updatedAt` |
| DELETE /api/notes/:id | 所有者 | 软删除（写 `deleted_at`），再删 404 |
| GET /api/notes/export?format=md\|csv\|json[&book=][&q=] | 所有者 | 与列表相同筛选，不分页；`format` 缺失或非法 400 `bad_format`。`Content-Disposition: attachment; filename="the-shelf-notes-YYYYMMDD.<ext>"`（UTC 日期），`Cache-Control: no-store`。CSV：UTF-8 BOM、CRLF、所有字段双引号包裹（RFC 4180），列 `book_title,quote,note,color,label,created_at,updated_at,book_id,note_id,locator`，以 `= + - @`、Tab、CR 开头的单元格前加 `'` 防公式注入。Markdown：`# The Shelf 笔记摘要`，按书（书名排序）分 `## 书名`，书内按创建时间正序：`> 原文`、笔记正文、`— 位置 · 时间`。JSON：`{exportedAt, count, notes}` |

页面：`notes.html`（所有者全部笔记，按书/按时间、搜索、按书筛选、改笔记/颜色、删除、“在书中打开” `read.html?id=<book>&note=<id>`、按当前筛选导出；访客显示登录框）。所有者登录后各页头部（`renderAuthBox`）出现“笔记”入口；详情页显示本书笔记数并链接 `notes.html?book=<id>`。阅读页对 `note=` 的定位与选中摘录属 N2。

### 2026-10-26 最近阅读（`docs/recent-reading-plan-2026-10-26.md`，迁移 `app/migrations/0006_reading.sql`）

全部仅所有者：访客一律 401 `login_required`（先于参数校验）；写操作沿用同源 `Origin` 校验，否则 403 `bad_origin`。表 `reading_history` 每本一行（`book_id` 主键、`last_opened_at`、`open_count`、`progress`）。`progress` 为仅供展示的人读进度：字符串，NFC 后去首尾空白，≤40 字（按码点，`progress_too_long`），不得含控制字符（C0/DEL/C1、U+2028/2029，`bad_progress`），非字符串 `bad_progress`；null 或空白即 null。可读书 = 存在、未软删除且 `status='uploaded'`，否则 404 `not_found`。

| 方法 路径 | 权限 | 说明 |
| --- | --- | --- |
| POST /api/books/:id/opened `{progress?}` | 所有者 | body 可为空或 JSON 对象（否则 400 `bad_json`）。upsert：`last_opened_at`=now，`open_count`+1（首次为 1）；给出 progress 则替换，省略/null 保留原值。返回 `{bookId, lastOpenedAt, openCount, progress}` |
| PUT /api/books/:id/progress `{progress}` | 所有者 | 只更新进度，不改时间与次数；必须含 `progress` 字段（null/空串清空，缺失 400 `bad_progress`）；从未打开过（无记录）404 `not_opened`，不建行。返回 `{bookId, progress}` |
| GET /api/recent?limit= | 所有者 | `{recent:[...]}`，按 `last_opened_at` 倒序（同刻按 book_id）。每项为所有者书目字段（`id,title,category,format,sizeBytes,status,createdAt,clc,docType,hasCover,hasInfo,authors`）加 `lastOpenedAt`、`openCount`、`progress`；软删除或非 uploaded 的书不返回（恢复后重新出现）。`limit` 默认 20、上限 100（超出按 100），非正整数 400 `bad_limit` |
| DELETE /api/recent/:bookId | 所有者 | 删除该书的记录（硬删除，再次打开从 1 计）；无记录 404 |

页面：首页（所有者）统计区下方显示“最近阅读 / RECENT”可折叠区块（默认展开，折叠状态存 localStorage `shelf:recent-collapsed`），横向滚动卡片（封面、书名、相对时间、进度、“继续阅读 →” `read.html`、× 移除），默认 12 本（请求 13 判断是否有更多），“查看全部”请求 100；无记录显示引导文字；访客不显示也不请求。阅读页（`lib/recent.ts`）：书加载成功且无错误后 `POST opened` 一次（附当时已知进度）；之后翻页 `PUT progress` 节流（距上次发送 ≥30 秒，尾随发送），`pagehide` 与页面隐藏时以 `fetch keepalive` 补发未发送的最新进度；失败一律忽略。进度文字：PDF / CBZ “第 N / 总 页”（双页 “第 N–M / 总 页”），EPUB（位置生成后）/ MOBI / AZW / TXT “约 N%”。

### 2026-10-27 Google 登录与所有者 API 令牌（G1，`docs/audiobook-google-login-plan-2026-10-27.md`）

第一阶段：新增 Google 登录，密码登录暂时保留（G2 线上验收后再移除）。仍是单一所有者：`OWNER_EMAILS` 白名单内且 `email_verified` 为 true 的 Google 账号得到所有者会话。Secrets：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`OWNER_EMAILS`（逗号分隔，忽略大小写与首尾空白）、`OWNER_API_TOKEN`（≥32 字符，否则视为未启用）；可选变量 `GOOGLE_REDIRECT_URI`（默认 `<origin>/api/auth/google/callback`）。会话校验只要求 `SESSION_SECRET`；未配置 `OWNER_PASSWORD` 时 `/api/login` 返回 503 `not_configured`。

| 方法 路径 | 权限 | 说明 |
| --- | --- | --- |
| GET /api/auth/google[?next=] | 公开 | 未配置 Google（client id/secret、白名单、`SESSION_SECRET` 任一缺失）503 `not_configured`。否则生成 `state`、`nonce`、PKCE verifier（S256），写入 HMAC 签名 cookie `shelf_oauth`（10 分钟，HttpOnly Secure SameSite=Lax，`Path=/api/auth/google`），302 到 Google（scope `openid email`，`prompt=select_account`）。`next` 须以 `/` 开头、非 `//`、无反斜杠/空白/控制字符，否则为 `/` |
| GET /api/auth/google/callback | 公开 | 校验 state cookie 签名、有效期与 `state` 参数（常量时间）；服务端用 client secret + code_verifier 向 `oauth2.googleapis.com/token` 换码（10 s 超时，不跟随重定向）；解码 id_token 并校验 `iss`、`aud`、`exp`、`nonce`、`email_verified`，邮箱须在白名单。成功设置所有者会话、清 state cookie、302 到 `next`；任何失败都清 state cookie 并 302 到 `/?login_error=<code>`：`google_denied`（用户取消或无 code）、`google_state`、`google_token`、`google_claims`、`forbidden_email`、`not_configured`。不记录、不回显 code 与 token |
| GET /api/me | 公开 | `{owner:boolean}`；Google 会话为 `{owner:true, email}` |
| 任意所有者接口 + `Authorization: Bearer <OWNER_API_TOKEN>` | 所有者 | 常量时间比较（SHA-256 摘要）。带 Authorization 头时只看令牌：令牌错误即非所有者，不回落到 cookie。仅有效 Bearer 写请求豁免 Origin 校验；cookie 与无效 Bearer 写请求仍须同源。Bearer 请求不下发 cookie |

会话 cookie `shelf_session`（HMAC(SESSION_SECRET)，30 天）：密码登录与旧 cookie 为 `<expiry>.<sig>`（签名内容 `owner:<expiry>`），过渡期内继续有效直到过期；Google 登录为 `<expiry>.<b64url(email)>.<sig>`（签名内容 `owner:<expiry>:<emailHash>`，emailHash = HMAC(SESSION_SECRET, `email:<email>`) 的 base64url 前 22 字符）。邮箱以签名保护的明文放在 HttpOnly cookie 中，供 `/api/me` 返回；邮箱移出 `OWNER_EMAILS` 后该会话立即失效。

页面：各处登录框顶部加“使用 Google 登录”按钮（`/api/auth/google?next=<当前路径+查询>`），下方保留密码框。`?login_error=` 显示中文提示（如 `forbidden_email` →“此 Google 账号无权访问”）后从地址栏移除。

脚本鉴权：`.env` 有 `SHELF_OWNER_API_TOKEN` 时 `scripts/mvp-upload.mjs` 与 `scripts/lib/batch.mjs`（enrich / classify / reidentify）发送 Bearer、不调用 `/api/login`；否则回落为 POST /api/login 取得 cookie。

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

## 2026-10-27 G2：移除密码登录

- 删除 `POST /api/login`：现在按未知路由返回 404（先过 Origin/CSRF 检查，跨源仍为 403）。代码中不再有任何 `OWNER_PASSWORD` 读取。
- 旧格式会话 cookie `<expiry>.<sig>` 不再被接受（即使签名正确）。仅 `<expiry>.<b64url email>.<sig>` 且 email 仍在 `OWNER_EMAILS` 内，或有效的 Bearer 令牌，才视为所有者。`sessionCookie` 必须带 email。已有的旧格式 cookie 随部署立即失效，需重新用 Google 登录。
- 前端登录区只剩“使用 Google 登录”按钮和 `login_error` 提示，密码输入框已移除。
- `scripts/mvp-upload.mjs`、`scripts/lib/batch.mjs`（classify/enrich/reidentify）不再有密码回退，必须设置 `SHELF_OWNER_API_TOKEN`，缺失时退出码 2（`mvp-upload --dry-run` 不联网，不要求令牌）。
- 待办：部署后执行 `wrangler secret delete OWNER_PASSWORD` 删除生产遗留 secret（本任务未执行，未部署）。
