# 固定 production 鉴权生命周期

本工具只操作 `the-shelf` 的 production D1 鉴权行和现有触发器撤销的会话，不部署 Worker、不迁移 schema、不上传对象、不改预算 authority 或计费。说明不加入公开文档白名单。

```sh
node scripts/cf-production-auth.mjs
node scripts/cf-production-auth.mjs status --execute --run-id auth-status-001
node scripts/cf-production-auth.mjs initialize-disabled --execute --run-id auth-init-001
node scripts/cf-production-auth.mjs close --execute --run-id auth-close-001 --expected-generation 1 --expected-row-sha256 <status中的rowSha256>
node scripts/cf-production-auth.mjs enable --execute --run-id auth-enable-001 --expected-generation 2 --expected-row-sha256 <status中的rowSha256> --expected-version <主Agent已独立验收的版本UUID>
node --test tests/cf-production-auth.test.mjs
```

默认 preview 在读取文件、时钟、配置、环境内容和网络前返回零请求。只有 `--execute` 才读取固定项目上下文；CLI 不接受任意账号、D1、Worker、origin、SQL、路径或凭证参数。执行拒绝 CI。真实动作须由主 Agent 在代码 review、适用验证和发布后另记有界执行计划；本工具实现不代表生产鉴权已初始化或开启。

## 固定身份与前置

账号来自0600 `.env` 的 `SHELF_R2_ACCOUNT_ID`，所有已设置账号经既有 `selectCredentials` 一致性校验；production D1 ID来自0600 `.local/cf03/deploy.json`，名称固定 `the-shelf-library`。Worker固定 `the-shelf`，origin固定 `https://the-shelf.iamzhutuo.workers.dev`；check D1永不请求。

仅读取既有 `.local/cf03/production/owner-access-key`、`owner-key-pepper`、`session-secret`，文件须为0600普通单链接、规范32字节base64url，三值互异。通过既有 `createOwnerVerifier` 和固定scope/origin派生 verifier，不创建、重设、打印或持久化密钥/verifier，也不执行旧 `auth-init.sql`。SQL和参数只在请求内存中存在，不进入收据。

远端先读取固定D1 identity，再用单条只读SQL投影 `auth_config` / `sessions` 两张表、挂在这两张表上的全部trigger定义，以及安全auth状态。表和trigger与仓库 `cloudflare/library/schema.sql` 在本机临时SQLite解析所得的同一投影精确比较；额外、缺失或改变的trigger拒绝。SQLite索引不在该投影内，自动索引的 `sql=null` 不被误当作未知trigger。安全auth投影只返回scope/origin/scheme/generation/enabled/updated_at、`verifier=?`的匹配布尔值与该scope全部 `revoked=0` 会话数，不取会话hash、正文或verifier值。

`status` 的 `auth.rowSha256`仅覆盖六个非秘密行字段。`enable`/`close`显式要求该hash和generation；CAS还约束origin、scheme、本机派生verifier及原updated_at。对方换密钥但安全字段不变时仍拒绝。

## 动作与SQL效果

| 动作                | 行为                                                                           | HTTP硬上限 / 当前正常路径 |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------- |
| status              | identity与schema/auth只读观察，不改旧unknown                                   | 3 / 2                     |
| initialize-disabled | 仅现有表中无production行时，INSERT generation=1、enabled=0；独立HTTP回读       | 4 / 4                     |
| enable              | 固定Worker前置观察后单次CAS enabled=1；独立auth及Worker回读                    | 12 / 11                   |
| close               | 单次CAS enabled=0、generation=generation+1；独立HTTP确认行及全部未撤销会话数=0 | 4 / 4                     |

`close`即使原行已disabled也递增generation。仓库既有 `auth_rotation` AFTER UPDATE trigger在同一D1语句事务内将该scope所有未撤销session置 `revoked=1`，包括已过期session；失败整笔回滚。不增加cleanup SQL或删除session。增代使迟到的旧enable不能再匹配原generation。

enable要求显式传入已独立验收的version UUID；工具不把读到的latest自动升级为已批准版本。派发前核对部署列表首项唯一100%版本与该UUID一致、settings业务bindings精确匹配固定D1/桶/vars/四个secret名称/ASSETS、workers.dev入口enabled且preview关闭；CAS前再读部署身份。成功后独立重读auth、部署、settings和入口，要求前后观察相同。secret名称只证明存在，不能证明远端secret值等于本机；真实登录与业务CPU/安全验收仍须单独完成。平台返回不支持的binding/入口结构时拒绝，不能按“看起来相同”归一化。

status、initialize-disabled和close不依赖Worker在线或版本接口，静态部署仍可初始化disabled，Worker故障时仍可关闭。close本身需要存在且身份匹配的auth行；缺表、坏schema或密钥不匹配不会擅自修改。

## 未知、持久化与恢复

每个请求在派发前将有限label/method/sequence写入0700 `.local/cf03/production-auth/` 下0600独占run收据并fsync；无SQL、参数、原始响应或provider错误。mutation还必须先将run/action写入0600 `production-auth-state.json` 的未决清单并fsync。传输失败、异常响应、期限、结果处理或结果落盘失败都不会自动重发；迟到响应不能修改已结束状态。

只有mutation响应校验、独立回读及结果持久化全部成功，才可移除**本次**未决标记。先前unknown永久保留；status只读观察不改判或清标记。历史unknown会阻断enable/initialize-disabled；即使新close成功，旧未决项仍继续阻断重新enable。当前工具没有resolution动作，未来须另行review独立的resolution机制，不能删除历史来解锁。为了保留安全关闭能力，新的close可在新run、显式新鲜generation/row hash下独立执行一次；它不重放旧action，也不抹掉旧unknown。结果不确定后先执行独立status，不重用旧run ID。

初次执行在空收据目录建立state标记；已有收据而state丢失时拒绝，不能当作新开始。未决run即使收据丢失也不能复用或清除其旧unknown。

本机 `.local/cf03/production-auth.lock` 排他覆盖整个操作；原锁或run收据存在即拒绝，不自动删崩溃遗留锁。所有祖先、私有输入、生成文件均固定inode/权限，派发前重新检查；目录置换、symlink、硬链接或文件变化即停止。收据和state通过0600独占临时文件、fsync、rename及父目录fsync写入。单请求30秒覆盖fetch和完整body，最多1MB/100000chunks，拒绝重定向与额外请求，无网络重试。

本机锁和前后观察不能阻止持D1/Worker管理权限者通过Dashboard或另一个工作区并发修改配置；执行窗口须保持可信单operator、禁止并行部署/改schema。CAS防护普通行竞争，但不是跨D1与Worker的事务。CAS后Worker漂移或读回失败保持unknown，不能自动重新enable或自动部署；主Agent应以新status与close关闭。

回退只撤回工具代码，不回滚generation、不重开已关闭鉴权、不删除会话/unknown/收据、不触碰storage authority、旧R2 guard或预算。生产业务启用和云端阅读必须另行真实验收。
