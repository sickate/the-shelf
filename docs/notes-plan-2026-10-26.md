# 笔记摘要（2026-10-26）

状态：2026-10-26 已上线并在生产验证。

用户需求：在阅读时选中一段文字，可以直接摘录，或添加笔记/评论；全部摘录与笔记在同一处浏览并导出。

## 决定（默认值，用户可改）

- **仅所有者可见**：与阅读/下载权限一致，访客看不到任何摘录或笔记。
- 一条记录 = 选中文字（摘录）+ 可选笔记正文（“笔记/评论”同一字段）+ 颜色标记 + 位置。无笔记即“摘录”。
- 支持格式：EPUB、MOBI/AZW3、TXT/MD（重排格式，直接选中）；PDF 需新增 pdf.js 文本层才能选中，按“页码 + 原文”定位。扫描版 PDF 无文本层，不支持。
- 导出：Markdown（按书分组，含位置与时间）、CSV、JSON。

## 数据（迁移 `0005_notes.sql`）

```sql
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,                 -- n_<random>
  book_id TEXT NOT NULL REFERENCES books(id),
  quote TEXT NOT NULL,                 -- 选中原文，≤ 4,000 字
  note TEXT,                           -- 笔记/评论，≤ 10,000 字，可空
  color TEXT NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow','green','blue','pink')),
  locator TEXT NOT NULL,               -- JSON：{type:'cfi',cfi} | {type:'pdf',page,start?,end?} | {type:'text',start,end}；≤ 2,000 字节
  label TEXT,                          -- 人读位置：章节名 / “第 12 页”
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_book ON notes (book_id, deleted_at, created_at);
```

## 接口（全部 `requireOwner`，写操作沿用 Origin/CSRF 校验）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/notes?book=<id>&q=&limit=&before=` | 列表（不传 book = 全部），按创建时间倒序，带书名 |
| POST | `/api/books/:id/notes` | `{quote, note?, color?, locator, label?}`，书须存在且未删除 |
| PATCH | `/api/notes/:id` | `{note?, color?}` |
| DELETE | `/api/notes/:id` | 软删除 |
| GET | `/api/notes/export?format=md\|csv\|json[&book=]` | `Content-Disposition: attachment`，CSV 带 BOM、防公式注入（`=+-@` 开头加 `'`） |

服务端校验长度、颜色枚举、locator 结构与大小；超限 400 并给出原因。

## 界面

- **阅读页**（N2）：选中文字后浮出小工具条 “摘录 / 写笔记 / 颜色”；写笔记弹出文本框。已保存的摘录在 EPUB/MOBI/TXT 中高亮显示，PDF 在文本层上高亮；点击高亮可编辑/删除。工具栏“笔记”按钮打开本书笔记侧栏，点击条目跳转。
- **笔记页 `notes.html`**（N1）：所有者的全部摘录与笔记，按书分组或按时间；搜索（原文与笔记）、按书筛选；每条可编辑笔记/删除、“在书中打开”（`read.html?id=..&note=<id>` 跳到位置）；导出按钮（Markdown/CSV/JSON，按当前筛选）。书架页与详情页头部加“笔记”入口；详情页显示本书笔记数与链接。

## 分工

| # | 任务 | 模型 | 依赖 |
| --- | --- | --- | --- |
| N1 | 迁移、Worker 接口与校验、导出、`notes.html` 页面与入口、测试 | Opus 5.5（鉴权、数据迁移） | 无 |
| N2 | 阅读页选中/高亮/侧栏/跳转（EPUB、MOBI、TXT、PDF 文本层） | Opus 5.5 | N1 接口、R1（阅读设置，同改 `read.ts`）合并后 |

## 验收

- 测试：接口鉴权（访客 401）、校验、软删除、导出三种格式（CSV 注入防护）。
- 生产 headless：EPUB/MOBI/TXT/PDF 各选中一段保存 → 高亮出现 → 刷新仍在 → 笔记页可见、搜索、跳回原位、导出文件内容正确。
- 回退：重新部署上一 Worker 版本；表保留无害。
