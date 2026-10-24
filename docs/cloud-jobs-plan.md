# CF-05 云持久任务实施设计（待 review）

日期：2026-10-23。作者分工：detail_finish，gpt-6.1-sol / high。本文是非公开设计，不是迁移、部署、真实 AI 或功能验收完成记录；不得加入 `scripts/export-docs.mjs` 的公开白名单。本轮只新增本文，不读凭证、不访问账号资源、不调用 AI、不修改业务代码或既有计划。

## 结论与最小批次

采用 D1 作为业务任务、调用意图、预算和结果的唯一持久 authority，Workflows 只负责在浏览器关闭后推进任务。先实现固定已确认正文的一次问答，再扩展有界分组总结，最后增加经核实的作者来源与主动公开。不能把现有 Node 内存锁、Workflows 的步骤缓存或上游 `task_id` 当作上游幂等机制。

两个非原子边界必须分别处理：D1 与 Workflow create；D1 与 AI POST。每个边界先落永久意图，只给本次成功 CAS 的执行者一次发送资格。意图已存在但未保存可信结果时不再次发送；因此可能出现“实际上没有发出但只能保留 unknown”的保守结果。这是无上游幂等/查询接口条件下的明确可用性取舍，不承诺严格 exactly-once 或自动结果恢复。

| 批次 | 实施范围 | 依赖及开启条件 | 明确不包含 |
| --- | --- | --- | --- |
| J0 | 新增 D1 表/trigger、共享 AI 准入、去重/预算/状态机、单元与真实 workerd 合成验证；业务 capability 保持关闭 | 主 Agent review 本文；协调 010/011 后的独立迁移编号及冻结 hash | 云 DDL、Workflow create、secret、AI、业务路由启用 |
| J1 | 固定 `question` / `gpt-luna` / `low`；单活动业务任务、一次调用、D1 查询/取消；独立 Workflow 类与显式部署开关 | J0；CF-04 `loadPreparedForJob` 的真实来源消费和对应 CPU 门槛；独立任务 Key；Workflow/配置受控验收 | 多任务自动队列、流式、作者检索、全书总结、公开结果 |
| J2 | `chapter_summary` 与 `full_summary`，最多 3 个叶组加 1 次归并，私有 partials 与精确覆盖 | J1 的关闭页面持续执行/未知不重发验收；分组与归并资源验证 | 无界长书、增量重算、未知步骤重做、跨日自动续费 |
| J3 | 固定作者来源获取/身份核验；所有四种操作的私有保存与单独主动公开、撤回 | 独立来源/许可设计及测试；发布和书籍生命周期联动审查 | 模型联网、任意 URL 抓取、自动发布、直接公开私人问句或大段原文 |

每批由 Sol/high 实现，主 Agent 独立 review、验证、发布；J0 可以先离线完成，不因上游/正文真实验收暂缺而停住可独立开发项。J1 首批单活动任务是有意收窄；Node 的默认 30 条队列不是已经迁移的能力，后续公平队列需另列批次。

## 已核对的事实与依据

本轮 web 工具返回 proxy 404；随后只用公开 HTTPS GET 成功读取指南/官方 Markdown，没有使用账号 API、凭证或私人收据。以下为 2026-10-23 的读取结果，部署前仍须再次核对变化。

- [当前 AI guide](https://oai.parallelstreamllc.com/guide)：同步 `POST /v1/tasks`；文本输入与 instructions 分别上限 500,000 / 50,000 Unicode 字符，编码 JSON 默认 32 MiB；可发送 `effort`，kind 不选择提示词。`content` 是字符串、usage 可为 null、`task_id` 是完成后的 turn 标识，没有状态查询、结果恢复或幂等接口。全服务共用并发 1、服务任务期限 840 秒，代理等待 900 秒。客户端不能把 503/断线/超时视为“从未执行”。
- [Workflows retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)：`step.do` 默认 5 次重试、10 分钟 timeout。必须显式 `retries: { limit: 0 }`；不可只依赖抛普通 Error。固定终态可用官方 `NonRetryableError`，不注册会补偿删除责任/恢复发送资格的 rollback。
- [Workflows API](https://developers.cloudflare.com/workflows/build/workers-api/)：binding 支持指定实例 ID 的 `create`、`get`、实例 `status`/`terminate`/`restart` 等。ID 的重复保护有 retention 边界；`restart` 可重新执行步骤。它们是 Workflow 自身能力，不能证明 AI 请求结果或提供 AI 幂等性。
- [Workflows rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)：步骤可能重执行，非幂等外部调用需要自身保护。业务去重和发送权必须由 D1 保证，即使 SDK 配置为零重试也不能省略。
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)：当前 Free 的每步 CPU 为 10 ms，等待 I/O 与 CPU 分开计量；单步普通输出和 event payload 均为 1 MiB，完成状态保留 3 天。D1 长期业务记录不能依赖实例保留期。页面关于部分 subrequest/并发的示例文字与表格不完全一致，本设计不据此扩大限额，采用更小项目硬上限并实测。
- [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)：`batch` 是整批回滚的事务；`withSession("first-primary")` 只保证该 session 的首个查询取主库，后续可能用满足顺序一致性的副本。每个安全复核边界新建 primary session，不能把旧 session 当成持续最新读取。

公开来源快照 SHA256：guide `c4992ad08cfe51227550b7db2fcf614abfc27c57dbb1843b662c232b2dc12065`；Workflow API `e2f919d0dbf8873c170e913a668e6e03cd3b8cb9062abcdd76bd562da85aeaf9`；retry `e2bd008f9ff6639871405d6d71404ee7eaa748814e3069361792648f98da35a3`；limits `1be5081806ac30a4d0f607578a06949caa661c09f94f2c3d9fddff597c04a0c6`；rules `cbad48d87145c0268ee0a95967be9be8c900cb06fd1170eece4e7749364f442f`；D1 `f4d4ed3a8b4ef23f64e11c25cc0782bd50f0134c0494eac0ee72d086087dfd32`。仅校验此次读取的字节，不声称冻结外部服务版本。

本地代码对照：

- `server/jobs.mjs`：SQLite 保存 jobs/calls/partials，模块锁和 `pump` 仅覆盖一个 Node 进程；默认每日 20 / 每任务 12 次，运行中指纹去重；running 重启转 uncertain，unknown 暂停队列。调用预算与 job 保存分开写，不可原样当作跨进程原子实现。问答取最多五块；总结 30,000 长度分组并归并；作者仅从固定 Wikipedia API 取资料且要求正文提到书名。
- `server/index.mjs`：已有创建、history、published、单任务查询和 publish 接口，前端轮询不会主动调用生成。现有请求缺少客户端业务 requestId / 显式 source pin，需要兼容性改造，不靠前端旧字段猜来源。
- `cloudflare/library/worker.mjs`：业务 AI capability 为 false，history/published 返回空，jobs 返回 ai_unconfigured；没有业务 Workflow 类/绑定。文件名识别是独立同步能力，不能称为 CF-05 已完成。
- `cloudflare/library/prepared.mjs` 的 `loadPreparedForJob`：已具备内部全文消费入口，限定同书、明确 file/version、真实会话、已确认 registry/index，并在 R2 外部 await 后新取 primary 复核；内部 chunks 不能直接序列化为公开 API。010/其后发布与真实正文消费仍需各自验收。
- 008/009 的文件名识别保留同名永久去重、每日计数及 pending 准入；历史 uncertain 不阻断独立新文件。迁移不得恢复旧的“所有 unknown 永久锁住所有 AI”假设，也不得清除历史行来接通业务任务。

## API 和能力契约

复用已有同源路径，不新建公开调试/任意 prompt/任意模型端点。新开关建议为 `CLOUD_JOBS_MODE=jobs-v1`、项目专用 `JOBS_WORKFLOW` binding、独立 `TASK_AI_KEY`；名称是待实现契约，不是已配置事实。没有全部精确配置/新 schema/共享准入时 capability 为 disabled，不借文件名 Key 的存在隐式开启。

| 接口 | 输入/输出与权限 |
| --- | --- |
| `GET /api/config` | 增加有版本的 `jobs` capability：operations、固定模型/effort、maxPendingJobs、daily/shared remaining、逐任务调用上界、source/未知原因；`aiConfigured` 仅在该批次可创建时 true，privateHistory 可在创建关闭时保留读取 |
| `POST /api/books/:bookId/jobs` | 所有者 session + Origin/CSRF。J1 严格白名单 `{requestId, operation:"question", question, model:"gpt-luna", source:{fileId,versionHash}}`；canonical UUID，问题非空且最多 4,000 Unicode 字符，不接受 prompt、URL、key、output_format、重试/force 参数。返回 202 `{job,pollUrl}`；已存在可信终态返回 200；同 requestId 不同请求 409；相同语义返回同一业务任务，绝不再次 create/POST |
| `GET /api/jobs/:id` | 所有者当前 session；D1 业务状态/固定错误码/coverage/usage/可显示出处。查不到、无权或回收站按既有隐藏策略；不返回 input 原文、内部 fingerprint、R2 key/ETag、session hash、原始上游响应/错误 |
| `GET /api/books/:id/history` | 所有者 + 同书权限；稳定游标、每页最多 25 项摘要，64 KiB 响应上界；查看全文走单任务 GET，避免历史数组无界 |
| `POST /api/jobs/:id/cancel` | `{expectedVersion}` + session/Origin/CSRF；只取消未来工作，不承诺停止已发 AI。queued 且无任何发送意图可 cancelled；有意图则 cancellation_requested，保留未知/已用预算，后续响应只能形成私有终态/证据，不能再派发下一步 |
| `POST /api/jobs/:id/publish` | J3 才启用；`{published,expectedVersion}`。只允许 completed 且 coverage 完整的固定结果快照；单独处理 public projection，撤回无须上游请求 |
| `GET /api/books/:id/published` | J3 前继续空。J3 后只返回当前可公开书籍、未回收、当前 publication revision 的白名单结果；私有/回收站匿名不泄漏记录存在性 |

UI 每次明确提交生成并固定一个 requestId。网络失败只 GET 同一业务 ID；若创建响应丢失，查询固定 requestId 的 owner-only 查询路径可在实施时增加，例如 `GET /api/jobs/by-request/:requestId`，仍不得重发 POST。该查询不把“不存在”解释成可重新发送。客户端丢失本地 ID 不授予新的发送权。轮询有次数和总时间上限，转手动刷新；浏览/恢复仅 session 或已有结果 GET，不触发 create/AI。

## 持久模型、去重与状态机

新增独立迁移（编号在 010/011 合并后由主 Agent 分配，不覆写冻结 SQL），使用结构化列、CHECK/FK、不可删除 trigger 和显式 CAS，避免整项大 JSON 重写。

1. `shelf_jobs`：scope/job_id/request_id、logical_fingerprint、operation/model/effort/prompt_contract、book/file/version、source descriptor/index/metadata/management 指纹与版本、原 session_hash/generation/有效期限、私有规范输入与固定 conversation refs、status/version、创建/截止时间、cancel_requested、coverage、公开状态。输入和输出分表；不保存 cookie/CSRF/Key。
2. `shelf_job_workflow_intents`：每 job 唯一固定 workflow_instance_id、创建意图时间、随机 claim、ack/unknown。实例 ID 永久由 D1 保留，不因平台三天过期而复用。
3. `shelf_job_call_plans` 与 `shelf_job_calls`：有界 ordinal/阶段/组范围、input 摘要 hash/字节/字符数、原 billing UTC day、fresh dispatch nonce、intent/完成时间、结果 hash、usage 或 null、固定诊断与 call state。每 `(job,ordinal)` 最多一个 dispatch intent。已发意图不能 DELETE/改回 ready/换 ordinal 恢复同一步。
4. `shelf_job_results` / `shelf_job_partials`：私有有界内容、content hash、call ordinal、稳定 source refs/coverage。单行硬限 128 KiB；大量出处分行，不把 20 MB 正文放进 D1 或 Workflow 输出。
5. `shelf_job_budget_reservations` / 追加式结算事件：计划预留、已转 dispatch、明确未发送释放数；计数归同一事务校验。不对 attempted/unknown 退款。
6. J3 独立 publication 行：完成结果 hash、public projection/revision、发布者 auth generation、当前书籍公开状态/management version 和必要出处覆盖。修改正文或发布内容不是覆盖原私有结果。

业务状态：`queued -> planning -> ready -> running -> completed`；明确本地失败走 `failed`/`cancelled`；创建 Workflow 结果不明走 `orchestration_unknown`；任何 AI 意图缺可信终态走 `uncertain`。API 可把后两者映射为现有 UI 的 uncertain，但原因必须区分。Workflow running/completed/errored 与业务状态分别记录，不互相冒充。

调用状态：`planned -> dispatch_intent -> completed | failed | uncertain`。本地验证/来源/预算失败可在没有 dispatch_intent 时安全失败。intent 之后，包括“持久成功但回执不明、尚未执行 fetch”窗口，都不能重新发出；收到完整、可信的确定拒绝仍只可记 failed，不重试。503/5xx/超时/重定向/无效 envelope/部分体/完成落库不明保守记 uncertain，不把 HTTP 200 中的 error 当成功。

逻辑去重指纹覆盖 book + 固定 source + operation/range + 规范问题 + 固定 conversation 结果 IDs/hash + model；不包含 requestId，不能换 requestId 绕过。另存完整 dispatch body hash（含 effort、prompt contract）。未知逻辑任务在升级 prompt/contract 后仍命中旧责任，不通过改版本恢复发送权。成功复用前先核验当前访问权；首批同语义返回已存结果，没有 force regenerate。多连接竞争由唯一约束与 SQL guard 裁决，不由先 SELECT 再 INSERT 裁决。

## 两层发送意图和 Workflow 执行

### 业务创建到 Workflow

API 一次 D1 batch 原子完成权限/模式/队列/请求去重、预算预留、job、固定实例 ID 和 creation intent。只有该次得到确定成功且 `changes=1` 的创建方可以调用一次 binding.create；params 只传 scope/jobId/contract，不能包含正文、问句、Key 或完整来源描述。

create 成功与 ack 保存失败时保留既有 intent。重复 HTTP、Worker 重启、另一进程均不能再次 create。独立的有界只读 operator 可 `get(id).status()`核对实例存在和运行态；404、retention 过期或 errored 不证明曾未创建，不能据此创建同 ID/新 ID。实例存在也不把 D1 未完成 job 改成 completed。

不把长调用放在 HTTP `waitUntil`；API 返回 202 后由 Workflow 独立存活。浏览器关闭不撤销已有合法会话，因此任务可继续；会话过期/登出/全局 auth generation 变化按下一节停止未来派发。

### 每次 AI POST

每个实际发送步骤显式 `retries.limit=0`，项目 fetch 总期限 900 秒，Workflow step timeout 预留落库余量建议 16 分钟；这不替代整任务 deadline。步骤返回只含 job/ordinal/固定 outcome，不把材料/问句/结果作为 Workflow step 输出或 `run` 返回值。所有错误均使用静态码，不把 provider message/正文写到 Workflow 日志。

官方 API 给出 retry limit 配置，但本文没有实际创建 Workflow 来验证当前部署版本的 `0` 行为。J0/J1 必须分别验证参数接受和故障后的实际发送次数；若运行时拒绝或仍重执行，不能换成默认配置继续开启。D1 单次资格保护仍须在引擎重执行时成立。本机 workerd 的 HTTP 兼容验证也不等于云端 Workflow 引擎持久性已验收。

发送顺序必须是：

1. 从已固定来源准备材料并完成输入/输出预算检查；新取 primary 验证会话、job grant、cancel、book lifecycle、metadata/source/index 精确身份。
2. 新生成本次 callback 的随机 nonce；一个 D1 batch 原子取得项目发送 slot、把本步预留转 attempted、插入不可重置 dispatch_intent、递增 job version，所有 SQL guard 共享相同条件。回执不明则绝不 fetch。
3. 仅本次成功 CAS 的调用栈持有一次内存发送资格。不能从已有 nonce、Workflow cached output 或回读 intent 重建资格。发送前若再发生外部 await，必须再次 primary 复核；失败保留已耗意图且不发送。
4. 固定 HTTPS `POST /v1/tasks`，Workerd 用已经实际验证的 `redirect:"manual"`，不跟跳、不自动重试、不换端点、不按 Retry-After 再发。不使用 SDK 未证明的 idempotency/status 能力。
5. 900 秒覆盖 fetch 和完整响应读取；响应字节/块数/UTF-8/JSON/schema/model alias 映射/usage 严格有界校验。合法成功也要在外部 await 后重查 grant/source，之后通过一个 D1 batch 原子保存 call terminal + 私有结果/partial + coverage + slot 结算。任何落库未知留责任，只读核对，不再次 POST。

权限/取消与派发的竞争以 D1 发送准入事务为线性化边界：撤销先提交则该次准入失败；准入先提交则已存在一次在途责任。不能承诺另一个请求在最后校验之后提交撤销，仍能原子地收回已取得资格的外部网络调用。发现撤销后的后续 await 一律阻断未来派发；已返回的成功只可存入带原 nonce/source 的隔离 receipt，不能借隔离写入重新激活 job、生成公开 projection 或继续下一步。

恢复 callback 如看到已完成结果可只读复用；看到未完成 intent 则停止该任务、显示待核对。平台重启/CPU kill/步骤重新执行都经过同一 guard。Workflow 自身 restart/retry/delete/pause/resume 不暴露为业务重试功能；operator 也不得用 restart 恢复未知 AI。

## 项目并发、unknown 和预算

建议共享 The Shelf 的 AI 准入，而不是新加 20 次“业务额度”与现有文件名 20 次叠加。初期共享 UTC 每日 20 次新 POST，J1 每任务 1 次，J2 最多 4 次（低于 Node 原默认 12）。这不是 token/金额封顶；guide 未支持 max_tokens 控制，usage 缺失仍 unknown。

共享核算为：当日所有 `filename_identifications`（包括 failed/uncertain）+ 当日业务 dispatch intents + 业务尚未转发送的预留，总数不超过 20。同一条文件名历史只计算一次；不能为了统一表而复制成第二笔消耗或重算历史日期。新增业务 reservation 与文件名 INSERT 必须由同一主库 SQL guard 相互感知，覆盖并发竞争；仅在 JS 中先读对方表不成立。新 trigger 先安装并核对再移除旧 guard，中间双 guard 允许更保守，不允许无保护窗口。

同样共享“当前本地 pending dispatch”slot，文件名 pending 和业务 intent 的准入互斥。不迁移/删除旧 pending、unknown 或诊断。key 归属与预算不是全网关并发控制；其他应用仍可占上游唯一名额。项目可以证明“没有同时取得两个本地发送权”，不能证明先前 unknown 的上游进程已结束。

建议 unknown 策略与 009 已有语义一致：unknown 永久封住该逻辑任务及其后续步骤，不自动启动已排任务、不按时租释放 pending。不同独立任务只允许新的、明确所有者操作，经当前 pending/预算门槛后准入；必须提示历史任务未知且这不是恢复它。transport 已结束并确定记录了 uncertain 后才允许释放本地 pending slot；上游是否结束仍 unknown。进程崩溃遗留 intent 不通过超时/lease 偷释放，需独立只读核对或有界保守归档为 unknown 的 operator 设计。这项“独立新任务”政策不同于 Node `hasUncertain()` 总闸，必须由主 Agent review 后实施，不能在迁移时静默变化。

预留按任务创建 UTC 日固定；先预留 J1 的 1 或 J2 的最大 4 单位，planning 得到 requiredCalls 后一次释放明确不需的单位。每步 actual dispatch 必须在同一 UTC 日，且任务最大期限足以落在该日和原 session 有效期内；否则在发出前拒绝/停止，不跨日自动新增预算。不释放 attempted/unknown；未发后续步骤的释放有唯一 settlement key、防重复扣减并保留记录。12 次或更多的长任务将来另设计多日授权，不借午夜重置绕过。

J1 不建立自动后台重发队列：最多一个 queued/planning/running 业务任务，pending 文件名则拒绝业务准入，业务活动时拒绝新活动业务任务。busy 是本地明确拒绝才不耗调用；若已有网络意图的远端 busy 则已耗预算且不重发。未来 30 条公平队列需要独立调度/未知阻断/跨日设计。

## 来源、长期授权和四种操作

创建时固定 book metadata version/必要字段 hash、management version、fileId/versionHash、confirmed registry/descriptor/index 身份；不使用可变的“当前默认版本”来重新解释任务。question 的历史上下文只取同来源的最多 3 个已完成回答，创建时固定 ID/hash（或首批明确不带对话），不能在执行时捞最新历史改变去重或输入。来源撤回、回收站、源 registry/ETag/hash 变化一律停止，不切换其他文件或正文。

首批直接复用真实 session_hash/generation 的持久授权，不伪造系统 session 绕过 `loadPreparedForJob`。每个安全边界新取 primary 验证 enabled/generation、原会话未撤销且未过期、job 有效期、取消标记及同书来源。打开/关闭页面不改变授权；登出或过期后不再发送新的材料。将来若需要超出 session 寿命的任务，应独立设计可撤销的 owner job grant，本批不延长 session。

撤销发生在 AI 正在执行时，不能撤回已经外送的材料，也不能把 abort/Workflow terminate 视为上游停止。后续响应可保存为原调用的私有证据/隔离结果，任务不得继续下一步或自动公开；用户重新登录可以核对权限范围内状态，不能由此重发原调用。任何 history/查询响应前仍检查当前调用者 session，而非拿创建者 grant 当作读取权限。

J1：`loadPreparedForJob` 的 20 MB / 20,000 chunks / 6,000 字符片段契约不改，R2 最多 head/get/head 3 次、30 秒整流以及既有 index 校验全部保留。检索复用 `rankTextChunks`，最多 5 段；找不到来源本地失败，0 AI。读取/校验大包可能超过 Free CPU，须实测；不能把长 wall-time 等同免费 CPU 已通过，也不能为通过而删除校验。

J1 的材料规划和唯一发送在同一个零重试 `step.do` 内完成，chunks 仅留在该 callback 内存中；只向 D1 保存文本以外的计划和来源指纹。不能把全文作为步骤返回值传到下一步，也不能依赖跨 step 的局部变量在 isolate 重启后仍存在。

J2：按原定位顺序、以 Unicode 字符计数规划最多 3 个 30,000 字符叶组，且所选出处最多 256 个；单组直接作为结果，多个组再调用一次归并。章节须根据 locator 的真实 PDF page / EPUB spine 选择，不用“第 N 个非空标签”冒充真实页码。完整书超任何界限在首个 POST 前拒绝；不截断成节选后仍标 full_summary。保存每个 partial 的 call/source hash 和 completedChunks；任一步 unknown 停止后续，已成功 partial 只读保留，不重复调用。未来扩至最多 12 次须独立资源/预算 review。

J2 独立 planning step 只持久化范围/hash/count。每个叶组和最终归并 callback 重新加载/校验同一固定来源，再从 D1 取该组计划或已完成 partial；正文不写入 Workflow 状态。按最保守实现，最多 planning + 3 叶组 + 1 归并共 5 次来源加载，即来源部分最多 15 次 R2、130 条 D1 statement，另加任务状态/预算/结果开销。若要减少归并的重载，须另证明等效来源授权与身份检查，不能悄悄删掉复核。

J3 作者：上游不会抓 URL 或联网。独立固定 provider/HTTPS/路径，禁止用户任意 URL/重定向/模型工具；获取有界资料并核对作者身份、作品关联、许可/抓取时间，之后固定 source hash。现有 Node “摘要包含书名”只是有限关联信号，不直接升级为已证明同名作者身份；不足时本地失败，0 AI。不得用模型记忆补缺或把版权资料抓取当作正文上传授权。

发布：用户单独点击才生成 public projection；默认私有。发布前核验 completed、coverage/source 完整、当前书籍 public 且未回收、当前所有者会话/CSRF/version；公开字段只含结果、允许的出处和覆盖，不含问题、对话、prompt、私有 R2 身份或原文片段。书籍改私有/回收须使 publication 在同事务/查询谓词中立即不可见；之后改公开不静默复活旧 publication，须重新明确发布。未签发的 source locator 不自动生成任意 file 阅读链接。

## 有界 I/O、隐私与验收门槛

项目建议上界（是实现目标，未声称已通过）：单次 AI input 最多 50,000 Unicode 字符、instructions 最多 4,000、整个 UTF-8 请求 256 KiB；响应 128 KiB、最多 4,096 read blocks、content 最多 16,000 字符。采用更小上限的目的为 Worker/D1 可控，不等同上游会保证此输出长度；越限已 dispatch 则 uncertain。J2 partial 每份最多 3,000 字符，归并前重新验证整体预算；不依赖 model max_tokens 未生效字段。

敏感输入/结果仅保存在受鉴权 D1 行，公开 API 私有响应 no-store，错误只用固定枚举。Workflow params、step 名称、输出、status 对外投影和日志不含问题/书名/正文/响应/Key。上游 task_id/request-id 只接受有界可信形状，不能存任意 header 字符串；usage 不齐保留 null，日志只有限计数/时长/验证布尔。D1 append-only 责任表与用户结果保留策略分开设计，不能靠删除结果清掉已消耗调用。

实施前逐路列 D1 statement/绑定参数/页数预算：不得把整个 20 MB 包/无限 locator JSON 塞入单行；出处分批每 statement 不超过 100 参数。J1 单次来源加载既有上限为 26 statements / 20 页 / 3 R2；额外 job 状态与调用步骤另计，不能称总预算仍为 26。每个调用步骤只一次 AI POST；一轮不得把资源异常重试算作免费读取。准确 statement 上限须由实现交付附表并做硬断言后才部署。

必要测试：

1. 两连接/多 isolate 同 requestId/语义竞争、共享文件名/业务 slot、共享第 20/21 单位、预留/结算原子回滚、午夜与 session 截止；不同 body 冲突无新调用。
2. Workflow create 前后各崩溃窗口、ack 未知、实例消失/retention 过期；最多一次 create，独立 status 不改上游终态，永不 restart/delete/recreate 逃逸。
3. 每个 AI 意图/网络/响应/落库窗口 crash/replay，含 nonce 相同回读、fresh callback、零长度流块洪泛、超时后迟到成功、workerd manual redirect、HTTP200 error；最多一次原 POST，unknown 不发下一步，不给新预算。
4. 关闭页面后 Workflow 持续；session 撤销/到期、metadata/source 替换、回收站、取消与派发同事务竞争；撤销先于发送准入时零新外送，已取得资格的在途风险如实保留，迟到响应只私有隔离。
5. question 无依据零 AI、固定历史/版本；PDF 空页/spine 编号与完整 coverage、超过分组限额零 AI；partial 确认后重放只读复用、不用旧 partial 配新来源。
6. 匿名/错误 Origin/CSRF/越书/他文件权限；history 分页/大小；主动发布 CAS、私有/回收站立即撤回、重新公开不自动复活；公开产物/错误/Workflow 输出实际秘密和正文扫描。
7. 主 Agent 独立审查后全套 Node/Python、真实 workerd、disabled/same-origin 构建、public/static 检查；Free CPU 和响应/任务 deadline 以真实观测区分通过/未知/失败，不用 mock 冒充生产。

## 发布、真实验收预算和回退

目前没有执行本节任何动作。顺序固定：离线 review/专项/完整验证 → commit → push → 两 CI → 独立增量 schema-status/apply/独立 status → 显式 Workflow/Worker 配置发布及精确回读 → capability/已有私人 PDF 回归 → 有界对应业务真实验收。迁移/绑定/secret 各有永久 intent 和未知不重放收据；既有 `TASK_AI_KEY` 不存在时另外设计默认零 I/O 的安装器，不借本设计重发文件名 secret。

部署器需识别 Workflow 类导出、binding 精确名称/脚本/类、jobs mode、来源配置、schema 与共享预算 guard，保留 trial、filename-ai、prepared 和全部现有绑定；省略新 flag 不能隐式开关功能。新 Workflow 与 Worker 的部署不是一次普通 HTTP，准确平台 mutation/readback 请求清单需 operator 实现后另行 review；本文不虚构 Wrangler 隐含请求数。新功能可以先部署关闭状态；真实正文/资源门槛未过，不宣称 J1 question 可用。

真实验收分开核定，建议上界如下（执行前必须冻结输入、requestId、来源 pin/hash、operator hash 和精确请求表）：

- 合成 Workflow 持久化/崩溃恢复：仅专用 check 环境，无生产 Key/真实材料、0 AI；不新建公开调试路由，不修改现有首本许可。合成通过只证明调度与 guard，不能记为真实 AI/正文验收。
- J1：只用已经合法确认且通过 CF-04 的一个固定 source、一个固定合成问题、一个 requestId、一个 Workflow create、最多一次 AI POST；公共/所有者业务 HTTP 正常 12、硬上限 14，具体请求见下表。不发送第二次创建 POST 来“测去重”，竞争在合成环境验证。次数不足取不到终态则停止该轮，保留 unknown，后续只读核对另列预算，不再产生 AI。没有合法 source 时不能上传测试书或启用 bypass 冒充验收。
- J2：另一个固定小来源、精确两叶组加一次归并，最多 3 AI；不与 J1 合并为默认已授权调用。先完成实现、review 和具体预算，再由主 Agent 在既有授权范围核定一轮，失败不续次。
- J3：来源获取固定一个请求和字节/deadline，最多一次作者 AI；发布/撤回的 HTTP 与权限回归单列。公开内容仅用可公开合成材料，不能以此授权发布真实私人结果。

J1 验收的待冻结请求模板（尚未执行，不代替具体 runner review）：

| 次序 | 唯一允许的业务请求/作用 |
| --- | --- |
| 1 | 匿名 GET 固定书籍 history，确认拒绝 |
| 2 | 所有者登录 POST |
| 3 | GET session 及 CSRF |
| 4 | GET config，确认仅 J1 capability/共享余量 |
| 5 | GET 固定 source 的 prepared 状态，确认 pin；其内部 R2/D1 另计 |
| 6 | 唯一 POST jobs，落固定 requestId/job/Workflow |
| 7 | GET 固定 job，观察运行或已完成；不要求模型刻意慢 |
| 8 | GET by-request，核对同 job/intent，不发送重复 POST |
| 9 | 关闭原页面后，期限内一次 GET 同 job；未完成则如实停止验收，不追加轮询/AI |
| 10 | GET 同书 history，确认私有保存或真实当前状态 |
| 11 | logout POST |
| 12 | 旧 session GET job，确认拒绝 |
| 13–14 | 仅失败路径的登出/撤销与其只读确认槽；不挪作重试创建、AI、额外轮询 |

每个业务 HTTP 最多 30 秒，整轮建议上限 20 分钟，关闭页面后的等待只为观察一次结果而非再执行。Workflow create 和上游 POST 是服务内部独立的 1/1 上限；两者不是这 14 个业务 HTTP 的同一计数。故障清理耗尽或结果未知仍保留全部意图。真实 source 状态检查、任务来源加载和部署回读各自列入完整 I/O 表，不能只报告业务 HTTP 而遗漏内部调用。

回退先关闭新创建/新派发 gate（primary CAS），保留只读历史和全部 ledger/results/unknown/partial；尚无意图的 job 可明确取消释放未用预留。已在途请求只可 best-effort 停止未来工作，不能把 terminate/回退当作上游已停止。新增 schema 与历史 source 不回滚/删除，不能部署回缺少共享预算 guard 的旧版本后仍允许文件名或业务调用；如旧版本不能识别共享 guard，必须同时关闭受影响写入口。代码/配置显式回退需保留现有首本阅读；完全静态回退继续遵守既有 trial/filename/prepared 的显式模式规则。生产失败不自动重发部署、secret、create 或 AI。

## 主 Agent review 的三项决策

1. 是否采用本文的首批固定 Luna/low、单活动业务任务、J1=1/J2<=4 调用，与文件名共享每日 20 的保守额度；若改变，先改设计和 SQL/测试范围，不能默认新增一套 20 次。
2. 是否采用“未知逻辑永不重发；已结束本地 transport 的未知允许新的明确独立任务；崩溃 pending 不按 lease 释放”的政策，并同步解释 Node 与云端的差别。
3. 是否把 J1 真实启用严格依赖 CF-04 的实际源消费/CPU验收、原 session 授权范围和独立 Key；若希望跨 session 长任务或更大全文总结，需新增 owner grant/分块资源批次，不能跳过当前边界。

review 通过只授权后续具体离线实现批次。schema/部署/真实 AI 的准确动作和验收仍以各批独立计划及证据为准。

## J0 精确实施提案（2026-10-23，待主 Agent 再 review）

主 Agent 已采纳以上三项决策，并分配 detail_finish（gpt-6.1-sol / high）做 J0。以下是实施前的表、trigger、事务接口冻结提案；本节更新时尚未创建 012 或状态模块。等待本节 review 后才编码。允许新增的实现文件为 `cloudflare/library/migrations/012-cloud-jobs.sql`、`cloudflare/library/jobs-state.mjs`、专项 Node/workerd 测试和必要的纯合成测试 helper；不改业务路由、Workflow、部署、auth、既有 009 SQL、F3 源码，不执行云 DDL、凭证操作或 AI。

### 共享账本：直接读旧行，逐单位永久预留

不复制、回填或改写 `filename_identifications`。012 建立只读 `shelf_ai_charges` 视图：旧 filename 每行产生一单位，按其原 `billing_day`；业务每条尚无 release 的 budget unit 产生一单位，按 unit 的固定 `billing_day`。无论调用是否转 attempted，业务 unit 始终只产生同一单位；调用 intent 不能额外加一。`used(day)=COUNT(shelf_ai_charges WHERE scope='production' AND billing_day=day)`，不是可变汇总计数器。

业务 job 创建时固定保留 J1 的 1 或 J2 的 4 单位，`AFTER INSERT jobs` 在同一 SQL statement 内创建全部单位。后续 release 是有 FK、唯一键和原因的追加行；只允许从来没有 call intent 的单位释放。任何 attempted/unknown 的单位永久保留，不因失败、取消、跨日、重登、换 gate generation 或结果删除而退还。release 后不能删除 release 或重建该单位/ordinal。

共享 slot 采用比仅在途请求更保守的规则：业务 job 从 queued 开始即独占本项目 AI slot，直到可信业务终态；中途 planning/ready 也挡住新的 filename。`shelf_ai_slots` 视图读旧 filename pending、非终态业务 job，以及防御性加入的无 terminal receipt 的 call intent。正常状态最多一个业务 job；同一 job 的 slot/intent 视图行不表示两次占用。新 job 检查没有任何 slot；新 filename 检查没有业务 slot，009 自己继续检查 filename pending。业务 call 准入忽略本 job 的活动行，要求没有 filename pending、没有其他 job、没有任何未终结 call intent。这样无需镜像 slot 或双写旧行。

现有 filename terminal 路径已核对：先 INSERT observation（必须仍 pending），再 UPDATE filename terminal，处于一个 `DB.batch`。共享视图直接读该行：整个事务提交前保持 slot，提交后自然消失；计费行始终保留。该事务失去回执不会导致视图重复释放或少算。012 不给 filename 增加 AFTER terminal 同步 trigger，不改变 observation/transition/retain；新增 `filename_identification_shared_admit_v1` BEFORE INSERT，只检查共享 slot 和 `used(NEW.billing_day)<20`。保留 `filename_identification_admit_v2` 及现有 schema assert 要求的四个 trigger，保留旧 filename 单独的 20 次保护；不 DROP 任何旧 guard。

SQLite/D1 写事务序列化使双方 guard 在同一写 authority 裁决：第 20 个单位只可能被 filename INSERT 或整个业务预留之一取得。业务预留 4 单位时必须一次有 4 单位空间，不能先取得 1 单位后等待或跨日补齐。额外 SQL 直接 INSERT unit 也不能绕过 job 上界和共享 20 guard。

### 012 的精确对象与约束

所有新增业务行只允许 `scope='production'`；测试使用隔离合成数据库中的 production scope，绝不把 check/生产 DB 混用。所有时间、序号、version、计数用 `typeof(...)=integer`，时间为 UTC 毫秒；ID 为 canonical UUID，hash 为小写 64 hex，随机 claim nonce 为独立 64 hex。所有责任表禁止 DELETE，所有 append-only 行禁止 UPDATE；无 TTL/lease 清理触发器。

| 对象 | 固定列、唯一性与作用 |
| --- | --- |
| `shelf_job_control` | `scope PK, mode(closed/jobs-v1), generation>=1, updated_at`；012 唯一初始行为 closed/generation1。任何修改必须 generation 恰好加 1、时间单调；禁止删除。J0 模块无打开方法，测试仅在隔离 DB 显式改为 jobs-v1。close 后再 open 不能恢复旧 generation 的任务 |
| `shelf_jobs` | `scope,job_id PK(scope,job_id),request_id UNIQUE(scope,request_id),logical_fingerprint UNIQUE(scope,logical_fingerprint),contract='jobs-v1',operation(question/chapter_summary/full_summary),model='gpt-6-luna',effort='low',prompt_contract,book_id,file_id,version_hash,source_snapshot_json,input_json,input_sha256,session_hash,generation,gate_generation,created_at,deadline_at,billing_day,max_calls(1/4),required_calls(NULL/1..4),state,version>=0,cancel_requested(0/1),updated_at,last_event_id`。question 只能 max_calls1，summary 只能 max_calls4。头部和所有输入/source/session/day 字段不可变；状态字段只能由下述 event 驱动。非终态 state 建唯一 scope 部分索引，保证一个活动 job |
| `shelf_job_events` | `scope,job_id,event_id PK,kind,expected_version,new_version=expected_version+1,from_state,to_state,cancel_requested,required_calls,created_at,reference_nonce,code`；`UNIQUE(scope,job_id,new_version)`。固定 kind 为 planning/ready/call_admitted/call_finished/cancel/workflow_observed/stop。无任意 payload/错误正文。BEFORE 校验 CAS 和动作对应证据，AFTER 更新 job 的状态/version/last_event_id；job UPDATE trigger 反查该 event，拒绝直接改状态 |
| `shelf_job_budget_units` | `scope,job_id,unit_no PK(scope,job_id,unit_no),billing_day,created_at`，FK job；unit_no 为 1..max_calls，日和时间必须等于 job。job INSERT 的 AFTER trigger 用固定 1..4 集合创建全部行；insert guard 检查新 job version0、上界、共享日额度。行永久不可变 |
| `shelf_job_budget_releases` | `scope,job_id,unit_no PK/FK unit,event_id FK event,reason(plan_unused/job_terminal),created_at`。只允许无 call intent 的 unit；plan_unused 仅 ready event 且 unit_no>required_calls，job_terminal 仅终态 event。event 的 AFTER 动作自动插入相应所有未发送单位的 release，不由 JS 减计数 |
| `shelf_job_workflow_intents` | `scope,job_id PK/FK job,instance_id UNIQUE,claim_nonce UNIQUE,created_at,expected_version`。永久一次创建意图；instance_id 从固定 scope/job_id 生成，不能由调用者换值；created_at=job.created_at，expected_version=0。没有可变的“重发”字段 |
| `shelf_job_workflow_receipts` | `scope,job_id PK/FK intent,claim_nonce FK对应 intent,observed_at,outcome(created/uncertain),code`；一次追加终态，不根据 get/status 的回读补出 create 资格。AFTER 生成 workflow_observed event；unknown 且尚无 call intent 可终结为 orchestration_unknown 并释放未发单位，已有在途 call 则保留当前活动状态和责任，不假称它没启动 |
| `shelf_job_call_plans` | `scope,job_id,ordinal PK/FK unit,phase(question/leaf/reduce),input_sha256,input_codepoints(1..50000),request_bytes(1..262144),coverage_json,created_at`。plan 内容和 ordinal 永不改写；coverage JSON 最多 16 KiB，不含原文。ready event 要求 1..required_calls 连续、数量一致、phase 与 operation 合法；不允许以换 ordinal 重做已计划步骤 |
| `shelf_job_call_intents` | `scope,job_id,ordinal PK/FK plan,dispatch_nonce UNIQUE,expected_version,billing_day,created_at,deadline_at,body_sha256`。同 unit 最多一条，日固定为 job 日且 `created_at/86400000=billing_day`；deadline 固定为 created_at+900000，不晚于 job.deadline_at-60000。intent 需无 release、当前 grant/source/gate/cancel 检查通过、前置计划调用全部 completed 且 usable；不接受 caller 指定旧 nonce |
| `shelf_job_call_receipts` | `scope,job_id,ordinal PK/FK intent,dispatch_nonce,observed_at,outcome(completed/failed/uncertain),transport_closed=1,usable(0/1),code,content_text,content_sha256,usage_json,coverage_json`。content UTF-8 最多128KiB、最终最多16000 Unicode字符、leaf最多3000；未成功content/hash必须NULL，成功必须非空且有hash。usage为NULL或仅含非负安全整数input_tokens/output_tokens，最多1KiB；coverage JSON最多16KiB。receipt永久不可变。usable由INSERT SELECT按当前grant/source/gate/期限/取消原子计算，不采信caller可用性声明；撤销后的完整响应只能usable0隔离保存。AFTER原子产生call_finished event，按当前取消/授权/序号决定ready/最终completed/failed/cancelled/uncertain，并释放明确未发单位 |

FK 均为复合 scope/job/ordinal 精确绑定，不允许把 A job 的 nonce、unit、plan、receipt 或 event 用于 B job。SQLite 对跨表唯一 nonce 的表达限制由明确的复合 UNIQUE+FK 解决，不把 FK 只写到 nonce 单列后忽略父身份。触发器错误使用静态 `jobs_*` code；SQL NULL 比较使用 `IS/IS NOT`，不让 nullable 字段绕过 immutable 比较。

额外三个只读视图为 `shelf_job_current_sources`、`shelf_ai_charges`、`shelf_ai_slots`。source 视图从现有 `shelf_prepared_readable_sources` LEFT JOIN `metadata_overrides`，用固定顺序 `json_object` 生成 snapshot。字段是 prepared 视图现有全部 SQL primitive 列（包括 descriptor、identity、original catalog/registry 字段）、实际 chunk count、`COALESCE(metadata.version,0)` 和规范缺省 patch `{}`。snapshot UTF-8 最大 64 KiB。创建和每次调用 intent 的 SQL guard 要求当前 snapshot 与 job 保存字符串逐字节相同，且实际 chunk count 等于声明数；不靠 JS 缓存 hash 判断当前来源。该视图不替代 `loadPreparedForJob` 的 R2/包/hash 实测，J0 不读取 R2。

输入 `input_json` UTF-8 上限 32 KiB，不含 cookie/CSRF/Key；J0 canonical helper 只接受固定 question/summary 所需白名单，不接受 arbitrary prompt/body/model。语义 fingerprint 固定为 book+file/version（源内容身份）+operation/range+规范问题/固定对话 refs+model；不包含 requestId、prompt contract、gate/session generation。dispatch body hash 独立保存，升级 contract 或重新登录不能绕开已有 uncertain 的逻辑唯一键。首批 conversation refs 固定为空；作者与 publication 不在 012 中实现。

### 原子事件与方法契约

新模块只依赖 D1/SQLite 适配器、crypto 和可信 clock；不 import Worker 路由、Workflow SDK、fetch、R2、Key、进程环境变量或 operator。对外普通 DTO 不带 nonce、source snapshot、原始 SQL 错误和私有输入。每次独立安全边界使用新的 `withSession('first-primary')` 首读；真正准入仍以写 statement/trigger 的最新状态为准。时间由模块 clock 产生，不采信未来 API body 的 now/billingDay。

| 方法 | 精确写入与成功条件 |
| --- | --- |
| `getJob` / `getByRequest` / `getByFingerprint` / `sharedBudget` | 只读；查到旧意图/receipt 只返回状态，永不返回任何发送 permit。先授权的 HTTP 投影留给 J1，本模块不是公开读取 API |
| `admitJob(input,grant)` | 一个 batch：INSERT job RETURNING（trigger 检查 gate/session/source/slot/日额度并创建全部 units）；INSERT 固定 workflow intent RETURNING；最终 SELECT 该 job 与本次新 nonce。只有本 batch 两条 INSERT 均确定成功、各 RETURNING 恰好一行、返回身份/nonce与本次生成值精确一致，才交出一次内存creation permit。唯一键冲突或回执丢失时仅回读DTO/冲突，零permit |
| `startPlanning(jobId,expectedVersion)` | INSERT planning event，CAS queued→planning，重查原 grant/source/gate/期限。CAS 失败无动作；不外送 |
| `savePlan(jobId,expectedVersion,plans)` | 一个 batch INSERT 有界 plans，再 INSERT ready event。ready trigger 检查连续序号/数量/phase，设置 required_calls，自动释放 unused units；任意失败整批回滚。重复/冲突只读既有计划，不重写。没有任何 intent 时本地失败可经 stop event 终结，自动释放未发 units |
| `claimCall(jobId,ordinal,expectedVersion,bodyHash)` | 模块新生成dispatch_nonce；一个batch INSERT call intent RETURNING，再INSERT call_admitted event RETURNING（CAS ready→running，引用新intent），最后读本次标识。必须两个INSERT各RETURNING恰好一行、identity/nonce/version精确匹配，才生成一次内存dispatch permit。任意异常/缺行/未知提交，回读只用于状态，绝不授予permit |
| `consumePermit(permit,callback)` | permit 是模块私有 WeakMap 的不可序列化空对象；只有本次 admission 的成功回执路径能创建。先从 WeakMap 删除，再调用 callback 一次；二次 consume、clone/JSON/readback/另一 isolate 的对象全部拒绝。callback 收到私有 job/ordinal/nonce 收据上下文；其返回值不重建 permit。J0 callback 只做合成计数，J1 固定 transport 才能发唯一 POST |
| `recordWorkflowOutcome(receipt)` | 单次 INSERT workflow receipt（含原 nonce）及 AFTER event；只接受此 intent 的 bounded outcome。保存回执失败可以只读核对，不再 consume/create。unknown 与 call admission 的竞争由同一 DB 串行裁决；终态先提交则后续 call intent 被拒，有在途 intent 先提交则保留责任，不释放 attempted |
| `finishCall(receipt)` | 单次 INSERT immutable call receipt，AFTER trigger 依据此时 job 最新 version 生成 CAS event、更新业务状态和未用 release。无需用发出时的旧 version 覆盖取消状态。取消先提交则完整成功也只能隔离；receipt 先提交并完成则之后取消不伪称已撤回结果。已有 receipt 返回只读同一结果；不同内容冲突，不 UPDATE 旧 receipt |
| `cancelJob(jobId,expectedVersion)` / `stopUnsent(jobId,expectedVersion,code)` | INSERT CAS event。无 pending call 时可终结并释放所有无 intent 单位；有 pending call 的取消仅变 cancellation_requested，保留 slot 和所有预算。stop 不能替未结束 transport 写 uncertain。没有 `retry/resume/reclaim/renewLease/reset` 方法 |

CAS event 的 BEFORE trigger 必须验证事件种类、允许 from/to、expected_version 当前值、时间单调、reference nonce 和对应新 intent/receipt；AFTER 先更新 job，再追加 release。job UPDATE guard 要求指向刚插入且版本恰好相邻的 event。plans/intent INSERT 与 event 处于同一个 batch；一旦 event CAS 失败，前面的 INSERT 也回滚。不能把 `UPDATE ... WHERE version=?` 返回 0 当作 batch 会自行回滚；所有必须成功的 CAS 用会 `RAISE(ABORT,...)` 的 event INSERT。直接写出不完整状态最多形成保守锁，不可能产生 permit；模块仍必须确认整批的精确成功回执。

不把D1 `meta.changes===1`当作带trigger事务的唯一证据：不同适配器可能将trigger内部变动纳入计数。精确成功以无ON CONFLICT忽略的INSERT自身RETURNING一行、唯一键/trigger CAS和本次nonce/version匹配共同裁决，并在SQLite及workerd验证实际回执形状；不存在“meta非零但未得到本次返回行也发出”的分支。summary计划仅允许required_calls为1、3、4：1是单leaf，3/4是2/3个leaf加最后一个reduce；question固定单question。各ordinal按顺序执行，前序必须有completed/usable receipt。

预算释放与业务终态绑定：ready event 仅释放 ordinal>required_calls；completed/failed/cancelled/orchestration_unknown/uncertain event 释放所有无 intent 的单位。uncertain 必须引用已追加的 `transport_closed=1` call receipt，或来自 workflow create 回执不明且没有 call intent；不存在“deadline 到自动改 uncertain”路径。crash 留下的 pending intent 永久占 slot，J0 不提供 operator 归档/解锁接口。未来归档需独立设计，不能调用 finishCall 假造已结束 transport。

job.deadline_at 不晚于原 session.expires_at 和本 UTC 日结束；创建须容纳最大调用数×960000 ms 加 `(max_calls+1)×30000 ms` 来源余量，不足则零预留拒绝。每次 intent 仍须在原日且剩余至少 960000 ms；午夜没有自动新 reservation。结果在 deadline 后返回仍只可隔离 receipt，不再派发。跨日读取旧结果不改其 billing_day。

### Trigger 清单与离线验收

012精确trigger名为：`shelf_job_control_transition/retain`；`shelf_job_header_admit/units/update/retain`；`shelf_job_event_admit/apply/immutable/retain`；`shelf_job_unit_admit/immutable/retain`；`shelf_job_release_admit/immutable/retain`；`shelf_job_workflow_intent_admit/immutable/retain`；`shelf_job_workflow_receipt_admit/apply/immutable/retain`；`shelf_job_plan_admit/immutable/retain`；`shelf_job_call_intent_admit/immutable/retain`；`shelf_job_call_receipt_admit/apply/immutable/retain`；以及additive `filename_identification_shared_admit_v1`（斜线表示同前缀分别命名，共34个）。每个责任表都有retain/immutable（job header例外采用event-only update）trigger；schema assert验证准确对象、列、trigger SQL hash和control合法形状，不以“表名存在”作为可用。迁移测试另断言初始closed；打开后的schema assert不得误要求当前gate仍closed。J0不把新schema加入线上deploy/apply列表。

实施时附每方法 statement/参数上界：admit3、startPlanning1、savePlan最多5、claim3、workflowOutcome1、finish1、cancel/stop1（不含 trigger 内部固定 SQL）；每 statement 参数不超过 32。plans 最大4，unit 最大4；触发器内部最多4单位的固定集合，不循环或无界 JSON 数组。source guard 的 catalog/metadata snapshot 有64KiB硬限，读历史的方法另设25项/64KiB上界。测试按真实 SQL 记录完整执行量，不把 trigger 内部 statement 隐去。

验收按以下边界分层，全部只用合成数据：

1. Node SQLite：默认 closed；旧 filename 行原值、全部历史状态/旧 guard 保留；filename observation+terminal 的整批成功/回滚/失去回执；两连接交叉抢第20单位、4单位一次预留、双方 slot、业务多 callback；额外 direct SQL 绕 guard 必须失败。
2. 预算与状态：reserved→intent不改变计数；重复 release/CAS/receipt、取消与 finish 竞争；attempted/unknown 永不 release；23:59 旧 pending跨日仍挡slot、旧uncertain仅计原日、新日独立任务允许；日期/generation/session/source pin变更无新permit；关闭再打开不能复活旧任务；计划及终态事务注入失败全回滚。
3. 每个 admission 的 commit前失败、commit成功回执丢失、fresh callback读旧nonce、旧permit二次consume、JSON clone、重新加载模块/多isolate；最多一次creation/dispatch callback。unknown无下一步；崩溃intent无lease释放；不通过readback“确认成功”后恢复发送资格。
4. 真 workerd：Miniflare+真实D1绑定执行012，最小测试worker只装新模块；`outboundService` 拦截全部fetch并拒绝/返回合成响应，从不转发DNS/互联网。不含真实Key/业务source；至少两个独立执行context竞争与回执丢失重放，并断言真实workerd调用次数。J0不声称验证了云Workflow、真实正文CPU或AI。
5. 主 Agent 独立 review 新SQL/module/tests后，再跑适用全套测试、构建与 public检查；012/私有设计不进入公开白名单。J0交付标为离线通过、未安装云schema、业务capability关闭；提交/推送/部署仍由主 Agent 在整合门槛通过后处理。

回退只撤回本地未合并实现，或将新 gate 保持closed；不DROP012、不删ledger、不恢复任何permit，不改旧阅读/filename配置。当前提案需要主 Agent 明确审阅的实现取舍只有：业务从queued起独占共享slot（比原最低并发条件更保守）、append-only单位+release而非可变计数、source精确SQL snapshot、event驱动CAS和receipt自动终结。review通过后按此编码，有结构调整先回报再实施。
