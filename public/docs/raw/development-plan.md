# The Shelf 开发计划

第一版已交付真实收藏书架、公开文档，以及可在本机运行的私人阅读与按需 AI 后端。CF-02 已将静态网站迁到 Cloudflare Workers Static Assets；GitHub 保存代码，GitHub Pages 保留为回退站点。业务 API、登录和私人阅读仍未迁移。

更新日期：2026 年 10 月 15 日。阶段：首版已验证；CF-01 评估完成、鉴权需适配；CF-02 静态迁移完成；CF-03 实现与主要安全测试完成，生产 CPU 门槛未通过，API 未发布。

实施按仓库根目录 `AGENTS.md` 的计划、分工、review、修正、验证与发布流程执行。主 Agent 负责规划、集成和最终验收；具体任务由主 Agent 评估难度后分配模型。下表模型与 effort 是建议起点，鉴权、安全、数据和 AI 的具体实现必须分配给 Sol；简单文档等任务可由 Luna 处理并经主 Agent review。实现完成、主 Agent review 通过、全部适用测试/构建/隐私检查通过后，达到本文迁移门槛的变更在既有授权内按提交、推送、现有 CI 部署、线上验证的顺序发布。

## 技术与边界

当前静态网站采用 Astro 和 TypeScript，后端采用 Node.js 内置 HTTP 与 SQLite，导入使用 Python 标准库。运行需要 Node.js 24 及以上、Python 3.9 及以上；本机 PDF 文本准备可使用 pdftotext，MOBI 转换需可选的 Calibre。

迁移目标为 Workers Static Assets 托管静态网站、Workers 提供同源 API、D1 保存业务数据、Workflows 执行持久 AI 任务，继续使用现有私有 R2 桶。线上正文提取改为在 paw 导入时准备，再按文件选择同步到私有存储；AI 推理继续使用现有命名任务服务。paw 是开发和导入机器，不改为常驻生产后端。

代码与公开目录可以进入仓库；私人文件映射、SQLite 和原始私人状态留在被忽略的本机目录。云端仅同步业务必需的数据，密钥放入服务端秘密配置，正文与会话不得进入公开构建。保留现有 .local 人工修正、数据库和收藏源文件。

不增加现金支出，保持单文件 20,000,000 字节门槛、逐文件上传和 8,000,000,000 字节 R2 总预算；原文件、正文、派生文件与同账号其他占用均需计入。免费额度需按账号核对，不能把 R2 预算当成账单封顶。不为迁移开通付费计划。

## 页面设计

书架使用暖白背景、墨色正文和少量朱红强调色。左侧分类导航，主区提供搜索、格式与可用性筛选、紧凑书籍网格和分页。封面默认由书名、分类和颜色排版生成，避免导入未经确认授权的图片。移动端把侧栏收起为选择器。

详情页提供面包屑、书名与作者、分类和格式标签、完整文件列表、私人阅读入口、书内提问、章节与全书总结、作者资料以及已发布结果。每个格式单独显示大小和状态；未上传不显示可下载。页面会根据后端登录与能力状态展示可执行的操作。

公开文档区有目录侧栏、可直接读取的正文、原文与合并原文链接。所有页面支持实际站点基路径，无 JavaScript 时详情和文档正文仍可读。

## 当前开发优先级

任务按下表顺序推进；同一优先级内仍有前置依赖。CF-01 评估结论是继续Cloudflare基础设施迁移。CF-02已完成；CF-03仍为P1进行中、未验收。代码与默认disabled静态改进已完成受控静态部署并通过线上验收；API发布必须等待CPU门槛通过；详细方案见[CF-03实施计划](https://github.com/sickate/the-shelf/blob/main/docs/cf03-plan.md)（仅仓库文档，不加入网站白名单）。先通过独立Free环境鉴权、原子预算和安全门槛，再发布同源API。真实两文件上传受账号共享R2用量核对门槛限制，未完成前不标为私人阅读验收通过；不做整库上传或真实模型任务。

| 编号 | 优先级与状态 | 任务 | 前置依赖 | 建议模型 / effort | 交付与验收 |
| --- | --- | --- | --- | --- | --- |
| CF-01 | P0，评估完成 | Cloudflare 免费后端最小验证 | 无 | gpt-6.1-sol / high | 记录 Workers 登录计算、D1 持久化、私有 R2 绑定与模拟 Workflow 长任务结果，给出继续或调整结论；结论不代表生产登录已通过 |
| CF-02 | P1，完成 | 静态网站迁到 Workers Static Assets | CF-01 的静态部署与权限检查通过 | gpt-6-luna / medium（静态、CI 与 URL 验证）；gpt-6.1-sol / high（受控部署辅助工具） | Astro 静态站已发布至项目 Workers Static Assets；1303 项资源 HTTP/2 全部 200，页面、文档、内容、MIME 与 404 检查通过；GitHub Pages 保留回退 |
| CF-03 | P1，进行中，未验收 | Workers + D1 登录与私人阅读 | CF-01、CF-02 | gpt-6.1-sol / high | 实现和本地安全测试已完成；独立 check/production D1 已建立，生产库仍空；云端安全、CAS、撤销和合成导入/快照主要检查通过。CPU P95仍高于5ms门槛，R2账号汇总条件授权已执行但数据freshness不满足；API与真实文件能力不得发布或标为验收通过 |
| CF-04 | P2，待开始 | 本机正文准备与云端检索数据 | CF-03 | gpt-6.1-sol / high | 在 paw 准备带页码或章节定位的正文，按文件同步到私有 R2；D1 保存必要索引与版本；缺少正文明确停用书内 AI，正文和索引不得进入静态产物 |
| CF-05 | P2，待开始 | Workflows 持久任务与真实 AI 接入 | CF-01 的长任务验证、CF-04、独立配置的有效任务 Key | gpt-6.1-sol / high | 迁移任务状态、去重、预算和中间结果；保留全局串行与调用上限；验证问答、章节和全书总结、有来源的作者资料及主动发布，浏览器关闭后任务继续 |
| CF-06 | P3，待开始 | 可靠性与后续体验 | 阅读和 AI 主流程验收 | gpt-6.1-sol / medium；涉及数据恢复或架构时 high | 优先完善上传结果核对、任务待确认处理和数据备份恢复；再按实际问题推进中文检索改进、跨设备阅读进度和网页上传管理 |

把免费运行验证放在最前，是为了尽早发现现有同步密码计算、正文处理和长任务能否适配 Workers，而不是完成大量后端迁移后才发现需要付费。静态迁移本身工作较小；真实阅读先于真实 AI，便于先确认登录、数据与文件权限。

CF-01 不依赖真实 AI Key；可先使用模拟上游验证调度，但长请求在真实 Cloudflare 运行环境中的表现必须单独记录。AI Key 的签发与现有服务运维配置独立处理，不把模拟通过标为真实 AI 已接通。

## 迁移实施要点

### 本轮 CF-01 与 CF-02 执行计划

CF-01 由 gpt-6.1-sol / high 实现最小独立验证程序，主 Agent 负责实际账号、免费计划与项目资源范围核对、集成 review 和云端验收。验证使用项目专用 Worker、D1、Workflow 与私有诊断数据；诊断入口必须鉴权，不读取电子书、不调用真实模型、不修改现有私人数据库。不把账号标识、真实密码、凭证或诊断入口令牌写进公开配置。记录登录计算、D1 跨请求持久化、R2 私有读写与清理、Workflow 在原 HTTP 请求结束后继续执行的实测结果，并区分模拟上游与真实模型能力。

CF-01 评估结论支持继续 CF-02。静态部署配置、CI 与 URL 验证由 gpt-6-luna / medium 实现；gpt-6.1-sol / high 负责受控部署辅助工具及凭证安全边界。完整 Astro dist 已通过 paw 上受控 helper 发布至 Workers Static Assets，正式站点为 <https://the-shelf.iamzhutuo.workers.dev/>。GitHub Actions 的 Cloudflare 构建产物成功，部署步骤因没有专用 token 按预期跳过；GitHub 自动部署仅在配置严格限定于单一 Worker 的专用 token 后启用，不能把账号级通用 token 复制到 GitHub。GitHub Pages 继续保留为回退方式。线上 AI 与私人 API 仍明确未配置，不能把诊断 Worker 当成生产业务后端。

**10 月 15 日进展：**CF-01 评估结论为“评估完成，鉴权需适配”：免费 D1、R2 与 Workflow 的基础验证已通过；当前 Node 登录方案不能直接照搬，CF-03 前须设计并验证保留凭证强度与限流的安全低 CPU 方案。CF-01 源码已推送，GitHub Actions 工作流 38675230094 成功；CF-01 当时 41 项 Node、8 项 Python、构建和隐私检查通过。CF-02 静态实现 review 通过，56 项 Node、8 项 Python、构建和隐私检查通过，并已通过受控 helper 发布、完成线上验收。源码提交 `308751c` 与 workflow 修正 `127be0b` 已推送；Cloudflare 工作流 38677306877 构建产物成功并按预期跳过部署步骤，Pages 工作流 38677307035 成功。HTTP/2 检查覆盖 1303 项资源，全部返回 200；12 份文档的 HTML 与 raw 页面、首页、书页、阅读入口、文档索引和合并文档均与本地构建逐字比对通过，缺失路径返回 404。Node 批量远程 fetch 曾间歇 TLS 失败，线上通过依据是独立 curl HTTP/2 检查。GitHub 仓库为公开仓库；`resources-and-access.md` 不纳入网站文档白名单，具体私有验收证据只存于被忽略的 `.local/`。未上传电子书或调用真实 AI。操作说明见[公开仓库 README](https://github.com/sickate/the-shelf/blob/main/cloudflare/probe/README.md)。

CF-03进展（2026年10月15日）：最终本地完整验证为138项Node与8项Python通过；metadata和account真实DOM分别通过11与9项断言。独立check D1已用官方Wrangler应用schema并完成002保守预算迁移回读；check与production D1独立建立，production库仍为空。production secrets仅本地生成，尚未安装到Worker或写入auth；check Worker已配置四个secret；check已关闭 `auth_config.enabled`、递增generation并撤销所有会话，workers.dev与preview URLs已禁用，D1和secrets保留未删除。应用使用现有同桶专用R2读写凭证。多轮云端每轮21个HTTP请求的安全、CAS和撤销检查通过；原子20并发争用最后一个额度仅1个成功；真实合成导入与snapshot保留override通过。源码提交 `0ae8825` 已推送；Cloudflare CI `38724875134` 构建 artifact 成功，Pages CI `38724875089` 成功。首次真实静态 CLI 在任何 Cloudflare 写入前遇到入口循环并停止；CLI修复已通过主 Agent review，新增两项真实独立进程 static/API CLI smoke后总计138项Node与8项Python全通过。CLI修复提交 `3e1aa89` 已推送；Cloudflare CI `38725881041` 构建成功、部署按预期跳过，Pages CI `38725881116` 成功。默认disabled的静态改进已通过本机受控发布及线上验收：首次网络检查完成1248项后中断，随后仅恢复剩余56项，合计1304项HEAD均为200；32项GET与本地字节及MIME一致，缺失页、`/api/health` 与 `/api` 均返回404，runtime保持disabled；线上账号页经真实Chrome DOM验证，凭证控件为disabled。

CPU门槛仍未通过：历史首轮P95/P99为5.634/13.184ms；SQL优化版本冷启动为5.313/10.873ms、热请求为4.236/5.830ms，合并42样本为5.313/10.873ms；最后小优化版本包含部署后首次访问的首轮21请求P50/P95/P99为2.512/6.554/10.981ms、同版本后续完整热轮21请求（不能保证复用同一isolate），HTTP/66断言通过，CPU P50/P95/P99为2.341/6.017/6.180ms，errors均为0；两轮P95都未达到5ms目标。六个版本/轮次共126请求，另有2次tail健康检查，共128次（低于150）；该最终候选版本首轮21次与同版本后续完整热轮21次，共42次。P99不是最大值，raw max缺失，tail连接后没有CPU events。保留每个版本全部结果，不挑较低样本。下一步先做调用级CPU观测，再评估减少D1往返原型；不改5ms目标。不得放宽5ms P95目标、降低凭证强度或付费绕过。

按当前保守API估算，每日D1写入上界为36,220行（CLI初始化诊断另计）；同账号Volt用量未知，因此不能保证账号免费额度。R2账号汇总只读条件授权已核查并执行；最新存储点不满足5分钟freshness，尚无合格上传证据。仅选择的EPUB（1,799,179 bytes）与PDF（2,588,862 bytes）dry-plan均因`account_storage_unknown`阻止；没有上传原书，也没有调用真实AI。The Shelf与Volt共享Cloudflare账号，Volt无R2（已有只读核查），Workers/D1额度共享。下一优先是调用级CPU诊断与评估进一步减少D1往返的原型；仍按计划、Sol实现、主Agent review及云端采样执行。CF-04和AI继续等待CF-03验收。代码及CLI修复已推送并通过CI，默认disabled静态改进已部署并通过线上验收，以receipt为准；API不发布，当前主站仍为CF-02静态站，CI Cloudflare仅生成artifact，Pages回退保持disabled。

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
