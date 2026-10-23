-- Only the existing verified production authority. This is its single additional
-- reservation, never a second balance. No seed, upload or readiness is implicit.
CREATE TABLE shelf_storage_single_trial (
 id INTEGER PRIMARY KEY CHECK(id=1), permit_id TEXT NOT NULL UNIQUE CHECK(length(permit_id) BETWEEN 1 AND 100 AND permit_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
 consent_id TEXT NOT NULL CHECK(consent_id='2026-10-23-first-book'),
 authority_identity_json TEXT NOT NULL CHECK(json_valid(authority_identity_json)),
 target_json TEXT NOT NULL CHECK(json_valid(target_json)), descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
 isolated_target_config_sha256 TEXT NOT NULL CHECK(length(isolated_target_config_sha256)=64 AND isolated_target_config_sha256 NOT GLOB '*[^a-f0-9]*'),
 size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes BETWEEN 1 AND 20000000),
 issued_at INTEGER NOT NULL CHECK(typeof(issued_at)='integer' AND issued_at>=0), expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>issued_at AND expires_at<=issued_at+86400000),
 state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uncertain','confirmed')),
 put_attempted INTEGER NOT NULL CHECK(typeof(put_attempted)='integer' AND put_attempted IN (0,1)), content_verified INTEGER NOT NULL CHECK(typeof(content_verified)='integer' AND content_verified IN (0,1)),
 etag TEXT, updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=0),
 CHECK((state='reserved' AND put_attempted=0 AND content_verified=0 AND etag IS NULL) OR
 (state IN ('uploading','uncertain') AND put_attempted=1 AND content_verified=0 AND etag IS NULL) OR
 (state='confirmed' AND put_attempted=1 AND content_verified=1 AND typeof(etag)='text' AND length(etag) BETWEEN 1 AND 256))
);
CREATE TRIGGER shelf_single_trial_admit BEFORE INSERT ON shelf_storage_single_trial BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shelf_storage_single_trial) OR NEW.state<>'reserved' OR NEW.put_attempted<>0 OR NEW.content_verified<>0 OR NEW.etag IS NOT NULL
 OR NEW.issued_at>CAST(unixepoch('subsec')*1000 AS INTEGER) OR NEW.issued_at<CAST(unixepoch('subsec')*1000 AS INTEGER)-300000
 OR NEW.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER) OR NEW.updated_at<>NEW.issued_at
 OR NOT EXISTS(SELECT 1 FROM shelf_storage_authority a WHERE a.id=1 AND a.phase='imported' AND a.identity_json=NEW.authority_identity_json
 AND length(a.migration_hash)=64 AND a.committed_bytes+a.reserved_bytes+NEW.size_bytes<=8000000000
 AND json_extract(NEW.target_json,'$.accountId') IS json_extract(a.identity_json,'$.accountId')
 AND json_extract(NEW.target_json,'$.bucket') IS 'the-shelf-first-book-20261023'
 AND json_extract(NEW.target_json,'$.bucket') IS NOT json_extract(a.identity_json,'$.bucket'))
 OR (SELECT count(*) FROM json_each(NEW.target_json))<>2
 OR (SELECT count(*) FROM json_each(NEW.descriptor_json))<>10
 OR json_extract(NEW.descriptor_json,'$.kind') IS NOT 'original' OR json_extract(NEW.descriptor_json,'$.scope') IS NOT 'production'
 OR json_extract(NEW.descriptor_json,'$.format') NOT IN ('PDF','EPUB') OR json_type(NEW.descriptor_json,'$.format') IS NOT 'text'
 OR json_type(NEW.descriptor_json,'$.sizeBytes') IS NOT 'integer' OR json_extract(NEW.descriptor_json,'$.sizeBytes') IS NOT NEW.size_bytes
 OR json_type(NEW.descriptor_json,'$.versionHash') IS NOT 'null' OR json_type(NEW.descriptor_json,'$.source') IS NOT 'null'
 OR json_type(NEW.descriptor_json,'$.fileId') IS NOT 'text' OR length(json_extract(NEW.descriptor_json,'$.fileId')) NOT BETWEEN 1 AND 100
 OR json_extract(NEW.descriptor_json,'$.fileId') GLOB '*[^a-zA-Z0-9_-]*'
 OR json_type(NEW.descriptor_json,'$.bookId') IS NOT 'text' OR length(json_extract(NEW.descriptor_json,'$.bookId')) NOT BETWEEN 1 AND 100
 OR json_extract(NEW.descriptor_json,'$.bookId') GLOB '*[^a-zA-Z0-9_-]*'
 OR json_type(NEW.descriptor_json,'$.sha256') IS NOT 'text' OR length(json_extract(NEW.descriptor_json,'$.sha256'))<>64
 OR json_extract(NEW.descriptor_json,'$.sha256') GLOB '*[^a-f0-9]*'
 OR json_extract(NEW.descriptor_json,'$.objectKey') IS NOT ('books/cf03/'||json_extract(NEW.descriptor_json,'$.fileId')||'/'||json_extract(NEW.descriptor_json,'$.sha256')||'.'||lower(json_extract(NEW.descriptor_json,'$.format')))
 THEN RAISE(ABORT,'single_trial_admission_invalid') END;
END;
CREATE TRIGGER shelf_single_trial_reserve AFTER INSERT ON shelf_storage_single_trial BEGIN
 UPDATE shelf_storage_authority SET reserved_bytes=reserved_bytes+NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER shelf_single_trial_transition BEFORE UPDATE ON shelf_storage_single_trial BEGIN
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.permit_id IS NOT OLD.permit_id OR NEW.consent_id IS NOT OLD.consent_id
 OR NEW.authority_identity_json IS NOT OLD.authority_identity_json OR NEW.target_json IS NOT OLD.target_json OR NEW.descriptor_json IS NOT OLD.descriptor_json
 OR NEW.isolated_target_config_sha256 IS NOT OLD.isolated_target_config_sha256 OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
 OR NEW.updated_at<OLD.updated_at OR NOT ((OLD.state='reserved' AND NEW.state='uploading' AND NEW.put_attempted=1 AND NEW.content_verified=0 AND NEW.etag IS NULL
 AND OLD.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) OR
 (OLD.state IN ('uploading','uncertain') AND NEW.state='uncertain' AND NEW.put_attempted=1 AND NEW.content_verified=0 AND NEW.etag IS NULL) OR
 (OLD.state IN ('uploading','uncertain') AND NEW.state='confirmed' AND NEW.put_attempted=1 AND NEW.content_verified=1 AND length(NEW.etag) BETWEEN 1 AND 256))
 THEN RAISE(ABORT,'single_trial_transition_invalid') END;
END;
CREATE TRIGGER shelf_single_trial_confirm AFTER UPDATE OF state ON shelf_storage_single_trial WHEN NEW.state='confirmed' BEGIN
 UPDATE shelf_storage_authority SET reserved_bytes=reserved_bytes-NEW.size_bytes,committed_bytes=committed_bytes+NEW.size_bytes WHERE id=1;
END;
CREATE TRIGGER shelf_single_trial_retain BEFORE DELETE ON shelf_storage_single_trial BEGIN
 SELECT RAISE(ABORT,'single_trial_retained');
END;
CREATE TRIGGER shelf_single_trial_keep_imported BEFORE UPDATE OF phase ON shelf_storage_authority
WHEN EXISTS(SELECT 1 FROM shelf_storage_single_trial) AND NEW.phase<>OLD.phase BEGIN
 SELECT RAISE(ABORT,'single_trial_keeps_imported');
END;
