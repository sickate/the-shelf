# F4 文件名识别 runtime 修复发布

2026-10-23。功能提交 `307d05d7fdf0cfeff19a544fd1c3a16cf672bb98` 已推送、两CI成功、受控部署及唯一合成AI验收通过。修复 Workers 不支持 `redirect:error` 导致发送前 TypeError：改为 `manual`，原固定URL和状态校验仍拒绝重定向。此次生产业务代码仅这一行变化；普通上传继续关闭，F3新前端及其23项浏览器验收不在本次发布中。

主Agent负责隔离、review、完整测试及发布；具体修复与测试由 gpt-6.1-sol/high 完成并经主Agent26项专项验收。基线30309a8，在 `/private/tmp/shelf-f4-release-20261023` 建立独立源码快照，仅覆盖identify、两项对应测试、package/lock及本文。精确提升已经安装的Miniflare/esbuild为直接开发依赖。对照新提交247个文件，除两份生成JSON的generatedAt外，源码逐字一致；构建时间字段差异已单独核对。未包含F1、F2、N1或N2a工作区改动；本文不在公开文档清单。

本地独立955项Node及8项Python通过，零失败/跳过/取消，日志 `/private/tmp/shelf-f4-release-full-unsandboxed-20261023.log`。首轮因沙箱禁止本机监听失败，已停止该轮并在既有授权下完整重跑，失败记录保留。disabled/same-origin两构建均1281页；每模式public检查1325文件/1264书、static检查1310资源/1281HTML/12文档及实际凭证扫描1559文件零匹配/不安全项通过。构建日志为 `/private/tmp/shelf-f4-release-disabled-build-20261023.log`、`/private/tmp/shelf-f4-release-api-build-20261023.log`。真实workerd测试全部outbound均被合成service拦截，没有真实AI或云请求。

按commit→push→CI→受控部署执行。Cloudflare CI `39970044768` 与Pages CI `39970044944`成功，Cloudflare自动API部署仍关闭。本机使用已验收快照和原production/single-trial/filename-ai配置部署，不迁移、不安装secret、不上传书籍或修改计费。显式管理HTTP上限3，Wrangler内部请求另计；部署日志 `.local/cf03/deploy-S2pojk/deploy.log`，SHA256 `0eebc06ae12015d047113b92f4b4e344b68f4eff333e5d63b284fc08df61f498`。独立1GET确认版本 `aaa7a94f-6478-4d76-aa65-03a3d2461d25` 唯一100%活动，收据 `.local/cf03/f4-runtime-release-active-result.json`。没有重复部署；临时快照中的上传secret副本在验收后已删除，原私有凭证保留。

发布后固定私人PDF的14HTTP回归成功，generationRevocationRequired=false、browserVerified=false，收据 `.local/cf03/reading-smoke-reading-after-runtime-307d05d-20261023/`。公开runtime/manage/read第二轮3GET与发布包逐字匹配；首轮首个GET在取得响应前transport失败，旧helper的requests=0只计响应，不能解释成零尝试。已修正尝试前计数，两轮合计不超过4个GET尝试，失败记录保留；没有写入或AI重试。

真实AI修复轮在部署确认后执行：固定合成文件名 `书名：星际航线_作者：虚构导航员_分类：科幻短篇.epub`，固定requestId `7e3d62af-9518-4e24-a236-96c8f1b3b80c`。私有runner `/private/tmp/shelf-filename-identify-repair-acceptance.mjs` SHA256 `70cdcf6cb16e55f5cb44691f4911c9872da2fa6a91264130bddd48112d2073ba`，主审18项合成测试通过；总10HTTP、每请求70秒、全轮240秒，最后两槽用于登出/撤销。全局不可覆盖attempt先持久化，只有一次新identify POST，不换文件/requestId/run重试、不重复secret PUT，只发送文件名而无原书字节。

唯一修复轮验收成功：`.local/single-trial/filename-identify-repair-acceptance-identify-repair-307d05d-20261023/result.json`。实际10HTTP/1次AI、0上传字节/真实书目变更，HTTP200、elapsedMs=2844，envelope/model/usage/metadata检查全部true，严格匹配预期书名、作者和分类。预算余量17，consumedOne=true。两条历史unknown收据hash前后一致，historyRetained=true；aiReconciliationRequired=false、generationRevocationRequired=false，登出和旧会话拒绝通过。该结果证明本次固定合成输入的完整链路，未改判历史unknown或宣称普通书籍识别普遍准确。

回退必须先固定明确版本和完整配置，不自动重发部署或AI。保留全部schema、对象、账本、收据、旧unknown与已消耗首本许可；失败时保留当前安全生产版本。后续普通上传、双源读取和F3浏览器验收按各自计划独立推进。
