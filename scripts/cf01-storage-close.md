# 固定 CF01 storage 能力收回

2026-10-22 真实动作停在未知 PATCH：六个 storage guard 已落地并通过负向拒绝及独立零行回读；settings PATCH 返回 HTTP400，未知记录保留。本机 r2_buckets 已关闭，随后独立 status 仍观察到 CF_BUCKET 并返回 patch_resolution_required。不得重放 PATCH、改为 latest 再试、删除状态或把 guard 通过当作云端 R2 能力已收回；authority 继续 imported。发现官方 endpoint 限制冲突后，代码已删除全部 PATCH 请求构造及派发路径；包括全新私有状态在内，只要仍有R2，close都会在任何 PATCH intent 前固定失败为 cf01_close_patch_contract_unsupported。

`node scripts/cf01-storage-close.mjs`、`close` 与 `status` 默认 preview，配置/文件/网络均零 IO。只接受下列固定动作，不接受账号、Worker、D1、版本、URL、SQL、路径、profile 或 force 参数：

```sh
node scripts/cf01-storage-close.mjs status --execute
node scripts/cf01-storage-close.mjs close --execute
```

本工具仅用于 `.env` 固定账号及 `.local/cf01/resources.json` 的固定 `the-shelf-cf01` D1 和主 Worker；不操作 mock Worker、Workflow、其他项目或账号/zone 资源列表，不读取/修改 R2 对象，不运行 sampler、smoke、cleanup 或业务 POST。先由主 Agent review、本地验证、提交、push 和既有 CI 通过后，主 Agent 才在既有项目授权内执行真实动作。代码和合成测试交付不代表真实云端关闭。

当前工具可以永久关闭 storage 新准入并在远端已无R2时独立回读；自动收回 `CF_BUCKET → the-shelf-books` 的 PATCH 路径已禁用，需另立可信方案。其他四个固定绑定、历史 budget/run、代码、Workflow、crypto 诊断和非绑定设置须保持。`cloudWriteFreezeProven`、`drainProven`、`uploadAllowed` 始终 false，routes 完整性始终 unknown，工具没有 ready/activate 路径。R2 binding 收回不证明旧 isolate 或已接收 PUT 已结束；authority 必须继续 imported。

## 固定方案与预算

实现分工为 `gpt-6.1-sol / high`，主 Agent 负责最终 review、功能验证、真实动作和发布。依赖真实 audit 已观察到固定两表、一个原始 reserve trigger，以及 storage budget=1、live storage runs=0、orphan=0；该 tombstone 不作排空证明。实现接受最多12个 lifetime budget、4个 storage budget/run 的有限计数，不读取其他任务正文；超限、未知 schema、绑定或分页均阻断，不能现场扩大预算。

每次请求（包括只读）先将固定目标、SQL hash、HTTP方法、有限预算和 dispatched intent 私有 fsync 后才派发。每次最多32 HTTP、6 DDL、1负向探针、**0 PATCH**；单响应最多2,000,000 bytes，每请求 fetch 与全部正文共同受30秒硬截止，拒绝重定向，无网络重试。SQL及参数只来自固定常量和新随机 run ID/时间，不接受调用者 SQL。六个已落地 guard 的 SQL 与 identity hash 保持不变。

| 阶段                                                                                     | 请求数 |
| ---------------------------------------------------------------------------------------- | -----: |
| D1 identity、schema、counts、Worker settings、最新 deployment、该版本 modules、subdomain |      7 |
| 六个 guard：逐条 CREATE TRIGGER 后各独立 schema 回读                                     | 最多12 |
| storage 负向 INSERT、独立该 ID 双表零行回读、counts                                      |      3 |
| 本机冻结前 settings / deployment 再核对                                                  |      2 |
| 仍有R2时固定契约拒绝；不创建 PATCH intent                                                |      0 |
| 独立 settings、deployment、该版本 modules、subdomain、schema、counts                     |      6 |
| 远端已无R2的完整首次 close 合成基线                                                      |     30 |

全新状态且仍有R2时，最多24请求完成六guard、负向验证及本机配置冻结，然后固定失败；只有这些准入保护完成，不能报告 capability-reduced。若六guard已存在，同样分支最多12请求并失败。已有未知PATCH仍先要求独立status和expected闭合，不会以这一契约gate替代或清空旧unknown。

已有精确 guard 不重复创建，未知/修改定义不修复或删除。`status` 是云端只读：上述首轮7请求，再独立 schema/counts 两请求，基线9。若存在未知负向探针，再逐条固定 ID 查询双表 COUNT，最多8条，仍计入32上限。Deployment 接口官方约定第一条为当前流量部署，只使用第一条、要求恰一个100%版本；不把历史部署分页当作已排空证明，不跟随其他页。

六个固定触发器只影响 storage：budget INSERT/UPDATE/DELETE 均拒绝，storage run INSERT/DELETE 拒绝；run UPDATE 只允许 run_id/kind/delay_seconds/mode/created_at 不变并写入 completed/failed/uncertain，阻止旧请求从 reserved 进入 running 后再启动 PUT。workflow/crypto 原准入及运行更新继续可用；既存 storage 可以落终态。工具不 UPDATE/DELETE 任何历史行，不修改 CF03 SQL003/004。

全部 run identity 字段使用 SQLite `IS NOT` 比较，明确拒绝原非空 run_id 被更新为 NULL；不依赖 `TEXT PRIMARY KEY` 隐含非空。固定 counts 同时读取 storage budget/run 的 NULL run_id 数量，任一个非零即在首轮 inventory 阶段阻断 status/close，未派发任何云写。现有 NULL 身份不自动修复、删除或推断为可排空记录。

所有定义必须与原始 CF01 schema 和工具内固定 guard 精确匹配（仅排版空白归一化）。每条 DDL 独立事务，不把六条当跨请求事务。负向 INSERT 要求 HTTP400、顶层 success=false、唯一数字7500错误，以及完整精确 `cf01_storage_admission_closed: SQLITE_CONSTRAINT` 基本或官方 extended trigger 格式，可有单一 `D1_ERROR: ` 前缀。额外前后缀、5xx、错误码字符串或不合法 envelope 均 unknown；之后独立双表该 ID COUNT=0且原计数不变才继续。

## 官方 Worker 设置契约

最初通过直接 HTTPS 读取官方 [ScriptAndVersionSettings SDK](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/script-and-version-settings.ts)，但只核对其可选 version_id 字段，遗漏了 endpoint 限制。2026-10-22 真实 PATCH 后又独立读取并固定了 [官方 OpenAPI revision d3e86ee](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml)，发现以下明确限制；这是契约纠正，不是对已丢弃错误正文的重建：

- 固定 `PATCH /accounts/{account}/workers/scripts/the-shelf-cf01/settings` 的 [requestBody](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L238663) 明确使用 multipart/form-data，settings part 为 application/json；当前 FormData + JSON Blob 与这一形状一致，不能据 HTTP400 推断应改成整个 application/json body。`/script-settings` 不支持 bindings，本工具不调用它。
- 已删除的旧实现曾提交保留的4个绑定，以 `{name,type:"inherit",version_id:<当前远端100%版本UUID>}` 继承；UUID取自同Worker远端最新100% deployment并核对该版本 bindings/modules。**但具体 UUID 在此 settings endpoint 不受支持。** 新代码没有替代写路径。
- 官方 [inherit.version_id 描述](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L513226) 限定：只有 `/accounts/{account_id}/workers/workers/{worker_id}/versions` 下的 Workers API version endpoints 接受具体版本ID；其他 endpoint 只接受 latest，并会对具体ID返回错误10057。当前方案违反该限制。SDK旧注释中的可选字段不能代替 endpoint 支持证明。
- latest 指最近上传版本，可能不是当前部署版本，不能简单替换它来重试；是否能够安全保留绑定、secret和原代码，需要另立方案、独立 review 与可信终态证据。此次仅确认请求与官方限制冲突，无法确认原 HTTP400 实际是否包含10057，不追溯改判原unknown。
- secret 原响应值不会进入 receipt/stdout；本轮不读取或回传secret、不新建版本或部署、不对管理接口做任何补充测试调用。
- 旧实现根据官方说明显式保留不自动继承的 annotations，预登记了 bindings、非绑定 metadata、annotations、全部模块和 subdomain 的五个 expected hash。新代码只保留这些历史hash的独立回读核验，不重新构造annotations或任何PATCH；receipt只存安全hash。

[官方 deployment SDK](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/deployments.ts) 的 list() 契约明确写明：“The first deployment in the list is the latest deployment actively serving traffic.” 因此取第一个部署且要求唯一版本100%，不猜测数组排序。[beta version SDK](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts)支持固定版本 `include=modules`。只保存module名称/类型/长度/hash，不保存新工具读取的源代码或secret。固定 service environment 仅接受缺失或 production，并归一化 production；[官方 multipart metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/#bindings)的 service 示例明确使用 production。未知/重复/额外绑定、不同service环境或入口均阻断。

没有找到能够只读取该固定 Worker 全部 routes 的官方受限接口；不会改查账号Worker列表或zone routes。故 routesCompleteness=unknown，不能产生完整 closure。

## 私有证据、失败与恢复

`.env`、resources、wrangler输入和所有收据要求普通单硬链接文件0600、目录0700；固定root及祖先、`.local`、`.local/cf01`设备号/inode/owner/mode/realpath被钉住，每次读取、写入和派发前重新核对。输入文件inode/权限/长度/mtime同样固定，根目录或收据被替换立即停止。每次新建 `storage-close-<UUID>.json`；`storage-close-state.json`持久保留所有写intent、unknown及失败run。stdout只输出安全计数、固定枚举和hash；provider错误正文、secret、annotations原文、author email不落盘。非probe响应即使success=true，只要errors存在且非空或类型不合法，也会失败；对应写保持unknown、读失败，后续请求停止。

独立 `storage-close.lock` 通过 O_EXCL 串行化该工具的 close/status。存在锁即阻断，不按年龄或猜测PID删除。崩溃残锁必须由主 Agent 根据实际本项目进程证据处理，不能删状态或收据绕过。

guard通过后，将私有 `.local/cf01/wrangler.json` 的固定 r2_buckets 同步改为空数组，保持其他配置；原hash保留在receipt。使用相同文件/目录检查、0600临时文件、fsync及原子rename，防止以后误部署恢复能力。之后若远端仍有R2，固定契约拒绝且不创建任何PATCH intent；不恢复本机R2项，不以本机修改代替云端证据，不改写历史evidence或audit收据。

任何可能写入请求的异常、HTTP失败、未知正文、超时或持久化失败都保留为 unknown，不在本次运行重发；已收到成功但后续回读失败的部分DDL也要求单独status。恢复顺序：

```sh
node scripts/cf01-storage-close.mjs status --execute
node scripts/cf01-storage-close.mjs close --execute
```

若有未知 D1 DDL/probe 写，status须在最新该类durable intent至少31秒之后完成两轮独立schema/counts观测，并对未知probe逐ID读零行，才产生恢复检查点。31秒只用于D1管理写恢复，不约束 Worker settings mutation，也不是R2 drain界限。

历史未知/dispatched PATCH 永远不因等待或“仍见 CF_BUCKET”而重试。独立status必须实际观察到无R2，且保留bindings/metadata/annotations/code/subdomain全部匹配该PATCH预登记expected hash，才保存与原请求关联的独立能力观测hash；原unknown状态不改判成功。若绑定仍在、hash漂移或来源缺失则继续阻断。close必须再次匹配这一独立观测，之后只允许零PATCH继续；回读不匹配时不会认领其他配置变更。历史pending/unknown记录原样保留，新代码不能创建或派发新的PATCH。

status失败会撤销已有检查点；原unknown永久保留，不能改判 rejected、删除或释放预算。下一close按实际精确定义补齐缺失guard；未知PATCH只有上述expected闭合后才能零PATCH继续，已收回绑定不重复PATCH。任何新未知或部分失败重新要求独立status。

失败保留冻结、所有tombstone、历史行、unknown、本机关闭配置和已落地guard，不恢复R2绑定，不开启auth，不部署其他代码或资源；代码可revert，但不回滚已关闭的旧能力。没有可信R2在飞行PUT上界、旧进程/连接与routes完整证明时，关闭动作仍只有能力收回观测，authority保持imported、书籍上传0、私人阅读未启用。

本地专项只使用合成配置、内存SQLite和transport：

```sh
node --test tests/cf01-storage-close.test.mjs
```
