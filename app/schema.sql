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
-- Added 2026-10-26 (app/migrations/0006_reading.sql). Owner-only recent reading: one row per book.
CREATE TABLE IF NOT EXISTS reading_history (
  book_id TEXT PRIMARY KEY REFERENCES books(id),
  last_opened_at TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 1,
  progress TEXT
);
CREATE INDEX IF NOT EXISTS reading_recent ON reading_history (last_opened_at);
-- Added 2026-10-27 (app/migrations/0007_audio.sql). Read-aloud jobs, blocks, pieces and settings.
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
  deleted_at TEXT,
  -- Added 2026-10-28 (app/migrations/0008_audio_tts.sql): TTS model (NULL = qwen3-tts-flash-realtime,
  -- jobs created before 0008) and narration tone (auto = LLM style sent as instruction, plain = none).
  tts_model TEXT,
  tone TEXT NOT NULL DEFAULT 'auto' CHECK (tone IN ('auto','plain')),
  -- Added 2026-10-28 (app/migrations/0009_audio_handoff.sql): continuation part a Workflow instance
  -- handed off (started by the cron / job GET); NULL = none pending.
  next_part INTEGER
);
CREATE INDEX IF NOT EXISTS audio_jobs_next_part ON audio_jobs (next_part) WHERE next_part IS NOT NULL;
-- One live job per (book, chapter, sha256(text), voice, tone) (0008; replaces 0007's audio_jobs_live).
CREATE UNIQUE INDEX IF NOT EXISTS audio_jobs_live_tone ON audio_jobs (book_id, chapter_key, source_sha256, voice, tone) WHERE deleted_at IS NULL;
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
  -- Added 2026-10-28 (0008): word marks as JSON [charOffset, ms, ...] (UTF-16 offsets into text), ≤ ~2 KB.
  marks TEXT,
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
