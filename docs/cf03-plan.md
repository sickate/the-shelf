# CF-03：Workers + D1 登录与私人阅读实施计划

更新日期：2026 年 10 月 15 日。状态：CF-03 P1 进行中、未验收；CPU生产门槛未通过，不发布API。代码与默认disabled静态改进待按已有流程发布，实际以receipt为准。本文不是上线验收记录。

最终本地验证为138项Node、8项Python通过；metadata真实DOM 11项与account真实DOM 9项断言通过。check/production D1已独立建立，check schema与002保守预算迁移已应用并回读，production库仍空。production secrets仅在本地生成，未安装Worker或写入auth；check Worker有四个secrets；check已关闭 `auth_config.enabled`、递增generation并撤销所有会话，workers.dev与preview URLs已禁用，D1和secrets保留未删除。多轮云HTTP安全/CAS/撤销及合成导入、snapshot保留override通过，原子20并发争用最后1额度仅1个成功。CPU结果、账号共享R2证据、生产登录/文件与reader闭环仍未达门槛。源码提交 `0ae8825` 已推送；Cloudflare CI `38724875134` 构建 artifact 成功，Pages CI `38724875089` 成功。首次真实静态 CLI 在任何 Cloudflare 写入前遇到入口循环并停止；CLI修复已通过主 Agent review，新增两项真实独立进程 static/API CLI smoke后总计138项Node与8项Python全通过。修复待单独提交并经CI验证后发布，当前静态站尚未更新。

本文只保存在仓库，不加入 `scripts/export-docs.mjs` 的公开文档白名单。实际账号 ID、数据库 ID、对象 key、选中文件 ID、密钥和原始验收记录只保存在被忽略的 `.local/`。本文不读取或复制真实 `.env` / `.local` 数据。

## 目标与当前差异

当前 `the-shelf` Worker 仅托管 CF-02 静态资源，线上前端没有业务 API。Node HTTP 后端的 `scryptSync`、内存会话/限流、磁盘 JSON 覆盖记录与 SQLite AI 队列仍用于本机开发。CF-01 已验证基础设施，但没有证明现有强密码计算适配 Workers Free。

CF-03 在同一个 `https://the-shelf.iamzhutuo.workers.dev` 来源提供 Workers API，以独立生产 D1 保存公开目录基线、元数据覆盖、私人文件登记、可撤销会话与原子预算；继续使用私有 `the-shelf-books` 桶。目标是登录、元数据编辑、公开目录快照同步、仅选一份真实合格 EPUB 和一份真实合格 PDF 的上传与私人阅读。静态网站、私人 API、AI 分别报告状态。

不迁移 AI、Workflows、私人问答/历史/已发布结果，不调用真实模型，不做正文提取、OCR、格式转换、跨设备进度、网页上传、整库上传或生产 Node 服务。不改现有本机所有者密码，不覆盖 `.local/manifest.json`、`overrides.json`、SQLite 或收藏源文件，不把 paw 改为生产服务器，不开通付费计划。

## 决策与实施分工

本阶段复杂度高，安全、持久状态、数据迁移与部署隔离均由 `gpt-6.1-sol / high` 实施，主 Agent 负责最终设计、代码 review、集成、真实账号操作、提交推送发布与线上验收。仅可使用 `gpt-6-luna` 与 `gpt-6.1-sol`；指定模型不可用时暂停对应分工并说明，不替换为第三种模型。

| 任务 | 模型 / effort | 依赖 | 交付与 review 重点 |
| --- | --- | --- | --- |
| A 安全方案与 Free 前置验证 | Sol / high | 本文 review | 随机访问密钥、HMAC verifier、真实 CPU、D1 限流/撤销并发证明 |
| B Workers/D1 核心 | Sol / high | A 方案确定；生产发布须 A CPU 通过 | schema、同源 API、会话/CSRF、metadata CAS、文件授权；无 AI 执行路径 |
| C 数据与逐文件 CLI | Sol / high | B schema/API 契约 | 白名单导入/快照、共享预算预留、单文件上传/reconcile、完整性验证 |
| D 前端能力与阅读闭环 | Sol / high | B 契约 | 同源模式、访问密钥文案、metadata 冲突、签名刷新、EPUB/PDF 阅读与下载 |
| E 受控发布 helper | Sol / high | B 运行配置、A 验证证据 | 保留 CF-02 默认拒绝脚本/binding 的边界，显式 API 模式，目标和秘密隔离 |
| F 普通文档更新与公开文案 | Luna / medium | A–E 行为稳定 | 主 Agent 审阅；安全、鉴权与数据说明的具体决定仍由 Sol 负责 |
| G 集成与发布验收 | 主 Agent | A–F review 与测试通过 | 本地验证、远端 CI、生产验证分别记录；不以子 Agent 自报完成替代 review |

任务可并行读代码和实现不相交文件，schema/API 契约的变更须先通知依赖方。每份交付有具体 review 意见与修正复审；Luna 同一交付连续两轮修正未通过时升级 Sol。实现完成不代表云端前置门槛已经通过。

## 1. 低 CPU 鉴权：独立随机访问密钥

### 凭证强度与使用方式

采用独立 CSPRNG 生成的 32 字节（256 bit）owner access key，以无填充 base64url 编码。它是机器生成的高熵访问密钥，不能由人类密码、现有密码哈希、书名或账号信息派生；长度检查不能证明已有密码有 256 bit 熵。保留本机原有 `SHELF_OWNER_PASSWORD` 与 scrypt 登录，线上明确显示“所有者访问密钥”，不诱导用户把普通密码用于快哈希验证。

Worker secret `OWNER_KEY_PEPPER` 是另一份独立 32 字节随机值。受控初始化工具在本机计算 HMAC-SHA256，消息使用固定版本/用途前缀及规范化的 access key；D1 `auth_config` 仅存 verifier、方案版本、credential generation 与启用状态，云端不保存 owner key 明文。线上使用 Web Crypto HMAC 验证固定长度数据与固定长度签名；不得用普通字符串早退比较 verifier，不降低 KDF 参数，不把密码计算转移到客户端。输入只接受规范化的 43 字符 base64url key，并限制 JSON 总体积；错误格式与错误凭证均返回同一 `invalid_credentials`。verify 路径的失败分支要实测且无原始错误输出。

独立 Worker secret `SESSION_SECRET` 用于会话摘要、CSRF 和 IP 伪匿名化，使用不同版本/用途前缀，不能与 owner key 相同。check已实际配置现有 `the-shelf-books` 桶专用 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`，与production用途采用同一份现有凭证，权限为Object Read & Write，尚无独立只读凭证。check使用真实桶专用R2签名凭证；独立且不与production共享的是owner access key、OWNER_KEY_PEPPER、SESSION_SECRET及D1。`BOOKS` 绑定在平台上也具有读写能力，本轮Worker应用仅调用HEAD并签GET，不提供PUT/DELETE签名或写对象接口。check应用只允许 `cf03-check/` 前缀的合成对象，不读取原书或生产owner key；凭证本身以桶为权限边界，不声称平台凭证按对象前缀隔离。任何R2写入仍受共享用量证据门槛限制。后续收窄到桶专用只读签名凭证是改进项，不为此创建账号通用token或扩大范围。所有secret不放入普通Wrangler vars、argv、CI artifact、静态代码或公开日志。

在现有项目授权内，可以直接生成这些项目专用随机密钥：它们只影响本项目、可撤销、不增加费用、没有改变用户现有本机密码，不需要重复请求批准。生成工具应先核对忽略规则与目录边界，用排他创建和 `0600` 写入 `.local/cf03/{check,production}/owner-access-key`（父目录 `0700`），既有文件只校验不覆盖；对应pepper与session secret分别保存为 `.local/cf03/{check,production}/owner-key-pepper`、`.local/cf03/{check,production}/session-secret`，均为 `0600`。不向终端或聊天打印明文，不通过命令替换/进程参数传递，不先删再写，不跟随符号链接。给用户的交付仅说明私有文件路径与安全读取方式。初始化不是公开网站上的注册流程，不接受远端任意设置 verifier。

以上花括号表示按profile分别存放，不是字面目录名。profile专属手工验收材料同样放入 `.local/cf03/{check,production}/`。共享资源allowlist仍为 `.local/cf03/deploy.json`，账号汇总证据默认 `.local/cf03/account-storage.json`；当前CLI的plan/staging/receipt仍使用其输出的 `.local/cf03/{profile}-*.json`，部署日志使用 `.local/cf03/deploy-*/`，不把文档路径调整描述为这些工具默认路径已迁移。所有上述文件都被忽略，不进入公开目录。

网页提示访问密钥由项目本机生成，登录后不在网页储存；输入 type=password、关闭拼写/自动大写，成功和失败后清空内存中的输入值，不使用 URL、localStorage 或 telemetry 保存。可以保留密码管理器的 current-password 提示。`GET /api/config` 返回 `authScheme: "owner-access-key"`，前端云端发送 `{accessKey}`；本机旧模式仍发送 `{password}`，避免悄悄修改本机登录契约。

### 会话、CSRF 与撤销

登录成功重新生成 32 字节 session token，仅通过 `__Host-shelf_session` Cookie 返回：`Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`，无 Domain。D1 仅存基于 SESSION_SECRET 的 token HMAC、credential generation、创建/固定到期时间与 revoked 状态；不存原始 token。24 小时绝对有效期，CF-03 不滑动续期，不沿用登录前 session，不接受 URL 或自定义 header 中的会话替代 cookie。

CSRF token 可由 SESSION_SECRET 对当前原始 session token 使用独立用途前缀 HMAC 派生；因此 D1 不必保存可复用的明文 CSRF。`GET /api/session` 在检查有效会话后返回该 token，匿名返回 null。所有写请求（含登录）要求精确匹配生产 HTTPS Origin、JSON Content-Type，拒绝缺失 Origin、`null`、伪相似域和未知来源；已登录写请求另验证 `X-CSRF-Token`。同源 API 不开启跨域 CORS，Pages 回退站不具备线上会话和写权限。跨站 Fetch Metadata 拒绝作为额外检查，不能代替 Origin/CSRF。

每个私人请求都查询 D1 主库当前会话和 auth_config generation/启用状态，不依赖 isolate/KV 缓存，不启用会降低撤销可见性的读副本。登出原子撤销会话并清空同属性 cookie，不能只清 cookie。受控 CLI 的全部登出/owner key 轮换，在一个事务更新 generation 并撤销会话；登录创建 session 的事务必须再次比较 generation，防止验证与轮换之间的竞争发出旧凭证会话。有效会话上限 10、每日新会话上限 50；这些限制也在 D1 原子执行，清理失败不能跳过上限。

轮换先生成并安全保存新的私有凭证，再部署匹配配置并事务切换 auth_config；记录当前 generation 可恢复性，不输出密钥。SESSION_SECRET 轮换自然使旧 token 摘要失配，仍同步撤销。密钥丢失通过本机受控轮换恢复，不提供匿名恢复接口。已在处理中的请求和已经签发的 R2 URL 有有限竞态窗口，撤销保证适用于撤销提交后的下一次授权，不宣称擦除浏览器已取得的字节。

## 2. D1 原子预算与失败关闭

内存 Map、先 SELECT 再 UPDATE、独立的全局/IP 计数更新均不能作为授权依据。使用 D1 单条 admission INSERT + trigger，或等价的经 review 的 D1 transactional batch：同一事务完成所有适用计数器检查和增量；任何一项超限以 `RAISE(ABORT, controlled_code)` 或约束失败回滚整个准入。trigger 由固定服务端 policy 决定限额，不把客户端传入的上限当作可信值。读取计数后在 JS 决定准入不合格。D1 batch 的事务性质以[官方 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/)为依据，具体 trigger/rollback 行为仍须真实 D1 并发验证。

预算键用服务端时间窗口、用途与经 SESSION_SECRET HMAC 的规范化 Cloudflare `CF-Connecting-IP`；不信任 X-Forwarded-For，自定义来源不可伪造 IP 以规避限制。IPv6 规范化并考虑 /64 聚合；丢失可信 IP 时进入共享 unknown 桶。日志不存原始 IP。时间戳和计数限制来自服务端/SQL，不接受浏览器声明。accepted admission 使用唯一 request ID，防止重试同一内部操作重复计数；成功或错误响应丢失不自动重试鉴权写操作。

初始保守限额如下，最终要根据 D1 `rows_read` / `rows_written`（含索引、trigger 与清理）测量收紧：

| 用途 | 全局限制 | IP 限制 | 原子条件 |
| --- | --- | --- | --- |
| 动态 API 准入 | 240/分钟、1,000/UTC 日 | 240/分钟 | 同事务所有键；公开静态资源不计入 |
| 登录尝试 | 20/分钟、100/UTC 日 | 5/分钟 | 在检查凭证前持久扣减，失败登录也消耗；不能因认证失败回滚准入 |
| 成功创建会话 | 50/UTC 日、10 个有效会话 | 受登录预算覆盖 | session INSERT、generation 检查与上限共同提交 |
| 文件 access 签发 | 1,000/UTC 日 | 120/分钟 | 先鉴权，准入与 session/generation/文件状态检查原子完成，随后才签发 |
| metadata 写入 | 100/UTC 日 | 20/分钟 | CAS 与公开 revision 更新同事务，冲突不改内容 |

窗口为明确固定窗口，边界可能出现双倍瞬时通过，不把它描述为滑动窗口。若改用滑动窗口/令牌桶，必须维持多键单事务。数据库不可用、超时、额度耗尽、缺少 policy/auth_config 或不确定提交时失败关闭，不回落到内存或匿名访问；返回受控 503/429 和可用时的 Retry-After，不泄露 SQL/绑定配置。错误 HTTP 方法不能进入正常写路径。

admission、IP 窗口与过期会话做有界保留和小批次清理，清理本身纳入日预算；不得每请求扫描全表或无限保存恶意 IP。达到本项目测得的保守 D1 操作预算后停用私人入口。Free 的 D1 目前每日包含 5M 读、100k 写，额外索引写也计数，依据[官方 D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)。本项目预算须扣除同账号其他 D1 使用及验证开销。应用限流不能避免所有攻击流量已经产生的 Worker/D1 消耗，不能承诺账单封顶或绝对不耗尽免费请求；不增加付费计划，耗尽时静态目录仍应可读。

## 3. 数据模型与迁移边界

创建项目专用生产 D1 `the-shelf-library`，check使用独立 `the-shelf-cf03-check`，两者database ID必须不同，均与CF-01诊断库分离。本地测试使用独立本地数据库，不对未知既有数据库执行migration；同时保留scope/origin隔离。binding固定为 `DB`，私有R2 binding为 `BOOKS`，静态binding为 `ASSETS`。schema migration有版本、checksum和幂等检查，部署前备份。

本次check初始化曾把整个schema提交至REST `/query`，返回 `incomplete input SQLITE_ERROR`，主Agent已确认没有表生效；当前改用官方Wrangler的 `d1 execute --remote --file` 方式初始化，再核对远端schema。该调整尚不表示D1事务或云端验收已经通过。

| 表/状态 | 允许内容 | 约束 |
| --- | --- | --- |
| auth_config / sessions | verifier、generation、token 摘要、到期与撤销 | 无密码、原始 access/session key；单 owner |
| 固定SQL策略 / counters / admissions | 固定用途计数、窗口、request ID、IP HMAC | 唯一键和有界保留；事务预算 |
| catalog_books / catalog_files | 现有公开目录白名单字段及 base revision | 稳定 ID；只导入明确公开数据 |
| metadata_overrides | bookId、允许的 patch、version、updatedAt | 与 base 分表，CAS；categoryId 服务端导出 |
| public_state | 全局递增 publicRevision、导入版本 | 所有公开可见变更同事务推进 |
| file_registry | fileId、bookId、format、sizeBytes、eligibility、objectKey、sha256、etag、state、version | 私有；仅 confirmed 状态能授权；初始仅两份所选文件 |
| storage_state / upload_reservations | 实测账号占用/时间、项目 ceiling、预留/已确认字节、每次上传状态与校验值 | 单原子协调者；未知结果保留预算 |

严禁迁入 root、path、mtimeNs、textPath、源目录、SQLite jobs/问题/正文/历史、服务密钥、访问密钥或随机挑选的私有 JSON 字段。初始公开 base 可以迁入完整书目；私人 file_registry 只登记所选两份文件。CLI 读取本机 manifest 仅作源路径/大小/稳定性核对，不上传该文档或覆盖原文。选定文件 SHA256 可以按需读取计算，不扫描整库原书。保留本机现有文件、数据库及人工覆盖。

本机 `overrides.json` 可在一次 bootstrap 中按五个允许字段校验后 insert-if-absent；若 D1 已存在覆盖则报冲突/保留云端，不能重复导入覆盖云端编辑。以后 base 重新导入与 overrides 分离，不能重置 overrides 或现有对象登记。现有 Python import 会重建 manifest 的 storageKey/textPath，CF-03 CLI 不借用该操作更新云端状态，单独写CLI输出所示的私有staging/receipt路径。

### 元数据并发与快照

沿用 title（300）、author（200，可 null）、description（4000）、category（100）、tags（最多 20 项，每项 60）的既有规则；拒绝未知字段、控制字符、空标题/分类与不合格数组。禁止客户端设置 id/categoryId/files/objectKey/version。categoryId 仍由已知分类或 category 的稳定 SHA256 前缀派生，与 Node 行为对齐；使用文本方式渲染用户内容，不能以 innerHTML 注入。

GET book 返回严格 publicBook 及独立 metadataVersion（或明确 ETag）；POST metadata 的 `{expectedVersion, changes}` 使用 compare-and-swap，零行命中返回 409 `metadata_conflict`，不静默覆盖。更新 override、该书 version 与 publicRevision 在同一事务内。前端保留输入，展示冲突并重新读取，不能自动重放整表单。两标签页同时改同一本书的验收必须仅一方成功；不同书互不丢失。

快照 CLI 从主库读取只含公开字段的合并视图，分批导出前后读取 publicRevision，revision 变化就丢弃暂存并有限重试，不产出混合版本。若采用单 D1 batch 读取，仍验证响应大小与 Free CPU，不在 Worker 一次构建巨大 JSON。分页使用稳定 ID 游标，有确定的终点；持续变化导致无法一致时安全中止。快照标记sourceRevision，staging按CLI输出的私有路径保存，严格白名单校验、分类计数/统计重算、隐私检查后原子替换 `data/catalog.json`，不自动commit/push。主Agent review diff后构建发布，D1修改立即可由API读取，静态列表和无JS页在下一次经过验证的部署更新。

公开快照保持现有 schema：顶层 schemaVersion/generatedAt/sourceStatus/thresholdBytes/stats/categories/books；stats 仅 books/files/totalBytes/candidateBytes/candidateFiles/localOnlyFiles/invalidFiles 七个数；分类仅 id/name/count；书籍仅 id/title/author/category/categoryId/tags/description/files；文件仅 id/format/sizeBytes/status/reason/visibility/readable。不得 spread 数据库记录或私有 manifest。上传可用性按明确契约映射现有状态字段，候选/可阅读格式不等于已上传或已授权。sourceRevision 可放私有 receipt，若加入公开 schema 先修订契约与消费方，不能偷偷扩展白名单。

## 4. 文件授权、签名与阅读

`GET /api/files/:id/access` 要求有效会话，先检查权限再查私有文件，匿名对已存在/不存在ID一律401，避免枚举映射。只允许state=confirmed、sizeBytes为安全正整数且<=20,000,000、对象属于固定项目桶/允许前缀、文件格式合法的记录。读取registry的version、SHA256、ETag、大小、格式后，必须调用 `BOOKS.head` 核对实际对象大小、规范化引号后的ETag、`customMetadata.sha256` 与MIME；缺失或不符返回409，不发URL。HEAD返回后在同一个主库事务重新验证有效session/current generation、当前registry版本与完整不可变descriptor，以及公开目录对应file descriptor，防止等待期间撤销或换版。未登记/待上传/uncertain/不合格文件不给URL。客户端不能提交objectKey、bucket、格式或签名参数。登录不能绕过大小门槛；桶及r2.dev继续私有。API与快照只有在当前confirmed登记的fileId、bookId、format、size完全匹配时才显示uploaded；否则base遗留uploaded降为not_uploaded。

响应固定为 `{url, format, expiresAt, mode:"r2"}`，expiresAt 为 ISO8601 UTC，签名只授权 GET、指定对象、固定 300 秒；不签 PUT/DELETE/任意 method，不把 GET 签名当 HEAD 授权。Range header 不绑定为固定值，允许同一短期 GET URL 请求合法字节区间。匿名不能取得签名；拥有尚未到期 URL 的持有者可以在无会话时读该对象，这是 bearer URL 本身的特性，不能把“直接 URL 必须有 cookie”列为验收。依据[R2 官方签名说明](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。

private API 响应 `Cache-Control:no-store`、`X-Content-Type-Options:nosniff`、`Referrer-Policy:no-referrer`，不进入 Cache API。对象元数据也应为 private/no-store；浏览器取得字节、下载和已打开 reader 不受登出即时清除。会话撤销立即阻止新签发；已签 URL 最长残留 300 秒，不能宣称即时吊销。如将来要求逐 Range 即时会话检查，应另设计 Worker R2 代理和请求预算，CF-03 不顺带实现。

R2 CORS 精确允许生产来源的 GET/HEAD 和 Range 必需 header，暴露 Accept-Ranges/Content-Range/Content-Length/ETag；不开放星号 origin、写方法或 credentials。仅在仍需本机开发读真实桶时保留已核实的本机来源，Pages 默认不开私人能力。CORS 限制浏览器行为，不能替代签名鉴权。API 签发后不输出 URL 到日志、referrer、埋点或公开 receipt。

前端统一 access/fetch helper，阅读页和详情下载共用：缓存仅在内存，expiresAt 前预留约 30 秒裕量重新申请；一轮读取只允许一次签名更新。R2 403 且已近到期/到期才重新访问受鉴权的 access endpoint 再 fetch，401/429/503、普通未到期403、文件撤销/410不盲重试；权限失败提示重新登录或等待。不得无限循环或在每次翻页重新签发。GET下载可在新URL后重启一次，丢弃部分旧响应；不能把新旧不同版本拼接。Range 如需恢复必须匹配对象版本/ETag。

CF-03 保留现有 reader 的小文件完整 fetch→ArrayBuffer→PDF.js/epub.js 模式，不声称已实现 PDF 网络分段读取；浏览器翻页使用本地已授权字节，TTL 到期不需要为已读取数据续签。Range 支持通过真实签名 GET 单独验证。EPUB 禁止 scripted content，PDF 保持 isEvalSupported=false，不能为上线放宽脚本执行。真实 EPUB 中的外链/资源应检查，不把正文插入顶层 DOM，出现危险行为则阻断该文件验收。

## 5. 逐文件上传、共享预算与恢复

所有上传先 dry run；本阶段每次执行仅一个明确 fileId，先 EPUB 验证成功后再 PDF，不并行、不展开目录、不自动挑全部 candidate。两份原书均须稳定、非空且 <=20,000,000 字节，源文件 realpath 在本机 manifest root 内、前后大小/mtime 一致，按需 SHA256。不要修改源书或自动转换。

现有 uploadSelected 的本机锁和静态 `SHELF_R2_EXISTING_BYTES` 不足以证明云端共享预算；CF-03 使用同一个 D1 协调状态与唯一 reservation。先核对账号 Free 状态、R2 Standard 共享免费使用、项目现有对象和 pending 上传，再原子检查并加预留。账号全部桶 GraphQL 读取已被自动审核拒绝，理由是可能包含其他项目 metadata、超出现有项目授权；不得重试或改用其他端点绕过。当前可读取的项目桶用量不等于全账号共享用量，`.env` 中 EXISTING_BYTES=0 也不构成新鲜证据。

CLI 接收本机可信 account-storage evidence 文件，验证账号匹配、采样时间新鲜、完整覆盖共享用量、来源可核对；unknown/不完整/过期一律阻断真实上传。先完成实现/review/测试及隔离auth验证、同源API发布（文件能力标为尚未真实验收），形成具体一份EPUB与一份PDF上传预览；主Agent在最后向用户请求最小“账号R2共享总量只读、不读对象或桶名”的额外授权，获准后采集证据并继续两份书。此前代码和auth工作不依赖该权限。该确认来源于本次自动审核拒绝，不是本文自行添加的批准流程。

项目保守条件为 `最新实测账号已占用字节 + 本项目累计已确认字节 + 活跃预留字节 + 本次字节 <= 8,000,000,000`，同时满足扣除账号其他资源后更小的可用空间。账号指标即使带有新时间，也可能尚未反映最近上传；不得使用两者的最大值或扣减未经证明的重叠。允许 observed 与 committed、pending 重复计入而保守拒绝，不能以观测刷新为由清零本项目累计已确认字节。离线 dry-run 明示 D1 committed/reserved 尚未核对、projectedBytes 未知，不能把未知 ledger 当零；最终准入由原子 INSERT trigger 累加全部四项决定。上传前刷新观察值并设置短期有效期；观测滞后、账号外部写入无法由项目 D1 严格锁住，故保留余量、一次一文件、每次前后核对，不能声称对其他客户端实现全账号原子封顶。8GB 是项目预算，不是平台账单硬上限。已应用旧 schema 的项目测试库使用 `cloudflare/library/migrations/002-conservative-storage.sql` 重建唯一预算 trigger；先停止上传准入，在受控目标库执行完整迁移并回读验证后再恢复，不清空任何占用、预留或登记。

reservation INSERT 与预算加计在同一 D1 事务，唯一 fileId+sha256/目标 key 防重复。先持久保存 reservation，再进行 PUT；receipt 为 `0600`。选择不可覆盖其他版本的对象 key，使用条件写/存在性核对防止覆盖既有对象。CLI 中断、超时、响应丢失后标记 uncertain，保持完整预算预留；不按 TTL 自动释放，不直接重试 PUT，不把HTTP200当作登记完成。

恢复先 HEAD 对照大小、对象标识及上传的 SHA256 元数据，再 GET 核验实际 SHA256（两份小文件允许完整读回），ETag 不当作 SHA256，元数据标签不能证明内容。确认匹配后原子把 reservation 转 confirmed、预留转已确认、写入 file_registry，并递增公开 revision；重复确认幂等。不匹配保留隔离状态并停止，不覆盖未知对象。不确定对象无可靠不存在证据时不释放；确认从未写入或受控删除并验证后才能释放。任何自动删除仅限本次创建并有凭据的项目对象，不清理无关已有对象。

R2 操作数按账号 Class A/B 共享核对并给项目设置保守门槛；access 签发数仅能约束新链接，不能限制同一签名被重复 GET/Range 的操作次数。无需为预算宣传增加一个无法兑现的“绝对零费用”保证。不启用 Infrequent Access 或付费计划。

## 6. API 与前端能力契约

| 接口 | 权限/结果 |
| --- | --- |
| GET /api/health | 最小 ok，不泄露账号、binding/DB ID、版本秘密 |
| GET /api/config | apiConfigured=true、aiConfigured=false、localFilesEnabled=false、r2Configured、thresholdBytes、authScheme、privateHistory=false；不返回 token/key |
| GET /api/session | authenticated、csrfToken；no-store |
| POST /api/login | 同源 JSON `{accessKey}`，严格原子登录预算，成功新建会话 |
| POST /api/logout | 当前会话+CSRF，撤销后清 cookie |
| GET /api/books/:id | publicBook、metadataVersion 或 ETag；不能泄露存储映射 |
| POST /api/books/:id/metadata | 会话+CSRF，CAS `{expectedVersion,changes}` |
| GET /api/files/:id/access | 会话、文件状态及签发预算，5分钟R2 GET链接 |
| GET /api/books/:id/published | `{jobs:[]}`，不导入旧 AI 内容 |
| GET /api/books/:id/history | 登录后 `{jobs:[]}` 兼容，但前端按 privateHistory=false 不请求 |
| jobs POST / publish / job GET | 显式 ai_unconfigured/未启用；匿名私人路由先401，无后台调用 |
| /api/files/:id/content | 生产不开本机文件路径或后门，鉴权后明确 disabled；不是静态fallback |

云端前端通过显式 `PUBLIC_SHELF_API_MODE=same-origin` 选择同源，不能用“空 API URL 同时表示禁用和同源”。CF-02/Pages 默认 disabled，本机保留显式 URL/本机 fallback。静态 artifact 记录能力模式以防把 API 版前端误发到回退站。metadata 编辑与阅读独立于 AI 失败；登录后不能无条件请求私人历史而让未迁移路由阻断页面。公开静态页及无 JS 内容继续可读。

## 7. 发布隔离与回退

保留现有 `wrangler.jsonc` 和 `scripts/cf-deploy.mjs` 的 CF-02 静态安全默认；不得放宽它的任意 config/entrypoint/binding 校验后让普通静态命令携带生产 API。新增显式受控 API 模式/独立 helper，重建固定 Worker `the-shelf`、受审 entrypoint、`ASSETS`/`DB`/`BOOKS` bindings，`assets.run_worker_first=["/api/*"]`，其余路径按原静态资源与404策略；准确 `/api` 也返回API错误而非页面。未知 API 返回JSON404，不能 fallback HTML。路由行为依据[Static Assets 文档](https://developers.cloudflare.com/workers/static-assets/)。

API helper 继承账号一致性检查、专用凭证选择、最小子进程环境、无 shell、临时私有目录、secret 0600/无符号链接、完整日志脱敏、无raw异常和 uncertain 结果不盲重试。只能接受固定项目名/来源/桶、私有 allowlist 中已核实的 D1 ID；部署前读取远端设置对照现有 bindings，差异必须可解释，不能让配置把本项目接到未知数据库。不得把 CF-01 D1/诊断凭证当成生产业务资源。

secret通过受控stdin/平台secret API安装，不进入普通配置文件/argv；允许的普通vars只有第9节固定来源、scope与项目R2账号/桶，禁止任意透传 `process.env`。R2对象凭证不等于部署权限，部署token仅供受控部署子进程环境使用，不进入Worker；通用账号token不复制到GitHub。现有CI继续构建并保存仅公开artifact，缺单Worker专用token时部署步骤继续关闭。本机受控发布仍在既有授权内；不得把GitHub构建成功说成CI已部署。

顺序：保存当前 CF-02 部署版本和公开 artifact/sha、导出专用 D1备份→隔离 Free 验证→实现与review→本地测试/构建/隐私检查→建立生产D1并只导入允许数据→commit→push GitHub→观察现有CI（Cloudflare构建、部署跳过；Pages按回退配置）→受控本机API发布→线上复核→逐文件EPUB/PDF与reader验收→记录完成状态。生产初始化和上传只在对应门槛通过后进行；未通过则不宣称CF-03完成。

先部署独立 `the-shelf-cf03-check` Worker，使用同代码与DB/BOOKS binding，SITE_ORIGIN为它自己的workers.dev来源，不带公开静态资源，独立check D1/owner access key/pepper/session secret，仅合成业务数据；R2签名凭证为上述现有真实桶专用RW凭证。check不得读取production会话/覆盖/文件登记，不签生产books对象，不接触原书或生产owner key；任何check前缀对象写入仍受共享usage证据门槛限制。CPU/atomic/security门槛通过才替换主站Worker。profile专属验收材料放入 `.local/cf03/{check,production}/`，共享DB allowlist与工具receipt路径按前文实际工具约定保存。受控helper必须要求显式目标模式，不能仅以cwd/同账号推断生产许可。静态网站当前主域不切到check Worker；static helper也要检查远端现有设置，一旦已有API入口/binding就拒绝用普通静态部署覆盖，显式回退模式除外。

回退：先停止新上传/签发，撤销会话/禁用新登录；回滚 `the-shelf` 到保留的 CF-02 静态版本及 disabled API 前端，确认首页/文档/404仍正常；必要时 GitHub Pages仍可作公开回退。D1和私有已验证对象保留待检查，不自动删库/删书或恢复旧库覆盖新metadata；不为代码回退执行破坏性反向migration。对已签链接等待最长TTL过期，紧急对象吊销需单独限定目标且记录。回退后只报告静态可用，API/私人阅读未上线或已停用。

## 8. 验收与证据

### A. Free鉴权前置门槛

在真实目标账号Workers Free隔离环境，以与生产相同的代码/compatibility_date/绑定/schema进行：正确/错误/畸形key、限流拒绝、session查询、CSRF失败、冷启动/热请求、D1可撤销会话与generation切换。先用独立合成随机凭证，不使用真实所有者密码；测试诊断入口不得裸露。本轮多次优化的采样预算：每个候选版本冷启动与热请求各21次、单版本合计不超过50次，整轮最多150次；CLI初始化诊断另计。每个版本的完整结果都保留，不选择性报告较低样本。

使用Cloudflare实际tail/analytics的CPU字段采样，保留采样来源、样本数、p50/p95、可取得的真实max、1102/其他错误和D1行读写；可信GraphQL分位或按秒单请求记录可作证据，P99不能冒称max，拿不到raw max须明确报告缺失。`Date.now`/wall time、单次200、CF-01旧探针或本地Miniflare均不能代替CPU证据。Workers Free当前10ms CPU限制依据[官方限制](https://developers.cloudflare.com/workers/platform/limits/)。目标样本p95<=5ms、可取得真实max时max<10ms且零CPU-limit错误，冷启动另记录；P99不是max，raw max缺失须如实写明。当前每日D1写入保守上界为36,220行（CLI初始化诊断另计）；同账号Volt用量未知，不能保证免费额度。余量不足则评估减少D1往返，不降低凭证强度。动态API日预算最多1000请求。拿不到可信CPU字段时明确门槛未通过，保留静态部署，不开付费。

### B. 本地与隔离集成

运行原有 `npm test`、Cloudflare构建、`npm run verify:public`，再加适用的真实安全/状态测试：

- 原子预算：同时至少20个请求争用剩余1额度，仅一个成功；多IP竞争global、同IP跨isolate、登录失败计数、UTC/分钟边界、D1失败回滚；不因超限部分扣了另一预算，也不超发。
- 会话：固定cookie属性、会话固定攻击、到期、登出及轮换后下一请求401；验证后/INSERT前轮换竞态；无Origin/错误Origin/错误CSRF/非JSON/超16KB体积拒绝；不记录key/token/body。
- 文件：匿名现有和未知ID均401；未登记/大于20MB/空/uncertain不给URL；URL只GET单对象5分钟，不允许构造key；不返回本机路径；GET签名不能冒用PUT/HEAD。
- metadata：既有验证规则、未知字段拒绝、同书CAS冲突、不同书并发、base重新导入保留override、snapshot分页期间revision变化不落盘；未知私有字段“投毒”不能出现在snapshot/API。
- 数据上传：一文件预留、两CLI竞争同一剩余额度、重复reservation/确认幂等、PUT前后中断、响应丢失、对象已存在/内容不符、hash核验失败、预算观察过期，均不能重复PUT/释放未知预算/标记可用。
- helper：CF-02默认拒绝脚本/binding；API模式拒绝未知DB/桶/账号/入口/route/secret var、符号链接/不安全权限/CI通用token，失败日志和artifact无明文秘密。
- 前端：disabled/本机/same-origin三模式，访问密钥文案，AI按钮禁用、metadata不依赖history、到期刷新一次、401/429不重试，失败不无限循环。

schema本地测试不能替代D1真实并发/rollback测试，HTTP测试不能替代reader渲染。

### C. 生产两文件与线上闭环

1. 记录当前账号Free状态、共享用量与项目预算；从现有私有清单明确选择一份EPUB，dry run→单文件预留→PUT→HEAD与完整GET SHA256→confirmed。检查匿名access401、桶公开直连拒绝、对象登记可恢复。
2. 在生产Origin登录：错误key失败、正确key成功，session/CSRF可用；元数据更新后API即时可见，另一标签页旧version409；导出公开snapshot、审阅diff并构建/发布后静态详情与分类一致。若为验证修改真实metadata，使用明确可恢复内容并最终恢复，不造无意义公开数据。
3. EPUB从详情进入reader，验证首章、下一页、目录跳转、主题/字号、刷新恢复浏览器进度与原文件下载；SHA256对应原文件。再按同样流程逐个上传PDF，验证首末页/翻页/页码跳转/缩放/目录（原文件有目录时）与下载。
4. 对两对象执行真实签名GET Range：起始、末尾suffix、开区间、越界416及Content-Range/Length/MIME；验证CORS生产来源和不允许来源。GET URL到期后失败，重新鉴权签发的新URL成功；登出/轮换后不能再取新URL，旧URL在最多300秒内的可用性按bearer契约记录。
5. 登录/编辑/reader及失败响应no-store、无secret/路径泄露；public/dist不含原书/正文/源路径/对象key/owner key；主页、详情、文档、raw、机器索引与404复核；Pages仍为公开回退且不尝试私人API。

优先补实际浏览器reader闭环；如果当前CUA/浏览器工具仍不可用，记录具体工具限制，继续完成HTTP/Range/hash/签名/鉴权验证并尝试本机可用自动化浏览器。未获得实际reader渲染证据时，只能标记“API与文件链路已验证，reader浏览器验收待完成”，不能把HTTP200或旧PDF本机证据称为CF-03完整验收。

### 完成与阻断记录

只有CPU门槛、原子并发、私密边界、真实两文件及reader、测试/构建/隐私、主Agent review全部通过才把CF-03标为完成。记录本地测试结果、commit、push、远端workflow状态、实际生产部署版本、线上验证与回退演练结果，分别列出。CF-03没有真实AI/Workflows能力。

当前尚未完成的门槛：CPU P95<=5ms（历史首轮P95/P99=5.634/13.184ms；SQL优化冷5.313/10.873ms、热4.236/5.830ms，42样本合并5.313/10.873ms；最近小优化版本包含部署后首次访问的首轮21请求P50/P95/P99=2.512/6.554/10.981ms；同版本后续完整热轮21请求（不能保证复用同一isolate），HTTP/66断言通过，CPU P50/P95/P99=2.341/6.017/6.180ms，errors均为0；两轮P95都未达到5ms目标。六个版本/轮次共126请求，另有2次tail健康检查，共128次（低于150）；最终候选版本首轮21次与同版本后续完整热轮21次，共42次。无raw max且tail连接后无CPU events；P99不代表最大值）、R2账号共享用量完整证据、生产auth安装/登录验证、两份真实上传与reader浏览器闭环。安全/CAS/撤销、D1并发最后一槽及合成导入/snapshot已通过相应云端检查；最终本地138项Node、8项Python和DOM断言通过。check/production D1已独立建立，production库空；production secrets未装Worker或写auth。仅EPUB 1,799,179 bytes与PDF 2,588,862 bytes的dry-plan因`account_storage_unknown`阻止，无原书上传、无真实AI。额外账号总量只读权限仍待授权；The Shelf与Volt同账号，Volt没有R2（只读核查通过），Workers/D1额度共享且Volt用量未知。CF-03 P1继续进行中，下一步先做调用级CPU观测，再评估减少D1往返原型；不改5ms目标，仍需计划、Sol实现、主Agent review和云端采样；CF-04及AI等待CF-03。代码与默认disabled静态改进待按已有流程发布，以receipt为准；API不发布，当前保留CF-02静态站。不得放宽5ms目标、降低凭证强度或付费绕过。

## 9. 实现方精确契约（review后的基线）

### Worker配置、作用域与秘密

生产 name=`the-shelf`、APP_SCOPE=`production`、SITE_ORIGIN=`https://the-shelf.iamzhutuo.workers.dev`；check name=`the-shelf-cf03-check`、APP_SCOPE=`check`、SITE_ORIGIN 为该固定Worker实际HTTPS origin。entrypoint固定 `cloudflare/library/worker.mjs`。普通vars只允许 `APP_SCOPE`、`SITE_ORIGIN`、`R2_ACCOUNT_ID`、`R2_BUCKET`，后两者来自私有受控allowlist且桶固定 `the-shelf-books`；DB ID不放入公开源配置。秘密名精确为 `OWNER_KEY_PEPPER`、`SESSION_SECRET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`，不同时接受同义别名。check/prod的database ID及前两份秘密必须各自独立。check也不能持有覆盖其他桶的签名密钥。

每条auth/session/catalog/override/file/counter/admission记录都带scope；所有查询显式绑定scope，不由请求参数选择。auth_config额外存固定origin，每个请求对照部署固定SITE_ORIGIN，拒绝未知Host。会话HMAC绑定scope+origin且cookie为host-only，各环境不能重放；generation各自递增。生产文件key前缀 `books/`，check只允许 `cf03-check/` 合成对象。私有数据API不得提供任意scope查询。storage_state为每库唯一预算，production为实际上传唯一协调者；check仅使用小型合成对象，容量仍计入账号共享总量。数据库不能锁住其他环境或账号其他项目。check仅清理check库。

初始化CLI分为 generate（只排他写本机0600文件）、install-secrets（明确check/production，只安装secret）、initialize-auth（事务写指定scope verifier/generation）、deploy（不隐式生成或轮换secret/改DB业务数据）。迁移schema为显式命令。所有步骤幂等检查，不得为了第二次运行重置generation、计数或其他scope。

### HMAC编码

owner key / pepper / session secret / 原始session token均为32字节、规范base64url无填充（43字符），解码后必须重新编码相等。HMAC密钥为base64url解码后的32字节；消息是UTF-8，精确前缀/换行如下（无末尾换行）：

```text
owner:   the-shelf/cf03/v1/owner\n{APP_SCOPE}\n{SITE_ORIGIN}\n{accessKey}
session: the-shelf/cf03/v1/session\n{APP_SCOPE}\n{SITE_ORIGIN}\n{rawSessionToken}
csrf:    the-shelf/cf03/v1/csrf\n{APP_SCOPE}\n{SITE_ORIGIN}\n{rawSessionToken}
ip:      the-shelf/cf03/v1/ip\n{canonicalIPOrIPv6Prefix}
```

owner使用OWNER_KEY_PEPPER，其他使用SESSION_SECRET。owner verifier与session_hash存HMAC-SHA256原始32字节的64字符小写hex；csrfToken输出HMAC的base64url43字符；IP key用小写hex。所有操作复用同一纯函数模块，初始化工具与Worker不复制不同编码实现。HMAC验证通过 `crypto.subtle.verify` 校验hex解码后的signature，不能仅凭43字符语法接受key。固定origin无尾斜线，scope只check/production。固定cookie名 `__Host-shelf_session`，成功login/session只返回authenticated、csrfToken，不返回原始session token。

### D1核心DDL与revision语义

下面字段/主键作为跨任务契约；完整migration须补固定policy、admission/预算trigger、CHECK/FK与索引并经过review，不把这段文档当成已执行migration。所有JSON在应用白名单校验后写入，不能信任仅json_valid。PRIMARY KEY字段改变等同数据迁移，不能实现方各自改名。

```sql
CREATE TABLE auth_config (
  scope TEXT PRIMARY KEY CHECK(scope IN ('check','production')),
  origin TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK(scheme='owner-access-key-v1'),
  verifier TEXT NOT NULL CHECK(length(verifier)=64),
  generation INTEGER NOT NULL CHECK(generation>=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  scope TEXT NOT NULL,
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64),
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  PRIMARY KEY(scope,session_hash),
  FOREIGN KEY(scope) REFERENCES auth_config(scope)
);
CREATE TABLE public_state (
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  base_revision TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE catalog_books (
  scope TEXT NOT NULL,
  book_id TEXT NOT NULL,
  public_json TEXT NOT NULL CHECK(json_valid(public_json)),
  PRIMARY KEY(scope,book_id)
);
CREATE TABLE metadata_overrides (
  scope TEXT NOT NULL,
  book_id TEXT NOT NULL,
  patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope,book_id),
  FOREIGN KEY(scope,book_id) REFERENCES catalog_books(scope,book_id)
);
CREATE TABLE file_registry (
  scope TEXT NOT NULL,
  file_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=20000000),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  etag TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uncertain','confirmed','disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope,file_id),
  UNIQUE(object_key),
  FOREIGN KEY(scope,book_id) REFERENCES catalog_books(scope,book_id)
);
```

catalog_books.public_json存该书完整publicBook（含公开files），不再另建catalog_files重复源；上表方案中的catalog_files仅表示逻辑文件视图。没有override时metadataVersion=0；首写expectedVersion=0创建version=1；其后UPDATE只允许version=expectedVersion并+1。GET book响应固定 `{book: publicBook, metadataVersion: integer}`，POST响应同结构；409响应 `{error:{code:"metadata_conflict"}, metadataVersion: current}`，不包含私有旧数据。POST只接受 `{expectedVersion: nonnegative-safe-integer, changes: five-field-patch}`；空changes拒绝。

metadata事务将当前patch合并changes、校验并CAS持久化、新version与public_state.revision+1一起提交。单纯base导入也递增public_state.revision；初始public_state revision=0，首次导入变1。base revision是内容hash/输入receipt标识，与全局递增revision不同，不用时间戳代替版本。仅公开可见变更递增public revision（会话/限流不递增，避免快照永不稳定）。快照外层私有receipt记录该revision与artifact hash，公开schema保持原样。

预算的固定policy直接封装在schema trigger中，不建由请求传参决定的policies表。精确责任由Worker与CLI共用同一schema模块：`counters(scope,kind,bucket,window_start,count)`复合唯一键、`admissions(scope,request_id,kind,created_at)`、`storage_state(id=1,account_id,observed_account_bytes,observed_at,ceiling_bytes,reserved_bytes,committed_bytes,evidence_hash,evidence_complete,updated_at)`、`upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,etag,content_verified,absence_verified,created_at,updated_at)`。receipt/request ID不可由网页任意复用以免逃预算。reservation object_key全局唯一，scope/file_id活跃预留唯一；所有状态转移走固定事务/trigger。Worker access准入也原子检查session generation/file version，签名只使用该次准入返回的对象记录。
