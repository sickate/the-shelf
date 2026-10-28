-- 2026-10-27 read-aloud (A1, docs/audiobook-google-login-plan-2026-10-27.md). Additive and idempotent.
-- One job per (book, chapter, sha256(submitted text), voice) among live jobs; soft delete only.
CREATE TABLE IF NOT EXISTS audio_jobs (
  id TEXT PRIMARY KEY,                -- a_<24 hex>
  book_id TEXT NOT NULL REFERENCES books(id),
  chapter_key TEXT NOT NULL,          -- reader locator, ≤ 500 bytes
  chapter_label TEXT,
  source_sha256 TEXT NOT NULL,        -- sha256 of the submitted chapter text
  voice TEXT NOT NULL,
  style TEXT,                         -- narration tone chosen by the LLM from block 0 (or the neutral default)
  status TEXT NOT NULL CHECK (status IN ('queued','cleaning','synthesizing','ready','failed','budget_exceeded')),
  workflow_id TEXT,                   -- current Workflow instance (<jobId>-p<part>)
  piece_chars INTEGER NOT NULL,       -- piece length used for new splits (200, or 120 after a CPU downgrade)
  est_seconds INTEGER,
  total_pieces INTEGER NOT NULL DEFAULT 0,  -- pieces so far + estimate for blocks not cleaned yet
  done_pieces INTEGER NOT NULL DEFAULT 0,
  billed_chars INTEGER NOT NULL DEFAULT 0,  -- DashScope usage.characters (CJK counts 2)
  error TEXT,
  llm_fallback_blocks INTEGER NOT NULL DEFAULT 0,
  cpu_downgraded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS audio_jobs_live ON audio_jobs (book_id, chapter_key, source_sha256, voice) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS audio_jobs_chapter ON audio_jobs (book_id, chapter_key, deleted_at, created_at);
-- LLM cleanup blocks (~6,000 chars). raw is cleared once the block is cleaned; cleaned text is kept
-- so regenerating (e.g. another voice) does not call the LLM again.
CREATE TABLE IF NOT EXISTS audio_blocks (
  job_id TEXT NOT NULL REFERENCES audio_jobs(id),
  idx INTEGER NOT NULL,
  raw TEXT,
  cleaned TEXT,
  raw_chars INTEGER NOT NULL,
  est_pieces INTEGER NOT NULL,
  llm_attempts INTEGER NOT NULL DEFAULT 0,
  llm_status TEXT NOT NULL CHECK (llm_status IN ('pending','llm','fallback','short')),
  split_done INTEGER NOT NULL DEFAULT 0,  -- 1 once this job's pieces for the block exist
  PRIMARY KEY (job_id, idx)
);
-- Synthesis units. seq = block * 65536 + k * 16; the gaps let a piece be split in place
-- (children seq+1..seq+15, cpu_split = 1). A split parent keeps its reservation/size.
-- Budget: COALESCE(size_bytes, reserved_bytes) of every row counts toward the 8 GB total
-- (soft-deleted jobs included); a reservation is made before the R2 put and kept on unknown outcomes.
CREATE TABLE IF NOT EXISTS audio_pieces (
  job_id TEXT NOT NULL REFERENCES audio_jobs(id),
  seq INTEGER NOT NULL,
  block INTEGER NOT NULL,
  segment INTEGER,                    -- assigned from actual durations when ready (each segment ≤ 20:00)
  text TEXT NOT NULL,
  est_ms INTEGER,
  r2_key TEXT,                        -- audio/<jobId>/<seq>.mp3
  reserved_bytes INTEGER,
  size_bytes INTEGER,
  duration_ms INTEGER,
  billed_chars INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','failed','split')),
  attempts INTEGER NOT NULL DEFAULT 0,  -- failed rounds (each round = 1 + 2 step retries)
  error TEXT,
  cpu_split INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS audio_pieces_block ON audio_pieces (job_id, block);
-- Global read-aloud settings (single row). piece_chars drops to 120 after a CPU-limit failure.
CREATE TABLE IF NOT EXISTS audio_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  piece_chars INTEGER NOT NULL DEFAULT 200,
  cpu_downgraded_at TEXT,
  downgrade_reason TEXT,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO audio_settings (id, piece_chars, updated_at) VALUES (1, 200, '2026-10-27T00:00:00.000Z');
