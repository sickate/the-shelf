-- Independent of 010/011/012. Apply only to the exact retained trial-009
-- production schema while the business API is disabled and auth is closed.
-- This installs NO consent, enabled policy, readiness or second balance.
CREATE TABLE shelf_storage_isolated_upload_policy (
 target_id TEXT PRIMARY KEY CHECK(target_id='isolated-project-20261024'),
 authority_identity_json TEXT NOT NULL CHECK(json_valid(authority_identity_json)),
 account_id TEXT NOT NULL CHECK(length(account_id)=32 AND account_id NOT GLOB '*[^a-f0-9]*'),
 bucket TEXT NOT NULL CHECK(bucket='the-shelf-first-book-20261023'),
 trial_target_sha256 TEXT NOT NULL CHECK(length(trial_target_sha256)=64 AND trial_target_sha256 NOT GLOB '*[^a-f0-9]*'),
 consent_sha256 TEXT NOT NULL CHECK(length(consent_sha256)=64 AND consent_sha256 NOT GLOB '*[^a-f0-9]*'),
 budget_bytes INTEGER NOT NULL CHECK(budget_bytes=8000000000),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 9007199254740991),
 created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
);
ALTER TABLE browser_uploads ADD COLUMN target_id TEXT REFERENCES shelf_storage_isolated_upload_policy(target_id);
CREATE TRIGGER shelf_isolated_policy_admit BEFORE INSERT ON shelf_storage_isolated_upload_policy BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shelf_storage_isolated_upload_policy) OR NEW.enabled<>0 OR NEW.generation<>0 OR NEW.updated_at<>NEW.created_at
 OR NEW.created_at>CAST(unixepoch('subsec')*1000 AS INTEGER) OR NEW.created_at<CAST(unixepoch('subsec')*1000 AS INTEGER)-300000
 OR NOT EXISTS(SELECT 1 FROM shelf_storage_authority a JOIN shelf_storage_single_trial t ON t.id=1
 WHERE a.id=1 AND a.phase='imported' AND length(a.migration_hash)=64 AND a.identity_json=NEW.authority_identity_json
 AND json_extract(a.identity_json,'$.accountId')=NEW.account_id AND json_extract(a.identity_json,'$.bucket')='the-shelf-books'
 AND t.authority_identity_json=a.identity_json AND t.state='confirmed' AND t.put_attempted=1 AND t.content_verified=1
 AND json_extract(t.target_json,'$.accountId')=NEW.account_id AND json_extract(t.target_json,'$.bucket')=NEW.bucket
 AND t.isolated_target_config_sha256=NEW.trial_target_sha256)
 THEN RAISE(ABORT,'isolated_policy_invalid') END;
END;
CREATE TRIGGER shelf_isolated_policy_update BEFORE UPDATE ON shelf_storage_isolated_upload_policy BEGIN
 SELECT CASE WHEN NEW.target_id IS NOT OLD.target_id OR NEW.authority_identity_json IS NOT OLD.authority_identity_json
 OR NEW.account_id IS NOT OLD.account_id OR NEW.bucket IS NOT OLD.bucket OR NEW.trial_target_sha256 IS NOT OLD.trial_target_sha256
 OR NEW.consent_sha256 IS NOT OLD.consent_sha256 OR NEW.budget_bytes IS NOT OLD.budget_bytes OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.enabled=OLD.enabled AND NEW.enabled<>0) OR NEW.generation<>OLD.generation+1 OR NEW.updated_at<OLD.updated_at
 THEN RAISE(ABORT,'isolated_policy_immutable') END;
END;
CREATE TRIGGER shelf_isolated_policy_retain BEFORE DELETE ON shelf_storage_isolated_upload_policy BEGIN
 SELECT RAISE(ABORT,'isolated_policy_retained');
END;
CREATE TRIGGER shelf_isolated_upload_admit BEFORE INSERT ON browser_uploads WHEN NEW.target_id IS NOT NULL BEGIN
 SELECT CASE WHEN NEW.target_id<>'isolated-project-20261024' OR NOT EXISTS(SELECT 1 FROM shelf_storage_isolated_upload_policy WHERE target_id=NEW.target_id AND enabled=1)
 OR EXISTS(SELECT 1 FROM file_registry WHERE scope=NEW.scope AND file_id=NEW.file_id)
 OR EXISTS(SELECT 1 FROM shelf_storage_single_trial WHERE json_extract(descriptor_json,'$.fileId')=NEW.file_id OR json_extract(descriptor_json,'$.bookId')=NEW.book_id)
 THEN RAISE(ABORT,'isolated_upload_target_invalid') END;
END;
CREATE TRIGGER shelf_isolated_upload_immutable BEFORE UPDATE ON browser_uploads WHEN OLD.target_id IS NOT NULL OR NEW.target_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'isolated_upload_immutable');
END;
-- No enabled filter: closing writes must retain confirmation and private reads.
CREATE VIEW shelf_isolated_upload_targets AS
 SELECT u.*,json_extract(u.descriptor_json,'$.sizeBytes') AS size_bytes,
 p.authority_identity_json,p.account_id,p.bucket,p.trial_target_sha256,p.consent_sha256,p.budget_bytes,p.created_at AS policy_created_at,p.enabled AS policy_enabled
 FROM browser_uploads u JOIN shelf_storage_isolated_upload_policy p ON p.target_id=u.target_id
 JOIN shelf_storage_authority a ON a.id=1 AND a.phase='imported' AND a.identity_json=p.authority_identity_json
 JOIN shelf_storage_single_trial t ON t.id=1 AND t.state='confirmed' AND t.put_attempted=1 AND t.content_verified=1
 AND t.authority_identity_json=a.identity_json AND t.isolated_target_config_sha256=p.trial_target_sha256
 AND json_extract(t.target_json,'$.accountId')=p.account_id AND json_extract(t.target_json,'$.bucket')=p.bucket
 WHERE u.scope='production' AND u.created_at>=p.created_at AND json_extract(a.identity_json,'$.accountId')=p.account_id
 AND json_extract(a.identity_json,'$.bucket')='the-shelf-books'
 AND (SELECT count(*) FROM json_each(u.descriptor_json))=10
 AND json_extract(u.descriptor_json,'$.kind') IS 'original' AND json_extract(u.descriptor_json,'$.scope') IS u.scope
 AND json_extract(u.descriptor_json,'$.fileId') IS u.file_id AND json_extract(u.descriptor_json,'$.bookId') IS u.book_id
 AND length(u.file_id) BETWEEN 1 AND 100 AND u.file_id NOT GLOB '*[^a-zA-Z0-9_-]*'
 AND length(u.book_id) BETWEEN 1 AND 100 AND u.book_id NOT GLOB '*[^a-zA-Z0-9_-]*'
 AND length(u.sha256)=64 AND u.sha256 NOT GLOB '*[^a-f0-9]*' AND json_extract(u.descriptor_json,'$.sha256') IS u.sha256
 AND json_type(u.descriptor_json,'$.sizeBytes') IS 'integer' AND json_extract(u.descriptor_json,'$.sizeBytes') BETWEEN 1 AND 20000000
 AND json_extract(u.descriptor_json,'$.format') IN ('PDF','EPUB','MOBI','AZW','AZW3')
 AND json_type(u.descriptor_json,'$.versionHash') IS 'null' AND json_type(u.descriptor_json,'$.source') IS 'null'
 AND json_extract(u.descriptor_json,'$.objectKey') IS ('books/cf03/'||u.file_id||'/'||u.sha256||'.'||lower(json_extract(u.descriptor_json,'$.format')))
 AND NOT EXISTS(SELECT 1 FROM shelf_storage_single_trial WHERE json_extract(descriptor_json,'$.fileId')=u.file_id OR json_extract(descriptor_json,'$.bookId')=u.book_id);

DROP TRIGGER shelf_storage_import_admit;
CREATE TRIGGER shelf_storage_import_admit BEFORE INSERT ON shelf_storage_reservations
WHEN EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND phase='imported') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_staging s WHERE s.reservation_id=NEW.reservation_id
 AND s.logical_key=NEW.logical_key AND s.object_key=NEW.object_key AND s.descriptor_json=NEW.descriptor_json
 AND s.size_bytes=NEW.size_bytes AND s.state=NEW.state AND s.etag IS NEW.etag
 AND NEW.put_attempted=1 AND NEW.content_verified=(s.state='confirmed')
 AND NEW.created_at=s.created_at AND NEW.updated_at=s.created_at)
 AND NOT EXISTS(SELECT 1 FROM shelf_isolated_upload_targets u JOIN shelf_storage_authority a ON a.id=1
 WHERE u.reservation_id=NEW.reservation_id AND u.policy_enabled=1 AND u.descriptor_json=NEW.descriptor_json
 AND NEW.logical_key=('original:production:'||u.file_id||':original') AND NEW.object_key=json_extract(u.descriptor_json,'$.objectKey')
 AND NEW.size_bytes=u.size_bytes AND NEW.state='reserved' AND NEW.put_attempted=0 AND NEW.content_verified=0 AND NEW.etag IS NULL
 AND NEW.created_at=u.created_at AND NEW.updated_at=NEW.created_at
 AND NEW.created_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) AND NEW.created_at>=CAST(unixepoch('subsec')*1000 AS INTEGER)-300000
 AND a.committed_bytes=COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state='confirmed'),0)
 AND a.reserved_bytes=COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state<>'confirmed'),0) AND a.committed_bytes+a.reserved_bytes+NEW.size_bytes<=u.budget_bytes)
 THEN RAISE(ABORT,'migration_unstaged_reservation') END;
END;
DROP TRIGGER shelf_storage_transition;
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
 AND NOT EXISTS(SELECT 1 FROM shelf_isolated_upload_targets u JOIN shelf_storage_authority a ON a.id=1
 WHERE u.reservation_id=OLD.reservation_id AND u.descriptor_json=OLD.descriptor_json AND u.size_bytes=OLD.size_bytes
 AND u.policy_enabled=1 AND OLD.state='reserved' AND OLD.put_attempted=0 AND NEW.put_attempted=1 AND NEW.content_verified=0 AND NEW.etag IS NULL
 AND a.committed_bytes=COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state='confirmed'),0)
 AND a.reserved_bytes=COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0)+COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state<>'confirmed'),0) AND a.committed_bytes+a.reserved_bytes<=u.budget_bytes)
 THEN RAISE(ABORT,'account_storage_stale') END;
END;
DROP TRIGGER shelf_storage_original_guard;
CREATE TRIGGER shelf_storage_original_guard BEFORE INSERT ON shelf_storage_original_registry BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shelf_storage_original_registry WHERE logical_key=NEW.logical_key OR reservation_id=NEW.reservation_id)
 THEN RAISE(ABORT,'storage_registry_immutable') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_reservations r JOIN shelf_storage_authority a ON a.id=1
 WHERE a.phase IN ('imported','ready') AND r.reservation_id=NEW.reservation_id AND r.logical_key=NEW.logical_key
 AND r.descriptor_json=NEW.descriptor_json AND r.etag=NEW.etag AND r.state='confirmed' AND r.content_verified=1
 AND json_extract(r.descriptor_json,'$.kind')='original'
 AND ((a.phase='ready' AND NEW.enabled=1) OR (a.phase='imported' AND EXISTS(
 SELECT 1 FROM shelf_storage_staging s WHERE s.reservation_id=NEW.reservation_id AND s.logical_key=NEW.logical_key
 AND s.descriptor_json=NEW.descriptor_json AND s.etag=NEW.etag AND s.enabled=NEW.enabled AND s.state='confirmed')) OR
 (a.phase='imported' AND NEW.enabled=1 AND r.put_attempted=1 AND EXISTS(SELECT 1 FROM shelf_isolated_upload_targets u
 WHERE u.reservation_id=r.reservation_id AND u.descriptor_json=r.descriptor_json AND u.size_bytes=r.size_bytes))))
 THEN RAISE(ABORT,'storage_registry_unverified') END;
END;
