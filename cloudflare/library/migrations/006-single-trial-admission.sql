-- Apply only while the business API is absent/disabled and auth enabled=0.
-- An interrupted/unknown replacement must never be followed by enabling the API.
-- Independently read back the complete exact trigger before deployment.
DROP TRIGGER admission_private;
CREATE TRIGGER admission_private BEFORE INSERT ON admissions WHEN NEW.kind IN ('access','metadata') BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sessions s JOIN auth_config a ON a.scope=s.scope
    WHERE s.scope=NEW.scope AND s.session_hash=NEW.session_hash AND s.revoked=0
      AND s.expires_at>NEW.created_at AND s.generation=NEW.generation
      AND a.generation=s.generation AND a.enabled=1
  ) THEN RAISE(ABORT,'library_session_invalid') END;
  SELECT CASE WHEN NEW.kind='access' AND NOT EXISTS (
    SELECT 1 FROM file_registry f WHERE f.scope=NEW.scope AND f.file_id=NEW.file_id
      AND f.state='confirmed' AND f.size_bytes>0 AND f.size_bytes<=20000000
  ) AND NOT EXISTS (
    SELECT 1 FROM shelf_storage_single_trial t JOIN catalog_books c
      ON c.scope='production' AND c.book_id=json_extract(t.descriptor_json,'$.bookId')
    JOIN json_each(c.public_json,'$.files') f
    WHERE NEW.scope='production' AND t.id=1 AND t.state='confirmed'
      AND t.put_attempted=1 AND t.content_verified=1 AND length(t.etag)>0
      AND t.consent_id='2026-10-23-first-book'
      AND json_extract(t.target_json,'$.bucket')='the-shelf-first-book-20261023'
      AND json_extract(t.target_json,'$.accountId')=json_extract(t.authority_identity_json,'$.accountId')
      AND json_extract(t.descriptor_json,'$.kind')='original'
      AND json_extract(t.descriptor_json,'$.scope')='production'
      AND json_extract(t.descriptor_json,'$.fileId')=NEW.file_id
      AND json_extract(t.descriptor_json,'$.format') IN ('PDF','EPUB')
      AND json_extract(t.descriptor_json,'$.sizeBytes')=t.size_bytes
      AND t.size_bytes BETWEEN 1 AND 20000000
      AND json_extract(f.value,'$.id')=NEW.file_id
      AND json_extract(f.value,'$.format')=json_extract(t.descriptor_json,'$.format')
      AND json_extract(f.value,'$.sizeBytes')=t.size_bytes
      AND json_extract(f.value,'$.status')='candidate'
  ) THEN RAISE(ABORT,'library_file_unavailable') END;
END;
