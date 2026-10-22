-- Apply ONLY to the verified production the-shelf-library D1 after base schema.
-- No identity seed, readiness, resource creation or legacy unfreeze is implicit.
PRAGMA foreign_keys=ON;
CREATE TABLE shelf_storage_authority (
 id INTEGER PRIMARY KEY CHECK(id=1), identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 phase TEXT NOT NULL CHECK(phase IN ('migration_required','imported','ready')),
 migration_hash TEXT, committed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(committed_bytes>=0),
 reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 observed_bytes INTEGER CHECK(observed_bytes>=0), observed_at INTEGER, evidence_hash TEXT, billing_period TEXT,
 readback_hash TEXT, receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json))
);
CREATE TABLE shelf_storage_sources (
 scope TEXT PRIMARY KEY CHECK(scope IN ('check','production')),
 migration_hash TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
 metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), freeze_proof_json TEXT NOT NULL CHECK(json_valid(freeze_proof_json)),
 reservation_count INTEGER NOT NULL CHECK(reservation_count>=0), registry_count INTEGER NOT NULL CHECK(registry_count>=0),
 committed_bytes INTEGER NOT NULL CHECK(committed_bytes>=0), reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0)
);
CREATE TABLE shelf_storage_staging (
 reservation_id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE,
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 20000000),
 state TEXT NOT NULL CHECK(state IN ('uncertain','confirmed')), etag TEXT,
 enabled INTEGER CHECK(enabled IN (0,1)), created_at INTEGER NOT NULL,
 CHECK((state='confirmed' AND enabled IS NOT NULL AND length(etag)>0) OR (state='uncertain' AND enabled IS NULL AND etag IS NULL))
);
CREATE TABLE shelf_storage_reservations (
 reservation_id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE,
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 20000000),
 state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uncertain','confirmed')),
 put_attempted INTEGER NOT NULL CHECK(put_attempted IN (0,1)), content_verified INTEGER NOT NULL CHECK(content_verified IN (0,1)),
 etag TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK(state<>'confirmed' OR (content_verified=1 AND length(etag)>0)),
 CHECK(state<>'uploading' OR put_attempted=1)
);
CREATE TABLE shelf_storage_original_registry (
 logical_key TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES shelf_storage_reservations(reservation_id),
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), etag TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE shelf_storage_text_registry (
 logical_key TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES shelf_storage_reservations(reservation_id),
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), etag TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TRIGGER shelf_storage_authority_insert BEFORE INSERT ON shelf_storage_authority BEGIN
 SELECT CASE WHEN NEW.phase<>'migration_required' OR NEW.committed_bytes<>0 OR NEW.reserved_bytes<>0
 OR NEW.migration_hash IS NOT NULL OR NEW.receipt_json IS NOT NULL OR NEW.readback_hash IS NOT NULL
 OR NEW.observed_bytes IS NOT NULL OR NEW.observed_at IS NOT NULL OR NEW.evidence_hash IS NOT NULL OR NEW.billing_period IS NOT NULL
 THEN RAISE(ABORT,'storage_authority_initial_state') END;
END;
CREATE TRIGGER shelf_storage_authority_delete BEFORE DELETE ON shelf_storage_authority BEGIN
 SELECT RAISE(ABORT,'storage_authority_retained');
END;
CREATE TRIGGER shelf_storage_identity_guard BEFORE UPDATE ON shelf_storage_authority BEGIN
 SELECT CASE WHEN NEW.id<>OLD.id OR NEW.identity_json<>OLD.identity_json
 OR (NEW.phase<>OLD.phase AND NOT ((OLD.phase='migration_required' AND NEW.phase='imported') OR (OLD.phase='imported' AND NEW.phase='ready')))
 OR (OLD.migration_hash IS NOT NULL AND NEW.migration_hash IS NOT OLD.migration_hash)
 OR (OLD.observed_at IS NOT NULL AND (NEW.observed_at IS NULL OR NEW.observed_at<OLD.observed_at OR (NEW.observed_at=OLD.observed_at AND NEW.evidence_hash IS NOT OLD.evidence_hash)))
 THEN RAISE(ABORT,'storage_identity_or_evidence_conflict') END;
END;
CREATE TRIGGER shelf_storage_source_guard BEFORE INSERT ON shelf_storage_sources BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND phase='migration_required') THEN RAISE(ABORT,'migration_conflict') END;
END;
CREATE TRIGGER shelf_storage_source_update BEFORE UPDATE ON shelf_storage_sources BEGIN SELECT RAISE(ABORT,'migration_conflict'); END;
CREATE TRIGGER shelf_storage_source_delete BEFORE DELETE ON shelf_storage_sources BEGIN SELECT RAISE(ABORT,'migration_conflict'); END;
CREATE TRIGGER shelf_storage_staging_guard BEFORE INSERT ON shelf_storage_staging BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND phase='migration_required') THEN RAISE(ABORT,'migration_conflict') END;
END;
CREATE TRIGGER shelf_storage_staging_update BEFORE UPDATE ON shelf_storage_staging BEGIN SELECT RAISE(ABORT,'migration_conflict'); END;
CREATE TRIGGER shelf_storage_staging_delete BEFORE DELETE ON shelf_storage_staging BEGIN SELECT RAISE(ABORT,'migration_conflict'); END;
CREATE TRIGGER shelf_storage_publish_guard BEFORE UPDATE OF phase ON shelf_storage_authority
WHEN OLD.phase='migration_required' AND NEW.phase='imported' BEGIN
 SELECT CASE WHEN NEW.migration_hash IS NULL OR length(NEW.migration_hash)<>64
 OR (SELECT count(*) FROM shelf_storage_sources)<>2
 OR EXISTS(SELECT 1 FROM shelf_storage_sources WHERE migration_hash<>NEW.migration_hash)
 OR (SELECT count(*) FROM shelf_storage_staging)<>(SELECT sum(reservation_count) FROM shelf_storage_sources)
 OR (SELECT count(*) FROM shelf_storage_staging WHERE state='confirmed')<>(SELECT sum(registry_count) FROM shelf_storage_sources)
 OR COALESCE((SELECT sum(size_bytes) FROM shelf_storage_staging WHERE state='confirmed'),0)<>(SELECT sum(committed_bytes) FROM shelf_storage_sources)
 OR COALESCE((SELECT sum(size_bytes) FROM shelf_storage_staging WHERE state='uncertain'),0)<>(SELECT sum(reserved_bytes) FROM shelf_storage_sources)
 OR EXISTS(SELECT 1 FROM shelf_storage_reservations)
 OR EXISTS(SELECT 1 FROM shelf_storage_original_registry)
 OR EXISTS(SELECT 1 FROM shelf_storage_text_registry)
 THEN RAISE(ABORT,'migration_incomplete') END;
END;
CREATE TRIGGER shelf_storage_publish AFTER UPDATE OF phase ON shelf_storage_authority
WHEN OLD.phase='migration_required' AND NEW.phase='imported' BEGIN
 INSERT INTO shelf_storage_reservations SELECT reservation_id,logical_key,object_key,descriptor_json,size_bytes,state,1,state='confirmed',etag,created_at,created_at FROM shelf_storage_staging;
 INSERT INTO shelf_storage_original_registry SELECT logical_key,reservation_id,descriptor_json,etag,enabled FROM shelf_storage_staging WHERE state='confirmed';
 UPDATE shelf_storage_authority SET committed_bytes=(SELECT sum(committed_bytes) FROM shelf_storage_sources),reserved_bytes=(SELECT sum(reserved_bytes) FROM shelf_storage_sources) WHERE id=1;
END;
CREATE TRIGGER shelf_storage_ready_guard BEFORE UPDATE OF phase ON shelf_storage_authority
WHEN OLD.phase='imported' AND NEW.phase='ready' BEGIN
 SELECT CASE WHEN NEW.readback_hash IS NULL OR length(NEW.readback_hash)<>64 OR NEW.receipt_json IS NULL
 OR json_extract(NEW.receipt_json,'$.migrationHash') IS NOT NEW.migration_hash
 OR json_extract(NEW.receipt_json,'$.readbackSha256') IS NOT NEW.readback_hash
 OR json_extract(NEW.receipt_json,'$.cloudWriteFreezeProven') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.databaseWriteFreezeProven') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.sourceProjectionVerified') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.writeClosureProof.schemaVersion') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.writeClosureProof.legacyConnectionsClosed') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.writeClosureProof.legacyProcessesStopped') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.writeClosureProof.legacyEntryPointsDisabled') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.writeClosureProof.probeWriteCapabilityDisabled') IS NOT 1
 OR json_extract(NEW.receipt_json,'$.writeClosureProof.drainBound.source') IS NOT 'enforced-transport-deadline'
 OR length(json_extract(NEW.receipt_json,'$.writeClosureProof.connectionEvidenceSha256')) IS NOT 64
 OR length(json_extract(NEW.receipt_json,'$.writeClosureProof.drainBound.configurationSha256')) IS NOT 64
 OR COALESCE(json_extract(NEW.receipt_json,'$.writeClosureProof.drainBound.maxRequestLifetimeMs'),0)<1
 OR COALESCE(json_extract(NEW.receipt_json,'$.writeClosureProof.deadlineMs'),0)<60000
 OR COALESCE(json_extract(NEW.receipt_json,'$.writeClosureProof.deadlineMs'),0)<json_extract(NEW.receipt_json,'$.writeClosureProof.drainBound.maxRequestLifetimeMs')
 OR COALESCE(json_extract(NEW.receipt_json,'$.writeClosureProof.drainedAt'),0)<json_extract(NEW.receipt_json,'$.writeClosureProof.stoppedAt')+json_extract(NEW.receipt_json,'$.writeClosureProof.deadlineMs')
 OR NEW.committed_bytes<>COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0)
 OR NEW.reserved_bytes<>COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0)
 THEN RAISE(ABORT,'migration_readback_failed') END;
END;
CREATE TRIGGER shelf_storage_admit BEFORE INSERT ON shelf_storage_reservations
WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND phase='imported') BEGIN
 SELECT CASE WHEN NEW.state<>'reserved' OR NEW.put_attempted<>0 OR NEW.content_verified<>0 OR NEW.etag IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND phase='ready'
  AND observed_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND observed_at>=CAST(unixepoch('subsec')*1000 AS INTEGER)-300000
  AND observed_at<=NEW.created_at AND NEW.created_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)+30000
  AND billing_period=strftime('%Y-%m','now') AND length(evidence_hash)=64
  AND observed_bytes+committed_bytes+reserved_bytes+NEW.size_bytes<=8000000000)
 THEN RAISE(ABORT,'storage_budget_or_evidence_invalid') END;
END;
CREATE TRIGGER shelf_storage_import_admit BEFORE INSERT ON shelf_storage_reservations
WHEN EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND phase='imported') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_staging s WHERE s.reservation_id=NEW.reservation_id
 AND s.logical_key=NEW.logical_key AND s.object_key=NEW.object_key AND s.descriptor_json=NEW.descriptor_json
 AND s.size_bytes=NEW.size_bytes AND s.state=NEW.state AND s.etag IS NEW.etag
 AND NEW.put_attempted=1 AND NEW.content_verified=(s.state='confirmed')
 AND NEW.created_at=s.created_at AND NEW.updated_at=s.created_at)
 THEN RAISE(ABORT,'migration_unstaged_reservation') END;
END;
CREATE TRIGGER shelf_storage_reservation_unique_guard BEFORE INSERT ON shelf_storage_reservations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shelf_storage_reservations WHERE reservation_id=NEW.reservation_id OR logical_key=NEW.logical_key OR object_key=NEW.object_key)
 THEN RAISE(ABORT,'storage_reservation_conflict') END;
END;
CREATE TRIGGER shelf_storage_reserve_account AFTER INSERT ON shelf_storage_reservations
WHEN NEW.state='reserved' BEGIN
 UPDATE shelf_storage_authority SET reserved_bytes=reserved_bytes+NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER shelf_storage_transition BEFORE UPDATE ON shelf_storage_reservations BEGIN
 SELECT CASE WHEN NEW.reservation_id<>OLD.reservation_id OR NEW.logical_key<>OLD.logical_key OR NEW.object_key<>OLD.object_key
 OR NEW.descriptor_json<>OLD.descriptor_json OR NEW.size_bytes<>OLD.size_bytes OR NEW.created_at<>OLD.created_at OR NEW.put_attempted<OLD.put_attempted
 OR (NEW.state<>OLD.state AND NOT ((OLD.state='reserved' AND NEW.state IN ('uploading','uncertain','confirmed')) OR (OLD.state='uploading' AND NEW.state IN ('uncertain','confirmed')) OR (OLD.state='uncertain' AND NEW.state='confirmed')))
 OR (OLD.state='confirmed' AND (NEW.etag IS NOT OLD.etag OR NEW.content_verified<>OLD.content_verified))
 THEN RAISE(ABORT,'storage_transition_invalid') END;
 SELECT CASE WHEN NEW.state='uploading' AND OLD.state<>'uploading' AND NOT EXISTS(SELECT 1 FROM shelf_storage_authority
 WHERE id=1 AND phase='ready' AND observed_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
 AND observed_at>=CAST(unixepoch('subsec')*1000 AS INTEGER)-300000 AND billing_period=strftime('%Y-%m','now')
 AND length(evidence_hash)=64 AND observed_bytes+committed_bytes+reserved_bytes<=8000000000)
 THEN RAISE(ABORT,'account_storage_stale') END;
END;
CREATE TRIGGER shelf_storage_confirm AFTER UPDATE OF state ON shelf_storage_reservations
WHEN NEW.state='confirmed' AND OLD.state<>'confirmed' BEGIN
 INSERT INTO shelf_storage_original_registry SELECT NEW.logical_key,NEW.reservation_id,NEW.descriptor_json,NEW.etag,1 WHERE json_extract(NEW.descriptor_json,'$.kind')='original';
 INSERT INTO shelf_storage_text_registry SELECT NEW.logical_key,NEW.reservation_id,NEW.descriptor_json,NEW.etag,1 WHERE json_extract(NEW.descriptor_json,'$.kind')='prepared-text';
 UPDATE shelf_storage_authority SET reserved_bytes=reserved_bytes-NEW.size_bytes,committed_bytes=committed_bytes+NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER shelf_storage_project_original AFTER INSERT ON shelf_storage_original_registry
WHEN json_extract(NEW.descriptor_json,'$.scope')='production' AND NEW.enabled=1 BEGIN
 INSERT INTO file_registry(scope,file_id,book_id,format,size_bytes,object_key,sha256,etag,state,version,updated_at)
 VALUES('production',json_extract(NEW.descriptor_json,'$.fileId'),json_extract(NEW.descriptor_json,'$.bookId'),json_extract(NEW.descriptor_json,'$.format'),json_extract(NEW.descriptor_json,'$.sizeBytes'),json_extract(NEW.descriptor_json,'$.objectKey'),json_extract(NEW.descriptor_json,'$.sha256'),NEW.etag,'confirmed',1,CAST(unixepoch('subsec')*1000 AS INTEGER))
 ON CONFLICT(scope,file_id) DO NOTHING;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM file_registry f WHERE f.scope='production' AND f.file_id=json_extract(NEW.descriptor_json,'$.fileId')
 AND f.book_id=json_extract(NEW.descriptor_json,'$.bookId') AND f.format=json_extract(NEW.descriptor_json,'$.format')
 AND f.size_bytes=json_extract(NEW.descriptor_json,'$.sizeBytes') AND f.object_key=json_extract(NEW.descriptor_json,'$.objectKey')
 AND f.sha256=json_extract(NEW.descriptor_json,'$.sha256') AND f.etag=NEW.etag AND f.state='confirmed')
 THEN RAISE(ABORT,'storage_projection_conflict') END;
END;
CREATE TRIGGER shelf_storage_original_guard BEFORE INSERT ON shelf_storage_original_registry BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shelf_storage_original_registry WHERE logical_key=NEW.logical_key OR reservation_id=NEW.reservation_id)
 THEN RAISE(ABORT,'storage_registry_immutable') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_reservations r JOIN shelf_storage_authority a ON a.id=1
 WHERE a.phase IN ('imported','ready') AND r.reservation_id=NEW.reservation_id AND r.logical_key=NEW.logical_key
 AND r.descriptor_json=NEW.descriptor_json AND r.etag=NEW.etag AND r.state='confirmed' AND r.content_verified=1
 AND json_extract(r.descriptor_json,'$.kind')='original'
 AND ((a.phase='ready' AND NEW.enabled=1) OR (a.phase='imported' AND EXISTS(
 SELECT 1 FROM shelf_storage_staging s WHERE s.reservation_id=NEW.reservation_id AND s.logical_key=NEW.logical_key
 AND s.descriptor_json=NEW.descriptor_json AND s.etag=NEW.etag AND s.enabled=NEW.enabled AND s.state='confirmed'))))
 THEN RAISE(ABORT,'storage_registry_unverified') END;
END;
CREATE TRIGGER shelf_storage_text_guard BEFORE INSERT ON shelf_storage_text_registry BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shelf_storage_text_registry WHERE logical_key=NEW.logical_key OR reservation_id=NEW.reservation_id)
 THEN RAISE(ABORT,'storage_registry_immutable') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_reservations r JOIN shelf_storage_authority a ON a.id=1
 WHERE a.phase='ready' AND r.reservation_id=NEW.reservation_id AND r.logical_key=NEW.logical_key
 AND r.descriptor_json=NEW.descriptor_json AND r.etag=NEW.etag AND r.state='confirmed' AND r.content_verified=1
 AND json_extract(r.descriptor_json,'$.kind')='prepared-text' AND NEW.enabled=1)
 THEN RAISE(ABORT,'storage_registry_unverified') END;
END;
CREATE TRIGGER shelf_storage_retain BEFORE DELETE ON shelf_storage_reservations BEGIN SELECT RAISE(ABORT,'storage_reservation_retained'); END;
CREATE TRIGGER shelf_storage_registry_update BEFORE UPDATE ON shelf_storage_original_registry BEGIN SELECT RAISE(ABORT,'storage_registry_immutable'); END;
CREATE TRIGGER shelf_storage_registry_delete BEFORE DELETE ON shelf_storage_original_registry BEGIN SELECT RAISE(ABORT,'storage_registry_immutable'); END;
CREATE TRIGGER shelf_storage_text_update BEFORE UPDATE ON shelf_storage_text_registry BEGIN SELECT RAISE(ABORT,'storage_registry_immutable'); END;
CREATE TRIGGER shelf_storage_text_delete BEFORE DELETE ON shelf_storage_text_registry BEGIN SELECT RAISE(ABORT,'storage_registry_immutable'); END;
