# 功能迭代计划（2026-10-24）：缩略图、拖拽上传、MOBI/AZW 阅读、AI 书籍详情、列表过滤

基线：`app/` 精简 MVP（`docs/mvp-plan.md`），Worker 版本 `180fa0ab…` 已在主站运行。本计划只扩展 `app/`，不触碰旧 Astro/CF01/trial 链路。本文是计划，不代表已实现或已上线。

## 0. 现状要点（与本计划相关）

- 书目：D1 `books` 表；`GET /api/books` 公开返回 `{id,title,category,format,sizeBytes,status,createdAt}`。
- 文件：私有 R2，key `books/<sha256>`，仅所有者可读（Range 支持）。
- 封面：目前是 `coverEl()` 生成的 CSS 文字封面，无真实图片。
- 阅读：PDF（pdf.js range）、EPUB（epub.js）、TXT/MD；MOBI/AZW3 只能下载。
- 上传：所有者面板里 `<input type=file multiple>` + 手填分类；客户端只检查大小和空文件，重复由服务端按 sha256 去重后返回 `duplicate:true`；预算超限 507、格式 415。
- 本地藏书格式分布：PDF 409、EPUB 17、MOBI 8、DOC 6、PPTX 2、AZW3 1、其他零星。
- AI：`../oai_api` 网关 `POST https://oai.parallelstreamllc.com/v1/tasks`，Bearer key 在 `.env` 的 `SHELF_OAI_KEY`。已按 `/guide`（2026-10-20 版）核对：同步调用、**全局并发 1**、单任务最长 840 s、忙时 503 + `Retry-After`、**不联网/不读 URL**、无幂等和结果存储、`json_object` 只保证可解析不保证 schema。

## 1. 共同约束（继续遵守 AGENTS.md）

- 单书 ≤ 20,000,000 bytes；8 GB 总预算在 D1 中原子检查。**缩略图字节也计入预算**（保守做法，450 本 × ~40 KB ≈ 18 MB）。
- 默认私有：书文件、缩略图、AI 详情均仅所有者可见（见 §8 待确认项）。
- 所有写接口保留所有者鉴权 + Origin 校验；不自动重传；软删除不释放对象/预算。
- AI key 只作为 Worker secret `OAI_KEY`、`DEEPSEEK_KEY`（`wrangler secret put`），不进 Git、不下发到浏览器。

## 2. 功能设计

### F1 书籍完整缩略图

**目标**：书架卡片和详情页显示真实封面（PDF 首页 / EPUB、MOBI 内嵌封面），无缩略图时回退到现有 CSS 封面。

**方案**：浏览器端生成，服务端只存储。理由：复用已有 pdf.js/epub 解析代码，免去在 Worker 或 Node 里装原生 canvas。
- 生成：`app/web/lib/thumb.ts`
  - PDF：pdf.js 以 range 方式只取首页，渲染到 canvas（宽 360px）。
  - EPUB：epub.js `book.coverUrl()`；无封面时渲染首页失败则放弃。
  - MOBI/AZW3：foliate-js 的 `getCover()`（依赖 F3）。
  - 统一输出 WebP（不支持则 JPEG），质量 0.8，目标 ≤ 80 KB，上限 200 KB。
- 存储：R2 key `covers/<book_id>.webp`；D1 新表 `covers(book_id PK, r2_key, size_bytes, width, height, created_at)`。
- 接口：
  - `PUT /api/books/:id/cover`（所有者，`image/webp|jpeg`，≤ 200,000 bytes，校验图片魔数；同一本覆盖写只按差额计入预算）。
  - `GET /api/books/:id/cover`（默认所有者；`Cache-Control: private, max-age=86400`，带 ETag）。
  - `GET /api/books` 增加 `hasCover`。
- 触发时机：
  1. 新上传成功后立即生成（F2 流程最后一步）。
  2. 所有者面板“补全缩略图”按钮：顺序处理所有 `uploaded && !hasCover` 的书，显示进度、可暂停；失败记日志不中断。
  3. 阅读页打开 PDF 时若无封面顺手生成（可选，低优先级）。
- 前端：`coverEl()` 若 `hasCover` 且为所有者，用 `<img loading=lazy>` 叠在 CSS 封面上，加载失败保持 CSS 封面。

**验收**：PDF/EPUB/MOBI 各至少 1 本生成并显示；无封面/损坏文件回退 CSS 封面；未登录访问 cover 返回 401；预算数字包含封面字节。

### F2 拖拽上传 + 不能上传原因提示

**目标**：所有者把本地文件（可多选、可整个文件夹）拖到书架页即可上传；每个文件都明确显示能否上传及原因。

**方案**：
- 拖拽区：所有者登录后整个书架页可接收 drop，显示全屏遮罩“松开以上传到 …”；保留原“选择文件”按钮。支持 `DataTransferItem.webkitGetAsEntry()` 递归文件夹：拖入文件夹时其**一级目录名作为分类**（与 `books/` 目录结构一致），散文件用面板中选中的分类（未选时要求先选，不默认）。
- 上传前检查（客户端快速判断 → 服务端权威判断）：
  1. 客户端：格式白名单、空文件、> 20,000,000 bytes、文件名非法字符/路径过长、同批次内 sha256 重复。
  2. 计算 sha256 后调用新接口 `POST /api/upload/check`（所有者），body `{files:[{path,sizeBytes,sha256}]}`（≤ 200 条），返回每个文件的 `{ok, reason, existingBookId?}`：`duplicate`（同 sha256 已在书架，附书名链接）、`duplicate_deleted`（在回收站，上传即恢复）、`similar_title`（同名不同内容，仅警告可继续）、`budget_exceeded`（按本批累计计算剩余预算）、`unsupported_format`、`too_large`、`bad_path`。
  3. 列表先展示检查结果，用户点“开始上传”只上传 `ok` 的文件；被拒文件显示中文原因，不上传。
- 实际上传仍走现有 `PUT /api/upload`（服务端再次校验，check 只是预判）；所有错误码统一映射为中文原因（`lib/common.ts` 的 `errorText` 扩充）：`too_large`→“超过 20 MB 单本上限（实际 xx MB）”、`budget_exceeded`→“剩余预算不足（剩 xx，需要 xx）”、`hash_mismatch`→“传输中文件损坏，请重试”、`storage_unknown`→“存储结果未知，已保留预留，不会自动重传，请联系维护”等。
- 并发 1、逐个上传，显示每本进度条（XHR upload progress）；完成后触发 F1 缩略图生成，刷新列表与预算。

**验收**：拖入混合文件（正常/重复/>20 MB/不支持格式/空文件/同批重复/文件夹）各显示正确原因，只有正常文件被上传；未登录时拖拽无效并提示登录。

### F3 MOBI / AZW3 / AZW 在线阅读

**方案**：引入 `foliate-js`（npm 1.0.1，MIT，纯浏览器解析 MOBI/KF8(AZW3)/EPUB/FB2/CBZ），由 esbuild 打包、按需动态加载。
- `read.ts` 新增 `readMobi()`：下载全文（≤ 20 MB）→ `makeBook(file)` → `<foliate-view>` 分页渲染；复用现有工具栏（上一页/下一页、目录、字号、深色主题、阅读进度存 `localStorage`）。
- `READABLE` 增加 `mobi`、`azw3`、`azw`；Worker `CONTENT_TYPES` 增加 `application/x-mobipocket-ebook`。
- 有 DRM 的 AZW/KFX 无法解析：捕获错误，显示“该文件受 DRM 保护或格式不受支持，请下载原文件”。
- 是否顺便用 foliate-js 替换 epub.js：**本轮不替换**，只用于 MOBI/AZW，降低回归风险；后续视效果再议。
- 注意：用户写的“awz”按 Amazon 的 `azw`/`azw3` 处理；格式白名单里已有这两项。

**验收**：本地 8 本 MOBI、1 本 AZW3 上传后可在线翻页、目录跳转、记住进度；DRM 样本给出明确提示。

### F4 AI 书籍详情（背景、作者、相关信息）

**目标**：详情页展示 AI 生成的：一句话简介、内容背景/主要内容、作者介绍、成书/出版背景、适合读者、目录要点或关键概念、相关推荐书（优先本书架内）、标签。明确标注“AI 生成，可能不准确”。

**方案**：
- 数据：D1 新表 `book_info(book_id PK, status CHECK(status IN ('generating','ready','failed')), data_json, model, input_kind, lease_until, error, updated_at)`。`data_json` schema（服务端校验，字段缺失/类型不符视为失败，不入库半截结果）：
  ```json
  {"title":"规范书名","authors":[{"name":"","bio":""}],"summary":"","background":"",
   "keyPoints":[""],"audience":"","publishInfo":"","tags":[""],"related":[{"title":"","reason":""}],
   "confidence":"high|medium|low"}
  ```
- 输入：书名 + 分类 + 格式 + 可选正文摘录（所有者浏览器用 pdf.js/epub/foliate 抽取前 ~8 页文本，截断 12,000 字，随 POST body 发送，不落库）。`input_kind` 记 `title` / `excerpt`。
- **联网检索（DeepSeek Search，2026-10-24 用户追加）**：oai 网关不联网，因此 Worker 先调用 DeepSeek `POST https://api.deepseek.com/v1/tools/search`（Bearer `DEEPSEEK_KEY` secret，来自 `.env` `SHELF_DEEPSEEK_KEY`）。
  - 查询 2 次：`<书名> 作者 简介`、`<书名> 内容简介 书评`（query ≤ 128 字符，必要时截断书名；`ori_question` 填“《书名》的作者、内容与出版背景”；`count: 8`，`need_content: false`）。
  - 合并去重，取 `rerank_score ≥ 1.0` 的前 8 条，每条只保留 `title/url/site_name/date/authority/summary`（summary 已是 600–800 字的模型可读摘要），作为“检索资料”交给 oai。
  - 错误：429/5xx/超时 → 跳过检索、继续只用书名+摘录生成，`data_json.searchUsed=false`；401/402 → 同样降级并在 `error` 记 `search_auth`/`search_balance`。不自动重试。
  - 费用：$0.75/千次成功请求，每本 2 次（约 450 本 ≈ $0.7）；2026-11-01 起计费。
  - 同名书消歧：提示词要求以正文摘录/分类判断版本，检索结果与摘录矛盾时以摘录为准，不确定写“不详”。
- 调用入口：`POST /api/books/:id/info`（所有者，Origin 校验，body `{excerpt?: string}`，≤ 64 KB）。
- 生成：Worker 调用 oai `POST /v1/tasks`，`model: gpt-luna`、`effort: medium`、`output_format: json_object`、超时 600 s。输出 schema 增加 `sources:[{title,url}]`（只能引用检索资料中出现的 URL，服务端校验，非白名单 URL 剔除）。
  - 单飞：先在 D1 原子写 `status='generating', lease_until=now+15min`，已有未过期租约则返回 409 `generating`；网关 503 → 返回 `ai_busy` 并带 `Retry-After`，**不在服务端自动重试**（网关无幂等）。
  - 已有 `ready` 结果直接返回；`?force=1` 才重新生成。
- 读取：`GET /api/books/:id/info`（默认所有者）。`GET /api/books` 仅在所有者会话下额外返回 `hasCover`、`hasInfo`、`authors`（访客响应不含这些字段，符合 §8 决定 1）。
- 批量：`scripts/mvp-enrich.mjs` 本地脚本，登录后顺序（并发 1）对 `!hasInfo` 的书调用上述接口，遇 503 按 `Retry-After`+抖动退避，限制总重试次数；可中断续跑。
- 前端：详情页新增“关于这本书”区块：未生成时所有者看到“生成 AI 简介”按钮（显示等待中、可能需要 1–3 分钟）；生成后展示各段落和“重新生成”；相关推荐若书名命中本书架则链接到详情页。
- 页面展示“参考来源”链接列表；`confidence: low` 或未用检索时加醒目提示。

**验收**：真实网关调用 3 本（知名书、冷门书、只有摘录的书）结果合规入库并展示；并发点两次只发一次请求；503/超时有中文提示且不重复入库；key 不出现在前端产物和日志中（`grep` dist）。

### F5 列表页更多过滤

**新增过滤**（与现有关键字/分类/状态/排序组合，状态写入 URL 查询参数，返回时恢复）：
- 格式：多选 chips（PDF/EPUB/MOBI/AZW3/TXT/其他），每项显示计数。
- 文件大小：< 1 MB / 1–5 MB / 5–20 MB / > 20 MB（仅本地）。
- 添加时间：最近 7 天 / 30 天 / 全部。
- 可在线阅读：是/否（基于 `READABLE` 与 `status`）。
- 有缩略图 / 有 AI 简介（所有者可见）。
- 作者：来自 AI 详情的 `authors`，提供下拉 + 关键字搜索同时匹配作者名。
- 排序新增：按大小、按格式。
- “清除全部过滤”与当前过滤摘要（例如“PDF、EPUB · 5–20 MB · 18 本”）。

全部在前端内存过滤（书目量级几百~几千，已一次性加载），只需 `/api/books` 增加 `hasCover`、`hasInfo`、`authors` 字段。

**验收**：各过滤单独及组合结果正确，计数与分类侧栏一致，刷新/返回后恢复。

## 3. Schema 增量（`app/schema.sql` + 迁移 `app/migrations/0002_features.sql`）

```sql
CREATE TABLE IF NOT EXISTS covers (book_id TEXT PRIMARY KEY REFERENCES books(id), r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, width INTEGER, height INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS book_info (book_id TEXT PRIMARY KEY REFERENCES books(id),
  status TEXT NOT NULL CHECK (status IN ('generating','ready','failed')), data_json TEXT,
  model TEXT, input_kind TEXT, lease_until TEXT, error TEXT, updated_at TEXT NOT NULL);
```
预算 SQL 改为 `books 中 r2_key 非空的 size_bytes 之和 + covers.size_bytes 之和 + LEGACY_RESERVE`，封面写入同样用条件 INSERT/UPDATE 原子检查。只新增表，不改动 `books` 已有列，回退时旧 Worker 忽略新表即可。

## 4. 任务拆分与模型分配

| # | 任务 | 范围 | 模型 | 依赖 |
| --- | --- | --- | --- | --- |
| T1 | Worker + schema：covers 存取、`/api/upload/check`、`book_info` 存取与 AI 调用（单飞、校验、错误映射）、`/api/books` 新字段、预算计入封面；单元测试（含 AI 网关 mock） | 鉴权/预算/AI 调用 | **Opus 5.5** | 本计划契约 |
| T2 | 缩略图生成 `lib/thumb.ts` + 批量补全 UI + `coverEl` 图片化 | PDF/EPUB/MOBI 渲染 | **Opus 5.5** | T1 接口；MOBI 部分依赖 T3 |
| T3 | MOBI/AZW3 阅读（foliate-js 集成、构建、DRM 提示） | 新阅读器 | **Opus 5.5** | 无 |
| T4 | 拖拽上传 UI + 预检结果展示 + 错误码中文化 + 上传进度 | 前端交互 | **Sonnet 5.5** | T1 `/api/upload/check` |
| T5 | 详情页 AI 区块 + 正文摘录抽取 + `scripts/mvp-enrich.mjs` | 前端 + 脚本 | **Opus 5.5**（涉及 AI 调用与摘录隐私） | T1 |
| T6 | 列表页过滤与排序扩展 | 纯前端 | **Sonnet 5.5** | T1 列表字段（可先用 mock 字段开发） |

并行顺序：T1、T3 先并行 → T1 合入后 T2、T4、T5、T6 并行。每个子任务交付后由主 Agent review，有问题交回修正再复审。

## 5. 验证步骤

1. `npm run app:test`（新增：cover 上传大小/类型/鉴权/预算、check 各原因、info 单飞/503/坏 JSON、列表字段）。
2. `node app/build.mjs` 构建通过；`grep` dist 确认无 `OAI`/key/内部路径泄露。
3. 本机 macOS 12 无法运行 workerd → 前端用 Node 测试替身 + 线上冒烟；浏览器验收通过 Claude in Chrome 实际打开页面操作（拖拽可用 DataTransfer 脚本模拟）。
4. 线上验收：迁移后执行 F1–F5 各自验收项；补全全部缩略图；批量生成 AI 详情（并发 1，可分多次）。

## 6. 部署与回退

- 发布顺序：`wrangler d1 execute the-shelf-app --remote --file app/migrations/0002_features.sql` → `wrangler secret put OAI_KEY` 与 `DEEPSEEK_KEY` → commit → push → `npm run app:deploy` → 线上验收。
- 回退：`npx wrangler rollback 180fa0ab-9aaf-454b-b84a-16226db2e7ad --name the-shelf`（当前 MVP 版本）；新表保留无害；R2 `covers/` 对象保留（不删除，仍计预算）。

## 7. 明确不做

- 服务端（Worker/Node）渲染缩略图或格式转换（MOBI→EPUB）。
- DeepSeek Fetch 全文抓取、豆瓣/Google Books 专用元数据接口（检索摘要已够用，可作为后续项）。
- DRM 解除；KFX 格式；DOC/PPT 在线阅读。
- 公开（非所有者）展示封面或 AI 内容——除非 §8 确认。
- 替换 epub.js、修改套餐/计费。

## 8. 已确认的决定（2026-10-24 用户回复“计划没问题，可以执行”）

1. 真实缩略图和 AI 简介仅所有者可见，访客看文字封面。
2. AI 输入允许附带正文摘录（仅所有者触发）。
3. 生成模型 `gpt-luna` medium。
4. 联网信息用 DeepSeek Search（见 F4）。

## 9. 线上基线核验（2026-10-24）

- 批量上传结果：445 个候选 → uploaded 384、cataloged（>20 MB 仅登记）59、duplicate 1（`02-数学/高数公式.pdf`）、failed 1（`01-计算机与技术/数据挖掘-概念与技术.pdf`，本地源文件 0 字节 → `empty_file`）；上传 1,442,973,084 bytes。线上书目 444 条（uploaded 385、local_only 59）。
- EPUB 线上阅读：API 层（未登录 401、登录下载 hash 一致、Range 206）和无头 Chrome 渲染（0.6 MB / 中位 / 18 MB 三本：封面、正文、翻页、目录、无控制台错误）均通过。
