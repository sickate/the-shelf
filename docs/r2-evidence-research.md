# R2 上传证据来源研究

核对日期：2026-10-22。本说明不在网站文档发布白名单；不包含账号标识、真实用量、凭证或私人云端结果。研究范围只有本项目代码和公开 Cloudflare 文档/源码，没有读取 `.env`，没有发送账号管理请求、读取计费数据或修改云端状态。

## 结论

当前已核对的公开接口中，没有证实可生成既有上传许可契约的完整 producer。找到可在服务端限定为账号纯数字汇总的 REST metrics 接口，适合补充观察，不能解锁上传。五分钟源数据新鲜度上界、完整当月计费等价 Class A/B 操作量及账号 R2 Free 状态仍未证实；不能把 unknown 或缺失值写成零。

这是对已核对公开契约的判断，不是声称 Cloudflare 内部绝无其他来源，也不是一次真实账号验收。没有运行 SQL/GraphQL schema 的账号 introspection；未验证的字段不作为可用契约。

## 本项目实际验收契约

`scripts/cf-library-data.mjs:accountEvidence()` 要求 schemaVersion=1、固定账号匹配、source=`cloudflare-account-aggregate`、completeCoverage=true、plan=`free`、storageClass=`Standard`；storedBytes 与当月 Class A/B 必须为非负安全整数，billingPeriod 必须为当前 UTC 月。源 observedAt 距现在不得超过300000ms；远端 authority 还拒绝未来时间。Class A/B 达800000/8000000时停止。

`server/remote-storage-authority.mjs:reserve()` 在 ready 后调用这个验证器，将观测与唯一远端账本共同用于8GB预算约束。imported 及本项目 committed/reserved=0 不证明账号当前存储=0，也不证明其他写能力已关闭。写闭包与账号用量证据是独立门槛，本研究不生成任一实际证明。

当前 observer 的 GraphQL account max 不是账号 total；其 accountEvidence 始终null、uploadEligible始终false。这些保护继续保留。

## 来源逐项核对

| 来源                                         | 官方事实                                                                                                  | 尚缺的证明及结论                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GraphQL `r2StorageAdaptiveGroups`            | 存储记录按桶描述，datetime是该存储值代表的时间；官方示例用max聚合。                                       | 不选择桶维度时的max不能视为所有桶之和。样本时间新鲜也不证明全账号完整同步；未见五分钟完整入库上界。                                                          |
| GraphQL `r2OperationsAdaptiveGroups`         | 官方明确去掉bucketName过滤可取账号操作概览；支持按actionType分组，最长31天查询。                          | 自适应采样节点可能提供估计；官方未承诺计费等价的完整当月计数或五分钟入库界限。取到sum或空数组均不能自行声明完整。                                            |
| REST `GET /accounts/{account_id}/r2/metrics` | 官方描述为所有桶的存储/对象数量汇总；按存储类、uploaded/published状态返回数字。                           | 明确可能未立即反映最新数据。返回契约没有sampleAt、水位、最大滞后或完整性声明；状态之间是否重叠及相加语义未充分定义。能改进观察，不能给合格total/observedAt。 |
| Standard免费额度公开价目                     | Standard有每月10GB-month、100万Class A、1000万Class B免费额度，IA不适用；存储按每天峰值在计费期平均计算。 | 价目是产品规则，不是固定账号当前plan=`free`的读回，也不是该月免费额度已用量证明。当前bytes与GB-month是不同量。                                               |
| R2 bucket info、S3/Workers list/head         | 针对固定桶/对象的操作不等同于全账号纯汇总。桶默认存储类也允许上传覆盖，旧对象保留原类。                   | 枚举全部桶/对象会越过当前纯汇总读取边界；固定桶空/Standard不能推出全账号空/Standard。不能借此补证。                                                          |
| Analytics SQL API                            | 官方有events/states/logs分类与动态目录；状态聚合合法性由dataset定义，events可能采样。                     | 已核对文档未给出可直接采用的、完整且五分钟内的R2总量/计费计数契约。不能猜测dataset/字段或泛查账号目录补齐。                                                  |

官方依据（本次直接读取公开页面/源码）：

- [R2 Metrics and analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)（页面更新2026-09-24）：R2数据集、源datetime、示例max、账号操作概览和31天限制。
- [GraphQL Sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)（页面更新2026-04-23）：Adaptive节点的采样与估计，调用方不能直接控制采样率。未采样不等同于完整摄入水位。
- [Get Account-Level Metrics](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/metrics/methods/list/) 与 [Cloudflare TypeScript SDK metrics源码](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/r2/buckets/metrics.ts)：固定GET、字段、可选性和滞后说明。本次核对main，未固定版本；后续真实执行前仍应按已review契约拒绝漂移。
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)（页面更新2026-10-01）：免费额度、Standard限定、操作分类及GB-month计法。未据此推断账号计费状态；本次没有查询账号订阅/账单。
- [官方Bucket SDK源码](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/r2/buckets/buckets.ts)：bucket info、列表返回、默认类对新对象的作用及上传覆盖。
- [SQL API Datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/)（页面更新2026-10-02）：动态目录、状态与事件语义，不是独立R2新鲜度保证。

## 可立即开发的保守补充

经主Agent review方案后，只给现有observer增加一次固定REST汇总GET。读取顺序为既有Volt本地/远端条件核对 → 固定GraphQL → REST metrics；前一步失败即停止。最多3次管理请求，逐次先durable intent；每响应仍1MB/100000 chunks、30秒完整fetch/body截止，无重试、翻页、重定向或动态端点。默认preview仍零文件/网络IO。

REST只有account_id path参数，没有query、fields选择或分页契约。成功result未声明任何桶名/ID，只有`standard`/`infrequentAccess` × `published`/`uploaded` × `payloadSize`/`metadataSize`/`objects`。由于不能server过滤，objects纯数字在内存验证后丢弃；不新增持久对象数量字段。envelope可能有字符串messages/errors，只在内存处理；非空errors停止，未知result键以固定response_invalid停止，键名和值不写stdout、receipt或异常。不能承诺服务端永不漂移，实际响应一旦漂移按失败关闭。

缺失/null/空result或整体没有任何payloadSize/metadataSize数字时失败；合法可选字段缺项不代表零。持久输出只有allowlist存储数字和固定元数据。缺失字段/状态/类用null，不补零；分开保存published/uploaded，不相加、不与GraphQL max相加。fetchedAt仅表示响应获取完成；sampleAt=null、totalBytes=null、freshness/ingestionDelay/stateOverlap=unknown、completeCoverage=false。顶层accountEvidence=null、plan=unknown、uploadEligible=false不变。第三请求失败时保留此前不完整历史观察，写固定stopped，不输出成功summary。

验证需覆盖：默认零IO、固定第三请求及durable intent、原条件失败不继续、额外键/字符串/负数/小数/溢出拒绝、可选字段缺失与显式零区分、messages及objects消除、未知字符串不进入错误/收据、响应/超时/重定向失败无重试、receipt身份漂移阻断持久化，以及成功/失败均不能生成许可。该开发不改上传器、authority、账本、计费、8GB/20MB/逐文件规则或公开文档白名单；代码撤回只移除此额外观察，不恢复上传。

## 仍可推进但不能解锁上传的工作

1. 完成旧写能力关闭/终态排空的独立验收、唯一账本及R2客户端的离线/合成验证；这些不需要假造账号用量证据。
2. 将上述缺项做成可审查的provider契约清单，继续只读公开官方更新。未来来源必须证明账号/全部jurisdiction覆盖、total语义、源时间和水位、计费计数完整性、Standard与Free定义，并保持只读纯汇总字段限制，才能另立有界producer实现计划。
3. 不通过增加采样/重查次数、把HTTP Date当sampleAt、等待后刷新fetchedAt、扩大时间窗口、把采样率1当完整水位、用本项目账本代替账号汇总或手写plan/completeCoverage来解锁。没有可用证明时继续停止真实上传。
