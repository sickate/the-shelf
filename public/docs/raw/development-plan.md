# The Shelf 开发计划

## 2026-10-24 用户优先级调整：独立交付书籍上传

最终本机放行：独立完整2195项Node和8项Python通过（`/private/tmp/shelf-upload-full-final-20261024.log`），disabled/same-origin两构建各1282页、public/static检查通过，两产物实际私密值扫描均1634文件、0命中/0不安全项。生产仅只读auth核验2HTTP，generation1/enabled1且无未决auth mutation；尚无新生产DDL、上传或发布。进入commit→push→两CI→固定生产迁移/部署→真实上传验收，不再扩大开发范围。

上传最终候选已由主Agent独立review，联合226/226通过（日志`/private/tmp/shelf-upload-independent-final-20261024.log`）。第二阶段固定operator、部署/auth/静态回退及专项完成；最后修复关闭generation围栏，允许enabled0执行close并推进generation，迟到旧enable不能重新开写，未知claim继续保留。该必要修复覆盖下方首阶段旧pin：013=`3b6b3b9686ed98e26cfbf873bd0869c15cba5103a9cd555383aa388147596866`，runtime helper=`dadbfe6f82843529c64160d2539e224b43e24d8b466843a47b6b60d45ce01e3a`；新完整schema两pin为`f37ec22776cfc94299af08f31af6944282a7bc8afd152df5739007add7b48626`/`f91bff01a7b5ce50b497ad58d061787f7895df8125cddc5924c00e7424169c7b`。实际安装41HTTP/20DDL，seed4HTTP，API部署5显式HTTP（Wrangler内部另计），auth enable实测11/上限12，policy enable6、close4。尚未执行生产安装、上传或发布，完整回归/构建/隐私与CI仍待本轮最终检查。

授权已落实：用户明确选择“按此规则开发并开放常规上传”，已按原话和完整风险说明在AGENTS.md新增2026-10-24条款，覆盖旧“后续上传关闭”对新模式的限制。每本20MB、原唯一authority全部已登记责任合计8GB、未知责任和首本永久保留；明确接受账号实量/未登记旧写未知及项目费用，不假装证明账号≤8GB/零费用。之后网页逐本提交即可，不逐本聊天求许可。授权不等于已部署或已上传。

本轮发布验收方法：真实浏览器工具再次确认Chrome原生cgWindowNotFound、IAB不可用；不重复要求用户准备窗口，也不将同一工具故障无限转化为功能开发的前置任务。上传版本必须先通过生产handleRequest+真实SQLite/实际workerd的上传/读取/并发/unknown/会话/Origin/CSRF验证、生产TS的合成DOM回归、完整测试/构建/隐私检查，再commit→push→CI和受控发布。线上必须独立检查固定版本/绑定、上传门槛、一次有界合成文件上传、目录/详情/全文hash/Range及注销撤销；不重跑F4真实AI、不改secret。CUA完整23场景及视觉/实际阅读器交互保留为明确未验收项，不把合成DOM或真实HTTP记成浏览器通过；若这些检查出现产品失败则停止开放/关闭policy并修复，工具本身不可连接不触发无限重复发布等待。此调整是主Agent针对当前可用验证手段的发布方案，不声称此前未完成的F3已验收。

主Agent线上独立验收清单：固定新建合成单页PDF（本机生成、无私人正文、≤20KB），在`.local/isolated-upload/live-acceptance/`先以不可覆盖plan固定文件/hash，再记录唯一bytes发送claim；最多24次固定同源业务HTTP、其中仅一次文件bytes POST，不调用AI，不自动重试。检查匿名拒绝、登录与能力、intent/唯一bytes、重复intent不再上传、私人目录/动态详情、access/HEAD/全文hash/Range、回收站拒读/恢复可读、旧首本读取及注销后撤销；合成书最终留在回收站，不删除对象或释放责任。未知立即保留plan/claim/收据并停止，失败后的注销最多一次包含在上限内。运维控制HTTP与部署工具独立计数，实际执行前以冻结实现的预算为准。

上传第一阶段已主审：013/helper及相对N2b基线的management/worker完整diff已阅读；独立63/63联合通过，含实际workerd和旧45项（日志`/private/tmp/shelf-isolated-upload-main-review-20261024.log`）。修复schema读取必须在admission/CSRF后、trial root/子路径零IO关闭、最后session验证后不再异步读target。仅格式化后冻结013=`ed3073da4670d80e7f222bd61c60e2c7a2f1b8e2b31ed83a9d182ec9b0d8ee8e`，helper=`2b01b80e7b3510ef3587a0e30f72c72eca0967d5daf7d660f06cafe743ca7737`，management=`ec21180c0c636851b040fb9c1b2ba5445e983a31316c95176ef353b0c2ebecb5`，worker=`11c90ccefbc963f2da0b2b4d9f11887c6804587105bb56055f73f52fd13389eb`，新专项=`7862a5acdb2b21fca2e28b5a2d0d339baf2939468bad1eb9dac6d0e5dc673a3a`。

第二阶段已批准原Sol/high线程新增scripts/isolated-upload.mjs、operator/deploy两专项，窄改cf-api-deploy/cf-production-auth/cf-deploy；显式isolated-uploads仅production+single-trial+filename-ai、不混prepared/v2，固定本轮consent。安装前加固定临时阻写guard，避免DROP/CREATE间原imported入口出现空窗；逐DDL持久intent/unknown停止，独立完整schema及全部旧数据/责任保留后移临时guard；seed默认关闭，enable独立CAS，关闭写不删除对象/预留，新增上传后只允许保留读取检查的修复或静态回退。实际HTTP/DDL预算由实现冻结后主审，不在开发期间执行生产调用。

第一实施范围已审：Sol/high上传线程新增013-isolated-upload.sql、isolated-upload.mjs及独立tests/isolated-upload.test.mjs，窄改management/worker；009+013直接工作，不为上传强制安装无关010/011。复用现隔离桶和原authority，新增固定policy及browser_uploads显式target_id，旧NULL目标不可转换；固定view集中映射不存另一余额。3个旧guard增严格新模式分支，原phase/首本/其他guard保留；enabled仅控制reserve/claim，读取/已claim确认保留。先交真实SQLite/Worker闭环给主Agentreview，再完成部署/auth/静态回退的精确新profile，全部在既有授权内自动推进。

用户要求先启动一个subagent单独完成书籍上传，并指出页面长期没有可见新增功能。本轮以可用上传流程为第一优先级，停止扩展无关底层工作。主Agent负责集成、代码review、独立功能验证及发布；专属upload_delivery子Agent使用gpt-6.1-sol/high（鉴权、隐私、AI和持久写任务），单独负责查清并实现最小可交付增量。

目标和范围：从页面选择PDF/EPUB/无DRM MOBI/AZW/AZW3，按现有20MB门槛及8GB责任预算，文件名自动识别书名/作者/分类并可修正，单文件上传后目录出现且可进入既有阅读器；先复用现有鉴权、识别、账本与读取能力，避免为本次交付新增通用框架。必须区分当前本机可用、待发布代码和真实生产门槛。首本许可已消耗，不复用或重置；保留旧unknown/对象/账本/收据，不推断未知用量为零，不修改套餐或扩大账号权限。

方案与依赖：子Agent先限时核对现有upload UI/API/authority/部署事实和阻断原因，交出一条精确最短实施路径及其文件范围。无需等待N2c全部完成即可开发与其无依赖的上传功能；不得把历史计划文字当额外授权或永久架构约束。先提交具体方案由主Agent审查，随即实施最小可运行补丁。若真实生产门槛确实无法由现有授权和能力满足，须以明确缺失事实/可选解决办法上报，不再反复搭建同类证明或以合成测试冒充生产上传。

验证与交付：主Agent独立检查选择文件、自动metadata、成功上传/列表/阅读、20MB拒绝、重复点击/网络结果未知零重传、未登录与错误Origin/CSRF、删除恢复不重复占用、私人字段不进入公开产物。适用专项、完整回归、构建和隐私检查通过后，按commit→push→CI→受控部署→独立线上验证交付；真实PUT须在具体逐文件计划和原有安全/预算证据门槛成立后执行。浏览器连接当前仍报cgWindowNotFound，继续修复和其他可独立验证工作，不重复要求用户准备同一窗口。失败保留当前部署；回退代码/配置，不删除账本/对象或重开旧写入口。

并行任务收口：legacy status只完成当前已实现五文件的冻结交付；index proposal只补最终边界说明，不继续扩大实现。主Agent先审已产生改动，避免遗留半成品污染上传任务。此优先级调整不表示已上传或已上线。

## 2026-10-24 N2c 只读运维兼容接续

最新收口：legacy五文件已由主Agent完整review并独立联合176/176通过（新150+旧26，零失败/跳过/取消），日志`/private/tmp/shelf-n2c-legacy-main-review-20261024.log`；六profile实际9/10/11，legacy7/8/9，status首GET起受1MiB/4096/30秒保护，旧apply回归保留。冻结SHA见子任务交付，不再扩大本轮实现。index-status/publish提案已只读探针通过并冻结，未批准实施，整个N2c仍未完成。完整回归在普通sandbox曾因24项listen EPERM失败（2009中1985通过，Python未启动），保留`/private/tmp/shelf-n2c-schema-full-main-20261024.log`，不是最终验收。用户已将第一优先级调整为上传，暂不为N2c继续整批发布。

接续状态核验：当前live inventory仅主Agent，原source/deploy/runtime线程均已不在列表，runtime最后报429限流；不把旧交付消息当当前运行handle。工作区已存在schema-readonly helper、prepared schema分支和两个新专项（实际名prepared-schema-readonly/schema-readonly），尚未由主Agent验收。按原指定gpt-6.1-sol/high新建接续任务，先核对现有实现和冻结边界再收尾；不静默更换模型，不重复启动任何云动作。

prepared schema阶段主Agent现已逐项review四文件及相对原冻结脚本的完整diff，独立三专项74/74通过，零失败/跳过/取消，日志`/private/tmp/shelf-n2c-schema-main-review-20261024.log`。真实run合成transport的六profile10/11请求、011 apply11只读/0DDL且无write-ddl intent、两读schema漂移、4表完整指纹、32表列与artifact独立PRAGMA、超1MiB/块数/迟到deadline及旧partial/unknown流程通过。prepared-index SHA=`c36f6a6a299526465b01f9905c3f397d25fe1bf05c5706956c643ae5ca3c9079`，共同helper SHA=`bc22fdf2e06280b2d9bae0b416012b811015197caaec8a342216aa979cc895a7`；原prepared-schema、旧专项、N2b/shared及010/011/012全与本轮基线一致。仅本机验收，不代表011已安装或整个N2c完成；index-status/publish及三个旧operator仍待后续实现和主审，不发布部分接线。

当前N2b冻结验证已完成：1963项Node和8项Python全部通过，两种构建、public/static及秘密扫描通过；尚未提交、推送或部署，F3完整23项真实浏览器验收仍待完成。下一项先处理`prepared-index schema-status`对完整011布局的只读识别，随后按依赖推进`index-status`及其他只读operator；不得把本计划当作实际兼容或云验收结果。

范围与方案：保留旧完整profile的10HTTP与原010逐对象精确检查；完整011状态通过原两条schema查询精确识别整库profile，保留原七组全量有序数据快照，并增加activation/receipts/evidence/legacy liabilities四表一组，完整状态最多11HTTP。每组响应仍受1MiB/块数/30秒限制，不静默截断、不忽略陌生对象/部分011。`schema-apply`在011仅允许同样只读状态检查后明确停止，旧布局的33HTTP/13DDL及未知DDL不重放规则保持；不提供v2 apply或index-publish许可，不提高限额掩盖额外请求。

分工与依赖：source_finalize（gpt-6.1-sol，high；复杂schema/数据安全任务）先只读审查prepared工具、共享精确profile和现有测试，交具体SQL/返回结构、请求预算和测试提案；可用本机合成SQLite探针，不改repo实现或冻结N2b文件、不调用云。主Agent审查提案后再批准其在工具/helper与独立专项内实现。`index-status`依赖该方案及主审通过，须在原5+P D1/3 R2内将完整manifest并入既有source前后语句，另行具体审查；本阶段不提前改它。

可并行的只读调查另交deploy_wiring（gpt-6.1-sol/high）：盘点book-management-schema、filename-identification-schema、identify-observation-schema的status如何精确兼容010/011及其数据快照，列出当前/目标HTTP、返回尺寸、旧apply拒绝新布局的最早安全位置。仅交提案与临时合成探针，不改代码或共享文件、不云调用；主Agent另审范围与预算后才实施，避免与prepared工具并发修改。

调查纠正旧计划的现状描述：007/008/009三个operator的oldSchema目前只是hash而非精确整库比对，010/011不一定被拒绝；007/008在129行探测达到阈值才停止，008还会将009替换后的admit trigger视为partial。实际status请求分别7/8/9（原上限9/10/10），fresh apply为21/22/25（原上限23/24/26）。这些差额不自动授权增加读取；新完整profile分支须精确验证、保留全数据和有界transport，历史apply不得悄悄处理新布局。007/008现transport仍有10MB响应、无chunk帽，不能误报已有1MiB保护；是否收紧及其兼容影响须在具体提案中审查。

prepared提案主审已读并独立运行`/private/tmp/the-shelf-source-finalize-n2c/probe.mjs`：六完整profile分别112/113、125/126、149/150对象；旧10、新11候选读数成立，最大合成schema响应101553B；原25张业务表全部由七组覆盖，新增四表全列有序组SQL1635B，逐表数据变化均改变指纹。partial011、011缺010、陌生/平台DDL漂移、两schema读之间010漂移、重复/257行和超1MiB均拒绝。探针不是实际工具/transport验收；早期主Agent两个临时空库probe因未seed导入前态被既有约束拒绝，正确seed后149对象复核通过，未修改repo或云状态。

现批准source_finalize（Sol/high）实施`schema-readonly.mjs`、prepared-index schema分支及两个新专项：共同helper仅引用冻结公共profiles，严格整库classifier（未知返回null只能由调用者固定legacy规则处理），固定32张业务表全列map/七legacy组/010三表组/011四表组及无LIMIT有序snapshot SQL；不执行环境/私人IO、SQLite或网络。运行时SQL仅去外围空白和一个末分号，保留字面量。prepared独立保留精确trial009基础+已知010 subset的历史恢复，不将partial称完整；两schema中010子集必须一致。保持旧nonPrepared hash与全部持久index plan/budgets原语义，另加whole hash/layout摘要；011精确识别后才启用11读/0DDL预算，apply完整只读后明确disabled并留私有receipt，零DDL/write-ddl intent。原HTTP前本地immutable身份/010 pin保持，它不是云写许可。主Agent独立验收实际run计数、旧33/13恢复与unknown、责任指纹、超限/迟到；其他工具和index-status待后续审查，不改冻结N2b/shared/DDL。

runtime_wiring（gpt-6.1-sol/high）可并行只读提出下一项index-status方案：实际SQLite探针复核5+P D1/3 R2内的整库profile及source前后同statement manifest、normal/trial全局来源唯一性，不能伪造Worker会话/配置来硬套消费者decoder。index-publish须将原010查询换为完整profile并最早拒绝011，旧profile写前后仍须能发现011跃迁且不增加未核定请求；本次不授予v2发布。只交临时SQL/提案，不改prepared-index或任何repo文件，依赖schema阶段主审通过后才另批实现。

三个旧schema工具提案主审已阅读并独立运行`/private/tmp/deploy-wiring-n2c-status-probe.mjs`及legacy probe，全部业务表分组无遗漏；完整009/010/011只读actual预算9/10/11，20k chunks整组7598923B将按1MiB明确失败而非截断。批准下一Sol/high任务实施三个工具及专用共同helper、新专项：以原第2次own-schema查询等价替换为固定完整schema查询，优先判共同完整profile；新status用七旧组+可选010组+可选011组，全量全列指纹，仅输出摘要。每响应复用已有boundedControlResponse的1MiB/4096块/30秒；旧apply原上限及unknown/claim规则不变，legacy fallback须由冻结公开DDL编译精确pre/known-own-subset，不能未知hash兜底。007/008在完整009及以后的apply最早第2HTTP停止，009 apply在完整010/011也第2HTTP停止；但完整009是009自身原生终态，必须保留既有零DDL重复检查兼容（旧专项明确要求），不得为测试删掉此行为。新status明确布局预算并持久记录，无额外拆页/无mutation。helper仅消费已主审schema-readonly，不修改其冻结文件、旧专项或N2b/shared/DDL；真实run六profile/旧恢复/陌生partial/责任指纹/超限与迟到必须由主Agent独立验收。该任务若指定模型持续不可用，暂停其具体开发，主Agent继续现有代码review/验证，不换模型。

验收：主Agent逐项review schema精确性、平台对象、保留数据完整性和只读边界，独立运行旧/011/部分与陌生DDL、四表责任变化、超限、未知响应及apply零DDL专项；旧schema/status/apply回归必须保持。随后按实际修改范围重跑完整测试、两构建和隐私检查。无真实HTTP、上传、AI、secret写入或010/011/012安装。发布仍依赖F3及整批门槛，之后commit→push→CI→受控部署→独立验证；失败保留现有部署，撤回本地工具改动即可，不回滚DDL、不删除对象/账本/unknown/收据、不重开旧写入口。

## 2026-10-24 接续复审与读取接线

本次继续沿用已批准分工与依赖，不重新签发试运行或重放云操作。CF01隔离CLI夹具仅补两个公开shared依赖，主Agent逐行review后独立15/15通过；原preload网络/配置拦截、断言和5秒上限保持。原完整回归1706/1707及Python未运行记录保留，最终冻结后重跑。3b-1坚持单条primary SELECT的原子快照语义，返回后检查配置/方法与会话当前到期时间，不声称能观测查询完成之后才发生的数据库撤销；不存在额外查询或逐file读取。CUA本轮再次观察到Chrome进程但browser列表为空、原生连接cgWindowNotFound；不重复要求用户准备同一窗口，继续独立本机验收，真实DOM门槛仍未通过。

N2b发布后的v2读取验收工具仍缺，补分配已完成fixture的deploy_wiring（gpt-6.1-sol/high）先只读核对现有cf-reading-smoke及专项，提交最小具体v2 plan/19正常20上限请求序列与HEAD处理提案；主Agent审后才改该工具及专项。目标仅同源双来源closed profile，复用既有private receipt/timeout/stream/no-retry，不产生CLI默认执行、配置发现或真实HTTP。14项原trial读取+HEAD+4个operator关闭样本为初始设计，必须核定实际计数，保留legacy/trial行为。此任务不改其他agent文件、共享contract/DDL/auth/deploy，不发真实上传/AI/secret/登录/云请求；后续真实运行仍须代码发布门槛和单独固定计划。

v2 reading-smoke提案已主审批准deploy_wiring实施工具及独立专项。schemaVersion2 exact plan显式storageMode=authority-v2/writeMode=closed/source=normal|trial及对应固定bucket，旧schema1原样；来源只能由固定confirmed私有证据给定，HTTP结果不能独立证明源桶，normal仅离线。实际19序列为匿名access/content、login、坏CSRF logout、session、book、local access、坏Origin content、content HEAD、全文/hash、Range、4 operator、logout、session false、旧cookie access/content。operator分别GET根、POST upload空JSON、HEAD object、OPTIONS未知深路径，均匿名且无uploadsecret/PUT；坏Origin样本仍404。HEAD内容必须广告精确size/MIME/ETag/Accept-Ranges且零body，不能用空body hash代替；HEAD operator bodyless不解析JSON，其余严格not_found/no-store。保持64KiB JSON/20MB对象/32B range/30秒/块数界限；未知login/logout零重放，logout unknown停止后续撤销探针并标generationRevocationRequired，已知cookie失败最多一次failure-logout且journal pin失败不清理。无真实请求，主Agentreview与合成计数/旧行为回归后才接受。

3b-1主Agent逐项review并独立120/120通过（含真实MF完整Worker普通/首本/冲突、分页/匿名/登出与生产TS合成DOM；`/private/tmp/shelf-book-routes-main-review-20261024.log`），最终SQL15341/15339B、6bind。首次57项中唯一失败为capability两SELECT的错误期望，修正为2且零projection后通过，原失败保留。此为本机路由验收，非真实浏览器或上线结果。

3b-2 metadata/生命周期实际SQL主Agent阅读并独立运行合成probe后批准runtime_wiring（gpt-6.1-sol/high）实施：初始full detail一次→batch admission/guarded CAS/final full detail，共4statement，不新增逐file或查询guard。metadata初始15698B/7bind、mutation15725B/10、final15440B/6；初始投影仅metadata置null与SQL不读metadata的guard逐字相同，管理/catalog/source/schema/authority/session均保留；另用expectedMetadataVersion CAS。生命周期初始15339B/6、mutation15871B/10、final15437B/6，guard检查完整preimage，expectedManagementVersion CAS，final owner allowTrash=true，从最终双源安全投影生成删除/恢复响应。主Agent独立probe成功写version1、旧expected0拒绝、trash1→2且final完整书保留；source/management/metadata-version/session/catalog/schema/authority race均零mutation。实现须保留原validation/category派生/冲突响应，patch32KiB/SQL16KiB/response1MiB/30秒及captured配置方法当前expiry，无unknown重放；补真实MF全部路由、normal/trial/conflict/竞态和原v1回归。只改runtime拥有控制器/新mutations helper及worker/management/专项，不改pure source/shared/prepared/deploy、DDL或云状态。

3c主Agent已逐项review六文件及窄export相对已接受3b纯模块的diff，反馈修复captured primary.prepare/bind/first/all漂移与最终await期间到期复核后，独立9文件联合581/581通过（零失败/跳过/取消；`/private/tmp/shelf-prepared-v2-main-review-20261024.log`）。真实workerd20k块为26业务D1（API3+control3+page20）、仅prepared3 R2、一次access；trialonly/同ID冲突零R2。最终source read9070B/10bind、admission9392B/14；构造前26字段raw总和16KiB，原source/guard/010哈希保持。冻结source=`597698dc9c7ec3c77d1d599cfafeeef6871efb194ba91c97838fb573c8f82a21`、prepared-source=`d52c95416e79f9323dd1a3169f60411d3e7f5c42bb81e7fb9dd5fd6bd63541e3`、prepared=`30fc8dd7b0be40d900ea52d66d0cd4924a7d1644fa9e28a06f09df255431067a`。结果仅本机验收，未安装010/011、未部署或执行真实正文同步。

v2 reading-smoke工具/新专项主Agent逐项review及独立74/74（含旧40项不变）通过，日志`/private/tmp/shelf-v2-reading-main-review-20261024.log`；工具冻结SHA=`2cd34677c50040a8c083ed486dc19641c1ccdbe1d8bfefbe6fd2861d2271a4b0`。实测19请求/20上限、HEAD零body、同源Cookie、4匿名operator、unknown停止及private journal等覆盖通过，仅合成transport，尚未真实运行。未执行真实登录、HTTP、上传或云操作；发布后运行须由固定私有confirmed证据生成plan，不手写云事实或宣称HTTP证明桶来源。

3b-2管理UI的closed reason随同复杂接线由runtime_wiring补一条已有manage-ui文本映射：storage_write_closed显示“当前版本尚未开放新增文件上传”，避免新明确状态落入泛化未知条件；不显示账本术语、不改gate或开启条件，不为此低风险文案另加镜像测试，复用原manage-ui专项。

3b-2主Agent逐项review实现/SQL/路由/专项，独立7文件272/272通过（`/private/tmp/shelf-book-mutations-main-review-fixed-20261024.log`）。首次269项中MF POST被模拟器/cdn-cgi自身Origin allowlist拒绝的失败日志保留；仅fixture配置精确站点hostname route后，原真实Origin/CSRF和错误http Origin/错误CSRF均由未改产品代码返回预期JSON，真实MF metadata/trash/restore/冲突全部通过。MAX_SAFE版本在写前拒绝，batch整包≤1MiB且results数严格0/≤1/1，未知结果一次batch后停止。mutation SHA=`1892dc3309a64437faa5d731102828f4c60aa72774d488a55e2a6a272f1efdb5`，controller=`becffb658d0fa7f422ba1f32d42972cb1d878f7aa995ea16ba3ec90e93423b5d`。管理文案原7项通过；该批业务代码已冻结，进入完整Node/Python、两构建、public/static及真实秘密扫描。真实浏览器仍不可用，不作新生产发布或010/011安装。

3b纯展示API和4b鉴权/静态回退接线已主Agent逐项review、修正反馈后独立通过：projection/source/controller/旧Worker共475/475（含真实workerd），deploy/auth/static联合192/192，均零失败/跳过/取消；日志分别`/private/tmp/shelf-storage-projection-main-review-20261024.log`、`/private/tmp/shelf-v2-auth-static-main-review-20261024.log`。pure source冻结SHA=`afaa17a4d44fb036b627b14b2a1ba72146c60135876b776304835e82c3a4e861`；4b probe3289B/1bind、CAS2761B/6bind。主审纠正了旧singleTrial enable密钥校验及旧静态boolean入口两处兼容回归，追加回归已通过。共享contract/artifact及DDL哈希保持，剩余3b路由/客户端和3c prepared仍未接线；不部署半成品。

分页SQL原型出现SQLite嵌套深度限制，不能把原型当通过。分配已冻结4b的deploy_wiring（仍gpt-6.1-sol/high）只读协助检查runtime的/tmp合成原型，可复制到自己的临时文件做浅化/预算实测，不改repo、不覆写runtime原型；runtime继续拥有3b接线。优先固定浅层CTE与精确有序聚合，不通过增加请求/忽略体量绕过。两者交可运行SQL与实测后再批准repo实现。source_finalize转为3c prepared只读提案，仍不改冻结模块或010。

3b-1浅化SQL已审批准实施：runtime_wiring（gpt-6.1-sol/high）负责新storage-book控制器、management/Worker详情接线及manage客户端/分页UI和专项，不改pure source/deploy/prepared。固定单页SQL9567B/6bind（原型），schema/header构造前有界，reference/normal/targets/raw各20001探测并以spill确定完整前缀，最多100本；分开的book_payload/source_payload/window_count浅聚合通过真实Miniflare SQL，保留有序JSON子类型。保守UTF8外层预算对共享source重复收费、预留4096标点/分页壳，最后精确JSON.stringify(row)≤1MiB；不要求预算最紧，不增加请求。公开1264目录+1086合成confirmed实测13页、64–100本，max row344450B；大catalog前缀3本874456B、后置超大返回之前5本、超大首本overflow，转义/patch前缀2本950112B。详情复用同一单书投影且全局fileId冲突，owner会话和配置方法在await后复核；无逐file查询。metadata方向为原4statement同源snapshot排除metadata自身字段+guarded CAS+最终投影，但具体SQL须再交实测主审，不在3b-1提前写。全部本地验收后仍须3b-2/3c闭包才发布。

3c实际SQL及合成probe已主审，批准source_finalize（gpt-6.1-sol/high）实施prepared-source新helper、prepared消费者v2分支及窄pure export/专项；不改worker、010或其他冻结SQL。初/末sourceRow将原封source SQL嵌入一条statement，读取7751B/10bind；guarded admission8073B/14bind，比对初始完整source+prepared原文并绑定requestId/ip，只一次access。prepared固定26字段去重复catalog，descriptor/identity构造前帽、prepared≤16384B/source≤524224B/outer≤1MiB；其余raw文本总和也在JSON构造前有界，合法字段不受影响。纯`decodePreparedNormalSource`复用原decodeSnapshot/selection/结构及字节帽、强制normal，不注册read grant；不得裁同书其他file或伪造raw0硬套book decoder。normal原件及prepared pin逐项相等，trialonly/跨来源冲突初始零R2；完整raw pair在guarded INSERT与最终primary闭合，所有await后检查已捕获配置/DB/两来源及prepared方法，R2使用捕获方法。v2不调用旧admitAccess closure，v1保留旧行为；直load unknown/partial模式拒绝。总业务控制3 D1+P，连既有API3为6+P≤26，R2≤3，维护序数另计。合成probe实际source79886B/prepared2531B/outer85987B，版本漂移guard零新增admission；Node及真实workerd、20k块、await漂移/未知/取消/旧分支回归由主Agent独立验收。

完整pre-route整合回归发现cf01-history-inspect的隔离CLI fixture仅复制旧cf-deploy，漏掉新增公开shared依赖；不是生产CF01功能回归。deploy_wiring（gpt-6.1-sol/high）仅补该fixture的两个公开shared文件，保留preload零网络/配置拦截和原错误断言，不改CF01实现。主Agent独立复验后再跑冻结最终全套；本次失败原日志保留，Python未进入执行不算通过。

接续主审结果：N2b-4a部署接线已独立156/156通过，N2b-3a文件读取控制器已逐项review并独立375/375通过（含两项真实workerd，日志`/private/tmp/shelf-storage-read-main-review-verified-20261024.log`）。最初受限回环测试失败保留，最终本机提升测试零失败/跳过/取消。3a成功路径4 D1+1 R2、admission固定5456B/9 bind；旧入口关闭与旧v1回归通过。仍为未提交、未发布的本地结果。

批准source_finalize（gpt-6.1-sol/high）实施3b纯展示投影decoder，范围仅storage-sources及其新专项：单一高层`decodeStorageBookProjection(config,{projection_json,overflow},{audience,allowTrash})`复用精确schema/authority、normal/trial decoder及catalog归属校验，不能创建read grant。header一次、每书catalog一次、每file完整named facts；全局raw冲突先于book/visibility/trash过滤，raw=0允许未上传文件但不能产生confirmed事实。owner可展示回收站，anonymous仅public且非trash；输出仅安全registry及管理事实。原阅读wrapper继续拒绝trash，所有既有界限/strict结构保持；需要配置await复核时只增加复用原unchangedConfiguration的无副作用断言。依赖3a冻结，不改路由/shared/DDL/deploy。先交纯模块主审再接线。

3b展示接口补齐现有metadata/回收站兼容：books输入附一次metadata:null或精确scope/book_id/patch_json/version，patch≤32768B、{}合法，复用既有安全字段及categoryId ID校验。输出安全mergePublicBook结果、已验证patch/metadataVersion和deletedAt（trash时已验证updated_at，否则null），runtime不二次解析未清理payload。匿名public书继续应用其公开override，private/trash书及其事实不输出。新增canonical持久patch限制须先证明所有D1 producer契约，不将本地Python导入与云bootstrap校验混为一谈，不默默更改持久数据。

3b管理列表采用按book_id的用户点击keyset分页，不自动拉全库；旧Node/v1无pagination时保持原响应。runtime_wiring（gpt-6.1-sol/high）先继续细化单条primary投影及精确字节前缀方案，确认后才实施：每页最多100本，schema/header一次，按必要完整facts计算UTF-8预算，1MiB外层transport与20,000候选为独立硬上限；过大单本明确失败，不能跳过或静默截断。cursor严格校验且绑定SQL；UI说明本页数量，上一页/下一页，每点击一次请求一页，authEpoch/pageGeneration和登出/pagehide清理阻止迟到数据回填。详情/metadata仍须同源归属和全局fileId冲突；不得逐file新增查询。4b auth/static尚待精确设计，不提前实现。整批主审、完整回归/两构建/隐私及浏览器门槛通过后才按既有发布与回退流程执行。

4b精确提案已审，批准deploy_wiring（gpt-6.1-sol/high）仅改auth/static工具、guard完整snapshot摘要及其专项。仅v2 enable读取target配置，不将upload secret作为能力；status/init/close不读storage/target、不观测Worker，坏storage不能阻断close。初始与独立auth probe各合入同statement完整guard，仍1 verifier bind；CAS为固定≤16KiB SQL、6 bind，末参初始固定五字段storage_guard_json，重建后逐字匹配才enable。完整snapshot包含schema、authority phase及全部retained事实，内存/参数原文不入收据。保留两轮实际100%version/settings/subdomain及临CAS deployment验证，11实际HTTP/12上限，不增加读取；transport仍1,000,000B/30秒，新增4096块硬界。静态回退显式v2/closed/filename-ai及精确prepared状态，只接受对应完整动态前态，后态仅ASSETS与相同四secret名；settings前后2HTTP、close4另计、Wrangler内部另计。未知保留私有intent、零自动重发，成功仅settings_verified、codeVersionVerified=false。无云操作/close/enable/secret写/DDL/上传/AI；主Agent独立SQLite/CAS/漂移与旧流程回归后再集成。

本次接续先完成N2b-2最终主审：真实Miniflare/D1发现平台自带`_cf_METADATA`未被N2b-1整库契约识别，当前按设计503；prepared_finish（原gpt-6.1-sol/high）先交精确sqlite_master结构和本地平台来源证据，再由主Agent审查最小精确兼容，不按前缀忽略、不删除系统对象、不读平台表内容或云账号。主审另要求最终primary查询返回后复核env/binding/method，覆盖await期间配置漂移及已取body取消。通过后独立运行source/trial/contract/旧trial/CLI/workerd联合回归。

依赖明确后继续N2b-3/4，detail_finish（原gpt-6.1-sol/high）先只读提出deploy/auth/static的最小具体接线及预算，主审批准后实施；不与source文件并发修改，不云调用、不安装DDL/secret、不重放既定F4验收或部署。当前源码仍有F3浏览器待验范围，不能把全工作区直接发布；发布仍依赖同批controller/deploy/auth/static闭包和原完整门槛。浏览器本次再次检查无可用Chrome provider，保留原4418夹具，不重复要求用户提供同一准备确认。

本轮agent运行状态核对发现原prepared_finish/detail_finish已不在live inventory，旧followup未恢复任务；现由source_finalize与deploy_wiring分别接续上述两项，均显式使用gpt-6.1-sol/high，未换模型。新source agent确认无旧agent并发修改后才接管；两项仍先交只读提案，主Agent验收与发布责任不变。

平台兼容提案已主审批准实施：source_finalize仅扩展原N2b-1三文件与其测试、新source及专项，在离线生成器新增精确`_cf_METADATA`完整schema三变体（原三个profile不变），固定DDL为平台观测的INTEGER PRIMARY KEY/BLOB形状，row保留在原查询与raw快照；逐变体生成一致hash/计数/字节数，prepared仍拒绝009，trial-v1仍拒绝011。任意DDL/类型/附加平台对象仍拒绝，不忽略前缀。最终DB await后复核已在当前源码，须补deferred测试，并固定DB.withSession方法身份，覆盖resolve和最终verify期间env/DB/两R2方法或binding漂移；拒绝后取消已取body且不等待取消。真实Miniflare双桶和contract/旧trial/CLI联合回归由主Agent独立验收。010/011/012及N2a原profile不改，零云请求。

N2b-4a主审批准deploy_wiring（gpt-6.1-sol/high）先实现新的storage-deploy-guard与cf-api-deploy v2闭写接线及专项，不改auth/static两个工具（后两项待4a主审后接续）。采用显式`--storage-mode authority-v2 --write-mode closed --filename-ai`，与single-trial互斥；前后态仅trial+filename→v2（prepared不变）、精确v2重发、显式prepared开启或rollback，不接受partial/遗漏/反向trial。guard一条固定SELECT、0参数、≤16KiB，完整schema LIMIT257/接受256，authority≤2行/identity≤2048B、retained trial≤2行/descriptor≤4096B/target≤256B及其fileId普通confirmed冲突计数；精确复用shared contract/纯decoder，历史permit到期不阻断，unknown/部分DDL仍拒绝。控制响应≤1MiB/4096块/30秒，迟到body取消不等待，404也有界。v2显式管理HTTP为identity→settings前→guard→settings后共4，prepared共用guard，不含Wrangler内部请求；收据仅证明settings_verified，独立代码版本100%仍是实际发布门槛，不能把已有enabled状态当作可跳过。先交4a可审diff/实际计数与测试，再接auth enable投影与static精确回退；不云调用、DDL、secret写、部署、AI或书上传。未完成Worker/controller闭包前绝不发布此批。

N2b-3由runtime_wiring（gpt-6.1-sol/high）同步先交具体只读接线提案：Worker文件读取、详情/metadata/list同源唯一性、prepared原normal限定、最早关闭trial operator及普通upload gate。依赖source最终验收；不得先改source/shared/deploy及现有controller文件。提案须列每类实际SQL/参数/返回字节与access admission原子闭包、管理列表上限、匿名/私有展示边界，主审后才实施。该分工与4a文件互斥，继续零云操作。

N2b-2已由主Agent完整review并独立296项联合通过（source/trial/contract/activation/schema/remote-authority/single-trial-authority，含真实workerd双桶），日志`/private/tmp/shelf-source-main-review-20261024.log`；schema-only本机独立复验确认精确平台DDL及零外网，artifact --check SHA=`1120fee5ec07248f162793be667f1946e426a7463222b2215a92f4b9f6734757`、118565B。该结论限模块离线验收，无路由或线上发布。

批准runtime_wiring先实施N2b-3a：新storage-read-controller、Worker v2配置/文件路由分派/API config，以及Worker和两个trial导出入口最早404、management capability/intent/bytes最早closed；保留旧v1。source文件不改，bulk/metadata/prepared暂不接线。新文件控制器使用现有grant/只读adapter，最多resolve→R2后assert→guarded INSERT→INSERT后assert四条D1及一次选定R2；最终INSERT用guard CTE及编号参数共9bind，SQL≤16KiB，原快照/响应/deadline上限不变；任一漂移取消body，API/access各一次，不退回签名或其他bucket。新增专项必须有真实SQLite/workerd、Range/HEAD/If-Match、0/1admission、await漂移及operator零secret/D1/R2、closed零body/storage/claim/PUT。3a冻结交主审后，再批准3b所需批量纯解码接口与完整有界SQL；不得用逐file resolve形成N查询。未完成3b/3c/4b前不发布半接线版本。

F3夹具诊断先行：normal_transition（gpt-6.1-sol/high）只改scripts/book-browser-fixture.mjs，为parent原无界iframe.onload加覆盖load与结果的4秒wall-clock截止，harness原2秒wait改按实际耗时计时，写静态phase/readyState及合成route计数诊断；保留23场景、全部隐私/业务/一次POST断言。模块顶层await改为void async run以避免模块求值等待初始pageshow的潜在循环，仍同步登记并等待真实trusted初始pageshow，不伪造边界；iframe改为页面内可见。已知无界框架等待被修正不等于rich产品缺陷已定位，必须CUA恢复后重跑真实DOM。无浏览器时仅验生成JS/HTTP/断言保留，不记浏览器PASS；不改产品源码、不访问线上、不发真实书或AI。

本轮检查点：N2b-1主审联合140项通过，J0主审代码/SQL及独立47项（41 Node+6真实workerd）通过。J0修正延迟permit复核、terminal并发唯一消费、call到期后迟到成功隔离，012仍离线且默认closed。控制层实际SQL预算已核定：新admit 6SELECT+2mutation，planning 3+1，savePlan 3+(k+1)最多8条，claim 3+2，consume 3+0，workflowOutcome/finish各1+1，cancel 5+1，stop 3+1；失败回读admit最多加2、claim加1，trigger内部SQL另计。首轮受限测试57失败含回环端口EPERM及SQL/hash编辑中间快照，保留日志；提升为本机回环测试后1255项Node中1252通过、3项CLI smoke因隔离fixture漏拷新增prepared-schema依赖失败，Python未启动，不能称全套通过。detail_finish（gpt-6.1-sol/high）只修fixture公开依赖闭包，保留零真网络/错误断言，主Agent复审再重跑最终冻结快照。

N4的201行设计已由主Agent完整review接受为条件性结论：当前REST/GraphQL来源无法证明所需fresh/complete/account/billing证据；LIST不能替代账号覆盖或未决PUT终态，B残留上界仍缺历史writer全集且N1明确不接受B。该结论不是producer实现。N4a–c暂不继续编码，优先完成读取接线，不通过新增返回unsupported的抽象层掩盖普通上传阻塞；不申请新例外、不追加账号读取。

N2b-1四文件主Agent逐项审阅完成，独立契约/activation/schema-state/remote-authority共140项通过，artifact --check一致。原011与010 SQL保持冻结，012未知整库对象继续拒绝。进入N2b-2的第一小步：由prepared_finish（gpt-6.1-sol/high）只实现独立Workers双source只读解析模块、必要的纯trial历史decoder及合成专项；依赖已通过的shared contract与normal-read-wiring-plan。先提交精确接口/SQL/参数/返回字节预算供主审，再编码。暂不修改worker路由、management/prepared/deploy/auth/static控制器，不云调用、不安装DDL、不改生产gate。source必须全局fileId冲突先判、无跨桶fallback、归属与registry/reservation精确匹配，R2后最终primary复核；历史首本读取不依赖已过期permit或上传secret，旧trial-v1行为保留。

验收先覆盖真实SQLite/workerd双binding、同key异bytes、跨source同fileId和异book、残缺描述、catalog重复、生命周期/source/schema/auth漂移及有界投影，主Agent独立review后才安排控制器接线。该模块离线完成不等于生产可读或可上传；发布必须等N2b控制器成批接线、全套/构建/公开与秘密检查、两CI和独立有界线上验收。未发布时撤回新模块即可，保留现有生产版本及全部对象/旧unknown/消耗首本事实。

J0继续原Sol/high修正延迟permit、并发terminal context及调用deadline晚到结果隔离；N4继续原Sol/high只读证据设计。主Agent完成已审范围的整合验证，浏览器当前Chrome进程存在但CUA仍报cgWindowNotFound，F3 23场景仍未通过；既往前九项通过不能写成全部通过。5445388文档提交的远端CI查询本轮因api.github.com连接失败未取得结果，不重复发布已验F4或真实AI。

## 2026-10-23 全量未完成任务持续实施

N2b设计主Agent完整review通过（normal-read-wiring-plan）：采用精确shared deployment contract与生成的纯schema artifact、authority-v2/closed双源、保留四secret、旧trial mode不存在、prepared普通来源限定、raw冲突先于book过滤、trial operator最早零IO关闭；deploy/auth/static须同批接线后才能发布。先批准prepared_finish（gpt-6.1-sol/high）实施N2b-1纯contract/schema artifact及生成一致性/严格配置测试，不改Worker业务/部署/auth入口，不云调用。014等未来schema不自动允许；012当前仅离线，须后续明确扩展完整profile，不能宽松忽略未知对象。其余N2b-2 source/路由和N2b-3控制器接线在contract交付主审后实施。查询参数、语句、体量必须有硬断言，不能以新增上限掩盖超额。

N2a主Agent完整diff/helper审查及独立48专项、78项N1/trial/operator/selected整合通过，原子manifest覆盖紧邻mutation的结构漂移，冻结N1未变。尚未完整新快照回归/提交发布。normal_transition（gpt-6.1-sol/high）接续N4只读设计：逐项对照现有已授权证据源与公开官方契约，研究完整账号用量producer和A/B闭包可证明上界，给出真实可实现接口/证据覆盖与明确unsupported缺项，不能仅把现有验证器重命名成producer。只读项目代码/现有安全投影和公开资料，不读凭证明文、不云账号调用、不改数据或旧operator，不伪造完整性/零量/终态、不申请新例外。先交设计供主审再实现。

J0精确提案主Agent已审阅通过（cloud-jobs-plan第198行起）：10表/3视图/34trigger、queued起共享slot、append-only unit/release、SQL当前source精确快照、event驱动CAS与receipt原子终结。批准detail_finish（gpt-6.1-sol/high）按该提案仅新增012/jobs-state及必要专项/合成helper；主Agent后续逐行审查及独立SQLite/workerd验证。当前生产开关/路由/Workflows/secret均不变；不将草稿schema安装到云端，结构变化先报。旧filename行与009 guard不改、不复制消耗、不从回读/缓存nonce恢复发送权。

N2b接线先行设计分工：prepared_finish（gpt-6.1-sol/high）只读审查normal-upload-transition-plan的双来源闭写模式及当前prepared/auth/deploy/static validator，交付可共享的精确配置profile、读路径source冲突/归属处理、各operator预算和迁移前后兼容清单。依赖N2a最终schema profile，先不实现、不改现有业务文件、不云调用；不得抢先安装011、开放普通上传、恢复trial operator或将trial正文投影进normal registry。主Agent审查方案后再分配N2b实现。

T4设计主Agent已完整审阅docs/cloud-jobs-plan.md，采用其三项决策：Luna/low单活动、文件名与业务共享UTC每日20且J1一调用/J2最多四；未知逻辑永不重发，结束本地transport的unknown仅允许明确独立新任务，崩溃pending不按lease释放；J1开启依赖真实CF04来源/CPU、原session及独立Key。批准detail_finish（gpt-6.1-sol/high）仅J0离线实现：新012持久jobs/调用意图/预算/共享准入schema及纯业务状态模块，真实SQLite多连接与workerd合成；业务capability仍关闭，不改routes/Workflow/deploy/auth/现有009 SQL，不云DDL/凭证/AI。先交精确表/trigger事务接口与共享计数方案，再实施；保留旧filename行和唯一消耗，默认关闭业务gate不影响既有安全阅读，旧pending不释放。已完成的F3源码冻结，浏览器验收仍待完成。

F4最小发布隔离：当前CUA仍报cgWindowNotFound，F3的23项浏览器验收未完成，不随本次发布。主Agent先从30309a8建立临时源码快照，仅覆盖identify的manual redirect修复、两项对应测试和已安装的精确Miniflare/esbuild直接依赖；独立运行完整Node/Python、disabled/same-origin两构建、public/static及实际凭证扫描。计划与结果记入非公开docs/filename-runtime-release.md；不包含F1、F2、N1、N2a或其schema/绑定。快照全部通过后只提交该批文件，推送并等待两CI，以对应提交的隔离快照受控部署现有single-trial/filename-ai配置。显式管理HTTP上限3（前后settings及D1身份），Wrangler内部请求单独计；独立active version回读1HTTP，三个公开字节比对、既有14项阅读HTTP回归及前述唯一F4合成验收另按各自runner预算执行。部署不新装secret、不迁移、不上传书；未知部署停止不重试，已有收据与旧unknown保留。失败保留现有生产版本，若需代码回退须先核定明确版本和完整配置，不能自动部署或复用AI请求。

F4修复验收的执行前固定契约：仅合成文件名`书名：星际航线_作者：虚构导航员_分类：科幻短篇.epub`，固定requestId=`7e3d62af-9518-4e24-a236-96c8f1b3b80c`，仅一次新identify POST。私有runner `/private/tmp/shelf-filename-identify-repair-acceptance.mjs` SHA256=`70cdcf6cb16e55f5cb44691f4911c9872da2fa6a91264130bddd48112d2073ba`，主Agent独立18项测试通过。总上限10 HTTP：匿名结果拒绝、登录、能力、两条历史unknown各GET、新POST、新结果GET、能力余量、登出、旧会话拒绝；每请求70秒、整轮240秒，预留最后两个清理槽。任何失败停止该轮，不换输入/requestId或新run重试；调用前落全局不可覆盖attempt，两条旧收据前后hash相等。只发送文件名，不上传原件、不重发secret PUT。必须先完成runtime修复的commit/两CI/受控部署和回读，再执行。

F1后续部署接线设计已由主Agent review：prepared_finish（gpt-6.1-sol/high）实施独立无云依赖的010 schema helper、显式production `--prepared-text` / `--prepared-text-rollback`、完整前后态配置校验与部署前只读schema/authority guard，以及显式静态回退识别。`PREPARED_BOOKS`仅绑定普通`the-shelf-books`；保留现有隔离`BOOKS`及trial/filename配置，四个prepared配置必须完整匹配，省略flag不能隐式移除。部署器不DDL、不上传、不安装secret，缺010在Wrangler前停止。验证含参数前置拒绝、双桶/账号/部分配置、010篡改/缺失、旧→prepared/重部署/显式回退、缺表零R2与首本阅读回归。此为离线实施授权；须主Agent独立review、专项/完整测试及两构建/隐私检查后提交发布。之后010 schema-status/apply/独立status上限10+33+10=53 HTTP/13 DDL，固定010 SHA=b70ad99611023bde6aa08901cd8eeebbdeeae0cd38e96f0ea8dec93e566afd0f，先于011；未知DDL停，仅只读恢复不重放。实际prepared启用部署另行核定前后置请求与Wrangler范围，不能把显式管理HTTP误作整次部署上限；无已确认正文仅做负向和既有PDF回归，不称云正文消费通过。

T4前置设计由detail_finish（gpt-6.1-sol/high）在F3交付冻结后只读进行：对照Node jobs、AI契约和Workers安全/预算，实现前先划分CF-05持久任务最小批次与接口。须明确D1持久dispatch intent、去重/每日与逐任务预算、Workflows重试关闭、上游无状态查询时unknown永久保留及零重发、来源快照/主动公开权限、查询/取消与真实验收预算。仅形成非公开设计，不实现或接线、不读凭证/云调用/真实AI；主Agent review设计后再分配具体代码。F3浏览器问题仍归原任务，不能以新设计替代其验收。

N1已由主Agent审查SQL/module并独立41项通过。批准normal_transition（gpt-6.1-sol/high）实施其`docs/normal-upload-transition-plan.md`的N2a：新增Node精确schema profile与责任读取模块，RemoteStorageAuthority识别完整旧/005/011布局，所有audit始终计normal+trial+legacy；schema2历史activation按当时activatedAt验证，新reserve/claim仍实时核验证据，v2禁止旧重新导入及首本操作。缺项/混合/陌生schema失败关闭，重新核定固定查询及operator预算；不得扩大旧registry为跨桶来源。仅离线实现及测试，不改Worker/deploy/auth/prepared接线、不云写/安装011/激活/上传；N2b/N2c先保留设计。主Agent需独立审查读写边界、竞争/迟到/旧测试兼容及完整回归后才发布。

接续批次（主Agent复核后实施）：F3通用动态详情页采用`/book/?id=`空壳，静态SEO页保留；复用现有单书API，由API决定公开/私有/回收站可见性，动态内容用安全DOM填充，新书详情与reader返回不依赖构建时ID。详情、reader须固定book/file归属，迟到响应和登出清理私人数据。此任务涉及隐私边界，交由新Sol/high实施（而非Luna）；task_inventory（Luna/medium）只更新事实清单与文档。验收含新ID、匿名私有/回收站拒绝、错误file归属零content请求、无页面浏览触发AI、basepath、静态回归和真实DOM。F4由manage_api（Sol/high）准备修复后的唯一独立合成AI验收方案/runner，主Agent独立review和部署后才能执行。两次历史任务及同名去重永远保留；新增验收仅因真实workerd证明redirect:error在发送前TypeError、已修复manual的实质新证据。原诊断轮两次上限仍是该轮事实；新修复验收轮最多一个新合成文件名/一个固定requestId/一次POST，不重复secret PUT，失败停止该轮并记unknown，不自行续次。精确输入/HTTP预算由runner设计后执行前补充。F1消费者继续主Agentreview；cloud_tasks（Sol/high）先修复行字段比较脆弱性，再设计路由和索引发布operator，批准细化范围后实施，不云写。各项最终仍按完整测试、两CI、受控部署及真实验收发布；失败保留全部对象、旧记录、schema和当前安全阅读版本。

目标：按用户最新目标完成项目全部未完成开发，不在单项结束后停止；逐项实现、测试、更新清单，最终以完整测试/构建及每项对应验收证据判断完成。先建立统一当前任务清单，逐条对照本计划、implementation-plan、remote-storage-plan、cf03-plan及实际代码和运维证据，历史计划不直接视为当前状态。延后事项也纳入盘点，依赖外部AI契约的能力明确记录，不伪造已支持。

F5普通上传迁移设计由normal_transition（gpt-6.1-sol/high）接续：检查当前003/005永久trial guard、原authority目标与生产隔离BOOKS、registrySource读取和全部账本责任。目标是在保留已上传首本可读及一次许可永久消耗的前提下完成正常模式；先交增量迁移、独立激活CAS、双来源读取/恢复及部署契约设计，再获主Agentreview实施。不得改冻结迁移、手填ready或新鲜完整证据、清unknown/责任、重放旧写、开新上传例外；未满足真实门槛仍不云写。验收应覆盖首本+普通责任精确计账、8GB边界竞争、模式/目标错配、部分迁移崩溃、撤销/回收站及唯一PUT，部署回退保留对象和全账本。按实际平台证据区分可实现技术缺口与确切外部限制，不把旧drain方案当唯一解，也不将其不可能条件永久挂在产品入口。

实施依赖：T0主Agent核对工作区、未推送提交和网络，恢复11364f3/30309a8发布及009/文件名识别真实验收；原两次AI任务上限和未知不重发规则继续适用。T1统一当前任务/证据清单；T2普通上传的旧入口收口、唯一账本、完整用量证据及隔离目标迁移；T3 CF-04私有正文同步与D1索引；T4 CF-05持久任务、去重/预算、问答/章节/全书总结、作者资料与主动发布；T5 CF-06上传核对、未知任务处理、备份恢复与跨设备进度；T6格式转换/OCR/只读MCP及流式输出契约逐项评估实施。依赖未满足时继续其他可独立开发任务，不能把临时关闭的入口记成普通功能可用。

本轮初始分工：task_inventory由gpt-6-luna/medium只读全量任务与实现证据，编写docs/task-status.md，避免把旧历史表当当前事实；normal_upload由gpt-6.1-sol/high先核对普通上传的实际阻塞、旧能力与用量证据链，给出最小可执行迁移/实现设计及测试，不云写；cloud_tasks由gpt-6.1-sol/high先盘点CF-04/05生产缺口、共享契约及独立可开发模块，提出实现范围/依赖/验收再实施。主Agent负责计划、接口裁决、review、集成、发布及最终验收。指定模型不可用时明确暂停对应分工。云端动作仍由主Agent在既有授权与具体请求预算内执行，不重置首本许可、不改未知事实、不修改计费。

首批新增实现细化：F1由cloud_tasks（Sol/high）补齐已确认正文版本的Workers消费及D1私有定位索引，复用selected-sync/registry/shared校验，保留20MB/20,000chunk/6000字符原契约；索引header、逐chunk原语与publication分表，避免D1单行2MB限制，不存正文、不新造预算。固定file/version与同书原件授权；head→条件get/hash→head最多3次R2、30秒整流期限，所有外部await后复核会话、管理版本及源身份。D1最多26条statement、最多20页，API仅返回有界摘要/locator，不输出私有路径/hash/ETag。本阶段仅新模块、增量010及测试，后续独立接路由、导入operator和部署绑定；合成通过不称已上线。F2由normal_upload（Sol/high）在当前009发布完成后实施已有reservation恰好占满8GB仍可claim的边界修复与条件PUT；intent仍禁止无余额新增，超1byte、身份或证据不符仍拒绝。onlyIf If-None-Match:*冲突/null/未知保留uncertain且唯一PUT资格不重给，不能靠此开放普通上传。主Agent逐项review与独立专项后继续下批。

验收与发布：每项完成必须附当前文件/测试/实际行为证据，并在任务清单更新状态；代码完成、本机浏览器、远端CI和线上验证分别记录。每个实现批次主Agent独立review与适用专项，最终完整Node/Python、构建、public/static和实际秘密扫描通过，再commit→push→两CI→受控部署→对应真实HTTP/浏览器。旧用量未知及只允许首本试运行的既有规则没有被最新宽泛目标自动豁免；持续解决其技术依赖，不以解除disabled或伪造ready代替迁移。无法满足的外部契约/权限须有实际证据并列入清单，不能宣告全部完成。

回退：保留当前可用私人阅读、所有schema/registry/对象/unknown及收据。每批按自身迁移状态选择保留安全读取的修复回退；完全关闭按显式trial/filename-ai静态回退并撤销会话，不自动恢复旧写能力，不删除责任或重发未知上传/AI/secret。私有数据和新运维文档不加入公开导出清单。

## 2026-10-23 识别失败隔离与有限诊断

目标：真实首个合成文件名识别返回未知后，纠正“任何未知都会永久阻止所有其他文件识别”的调度设计。主Agent和两个Sol独立复核确认，这不是AGENTS对AI的硬性要求；不得把上传authority的未知阻断类推为所有独立AI推理不可继续。原调用仍未知、没有结果，绝不删除/改判/重发；普通上传及旧存储未知边界完全保留。

方案与范围：永久保留每个规范化文件名的hash去重及所有结果/失败/unknown，unknown继续计入其原UTC日20次新调用预算。仅pending继续占全项目当前发送资格；本轮不自动回收崩溃pending、不按时间证明上游终止。已持久uncertain不再阻止真正不同文件名的新任务。新任务仍原子准入、固定gpt-luna/low、文件名长度限制、60秒、最多一次POST；不宣称此本地锁控制其他项目或证明旧上游停止。网关并发1/无队列由服务方控制；新任务遇busy/其他unknown仍保留责任，不自动排队或重试。次数与输入上界不是金额封顶，必要的一次新probe在既有本项目合理费用授权内。

新增独立009迁移，008原文件/hash不改、旧识别行逐字保留；只精确更换准入trigger的uncertain总闸，并新增私有不可删除诊断表，以同一终态事务记录新调用的有限观测。观测仅固定失败阶段、100–599状态或null、有界耗时/字节/块数、静态类型与校验布尔，request-id只接受32hex/canonical UUID，否则仅形状布尔；不存原始响应、任意错误文本/字段名、URL、文件名、key或书籍正文。缺少旧诊断仍缺失，不补造。服务端、API capability与UI一致表达：旧文件待核对，其他独立文件可识别；同名缓存/uncertain永不重发，绝不靠换ID/contract绕过。

分工依赖：A4 manage_api由gpt-6.1-sol/high实现009精确SQL、准入/观测事务、服务端与竞争/未知/隐私测试；先交付schema/观测契约供A5。A5 identify_deploy由gpt-6.1-sol/high实现独立固定production迁移operator（默认0IO、有限HTTP/DDL、不可覆盖意图与未知不重放），保护原schema/authority/trial/auth/007及全部008数据指纹；新独立合成验收runner最多11业务HTTP/1额外上游任务，旧runner/attempt不改。A6 manage_ui由gpt-6-luna/medium检查旧文件uncertain后换独立文件的准入/提示/过期响应及17场景不退化，仅必要UI/fixture调整，不改后端。主Agent负责最终契约、独立review、集成和验收。

验收：合成验证uncertain保留且仍计费/同名不可调、不同文件可原子准入、两个pending只胜一个、崩溃pending仍阻断、无新预算/旧unknown清理；诊断无secret/rawbody且终态与观测原子一致，维护会话不受历史记录影响。主Agent专项及适用全套Node/Python、disabled/same-origin构建、public/static/实际秘密扫描、真实浏览器（工具可用时）验收；浏览器不可用不得声称线上DOM通过。之后commit→push→两CI→009 status/apply/独立status→受控filename-ai部署→固定日志绑定/活动版本回读→3个公开资源GET→新独立合成probe及固定PDF只读回归。迁移准确HTTP/DDL预算与新probe输入须由主Agentreview后、执行前补充；不重发secret、不改计费。

本轮AI任务累计最多2个：旧1个已unknown且验收失败，新1个用于新版不同合成资料的诊断与功能验证；使用新固定requestId、不同语义合成书名，不重做旧书名或借改名恢复旧结果。新probe无论成功/失败/unknown都不追加第三个任务。失败保留全部责任、完成登出和只读记录；代码回退保留009与原008/所有数据，可关闭识别但保留现有阅读，完全静态关闭仍按显式trial/filename-ai回退与会话撤销。未通过真实验收仍不得宣称AI已接通；旧首本许可、上传关闭和存储未知不受本修订影响。

执行清单补充：009 status正常9HTTP/硬10/0DDL，apply正常25HTTP/硬26/6DDL，独立status同前；三步正常43HTTP/硬46/6DDL。先建诊断表及三个保护trigger，再建admit_v2，额外精确回读全部新对象及仍在的旧guard后才DROP旧guard；中间双guard只会更保守，不存在无准入保护窗口，不假定REST多语句原子。未知DDL不重放，原schema/authority/trial/auth/registries/007及全部008行前后指纹一致。新固定probe文件名为“书名：雨后山谷_作者：示例编辑_分类：自然随笔.epub”，requestId为`c2d6ff51-834a-4a65-a021-b179dc0cf676`；最多11业务HTTP，其中失败时只读GET诊断并登出/撤销、无第二POST。旧attempt/unknown不变，准确迁移SHA及实际验收结果在执行前后分别记录。

主Agent发布前独立验收：009冻结SHA256为`46607c049ca3d16afc2a50fa6f27cf01c7aba6b5fa7073616c2461d9c19bebcd`；专项56项、完整953项Node及8项Python全部通过，零失败/取消/跳过。第二独立合成验收runner经review修正failed→502诊断读取及状态映射，14项合成测试全部通过，仍最多1额外AI/11业务HTTP。Chrome Tuo真实浏览器18个管理页合成场景全部通过，包括同名不重试、旧unknown后新文件识别、手改保护、上传及回收站恢复。真实AI执行和发布结果在后续记录，不能把合成通过记为AI接通。

## 2026-10-23 上传可用性与文件名 AI 识别

目标：修正管理页必须手填元数据的流程。用户选择文件后，仅把文件名发送给所有者鉴权的AI识别服务，自动填充书名、作者、分类；结果可修改，不外送文件正文。明确区分“识别资料”和“上传原件”的能力、进度和失败。当前生产普通上传仍关闭（trial隔离目标、authority imported和过期/未知用量），本需求不豁免8GB/20MB和旧未知证据门槛；不能只解除disabled或重置首本一次许可。

方案与范围：复核现有AI任务服务的最新guide、真实Key及部署契约，优先复用现有命名任务和持久调用预算/去重；AI边界、模型输出严格白名单/长度校验、会话/Origin/CSRF、超时无自动重试和私有元数据均由Sol实现。上线前须有真实合成文件名调用验收，不能用本地文件名规则冒充AI。文件选择优先展示，识别结果默认填入可选编辑区，不要求用户手填；空缺与AI不可用给出明确状态/可编辑回退；换文件迟到响应不能覆盖新文件或用户修改。上传关闭时显示具体原因与不可用按钮文案，允许独立识别但不发送字节。复核普通上传实际缺项，只在既有证据门槛真实满足时迁移，不扩读其他业务数据、不新增上传例外、不改计费。

分工与依赖：主Agent负责计划、接口评审、集成、独立验收与发布。A1由既有manage_api（gpt-6.1-sol/high）先只读设计上传缺项及AI后端/密钥/持久预算/部署最小方案；收到主Agent契约确认后实施安全后端与合成测试，不自行云调用、迁移或部署。A2由既有manage_ui（gpt-6-luna/medium）在契约确认后负责文件优先、自动识别、可选修改、并发与不可用状态及浏览器fixture；不修改API鉴权/预算。主Agent不以子Agent自报替代验收，指定模型不可用时明确暂停该分工。

实施契约补充：新增严格POST /api/manage/identify {filename,requestId(UUID)}，仅basename/支持格式/255字符及1024UTF8字节；同步60秒，不重试POST。D1对contract+文件名hash永久去重及私有结果缓存，单一全项目持久在途claim、UTC每日20次，未知也占用次数及claim，崩溃/超时不自动租约释放。重复pending只返回202固定同源GET pollUrl，已完成200 metadata三字段（可null），未知409并阻止新调用；外部await后复核会话。服务固定gpt-luna/low/json_object及固定HTTPS任务入口，禁止redirect/正文外送/模型改端点。UI按选择代次忽略迟到响应并保护手改字段；无法识别的标题可明确以文件名暂代，用户不必填写。A3新增gpt-6.1-sol/high identify_deploy，负责受控显式--filename-ai部署模式、FILENAME_AI_MODE=filename-v1及FILENAME_AI_KEY secret安装/严格回读/静态回退与隐私扫描；依赖A1环境契约，和A1/A2独立文件范围实施。secret安装默认零IO预览，固定项目Worker和持久意图，unknown不重发，不因GET名称存在声称值验证。

验收：无登录/错误Origin与CSRF不能调用AI；仅文件名进提示，不含文件内容/path/key；未知模型输出拒绝、不插HTML；重复/并发及超时不会重复调用，调用上限和恢复持久。换文件/手动修改/识别失败/关闭上传/正常单次上传/未知不重传均通过合成浏览器。主Agent独立review、适用专项和完整Node/Python、disabled及same-origin构建、verify:public/static与实际凭证扫描。真实AI只使用合成文件名，固定有界请求清单在执行前追加；无有效凭证或服务契约不能上线时记录确切阻塞并完成独立前端改进。

发布与回退：本地验收通过后commit→push→两CI→受控same-origin trial部署→HTTP及真实浏览器验证；不得将disabled产物覆盖生产API。新增secret/schema须独立精确目标/请求预算/回读设计，不扩大现有部署validator或把线上AI未经验证记为已接通。失败保留旧Worker、旧账本、未知与全部对象/首本许可；回退使用保留回收站访问复核的既有575abdb特性或显式静态回退及会话撤销，不退回缺失生命周期检查的代码。


本轮生产执行清单：主Agent已独立通过识别核心15项、008工具7项、部署/secret及私有恢复54项、真实合成runner8项、UI7项专项；适用全套/构建/浏览器最终结果另记。008固定SHA为`a2d6f76e54365eff03361902f1484373e80c6c8350d50fb71dd0f4c8cee0fe15`，原base/007不变。所有本地门槛及该提交两CI通过后，依次固定production 008 status（<=10HTTP/0DDL）→apply（<=24HTTP/6DDL）→独立status（<=10HTTP/0DDL），核对原schema/authority/trial/auth/registry/007行前后指纹；未知DDL不重放。secret安装器先零IO preview/纯本地prepare，然后唯一install（4HTTP/1secret PUT；D1身份、旧settings、新secret、严格过渡态settings），unknown仅允许单独review的recover（2GET/0PUT），不把名称存在当值验证。受控部署为`--profile production --single-trial --filename-ai`，postflight只接受固定原DB、隔离BOOKS、原三secret加一AIsecret及精确mode；部署结果未知不重复deploy，必要时钉本次私有log SHA/UUID后用已review的2GET恢复helper独立确认。保留原production会话generation，不安装旧R2写key、不新增PUT许可。

上线验收仅固定3项公开资源GET并对比same-origin本地字节、最多11业务HTTP的合成filename runner（匿名/登录/能力/CSRF/Origin拒绝、单次真实识别、同名缓存与GET结果、日预算仅减1、登出与撤销），最多1个上游AI任务，无重试、无书籍正文/真实书目变动/上传字节。随后复用既有14HTTP/硬上限15的固定PDF只读验收；不为证明按钮而上传新书。浏览器分别观察生产匿名登录入口及本机17个合成DOM场景，生产AI实际结果以HTTP收据为证，不将mock称生产浏览器闭环。任何失败停止受影响动作并保留unknown/receipt；必要静态回退命令增加显式`--single-trial --filename-ai`，保留4secret、008和全部存储/识别责任，另按原会话撤销方案关闭阅读入口。最终结果仅写非公开运维交接，不自动发布新运维文档。

本轮本地最终验收：主Agent独立完整931项Node及8项Python通过，零失败/取消/跳过；Chrome Tuo真实浏览器17个合成管理页场景全部PASS，另独立展开编辑区确认手改书名被保留。部署/secret最终23项通过。首次完整回归的既有fsync密集测试在默认文件并发下超时，保留失败记录；仅将Node测试文件并发限制为4，未改超时、断言或生产行为，随后全套通过。最终same-origin构建、公开/静态/真实凭证扫描及本提交CI仍在发布门槛中，生产AI尚未执行。

远端CI修正：5db33b3的两CI均在两个新增真实SQLite测试失败，原因是测试临时目录硬编码macOS `/private/tmp`，Linux runner不存在；本地通过不代表该提交CI通过。原Sol/high manage_api只修改测试临时路径为系统tmpdir并检查同类新测试，不改生产、断言或云状态。主Agent独立review、22项专项及修正后完整932项Node/8项Python全部通过，零失败/取消/跳过；随后重建并检查公开/静态与凭证，再提交新版本并重新等待两CI。此时所有真实迁移、密钥安装、AI调用及部署继续为零。

## 2026-10-23 新需求：网页上传、删除与多格式阅读

目标：所有者可在网页逐文件选择、校验、上传书籍并取得可阅读条目；可将书移入回收站并恢复；PDF、EPUB、无DRM的MOBI/AZW/AZW3可在浏览器阅读。接续未提交的详情文件动态按钮，保留现有首本PDF阅读。当前线上只有固定首本试运行，通用上传和上述管理尚未上线；不得将本计划或前端按钮写成云功能已验收。

范围：新增所有者管理页、受会话/Origin/CSRF保护的管理API、持久元数据/回收站及单文件上传状态；复用唯一远端预算authority，不新建余额、不重置首本许可。上传仍20,000,000字节/文件、8,000,000,000总预算、逐文件、私有；现有unknown/guard/imported责任保留。旧单次例外已用完，本需求授权功能开发但不自动豁免后续真实上传的证据门槛。删除默认可恢复的逻辑删除，隐藏条目并阻止文件访问，保留对象和预算；本轮不永久删除原书、清理账本或修改计费。DRM、损坏及不支持的Kindle变体明确报错，不绕过DRM，不外送原书或借AI转换。新文件元数据默认私有，不自动加入公开静态目录。

方案：先核对现有authority、binding隔离和catalog约束，由Sol提交可实施的API/表/上传状态契约，再编码。普通上传必须使用原authority的原子预留、唯一不可重试PUT资格及独立内容确认，响应未知保留额度并停止自动重试；无法取得合格生产证据时返回明确不可上传原因，不能回退单次许可或直传绕过。回收站读写和文件访问复核同一持久状态，处理并发删除/恢复/撤销。管理页支持输入书名/作者/分类、单文件、进度/待核对状态、重复点击抑制，上传后使用动态详情入口，避免依赖重建静态路由。多格式阅读优先评估成熟本地浏览器解析库，固定版本/许可，限制书内脚本、网络、导航、资源与解压开销；保持目录、翻页、字号/主题及本机进度，原件下载保留。

设计评审补充：普通上传仅在非trial生产模式显式启用normal authority路径、绑定与原authority账号/桶完全一致、phase ready、当月完整证据在5分钟内且账本预算足够时执行。当前隔离首本绑定与原authority目标不同且phase imported，因此本轮生产普通上传继续准确显示阻断；不写死永久关闭的伪实现，离线以真实SQL/合成R2验证正常路径。API契约为所有者GET /api/manage，单文件POST /api/manage/uploads先登记意图，再对服务端返回的固定bytesUrl作一次二进制提交；重复hash不另预留、不自动重发，unknown保留。007增量表记录私有/回收站状态和上传意图，与原余额共用事务。阅读器初版采用固定官方MIT MOBI/KF8解析源及本机EPUB解包，文本优先，省略原书CSS/图片；解析隔离与可终止超时，显示仅允许重建的文本排版，受DRM保护或HUFF/CDIC等未实现变体明确拒绝。该限制须在产品提示和交付中说明。

任务与依赖：主Agent负责计划、架构/契约评审、集成、独立验收和发布。M1为gpt-6.1-sol/high，负责安全/预算/持久化/API设计及实现、迁移与安全测试；先提交设计，再按主Agentreview实施。M2为gpt-6.1-sol/high，负责阅读器库核对、恶意内容隔离、多格式解析/渲染和格式合成样本测试；独立于M1但不得修改管理页面。M3为gpt-6-luna/medium，依赖M1明确契约，负责管理页面、上传/回收站交互及动态详情入口，不实现授权和预算。最多三名子Agent同时工作，主Agent不以子Agent自报替代验收；模型不可用明确说明并暂停受影响分工。

验收：匿名、错误Origin/CSRF、过期/撤销会话均不能写；上传超过门槛、空文件、类型/魔数不符、预算未知/不足拒绝且无PUT；重复点击/并发只发一次，未知结果不自动重传，其他已存在数据保留。删除后列表/访问立即一致，恢复可读，旧未知和首本结果不改。无DRM的EPUB/MOBI/AZW/AZW3真实合成文件可解析并通过实际浏览器验证章节、导航和资源；脚本/外链不能执行或外泄，损坏/DRM明确失败。Pages/disabled构建管理操作禁用，PDF和旧本机模式保持兼容。主Agent审阅代码并独立执行针对性、完整Node/Python、两构建、verify:public/static和凭证/正文泄露检查；浏览器不可用时准确记录限制，不把解析测试冒充渲染验收。

发布/回退：适用本地门槛通过后commit→push→Cloudflare/Pages CI→重建same-origin trial API→受控部署及真实有界HTTP/页面验收；不得将当前disabled dist当业务包发布。线上schema/配置操作需先有精确目标、增量迁移/回读与请求上限计划，不重初始化auth、不重发首本PUT、不借新测试删除已上传原书。真实普通上传仅在正常预算证据合格时逐文件执行；不合格时上线清楚说明原因的关闭状态并如实报告，继续交付其他功能。新增表/对象/责任记录保留。仅当管理表仍为空时可回退旧已验收trial代码；已有回收站操作后，旧代码不具备trial生命周期复核，必须使用保留复核的修复版本或显式trial静态回退并撤销会话。严重读取安全问题同样静态回退，不能只auth close而遗留operator入口。

本地独立验收：主Agent完整回归898项Node、8项Python全部通过，零取消/跳过。历史schema兼容问题已改用独立007迁移修复，基础schema逐字不变；最终针对性40项管理/迁移/阅读器测试通过。disabled与same-origin构建均1281页，public/static检查和实际凭证扫描通过、零秘密命中。Chrome tuo配置已恢复本机CUA访问；主Agent观察合成EPUB/MOBI/AZW/KF8真实Worker解析、CSP/净化、目录/导航/字号/主题/进度/清理全部PASS，并手动切换章节确认正文。管理页真实DOM七项（匿名、阻断、正常单次提交、重复意图、未知不重传、回收站确认、恢复冲突）全部PASS；只用合成书/本机mock，不冒充生产上传。

真实发布操作计划：两CI成功后，对固定production原D1执行007 status（最多9HTTP/0DDL）→apply（最多23HTTP/7DDL）→独立status（最多9HTTP/0DDL），逐请求私有持久收据，原authority/预留/registry/首本结果/auth_config前后指纹相同；unknown不重发。迁移complete后按现有single-trial受控部署工具发布，保留隔离桶与原鉴权，不添加普通上传配置。线上管理验收固定最多9请求：匿名管理401、公开catalog-state、登录、所有者列表与关闭原因、纯合成元数据上传意图409、无效CSRF与错误Origin对不存在合成ID的trash拒绝、登出、旧cookie拒绝。生产仅首本PDF，不为验收新增目录或删除/恢复真实PDF；实际trash/restore由本地SQL与浏览器合成夹具验证。随后原有14请求/上限15的只读PDF阅读与安全验收，不发PUT。浏览器核对上线管理页及原PDF。任何异常停止受影响步骤并保留收据，按上述回退边界处理；提交、CI、迁移和部署结果另行记录。


## 2026-10-23 已批准：首本单次隔离试运行

目标：用户明确回复“允许”后，完成首本<=20MB私人文件的一次上传和在线阅读闭环。该次允许账号用量/旧请求终态未知及实际总量可能超过8GB；不伪造完整证据，不修改计费，不扩大为后续上传许可。此前“待用户决策/未获授权”段落保留为历史，以本节为准。

范围与方案：保留旧authority imported、六guard、全部旧unknown/责任；使用旧CF01绑定及旧桶凭证不能访问的项目隔离桶与新桶专用凭证。在原唯一D1 authority内添加单次例外许可/预留/结果，固定账号、目标、文件ID/hash/key/大小/期限，一次PUT后不可再次领取；正常ready/evidence门禁继续不变。响应丢失/崩溃保留预留，只允许经review的同对象有限只读恢复，不补发PUT、不清账、不删除对象。阅读绑定明确存储目标，保持私有、会话/撤销、CSRF和Range/完整性检查。先设计评审后实现，先本地验收/提交/CI后云操作。

分工及依赖：主Agent负责规则记录、架构评审、集成、独立功能验证、发布及真实有界云操作。T1由gpt-6.1-sol/high设计并实现原authority内的单次许可、SQL保护与并发/崩溃/未知测试；先交设计等待主Agentreview，再编码。T2由gpt-6.1-sol/high设计隔离存储、专用凭证、固定目标读取与部署接线及精确请求预算；先只读设计，不创建资源，不读私人正文，依赖T1契约再实施。T3前端既有Luna/medium交付由主Agent继续真实浏览器验收；未通过不宣称上线。新增简单文档随集成维护，不另开无依赖代码任务。指定模型不可用则说明限制，不替换。

分工细化：第三项安全敏感实现由gpt-6.1-sol/high负责新增single-trial操作器及专项测试/说明，复用选书与私有journal，依赖T1许可接口和T2固定目标；不修改authority/runtime/deploy文件。原前端Luna交付改称T4，由主Agent独立验收。固定候选隔离桶为the-shelf-first-book-20261023，生产显式trial模式只带新桶读取绑定与凭证，默认/check行为不变；不得同时部署旧桶写凭证。资源/凭证创建方法尚在设计核对，未执行云操作。

验收：许可不可复用，双连接竞争只准一个，过期/目标/大小/hash不符拒绝，unknown永久占用额度；正常上传仍拒绝、旧事实不变。隔离目标/凭证权限须实测读回，只含新项目桶，不配置公开访问。专项、完整Node/Python、disabled构建、public/static/凭证检查通过；commit→push→两CI→受控部署→独立回读。真实操作前记录固定文件的私有选择依据、精确HTTP清单/上限和恢复步骤；原书不送AI。验收区分本地、CI、云端HTTP和真实浏览器；不得用静态200或mock代替读书成功。

实施路线评审：新桶S3凭证签发需要API Tokens Write，不能从已有旧桶对象key推断能扩权；浏览器也不可用。因此采用不依赖新S3凭证的binding-only路线：固定新桶BOOKS binding作为隔离能力，生成仅项目专用SINGLE_TRIAL_UPLOAD_SECRET，显式trial生产模式不携带旧桶S3凭证。T2负责固定上传与同源私有全文/Range接口，T3仅一次HTTP上传、不先在本机领取PUT资格；Worker在完整大小/hash匹配后于原D1 CAS领取唯一资格，再最多一次BOOKS.put。未知不补发。T1与T2共享精确claim/schema契约；独立有限同对象HEAD/GET核对后再确认账本。阅读复用现有会话/撤销/目录描述和外部await后的原子复核，避免添加公开对象或跨域签名入口。这是批准的专用访问能力实现方式，不以不存在的桶凭证充当隔离证据。

本地实施检查点：T1交付SQL005/006、原authority单次许可/同余额预留/只读恢复和9项新增专项；主Agent独立review并运行38项专项（含29项原authority）全部通过。SQL006保留原会话generation/enabled约束，新增精确候选目录匹配的已确认单本分支；旧SQL003/004不变。原客户端不启用trial检测时请求预算不变。T3主Agent复审补齐无视abort、零字节洪泛和永不完成cancel的有界保护，独立25项专项通过；T2已交付，待主Agent最终复审及全套回归。主Agent已在私有目录生成专用secret/target配置及单文件选择（均0600、目录0700）；选定PDF为24,582字节，本机实际读取并由PDF.js解析为1页，未输出正文或标识。真实single-trial plan返回planned/unknown、零云请求。未创建桶、未应用新schema、未发许可或上传。浏览器无可用surface，支持文档中的launch_app在本机运行时也未提供，页面验收仍待恢复。

部署依赖补齐：Sol/high只读复核确认旧SQL004不阻止目录bootstrap，现有全目录1264本会产生89HTTP，首本试运行无需引入全部目录。如生产尚无目录，T3继续以Sol/high在同一操作器增加最小catalog动作：固定D1/auth关闭、catalog/overrides为空且无active import时，从已跟踪公开目录选中唯一书目，经原bootstrap()和明确空overrides导入，正常7HTTP、硬上限10，逐请求durable intent；独立回读精确候选和导入fingerprint。明确其为单本API目录，公开静态全目录保持；非空/未知不重置、不自动resume，已有匹配目录则跳过此动作。不得伪造candidate或另写导入器。

发布前独立验收：T2最终runtime/deploy/auth专项59项通过；T3最终单本catalog与增强reading smoke联合58项通过（包括错误Origin、错误CSRF被拒且会话保持、登出后旧cookie拒绝）。主Agent已review最终catalog导入与runtime外部await后的会话/目录/描述复核。前端七文件已单独保存于stash `0176cdca1be8bf25bb07888f18417ec23bd6831d`，不混入本次后端发布；完整回归、构建与隐私检查正在执行。此处仍未创建桶、安装secret、应用schema、导入目录或发出真实PUT；云结果按后续实际收据单独记录。

本地发布门槛已通过：首次完整回归835/838通过，3个失败均为CLI临时仓库漏复制新增依赖；Sol只修复fixture复制清单，主Agent独立3/3复验后，干净全套838项Node、8项Python全部通过，零取消/跳过。最终全套日志`/tmp/shelf-single-trial-full-fixed-20261023.log`，保留首次失败日志。disabled构建1280页、verify:public1318文件、verify:static1304资源、实际秘密扫描1509文件零命中/零不安全文件通过；最终文档变更随发布再生成检查。临时负向/确认/阅读接线helper主Agent逐段审阅及独立4项合成通过，实际云验证仍待执行。此门槛仅为本地结果，提交、CI、部署及真实对象验收分别记录。

真实运维序列预算：本地/CI通过后，主Agent固定新桶GET(404)→一次create POST→metadata/managed-domain/custom-domains/lifecycle四次独立回读，共6管理HTTP；要求私有、无custom domain、无对象自动删除/转层规则。不列其他桶、不改计费、不创建通用token，创建未知不重发。安装三项项目secret、schema005/006完整回读、必要单本目录、受控trial API部署及精确绑定/版本回读后才issue。有效secret+错误hash的合成同大小请求等负向验收不得领取claim/PUT；随后唯一真实upload、只读reconcile、auth显式enable、真实全文/hash/Range/匿名与撤销验收。实际CPU数值/共享余量未知保持unknown；不将旧5ms优化采样当上线失败，也不新增代码不存在的账号完整证据门槛。任何1102或相关安全失败停止受影响步骤并按回退关闭。

运维预算细化：旧桶凭证仅对固定新目标一次HEAD，必须实际403；secret安装为固定Worker settings GET、一次secrets-bulk PATCH、独立settings GET，共3HTTP，精确三项且无旧R2秘密，不假定批量PATCH原子。四个负向POST固定错误secret、Origin、大小和同大小全零错误hash；随后原status只读确认仍reserved/未attempt。reconcile成功后另一次有界observe-confirmed（正常4/cap5HTTP）只读原authority，独占保存已确认descriptor/etag供14/cap15HTTP reading smoke使用，不手写云事实。各次mutation和negative全局attempt不可重发，逐请求durable intent；所有操作工具及测试先由主Agent独立审阅/验证，不产生第二份余额。

真实云检查点（功能提交47a551e）：Cloudflare CI39887039702与Pages CI39887039727均success，前者deploy明确skipped。新桶6HTTP私有/生命周期回读通过，旧key一次HEAD403；追加固定旧CF01 settings一次GET确认全部R2 binding仍只指向旧桶，不据此改判旧unknown。secret首次仅1GET因临时helper强制ASSETS而停止、0PATCH；现有静态配置确实允许无ASSETS binding。Sol修正仅/tmp helper允许0/1并严格保持前后非secret projection，主Agent独立38项合成后，新run3HTTP一次PATCH及回读通过。schema17HTTP/9DDL、catalog7HTTP/3mutations精确回读通过，受控API部署及新桶/原D1/三secret绑定回读通过。issue9HTTP签发唯一许可；真实negative4HTTP通过，status5HTTP独立确认reserved且未attempt；唯一upload1HTTP后reconcile10HTTP真实HEAD/全文hash/HEAD通过，原authority confirmed/putAttempted/contentVerified均真。observe-confirmed4HTTP独立只读验证并私存ETag。仍无第二PUT、对象删除、旧账清除、AI或计费变更。

阅读接续：auth最新status2HTTP为generation1/enabled0、未撤销会话0、无未决mutation；enable在第4HTTP settings检查后stopped、没有CAS，仍关闭。Sol/high先以新临时固定settings shape只读诊断（cap1）核对严格binding exact与实际平台合法字段差异，仅输出有限字段类型/默认匹配布尔和unknown数量；对照已安装官方契约后再实施最小operator兼容，不猜默认、不丢完整settings hash、不放宽未知字段/实际version/subdomain/两轮比较。主Agentreview、适用专项/构建/隐私及提交CI通过后继续新enable和14HTTP reading，不重初始化、不重传原书。真实浏览器仍不可用，HTTP结果与页面渲染分别报告。

配置契约核对及修复：两次独立cap1/实际1HTTP有限诊断分别定位DB唯一额外字段、确认其为官方`database_id`且与旧`id`严格相同，其他未知字段0；不涉及R2 jurisdiction。固定官方OpenAPI的workers_binding_kind_d1明确记录id已弃用并重命名database_id。Sol/high仅修改auth operator的7行映射：保留旧精确三字段形式，新增精确四字段且两个ID均等于固定production D1；返回原binding参与normalized和完整settings hash，未知键/类型错/冲突仍拒绝。新增9项覆盖成功、CAS前拒绝和CAS后别名增删/漂移保留unknown；Sol专项33项通过，主Agent已逐项review并独立复验相关部署/鉴权/读取套件。Worker源及API部署validator未改，不重新上传或部署对象；修复提交CI通过后以新run接续enable及reading。

部署与回退：保留当前静态站，业务默认关闭；复用已初始化generation1/enabled0鉴权，不重复初始化。新schema为增量，旧SQL不改写。发布失败关闭新API/auth并撤销会话，保留许可、对象、预留、收据及unknown；不恢复旧写能力，不删除历史，不以重新上传代替恢复。仅在设计和验收门槛满足后执行已授权的单本试运行，无需重复征求同一许可。

## 2026-10-23 接续：恢复验收与上传阻塞决策

目标：接续985136a，完成其远端CI/静态发布核对、已计划的production disabled初始化，以及工作区动态文件入口的真实浏览器验收；同时把真实上传的剩余阻塞收敛为可执行步骤或明确的外部依赖，不新增只能输出false的operator。

当前范围与依赖：main仍为985136a，前端七文件及上轮实际观察记录未提交；旧unknown/六guard/imported和8GB/20MB/逐文件门槛继续保留。主Agent先核验既有CI与线上字节，CI成功后才按上一节固定4HTTP/一次INSERT计划初始化disabled；不启用登录、不部署业务API、不上传、不改计费。浏览器仅对合成fixture验收，无法连接则不宣称前端通过或发布它。本轮初次gh查询仍连接失败，CUA无browser且Chrome返回cgWindowNotFound；不反复启动同一失败诊断，不扩读网络或其他项目配置。

分工与方案：主Agent负责网络/CI与生产实际执行、前端独立review/浏览器验收、集成和最终发布。`gpt-6.1-sol / high`负责一次有界只读架构复核：依据现有代码和记录，区分用户硬约束、当前实现门槛、未能取得的供应商事实；交付当前规则内的最短可执行路径，或必须由用户变更的具体最小规则及保留的8GB/逐文件/隐私保护。只读跟踪源码和现有文档，不读.env/.local、不云调用、不改validator/ready/预算、不实现新operator，不重复前轮契约研究；依赖既有R2证据研究、旧写能力设计及费用授权。无新增低复杂度实现，Luna前端交付继续等待主Agent验收，不让子Agent自报代替真实浏览器结果。

验收与验证：真实云操作须有固定目标、独立前置/回读和原请求预算；网络或证据不足立即停止，未知不重试。代码如有修正仍交对应模型实施、主Agent复审、适用专项及完整测试/disabled构建/public/static/凭证检查后commit→push→CI→线上核验。纯记录与设计复核不重复全套测试。未具备证据不上传，不假填Free/完整性/源时间/排空，不扩大账号读取或凭证权限。

部署与回退：本轮没有已批准的业务API/上传迁移发布；默认保留当前静态站。disabled初始化成功保留关闭行和证据，未知保留预留及收据，不删除行/对象、不恢复旧写能力；前端未验收继续留在工作区。网络恢复后只接续尚未执行动作，不重发已发mutation。需要改变用户明确规则时先交具体可审查方案，不能自行放宽再补问。

网络与CI接续：本轮gh初查失败，但两次15秒有界公开curl分别成功读回主站disabled和固定提交CI；后者严格筛选完整985136a SHA，两运行39795268773、39795268728均completed/success。继续核对Pages实际文档与提交字节及部署step，随后按既定4HTTP/1 INSERT/new run的initialize-disabled计划执行；不因初次gh失败重新启动旧迁移或重发任何历史云写。

待用户决策的最小例外（未获授权，未实施）：目前已核对的Cloudflare接口无法生成当前代码要求的五分钟完整账号用量及Free/月操作证明，缺失历史也不能靠重跑补齐。若保持“未知或过期必须阻断”和可证明的实际8GB总量，上传继续关闭。可供选择的例外只允许首本固定文件<=20MB，在账号完整用量和旧请求终态仍unknown时新增最多一个对象；这意味着不能证明上传后账号实际总量仍<=8GB，可能有仅属于项目的存储/操作费用，不修改套餐或计费。后续上传继续阻断。

仅在用户明确选择例外后再细化并实施：新书置于旧CF01能力不能访问的项目私有隔离存储及专用凭证下，仍由同一个远端authority持久记录单次许可/全部预留/结果，不直传绕账、不填假accountEvidence或closure、不将imported改写成ready。许可绑定账号、唯一文件/hash/key/大小、一次PUT及期限；PUT未知不换key、不重试，保留预留，只按后续review的有限HEAD/GET恢复。旧unknown/guard/历史责任均保留；具体schema迁移、HTTP请求清单与上限、并发/崩溃测试、登录/阅读发布及关闭回退须经Sol设计实施和主Agent独立验收后执行。当前没有创建隔离桶/凭证或开放例外通道，用户未答复不视为同意。需要确认的依据是AGENTS.md第25行的未知/过期阻断规则；费用授权不取消这条规则。

本轮实际验收：985136a两CI最终success；Pages公开开发计划与该提交逐字一致，Cloudflare部署skip的既有step观察和主站runtime disabled保留。两项额外job详情读取因自动审核deadline未执行，未以其作新成功证据。按计划真实initialize-disabled成功，实际4HTTP/1 INSERT，独立HTTP回读generation=1/enabled=0、unrevokedSessions=0、unresolvedMutations=0。未开启会话/业务API、未上传对象、不改旧账本或unknown。前端真实浏览器仍因CUA无browser/Chrome cgWindowNotFound未验收；首本例外问题已提出，须等用户明确选择，不因超时默认批准。本轮仅计划、证据记录和已验收运维工具执行，没有新生产代码修改，不重复既有798项完整回归。

## 2026-10-22 加速交付：单本书私人在线阅读

目标：优先打通“登录→上传一个合格文件→在线阅读”的真实最小闭环；AI后续完善独立推进。现有静态站可用，业务API仍关闭，旧authority仅imported；CF01版本扩展字段与placement契约未明，不再重复同类status诊断。

方案与依赖：先由Sol/high评审是否可用项目专属隔离存储目标及独立最小权限凭证，让旧CF01请求只能影响旧目标，并将旧目标全部已知/未知最大存储责任保守计入8GB预算。此为待评审架构候选，尚未授权实现为ready事实；必须证明目标与凭证隔离、旧能力不能触及新对象、旧预算不清零、单一账本及总预算持续有效。若方案无法成立，保持现有门禁并明确缺项；不依赖猜测旧请求终态或等待接口文档。与此同时独立盘点生产登录/阅读实现和旧registry向唯一authority读取的缺口，推进不依赖存储关闭的离线实现与安全验收。

分工：主Agent负责需求、方案选择、依赖协调、独立review/验证和发布；`gpt-6.1-sol / high`负责隔离目标/能力与保守旧责任的架构设计（先只读代码及官方契约，不云调用、不改私有数据）；另一`gpt-6.1-sol / high`负责最小生产登录/阅读链路的代码和发布门槛盘点，先交具体可实施缺口清单，待接口确定后实施。两任务并行、不得重跑旧审计operator或相同CF01诊断，指定模型不可用不替换。方案评审后再追加具体实现范围、验收与真实请求预算，不能边研究边新建云资源。

设计评审及本轮实施：隔离新桶不能补齐旧责任上界或账号存储证据，且增加身份/凭证迁移，故不创建新桶、不切换authority。代码盘点确认新registry的confirmed原书已有同事务file_registry投影，旧冻结trigger有精确允许分支，无需再建双写桥。Sol/high实施固定生产来源的单书只读/登录验收runner（默认preview零IO，成功10HTTP/失败收尾总<=11HTTP；逐请求durable intent；验证匿名拒绝、会话、已确认文件描述、完整GET的hash/大小/MIME/ETag、Range、logout和撤销拒绝；不记录凭证、cookie、签名URL或正文）。另一Sol/high先设计固定production auth的status/initialize-disabled/enable/close控制器，主Agent复核SQL/预算后实施；初始化默认disabled、CAS控制generation、未知mutation不重试，和migration/authority不互写。

前端具体缺口：静态详情的文件按钮不会随API确认状态刷新，上传后仍需重建。将此有界展示任务分配`gpt-6-luna / medium`，范围仅文件行data属性、DOM状态/按钮刷新模块及book.ts接线、合成DOM fixture与必要测试。复用现有canAccessFile/fileStatus，只处理页面已知fileId且format/size相符的API行，全部DOM以textContent/固定元素生成，不加入新API或自动文件请求；默认disabled/Pages不生成入口，本机行为保持。上传权限仍由后端独立检查。主Agent须独立review并做真实浏览器DOM验收，不能以子Agent测试报告代替。

验收：保持原8GB/20MB/逐文件规则，未知占用保守预留；原unknown、旧库/收据/guard均保留。先合成单对象上传/恢复和会话、CSRF、授权、文件完整性/Range回归，再具备合格用量证据与实际套餐安全证据后执行单文件云验收。部署只用固定本项目资源、明确版本和可关闭回退；不改计费、不开账号通用凭证、不发送书籍给AI、不把paw作为生产服务器、不批量上传。实现经主Agentreview、专项/适用全套测试、disabled构建、公开/静态/凭证检查后commit→push→CI→受控部署→真实HTTP及浏览器验证。失败关闭新业务入口，保留预算、对象、未知和既有静态站；代码可回退，不能删除旧证据或假填ready/drain。

实现复审：主Agent已逐项审查两个Sol工具，独立通过读取runner40项及production auth最终23项。读取流新增包含零字节块的硬上限，防止微任务洪泛绕过deadline；鉴权补充跨SQLite连接CAS竞争、close与全部会话撤销的事务回滚、迟到enable被新generation拒绝、持久结果失败保留unknown、state/receipt丢失不可重置等验证。工具尚未真实执行，不能据此声称生产登录已初始化或开启。

前端交付留在工作区待验收：Luna完成动态按钮、状态和解释同步，主Agent review首轮修正后独立Node专项通过。真实浏览器fixture服务启动成功，但本会话CUA无可用浏览器，连接本机Chrome返回cgWindowNotFound，无法取得页面执行结果；不将合成Node DOM视为真实浏览器通过。本轮先独立提交两个运维工具及记录，前端改动暂不提交、不部署，待真实浏览器验收再发布。

后续真实鉴权观察计划：上述工具通过最终完整回归、构建、隐私检查及对应CI后，仅运行一次固定production status（硬上限3HTTP，正常2HTTP，0mutation），读取固定D1身份及鉴权表/触发器和安全行投影；任何不符立即停止，不重试。如确认为缺行且无未决记录，再单独记录并执行至多4HTTP的一次initialize-disabled及独立回读。不得执行历史enabled=1的auth-init.sql，不启用API、不上传；结果不确定保留私有证据并只读恢复，不能重放初始化。真实enable、对象上传和阅读另须满足既有生产门槛。

只读时序调整：工具提交985136a已推送，本地最终798项Node/8项Python、构建和隐私检查通过，两CI均queued。主Agent将一次固定production status前移至等待CI期间，仍硬上限3HTTP/0云mutation、相同scope/schema/身份和脱敏边界，不重试；它仅补充实际只读验证，不构成发布通过。initialize-disabled及任何云mutation仍等待对应CI通过，enable/上传继续等待全部原门槛。前端和本次时序记录尚未纳入985136a，待后续验收交付。

真实只读结果：production status实际2HTTP通过，auth=null、unresolvedMutations=0，固定D1身份、两表及附属trigger精确符合。主站独立GET为runtime disabled、health404。下一次initialize-disabled执行范围固定：仅在985136a两CI成功后，使用新run ID重新独立核对固定D1/schema/缺行，单次INSERT generation=1/enabled=0并独立HTTP回读，总上限4HTTP/1云mutation；不设置Worker secret、不发布API、不执行旧SQL、不读取/上传对象。回读须匹配本机派生verifier、disabled新行及未撤销会话数0；失败保留state/receipt及unknown，不重试INSERT。仅初始化不授予任何会话/阅读权限；回退保留disabled行及证据，不能删除云数据或清历史。

## 2026-10-22 本轮继续：具体版本契约核查

目标：接续 `d98c620`，先核对该提交的两条远端CI，再解决固定CF01具体版本HTTP200响应与严格Version契约不符的阻塞。当前仅确认顶层存在契约外字段、六个lifecycle字段缺失，尚未证明可安全兼容；不得通过删除未知键、猜测默认值或改用latest绕过。

范围与依赖：主Agent负责CI/线上静态状态核对、计划、设计审查及最终验收；`gpt-6.1-sol / high`负责复杂的版本接口契约研究，先只读项目代码、既有官方schema/SDK及公开官方资料，交付差异分类、最小安全诊断或兼容方案、请求预算与不可证明项。研究阶段不云调用、不修改私人状态、不实现新云写路径；设计经主Agent复核后才分配具体实现。若确需诊断，先审查有限投影及合成测试，再另记一次固定status预算（最多14HTTP、0mutation）的计划；未知字段名称/原值、模块、secret和annotations不进入输出。

验收：任何兼容必须有官方契约依据，保持具体UUID、代码/绑定/metadata精确比较、五expected hash、六guard、durable intent、deadline和未知结果零重试；无法证明的表示继续拒绝。实现由主Agent独立review、专项与完整Node/Python回归，顺序执行disabled构建、verify:public、verify:static及实际凭证扫描。研究无可实施结论时记录具体缺口，继续可独立验证的工作，不循环执行同一失败status。

发布与回退：适用验收通过后commit→push→两CI→静态线上核对；Cloudflare自动部署仍关闭。create/deploy不属于本阶段执行范围，须另有有界计划。代码失败可revert，不能恢复旧R2能力或回改历史unknown。authority保持imported、ready/drain/upload关闭；不上传书籍、不调用AI、不启用业务API、不改计费，私人证据/预算/旧库均保留。

接续基线已独立验收：`d98c620fe6e0a5a7fb37f16c5e6ac34c6bf665c4` 的Cloudflare CI `39771627350` 构建成功、部署skipped，Pages CI `39771627306` 构建与部署成功；Pages公开开发计划与该提交逐字一致。主站runtime仍为`schemaVersion=1/apiMode=disabled`，`/api/health`为404。此记录收尾上次纯测试修正的远端验收，不代表业务后端上线。

一次受限诊断执行计划：Sol/high交付临时version-shape wrapper，主Agent逐行审查并独立执行原/新20项合成测试，全部通过。原status为唯一请求生产者，默认preview零IO；仅固定具体版本响应新增官方flat/legacy静态字段presence/type、已知键集合和请求UUID相等布尔，不遍历模块、binding或annotation内容，不输出未知字段名/值/hash。现执行一次新status，硬上限14HTTP（D1为固定SELECT的POST）、0云mutation、0额外fetch；每请求30秒及2MB、最多两次每类capture、原validator/共享锁/durable intent/收据规则不变。失败即停，不再次相同诊断、不create/deploy、不删除锁或unknown；结果另记。临时脚本SHA256为`3d89b480a9baac187bacc62f9ad2fe0024d3a6527d9d4237304669221d812253`，不加入公开资产。

实际诊断7HTTP/0云mutation，在具体源版本HTTP200的`candidate_invalid`停止，原validator未改。扁平必需字段及代码字段presence/type齐全、请求UUID相等；legacy metadata/resources均缺失，排除旧响应假说，但仍有官方flat/legacy集合外顶层字段。另确认settings placement为`{}`而具体Version缺失，crossMetadata须继续拒绝。官方schema未显式禁止扩展字段，故只记“额外字段语义未证明”，不宣称平台违反schema。Sol/high离线复核Worker/Script字段不能建立Version兼容依据；此阶段无安全生产修正，不追加泛化诊断。下一步须取得完整版本字段及placement读写默认语义的官方依据，再设计最小兼容或受支持替代路径；R2能力收回、drain、合格用量证据仍分别待验收。真实create/deploy/上传/AI均0，业务API保持关闭。详细官方链接及未发送的契约问题见仓库内`docs/cf01-version-capability-plan.md`，不加入公开白名单。

主Agent本地验收：诊断专项20项通过；首次完整测试受沙箱回环监听限制未完成，保留原失败日志，不记成功。在可监听环境独立11项通过后，完整734项Node及8项Python全部通过，零失败/取消/跳过（`/tmp/shelf-version-contract-followup-full-20261022.log`）。生产代码无修改，本轮交付为契约核查、真实只读结果及交接记录；构建/隐私和对应新提交CI另验。

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
