# 唯一远端存储 authority 与切换计划（2026-10-21）

实施分工：主 Agent 负责范围、review、真实云操作、最终验收与发布；本方案和安全/持久状态实现由 gpt-6.1-sol / high 承担。依赖 AI/R2 客户端收尾；设计和离线验证可先行。本文不加入公开文档导出白名单；真实账号、D1 ID、快照、对象 key 和 receipt 只放被忽略的 `.local`，目录 0700、文件 0600。

## 2026-10-22 接续实现与验收计划

本次由 gpt-6.1-sol / high 在已有未提交实现上收尾 authority、SQL 003/004 和正式测试；迁移操作器由另一 Sol/high 任务负责，双方依赖 `migrateFrozen` 只到 imported、`activateFrozen` 才能到 ready 的契约。主 Agent 独立 review 后验收；本段计划不代表真实迁移或上线。

范围：逐项审查 imported 的 exact staging INSERT 边界、原书/正文跨两环境的单预算、原书确认与 production 阅读投影原子性、全部 POST 不确定结果、验证总 deadline 与迟到流取消、完整独立回读后再次核对冻结来源，以及 ready 所需的可信写能力关闭证明。将 draft 测试改正式测试并纳入 `npm test`；更新本文过期描述。明确不做云写、上传、启用 API、提交或发布，不改其他任务文件及私人状态。

验证顺序：先运行 authority 专项，补充闭包缺项、投影/来源漂移和响应未知的失败路径，再运行完整 Node/Python 回归并交主 Agent review。旧入口关闭、迁移操作器的 targeted 测试由对应任务交付，主 Agent 验收集成。无完整写关闭与可信 drain 上界证明时只能保持 imported；当前操作器的 ready 命令在任何 IO 前拒绝。发布仍按本文末尾门槛由主 Agent 执行；失败保留旧冻结及所有预算事实，以全局 auth 关闭、static disabled 和停止 operator 回退，不能尝试修改不可变 registry 来关闭条目。

## 当前事实与目标

代码盘点：`server/storage-authority.mjs/.sql` 是本机 SQLite 参考；`server/object-sync.mjs` 已在提交 `9963771` 中等待异步 `claimPut` 和 `markUncertain`，本轮不重复实现。旧版 `scripts/cf-library-operations.mjs` 按 profile 写独立 D1 预算、`server/upload.mjs` 持有本机 JSON 账本及无条件 PUT、`scripts/cf-library-clients.mjs` 和 CF-01 probe 持有旧 PUT 路径；本轮未提交实现正在将这些入口永久拒绝执行，须由主 Agent 验收。两库不能各分配 8 GB，代码入口关闭也不等于旧进程/凭证的真实写能力已经撤销。Worker 当前只有读书/登录/metadata 写入，没有原书上传 API。

本机只读检查确认 `.local/cf03/deploy.json` 含两个不同的固定 D1 ID，权限 0600；默认 manifest 当前无已登记 storageKey。这不证明没有旧预留、不证明远端为空，也不代替真实冻结。历史资料称 check 已有 schema/002 且 auth 关闭、production 空；新轮必须逐库有界实测，不沿用历史值。

目标是唯一远端原子预算，覆盖 original/prepared-text × check/production。总预算 8,000,000,000 bytes、单对象 1..20,000,000 bytes；证据继续使用新鲜完整账号 R2 observation，按 observed + committed + reserved + requested 保守计数，不扣猜测重叠。任何 uncertain 继续占用全部额度。

## 选定架构

复用 `.local/cf03/deploy.json` 的 **production D1** 作为唯一 authority，新增 `shelf_storage_*` 前缀表；不新建 D1、不改两库身份、不把 check/prod auth/session/catalog 合库。所有新上传入口只绑定这一 D1 的 account/ID/name；identity 同时钉住固定桶、authority ID 与两个 legacy DB ID。check DB 保留原资料、独立鉴权和永久冻结标记，永不成为第二个预算实例。

远端 adapter 使用固定项目 D1 REST URL；公开 API 无 reserve/confirm/任意 SQL 路由。不创建通用凭证；现有项目管理凭证属于可信 operator 边界，SQL trigger 无法防御持有 D1 管理权限者蓄意改 schema。代码只暴露受限方法，确认仅由 HEAD→条件 GET 全字节 SHA256→HEAD 验证闭包调用；R2 adapter 不隐式重试 PUT。

原子性用单条 SQL + trigger 实现：reservation INSERT 的 BEFORE trigger 验证 ready/identity/新鲜证据和余额，AFTER trigger 增加 reserved；claim CAS 单条 UPDATE 持久记录唯一 PUT 资格；confirmed UPDATE 的同一事务 trigger 转移额度、写 registry。不得把 SELECT 余额和 UPDATE 余额分成两个网络调用，也不得将 `BEGIN IMMEDIATE` 原样移植至 D1。相同 reservation/descriptor 重入幂等；响应丢失后读回，不重放未知 PUT。

迁移分批只写 staging，authority phase 保持 migration_required。最终单条 phase CAS 的 trigger 验证两份来源/冻结 hash/行数/总量/所有关联，原子发布 live reservations、registries 与预算，进入 imported；失败全部回滚。独立分页读回全部 live/staging/source/registry 及 production `file_registry`，重新算 hash，再完整核对两份冻结来源；保存 imported receipt，此时 `cloudWriteFreezeProven=false`。只有受信 verifier 提供进程/活动连接、旧入口和 CF-01 写能力关闭以及真实强制 deadline 的排空上界证明后，`activateFrozen` 才能再次回读并进入 ready。不删除或重建任何旧记录。当前操作器尚未实现这一关闭证明，ready 在任何 IO 前阻断。

生产阅读兼容：production 的既有 `file_registry` 是读取投影，预算唯一来自新 authority。原书确认时同库 trigger 原子投影到 `file_registry`，字段必须匹配已验证的 authority reservation，禁止 legacy confirm 直接写入、任意替换或删除投影。旧 `storage_state` / `upload_reservations` 全部永久拒绝写；`file_registry` 的 INSERT guard 只允许与新 registry 完全一致的受控投影，UPDATE/DELETE 永久拒绝。两个新 registry 同样不可变，不支持关闭单条登记；旧已导入 disabled 登记保持 disabled 并继续占 committed。回退只能关闭全局 auth、保持 static disabled 并停止 operator。prepared-text 用独立 registry，不伪装原书、不投影到原书文件表。check 可上传和验证合成对象，但此轮不启用 check 私人阅读；若需要 check API 读取新登记，另加固定 production authority 只读 binding 并完整修改鉴权后二次一致性检查，不能跨库假装原子。

## 全部旧入口的冻结与证明

1. 本机 `server/upload.mjs` 的 execute 永久返回迁移错误，dry-run 保留；新老 `cf:library upload/reconcile` 入口不得再调旧 reservation/confirm/R2 PUT。旧导出函数同样 fail closed，不能只禁 CLI。
2. 旧 `cf-library-clients.mjs.r2Client().put` 和 CF-01 probe PUT 永久关闭或只保留显式不可生产的内存 mock；禁止把固定桶 Object R/W 凭证交给不受 authority 控制的旧路径。probe 历史清理/证据不重放。
3. 两个固定 D1 上安装不可回退的存储冻结行与 BEFORE INSERT/UPDATE/DELETE triggers。只冻结存储表，不误伤独立 metadata/catalog/auth；已运行旧进程的后续 SQL 也必须拒绝。DDL 分条安装并非事务整体；此期间不开放 ready、不种启用的 auth。精确定义独立读回后各库以单条 marker INSERT 使冻结生效，两库都回读确认前新 authority 不开放；部分失败保留已冻结库和未知记录，经独立 status 后显式继续完成，不恢复旧准入。
4. 远端只读回读 `sqlite_master` 中受限表/trigger 定义 hash、freeze ID/时刻及两库 storage counts。以实际拒绝旧 reservation 的有界测试证明冻结，测试使用不会落库的旧路径合法输入，不修改真实记录。
5. 检查 `getConfig` 解析出的实际 manifest/stateDir，而非仅默认路径；保留并快照 JSON `upload-reservations.json`、manifest 中所有 storageKey、任何 upload.lock 状态。缺失只可记为“已检查指定路径不存在”，不能忽略已配置其他路径。有任何旧本地已上传/未决项时先投影为独立 legacy-local 来源并保守占额度，方案须增加三来源 canonical schema；在实现该兼容前必须阻断迁移，不能清零或猜测归属。默认两来源导入仅在证明确无本地旧对象和预留时适用。
6. 数据库停写不能撤回已在飞行中的 R2 PUT。先拒绝所有旧执行入口、确认本项目旧上传进程和活动连接已关闭、lock 不存在，并独立证明旧 CF-01 probe 的写绑定/凭证/路由已关闭。排空上界必须来自真正强制生效的 transport deadline 及其配置证据，不能凭等待60秒、数据库 marker 或调用者布尔值推断。结构化 closure 绑定 identity、入口、本机状态、进程、连接和 probe 证据 hash，记录 deadline 配置 hash/最大请求寿命、stoppedAt/drainedAt/verifiedAt；可信 verifier 负责实际核验证据，adapter 校验完整性与激活时新鲜度。所有旧未决记录导入 uncertain 且 putAttempted=true，永不重传。无法证明无旧在飞行写入时保持 imported，上传关闭。

## 真实快照与空库规则

先运行只读 preflight：仅固定两个 D1 的 identity GET、受限 sqlite_master 表/trigger 名/SQL hash、存在的 storage_state 完整非秘密预算字段、reservation/registry 按 state 的 COUNT/SUM、auth enabled/generation 的数字汇总。不得读取 owner verifier、session hash、正文或列出账号资源。Worker 设置仅固定两个 Worker 的 routes开关/版本和绑定类型/已固定目标一致性，secret 仅查名字，不输出值。

远端 adapter 的完整迁移快照在 freeze 后使用稳定主键 keyset 分页，每页最多100行、两来源 reservations 合计硬上限1000行、每张回读表最多1000行、单响应上限1 MB，显式 ORDER BY；独立读回后再次检查源统计与完整数据。按源逐行转换 descriptor 并校验格式/key/hash/状态/完整字段，保存 canon hash 与源 SQL/schema hash。confirmed 必须有 content_verified、etag 和完整 registry；disabled 仍计 committed。reserved/uploading/uncertain 全部变成 uncertain；aborted 仅 absence_verified 明确成立才可排除。unknown state、孤儿登记、账本和行总量不符、快照缺页或冲突全部阻断。共享本机 snapshot validator 的100,000行兼容上限不是远端执行预算；当前受控操作器仅允许真实已核验空旧源，任何非空旧源另需主 Agent 审查精确预算。

production 如果真实没有业务表：须取得固定 ID/name identity、限定 sqlite_master 无业务表证明、明确 empty-source freeze/marker；先只建冻结和 authority schema，空来源的 committed/reserved/counts=0 来自这些真实查询，不能由404/权限拒绝推断。若已有部分业务表而缺 ledger，不能当空库。生产基础业务 schema 可后续在保持入口关闭的情况下初始化，但不得覆盖上述证据或重跑 legacy admission。

## 受控工具与预算

先交付纯只读 preflight CLI，无 `--sql`/任意 URL/资源名/账号枚举参数；main review 后执行，私有 receipt 保存原始安全字段与目标身份，stdout 仅安全摘要。接着提供独立 freeze/snapshot/import/readback/status 操作，每次只有固定动作，mutating 动作显式 `--execute`，操作 hash/identity 一致才可恢复。不自动建资源、开启API、上传、重试未知写或改计费。

所有查询≤100 KB、params≤100、网络 deadline≤30s、无重定向、错误脱敏。当前操作器将仓库固定SQL文件在本机内存SQLite解析为原始完整单条DDL，按原始依赖顺序经固定D1 REST接口逐条执行，不通过Wrangler隐式展开、不接受任意SQL/路径/资源。每条DDL独立事务，所有请求先私有落盘intent，按精确已存在定义恢复，不假定多请求共同事务。固定动作、请求/DDL上限与恢复检查点见 `scripts/storage-migrate.md`。任何POST的传输失败、HTTP错误、5xx、异常正文或D1 envelope均记unknown，无自动重试；只读回读后才能显式恢复。迁移staging每批≤10行、参数≤90，live publication依赖单条SQL trigger原子提交；若超D1 30s限制则停在migration_required，不拆开live publication。1000行只是adapter硬拒绝上限，不是获准执行1000行的预算；cloud操作先从preflight获得真实计数，再由main固定精确请求预算。

## 顺序、验收与回退

1. main review本文；实现异步同步协议修正、只读preflight及测试。先独立commit/push/CI，main随后执行fixed-target preflight，无云写。
2. 基于真实preflight确定明确迁移请求预算，完成authority SQL/adapter、旧入口冻结和迁移工具、测试。main review后全套Node/Python、disabled build、verify:public/static、真实secret离线扫描；commit→push→CI。
3. main按既有授权执行旧入口冻结→两来源真实快照→staging→原子发布imported→独立readback。完整进程/连接/probe写能力关闭及可信drain证明另行实现、review、真实验收后才可activate到ready；当前操作器拒绝ready，不越过此门槛。记录每一步真实回读和未知结果。冻结失败不上传；读取失败不补零；未知写先只读恢复。
4. 本地与真实远端分别验证：original/prepared-text ×check/production争最后额度只一个成功；真实竞争可用受限合成/不可PUT预留但不得污染8GB真实账本，优先在独立临时合成表测试同一SQL。旧入口拒绝、迁移幂等、差一字节冲突、部分staging崩溃恢复、unknown保留全部额度、异步claim失败零PUT、确认失败不启登记。真实authority SQL和identity须独立核对，不能把测试表成功称生产验收。
5. 取得≤5分钟、完整、固定账号、当月、Free/Standard的真实R2证据；证据不足继续等待实际数据，不修改采样时间。先单个中性合成对象完整PUT/恢复/HEAD→GET hash→HEAD，再从明确私人映射选一个≤20MB原书；每次单文件计划和receipt，禁止扫描后批量上传。实际线上登录、拒绝未登录/禁止origin、Range、页/章节定位与浏览器阅读另由main验收。静态200不算业务后端成功。
6. 任何迁移/上传失败：旧入口继续冻结，保留旧库、staging、所有预留和R2对象；关闭全局auth、保持static disabled、停止operator并保留已有静态部署。不可变registry不支持单条关闭，不用修改登记绕过约束。可revert代码但不重新开启旧独立预算，不删除uncertain、不回滚已确认的预算事实。只有完整重新验证后显式恢复新authority。

发布结果分别报告本地验证、远端CI、真实迁移/对象协议和线上功能；任何一项缺证据记unknown。此文仅设计，尚未迁移、尚未上传、尚未启用私人阅读。

## 第一实施检查点（本地，尚未执行云端）

`scripts/storage-preflight.mjs` 已实现固定两个D1/Worker的纯只读查询，最大18请求、单响应1MB、全请求30秒硬截止（包括fetch及正文），无网络重试、拒绝重定向。每次派发前将请求intent和固定预算写入0700/0600私有receipt并fsync文件及父目录；stdout只有计数和安全摘要。两个D1的应用表COUNT只排除SQLite保留`sqlite_`前缀、精确`_cf_KV`和`d1_migrations`；任何其他未知表均阻止空库证明，不排除任意`_cf_`前缀。观测空schema仍不是停写/迁移证明。账本缺失、不完整evidence保持unknown，已有reserved/committed不会清零。当前工具不查询会话/验证器、对象key/正文或账号资源列表。

同步协议现在等待异步claim CAS完成后才允许PUT，并等待uncertain落库；有界回归覆盖延迟CAS、CAS失败零PUT、uncertain失败保留原错误、真实旧schema查询、最大请求数、预写intent、外部/符号链接路径、非空本机JSON账本、缺失manifest、缺失/错误D1、不完整evidence、超长响应、忽略AbortSignal的fetch、停滞正文/取消及重定向。此检查点由main review、全套验证及commit/push/CI后执行首次真实只读inventory，不执行云写或上传。

## 2026-10-22 接续：CF01旧写能力关闭的先行只读核查

主Agent已在提交 `4e23dd3`、本地471项Node/8项Python及两CI通过后执行真实schema冻结。100条DDL及两个冻结标记已独立读回；旧入口负向验证返回未分类错误，保留unknown并停止，authority仍uninitialized，不继续导入或上传。先由Sol/high补齐受限错误元数据与历史probe行精确只读查询，再经review/验证/提交/CI恢复；不得凭完整schema把负向验证补记成功。

并行只读核查由 `gpt-6.1-sol / high` 实施：固定CF01资源，核对实际历史版本与R2写路径、持久预算/运行/tombstone及已完成私人receipt。只读工具默认preview零IO，显式execute每请求durable intent，最多16个固定项目管理请求、单响应最多2MB、期限30秒，不列账号资源、不读取其他项目、不重放probe。使用官方Worker beta version `include=modules`只读取该固定Worker的历史代码；内容仅私有保存或记录hash，不输出秘密。实际所有storage admission都须可映射到先持久预留、后await PUT、后明确成功终态的同版本代码；缺版本、失败/未知/活跃行、缺页均不形成closure证明。

只读库存本身不能关闭在禁用前已接入但尚未reserve的旧请求。下一mutating动作须独立review固定CF01 D1 storage-only admission guard并回读，在不改历史行、Workflow或其他诊断的前提下永久拒绝后续storage预留，然后完整核对已预留历史终态并移除旧R2绑定/入口。可信完整调度账本可能提供终态排空依据；只有真正取得该证据后才评审支持此证明来源，不能以调用者布尔值或时间等待替代。当前先行核查不写云端、不改变ready阻断，也不放宽R2新鲜完整用量门槛。失败保留全部证据和现有静态站。

2026-10-21通过官方HTTPS读取[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)：`batch()` 的语句顺序执行，任何一条失败会回滚整批；`withSession("first-primary")` 首次读走primary并维持后续顺序一致性。这不等于跨D1或跨R2事务，安全准入必须由同一D1内原子写入决定。通过[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)核对SQL 100KB、100绑定参数、单行2MB、单查询30秒；batch内每条语句仍受单查询限制。以上两页实际读取成功，web工具的runtime代理404由直接官方HTTPS只读获取替代。
