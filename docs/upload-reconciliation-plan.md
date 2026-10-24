# 未知上传结果核对（TS-009，常规上传上线后实施）

主Agent方案，2026-10-24。依赖TS-005的013、明确隔离target和生产上传/阅读验收；当前发布期间仅保留方案，不修改冻结产品模块。实施模型gpt-6.1-sol/high；涉及原责任确认、鉴权、R2和并发，不分给Luna。主Agent负责独立review、测试、提交与发布。

目标：所有者看到“需核对”时可显式核对既有对象；能证明内容完整就确认原预留，不能证明就保留未知，页面提供清楚结果。仅常规隔离target；不处理旧NULL target、首本、永久删除/预算释放、旧桶ready迁移，也不新增PUT、重传、换key、预留或余额。

复用013现有uploading/uncertain→confirmed触发器及registry投影，无schema迁移。复用assertIsolatedUploadRow、write:false策略读取、格式/hash验证和现有session/Origin/CSRF。旧RemoteStorageAuthority.reconcile要求旧桶ready，不适用于本模式，不调用它。

1. 管理列表新增严格映射后的putClaimed、canVerifyExisting布尔字段，不返回key、bucket、descriptor或R2 URL。NULL、未claim、错误映射一律不能核对。
2. 新POST /api/manage/uploads/:id/reconcile只接受固定ID与版本，服务端从原记录决定全部对象身份。owner、Origin/CSRF及现有admission先于对象访问；confirmed独立核验当前投影后回状态，未claim不授予发送权限。
3. 对原put_attempted=1且uploading/uncertain，每次显式点击最多2HEAD+1条件GET、全文≤20MB：首HEAD确定ETag/大小，GET绑定首ETag，限长全文hash及格式检查，末HEAD必须一致。总期限和分阶段期限到达后不继续派发请求；不调用put/delete。
4. 仅CAS原reservation/descriptor/key/put_attempted/捕获状态和更新时间。确认由现有触发器原子reserved→committed；并发核对或原上传确认最多转账一次。CAS响应未知只回读，不重发mutation；仍未知即保留全部责任。policy关闭不阻止已有claim确认。
5. UI增加“核对上传结果”，单次点击期间禁用，保护选择代次、会话退出和迟到响应；成功刷新目录，失败提示仍待核对。没有自动轮询或字节重传。删除/退出发生于验证期间可保留事实确认，但私人响应与阅读须复核当前session及生命周期。

文件范围：cloudflare/library/management.mjs、isolated-upload.mjs，src/scripts/manage.ts、src/lib/manage-ui.mjs，tests/isolated-upload.test.mjs、manage-ui.test.mjs及适用的既有管理浏览器fixture；不新增operator或更改013。

验收：真实workerd/SQLite模拟PUT成功后响应丢失、claim后崩溃、确认CAS响应丢失；所有路径PUT/DELETE/新reservation为0。覆盖缺失对象、错hash/格式、ETag漂移、超限、超时、并发核对/原确认、policy关闭、旧来源拒绝零R2、Origin/CSRF/登出撤销、trash/restore竞态。主Agent独立检查SQL转账唯一性和实际R2调用计数；管理页真实本机Chrome夹具验证按钮、重复点击和迟到响应。完整适用回归、两构建、public/static和实际秘密扫描通过，再commit→push→两CI→保留013的同profile部署。生产仅做有界鉴权/无效ID/既有confirmed只读核对，不制造未知PUT来验收。

回退：回到上一个已验隔离业务版本，保留013、所有对象、原记录、预留与unknown；不回到仅首本版本。新核对路由失败可关闭该入口，已有上传/读取继续按原规则。无SQL迁移，无须为本任务重置auth、首本许可或策略。公开文档仍固定白名单，新方案不自动导出。

Sol只读复审补充：请求JSON严格只有{expectedVersion:book_management.version}；reservation旧updated_at必须在服务端SQL明确alias取得，不能混用u.created_at或管理版本。HEAD/GET/HEAD复用objectHeadMatches，除ETag/size外核对customMetadata.sha256及contentType，保证确认后的reader可读。CAS前复核配置和原target tuple，WHERE EXISTS绑定该tuple/descriptor；任何confirmed或CAS未知回读均验证完整registry投影。UI按钮不能依赖uploadReady（写策略关闭仍应能核对原claim），通过initManage闭包的会话/页面epoch保护迟到响应。

返回stateInfo时所有reconcile分支均显式canSubmit:false（该helper对reserved默认true，不能复用默认值）。确认CAS未知时本次请求只回读不自动重发；后续用户再次显式核对必须重读原记录并完整验证，再以旧state+updated_at保证迟到/并发确认最多一次，不承诺跨所有未来点击永久禁止CAS（无新增持久attempt字段）。生产confirmed状态核对可有既有admission计数写，所谓只读是无业务/账本/对象变更。
