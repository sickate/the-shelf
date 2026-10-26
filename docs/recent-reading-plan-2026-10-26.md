# 最近阅读（2026-10-26）

用户需求：增加“最近阅读”，按最近打开时间倒序列出看过的书，首页默认显示。

## 决定

- 记录在服务端（D1），跨设备一致；仅所有者可见（阅读本身只对所有者开放）。访客首页不显示该区块。
- “打开”= 所有者在阅读页成功加载一本书（`read.html` 加载完成后上报一次）；同一本书只保留最近一次时间和打开次数。
- 进度：阅读页已有本地页码/位置；上报时附带可选的人读进度（如“第 12 / 300 页”“约 35%”），≤ 40 字，仅用于展示。

## 数据（迁移 `0006_reading.sql`）

```sql
CREATE TABLE IF NOT EXISTS reading_history (
  book_id TEXT PRIMARY KEY REFERENCES books(id),
  last_opened_at TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 1,
  progress TEXT
);
CREATE INDEX IF NOT EXISTS reading_recent ON reading_history (last_opened_at);
```

## 接口（所有者；写操作沿用 Origin 校验）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/books/:id/opened` | `{progress?}`，upsert：时间=now，次数+1；书须存在、未删除、`status='uploaded'` |
| PUT | `/api/books/:id/progress` | `{progress}`，只更新进度（阅读中翻页节流上报，≥ 30 秒一次） |
| GET | `/api/recent?limit=` | 默认 20、最多 100；按 `last_opened_at` 倒序；含书目基本字段（同列表）、`lastOpenedAt`、`openCount`、`progress`；已删除/非上传状态的书排除 |
| DELETE | `/api/recent/:bookId` | 从最近阅读中移除一条 |

## 界面

- 首页（所有者）：统计区下方、书架之前显示“最近阅读 / RECENT”区块，默认展开；横向卡片（封面缩略图、书名、相对时间“3 小时前”、进度），最多 12 本，“查看全部”展开为完整列表（最多 100）。每张卡片“继续阅读”直接进 `read.html`，小 × 移除。没有记录时显示一句引导文字。区块可折叠，折叠状态记在 localStorage。
- 阅读页：加载成功后 `POST opened`；翻页时节流 `PUT progress`。改动集中在一个小模块（`lib/recent.ts`），`read.ts` 只加挂钩。

## 分工

| # | 任务 | 模型 |
| --- | --- | --- |
| RR1 | 迁移、Worker 接口、测试、首页区块、阅读页上报 | Opus 5.5（数据迁移、鉴权） |

## 验收

- 测试：访客 401、校验、upsert 计数、排序、删除/非上传排除。
- 生产：打开 3 本书后首页顺序正确、刷新保留、移除生效；手机宽度正常。
