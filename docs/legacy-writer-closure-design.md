# 旧存储写能力闭包：独立设计复核

核对日期：2026-10-22。实施模型/effort：`gpt-6.1-sol / high`。这是供主Agent审查的设计，未实现 verifier，未改变 guards、SQL、authority、ready 或云端状态。本文件不加入网站文档白名单。

研究只读当前项目已跟踪代码、Git历史与官方公开文档；未读 `.env`、`.local` 私人源码/日志或其他项目数据，未调用云管理接口，未检查/启动/停止进程。本文引用的真实状态是主Agent计划中给定的检查点，不是本Agent独立重验结果：storage budget墓碑1、live0、orphan0、六guard已验收；历史PATCH仍unknown；authority为imported。该状态不等于闭包完成。

## 结论与范围

当前墓碑计数加永久guard，只能证明观测时数据库行形状和之后受guard保护的准入限制，不能独立证明旧请求/R2操作已完成。存在一条值得实现的严格替代证明路线：**穷尽历史执行代码集合，证明所有可能版本同一写序不变量，再以完整永久调度账本和每条正向completed/cleanup回执证明所有已准入写已结算。** 在此前提全部成立时，可避免依赖不可证的旧请求最大时长；它是新的独立证据source，不能伪称旧source满足。

目前还没有这些完整证据，故不能将设计填成true或执行ready。固定版本列表、终态收据检查、真实本机进程/连接闭包、未知PATCH独立处置，以及合格R2上传证据仍为分开的工作。

## 已读代码与实际语义

| 位置                                                           | 已证明的代码事实                                                                                                                                             | 不能据此证明                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `720690b:cloudflare/probe/core.mjs` 的 reserve、schema trigger | `INSERT OR IGNORE cf01_budget`成功后同一语句trigger创建reserved run；只有reserve报告changes>0，handler才执行工作。预算墓碑不由此代码删除，重复ID不重新执行。 | SQL表没有历史版本ID，且旧schema未永久禁止管理端删除预算或改状态。当前行不是完整历史审计。                                                                             |
| `720690b:cloudflare/probe/handler.mjs` storage路径             | await running更新 → await storageProbe → await completed；storageProbe串行await唯一PUT、完整GET、Range GET和正文校验，没有waitUntil或后置PUT。               | `saveResult`不检查UPDATE行数，不能一般地把“UPDATE未抛错”视为持久claim。若行被别处删掉，UPDATE零行不会触发guard，旧代码仍可能继续。必须由完整历史不变量排除此情形。    |
| 同版本failed与cleanup                                          | 异常catch将run写failed。cleanup仅在completed/failed后，await DELETE、await HEAD确认无对象后才删run，保留budget。                                             | failed可来自PUT异常，无法证明服务端未提交/不再提交；墓碑不能区分原completed或failed。并发cleanup还可能有一条未知DELETE与另一条成功cleanup同时存在，单个墓碑不排除它。 |
| 当前 `cloudflare/probe/core.mjs`                               | storage reserve和storageProbe均立即拒绝；workflow路径仅做mock请求，不运行storageProbe。                                                                      | 代码磁盘已改不能证明旧isolate/旧本机已加载代码或绑定失效。Workflow20分钟step配置不是storage HTTP/PUT时限。                                                            |
| `scripts/cf01-storage-close.mjs:CF01_CLOSE_GUARDS`             | storage budget禁止INSERT/UPDATE/DELETE；storage runs禁止INSERT/DELETE；UPDATE只允许身份保持且state为completed/failed/uncertain。                             | guard不能撤销已开始的PUT，也不会拦截没有匹配行的UPDATE。terminal允许uncertain/failed不是R2正向终态证明。                                                              |
| `scripts/cf01-storage-audit.mjs`                               | 读取两候选历史版本，storageMappings保留completed观察但明确mapping/drain=false。                                                                              | 两候选非穷尽执行集合；当前100%部署不排除旧版本、preview/override和更晚未部署版本。                                                                                    |

旧storage路径源码在Git中只有初次实现和后续冻结的变更可供对比；Git源码不等于已部署模块，也不能代替远端模块字节/入口/兼容设置核对。本设计不猜测未读取的私人历史模块是否匹配。

## 首先修正采集缺陷，而不填补不存在的历史

旧 `scripts/cf-probe.mjs:call()` 在发请求前持久记录method、pathname、at和pending，但未记录POST body的runId/kind，也没有执行版本。`start()`先记runs再call，客户端锁有助于串行化，但不构成服务端全部调用者的证明。

现有audit过滤requests只保留响应中data.run.run_id匹配，或pathname为`/v1/runs/<已知ID>`。因此 `POST /v1/runs` 在pending/uncertain且无返回run时被丢掉；如果返回的是noResend/无run等形式，也可能失去关联。这是可修正的采集缺陷，不是可以忽略的历史未知。

拟新增只读离线解析：在既有512 runs/512 requests硬界内保留**全部**请求的原始序号、固定方法/路径类别、有限结果枚举和必要数字；已知runId只保存项目私有hash关联，未知字符串不输出。POST无身份时显式`unattributed_mutation`，pending/uncertain原样保留，不能从邻近时间/数组顺序猜body；缺正文的旧记录不能事后补写“当时发了什么”。非storage请求只有确切返回kind/已记录ID可证明，不能将模糊POST默认归为workflow。

严格基线遇任何未归属mutation、failed/unknown、缺正向回执即拒绝终态证明。后续若要通过完整账本不变量证明某未准入请求必定无能力，也须另立逐条证明规则，不能由本采集器自动消除unknown。原CF01 PATCH unknown属于另一管理操作历史，既不丢弃，也不能被storage终态证明改判。

## 历史执行版本集合的最小可审查证据

可以不恢复每个run的精确执行版本ID，但必须证明它落在一个**穷尽**集合中，并验证集合每个版本相同的不变量。所需步骤如下，均为未来实现方案、尚未实际调用：

1. 钉住项目账号、固定Worker名称及不可变Worker ID、D1 ID和创建生命周期；主Worker不能被删除重建后按同名认领。列全部版本而非deployable-only，也不按当前deployment裁剪；preview/override即便未部署也须纳入。
2. 固定`GET /accounts/{a}/workers/workers/{worker}/versions?page=1&per_page=13`，以13作超12版本哨兵。只接受1..12项、唯一ID、合法number、完整分页元数据（page1、per_page13、total_count与结果数一致、total_pages1）；缺任一覆盖字段或出现下一页即停止，不自动翻页。项目授权允许固定Worker读取，不需要账号资源列表。
3. number集合必须精确为1..N，N为**全列表最大number**，并覆盖当前deployment引用的每个ID。不能把当前部署版本number当历史最大值，因为后续上传版本可尚未部署。最多12个版本逐个`include=modules`读取，核对ID/number、main、全部模块名/类型/长度/hash、兼容设置、固定D1/R2目标；未知动态模块、资产可执行入口、额外绑定/迁移/导出均拒绝。只持久review hash，不写原源码/secret/author字段。
4. 重复同一列表及固定Worker身份/部署/settings回读，两轮集合hash稳定。采集期间冻结本项目发布者；这仅防观测漂移，不能回填过去缺失的版本。
5. **连续编号仍不是单独充分条件。** 官方说明number从1开始、旧API称sequential，但同时提供删除版本接口；所读文档未承诺删除后编号绝不复用、列表含已删除版本或可证明从未重建。需要可信的项目初始创建及全部版本创建/删除/重建操作历史，或可核实的官方单调不复用/完整保留契约。若已有历史模块存档，可按不可变ID/hash补齐删除版本，仍须证明没有遗漏。版本数达到13、编号缺口、旧Worker生命周期不明或任一缺模块均失败。

该集合全称证明比“日志中找到两个版本”强，但不能把分页完整性误当历史保存完整性。官方未来若提供更强明确保证，可按其精确限定更新设计，不现场猜测。

## 全称代码不变量与逐条正向终态

所有候选历史模块须由主Agent逐模块review，并固定人工review结果与源码hash；不接受用关键词正则宣称任意JavaScript已安全。允许自动验证已review精确字节/AST指纹，未命中版本必须人工拒绝或另审。

全称不变量至少包括：

- 每个storage R2 PUT之前，必须在同一固定D1成功建立唯一永久budget与对应run；仅唯一成功创建者可以工作。重复ID、错误、未创建、其他kind或查询失败路径均不PUT；不同请求不能复用该claim。所有mutating入口、导出、top-level、fetch、RPC、scheduled、queue、Workflow及服务绑定路径均已覆盖，不存在旁路R2写。
- 每个claim最多一次串行await PUT；正向completed只能在该PUT成功resolve及预期GET/Range校验完成后落库，无catch将未知改completed、无后台写、重试、并行PUT或completed之后的再次PUT。固定对象key和neutral正文与预算runId绑定。
- run/budget身份不可被项目历史代码改写、预算不删除；只有终态cleanup可删run。表/trigger历史始终与这条不变量兼容，没有其他项目/管理写将completed伪造、清预算或绕过预留。需要可信的本项目调度/迁移记录支撑，当前schema无法自行证明过去。
- cleanup的所有R2 delete都await结束，成功回执在HEAD不存在及D1删除后；所有已发cleanup请求也必须有正向终态或严格无副作用证明。不能因storage PUT已completed而漏掉一个在途DELETE。

对全部永久storage budget（最多4，当前给定为1）做精确集合对应，不只看计数。每条必须找到同一runId/kind/created_at/options及预期neutral结果的HTTP200正向completed回执；`fullOk/rangeOk=true`、bytes等数字须符合被review代码。若run已删，还需对应正向cleanup回执`cleaned=true,budgetTombstoneRetained=true`及前后顺序；只存`runs[].cleaned=true`不够。若保留run，须终态仍为completed且未有后续重写/未知mutation。

只要永久budget集合可证明穷尽、所有历史代码符合上述规则、每个budget恰一次正向completed且全部cleanup也已结算，就能推导全部已准入R2写已结束，无需从client断开猜测remote超时。guard阻止之后新预留、身份变化和删除，审查通过的旧请求也无法获得新的唯一claim。若pending请求已在readInput但尚未reserve，它之后必须经过guard而失败；这条结论依赖完整代码与唯一claim证明，不依赖随便等待。

反例必须拒绝：budget墓碑无原正向completed；只有failed/uncertain/404或HEAD空；收到completed但模块会后台再次PUT；预算曾删除后重用；同ID有两执行者；表被直接改completed；有未归属POST/DELETE；版本集合不穷尽；cleanup存在未知DELETE。任何一项不能用另一项“看起来安全”来补。

## 本机旧transport与连接/进程闭包

旧 `97dd4ec:server/upload.mjs` 用预签名PUT和`AbortSignal.timeout(60000)`；旧 `0ae8825:scripts/cf-library-clients.mjs` 也只有60秒AbortSignal，异常明确为upload_outcome_unknown；旧CF01客户端120秒AbortSignal只约束客户端HTTP。旧CF01 Worker的R2 binding PUT没有signal/总时限。新 `server/r2-object-store.mjs` 虽有Promise.race、AbortController和迟到响应取消，保证本地API有界返回，也没有provider已接收PUT必在60秒内终止的承诺。这些不能追认为旧provider副作用的强制寿命。

正向完成证明和连接关闭证明仍分开：停止进程/销毁socket会阻止后续客户端发送，但不能单独证明此前已交给服务端的请求未提交。反过来，所有PUT已成功完成也不等于旧进程不会再发新PUT。

未来本机检查器应在项目发布/任务入口先保持永久拒绝后，按固定项目root及已知launcher/进程身份核查：PID+启动时间/boot身份、UID、exe及已加载版本hash/可信启动记录、cwd、父子关系、绑定的项目端口和项目专用连接池。只输出固定字段/hash，不采集env、完整argv、其他项目进程或连接。没有可信PID清单时，先设计本项目限定发现方法；不能用宽`ps aux`加事后过滤来扩大读取。

真正关闭需要另轮授权内动作和回读：项目专用supervisor/launcher停新任务 → 等所有已记录写获得正向结算 → 关闭专用HTTP dispatcher并await close → 确认该进程实例退出、无该实例socket/子进程、无后台重启机制 → 私有upload锁/账本/manifest双次稳定读回。旧实现没有可调用的专用dispatcher关闭接口，不能伪造一个close返回值；已退出进程可用OS实例/连接事实替代本机socket部分，但远端未知写依旧保留。`destroy()`只证明本地销毁，不能当服务端事务撤回。当前无锁也不证明进程/远端请求空；残锁不能按年龄删除。

旧CF03两库冻结加全量空预留，可在**所有历史PUT都先持久reserve且无删记录旁路**的版本不变量下支持“没有已准入旧PUT”；本机原上传器的本地预留/manifest也须对应保留。不能由当前两库空直接覆盖更早本地直传链。当前合成测试对忽略AbortSignal的fetch作race，仅测试本地有界性，不能当真实OS/socket/provider验收。

## 可提审的架构扩展，不是当前ready许可

当前 `server/remote-storage-authority.mjs:writeClosure()` 只接受`drainBound.source='enforced-transport-deadline'`，并强制身份/入口/本地状态/进程/连接/probe六hash及对应事实，`deadlineMs >= max(60000,maxRequestLifetimeMs)`、时间关系合法、激活时verifiedAt五分钟内。`scripts/storage-migrate.mjs ready --execute`在读配置/网络前永久失败；当前预算ready=0且没有真实producer。

可另立方案增加带tag的**独立严格分支**，例如`drainProof.source='positive-terminal-coverage'`：它必须携带Worker生命周期、完整版本覆盖及review集合hash、不可重用预算全集hash、逐claim正向终态集合hash、全调度/cleanup覆盖hash、本机进程/连接关闭证据hash、永久新准入/能力关闭证明及最终独立回读时间。验证器应从这些原始可信证据重新计算集合等式，而不是接受调用者传true或只校验hash格式。

旧deadline source的规则完全保留，未知source拒绝；新source不填写虚假maxRequestLifetimeMs、deadlineMs或enforced-transport标记。它对已存在全部写逐条证明结束，和强制寿命提供同样需要的“无未来旧副作用”结论；缺任一记录即不成立。可以按CF01、旧本机直传、旧CF03分别提供严格证明，再做固定writer集合的合取，不允许一个scope覆盖另一个scope。未知PATCH的结果/能力回收证据继续单独处理，不能用storage终态覆盖它。

新架构只在独立设计review、威胁模型/反例测试和完整实现验收后才有资格讨论接入ready。还必须具备未来不能恢复旧R2绑定/入口的约束与独立当前观测；固定Worker routes完整性、preview/override/服务调用路径若仍unknown则依赖其跨入口同一guard不变量证明，不能填routesComplete=true。R2新鲜完整账号证据仍是每次上传独立门槛，本source不生成accountEvidence。现阶段不改任何代码门禁。

## 下一开发分层与有界预算建议

先做零云调用离线验算器，读取经单独授权的本项目有限私有输入、拒绝symlink/hardlink/目录置换，保留所有pending/unknown请求；输出每项evidence缺口与集合覆盖摘要，始终readyEligible=false。加入缺POST body、过滤遗失、额外版本、空分页、deleted/recreated生命周期、多个完成者、failed墓碑、并发cleanup未知、guard前已PUT、UPDATE零行继续、伪hash/伪布尔等反例。该阶段可修复采集问题但不制造历史事实。

之后另立固定Worker只读采集计划（不是本研究的执行许可）：最多32HTTP、0写、0对象读取、无重试/自动翻页；逐请求durable intent，30秒fetch+body、2MB响应、版本<=12、每版模块<=64。建议基线：Worker身份首末2、版本列表首末2、每版modules最多12、D1 identity1、两轮schema/counts/storage/orphans共8、deployment首末2、settings首末2、subdomain1，共30。任意未知/超限/漏分页停止，不能动态增预算；列表返回author/URL/secret等均在内存丢弃，仅留允许的hash/数字。固定只读采集不触碰其他账号资源、其他项目或计费。

采集若仍缺删除版本/Worker生命周期的历史证明，或缺原completed/cleanup收据，应交付明确blocked item，继续只读能力观察与离线工作，不扩大到账号审计日志或宽资源列表。已丢失的历史不能由今天重跑storage、重建墓碑或重新cleanup修复。若证据实际可齐，主Agent再单独批准新的严格source实现计划；其后才是本机真实进程/连接操作、独立闭包验收和ready实现讨论。

回退：本设计不产生状态变化；未来代码可撤回，永久guard、空R2本机配置、原unknown、原预算/收据及imported均保留，不能重新开启旧写。任何证明失败都维持当前业务/API/auth/上传关闭。

## 官方依据与推断边界

- [Workers limits: Duration/Subrequests](https://developers.cloudflare.com/workers/platform/limits/#duration)：HTTP在客户端保持连接时没有硬总时限，子请求也无固定时限；断开后任务可能取消。官方runtime更新的20分钟grace针对runtime进程更新，不能从普通脚本部署/关闭绑定时刻套用。由此推断：10ms CPU、120秒client timeout、30秒waitUntil均不能证明旧storage PUT终止。
- [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions)：PUT成功resolve后写全局可见，DELETE成功resolve后删除全局可见；没有给此PUT的强制signal/总时长承诺。由此支持正向成功顺序证明；拒绝/超时不作无副作用结论。
- [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)：版本保存代码/绑定/兼容配置，deployment决定流量，存储资源状态不随版本保存；上传与部署可分离。不能以当前deployment替代全部历史候选。
- [官方beta版本列表](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/list/)及[SDK版本源码](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts)：固定Worker分页、per_page<=100、number从1开始、include=modules及版本删除接口。当前列表对删除历史的完备性/编号复用未获保证，本文没有将之视为事实。
- [Version metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)：运行时可以取得version ID/tag/timestamp，适用于未来持久调度来源设计，不能追溯生成旧执行ID。
- [Node AbortController/AbortSignal](https://nodejs.org/api/globals.html#class-abortcontroller)：timeout触发signal；[Undici Dispatcher](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md)：close等待排队请求完成，destroy异步中断本地请求且其间仍可能进展。由此推断：客户端取消/本地socket关闭不等同provider事务撤回。

以上官方公开文档在本研究日读取；源码main链接可能后续变化，实施须固定所review revision并核对实际Node/Undici版本。本文没有由官方文档推断真实部署/终态事实。
