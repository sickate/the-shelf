# 文件名 AI 识别运维

识别和上传是独立能力。当前普通上传继续关闭：生产为首本隔离桶，原唯一authority仍为imported；005保留trial记录并禁止离开imported，activate也显式拒绝。有旧请求unknown且没有positive-terminal排空证明，账号完整用量也没有五分钟内的合格证据。现有代码没有可直接安全解除这些门槛的操作；切换变量、刷新用量、清记录或重置首本许可均不能开放普通上传。本次不诊断、重试或改变这些旧责任。

新识别只把用户选择的文件名发送到固定命名任务服务，不读取、上传或发送文件正文。`.env`存在项目AI配置，是否可用须以真实合成调用为准；现有Node开发队列和旧smoke收据保留。生产既有书籍任务端点继续关闭，本功能不迁移Workflows或Node队列。

所有者POST `/api/manage/identify`，请求严格为`{filename,requestId}`。requestId为小写canonical UUID；文件名必须是PDF/EPUB/MOBI/AZW/AZW3的basename，NFC/trim后1–255 Unicode字符、最多1024 UTF-8字节，拒绝路径、控制字符和无效Unicode。固定调用`https://oai.parallelstreamllc.com/v1/tasks`，`research_summary`、`gpt-luna`、`effort=low`、`json_object`；只有文件名进入input，instructions固定。

返回completed的metadata仅有title/author/category三键，可为null，字符串上限240/160/80。UI只能将结果作为可修改建议；空title可明确显示“文件名暂作书名”，不得称作AI已识别。重复已完成文件名永久复用缓存；服务端返回的requestId可能是已有任务的canonical ID。同requestId对应不同文件名返回409。重复pending返回202及只读pollUrl；GET该URL从D1读取，无上游调用。60秒后仍pending仅投影uncertain，持久claim不回收。未知返回409并暂停所有新识别，不因新ID、重启、换UTC日或重新部署解锁。客户端只作有限只读轮询，不重发POST。

008新增一个私有ledger表、两个索引、三个保护trigger。原子INSERT同时验证当前会话、永久hash去重、全项目单调用claim和UTC日20次上限。失败/未知均占当日预算；pending/uncertain永久占用全项目claim。数据库不保存原文件名，仅保存版本化SHA256、有限调用统计及私有结果。ledger不外键引用可被维护删除的sessions；准入trigger实时验证会话，结果返回前再次验证。成功响应envelope必须匹配已知task_id、kind和实际模型；usage缺失保持null。明确4xx及完整200中的业务schema失败记录failed，不自动重试；超时、5xx、重定向、截断、无效envelope及响应未知保留uncertain。没有删除/重置/自动恢复入口。

生产部署配置仅新增`FILENAME_AI_MODE=filename-v1`与项目secret `FILENAME_AI_KEY`；endpoint/model/effort不接受环境覆盖。密钥只能通过独立受控secret安装器从私有配置载入，不打印或进入网站。既有D1、trial桶、三项secret、auth generation及已消费的许可保持不变。执行窗口停止本项目Node开发AI发送器；D1只能协调本功能，不能宣称控制其他应用的网关名额。网关全局并发1，503仍为unknown。

新增schema工具：

```sh
node scripts/filename-identification-schema.mjs status
node scripts/filename-identification-schema.mjs status --execute --run UNIQUE_PRE
node scripts/filename-identification-schema.mjs apply --execute --run UNIQUE_APPLY
node scripts/filename-identification-schema.mjs status --execute --run UNIQUE_POST
```

默认preview零IO。固定原production D1，status正常8HTTP/硬上限10/0DDL；apply正常22HTTP/硬上限24/6DDL。状态、原schema、authority、trial、auth、原registries、007管理/上传行前后指纹核验；全局apply claim和逐请求私有意图先于发送，0700目录/0600文件不可覆盖。DDL未知停止且保留claim，不以新run自动重放；不修改base/007历史hash。状态完整的再次apply零DDL；有识别历史后使用status，不以apply覆盖数据。

本地专项覆盖跨连接单claim、每日上限/UTC换日、未知不重试、pending崩溃、永久缓存、冲突ID、会话维护/撤销、输入输出边界和有界transport。真实合成验收由主Agent在review/完整验证/CI/迁移/secret及版本绑定回读后执行：固定最多11个业务HTTP、最多1个真实AI任务，不发送书籍或上传字节；任何未知停止后续识别，仅完成已授权登出/旧cookie拒绝检查。真实结果另记收据，不以合成fixture或本地全绿声称AI已上线。

回退保留008及全部识别责任，可关闭识别mode或回退到保留回收站访问复核的已验收Worker；不恢复旧上传能力、不清ledger、不重置trial。只有显式trial静态回退并撤销会话才能完全关闭既有operator入口，单独auth close不足以关闭它。
