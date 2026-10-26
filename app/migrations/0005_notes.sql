-- 2026-10-26 notes / highlights (docs/notes-plan-2026-10-26.md). Additive and idempotent.
-- Owner-only: a row is a selected quote, an optional note text, a colour and a JSON locator.
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
