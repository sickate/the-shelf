-- 2026-10-24 features (docs/features-plan-2026-10-24.md §3): cover thumbnails and AI book info.
-- Additive only; existing `books` columns are untouched, so the previous Worker ignores these tables.
CREATE TABLE IF NOT EXISTS covers (
  book_id TEXT PRIMARY KEY REFERENCES books(id),
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_info (
  book_id TEXT PRIMARY KEY REFERENCES books(id),
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  data_json TEXT,
  model TEXT,
  input_kind TEXT,
  lease_until TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);
