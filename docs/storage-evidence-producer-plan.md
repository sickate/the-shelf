# N4 完整用量与旧写闭包证据设计

日期：2026-10-23；续核：2026-10-24。执行模型：`gpt-6.1-sol` / high。状态：只读研究与设计，待主Agent审查；不进入公开文档白名单。

## 目标、范围与执行计划

本批回答两个独立问题：现有公开Cloudflare接口能否产生符合既有五分钟、全账号、当月计费等价Class A/B、Standard/Free契约的可信用量证据；旧CF01及其他旧写路径能否用完整终态A或完整持久预留最大责任B证明预算上界。重点核对固定项目桶强一致LIST及字节上界能证明什么、如何与条件性账号纯汇总授权结合。没有证据时明确unknown/unsupported，不把validator、observer或手写布尔称为producer。

步骤与依赖：先复核现有validator、observer、安全投影和旧CF01持久预留代码；再读取公开官方API、SDK、强一致性、multipart、计费、Workers生命周期及版本历史契约；逐字段建立来源/覆盖/时间/权限/不支持矩阵；最后给出证明公式、反例、未来最小有界只读计划和实现验收门槛。主Agent先审本设计，之后才能分配编码。

本批不读取`.env`或凭证明文、不运行任何账号接口、不读取私人对象/正文、不修改旧data/operator/011或原unknown、不执行DDL/activation/PUT/DELETE、不改计费和8,000,000,000-byte/20,000,000-byte门槛，不请求新上传例外。引用代码和既有安全投影不等于重新证明真实云端事实。

验收：每个肯定结论有具体源码或官方契约；区分当前文档可支持、当前项目实际已证明、仍需实际只读取证和公开契约缺项。尤其禁止以LIST当前可见对象替代在飞行/multipart责任、以固定桶替代全账号、以采样率1/HTTP Date/fetchedAt替代完整性或源时间、以当前可见版本替代所有历史执行代码。交付只有本文件；不发布代码或云状态变化。回退仅撤回设计，不撤销既有事实、对象、账本、guard或收据。

## 结论与当前边界

现有公开契约不足以产生当前验收所需的 `admissible` 账号用量收据：REST账号metrics没有可核验的源时间/最大滞后或当月Class A/B；GraphQL公开契约没有同时证明五分钟内、完整全账号、计费等价计数及实际Free/Standard状态。固定项目桶LIST和完整持久预留可以作为项目字节证明的组成部分，但不能补上账号汇总的这些缺项。这里的“不足”指本批已核对来源无法支持该证明，不断言Cloudflare内部没有其他能力。

旧写闭包A（全部可能旧写均已终态）尚未证明。有限残留责任B有可实现的条件性证明路径，尤其CF01先持久预留再固定大小PUT的历史代码；但实际历史代码/执行入口全集及其他旧写者仍不完整，当前不能出具真实B。冻结的N1 `validateSafety`只接受A，明确拒绝B；不得将B改名为A、填 `allPossibleWritesTerminal=true` 或只调整validator来开启普通上传。

因此本批交付是来源契约、证明条件和后续实施计划；不是producer实现、真实云核查或迁移验收。普通上传保持关闭，首本已消耗的一次许可不再issue/upload；原imported、unknown、guard、对象、账本和私人收据全部保留。私人阅读的独立推进不依赖放开普通上传。

## 证据层级和本地实现事实

本设计区分三种结论：

| 层级 | 含义 | 本批可得结果 |
| --- | --- | --- |
| `observed` | 获得某来源返回的数值或本地历史投影；注明范围、时间和缺项 | 已有observer和历史安全投影；N4没有刷新账号观察 |
| `unsupported` | 已核对来源的契约缺少必要字段或语义，当前适配器不能完成证明 | 当前REST/GraphQL无法满足完整账号证据契约；不能把缺字段补零 |
| `admissible` | 可信producer实际取证，验证完整性/源时间/身份/计费语义等全部条件，再由独立verifier绑定快照和CAS | 当前不存在；格式校验、hash和布尔字段不能生成这些事实 |

三个要求互相独立，必须分别通过：①当前全账号存储的可信数值或经专门审核的上界；②当月完整、够新、计费等价的Class A/B及Standard/Free状态；③所有旧写入口的能力关闭和在途责任处理。项目LIST不是①的账号全集；字节责任B不是②的操作次数上界；账号观察也不能证明③。

本地对应实现：

- `scripts/cf-library-data.mjs` 的 `accountEvidence` 校验schema/账号、完整覆盖声明、Free/Standard、当前UTC月、安全整数、五分钟及A<800,000/B<8,000,000；它不获取或证明这些输入。通用helper允许最多30秒未来偏差，不等于生产可以接受未来证据。
- `server/storage-activation-v2.mjs` 的 `validateEvidence` 更严格地拒绝未来时间，并要求provider四项verified标志、contract/observation hash。其 `validateSafety` 仅接受 `complete-terminal-closure` 下的 `enforced-transport-deadline` 或 `complete-persisted-terminal-set`。这些是拒绝不合格输入的契约，不是已接入的producer/verifier。
- `scripts/cf-r2-account-audit.mjs` 是observer，始终 `uploadEligible=false`、`accountEvidence=null`；最多3个固定管理读取，保留unknown，不自动翻页或重试。已有研究见 `docs/r2-evidence-research.md`、`scripts/cf-r2-account-audit.md`。
- `server/remote-storage-authority.mjs` / N2a继续计入旧账及首本责任；N4不修改authority、schema、原收据或会计公式，不创建第二套可用余额。

## 公开来源契约与缺项矩阵

以下为公开官方资料和官方SDK源码核查，非账号实际响应。检索在2026-10-23至24完成；SDK链接指向当时main而非固定提交，后续编码须保存原文hash并固定已审核版本。没有将调用时间、HTTP Date或缓存抓取时间当源时间。

| 来源/字段 | 官方契约可支持的事实 | 不能据此填写的证明 |
| --- | --- | --- |
| R2账号REST `GET /accounts/{account}/r2/metrics`；`standard` / `infrequentAccess` → `published` / `uploaded` → `payloadSize` / `metadataSize` / `objects`，均可选 | 官方SDK描述为全账号桶的存储/对象metrics，并明确可能未反映最新数据 | 没有source timestamp/watermark/最大滞后、完整缺字段语义、当月A/B或实际套餐字段；不能承诺五分钟或把省略类别当0 |
| GraphQL `r2StorageAdaptiveGroups` 的 `payloadSize` / `metadataSize` / `objectCount` / `uploadCount` / `datetime` | 桶的对象数据、metadata、对象数、待完成multipart数及该值代表的时间；单次查询范围最多31天 | 一组max不是全账号sum；不同桶/时点max相加也不是同一时点总量。账号筛选不自动证明所有桶/辖区都已报告、无延迟或漏采样 |
| GraphQL `r2OperationsAdaptiveGroups` 的操作类型/状态/时间聚合 | 可观察指定范围的操作统计；只选择纯数字聚合可维护既有授权边界 | 未找到覆盖整月、所有接口/状态及计费归类完全等价的完整水位契约；sampleRate=1或无显式采样字段不证明无迟到/漏报 |
| R2 `list` / S3 `ListObjectsV2` | 该次LIST执行时的已完成可见对象；大小和storageClass可用于固定项目桶检查 | 不涵盖未知在途PUT未来提交、未完成multipart所有parts；多页没有已记录的同一快照token契约 |
| Workers `R2Object.size` / `storageClass` | 已完成对象数据字节及Standard/InfrequentAccess | bucket默认Standard不证明历史对象均Standard，也不证明其他账号桶无IA |
| R2公开pricing | Standard免费层、操作分类、GB-month计费规则 | 公开价格不是目标账号实际Free状态，GB-month不是当前字节，未观察值不能按免费额度补齐 |
| Workers版本/部署列表 | 可分页查看当前可见版本和部署，detail可取模块 | 不是所有曾执行代码的不可删历史全集；列表分页完成也不证明执行全集完整 |
| R2 Data Access Logs | 支持的请求事件可辅助诊断 | 官方明确异步best effort、可能遗漏、只含HTTP<400、无历史回填且保留7天；不能形成完整当月账或完整旧写终态集 |

来源：[账号metrics API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/metrics/methods/list/)、[官方metrics类型](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/r2/buckets/metrics.ts)、[R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)、[GraphQL sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)、[R2 pricing](https://developers.cloudflare.com/r2/pricing/)、[Data Access Logs](https://developers.cloudflare.com/r2/buckets/data-access-logs/)。

REST四类分量即使有重叠，也不是“不能求上界”的充分理由：若已证明所有当前存储都在这些非负类别中，重复相加可以保守高估。但目前没有证明类别全集、缺字段为零、源时点和滞后期间增长上界，因此此处的和既不能当精确总量，也不能成为当前确定上界。`published`/`uploaded`名称也不提供足够语义让调用方自行去重或解释成复制份数。

R2 local uploads文档说明逻辑读写仍强一致，异步复制不构成“LIST可能陈旧”的理由；它也未给出把复制、上述metrics状态和计费存储相互换算的完整契约。不要因本地上传功能推断多算/少算或物理份数。来源：[local uploads](https://developers.cloudflare.com/r2/buckets/local-uploads/)。

### 时间、计数和Free语义

sourceTime必须来自有明确语义的源字段，覆盖所声明数值；`fetchedAt`仅说明取回时刻。GraphQL的旧样本即使刚取回也仍旧；源时间未来、超过300,000ms、跨UTC月、缺样本或覆盖未知均拒绝。采样置信区间不等于确定预算上界。源数据覆盖到时间t以后还必须处理t到准入时刻的全部可能增长；不能因“最多五分钟”就把窗口内其他客户端增长当0。

当月Class A/B需要完整账期和计费归类，包括LIST、multipart、copy/lifecycle等适用操作。当前公开pricing将ListObjects、ListMultipartUploads、ListParts列入A，将HEAD/GET/UsageSummary列入B；核查自身也消耗操作，必须纳入后续账或预留，而不能核查完仍使用核查前余额。公开文档提到UsageSummary不等于已发现可满足fresh/complete的现行API，不猜测URL或扩读账单。

项目8,000,000,000 bytes和20,000,000 bytes是十进制硬门槛，低于平台能力，不能用R2更大的对象上限或10 GB-month免费层替代。R2免费层只覆盖Standard；“Workers Free套餐”“R2免费额度资格”“R2实际账单计划”不是同一字段。冻结契约中的 `plan: free` 需要后续明确可验证的对应来源；仅凭公开价格或账号可调用API不能填true。本批不修改该契约或计费。

## 固定项目桶LIST能构成的证明

### 分页与稳定区间

官方将LIST定义为其执行时点的强一致操作。Workers `limit`最多1,000，但允许在仍有后页时返回较少对象，必须依据 `truncated` 和opaque `cursor` 翻页；不能按返回数量判结束。S3路径则须按ListObjectsV2返回的截断/continuation token字段处理，不能混用两套分页。来源：[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)、[Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)。

完整固定桶扫描须：目标账号/桶/辖区固定；无prefix/delimiter或其他省略对象的过滤；不请求customMetadata/httpMetadata；验证每页格式、大小、安全整数、storageClass、cursor前进且不循环；有预先固定的页/行/字节/时间上限。截断时缺cursor、重复cursor、到达上限仍有后页、异常或无法判定结束，结果均为incomplete，不输出“桶为空”。不同桶即使key相同也独立计数，不能跨桶去重。

多页强一致不等于一个多页快照。要把页求和为稳定时点的完整桶数据量，需要额外证明扫描区间内命名空间已静止，或完整列举全部可能变动者并把扫描期间/之后的遗漏和增长保守计入。两个相同扫描hash、两次相同D1快照或无新日志都不独立证明中间无写、无删除/重建或无延后提交。对象先在某页观察后删除、另一对象后加入已扫区间，可使两次局部观察漏掉责任；未知PUT也可在扫描后提交。

官方明确：强一致HEAD/GET的404只证明该次读取处理时不存在，不会等待或取消之前结果未知的PUT，后者仍可能随后提交。LIST不能提供更强的在途终止证明。文档提及条件重试作为一种应用策略，但本项目未知写禁止重试/换key，因此本设计不采用该办法。删除、清理回执、404和当前空桶均不用于释放旧责任。

### multipart和storageClass

已完成对象LIST不列出未完成multipart的所有part字节。需要完整可信的“所有可能历史写者均不支持且未发起multipart”证明，或单独有界执行S3 `ListMultipartUploads` 并对每个upload执行分页 `ListParts`，同时处理扫描期间可能新增/替换part和complete的责任；只检查 `uploadCount=0` 的滞后metrics不够。Workers reference本身未提供相应完整multipart列表方法，不能把resume成功当upload存在或不存在的校验。

R2兼容表支持ListMultipartUploads的key-marker/upload-id-marker和ListParts的part-number-marker；后续实现须固定R2实际支持的分页字段及XML/SDK解析契约，再编写边界测试，不能套用AWS额外的未承诺快照语义。缺字段或超限停止，不通过abort/delete使证明变简单。默认7天未完成multipart自动终止可被lifecycle调整，且尚无本项目该历史配置证据；等待7天不是闭包。来源：[multipart](https://developers.cloudflare.com/r2/objects/multipart-objects/)、[S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)。

每个对象必须核对storageClass；当前桶默认Standard只决定相应新写默认，历史对象可以不同，上传也可指定类别。项目固定桶LIST不能证明账号其他桶/辖区没有IA。来源：[官方bucket类型](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/r2/buckets/buckets.ts)。

### 字节公式及其适用边界

若已证明稳定区间、完整分页、固定桶全集，已完成对象数据量可写为 `P = Σ object.size`。这仅是live completed payload。文档限制对象metadata为8,192 bytes、key为1,024 bytes，因此 `Σ(size + 8,192 + 1,024)` 可作这些已文档化逻辑分量的保守候选界，重复计入key也可接受；但没有证明它与REST/GraphQL `metadataSize`、multipart内部占用、物理复制或计费总量完全同义。此映射未闭合前，不能把该式写为账号storedBytes或宣称8GB已证明。来源：[R2 limits](https://developers.cloudflare.com/r2/platform/limits/)。

对于完整已知的旧写者集合W，可设计：

```text
U_project = U_completed_baseline + U_pending_multipart
            + Σ(w ∈ W) max_additional_logical_bytes(w)
```

每项都要有明确测量口径、身份、覆盖和时间绑定；允许保守重复，不按404、cleanup、重叠或“可能已包含”扣减。若W不完整、某写者无最大大小/调用次数、multipart未知或测量口径未映射，则整体仍unknown，不用平台对象最大值代替没有次数上界的写者。该公式不创建新余额；原authority所有committed/reserved/trial责任仍完整保留。

现有准入把账号观察与authority责任相加，本就可能重复覆盖项目对象。N4不以LIST基线、当前空桶或已包含为由减去任何原责任来“找回空间”。若未来需要上界proof，必须显式标记 `measureKind: upper-bound` 并另行review，不能把上界伪装成当前精确观测值塞入冻结schema。

## 全账号组合与授权边界

固定项目桶LIST不能证明账号所有桶、所有辖区及所有调用者的当前占用。Volt未启用R2/未发现其他当前占用，是允许读取账号纯汇总的授权条件，不是所有历史桶/凭证/调用者均不存在的完整性证明。固定项目桶与首本隔离桶的证据也不能相互替代。

项目LIST可用于一致性拒绝：若同口径、同有效时间的账号声明总量小于项目已确认存储下界，应拒绝该声明；相等不能证明没有其他占用。过期账号数值加项目当前LIST，仍无法界定未观察其他调用者的增长。只有覆盖完整的账号源和有界滞后/增长，或经单独审核的完整账号责任模型，才能产生当前账号上界。

既有条件授权只允许账号纯数字汇总及固定项目桶对照；不会授权列出其他桶名、其他项目对象/metadata/内容或请求日志。本批未执行这些调用。未来不能通过全账号ListBuckets、逐桶LIST、Data Access Logs或账单明细绕开字段缺项；若来源不能在服务端限于已授权字段，维持unsupported并说明具体缺口，不先扩读再本地丢弃。没有新建通用凭证或提出新的上传豁免。

## 旧写闭包A：要求和现状

A需要完整的可能写集合，每项均有可信终态，或有覆盖R2服务端提交的强制有限截止。集合必须覆盖所有曾可执行版本、路由/服务/Workflow/队列入口、绑定与目标、Node/S3客户端、dashboard/direct API、multipart及残留连接。仅当前部署代码或已知两版本不足以证明全集。

正向成功回执只有在与实际执行版本/请求/目标绑定、该版本确实await PUT并在成功后持久终态时，才证明对应写已完成；不能从一次storage完成响应推断其他请求终态。通用catch写入failed/uncertain可能源于连接中断或PUT响应丢失，不自动是provider已终止的失败。删除run或cleanup响应次数不提供全部请求的映射。

HTTP客户端AbortController/60秒、本地进程退出、撤路由、禁workers.dev、关闭入口、D1 guard、移除/撤销凭证、部署新版本、删除Worker，均不能单独证明已进入R2的旧PUT终止。公开Workers文档没有对HTTP handler提供该服务端提交上界：客户端连接在时无固定wall-time上限，subrequest也无独立固定截止；waitUntil的30秒和runtime更新20分钟grace不是R2终态回执，CPU上限不是wall-time。IAM传播时间也不是在途取消契约。来源：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)。

版本列表也不闭合全集：Wrangler展示最近100个版本/部署；官方API支持分页且存在删除版本能力。全部当前可见页结束，不等于不可删的全部曾执行版本。部署版本还不保存R2/D1状态。后续只有新增可信历史来源/完整性见证才可能补全集；重复读相同列表不会补出已丢失历史。来源：[versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)、[官方beta versions类型](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts)、[script versions类型](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/versions.ts)、[官方分页实现](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/core/pagination.ts)。

本地已有安全投影见 `scripts/cf01-storage-audit.md` 和 `docs/resources-and-access.md`：历史7 runs/24 requests/8 starts中保留unknown=1、unattributed=1、unresolvedStart=1、unresolvedMutation=1；有1条storage completed及7条cleanup响应。既有guard观察为budget_all=7/storage=1、live storage run=0/orphan=0；这不是N4新鲜回读。现有audit只取得两个已知历史版本，无完整执行版本映射；其closure/upload标志仍false。不能给无run ID的POST猜测kind、补终态或抹掉unknown。因此当前A仍不成立。

## 有限残留责任B：可实现候选与阻塞

### CF01持久槽候选

本地历史提交 `720690b:cloudflare/probe/core.mjs` 的 `reserve` 及对应 `720690b:cloudflare/probe/handler.mjs` 在任何storage工作前原子 `INSERT OR IGNORE cf01_budget`；lifetime总预算12、storage最多4，trigger同时建立run，重复ID不再执行。对应 `storageProbe` 对严格UUID的固定key只调用一次await PUT，body为固定文本加UUID和换行，UTF-8恰为72 bytes，无multipart；随后GET/Range验证。cleanup保留budget tombstone。当前 `cloudflare/probe/core.mjs` 已拒绝旧storage写，`scripts/cf01-storage-close.mjs` 的storage guard阻止新增/删除预算及身份重用，但不能使已预留请求消失。

如果能证明所有可能path-to-PUT都先提交同一不可重用预算槽，完整且冻结的budget集合便可以覆盖那条无法归属的旧POST：未预留者将被guard阻断；已预留者属于已计责槽，无需猜测其run ID或强行证明其终态。这是B相较逐请求终态A可行的关键，不需要把unknown改成failed。

在完整历史代码均满足同一约束的前提下，CF01剩余payload责任最多为 `72 × N_storage_budget`，且N≤4；即使某槽当前无run/对象、已cleanup或实际已提交，也保守保留其最大责任，不扣减。72只覆盖payload；固定key/contentType等逻辑metadata仍须另计并映射所需测量口径，不能把72直接当账号总字节。

### 出具真实B前的必需证明

| 证明项 | 当前缺口/反例 | 未满足时输出 |
| --- | --- | --- |
| 所有可能执行历史版本/入口全集 | 只有两个已知版本及本地候选；没有不可遗漏的历史见证，不能用当前版替旧版 | `unsupported: historical_code_universe_unproven` |
| 每条PUT之前必经同一持久reserve且无绕行/重发 | 需逐版本/handler证明成功claim后仅一次固定PUT，错误路径/重入/其他入口也受限 | `unsupported: reserve_dominance_unproven` |
| 固定D1/桶/绑定身份，完整budget/tombstone及orphan检查 | 既有观察非本次刷新；需证明历史没有换库、删槽后重用、旁路表或孤儿执行 | `observed`且不授予B |
| 最大body、metadata、key、multipart/调用次数 | 当前72-byte候选仅针对已审源码；变量body、循环PUT、multipart或不同目标即失效 | `unsupported: residual_bound_unproven` |
| 所有其他旧写者 | Node/S3旧client、凭证/连接/直接入口仍须同等覆盖，CF01不能代表全部W | `unsupported: writer_universe_unproven` |
| 能力关闭与未来增长 | 冻结新reserve不必然移除旧执行能力；guard、binding、进程/连接证据分别保留 | 字节候选不能变成激活许可 |

不必为了B伪造一个无法证明的请求kind；但也不能把“有预算表”本身当作所有历史代码都使用它的证明。若历史全集证据永久缺失，B对真实历史可能不可恢复，应保留永久责任/关闭相关路径并独立报告该限制，不无限重试同类观察。

72×4的候选也不限制当月操作次数：普通阅读GET不受CF01 storage槽限制；历史CF01 handler的status只读D1/Workflow，不能误称为R2读取，但cleanup在每次执行时会HEAD，且没有另一个不可重用的操作claim，并发cleanup或失败后保留run可产生多次HEAD。因此不能从storage槽数推导整月R2读取上限；byte槽不是操作槽。即使真实B日后通过，也仍需独立完整账号A/B证据和入口控制。当前N1没有B proof-kind；支持B需另立schema/验证器/原子CAS方案和主Agent安全review，保留旧unknown与上界责任，不修改冻结N1或借名称兼容绕过。

## producer、verifier和结果接口设计

producer负责固定授权源的真实读取、目标身份校验、时间/完整性/测量口径证明、持久intent和结果；verifier独立检查来源契约与见证，将其绑定到准确authority快照/identity和CAS，再由既有validator拒绝不合法结构。hash只能绑定已读取内容，不能证明来源完整、未遗漏版本或时间新鲜；手写verified=true不是可信见证。

下一阶段先实现纯离线结果联合类型，示意如下，不是当前N1的输入schema：

```js
{ status: "observed", fetchedAt, sourceTime: null,
  numericComponents, measureKind: "source-components",
  coverage: "unknown", reasons: ["source_watermark_unavailable"] }
{ status: "unsupported", capability: "account-admission-evidence",
  reasons: ["billing_completeness_unproven", "source_lag_unbounded"] }
// 当前来源不能走此分支；只有实际见证通过后才能构造：
{ status: "admissible", contractRef, observationRef, witnessRefs,
  targetIdentityHash, sourceTime, coverageScope, measureKind }
```

`observed`和`unsupported`不带可被现有activation接受的accountEvidence/provider布尔；已知契约缺项时默认零网络返回unsupported，不能为凑fresh时间无意义刷新同一来源。字段缺失不填0，unsupported不是某个账号被测为0。精确值与上界必须分不同measureKind并说明误差方向；若现有契约不支持上界，保持拒绝而非悄悄转换。

producer之后仍需满足：固定端点/账号/目标/字段、无任意URL/SQL、来源schema固定审核、完整body有截止、数值安全范围、无重定向/重试、页上限、源时间验证、原子私有intent/收据及崩溃unknown保留。新证据不得释放或覆盖旧unknown，接入authority时仍使用唯一远端CAS，不引入第二账本或本地许可来源。

## 下一步任务、依赖和验收

主Agent先审本设计。以下只描述可分配工作，没有授权本批编码或执行真实读取。

| 顺序/任务 | 模型/effort及依赖 | 交付/验收 | 云状态 |
| --- | --- | --- | --- |
| N4a 来源能力矩阵和结果类型 | Sol/medium；依赖本设计review | 纯函数/固定官方契约fixture；当前REST/GraphQL只能observed/unsupported，无环境读取/默认网络。测试缺字段、旧/未来时间、采样、max误当sum、零值、跨月、类别重叠但缺覆盖等 | 零账号调用、零mutation |
| N4b CF01 B候选离线验证器 | Sol/high；依赖N4a和完整性见证格式review | 输入固定target manifest、已审代码bundle、schema/guards、完整budget/tombstone投影及安全历史；验证reserve支配和每槽最大责任。缺历史全集、orphan、复用槽、变长body、multipart、循环/旁路PUT、错绑定均拒绝；输出candidate/unsupported，不能实际授予B | 不读真实私有输入、不改operator |
| N4c 固定项目inventory inspector | Sol/high；依赖来源分页解析、下述预算和隐私review | 先合成fixture测试，既有actor写入口不扩展。输出payload/inventory观察和不完整原因，不输出账号admissible或自动release | 本地默认零IO，真实执行另经主Agentreview |
| N4d 真实账号producer与闭包接入 | Sol/high；依赖新的可证明来源契约、A或另审B、完整writer集合和生产verifier/journal | 满足全部fresh/coverage/billing/free/identity要求及安全CAS后方可谈activation；现有公开源缺项使该任务当前阻塞 | 不以N4a–c通过作为发布门槛 |

N4b采用已人工review的精确artifact fingerprint允许表及证明manifest核验，不运行输入代码，也不靠regex或任意JavaScript自动控制流分析授予reserve支配证明。“完整代码bundle”的hash不自行提供全集证明。若没有可恢复的历史完整性见证，应明确停止在candidate，而不是继续加heuristic把实际闭包变true。也不能给一组任意调用者输入授予producer可信身份。

### N4c候选固定请求预算（只作review输入）

只考虑已授权的项目普通桶和首本隔离桶两个固定目标，不列账号桶，不读正文，不返回原始key/metadata到stdout。每桶completed最多4页×1,000对象，multipart upload最多2页×1,000项，所有ListParts合计最多8页×1,000 parts；跨两桶总上限28个Class A列表请求。达到任一上限仍有后页/未处理upload就停止incomplete，不新增预算、不自动续跑。未用页不挪给其他目标。

这不是已经具备权限的可执行profile：首本隔离桶现有binding-only能力不自动提供S3 multipart列表能力；缺少固定目标所需的只读能力就返回unsupported。不得复用/扩权旧CF01或普通桶凭证、改变隔离或临时增设任意actor入口来完成扫描。选择binding读取已完成对象、S3读取multipart或完整历史无multipart证明，须先做具体能力/部署review。

每响应上限2,000,000 bytes、单次请求含完整body最长30秒、整个扫描最长120秒；任何一个先到即停止，未决读取记unknown，不自动重试。页必须完整解析且token前进；各类计数、key/part身份、size和storageClass都校验。multipart upload很多、一个upload超过剩余parts页或XML开销过大均可使本profile不够；这是有界拒绝的预期结果，不是空/完整证明。当前没有真实库存数据可宣称这些上限足够。

这28只是该候选R2扫描的最多列表操作，不包含额外核查、D1投影、凭证状态、账号observer或其他任务；正式执行计划必须分别列出它们，不能藏入28。实际调用自身Class A责任须持久计入；源证据不足时不运行扫描来代替账号证明。私有key只在受限内存/0600收据中处理，公开只输出聚合、受限reason、内容hash；不记录metadata/body、凭证明文、其他桶名或平台错误正文。分页token/上传ID也不公开。

## 部署、回退和本批验证

本批没有部署物，不提交激活/迁移，不调用账号接口。后续N4a–c可以本地review和合成测试完成，但不得因此部署可授予admissible证据的入口。N4d发布门槛必须另列具体代码、完整见证、真实安全验收和回退流程；届时按项目 `commit → push → CI → 受控部署 → 线上验收`，分开报告本地、CI、线上状态。真实用量/写闭包门槛未通过时继续保留当前受控私人阅读部署，普通上传关闭。

设计回退只撤回本文件或未启用实现；任何失败/unknown均保留原账和新intent责任，不删对象、guard、收据，不重放旧PUT，不重新issue首本许可。关闭现有operator入口仍须项目既定trial静态回退，不能仅auth close。

本批验证仅检查官方来源与本地代码一致性、文档差异/空白及公开白名单边界；不以文档检查替代功能测试或云端取证。`docs/storage-evidence-producer-plan.md`未加入 `scripts/export-docs.mjs` 固定清单。N1/N2a冻结实现和历史安全投影未因本研究改动。
