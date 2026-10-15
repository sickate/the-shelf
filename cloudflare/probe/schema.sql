-- Dedicated CF-01 D1 only. Never apply to any existing Shelf database.
CREATE TABLE IF NOT EXISTS cf01_budget (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delay_seconds INTEGER NOT NULL,
  mode TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS cf01_reserve_run AFTER INSERT ON cf01_budget BEGIN
  INSERT INTO cf01_runs (run_id, kind, state, delay_seconds, mode, created_at, updated_at)
  VALUES (NEW.run_id, NEW.kind, 'reserved', NEW.delay_seconds, NEW.mode, NEW.created_at, NEW.created_at);
END;
CREATE TABLE IF NOT EXISTS cf01_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'success',
  network_calls INTEGER NOT NULL DEFAULT 0,
  mock_calls INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  result_json TEXT
);
