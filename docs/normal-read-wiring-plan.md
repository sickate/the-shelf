# N2b 闭写双源读取与共享部署契约设计

2026-10-23。设计者 prepared_finish，`gpt-6.1-sol` / high。主 Agent 已验收 F1 接线的177项；本轮只研究仓库公开源码、N2a最终profile和本地内存SQLite，新增本文，不改业务文件、其他文档、SQL、凭证或云状态。本文不进入公开文档清单。设计通过不代表实现、迁移、发布或普通上传开放。

## 本轮计划与实施边界

先核对当前 trial/prepared/filename、deploy/auth/static 的实际契约；再以 N2a 冻结profile为依赖，确定一套纯共享配置契约及双源授权投影；最后列出兼容、请求预算、专项验收与回退门槛，交主 Agent 设计review。N2a profile已由 normal_transition 通报冻结，主 Agent 对N2a最终实现的review仍是实施依赖。本轮没有运行生产CLI、测试账号或网络请求。

后续具体开发仍须另行派给Sol/high；建议拆为：①纯contract和公开schema artifact/一致性检查；②storage-sources及旧trial decoder的纯读取拆分；③Worker/detail/manage/prepared闭包；④deploy/auth/static同批接线；⑤真实SQLite/workerd与现有专项回归。①依赖N2a final；②依赖①；③依赖②；④与②③一同集成验收；发布依赖主 Agent 完整复审与独立验证。N2c运维兼容独立实施，不把它混入本批真实DDL。

目标是让当前已确认首本和已导入普通原件共用所有者同源阅读，保持普通写关闭。明确不做011安装/activation、普通reserve/claim/PUT、secret安装或删除、全库上传、持久AI/Workflows、首本prepared来源扩展，以及任何旧许可重发。首本已消耗许可和所有unknown/guard/imported/对象/账本永久保留。

## 当前源码中需要同时收口的差距

- `worker.mjs` 的 `registrySource(env)` 在 trial模式只投影首本，并把环境值插入SQL；文件路由先查 `browser_uploads`，随后才选trial或S3签名分支。已导入普通confirmed原件不在browser_uploads时不能复用管理上传的同源读取。
- `single-trial.mjs` 的 `trialMode()` 把隔离BOOKS、put能力和旧mode绑定；`decodeTrialRow()` 又依赖它。不能将它原样用于普通BOOKS+TRIAL_BOOKS，也不能为了读取重新开启operator。
- `bookInfo`、metadata回读、管理列表分别依赖registry投影；`mergePublicBook()`只作展示匹配，不检测跨source冲突。只修content路由会留下错误的“已上传”显示和跨书归属问题。
- F1部署器支持trial+filename+prepared；auth enable仍按旧单BOOKS/旧secret集合校验，刻意不接受这些扩展。status/close目前不读Worker settings，因此紧急撤销不依赖新profile是否有效。
- 006的 `admission_private` 已允许普通file_registry或首本access，但其OR条件不是source唯一性证明；007的access guard也不能代替trial生命周期闭包。010的view和insert trigger只认识普通registry，不认识首本。
- 管理普通上传只靠 `NORMAL_UPLOAD_MODE=authority-v1` 等条件拒绝仍不够明确；bytes入口当前会先读uploadRow。新closed分支必须在任何storage lookup/读取请求字节前返回。

## 同一套精确部署profile

新增纯 `shared/storage-deployment-contract.mjs`，不得导入Node、SQLite、fs、环境发现、网络或现有deploy脚本。其输入是调用方已经固定/验证的账号、原production DB及check DB、旧trial target config SHA和显式profile标识；不接收任意URL/桶/Worker/SQL/path。账号和DB实际值只来自原私有deploy配置，不写进该共享文件、前端或公开输出。

建议接口：

```text
storageDeploymentContract({profile, identity, trialTargetSha256,
                           filenameAi, preparedText, retainedSecrets})
  -> {worker, origin, vars, d1Bindings, r2Bindings, secretNames,
      allowedStorageLayouts, schemaFeatures, canonicalProfile}
validateRemoteStorageBindings(settings, contract)
  -> {canonicalBindings, bindingsSha256, settingsSha256}
validateRuntimeStorageConfiguration(env)
  -> {mode, writeGate:'closed', normalTarget, trialTarget, preparedEnabled}
```

`profile`只接受已列出的离散值。`filenameAi/preparedText`为严格boolean；`retainedSecrets`只接受本表的精确名字profile，不能传任意secret数组。纯contract构造不会自行读取secret值；返回稳定canonicalProfile，调用方用既有Node/WebCrypto计算profile hash，避免在纯模块引入Node crypto。Worker runtime只核对明确mode/目标字段、方法及原owner/session key规则；R2对象不能自省实际桶/账号，真实目标仍必须靠受控deploy和独立完整settings/实际版本读回来证明。

| profile               | 范围与核心R2 binding                                                               | storage vars                                    | 旧mode规则                                               |
| --------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `legacy-v1`           | 原check/ordinary fixture；BOOKS→普通桶，现有行为保留                               | 原APP_SCOPE/SITE_ORIGIN/R2_ACCOUNT_ID/R2_BUCKET | 不能用于新production双源发布；无TRIAL_BOOKS/STORAGE_MODE |
| `trial-v1`            | 当前production回归；BOOKS→隔离首本桶                                               | 原trial mode、target SHA及原R2 vars             | 不允许TRIAL_BOOKS或新STORAGE_MODE混入                    |
| `authority-v2-closed` | 仅production；BOOKS→`the-shelf-books`；TRIAL_BOOKS→`the-shelf-first-book-20261023` | 下表精确字段                                    | 所有旧写开关与旧SINGLE_TRIAL_MODE必须不存在              |

`authority-v2-closed` 精确核心字段：

| 名称                                                      | 固定契约                                                |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `APP_SCOPE` / `SITE_ORIGIN`                               | production / 原主站同源                                 |
| `DB`                                                      | 原production D1；DB UUID由原deploy.json固定             |
| `ASSETS`                                                  | 原静态资源binding及/api run_worker_first配置            |
| `BOOKS` / `R2_ACCOUNT_ID` / `R2_BUCKET`                   | 普通原桶 / 原固定账号 / `the-shelf-books`               |
| `TRIAL_BOOKS` / `TRIAL_R2_ACCOUNT_ID` / `TRIAL_R2_BUCKET` | 原隔离桶 / 同固定账号 / `the-shelf-first-book-20261023` |
| `TRIAL_TARGET_SHA256`                                     | 原已确认target config SHA；不是新许可/新target          |
| `STORAGE_MODE` / `STORAGE_WRITE_MODE`                     | `authority-v2` / `closed`                               |

这里明确选择新名字 `TRIAL_TARGET_SHA256`，避免保留旧 `SINGLE_TRIAL_MODE` 使 `trialMode()`意外重开。v2下 `SINGLE_TRIAL_MODE`、`SINGLE_TRIAL_TARGET_SHA256`、`NORMAL_UPLOAD_MODE`、R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY均须不存在；不能设成空字符串或未知值。旧secret `SINGLE_TRIAL_UPLOAD_SECRET`的名字留存是下面的惰性secret profile，不是运行mode。

v2初次发布只使用现有已知的四secret profile：`OWNER_KEY_PEPPER`、`SESSION_SECRET`、`SINGLE_TRIAL_UPLOAD_SECRET`、`FILENAME_AI_KEY`，同时显式filename开启。另保留三secret（没有FILENAME_AI_KEY）的旧trial精确profile用于既有测试/已确认环境；不能在当前四secret生产前态中省略filename flag来隐式接受或删除它。没有trial secret的v2 profile本批不提供，未来独立确认secret删除后才设计。deploy/auth只验证名字/类型，不安装、读取远端值或删除secret；v2读取target文件可用现有 `validateSingleTrialTarget(..., undefined)`验固定字段/SHA，不要求用旧上传secret再次证明读取能力。

filename扩展与storage mode解耦：开启精确要求 `FILENAME_AI_MODE=filename-v1` 和已知FILENAME_AI_KEY名字，关闭时mode和该secret都必须符合被选精确profile，不能作任意可选secret。现有identify协议/限额/真实Key验收不因本次profile自动通过。

prepared扩展精确为**四项**：`PREPARED_TEXT_MODE=registry-v1`、`PREPARED_R2_ACCOUNT_ID`同账号、`PREPARED_R2_BUCKET=the-shelf-books`、`PREPARED_BOOKS`→普通桶。与BOOKS同桶仍保留两个明确binding角色。四项完整存在或完整不存在，缺一/多一/错类型/错桶都拒绝；同名重复、未知binding/var/secret、额外json同样拒绝。R2 binding只接受已review的固定字段shape（缺省或default jurisdiction、可选同账号account_id），D1官方database_id/旧id别名只接受精确相等的已支持shape；前后观察中shape改变仍由完整settings hash检测，不因归一化而忽略漂移。

CLI只作固定profile选择，不增加账号/桶/DB/URL覆盖：建议新增 `--storage-mode authority-v2 --write-mode closed`，与 `--single-trial`互斥；filename/prepared仍须显式指定。v2初次迁移和v2 prepared开关使用单独明确的前态→后态迁移白名单，不能用allowStatic/allowTransition宽泛跳过检查。当前已验收trial+filename可作为首次v2前态；完整正确v2可重复发布；partial、混合mode、错误普通/隔离桶一律在Wrangler前失败。prepared omission仍拒绝移除；prepared-only回退保持v2 BOOKS/TRIAL_BOOKS+closed，只移除prepared四项。

## N2a schema依赖与生产组合

下表已从最终N2a公开模块在本机重新计算核对；hash是有序schema JSON SHA，不能与SQL源码SHA混用。

| N2a layout      | 定义数 | schema JSON SHA256                                                 |
| --------------- | -----: | ------------------------------------------------------------------ |
| `legacy-v1`     |     44 | `10fc23abed2c792337e28eecd7cb47c50f3731426c745b64989a11817d720350` |
| `trial-v1`      |     51 | `4b6c10339c1d74355254951d0168d936b6e3e159b8aa3704619342346d0d7e4e` |
| `activation-v2` |     75 | `5208bcb2e9dcdf1d1d8aa0affec120c8ed3aa15350cd5245b705734e14c13dd2` |

N2a仅覆盖 `shelf_storage_* / shelf_single_trial_* / shelf_legacy_*`，固定LIMIT129，只trim外围和单个末分号，不折叠SQL内部空白。006 admission_private、010 prepared以及其他auth/management/filename schema不在这75项里，不能把“匹配75项”写成“整库校验通过”。011源码SHA保持 `db532d26cbe6dc3639cb9f5a32ae85ad6f0943ab7b2fc1fabe974bd1bfc3a0c3`；010源码SHA保持 `b70ad99611023bde6aa08901cd8eeebbdeeae0cd38e96f0ea8dec93e566afd0f`。不改005/006/010/011。

Worker不能导入Node schema模块。新增一个由受信SQL和N2a公开数组离线生成的纯数据artifact（建议 `shared/storage-schema-profiles.mjs`），生成器/一致性测试验证其逐对象定义及上述hash与N2a一致。artifact无资源实际ID/secret/私有状态；不在运行时读磁盘或从远端生成“期望schema”。纯deployment contract与Worker引用该artifact；Node仍以N2a helper为实现来源，避免人工维护第二套宽松schema。

production verifier还需固定**整库**profile：本地SQLite实测001–009为112项、001–010为125项；以75项替换旧51项storage定义后的001–011为149项（含010）。可用固定sqlite_master投影LIMIT257读取，排除平台明确的 `_cf_KV`/`d1_migrations`和SQLite内部对象；不忽略未知业务对象。比较字段集合/原语类型/名称唯一及完整SQL，不能仅比数目、哈希远端自身或给未知DDL加忽略项。

production v2 closed接受以下两类：

1. 旧005完整trial布局，加精确006/007/008/009，010可完全无或完整13项；prepared开启则必须010完整。此时authority仍imported，读取不等待011/activation。
2. 完整011的75项storage布局，加同一006/007/008/009及完整010（遵守010先于011的生产安装顺序）。011 partial、两个旧guard只替换其一、陌生DDL、任意内部字面量漂移全部503/部署拒绝，不能退回旧布局。Node的75项兼容可独立用于无010合成fixture，不把该fixture当生产组合授权。

发现profile和使用grant的同一primary SELECT再次附带有序schema JSON，R2返回后的最终primary SELECT也再次比较；不跨请求缓存“曾匹配”。这与N2a同statement manifest思想一致。旧/新schema切换窗口允许失败关闭，不能承诺无中断或跨外部await持有事务。Worker读取既有confirmed内容不以authority ready、五分钟账号证据或activation成功作为前提；它只证明当前精确schema/identity/来源/所有者闭包，不输出activation已验收结论，更不导入N1 verifier或开启新写。

完整schema JSON本地测得001–010为77,059bytes、001–011为101,334bytes；外包一层schema_json字符串约79,795/104,649bytes。是本地schema体量测量，不是线上全响应上限或Free CPU验收。控制面继续1MiB和30秒/有界块数/无重试，超限停止，不扩大producer权限。

## 双源解析与同书归属

新增Worker-only `storage-sources.mjs`，只用Web API/WebCrypto、纯schema artifact和固定SQL/bind参数。保持旧v1路径供回归，但明确v2路径不得回落到S3签名或旧单桶分支。

```text
storageReadConfiguration(env) -> frozen normal/trial target + closed gate
resolveConfirmedSource(env, {scope, fileId, expectedBookId?})
  -> immutable grant {source, target, descriptor, etag, sourceVersion,
                      authorityIdentity, schemaProfile, catalogFacts,
                      managementVersion, visibility, sessionFacts}
confirmedSourceProjection(...) -> 固定SQL/bind参数及内部source计数
readSourceAdapter(env, source) -> 仅head/get facade
assertUnchangedSourceGrant(...) -> 最终primary闭包与一次access admission
```

先做按 `(scope,fileId)` 的全局原始confirmed候选计数，再按bookId、visibility/trash、catalog、registry有效性筛选。普通候选来自confirmed file_registry；trial原始候选按state=confirmed及descriptor中的scope/fileId计数，先不以put/content_verified、registry/catalog或bookId过滤，随后decoder才验证已消耗事实。两来源同ID即409，不能UNION去重、优先normal/trial、按bookId先过滤，或因某一候选descriptor坏了而静默忽略。无候选409；单候选但关系/类型损坏409或503，绝不尝试另一个桶。不同source使用相同object key是两个对象，grant和cache identity必须含source+target，不能仅按key缓存。

普通候选必须同时精确对应原authority identity、original registry和reservation：enabled=1、confirmed/content_verified=1、reservationId/logicalKey/objectKey/descriptor/ETag一致；descriptor的scope/fileId/bookId/format/size/hash与file_registry所有对应字段及其正整数version一致。只读不会重写file_registry或伪造browser_uploads。prepared-text reservation不作为普通原件候选。

trial使用新纯decoder（从现有decodeTrialRow拆出与trialMode无关的固定target读取校验），保留consent、permit、发放/到期历史字段关系、target/account/config SHA、authority完整identity、descriptor固定shape/key以及put_attempted=content_verified=1和ETag；**读取已确认历史首本不要求现在仍在permit期限内**。原trial-v1 wrapper继续调用trialMode，不改变旧operator契约。v2 decoder不读上传secret、不要求put方法、不提供任何mutation入口。

grant所属bookId是descriptor、普通file_registry（若普通来源）和catalog主键共同确定的唯一同书值。请求expectedBookId必须等于它；catalog文件必须恰好一个匹配id，format/size/status=candidate及当前允许的visibility/readable规则匹配。trial保留原private/readable=true约束。不能先用请求bookId过滤候选，不能让另一书catalog引用同fileId后被展示成已上传。

详情、metadata返回的registry、管理列表统一使用相同投影并检测冲突。mergePublicBook只接收已验证的同书公开字段子集；内部source/target/descriptor/hash/key/permit不进入API。发现被该响应引用的冲突fileId时整次响应409，不静默把其中一本显示可读。管理列表还须全局检测其列出的confirmed来源；保留现有book上限，新增来源投影候选上限20,000行，固定LIMIT20,001探测超限，并对所返回的最小投影设1MiB字节上限，任一超限整次503，不自动分页加请求。单文件读取继续只取最多两个raw候选，不受列表规模影响；不能保留无LIMIT的source扫描。

## 读取闭包、prepared和最早关闭operator

v2 `/api/files/:id/access|content` 在browser_uploads分派之前统一resolve，覆盖非browser导入普通confirmed和首本。GET/HEAD、单Range/416、If-Match/412、ETag/Content-Length/Content-Range、同源URL和no-store沿用已验收约定。access只HEAD对象后给同源content URL，不能返回签名URL；HEAD/content/R2 GET均只使用grant选定的head/get facade。真实R2 binding仍有平台写能力，不能称为只读binding。

初始primary grant绑定当前session generation/revocation/expiry、auth enabled/origin、源与目标、schema、同书/catalog唯一候选及management visibility/trashed/version。外部R2 await后，最终primary重新计算全局candidate计数并比较同一grant，不只比较fileId/ETag；source、目标、归属、版本、catalog或schema漂移都拒绝。最终INSERT access admission带同一固定谓词与session校验，只有成功一次；API admission继续原来一次。拒绝时取消迟到object/body，不等待永不settle的cancel；有30秒deadline、块/字节界限，不能以abort等于证明provider停止。返回流后无法撤回已发送字节，真实验收只证明发出响应前的闭包，不宣称整个阅读期间持续锁住会话。

prepared继续只读取010普通来源。首本未写普通original registry/file_registry，不能把它投进去绕010；trial prepared在D1阶段零R2拒绝。v2 prepared还要检测普通与trial同ID冲突；建议将固定source计数/schema snapshot子投影并入现有prepared初始及最终sourceRow SELECT，不额外计一次API/access admission或额外HTTP。010 view/trigger保持冻结。仅在其结果确定normal且与prepared pin原件完全一致时继续，R2后同一predicate再核对；不能只在preparedRoute外面做一次前置检查。

最早关闭须在 `handleRequest()` 取得规范pathname后、任何configuration/owner key检查/ipDigest/session/Origin/CSRF/D1 admission/R2之前执行：

```text
if env.STORAGE_MODE === 'authority-v2' and
   (pathname === '/api/single-trial' or pathname startsWith '/api/single-trial/'):
    return 固定404 not_found + no-store
```

精确v2 mode就关闭，即使write mode/secret/DB/全局auth配置损坏也不能先运行旧operator。未知storage mode不获得任何v2能力，普通API随后503。所有方法（GET/HEAD/POST/PUT/OPTIONS等）、未知子路径、正确旧secret同样404，零secret值读取、零WebCrypto operator鉴权、零D1/R2。对导出的trialOperatorRoute/operator鉴权入口再加相同防线，避免直接调用绕过；测试env secret用getter证明从未访问。旧trial-v1既有行为保留，不能通过更改通用trialMode使原生产HTTP回归失效。

v2普通upload capability在storage读取前固定返回disabled/normal_upload_unavailable，原因storage_write_gate_closed。`/api/manage/uploads` intent及任意bytes路由在进入intent/bytes/uploadRow/readJson/boundedUploadBytes之前固定拒绝；普通API的原session/Origin/CSRF/API admission仍保留，这与trial operator的零D1最早关闭不同。没有storage reservation/claim/metadata副作用、零body读取/零PUT。管理metadata/trash/restore及filename识别不因这个gate关闭。

本地历史trial CLI的只读status可沿N2a保留；issue/upload/schema/catalog/reconcile不因新profile获得重放授权。N2b不调用它们。若另行接这些CLI的v2兼容，只允许显式只读历史状态，不能为“测关闭”执行真实已消耗upload；HTTP最早拒绝不能当作可以安全重放CLI的理由。

## deploy / auth / static必须同时可用

部署guard一次固定有界只读SELECT读取整库profile、authority完整identity、原confirmed trial target/consumed事实，prepared开启时也在同条中验证010；不DDL、不读对象、不触达账号用量。保留原production DB identity GET与前后settings。N2b首次可部署旧005完整布局，不要求011或新鲜账号producer。

auth enable使用同一contract归一化所有binding，继续固定100%实际expectedVersion、两次完整Worker观察及CAS前deployment观察，不能只比较vars。启用前/独立auth回读可把storage/schema/target投影并入现有固定SELECT，保持HTTP上限；任何漂移拒绝，不自动再enable。status、initialize-disabled、close保留原auth-only schema检查；尤其close不依赖v2/prepared schema或Worker配置可读，以便损坏时仍能撤销generation和sessions。原auth状态不随部署自动enable/initialize/重建。

完整静态回退必须显式选择 `authority-v2-closed`并识别当前全部双binding、prepared/filename/retained-secret精确profile；遗漏mode或prepared flag不准删除能力。输出仅ASSETS和同一已知secret名字集合，不恢复旧写绑定、不删除secret或数据。先按有界close撤销会话，再静态发布；未知发布保留receipt并独立只读恢复，不自动重deploy。prepared-only回退保留v2所有者同源阅读与closed gate。长期代码回退必须保留双source与生命周期检查；将来有普通confirmed对象后不能回trial-only版本。

## 受影响operator与预算清单

这是设计预算，实施后必须用实际adapter计数专项核定；控制响应仍有界、无重试，Wrangler内部请求及浏览器请求另列。未实施的兼容不能按此表实际运行。

| 工具/路径                                                                                   | 当前已核定                                                          | N2b/N2c设计处理                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-api-deploy`                                                                             | 普通/trial显式3HTTP；prepared4                                      | v2无prepared新增1条schema/authority/source guard→4；v2+prepared合并同一guard仍4。identity/settings前/guard/settings后。prepared-only v2回退也要v2 guard→4，不沿用旧trial回退3；零DDL/R2/secret写。                                                        |
| `cf-production-auth`                                                                        | status3、initialize4、enable12、close4                              | enable把完整storage投影并入已有auth SELECT，保持12；status/initialize/close不增加storage/Worker依赖，保持3/4/4。额外投影必须有大小测试，不能再暗加SELECT。                                                                                                |
| `cf-deploy` static                                                                          | settings前/后2显式HTTP                                              | v2仍2；close另算4，不混写成一次静态回退共2。Wrangler内部HTTP另计。                                                                                                                                                                                        |
| `cf-reading-smoke`                                                                          | 旧ordinary正常10/限11；trial正常14/限15                             | 新v2同源plan必须单独实现，不能套旧presign plan。建议保留trial14项+HEAD1+四个operator关闭样本=正常19/限20（1次失败logout余量）；所有字节/Range限额保持，浏览器不包含。仅真实首本有对象时验trial来源，normal来源只在离线双桶fixture验，不上传来凑真实证据。 |
| `prepared-index schema-status`                                                              | 10HTTP                                                              | N2c完整旧profile仍10；完整011多一组4张v2表完整有序快照→11，单组超1MiB失败。新group是activation/receipts/evidence/legacy liabilities，不忽略旧事实。                                                                                                       |
| `prepared-index schema-apply`                                                               | 33HTTP/13DDL                                                        | 010先于011，旧完整profile维持33；activation-v2下不提供apply，状态只读后停止，不能“补010”或给35HTTP新DDL许可。                                                                                                                                             |
| `prepared-index index-status`                                                               | D1≤5+P、R2≤3                                                        | 将原010查询替换为固定整库+010投影，并在既有source前后语句附manifest，目标保持5+P及3；不额外authority audit。N2c需专项证明不漏未知对象/部分011，超限停止。                                                                                                 |
| `prepared-index index-publish`                                                              | cold D1≤13+B+2P、R2≤6；resume多P                                    | N2b不运行；N2c只读兼容不授权v2发布。完整011写路径在显式review前停止，不悄悄沿用旧schema检查。原010/source支持仍只有normal。                                                                                                                               |
| `single-trial` CLI                                                                          | catalog10/schema20/issue12/status6/upload1/reconcile16              | HTTP operator在v2一律最早关闭；本地不调用mutation。N2a旧trial实际status5、issue11、reconcile13，均未改6/12/16上限；只读v2状态需单列计数，不把旧issue预算变成新许可。                                                                                      |
| `selected-sync` / `storage-migrate`                                                         | selected128；import80（内部authority72）、schema-freeze144/status32 | N2a正常selected29/128、空库import74/80，在旧布局仍有余量；v2 mutation按schema拒绝。新双源读取不恢复这些历史写流程，额外兼容属独立review。                                                                                                                 |
| `storage-preflight`                                                                         | 18HTTP                                                              | 当前Worker配置白名单仍只认BOOKS普通桶；要作为v2权威preflight必须改为同contract并核定其额外schema/source观测。N2b不直接运行旧工具去推断v2可上传，也不提升18。                                                                                              |
| `book-management-schema` / `filename-identification-schema` / `identify-observation-schema` | status9/10/10；apply23/24/26                                        | oldSchema快照会拒绝010/011，属N2c候选。只读status精确兼容及保留v2事实必须重算；历史apply不自动支持新布局。不得简单忽略011来维持原预算。                                                                                                                   |
| `cf-filename-ai-secret`                                                                     | install4/recovery2                                                  | 其validator仍限定trial。v2不调用安装/恢复，不扩secret PUT；后续只读recovery若确有需要单独复用精确contract并验证2请求预算。                                                                                                                                |
| 旧CF01关闭/audit及账号汇总producer                                                          | 各自原有许可/限额                                                   | 不在本批，不能因为新contract扩读账号、恢复旧入口或把旧unknown改成已证明。                                                                                                                                                                                 |

其中P=ceil(C/1000)、B=ceil(C/100)；prepared包/块既有上限保持。Worker业务D1操作数与控制面HTTP分列：source/schema投影应合入初始和最终primary两语句，不再起无意的独立schema请求；API admission原批次及维护序数清理照旧，成功access只一次。管理列表closed capability不再走旧用量/authority探测，减少的查询不能挪作额外无限扫描。

N2a原audit为旧布局2SELECT、v2只读3SELECT（每实例每scope另一次identity GET）；manifest额外响应约legacy25,693/trial32,807/v257,661bytes。这些已在N2a预算表登记，本设计不再给每个Worker请求套Node audit，避免重复开销与Node依赖。新增operator预算或更大的边界须先更新计划/review，不能提高requestLimit掩盖超额。

## 验收、发布门槛与回退

1. 纯contract表驱动覆盖所有profile组合、严格boolean、四项prepared完整性、未知/重复/mistyped配置、D1 alias冲突、两个R2相同key不同对象、mode混用、secret名字集合。生成artifact逐对象等于N2a，006/010独立核验；partial/陌生DDL/内部字面量空白全部拒绝。
2. 真实SQLite与workerd/miniflare使用两个独立R2 binding：普通已导入但没有browser_uploads、首本、同key不同bytes、跨source同ID/不同book、同书catalog重复fileId、错误book归属、残缺registry/reservation、首本trial decoder历史过期读取。不能用一个Map冒充两桶。
3. GET/access、HEAD、完整GET、Range、416/412、异常/空body/超时/迟到取消；R2外部await中trash/restore、visibility/version/catalog/source/schema/auth generation/revoked漂移。返回前闭包拒绝且不泄漏key/hash/permit；API/access各一次，错误前态零R2。
4. prepared只支持normal；trial prepared和跨source冲突在D1零R2拒绝。保留010全部现有用例、不修改冻结SQL。管理详情/list/metadata回读对冲突一致，不只测content。
5. 最早operator矩阵覆盖根路径、trailing slash、全部已知及未知子路径、各方法、正确/错误旧secret、坏全局auth/DB/Origin。secret getter、D1/R2 spy均零访问；直接调用导出operator入口同样拒绝。普通上传closed同时证明零body读取、零storage lookup/claim/PUT，但不删除其正常API/session/CSRF规则。
6. deploy/auth/static必须同批集成：缺schema/错target在Wrangler前停止；精确100%版本与完整settings前后闭合；close在storage配置/011损坏时仍可用；未知deploy/CAS不重发。HTTP计数、1MiB/块数/30秒及迟到取消独立断言。
7. 主 Agent review、完整Node/Python、构建、public/static、秘密扫描通过后，才在既有授权内commit→push→分别记录CI→受控部署。真实发布前冻结旧版本/配置/DB/首本行快照；首批仍旧005完整schema，011未安装/activation未执行。随后按另行核定19/20读取runner及浏览器验收，不做真实upload/operator测试，不因测试通过宣称普通上传完成。

失败先保留现有可用部署。N2b离线未发布时撤回新增代码即可；实际发布后首选保留双源+生命周期的closed版本，或auth close加显式完整静态API回退。所有010/011、对象、账本、私有receipt、首本许可及unknown保持；不回滚DDL、不释放未知预留、不换key、不重装secret、不恢复旧写。交付分别报告本地、远端CI、真实HTTP和浏览器状态。
