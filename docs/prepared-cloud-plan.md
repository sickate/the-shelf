# 私有正文云消费与索引实施计划

实施模型：gpt-6.1-sol / high；主Agent负责接口裁决、独立review、集成及最终发布。本文件为私有运维设计，不加入公开文档导出清单。

## 范围与当前事实

已存在的单文件同步协议、selected-sync、唯一production D1 storage authority及prepared-text registry继续承担全部对象预算、预留、PUT资格和核验。当前普通上传受imported、旧unknown及用量证据门槛限制；首本许可已消耗，不允许重新上传或重置。正文消费者只读取已确认且content_verified的普通正文登记，v1还要求同scope/file/book/source SHA的原件确认可读及catalog candidate资格；不把隔离首本BOOKS绑定当普通正文桶。

第一阶段已有010三表及只读view、严格包/定位投影、私有章节与检索模块和离线测试。010为增量迁移，保留003/005/009等冻结文件。D1仅存来源/定位索引，无正文；中文关键词排序复用现有共享算法，不宣称已经实现倒排检索。包上限保持20,000,000bytes、20,000chunks和每块6,000 Unicode codepoints。平台CPU/内存仍须单独测量，不以Node测试称Free验收通过。

本阶段依次完成router及集成测试、独立010/schema/index operator及离线测试。部署绑定离线接线已获主Agent实施授权，仍须主Agent独立review后再考虑真实发布；不云写、不提交。CF-05 Workflows、真实AI、作者资料和结果发布不在本阶段实现范围内，不把filename同步识别当持久书籍任务。

## Router与授权

仅接入GET `/api/books/:bookId/prepared?fileId=...&versionHash=...&cursor=...`和POST `/api/books/:bookId/prepared/search`，POST精确JSON为fileId/versionHash/question。显式文件和版本必填，不扫描最新或跨书；章节每页32、检索最多5个各1,000codepoints摘要，JSON响应最多65,536bytes。

请求复用Worker现有API admission，消费者不再计API次数；在R2之前通过注入依赖复用一次现有access admission，不双计。独立Origin、所有者session、JSON/CSRF校验保留。初始primary查询绑定会话generation、管理版本、普通原件/正文registry、原件version及catalog候选事实；HEAD→GET实际SHA→HEAD后，严格验证完整正文包、重建全部定位索引，逐块字段集合/原语值比较，最终再次primary读取全部授权与来源快照；任何撤销/删除/换源拒绝输出。

只有PREPARED_TEXT_MODE=registry-v1、独立PREPARED_BOOKS能力、固定账号及the-shelf-books桶配置全部匹配authority才读取。消费者只调用head/get；平台R2 binding本身并非只读权限。缺配置零R2。流全程30秒deadline、最多65,536传输块，超时/断流/尺寸/hash漂移拒绝；迟到流取消且不等待不settle的cancel。私有pin、源/包SHA、etag、object key、reservation、mtime及完整正文不进入路由输出或日志。

## 010/schema与index operator

独立脚本仅提供plan/schema-status/schema-apply/index-status/index-publish。默认preview为零secret读取、零HTTP、零DDL；execute仅固定项目production D1与普通桶、精确file/version/packageSHA，不接收任意SQL/URL/桶/DB/path参数。复用loadMigrationContext、现有私有IO及有界控制响应、R2 store；plan复用loadSelectedLocalObject及共享包校验/index投影。绝不自行reserve、claimPut、PUT、删除对象或重放selected-sync。

010以真实SQLite解析获得固定3表、9trigger、1view共13对象，review后冻结源码SHA。schema-status读取固定D1 identity、新对象、旧schema及authority/trial/auth/registry/management/filename/observation事实并私有保存指纹。schema-apply安装前后逐项对照，保留全部旧数据与未知事实；每个DDL先落盘intent，未知即停，后续只读status不重复未知DDL。

index只为已确认原件和正文发布。单一tuple派生唯一持久claim/journal；先HEAD→GET/hash/严格包校验→HEAD，精确确认registry/source后INSERT一次header；每批最多100chunk，使用固定SQL及有界json_each参数（JSON最多64KiB，4参数）。未publication的完整或部分分片均不可消费。独立每页1,000行完整读回，比较count/顺序/定位/hash/字节与codepoints；复核来源后单条INSERT publication，trigger原子检查count/min/max/sum。最后独立status及第二轮完整R2核验。

任何POST未知停止；只读status只有在该批全部精确出现时才可继续从未尝试批次。不因尚未见到行而重发未知批，不允许换run绕过全局tuple claim。header、分片、publication不覆盖或删除；保留半成品及所有责任。index-status恢复绑定原先私有冻结plan，不以当前pins变化改写历史意图。

## 预算与验收

schema-status固定10只读HTTP：一个production D1 identity GET、一个010对象查询、一个旧sqlite_master查询、七组完整旧表有序JSON快照。七组分别为authority/legacy/trial、auth/session/admission/counter、ordinary registry/reservation、management/public-state、catalog、retained import、filename/observation；保留所有旧表列与行，不截断。catalog与retained import分组避免重复元数据使单个控制响应超过1MiB；任一组过大或schema不兼容即拒绝，不拆成未核定的新请求或补零。schema-apply安装前后各10读加最多13DDL，共33HTTP/13DDL。010源码SHA固定为`b70ad99611023bde6aa08901cd8eeebbdeeae0cd38e96f0ea8dec93e566afd0f`，改动即阻断operator。

对C块，B=ceil(C/100)、P=ceil(C/1000)：cold index-publish候选D1上限13+B+2P、R2上限6（两轮HEAD/GET/HEAD），总上限19+B+2P；20k块最坏259HTTP，零PUT。恢复index-publish先全量读取原有分片，因此单列D1上限13+B+3P、R2上限6，总上限19+B+3P；B仍按完整C保守核定，已尝试写绝不重放。index-status上限5+P D1加3R2，object读取后再次primary读取完整来源授权快照。执行前必须根据实际C及冻结SHA单独核定预算；schema与index预算分开。所有请求30秒deadline、响应最多1MiB、无redirect、零自动重试、预写durable intent。

验收覆盖真实Worker route+SQLite admissions（API/access各仅一次）、缺配置/匿名/错Origin/CSRF/预算拒绝零R2、读取中撤销/换源拒绝、完整20k块不截断、部分publication失败、所有整数严格类型、D1列重排仍正确、私有字段不外泄。operator覆盖preview零IO、固定目标、13对象兼容、逐请求预算、每种未知写与只读恢复、跨run不能绕过、半批/错源/错hash/多余行/迟到正文拒绝、全程零PUT/零AI。主Agent独立review及适用全套Node/Python、构建、public/static与秘密扫描后才按项目流程提交/CI。

## 后续部署与回退

部署器现在仅在明确prepared模式下生成production额外绑定PREPARED_BOOKS→the-shelf-books及PREPARED_TEXT_MODE/PREPARED_R2_ACCOUNT_ID/PREPARED_R2_BUCKET；保留DB、隔离BOOKS、trial/filename vars及secrets。仅本地部署器接线；auth工具的enable严格校验不扩权，status/close保持原行为。发布门槛包括010精确hash、同authority/source/index确认、真实资源及鉴权/流/浏览器验收。生产无正文时不伪造可用。

本阶段失败回退代码并保留所有D1/R2/unknown及私有receipt。未来prepared回退只移除其mode/新增binding，保留已验收trial及filename配置；完全静态关闭仍按显式trial/filename回退与撤销会话，不恢复旧写能力或删除历史责任。分别报告本地测试、远端CI和线上状态。

## 本地实现交付（待主Agent独立review）

### F1 部署接线实施批次

本批由prepared_finish（gpt-6.1-sol/high）负责，先抽010公开固定定义helper，再接API部署前后态与只读guard、显式prepared-only回退及完整静态回退，最后专项验证并交主Agent独立review。限定实现文件为`scripts/prepared-schema.mjs`、`scripts/prepared-index.mjs`（仅等价抽helper）、`scripts/cf-api-deploy.mjs`、`scripts/cf-deploy.mjs`、新部署专项测试及消费者缺010的测试；本计划同步更新。依赖既有trial/filename配置与主Agent已review的010/consumer/operator，不改010、prepared消费者、auth enable、构建runtime、CI、secret或其他云资源工具。

部署只允许显式production prepared开关：完整四项为PREPARED_TEXT_MODE、PREPARED_BOOKS、PREPARED_R2_ACCOUNT_ID、PREPARED_R2_BUCKET；保留BOOKS隔离桶及trial/filename vars和四secret。初次启用前态只接受完全无prepared或完整正确prepared；缺一项/错误值/重复/额外能力拒绝。省略flag不能移除prepared；prepared-only回退必须显式指定，完整静态回退也必须显式识别prepared前态。运行时binding不是只读权限，继续仅允许HEAD/GET。

开启前在原production D1身份GET后新增一次有界只读SELECT，同时比对010完整13对象及authority账号/普通桶/production DB；缺010在Wrangler前停止，部署器永不DDL。固定SHA与53 HTTP/13 DDL的独立schema三步预算不变。部署器自身显式HTTP由原3次（identity、settings前/后）变为prepared启用4次（多schema/authority SELECT）；Wrangler内部HTTP仍未精确计数，不能称整次部署上限。活动版本确认及未知部署只读恢复仍须另核定，绝不自动重发deploy。prepared-only回退不查询010，保持原API部署显式3次HTTP；完整静态回退是前/后settings两次显式HTTP。三者均不含Wrangler内部HTTP，不自动发额外恢复请求。

验收包括纯helper无云依赖/固定SHA、CLI错误组合零凭证读取、双桶与四项完整性、前后态与显式回退、缺010/authority错配零Wrangler、未知部署不重试、Worker缺表零R2和trial阅读回归；原operator/consumer 86项回归加既有API/filename/static/auth专项。本批本地专项合并执行177/177通过（新部署19、消费者60、operator28及既有API/filename/static/auth70）；纯helper抽取后的原86项亦单独通过。固定guard SQL已在真实内存SQLite执行，并对缺失/冲突/多余010及authority错配验证；Worker缺010的GET/POST均503、零R2、零access admission。仅本地执行，不云写、迁移、部署或提交；失败保留当前线上版本及全部数据/unknown。

开启命令的显式组合为`node scripts/cf-api-deploy.mjs --profile production --single-trial --filename-ai --prepared-text`；prepared-only回退将最后flag改为`--prepared-text-rollback`；完整静态回退为`node scripts/cf-deploy.mjs --static-rollback --single-trial --filename-ai --prepared-text`。这里仅记录已测试的命令语义，本批没有运行这些真实命令。部署器生成配置及receipt只记录公开mode/桶/schema SHA，不写入任何新secret；auth enable仍不兼容prepared模式，未来启用需要另行review。

`worker.mjs`已接入两个prepared路由，复用原API admission并注入一次原access admission；`cf-prepared.test.mjs`通过实际handleRequest和原schema解析得到的SQLite admission表/trigger验证GET及POST各计一次。消费者默认缺能力关闭；部署器仅本地接线，真实生产配置与auth工具未改。

独立`scripts/prepared-index.mjs`仅接受五个固定动作、`--execute`及精确`--file/--version/--sha256`。所有动作默认preview，只校验参数及本地公开迁移定义，零secret读取、零HTTP、零DDL；`plan --execute`才读取本地私人包/manifest/pin并验证，不调用cloud context或HTTP。其余execute动作复用固定项目context；当前交付只离线测试，尚未执行任何云动作。

index-publish通过固定identity+file/version/packageSHA派生唯一私有目录与immutable plan，不接受run/DB/URL/bucket/path覆盖；恢复/status不重新读取当前pin。每个远程请求先fsync intent，目录创建和claim也fsync；每个写操作只有固定一次intent资格。DDL、header、批次或publication未知时停止；只读完整精确schema/行比对可识别已实际存在的效果，未出现或半批不能再次派发该写。并发同tuple由独占intent保证至多一个写者，同名key不会通过新run绕过。

本地验收包括010三表/九trigger/view解析、当前1264本catalog与retained import完整有界快照、完整20k块不截断、逐HTTP/参数预算、全部四类未知写的已落库与未见效果恢复、半批不发布、篡改/hash/整数/多余行/源漂移、D1列重排、D1与R2迟到/悬挂流取消及零PUT。Node离线结果不代表Free CPU、线上迁移或真实云正文消费验收。
