-- 2026-10-26 recent reading (docs/recent-reading-plan-2026-10-26.md). Additive and idempotent.
-- Owner-only: one row per book, the latest successful open in the reader and an optional
-- human-readable progress label (≤ 40 chars, display only).
CREATE TABLE IF NOT EXISTS reading_history (
  book_id TEXT PRIMARY KEY REFERENCES books(id),
  last_opened_at TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 1,
  progress TEXT
);
CREATE INDEX IF NOT EXISTS reading_recent ON reading_history (last_opened_at);
