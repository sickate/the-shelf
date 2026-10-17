# CF-03：Workers + D1 登录与私人阅读实施计划

更新日期：2026 年 10 月 17 日。状态：CF-03 P1 进行中、未验收；CPU生产门槛未通过，不发布API。代码及CLI修复均已推送并通过CI；默认disabled静态改进已部署并通过线上验收，以receipt为准。本文不是上线验收记录。

10月16–17日：第11节sampler及第12节固定Cloudflare管理adapter已实现并通过主Agent review；12.3兼容修正后共192项Node、8项Python通过，两CI成功。只读云预检因admissions实际276超过计划上界256而停止，业务0、写入0；本轮不再接续采样，关闭核验及实际消耗见12.4。不能把本地集成通过当CPU通过。

静态改进发布时本地验证为138项Node、8项Python通过；metadata真实DOM 11项与account真实DOM 9项断言通过。check/production D1已独立建立，check schema与002保守预算迁移已应用并回读，production库仍空。production secrets仅在本地生成，未安装Worker或写入auth；check Worker有四个secrets；check已关闭 `auth_config.enabled`、递增generation并撤销所有会话，workers.dev与preview URLs已禁用，D1和secrets保留未删除。多轮云HTTP安全/CAS/撤销及合成导入、snapshot保留override通过，原子20并发争用最后1额度仅1个成功。CPU结果、账号共享R2证据、生产登录/文件与reader闭环仍未达门槛。源码提交 `0ae8825` 已推送；Cloudflare CI `38724875134` 构建 artifact 成功，Pages CI `38724875089` 成功。首次真实静态 CLI 在任何 Cloudflare 写入前遇到入口循环并停止；CLI修复已通过主 Agent review，新增两项真实独立进程 static/API CLI smoke后总计138项Node与8项Python全通过。CLI修复提交 `3e1aa89` 已推送；Cloudflare CI `38725881041` 构建成功、部署按预期跳过，Pages CI `38725881116` 成功。默认disabled的静态改进已通过本机受控发布及线上验收：首次网络检查完成1248项后中断，随后仅恢复剩余56项，合计1304项HEAD均为200；32项GET与本地字节及MIME一致，缺失页、`/api/health` 与 `/api` 均返回404，runtime保持disabled；线上账号页经真实Chrome DOM验证，凭证控件为disabled。

本轮阶段收尾：CPU证据分析器与重复配置解码最小候选已分别提交并推送 `5a6242d`、`15cd401`，两阶段Cloudflare及Pages CI均成功；最终156项Node、8项Python、disabled build、真实secret隐私扫描与verify:static通过。check的HTTP/2首轮21请求、80断言、真实CAS两次mutation admission及generation撤销HTTP检查通过；warm未运行、满批维护未触发。

最后一次同窗只读取得平台aggregate requests=21、errors=0，CPU P50/P95/P99/max=2.090/4.387/4.835/4.835ms，sampleInterval=1、同一version；分析器仍判 `unknown/incomplete_evidence`，保留 `group_aggregate_count_mismatch`、`ambiguous_attribution`、`missing_request_traffic`，不能凭aggregate低值判通过。平台max现已可取，原始逐请求CPU序列仍缺；HTTP/1与HTTP/2负载不可直接用于优化性能因果比较。本轮云分支结束，不加预算或采样；最终账本business48/100、explicitManagement84/90、D1management38/40，另有1次受控helper部署（内部HTTP未精确计数）。关闭证据确认check auth=0、active=0、入口disabled；最终只读不改变状态，生产API未启用、主站静态不变。

下一优先级是以新鲜表基数另立有界验收计划，再完整收集两轮业务请求、等待analytics并核验真实CAS与满批维护；sampler和固定manager已完成本地验收，不直接接续已停止轮或现场扩大上界。 CPU/CF-03仍未验收通过；R2条件汇总授权已执行，但新鲜完整证据仍不足，无原文件上传。

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

现有 uploadSelected 的本机锁和静态 `SHELF_R2_EXISTING_BYTES` 不足以证明云端共享预算；CF-03 使用同一个 D1 协调状态与唯一 reservation。先核对账号 Free 状态、R2 Standard 共享免费使用、项目现有对象和 pending 上传，再原子检查并加预留。此前账号全部桶 GraphQL 读取因可能包含其他项目 metadata、超出现有授权而被自动审核拒绝，此拒绝保留为历史。用户随后明确给出条件性账号R2纯汇总只读授权：其当前只有The Shelf与Volt使用Cloudflare，复核Volt未启用R2、未发现其他当前R2占用后，可读取账号R2总存储及当月Class A/B数量汇总，并对照固定 `the-shelf-books` 桶汇总；不查询其他桶名、对象名或业务数据，不新建通用凭证、不修改Volt。若条件变化或出现不可归属的当前存储，停止受影响操作；不得以新授权绕过其边界。项目桶用量仍不能单独替代全账号共享用量，`.env` 中 EXISTING_BYTES=0 也不构成新鲜证据。

CLI 接收本机可信 account-storage evidence 文件，验证账号匹配、采样时间新鲜、完整覆盖共享用量、来源可核对；unknown/不完整/过期一律阻断真实上传。本轮条件授权已由主Agent核查并执行：Volt同账号、远端R2 binding为0，配置文档与源码核查未发现R2接入；只请求账号纯汇总及固定Shelf桶汇总。查询截至2026-10-15T11:23:42Z时，最新存储点为11:10:00Z，账号与Shelf的Standard/IA payload、metadata、object、upload指标均为0，但采样点已滞后超过5分钟。月初至查询时账号操作66次、Shelf46次，差20次包含历史账号管理操作；未将差额归属任何项目，未查询其桶名。原始audit/conclusion仅存于忽略的私有文件，未改写observedAt、未生成合格 `account-storage.json`，没有上传。后续在同一条件授权边界内取得新鲜完整证据后，仍须先通过CPU及生产API门槛，再按既定EPUB→PDF流程逐文件执行；当前CPU仍为主要上线门槛。

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

在真实目标账号Workers Free隔离环境，以与生产相同的代码/compatibility_date/绑定/schema进行：正确/错误/畸形key、限流拒绝、session查询、CSRF失败、冷启动/热请求、D1可撤销会话与generation切换。先用独立合成随机凭证，不使用真实所有者密码；测试诊断入口不得裸露。上一轮多次优化的历史采样预算：每个候选版本冷启动与热请求各21次、单版本合计不超过50次，整轮最多150次；历史实际128次。本次调用级观测采用第10节独立有限预算，不重置或掩盖上一轮记录。每个版本的完整结果都保留，不选择性报告较低样本。

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

静态改进发布时的阻断记录（以下为当时状态，最新见第10节）：CPU P95<=5ms（历史首轮P95/P99=5.634/13.184ms；SQL优化冷5.313/10.873ms、热4.236/5.830ms，42样本合并5.313/10.873ms；最近小优化版本包含部署后首次访问的首轮21请求P50/P95/P99=2.512/6.554/10.981ms；同版本后续完整热轮21请求（不能保证复用同一isolate），HTTP/66断言通过，CPU P50/P95/P99=2.341/6.017/6.180ms，errors均为0；两轮P95都未达到5ms目标。六个版本/轮次共126请求，另有2次tail健康检查，共128次（低于150）；最终候选版本首轮21次与同版本后续完整热轮21次，共42次。当时未取得平台max且tail连接后无CPU events；P99不代表最大值，本轮补查见第10节）、满足freshness的R2账号共享用量完整证据（条件授权已执行）、生产auth安装/登录验证、两份真实上传与reader浏览器闭环。安全/CAS/撤销、D1并发最后一槽及合成导入/snapshot已通过相应云端检查；当时本地138项Node、8项Python和DOM断言通过。check/production D1已独立建立，production库空；production secrets未装Worker或写auth。仅EPUB 1,799,179 bytes与PDF 2,588,862 bytes的dry-plan因`account_storage_unknown`阻止，无原书上传、无真实AI。账号R2总存储及当月A/B数量纯汇总的条件只读授权已核查并执行，但最新存储点仍不满足5分钟freshness、未生成合格evidence；The Shelf与Volt同账号，Volt没有R2（只读核查通过），Workers/D1额度共享且Volt用量未知。当时CF-03 P1继续进行中，计划先做调用级CPU观测，再评估减少D1往返原型；不改5ms目标，仍需计划、Sol实现、主Agent review和云端采样；CF-04及AI等待CF-03。代码及CLI修复已推送并通过CI，默认disabled静态改进已部署并通过线上验收，以receipt为准；API不发布，当前保留CF-02静态站。不得放宽5ms目标、降低凭证强度或付费绕过。

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


## 10. 调用与路由级 CPU 观测执行计划与阶段记录（2026-10-15，本轮云分支已结束）

本节是后续实施基线，不代表观测工具、优化或云端验收已完成。本次只读review覆盖 `worker.mjs`、`core.mjs`、`security.mjs`、schema预算/会话/CAS triggers及本文已有CPU记录；未读取真实凭证或私有原始证据、未恢复check、未触云。上一轮128/150是独立历史轮次，不与本轮拼接成更好看的分布，也不以新预算为由清空当日D1限额。

### 10.1 目标、边界与当前假设

目标是建立可复核的路由总CPU证据及云端函数调用栈证据，先区分共同请求开销、metadata业务处理与D1 binding周边序列化，再实施至多一个有证据支持的最小优化。保持256 bit CSPRNG访问密钥、HMAC verifier和畸形key的dummy verify、Origin/CSRF、主库即时session撤销与generation、元数据CAS、HEAD后文件descriptor复核、原子全局/IP预算、清理上界和现有费用门槛。不得以缓存会话/预算、弱化密码学、放宽5ms目标或付费解决采样失败。

本轮不启用生产API、不安装生产auth、不改变主站静态部署及runtime disabled，不上传原书或合成R2对象、不调用AI/Workflows。工具仅访问固定check Worker与独立check D1；不增加公开诊断路由、诊断响应字段或header，不在生产业务代码添加计时/console/custom spans。R2条件汇总授权已执行，5分钟freshness仍不满足；后续必须有有效采样时间，REST汇总若没有采样时间，查询时刻不能代替observedAt，不为CPU阶段放宽上传门槛。

现有代码给出的可检验假设如下，均不是已定位根因：

| 路径 | 当前工作量 | 应验证的问题 |
| --- | --- | --- |
| 所有合法API | 配置/URL及密钥格式检查，IP HMAC；可用cookie再做session digest；admission+ordinal+session同批 | 固定共同开销、binding返回处理、初始化/JIT或GC是否占主要样本 |
| metadata提前版本冲突 | admission batch→version/category条件SELECT→409 | 与CAS失败分支分开，不能用旧version快路径代替真实并发冲突 |
| metadata成功/真实CAS失败 | 上述两次D1后，分类ID/patch处理，再mutation admission+CAS RETURNING+latest version同批，共3次D1；清理时额外1批 | category查询扫描、D1数据编码/解码、返回JSON/对象分配是否昂贵；远端SQL耗时不直接计成Worker CPU |
| unknown category | SQL已优先known ID；未知才SHA256，最多64项promise缓存 | 首次hash与同isolate复用差异；不同isolate缓存不可假设命中，known ID不能被hash覆盖 |
| maintenance | D1当次ordinal为1或32倍数才批量清理 | 保留一次真实满批样本，不能通过删空过期行或避开ordinal降低测试工作量 |
| malformed login | 严格canonical校验，不抛decode异常，仍subtle.verify | 比较verify及共同路径，不能再用“畸形输入异常”解释已修版本的高值 |

历史10.873/10.981ms等仍保留。此前按邻近秒给请求贴CPU标签，只能作为候选关联：如有多个候选请求、并发CAS同秒、时钟漂移或未保存开始时间，离线分析器必须拒绝唯一归因。JIT、GC、平台差异只是待profile验证的推测。

### 10.2 证据分层与采样口径

1. **路由总CPU**：优先取得check限定的invocation原始CPU记录（实际字段、单位、request关联以实测schema为准）；没有raw CPU时，使用固定script/version/时间范围的GraphQL CPU分位及requests/errors，保留原始响应和可取得的sampling/confidence信息。先由受控schema查询确认字段，不假设GraphQL提供URL、HTTP状态或request ID维度。相邻请求记录只能建立关联，不能创造不存在的维度。
2. **函数调用CPU**：优先使用平台已部署Worker的runtime CPU profile，固定check和实际运行的version UUID，使用官方管理API或现有工具；不用可能指向未部署版本的latest。官方说明profile捕获的是最近活跃、已经加载的isolate，需捕获期间有流量；它不是历史回放、不能证明首次冷启动、也不保证抓到并发对中的每个请求。保存原始pprof及self/total/采样数；本轮不新增源映射配置；若现有profile不可读，先记录限制，另行review后再考虑源映射。Free/现有权限是否实际支持须由主Agent验证，失败不升级付费、不新建通用token。[官方runtime profiling](https://developers.cloudflare.com/workers/observability/profiling-in-production/)
3. **辅助结构信息**：本地测试可记录SQL/binding次数与D1 meta的rows_read/rows_written；云端只接受平台已有输出。D1 duration、trace span elapsed time、网络RTT、Date.now/performance.now差值都是不同口径，不能当CPU、不能用“总CPU减D1墙钟”等推导函数CPU。本轮不启用tracing；若以后确需它定位I/O结构，先另行补计划和隐私review，不能临时扩大本轮范围。[CPU与wall time口径](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)、[DevTools计时限制](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/)

GraphQL的Adaptive数据可能采样，低样本P95/P99只能描述本次有限样本，不能推出长期尾部保证；P99不是max，单秒count=1也不自动成为raw CPU。缺失/延迟数据不填0，不平均各秒分位或把各组P99拼成总体分位。有原始CPU序列时使用预先固定的nearest-rank方法计算P50/P95/P99与observed max；只有分组分位时，整体分布须另向平台查询同一完整范围，不以平均或加权平均分位代替。按平台字段保存原单位，报告统一ms；记录转换方式。无raw max继续明确缺失。[官方采样说明](https://developers.cloudflare.com/analytics/graphql-api/sampling/)

runner每次请求在私有receipt保存单调递增序号、预定route模板/分支、版本、客户端UTC开始和结束、server Date与Cf-Ray（若有）、预期/实际HTTP状态、body长度/hash及是否maintenance；禁止存accessKey、cookie、CSRF、body明文或签名URL。server Date仅辅助时钟核对。普通请求分配隔离时间窗口，不同路由不共享同一秒；跨秒、时钟不一致、count不匹配均标ambiguous/missing，不强行贴标签。真实CAS pair单独窗口，只报告pair聚合，除非raw平台事件能唯一关联，否则不能把较高CPU分配给200或409。旧证据分析同样拒绝歧义。

### 10.3 最小工具与实施分工

全程按 `gpt-6.1-sol / high` 实施安全/观测工具与SQL，主Agent review和真实云操作；Luna仅可做主Agent最终提供证据后的普通文档汇总。实施依赖如下，每块单独交review，不一次搭建通用监控系统。

| 工作块 | 可独立review的交付 | 前置与责任 |
| --- | --- | --- |
| CPU-01 离线证据分析器 | `scripts/cf-cpu-evidence.mjs`及对应合成fixtures/tests，纯解析：字段/单位校验、count核对、窗口关联、并发歧义拒绝、分位口径、缺失标识、版本隔离、秘密输出白名单 | 已分配Sol实施，主Agent review；无网络、默认无变更；不读取.env或整个.local；只显式输入证据文件，私有输出0600 |
| CPU-02 主Agent私有runner/采集 | 主Agent用受review的最小私有runner先保存固定manifest和预算预览，再显式执行；固定check origin/name/DB allowlist、redirect:error、timeout，无mutation自动重试；输出离线分析器的脱敏输入 | 依赖CPU-01 review；本轮不实现通用云CLI、任意查询工具或完整profiling工具；凭证读取与触云仅主Agent执行 |
| CPU-03 云端定位 | check恢复与关闭receipt、同版本baseline冷/热、一次能力probe及至多2个有效runtime CPU捕获、路由/栈分析，明确可解释与未知部分 | 主Agent执行、Sol分析；先证明观测字段和数据可关联，再消费完整请求预算 |
| CPU-04 一个最小优化 | 针对已定位热点的小diff与语义/竞态测试；例如metadata分类SELECT的扫描/返回量或一次SQL往返 | 只在CPU-03有证据后由主Agent明确分配Sol；不先改SQL/schema。若涉及新索引，先核算迁移与索引写成本；若需新架构，另写计划，当前停止 |
| CPU-05 验收与收尾 | 优化后同口径冷/热、安全回归、完整测试/构建/隐私检查、check关闭与证据汇总 | 主Agent复审及云验收；阶段工具/已审代码可commit→push→CI，生产API仍受原门槛限制 |

分析器必须拒绝重复request序号、重叠路由窗口、错误scope/version、非法/负数CPU、不明单位、请求数不一致、混入其他Worker数据、把HTTP状态当runtime status、把pprof捕获总量当请求CPU。提供单秒多候选、跨秒、CAS pair、GraphQL缺项/采样、微秒换算、分位不可合并的测试。主Agent对私有runner另核对默认dry-run、目标guard、预算用尽、执行中断、凭证不入argv/log、私有文件权限、重定向和错误脱敏；不修改业务响应来方便关联。

离线分析器输入先定义小型固定契约：`schemaVersion`、`scope=check`、版本标签、`requests[]`（序号、固定routeLabel枚举、开始/结束UTC、server Date若有、状态、预期分组）、`cpuGroups[]`（覆盖开始/结束、平台count/errors、CPU字段及unit/source、sampling元数据）、可选完整原始CPU数值序列。实际URL、书籍/文件ID、cookie/key/CSRF/IP和任意请求body不在契约中；未知字段拒绝，错误消息不回显输入。routeLabel固定为本次manifest允许的常量，禁止把URL/ID作为标签。仅显式文件读写，无.env、自动发现.local、网络或隐式Cloudflare查询。

时间校验同时覆盖：UTC格式、开始<=结束、请求窗口与查询窗口完全包含、采样秒的半开区间、额外/漏失流量、版本一致性、sampling/count含义。能够匹配单一普通请求才作该请求关联；CAS pair保留组标签，不把aggregate均分给两请求或不同路由。**归因失败仍必须输出完整、已验证的输入aggregate、全部样本计数与最高已有分位，并列出unattributed/ambiguous/missing；不得丢弃高值后计算更好的gate。** 阈值明确不达标时gate=failed，证据覆盖/统计量不足时gate=unknown；只有完整可信口径均满足才gate=passed，路由细分unknown不能冒称函数已定位。原始provider JSON仍仅私有保存，公开摘要只含固定安全字段。

runtime profile本轮只做供主Agent review的最小能力probe，不开发管理框架：先固定check已部署version UUID并确认有预算内流量，再使用现有受控认证请求 `POST /accounts/{account}/workers/workers/the-shelf-cf03-check/versions/{deployedVersion}/profile`，JSON为 `{"duration_ms":1000,"profile_type":"cpu"}`，返回压缩pprof直接写0600私有文件、限制大小；Authorization不入argv/log。根据官方文档需Workers Scripts Read或相应只读角色，不新签通用token；仅1次上述1000ms权限/能力probe；其成功结果也可直接分析，后续至多2次有效捕获、每次不超过5000ms，合计管理请求不超过3次、总捕获时间不超过11秒，不重试失败捕获。若unsupported/403/429或样本不足，保留响应类型与限制，不换端点/扩大权限/无限加流量；离线分析器与路由总CPU仍可独立交付。方法依据[官方profile API与限制](https://developers.cloudflare.com/workers/observability/profiling-in-production/)，本计划没有执行该probe，也不假设目标Free环境支持。

### 10.4 本轮有限预算与停止条件

本轮新增**最多100次check业务HTTP请求**，不是每天重新获得100次，不跨日偷偷重置。所有setup、首次请求、profile流量、失败、timeout、重试、检查退出状态均计入；上次128次仅作历史。预算预分配：baseline固定完整21请求一轮；一个候选冷/热同样21请求×2=42次；路由隔离/profile诊断最多16次；准备/关闭、必要专项和失败余量共21次，合计100。先纯离线CPU-01，云采集在其review后才执行；没有有据候选不消费42次。未使用某块不新增替代候选；每阶段有预算余额但无可信证据也不盲跑。

诊断最多16次，预定metadata success 4、旧version conflict 2、真实并发CAS 3对6、畸形login 4；包括profile窗口流量，不新增请求补满或刷health。建立路径的额外setup从21次余量扣，所有请求须先计入manifest。profile只做前述小probe，成功/失败都计管理请求。保持login/IP每分钟5、metadata/IP每分钟20等现有阈值，禁止高频回放、sleep后无限重试或为了profile放宽限额。成功session创建最多12次/本轮且同时active不超过10、login尝试最多20、metadata写路径尝试最多40；均须连同固定manifest验证可满足，不能执行后再调整分母。

管理面请求（GraphQL、profile、D1 REST、settings/deploy/关闭回读等）合计最多80次，子上限GraphQL24、profile3、D1管理24，其余29；每个明确查询窗口因聚合延迟最多3次读取，429/权限拒绝或profile unsupported不换端点绕过。D1本轮估算预留不超过100,000 rows_read、15,000 rows_written，含setup、维护满批、专项及索引成本；100次业务请求不自动保证该D1上界；执行前按当前schema计算各块最坏成本，不能只拿无过期行时的实测值。每批消耗与剩余记入私有ledger，实际meta在批后核对，下一批前按最坏值预留，超出即停。账号其他项目Workers/D1用量未知，不能据此宣称账号免费余量有保证；配额报错立即收尾，不升级付费，不启用外部日志服务、Logpush、Tail Worker或新观测资源。

本轮不启用Workers Logs或tracing、不新增源映射等观测配置；只分析现有平台CPU记录与最小runtime profile probe。私有原始profile/CPU证据文件合计不超过20MiB，不记录请求header/body；无法取得可信记录时保留限制，不扩大观测范围。

### 10.5 check恢复、固定对照与收尾

主Agent先回读固定check名称、独立DB ID、origin/scope、已应用schema/002、关闭状态及现有版本，保存可恢复版本/配置摘要和合成DB所需备份；不列其他项目资源。使用现有受控helper，不新增source maps或日志选项，不放宽生产/static默认。只恢复check入口及check auth，按generation单调递增启用，旧会话继续无效；不重装/打印生产密钥、不连接production D1。启用后先用预算内最少请求验证观测可取，失败立刻关闭，不先跑42次。

固定manifest在第一次执行前保存hash、顺序、输入大小、unknown category、预期HTTP及业务状态、维护安排；保留原21请求的完整业务负载，不替换为health。baseline的21次与候选每轮21次使用相同逻辑输入和种类，测试metadata有真正同expectedVersion的并发pair，并通过check D1 mutation admission/CAS结果证明race loser，而不是两次串行旧版本冲突。first-access轮只叫部署后首次访问，不保证isolate冷；hot轮也不保证同isolate。profile请求单独报告，不掺入候选最终21+21分布，不用简单请求稀释P95。

满批maintenance至少做一次：预置仅check合成的到期记录，在真实D1日计数达到下一个维护ordinal时触发，回读证明LIMIT删除上界；每轮维护安排一致并单列有/无维护样本。不倒减真实日/minute计数、不删当日准入来重获额度；如需测试fixture隔离，先review并保留真实消耗ledger，不把专项状态当正常预算证据。重置metadata用独立合成book/fixture或受控check数据准备，所有SQL/索引写计入本轮管理和D1预算，不改生产库。

所有分支（成功、失败、预算到顶、观察工具不可用、中断）均执行有界finally收尾：先关闭check auth并增加generation、撤销check sessions，再禁用workers.dev与preview URLs、停止profile/tail，确认没有遗留观测任务或新增观测配置，回读DB和入口状态。若关闭失败，不标收尾完成，记录未关闭资源和下一项具体补救；不删除D1/秘密/现有R2对象，不以恢复旧DB覆盖后来数据。主站静态始终保持原版本和disabled能力。

### 10.6 验收与回退

阶段1达标是离线分析器可复现且脱敏、主Agent私有runner采样输入通过review、实际check路由CPU可关联（歧义如实拒绝）、至少获得有足够栈样本的云端函数profile或明确平台不可用限制，并产出一个可验证热点或“暂无法归因”。profile不能覆盖的native crypto、binding内部和短函数采样误差须注明，不能把无样本解释为无开销。只有调用证据支持且最小变更能保持同事务/CAS/撤销语义时进入CPU-04；否则保留成果并停止，不无限变更架构。

候选必须完成本地现有完整Node/Python测试、构建和verify:public，并补强受影响竞态/错误分支；主Agent review通过才部署check。最终验收使用无debugger/额外profile或trace活动的同一候选版本完整冷/热21+21：每轮及合并均报告平台P50/P95/P99、requests/errors与缺失数据，P95<=5ms仍是门槛；若取得真实max须<10ms，raw max拿不到继续明确缺失；1102/其他CPU-limit errors必须为0。高P99仍报告并调查，不因HTTP200抹去；无法可信计算合并值或字段缺失时不宣称门槛通过。历史失败版本和本轮baseline均保留，不只展示最佳轮。

本轮不自动推广到生产：通过CPU仅解除这一项阻断，生产auth、账号新鲜R2 evidence、真实两文件与reader等既有门槛逐项执行后才判断对应发布资格。未通过则回到已审版本或保留候选本地代码，关闭check，主站维持已验收静态站；不会回滚已通过的静态改进。阶段工具可按commit→push→现有CI构建（部署仍按既有禁用配置）交付，分别报告本地、CI、check实验、生产未启用状态。

### 10.7 本轮阶段结果（2026-10-15）

CPU-01离线分析器已完成主Agent review修正，新增15项专项及CPU-01阶段当时153项Node、8项Python、disabled build、真实私钥隐私扫描、verify:static均通过；已用旧真实warm证据成功运行分析器，保留aggregate并拒绝missing startedAt的路由推断。
按固定旧候选version与完整时间范围补查：首轮21请求P50/P95/P99=2.512/6.554/10.981ms、平台max=10.981ms；后续21请求=2.341/6.017/6.180ms、max=6.180ms；合并42请求=2.409/6.180/10.981ms、max=10.981ms。三组avg.sampleInterval均为1、dimensions.scriptVersion相同；max.cpuTime的schema描述为“Maximum CPU time for one request - microseconds”，已按微秒转ms，区别于P99和仍未取得的原始CPU序列。
旧receipt仅有响应at，缺少完整请求窗口，分析器拒绝路由唯一归因但保留全部aggregate；CF-03 CPU gate仍fail。历史记录中的max缺失表示当时未取得，本轮补查不改写当时记录。私有证据位于 `.local/cf03/cpu-round-q2yZiT/`，不公开真实version UUID、账号ID或秘密。
profile流程首次恢复时health返回404（传播阶段，未调用profile），finally关闭；第二次明确等待30秒后health/session均200，唯一一次profile POST返回404、code10393“无近期执行”，未取得pprof；不能据此判定Free不支持或权限被拒。
最终check auth disabled、active sessions=0、workers.dev及preview disabled均已回读确认；production与静态部署未变，无R2对象写入。额外GraphQL已执行，累计业务请求3/100、管理请求26/80；固定check D1自本轮12:00Z起平台统计rowsRead=26、rowsWritten=18、readQueries=6、writeQueries=6（含两次启闭）。两个成功health/session执行已出现在GraphQL，sampleInterval=1，CPU P50/P95/P99/max=1.589/6.603/6.603/6.603ms；仅2样本不能判通过，也不与旧21样本混合；profile仍为10393。
下一步先补充较长但有限的一致流量窗口、route隔离诊断的计划及预算/失败重试口径，再交主Agent执行；当前暂无函数热点证据，不实施SQL优化，尤其不直接合并会改变登录失败计数事务的操作。

### 10.8 持续流量下的一次有限profile诊断（待主Agent review执行）

GraphQL已确认前次两个GET确实执行，profile10393不能判为unsupported；此前仅两次GET未形成持续流量。本次以此证据修订10.3“失败不重试”：改变流量模式后仅新增一次capture，属于一次明确的后续诊断，不循环重放失败请求、不放宽既有总预算。
主Agent先读回check auth/入口已关闭及当前active version，固定同一check与已部署version UUID；恢复check auth/entry后明确等待30秒传播，production与静态站保持不变。
从既有诊断配额取malformed-login 4次：合法Origin与JSON、固定无效人类字符串、无cookie或真实访问密钥，均预期401；不创建session、不写业务metadata，原子API及登录计数照常消耗，不清零额度。
首请求完成后启动唯一一次3000ms CPU capture，其余3请求以700ms节奏并行于capture，向最近活跃isolate提供持续业务；所有操作无自动retry，任一错误仍执行finally关闭。不能保证四请求落在同一isolate，须保留实际采样覆盖限制。
累计capture预计2次（原有1次+本次1次，仍低于3次上限），业务请求预计7/100（现有3+本次4）；管理请求硬停于45/80，D1管理仍不超过24。执行前逐项预留恢复/关闭与回读的管理余额，失败请求同样计入。
结束或失败均关闭check auth、递增generation并撤销会话，禁用workers.dev/preview，回读确认；失败原样保存status/code并停止profile分支，不换端点、不猜权限/平台原因，不增加流量补样本。
pprof仅用于函数热点定位，不并入最终gate分布；样本不足则定位未知，不以本地wall time推断CPU热点。仅在有效样本足够且显示具体热点后，由主Agent另行分配最小业务改动；否则交付诊断成果，不宣称优化已完成。

10.8实际执行结果：4次malformed-login均返回401；本次3000ms profile仍返回404、code10393，未取得pprof，profile分支到此停止，不继续尝试，也没有函数热点证据。
finally已回读确认check auth=0、active sessions=0、workers.dev/preview入口disabled；production及静态站未变。累计业务请求7/100、管理请求39/80（含新增一次GraphQL）。
这4请求的独立完整窗口具有相同version、sampleInterval=1，CPU P50/P95/P99/max=2.704/7.126/7.126/7.126ms；不与旧21请求混合，低样本不能证明通过。
离线工具已实际运行，报告P95 fail，同时保留 `fewer_than_21_requests` 与 `ambiguous_attribution`，不丢失aggregate或强行归因路由/函数。
check D1自本轮12:00Z起平台统计rowsRead=71、rowsWritten=72、readQueries=16、writeQueries=16；未创建session、未写业务metadata或R2对象。

### 10.9 重复配置解码去除最小候选（计划，待delivery实施）

由Sol/high先以独立Buffer oracle证明32字节编码为43字符：42×6+4个数据位，末字符两padding位必须为0；再export `isCanonicalKey` 复用既有精确regex，与 `decodeKey` canonical接受域等价。
`configuration` 对两个trusted secret仅做canonical格式布尔判断，非法仍503、两secret相同仍拒绝；`verifyOwnerKey` 共用helper且dummy HMAC verify不变，`importHmac` cache miss的实际decodeKey/import不变。
session/CSRF/SQL/原子预算/访问密钥强度均不变；只验证每请求少两次重复decode及分配，不声称已定位CPU热点或保证性能，profile分支保持停止。
补独立oracle、非法env在DB前失败、warm解码次数与cache miss测试；主Agent review及完整测试/构建/隐私检查通过后可阶段commit。
如做云对照，先明示同版本/固定负载/完整窗口及平台CPU计量口径，全部纳入原100业务/80管理预算；本地操作数减少不等于云CPU通过，生产部署仍受原门槛限制。

10.9候选云复测计划：候选3文件已主review通过，针对24项测试及完整156项Node、8项Python、disabled build、真实密钥隐私扫描、verify:static均已通过；候选待云复测。旧版本21/21/42保留为历史baseline，不再发送baseline21；候选最多部署check一次，首轮21完整原业务及后续21（首轮明确fail可停止），不混入profile的4请求、不预设CPU改善。
保留真实并发metadata pair，用已有generation UPDATE RETURNING同时核验本轮两个mutation admission，不新增往返；HMAC/session/CSRF/撤销/文件未注册检查照旧。每轮D1仅合成book INSERT及generation UPDATE两次管理调用，移除本变更不影响的冗余扫描，session/entry在最终关闭时统一核验。
业务累计最多7+42=49/100，显式管理fetch仍不超过80、D1管理子上限24维持。Wrangler helper内部HTTP不能精确计数，另明确授权本阶段仅1次固定check/原绑定的受控部署工具操作，与显式fetch ledger分开报告；不冒称CLI内部计数精确或总HTTP<=80已证明，这是统计口径的透明补充，不扩大平台费用、业务及D1安全上限。
helper若要求扩大资源范围或付费则停止，不操作production；当前主站静态部署不变，所有分支finally关闭check auth、撤销旧会话及关闭workers.dev/preview入口并回读。按完整固定窗口真实平台CPU报告P95<=5ms、max<10ms、CPU-limit errors=0门槛，不以本地操作次数或HTTP成功替代。

10.9恢复计划与拦截记录：提交 `15cd401` 的Cloudflare CI `38735625693` 与Pages CI `38735625931` 均成功，check已受控部署1次；子runner误用含CI:true的baseEnvironment，readProjectEnvironment以 `code=ci` 在任何业务请求/fixture写入前正确拦截。finally已确认auth=0、active sessions=0、入口disabled。
当前账本保留业务7/100、显式管理48/80、D1管理20、helper部署1；不清零、不重部署、不换凭证或端点。恢复仅在root本地明确非CI时向子runner传PATH/TMP/LANG等最小环境，不注入CI:true；先核验已部署candidate UUID及3份源hash未变，再恢复check auth/entry。
本次恢复/关闭额外D1开销将管理子上限由24有界修订为32，已用20继续计入；显式管理总上限80、业务100、费用/上传预算均不变，先预留足够收尾余量。仍最多原完整21+21请求，首轮明确fail可停止；所有分支finally关闭auth、撤销会话、禁用入口并回读，不修改业务源码。
第一次恢复的最小env已移除CI但漏传当前本地进程中的Cloudflare token，凭证guard以 `code=credentials` 再次在业务/fixture写入前停止并finally关闭；账本仍为business7、explicit56、D1管理24、helper1，32/80/100上限不变。
主Agent已在同一非CI最小env显式传入项目账号与现有token（仅子进程env，不落盘、不入argv/log）完成独立无网络preflight，账号配置、key格式及本地非CI检查均通过；此后才继续同一candidate版本，源hash/UUID不变、不重部署、不重放已业务写入，仍最多原21+21请求。

### 10.10 最后一次有界验收传输修正（计划与已有结果）

`15cd401`候选在check完成20请求、60断言后，真实CAS coverage断言失败：D1仅1条metadata mutation，另一409是提前stale，最后generation-session HTTP未发；不是完整21请求，不能判gate通过。
该20请求同version、sampleInterval=1，平台CPU P50/P95/P99/max=1.535/4.179/7.677/7.677ms、errors=0；样本少于21且CAS负载不同，较低P95不证明优化有效。当前账本业务27、显式管理68、D1管理31、helper部署1；auth=0、active=0、入口disabled已确认。
check D1本轮平台统计rowsRead=845、rowsWritten=285、readQueries=62、writeQueries=54；后续audit另读187行，可能尚未反映于该平台统计，不将延迟指标当最终完整成本。
仅由Sol修正private sampler传输，使用node:http2固定check、单TLS连接执行相同21项语义请求，CAS两stream并发共享已用连接；避免第二HTTP/1连接建立错开只是待验证假设，不是已证根因。race coverage断言移至21个HTTP之后，失败也保存完整窗口；不改业务源码。
主Agent完成无网络preflight与代码review后，仅对同一已部署候选执行，不重部署、不换凭证；最多部署后首个完整21及后续21，首轮明确失败即停，业务总计最多69/100；不保证首轮isolate冷或后轮同isolate，HTTP/2与旧HTTP/1基线不可直接作性能因果比较。
因现有余额不足，仅此一次透明修订显式管理上限80→90、D1管理32→40，用于有界采集、恢复和关闭；既有账本不清零，100k读/15k写行上限、费用/上传规则、安全要求和5ms门槛不变，不新开付费。
禁止追加candidate/profile或再扩大额度；失败或证据不足即保留阶段成果、停止本轮云分支。所有分支finally关闭auth、撤销会话、禁用入口并回读active=0；生产API保持关闭，不把传输修正或HTTP成功称为CPU验收通过。
主Agent在1次官方D1 query batch内，仅为check预置64条旧合成admissions、8条旧daily counters、128条旧minute counters及32条revoked/expired sessions，不禁用或绕过正常trigger，所选历史时间窗也须满足其限额；不倒减当日/分钟计数、不清空真实ledger，维护before统计整合auth读取、after整合既有generation RETURNING，无新增HTTP或额外DB往返。
候选两轮40次合法API admission至少覆盖一次ordinal32维护，按限量fixture的before/after与真实meta核对删除量；第一轮失败即停且不宣称满批证明，既有读写行上限及40次D1管理子上限不变。
10.10实际HTTP/2结果：首轮完整21请求、80断言、CAS metadataAdmissions=2及generation后HTTP authenticated=false均通过；控制器在3次GraphQL读取仍仅见3/21（avg.sampleInterval=1、same version）时按unknown停止，未运行warm，finally已回读auth=0、active=0、入口disabled。
当前累计business48/100、explicit83/90、D1management38/40、helper部署1；maintenanceAfter仍为old admissions64/daily50/minute142/sessions32，首轮未触发满批维护，warm及满批均未验收，不得称完整CPU验收通过。
现在停止全部business/profile/deploy，不扩大90/40/100；因官方聚合明显迟到，仅在剩余显式预算内增加一次延迟的最终旧窗口GraphQL只读（该窗第4次，对原每窗最多3次的唯一有界修订，无业务/传输重试），固定check、同version和原完整21窗口，不改范围稀释、不混旧20窗口；若仍不完整即unknown结束本轮。
HTTP/1与HTTP/2不能据此归因性能效果，CPU/CF-03仍未通过。后续阶段应先完整采集两轮HTTP再等待analytics，并将受控sampler固化、测试化，避免ops环境与采集时序错误；这是下一阶段事项，本轮不继续业务采样。

10.10最终只读收尾：第4次固定同version、原完整21窗口GraphQL读取已完成，aggregate requests=21、errors=0、sampleInterval=1，CPU P50/P95/P99/max=2.090/4.387/4.835/4.835ms；平台max是独立字段，原始逐请求CPU序列仍缺。
分析器gate仍为 `unknown/incomplete_evidence`，reasons为 `group_aggregate_count_mismatch`、`ambiguous_attribution`、`missing_request_traffic`；完整aggregate已保留，不能仅凭较低P95/max判通过，不与旧20请求或profile窗口混合。
最终ledger为business48/100、explicitManagement84/90、D1management38/40、helper部署1；auth=0、active=0、entry off的关闭证据来自candidate-h2-result，最后一次只读不改状态。warm未跑、满批维护未触发，本轮云分支结束，不再扩预算或采样，生产API及主站静态不变、无R2对象写入。
阶段提交 `5a6242d`、`15cd401` 均已push且各自Cloudflare/Pages CI成功；最终156项Node、8项Python、disabled build、真实secret隐私扫描及verify:static通过。下一阶段先固化测试受控sampler，业务两轮完整采集后再等analytics，验证真实CAS与满批维护覆盖，再另行计划云轮；CPU/CF-03未通过，R2新鲜证据不足、无原文件上传仍保留。

### 10.11 今日收工与下次接续（2026-10-15）

代码提交 `5a6242d` CPU证据分析、`15cd401` 去除重复配置解码及进度文档 `ab39b8b` 均已推送；三个提交的Cloudflare与Pages CI成功，最新CI `38740719898`/`38740720092`成功。
156项Node、8项Python、build、真实secret隐私检查及`verify:static`通过；静态文档经受控helper部署，32 GET内容/MIME一致、3个missing及API 404通过，runtime disabled。发布receipt保存在`.local/cf03/cpu-round-q2yZiT/stage-release.json`及`.local/cf03/live-static-resume-zLEFpQ/receipt.json`；网络中断与规范slash验证记录保留，最终协议混合，不能声称全部H2。
check已关闭auth、撤销全部会话并关闭entry；production API未启用，无书籍上传。CF-03未完成：新候选21 HTTP/80断言及真实CAS通过，aggregate P95=4.387ms/max=4.835ms，但分组证据不完整、gate unknown；warm和满批维护未验收，R2用量证据freshness仍不足。
最终ledger为business48/100、explicit management84/90、D1 management38/40、helper1，不重置。下次先计划、固化并测试受控sampler（环境传递、真实CAS、两轮HTTP完整收集后再等analytics、满批维护覆盖），之后另行有界云验收；不可直接追加采样或扩大本轮预算。
今日工作到此停止，不启动下一阶段。

## 11. 受控 sampler 固化（2026-10-16，本地验收完成）

本阶段承接10.11，复杂度高，由 `gpt-6.1-sol / high` 实现，主Agent设计审阅、集成验收与发布。目标是把临时采样流程变为仓库内可review、无网络可测试的固定check工具，避免环境传递遗漏、CAS提前stale、analytics迟到中断热轮及维护覆盖缺失。阶段开始时只有私有临时runner；当前实现结果见11.1，本地验收不代表CPU云验收已完成。

范围：固定check目标与版本契约、默认dry-run、有限预算和收尾预留、逐请求脱敏receipt、单HTTP/2连接与并发CAS、完整两轮HTTP后才读取analytics、真实mutation admission和满批维护证明、失败与中断时的有界收尾。管理适配器与凭证仅由显式注入的受控调用提供；工具不得自动读取.env或遍历.local、接受任意Worker/DB/URL、输出凭证或自动重试mutation。纯测试使用合成凭证和模拟平台，不访问云端。

明确不做：不修改Worker鉴权/业务/schema，不恢复check、不另开本轮云预算，不追加profile/候选优化，不启用生产API、上传R2对象、调用AI或变更生产部署。10.10最终账本原样保留，新一轮云验收须在工具review通过后另立有界计划及预算，不继承剩余额度为自动执行许可。

依赖与方案：先审阅现有临时HTTP/2 runner和离线分析器契约；实现固定21请求×2的采集状态机及可注入HTTP/管理/时钟适配器；保持每次mutation只发一次，CAS后通过D1的两条真实admission证明竞态路径，generation撤销后的HTTP仍包含在完整21请求中；断言失败保留已发送请求与窗口再停止。两轮全部完成后才进行有限analytics读取，迟到或缺失保留unknown，不掩盖较高CPU。维护证明独立记录触发ordinal和各类删除上界，不由HTTP成功推断通过。

验收：目标/版本/预算不合法时零外部调用；明确非CI与最小环境传递可测；单连接CAS双stream及两次mutation证明可测；21+21请求全部先于analytics；超时、解析/断言失败、中断、预算不足均保留receipt并执行收尾，收尾失败明确报告；不记录key/cookie/CSRF/body/签名URL，私有输出0600且拒绝符号链接；离线分析器兼容。主Agent review每次交付，运行专项及全部Node/Python测试、disabled构建、verify:public和verify:static。

发布与回退：仅工具与仓库计划按commit→push→现有CI交付；CI的Cloudflare步骤继续只构建artifact并跳过部署，Pages保留回退。公开静态站没有产品变更，本阶段不额外发布主站；生产API继续关闭。若工具验证失败，保留现有工具和静态部署，不触云；已推送工具可用revert回退。本地、远端CI、云验收分别报告。

### 11.1 实施与验收记录

Sol/high交付 `scripts/cf-cpu-sampler.mjs`、固定check的 `cf-cpu-sampler-h2.mjs`、[API与管理契约](../scripts/cf-cpu-sampler.md)及16项专项测试。主Agent逐项review并要求修正CAS重复序号与持久化错开、预检失败误写资源、等待超时、CI环境标识、写盘失败阻断收尾、关闭generation自比较、两批维护准备和跨平台读取隐藏请求成本；修正后复审通过。管理预检已拆成version、DB identity、DB state、entry各一次显式调用，不将跨平台事实伪装为单次D1查询。

真实Worker+SQLite无网络集成执行42个HTTP请求、40次真实API准入、两轮各两条metadata mutation admission，以及ordinal 1和32各一次64/8/128/32满批清理。两轮业务完成后才查询三个固定analytics窗口；延迟/缺失保持unknown。故障测试覆盖中断、超时、错误响应、重定向/大小边界、陈旧CAS、目标不符、符号链接、关闭失败及最后一次写盘失败。未触云、未上传对象、未改业务Worker/schema或本机私人数据；旧账本不变。

本地完整172项Node与8项Python测试通过，默认disabled的Cloudflare构建通过。首次全量重跑被沙箱禁止监听127.0.0.1而失败；在项目授权内允许本机端口后同套测试全部通过。公开产物及真实secret隐私扫描通过，verify:static覆盖1304项资源通过；远端CI以本轮交付报告为准。本地CPU明确unknown，不把模拟analytics通过当平台CPU证据。

此阶段只交付可测试的controller/HTTP2传输及管理适配器契约，没有真实Cloudflare管理adapter或可直接执行的云CLI。下一阶段须先由Sol实现固定管理adapter，明确每个真实HTTP、SQL batch、资源核验及保守读写成本，再由主Agent review、另立新云轮预算和观测任务前置核查。原10.10轮已关闭，不能重置或追加；CF-03、生产登录/阅读、R2新鲜证据与CF-04/AI门槛仍未通过。

## 12. 固定check管理适配器与新云轮（2026-10-16–17，本地验收完成、云轮只读停止）

目标：补齐第11节未实现的真实Cloudflare管理adapter，使固定sampler能通过明确的一次HTTP管理命令读取/修改独立check环境。当前controller及H2已通过172项Node、8项Python测试，提交 `26a6aa4` 已推送，Cloudflare CI `38837786472` 成功且部署跳过，Pages CI `38837786363` 成功；生产API仍关闭。复杂度高，鉴权/凭证、持久状态和管理边界由 `gpt-6.1-sol / high` 具体实现，主Agent负责方案、逐次review、集成、实际账号操作和发布。

范围：只接受显式注入的已核验项目账号、deployConfig及固定已部署check版本；封装固定deployment、DB identity/query、subdomain与GraphQL命令；固定SQL和合成fixture，不接受任意URL/SQL/scope。每个command最多一次HTTP，D1批处理按官方契约编码并汇总所有rows_read/rows_written，保留正常trigger和真实日/minute消耗。只返回sampler白名单字段，凭证不入argv、receipt、日志或网站；redirect:error、有界响应、AbortSignal、失败无重试。固定schema/002检查需核验实际SQL，不凭名义version推断迁移完成。fixture只能新增本轮固定合成记录，冲突停止，不覆盖私人数据或旧轮记录。

不做：不修改Worker业务/鉴权/schema，不重部署候选、不创建账号通用token、不碰production D1/auth或R2对象，不启用生产API、AI/Workflows、日志/tracing/profile，不扩大公开文档白名单。第10轮已关闭账本原样保留。适配器实施和纯测试阶段零云请求。

依赖/任务：先核对Cloudflare官方REST/D1/GraphQL契约与现有schema、fixtures；Sol实现adapter与无网络单元/真实SQLite SQL集成，必要时以小diff修复controller契约并说明；主Agent审阅每个目标、SQL与响应投影，验证中断、重定向、超限、缺失/错误meta、schema漂移、重复fixture、版本漂移及跨轮证明。读写估算必须区分保守预留和平台实测，拒绝没有成本依据的execute配置。

验收/发布：专项及全部Node/Python测试、disabled构建、verify:public、真实secret扫描与verify:static通过后，工具按commit→push→现有CI发布，Cloudflare部署保持关闭、Pages回退照常。失败则保留现有静态站，工具可revert，不回滚私人DB或重置真实计数。

云端执行为后置子阶段：adapter review和本地验证通过后，主Agent先补写12.2实际版本、固定命令清单、成本、观测前置核验和新轮独立有限预算，再在现有项目授权内执行；计划满足后不重复索要确认。没有通过这些前置门槛不恢复check、不发送业务样本。新轮仅同一已部署候选21×2，不加候选/profile/重试/原书上传；完整两轮后才等待analytics，缺失保留unknown。所有分支有界关闭check auth、增加generation并撤销会话、禁用entry/preview并独立回读；关闭失败明确报告补救。主站保持disabled，CPU通过也不等于CF-03或私人阅读上线。

### 12.1 adapter实施中的契约修正

原 `costs.business` 对每个HTTP都预留一次满批维护，42次重复计入会虚增至超过15k写行门槛。改为普通业务成本与 `costs.maintenance` 分开：首mutation前持久预留两批维护成本，两轮各20次连续准入、每轮不跨UTC日，按ordinal 1/32最多各触发一批。该估算依赖隔离check与真实admission增量证明，发现额外流量或ordinal不符即失败；不能宣称已经证明不受控外部并发下的行数硬上限。原100k读/15k写数值门槛不变；schema索引、trigger及fixture增长均计入成本公式，业务保守预留与管理平台meta分列。

上一云轮最终aggregate=21但groups仍为首次3条；[官方metrics说明](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)也提示近几分钟聚合存在延迟。增加显式 `analyticsDelayMs`（0..300000）：42个HTTP完成后、首次analytics前有界分片等待，下一云轮拟300000ms；仍每个固定窗口最多3次读取、不追加业务、不保证等待后数据一定完整。延迟/采样/缺失仍保持unknown，不改CPU阈值或分析器口径。

Sol/high交付固定manager与14项专项测试；主Agent复审关闭后禁止重新启用、按真实rowid核验CAS、schema/002逐对象SQL对照、全批meta求和、非法/缺失分组仍保留有效高aggregate，以及非事务部分提交后不重试/不回滚旧账本。计数增长按慢请求最坏跨分钟估算为400，成本公式及其隔离前提见[sampler操作说明](../scripts/cf-cpu-sampler.md)。完整187项Node、8项Python、格式检查、disabled构建、公开产物检查、真实secret扫描及1304项静态资源检查通过；远端CI以本轮交付报告为准。

### 12.2 单次新云轮（已执行并停止，结果见12.4）

本轮独立于已关闭第10轮，旧账本不重置。只使用收尾receipt固定的同一已部署candidate UUID，私有operator核对其worker/security/core三份源码hash未变；不重新部署，不换凭证。账号来自项目私有环境、DB来自既有deploy allowlist，所有标识与原始证据留 `.local/cf03/manager-round-20261016/`（0700/0600）。默认dry-run已完成无网络本地验证，真实execute独占创建run-start，拒绝重放/续跑。

新轮上限：business=42、explicitManagement=44、D1 management=20、保守rowsRead=100000/rowsWritten=15000、原始证据20MiB；正常操作只允许用到40次管理/18次D1，另4/2仅供失败后的受review补救，不自动重试mutation。sampler本身预留28次管理（含最多9次analytics）/12次D1，另有settings与tails各前后一次只读，共预计32次显式管理；调用前持久化外层账本，失败/timeout照计。首mutation前已预留四次独立关闭/回读及两批maintenance。

表初始上界：admissions256、counters512、sessions128、catalog_books32、metadata_overrides32、catalog_import_rows16、file_registry4、upload_reservations8，其余schema表各4；当前公式预留69500读/10516写，外部settings/tails不读写D1。adapter在只读inspect里核验实际表行数及schema，不符合就停止，不现场扩大假设或门槛。预算是保守估算，实际D1管理meta独立汇总；业务meta与共享账号余量未知部分明确报告，不冒称已证明整账号免费余量。

先读取固定check settings校验原绑定、无新增logs/tracing/logpush/tail consumer，再GET固定Worker tails要求为空；旧profile receipt证明前次有界capture已结束，本轮不启动profile/tail。未知活动或权限不足即停止，不删除外部活动、不扩大权限。manager再独立核对固定已部署version、DB身份、真实schema/002、auth关闭/active0、entry/preview关闭后才启用check。沿用已记录Free环境，不升级付费或修改套餐。

依固定H2连接完整21×2，真实CAS和generation HTTP、40次API准入及满批维护按receipt证明；再等待300000ms，按首轮/后轮/合并三个固定窗口各最多三读。HTTP失败、CAS提前stale或证据未知则保留完整已有窗口并停止，不加业务、candidate、profile或扩大窗口稀释。CPU门槛仍P95<=5ms、平台max<10ms、errors=0，不能把unknown写成pass。

所有分支由controller有界finally关闭auth、递增generation、撤销会话，禁用entry/preview并分别回读。外层记录写失败也不阻断这四次关闭尝试；关闭失败明确列未核验项，再在保留的补救预算内review具体修复，不标收尾完成。结束后再只读核对settings/tails；不删除D1、secret或旧对象/消费记录，不改主站静态或production。工具先commit→push→现有CI，门槛通过后在已授权范围内执行本计划，不再索要重复批准；结束记录实际CPU、消耗、关闭状态及未过门槛。

12.2首次前置读取：源码 `2b96e40` 两CI成功后执行，固定Worker settings返回logpush=false、tail_consumers=[]，但完全省略observability。严格operator据此安全停止；ledger management1/44、D1=0、business=0，无auth/entry写入。原始settings与停止记录保留，run-start不删除、不重置。

### 12.3 前置settings缺省语义适配（同一12.2轮，本地验收完成）

主Agent核对锁定的官方Wrangler4.151.0源码：`normalizeRemoteConfigAsResolvedLocal` 对远端配置调用 `normalizeObservability`；当整个observability缺省时返回enabled=false、logs.enabled=false、traces.enabled=false。其部署代码也将缺省配置发送为 `{enabled:false}`。这与新建项目模板默认true不同，不能将两者混用。[Workers Logs说明](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)同时说明写入日志需启用observability。以已锁定SDK远端归一化契约为依据，Sol/high补纯解析helper与反例测试：只接受完整字段缺省或合法明确disabled对象；null、错误类型、任何enabled配置、缺失/启用logpush或未知tail consumer状态仍拒绝。不得改变云端配置来绕过检查，也不猜未来SDK的默认值。

helper review、全套验证及CI通过后，允许一次有界的只读前置接续：仅当原receipt证明business0/D1=0/management1且未进入sampler时，独占创建continuation记录并沿用已有管理计数及原始证据，再核查settings/tails。run-start与首次失败原样保留，不加42业务、44管理/20D1总预算，不重放已发送业务或mutation。若仍有未知状态立即停止，不再续接。后续实际采集与关闭完全沿12.2。

Sol/high交付纯解析helper及5项测试；主Agent审阅通过，192项Node与8项Python全部通过。明确区分属性缺省与null/畸形/显式开启，测试同时检查package-lock、实际安装版本及SDK远端归一化源码，升级不能静默沿用旧契约。私有operator接续由Sol复审：原始run-start/第一次停止/evidence保留、continuation独占，计划与表上界完全相同，旧rawBytes须为安全整数并与原始证据字节数相符；管理账本从1继续，不归零。构建、隐私检查及远端CI通过后才执行接续。

### 12.4 本轮只读停止与关闭核验（2026-10-17）

`2b96e40`及`1beed5a`已推送；最新Cloudflare CI `38845522076`成功、部署跳过，Pages CI `38845521906`成功。12.3的单次接续通过settings/tails前置后，在只读数据库预检停止：44个schema对象及002 SQL均匹配，10月16日预检记录auth=0、active sessions=0，但admissions=276超过固定上界256，其余表未越界。按12.2不扩大上界、不写fixture、不恢复auth/entry、不再接续本轮；没有业务HTTP或analytics样本，CPU仍unknown。

截至停止及settings/tails后置核对，累计management=8、D1 management=2、business=0；16项数据库查询全部成功，原始meta合计670行读、0行写。sampler中的actual管理meta为0是投影在基数校验失败前未返回，不能解释为平台零消耗；原始证据保留在私有目录。未进入任何mutation，因此不执行无必要的关闭写入。

收尾计划及结果：Sol/high实现私有一次性核验脚本，主Agent完成review及无网络dry-run后执行一次固定check的subdomain GET，确认workers.dev与preview均关闭。请求前独占、fsync保存management=9预留，30秒超时、无重试、共享20MiB证据上限；最终累计management=9/44、D1 management=2/20、business=0/42，670行读、0行写。原operator停止证据原样保留，最终账本追加在 `final-verify-start.json` / `final-verify-result.json`；没有重启采样或修改云配置。auth=0/active=0来自10月16日预检记录，本次仅新鲜核验入口，证据时间分别保存，不将旧auth读伪称本次D1回读。

本次主站只读复核：runtime返回200且apiMode=disabled，`/api/health`返回404，Pages回退首页返回200。

交付只更新仓库计划，按commit→push→既有CI验证；不改变公开文档白名单或主站部署。代码已通过192项Node、8项Python、disabled构建、公开产物/真实secret检查和1304项静态检查；本次仅修改本计划，复用同源完整验证；再次执行verify:public通过（1318项产物），diff检查通过，远端CI结果以交付报告为准。失败保留当前可用静态部署，记录可revert；生产API仍关闭，无R2上传、AI调用或资源配置写入。下一轮必须先读取新鲜基数并重新审阅成本与预算，不把当前已停止轮改成更大上界后续跑。


### 12.5 下次从这里接续（2026-10-17收工检查点）

本次仅保存交接文档，不启动下一轮开发、采样或部署迁移。任务难度低，由主Agent维护既有记录并review；后续涉及管理工具、鉴权、持久状态和采样安全的实现仍须由Sol/high负责。验收是下次仅凭文档即可找到源码、最后账本、停止原因与下一步，不依赖聊天历史；文档检查及适用构建/隐私检查通过后commit→push→现有CI，Cloudflare自动部署继续关闭。若文档有误以修订或revert回退，不修改云端状态或私人数据。

**阅读顺序与完成项：**先读根目录AGENTS.md、开发计划和本节，再读11–12.4及 `scripts/cf-cpu-sampler.md`。sampler/H2传输已固化（`26a6aa4`），固定管理adapter已完成（`2b96e40`），锁定Wrangler远端observability缺省语义的兼容修正已完成（`1beed5a`）。完整192项Node、8项Python、disabled构建及隐私/静态检查通过。收尾记录 `fba0df7` 已推送，Cloudflare CI `39000386135`成功且部署跳过，Pages CI `39000386094`部署成功；其后只读复核主站runtime disabled、API 404、Pages 200。无需重新实现sampler，不把这些结果当作CPU验收通过。

**停止点与账本：**12.2轮已结束，不可重跑operator的 `--execute` / `--continue-preflight`，不可删除独占标记或重置账本。admissions=276超过原上界256；这是10月16日观测值，下次不能当新鲜基数。最终累计management9、D1 management2、business0、实际D1读670/写0；旧第10轮business48、management84、D1 management38、helper1另行保留，两个轮次不混算。auth=0/active=0为旧预检证据，最终只读GET确认entry/preview关闭；下次启用前须重新核验状态，不能沿用旧时间证明当前状态。

**证据入口（均被忽略，不提交原始内容）：**本机 `.local/cf03/manager-round-20261016/` 内的 `run-start.json` 保存原计划及上界，`attempt-1.json` / `continuation-start.json`保留首次失败与唯一接续记录，`operator-state.json` / `sampler.json`保留基数拦截；`provider-3.json`是16项数据库只读结果及670/0原始meta，`final-verify-start.json` / `final-verify-provider.json` / `final-verify-result.json`是追加管理9的预留、入口证据与最终账本。既有deploy allowlist在 `.local/cf03/deploy.json`，同candidate的版本与源码hash基准在 `.local/cf03/cpu-round-q2yZiT/candidate-h2-result.json`。只按明确文件读取，不遍历或打印凭证；私有目录0700、文件0600。若下次换机器缺少这些证据，先恢复受授权的项目私有资料并校验权限，不从仓库推测真实标识或伪造旧receipt。

**下次第一件事：**先写新的有界预检计划及只读预算，读取固定check的新鲜schema、全表基数、auth/active、版本及entry状态，再按新鲜基数审阅成本公式、固定上界与收尾预留。不要现场放大256后继续已停止轮，也不要清理旧admissions来迎合上界；若新鲜观测不满足新计划仍停止。新云轮须独立目录/ledger、防重放，保持原100k读/15k写及费用边界，前置settings/tails与观测任务核查照旧。计划与工具review、适用测试/构建/隐私检查及CI通过后，再在既有授权内执行，不重复索要同一项目授权。

**待验收与可选改进：**CPU gate仍unknown，下一轮需完整21×2真实HTTP、CAS双mutation、40次API准入、两批满额维护和完整analytics证据；不能挑旧低aggregate或用本地模拟判通过。manager在投影拒绝时丢失安全错误码及已知meta的传递可另立离线小任务，主Agent审阅后再交Sol实现；它不改变本轮670/0事实，也不是放宽基数的理由。CF-03生产登录/私人阅读仍未上线，R2仍须新鲜完整用量证据且逐文件上传；CF-04和真实AI继续等待，不新增现金支出、不把paw改为生产服务器。

## 13. 新鲜状态只读预检（2026-10-17，已完成）

目标：接续12.5，以独立证据取得固定check环境的新鲜schema、全表有界基数、auth/active、部署版本、绑定、入口及观测配置。当前sampler和manager已完成；本节不代表CPU或CF-03验收通过。复杂度高，固定只读工具及私有operator由gpt-6.1-sol / high实现，主Agent负责计划、逐项review、集成测试、云端执行与交付。

范围与方案：沿用明确的项目环境、deploy allowlist和candidate源码hash证据，不读取所有者access key。新增独立、防重放的私有目录/ledger，任何HTTP前先持久化预留；默认dry-run无网络。只允许固定check的settings、tails、deployments、D1 identity、固定只读SQL batch和subdomain；settings/tails可在结束时各独立读一次，共最多8次管理HTTP、其中2次D1管理，超时30秒、无重试、redirect:error、单响应最多1MiB、原始证据总计8MiB。只读POST /query不代表允许任意SQL：SQL从当前schema生成固定表名及字段，只读聚合，禁止接收SQL/URL参数，保留每项provider meta及错误状态。

读写预算：预检保守预留最多20,000行读、0行写；每张项目表最多探测1,024行并返回有界计数，达到截断上限即unknown并停止，不将截断值当真实全表基数。schema/认证聚合也须有界且不得返回私人行内容或凭证。预留不等于平台已计费行数，实测meta独立汇总，超出预留或未知立即停止，不隐瞒已发生消耗。未来采样轮须把本次实际/保守消耗纳入累计100,000读/15,000写总门槛，不能以拆分预检重复获取额度。

依赖与验收：先由Sol核对既有schema、固定manager及平台官方只读契约，实现无网络测试，覆盖schema漂移、截断、错误meta、目标/版本/绑定不符、重定向/超时/大小限制、CI拒绝、符号链接、防重放和写盘失败。主Agent审阅全部请求与SQL后运行适用专项及全套Node/Python、disabled构建、verify:public、真实secret扫描和verify:static；工具commit→push→既有CI通过后在既有授权内执行一次预检。结果只公开安全聚合及状态，原始证据0700/0600留.local，不扩大文档发布白名单。

明确不做：不接续/修改12.2旧轮、清理旧admissions、启用auth/入口、业务HTTP、analytics/profile/tail创建、重部署、production/R2/AI/Workflows操作，不改变业务Worker/schema或免费套餐。只读状态不符仍保留证据并停止；不凭旧auth状态宣称新鲜关闭，也不进行未预算的补救写入。

下一依赖：预检成功后，主Agent按新鲜完整基数重新审阅采样成本、固定上界、关闭预留及账号免费余量证据，再另写独立采样计划。未完成这些条件不能自动发送业务样本。失败保留现有静态站及check状态，工具代码可revert；不回滚私人数据或真实计数。Cloudflare CI部署继续关闭，Pages按现有回退流程发布；本次不发布业务API。

### 13.1 工具交付与本地验收

Sol/high完成固定只读模块 `scripts/cf-cpu-preflight.mjs`、私有 `.local/cf03/preflight-20261017/operator.mjs` 与API/成本说明，另一Sol/high并行交付14项无网络专项测试。主Agent逐项review并要求修正迟到响应继续写盘、schema平台内部对象误判、非boolean execute误启用、错误响应基数完整性、声明响应大小及私有manifest目标可审计性；修正后复审通过。schema使用128行有界MATERIALIZED来源，只返回项目表关联SQL；13表计数与auth/session/marker合计17条固定SQL，不返回verifier或session hash。

本地完整206项Node、8项Python通过；首跑因沙箱禁止127.0.0.1监听失败，在项目授权内允许临时本机端口后同套全过。默认disabled的Cloudflare构建1280页、verify:public 1318项产物、verify:static 1304项资源通过；独立真实secret扫描覆盖1435文件零命中，格式/diff检查通过。私有operator dry-run核验candidate三份源码hash及历史profile结束，未读取.env/owner key、未联网或创建执行账本。隐私扫描另行按固定路径读取凭证，仅用于离线匹配，不属于预检operator。

工具提交前只读核对原交接提交3157562：Cloudflare CI 39002764865成功且部署跳过、Pages CI 39002764963成功；主站 `/data/runtime.json` 为disabled，`/api/health`为404。以上不是本次新工具远端CI或check新鲜预检结论。新工具commit→push→两CI成功后才执行第13节一次固定只读预检；结果及新鲜时间另记13.2。CPU仍unknown，无业务HTTP、R2上传、AI调用或云配置写入。

### 13.2 新鲜只读结果

工具5f2c4b5已推送，Cloudflare CI 39015577802与Pages CI 39015577777均成功。2026-10-17 07:59:12–07:59:16 UTC仅执行一次第13节预检，8/8管理HTTP成功，其中2次D1；17项SQL的原始meta完整，实际837行读、0行写。独立账本和原始证据位于 `.local/cf03/preflight-20261017/`，最终状态 `ledger-17.json`；不得重新执行该operator或删除run-start。

固定候选版本、DB身份、schema/002匹配；auth关闭、generation24、active sessions0；workers.dev与preview均关闭，前后settings观测关闭且tails为空。新鲜表基数：admissions276、counters218、sessions48、catalog_books9、metadata_overrides9；auth_config/library_schema/catalog_imports/catalog_import_rows各1，public_state2，file_registry/storage_state/upload_reservations各0。计数均未截断；预检没有业务HTTP、配置写入、上传或analytics，因此CPU仍unknown。

## 14. 基于新鲜基数的独立CPU采样（预算复核通过，共享额度证据未过，未执行）

目标：在第13节新鲜状态上审阅独立21×2采样轮。旧12.2轮永久封存，绝不接续或清理旧admissions。仅复用同一已部署candidate和已完成的sampler/manager，不改业务Worker/schema，不增加候选/profile/真实书籍/模型调用或付费计划。复杂度高，由Sol/high实现新的私有operator并作独立成本/安全审阅，主Agent集成review、预算复核与实际执行。

拟定独立上界：沿12.2其他表上界，admissions改为384（新鲜276）；counters512、sessions128、catalog_books/metadata_overrides各32、catalog_import_rows16、file_registry4、upload_reservations8，其余各4。采用原schema成本公式与增长180/400/68/2/2，不改变SQL、维护规模、20次连续准入/轮或CPU门槛。离线dry-run为42业务、28管理（含最多9 analytics）、12 D1，保守71,292读/10,516写；加第13节完整20,000读预留，合并91,292读/10,516写，仍低于100,000/15,000，不能拆分重复使用预算。业务预留与平台实测meta继续分列。

新轮拟 `.local/cf03/sampler-round-20261017/`，独立run-start/nonce/ledger、防重放，无continue入口。采样子预算business42、explicitManagement44、D1 management20、原始证据20MiB；含前置只读轮后累计最多52管理/22 D1，读写总门槛不变。正常最多40管理/18 D1，另4/2仅受review收尾补救，不自动重试mutation。sampler预留28管理/12D1，额外settings/tails前后四次只读；每次真实HTTP先持久预留，失败也计数。首mutation前完整预留两批维护及四次关闭/回读。执行前再次核验candidate/source hash、schema/表上界、auth/active与entry、前置settings/tails及历史profile已结束；任一不符停止，不现场放大上界。

费用与证据门槛：先独立审阅第13节证据与成本，并复核既有Free环境/项目免费额度记录及共享账号用量未知的影响。仅有91,292/10,516计划值不能证明账号整体剩余额度；不得读取未授权Volt或账号其他资源来补证，不能把unknown改成保证免费。若现有证据不足以满足不增加现金支出和计划额度门槛，停在离线准备，不启用auth/entry。该结论须在本节记录后才决定是否执行，不能仅凭生成operator越过门槛。

通过前置门槛后的验收步骤：固定H2完整两轮，各含真实CAS双mutation，40 API准入及两批满额维护；42 HTTP结束后有界分片等300000ms，首轮/后轮/合并三个固定窗口各最多3读，不补业务、不扩大窗口。P95<=5ms、max<10ms、errors=0，完整证据才pass，缺失仍unknown。每个已进入mutation分支有界finally关闭auth、增加generation撤销会话、关闭entry/preview并独立回读；关闭失败按补救预算review处理，不隐瞒未核验项。生产API保持disabled。新工具/计划先本地验证及commit→push→既有CI成功再执行；失败保留静态站，代码可revert，不回滚私人数据或真实计数。

### 14.1 独立复核结论与接续门槛

Sol/high独立复算与主Agent复核一致：全部13表新鲜基数在新独立上界内，累计保守91,292读/10,516写通过原100,000/15,000门槛。但第13节receipt仅证明check库837读/0写，没有共享账号当天Workers请求、D1读写的已用/剩余量；旧12.2明确unknown，不能改作新鲜余量证明。现有条件性账号纯汇总授权仅覆盖R2，不能默认为Workers/D1授权。按第13/14节门槛，停在离线计划，不创建新采样执行账本、不读取owner key、不启用auth/entry。

最小待补范围是目标账号当前Free计费状态、UTC计费日与观测时间，以及Workers当日请求、D1当日rows_read/rows_written的纯数字已用/免费上限/剩余，包含共享项目及管理面消耗的完整性和滞后说明。只读纯汇总，不列Worker/DB/项目名或ID、不读Volt配置、SQL、日志、请求/IP、对象、正文或其他业务数据，不创建通用凭证/订阅。该范围超出现有R2条件授权，须另获明确授权后才能读取；字段不可得、采样/滞后或覆盖不完整仍为unknown，不用已知部分抵作完整余量。

另发现验收与现有工具的差别：现有sampler最终只要求至少一轮 `coverage.fullBatch`，不是两批实际执行；预留两批/种入两批不能替代执行证据。继续实现新私有operator时须核验两轮 `maintenanceOrdinals` 合计恰为2，且沿用每批64/8/128/32真实减少证明；不足则标未验收，不追加业务或清理旧记录。本次仅记录该前置要求，不改变已交付sampler契约，不伪称已修复或完成新采样。

## 15. 2026-10-17 当前决策与后续依赖

用户最新决定优先推进功能开发，优先复用免费资源；确有必要时可接受仅属于 The Shelf 的合理超额费用。该意向不表示已经开通付费计划、不修改本轮计费，也不承诺费用封顶。账号级 Workers/D1 纯汇总读取授权未扩大，不能读取 Volt 或账号其他资源来补证。

5ms CPU P95 是优化目标，不再阻断离线功能开发。既有分析器的 `unknown/incomplete_evidence` 与分组不匹配、归因歧义、缺少请求流量等原因继续保持unknown，不能把它改写为通过或修改测试伪造通过。生产API上线仍须按实际套餐核验CPU限制、错误行为和安全验收；R2真实上传仍要求新鲜完整用量证据、8,000,000,000字节总预算、20,000,000字节单文件门槛及逐文件计划，并保护正文和凭证隐私。

本轮已并行完成CF-04本机单文件正文准备首步，实现经主Agent review，15项新增专项及完整221项Node、8项Python本机测试通过，零跳过。该工具生成私有版本化正文包，尚未接入阅读/AI服务。CF-04云同步与D1索引仍依赖相应CF-03生产安全、资源及上传验收。CF-05仍依赖CF-01长任务验证、CF-04云端数据路径及独立有效任务Key。以上调整只改变离线开发排序，不重开第12.2、13或14节已封存/已停止的operator。本轮未执行新的Cloudflare配置或数据操作；未来按项目既有授权与具体计划执行，不重放旧operator。
