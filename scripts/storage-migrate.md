# 固定远端存储迁移操作器

`storage-migrate.mjs` 只为 The Shelf 固定的两个 CF03 D1 执行有限迁移。生产 D1 是唯一目标账本；check D1 仅作为旧账本来源并永久冻结。账号必须与项目 `.env` 的 `SHELF_R2_ACCOUNT_ID` 一致，桶固定为 `the-shelf-books`，D1 标识与名称从私有 `.local/cf03/deploy.json` 读取并通过 Cloudflare 身份接口复核。CLI 不接受任意账号、数据库、URL、SQL、文件路径或凭证。

本操作器实现 `schema-freeze`、`import` 和 `status`。`ready --execute` 始终以 `migration_write_closure_unproven` 阻断，且不会读取项目配置或发起网络请求。成功导入只证明数据库冻结及导入读回，不能证明进程、连接、开发 probe 或旧 R2 写入凭证已经关闭。本阶段没有 R2 PUT、上传预留、登录启用、Worker API 启用、套餐或计费修改。

## 命令与固定上限

```sh
node scripts/storage-migrate.mjs schema-freeze
node scripts/storage-migrate.mjs schema-freeze --execute --run-id schema-001
node scripts/storage-migrate.mjs import --execute --run-id import-001
node scripts/storage-migrate.mjs status --execute --run-id status-001
node scripts/storage-migrate.mjs ready --execute --run-id ready-001
```

省略 `--execute` 时，只输出动作、固定上限及阻断状态，不显式访问文件、秘密、网络或子进程。每次执行必须使用新的 run ID；已有运行目录不能覆盖。没有不加参数的自动迁移或上传入口。

| 动作            | HTTP 请求最多 | DDL 语句最多 | 固定 DDL 文件组最多 |
| --------------- | ------------: | -----------: | ------------------: |
| `schema-freeze` |           144 |          102 |                   5 |
| `import`        |            80 |            0 |                   0 |
| `status`        |            32 |            0 |                   0 |
| `ready`         |             0 |            0 |                   0 |

请求按单条固定 SQL 的 D1 REST 调用记账，不通过 Wrangler 隐式展开。DDL 定义仅由仓库固定的 `schema.sql`、`002-conservative-storage.sql`、`003-storage-authority.sql`、`004-freeze-legacy-storage.sql` 在本机内存 SQLite 中解析取得；执行时保留原始 SQL，按原始依赖顺序创建。任何未知或修改过的既有定义均阻断，不猜测修复。每条请求在发出前私有落盘，DDL 上限在发出前扣除。单次请求 SQL 最多100 KB、参数最多100项，响应最多1 MB；请求和完整响应体共同受最多30秒期限约束。无自动重试、重定向或备用目标。

离线空源场景实测 `schema-freeze` 为139次HTTP请求、100条DDL，`import` 为67次HTTP请求、0条DDL。这些是 mock 的验证结果，不代表已执行真实云端迁移。实际请求数取决于冻结进度及 preflight 的固定分支，且不得突破上述上限。

## 冻结与导入顺序

1. `schema-freeze` 每次先重新运行 `storage-preflight.mjs`，将其每条请求纳入当前运行预算和意图记录。要求本机旧清单/账本为空、旧 D1 预留与 registry 为空、auth 关闭，以及 check Worker 的 workers.dev 和预览入口关闭或 Worker 不存在。
2. 首次生产 D1 必须由这次 preflight 证明没有应用 schema。原始空源证明在首次 DDL 前写入迁移状态；后续局部恢复必须保留该证明。已经存在应用 schema 且没有原始证明时阻断。
3. 先补生产基础 schema，以固定 SELECT 核对两个基础种子，仅在缺失时补齐，再补生产 authority schema，接着在两个 D1 安装完全匹配的冻结定义。只在独立读回冻结定义后插入不可变冻结标记。两个标记生效后，才把生产的已知基础 `reserve_upload` trigger 升级为002定义。
4. 独立读回完整 schema、关闭的 auth、D1身份；在两个D1各提交一次固定旧预留负向测试，必须以 HTTP 400 和明确的 `legacy_storage_frozen` 事务拒绝返回；5xx 即使携带该文本也仍属未知结果。测试意外成功或返回结果未知均阻断。
5. `import` 先按当次有效配置重新检查 `getConfig` 实际 manifest、JSON 账本及 upload.lock；任何本机登记、旧预留或 lock 均在云请求之前阻断。再次独立验证上述身份、schema、冻结标记及 auth，并在首个可能写请求前重查本机来源，才调用 `RemoteStorageAuthority.initialize/readFrozenSnapshots/migrateFrozen`。私有收据记录当次本机观测，不沿用 schema-freeze 的旧结果。当前仅支持已实测的空旧源；任何旧预留或registry非空都以 `migration_inventory_changed_requires_budget_review` 阻断。此范围不支持非空源批量迁移。
6. 首次冻结快照及时间戳保留在私有快照文件，恢复时保持同一迁移哈希。适配器独立读回导入的全部 canonical staging、计数、registry、冻结源及导入收据。成功后 phase 必须仍为 `imported`，`cloudWriteFreezeProven=false`，`uploadAllowed=false`。

## 私有证据与未知结果恢复

所有执行动作（包括只读 `status`）共享单机 operator lock，不并发发出请求。短暂的 `operator-acquire.lock` 目录串行化每次获取锁与死 PID 接管，防止两个恢复者各自删除对方的新锁。活进程持锁时拒绝执行；仅在确认原 PID 已不存在后归档旧锁并接管，不终止任何进程。获取锁阶段若崩溃留下该目录，后续动作始终阻断，不能仅凭目录年龄或 PID 猜测删除；必须由主 Agent 审核本机进程证据后单独处理。

证据存储于 `.local/cf03/storage-migration/<run-id>/`。目录要求0700、文件0600并属于当前用户，拒绝符号链接、多硬链接文件和发生替换的文件。请求 `N-intent.json` 在发送前以独占方式创建并fsync；`N-outcome.json` 独占保存观测、已证明拒绝或未知结果。全局 `state.json` 保存未决写入和原始空源证明；`manifest.json` 与 `snapshots.json` 只创建一次。证据不包含凭证、原始SQL、响应正文或原始provider错误；本机快照是私有迁移材料，不进入站点公开文档清单。

任何写入的超时、断连、异常响应或日志落盘失败均不当成失败回滚，也不会在本次运行重发。所有预算占用和未知记录保留。下一次写操作必须先有**单独成功的** `status` 检查点：

```sh
node scripts/storage-migrate.mjs status --execute --run-id after-unknown-001
node scripts/storage-migrate.mjs schema-freeze --execute --run-id schema-resume-001
# 若未知发生在导入，则显式重新执行 import，并使用新的 run ID。
```

`status` 仅向固定D1发出身份GET和SELECT。若有未知写入，距离最新预登记不足31秒则报告 `migration_unknown_write_quiescence_pending`；到期后对两个D1各作两次独立schema观测，只有一致才生成恢复检查点。它不把未知请求标成失败，不宣称对象缺席，不释放任何预算，也不授予ready权限。随后显式执行的冻结动作按实际存在的精确定义补缺；导入动作依赖不可变staging、原快照与全量读回的幂等检查。schema漂移、身份变化、新的未知结果或快照变化均重新阻断。不要删除状态、收据、未知记录或冻结标记来绕过恢复要求。

`status` 仍会在本机写私有观测收据，其“只读”指云端没有写操作。它没有完整的旧R2能力关闭证明，不能用作生产上传许可。

失败请求的 outcome 现在保留实际 HTTP 状态、最多8个受限数字 provider code、顶层及单查询 success 三态、result 形状，以及固定 `legacy_storage_frozen` token/精确错误格式是否出现的布尔值；不保存 provider message、响应正文或秘密。HTTP 200、400、409 与 5xx 必须分开记录，token 布尔值仅帮助诊断，不证明 SQL 已原子拒绝。旧收据中未记录的状态/错误不得事后补推断。

若未决写入属于已知负向预留探针，`status` 仅根据既有 run ID、profile 和完全匹配的固定 SQL hash，对最多8条探针逐条读取精确 reservation ID 的 COUNT，并独立读取两个固定 D1 的 reservation/registry 总 COUNT。这些读请求计入原32次HTTP上限。即使全部为零，收据仍明确 `atomicRejectionProven=false`，旧 unknown 不改成 rejected；若发现任何行则撤销旧恢复检查点并要求预算/库存审查，绝不自动删除。schema 匹配或当前不存在探针行均不能代替当次 SQL 原子拒绝证据；本阶段不改变负向拒绝的接受规则，也不自动重发探针 INSERT。

## 尚未实现的收口及回退

后续真实关闭能力验收必须单独实现：固定本项目本机旧写入口及其活动连接关闭、持久任务停止和排空、旧CF01 probe 的写绑定/凭证/路由关闭与独立读回、在明确上界内排空已开始的PUT，并提供结构化且可复核的关闭证明。拟议 `close-probe` 必须是固定资源、有限请求、私有预登记和失败保守的独立动作；当前CLI不接受该动作，不能拿冻结标记、环境变量或调用者布尔值代替证明。只有真正实现并验收关闭证明之后，才能评审解除 `ready` 阻断。

冻结SQL是永久保护，迁移失败时保留当前关闭状态和所有私有证据，不自动删除schema、解冻旧账本、覆盖旧文件或启用业务。修复代码后先离线验证，再用 `status` 独立观测并显式补齐迁移。站点和业务后端部署不属于此操作器；没有真实云端运行和独立验收时不得宣称迁移、上传或云端阅读已经上线。

离线验证：

```sh
node --test tests/storage-migrate.test.mjs tests/storage-preflight.test.mjs tests/remote-storage-authority.test.mjs
```

## 下一阶段 `close-probe` 具体提案（未实现、不得当作关闭证明）

本阶段动作只可收回固定项目 CF01 的 R2 写能力，不能重放历史 sampler、storage smoke 或 cleanup，不能删除 probe 收据、D1 历史或工作流，也不能操作 mock Worker 或其他项目。主 Agent 完成实现 review、全套 CI 后才执行云端动作。`ready` 继续保持零 IO 阻断，直到另行验收真实关闭证明。

1. 固定读取 `.local/cf01/resources.json` 和 `.local/cf01/wrangler.json`，使用与迁移操作器相同的文件权限、符号链接和替换检查。账号须与项目 `.env` 完全一致；Worker 只允许固定 `the-shelf-cf01`，配置的 D1 ID/name 须与 CF01 resources 完全匹配，R2 只允许 `CF_BUCKET → the-shelf-books`，Workflow 与服务绑定只可保留固定既有配置。未知、重复或扩展的绑定阻断，不能泛化成任意 Worker 参数或枚举账号资源。
2. 每次云请求先私有 fsync 意图、扣固定预算，不自动重试写。独立 GET 固定 Worker settings、subdomain、绑定/版本以及该 Worker 自身的 routes，核对资源一致；仅使用经官方契约验证的受限设置接口移除 CF_BUCKET，保留其他绑定、Workflow 和代码。接口不能精确保留其他设置时停止，不把未经审核的整体 Worker 重部署作为备用路径。本机私有 Wrangler 配置中的 R2 项也须同步关闭，防止后续误恢复；旧代码 `reserve(storage)` 和 `storageProbe` 均永久拒绝。不能只修改本机配置就宣称线上 capability 已撤销。
3. 写响应未知时保留 unknown，并要求单独只读 status。成功或恢复后，都要新请求独立回读 settings、版本、bindings、workers.dev/preview 及该 Worker routes，确认目标仍固定且没有 R2 binding 或备用存储入口；记录结构化观测 hash 与时间，不输出秘密。受影响的业务 endpoints 应只做不触发任务的只读/拒绝检查，不能新建 storage run 验证关闭。
4. 本机关闭证据必须来自 `getConfig` 实际解析的 manifest/stateDir（含配置来源 hash），确认实际 manifest/storageKey、JSON 旧账本及 upload.lock 已检查且为空/不存在。同步记录所有旧执行入口代码 hash；不能把默认路径为空推广到自定义路径。记录由固定命令采集的本项目实际进程、PID 启动身份及连接停写证据，并在排空后独立复查。PID、不存在的 lock 或一个布尔值均不足以证明旧进程/连接已关闭。
5. R2 binding 移除只证明新 Worker 实例没有 capability，不证明历史 isolate 或已开始 PUT 已结束。必须另有可信来源明确界定“最后可能开始写的时刻”、旧在飞行请求的最大寿命、provider 已接收 PUT 的最大完成延迟及撤销传播界限，并在其总上界后 fresh 回读。历史客户端的 120 秒 AbortSignal 不是服务端 R2 PUT 截止；现有 CF01 直接 `await CF_BUCKET.put` 没有可据以证明的应用截止。因此当前 drain 上界应保持 unknown，不能使用任意等待秒数、历史 sampler 结果或无新增对象观察代替上界。没有可信上界时，关闭能力动作仍有价值，但 authority 必须继续 `imported`、禁止上传。
6. 关闭证明应持久绑定 identity/migrationHash、两份冻结 schema/marker hash、实际本机路径与入口 hash、进程/连接观测、CF01 配置及远端 bindings/routes/版本观测、可信 drain 来源和上界、排空后的 fresh 观测。主 Agent review 确认每个来源可信后，独立 verifier 才能交给 `activateFrozen`；调用者传入 `closed=true`、旧收据或可自由填写的时间戳不构成证明。失败时保留所有旧冻结和证据，不恢复 R2 绑定，不开启 auth，不修改其他资源。
