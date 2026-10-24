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

补充验证分工（2026-10-24）：browser_fixture（gpt-6-luna/medium）只运行已有本机合成DOM/电子书夹具，尝试用已安装Chrome headless与本项目独立临时profile完成实际浏览器引擎验证，不访问用户Chrome资料或生产API、不读取密钥、不新增产品实现。主Agent独立审查输出与失败，CUA不可用不重复要求用户开窗口；headless通过只能证明所执行合成场景，不记为生产视觉验收。

主 Agent 独立review并验收：真实SQLite并发最后一槽、同hash/双点击一次PUT、未知claim/PUT保留、20MB/格式/DRM拒绝、未登录/Origin/CSRF、NULL旧normal不误读、首本+新五格式目录/详情/Range/阅读、trash/restore不释放预算、来源冲突拒绝及会话撤销。离线合成通过不能称真实上传。按development-plan顶部本轮发布验收方法，完成生产TS合成DOM回归、完整回归/两构建/隐私检查后commit→push→CI；真实浏览器工具不可用保留为明确未验收项，不冒充通过。固定生产目标、DDL/启用/逐文件HTTP清单及硬上限由实际实现确定再审。真实上传通过后独立目录/全文hash/阅读验收。失败静态回退并关闭policy，保留全部对象/责任/unknown/收据；新增上传后禁止回退到只看首本、看不到新责任的旧业务代码。

## 固定运维顺序与请求上限

### 静态绑定保留修复（2026-10-24，Sol/high）

真实旧profile静态发布暴露了 Wrangler assets-only 的上传元数据早返回分支：它省略全部 bindings 和 keepSecrets，导致已部署静态版本未保留secret。auth已关闭、013尚未执行；主Agent负责核验历史不可变版本后恢复原版本绑定，不重写secret。修复范围仅是静态发布写入固定私有passthrough模块并设置main与ASSETS，强制使用正常Worker元数据分支；保留精确前后配置核验，不启用keep_vars、不继承DB/R2/业务vars，不更改API能力。API现有main继续走keepSecrets分支。验收执行当前安装Wrangler真实getBindings/serializer，证明旧assets-only缺陷、新静态元数据包含ASSETS与仅secret保留类别、API元数据保持明确DB/R2/vars；再运行旧静态/v2/隔离部署及鉴权回归。发布与回退均由主Agent在本地独立验收后操作；失败保留auth关闭、原不可变版本和全部私有记录。

### 独立一次性绑定恢复工具（2026-10-24，Sol/high）

父任务明确分配 `scripts/cf-static-binding-recovery.mjs` 与独立测试；静态修复批次保持冻结。只恢复本项目static user-worker的四secret绑定能力，不读取远端secret值、不使用或发送业务secret值，不改D1/R2，不执行013，不开启auth/policy，不调用AI或原文件PUT。开发Agent仅离线实现，任何真实动作留给主Agent独立review后执行。

固定来源版本 `aaa7a94f-6478-4d76-aa65-03a3d2461d25`，固定当前latest assets版本 `08d46159-f7a7-4eec-b47c-30a9502aad2c`。预览0 IO。执行前在本项目账号内核验production D1身份、旧来源不可变版本精确trial+filename-AI绑定、settings精确空、当前部署100%固定来源、latest列表首项固定assets版本，以及固定auth/session schema与production enabled0/generation2、无未撤销会话。auth只SELECT安全字段，不读verifier；不加载独立owner/session/upload secret文件，不读取远端secret值，不使用或发送业务secret值。现有环境加载器会解析整个项目.env（可能含AI key），控制面请求仅使用现有deployment token。所有项目身份来自现有固定账号、deploy配置和单次target记录。

不调用Wrangler deploy：已核对实际源码存在version upload的 `retryOnAPIFailure`，不符合恢复工具单次保证。使用有界直传，先持久不可复用全局claim与单次intent，再最多一次版本POST `/versions?bindings_inherit=strict`；固定module、ASSETS、四个 `{name,type:inherit,version_id:固定来源}`，`keep_assets:true` 保留previous-upload静态assets，不使用全局keep_bindings或secret_text值。此字段已有官方multipart文档支持，显式version_id已有官方SDK类型支持；实际安装Wrangler serializer须离线证明输出一致。版本响应确认ID（如附bindings则同时精确核验），独立immutable GET必须精确验证ASSETS+四secret后，最多一次固定`?force=true` deployment POST到已独立核验的新版本100%（主Agent明确同意，避免旧secret代际差异；不是重试/fallback）；再独立deployment GET、deployed immutable GET、settings GET和auth只读核验。总上限13 HTTP（6前置只读、1版本POST、1上传版本GET、1部署POST、4最终只读），2 Worker mutation，D1/R2写0。每个请求有超时/体积/重定向边界，无自动重试。版本上传或部署未知立即停止，不重放、不清claim；失败不自动部署旧版本或改secret，保留原不可变来源和所有收据供主Agent审阅。

专项验收：真实安装serializer输出明确固定version_id且无秘密值、正常13请求路径、任一前置漂移阻断全部写、版本响应/独立GET错误不得部署、上传/部署未知不重试、并发与换run不能复用全局claim、postflight绑定/版本/auth漂移保留未知记录、路径权限与响应超时边界。主Agent审阅通过后才发布工具；真实恢复结果不能由离线测试代替。

### 新版版本API恢复（2026-10-24，Sol/high；主Agent已审阅并批准离线实现）

旧工具真实第7请求已尝试1次version upload，0 deployment，结果unknown；原run、全局claim和未知责任永久保留，不重放原multipart payload。其迟到结果只能新增未部署版本，不能自行接管流量；不把该unknown扩大为禁止另一个经过主审、不同接口及明确payload的新版本发布。前述旧工具方案保留为历史，不能继续作为固定版本继承的可执行契约。

这次一手文档核对发现：旧[Script Version Upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)明确只允许inherit.version_id使用latest，固定UUID会报10057；[新版Create Worker Version](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/)才允许固定UUID，且路径worker_id可直接为项目名称。SDK旧注释和serializer只证明字段能发出，不能证明旧端点接受；旧请求实际HTTP状态和错误码未保留，故10057只是与契约吻合的原因推断，不据此把unknown改为已拒绝。[Direct Uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/)明确允许Version使用keep_assets，不能声称keep_assets本身不受支持；新版JSON API未列此字段，候选方案不猜测省略assets的继承语义。

新工具 `scripts/cf-static-binding-recovery-v2.mjs` 使用独立私有目录/全局claim；旧工具仅增加四个现有验证函数的export供复用，执行行为及旧claim不变。仅固定账号及the-shelf路径，不列账号Workers，不GET包含其他Worker references的Worker对象。六个前置检查沿用旧工具：旧不可变AAA7版本精确14绑定、settings空、production D1身份、当前100%AAA7部署、最新版本仍08、auth关闭generation2且无未撤销session。旧source读取继续使用已经核对的script immutable GET，不新增含secret值或关联资源名的读取。

固定沿用已保存disabled artifact `.local/isolated-upload/static-fix-disabled-dist`，冻结1312个公开文件、12,516,770原始bytes，以及按路径排序的 `{path,hash,size,sha256}` 全清单SHA256 `6af1677ac59cd57db7c6498453f01e0a33b6fffde4e0e0f7ac05b57ec0e6da8f`。manifest hash必须与实际安装Wrangler的hashFile离线对照（base64内容加文件扩展名的BLAKE3前32 hex）；严格无symlink、无隐藏/私有/书籍/数据库文件，固定公开扩展名，runtime.apiMode=disabled，执行前全文复核冻结清单。先持久新工具不可复用asset-session claim，第7请求最多一次 `POST /workers/scripts/the-shelf/assets-upload-session` 提交该固定完整manifest，JWT仅在内存使用、不打印、不保存明文。主Agent明确批准缺失公开asset的bulk及single上传：每个hash严格属于冻结manifest、全bucket无重复、全部请求原始bytes合计≤20,000,000。bulk最多16个非空bucket，按序每bucket一次 `POST /workers/assets/upload?base64=true`，session JWT鉴权、hash作FormData key/文件名、base64内容及与实际Wrangler一致的公开MIME；single-asset模式先flatten，必须全部hash总数≤16，按序每hash一次 `POST /workers/assets/upload/<hash>`，只发送内存中已冻结原始bytes及明确MIME。先验证完整计划、JWT模式/时效并持久每请求claim，才发送。仅这两个asset endpoint允许200或201，其他请求仍strict200；中间响应不要求返回JWT，收集最后非空completion JWT，全部完成后必须有效。空buckets不受模式flag限制，直接使用session返回的completion JWT。任意unknown立即停止，不重传、不换manifest、无自动fallback，换run不能复用本工具的任何上传权限。

全部asset请求完成后，最多一次 `POST /workers/workers/the-shelf/versions?deploy=false`，JSON明确包含 `main_module:static-worker.mjs`、固定passthrough模块的 `{name,content_type,content_base64}`、兼容日期、`assets:{jwt:新completion token,config:{html_handling:force-trailing-slash,not_found_handling:404-page}}`、ASSETS及四个AAA7固定UUID inherit；路由配置与原静态部署一致，冻结artifact无 `_headers`/`_redirects`，不丢弃已有特殊模块。没有keep_assets、keep_bindings、DB/R2/业务vars或secret_text值。先持久新工具不可复用attempt claim及单次请求intent；不调用Wrangler deploy，不自动retry。独立新版immutable GET `.../versions/<newID>?include=modules`核验ID、精确五绑定、main_module及固定模块全文/hash后，才执行单次旧deployment API `?force=true`、100%明确newID。随后依次独立deployment GET、旧script immutable GET、settings GET及安全auth SELECT，均精确核验。总上限30 HTTP=14基础请求+最多16 asset POST：6前置只读、1 asset-session POST、≤16 asset POST、1新版version POST、1新版immutable GET、1 deployment POST、4最终只读；非查询控制面mutation POST最多19（session1/asset16/version1/deployment1），另2 D1只读query POST，即总HTTP POST最多21；仅固定公开asset bytes≤20,000,000，私人/书籍bytes0，D1/R2写0。任何mutation未知立即停止且不重放；asset session不能自动换manifest，version未知不能自动deploy，deployment未知不能自动回退。

独立 `scripts/cf-recovery-transport.mjs` 只允许记录数字HTTPstatus和最多32个安全整数Cloudflare错误code，不含statusText、headers、URL、message或raw body；拒绝响应前保留status，并在30秒、1MiB、4096 chunk、无重定向边界内读取JSON错误code。默认strict200，只有明确asset调用允许201；保持业务envelope严格校验、无自动重试，不修改共享wrapper或旧run。验收覆盖200正常、201默认未知及asset特例、400错误code、500、脱敏、超长/坏JSON/重定向/超时和不重试；新工具另验固定name端点、JSON精确body与deploy=false、manifest hash/MIME与实际Wrangler一致、固定路由、bulk/single顺序上传、16请求/20MB上限、外来/重复hash拒绝、空bucket completion、JWT不泄漏、独立模块/绑定核验、并发claim及全部未知状态不重放。CI通过纯依赖注入测试合成assets，CLI不暴露路径或loader选项，生产始终执行固定路径与全清单hash核验；本机真实冻结公开artifact加载另作只读验证。开发子Agent仅离线实现，主Agent负责独立review、提交/CI和真实执行；失败保留auth关闭与全部unknown，deployment未知时先由主Agent只读核验真实active版本，不自动部署或重写secret。

具体生产操作由主 Agent 独立审核执行；此分工只开发和离线验证。所有命令 run ID 使用新的唯一值；generation、row hash、version 从独立真实观测填写，不能猜测或重放未知写请求。固定 consent 文件 `.local/isolated-upload/consent.json` 只接受脚本中的完整已批准文本、固定账号/production数据库/authority/隔离桶，0600，不能用任意调用者 hash 代替批准。

1. `node scripts/cf-production-auth.mjs status --execute --run-id <id>`：3 HTTP；随后 `close --execute --run-id <id> --expected-generation <g> --expected-row-sha256 <hash>`：4 HTTP、1 auth CAS，撤销全部会话。
2. 先构建 disabled 静态 artifact，按当前已核验旧 trial+filename profile 执行 `node scripts/cf-deploy.mjs --static-rollback --single-trial --filename-ai`：2 显式 settings GET，无 D1/secret/R2 写；Wrangler 内部 HTTP 单独不计。
3. `node scripts/isolated-upload.mjs install --execute --run <id>`：41 HTTP，20 单条 DDL（3 临时锁、14 固定 migration语句、3 删除临时锁），0 data mutation；要求精确009、auth关闭、前后七组旧数据快照一致、新 target_id 全NULL、全schema独立回读通过。任何 DDL未知立即停止，保留不可复用 install claim 和锁；不自动修复或重放。
4. `node scripts/isolated-upload.mjs seed --execute --run <id>`：4 HTTP、1 policy INSERT，固定 enabled0/generation0；不能重seed。
5. 构建 same-origin API artifact，执行 `node scripts/cf-api-deploy.mjs --profile production --single-trial --filename-ai --isolated-uploads`：5 显式 HTTP（D1身份1、settings前后2、完整schema/authority/accounting/trial/policy前后2），无 secret/R2 写；部署 intent/receipt 保留，codeVersionVerified=false，Wrangler内部请求不计。新 profile 不接受 prepared/v2 混用。
6. 独立核对实际 Worker version，再 `node scripts/cf-production-auth.mjs enable --execute --run-id <id> --expected-generation <g> --expected-row-sha256 <hash> --expected-version <version> --single-trial --filename-ai --isolated-uploads`：实测11 HTTP，硬上限12，1 auth CAS；初始完整隔离观测在同条CAS中绑定，前后版本/settings/subdomain严格核对。policy仍保持0。
7. `node scripts/isolated-upload.mjs enable --execute --run <id> --expected-generation 0`：6 HTTP、1 policy CAS；settings前后精确一致，同条CAS绑定完整初始schema/accounting/trial/auth/policy观测；CLI结果保守保留 uploadAllowed=false，业务可用性由主Agent真实HTTP验收。随后真实上传另按主Agent的逐文件验收清单执行。

回退先用 `node scripts/isolated-upload.mjs close --execute --run <id> --expected-generation <g>`：4 HTTP、1 policy CAS，不读取 Worker配置或完整schema/accounting；enabled0也可 generation+1，保证迟到旧enable CAS失败。保留旧unknown claim，不能据此清除责任。仅policy close保留已确认读取和已claim确认；需要整体静态回退时再auth close及disabled artifact，使用 `node scripts/cf-deploy.mjs --static-rollback --single-trial --filename-ai --isolated-uploads`（2 settings GET）。之后只能恢复保留013的隔离版本，不部署仅识别旧首本的业务版本。
