# 固定 CF01 版本收回 operator

`cf01-version-close.mjs` 只处理固定 `the-shelf-cf01` 的候选版本创建、独立校验和分步部署。官方契约与完整请求矩阵见 [设计说明](../docs/cf01-version-capability-plan.md)。本地实现/合成测试不代表实际云端绑定已收回。

```sh
node scripts/cf01-version-close.mjs create
node scripts/cf01-version-close.mjs deploy
node scripts/cf01-version-close.mjs status
```

默认全部为 preview：文件、时钟、凭证、网络均零 IO。只有追加 `--execute` 才进行固定动作。工具无账号、Worker、版本、SQL、URL、预算覆盖参数；不调用 latest、versions list、Workflow API 或 R2 对象接口。

执行前由主 Agent 完成代码 review、本地验证、提交/push/CI，并核对单 operator 窗口。项目 CI 自动 CF 部署须保持关闭；不并行运行 Wrangler、Dashboard 或其他项目内 CF01 写动作。本机共享 `.local/cf01/storage-close.lock` 只能阻止采用该锁的 operator，Cloudflare 无 CAS 契约，工具无法阻止外部有权用户在预读与 dispatch 之间修改部署。

固定私有输入为 `.env`、`.local/cf01/{resources.json,wrangler.json,storage-close-state.json}` 和旧 unknown PATCH 对应收据。本机 Wrangler 必须已经无 R2 项、workers_dev=false、preview_urls=false；工具不自动修改配置。输入目录0700、文件0600、同 owner、无 symlink/hardlink；每请求前 pin 文件与全部父目录并检查置换。旧 close 状态、收据、六 guard 与 identity hash 不修改。

`create --execute` 最多18请求，其中仅1次 `POST /workers/workers/the-shelf-cf01/versions?deploy=false`。源是两轮相同的当前唯一100%部署完整UUID，四个非R2绑定均从它inherit，代码/全部模块/入口精确复制，支持范围内metadata和可写annotations精确保留。未知字段、assets/containers/exports/migrations/migration_tag/exports_reconciliation、非空包依赖、开启cache或扩展placement均在写前拒绝。候选具体UUID独立回读完全匹配后只记candidate_verified，不自动部署。

`deploy --execute` 最多20请求，其中仅1次 `POST /workers/scripts/the-shelf-cf01/deployments?force=false`，只设已持久候选100%。必须同时有已verified新state和完整成功create receipt；state先落盘而receipt未完成不能解锁。再次回读源与候选、metadata/入口/guard/counts及当前源部署，再部署并回读具体deployment ID、当前部署、候选代码、settings、subdomain及六guard/counts。通过只记独立capability_observed，不授予排空/ready。

`status --execute` 最多14只读请求，含D1固定SELECT的HTTP POST；通常13请求，候选不同于当前时增加1次具体候选GET。两轮固定当前部署与具体版本、settings、入口、guard/counts须一致。legacy settings没有明确的“当前部署”版本绑定语义，因此当前流量始终以deployment首项UUID→具体版本GET验证；settings本身不能证明流量版本。

所有HTTP先将intent落盘fsync；fetch+body共30秒、响应/请求各2MB上限，不重定向、不重试、不自动分页。私有新状态为 `.local/cf01/version-close-state.json`，每次新收据为 `.local/cf01/version-close-<UUID>.json`。只保存允许的hash/已知枚举/数字和固定资源身份，不保存模块/base64、secret值、annotation文本、作者或provider原始错误。输出错误重新按allowlist构造，外部异常文本不透传。

任一mutation发生超时、断线、非预期状态、矛盾envelope、落盘失败，或200之后的独立校验失败，均保留dispatched/unknown并停止后续云写。create unknown永不重试，也不允许deploy；候选UUID已持久化只允许固定GET观察，丢失UUID则不list猜认、不创建替代版本。deploy unknown亦不重试；后续独立status可以证明当前已无R2且符合旧expected五hash，但unknown记录始终保留，不改判原请求成功/失败/终止。

原PATCH unknown始终保留。新目标在create之前就必须匹配其五项expected hash：bindings、非binding metadata、可写annotations、代码/入口、subdomain；不改旧hash算法、不重新登记期望。所有回读成功仍只证明观测时当前版本的绑定能力，不能证明旧版本/在途请求/路由/本机进程连接排空。`cloudWriteFreezeProven`、`drainProven`、`uploadAllowed` 始终false，authority保持imported。

失败不删除候选/收据/unknown、不清预算、不重启旧入口、不恢复R2绑定、不部署回旧R2版本。可回退工具代码；当前安全冻结事实保留。真实create/deploy须由主Agent在既有授权及对应固定有界run计划内串行执行；本工具不自动运行真实验收。
