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
