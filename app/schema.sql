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
-- Added 2026-10-25 (app/migrations/0003_classification.sql). clc/source are NULL only while a first
-- auto-classification is generating or after it failed.
CREATE TABLE IF NOT EXISTS book_class (
  book_id TEXT PRIMARY KEY REFERENCES books(id),
  clc TEXT,
  secondary TEXT,
  source TEXT CHECK (source IS NULL OR source IN ('cip', 'ai', 'manual')),
  confidence TEXT,
  reason TEXT,
  evidence_url TEXT,
  raw_code TEXT,
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  lease_until TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  -- Added 2026-10-25 (app/migrations/0004_doc_type.sql): book|course|paper|articles|manual|other;
  -- NULL for results from before the migration (counted as book).
  doc_type TEXT
);
CREATE INDEX IF NOT EXISTS book_class_clc ON book_class (clc);
-- Added 2026-10-26 (app/migrations/0005_notes.sql). Owner-only quotes/notes; soft delete via deleted_at.
-- locator is JSON: {type:'cfi',cfi} | {type:'pdf',page,start?,end?} | {type:'text',start,end}.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  quote TEXT NOT NULL,
  note TEXT,
  color TEXT NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow','green','blue','pink')),
  locator TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_book ON notes (book_id, deleted_at, created_at);
