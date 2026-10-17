# 私有对象同步与共享预算（离线参考实现）

`storage-authority.mjs` / `.sql` 提供本机 SQLite 预算账本，`object-sync.mjs` 提供可恢复的单对象同步协议。原书与正文、check 与 production 必须使用**同一个数据库实例与身份**，在 `BEGIN IMMEDIATE` 事务中争用余额。这是后续云迁移的可验证基础；目前没有 Cloudflare 客户端、生产适配器、CLI、自动上传或新环境配置，现有原书上传入口尚未切换。

本文件不在网站文档发布清单内。不要把真实身份、迁移快照、对象登记、正文或数据库复制到公开目录或日志。

## 预算和对象契约

- 总预算固定为 `8_000_000_000` bytes；每个原书或完整正文 JSON 包须为 `1..20_000_000` bytes。
- 新增预留按 `账号观测存储 + 已确认字节 + 未确认预留 + 本次新增字节` 检查。观测与账本可能重叠，当前不扣减猜测的重叠量，宁可保守计数。
- 账号证据复用 `scripts/cf-library-data.mjs` 的 `accountEvidence` 契约：完整、固定账号、Standard/Free、当月操作数及五分钟内观测。此实现进一步拒绝未来时间；不接受同一时刻不同证据或观测时间回退。进入 PUT 前再次检查时间和月份。付费意向不自动生成合格证据，付费套餐的证据适配尚未实现。
- 身份包含 `schemaVersion=1`、`authorityId`、`accountId`、固定桶 `the-shelf-books`，以及不同的 `legacyDatabases.check` / `.production` 标识；重新打开时须完全匹配。
- descriptor 固定字段为 `kind, scope, fileId, bookId, format, sizeBytes, sha256, objectKey, versionHash, source`。不接收路径或额外字段。`sha256` 始终是实际对象完整字节的 SHA-256，不能以 ETag 代替。
- 原书 `kind=original`，`source` 和 `versionHash` 为 null；key 延续 `books/cf03/<fileId>/<sha256>.<format>` 或 `cf03-check/<fileId>/<sha256>.<format>`。一个作用域内同文件仅有一个原书登记；原书替换不是此阶段功能。
- 正文 `kind=prepared-text, format=JSON`，key 为 `prepared-text/v1/<scope>/<fileId>/<versionHash>/<sha256>.json`；`source` 使用正文版本选择的七字段描述。真实 bytes 必须通过 `shared/prepared-text.mjs` 的完整严格校验。同一文件的不同正文版本独立登记并分别占用存储。

`prepareObject` 根据受限字节计算 descriptor；`validateObjectBytes` 再验证 descriptor 与实际字节，正文同时核对来源、版本、locator 和内容 hash。输入在第一次 await 前复制；校验和上传使用已固定的数据。

## 生命周期与恢复

新数据库先处于 `migration_required`，完成显式迁移投影验证后才可预留。

| 状态        | 含义与恢复                                                            |
| ----------- | --------------------------------------------------------------------- |
| `reserved`  | 已占用全部字节，尚未持久记录 PUT 尝试；使用新鲜证据可继续             |
| `uploading` | 事务 CAS 已持久记录唯一 PUT 资格；即使尚未发送就崩溃，也不再 PUT      |
| `uncertain` | PUT 或确认结果不确定；全部字节继续预留，只做核对                      |
| `confirmed` | HEAD→GET 实际 hash→HEAD 验证通过，事务内将预留转为已确认并写 registry |

`syncObject` 先校验字节、预留，再检查 key 是否已有对象。已有对象只验证，不覆盖；不存在时须先 `claimPut`，然后以 `ifNoneMatch: "*"` 发送一次 PUT。响应丢失、异常或重启不能触发自动重传。相同 reservation 与相同 descriptor 重入幂等，改 id、逻辑对象或 descriptor 则冲突。

`reconcile` 不上传：首次 HEAD 核对大小、实际 SHA-256 元数据、MIME 与 ETag；GET 使用 `ifMatch` 并受大小限制，读取完整流后验证真实内容；再次 HEAD 须保持同一对象身份。缺失、截断、超限、元数据不符、hash 不符或对象变动都不会释放额度或启用登记。ETag 仅用于稳定身份，不用作内容 hash。

没有 TTL 自动释放、删除 reservation、自动删除对象或自动清理 uncertain 的入口。尚未尝试 PUT 的对象遇到读取错误时可继续保持 `reserved`；已持久声明 PUT 的对象进入 `uncertain` 后仅允许验证恢复。确认和登记失败会整笔回滚。

## 冻结迁移投影

`migrateFrozen` 只接受 check 和 production 各一份显式完整投影，不能把不存在或不可读的旧库当作空库。每份包括：固定数据库/账号/桶、停写声明及 freeze ID/时间、完整计数、账本总量、原书 reservations、registry 和覆盖全部规范字段的 SHA-256。

确认项需要内容验证声明及对应 registry；disabled 项仍占已确认字节。未完成预留全部导入为 `uncertain`，保留额度并禁止再 PUT；aborted 项只有带明确缺失验证声明才可排除。重复逻辑对象、账本和行数不符、未知状态、缺失登记及冲突导入均拒绝。首次导入在同一事务内回读 reservations、sources、registry 和 receipt，失败不留下部分迁移。

相同快照重入返回原 receipt，不覆盖已有状态。receipt 的 `cloudWriteFreezeProven: false` 明确表示：调用方的合成/离线停写声明**不是远端停写证明**。本模块不读取旧 D1，也不证明账号只有一个 authority；生产切换仍须冻结全部旧写入口、固定唯一权威实例并独立核验真实快照与回读，不能让各旧库继续分别分配共享余额。

## 模块接口与文件边界

主要接口：

```js
import { StorageAuthority, prepareObject } from "./storage-authority.mjs";
import { syncObject } from "./object-sync.mjs";

// 所有参数由受控的未来适配层提供；此处没有默认私人目录或隐式发现。
const authority = new StorageAuthority({ filename, privateRoot, identity });
try {
  authority.migrateFrozen(identity, [checkSnapshot, productionSnapshot]);
  const object = await prepareObject(objectInput);
  const result = await syncObject({
    authority,
    identity,
    reservationId,
    descriptor: object.descriptor,
    bytes: object.bytes,
    evidence,
    store,
  });
} finally {
  authority.close();
}
```

模块另提供 `inspect`、`get`、`registry`、`reserve`、`claimPut`、`markUncertain` 和 `reconcile`。只有完整对象验证流程可调用内部确认事务；不公开直接跳过校验的 confirm 方法。返回 descriptor 和迁移数据属于私人运维信息，不可直接用作公开 API。

`privateRoot` 必须已存在且为 `0700`；目标 DB 必须在其内，祖先不能为符号链接，根目录下的中间目录同样须为 `0700`。数据库及已有 `-journal/-wal/-shm` 必须是 `0600` 的普通、单链接文件；不替用户修正旧权限。SQLite 打开前检查路径，受信任的私人目录由当前用户独占；本模块不提供对恶意同 UID 进程并发更换路径的隔离保证。

`store` 是可信 I/O 适配器，精确包含 `target={accountId,bucket}` 与 `head/get/put` 方法，绑定固定账号/桶后使用；GET 必须返回 `ReadableStream<Uint8Array>`。适配器负责真实服务鉴权、请求 deadline、取消、条件请求和目标约束，不能隐式重试 PUT。当前模块限制字节数与流块数，没有真实网络的 deadline/abort 客户端；接入前须独立实现并验证这些边界。闭包中的外部配置属于适配器信任边界，不能靠复制 `target` 自动证明实际远端目标。

## 验证与后续接入

```sh
node --test tests/storage-authority.test.mjs
```

测试只使用临时合成文件、真实 SQLite 和内存对象存储，验证预算、迁移回读、崩溃恢复、内容校验和并发；真实 Cloudflare、R2 与 AI 均未访问。后续接入顺序为：唯一远端 authority 设计及真实旧入口停写 → D1/远端适配和身份绑定 → 新鲜资源证据 → 单对象生产安全验收。此离线实现不代表正文已经上传、云端索引可用或生产业务 API 上线。
