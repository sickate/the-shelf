-- 2026-10-28 read-aloud on qwen-audio-3.1-tts-flash (docs/tts-qwen-audio-plan-2026-10-28.md). Additive.
-- Run once: SQLite/D1 has no ADD COLUMN IF NOT EXISTS, so re-running the ALTERs fails with
-- "duplicate column name" (nothing else changes); the index statements are idempotent.
-- tts_model NULL = qwen3-tts-flash-realtime (jobs created before this migration).
ALTER TABLE audio_jobs ADD COLUMN tts_model TEXT;
-- auto = the LLM-chosen style is sent as the TTS instruction; plain = no instruction. Old rows: auto.
ALTER TABLE audio_jobs ADD COLUMN tone TEXT NOT NULL DEFAULT 'auto' CHECK (tone IN ('auto','plain'));
-- Word marks: JSON [charOffset, ms, ...], UTF-16 offsets into the piece text, ≤ ~2 KB. NULL = none.
ALTER TABLE audio_pieces ADD COLUMN marks TEXT;
-- One live job per (book, chapter, sha256(text), voice, tone). Existing live rows are unique on the
-- old key, so they stay unique on the wider one.
DROP INDEX IF EXISTS audio_jobs_live;
CREATE UNIQUE INDEX IF NOT EXISTS audio_jobs_live_tone ON audio_jobs (book_id, chapter_key, source_sha256, voice, tone) WHERE deleted_at IS NULL;
