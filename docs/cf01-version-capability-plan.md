# CF01 固定版本继承与分步部署设计

日期：2026-10-22。状态：契约设计已由主 Agent 审查通过，`scripts/cf01-version-close.mjs`、专项合成测试和操作说明已完成首版实现，正进行扩展验证及主 Agent 复审；**未调用云管理接口、未创建或部署真实版本**。实施模型为 `gpt-6.1-sol / high`，主 Agent 负责独立 review、验证及真实执行。

## 目标、范围与结论

目标是在固定账号的 `the-shelf-cf01` 上，从远端当前唯一 100% 部署的完整 UUID `U` 创建候选版本 `W`，复制原代码、入口、受支持的版本 metadata 和可写 annotations，只继承四个非 R2 绑定；独立验明 `W` 后，另一步将 `W` 设为 100% 部署。只允许 `.env` 固定账号、`.local/cf01/resources.json` 固定 D1 和固定主 Worker；不接受调用者指定资源、URL、SQL、版本或候选 UUID。

官方契约支持这个路径。它解决 settings PATCH 无法继承具体 UUID 的确定性缺陷，但不提供原子比较交换、请求幂等、未知请求终止、历史执行排空或所有旧版本失效的证明。单 operator 运维窗口、完整字段白名单和独立回读都是执行前提；不能把本设计写成“已经收回绑定”。

历史 settings PATCH 始终保留 `unknown`。新观测只能独立满足其预登记的五项 expected hash，不能把旧请求改判为成功、失败或已终止。六条已落地 storage guard、guard identity digest、SQL003/004、历史收据及私人状态均不在本方案修改范围内。

`cloudWriteFreezeProven`、`drainProven`、`uploadAllowed` 始终为 false；authority 保持 imported。不上传书籍，不调用 AI，不启用 API/auth/私人阅读，不读取 R2 对象或 Workflow 实例，不修改计费。

## 官方契约依据

主依据是官方 OpenAPI 固定 revision `d3e86eec17211653ca9bc18c0d4bfcace2904148`（commit 时间 `2026-10-21T22:20:02Z`），已保存于 `/tmp/shelf-cf01-openapi-pinned.yaml`。SDK 只作交叉佐证，不能用较旧或未限定 endpoint 的注释扩大 OpenAPI 的支持范围。

| 事项              | 可证事实及边界                                                                                                                                                                              | 官方来源                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 固定 UUID 继承    | `inherit.version_id` 允许具体 UUID；仅 `/workers/workers/{worker_id}/versions` 端点族支持。其他 upload/settings 端点只接受 latest；latest 可能是未部署版本，本方案禁止使用。                | [inherit schema L513207](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L513207)                                                                                                                                         |
| 创建候选          | `POST /workers/workers/{worker_id}/versions` 是 application/json；`deploy=true` 会同时创建 100% 流量部署。本方案显式 `deploy=false`。                                                       | [create L241281](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L241281)                                                                                                                                                 |
| 具体版本回读      | 完整具体 UUID，`include=modules` 返回模块内容；模块由 name/content_type/content_base64 构成，main_module 指向模块名。                                                                       | [version GET L241354](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L241354)、[Version schema L511971](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L511971)    |
| 当前部署          | deployments GET 明确首项是正在服务流量的最新部署；必须恰有一个具体 UUID、percentage=100。                                                                                                   | [deployments L237774](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L237774)                                                                                                                                            |
| 分步部署          | POST deployments 的 JSON `strategy=percentage`、versions 各比例和为 100。`force=true` 绕过保护；本方案显式 false。                                                                          | [deploy POST L237859](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L237859)、[deployment schema L513948](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L513948) |
| Worker 与版本配置 | Version 不包含 logpush/observability/tags/tail_consumers/subdomain；这些在 Worker schema。不得把完整 Worker 对象作为 version body。Worker PUT 会重置遗漏字段，本方案禁止 Worker PUT/PATCH。 | [Worker schema L512233](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L512233)                                                                                                                                          |
| settings 观测     | GET 返回 script/version settings；没有明确说明其一定对应“当前部署”还是“最新上传”。必须用 deployments → 具体 version 交叉确认，不能仅凭 settings 证明流量版本。                              | [settings GET L238597](https://github.com/cloudflare/api-schemas/blob/d3e86eec17211653ca9bc18c0d4bfcace2904148/openapi.yaml#L238597)                                                                                                                                           |
| 未知及竞争        | 上述两个 POST 未声明幂等键、If-Match/expected deployment、CAS 或请求状态查询；不能自行构造这些保证。                                                                                        | 上述两个 POST 的完整 parameters/requestBody                                                                                                                                                                                                                                    |

交叉读取了官方 [SDK versions.ts](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts)：create 将 account_id/deploy 分别放 path/query，其余作为 JSON body；`VersionCreateParams` 不含 readonly 的 id/number/urls/created_on。官方 [SDK deployments.ts](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/scripts/deployments.ts) 同样将 force 放 query，并有具体 deployment GET。当前 SDK 命名空间仍称 beta，固定 OpenAPI 则将该 endpoint 标为 generally-available；以实际 HTTP 契约为准。

## 为什么先创建、后部署

`deploy=true` 可将创建与 100% 部署放进一个请求，少一个独立写 unknown 点，但新绑定继承、模块或 metadata 只要出现平台差异，就会在候选独立验明之前承接流量。选择 `deploy=false` → GET 具体 `W` → 另一步部署，允许发现任何差异时停在未部署候选状态。

代价是两个独立写状态机、一个可能永久停留的未部署版本，以及更多有界只读验证。create 成功不自动调用 deploy；用户参数不能跳过候选验证。既不删除未部署候选，也不回滚到保留 R2 的旧版本。

## 精确请求及字段映射

基础路径恒为 `https://api.cloudflare.com/client/v4/accounts/{固定账号}`。`U` 只能来自两次相同的当前部署观察；`W` 只能来自本次 create 响应中已持久化的完整 UUID。任何 endpoint 都不使用 latest 或 UUID 前缀。

创建请求形状如下，尖括号表示经白名单校验后来自 `U` 的值，不是 CLI 输入；按源字段是否存在有条件复制，不能把尖括号、undefined 或默认猜测实际发送。

```http
POST /accounts/{account}/workers/workers/the-shelf-cf01/versions?deploy=false
Content-Type: application/json
```

```json
{
  "annotations": {
    "workers/message": "<原值，如存在>",
    "workers/tag": "<原值，如存在>"
  },
  "bindings": [
    { "name": "CF_DB", "type": "inherit", "version_id": "<U>" },
    { "name": "CF_MOCK", "type": "inherit", "version_id": "<U>" },
    { "name": "CF_PROBE_TOKEN", "type": "inherit", "version_id": "<U>" },
    { "name": "CF_WORKFLOW", "type": "inherit", "version_id": "<U>" }
  ],
  "main_module": "<原 main_module>",
  "modules": [
    {
      "name": "<原名>",
      "content_type": "<原类型>",
      "content_base64": "<原字节的规范base64>"
    }
  ],
  "compatibility_date": "<原值，如存在>",
  "compatibility_flags": ["<原值，如存在>"],
  "limits": { "cpu_ms": 50 },
  "usage_model": "<原值，如存在>"
}
```

上例 limits=50 仅展示 JSON 形状，实际必须精确复制源值且保持字段存在性，绝不硬编码该数值。下面白名单是完整实施边界；不把示例的可选字段无条件注入 body。

| 源字段/能力                                                                      | body 与独立比较规则                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 四个保留绑定                                                                     | 源必须精确匹配 CF_DB 固定 D1、CF_MOCK 固定 mock/production 且无 entrypoint、CF_WORKFLOW 固定 Workflow/class/script、CF_PROBE_TOKEN secret_text。只有这四个 inherit 项；无 old_name，无 CF_BUCKET，无其他绑定。候选回读必须是四个实际绑定，不能仍为 inherit 描述。 |
| Secret                                                                           | 由同一具体 `U` 的 inherit 保留；不读取/重设 secret 值，不以名称观察声称已证明 secret 明文字节相同。值保留依据是固定版本的继承契约；回读只证明 secret_text 名称/类型。意外返回 text 立即从安全投影中去除，不能写 receipt/stdout。                                  |
| modules/main_module                                                              | 无重新构建、压缩、转码、文件名修复或模块过滤；复制所有模块，包括 sourcemap。拒绝重复名、不规范 base64、缺入口及超出既有模块/名称/类型/响应上限。独立比较精确名称、类型、字节数、解码字节 hash、main_module；模块名不作为本机路径。                                |
| annotations                                                                      | 只复制 workers/message、workers/tag，原样保持缺失/空串/字节内容；分别按 1000/100 UTF-8 字节门槛预检，防服务器截断。不新增 run tag。不复制 readonly workers/triggered_by。未知 annotation key 阻断。候选和最终 settings 的可写 annotation hash 必须一致。          |
| compatibility_date、compatibility_flags、limits(cpu_ms/subrequests)、usage_model | typed 白名单精确复制源字段，包括缺失状态；不补默认值。settings 与具体版本存在相同字段时须一致。未知子字段/null 形状阻断，不通过“删掉未知项”继续。                                                                                                                 |
| placement                                                                        | 仅支持源字段缺失，或固定 schema 的 `{mode:"smart"}`。其余 region/host/target 等不泛化支持；遇到即停，另立评审。                                                                                                                                                   |
| cache_options                                                                    | 源缺失则省略；或仅精确支持 `enabled:false`、可选 boolean cross_version_cache。enabled=true 会按契约产生额外 zone 资源，不在本任务范围，阻断。                                                                                                                     |
| package_dependencies                                                             | 只支持缺失或空数组；非空即阻断，不重装包、不假定其仅为无影响注释。                                                                                                                                                                                                |
| assets、containers、exports、migrations、migration_tag、exports_reconciliation   | 第一版遇到字段存在即阻断，包含空值/空集合；绝不复制、推导或重新提交。exports 的 GET 会省略 tombstoned 生命周期项，不能保证任意读写 roundtrip；migrations 在部署时应用，不能重放。                                                                                 |
| Workflow                                                                         | 只继承既有 binding 并复制原 Cf01Workflow 模块。不调用 Workflow create/update、instances、迁移或 exports reconciliation；不根据本机源码重新生成 Workflow 配置。若原版本另含上述 lifecycle 字段，停在候选创建之前。                                                 |
| Worker metadata                                                                  | logpush、observability、tags、tail_consumers 不进入 version body。通过固定 settings GET 对完整非绑定/非 annotation metadata 取旧算法 hash，前后严格相同；不写 Worker/settings endpoint。缺失字段不推断默认值。                                                    |
| subdomain                                                                        | 固定 `/workers/scripts/the-shelf-cf01/subdomain` 只读，enabled 与 previews_enabled 必须均 false，前后 hash 相同。新版本 urls 字段只读且可能存在，不等于入口已启用。                                                                                               |
| readonly 数据                                                                    | id/number/urls/created_on/author_email/author_id/source/startup_time_ms 等不进入请求；作者、URL、annotation 文本不落收据。新 id/时间/number 变化是版本创建事实，不算保留原始版本身份。未知源顶层字段须分类失败，不能默认视为 readonly。                           |

不调用新 Worker detail GET：它无字段投影参数且含 references，可能带入无关依赖资源元数据；settings + 固定 subdomain 足以覆盖既有五 hash 的观测范围。settings schema 未覆盖的任意 Worker 字段，不能声称由本方案逐字节验证过。版本与 Worker 字段在契约中分离，加上不调用 Worker 写端点，支持“未请求改写 Worker 设置”；最终精确保留仍以实际独立回读为验收。

部署请求为：

```http
POST /accounts/{account}/workers/scripts/the-shelf-cf01/deployments?force=false
Content-Type: application/json
```

```json
{
  "strategy": "percentage",
  "versions": [{ "version_id": "<W>", "percentage": 100 }]
}
```

原部署若有可写 `annotations["workers/message"]`，按原值复制该字段；部署 annotation 与版本 annotation 分别校验，不混用。部署 readonly triggered_by/id/source/author/created_on 不复制。返回完整 deployment UUID `D1` 后固定 GET `/workers/scripts/the-shelf-cf01/deployments/{D1}`，再读列表首项证实当前为 `D1/W/100%`。

## 旧五 hash 与新验证的关系

旧收据的 bindingsSha256、metadataSha256、annotationsSha256、codeSha256、subdomainSha256 使用现有 close 算法原样计算；不能重写原 expected、排序重算其 JSON 对象或改变旧算法以让新观察通过。另加新版本 typed metadata 比较，不能用它替换旧 hash。

create 前，构造“移除 CF_BUCKET 后”的源观测，必须已经等于历史 unknown 的五个 expected hash。源代码/metadata/annotations/入口发生变化便停止；不为“最新远端状态”重登记一个覆盖旧 expected 的目标。

create 后的 settings 可能对应旧上传或新上传，官方契约对此不够明确：它的完整非绑定 metadata 和可写 annotation 必须仍等于目标；bindings 只允许精确等于已验证源五项或候选四项。此时不标记当前流量已无 R2。当前流量版本仍以部署首项 UUID → 具体版本 GET 为准。

deploy 后必须同时满足当前部署 `W/100%`、具体 `W` 四绑定无 R2、settings 四绑定无 R2、五 hash 与原 expected 全部相同、两个入口仍 false、六 guard 原样和固定 counts 安全。独立新 status 再证实；原 close status 也可在自己的新收据中形成五 hash observation，但不重写旧 unknown。这只证明当前观察的能力收回，不证明两个未知请求的终止或在途排空。

## 状态机、未知恢复与锁

建议独立新工具 `scripts/cf01-version-close.mjs`，只含 `create / deploy / status`；默认 preview 在读取文件/时钟/网络之前返回合成计划。新状态/收据使用 `.local/cf01/version-close-state.json` 和固定新 receipt 前缀；只读 pin 旧状态/收据，不修改它们。新工具与既有 close 共用 `.local/cf01/storage-close.lock` 的排他锁和 inode/目录复核，防止两个本机 operator 同时写；status 也拿该锁。崩溃遗留锁不自动删除。

每个请求前先将固定目标、label、method、安全 body hash、预期 hash、最大请求预算和 dispatched intent fsync 到私有状态/收据；写 intent 成功后才发 HTTP。所有目录 0700、文件 0600、禁止符号链接/硬链接，pin 输入与父目录，每请求前检查。receipt 从不保存原模块/base64、secret、原 annotation、作者、provider 原始 error 或任意字符串；只保留固定资源身份、完整版本/部署 UUID、hash、数值及已知枚举。

实现复用旧 close 新增的冻结 `CF01_CLOSE_INTERNALS` 导出，不移动旧实现，不改变旧 run/guard/schema/hash。`privateStore.read` 仅新增可选第三参 max，默认仍 2MB，参数只能为1..2MB安全整数并在实际打开/读取时约束；历史检查器可固定1MB，不放宽原工具。新 operator 对 legacy 全部 writes/failures逐条验证，并将旧receipt的schema/kind/action/runID/identity、唯一固定PATCH的label/path/method/index/at/state严格链接；畸形旧D1写不能被filter隐去。两次state/receipt rename不是原子提交，因此deploy必须再验证完整成功create receipt、同run/identity/expectedhash、18个observed请求和对应mutation body/response ID hash，不能仅靠state中的verified解锁。

| 事件                                                   | 允许后续                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create 响应成功、W 已持久化且独立 GET 完全匹配         | 记 candidate_verified；仍不自动部署。新 deploy 动作必须重新完整预检 U 和 W。                                                                                                                      |
| create 超时/断线/非预期状态/矛盾 envelope/本机落盘失败 | 保留 dispatched/unknown，不重试 create；包括 HTTP400 也不推断已终止。无后续云写。                                                                                                                 |
| create unknown，但 W 在崩溃前已可靠持久化              | status 可固定 GET W 验证独立存在性与候选内容；第一版仍不解锁 deploy，未知创建保持阻断。需要另行评审终态规则，不能在状态机里偷偷把观察存在当作原请求终态。                                         |
| create unknown，W 完全丢失                             | 永久阻断 deploy。无 run tag、幂等键或请求查询；不能按时间/版本号/hash/唯一 list 结果猜认本次候选，不上传第二个候选。第一版完全不调用 versions list。                                              |
| deploy 成功且独立回读通过                              | 新 receipt 记 capability_observed；另一次新 status 复核。保留所有原 unknown。                                                                                                                     |
| deploy unknown，W 已知                                 | 停写。新 status 可证明此刻当前部署恰为 W/100% 且无 R2/五 hash 相同，形成独立 capability observation；不把原部署请求改判成功/失败，不重发 deploy，不自动 rollback。若仍为 U 或其他版本，保持阻断。 |
| 漂移/多版本渐进部署/任何字段不支持/超预算              | 停止；保存安全失败，不修复、不选择“最像”的版本、不扩充资源范围。                                                                                                                                  |

本机锁不能约束 Dashboard、另一个工作区、持有凭证的其他用户、直接 Wrangler 或其他脚本。真实执行窗口必须由主 Agent 核对项目 CI 自动部署关闭、没有计划内其他 CF01 写动作、固定本机配置 R2 已关闭、同一 operator 串行执行；已有旧 unknown 不据此变成已终止。两次部署预读及写后再读只能发现观测到的漂移，不能保证排除预读与 dispatch 之间的外部并发，也不能保证原子不覆盖。记录这是可信运维前提和 API 限制，不使用一个自填 boolean 冒充远端锁/CAS/排空证据。

## 固定请求矩阵与硬预算

下表每个动作独立新 run ID；D1 query 虽用 HTTP POST，但只执行现有固定 identity/schema/counts SELECT，计入只读请求，不含 DDL/探针。所有请求包括 fetch 和 body 共用最多 30 秒 deadline，response 最大 2,000,000 字节、chunk 最大 10,000；payload 同样上限 2,000,000 字节。重定向、SDK 自动分页/自动重试、写重发均禁止。任何请求失败立即终止，不消耗剩余预算。候选 GET 没有 modules 或响应过大即失败，不能现场放宽上限。

### create：最多 18 HTTP，其中 17 只读、1 version POST

| 序号  | 固定请求/检查                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| 1–3   | 固定 D1 identity、schema 六 guard、counts；每项单请求。                                                      |
| 4–7   | deployments?page=1&per_page=1 → D0/U；settings；subdomain；具体 U?include=modules。                          |
| 8–10  | 再读 deployments、settings、subdomain；源必须相同，五 expected 目标预校验，字段白名单及 payload 大小已验明。 |
| 11    | 唯一 POST versions?deploy=false。                                                                            |
| 12    | 具体 W?include=modules，严格验明四继承结果、原代码/入口/全部支持 metadata/annotations。                      |
| 13–15 | deployments 仍 D0/U；settings metadata/annotation 相同且 bindings 仅源/候选已知两种；subdomain 仍关闭。      |
| 16–18 | schema、counts、deployments 再读；不得出现漂移。                                                             |

### deploy：最多 20 HTTP，其中 19 只读、1 deployment POST

| 序号  | 固定请求/检查                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| 1–3   | 固定 D1 identity、六 guard schema、counts。                                                                               |
| 4–8   | 当前 deployments 必须仍 D0/U；settings；subdomain；具体 U modules；具体 W modules。与 create 收据及旧 expected 严格一致。 |
| 9–11  | deployments、settings、subdomain 再读；检查 operator 窗口、本机 pinned 输入及私有 durable intent。                        |
| 12    | 唯一 POST deployments?force=false，只设 W/100%。                                                                          |
| 13–17 | 具体 D1 GET；当前 deployments 首项 D1/W/100%；具体 W modules；settings 必须四绑定无 R2且五 hash 匹配；subdomain 关闭。    |
| 18–20 | 六 guard schema、counts、当前 deployments 再读，目标不变。                                                                |

### status：最多 14 HTTP，0 云写

1–7：D1 identity、schema、counts、当前 deployments、settings、subdomain、当前具体版本 modules。8：若已有候选 UUID 且不同于当前版本，GET 具体候选 modules；否则跳过且不补别的请求。9–14：第二轮 schema、counts、deployments、settings、subdomain、当前具体版本 modules。两轮当前部署/五 hash/guard/counts须一致。未知 create 没候选 UUID 时，不查询版本列表，不恢复写能力；status 可记录旧当前版本仍有 R2的安全阻断结果。

每动作按硬计数器和固定 label 顺序限制，版本 POST<=1、deployment POST<=1，但某动作另一类写预算恒为 0；总调用没有“用剩余次数试另一接口”的权限。状态累计有界并拒绝任意旧 intent，history 不自动截断/清除。32 等较大通用上限不能代替上面每动作精确上限。

## 最小实施与验收

1. 新独立工具、专项合成测试、操作说明；不改现有 close PATCH=0 门禁，不改变六 guard/BASE_SCHEMA/hash、SQL003/004、export-docs 固定公开白名单。必要复用只读 helper 时先保证旧算法/旧工具行为逐字等价；宁可独立严格验证，不借重构更改历史证据解释。
2. 覆盖默认零 IO；固定身份/共享锁/目录文件替换；每请求 fsync 先于 dispatch；四具体 UUID inherit且从不发送 secret；多模块/入口/字节；metadata/annotations缺失与截断；lifecycle 字段拒绝；settings不能冒充当前版本；无 CAS 漂移检测；create/deploy 所有 unknown落点不重试；候选UUID丢失阻断；原unknown与五hash不变；14/18/20请求上限、超时/响应上限/重定向/矛盾 envelope以及秘密哨兵不落盘。
3. 主 Agent 独立 review，运行专项、完整 Node/Python、disabled 构建、public/static 与真实凭证扫描。检查旧 guard 源/identity 与已落地证据完全不变，新文件不进入公开文档导出。
4. 本地验收后 commit → push → 既有 CI，分别核验静态部署状态。主 Agent 再制定真实 create 的固定有界 run 计划；验明候选后另行制定 deploy 计划。达到既有授权和计划门槛自动执行，不重复请求同一资源授权；没有通过本设计审查之前不新增云写路径。
5. 最终交付区分源码/离线验证、远端 CI、真实 candidate、真实 deployment 与独立 status。无实际回读不得写“R2已收回”；有回读仍不得写 drain/ready/上传完成。

失败回退只回退新工具代码。云端保留原 guard、unknown、预算墓碑、未部署候选及收据；不删除候选、不清状态、不恢复 R2绑定、不部署旧版本、不启动旧入口。资源用量、新鲜度、在途执行、routes/进程连接闭包仍由独立证据链处理。
