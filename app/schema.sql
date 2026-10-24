-- The Shelf MVP schema (D1 database `the-shelf-app`).
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT UNIQUE,
  r2_key TEXT,
  source_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'uploaded', 'local_only')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS books_listing ON books (deleted_at, category, title);
CREATE INDEX IF NOT EXISTS books_budget ON books (r2_key, size_bytes);
-- Added 2026-10-24 (app/migrations/0002_features.sql). Cover bytes count toward the 8 GB budget.
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
