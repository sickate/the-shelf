# 书籍上传交付：常规隔离上传最短方案

2026-10-24；upload_delivery：gpt-6.1-sol/high。主 Agent 审核后实施默认关闭的离线代码；常规隔离上传授权已记录于 AGENTS.md；生产开启与真实 PUT 等待主 Agent 独立验收及具体操作审核。本方案不依赖 010/011/012，不重开普通旧桶写能力。

## 一次需要改变的规则

8,000,000,000 bytes 数值不变：唯一 production D1 authority 的 committed+reserved+新预留必须原子≤8GB，包含全部已登记旧 unknown 和首本；20MB 单文件、private、未知不重试/不换 key/不释放责任不变。改的是不再要求新隔离上传证明未知共享账号实际总存储≤8GB、完整实时账号计费证据或所有旧请求终态。

已在 AGENTS“已授权的项目操作”记录新日期条款，仅覆盖旧段中“后续上传继续关闭/其他上传继续关闭”对**新模式**的限制，保留首本历史和其他旧入口关闭：

> 授权项目隔离常规上传。所有者在网页逐本选择并提交即授权该文件上传，不逐本聊天确认；单文件≤20MB，原唯一 production authority 全部已记账 committed+reserved+新预留≤8GB，包含旧 unknown 及首本责任，未知永久占位。接受共享账号完整用量、未完整登记的旧写责任及终态仍未知，不能保证共享账号实际存储≤8GB或零项目费用；仅免除新隔离模式对这些未知事实的放行前提，不将其改判 ready/已证明，不修改套餐。仅使用旧 CF01 不可访问的项目隔离能力。原首本许可已耗尽且不可复用；原桶旧入口继续关闭。

此前费用授权已有“可承担本项目合理超额费用”，本次不再次要求计费权限。新增同意已覆盖上述未知风险及8GB度量口径。

## 四项实现，直接复用已有上传流程

1. **当前 trial-009 + 新独立 migration**：1张 `shelf_storage_isolated_upload_policy`（固定身份/account/bucket、consent hash、8GB、enabled默认0；身份不可变、记录保留）；`browser_uploads` 增 nullable `target_id`，旧行保持 NULL，新行明确绑定该 policy。不设第二余额、不改 authority.phase=imported。精确替换3个guard：`import_admit`允许严格匹配新target/upload/descriptor且原子总责合格的reserved；`transition`允许该新target一次claim，保留旧ready规则；`original_guard`允许该新target已验证confirmed投影，保留旧staging规则。新增target行不可变/保留约束。原reserve/confirm/account/project触发器可原样复用：确认在同authority reserved→committed，建original_registry→file_registry；006 admission及004 projection已兼容此同authority confirmed路径。首本表、permit、计数完全不改。
2. **现隔离桶 + 显式新配置**：优先复用 `the-shelf-first-book-20261023` 的现 BOOKS binding（旧CF01不能访问；不新建桶/secret）。保留 SINGLE_TRIAL_MODE/target仅用于历史首本读取；新增 `ISOLATED_UPLOAD_MODE=project-v1`、`ISOLATED_UPLOAD_CONSENT_SHA256`，缺失/未知/不匹配关闭。新模式先永久404旧 single-trial operator。authority.identity.bucket仍为旧 `the-shelf-books`，绝不改身份来伪装同桶。
3. **真实上传及读取接线**：复用管理页 filename-only AI、可修正metadata、一次intent/一次bytes、PUT→HEAD→全文hash→HEAD和未知状态。新写只接受 policy target；旧normal `target_id=NULL`永远不路由至隔离桶。目录/详情只 UNION“已确认历史首本”与“严格join新target/upload/reservation/original_registry的confirmed新行”；任意同fileId跨来源冲突拒绝。`managedFileAccess`复用现HEAD/GET/Range及session/lifecycle复核，以新target映射绑定BOOKS；历史首本仍走原trial路径。metadata/回收站原路径复用且不释放预算；上传后在所有者私人目录显示，不公开原文件或私人metadata。
4. **有界安装/部署**：固定新migration和consent hash，只允许009精确前态→新精确profile；新profile暂由本模式专用helper识别，既有N2c工具遇到它拒绝，不改冻结helper。私有operator持久intent/收据、unknown不重放；DDL期间业务静态回退且auth关闭，独立全schema和旧责任/首本前后回读通过后再部署。生产启用须同时具备精确新部署配置+policy.enabled=1；没有用户同意时不能创建启用许可。

预计范围：新增 migration、`cloudflare/library/isolated-upload.mjs`、`scripts/isolated-upload.mjs`；窄改现 management/worker、cf-api-deploy/cf-production-auth/cf-deploy 的新profile/显式回退接线；新增 SQL/Worker/运维3份专项，必要时补现真实浏览器fixture。先在/private/tmp准备真实SQLite探针核对3guard及首本并存，再交主审；不改冻结N2b/shared/010/011/012，不先发任何生产动作。

## 验收、发布与回退

主 Agent 独立review并验收：真实SQLite并发最后一槽、同hash/双点击一次PUT、未知claim/PUT保留、20MB/格式/DRM拒绝、未登录/Origin/CSRF、NULL旧normal不误读、首本+新五格式目录/详情/Range/阅读、trash/restore不释放预算、来源冲突拒绝及会话撤销。离线合成通过不能称真实上传。按development-plan顶部本轮发布验收方法，完成生产TS合成DOM回归、完整回归/两构建/隐私检查后commit→push→CI；真实浏览器工具不可用保留为明确未验收项，不冒充通过。固定生产目标、DDL/启用/逐文件HTTP清单及硬上限由实际实现确定再审。真实上传通过后独立目录/全文hash/阅读验收。失败静态回退并关闭policy，保留全部对象/责任/unknown/收据；新增上传后禁止回退到只看首本、看不到新责任的旧业务代码。

## 固定运维顺序与请求上限

### 静态绑定保留修复（2026-10-24，Sol/high）

真实旧profile静态发布暴露了 Wrangler assets-only 的上传元数据早返回分支：它省略全部 bindings 和 keepSecrets，导致已部署静态版本未保留secret。auth已关闭、013尚未执行；主Agent负责核验历史不可变版本后恢复原版本绑定，不重写secret。修复范围仅是静态发布写入固定私有passthrough模块并设置main与ASSETS，强制使用正常Worker元数据分支；保留精确前后配置核验，不启用keep_vars、不继承DB/R2/业务vars，不更改API能力。API现有main继续走keepSecrets分支。验收执行当前安装Wrangler真实getBindings/serializer，证明旧assets-only缺陷、新静态元数据包含ASSETS与仅secret保留类别、API元数据保持明确DB/R2/vars；再运行旧静态/v2/隔离部署及鉴权回归。发布与回退均由主Agent在本地独立验收后操作；失败保留auth关闭、原不可变版本和全部私有记录。

### 独立一次性绑定恢复工具（2026-10-24，Sol/high）

父任务明确分配 `scripts/cf-static-binding-recovery.mjs` 与独立测试；静态修复批次保持冻结。只恢复本项目static user-worker的四secret绑定能力，不读取远端secret值、不使用或发送业务secret值，不改D1/R2，不执行013，不开启auth/policy，不调用AI或原文件PUT。开发Agent仅离线实现，任何真实动作留给主Agent独立review后执行。

固定来源版本 `aaa7a94f-6478-4d76-aa65-03a3d2461d25`，固定当前latest assets版本 `08d46159-f7a7-4eec-b47c-30a9502aad2c`。预览0 IO。执行前在本项目账号内核验production D1身份、旧来源不可变版本精确trial+filename-AI绑定、settings精确空、当前部署100%固定来源、latest列表首项固定assets版本，以及固定auth/session schema与production enabled0/generation2、无未撤销会话。auth只SELECT安全字段，不读verifier；不加载独立owner/session/upload secret文件，不读取远端secret值，不使用或发送业务secret值。现有环境加载器会解析整个项目.env（可能含AI key），控制面请求仅使用现有deployment token。所有项目身份来自现有固定账号、deploy配置和单次target记录。

不调用Wrangler deploy：已核对实际源码存在version upload的 `retryOnAPIFailure`，不符合恢复工具单次保证。使用有界直传，先持久不可复用全局claim与单次intent，再最多一次版本POST `/versions?bindings_inherit=strict`；固定module、ASSETS、四个 `{name,type:inherit,version_id:固定来源}`，`keep_assets:true` 保留previous-upload静态assets，不使用全局keep_bindings或secret_text值。此字段已有官方multipart文档支持，显式version_id已有官方SDK类型支持；实际安装Wrangler serializer须离线证明输出一致。版本响应确认ID（如附bindings则同时精确核验），独立immutable GET必须精确验证ASSETS+四secret后，最多一次固定`?force=true` deployment POST到已独立核验的新版本100%（主Agent明确同意，避免旧secret代际差异；不是重试/fallback）；再独立deployment GET、deployed immutable GET、settings GET和auth只读核验。总上限13 HTTP（6前置只读、1版本POST、1上传版本GET、1部署POST、4最终只读），2 Worker mutation，D1/R2写0。每个请求有超时/体积/重定向边界，无自动重试。版本上传或部署未知立即停止，不重放、不清claim；失败不自动部署旧版本或改secret，保留原不可变来源和所有收据供主Agent审阅。

专项验收：真实安装serializer输出明确固定version_id且无秘密值、正常13请求路径、任一前置漂移阻断全部写、版本响应/独立GET错误不得部署、上传/部署未知不重试、并发与换run不能复用全局claim、postflight绑定/版本/auth漂移保留未知记录、路径权限与响应超时边界。主Agent审阅通过后才发布工具；真实恢复结果不能由离线测试代替。

具体生产操作由主 Agent 独立审核执行；此分工只开发和离线验证。所有命令 run ID 使用新的唯一值；generation、row hash、version 从独立真实观测填写，不能猜测或重放未知写请求。固定 consent 文件 `.local/isolated-upload/consent.json` 只接受脚本中的完整已批准文本、固定账号/production数据库/authority/隔离桶，0600，不能用任意调用者 hash 代替批准。

1. `node scripts/cf-production-auth.mjs status --execute --run-id <id>`：3 HTTP；随后 `close --execute --run-id <id> --expected-generation <g> --expected-row-sha256 <hash>`：4 HTTP、1 auth CAS，撤销全部会话。
2. 先构建 disabled 静态 artifact，按当前已核验旧 trial+filename profile 执行 `node scripts/cf-deploy.mjs --static-rollback --single-trial --filename-ai`：2 显式 settings GET，无 D1/secret/R2 写；Wrangler 内部 HTTP 单独不计。
3. `node scripts/isolated-upload.mjs install --execute --run <id>`：41 HTTP，20 单条 DDL（3 临时锁、14 固定 migration语句、3 删除临时锁），0 data mutation；要求精确009、auth关闭、前后七组旧数据快照一致、新 target_id 全NULL、全schema独立回读通过。任何 DDL未知立即停止，保留不可复用 install claim 和锁；不自动修复或重放。
4. `node scripts/isolated-upload.mjs seed --execute --run <id>`：4 HTTP、1 policy INSERT，固定 enabled0/generation0；不能重seed。
5. 构建 same-origin API artifact，执行 `node scripts/cf-api-deploy.mjs --profile production --single-trial --filename-ai --isolated-uploads`：5 显式 HTTP（D1身份1、settings前后2、完整schema/authority/accounting/trial/policy前后2），无 secret/R2 写；部署 intent/receipt 保留，codeVersionVerified=false，Wrangler内部请求不计。新 profile 不接受 prepared/v2 混用。
6. 独立核对实际 Worker version，再 `node scripts/cf-production-auth.mjs enable --execute --run-id <id> --expected-generation <g> --expected-row-sha256 <hash> --expected-version <version> --single-trial --filename-ai --isolated-uploads`：实测11 HTTP，硬上限12，1 auth CAS；初始完整隔离观测在同条CAS中绑定，前后版本/settings/subdomain严格核对。policy仍保持0。
7. `node scripts/isolated-upload.mjs enable --execute --run <id> --expected-generation 0`：6 HTTP、1 policy CAS；settings前后精确一致，同条CAS绑定完整初始schema/accounting/trial/auth/policy观测；CLI结果保守保留 uploadAllowed=false，业务可用性由主Agent真实HTTP验收。随后真实上传另按主Agent的逐文件验收清单执行。

回退先用 `node scripts/isolated-upload.mjs close --execute --run <id> --expected-generation <g>`：4 HTTP、1 policy CAS，不读取 Worker配置或完整schema/accounting；enabled0也可 generation+1，保证迟到旧enable CAS失败。保留旧unknown claim，不能据此清除责任。仅policy close保留已确认读取和已claim确认；需要整体静态回退时再auth close及disabled artifact，使用 `node scripts/cf-deploy.mjs --static-rollback --single-trial --filename-ai --isolated-uploads`（2 settings GET）。之后只能恢复保留013的隔离版本，不部署仅识别旧首本的业务版本。
