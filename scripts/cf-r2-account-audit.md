# R2账号纯汇总的有界观察

```sh
node scripts/cf-r2-account-audit.mjs
node scripts/cf-r2-account-audit.mjs --execute --run-id r2-observation-20261021
node --test tests/cf-r2-account-audit.test.mjs
```

默认预览不读取配置、私人数据或发送网络请求。执行时必须以项目0600普通单链接`.env`中的`SHELF_R2_ACCOUNT_ID`固定账号，凭证按既有`selectCredentials(environment, fileEnvironment)`规则从进程环境与该文件合并选取；所有已设置账号必须一致，CI执行被拒绝。不创建凭证、不将继承的token写回`.env`或其他文件，不输出token。CLI仅接受`--execute`和`--run-id`，不能覆盖账号、Worker、桶、端点或查询。模块的依赖注入用于离线测试和受控运维，不是公开API；离线测试显式使用`environment:{}`，仅继承凭证回归注入合成环境。

执行先只读本机固定Volt配置，核对账号一致、所有声明作用域均无R2绑定；Worker名称必须与项目已有私有复核记录相同。随后最多发送两个管理请求：一次该固定Worker的settings GET以重新核对无R2绑定；成功后，一次GraphQL仅查询固定账号与`the-shelf-books`的数值存储及当月操作汇总。不会列举账号资源、读取其他桶/对象名、对象内容、请求/IP、日志、业务数据或订阅账单，不修改Volt或任何云端资源。其他当前R2绑定、账号不一致、无法核对或异常均停止，不继续账号汇总。

settings响应中的绑定名称、值和其他字段仅在内存中解析后丢弃；只记录账号一致、本机无R2及远端无R2的布尔值。GraphQL不选择桶/对象名或其他项目标识；操作类型仅按官方Class A/B/免费操作表在内存中分类，未知类型只保留数值计数，不持久保存字符串。账号ID、Worker名称、凭证、原始响应与异常消息均不写文件或输出。

每个请求先持久登记pending，再调用fetch。`.local/r2-account-audit/<run-id>`目录0700、文件0600，已有run ID不能重入；不重试或自动翻页。每次请求的30秒期限覆盖fetch与完整响应流；取消挂起和期限后到达的响应不会阻塞结束。每个响应最多1,000,000字节、100,000个chunk；每个数据集最多1000组，达到上限单独标为可能截断。私有证据持久化失败会停止下一请求；`managementRequests`是预登记请求数的保守上界，pending不证明实际已发送。

该工具**始终返回`uploadEligible:false`、`accountEvidence:null`**。它只建立可复核的当前观察，不能生成上传许可：

- 工具仅选择存储字节`max{payloadSize metadataSize}`，不读取对象数量或未完成上传数量。不包含桶维度的账号`max`没有文档证明等于所有桶的总和；账号max与固定桶max相同也不能证明没有其他存储。输出明确标为`max_not_total`，`totalBytes`保留null。
- 实际存储sample时间、获取时间和查询窗口分别保留。sample超过5分钟标为陈旧，不能以获取时间替换；即使sample新鲜也不证明采样、覆盖与摄入延迟满足预算契约。空数组不能解释为零。
- 当月Class A/B计数只是观测聚合，采样、延迟和计费等价完整性均unknown。达到组数上限、未知操作或其他存储类不会升级为完整证据。
- 没有调用可在服务端仅返回R2 Free计费状态的已确认接口，`plan`始终unknown；不读取账号全部订阅来补齐这个字段。

官方依据：2026-10-21核对[Metrics and analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)（页面更新2026-09-24；存储sample表示的时间、聚合字段及最大31天查询范围）与[R2价格和操作分类](https://developers.cloudflare.com/r2/pricing/)（页面更新2026-10-01）。官方文档未提供满足现有五分钟、完整账号覆盖、Standard/Free预算契约的全部证明，不能伪造`completeCoverage`或把缺失计为零。后续若发现可用接口，应另立有界计划和review后接入；本工具不自动扩读或放宽上传门槛。

测试仅使用合成配置、私有临时目录和mock HTTP响应，不读取真实凭证、不访问Cloudflare、不上传对象。该说明不纳入网站文档发布清单。
