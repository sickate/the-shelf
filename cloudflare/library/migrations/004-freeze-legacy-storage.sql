-- Apply to BOTH verified project D1 databases after base schema, then seed one
-- fixed identity row using the reviewed operator. No seed or remote write here.
CREATE TABLE shelf_storage_legacy_freeze (
 id INTEGER PRIMARY KEY CHECK(id=1), authority_id TEXT NOT NULL, account_id TEXT NOT NULL,
 bucket TEXT NOT NULL CHECK(bucket='the-shelf-books'), freeze_id TEXT NOT NULL UNIQUE, frozen_at INTEGER NOT NULL
);
CREATE TRIGGER shelf_legacy_marker_update BEFORE UPDATE ON shelf_storage_legacy_freeze BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_marker_delete BEFORE DELETE ON shelf_storage_legacy_freeze BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_state_insert BEFORE INSERT ON storage_state WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_state_update BEFORE UPDATE ON storage_state WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_state_delete BEFORE DELETE ON storage_state WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_reservation_insert BEFORE INSERT ON upload_reservations WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_reservation_update BEFORE UPDATE ON upload_reservations WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_reservation_delete BEFORE DELETE ON upload_reservations WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
-- Check has no authority tables: these projection attempts fail closed there.
-- Production accepts only the exact confirmed registry projection in the SAME D1.
CREATE TRIGGER shelf_legacy_registry_insert BEFORE INSERT ON file_registry WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_original_registry g JOIN shelf_storage_reservations r ON r.reservation_id=g.reservation_id JOIN shelf_storage_authority a ON a.id=1
 WHERE a.phase IN ('imported','ready') AND r.state='confirmed' AND r.content_verified=1 AND g.enabled=1
 AND json_extract(g.descriptor_json,'$.scope')=NEW.scope AND json_extract(g.descriptor_json,'$.fileId')=NEW.file_id
 AND json_extract(g.descriptor_json,'$.bookId')=NEW.book_id AND json_extract(g.descriptor_json,'$.format')=NEW.format
 AND json_extract(g.descriptor_json,'$.sizeBytes')=NEW.size_bytes AND json_extract(g.descriptor_json,'$.objectKey')=NEW.object_key
 AND json_extract(g.descriptor_json,'$.sha256')=NEW.sha256 AND g.etag=NEW.etag AND NEW.state='confirmed') THEN RAISE(ABORT,'legacy_storage_frozen') END;
END;
CREATE TRIGGER shelf_legacy_registry_update BEFORE UPDATE ON file_registry WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
CREATE TRIGGER shelf_legacy_registry_delete BEFORE DELETE ON file_registry WHEN EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1) BEGIN
 SELECT RAISE(ABORT,'legacy_storage_frozen');
END;
