-- 2026-10-28 read-aloud fixes (docs/audio-fixes-plan-2026-10-28.md, B1). Additive.
-- Run once: SQLite/D1 has no ADD COLUMN IF NOT EXISTS, so re-running the ALTER fails with
-- "duplicate column name" (nothing else changes); the index statement is idempotent.
-- next_part: a Workflow instance that reached its per-instance budget records the continuation part it
-- needs and ends; the cron / job GET (top-level invocations) start <jobId>-p<next_part> and clear it.
-- NULL = nothing pending. Code from before this migration never reads or writes it.
ALTER TABLE audio_jobs ADD COLUMN next_part INTEGER;
CREATE INDEX IF NOT EXISTS audio_jobs_next_part ON audio_jobs (next_part) WHERE next_part IS NOT NULL;
