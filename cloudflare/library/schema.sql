-- CF-03 dedicated D1 only. check and production MUST use different databases.
-- All times are integer UTC epoch milliseconds. Never apply to CF-01 or local private SQLite.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS library_schema (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
INSERT OR IGNORE INTO library_schema VALUES (1, CAST(unixepoch('now') AS INTEGER)*1000);
CREATE TABLE IF NOT EXISTS auth_config (
  scope TEXT PRIMARY KEY CHECK(scope IN ('check','production')),
  origin TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK(scheme='owner-access-key-v1'),
  verifier TEXT NOT NULL CHECK(length(verifier)=64 AND verifier NOT GLOB '*[^0-9a-f]*'),
  generation INTEGER NOT NULL CHECK(generation>=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  scope TEXT NOT NULL,
  session_hash TEXT NOT NULL CHECK(length(session_hash)=64),
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+86400000),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  PRIMARY KEY(scope,session_hash),
  FOREIGN KEY(scope) REFERENCES auth_config(scope)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(scope,revoked,expires_at);
CREATE TABLE IF NOT EXISTS public_state (
  scope TEXT PRIMARY KEY CHECK(scope IN ('check','production')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  base_revision TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO public_state(scope,revision,updated_at) VALUES ('check',0,0),('production',0,0);
CREATE TABLE IF NOT EXISTS catalog_books (
  scope TEXT NOT NULL,
  book_id TEXT NOT NULL,
  public_json TEXT NOT NULL CHECK(json_valid(public_json)),
  PRIMARY KEY(scope,book_id),
  FOREIGN KEY(scope) REFERENCES public_state(scope)
);
CREATE TABLE IF NOT EXISTS metadata_overrides (
  scope TEXT NOT NULL,
  book_id TEXT NOT NULL,
  patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope,book_id),
  FOREIGN KEY(scope,book_id) REFERENCES catalog_books(scope,book_id)
);
CREATE TABLE IF NOT EXISTS file_registry (
  scope TEXT NOT NULL,
  file_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('PDF','EPUB','MOBI','AZW','AZW3')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=20000000),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  etag TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uncertain','confirmed','disabled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope,file_id),
  FOREIGN KEY(scope,book_id) REFERENCES catalog_books(scope,book_id),
  CHECK((scope='production' AND object_key LIKE 'books/%') OR (scope='check' AND object_key LIKE 'cf03-check/%'))
);
CREATE INDEX IF NOT EXISTS files_book ON file_registry(scope,book_id);
CREATE TABLE IF NOT EXISTS counters (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count>=0),
  max_count INTEGER NOT NULL CHECK(max_count>0 AND count<=max_count),
  PRIMARY KEY(scope,kind,bucket,window_start)
);
CREATE TABLE IF NOT EXISTS admissions (
  scope TEXT NOT NULL CHECK(scope IN ('check','production')),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('api','login','access','metadata')),
  ip_key TEXT NOT NULL CHECK(length(ip_key)=64),
  created_at INTEGER NOT NULL,
  session_hash TEXT,
  generation INTEGER,
  file_id TEXT,
  PRIMARY KEY(scope,request_id)
);
CREATE INDEX IF NOT EXISTS admissions_expiry ON admissions(created_at);

-- Each admission INSERT is one atomic multi-key budget reservation. Failed
-- constraints roll back ALL increments; never SELECT counts then authorize in JS.
CREATE TRIGGER IF NOT EXISTS admit_api AFTER INSERT ON admissions WHEN NEW.kind='api' BEGIN
  INSERT INTO counters VALUES(NEW.scope,'api_day','global',NEW.created_at/86400000,1,1000)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
  INSERT INTO counters VALUES(NEW.scope,'api_minute','global',NEW.created_at/60000,1,240)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
  INSERT INTO counters VALUES(NEW.scope,'api_ip',NEW.ip_key,NEW.created_at/60000,1,240)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS admit_login AFTER INSERT ON admissions WHEN NEW.kind='login' BEGIN
  INSERT INTO counters VALUES(NEW.scope,'login_day','global',NEW.created_at/86400000,1,100)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
  INSERT INTO counters VALUES(NEW.scope,'login_minute','global',NEW.created_at/60000,1,20)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
  INSERT INTO counters VALUES(NEW.scope,'login_ip',NEW.ip_key,NEW.created_at/60000,1,5)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS admission_private BEFORE INSERT ON admissions WHEN NEW.kind IN ('access','metadata') BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sessions s JOIN auth_config a ON a.scope=s.scope
    WHERE s.scope=NEW.scope AND s.session_hash=NEW.session_hash AND s.revoked=0
      AND s.expires_at>NEW.created_at AND s.generation=NEW.generation
      AND a.generation=s.generation AND a.enabled=1
  ) THEN RAISE(ABORT,'library_session_invalid') END;
  SELECT CASE WHEN NEW.kind='access' AND NOT EXISTS (
    SELECT 1 FROM file_registry f WHERE f.scope=NEW.scope AND f.file_id=NEW.file_id
      AND f.state='confirmed' AND f.size_bytes>0 AND f.size_bytes<=20000000
  ) THEN RAISE(ABORT,'library_file_unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS admit_access AFTER INSERT ON admissions WHEN NEW.kind='access' BEGIN
  INSERT INTO counters VALUES(NEW.scope,'access_day','global',NEW.created_at/86400000,1,1000)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
  INSERT INTO counters VALUES(NEW.scope,'access_ip',NEW.ip_key,NEW.created_at/60000,1,120)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS admit_metadata AFTER INSERT ON admissions WHEN NEW.kind='metadata' BEGIN
  INSERT INTO counters VALUES(NEW.scope,'metadata_day','global',NEW.created_at/86400000,1,100)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
  INSERT INTO counters VALUES(NEW.scope,'metadata_ip',NEW.ip_key,NEW.created_at/60000,1,20)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS create_session BEFORE INSERT ON sessions BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth_config WHERE scope=NEW.scope AND generation=NEW.generation AND enabled=1)
    THEN RAISE(ABORT,'library_session_invalid') END;
  SELECT CASE WHEN (SELECT count(*) FROM sessions WHERE scope=NEW.scope AND revoked=0 AND expires_at>NEW.created_at)>=10
    THEN RAISE(ABORT,'library_session_limit') END;
  INSERT INTO counters VALUES(NEW.scope,'session_day','global',NEW.created_at/86400000,1,50)
    ON CONFLICT(scope,kind,bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS auth_rotation AFTER UPDATE OF generation,enabled ON auth_config
WHEN OLD.generation<>NEW.generation OR NEW.enabled=0 BEGIN
  UPDATE sessions SET revoked=1 WHERE scope=NEW.scope AND revoked=0;
END;
CREATE TRIGGER IF NOT EXISTS auth_generation_guard BEFORE UPDATE ON auth_config BEGIN
  SELECT CASE WHEN NEW.scope<>OLD.scope OR NEW.origin<>OLD.origin OR NEW.generation<OLD.generation
    OR (NEW.verifier<>OLD.verifier AND NEW.generation<=OLD.generation)
    THEN RAISE(ABORT,'library_rotation_invalid') END;
END;

CREATE TRIGGER IF NOT EXISTS catalog_insert AFTER INSERT ON catalog_books BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=CAST(unixepoch('now') AS INTEGER)*1000 WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS catalog_update AFTER UPDATE ON catalog_books WHEN NEW.public_json<>OLD.public_json BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=CAST(unixepoch('now') AS INTEGER)*1000 WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS catalog_delete AFTER DELETE ON catalog_books BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=CAST(unixepoch('now') AS INTEGER)*1000 WHERE scope=OLD.scope;
END;
CREATE TRIGGER IF NOT EXISTS metadata_insert AFTER INSERT ON metadata_overrides BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=NEW.updated_at WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS metadata_update AFTER UPDATE ON metadata_overrides BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=NEW.updated_at WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS metadata_delete AFTER DELETE ON metadata_overrides BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=CAST(unixepoch('now') AS INTEGER)*1000 WHERE scope=OLD.scope;
END;
CREATE TRIGGER IF NOT EXISTS registry_insert AFTER INSERT ON file_registry WHEN NEW.state='confirmed' BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=NEW.updated_at WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS registry_update AFTER UPDATE ON file_registry WHEN NEW.state='confirmed' OR OLD.state='confirmed' BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=NEW.updated_at WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS registry_delete AFTER DELETE ON file_registry WHEN OLD.state='confirmed' BEGIN
  UPDATE public_state SET revision=revision+1,updated_at=CAST(unixepoch('now') AS INTEGER)*1000 WHERE scope=OLD.scope;
END;

CREATE TABLE IF NOT EXISTS storage_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  account_id TEXT NOT NULL,
  observed_account_bytes INTEGER NOT NULL CHECK(observed_account_bytes>=0),
  observed_at INTEGER NOT NULL,
  ceiling_bytes INTEGER NOT NULL CHECK(ceiling_bytes>0 AND ceiling_bytes<=8000000000),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
  committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(committed_bytes>=0),
  evidence_hash TEXT NOT NULL,
  evidence_complete INTEGER NOT NULL CHECK(evidence_complete IN (0,1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_reservations (
  reservation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('check','production')),
  file_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=20000000),
  format TEXT NOT NULL CHECK(format IN ('PDF','EPUB','MOBI','AZW','AZW3')),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uncertain','confirmed','aborted')),
  etag TEXT,
  content_verified INTEGER NOT NULL DEFAULT 0 CHECK(content_verified IN (0,1)),
  absence_verified INTEGER NOT NULL DEFAULT 0 CHECK(absence_verified IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(scope,book_id) REFERENCES catalog_books(scope,book_id),
  CHECK((scope='production' AND object_key LIKE 'books/%') OR (scope='check' AND object_key LIKE 'cf03-check/%'))
);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_file ON upload_reservations(scope,file_id) WHERE state<>'aborted';
CREATE TRIGGER IF NOT EXISTS reserve_upload BEFORE INSERT ON upload_reservations BEGIN
  SELECT CASE WHEN NEW.state<>'reserved' OR NEW.content_verified<>0 OR NEW.absence_verified<>0
    THEN RAISE(ABORT,'library_upload_state') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM file_registry WHERE scope=NEW.scope AND file_id=NEW.file_id)
    THEN RAISE(ABORT,'library_already_registered') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM storage_state WHERE id=1 AND evidence_complete=1 AND length(evidence_hash)=64
      AND observed_at<=NEW.created_at AND observed_at>=NEW.created_at-900000
      AND observed_account_bytes+committed_bytes+reserved_bytes+NEW.size_bytes<=ceiling_bytes
  ) THEN RAISE(ABORT,'library_storage_budget') END;
  UPDATE storage_state SET reserved_bytes=reserved_bytes+NEW.size_bytes,updated_at=NEW.created_at WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS transition_upload BEFORE UPDATE ON upload_reservations BEGIN
  SELECT CASE WHEN NEW.reservation_id<>OLD.reservation_id OR NEW.scope<>OLD.scope OR NEW.file_id<>OLD.file_id
    OR NEW.book_id<>OLD.book_id OR NEW.object_key<>OLD.object_key OR NEW.size_bytes<>OLD.size_bytes
    OR NEW.format<>OLD.format OR NEW.sha256<>OLD.sha256 OR NEW.created_at<>OLD.created_at
    OR (NEW.state<>OLD.state AND NOT (
      (OLD.state='reserved' AND NEW.state IN ('uploading','uncertain','confirmed','aborted')) OR
      (OLD.state='uploading' AND NEW.state IN ('uncertain','confirmed','aborted')) OR
      (OLD.state='uncertain' AND NEW.state IN ('confirmed','aborted'))))
    OR (OLD.state IN ('confirmed','aborted') AND (NEW.content_verified<>OLD.content_verified OR NEW.absence_verified<>OLD.absence_verified OR NEW.etag IS NOT OLD.etag))
    THEN RAISE(ABORT,'library_upload_state') END;
  SELECT CASE WHEN NEW.state='confirmed' AND (NEW.content_verified<>1 OR NEW.etag IS NULL OR length(NEW.etag)=0)
    THEN RAISE(ABORT,'library_upload_unverified') END;
  SELECT CASE WHEN NEW.state='aborted' AND NEW.absence_verified<>1
    THEN RAISE(ABORT,'library_upload_unverified') END;
END;
CREATE TRIGGER IF NOT EXISTS confirm_upload AFTER UPDATE OF state ON upload_reservations
WHEN NEW.state='confirmed' AND OLD.state<>'confirmed' BEGIN
  INSERT INTO file_registry(scope,file_id,book_id,format,size_bytes,object_key,sha256,etag,state,version,updated_at)
    VALUES(NEW.scope,NEW.file_id,NEW.book_id,NEW.format,NEW.size_bytes,NEW.object_key,NEW.sha256,NEW.etag,'confirmed',1,NEW.updated_at);
  UPDATE storage_state SET reserved_bytes=reserved_bytes-NEW.size_bytes,committed_bytes=committed_bytes+NEW.size_bytes,updated_at=NEW.updated_at WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS abort_upload AFTER UPDATE OF state ON upload_reservations
WHEN NEW.state='aborted' AND OLD.state<>'aborted' BEGIN
  UPDATE storage_state SET reserved_bytes=reserved_bytes-NEW.size_bytes,updated_at=NEW.updated_at WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS retain_reservation BEFORE DELETE ON upload_reservations
WHEN OLD.state<>'aborted' BEGIN
  SELECT RAISE(ABORT,'library_upload_retained');
END;

-- Durable public-base import coordinator. Never expire or take over a lease by
-- wall clock. Explicit same-input resume rotates owner_token and fences writers.
-- Batches only touch staging; the completion trigger publishes atomically.
-- base_hash/public_state.base_revision hash the supplied book input only: subset
-- imports preserve absent live books, overrides and registries. The global
-- public_state.revision is the consistent whole-database snapshot version.
CREATE TABLE IF NOT EXISTS catalog_imports (
  scope TEXT PRIMARY KEY CHECK(scope IN ('check','production')),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  base_hash TEXT NOT NULL CHECK(length(base_hash)=64),
  owner_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','complete')),
  book_count INTEGER NOT NULL CHECK(book_count>=0),
  patch_count INTEGER NOT NULL CHECK(patch_count>=0 AND patch_count<=book_count),
  seeded_overrides INTEGER NOT NULL DEFAULT 0 CHECK(seeded_overrides>=0),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(scope) REFERENCES public_state(scope)
);
CREATE TABLE IF NOT EXISTS catalog_import_rows (
  scope TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  book_id TEXT NOT NULL,
  public_json TEXT NOT NULL CHECK(json_valid(public_json)),
  patch_json TEXT CHECK(patch_json IS NULL OR json_valid(patch_json)),
  writer_token TEXT NOT NULL,
  PRIMARY KEY(scope,book_id),
  FOREIGN KEY(scope) REFERENCES catalog_imports(scope)
);
CREATE TRIGGER IF NOT EXISTS import_begin AFTER UPDATE OF state ON catalog_imports
WHEN OLD.state='complete' AND NEW.state='active' BEGIN
  DELETE FROM catalog_import_rows WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS import_row_insert BEFORE INSERT ON catalog_import_rows BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM catalog_imports
    WHERE scope=NEW.scope AND state='active' AND input_hash=NEW.input_hash AND owner_token=NEW.writer_token)
    OR json_extract(NEW.public_json,'$.id') IS NOT NEW.book_id
    THEN RAISE(ABORT,'library_import_fenced') END;
END;
CREATE TRIGGER IF NOT EXISTS import_row_update BEFORE UPDATE ON catalog_import_rows BEGIN
  SELECT CASE WHEN NEW.scope<>OLD.scope OR NEW.book_id<>OLD.book_id OR NOT EXISTS(SELECT 1 FROM catalog_imports
    WHERE scope=NEW.scope AND state='active' AND input_hash=NEW.input_hash AND owner_token=NEW.writer_token)
    OR json_extract(NEW.public_json,'$.id') IS NOT NEW.book_id
    THEN RAISE(ABORT,'library_import_fenced') END;
END;
CREATE TRIGGER IF NOT EXISTS import_complete_guard BEFORE UPDATE OF state ON catalog_imports
WHEN OLD.state='active' AND NEW.state='complete' BEGIN
  SELECT CASE WHEN NEW.scope<>OLD.scope OR NEW.input_hash<>OLD.input_hash OR NEW.owner_token<>OLD.owner_token
    OR NEW.base_hash<>OLD.base_hash OR NEW.book_count<>OLD.book_count OR NEW.patch_count<>OLD.patch_count
    OR (SELECT count(*) FROM catalog_import_rows WHERE scope=NEW.scope)<>NEW.book_count
    OR (SELECT count(*) FROM catalog_import_rows WHERE scope=NEW.scope AND input_hash=NEW.input_hash)<>NEW.book_count
    OR (SELECT count(*) FROM catalog_import_rows WHERE scope=NEW.scope AND input_hash=NEW.input_hash AND patch_json IS NOT NULL)<>NEW.patch_count
    THEN RAISE(ABORT,'library_import_incomplete') END;
END;
CREATE TRIGGER IF NOT EXISTS import_publish AFTER UPDATE OF state ON catalog_imports
WHEN OLD.state='active' AND NEW.state='complete' BEGIN
  UPDATE catalog_imports SET seeded_overrides=(SELECT count(*) FROM catalog_import_rows r
    WHERE r.scope=NEW.scope AND r.input_hash=NEW.input_hash AND r.patch_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM metadata_overrides o WHERE o.scope=r.scope AND o.book_id=r.book_id))
    WHERE scope=NEW.scope;
  INSERT INTO catalog_books(scope,book_id,public_json)
    SELECT scope,book_id,public_json FROM catalog_import_rows WHERE scope=NEW.scope AND input_hash=NEW.input_hash
    ON CONFLICT(scope,book_id) DO UPDATE SET public_json=excluded.public_json
    WHERE catalog_books.public_json<>excluded.public_json;
  INSERT INTO metadata_overrides(scope,book_id,patch_json,version,updated_at)
    SELECT scope,book_id,patch_json,1,NEW.updated_at FROM catalog_import_rows
    WHERE scope=NEW.scope AND input_hash=NEW.input_hash AND patch_json IS NOT NULL
    ON CONFLICT(scope,book_id) DO NOTHING;
  UPDATE public_state SET base_revision=NEW.base_hash,updated_at=NEW.updated_at WHERE scope=NEW.scope;
END;
