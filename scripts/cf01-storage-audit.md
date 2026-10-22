# CF01 storage 先行只读核查

`node scripts/cf01-storage-audit.mjs` 默认 preview：不读配置、不创建文件、不发网络请求。`node scripts/cf01-storage-audit.mjs --execute` 才执行固定 CF01 管理读取。没有 URL、SQL、账号、Worker、版本、profile 或输出路径参数；不能恢复、重试或扩大历史版本集合。真实执行由主 Agent review 和专项/完整验证通过后进行；本工具交付本身没有执行云端。

范围只涉及 `.env` 固定账号、`.local/cf01/resources.json` 的固定 D1 与 `the-shelf-cf01` 主 Worker。不读取 mock Worker、Workflow 实例、R2 列表/对象、其他项目或账号资源列表，不调用 probe，不执行 DDL、云端业务 POST、PUT、DELETE、上传、清理或绑定变更。D1 `/query` 的 POST 只承载代码中固定 SELECT。

执行前私有输入均要求目录 0700、普通文件 0600、非符号链接、非硬链接；读取检查打开前后 inode、权限、大小、mtime。必需文件为 `.env`、`.local/cf01/{resources.json,wrangler.json,evidence.json,wrangler-debug.log,deploy-the-shelf-cf01.log}`。不自动修复权限或缺失文件。配置须精确匹配固定 D1、桶、mock service 和 Workflow；未知绑定面阻断。历史 UUID 只从私有部署日志提取：只匹配 `Deployed the-shelf-cf01 triggers` 后紧邻的版本，排除 mock；须恰有两个已知版本，最后一个须匹配固定主 Worker deploy log。缺早版本时不能用当前代码替代；工具不接受调用者补入任意版本。

每次执行新建 `.local/cf01/storage-audit-<随机UUID>.json`，0700 目录 / 0600 文件；执行开始固定真实 root、全部祖先和私有父目录的设备号、inode、owner、权限及真实路径，写入、打开、rename、fsync 前后均重新核对，临时文件和父目录以 `O_NOFOLLOW` 打开。符号链接替换或换成另一个0700目录也会停止，且不向替换目录写入后续收据、不继续派发。每次请求先将目标、标签、请求上限、SQL hash 和 `dispatched` intent 原子持久化并 fsync 文件及父目录，再派发网络请求。崩溃中的 intent 保留为未知；没有自动恢复/重试。私有收据保留标识、历史代码 base64 及 hash、受限 storage 历史和匹配的私人 storage 完成响应；stdout 只有模式、计数、hash 和安全诊断。错误仅从代码固定 allowlist 重新构建，导出错误类的调用者内容也不能进入诊断。平台错误正文、凭证、secret binding 值、author email 均不复制到结果。

精确请求预算为 14 个，上限 16 个；每响应至多 2,000,000 bytes，每请求 fetch 加完整正文共用最长 30 秒硬截止，取消不能阻塞截止。不接受重定向。超限、缺页信号、无权限、404、不合法 envelope、停滞流、缺模块或身份漂移一律停止，不补零。

| 顺序  | 固定读取                                                                                                               | 请求数 |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | -----: |
| 1     | CF01 D1 identity；核对固定 UUID/name                                                                                   |      1 |
| 2–5   | 首轮受限 sqlite_master 两表/其 trigger；预算和 storage 运行计数；完整 storage budget LEFT JOIN run；storage orphan run |      4 |
| 6–8   | 主 Worker settings binding；workers.dev/preview 开关；beta Worker identity/更新时间                                    |      3 |
| 9–10  | 两个私有日志已知版本，各一次 beta version GET `?include=modules`                                                       |      2 |
| 11–14 | 同一组 D1 schema/计数/storage/orphan 独立回读，全部内容 hash 须等于首轮                                                |      4 |

预算 lifetime 总行最多12、storage预算最多4、storage运行最多4，完整 storage 查询 `ORDER BY run_id LIMIT 5`；计数和实际行数必须相符。schema `LIMIT 17`，17行命中即拒绝。未知状态、run/budget 冲突、非法结果、缺行、漂移或上限之外的数据阻断核查。不存在 run 的 budget 仍作为 tombstone 完整保留；orphan、failed、uncertain、reserved、running 不会被转成完成。两次相同快照只说明两次观察相同，不能证明中间无活动。

2026-10-22 通过官方 Cloudflare TypeScript SDK 的 [beta versions.ts](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts) 与 [beta workers.ts](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/workers.ts) 直接 HTTPS 核对：历史版本接口为 `GET /accounts/{account}/workers/workers/{workerId}/versions/{versionId}?include=modules`；模块为 `{name,content_type,content_base64}`。代码只保存经过校验的模块，不把模块名当作本机文件路径。该 API 可能返回数 MB；超过本工具2MB上限时保留失败状态，须另立有界计划，不能现场放宽。beta Worker detail 没有当前部署 version ID 字段，因此收据 `currentVersionId` 明确为 null，本机最新 deploy log 不冒充远端当前版本。

2026-10-22 实际 settings 返回固定 `CF_MOCK → the-shelf-cf01-mock` 的 `environment="production"`。官方 [multipart metadata 文档](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/#bindings) 的 service 示例明确使用 production；[官方 SDK settings 类型](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/script-and-version-settings.ts) 将 environment 定义为可选。工具只接受字段缺失或精确 production，两者在安全收据中归一化为 production；development、空串、null及任意其他环境继续拒绝。此兼容同时适用于实际 settings 与历史版本，不扩大目标或授予关闭证明。

现有 CF01 budget/run 和原私人执行收据都没有执行版本标识。工具提供两个历史版本和 storage 完成收据候选供主 Agent 私下人工核对，不能从较新版本、版本时间或 regex 命中推断旧版本已先持久 reserve、后 await PUT、再保存成功终态。`executionVersionMappingProven`、`cloudWriteFreezeProven`、`drainProven`、`uploadAllowed` 永远为 false；成功状态仅为 `inventory-observed-closure-unproven`。缺历史版本/缺页/失败的核查状态为 `failed-closed`。

只读库存不能阻止禁用前已经接入但尚未 reserve 的请求，也不能撤销旧 isolate、删除现有绑定或为 R2 PUT 建立强制 deadline。storage-only admission guard、固定旧 capability 移除、真实历史版本人工对应和可信终态排空证明属于下一独立 review 动作；本工具没有 ready/closure 或云写路径。

本地专项：`node --test tests/cf01-storage-audit.test.mjs`，使用合成私有配置、SQLite 和 transport，不读取真实收藏或真实云端。
