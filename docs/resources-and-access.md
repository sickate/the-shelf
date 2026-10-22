# The Shelf 资源、权限与开发配置

更新日期：2026 年 10 月 15 日。本文是仓库运维记录，不在网站文档发布清单中，不包含真实凭证。现有资源验证记录来自 10 月 14 日；本次补充当前工作区说明。

## 2026-10-22 发布恢复：2c74cc9 已推送

后续实现的主Agent验收通过：版本工具116项独立专项、history+旧close80项、CLI+core19项；完整723项Node/8项Python零失败/零跳过。顺序disabled构建1280页、公开1318文件、静态1304资源和1493文件实际凭证扫描通过，秘密命中/不安全文件均0。日志仅保存在本机 `/tmp/shelf-followup-full-20261022.log`、`/tmp/shelf-version-main-20261022.log`、`/tmp/shelf-followup-build-20261022.log`。新版本/历史工具仍未真实执行，待本轮提交与两CI通过后先记录有界真实计划；原PATCH unknown、六guard、imported、书籍0和业务关闭状态不变。

用户要求继续后续任务。网络恢复后，主Agent只读确认远端main仍为6cebed0，再通过已有GitHub登录的HTTPS通道推送至 `2c74cc94ef0b291a31100400f9b05a4d01131b23`。Cloudflare CI `39739955059` 成功，部署步骤skipped；Pages CI `39739955068` 的build/deploy均成功。主站curl固定GET回读runtime为schemaVersion=1/apiMode=disabled，API health为404；Python urllib一度返回403，未据此改判应用状态，改用curl独立核对。先前网络失败记录保留为历史，本次恢复不执行CF01云写、账本变更、AI或对象上传。

Pages公开开发计划已用curl下载并与2c74cc9源文档逐字比较一致。主Agent另对固定本机CF01 evidence执行0600/O_NOFOLLOW/1MB及前后inode/mtime检查的只读聚合：24请求、1个storage run、8条start，其中1条无run ID且未决；未决mutation合计1，storage正向completed回执1。仅为本机证据现状，不将模糊POST归为storage/Workflow、不覆盖unknown、不当完整调度或排空证明；readyEligible=false。独立设计复核说明在 `docs/legacy-writer-closure-design.md`，不在公开白名单。

## 2026-10-22 最新云端验收：账本已导入，CF01关闭部分完成

实现提交 `6cebed05a52ed8a3c7bff3b2568c1d884e226d00` 已推送，Cloudflare工作流 `39726393168` 与Pages工作流 `39726393083` 均成功；前者明确部署step skipped，只保存artifact，后者为静态回退部署。主Agent完整590项Node/8项Python通过，顺序disabled构建1280页、公开产物1318文件、静态资源1304项及真实凭证扫描1484文件通过，零跳过/秘密命中/不安全文件。主站仍9963771，不代表业务后端上线。

CF01新工具真实status用9HTTP通过，私有收据为 `.local/cf01/storage-close-b019aeaa-2603-428b-9928-b2e0fd128927.json`。随后close运行 `.local/cf01/storage-close-93c327fc-5e75-4a9c-9f6c-abaf313f29a2.json` 共25HTTP，六条永久storage-only guard已落地并逐条回读，新探针精确拒绝且双表独立读回零行；原7条budget/1条storage墓碑未变，storage run和orphan均0。本机私有Wrangler固定R2项已原子改为空数组，文件0600，其余配置保留。第25请求settings PATCH返回HTTP400，以unknown保留并停止，不重发、不恢复guard或本机R2项。

独立status收据 `.local/cf01/storage-close-04e53f47-3e7c-48a3-be6e-a0b647fbecb2.json` 用7HTTP确认六guard、原库存和关闭的workers.dev/preview，但CF_BUCKET仍存在，按 `cf01_close_patch_resolution_required` 阻断。原unknown未补判；实际cloudWriteFreeze/drain/upload均未证明。后续核对固定官方OpenAPI revision `d3e86eec17211653ca9bc18c0d4bfcace2904148`，确认settings inherit具体UUID不受支持；这不能追溯证明当次400的provider code或事务结果。修正代码删除全部PATCH构造与派发，预算设为0；即使全新状态，仍有R2时也在创建PATCH intent前固定拒绝，不改成latest。六guard和schema定义与已落地版本逐字一致，历史unknown及expected独立回读规则保留。本修正未再调用云管理接口。

CF03另以 `post-cf01-close-20261022-6cebed0` 独立15HTTP status回读，authority保持imported，committed/reserved均0，旧两库来源及历史unknown保留。R2观察 `rest-observation-20261022-6cebed0` 共3HTTP成功，先复核Volt无R2条件；私有证据位于 `.local/r2-account-audit/rest-observation-20261022-6cebed0/`。REST四个存储类/状态的payload/metadata观察均0但无源时间；不相加、不视为合格总量。GraphQL最新sample在读取时约32.5分钟前，操作计数的采样/覆盖/计费状态仍unknown，accountEvidence=null、uploadEligible=false。

接续必须先读本节及开发计划顶部，不重复close/原PATCH，不运行已不适配关闭后私有配置的旧audit来恢复能力。保留全部收据、unknown、本机配置与六guard；只读status不会凭等待时间解锁。书籍上传0、API/auth/私人云端阅读关闭；绑定收回、可信在途排空和合格R2证据仍待独立方案与验收。

契约保护的本地验收：Sol/high专项68项通过，主Agent review与独立完整588项Node/8项Python通过，零失败/跳过；顺序disabled构建1280页、公开1318文件、静态1304资源及真实凭证扫描1484文件均通过，零秘密命中/不安全文件。待提交推送后以对应CI结果核对静态回退发布，不据此重试云端PATCH或宣称业务上线。

本地修正提交为 `fcfb3d12c7a27ea2022e7d69f7ce5c171156c69f`；随后SSH推送连接关闭，HTTPS推送DNS失败，独立GitHub API亦连接失败，主站runtime GET解析超时。未取得本提交的远端CI或线上验证，不将上一提交的成功结果套用到本修正。下次先确认远端实际HEAD，再在网络恢复后推送并验收现有CI；本机已保存代码和文档，私人证据原样保留。

## 2026-10-22 恢复开发：真实迁移验收记录

本轮从提交 `de20e307e9caee1540bef8146d12ef19f4c2b414` 接续。对应 Cloudflare artifact 工作流 `39723864943` 与 Pages 工作流 `39723864972` 均成功；Cloudflare 自动部署关闭。`storage-migrate` 与 `cf01-storage-audit` 专项测试共 56 项通过，零跳过。

迁移操作均为独立运行，私有收据保存在 `.local/cf03/storage-migration/<runID>/receipt.json`，本文不记录账号、资源标识或密钥：

- `resume-status-20261022-de20e30`：15 次 HTTP、0 条 DDL，恢复成功，authority 为 `uninitialized`。
- `resume-freeze-20261022-de20e30`：39 次 HTTP、0 条 DDL，冻结成功。check 与 production 两库均精确拒绝旧写入口，并各自独立回读为零行；`databaseWriteFreezeProven=true`。
- `resume-import-20261022-de20e30`：67 次 HTTP、0 条 DDL，导入结果为 `imported`；`committed` 与 `reserved` 均为 0。闭包尚未证明。
- `resume-post-import-20261022-de20e30`：独立 status 运行，15 次 HTTP、0 条 DDL，再次确认 `imported`；check 的 56 项及 production 的 88 项 schema 完整，marker 存在，两库旧 reservation/registry 均为 0。两条历史 unknown probe 当前读数为 0，但 `atomicRejectionProven=false`，原有 unknown 结论继续保留。

CF01 收据首次只读审计运行因 `cf01_audit_bindings_unexpected` 停止，共 6 次 HTTP；私有收据为 `.local/cf01/storage-audit-cd307f48-7dc5-4bb0-b5f4-b0ac40136a5b.json`。已只读确认固定 `CF_MOCK` environment 为 `production`，而原工具仅接受空值。私有 `wrangler-debug.log` 权限由 `0644` 收紧为 `0600`，内容未改动。后续提交 `5c0a25da005925f2cf2c5791d8581018a447b753` 已推送；Cloudflare 工作流 `39725030540` artifact 成功且自动部署跳过，Pages 工作流 `39725030531` 成功并部署静态回退站点。新版 CF01 audit 独立只读运行成功，共14次HTTP，私有收据为 `.local/cf01/storage-audit-1ce19c8f-cb32-4ea1-bed1-6e76ea38b5b2.json`。

该 audit 状态为 `inventory-observed-closure-unproven`。两次snapshot一致：`budget_all=7`、`storage=1`、`liveStorage=0`、`orphan=0`；唯一storage项是tombstone；取得两个历史版本（number 1、3，各含1个模块），workers.dev与preview均为false。`executionVersionMappingProven`、`cloudWriteFreezeProven`、`drainProven`、`uploadAllowed` 均为false，因此不能据此证明排空或旧写能力已关闭。R2 observer补充虽经主Agent独立15项专项通过，但尚未提交或真实运行，未取得新的REST用量证据。

初始预算观察为 `budget_all=7`、`storage=1`、`runs_storage=0`、`orphan=0`；唯一 storage 项为 tombstone。这只是观测，不能证明账本已排空。当前书籍数为 0，R2 用量证据仍不合格；ready、API、auth 与私人阅读继续关闭。主站仍为 `9963771`，本轮未手动部署；Pages静态回退部署不改变此状态。

本检查点主Agent独立完整回归为516项Node、8项Python通过，零失败/零跳过。首次沙箱运行的13项HTTP测试因监听127.0.0.1返回EPERM，原日志保留；授权临时端口后重跑整套通过，日志为 `/tmp/shelf-resume-full-authorized-20261022.log`。disabled构建1280页、公开产物1318文件、静态资源1304项及实际凭证扫描1480文件均通过，零秘密命中/零不安全文件；格式与diff检查通过。后续CI与新版audit结果见上文；R2 REST用量证据、排空与旧写能力关闭仍未证明。

下一实现检查点已由主Agent完成独立review及完整590项Node/8项Python验收，零失败/零跳过，日志为 `/tmp/shelf-close-rest-full-20261022.log`。包含固定CF01关闭工具70项专项和R2 REST观察15项；review补齐了未知PATCH只能匹配预登记五项hash后零PATCH继续、SQLite NULL安全identity保护及旧NULL库存拒绝、矛盾success/errors响应失败关闭。关闭工具尚未真实运行，六条guard和settings PATCH尚未落地；R2第三GET尚未真实读取，仍须提交/CI后执行。回归中的文档导出会重写共享文件，因此构建与公开/静态/凭证检查必须在回归后顺序运行，不能并行读取混合产物。

## 2026-10-22 收工：代码保存，云操作停止

用户要求记录进度、提交全部代码和文档后今天结束。本轮不再执行云端冻结/导入、CF01核查、AI调用、对象上传或手动部署。项目私有配置、凭证、原书、数据库、快照及所有未知收据继续保留于忽略目录；提交只包含非私人代码、说明、测试和固定白名单导出的公开文档。

当前云端状态不变：书籍上传0本，authority为uninitialized，冻结验收未完成；两个未知probe保留，最后只读回查均无记录且两库旧reservation/registry总数均0。R2用量观察不合格，API、登录、私人云端阅读关闭；主站静态版本为9963771。AI Key的合成文本/JSON实测已通过，gpt-sol未单独实测，不代表书内业务或持久AI任务上线。

Sol/high已交付精确Workerd extended格式兼容及独立零行读回、有限错误语法诊断和固定CF01只读audit。主Agent已复审最后修正并运行完整507项Node、8项Python测试，全部通过、零跳过；包含迁移24项、CF01专项32项，以及目录/收据替换、错误码敏感内容消除、严格格式拒绝矩阵与零行回读。格式检查及CF01真实CLI preview零IO通过。测试日志为本机 `/tmp/shelf-closeout-tests-20261022.log`；已落地SQL003/004未改动。CF01工具未真实执行，真实执行前需核验 `.local/cf01/wrangler-debug.log` 当前0644并按授权收紧为0600；本轮未修改该文件或任何云资源。两个既有未知run及各次status的相对路径见下节；禁止重写或补判旧unknown。

收工disabled构建生成1280页，公开产物1318文件和静态资源1304项检查通过；真实凭证扫描1480文件，零命中、零不安全文件。构建日志为本机 `/tmp/shelf-closeout-build-20261022.log`。本次提交后的CI结果以对应Git提交工作流和收工回复为准；没有手动部署主站或业务后端。

下次执行顺序及回退见 `docs/development-plan.md` 顶部收工交接：先核对提交/CI和新run只读status，再新run冻结验收，之后才导入；旧写能力关闭/终态证明、合格R2证据、单对象与选定单本上传、云端阅读仍待完成。收工提交和Pages静态CI不能作为业务已上线依据。

## 2026-10-22 实际冻结续验（cf60690）

提交 `cf60690a138a1e294521f704327c8d7be2bdf772` 已推送。主 Agent 本地复核通过：472项 Node、8项 Python 测试均通过且零跳过，21项迁移专项通过；构建生成1,280页，`verify:public` 检查1,318个文件，静态资源检查1,304项，真实凭证扫描1,477个文件通过。Cloudflare CI `39718968993` artifact成功且自动部署跳过；Pages CI `39718969027` 成功。

增强只读状态运行 `diagnose-after-freeze-20261022-cf60690` 共14次HTTP，确认原probe计数为0、check与production两库的reservation和registry计数均为0。随后schema冻结运行 `freeze-diagnostic-20261022-cf60690` 共32次HTTP、0条DDL；新check probe返回HTTP 400/code 7500，并带有freeze与SQLite标记，但错误格式未通过严格格式匹配规则，按unknown保留。该结果不能证明具体wrapper行为或原子拒绝成功。再以 `status-after-diagnostic-20261022-cf60690` 独立只读运行15次HTTP，确认两个probe均为0、两库旧reservation/registry总数均为0；两个unknown仍保留。

authority仍为 `uninitialized`，书籍0本，业务API未启用，主站仍为静态版本 `9963771`。没有导入、激活、R2 PUT或真实书籍上传。私有receipt位于项目相对路径 `.local/cf03/storage-migration/` 对应运行目录；本文不包含凭证或账号标识。本记录不把新代码视为真实云端核查；CF-01工具仍待主 Agent 验收。下一项Sol工作增加脱敏语法诊断；主Agent已核对官方Workerd源码，并另行批准仅对新响应兼容其精确extended trigger约束格式，仍要求HTTP400、明确失败envelope及单条code7500。泛token、5xx和旧unknown不改变。下方此前检查点保留为历史。

## 2026-10-22 实际冻结与R2观察（历史）

第二检查点 `4e23dd3895145d4a2163f03354cd24324be8cf56` 已推送；Cloudflare artifact CI `39717347207` 和 Pages CI `39717347250` 成功。主站仍为上一受控静态部署，API和私人云端阅读关闭，上传书籍0本。

主Agent实际执行 `schema-freeze` 运行 `schema-20261022-4e23dd3`：134个HTTP已派发、100条DDL已完成；第134个check旧预留负向验证记录unknown后停止。独立只读运行 `status-after-schema-20261022-4e23dd3` 以11个HTTP确认两库schema完整（56/88个对象）和冻结标记存在，authority尚未初始化。没有导入、激活或R2 PUT。旧响应未保留可分类元数据，不推断其具体HTTP状态或事务结果；未知收据和state必须保留。证据在 `.local/cf03/storage-migration/` 对应运行目录。

R2只读运行 `r2-observation-20261022-4e23dd3` 以2个固定汇总请求完成观察，但新样本约24.5分钟前、账号存储为max非sum、操作采样/覆盖及Free状态未完整证明，结果 `observed_incomplete`、`uploadEligible=false`。最新样本的零不能当完整账号零。未列其他桶或读取对象，证据在 `.local/r2-account-audit/` 对应运行目录。

接续先review并发布诊断增强，再只读精确检查历史probe是否留行；原unknown保留、不自动重放。CF01旧写能力及在途调度终态另作固定范围核查，缺完整closure仍不能ready。下方旧轮事实保留为历史。

## 2026-10-21 检查点

2026-10-22 用户再次要求核验 `.env` 的 `SHELF_OAI_KEY` 后，重新读取公开指南并执行独立有界 smoke `ai-key-check-20261022-0258`。无Key401，两次带Key的 `gpt-luna` 合成任务均200；普通文本与显式JSON对象均通过，耗时约5005ms和3148ms。共3个HTTP、2个带Key任务、零重试，没有发送书籍或私人内容。当前Key/文本入口/该模型已实测可用，`gpt-sol` 未单独实测；前轮503仍保留unknown历史。私有证据为 `.local/ai-smoke/ai-key-check-20261022-0258/receipt.json`，不包含Key或生成正文。公开指南此次仍标注2026-10-20更新。

第二实施检查点本地通过：471项Node、8项Python，零跳过；disabled build1280页、verify:public1318文件、verify:static1304资源和1477文件真实凭证扫描零命中/零不安全文件。主Agent分别审阅authority、旧入口拒绝、bounded迁移与selected-sync；新代码尚待此检查点提交/CI后执行真实冻结和导入，业务API仍关闭、R2对象尚未上传。日志仅本机 `/tmp/shelf-ledger-full-tests.log`、`/tmp/shelf-ledger-build.log`、`/tmp/shelf-ledger-static-verify.log`；不把离线模拟139/67次请求记为真实云请求。

提交 `9963771bbab02d0dc32f2d3dcb9ab22114ed09af` 已推送至 `main`。主 Agent 本地验收为 398 项 Node、8 项 Python 测试通过，零跳过；构建 1,280 页，`verify:public` 检查 1,318 个文件，静态资源检查 1,304 项，真实 secret 扫描 1,463 个文件通过。Cloudflare workflow `39620203325` 仅构建 artifact 且成功，自动部署关闭；Pages workflow `39620203289` 成功。主 Agent 随后执行本机受控静态部署并完成线上核验：runtime 为 `schemaVersion=1`、`apiMode=disabled`，`/api/health` 为 404，AI raw 文档与预期字节一致。此发布不包含业务 API 或私人阅读。

真实只读 preflight 完成 14/18 请求：check identity/schema 有效，reservations、registry、auth 均为 0；production 实际应用 schema 为空。应用 manifest 的 `storageKey` 数为 0，本机预留为空、lock 不存在。以上只代表观察到的当前状态，不能证明冻结、迁移或切换已完成；`uploadAllowed=false`。authority、旧写入入口关闭及 R2 只读 observer 仍在实现 review，未执行云端写入或上传。私有 receipt：`.local/cf03/storage-preflight-fb911552-0eaa-4447-97c4-49c882aaab81.json`。

真实 AI smoke 中，未授权请求以 401 通过；首个带 Key 的 `gpt-luna/topic_analysis` 请求返回 503 `unknown`，第二个模型请求未发送。总计 2 个 HTTP 请求、其中 1 个带 Key 请求，无重试；真实模型任务结果仍未验证成功。私有 receipt 目录：`.local/ai-smoke/ai-contract-20261021-9963771/`。

本 checkpoint 依照先计划、按复杂度分配 Sol/Luna、主 Agent review 和验收、通过后再发布的流程执行。线上当前只验收静态站；远端唯一预算账本、旧入口迁移关闭、真实上传及云端阅读均未完成。上述私有路径仅供本项目维护使用，不含凭证。

## 当前工作区

当前工作区就是 paw 上的 The Shelf 项目开发目录。默认直接在当前工作区执行，不额外 SSH 到 paw 或重复同步副本；跨机操作仍按具体任务需要和既有授权判断。此前记录的配置与凭证同步及其授权继续有效，作为历史记录保留。

本次修正计划：将当前环境说明补入协作约定与本记录，由主 Agent review、验证后提交发布。

## 部署边界

`paw@paw:~/code/the-shelf` 是开发目录，未配置常驻 Node.js 业务服务、生产 API 域名或反向代理。当前 Node.js 后端使用本机 HTTP 和 SQLite；CF-02 静态站正式发布在 Cloudflare Workers Static Assets，GitHub Pages 保留回退。Cloudflare 另有私有 R2 文件存储，以及仅供 CF-01 使用且已完成清理核验的诊断资源。

10 月 15 日用户确认将 Cloudflare 统一托管加入计划，目标为 Workers Static Assets、Workers、D1 与 Workflows；先验证免费运行条件，再逐步迁移。CF-01 验证资源已结束运行并完成清理核验；CF-02 静态站已发布到 Workers Static Assets 并通过线上验收，GitHub Pages 保留回退。业务 API、生产登录和私人阅读尚未迁移。资源地址、账号/数据库标识和凭证留在忽略的 `.local/` 文件中，不在此记录。任务顺序见 `docs/development-plan.md`。

## Cloudflare Workers Static Assets（CF-02）

正式静态站：<https://the-shelf.iamzhutuo.workers.dev/>。主 Agent 使用 paw 上的受控 helper 发布。控制 API 回读的 worker subdomain 为 `iamzhutuo`，preview 关闭，bindings 为 0。GitHub Actions Cloudflare 工作流 `38677306877` 成功构建 artifact，deploy step 因未配置单 Worker 专用 token 而按预期 skip；Pages 工作流 `38677307035` 成功，旧站继续作为回退。

线上独立 HTTP/2 全量检查覆盖 1,303 项资源，全部返回 200，其中 1,280 个 HTML、含 1,264 个书籍详情页。另对 29 个 GET 路径检查首页、书籍页、阅读入口、12 份文档 HTML 与 raw、docs index 与 all；逐字比对本地构建内容及 MIME 均通过，缺失路径返回 404。Node 批量 fetch 曾间歇 TLS 失败；最终通过依据是独立 curl HTTP/2 检查，不把 npm remote 命令表述为通过。

证据文件位于忽略的 `.local/cf-static/`，包括 release、响应头摘要、内容摘要和 CORS 回读。CF-02 源码提交 `308751c` 与 workflow 修正 `127be0b` 已推送；网络校验脚本增强随本轮收尾提交。当前完整验收为 56 项 Node、8 项 Python、构建及公开产物隐私检查通过；静态实现 review 已通过。GitHub 自动部署仍需严格限定于单一 Worker 的专用 token；不得复制账号级通用 token 到 GitHub。CF-02 已完成，CF-03 登录实现尚未开始。

## GitHub

| 项目 | 已核验配置 |
| --- | --- |
| 仓库 | `sickate/the-shelf`，公开仓库，默认分支 `main` |
| 本机与 paw 的 GitHub 身份 | 均为 `sickate`，对本仓库有管理和推送权限 |
| Pages | 使用 GitHub Actions 发布，强制 HTTPS |
| 网站 | <https://sickate.github.io/the-shelf/> |
| 发布环境 | `github-pages`，仅允许 `main` 部署 |
| Actions 默认权限 | `contents: read`；工作流另声明 `pages: write` 与 `id-token: write` |
| 最近一次发布核验 | [成功的 Pages 工作流](https://github.com/sickate/the-shelf/actions/runs/38430083904) |
| 前端 API 变量 | `PUBLIC_SHELF_API_URL` 尚未设置；确定生产 API 地址后再填写 |

paw 已有可用的 GitHub CLI 登录和 Git SSH 访问。本次复用其既有权限，不复制本机 GitHub 账号令牌。Pages 使用工作流临时令牌和 OIDC，不需要长期部署密钥，也不需要 Cloudflare 密钥。

通过非交互 SSH 运行时，Homebrew 工具可能不在默认 PATH 中，先执行：

```sh
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd ~/code/the-shelf
gh api repos/sickate/the-shelf --jq .permissions
```

## Cloudflare R2

已在项目 `.env` 中 `SHELF_R2_ACCOUNT_ID` 指定的 Cloudflare 账号创建私有 `the-shelf-books` 桶，使用 Standard 存储，位置提示为 APAC。`r2.dev` 公共访问关闭，未绑定匿名自定义域名。核验时整个账号显示存储占用为 0 B，账单使用量为 $0.00；未开通新的付费订阅。账号标识和真实凭证留在私人配置中。

已签发账号持有的长期令牌 `the-shelf-development`，状态为 Active，权限为 `Object Read & Write`，仅限定到 `the-shelf-books`，可读取、上传、列出和删除桶内对象。S3 Access Key ID 和 Secret Access Key 已写入本机与 paw 的被 Git 忽略的 `.env`，分别对应 `SHELF_R2_ACCESS_KEY_ID` 和 `SHELF_R2_SECRET_ACCESS_KEY`；账号和桶分别对应 `SHELF_R2_ACCOUNT_ID`、`SHELF_R2_BUCKET`。没有复制本机 Wrangler OAuth 凭证或其他项目的通用管理令牌。

若需吊销或轮换，在 Cloudflare R2 → Manage API Tokens 中按 `the-shelf-development` 名称管理。先签发相同单桶范围的新令牌，更新两端 `.env` 并验证后，再吊销旧令牌；不要把权限扩大到所有桶。

CORS 配置源在 `config/r2-cors.json`。10 月 15 日本轮 Cloudflare PUT 后 GET 回读与配置完全匹配：在原有 GitHub Pages 和本机 Astro 来源基础上，仅新增 `https://the-shelf.iamzhutuo.workers.dev`；原 `GET`、`HEAD`、Range 请求及响应头规则保留。回读证据保存在忽略的 `.local/cf-static/`。此改动为 CF-03 跨域阅读准备；当前 CF-02 静态站点尚无线上私人 API。[Cloudflare CORS 文档](https://developers.cloudflare.com/r2/buckets/cors/)。

项目上传预算仍为 8,000,000,000 字节，每个文件不超过 20,000,000 字节。R2 免费额度按整个账号共享，必须先核对账号已有占用；配置预算不是 Cloudflare 的账单封顶。[R2 价格与免费额度](https://developers.cloudflare.com/r2/pricing/)。

本次不上传电子书。实际上传继续使用逐文件计划，传入 `--execute` 才执行。

## 私人配置与同步

`.env` 使用 `0600` 权限，`.local` 使用 `0700` 权限。开发环境已生成独立所有者密码，密码留在 `.env` 中，不写入文档、Git、前端 `PUBLIC_` 变量或 GitHub Actions。开发后端仅监听 `127.0.0.1:8787`；本机文件读取默认关闭。

同步只涉及项目配置和本次修改的源文件。paw 已有的私人书籍映射、SQLite、提取正文和源文件保持在原位置。本机私人文件映射不能替代 paw 自己的导入结果。

不要把 `.env` 当成 shell 脚本执行；项目命令通过 Node 的环境文件加载器读取它。

```sh
npm run server
npm run dev
```

在本机浏览器访问 paw 的开发环境，可建立 SSH 转发：

```sh
ssh -N -L 4321:127.0.0.1:4321 -L 8787:127.0.0.1:8787 paw@paw
```

然后打开 <http://127.0.0.1:4321/>。私有状态和凭证均被 Git 忽略；运行 `npm run verify:public` 检查发布产物。

## 自动审核授权

用户已授权本项目 Cloudflare、GitHub 操作及仅影响本项目的 Bash / shell 命令自动审核执行。授权记录在 `AGENTS.md`，实际项目设置在 `.codex/config.toml`，两者均已同步到 paw。

设置为 `approval_policy = "on-request"`、`approvals_reviewer = "auto_review"`、`sandbox_mode = "workspace-write"`。额外审核策略列明仓库、Cloudflare 项目资源、两端项目目录和凭证同步范围。它保留沙箱及自动审核，不关闭审批检查，也不授权无关项目或账号级通用凭证。

通过 Codex `config/read` 回读，确认本机 0.159.0 和 paw 0.162.1 均实际加载自动审核、项目范围及本地 Shell 授权。两端项目均已被各自 Codex 信任。后续新会话从本项目目录启动即可读取；已启动会话不保证热更新设置。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 已完成的验证

下表保留 10 月 14 日历史结果；10 月 15 日新增云端验证见后续 CF-01 记录。

| 验证 | 结果 |
| --- | --- |
| paw 运行环境 | Node.js 26.0.0、Python 3.14.5，具备 pdftotext |
| 现有测试 | 16 项 Node 测试、8 项 Python 测试全部通过 |
| Pages 构建 | 使用正式站点与 `/the-shelf/` 前缀，生成 1,280 个页面，含 1,264 个书籍详情 |
| 公开产物 | 加载实际 `.env` 的 `verify:public` 检查通过；本运维记录不在公开清单内 |
| 真实开发后端 | 临时本机监听，健康检查、所有者密码登录、会话读取通过；验证结束后关闭 |
| 真实 R2 对象访问 | 上传、完整读取、206 Range、Pages 与本机 CORS 均通过 |
| 私有边界 | 无签名请求被拒绝；不允许的 Origin 不获 CORS 访问 |
| 验证对象清理（10 月 14 日） | 只使用中性文本诊断对象，验证后已删除；没有上传电子书 |
| 项目审核配置 | 两端实际回读均为 `auto_review`，项目和 Shell 策略已加载 |

所有实际密钥与所有者密码仍仅保存在 `.env`。`npm run verify:public` 现会加载该文件，以便核对配置值未进入发布包。S3 匿名请求实际返回 400 `InvalidArgument`，属于拒绝访问；不能只把 403 视为成功的私有隔离检查。

## AI 与生产部署待办

`SHELF_OAI_BASE_URL` 和 `SHELF_OAI_KEY` 暂留空。现有任务入口只接受服务环境配置的 Key，旧管理页签发的数据库 Key 无法用于 `/v1/tasks`。专用任务 Key 需通过该服务的运维配置接入后验证；本次尚未修改现有 AI 生产服务或调用模型。

Cloudflare 静态网站已发布，免费 CPU、D1 持久化和 Workflows 长任务基础验证已完成。生产业务 API 地址与同源路由、登录和私人阅读迁移、GitHub 自动部署所需的单 Worker 专用 token，以及 AI 任务 Key 仍待后续阶段确定。当前 R2 与 GitHub 已可供 paw 开发使用；AI 未配置时仍明确停用，不会发起模型请求。

10 月 15 日 CF-02 完整验收运行 56 项 Node 测试、8 项 Python 测试、构建及公开产物隐私检查均通过；静态实现经 review、发布和线上验收通过。当前站点及检查证据见 CF-02 记录。

## CF-01 云端诊断记录（2026-10-15）

主 Agent 使用本机现有 Cloudflare 认证核对，目标账号与项目 `.env` 中指定账号一致。Workers account-settings 显示 default usage model 为 standard，且 `/workers/standard` 为 true；这两项单独不能判定账号计划。实际部署显式设置 `cpu_ms=10` 被拒绝，返回 code 100328，错误明确指出 Free plan 不支持配置 CPU limits。移除该手动参数后，同项目 Worker 成功部署，因此本次已有实际 Free 计划证据；未升级付费。Billing 接口返回 403，账号令牌权限组接口 `/accounts/id/tokens/permission_groups` 返回 403；当前认证无法读取令牌权限组，未签发新的部署令牌。部署凭证没有复制到 GitHub，也没有创建账号级通用令牌。

已创建专用 D1 `the-shelf-cf01`、主 Worker `the-shelf-cf01`、无公开入口的私有 mock `the-shelf-cf01-mock` 和 Workflow `the-shelf-cf01`。实际 account/database 标识仅在 `.local/cf01/resources.json`，probeBearer 仅在 `.local/cf01/secrets.env`；私有 `evidence.json` 记录探测结果。这些文件权限均为 `0600`。本轮仅向现有私有桶写入 `diagnostics/cf01/<UUID>/neutral.txt` 中性诊断对象，不含电子书；后续清理按 probe 操作流程执行。

已验证 R2 72-byte 对象完整读写和 Range 读取、D1 跨请求持久化，以及 65 秒 Workflow 在客户端退出后继续完成。服务绑定 mock 等待约 65,071 ms；`network_calls` 与 `mock_calls` 均为 1，表示一次性 claim 计数，不代表计费次数。真实 AI 未调用。

密码计算探针的 scrypt 双计算返回 `verified=true`。Cloudflare 在纯计算期间冻结 `Date.now()`，因此 wallMs=0 不表示 CPU 用量为零。GraphQL 同 script 时间窗汇总 P99 为 149,242 微秒（149.242 ms），不能归因到某一次运行的精确 CPU。固定配置 600,000 次迭代的 PBKDF2 云端运行失败；第二次受控错误结果为 `pbkdf2_iteration_limit`。本地 workerd 单次 600,000 次迭代成功不能替代云端验证；不降低参数宣称通过。

840 秒模拟服务绑定长任务已完成，Workflow 状态为 complete，`networkWallMs=840071`；客户端在初次启动后已退出，`network_calls=mock_calls=1`。初始启动响应遇到 TLS 错误后，主 Agent 检查持久状态并使用相同 runID 显式恢复一次。防重复调用证据来自 D1 原子预留和固定实例 ID，不是 404，也不构成自动重试上游的依据；不得自动重发不确定的上游请求。

65 秒 uncertain 模拟已结束，Workflow 状态为 complete，业务 run 状态为 uncertain，`networkWallMs=65088`；`network_calls=mock_calls=1`。同标签重复 start 只 GET 既有 run ID，没有新 POST，计数仍为 1。诊断资源清理验证通过：`cf01_runs=0`，保留 7 个预算去重墓碑；主 probe 的 workers.dev 和 preview 入口已禁用，mock 原本即为私有。没有上传电子书或调用真实 AI。

CF-01 评估结论为“评估完成，鉴权需适配”：免费 D1、R2 与 Workflow 基础能力验证通过；Node 登录不可直接照搬，CF-03 必须先设计并验证安全低 CPU 登录方案，同时保留现有凭证强度、限流和会话安全。CF-01 源码提交 `720690b` 已推送，GitHub Actions 工作流 `38675230094` 成功；完整检查为 41 项 Node、8 项 Python、构建与隐私检查通过。没有上传电子书或调用真实 AI。

CF-01 源码 probe 12 项（含清理竞态）和隐私检查 13 项通过；CF-01 当时完整验收为 41 项 Node、8 项 Python，且源码 CI 成功。CF-02 本轮完整验收为 56 项 Node、8 项 Python、构建和隐私检查通过。现有诊断对象的无签名 R2 GET 返回 400 拒绝；未授权诊断 GET、POST、DELETE 均返回 401；主 probe 的 workers.dev 与 preview 入口已禁用，mock 为私有。CF-02 静态实现 review、部署与线上 URL 验收均通过，详细结果见 CF-02 记录。GitHub 自动部署尚无严格限定于单一 Worker 的专用 token，不能标为已完成，也不能把账号级通用 token 复制到 GitHub。当前 GitHub Pages 保持服务。详见 [CF-01 probe 操作说明](../cloudflare/probe/README.md)；该运维记录不纳入网站文档白名单，私有证据仅存于被忽略的 `.local/`。

## 公开仓库提交检查

用户确认保持仓库 public；GitHub Pages 在 Cloudflare 新站验收前继续使用。10 月 14 日提交前已检查待提交内容与全部已有 Git 历史，并使用独立离线密钥扫描器复核；实际 R2 Access Key ID、Secret Access Key 和所有者密码未出现在代码或历史中。扫描器提示的文档版本 SHA-256 已重新计算核对，测试用假凭证与类型判断均已逐项确认。

`.env`、`.local`、书籍原文件、SQLite、提取正文和临时扫描报告不进入 Git。公开产物检查使用通用私人路径检测规则，不把实际账号标识和私人挂载目录写进规则。两端 R2 配置和所有者密码逐项比对一致；paw 已有有效 GitHub CLI 登录及 SSH 仓库访问。

## 本轮条件性 R2 汇总核查（2026-10-15）

用户说明当前仅The Shelf与Volt使用Cloudflare，并授权在确认不涉及其他项目R2使用后，读取账号R2总存储及当月Class A/B操作数量纯汇总。主Agent已只读核对Volt与Shelf账号相同、远端R2 bindings为0，文档及源码未发现Volt接入R2；未修改Volt。随后仅请求账号纯汇总和固定 `the-shelf-books` 桶汇总，未读取其他桶名、对象名或业务数据，未新建通用凭证。条件变化或出现不可归属的当前存储时须停止；此项新授权有限补充此前自动审核拒绝的范围，旧拒绝仅保留为历史，不再记为当前授权缺口。

截至2026-10-15T11:23:42Z查询，最新存储点为11:10:00Z，账号及Shelf桶的Standard/IA payload、metadata、object、upload指标均为0；该存储点已超过5分钟freshness门槛。月初至查询时账号操作66次、Shelf46次，差20次包含历史账号管理操作，未归属任何项目，未查询其桶名。仅保存私有audit/conclusion，未伪造observedAt、未生成合格 `account-storage.json`，无上传。当前R2阻塞是新鲜完整证据，CPU仍是主要上线门槛；条件授权不扩大到账号其他资源。

## CF-03 当前记录（2026-10-15）

本轮阶段收尾：CPU证据分析器与重复配置解码最小候选已分别提交并推送 `5a6242d`、`15cd401`，两阶段Cloudflare及Pages CI均成功；最终156项Node、8项Python、disabled build、真实secret隐私扫描与verify:static通过。check的HTTP/2首轮21请求、80断言、真实CAS两次mutation admission及generation撤销HTTP检查通过；warm未运行、满批维护未触发。

最后一次同窗只读取得平台aggregate requests=21、errors=0，CPU P50/P95/P99/max=2.090/4.387/4.835/4.835ms，sampleInterval=1、同一version；分析器仍判 `unknown/incomplete_evidence`，保留 `group_aggregate_count_mismatch`、`ambiguous_attribution`、`missing_request_traffic`，不能凭aggregate低值判通过。平台max现已可取，原始逐请求CPU序列仍缺；HTTP/1与HTTP/2负载不可直接用于优化性能因果比较。本轮云分支结束，不加预算或采样；最终账本business48/100、explicitManagement84/90、D1management38/40，另有1次受控helper部署（内部HTTP未精确计数）。关闭证据确认check auth=0、active=0、入口disabled；最终只读不改变状态，生产API未启用、主站静态不变。

下一优先级先固化并测试受控sampler，完整收集两轮业务请求后再等待analytics，核验真实CAS及满批维护覆盖；形成新计划后再考虑下一云轮，不直接追加采样或优化。 CPU/CF-03仍未通过，R2条件授权已执行但freshness不足，未上传原文件。

以下保留静态改进发布时及上一轮CPU的历史记录。

当时CF-03为P1进行中、未验收。本地138项Node与8项Python测试通过，metadata/account真实DOM分别11/9项断言通过。独立check与production D1已建立；check schema及002保守预算迁移已应用并回读，production库为空。production secrets只在本地生成，未安装Worker或写入auth；check Worker已配置四个secret；check已关闭 `auth_config.enabled`、递增generation并撤销所有会话，workers.dev与preview URLs已禁用，D1和secrets保留未删除。Cloudflare多轮安全、CAS、撤销、合成导入及snapshot保留override检查通过；原子20并发竞争最后一槽仅1个成功。源码提交 `0ae8825` 已推送；Cloudflare CI `38724875134` 构建 artifact 成功，Pages CI `38724875089` 成功。首次真实静态 CLI 在任何 Cloudflare 写入前遇到入口循环并停止；CLI修复已通过主 Agent review，新增两项真实独立进程 static/API CLI smoke后总计138项Node与8项Python全通过。CLI修复提交 `3e1aa89` 已推送；Cloudflare CI `38725881041` 构建成功、部署按预期跳过，Pages CI `38725881116` 成功。默认disabled的静态改进已通过本机受控发布及线上验收：首次网络检查完成1248项后中断，随后仅恢复剩余56项，合计1304项HEAD均为200；32项GET与本地字节及MIME一致，缺失页、`/api/health` 与 `/api` 均返回404，runtime保持disabled；线上账号页经真实Chrome DOM验证，凭证控件为disabled。私有受控发布日志为 `.local/cf-static/deploy-kcHY0V/deploy.log`；线上验收记录为 `.local/cf03/live-static-M5NdkD/receipt.json` 与 `static-account-browser-evidence.json`，均不进入公开产物。

上一轮CPU门槛未通过：当时的小优化包含部署后首次访问的首轮21请求P50/P95/P99为2.512/6.554/10.981ms；同版本后续完整热轮21请求（不能保证复用同一isolate），HTTP/66断言通过，CPU P50/P95/P99为2.341/6.017/6.180ms，errors均为0。两轮P95都未达到5ms目标。六个版本/轮次共126请求，加2次tail健康检查共128次（低于150）；最终候选版本首轮21次与同版本后续完整热轮21次，共42次。当时未取得平台max，tail连接后无CPU events；P99不是最大值，本轮已补查平台max，原始逐请求CPU序列仍缺，5ms目标不变。R2账号汇总只读条件授权已核查并执行；最新存储点不满足5分钟freshness，尚无合格上传证据；两份选中文件的dry-plan均因`account_storage_unknown`阻止，没有上传原书或调用真实AI。The Shelf与Volt共用Cloudflare账号；Volt无R2（只读核查通过），Workers/D1额度共享且Volt用量未知。代码及CLI修复已推送并通过CI，默认disabled静态改进已部署并通过线上验收，以receipt为准；API不发布，当前主站仍为CF-02静态站，Cloudflare CI仅生成artifact，Pages回退保持disabled。详细验收与后续采样计划见[CF-03计划](cf03-plan.md)及[Library操作说明](../cloudflare/library/README.md)。

## 2026-10-17 开发费用与依赖决策

用户决定优先推进功能，优先复用免费资源；确有必要时可承担仅属于 The Shelf 的合理超额费用。本轮没有开通付费计划或修改账号计费，也没有费用封顶承诺。账号 Workers/D1 纯汇总读取授权未扩大。

5ms CPU 是优化目标，不再阻断离线开发；当前 CPU 分析仍为 `unknown`，没有更改测试或宣称通过。CF-04本机正文准备首步与CF-03并行推进；云同步、生产CPU/安全验收和真实上传仍须分别满足其证据门槛。8 GB总预算、20 MB单文件限制、逐文件上传及隐私安全要求继续有效。

本轮离线首步已完成实现与主Agent review，`prepare:text`默认预览、显式执行才生成本机私有版本包；新增15项专项及完整221项Node、8项Python通过，零跳过，未使用真实收藏或访问云端。正文包尚未接入阅读/AI、R2或D1，不把本机交付记作业务上线。实际新部署、计费变更、书籍上传和真实模型调用均为零。

## Workers / D1 账号纯汇总只读核查（2026-10-17）

用户已另行明确授权固定项目账号Workers/D1当日纯数字汇总及产品Free状态核验，覆盖共享账号全部项目；此前未授权记录保留为历史。本轮仅两个固定无维度GraphQL POST，不返回资源名、标识、SQL或业务数据，不调用全账号订阅/宽计费接口，不创建凭证或修改套餐。

实现`418ac9b`、公开索引修正`b464600`已推送；后者Cloudflare CI `39017767928`成功、部署跳过，Pages CI `39017767922`部署成功。自动审核服务临时故障期间请求未执行，恢复并核验CI后仅执行一次审计：UTC窗口2026-10-17 00:00:00至09:57:59.639，完成于09:58:01.631；实际管理HTTP 2/12，无重试。Workers请求估计值216、平均sampleInterval=1.180327868852459；D1同UTC日读28,126行、写17行，只有日期粒度，采样状态unknown。合计不归属任何单独项目。

Workers/D1 Free状态均unknown；两数据集计费等价性、管理面覆盖及摄入延迟未获证明，均complete=false、remaining=null。不能据此证明当前精确免费余量；未调用更宽接口补齐。参考Free日上限不是当前套餐证明，本轮不启动采样/上传/AI，不改变生产API关闭状态或账号计费。

私有证据位于`.local/cf03/quota-audit-20261017/`的`run-start.json`、`ledger.jsonl`、`workers.json`、`d1.json`和`summary.json`，目录0700、文件0600；operator只使用原项目.env与已有注入认证，核对账号一致，不读取所有者key。独占标记与账本必须保留，该operator不得重跑。本轮新鲜预检837读/0写的独立证据仍在第13节所述目录，不与本次账号汇总或HTTP数量混算。下一步见CF-03计划16.2及开发计划；本文件继续不纳入公开文档白名单。


## 正文包消费交付与静态站发布（2026-10-17 收工）

当前功能提交`839eb5e`已推送；Cloudflare CI `39024048769`与Pages CI `39024048789`均成功，前者构建artifact且自动部署按配置跳过，后者回退站部署成功。随后使用现有受控helper实际发布主站静态资源，私有发布日志为`.local/cf-static/deploy-cfBKPv/deploy.log`。本轮发布仅含静态站和文档；Node正文包消费代码已提交供开发使用，未部署业务后端、启用生产API或更改计费。

主Agent与Sol/high独立审阅通过；完整258项Node、8项Python测试零失败/零跳过，disabled构建1280页、公开产物1318文件、静态资源1304项及真实secret扫描1449文件零命中/零不安全文件。首次Node远程验证在超过1000项后遇到单资源网络超时；保留该失败日志，最终使用curl HTTP/2完整复核1304个不同规范URL，全部200。34个GET样本的预期内容与MIME通过，覆盖全部12份文档HTML/raw、首页/账号页/书页与资源；文档索引逐字对照已部署提交的public索引，本机随后重建的索引只有generatedAt不同，内容版本相同。缺失页、`/api/health`、`/api`均404，runtime为disabled。主站及Pages的交接文档均与提交逐字一致。

完整私有receipt、逐项HEAD、GET比对和首次失败日志位于`.local/cf-static/release-839eb5e-20261017/`，目录0700、文件0600；不删除或改写失败证据。此运维记录不加入网站文档白名单，因此后续仅提交本文件不需要再次部署静态资源。当前公开部署对应功能提交`839eb5e`，本轮已完成发布验收。

下次从开发计划顶部“2026-10-17 收工交接”继续：本机包准备、显式版本选择、问答及章节/全书总结消费已实现；下一步为统一原子预算authority与正文云同步设计、CF-03两次实际满批维护验收，再按新鲜R2证据及安全门槛安排逐文件同步和有效任务Key接入。没有选择真实书籍、修改pins/原manifest、迁移私人数据库、启动常驻后端、上传原书/正文或调用真实模型；不重跑既有审计或采样operator。回退办法见开发计划，旧私人数据与证据保留。
