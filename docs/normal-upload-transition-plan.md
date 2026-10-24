# 普通上传下一增量设计（F5，供主 Agent review）

日期：2026-10-23。实施模型为 `gpt-6.1-sol` / high；初始设计仅做代码和既有文档研究，N1本地交付见下；没有读取凭证、发云请求、改生产状态或上传。本文不加入公开文档清单。以下目标及离线实现均不能据此称普通上传已可用。

## N1 实施批次（主 Agent 2026-10-23 review 后授权）

本批由 normal_transition（`gpt-6.1-sol` / high）实施，只新增固定011 SQL、新独立 `server/storage-activation-v2.mjs` 及专项测试；不改003/005等历史文件、不改现有RemoteStorageAuthority/Worker/management、不提交、不云写。B仅保留为候选框架，N1 validator明确拒绝B激活；真实proof、账号producer和生产接线均未提供，默认零激活写。

分步：①固定SQL先检查唯一authority确为imported，再安装默认闭锁phase/写guard；②新增activation/immutable receipt/evidence/legacy责任和精确SQL快照/统一责任视图，替换明确旧ready和trial phase guard；③新模块仅通过固定SQL DB adapter有界读取，验证完整精确schema、快照和真实外部verifier结果，唯一CAS经trigger在同一事务切ready；④SQLite离线验收首本/普通/legacy计账、伪造proof/过期证据、部分安装、unknown响应、CAS竞争与8GB边界；⑤交主 Agent review，不代替主验收。

适配器是可信固定production D1边界，模块不加载.env、发现资源或提供任意SQL入口。外部verifier必须由可信调用端注入，必须独立核对其绑定的snapshot/identity/schema及部署/闭包/完整账号来源；用户输入receipt不能代替verifier。N1内无生产verifier，不能以合成成功称真实门槛成立。验证含专项Node SQLite，语法/格式与diff；完整回归与发布由主Agent集成。回退仅撤回新增未接线代码，已安装schema则保留全部表、闭锁guard和责任，不回旧写、不删除unknown或首本；部分迁移禁止启用API/普通写。

N1本地交付检查点：新增011固定SHA256为`db532d26cbe6dc3639cb9f5a32ae85ad6f0943ab7b2fc1fabe974bd1bfc3a0c3`，模块固定该hash并从可信SQLite schema生成75项精确定义，比较只trim及去末分号，不折叠SQL字面量内部空白。单条CAS原子发布receipt/evidence及原authority ready；默认缺verifier或durable journal即零激活写。journal唯一键固定同一authority操作，不能换run ID；lost/late结果保留单次claim，只能独立inspect。每次外部await最多30秒结束消费者等待，不声称取消provider写或证明旧drain。读取前计数上限1000/每类、快照1MB，目标跨await固定；部分schema或旧005 hash检查器尚未v2接线时失败关闭。

独立专项`node --test tests/storage-activation-v2.test.mjs`本地41项通过：包括真实SQLite文件双连接竞争、8GB精确边界及+1、20MB、prepared-text/原书确认转账、首本+unknown+legacy计账、两个guard替换中断点、字面量空白篡改、target漂移、挂起与迟到CAS、B/伪造布尔/不完整账号来源拒绝。只使用合成数据，无R2 PUT/云端请求。N2双源读取、真实外部verifier/producer、固定production安装operator和部署接线均未实现；真实011尚未安装、真实activation未执行。后续010先于011；现有精确001–009/005 schema检查器需显式更新兼容011，不得放行陌生定义。

## N2 接线细化设计（只读，待主 Agent review 后分配）

本节模型`gpt-6.1-sol` / high。主Agent已独立验收N1 41项，工作区完整1117项Node/8项Python通过；这不代表011已安装或普通上传已开放。本轮仅阅读源码并更新本人设计，不实现接线、不读凭证、不云调用、不操作secret、不改旧SQL。

### 最小批次与接口

| 批次 | 改动边界 | 可独立验收/交付的行为 |
| --- | --- | --- |
| N2a：Node只读schema/receipt兼容 | 新`server/storage-schema-state.mjs`；精确兼容`RemoteStorageAuthority`；新专项。复用N1的75项schema和schema2 receipt validator，不在Worker导入Node/SQLite/fs模块。 | 原005完整布局与011完整布局分别识别；所有audit无论`singleTrial`参数如何都计normal+trial+legacy。v2 closed/imported可inspect，不因缺生产producer而阻止读取账本事实；新写仍拒绝。只接兼容读取，不提供activate/证据写接口。 |
| N2b：闭写双源阅读 | 新`cloudflare/library/storage-sources.mjs`及纯共享部署契约；接`worker.mjs`/`single-trial.mjs`/管理列表与文件读取；扩`cf-api-deploy`与`cf-production-auth`精确配置白名单；专项。 | 显式authority-v2+closed模式可在011尚不存在时发布，原首本同源阅读继续；普通confirmed也走同源代理；所有trial operator路径在其鉴权/会话/D1/R2前关闭；无普通上传。不需要真实完整用量producer、激活或新secret。 |
| N2c：运维schema显式兼容 | `prepared-index`及确实仍会用于当前部署的status/snapshot工具，复用精确布局profile；专项。旧历史迁移工具不强行支持新写。 | 010的schema-status/index-status在完整011之后仍能有界读取，未知DDL/混合布局拒绝；旧来源/数据保留。该批不改010/011 SQL、不扩prepared原书来源、不发布正文或新索引。 |

依赖：N2a与纯deployment契约可分别开发；N2b使用已review契约且必须与auth/rollback validator同批集成，不能发布只能deploy却无法受控close的配置；N2c依赖同一schema profile定义。首个可真实交付的安全读取版本是N2b，生产仍保持完整旧005布局，011无安装、activation无执行、uploadGate关闭。N2a/N2c可先commit代码而不变生产。所有具体实现仍由Sol/high，主Agent独立review与验证，不以设计代替完成。

Node新模块接口建议：

```text
readStorageSchemaState({query, identity, expectedLayout?})
  -> {layout:'legacy-v1'|'trial-v1'|'activation-v2', schemaSha256}
readStorageResponsibility({query, identity, layout})
  -> {normalCommitted, normalReserved, trialCommitted, trialReserved,
      legacyReserved, committedBytes, reservedBytes}
readActivationPublication({query, identity, layout})
  -> {state:'absent'|'closed'|'active', generation, receiptHash?}
```

schema查询固定storage/trial/freeze命名空间与上限；profile必须精确匹配整套定义，只有真正没有trial/v2任何对象时才可认旧legacy profile。005存在任何对象就不能因`singleTrial:false`省略；v2存在任何对象就必须75项完整匹配，部分安装不能回退解释成v1。只trim/去末分号，不折叠字符串内部空白。无需新增可控table/SQL/account参数。旧`singleTrial`参数只可表达“此调用要求存在首本契约”，不能切换会计责任；`false`也不会从求和中删除首本。legacy无trial布局保留离线参考/旧固定fixture用途，当前production显式要求trial存在。

N2a中`#audit()`在所有方法先使用这个layout并统一责任，比较原authority计数；v2使用011责任视图并验证其精确定义，不能另建余额。`inspect()`只陈述imported/closed真实事实。`#ready()`对v2要求authority ready、activation active/generation1、不可变receipt/evidence/snapshot逐字/hash闭合，schema2 validator使用当时`activated_at`验证历史activation证明，当前账本再次求和；不把五分钟源证据当永久ready证明。每次reserve/claim另校验**当前**合格证据，N2a不会增加生产producer。普通`registry()`不能把trial descriptor拼入原返回类型，因为其调用端默认normal桶；如果需要跨源operator读取，新增明确`confirmedSources()`返回`{source,target,descriptor,reservationId,etag}`，不暗中改变旧`registry()`语义。`activateFrozen`/migrate不支持v2重新导入；旧issue/claimSingleTrial在v2固定拒绝，新兼容不能重启单次能力。

v2 schema识别和receipt校验不能缓存跨整个多await写动作：每次新操作、以及外部R2返回后任何确认写前，重新核对固定layout/receipt/generation；SQL最终原子guard仍作为准入边界。现有requestLimit与operator精确预算必须随新增固定查询重算，不能原预算满后偷偷增加请求。没有迁移锁/CAS的外部schema并发不虚称被消除；部分/漂移立即停止。

### N2a 实施检查点（2026-10-23，Sol/high）

主Agent已授权本批实施：仅新增Node schema-state模块、接入RemoteStorageAuthority并增加真实SQLite专项。依赖冻结N1 schema/validator；不改010/011、Worker、部署、auth、prepared-index、凭证或生产数据。先从受信本地SQL推导完整legacy/005 profile，并逐操作读取固定schema查询；再统一normal/trial/legacy计账，校验v2历史publication及当前责任；最后保留普通registry桶语义并阻断旧迁移/首本mutation。v2没有受信实时producer，因此所有新mutation保守拒绝，不能用调用方raw evidence刷新原authority或重新打开首本。

验收使用本地真实SQLite覆盖完整三profile、部分/篡改DDL、默认false仍计trial、v2 closed/active历史证明、当前账本漂移、normal-only registry、所有v2 mutation零写和外部R2后重查。运行原remote/single-trial、N1及本批专项，主Agent复审后再决定集成；本批不发布。预算按新增固定查询逐调用记录，不擅自提高operator限额。回退仅撤销本批Node接线，保留全部SQL、对象、账本、许可和历史记录；不对生产执行回退DDL。

### N2a 实现与预算记录（本地，待主 Agent 最终复审）

实现文件为`server/storage-schema-state.mjs`、`server/remote-storage-authority.mjs`，专项为`tests/storage-schema-state.test.mjs`及独立合成fixture；扩原remote/operator回归。冻结011/N1代码和N1测试hash未变。导出的profile只覆盖storage/trial/legacy命名空间，不冒充整库schema：006的`admission_private`和010的prepared对象不在此命名空间，仍须各自checker独立验证。

| layout | 精确定义数 | schema JSON SHA256 | manifest参数UTF-8字节 | audit额外JSON响应字节 |
| --- | ---: | --- | ---: | ---: |
| legacy-v1 | 44 | `10fc23abed2c792337e28eecd7cb47c50f3731426c745b64989a11817d720350` | 24776 | 25693 |
| trial-v1 | 51 | `4b6c10339c1d74355254951d0168d936b6e3e159b8aa3704619342346d0d7e4e` | 31723 | 32807 |
| activation-v2 | 75 | `5208bcb2e9dcdf1d1d8aa0affec120c8ed3aa15350cd5245b705734e14c13dd2` | 55998（只读，不用于旧写） | 57661 |

固定schema SELECT为N1的`sqlite_master`有序查询，LIMIT129；只trim外围/去单个末分号进行发现比较，不折叠内部空白。accounting SELECT在同一SQLite statement内投影原始有序schema JSON并与完整manifest再等值比较，防止发现查询后011安装被解释成旧布局。每条旧mutation均由`#write`在原statement的WHERE内增加同一manifest等值谓词，manifest用**一个参数**传入，不拼入SQL、不插值SQL literal。谓词增加307字节SQL/一个参数；十行staging批次为91参数，保留≤100参数/≤100KB SQL界限。读取仍是分statement快照，不声称跨整个方法持有事务；事实对应accounting SELECT时刻，后续旧写再由原子谓词拒绝布局变化。v2 publication与phase交叉读不一致时停止，不将它解释成新写许可。

所有audit每次先schema SELECT，再accounting SELECT；v2另加publication SELECT，即旧布局2查询、v2读取3查询。每实例每scope仍仅一次identity GET；下面均不含这次GET、不含R2、正常无重试，`P`为registry分页数：

| 方法/路径 | audit次数 | legacy/trial D1查询数 | v2行为 |
| --- | ---: | ---: | --- |
| inspect / migrationReceipt | 1 | 2 | 3查询只读 |
| get / registry | 1 | 3 / 2+P | 4 / 3+P，只含normal registry |
| reserve新记录 / 旧reserved / 已attempted或confirmed | 2 / 2 / 1 | 8 / 7 / 3 | schema后拒绝，零写 |
| claimPut / markUncertain | 1 | 4 | schema后拒绝，零写 |
| reconcile成功 / 已confirmed / absence | 2 / 1 / 2 | 7 / 3 / 8 | schema后拒绝，零R2/零写 |
| inspectSingleTrial | 1 | 3 | 4查询只读 |
| issueSingleTrial | 2 | 6 | schema后拒绝，零写 |
| claimSingleTrialPut / markSingleTrialUncertain（需写） | 1 | 5 | schema后拒绝，零写 |
| reconcileSingleTrial成功 / 已confirmed / absence | 3 / 1 / 2 | 9 / 3 / 8 | schema后拒绝，零R2/零写 |
| migrate/activate完整旧流程 | 3，另入口schema1 | 固定旧readback+3次audit；已有ready早返仅1次audit | 入口schema后拒绝，零写 |

`initialize`已有authority为原existence SELECT+一次audit（3查询）；全新authority另需schema SELECT+guarded INSERT（共5查询），无v2初始化写。与旧默认singleTrial=false路径相比，普通inspect/get/registry/claim/mark每次+1查询，reserve fresh+2，ordinary reconcile成功+3、absence+2；trial冷实例首次schema原已存在，status不增请求，后续audit不再缓存。新增schema pin不增加HTTP。1MB响应上限、1000行分页上限及无自动重试均保留；v2大publication仍受原响应上限约束，超过即停止，不放大读取上限。

| 现operator | 新正常路径精确总HTTP | 原固定上限/是否改动 | 说明 |
| --- | ---: | --- | --- |
| single-trial status | 5 | 6，不改 | D1 identity+schema+accounting+trial，另catalog1 |
| single-trial issue | 11（原9） | 12，不改 | 预inspect4+catalog1+issue6；已consumed生产不得重发 |
| single-trial reconcile成功 | 13（原10） | 16，不改 | D1 10+HEAD/GET/HEAD3；已confirmed路径4 |
| single-trial catalog/schema/upload | 既有10/20/1上限 | 不改 | 不经本批修改的authority流程 |
| storage-migrate import合成空库 | 74 | 80；authority内部72，不改 | schema-freeze仍141/144；新authority初始化额外schema，入口schema与每audit重读；仅旧布局fixture，不代表生产可迁移 |
| selected-sync完整新对象成功 | 29（原21） | 128，不改 | 启动inspect+receipt共5；reserve8、claim4、confirm7；R2 HEAD/PUT/HEAD/GET/HEAD共5。当前CLI sync缺qualifying producer仍零云请求拒绝，v2亦拒绝 |

这些数字为成功正常路径，错误/丢响应保留原固定全局上限，不增加限额或重试。对应operator专项仍覆盖lost-confirm、deadline、unknown和receipt，不把测试绿等同真实producer或可云上传。主Agent最终复审、全库检查和N2后续部署未完成；本批没有云请求、DDL、activation、PUT或发布。

本地交回记录：最终remote+新schema专项48/48通过（`/private/tmp/shelf-n2a-atomic-final-20261023.log`），首本authority+冻结N1 50/50通过（`/private/tmp/shelf-n2a-frozen-regression-final-20261023.log`），首本operator16/16通过（`/private/tmp/shelf-n2a-operator-final-20261023.log`），selected-sync12/12通过（`/private/tmp/shelf-n2a-selected-final-20261023.log`）。包含storage-migrate的组合运行147通过、0失败、1取消：既有hostile-upload测试在并发migration子进程负载下超过10秒；独立operator重跑该项3338ms通过，未提高timeout。该组合内旧migration24项均通过并报告import74/schema-freeze141。最终新增批次/manifest响应边界2项已在48项专项中通过；不能把组合取消隐去或声称某次单命令150/150。`git diff --check`通过；等待主Agent独立review、全库/构建/公开检查，未提交或发布。

### Worker新读取接口与授权

`storage-sources.mjs`只用Worker API和WebCrypto，输入SQL均固定并bind参数；`registrySource(env)`当前将环境值插值进SQL的做法在v2移除。建议接口：

```text
storageReadConfiguration(env) -> 固定mode/normalTarget/trialTarget/writeGate
confirmedSourceProjection() -> 固定SQL片段 + 固定绑定参数
resolveConfirmedSource(env, scope, fileId) -> 单一source grant或409
sourceReadAdapter(env, source) -> 仅head/get facade
readConfirmedFile(request, env, context, session, grant, dependencies)
  -> 当前会话/lifecycle/source重新校验后的同源响应
```

新mode `STORAGE_MODE=authority-v2`，强制`STORAGE_WRITE_MODE=closed`；N2b不接受open值，也不设置`NORMAL_UPLOAD_MODE=authority-v1`。普通上传capability明确返回`normal_upload_unavailable`/`storage_write_gate_closed`，不读取上传字节、不claim、不PUT；已有管理metadata/trash/restore继续按当前鉴权授权工作。以后支持普通写是另一显式实现和部署步骤，需要实际activation和当前producer，不因部署closed读取版自动开放。

`BOOKS`固定普通原桶、`TRIAL_BOOKS`固定隔离首本桶。纯source decoder从原trial行及保存的target SHA解码已确认描述，不依赖旧`trialMode()`开关，也不需读取上传secret；保留现有trial-v1 decoder供旧兼容路径。trial facade不暴露put/delete，必须明确R2 binding本身仍具有平台能力、只是代码接口限制；不能称binding天然只读。

安全投影由普通`file_registry`与已确认trial构成，并为普通行核对其authority original registry/reservation一致性；trial核对原authority identity、permit/consent、固定隔离target、已消耗put_attempted/content_verified和descriptor、ETag。内部保留source标识，API不泄露桶/key/hash。按`(scope,fileId)`在两来源求候选数：同ID出现两条即409，不能UNION去重、优先命中或按bookId过滤后隐藏冲突。key相同但source不同是两个不同对象，绝不跨桶fallback；bookInfo/动态detail/管理列表也须检测冲突，不能只在content路由拒绝。

当前文件路由先判断`browser_uploads`，否则走trial或旧S3签名分支；N2b的v2分支必须先统一resolve覆盖**普通已导入且不在browser_uploads的confirmed原书**和trial。v2无S3签名URL支路、不要求/安装R2_ACCESS_KEY_ID/SECRET。保留旧v1 fixture兼容路径，但不能从v2未知源降级过去。确认读取不要求authority ready或新鲜用量；完整旧imported布局或完整v2 closed/active布局都可读已确认文件，仍检查目标及所有者权限。部分011或不支持schema返回503，保留对象；安装窗口如发生短暂只读不可用须如实报告，不用旧单桶fallback冒充连续读取。

HEAD/GET/Range/If-Match沿用同源no-store约定，R2 await后以primary D1核对同一session generation、auth enabled/origin、book/file归属、catalog候选、visibility/trash版本、原source+target+descriptor+ETag。迟到对象关闭body，返回前再次校验；正常与trial共用这个闭包，不能只复查fileId。已注销/trashed读取被拒绝，但对象和预算不变。

`/api/single-trial`以及整个`/api/single-trial/*`在v2最早path分派处固定404/410，发生在旧operator secret检查、session解析、D1 admission和R2前；包括未知子路径、HEAD/OPTIONS/POST及携带正确旧secret。为避免无效全局auth配置使operator路径先跑configuration，`handleRequest`可先作极小静态path+明确v2模式检查，随后普通API仍完整configuration。旧trial-v1模式保留现有行为，不能误把未知mode当v2而扩大关闭以外能力。

### 部署、auth与prepared的同一契约

新增纯共享模块（例如`shared/storage-deployment-contract.mjs`）构造固定profile，供Worker配置验证、`cf-api-deploy`、`cf-production-auth`、静态rollback共用；Node路径不向前端导出私有运行值。输入来自原私有deploy identity/已确认trial target receipt，不是任意URL/账号/桶CLI参数。

v2 profile的精确绑定：DB→原production；BOOKS→`the-shelf-books`；TRIAL_BOOKS→已确认隔离桶；ASSETS→当前production静态。精确vars：APP_SCOPE/SITE_ORIGIN、普通R2_ACCOUNT_ID/R2_BUCKET、STORAGE_MODE/WRITE_MODE、固定trial账号/桶/原target SHA。准备正文是显式扩展子profile：`PREPARED_TEXT_MODE=registry-v1`、`PREPARED_R2_ACCOUNT_ID`同账号、`PREPARED_R2_BUCKET=the-shelf-books`和`PREPARED_BOOKS`三项成组存在，缺一/多一/错桶即拒绝；可与BOOKS指向同普通桶，但代码读取职责独立。不能泛化为允许任意额外R2 binding。prepared未启用时这整组必须不存在。

当前secrets名单把filename AI绑定到trial模式，必须拆成显式profile，不要求v2重新安装secret。首次v2 closed读取发布精确保留当前已知secret名字集合（owner/session、原trial upload secret及已安装FILENAME_AI_KEY）；trial secret留存是惰性历史能力，v2代码路径完全不可调用它，N2b不发secret PUT/DELETE，也不因旧安装unknown重装。未来移除是单独有界操作，不能作为本批前置。无trial secret的v2子profile只能在实际独立确认该secret已移除后使用；不是接受任意可选secret。FILENAME_AI_KEY存在不证明值正确或AI验收成功，filename AI能力/预算沿原契约。

`validateRemoteBindings/workerConfig`、production auth的绑定规范化（目前只认识一个BOOKS）、safeStaticBindings/显式静态回退都必须支持**同一精确profile集合**。拒绝未知binding、同名重复、额外json/secret/plain_text及mode混用。状态报告、enable/close和deployment postflight比对固定当前100%实际版本+完整bindings，不能以vars或对象方法存在冒充R2目标；runtime无法自省R2 bucket身份，这是受控deploy独立读回负责的边界。当前owner鉴权generation不因该读取接线自动重建或enable，已有session处理由主Agent真实验收计划决定；不隐式secret变更或改计费。

prepared边界必须说清：010的`readable_sources`和index insert严格JOIN普通original registry/reservation + file_registry，trial未写入这些表。因此N2可让prepared binding与v2并存、读取普通已登记原书对应的已发布正文；**首本PDF继续可读，但首本prepared在该批不支持**，请求应在D1零R2拒绝。不能把trial投影进普通file_registry来绕过。将来要支持它，需要独立增量source-aware prepared schema与publication核对；不改冻结010。N2c构造“完整001–010旧profile”和“完整001–011新profile”两种精确旧schema集合，完整匹配后各自按相同固定计数/分页读回；所有私有对象/账本均保留，新schema不能被简单加入忽略清单。

### 顺序、验证与回退

1. N2a/B/C离线开发各自review，现有v1/trial fixture和新v2 old/closed/active/partial fixture均运行。N2b使用真实SQLite和miniflare/workerd证明双binding路由，不依赖一个Map假装两个桶。外部provider保持缺失，生产上传仍关闭。
2. 每批完整Node/Python、build、verify:public/static及秘密扫描，commit→push→两CI分别记录。N2b部署前固定现有Worker/version/DB/首本行/配置快照，参数不读取或重写秘密值。先发布v2 closed双源读取，保留旧005完整schema、原auth状态及现有对象；目标与secret名字逐项独立回读。真实阅读验收只对已确认首本做有界GET/HEAD/Range、登录/登出/错误Origin/CSRF/撤销和浏览器，不上传新书、不执行trial operator。新增HTTP预算在runner最终review后锁定，不借旧14请求名义扩读。
3. 010按其operator先安装并独立status；prepared启用也使用显式review后的子profile。011安装operator仍属后续工作，N2无实际DDL。只有N2 schema兼容/读回、当前安全版本和回退都验明，才规划固定011安装。011 partial停止后只读status，不重放unknown；complete后读取兼容验收，但activation仍closed。
4. 真正producer/闭包未成立也可以完成上述代码、兼容部署和现有阅读验收。N2没有activate调用链、生产verifier/journal、普通PUT新入口或授权例外；不称普通上传完成。

专项应至少覆盖：default singleTrial=false仍计首本/legacy；75项v2精确schema与旧005完整profile、任意一项缺失/字面量空白/未知对象拒绝；schema2历史证明按activatedAt校验而新写证据仍实时；首本+普通+prepared责任；两个桶同key、跨源同fileId冲突、错误book归属、source/descriptor/ETag迟到漂移；已导入normal不在browser_uploads仍同源可读；Range/HEAD、空body/timeout/迟到取消；trash/restore/revoke和await竞争；任意trial operator路径正确secret也零D1/R2；v2闭写intent/bytes零PUT；部署各准确绑定/vars/secret集合，prepared组完整/缺项/错桶，auth close与静态rollback能处理相同profile；trial prepared零R2拒绝；prepared status在011后完整且不忽略陌生schema。

N2b发布前可回当前已验收trial安全版本，因为普通上传始终0、没有普通新对象；一旦后续已有普通对象/回收站状态，不得回trial-only或无生命周期校验版本。长期回退应是保留双source和生命周期的closed读取版，或显式静态API关闭+generation撤销+全部operator关闭。保存010/011、所有对象/账本/unknown和原许可；不回滚schema、不重装/重发secret、不恢复旧写。线上状态仍必须区分本地、CI、真实HTTP和浏览器。

## 目标、约束与当前差距

在**同一原 production D1 authority** 中继续保留原 imported 来源、全部 uncertain/unknown、guard、首本单次许可及已确认对象；把普通原书和 prepared-text 接入一个 8,000,000,000 bytes 预算。单对象 1..20,000,000 bytes，逐文件明确意图，claim 后最多一次 PUT，未知不重发、不释放、不换 key。首本许可已经消耗，永不 issue/reset/upload。当前可读首本必须在普通模式下继续读。

目前存在彼此独立的技术缺口：

1. `005-single-trial.sql` 的 `shelf_single_trial_keep_imported` 永久拒绝 phase 变更；adapter `activateFrozen()` 也在存在首本行时拒绝。因此设置环境变量不能激活正常模式。
2. `003` 的 `shelf_storage_ready_guard` 只求和普通 reservations，遗漏首本表。adapter `#audit()` 仅在配置启用首本 schema 检测时才计首本，不能由调用者自由选择是否计入；management capability 已主动计首本，但不能弥补 SQL 旧 guard。
3. `worker.mjs:registrySource()` 与 file access 依赖 trial/normal 二选一。生产 `BOOKS` 是隔离首本桶，普通 authority identity 则固定原桶；切 `BOOKS` 会使首本失去读取，保持原 binding 又会使普通文件落错桶。
4. `007` 网页上传已有意图、唯一 claim、核验及确认链，却没有普通 unknown 的受控恢复入口。普通上传 capability 只看到 authority 中的数字/hash，不是完整用量 producer。
5. `activateFrozen()` 重新运行旧导入/读回流程；首本之后不能用旧导入合计覆盖当前总账。需要独立 `activateImportedV2()`，只验证和激活，不重新 import、不复制首本进普通 reservations。

范围明确不含：新首本例外、账号级通用凭证、计费修改、清理旧对象/预算、重放未知写、批量扫描上传、把 paw/Node 变生产、修改 003/004/005/006/007 原迁移文件及其历史 hash。

## 数据模型：增量 v2，保留历史

新增独立迁移（编号由主 Agent 集成时分配，避免与正在开发的010等冲突），由固定 production-only operator 安装。历史文件/hash不变；**已落地 trigger 的显式替换**属于新迁移，不能伪称纯 CREATE 足够。004 冻结 trigger、两来源、staging 和所有历史业务行完全保留。

新增以下表，均不可 DELETE；证据、来源与已发布快照不可 UPDATE：

| 表 | 用途和关键约束 |
| --- | --- |
| `shelf_storage_activation_v2` | 单行 id=1；状态 `closed/active`、generation、固定 authority identity/migration hash、原 imported receipt hash、当前 normal/trial target 与部署契约 hash、完整回读 hash、证据引用、激活时间。只允许 generation0 closed→generation1 active，不能重新激活或降级删行。初始 INSERT 只许 closed，不能 seed ready。 |
| `shelf_storage_activation_receipts_v2` | 不可变 verifier 输出；schemaVersion=2、验证范围、两旧来源 hash、完整 trial 精确投影、normal/trial/legacy责任分项、schema hash、部署配置 hash、写安全证明种类及其来源。hash是绑定手段，不是事实本身。operator只能发布独立核验已得到的事实。 |
| `shelf_storage_evidence_v2` | 不可变 account-evidence 引用及允许的纯汇总字段：来源契约版本、固定账号、源 observedAt/coverage watermarks（若有）、当月 A/B、storedBytes、Standard/Free、完整性、取得时间、proof hash。没有合格 producer 时不插入 admissible 行。不能由网页提交 JSON/布尔来生成。 |
| `shelf_storage_legacy_liabilities_v2` | 可选残余责任来源，不是第二余额：来源 identity、tombstone/source digest、固定对象 namespace、最大可能字节/操作数、证明引用。每条 INSERT 在同一事务计入原 authority 的 reserved；没有终态不释放。只在下述有界残余证明真实成立时使用。 |

普通与首本不做数据去重，只有原有首本表持有该许可。SQL 和 adapter 统一求和：

```text
committed = SUM(normal confirmed.size) + SUM(trial confirmed.size)
reserved  = SUM(normal nonconfirmed.size) + SUM(trial nonconfirmed.size)
          + SUM(retained legacy liability.maxBytes)
admission = observedAccountBytes + committed + reserved + requested <= 8,000,000,000
claim     = observedAccountBytes + committed + reserved <= 8,000,000,000
```

与账号观测重叠仍重复保守计入，不猜重叠、不扣除观测已含字节。首本已确认24,582 bytes只计一次；如果同时在观测中出现，观测和项目责任的双计是既有保守策略。ordinary `reserved→confirmed` 保持总责任不变，trash/restore不改余额。legacy责任不能挪成普通可上传资格。

无配置可关闭首本/legacy求和：v2 schema存在时 adapter必须核验其精确定义，缺表/部分迁移/陌生trigger固定失败。普通 adapter 的 `get/registry/reconcile` 也不能依赖重新执行 migration 导入。

## 受保护增量安装与激活 CAS

先在 imported 下安装 `v2_phase_gate`、新普通准入/claim保护及 v2表。`v2_phase_gate` 默认拒绝 phase 变化，只有 v2 activation 行已经由同事务合法 CAS为active才允许 imported→ready。它先独立读回精确定义，**然后**才移除/重建以下旧 trigger：

- `shelf_single_trial_keep_imported` 改为：仍拒绝其他phase变更；唯一例外是 v2 activation精确关联的 imported→ready，且原已消耗首本精确行仍在、confirmed/put_attempted/content_verified均保持原值。
- `shelf_storage_ready_guard` 改为：验证v2 receipt、固定来源与身份、normal+trial+legacy总责任，而非要求无法取得的旧deadline布尔；证明方法必须是实际验收通过的白名单之一。
- 原普通 admit/claim/registry guard按v2补强：active/generation、完整证据引用、两目标身份、精确余额与唯一claim；禁止 v1 receipt/环境变量绕过。旧 imported staging-only admission仍保留，在ready前不允许普通新reservation。

新guard先加、旧guard后删，phase在整个DDL序列均为imported。任意步骤unknown停在受保护部分安装；status只读列出精确已存在/缺失定义，不能因换run ID重放DDL。独立恢复计划只能补明确缺失、无未决原mutation的条目，不能 DROP未知定义。已确认首本读取不依赖新activation，DDL期间仍可维持现有安全读取；若实际DDL需要更换访问guard，则先切保留生命周期的只读安全版本，而非开放窗口。

`activateImportedV2(identity, expected, verifier)` 单独实现，不调用 `migrateFrozen()`：

1. 固定D1身份、全部v2/schema exact hash、旧004/CF01 guard、原migration/source/staging/live/registry/007精确关联及trial行独立有界读回。当前普通行即使为空也由查询证明；不从文档推零。
2. 重新检查两冻结来源未变、本机真实配置路径/账本/锁和旧写能力。核对写安全proof与producer证据；未证实字段立即失败，0激活写。源、trial及预算指纹必须绑定同次读回。
3. 固定normal和trial部署契约已实际独立读回，双来源读取代码在当前版本；写开关仍closed。激活时用量证据重新校验源时间≤5分钟、当前UTC月、未来时间拒绝、完整账号覆盖/Standard/Free与A/B门槛；不刷新时间。
4. 发布不可变v2 receipt。唯一激活SQL是对activation行的单条CAS：`UPDATE ... SET state='active',generation=1,... WHERE id=1 AND state='closed' AND generation=0 AND <所有expected hash与identity一致> RETURNING ...`。BEFORE guard核验receipt/proof/evidence/当前来源与trial精确投影及全部责任；AFTER trigger在同事务更新原authority为ready及v2 receipt/readback引用。失败整体回滚，不能先ready后记proof。
5. 独立primary读回activation/authority/receipt/责任及源hash。响应未知不重新CAS；只读status可证明实际已active及全部expected一致，保留原unknown intent。不存在/冲突保持关闭；新激活轮不靠重发旧CAS解决未知。

SQL无法证明管理凭证持有者提供的外部事实，不能将接受hash/布尔当作平台证明；可信verifier必须实际验证来源。`validateMigrationReceipt()`新增schemaVersion2分支，v1仍原义校验，不把v2证明包装成旧 `cloudWriteFreezeProven:true`。激活证明为历史静态事实；五分钟用量证据是每次准入/claim的动态事实，过期只暂停新写，不关闭已确认文件读取。

## 旧写闭包：不要把一个缺失deadline永久当唯一方案

现有远端两个D1 freeze、CF01六guard、本机旧入口拒绝属于已实现控制；当前CF01版本工具被未知额外字段及settings/version契约差异阻挡。**这是工具未实现/未支持的具体响应契约，不等于平台无法移除binding。** 在官方契约核对及新有界计划review前不放宽validator、不重发旧PATCH、不删除Worker猜排空。

可接受的v2写安全证明有两条互斥路线，均须逐项独立证明：

**A. 完整终态闭包。** 实际可核验的强制transport deadline，或完整持久调度/预算与执行版本关联、每个可能PUT确已终止，配合所有入口/凭证/进程/连接关闭。并不强制所有实现都采用旧 `enforced-transport-deadline` 字符串；不同proof使用准确种类。对R2 binding旧PUT没有已核对的可验证取消/最长寿命保证时，等待、禁route、无新部署流量、DELETE Worker都不能补出终态。

**B. 完整有界残余责任。** 如果能够证明未知旧写全部受持久预留集合约束，且关闭后无法产生集合外的新写、每条最大字节/namespace有可信上界，则将其最大残余永久保守计入唯一authority；old unknown依旧unknown、drain仍unproven，不再要求已终止才能证明预算安全。此法是完整残余上界证明，不是豁免或将不明总量写成零。若项目安全规则还要求独立能力移除，B不免除该项；它仅替代“所有在飞行请求终止”的预算证明。

本机git `720690b` 的CF01源代码为一个可研究候选：storage先唯一`cf01_budget` INSERT，trigger创建run，随后一个`await CF_BUCKET.put`，key固定`diagnostics/cf01/<UUID>/neutral.txt`，payload `The Shelf neutral CF-01 diagnostic <UUID>\n` 经TextEncoder实测72 bytes；同run重入不再次执行，budget tombstone不因cleanup删除；storage路径不是Workflow。当前六guard可以拒绝后来的新storage budget。**不能把这些本机事实直接投射到所有真实历史代码。**

B verifier需要：固定CF01所有可能storage执行代码版本的完整可证明集合，逐个校验上述前置持久预留/一次PUT/有界key与payload；完整稳定budget/tombstone/orphan清单；guard真实生效前后集合稳定；旧local/S3路径也有完整责任与能力关闭证明；旧cleanup最多操作diagnostics命名空间，不能覆盖/删除新books对象。已cleanup条目也不扣除最大责任，已confirmed旧对象也保守覆盖。一个unknown POST没有run ID不一定必须猜认：若所有通往PUT的路径必先写入已冻结完整budget集合，集合本身可覆盖它；这个前提缺失时仍失败。某个版本未知、存在绕过reserve的路径、历史集合不完整、未记录本地PUT或大小无界，则B不可用。不能用4个slot×72bytes代替缺失证明。

现有只读audit仅两个候选历史版本且没有真实执行版本关联，history有一个无归属unknown POST，因此目前A/B均未成立。下一最小工作是编写纯本地“所有候选版本是否均满足同一上界”的verifier及合成反例，列清还需哪种固定项目只读证据。若需新固定Worker有界版本/部署历史读取，要先核对官方分页/历史完整性契约；只列现有可见版本不自动证明被删旧版本/所有曾部署代码。旧工具禁止list是旧工具范围，并不表示全局授权禁止或平台一定不支持；本设计不执行list。

## 完整用量 producer：独立且尚未得到的门槛

以 `docs/r2-evidence-research.md` 与 `scripts/cf-r2-account-audit.md` 的已核对公开契约为依据，当前observer始终`accountEvidence:null/uploadEligible:false`，是正确状态。REST全账号metrics可改善数字观察，但无源样本时间/摄入水位/最大滞后保证，published/uploaded重叠未知；GraphQL account max不是sum，Adaptive当月操作不具有已证明的计费等价完整性；仅R2 Free计费状态的服务端限域接口也未被证实。

需要新producer证明：固定账号所有jurisdiction/存储类的实际total语义、源时间及完整覆盖水位/≤5分钟滞后、当月计费等价A/B、Standard/Free状态。取得时间、HTTP Date、项目controlledBytes、账本为零、样本率1、重复多查、手填completeCoverage都不能补齐。上述是**已检查公开接口缺少所需可验证契约**；不是声称平台内部永远不可能提供。官方来源更新可继续只读研究；固定账号真实调用仍先有有界review计划，不借机读取账单/资源/其他业务。

现有`accountEvidence()`仅是输入验证器，不是可信producer，不能把测试fixture或手写JSON放生产。先实现严格provider结果union：`admissible`必须附全部实际来源；`observed`带未知项不能生成evidence行；失败固定错误且原观察保留。没有满足契约的真实provider，producer模块只可输出observed/unsupported，activation和新上传继续关闭；不请求新例外或重复现有汇总授权。

## 双源读取、模式与未知恢复

新增显式`STORAGE_MODE=authority-v2`，替代容易混淆的trial/normal二选一；配置要求精确绑定：`BOOKS`→原authority固定普通桶，`TRIAL_BOOKS`→已消耗首本隔离桶，同账号/原production D1。trial target hash原样保留，作为只读legacy descriptor验证，不需要保留试运行upload secret/路由。v2 mode中所有`/api/single-trial/*` operator入口在鉴权前固定404/410，不能只auth close；首本普通所有者同源阅读继续可用。移除secret如发生unknown仍保留记录，不借改名重装。

部署工具必须从**实际固定当前版本绑定**验证两个target，不能仅信`R2_BUCKET`变量或对象方法存在。网页不可选择bucket/account/binding/descriptor；普通写唯一BOOKS，trial适配器只暴露head/get。normal与trial file ID冲突时整个私有文件解析失败，不靠UNION/先命中选一个；objectKey相同不表示同对象，源身份总是`(source,target,key,descriptor,etag)`。

`registrySource()`改为固定v2受限投影（原file_registry + 已确认trial），返回安全元数据及内部source标识。trial不投影进入普通file_registry，避免暗示对象在普通桶。管理页、bookInfo、动态detail、读取及prepared-text source授权统一用该解析器；普通文件、首本各自选择固定binding。所有R2 await后复核session generation、book/file归属、visibility/trash版本及**原source身份**，丢弃迟到响应；失败不能跨桶fallback。保留Range/HEAD/条件ETag及同源no-store。账号用量过期不影响已有确认阅读。

新增owner-only受控`GET /api/manage/uploads/<id>`状态与显式核对动作：只恢复原普通reservation，要求原descriptor/target一致和put_attempted=1，最多HEAD→条件GET/全hash→HEAD（3 R2只读，≤20MB/30秒整轮）。确认CAS同事务转账/发布registry，无PUT，无删除，无新key；404/缺内容/冲突/未知仍保留全部责任。reserved且claim未发生的状态只返回原意图，不由恢复工具授予第二次canSubmit；领取响应未知后绝不因为客户端没发PUT而重新发资格。确认可以保留在revocation/trash后已验证的预算事实，但返回内容与阅读必须复查权限。trial恢复保持旧独立受限方法，不混进普通upload ID路径。

## 任务依赖、验收和发布

建议下批按同一Sol/high实施，主 Agent逐批review；可以在真实producer/闭包缺证据时完成N1–N4离线开发并发布保持关闭的兼容读取，不把disabled称已完成普通上传：

| 批次 | 交付 | 依赖/真实门槛 |
| --- | --- | --- |
| N1 | 新schema状态机、全部责任求和、`activateImportedV2`/receipt validator/固定status与恢复 | 本设计review；合成外部proof只能测试，生产无proof 0激活写 |
| N2 | 双绑定source resolver、trial只读兼容、operator关闭、deploy/config validator | N1契约；先发布read-compatible闭写版本，再动activation |
| N3 | 普通unknown只读核对、状态展示、intent/claim CAS强化 | N1/N2；只离线fixture，不拿首本重复PUT验收 |
| N4 | A/B closure verifier框架及provider严格union、证据缺口报告 | 可独立本地实现；未知不提升为合格 |
| N5 | 固定production增量operator与独立readback、闭写双源部署 | N1–N4主review、全套验证/CI；具体HTTP/DDL预算先由最终SQL条数和真实preflight计数锁定，不沿用旧预算 |
| N6 | 实际proof与producer、唯一激活CAS、真实普通逐文件上传阅读 | 真实A或B成立、完整新鲜账号证据、目标/权限/资源验收；当前这些门槛尚未满足 |

验收矩阵至少包含：normal+24,582首本精确一次求和；旧uncertain/legacy最大责任永不释放；8GB最后额度并发仅一个intent成功、已有预留恰好8GB仍可claim、超1byte拒绝；20MB和+1byte；schema缺项/旧ready/mode与目标错配零PUT；phase CAS各崩溃落点、unknown响应独立只读恢复不重写；不同源重复file ID拒绝；首本普通双源列表与阅读、错误bucket零fallback、ETag/source漂移；trash/restore/revoke与await竞争；PUT条件冲突/null/超时保留唯一资格；核对HEAD/GET/HEAD异常/404不释放；source/proof/evidence伪造或过期拒绝；provider缺源时间/完整性字段不升级；旧guard/所有历史行/许可/收据逐字不变。

主 Agent独立review后运行相应专项、完整Node/Python、build、verify:public/static及实际秘密扫描，再commit→push→两CI，分别记录结果。CI当前默认不部署业务Worker；本机受控发布仍须实际版本/双bindings/config/readback核验，不能称CI自动上线。闭写兼容部署先验现有首本HTTP和浏览器；普通实际验收另固定一个已选≤20MB文件、一个requestId/descriptor/key、一次PUT与独立全文核验，不批量尝试、不重用首本许可。运行预算与目标未最终锁定前不执行云写。

回退保留所有v2表/active事实、两来源、首本、legacy责任、对象、unknown及receipt，不反向执行旧schema、不开旧写。业务故障可以原子闭普通写配置但保留双源只读/生命周期；不能回旧trial-only或无trash校验版本。若需全关，显式静态API回退并撤销generation且关闭全部operator入口，不能只auth close。已激活后不把authority倒回imported、不减少计账，不重发未知上传或部署；独立status核对后按新修复计划恢复。
