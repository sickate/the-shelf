-- CF-03 dedicated project D1 only; main operator verifies check/production target.
-- Stop upload CLI admissions before applying BOTH statements as a reviewed D1
-- batch. Verify reserve_upload in sqlite_master before admitting more uploads.
-- No storage counters, reservations, registry rows or other triggers are reset.
DROP TRIGGER IF EXISTS reserve_upload;
CREATE TRIGGER reserve_upload BEFORE INSERT ON upload_reservations BEGIN
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
