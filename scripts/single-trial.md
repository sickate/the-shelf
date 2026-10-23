# 首本单次隔离试运行 operator

只服务于 2026-10-23 已批准的一次例外。不会生成合格账号用量证据，不将 imported 改为 ready，不消除任何旧 unknown，不允许批量或第二次上传。先完成代码 review、专项/完整验证、提交和 CI，再按主计划有界执行云操作；本工具本身不创建桶、不生成或扩大 Cloudflare 凭证、不部署 Worker、不启用登录。

## 固定私有输入

所有目录均属当前用户、权限 `0700`；文件 `0600`，拒绝符号链接、不安全所有者/路径及文件读取中变化。

- `.local/single-trial/selection.json`：精确 `{ "schemaVersion": 1, "fileId": "<固定私人文件ID>" }`。主 Agent 私下选择唯一文件后写入；不在命令行传文件名/ID。`plan`/`issue` 使用现有 selected-sync 的安全读取链，核验 manifest 原始路径、candidate/private、固定大小/mtime 和实际 bytes，再计算规范 descriptor。只支持 production 原书 PDF/EPUB、非空且不超过 20,000,000 bytes。
- 既有 `.env`、`.local/cf03/deploy.json`：沿用 `loadMigrationContext` 的固定账号、唯一 production D1 identity。旧桶配置仍是 `the-shelf-books`，不能将 authority identity 偷换为新桶。Cloudflare API token 可由既有受控本机授权环境临时注入，不持久化/打印；不读取其他账号凭证。
- `.local/cf03/production/single-trial-upload-secret`：canonical 43 字符 base64url 专用随机秘密，与 Worker 的 `SINGLE_TRIAL_UPLOAD_SECRET` 一致。
- `.local/cf03/production/single-trial-target.json`：精确字段如下。`uploadSecretSha256` 为 secret 文本的 SHA256。规范 target hash 是递归按键排序的 JSON UTF8 SHA256，与 Worker `SINGLE_TRIAL_TARGET_SHA256` 及 D1 permit 一致。

```json
{
  "schemaVersion": 1,
  "mode": "first-book-20261023",
  "accountId": "<既有固定账号>",
  "bucket": "the-shelf-first-book-20261023",
  "worker": "the-shelf",
  "origin": "https://the-shelf.iamzhutuo.workers.dev",
  "uploadSecretSha256": "<秘密摘要>"
}
```

该 fingerprint 只固定配置，不能证明云隔离。主 Agent 必须独立证明旧 CF01/旧桶凭证不能访问新桶、BOOKS 绑定正确且无公开访问，并保留实际部署回读证据；不能通过手写布尔值自证。原书不发给 AI。

## 动作与硬上限

```sh
node scripts/single-trial.mjs plan
node scripts/single-trial.mjs schema --run <新runID>
node scripts/single-trial.mjs catalog --run <新runID>
node scripts/single-trial.mjs status --run <新runID>
node scripts/single-trial.mjs issue --run <新runID>
node scripts/single-trial.mjs upload --run <新runID>
node scripts/single-trial.mjs reconcile --run <新runID>
```

默认 `plan` 零云 IO、不写收据，仅安全读取唯一选定本地文件，stdout 只有格式/字节数/状态和未知说明，无私人 ID、hash、key、路径或秘密。没有 selection 时固定失败，不扫描选书。每个非 plan 动作必须新 runID，不能覆盖旧 run。

| 动作      | operator HTTP 硬上限 |                   D1 mutation 上限 | R2 内容写入         |
| --------- | -------------------: | ---------------------------------: | ------------------- |
| schema    |                   20 |                           9 条 DDL | 0                   |
| catalog   |                   10 |        3 次 lease/staging/complete | 0                   |
| status    |                    6 |                                  0 | 0                   |
| issue     |                   12 |                           1 INSERT | 0                   |
| upload    |                    1 |                       本机不 claim | Worker 内最多 1 PUT |
| reconcile |                   16 | 最多 2 次 confirm/uncertain UPDATE | 0                   |

上述 HTTP 计数包含本机发出的 D1 管理 API 和固定 Worker HTTP。成功 upload 的 Worker 内部为 1 次固定 singleton SELECT、1 次 CAS RETURNING、恰好 1 次 R2 PUT；没有 HEAD/GET。每个 object HEAD/GET 内部各有 1 次固定 singleton SELECT 和对应 1 次 R2 HEAD/条件 GET。干净 reconcile 为本机 7 次 D1 HTTP + 3 次 Worker HTTP（内部另有 3 次 D1、2 次 HEAD、1 次 GET）；不得将这些内部消耗视为零。每次 D1 最长 30s，Worker HTTP 最长 60s；每个 run 在新请求前检查 5 分钟总 deadline。没有自动重试、redirect、任意目标/SQL/路径/时钟/credential provider CLI 参数。

`schema` 只访问原 production D1，先 GET 精确 uuid/name，再独立读取 SQL005 对象与 admission_private，既有 trigger 必须逐字等于审查过的旧版或新版；缺失/漂移拒绝。需要写入时，要求 auth 只有 production enabled=0 行，固定 `/api/health` 为 404，随后先持久化唯一 schema-attempt。SQL005 先建表再逐条建六 trigger；SQL006 单独 DROP/CREATE（不假设事务），最后独立精确回读两组定义。干净首次为 17 HTTP/9 DDL；完整已安装只读为 4 HTTP。部分 schema 或替换未知停止，不自动修复/重发。API 上线必须等待完整独立回读。目录文件 selected candidate 是否存在只返回布尔；缺失不伪造。

`catalog` 仅在 production API 目录为空时执行。通过安全本地选择得到固定 descriptor，查找已跟踪 `data/catalog.json` 中唯一同 bookId 的真实公开条目，并核验选中 fileId/format/size 为 private candidate；保留该书真实公开字段，不生成候选事实。随后使用 `publicCatalog`/`bootstrapInput` 校验和显式空 overrides，复用既有 `bootstrap()` 的 lease→staging→complete。远端先核验固定 uuid/name，再以一次组合查询要求 auth disabled、catalog_books=0、metadata_overrides=0、无 active import；在第一个 lease 前持久化唯一 `catalog-attempt.json`。成功固定 7 HTTP、3 次 mutation，cap10，无 resume/reset 参数；最终独立回读 complete、input/base hash、public_state base_revision、单行目录及完整 public_json。任何已有目录、override、active lease、源条目不符或未知都停止。此单书 API base 不修改完整静态目录。

`issue` 要求远端 singleton 尚不存在、真实 catalog 中当前选中文件的 book/file/format/size 精确匹配 candidate，随后先以独占写入 fsync 固定 `permit.json`，再调用原 authority 的一次 INSERT。许可期限固定签发后 24h，绑定原 authority identity、新 target/hash、完整 descriptor。已有本地 permit 或远端 permit 都阻止重发，不用新文件/key规避。

`upload` 只加载原 `permit.json`，再次安全读取同一本地文件并精确比较 descriptor、目标 fingerprint 和期限。先 fsync 固定 `upload-attempt.json`，再 fsync 当次请求 intent，最后只发一个固定 `/api/single-trial/upload` POST；无 cookie，只带专用 secret、permit、同源 Origin、精确 Content-Length。**本地不调用 claim**。Worker 在校验全部 bytes 后，以唯一成功 RETURNING CAS 在紧邻 PUT 前领取；只有该分支可以调用 BOOKS.put 一次。响应成功只报告 `uploaded-unverified`，绝不当作登记成功。

`reconcile` 不重读本地原书、不 PUT：仅使用 permit 对同一个固定 `/api/single-trial/object` 做 HEAD→If-Match GET→HEAD；校验长度、类型、SHA256、ETag、完整流和前后元数据，随后由原 authority 持久确认。404、内容漂移、预算/超时/丢失响应均保留全部责任；缺失不释放 reserved，也不变成重传授权。已确认只读返回，不再次读对象。secret endpoint 不提供枚举或任意 key。

trial 阅读 smoke 成功为 14 次固定 HTTP，硬上限 15（失败时最多另一次已记账的有效 logout）；原非 trial 流程仍为成功 10 / 上限 11。顺序为匿名 access401、匿名 content401、login、无效 CSRF logout403（必须 `csrf_invalid`）、authenticated session（证明拒绝后会话仍有效）、catalog、access、错误 Origin content403（必须 `origin_forbidden`）、有效同源完整内容、Range206、有效 logout、logged-out session、旧 cookie access401、旧 cookie content401。错误来源和 CSRF 不接受仅状态码相同但错误语义不同的响应。全部先写固定 label intent，再派发；有效内容核对 SHA256/大小/MIME/ETag 与 Range，正文/授权头/错误源 URL 不写收据。

## 崩溃、未知与回退

所有云请求必须先有不可覆盖、fsync 的 `NNN-intent.json`，再派发；结果只包含结构化状态，headers-received 不能当作完整成功。完整 descriptor 只保存在私人 permit，不记录 URL、授权头、secret、正文或供应商错误文本。`schema-attempt.json`、`catalog-attempt.json`、`permit.json`、`upload-attempt.json` 均独占创建；即使请求尚未真正派发，崩溃后也保守阻止重发。run 收据永久保留，不自动清理。

issue 响应丢失后只运行新 status；即使 status 看不到 permit，也不能重发原 INSERT。upload/CAS/PUT 响应丢失后不再 upload；只可按已审查的同对象有限 reconcile 恢复。schema 未知后只做新只读核对，缺失/部分定义须另行 review 后才允许明确修复，不借更换 run ID 自动重放。最终部署/阅读失败时关闭新 API/auth、撤销会话并保留桶、对象、全部预留、许可、历史 unknown 和收据；不删除对象、清账、改计费或恢复旧写能力。

登录 auth close 只撤销普通阅读会话，**不会关闭专用 single-trial upload/object secret 入口**。关闭这些入口须先构建 disabled 产物，再执行已审查的 `node scripts/cf-deploy.mjs --static-rollback --single-trial`。该路径验证固定 target/实际 secret/精确 trial bindings，并移除动态代码、vars、BOOKS/DB；保留三个已知惰性 secret 和全部数据责任。也可按单独审查的明确方案移除专用 mode/secret；不能只执行 auth close 就宣称上传入口已关闭。
