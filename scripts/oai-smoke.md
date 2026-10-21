# 命名任务接口的受控验收

契约依据：[服务方 guide](https://oai.parallelstreamllc.com/guide)，最后更新 2026-10-20。此工具只使用中性合成事实，不读取书籍、历史任务或私人数据库。离线测试不调用真实服务。

```sh
node scripts/oai-smoke.mjs
node scripts/oai-smoke.mjs --execute --run-id ai-contract-20261021
```

默认仅预览。执行模式只从本项目权限为0600、当前用户所有且非链接的 `.env` 读取 `SHELF_OAI_BASE_URL` / `SHELF_OAI_KEY`；不打印凭证。只允许固定 `/v1/tasks`，不探测健康、额度、模型或管理接口，不跟随重定向。

执行顺序：先发送一个不带 Authorization 的请求，必须收到401；随后最多两个带Key的 `gpt-luna` 请求，分别验证 `topic_analysis` 的文本回答与 `research_summary` 的显式 `json_object` 输出。`kind` 只是响应标签，业务要求通过 `instructions` 发送，输出格式通过 `output_format` 发送。合成回答必须同时包含蓝色灯笼与七块石头两项事实。JSON对象的可解析性由adapter验证，事实检查单独进行。

每个请求先将 pending 意图持久保存，再发送一次。目录 `.local/ai-smoke/<run-id>` 必须0700，文件必须0600；已有run ID拒绝执行。记录只包括状态、时间、输入/输出字符数、有限数字usage和事实检查布尔值，不记录请求正文、生成内容、错误正文或请求头。缺失usage保留null。请求结果分别记 `pass`、`fail`、`unknown`；receipt仅在鉴权及两个任务全部通过时为success。receipt缺失或仅有pending必须视为unknown，不能据此重发。

最多3个HTTP请求、2个带Key任务。没有自动重试；超时、断线、5xx、重定向、未完成/无效成功响应均停止后续请求。每个smoke请求的客户端总期限900秒（为840秒服务执行及清理留出余量），覆盖响应体读取；到期会取消本地请求，但无法证明服务端未执行或没有消耗额度。新run ID也不是上游幂等键，禁止把创建新ID作为自动重试。

业务adapter允许 `gpt-luna` / `gpt-sol` / `gpt-pro` 别名，input为1～500000个Unicode字符，instructions最多50000字符，完整UTF-8 JSON正文最多32MiB；当前消费方额外将响应JSON限制在1MB。只接受HTTP200的JSON完整响应，完整保留content字符串，显式JSON输出另做对象校验。业务默认客户端期限900秒，为840秒服务执行及清理留出余量；可配置更短期限，超过900秒拒绝启动。业务队列先验证本地请求，再在发送前保存调用计数；本地拒绝不消耗调用预算，未知调用不返还预算，不自动重放503。任一uncertain任务会暂停后续发送和新任务准入，重启仍保留暂停；必须先由运维核对并处理不确定任务，不能靠重启或创建新任务绕过。

网关全局并发为1，可能被其他应用占用；本Node进程拒绝重叠adapter调用，现有队列串行消费。跨进程/副本仍需共享调度，不能把进程锁宣称为全局并发控制；真实smoke应在本项目其他AI发送器停止时运行。服务无联网、文件、工具、状态查询、会话续接、队列或结果恢复接口。作者资料由应用事先获取并核验，AI仅整理已提供的材料。

离线验证：

```sh
node --test tests/oai-smoke.test.mjs
node --test --test-name-pattern='task adapter' tests/backend.test.mjs
```

执行此工具通过，仅证明当次合成材料的接口契约，不证明真实书籍任务、云端阅读或业务后端已上线。
