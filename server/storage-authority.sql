-- Offline SQLite authority only. This is NOT a D1/production migration.
PRAGMA foreign_keys = ON;
CREATE TABLE authority (
  id INTEGER PRIMARY KEY CHECK(id=1),
  identity_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('migration_required','ready')),
  migration_hash TEXT,
  observed_bytes INTEGER CHECK(observed_bytes>=0),
  observed_at INTEGER,
  evidence_hash TEXT,
  billing_period TEXT,
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(committed_bytes>=0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0)
);
CREATE TABLE migration_sources (
  scope TEXT PRIMARY KEY CHECK(scope IN ('check','production')),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL
);
CREATE TABLE migration_receipt (
  id INTEGER PRIMARY KEY CHECK(id=1),
  receipt_json TEXT NOT NULL
);
CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  descriptor_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 20000000),
  state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uncertain','confirmed')),
  put_attempted INTEGER NOT NULL CHECK(put_attempted IN (0,1)),
  content_verified INTEGER NOT NULL DEFAULT 0 CHECK(content_verified IN (0,1)),
  etag TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(state<>'confirmed' OR (content_verified=1 AND length(etag)>0)),
  CHECK(state<>'uploading' OR put_attempted=1)
);
CREATE TABLE original_registry (
  logical_key TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(reservation_id),
  descriptor_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE text_registry (
  logical_key TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(reservation_id),
  descriptor_json TEXT NOT NULL,
  etag TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TRIGGER immutable_descriptor BEFORE UPDATE ON reservations BEGIN
  SELECT CASE WHEN NEW.reservation_id<>OLD.reservation_id OR NEW.logical_key<>OLD.logical_key
    OR NEW.object_key<>OLD.object_key OR NEW.descriptor_json<>OLD.descriptor_json
    OR NEW.size_bytes<>OLD.size_bytes OR NEW.created_at<>OLD.created_at
    OR NEW.put_attempted<OLD.put_attempted
    OR (NEW.state<>OLD.state AND NOT (
      (OLD.state='reserved' AND NEW.state IN ('uploading','uncertain','confirmed')) OR
      (OLD.state='uploading' AND NEW.state IN ('uncertain','confirmed')) OR
      (OLD.state='uncertain' AND NEW.state='confirmed')))
    OR (OLD.state='confirmed' AND (NEW.etag IS NOT OLD.etag OR NEW.content_verified<>OLD.content_verified))
    THEN RAISE(ABORT,'storage_transition_invalid') END;
END;
CREATE TRIGGER retained_reservation BEFORE DELETE ON reservations BEGIN
  SELECT RAISE(ABORT,'storage_reservation_retained');
END;
