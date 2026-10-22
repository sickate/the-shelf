# 固定 CF01 storage 能力收回

`node scripts/cf01-storage-close.mjs`、`close` 与 `status` 默认 preview，配置/文件/网络均零 IO。只接受下列固定动作，不接受账号、Worker、D1、版本、URL、SQL、路径、profile 或 force 参数：

```sh
node scripts/cf01-storage-close.mjs status --execute
node scripts/cf01-storage-close.mjs close --execute
```

本工具仅用于 `.env` 固定账号及 `.local/cf01/resources.json` 的固定 `the-shelf-cf01` D1 和主 Worker；不操作 mock Worker、Workflow、其他项目或账号/zone 资源列表，不读取/修改 R2 对象，不运行 sampler、smoke、cleanup 或业务 POST。先由主 Agent review、本地验证、提交、push 和既有 CI 通过后，主 Agent 才在既有项目授权内执行真实动作。代码和合成测试交付不代表真实云端关闭。

目标是永久关闭 storage 的新准入并从固定 Worker 新部署版本收回 `CF_BUCKET → the-shelf-books`；其他四个固定绑定、历史 budget/run、代码、Workflow、crypto 诊断和非绑定设置须保持。`cloudWriteFreezeProven`、`drainProven`、`uploadAllowed` 始终 false，routes 完整性始终 unknown，工具没有 ready/activate 路径。R2 binding 收回不证明旧 isolate 或已接收 PUT 已结束；authority 必须继续 imported。

## 固定方案与预算

实现分工为 `gpt-6.1-sol / high`，主 Agent 负责最终 review、功能验证、真实动作和发布。依赖真实 audit 已观察到固定两表、一个原始 reserve trigger，以及 storage budget=1、live storage runs=0、orphan=0；该 tombstone 不作排空证明。实现接受最多12个 lifetime budget、4个 storage budget/run 的有限计数，不读取其他任务正文；超限、未知 schema、绑定或分页均阻断，不能现场扩大预算。

每次请求（包括只读）先将固定目标、SQL hash、HTTP方法、有限预算和 dispatched intent 私有 fsync 后才派发。每次最多32 HTTP、6 DDL、1负向探针、1 PATCH；单响应最多2,000,000 bytes，每请求 fetch 与全部正文共同受30秒硬截止，拒绝重定向，无网络重试。SQL及参数只来自固定常量和新随机 run ID/时间，不接受调用者 SQL。

| 阶段                                                                                     | 请求数 |
| ---------------------------------------------------------------------------------------- | -----: |
| D1 identity、schema、counts、Worker settings、最新 deployment、该版本 modules、subdomain |      7 |
| 六个 guard：逐条 CREATE TRIGGER 后各独立 schema 回读                                     | 最多12 |
| storage 负向 INSERT、独立该 ID 双表零行回读、counts                                      |      3 |
| PATCH 前 settings / deployment 再核对                                                    |      2 |
| 固定 settings PATCH，移除 R2 绑定                                                        |  最多1 |
| 独立 settings、deployment、该版本 modules、subdomain、schema、counts                     |      6 |
| 完整首次 close 合成基线                                                                  |     31 |

已有精确 guard 不重复创建，未知/修改定义不修复或删除。`status` 是云端只读：上述首轮7请求，再独立 schema/counts 两请求，基线9。若存在未知负向探针，再逐条固定 ID 查询双表 COUNT，最多8条，仍计入32上限。Deployment 接口官方约定第一条为当前流量部署，只使用第一条、要求恰一个100%版本；不把历史部署分页当作已排空证明，不跟随其他页。

六个固定触发器只影响 storage：budget INSERT/UPDATE/DELETE 均拒绝，storage run INSERT/DELETE 拒绝；run UPDATE 只允许 run_id/kind/delay_seconds/mode/created_at 不变并写入 completed/failed/uncertain，阻止旧请求从 reserved 进入 running 后再启动 PUT。workflow/crypto 原准入及运行更新继续可用；既存 storage 可以落终态。工具不 UPDATE/DELETE 任何历史行，不修改 CF03 SQL003/004。

全部 run identity 字段使用 SQLite `IS NOT` 比较，明确拒绝原非空 run_id 被更新为 NULL；不依赖 `TEXT PRIMARY KEY` 隐含非空。固定 counts 同时读取 storage budget/run 的 NULL run_id 数量，任一个非零即在首轮 inventory 阶段阻断 status/close，未派发任何云写。现有 NULL 身份不自动修复、删除或推断为可排空记录。

所有定义必须与原始 CF01 schema 和工具内固定 guard 精确匹配（仅排版空白归一化）。每条 DDL 独立事务，不把六条当跨请求事务。负向 INSERT 要求 HTTP400、顶层 success=false、唯一数字7500错误，以及完整精确 `cf01_storage_admission_closed: SQLITE_CONSTRAINT` 基本或官方 extended trigger 格式，可有单一 `D1_ERROR: ` 前缀。额外前后缀、5xx、错误码字符串或不合法 envelope 均 unknown；之后独立双表该 ID COUNT=0且原计数不变才继续。

## 官方 Worker 设置契约

2026-10-22 通过直接 HTTPS 实际读取官方 [ScriptAndVersionSettings SDK](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/script-and-version-settings.ts)：

- 固定 `PATCH /accounts/{account}/workers/scripts/the-shelf-cf01/settings` 使用 multipart `settings` JSON；`/script-settings` 不支持 bindings，本工具不调用它。
- PATCH 只提交保留的4个绑定，以 `{name,type:"inherit",version_id:<当前远端100%版本UUID>}` 继承；UUID仅从同Worker远端最新 deployment 取得，再与该固定版本 bindings/modules 交叉核对，绝不由CLI或本机历史日志指定。
- 官方 `WorkersBindingKindInherit.version_id` 明确可指定旧版本，不使用默认 latest；secret 通过 inherit 保留，不读取其值来回传。原响应中即使附带 secret text 也会丢弃，不进入 receipt/stdout。
- 官方说明 annotations 不会自动继承，因此显式保留原可写 workers/message 和 workers/tag；workers/triggered_by 为只读，不回传。可写内容仅在内存中传PATCH，receipt只存hash。
- PATCH 不携带代码、migrations、Workflow操作或其他设置；派发前持久预登记保留 bindings、非绑定 metadata、annotations、全部模块及 subdomain 的五个 expected hash。前后独立核对这些内容，任何变化阻断；PATCH响应或独立回读未知也不能当已关闭。

[官方 deployment SDK](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/deployments.ts) 的 list() 契约明确写明：“The first deployment in the list is the latest deployment actively serving traffic.” 因此取第一个部署且要求唯一版本100%，不猜测数组排序。[beta version SDK](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts)支持固定版本 `include=modules`。只保存module名称/类型/长度/hash，不保存新工具读取的源代码或secret。固定 service environment 仅接受缺失或 production，并归一化 production；[官方 multipart metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/#bindings)的 service 示例明确使用 production。未知/重复/额外绑定、不同service环境或入口均阻断。

没有找到能够只读取该固定 Worker 全部 routes 的官方受限接口；不会改查账号Worker列表或zone routes。故 routesCompleteness=unknown，不能产生完整 closure。

## 私有证据、失败与恢复

`.env`、resources、wrangler输入和所有收据要求普通单硬链接文件0600、目录0700；固定root及祖先、`.local`、`.local/cf01`设备号/inode/owner/mode/realpath被钉住，每次读取、写入和派发前重新核对。输入文件inode/权限/长度/mtime同样固定，根目录或收据被替换立即停止。每次新建 `storage-close-<UUID>.json`；`storage-close-state.json`持久保留所有写intent、unknown及失败run。stdout只输出安全计数、固定枚举和hash；provider错误正文、secret、annotations原文、author email不落盘。非probe响应即使success=true，只要errors存在且非空或类型不合法，也会失败；对应写保持unknown、读失败，后续请求停止。

独立 `storage-close.lock` 通过 O_EXCL 串行化该工具的 close/status。存在锁即阻断，不按年龄或猜测PID删除。崩溃残锁必须由主 Agent 根据实际本项目进程证据处理，不能删状态或收据绕过。

guard通过后、云PATCH前，将私有 `.local/cf01/wrangler.json` 的固定 r2_buckets 同步改为空数组，保持其他配置；原hash保留在receipt。使用相同文件/目录检查、0600临时文件、fsync及原子rename，防止以后误部署恢复能力。PATCH失败也不恢复本机R2项，不以本机修改代替云端证据；不改写历史evidence或audit收据。

任何可能写入请求的异常、HTTP失败、未知正文、超时或持久化失败都保留为 unknown，不在本次运行重发；已收到成功但后续回读失败的部分DDL也要求单独status。恢复顺序：

```sh
node scripts/cf01-storage-close.mjs status --execute
node scripts/cf01-storage-close.mjs close --execute
```

若有未知 D1 DDL/probe 写，status须在最新该类durable intent至少31秒之后完成两轮独立schema/counts观测，并对未知probe逐ID读零行，才产生恢复检查点。31秒只用于D1管理写恢复，不约束 Worker settings mutation，也不是R2 drain界限。

未知/dispatched PATCH 永远不因等待或“仍见 CF_BUCKET”而重试。独立status必须实际观察到无R2，且保留bindings/metadata/annotations/code/subdomain全部匹配该PATCH预登记expected hash，才保存与原请求关联的独立能力观测hash；原unknown状态不改判成功。若绑定仍在、hash漂移或来源缺失则继续阻断。close必须再次匹配这一独立观测，之后只允许零PATCH继续；回读不匹配时不会认领其他配置变更。PATCH在完整独立回读前都保留为pending，失败转unknown，防止200响应后回读漂移绕过恢复门槛。

status失败会撤销已有检查点；原unknown永久保留，不能改判 rejected、删除或释放预算。下一close按实际精确定义补齐缺失guard；未知PATCH只有上述expected闭合后才能零PATCH继续，已收回绑定不重复PATCH。任何新未知或部分失败重新要求独立status。

失败保留冻结、所有tombstone、历史行、unknown、本机关闭配置和已落地guard，不恢复R2绑定，不开启auth，不部署其他代码或资源；代码可revert，但不回滚已关闭的旧能力。没有可信R2在飞行PUT上界、旧进程/连接与routes完整证明时，关闭动作仍只有能力收回观测，authority保持imported、书籍上传0、私人阅读未启用。

本地专项只使用合成配置、内存SQLite和transport：

```sh
node --test tests/cf01-storage-close.test.mjs
```
