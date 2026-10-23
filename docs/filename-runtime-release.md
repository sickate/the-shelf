# F4 文件名识别 runtime 修复发布

2026-10-23。仅修复 Workers 不支持 redirect:error 导致发送前 TypeError：改为 manual，现有固定 URL/状态校验继续拒绝全部重定向。保留历史 unknown、去重、预算和禁止重发。加入真正 workerd 合成 outbound 回归，零真实 AI/凭证/网络；精确提升已安装 Miniflare/esbuild 为直接开发依赖。

主Agent负责隔离、review、完整测试与发布；实现/测试先前由 gpt-6.1-sol/high 完成并经主Agent26项专项验收。基线30309a8，临时源码快照 /private/tmp/shelf-f4-release-20261023，仅覆盖本修复、两测试及package/lock。不包含尚待浏览器验收的详情/reader、prepared、普通上传迁移；此文件不在公开文档清单。

验收：完整 Node/Python测试；disabled/same-origin两构建、public/static与实际凭证扫描；与基线对比生产改动仅一行redirect。通过后只提交上述五文件及此文档，push后检查两CI。用对应提交快照及现有 production/single-trial/filename-ai 受控部署，不迁移、不安装secret、不上传新书。管理HTTP最多3，Wrangler内部请求另计，独立active-version确认1请求，公开字节比对3GET，原PDF阅读14HTTP。部署未知不重试，先只读恢复；失败保留安全生产版本。回退需明确受控版本与配置，保留所有schema、对象、账本与unknown。

部署确认后唯一真实AI验收：合成文件名书名：星际航线_作者：虚构导航员_分类：科幻短篇.epub；requestId 7e3d62af-9518-4e24-a236-96c8f1b3b80c。主审18项的私有runner SHA 70cdcf6cb16e55f5cb44691f4911c9872da2fa6a91264130bddd48112d2073ba，仅一次POST，总10HTTP、70秒/请求、240秒全轮，最后两槽登出及撤销核验。全局不可覆盖attempt先落盘，旧收据hash前后相等；失败保留unknown，不换文件/requestId/run重试，不重复secret PUT。只发送合成文件名，无原书字节。

本地最终验收：独立隔离快照955项Node+8项Python通过，零失败/跳过/取消（/private/tmp/shelf-f4-release-full-unsandboxed-20261023.log）。首轮沙箱禁止本机监听导致测试失败，已停止该轮并在既有授权下完整重跑；不将失败轮记为成功。disabled与same-origin均1281页构建通过；两模式public检查1325文件/1264书、static检查1310资源/1281HTML/12文档及实际凭证扫描1559文件零匹配/不安全项通过。日志分别/private/tmp/shelf-f4-release-disabled-build-20261023.log与/private/tmp/shelf-f4-release-api-build-20261023.log。当前dist为same-origin。尚未提交/CI/部署/真实AI，不能称线上通过。
