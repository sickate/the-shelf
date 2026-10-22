# 单文件远端同步操作器

`selected-sync.mjs` 提供 `plan`（默认）、`sync`、`reconcile`。每次必须明确指定一个 profile、一个 file 和一种对象；没有批量、强制、重试、凭证、目标、时钟或 evidence 文件参数。

```sh
node scripts/selected-sync.mjs plan --profile check --file file_1234567890abcdef --kind original
node scripts/selected-sync.mjs plan --profile production --file file_1234567890abcdef --kind prepared-text --version <64位版本SHA256> --sha256 <包原始字节SHA256>
```

示例 ID 为合成占位符。`plan` 仅读本地，校验真实 `.env` 与环境提供给 `getConfig` 的 manifest/stateDir；这两处必须位于本项目 `.local` 内，每层目录 `0700`、拒绝符号链接，manifest `0600`。不输出本地路径、原文或凭证，不改 manifest、pins、原书或旧账本。原书只接受私有 candidate PDF/EPUB，复用 `selectedFile` 的 20 MB、mtimeNs、no-follow 与完整 SHA-256 检查。文本只使用当前独立 pins，核对来源属性和真实源书 SHA-256，经私有 helper 读取明确版本，验证严格包契约与原始包字节 SHA-256。上传字节直接来自包文件，不重新序列化。

当前 **公开 `sync` 保持关闭**：现有 `cf-r2-account-audit.mjs` 不能产生合格的存储用量 receipt，`sync` 在任何远端或 R2 请求前返回 `qualifying_storage_receipt_unavailable`。手写 JSON、环境变量、历史 receipt 或任意 evidence 路径均不能打开此入口。plan 的 `uploadAllowed:false` 不代表完成迁移、生产上传或云端阅读验收。

模块接口 `runSelectedSync` 的 `trustedOperator` 是仅供受控 JavaScript 调用方注入测试传输和已验证 receipt 的 provider，没有 CLI/环境模块路径加载器。离线测试把这个接口连接到真实 `RemoteStorageAuthority`、内存 SQLite、真实 R2 签名传输实现及合成 HTTP response；这证明协议链路，不证明已获得生产上传证据。未来接入真实 evidence 必须审阅并实现固定可信来源的代码，不能给 CLI 增加任意 JSON 绕过。

远端身份复用 `loadMigrationContext`，固定 `.env` 项目账号、`the-shelf-books`、check/production D1 与 production 唯一 authority。任何可执行操作先只读核验 `ready`，再通过共享 `validateMigrationReceipt` 校验远端持久迁移证明；工具自己的 preview/receipt 不能代替这项证明。通过后才创建只允许当前 descriptor 的 R2 客户端，完整复用 `syncObject` 的预留、CAS claim、一次条件 PUT 和 HEAD/条件 GET 全字节哈希/HEAD 验证。相同 identity 和完整 descriptor 推导同一 reservation ID，换 profile、版本或内容不能复用原 reservation。

请求意图在实际配置的 stateDir 下 `selected-sync/<reservation>/<随机run>/` 保存，每层 `0700`、文件 `0600`，创建目录和写文件均 fsync。每个 D1/R2 请求在发送前写入不可覆盖的 intent，再记响应头结果；网络异常或进程中断保留 unknown 证据。journal 是请求证据，远端 D1 仍是唯一预算和 reservation authority。本地文件不含原文、凭证、原书路径或 SQL；selection 仅保留固定身份和 descriptor。每次调用总请求上限 128；没有自动重试。

```sh
node scripts/selected-sync.mjs reconcile --profile production --file file_1234567890abcdef --kind original
```

`reconcile` 不需要新的上传用量证据，但仍核对上述固定身份和真实 ready receipt，且必须能从相同本地选中来源重新得到 descriptor。文本仍须提供明确 version 和包 SHA-256。它只查询那个确定 reservation，然后执行 `authority.reconcile`；不 reserve、不 claim、不 PUT。对象 404 保留 uncertain 和预算，不解释为上传可重试、也不释放用量。不存在的 reservation 直接拒绝。原书或当前 pins 已改变、包已删除时本轮工具拒绝，保留私人 journal 和远端状态，由后续经审阅的恢复流程处理。

验证：`node --test tests/selected-sync.test.mjs`；文件名已由现有 `npm test` glob 自动包含。测试覆盖真实迁移生成的合成 ready receipt、原书与文本完整链路、PUT/claim 丢响应、无 evidence reconcile、404 uncertainty、伪 proof/unready 拒绝、包与pin漂移、私有路径和符号链接、证据新鲜度及 8 GB 门槛。没有执行云端请求、真实上传或部署。

部署和回退沿用项目门槛：主 Agent 审阅并完成适用测试/构建/隐私检查后才提交、推送与既有 CI。此工具默认关闭上传，不改变当前站点、业务 API、旧写入口或任何真实对象；回退只回退代码，保留所有远端 reservation、计费计数与私人 journal。
