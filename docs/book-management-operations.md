# 网页书籍管理：部署与验证

本轮实现正常预算门槛下的逐文件网页上传、私有目录和回收站。当前生产仍是已消耗许可的首本隔离试运行；普通上传保持关闭。`NORMAL_UPLOAD_MODE=authority-v1` 仅为未来正常上传环境的显式配置，不得对当前隔离桶启用，不得重置首本许可或把 imported 改成 ready。

普通上传必须同时满足：原唯一 authority 的受保护 ready 状态、该 authority 已接纳的完整账号证据（当前 UTC 月、五分钟内）、账本与所有普通/首本预留及确认责任精确一致、总量不超过 8,000,000,000 字节；生产 BOOKS 必须精确对应原 authority 的账号和 `the-shelf-books`，并显式正常模式、没有试运行模式。单文件最多 20,000,000 字节。网页不能写证据、启用 ready、清理账本或改变目标。当前首本 SQL 还会阻止 authority 离开 imported；未来正常上传启用需要另行审查迁移设计，本轮不解除该保护。

上传使用新私有目录条目和原 `shelf_storage_reservations`，没有第二个余额。新意图只有首次响应的 `canSubmit:true` 可提交字节；重复文件 hash 返回既有意图和 `canSubmit:false`。字节有时间、大小及分块上限，并核对 hash、格式头和基本 DRM 标记；完整可读性由阅读器进一步校验。持久领取唯一 PUT 资格后至多一次 PUT，然后独立 HEAD、全文 GET/hash、HEAD。任一写入或核验结果未知时保留责任，停止自动重传。管理页的 uploading/uncertain 需要审查后的只读恢复方案，当前没有自动重传或永久删除入口。

## 固定 007 增量迁移

基础 `schema.sql` 与历史 storage migration/CPU sampler 的 schema hash、请求预算保持原样。新管理 Worker 和升级后的 snapshot 查询都要求007存在；缺失时固定失败，不能跳过私有目录/回收站过滤。`cf:init` 继续只准备原有鉴权材料，不隐式迁移。固定007工具只覆盖当前 production；历史 check/sampler 库本轮不迁移，也不得部署新管理 Worker。未来 check 迁移及 sampler 合约需要单独 review；升级后的 check snapshot 在缺少007时拒绝，不能解释为数据已导出。production 必须独立回读007 complete 后才部署新 Worker。

主 Agent review、针对性/完整测试、构建和隐私检查通过后，先运行只读状态，再执行增量安装。工具只读取 `.env` 固定账号和 `.local/cf03/deploy.json` 的原 production `the-shelf-library`，不接受任意账号、数据库、SQL 或文件路径 CLI 参数。

```sh
node scripts/book-management-schema.mjs status
node scripts/book-management-schema.mjs status --execute --run UNIQUE_STATUS_ID
node scripts/book-management-schema.mjs apply --execute --run UNIQUE_APPLY_ID
node scripts/book-management-schema.mjs status --execute --run UNIQUE_READBACK_ID
```

无 `--execute` 时不读取凭证、不发网络请求、不写 journal。源码迁移固定 hash 为 `808ebf6bb222e98e69ec74dac9ec036a5347930c53ce6e2f194eefddc278a39f`。`apply` 最多 23 HTTP、7 DDL（全新安装通常21 HTTP）；`status` 最多9 HTTP、0 DDL（通常7 HTTP）。每个请求先持久记录意图，收据目录0700、文件0600；日志只保留语句 hash、状态和事实 hash，不记录密钥或原书正文。工具核验数据库 identity、007 的全部七个精确 schema 定义，并比较前后原 schema、authority、首本结果、全部原始/正文 registry 与 reservation、production auth_config 的指纹。活跃 admissions/counters/sessions 的数据行不作为静态不变量。

第一次 DDL 前持久写入全局不可覆盖 `apply-claim.json`。结果未知后不得另取 run ID 重发；即使第一条 DDL 未落库，也必须停止。`status` 仅报告 absent/partial/complete；部分安装需要另行 review 的缺失语句恢复设计。已有完整精确 schema 只做验证；未知定义、来源 hash 变化、事实漂移或新表非空都拒绝。工具不会关闭/重建鉴权，不会 issue/upload 首本，也不会修改旧 imported、unknown、guard、余额和对象。

## 发布验收与回退

迁移独立回读 complete 后才发布带管理 API 的 Worker。当前生产配置保留试运行绑定和原鉴权 generation，普通上传配置不添加。当前 production 只有已确认首本 PDF，线上不做任何真实书籍 trash/restore；真正的逻辑删除/恢复由本地 SQLite、安全并发测试及实际浏览器合成 fixture 验收。部署后的管理 HTTP 验收固定最多9请求：匿名管理拒绝、匿名 catalog-state、所有者登录、所有者管理列表/上传关闭原因与首本确认、仅合成 JSON 的上传意图拒绝、针对不存在合成书 ID 的错误 CSRF 和错误 Origin 拒绝、登出、撤销会话管理拒绝。不得请求真实书的变更路径，不发送上传字节，不再次 PUT、不删除首本原件；日志只保留请求标签、状态和结论，密钥、会话及书籍信息不落日志。登录结果未知或登出/撤销未确认时停止、不重试，并明确要求受控 generation 撤销后再开始新一轮。私有新目录不进入公开 snapshot，公开 catalog-state 只列 public 状态的回收站 ID。

回滚时保留007和全部条目、预留、对象及收据。一旦存在回收站状态，直接回到旧版无生命周期检查的试运行 Worker 会绕过逻辑删除；只能回到仍保留生命周期访问校验的安全版本，或显式切回静态 API 关闭模式并撤销会话。不能仅关闭 auth 而遗留试运行 operator 入口。旧普通模式已签发的外部短期链接仍有原有的五分钟有效期；当前首本及本轮新上传都使用同源代理，在 R2 await 后再次检查会话与生命周期版本。静态 HTML 已公开的目录信息不能靠回收站撤回缓存，动态书架隐藏与私人文件访问阻断分别验收。
