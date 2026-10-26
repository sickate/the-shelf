-- 2026-10-25 hierarchical CLC classification (docs/classification-plan-2026-10-24.md §5).
-- Additive and idempotent. Deviation from the plan sketch: clc/source are nullable (the single-flight
-- lease row of a book without a previous result has no code yet) and an error column mirrors book_info.
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS book_class_clc ON book_class (clc);
