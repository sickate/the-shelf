# CF-03 Library 运维说明

本文说明目前仓库中的 CF-03 初始化、发布与书库数据工具。CF-03 仍处于验收阶段，尚未通过生产门槛，也不代表同源 API、登录或私人阅读已经上线。当前已上线的仍是 Workers Static Assets 静态站，GitHub Pages 作为公开站点回退。

2026-10-16已固化[受控CPU sampler与固定Cloudflare管理adapter](../../scripts/cf-cpu-sampler.md)：本地187项Node、8项Python测试通过，包含真实管理SQL与Worker+SQLite两轮CAS、满批维护及故障收尾。工具没有云CLI，实际执行通过已审私有operator和[独立有界计划12.2](../../docs/cf03-plan.md)进行。CPU及CF-03仍未验收，本地测试不等于生产API上线。

## 环境与初始化

所有 CLI 都从仓库根目录运行。`check` 和 `production` 使用独立 D1、独立 scope/origin，以及各自的 owner key、owner pepper 和 session secret。初始化只创建或核验 `.local/cf03/<profile>/` 下的本机私有文件（目录 0700、文件 0600），包括 `auth-init.sql`；不会创建或修改 Cloudflare 资源，不会应用 schema，也不会安装 Worker secret。

```sh
npm run cf:init -- --profile check
npm run cf:init -- --profile production
```

先建立/核对对应 D1，再显式应用 schema。整份 schema 曾经通过 REST `/query` 失败并返回 `incomplete input`，确认没有表生效；不要用 REST query 执行整份文件。使用官方 Wrangler 文件执行命令。不要裸跑 Wrangler（否则会读取仓库静态站配置），也不要 `source .env`。由受控 operator 先核对 Cloudflare account、D1 ID/name 与目标数据库状态，再以最小子进程环境传入已授权的项目专用凭证运行下列模板；`<...>` 均须替换为已核验值，token 不得放入 argv：

```sh
node node_modules/wrangler/bin/wrangler.js d1 execute <已核验数据库名> --remote --file <schema或auth SQL> --config <已核验私有配置路径> --env-file <空env文件路径> --yes
```

若目标库已应用旧版预算 trigger，先按维护计划停止准入并应用 `cloudflare/library/migrations/002-conservative-storage.sql`，核对后再恢复。`auth-init.sql` 也须在 schema 之后由操作者明确应用到对应 D1；重复初始化不会轮换凭证或重置 generation。

API Worker 发布命令只接受 `--profile`，参数顺序如下：

```sh
npm run deploy:cloudflare:api -- --profile check
npm run deploy:cloudflare:api -- --profile production
```

发布前必须已在目标 Worker 配好全部四个 Worker secrets；发布 helper 只验证绑定，不负责签发或安装秘密。`cf:init` 也不会写 D1 owner verifier；需在 schema 应用后明确执行生成的 `auth-init.sql`。API 部署配置使用被忽略的本地 `.local/cf03/deploy.json`，格式可参照 `cloudflare/library/deploy.example.json`；其中 check 与 production 数据库 ID 必须不同。

## 静态站构建与回退

`npm run build:cloudflare:api` 通过 `SHELF_CF_API_MODE=same-origin` 构建仅供生产 origin 的同源 API 前端；默认 `npm run build:cloudflare` 使用 `disabled`。Pages 回退必须维持私有 API 禁用，不能发布 same-origin/API 模式。

`npm run deploy:cloudflare` 仅执行静态发布。若目标 Worker 已绑定 API，helper 会拒绝用静态发布覆盖；确认需要回到 CF-02 静态站时才显式运行 `npm run deploy:cloudflare -- --static-rollback`。Cloudflare CI 默认只构建并保存 artifact，部署步骤关闭；单 Worker 专用部署凭证尚未配置。GitHub Pages 工作流仍是公开站点回退。

## Library CLI

命令格式为 `npm run cf:library -- <action> --profile <check|production> [options]`。每次只选择一个动作；`--profile` 必须提供，选项不可重复。

| 动作 | 用法与作用 |
| --- | --- |
| `bootstrap` | `bootstrap --profile check` 先 dry-run；加 `--execute` 才写入。可用 `--overrides <私有JSON路径>` 指定 metadata 修订，执行时可加 `--resume` 续接同一输入的活动导入。租约 token 对旧写入者 fencing，输入 fingerprint 不匹配时拒绝续接。 |
| `snapshot` | `snapshot --profile production` 生成私有预览；只有 `production` 可加 `--execute` 发布公开快照。发布前用固定公开字段白名单校验，快照期间 revision 必须一致；check 不允许发布。 |
| `plan` | `plan --profile production --file <fileId>` 只生成本机私有单文件计划；可用 `--manifest <路径>`、`--account-evidence <路径>` 覆盖默认私有输入。计划不是上传许可。 |
| `upload` | `upload --profile production --file <fileId> --execute` 才执行一次上传。可选同样的 `--manifest` 与 `--account-evidence`。一次只处理一个文件。 |
| `reconcile` | `reconcile --profile production --file <fileId> --execute` 对现有 reservation 核实对象并恢复状态；若 PUT 结果未知，不能盲目重试。 |

`check` 与 `production` 共用现有私有 `the-shelf-books` 桶及仅限该桶的 Object Read & Write 凭证：应用当前只做对象 HEAD 检查并签发单对象 GET；Library 工具按 scope 限定 key 前缀及允许的 PUT/HEAD/GET 操作。此阶段不要把真实书上传到 check；check 只应用于合成数据验证。现有桶凭证仅有对象读写权限，不能读取账号级共享用量。此前自动审核因其他项目metadata可能超出授权而拒绝汇总读取；该拒绝是历史记录。用户本轮说明当前仅The Shelf与Volt使用Cloudflare，并在核实不涉及其他项目R2使用的条件下授权账号R2总存储及当月Class A/B数量纯汇总只读。主Agent已复核Volt同账号、未启用R2，执行账号汇总与固定Shelf桶汇总对照；未请求其他桶名、对象名或业务数据，不新建通用凭证、不修改Volt。条件变化或出现不可归属当前存储时须停止。当前阻塞为数据freshness：截至11:23:42Z查询的最新存储点仍为11:10:00Z，虽账号与Shelf存储指标均为0，已超5分钟，未生成合格evidence；历史操作差额不归属某项目。不能改写采样时间或用单桶用量、未知值代替新鲜完整账号证据，上传继续阻断；CPU仍是API上线主门槛。

文件导入保持逐文件操作：单文件上限 20,000,000 bytes，项目总预算 8,000,000,000 bytes。预算按 `账号已观测占用 + 项目已确认 + 活跃预留 + 本次请求` 保守相加，不猜测或抵扣重复计量；本地 dry-run 缺少 D1 ledger 时会显示预算未知/阻止上传，最终额度由 D1 原子 reservation trigger 判定。PUT 超时或响应不明会保留 reservation 并标记 uncertain；先运行 reconcile。对象缺失只说明当前 HEAD 未发现对象，不能证明延迟 PUT 不会到达，所以不自动释放额度或重试未知 PUT。

## 当前验收状态

本轮阶段收尾：CPU证据分析器与重复配置解码最小候选已分别提交并推送 `5a6242d`、`15cd401`，两阶段Cloudflare及Pages CI均成功；最终156项Node、8项Python、disabled build、真实secret隐私扫描与verify:static通过。check的HTTP/2首轮21请求、80断言、真实CAS两次mutation admission及generation撤销HTTP检查通过；warm未运行、满批维护未触发。

最后一次同窗只读取得平台aggregate requests=21、errors=0，CPU P50/P95/P99/max=2.090/4.387/4.835/4.835ms，sampleInterval=1、同一version；分析器仍判 `unknown/incomplete_evidence`，保留 `group_aggregate_count_mismatch`、`ambiguous_attribution`、`missing_request_traffic`，不能凭aggregate低值判通过。平台max现已可取，原始逐请求CPU序列仍缺；HTTP/1与HTTP/2负载不可直接用于优化性能因果比较。本轮云分支结束，不加预算或采样；最终账本business48/100、explicitManagement84/90、D1management38/40，另有1次受控helper部署（内部HTTP未精确计数）。关闭证据确认check auth=0、active=0、入口disabled；最终只读不改变状态，生产API未启用、主站静态不变。

下一优先级先固化并测试受控sampler，完整收集两轮业务请求后再等待analytics，核验真实CAS及满批维护覆盖；形成新计划后再考虑下一云轮，不直接追加采样或优化。 CPU/CF-03未通过，R2新鲜证据不足，仍无原文件上传。

以下为静态改进发布时及上一轮CPU的历史记录。

静态改进发布时本地完整验证为138项 Node、8项 Python通过；metadata真实DOM 11项、account真实DOM 9项断言通过。独立check/production D1已建立；check schema与002预算迁移已应用并回读，production库仍空。production secrets仅本地生成，未安装Worker或写入auth；check Worker已有四个secrets；check已关闭 `auth_config.enabled`、递增generation并撤销所有会话，workers.dev与preview URLs已禁用，D1和secrets保留未删除。云端多轮安全/CAS/撤销通过，原子20并发最后一槽仅1个成功，合成导入与snapshot保留override通过。源码提交 `0ae8825` 已推送；Cloudflare CI `38724875134` 构建 artifact 成功，Pages CI `38724875089` 成功。首次真实静态 CLI 在任何 Cloudflare 写入前遇到入口循环并停止；CLI修复已通过主 Agent review，新增两项真实独立进程 static/API CLI smoke后总计138项Node与8项Python全通过。CLI修复提交 `3e1aa89` 已推送；Cloudflare CI `38725881041` 构建成功、部署按预期跳过，Pages CI `38725881116` 成功。默认disabled的静态改进已通过本机受控发布及线上验收：首次网络检查完成1248项后中断，随后仅恢复剩余56项，合计1304项HEAD均为200；32项GET与本地字节及MIME一致，缺失页、`/api/health` 与 `/api` 均返回404，runtime保持disabled；线上账号页经真实Chrome DOM验证，凭证控件为disabled。

上一轮CPU门槛未过：当时的小优化版本包含部署后首次访问的首轮21请求P50/P95/P99为2.512/6.554/10.981 ms；同版本后续完整热轮21请求（不能保证复用同一isolate），HTTP/66断言通过，CPU P50/P95/P99为2.341/6.017/6.180 ms，errors均为0。冷、热两轮P95都未达到5 ms目标。六个版本/轮次共126请求，加2次tail健康检查共128次（低于150）；最终候选版本首轮21次与同版本后续完整热轮21次，共42次。当时未取得平台max，tail连接后没有CPU events；P99不是最大值，本轮已补查平台max，原始逐请求CPU序列仍缺，5 ms目标不变。R2账号汇总只读条件授权已核查并执行；最新存储点不满足5分钟freshness，尚无合格上传证据；EPUB 1,799,179 bytes与PDF 2,588,862 bytes的dry-plan均因`account_storage_unknown`阻止，未上传原书或调用真实AI。代码及CLI修复已推送并通过CI，默认disabled静态改进已部署并通过线上验收，以receipt为准；API不发布，CF-03仍未验收。
