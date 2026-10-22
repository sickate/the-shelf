# The Shelf 开发计划

## 2026-10-22 接续检查点

CI修正接续：最小兼容提交66d47e0已推送，Pages39770096434成功；Cloudflare39770096457在唯一deadline合成测试失败，尚未通过最终CI。原因是测试给整轮每请求5ms，CI负载下在preflight先超时、未抵达目标mutation，导致预期unknown写断言读到undefined；本地734/8全绿不能代替此远端结果。Sol/high只负责使deadline测试在目标mutation/body阶段确定性推进，保持生产30秒及所有unknown/零重试/安全断言不变，不skip或放宽测试；主Agent复审、独立专项和适用完整验收后提交新CI，原失败记录保留。本修正无云调用，版本契约阻断及上传关闭状态不变。

纯测试修正已完成并由主Agentreview：仅在durable mutation、实际body reader pull或迟到响应arrived阶段推进原30秒的mock timer，显式恢复时钟，原安全断言全部保留，生产代码不变。独立5项目标专项及再次完整734项Node/8项Python通过，零失败/取消/跳过；日志 `/tmp/shelf-followup-deadline-full-20261022.log`。随后按顺序构建/隐私/提交并等待新两CI，不将66d47e0失败改写成成功；下一接续以最新提交对应工作流为准。

实现提交 `50473337f5399f2be12d37cfbaaef46f684fd4cf` 已推送；Cloudflare CI `39766979379` 成功但部署跳过，Pages `39766979402` build/deploy 成功，Pages 开发计划与本地字节一致。主站 runtime 仍 disabled，API health 返回404；这些是静态站观测，不代表业务上线。

本轮最小后续修正：history 两字段经有界校验后全部消除，不改变 outcome/归属；独立15项、真实零网络 history 验证通过。观察到7 runs、24 requests、8 starts，`unknown=1`、`unattributed=1`、`unresolvedMutation=1`、`storageCompletedResponse=1`、`cleanupResponse=7`，不得据此宣称完整历史或 drain 已证明。仅 settings 读取接受精确 `placement:{}` 官方默认表示，并原样参与 hash；具体 version/create 与跨 metadata 精确比较仍严格，不将缺失归一为 `{}`。独立8项通过。私有 Wrangler 仅收紧 `workers_dev=false`，R2 绑定仍为 `[]`、preview 为 false，其余字段保留。

真实 status/诊断均为零 mutation。最近两轮各7个 HTTP 请求均在具体源版本的 HTTP 200 `candidate_invalid` 停止；有限诊断只确认 version 有固定官方 schema 外顶层字段，六个官方 lifecycle 字段均缺失，不输出未知字段名称或值。不要盲目重试或放宽 validator；尚未 create/deploy，R2 绑定回收未验收，旧 PATCH `unknown` 与六 guard 保留。最后确认 authority=`imported`，committed/reserved 均为0；书籍为0，API/auth/私人云阅读关闭。合格 R2 证据和 drain 证明仍缺。

主Agent复审后独立完整734项Node及8项Python通过，零失败/取消/跳过；按顺序构建、公开/静态/真实凭证检查后提交推送，最终发布状态以对应Git提交与工作流为准。后续先核对最新commit与CI，再研究官方契约外字段的兼容证明，以及settings默认 `{}` 与version缺失的语义；证据不足就继续拒绝，不重跑旧close/PATCH，不恢复旧写能力，不填ready或上传许可。

第一版已交付真实收藏书架、公开文档，以及可在本机运行的私人阅读与按需 AI 后端。CF-02 已将静态网站迁到 Cloudflare Workers Static Assets；GitHub 保存代码，GitHub Pages 保留为回退站点。业务 API、登录和私人阅读仍未迁移。

更新日期：2026 年 10 月 22 日。阶段：首版已验证；CF-01 评估完成、鉴权需适配；CF-02 静态迁移完成；CF-03 实现与主要安全测试完成，API 未发布；远端存储冻结已验收、空源账本已导入 imported，旧写能力闭包待验收，尚未上传书籍。

## 2026-10-22 后续任务：恢复发布与旧能力收回替代方案

目标与范围：接续本地 `2c74cc9`，先恢复GitHub发布和独立静态验收；随后解决固定CF01 Worker收回R2绑定的受支持方案。历史PATCH继续unknown，六guard、本机空R2配置和全部私有收据保留；不重跑close、旧PATCH、freeze或import，不上传书籍、不调用AI、不启用业务API、不改计费。R2完整用量证据及真正排空依然是ready和上传的独立前置。

方案与依赖：主Agent先只读核对远端HEAD及网络；只在远端无分叉时推送既有已验收提交，等待两CI并核对Pages文档/主站disabled。与此同时，Sol/high研究固定官方OpenAPI及现有部署/回读代码，判断受支持的版本创建/部署接口能否精确保留当前100%部署的代码、四个非R2绑定（包括secret）、metadata、annotations和入口，并为历史unknown提供独立闭合依据；不能使用latest、不能猜测HTTP400终态。先提交可审查设计及风险/请求预算，主Agent确认契约后再细化实现，未确认前不新增云写路径。若官方契约不足，保持固定拒绝并说明具体缺口，继续可独立完成的离线工作。

分工：主Agent负责发布恢复、计划、官方契约复核、集成及最终验收；替代接口和持久恢复设计分配 `gpt-6.1-sol / high`，范围仅固定CF01与相关离线测试/操作文档，依赖已保存unknown及固定资源。简单进度文档按需分配 `gpt-6-luna / medium`，依赖最终事实；不让文档代替真实验收。指定模型不可用不静默替换。

独立设计复核分配另一 `gpt-6.1-sol / high`：只读检查旧CF01源码/调度账本、既有transport和ready契约，确定能否形成可信历史终态/进程连接/排空证明；只研究公开契约及项目代码，不读取其他项目业务数据、不云调用、不启动/停止进程、不修改authority或私人状态。输出明确可实现的证据链与不可证明缺项，供主Agent决定后续实现，不能以布尔值或任意等待替代事实。

主Agent代码盘点发现本机 `cf-probe` CLI 的 `start storage`/`smoke` 仍可能读取配置并发送旧storage POST，尽管当前源码reserve/storageProbe已拒绝、远端guard也已生效。由上述Sol/high在设计交付后修正CLI：这两个入口在配置/锁/文件/网络IO前固定拒绝，内部start再作防御检查；历史poll/cleanup与crypto/Workflow诊断保留，不改私人evidence、云端代码和guard。用隔离临时fixture测试真实CLI及导出main，覆盖零IO/零fetch和原证据不变，再经主Agent完整验收发布；不对真实Worker发送负向探针。

验收与验证：新设计须明确逐请求durable intent、上传/部署未知不重试、独立版本/代码/绑定/入口回读、固定对象身份与请求上限、secret消除和默认零IO。实现后主Agent独立review、专项及完整Node/Python测试，再顺序disabled构建、公开/静态和实际凭证扫描。全部门槛及对应CI通过后才另记真实动作的固定有界计划；此阶段没有云写授权范围之外的试探调用，也不把新版本/绑定观察当作drain证明。

部署和回退：按commit→push→既有CI→线上静态验收推进；CF自动部署保持关闭，Pages仅静态回退。网络失败保留本地提交并记录未验收状态；实现失败可revert代码，不能恢复旧R2能力、删除unknown、清预算或回滚永久guard。新云动作如产生未知结果立即停止，只读恢复，不自动部署回旧版本。

先行发布恢复已验收：远端从6cebed0推送至 `2c74cc94ef0b291a31100400f9b05a4d01131b23`，两CI `39739955059` / `39739955068` 成功；Cloudflare部署skipped，Pages build/deploy成功，公开开发计划字节与2c74cc9一致。curl回读主站runtime仍disabled、API health404。未重跑任何CF01云写、迁移、AI或上传。

替代方案已由主Agent对固定OpenAPI版本创建JSON、具体UUID inherit、部署force参数及字段schema复核，细节见仓库内 `docs/cf01-version-capability-plan.md`（不公开）。实施由Sol/high负责独立 `cf01-version-close` 工具的create/deploy/status、合成测试和操作说明；create固定最多18HTTP/1版本POST且deploy=false，独立验明后才由另一次deploy最多20HTTP/1部署POST（force=false）执行；status最多14HTTP/0云写。只从当前100%部署取源UUID，只从持久化成功create响应取候选UUID；未知创建不再创建、不自动解锁部署，候选UUID丢失不靠list猜认。未知部署不重放，只读独立能力观察。旧close仅允许新增冻结内部helper导出以复用私有文件/transport validator，不改变原运行行为、六guard/schema/hash或旧状态解释。

实施门槛补充：固定四个非R2绑定从具体源版本inherit，原模块字节/入口、受支持typed metadata及可写annotations精确保留，secret不读取/记录/重设。未知字段或assets/exports/migrations/containers等生命周期项出现即拒绝。共享storage-close锁，逐请求durable intent和0700/0600输入pin；新状态与收据独立，旧unknown只读，五expected hash原算法逐项匹配。API无CAS，单operator窗口及CI自动部署关闭是可信运维前提，预后回读只检测漂移，不声称阻止外部有权用户并发。当前只授权实施离线代码；真实create/deploy各在review、全验收及CI后另记有界计划再自动执行。

历史证据采集补充实施：CLI修正经主Agent专项19项通过后，同一Sol/high继续交付固定本机CF01历史检查器，仅以有界只读读取原evidence，保留全部请求序号与有限方法/路径/结果分类，不再丢掉无run ID的POST。默认preview零IO，execute也零网络，不读.env，不修改原证据，不推断缺失body的run归属；输出聚合及私有安全投影，显式标出unattributed/pending/unknown，readyEligible与drainProven始终false。复用已有私有pin/存储helper，原文本/secret/result_json不落输出；纯parser及临时fixture覆盖敏感哨兵、额外/缺失/畸形字段、文件/目录置换和证据不变。它解决采集缺陷，不实现positive-terminal新source、不接入authority或ready；完整回归/构建/隐私/CI及主Agent验收后才实际读取固定私有文件。

本轮实现已由主Agent独立review与验收：版本工具专项116项、历史检查器与旧close联合80项、CLI与core联合19项通过；完整723项Node及8项Python通过，零失败/取消/跳过。六guard及BASE_SCHEMA与HEAD逐字一致，旧close仅新增冻结helper导出及可选有界读取参数，默认2MB不变。所有真实CLI preview为零请求；GitHub中CF自动部署变量未设置，既有工作流继续跳过部署。当前尚无新CF01云调用、候选版本或部署；构建、隐私、提交和CI结果另记，不把本机全绿当实际绑定收回。

真实接续及兼容修正计划：5047333两CI和线上静态已通过。首次status在本机配置校验前0HTTP停止；主Agent仅用已验收privateStore把固定私有Wrangler的workers_dev由true收紧为false、前后回读，其余字段精确保留。随后status5HTTP只读，在initial-settings HTTP200因metadata_invalid停止，前四identity/schema/counts/deployment已观察；没有mutation或候选。history执行亦在输出前因两个历史扩展字段固定拒绝，原输入不变。Sol/high分别承担最小修正：history显式允许有界opaque operatorRecovery string并消除，不改outcome/归属/summary；官方Workflow InstanceStatus.rollback精确null或outcome/error形状仅校验并消除，其他未知字段仍拒绝。version先由Sol交付一次性受限诊断脚本方案供主Agentreview，在新status原14请求预算内仅投影已知metadata字段presence/type/固定enum/合法性布尔，不输出值/secret/annotations，不增请求、不改原validator；拿到事实后才对照固定官方契约另定最小兼容。两修正仍须主Agent独立review、专项/完整回归、顺序构建/隐私与新CI，再接续真实动作；当前create/deploy均未执行，imported、unknown、六guard及关闭状态保留。

诊断后最小修正目标：一次性诊断经主Agent独立7项合成验证后实际5HTTP/0mutation，确认settings无未知键，placement为精确空对象{}而非smart/off；其余出现的已知metadata均合法。Sol/high先确认固定官方schema的mode可选契约；支持时仅新增精确{}或原{mode:smart}兼容，空对象原样复制及hash，不归一为缺失、不接受off/其他placement目标。未知字段、精确metadata比对、五hash与创建/部署门禁不变，配合history修正完成新一轮review/回归/构建/隐私/CI后，再各记真实有界动作。

验证顺序细化：为避免把纯读取输入兼容问题拖到每轮发布后才发现，主Agent完成上述最小diff复审与独立专项后，先将一次version status（仍最多14HTTP/0云mutation、共享锁与全新收据）及一次固定history（0网络/原输入不变）作为真实只读功能验收，任一新缺口立即停止交回Sol，不绕过validator。这取代上一段“所有真实动作均等CI”的只读部分；create/deploy等云mutation依旧必须完整回归、顺序构建/隐私、提交及两CI全部通过，并另记各自有界计划后才执行。此调整不降低任何云写/ready/上传门槛。

固定契约复核纠正：settings.placement含default:{}声明，但其ref的oneOf和Version的placement均有分支required，不能推断mode可选或create placement:{}合法。当前实施缩小为仅settings读取兼容精确默认{}；version/create validator及crossMetadata精确比较保持严格。一次性只读wrapper同时允许对原status本来要GET的固定具体版本作同一有限META投影，各类最多2capture，合计仍14HTTP、0额外fetch，不读取/输出modules值。取得源version事实后才另定默认表示对照或写body方案，尚未决定任何新云写。

## 2026-10-22 恢复开发：冻结续验、导入与旧能力收口

目标：从已提交的 `de20e30` 接续，先完成真实冻结负向验收和唯一账本的空源导入/独立回读，再以实际CF01库存为依据实现关闭旧写能力的下一步骤。当前只有schema/marker已实际确认，两个历史unknown仍保留，authority未初始化；本计划不把代码完成视为云端验收。

范围与依赖：主Agent先核对Git/CI，以全新run ID执行独立只读status；满足恢复门槛后，以另一新ID执行schema-freeze，要求两库精确拒绝及各自独立零行读回。通过后才以新ID执行import，并独立status确认phase=imported、预算及两库来源一致。CF01核查可独立进行，执行前仅收紧项目私有输入日志权限，不改写内容；固定14请求、硬上限16，无云写。随后根据真实库存落实storage-only admission关闭和固定Worker R2绑定收回工具，必须先完成官方接口契约核对、实施review及CI，再执行受控云动作。

分工记录：主Agent负责计划、真实操作、集成、独立review、功能验收和发布；安全/持久状态任务分配 `gpt-6.1-sol / high`，范围为CF01关闭能力工具、对应测试和操作说明，依赖真实audit输出及固定远端契约。简单交付文档整理按需分配 `gpt-6-luna / medium`，依赖最终验收结果，不修改私人证据。指定模型不可用即说明并暂停该分工，不替换为其他模型。

补充分工：另一 `gpt-6.1-sol / high` 独立核实官方R2纯汇总来源能否生成既有完整上传证据，仅研究公开官方契约与本项目代码，不调用账号管理接口；输出受限研究记录，供主Agentreview后决定producer实施，不能更改新鲜度、授权或上传门槛。

R2实施补充：官方固定 `GET /accounts/{account}/r2/metrics` 提供无桶维度的账号数字聚合；Sol/high在私有临时区先实现observer补充，总请求硬上限由2变3。先保留既有Volt条件核验，之后固定GraphQL及该GET；仅持久化已知数字存储字段，未知键拒绝、缺项保留null，不累加未证实互斥的published/uploaded，不保留对象数量或任意字符串。须经专项/完整验证、主Agentreview和CI才实际读取。接口未提供可信sampleAt/五分钟上界，不是合格producer；accountEvidence保持null、uploadEligible始终false。不得读取更宽订阅或放宽上传门槛。

实际接续检查点：已核对起点两CI成功；新status 15HTTP、冻结续验39HTTP/0DDL、空源导入67HTTP/0DDL及独立status 15HTTP均成功，authority现为imported，committed/reserved均0；两库schema与marker完整、历史unknown探针当前无行，但原unknown不改判。CF01首轮audit在第6请求因服务绑定environment=production的合法平台格式停止；Sol已根据官方契约补齐只接受缺失或精确production的兼容，主Agent独立41项专项通过，正进行完整验收，提交/CI后再运行新audit。此检查点仍无写能力闭包、无合格R2证据、无书籍上传或业务启用。

后续实际验收：兼容检查点 `5c0a25d` 完整516项Node/8项Python、disabled构建/公开/静态/真实凭证检查均通过并推送，两CI `39725030540` / `39725030531` 成功。新CF01只读audit14请求成功，取得两个固定历史版本、两轮库存一致，storage墓碑1/活动0/孤儿0，入口关闭；这仍不证明历史执行版本映射或在途排空。Sol/high下一工具固定最多32请求、6条storage-only guard DDL、1条新拒绝探针、1次仅移除固定R2绑定的settings PATCH；保留其他绑定/代码/metadata并独立回读。D1未知写按独立status恢复，Worker PATCH未知没有31秒终止推断，只有无R2且与预登记安全hash全部匹配的独立status才可零PATCH继续；原unknown保留。主Agentreview要求修正未知PATCH恢复、完整identity guard和矛盾envelope矩阵后再验收。ready/routes完整性/drain继续不授予。

最新真实状态（`6cebed0`）：关闭工具及R2观察补充经主Agent独立590项Node/8项Python、顺序disabled构建/公开/静态及1484文件真实凭证扫描通过，两CI `39726393168` / `39726393083` 成功，CF部署步骤仍跳过。CF01先行status9请求通过；close25请求已落地六条永久storage guard并通过新探针精确拒绝与独立零行读回，但settings PATCH返回HTTP400，按unknown保留并停止。本机私有Wrangler R2项已关闭；随后独立status7请求确认六guard、R2绑定仍存在、storage墓碑1/活动0/孤儿0，因patch_resolution_required阻断，**不得再次运行close来重发PATCH**。官方请求契约核对与后续终态证明另行处理，不能凭400/等待31秒补判原请求失败。CF03独立status15请求再确认imported、committed/reserved均0。R2新observer真实3请求成功，但REST无sampleAt、GraphQL最新样本约滞后32.5分钟，completeCoverage=false、plan=unknown、accountEvidence=null、uploadEligible=false；零观察不推断为完整账号零用量。

下一接续门槛：保留CF01未知PATCH、六guard、本机关闭配置和全部收据，先完成官方settings请求契约及可信未知终态的核对，不能重放原写或恢复R2项；现有status只可云端只读观察，不会自动解锁。可信在途排空、routes/本机进程连接闭包与合格R2证据仍缺，authority保持imported；书籍上传0，API/auth/私人阅读关闭，主站仍为原已验收静态部署。不要再按下方历史交接从旧schema-freeze或旧audit开始重跑。

官方契约纠正与修复分工：Sol/high通过固定revision的Cloudflare OpenAPI确认，settings PATCH虽接受multipart JSON，但inherit的具体version UUID仅适用于Workers version endpoints；其他endpoint只接受latest。此前SDK注释不足以证明settings支持具体UUID。这是确定的请求契约缺陷，不能据此猜测旧400的实际provider code或改判unknown。Sol/high负责给所有入口的该PATCH分支加固定失败保护及离线测试、更新操作说明，保持已落地六guard及identity hash原样；不改成可能继承未部署版本的latest，不新增替代写路径，不重发旧请求。主Agent复审/整体验证/CI后交付，真实绑定收回留待有可信版本保留和未知终态证据的独立方案。

契约保护实现已由主Agent复审：全部PATCH构造和派发已删除，PATCH预算为0；仍有R2时，在六guard和本机配置冻结后、创建PATCH intent前固定拒绝。原unknown及五项expected hash的独立核验继续保留，六guard/BASE_SCHEMA与已落地版本逐字一致。Sol专项68项通过，主Agent独立完整588项Node及8项Python通过，零失败/跳过；测试数量变化来自删除已不可能执行的PATCH响应分支并补入零PATCH门禁。顺序disabled构建1280页、公开产物1318文件、静态资源1304项和实际凭证扫描1484文件均通过，秘密命中/不安全文件为0。此修正未再调用云管理接口，真实绑定收回和上传状态不变；接续不得把代码门禁视为云端闭包完成。

发布接续检查点：修正已保存在本地提交 `fcfb3d12c7a27ea2022e7d69f7ce5c171156c69f`。SSH推送连接被远端关闭，使用已有GitHub登录的HTTPS备用推送又因github.com解析失败退出；独立GitHub API核对也连接失败，主站runtime只读核对DNS超时。因此本次尚未确认远端收到修正、未取得对应CI或线上验收结果，不宣称已发布。下次先核对工作区和远端提交；网络恢复后推送本地检查点，等待两CI并核对Pages静态文档及主站disabled/API404。不得借发布恢复重跑云端close、旧PATCH或上传。

验收与验证：先运行迁移/CF01专项，核对私有输入和历史状态，再真实status→freeze→import→独立status；任何unknown立即停止受影响写入，只读恢复。新实现须覆盖默认零IO、固定资源/预算、逐请求durable intent、未知写不重试、独立回读、身份/配置漂移及秘密消除，主Agent独立审查并运行完整Node/Python、disabled构建、verify:public/static和实际凭证扫描。CF01库存只证明观测；无可信历史执行版本和终态排空证明仍禁止ready。R2新鲜完整证据不足则不上传，不手写许可，不重放旧probe。

明确不做：不修改已落地SQL003/004、不删除历史unknown/预留/收据、不解冻旧入口、不改计费、不将paw改成生产服务器、不扩大账号读取、不启用生产API/auth或私人阅读。后续上传依赖ready与合格R2证据，未满足不得越过。

部署与回退：新实现通过主Agentreview和全部适用验证后，commit→push→既有CI；CF自动部署仍关闭，Pages仅发布静态回退，主站沿用已验收静态部署。经CI确认后才运行新受控关闭动作。失败保留冻结、imported、全部账本事实和私有证据，停止operator并保持auth/static业务关闭；代码可revert，旧写能力不恢复。交付分别记录本地验证、CI、真实数据库/能力观测及线上状态。

## 2026-10-22 收工交接：保存全部代码与文档

用户要求今天到此，先记录进度并提交全部代码和文档。本轮只做收工review、本地验证、文档导出、提交推送和既有CI核对；不再执行真实schema冻结、导入、CF01管理核查、AI调用、R2上传或手动部署。私人 `.env`、`.local`、原书和数据库继续忽略，不纳入Git。

真实状态：书籍上传0本；业务API、登录与私人云端阅读未启用，主站仍为已验收的 `9963771` 静态部署。AI Key已用合成材料实测，`gpt-luna` 文本与JSON均200；不是书内AI业务已上线。两个固定D1的schema和冻结标记已实际读回，但冻结负向验收尚未通过，authority为 `uninitialized`，尚未导入或ready。两条未知probe保留，最后独立status确认它们当前均不存在，两库旧预留和文件登记计数均0。R2汇总观察不满足新鲜完整证据门槛，仍禁止上传。

本次保存代码：有限错误语法诊断、官方Workerd精确extended约束格式兼容、每次新拒绝后的独立零行读回，以及CF01固定资源只读核查工具。CF01已按review补齐目录/收据身份检查和错误码白名单；工具默认preview零IO，最多16请求，关闭/排空/上传标志始终false。子Agent为Sol/high，主Agent已复审最后修正；完整507项Node、8项Python测试通过、零跳过，包含迁移24项和CF01专项32项，格式检查及真实CLI preview通过。工具尚未真实运行，精确格式兼容尚未经过新的云端负向验收，不将离线测试写成实际迁移成功。新离线冻结基线为141HTTP/100DDL，导入仍67HTTP；硬上限保持144/102及80。

下次从这里继续：先读本节、`docs/resources-and-access.md`最新收工记录、`docs/remote-storage-plan.md`及两个工具说明，核对已提交版本和远端CI。随后用全新run ID执行独立只读status，确认schema、冻结标记、两条未知probe和总计数；再按恢复门槛以另一全新run ID进行冻结验收，不覆盖收据或重放旧未知INSERT。通过后才进行冻结源导入和独立回读，先保持imported。CF01只读工具执行前须核验其私有输入权限，历史日志当前0644需在项目授权内改0600；只读库存本身不证明写关闭，固定storage admission关闭、旧绑定收回和可信终态排空证明仍须单独实施验收。最后补齐合格R2证据，再做单个中性对象、选定单本上传及云端阅读安全/浏览器验收。

回退和边界：保留所有原始证明、未知请求、冻结标记、预留、私人receipt和现有静态部署；不解冻旧写入口、不清零、不删除对象、不改计费。收工提交不启用业务、不部署新的Worker；既有Pages CI发布只代表回退静态站，不代表私人阅读上线。

## 2026-10-22 真实云端检查点与接续计划

`4e23dd3895145d4a2163f03354cd24324be8cf56` 已提交并推送，Cloudflare artifact 工作流 `39717347207` 与 Pages 回退工作流 `39717347250` 均成功。Cloudflare 自动部署仍跳过，主站静态部署仍为上一检查点；业务 API、私人云端阅读未启用，书籍上传数量为0。

主 Agent 随后实际执行固定两库的 schema 冻结：100条DDL完成，两个不可变冻结标记及完整schema已由独立只读 status 回读确认（check 56个schema对象、production 88个）。第134个请求为旧预留入口负向验证，返回未分类错误，按未知写保留并停止；不能据schema完整推断当次SQL拒绝已验收。authority 当前仍为 `uninitialized`，尚未导入，未执行R2 PUT。

同轮R2账号只读观察获得存储与操作汇总，但最新存储样本在读取时约24.5分钟前，账号存储是max而非总和，采样、覆盖和计费状态不完整。因此 `uploadEligible=false`，不把最新样本中的零值当作完整账号零用量。

接续任务与依赖：`gpt-6.1-sol / high` 补齐迁移失败的有界脱敏结构诊断、对历史未知探针的精确只读行计数及非零时撤销恢复检查点；主 Agent review、专项和适用整体验证、提交及CI后才执行增强status，不重放原未知INSERT、不修改已落地SQL003/004。另一 `gpt-6.1-sol / high` 独立实现固定CF01的旧写路径/历史代码/终态库存只读核查，默认零IO、最多16请求、每响应2MB/30秒；只读库存不作为关闭能力证明。之后另行验收旧写准入关闭和全部历史调度终态，完成账本导入及独立回读；完整闭包和合格R2证据具备后才可ready、单文件上传和云端阅读验收。

诊断检查点 `cf60690a138a1e294521f704327c8d7be2bdf772` 已推送，主Agent独立专项21/21、全套472项Node/8项Python、构建、公开/静态检查和1477文件真实凭证扫描通过，两CI `39718968993` / `39718969027` 成功。增强status以14次只读HTTP确认原probe精确计数及两库总数均0，原unknown保留。之后以新run ID进行固定冻结验收，32次HTTP、0DDL，在新check负向探针停止：HTTP400、数字code7500、含冻结与SQLite约束标记，但错误格式不匹配严格接受规则。再次独立status以15次只读HTTP确认两条probe当前均无记录，两库旧reservation/registry均0；两个unknown保留，authority仍uninitialized。不能将错误标记出现等同于原子拒绝证明。

下一诊断由 `gpt-6.1-sol / high` 实施：为最多8条错误增加不可逆的固定allowlist语法签名，已知错误词与ASCII标点映射成有限枚举，其他内容只记other；每消息最多64签名token、扫描和长度分档有界，绝不保留原文或可逆片段。此改动仅帮助识别provider wrapper，不能连接至拒绝接受条件。主Agent验证秘密/sentinel消除、截断及各种HTTP结构，连同CF01只读工具完成独立review/适用测试/提交/CI后，才按独立status恢复门槛执行下一次新ID负向验收，不重放两个原未知请求。

主Agent已直接核对Cloudflare官方Workerd `src/workerd/util/sqlite.c++` 的 `dbErrorMessage`：基本SQLite错误后可精确追加 ` (extended: SQLITE_CONSTRAINT_TRIGGER)`。因此允许Sol实现这一单一官方格式的严格兼容：仍要求HTTP400、顶层success=false、错误数组中的完整固定冻结错误精确匹配；只给新响应分类，不回改旧unknown。不是以token布尔推断拒绝，只有真实新响应完整命中已review语法才通过。其他前后缀、拼接、缺项、5xx和任何宽泛命中继续unknown；专项须覆盖这些拒绝矩阵。固定语法诊断仍不接入接受判定。

CF01工具主Agent专项及独立24项测试通过，但review发现私有收据父目录未固定inode、导出错误类型的code未白名单净化，交回Sol/high修复并复审；修复前不提交、不实际核查。补充父目录symlink/同权限目录置换以及敏感code注入回归，目录漂移不得继续dispatch，错误不得保留可控原文。由于已完成子Agent无法再启动新turn（工具报告agent thread limit），由当前仍运行的Sol/high迁移任务顺序收尾这两项，模型不替换。简单运维状态由Luna/medium完成并由主Agent复核。

失败及回退：保留未知请求、原始空源证明、旧库、冻结标记、全部预留和私人receipt；未知诊断缺失不事后猜测，非零库存另作预算审查。保持API/auth/static业务入口关闭，保留现有可用静态部署；修正代码后独立status恢复，不解冻旧入口、不清账、不改计费。下方此前检查点均保留为历史，以本节的实际云状态为准。

## 2026-10-21 检查点：静态发布、AI smoke 与远端迁移状态

2026-10-22 接续验证：按用户再次要求，重新读取生产接入指南（仍标注2026-10-20更新），使用已发布的有界 smoke 独立执行新一轮合成验证。无 Key 请求返回401；两次带项目 Key 的 `gpt-luna` 任务均返回200，普通文本与显式 `json_object` 输出均通过内容校验，全轮3个HTTP请求、2个带Key任务、没有重试。据此确认当前任务Key、`/v1/tasks` 与 `gpt-luna` 实测可用；`gpt-sol` 尚未单独实测。下文10月21日503未知结果保留为历史，不改写为当时成功。未发送书籍或私人内容。

当前实施收口分工：远端authority和SQL由 `gpt-6.1-sol / high` 完成严格导入、独立投影回读、取消与未知结果保护；迁移操作器由同模型独立完成固定资源的 `schema-freeze / import / status`，每请求预登记并允许未知结果后只读恢复；逐文件同步入口由同模型完成实际配置路径、选定版本、确定预留ID与只核对恢复。依赖顺序为authority稳定接口→操作器/同步入口→主Agent整合验收→提交及CI→真实数据库冻结和导入。导入保持 `imported`；完整旧进程、连接、CF01写能力及在途请求关闭证明另行验收后才可 `ready`。当前没有合格R2上传用量证据生产者，公开同步执行保持拒绝新PUT；不得用手写证据或迁移收据代替真实上传证据。检查失败保留静态站、冻结与全部预留，通过修正代码及独立status恢复，不恢复旧写入口。

第二实施检查点的主Agent review和本地整体验收通过：471项Node、8项Python测试零失败/零跳过，disabled构建1280页、公开产物1318文件、静态资源1304项及1477文件真实凭证扫描通过。已实现永久拒绝旧写入口、唯一远端预算adapter和SQL、固定资源冻结/导入/status工具及逐文件同步/核对入口。迁移工具离线空源验证为139次HTTP/100条DDL、导入67次HTTP；schema动作硬上限144请求/102条DDL，import上限80请求，超限或未知结果均停止。本段只记录本地验收；实际远端冻结、导入、ready、上传与云端阅读仍须各自执行和独立验收，不因测试通过而宣称上线。

提交 `9963771bbab02d0dc32f2d3dcb9ab22114ed09af` 已推送至 `main`。主 Agent 完成整合 review 与本地验收：398 项 Node、8 项 Python 测试通过，零跳过；静态构建生成 1,280 页，`verify:public` 检查 1,318 个文件，静态资源检查 1,304 项，真实 secret 扫描覆盖 1,463 个文件并通过。Cloudflare 工作流 `39620203325` 构建 artifact 成功（自动部署关闭），Pages 工作流 `39620203289` 成功。随后主 Agent 本机受控发布 Cloudflare 静态站并完成线上核验：runtime 的 `schemaVersion=1`、`apiMode=disabled`，`/api/health` 返回 404，AI raw 文档字节一致。此结果只证明静态站发布，业务 API 与私人阅读未上线。

真实只读 preflight 完成 14/18 项请求。固定 check identity/schema 有效，reservations、registry、auth 均为 0；production 实际应用 schema 为空。当前 manifest 的 `storageKey` 数为 0，本机预留为空且 lock 不存在。这些快照不能证明账本被冻结、已迁移或已切换为唯一远端 authority；`uploadAllowed=false`，本阶段没有真实上传。authority、旧入口关闭与 R2 只读 observer 仍在实现 review 中，未执行云端写操作。

真实 AI smoke 以未授权请求 401 通过，但首个带 Key 的 `gpt-luna/topic_analysis` 返回 503 `unknown`；第二个模型请求未发送。实际共 2 个 HTTP 请求、其中 1 个带 Key 请求，没有重试。因此真实模型任务尚未验证成功，不能据此确认模型可用。

本检查点继续按“先详细计划、复杂任务由 Sol / 简单任务由 Luna、主 Agent review 与验收、通过后再发布”执行。现阶段远端唯一预算账本、旧写入入口迁移关闭、逐文件上传及云端阅读均未达验收门槛；静态发布与上述离线验证不替代这些阶段的实施或验收。

## 2026-10-21 接续：AI 契约收尾、唯一远端预算与云端阅读

需求与当前差距：用户要求先固定本机各项目 Codex 开发流程，然后按依赖完成 AI/R2、远端预算账本/旧入口迁移、真实上传/云端阅读。当前已提交基线为 `6c8b230`，最新两 CI 成功，线上 `/data/runtime.json` 实测仍为 disabled；未提交的 `scripts/oai-smoke.mjs`、`server/r2-object-store.mjs`、对应测试及10月18日计划须接管审阅，不能按已验收处理。现有 SQLite authority 是离线参考，check/production 的独立 D1 尚不能证明共享预算。

通用流程：先需求分析和详细计划，再按难度分配子 Agent；复杂任务 gpt-6.1-sol / high，简单任务 gpt-6-luna / medium；主 Agent review、功能验证、必要修正复审通过后再合并、commit、push、部署和线上验证。本机通用约定写入 `~/.codex/AGENTS.md`，本项目保留更具体规则。主 Agent 负责集成与最终验收，不以子 Agent 自报代替证据。

范围与任务依赖：

1. **S1 AI 契约与 smoke（Sol/high）**：对照10月20日更新的服务方 guide，检查输入、instructions、output_format、模型别名、响应、840秒服务期限、全局串行、无幂等/查询、unknown语义与脱敏。修正现有 adapter、队列消费与测试；使用中性合成材料最多2次真实模型调用及1次无Key鉴权验证，先持久登记、无自动重试，结果分别记 pass/fail/unknown。不得把 kind 当业务提示词、缺失 usage 当零，或声称服务能联网获取作者资料。
2. **S2 R2 客户端（Sol/high，与S1独立）**：review 未提交客户端，核对当前官方条件写入契约；通过目标绑定、SigV4、HEAD/GET/PUT、If-None-Match/If-Match、deadline、取消、内容大小/hash/MIME、重定向拒绝、错误脱敏、无PUT自动重试及真实SQLite整链路合成验证。此步不上传真实文件。
3. **S3 远端 authority 与迁移（Sol/high，设计可先行，实施依赖S2）**：盘点所有项目旧写入口和既有专用资源；选定一个唯一远端原子预算实例，绑定账号、桶、authority与旧库身份。设计冻结、真实完整快照、未决预留保留、原子导入和独立回读、旧入口永久拒绝/显式转接、防双写、幂等恢复及检查/生产共用余额。先完成离线实现与安全review再操作云端；真实schema、停写与迁移结果另记私有证据。
4. **S4 单文件上传和云端阅读（Sol/high，依赖S1/S2/S3和生产安全验收）**：取得授权范围内新鲜完整资源证据，保留8GB总预算/20MB单文件门槛及逐文件计划；优先中性合成PDF/EPUB完成真实对象协议验收，再从既有私人映射显式选定符合预算的单文件上传，不批量扫描/上传。业务Workers/D1登录与同源阅读须满足实际套餐CPU/安全/关闭回退门槛；验证未登录拒绝、登录后全文/Range、禁止Origin、对象不存在与篡改、页码/章节定位和浏览器阅读。真实书籍不送AI，真实AI用S1合成材料独立验收。

明确不做：不修改计费/开通付费套餐，不扩读无关账号资源或私人数据，不把paw变生产服务器，不批量上传/自动删除对象，不清除 uncertain 账本，不扩大公开文档白名单；Workflows持久AI完整业务迁移另按依赖验收，不能以一次AI smoke声称已上线。

验收与验证：每项交付主 Agent 按设计、失败路径和安全边界review，修正后复审；运行必要专项、全套Node/Python、disabled静态构建、verify:public、verify:static和真实凭证离线扫描。远端账本须证明真实跨入口余额竞争不会超额、旧入口停写不可绕过、迁移快照/总量/回读一致、响应丢失仍保留预算。云端阅读须以实际HTTP/浏览器证据验收，不能以本机mock或静态站200代替。证据分为本地、远端CI、真实云操作与线上功能四类，缺失证据记unknown并继续不受影响的工作。

发布与回退：各可独立交付阶段通过review/验证后 commit→push GitHub→既有CI→受控项目部署→独立核验结果；Cloudflare静态CI默认仅artifact，业务发布须显式使用受控工具且绑定通过验收的版本。先保留当前静态部署，生产入口默认关闭；迁移冻结后失败不得重开双写，保留快照/预留，修正后幂等恢复。代码可回退至`6c8b230`或各阶段上一验收提交；不回滚已发生模型调用、云账本或删除真实对象。若资源接口/凭证/证据不可得，记录具体限制，完成剩余可独立工作后交接，不猜测成功。

## 2026-10-18 接续：真实 AI 接口验证与受控对象客户端

目标：按用户新授权，先用非私人、短合成材料验证配置中的 oai_api `/v1/tasks`，再继续上一轮未完成的同步客户端开发。上轮的 SQLite authority、迁移投影和内存对象验证已完成；远端唯一 authority、真实停写迁移与客户端尚未接入，不把它们记为上线。

AI 验证方案：由 gpt-6.1-sol / high 实现可复用、显式执行的有界 smoke 工具，主 Agent review 后在现有配置上运行一次。仅测试 `gpt-luna` 的 `topic_analysis` 与 `research_summary` 两种短任务，另至多一个无 Key 请求验证鉴权拒绝；总计最多 3 个 HTTP 请求、最多 2 次真实模型任务，逐个先持久登记再发送，不自动重试。发生超时、断线或 5xx 等不确定结果立即停止后续模型请求并保留记录。禁止重定向、禁止私人书籍/正文/历史、禁止打印 Key 或原始响应；仅保留安全状态、耗时、字符数、有限 usage 与内容检查布尔值，证据目录0700、文件0600；不变更真实任务队列或数据库。默认预览不发送网络请求，工具不纳入 npm test 的真实调用。

同步开发范围：由 gpt-6.1-sol / high 审查 Cloudflare 当前条件写契约，再实现供既有 `syncObject` 注入的固定桶 R2 SigV4 客户端；固定对象 descriptor/key，禁止列表、删除、批量、自动 PUT 重试及任意账号/桶切换，保持 20 MB 限制。HEAD/GET/PUT 的目标、条件请求、hash 元数据、MIME、流大小、deadline/取消、重定向和错误脱敏须通过合成 transport 测试及与真实 SQLite authority 的离线完整链路。客户端实现不自动打开旧上传入口，不执行真实 R2 上传，不建立第二套远端预算。

依赖与分工：AI 调用、鉴权、网络隐私与对象持久协议复杂度高，两个独立实现分别由 Sol/high 负责，主 Agent 制定接口、review、执行真实 AI smoke 与集成验证；必要修正交原实现者。远端 authority 和旧入口冻结/真实迁移的接入设计由 Sol/high 只读审查后单独确定，不在未验收状态下改云端 schema 或启用业务 API。

验收及发布：真实 AI 结果必须分别记录成功/失败/unknown，不以配置非空或 mock 通过代替真实验证；若凭证无效或服务不可用，保留具体安全状态并继续不依赖 AI 的开发。客户端只跑本机合成测试、不读真实收藏；完成主 Agent review、适用全套测试、disabled 构建、public/static 与实际凭证扫描后 commit→push→既有 CI→核验 Pages 和当前静态主站。回退工具/客户端代码至上一验收提交 `6c8b230`，保留所有私人证据、原书、数据库和 uncertain 记录，不自动重试已发送 AI 或 PUT；生产 API 仍关闭，本轮不改计费。

## 2026-10-17 接续开发：统一正文同步预算的离线实现

目标：实现供原书与正文包共用的唯一原子预算 authority，以及正文专用 registry/reservation 和可恢复的单对象同步协议。当前 check/production 使用不同 D1，既有 storage_state 不能证明跨库共享预算；本轮新增独立离线契约与实现，不把两个旧库直接当作统一 authority，不在现有上传入口旁新增可实际绕过预算的云端入口。

范围与方案：先审查旧账本及正文包契约，再固定 authority 身份、作用域与对象 descriptor；在同一数据库事务内检查 8 GB 总预算、20 MB 单对象及新鲜完整账号证据并持久预留，原书与正文均占用同一余额。正文使用独立 JSON 对象 key 和版本登记，不伪装原书；先保存预留再执行一次 PUT，超时、中断和响应不确定均保持全部预留，不自动重试 PUT 或按 TTL 释放；通过 HEAD→GET 实际 SHA256→HEAD 核对稳定对象后幂等确认。迁移必须从冻结旧写入后的显式快照导入并回读校验，不能将缺失库、缺失账本或未知状态当零。具体接口经 Sol 设计审查后实现，并把未接入真实部署的部分写清。

明确不做：不修改远端 schema、旧库账本、真实 pins/manifest/数据库/原书，不重放旧 CPU operator，不访问云端业务、上传真实对象、调用真实 AI、修改计费或启用 API；原书旧 CLI 不得宣称已完成统一迁移。云端执行与旧入口停写、身份绑定、生产适配和安全验收另设门槛。CPU 仍 unknown；私人同步契约与证据不加入公开文档白名单。

依赖与分工：本任务涉及持久数据、隐私与架构，复杂度高；gpt-6.1-sol / high 负责设计和具体实现，主 Agent 审阅设计、代码、失败路径和测试；另由 gpt-6.1-sol / high 独立安全审阅。先交付完整可验证的离线同步基础，再决定下一阶段真实适配，不以未完成云部署声称同步上线。

验收与验证：同一个真实 SQLite authority 下跨 check/production、原书/正文竞争不能超额；重复预留/确认幂等、状态和不可变 descriptor 不能漂移。覆盖过期/缺失证据、余额边界、重放、PUT 前后崩溃/响应丢失、对象已存在、内容 hash 不符、两次 HEAD 不一致、uncertain 保留预算。迁移使用合成旧库快照，验证完整性、重复导入、冲突、回读和未知预留不释放；正文使用真实共享包校验和合成 PDF/EPUB 包，不上传本机路径、源目录或正文至公开产物。主 Agent review 后运行全套 Node/Python 测试、disabled 构建、verify:public、verify:static 及真实凭证扫描。

发布与回退：离线交付达到验收门槛后 commit→push GitHub→既有 CI→核验静态主站与 Pages；Cloudflare CI 仍只构建 artifact，本轮无业务 Worker 发布需求。失败修正或 revert 本轮代码，保留现有静态部署及全部私人数据；未发布的新 authority 不自动替换旧账本，也不删除任何 uncertain 记录或对象。

整合 review（本轮）：接管另一会话停止后留下的未提交实现，不覆盖私人数据。主 Agent 与 Sol/high 独立审阅确认 sampler 两批证明的离线 40 项回归通过。存储 authority 发现既有 DB/sidecar 可通过硬链接写出 privateRoot 的问题，须拒绝 nlink≠1，验证外部文件不变；补齐真实多线程 SQLite 最后余额争用、同预留并发同步仅一次 PUT，以及提取器真实输出到同步确认的集成验证，再进行完整验收与提交。上述安全和持久数据修正由 gpt-6.1-sol / high 实现，主 Agent 复审；本轮仍不接入真实云适配器。

附带离线修正：按 CF-03 交接要求，把 sampler 的最终维护验收从“至少一轮实际满批”收紧为“两次实际满批”；仅预算预留两次、预置两倍 fixture 或 ordinal 命中不能替代真实删除差值。由 gpt-6.1-sol / high 实现，主 Agent review，覆盖仅一次、零次、部分批次拒绝与真实 Worker+SQLite 双批通过；保留全部请求、CAS、generation、analytics 和账本上限。本轮不执行 sampler 云端 operator；失败回退工具代码，旧证据不改写、不重放。

本轮实现与 review 已完成：统一 SQLite authority、原书/正文专用 registry、冻结快照投影迁移与回读，以及可恢复的单对象协议已交付；模块说明在仓库 `server/storage-authority.md`，未加入网站文档清单。主 Agent review 与 Sol/high 独立审阅后修复 DB/sidecar 硬链接越界，补齐 8 个真实 Worker 竞争同一库最后余额、同预留并发单 PUT、丢响应保留全部预算及真实合成 EPUB 提取→校验→内存对象同步→版本登记。全套 303 项 Node 与 8 项 Python 测试通过、零跳过，存储专项 35 项、sampler/manager 专项 40 项均通过。sampler 已要求恰有两次真实满批证明；这些是纯本机合成验证，CPU 仍 unknown，未执行云端采样或真实上传。

下一阶段接入门槛：先确定并绑定唯一远端 authority，证明全部旧写入口停写并产生真实完整快照，完成远端迁移/回读与 R2 客户端的 deadline、取消、目标绑定、条件写入及禁止 PUT 重试，再取得新鲜资源证据做单对象安全验收。现有原书 CLI、check/production D1 与业务 API 未切换，本机 `ready` 与迁移 receipt 不构成远端停写证明。持久任务和有效 AI Key 仍另行验收。保持原 manifest、真实 pins/数据库及原书，不清理 uncertain 或任何真实对象。

## 2026-10-17 收工交接：正文包本机消费已实现

本轮按用户要求提交当前改动并部署静态站，之后从本节继续，不再启动新功能或云端采样。当前实现包含共享严格正文包校验、中英文检索、`text:select`显式单文件版本选择，以及Node任务队列的版本快照、问答和章节/全书总结消费；页码/spine与版本引用随任务保留。原manifest、原书及私人状态不迁移；生产API、正文云同步、D1索引和真实AI仍未上线。

本次发布工作复杂度中等，由主Agent集成、验证和交接，gpt-6.1-sol / high独立审阅隐私、包契约与任务边界。当前全套258项Node、8项Python测试通过、零跳过，覆盖合成PDF/EPUB完整消费及模型mock。Sol/high独立审阅通过，相关24项测试独立复跑全过；disabled静态构建1280页、verify:public 1318文件、verify:static 1304资源通过，真实secret扫描1449文件零命中/零不安全文件。随后commit→push→既有CI成功→本机受控发布Cloudflare静态站→线上验证，同时保留Pages回退。上线结果以仓库提交、工作流和私有发布receipt为准，不把本机测试写成生产业务验收。若失败保留现有可用站点；需要回退时从上一已验收提交`7542d26`重新构建disabled静态包并受控发布，不修改私人数据库、版本包或已发生的云端账本。本轮不改计费、云端schema或业务Worker。

下次阅读顺序：AGENTS.md → 本节及下方“正文包消费与同步方案” → `scripts/prepare-text.md` → CF-03计划16.2。已选包的使用步骤是prepare预览/执行、text:select预览/执行，再重启本机开发后端；本次未替用户选择真实书籍、修改pins或启动常驻后端。来源、包或权限异常须明确失败，不扫描最新包或回退其他版本。

下次任务按依赖推进：

1. 为正文云同步制定统一原子预算authority与专用registry/reservation方案；现有check/production独立D1不能各自复制共享桶预算。先完成离线契约、迁移/回读及uncertain保留额度、HEAD→GET hash→HEAD核验的实现和测试，再安排真实同步。
2. CF-03离线补齐“两次实际满批维护”验收要求；新云轮另立有界计划并重新核验当时schema/基数/关闭状态、套餐限制与资源证据。不重跑任何已封存operator，CPU仍unknown。
3. 真实逐文件上传继续要求新鲜完整R2证据、20 MB单文件与8 GB总预算和生产安全验收；正文消费与持久任务、有效任务Key分别通过后，才推进CF-05真实AI。优先推进可离线验收的功能，不以未知免费余量停止全部开发。

## 2026-10-17 最新调整：先推进功能，必要时付费

用户最新指示：“没事，我们先提交，如果最后实在不行，我们就把超额部分付费就完事了。先尽量推进功能开发。”这取代此前绝对不增加现金支出和仅因免费额度证据不足而停止全部功能开发的要求。优先复用免费资源，确有必要时接受本项目的合理超额费用；本轮不新开套餐或修改账号计费，不据此读取其他项目或扩大账号数据权限。8 GB总预算、20 MB单文件门槛、逐文件上传及隐私安全规则继续保留。下文旧轮次的免费预算和停止记录保留为历史，不能据新指示重放已停止的云轮。

目标与范围：先保存本次决策与当前实现，再交付CF-04的本机正文准备首步。正文准备不必等待CF-03的生产CPU验收；云端上传、D1检索索引、线上阅读及真实AI仍各自验收。CPU P95 5ms保留为优化目标，不再作为离线功能开发的前置；上线时仍须验证所用套餐下实际CPU限制和错误行为，不能把付费意向当作验收通过。

方案与依赖：复用现有私人manifest和PDF/EPUB提取方式，新增显式选定单文件的本机准备命令，默认只预览、显式execute才生成私有版本化正文包；保留PDF页码/EPUB章节定位、来源指纹、分块及内容校验值。输出仅进入被忽略的.local，不改收藏源、旧manifest、数据库或公开catalog。没有正文、格式不支持或来源发生变化时明确拒绝，不以模拟内容代替。

复杂度与分工：正文工具涉及私人文件与未来持久数据契约，由gpt-6.1-sol / high实现，主Agent负责设计审阅、实际验证、集成和发布；约定与状态文档由gpt-6-luna / medium同步并由主Agent复审。

验收与验证：使用合成PDF/EPUB覆盖真实提取、页码/章节、分块和hash；覆盖路径越界/符号链接、原文件漂移、大小限制、空正文、损坏输入、无execute无写入、已有产物保护和0700/0600权限。运行全套Node/Python测试、Cloudflare disabled构建、verify:public及verify:static，不上传真实书籍或调用模型，不扩大公开文档白名单。

提交与部署回退：先commit/push本次决策并核对CI；工具交付后review、测试、构建、隐私检查通过，再commit→push→现有CI→线上静态状态核验。Cloudflare自动部署保持关闭；本轮本机工具无需发布业务Worker。失败修正或revert本轮代码，保留现有静态站和全部私人数据，不自动删除已准备正文或回滚云端账本。

先行决策提交 `cdc2b49` 已推送；Cloudflare CI `39017199977` 成功构建artifact、Pages CI `39017199956` 成功。原有206项Node和8项Python测试、disabled构建及公开产物检查通过。本机正文准备首步的实现与新增测试单独交付，不把前述基线结果记为新功能验收。

CF-04离线首步实现完成：`npm run prepare:text -- --file <fileId>` 默认预览，`--execute` 为单个PDF/EPUB生成私有版本包；包含PDF页码/EPUB spine位置、Unicode分块、来源指纹和内容/版本hash。来源与输出逐层拒绝符号链接、检查原文件漂移，已存在的完整相同包可复用，其他同名包拒绝覆盖；原manifest、收藏文件及数据库保持原样。Sol/high交付后，主Agent审阅并要求修正严格boolean执行参数、正常XHTML兼容及独立CLI成功路径；修正复审通过。新增15项专项及完整221项Node、8项Python本机测试均通过，零跳过，包含真实合成PDF/EPUB和独立CLI执行/复用。工具说明在仓库 `scripts/prepare-text.md`，未加入网站文档清单。该首步交付时，上传、D1索引和现有阅读/AI服务消费此包尚未实现；正文消费接续见下节，本机工具交付不等于CF-04全阶段完成。

实施按仓库根目录 `AGENTS.md` 的计划、分工、review、修正、验证与发布流程执行。主 Agent 负责规划、集成和最终验收；具体任务由主 Agent 评估难度后分配模型。下表模型与 effort 是建议起点，鉴权、安全、数据和 AI 的具体实现必须分配给 Sol；简单文档等任务可由 Luna 处理并经主 Agent review。实现完成、主 Agent review 通过、全部适用测试/构建/隐私检查通过后，达到本文迁移门槛的变更在既有授权内按提交、推送、现有 CI 部署、线上验证的顺序发布。

本次收工检查点（10月17日）：受控sampler与固定Cloudflare管理adapter已完成并通过192项Node、8项Python测试。新云轮因表基数超过预设上界在只读预检停止，没有业务请求或数据写入，CPU仍未验收。下次先从[CF-03实施计划第12.5节](https://github.com/sickate/the-shelf/blob/main/docs/cf03-plan.md#125-下次从这里接续2026-10-17收工检查点)读取交接，再按新鲜基数另立有界验收计划；不重跑已停止轮。该计划仅在仓库维护，不加入网站文档白名单。

10月17日接续：CF-03计划第13节独立只读预检已完成，Sol/high交付固定工具与14项新测试，主Agent review及完整206项Node/8项Python、构建/隐私检查通过；5f2c4b5已推送且两CI成功。新鲜schema/候选匹配，auth/active/入口/观测状态均满足关闭要求，13表计数完整；8管理/2D1请求实测837行读、0写。第14节独立采样计划计入预检后保守91,292读/10,516写，预算复核通过；共享账号Workers/D1当日余量缺完整新鲜证据，现有R2条件授权不自动覆盖其账号纯汇总，故未启用check或发送业务样本。补证边界及两次实际满批维护要求见CF-03计划14.1，CPU仍unknown、生产API仍关闭。

10月17日补证已执行：用户授权的Workers/D1账号纯汇总工具已通过234项Node、8项Python及构建/隐私检查，`b464600`的Cloudflare CI `39017767928`与Pages CI `39017767922`均成功，前者部署跳过、后者回退站部署成功。09:58:01.631 UTC完成一次固定审计，实际2次管理HTTP；Workers当日请求估计值216（平均采样间隔约1.1803），D1当日读28,126行/写17行（日期粒度、采样未知）。套餐、计费完整性与精确余量仍unknown，不据此启动旧采样轮。此前“授权待补”是历史；本轮无业务采样、上传、AI或计费变更。详细限制与私有证据入口见CF-03计划16.2。

后续任务顺序：CF-04正文包在本机任务/检索中的消费现已实现，接续统一预算authority与私有云同步方案；并行离线补齐CF-03“两次实际满批维护”的严格验收。两者均先立计划，涉及私人数据/安全实现由Sol/high负责、主Agent review。新云轮须另立有界计划并重验新鲜状态、资源与套餐限制，不重放旧operator；真实同步另需合格R2证据及逐文件安全验收，之后推进CF-05持久任务与有效AI任务Key。离线开发继续推进，生产API仍关闭。

## 技术与边界

当前静态网站采用 Astro 和 TypeScript，后端采用 Node.js 内置 HTTP 与 SQLite，导入使用 Python 标准库。运行需要 Node.js 24 及以上、Python 3.9 及以上；本机 PDF 文本准备可使用 pdftotext，MOBI 转换需可选的 Calibre。

迁移目标为 Workers Static Assets 托管静态网站、Workers 提供同源 API、D1 保存业务数据、Workflows 执行持久 AI 任务，继续使用现有私有 R2 桶。线上正文提取改为在 paw 导入时准备，再按文件选择同步到私有存储；AI 推理继续使用现有命名任务服务。paw 是开发和导入机器，不改为常驻生产后端。

代码与公开目录可以进入仓库；私人文件映射、SQLite 和原始私人状态留在被忽略的本机目录。云端仅同步业务必需的数据，密钥放入服务端秘密配置，正文与会话不得进入公开构建。保留现有 .local 人工修正、数据库和收藏源文件。

优先免费，确有必要时可承担仅属于 The Shelf 的合理超额费用；本轮不实际开通套餐或修改计费，付费意向不表示已开通或承诺费用封顶。保持单文件 20,000,000 字节门槛、逐文件上传和 8,000,000,000 字节 R2 总预算；原文件、正文、派生文件与同账号其他占用仍需计入。共享账号免费余量未知不阻断离线开发，但上传仍须具备新鲜、完整的R2用量证据并逐文件验收。

## 页面设计

书架使用暖白背景、墨色正文和少量朱红强调色。左侧分类导航，主区提供搜索、格式与可用性筛选、紧凑书籍网格和分页。封面默认由书名、分类和颜色排版生成，避免导入未经确认授权的图片。移动端把侧栏收起为选择器。

详情页提供面包屑、书名与作者、分类和格式标签、完整文件列表、私人阅读入口、书内提问、章节与全书总结、作者资料以及已发布结果。每个格式单独显示大小和状态；未上传不显示可下载。页面会根据后端登录与能力状态展示可执行的操作。

公开文档区有目录侧栏、可直接读取的正文、原文与合并原文链接。所有页面支持实际站点基路径，无 JavaScript 时详情和文档正文仍可读。

## 当前开发优先级

### 2026-10-17 接续：正文包消费与同步方案

目标：把已交付的私有正文包接到实际检索/问答数据路径，并设计其受预算约束的私有云同步。先由gpt-6.1-sol / high核对现有CF-03上传账本、包契约及Node任务队列，主Agent审阅后确定本轮完整可验收范围和接口，再分配实现。共享校验必须可在Node/Workers复用；明确选定版本，缺包、篡改或来源不一致时拒绝，不能扫描“最新包”或退回无依据内容。

边界：不重放旧CPU轮、不放宽8GB/20MB/逐文件和R2新鲜证据门槛，不改真实私人manifest/数据库/原书，不调用真实模型。本轮云端execute必须在对应迁移、原子共享预算、失败恢复、实际目标和证据齐备后才执行；不满足时仍完成可独立验收的消费/检索功能并如实区分代码、合成验证与云端状态，不让免费CPU优化阻断代码开发。计划细化后记录方案、依赖、验收与部署回退；适用全套测试、disabled构建、隐私检查通过后commit→push→现有CI→线上静态核验，业务API保持关闭直至独立上线验收。

方案审查后，本轮交付范围定为实际Node消费闭环：无Node依赖的共享严格包校验和中英文检索模块；独立私有版本选择文件及显式单文件激活命令；开发后端启动时读取选择快照，排队时固化选中版本、来源描述及fingerprint，问答/章节/全书总结消费校验后的正文并保留字符串引用与结构化页码/章节定位。版本选择不写原manifest、不扫描最新包；更换选择后重启开发后端生效。声明了版本而缺包、错源或校验失败时停止任务，不回退其他文件或旧正文。无选择的既有路径保持兼容。

依赖与分工：gpt-6.1-sol / high分别负责共享包/检索契约及Node消费/单文件激活，主Agent制定接口、review与集成。选择文件固定为私人stateDir下`prepared-text/pins.json`，目录0700、文件0600；激活默认只预览，execute才带并发冲突检查原子更新独立选择文件，现有manifest及其他选择保留。任务内部来源快照不进入私人API返回或主动发布白名单；对外引用仅返回必要定位和版本，不含源路径、完整正文或来源文件hash。

验收：真实合成PDF/EPUB经prepare与激活后，由实际后端/JobQueue执行问答及总结，只有模型HTTP使用mock；检查空页后的页码、spine、版本、分块覆盖及全部实际提示材料。缺包/篡改/错pin/源描述不符/符号链接/权限异常在模型调用前失败。相同版本在途去重、不同版本不合并、排队后改变默认不换源、重启保留任务内版本。检索验证中文罕见主题、大小写/全角归一及无相关内容拒绝，原文和offset保持不变。新版本提问的历史材料仅接纳相同文件与正文版本的已完成回答，不混用旧版本。启动只接受独立选择文件的声明，原manifest中的内部preparedText字段不能激活版本；引用投影逐层检查字段与原语类型。适用全套测试、构建、公开产物和真实凭证扫描后提交并验证CI及现有站点；失败revert本轮代码，保留旧站与全部私人数据，不自动清理版本包。

云同步单独迁移：既有上传器只能登记原书，不能伪造PDF/EPUB上传正文。正文需专用registry/reservation与JSON对象key，共用唯一原子预算authority；check/production当前独立D1各自的storage_state不是跨库原子预算，禁止为正文另复制一套预算。后续完成统一authority设计、迁移/回读、uncertain保留额度及HEAD→GET hash→HEAD确认，再在合格R2证据下逐文件执行。本轮不改变远端schema、Worker或R2，不把本机消费验收记为云同步完成。

任务按下表推进，保留阶段依赖。CF-01评估完成、CF-02已完成；CF-03仍为P1进行中、未验收，API仍关闭。5ms CPU是优化目标，不是离线功能开发前置；CPU分析器当前 `unknown` 仍为未知，不能改写为通过。CF-04本机正文准备首步可与CF-03并行开发，云端同步及生产阅读仍须各自验收；CF-05仍依赖CF-04、长任务验证及有效任务Key。真实上传仍要求新鲜完整R2证据、逐文件计划和安全门槛。详细CF-03记录仅在仓库维护，不加入网站白名单。

| 编号 | 优先级与状态 | 任务 | 前置依赖 | 建议模型 / effort | 交付与验收 |
| --- | --- | --- | --- | --- | --- |
| CF-01 | P0，评估完成 | Cloudflare 免费后端最小验证 | 无 | gpt-6.1-sol / high | 记录 Workers 登录计算、D1 持久化、私有 R2 绑定与模拟 Workflow 长任务结果，给出继续或调整结论；结论不代表生产登录已通过 |
| CF-02 | P1，完成 | 静态网站迁到 Workers Static Assets | CF-01 的静态部署与权限检查通过 | gpt-6-luna / medium（静态、CI 与 URL 验证）；gpt-6.1-sol / high（受控部署辅助工具） | Astro 静态站已发布至项目 Workers Static Assets；1303 项资源 HTTP/2 全部 200，页面、文档、内容、MIME 与 404 检查通过；GitHub Pages 保留回退 |
| CF-03 | P1，进行中，未验收 | Workers + D1 登录与私人阅读 | CF-01、CF-02 | gpt-6.1-sol / high | 实现和主要安全检查完成，CPU证据仍`unknown`，warm与满批维护未验收。后续云验收仍须新鲜基数、采样计划、CPU观测、真实维护、R2证据与安全门槛；生产库空，API与真实文件能力未上线 |
| CF-04 | P2，本机准备与任务消费实现完成，云端待实现 | 本机正文准备与云端检索数据 | 本机首步不依赖CF-03生产CPU验收；云端同步与D1索引依赖CF-03相应安全/资源验收 | gpt-6.1-sol / high | 单文件正文包、页码/章节定位、来源和版本校验、显式版本选择及本机问答/总结消费已实现；完整258项Node、8项Python测试通过，模型调用仅mock。云同步、D1索引与生产阅读/真实AI另行实现验收。正文和索引不得进入静态产物 |
| CF-05 | P2，待开始 | Workflows 持久任务与真实 AI 接入 | CF-01 的长任务验证、CF-04、独立配置的有效任务 Key | gpt-6.1-sol / high | 迁移任务状态、去重、预算和中间结果；保留全局串行与调用上限；验证问答、章节和全书总结、有来源的作者资料及主动发布，浏览器关闭后任务继续 |
| CF-06 | P3，待开始 | 可靠性与后续体验 | 阅读和 AI 主流程验收 | gpt-6.1-sol / medium；涉及数据恢复或架构时 high | 优先完善上传结果核对、任务待确认处理和数据备份恢复；再按实际问题推进中文检索改进、跨设备阅读进度和网页上传管理 |

优先免费运行验证仍有助于发现适配问题；确有必要时可评估合理项目费用。离线功能可以先行，云端真实阅读先于真实AI，便于核实登录、数据与文件权限。

CF-01 不依赖真实 AI Key；可先使用模拟上游验证调度，但长请求在真实 Cloudflare 运行环境中的表现必须单独记录。AI Key 的签发与现有服务运维配置独立处理，不把模拟通过标为真实 AI 已接通。

以下迁移实施要点中的旧轮收工状态、费用限制与“CF-04等待CF-03”记录均为当时历史证据；与本页顶部2026-10-17最新调整不一致之处，以最新调整和“当前开发优先级”为准。旧轮数值与结论保留，不据此重放已停止的云轮。

## 迁移实施要点

### 本轮 CF-01 与 CF-02 执行计划

CF-01 由 gpt-6.1-sol / high 实现最小独立验证程序，主 Agent 负责实际账号、免费计划与项目资源范围核对、集成 review 和云端验收。验证使用项目专用 Worker、D1、Workflow 与私有诊断数据；诊断入口必须鉴权，不读取电子书、不调用真实模型、不修改现有私人数据库。不把账号标识、真实密码、凭证或诊断入口令牌写进公开配置。记录登录计算、D1 跨请求持久化、R2 私有读写与清理、Workflow 在原 HTTP 请求结束后继续执行的实测结果，并区分模拟上游与真实模型能力。

CF-01 评估结论支持继续 CF-02。静态部署配置、CI 与 URL 验证由 gpt-6-luna / medium 实现；gpt-6.1-sol / high 负责受控部署辅助工具及凭证安全边界。完整 Astro dist 已通过 paw 上受控 helper 发布至 Workers Static Assets，正式站点为 <https://the-shelf.iamzhutuo.workers.dev/>。GitHub Actions 的 Cloudflare 构建产物成功，部署步骤因没有专用 token 按预期跳过；GitHub 自动部署仅在配置严格限定于单一 Worker 的专用 token 后启用，不能把账号级通用 token 复制到 GitHub。GitHub Pages 继续保留为回退方式。线上 AI 与私人 API 仍明确未配置，不能把诊断 Worker 当成生产业务后端。

**10 月 15 日进展：**CF-01 评估结论为“评估完成，鉴权需适配”：免费 D1、R2 与 Workflow 的基础验证已通过；当前 Node 登录方案不能直接照搬，CF-03 前须设计并验证保留凭证强度与限流的安全低 CPU 方案。CF-01 源码已推送，GitHub Actions 工作流 38675230094 成功；CF-01 当时 41 项 Node、8 项 Python、构建和隐私检查通过。CF-02 静态实现 review 通过，56 项 Node、8 项 Python、构建和隐私检查通过，并已通过受控 helper 发布、完成线上验收。源码提交 `308751c` 与 workflow 修正 `127be0b` 已推送；Cloudflare 工作流 38677306877 构建产物成功并按预期跳过部署步骤，Pages 工作流 38677307035 成功。HTTP/2 检查覆盖 1303 项资源，全部返回 200；12 份文档的 HTML 与 raw 页面、首页、书页、阅读入口、文档索引和合并文档均与本地构建逐字比对通过，缺失路径返回 404。Node 批量远程 fetch 曾间歇 TLS 失败，线上通过依据是独立 curl HTTP/2 检查。GitHub 仓库为公开仓库；`resources-and-access.md` 不纳入网站文档白名单，具体私有验收证据只存于被忽略的 `.local/`。未上传电子书或调用真实 AI。操作说明见[公开仓库 README](https://github.com/sickate/the-shelf/blob/main/cloudflare/probe/README.md)。

本轮阶段收尾：CPU证据分析器与重复配置解码最小候选已分别提交并推送 `5a6242d`、`15cd401`，两阶段Cloudflare及Pages CI均成功；最终156项Node、8项Python、disabled build、真实secret隐私扫描与verify:static通过。check的HTTP/2首轮21请求、80断言、真实CAS两次mutation admission及generation撤销HTTP检查通过；warm未运行、满批维护未触发。

最后一次同窗只读取得平台aggregate requests=21、errors=0，CPU P50/P95/P99/max=2.090/4.387/4.835/4.835ms，sampleInterval=1、同一version；分析器仍判 `unknown/incomplete_evidence`，保留 `group_aggregate_count_mismatch`、`ambiguous_attribution`、`missing_request_traffic`，不能凭aggregate低值判通过。平台max现已可取，原始逐请求CPU序列仍缺；HTTP/1与HTTP/2负载不可直接用于优化性能因果比较。本轮云分支结束，不加预算或采样；最终账本business48/100、explicitManagement84/90、D1management38/40，另有1次受控helper部署（内部HTTP未精确计数）。关闭证据确认check auth=0、active=0、入口disabled；最终只读不改变状态，生产API未启用、主站静态不变。

下一优先级是按新鲜表基数另立有界验收计划，再用已固化sampler完整收集两轮业务请求、等待analytics并核验真实CAS及满批维护；不接续已停止轮，不现场扩大上界。 CPU/CF-03仍未验收通过，CF-04与AI继续等待。

静态改进发布时CF-03记录（2026年10月15日）：当时本地完整验证为138项Node与8项Python通过；metadata和account真实DOM分别通过11与9项断言。独立check D1已用官方Wrangler应用schema并完成002保守预算迁移回读；check与production D1独立建立，production库仍为空。production secrets仅本地生成，尚未安装到Worker或写入auth；check Worker已配置四个secret；check已关闭 `auth_config.enabled`、递增generation并撤销所有会话，workers.dev与preview URLs已禁用，D1和secrets保留未删除。应用使用现有同桶专用R2读写凭证。多轮云端每轮21个HTTP请求的安全、CAS和撤销检查通过；原子20并发争用最后一个额度仅1个成功；真实合成导入与snapshot保留override通过。源码提交 `0ae8825` 已推送；Cloudflare CI `38724875134` 构建 artifact 成功，Pages CI `38724875089` 成功。首次真实静态 CLI 在任何 Cloudflare 写入前遇到入口循环并停止；CLI修复已通过主 Agent review，新增两项真实独立进程 static/API CLI smoke后总计138项Node与8项Python全通过。CLI修复提交 `3e1aa89` 已推送；Cloudflare CI `38725881041` 构建成功、部署按预期跳过，Pages CI `38725881116` 成功。默认disabled的静态改进已通过本机受控发布及线上验收：首次网络检查完成1248项后中断，随后仅恢复剩余56项，合计1304项HEAD均为200；32项GET与本地字节及MIME一致，缺失页、`/api/health` 与 `/api` 均返回404，runtime保持disabled；线上账号页经真实Chrome DOM验证，凭证控件为disabled。

上一轮CPU记录（当时门槛未通过）：历史首轮P95/P99为5.634/13.184ms；SQL优化版本冷启动为5.313/10.873ms、热请求为4.236/5.830ms，合并42样本为5.313/10.873ms；最后小优化版本包含部署后首次访问的首轮21请求P50/P95/P99为2.512/6.554/10.981ms、同版本后续完整热轮21请求（不能保证复用同一isolate），HTTP/66断言通过，CPU P50/P95/P99为2.341/6.017/6.180ms，errors均为0；两轮P95都未达到5ms目标。六个版本/轮次共126请求，另有2次tail健康检查，共128次（低于150）；该最终候选版本首轮21次与同版本后续完整热轮21次，共42次。P99不是最大值，当时未取得平台max，tail连接后没有CPU events；本轮已补查平台max，原始逐请求CPU序列仍缺。保留每个版本全部结果，不挑较低样本。sampler现已完成本地验收，下一步按新鲜基数另立有界云计划，仍不改5ms目标。不得放宽5ms P95目标、降低凭证强度或付费绕过。

按当前保守API估算，每日D1写入上界为36,220行（CLI初始化诊断另计）；同账号Volt用量未知，因此不能保证账号免费额度。R2账号汇总只读条件授权已核查并执行；最新存储点不满足5分钟freshness，尚无合格上传证据。仅选择的EPUB（1,799,179 bytes）与PDF（2,588,862 bytes）dry-plan均因`account_storage_unknown`阻止；没有上传原书，也没有调用真实AI。The Shelf与Volt共享Cloudflare账号，Volt无R2（已有只读核查），Workers/D1额度共享。下一优先级是按新鲜表基数另立有界验收计划，再用已固化sampler完整收集两轮业务请求、等待analytics并核验真实CAS及满批维护；不接续已停止轮，不现场扩大上界。仍按计划、Sol实现、主Agent review及云端采样执行。CF-04和AI继续等待CF-03验收。代码及CLI修复已推送并通过CI，默认disabled静态改进已部署并通过线上验收，以receipt为准；API不发布，当前主站仍为CF-02静态站，CI Cloudflare仅生成artifact，Pages回退保持disabled。

各阶段由主 Agent review，运行适用测试、构建、公开产物隐私检查及集成验收后按计划发布。凭证留在被忽略的私人配置；CI 只上传公开产物。保留 GitHub Pages 的回退发布方式，不开通付费计划。诊断对象与临时记录在验收后清理，仓库运维记录不纳入网站文档白名单，私有验收证据留在 `.local/`。

- Workers 的本地文件系统不作为持久数据库；现有 node:sqlite、子进程和长期内存队列需要适配。登录计算、检索和 JSON 处理需实测免费 CPU 限制，不能通过降低密码保护强度来迁就额度。
- D1 保存业务数据与必要索引，大段正文优先放私有 R2。规划单库容量、查询索引、备份与导入校验，迁移脚本保留现有本机数据，不静默覆盖人工修正。
- Workflows 步骤显式配置超时与重试。明确忙碌拒绝才有限重试；超时、断线和响应不确定不得因平台默认重试而重复调用上游。持久调度不能替代上游幂等保证。
- 元数据在 D1 修改后，当前详情应可读取；下一次静态构建只同步公开字段。公开文档仍使用现有固定发布清单，运维记录不进入网站。
- 切换网站来源时同步 R2 CORS、Cookie、CSRF、前端 API 路径和旧站入口；仅 API 路由运行动态逻辑，公开静态页不消耗不必要的 Worker 调用。

2026 年 10 月 15 日评估使用的官方依据：[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[Workflows 限制](https://developers.cloudflare.com/workflows/reference/limits/)与[重试配置](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)、[R2 价格](https://developers.cloudflare.com/r2/pricing/)。实施时重新核对实际账号计划与剩余额度。

## 延后任务

格式自动转换、扫描 PDF OCR、书籍问答流式输出、公开文件许可管理与只读文档 MCP 留到上述主流程稳定后。仅为目录扩充上传文件或批量生成总结不作为当前优先事项。

## 完成标准

真实收藏可以搜索、分类、分页并查看各格式详情。20 MB 以上只登记，零字节文件不可阅读。public 与 dist 中没有本机路径、源电子书、正文、私人历史或密钥。匿名访问者可读所有公开文档及机器索引。

后端登录保护私人文件与 AI；未知来源写操作被拒绝。任务先持久保存，刷新不重建相同在途任务，工作进程有并发和调用上限，失败不会无限重试。没有正文时返回明确状态，不生成未经依据的书内回答。

PDF 和 EPUB 阅读器支持授权文件；MOBI 和 AZW3 提供原格式下载及需要转换的提示。现有 AI 服务没有书籍流式接口，第一版展示排队和完成状态。

## 迁移上线门槛

确认 Cloudflare 账号内本项目资源、免费计划与专用部署权限；现有 R2 对象凭证不等同于 Workers 或 D1 部署权限。确定实际站点 URL 与同源 API 路由，更新构建和运行配置。可使用平台提供的域名，不以购买新域名为前置条件。

静态站、私人阅读和 AI 分别验收，只有已通过的能力才标为在线可用。每阶段运行现有测试、构建和 npm run verify:public，并补充对应云端集成检查。新部署可回退、私人数据迁移核对通过后再切换；免费适配若未通过，记录限制并调整设计，保留现有站点，不自动升级付费或把 paw 改成生产服务器。

## 首版进度

导入、公开目录、全部书籍详情、文档导出、私人登录与阅读、元数据修正、R2 签名与受预算约束的上传计划、AI 任务队列及结果发布均已实现。16 项 Node 检查与 8 项 Python 检查通过；真实 PDF 已在浏览器验证授权阅读。静态产物检查通过，含 1,264 个详情页，未包含原电子书和私人源路径。

私有 R2 桶已创建，项目专用对象凭证已配置到开发环境，真实对象读写、Range 和跨域访问验证通过，尚未上传电子书。远端 AI Key 未配置，AI 相关功能由模拟上游验证。Cloudflare 的生产业务迁移（Workers API、D1 业务数据与 Workflows 任务）尚未实施或验收；CF-01 的基础设施诊断已完成评估，CF-02 静态迁移已完成。现有 GitHub Pages 与 Node.js + SQLite 开发方式仍有效。

2026 年 10 月 15 日复跑 16 项 Node 测试、8 项 Python 测试、1,280 页面构建和公开产物隐私检查通过。具体运行方式与限制见运行与部署说明。
