-- 2026-10-25 document type: books vs non-book materials (docs/classification-plan-2026-10-24.md §11).
-- Run once: SQLite/D1 has no ADD COLUMN IF NOT EXISTS, so re-running fails with "duplicate column name".
-- NULL = classified before this migration (counted as a book) or not classified yet.
ALTER TABLE book_class ADD COLUMN doc_type TEXT;
