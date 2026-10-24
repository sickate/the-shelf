-- Private reading projection only. Never changes the storage authority or budget.
-- Requires base schema, 003 and 007; apply separately after review, not implicitly.
CREATE TABLE shelf_prepared_indexes (
 scope TEXT NOT NULL CHECK(scope='production'),
 file_id TEXT NOT NULL, version_hash TEXT NOT NULL, book_id TEXT NOT NULL,
 text_reservation_id TEXT NOT NULL UNIQUE REFERENCES shelf_storage_reservations(reservation_id),
 text_logical_key TEXT NOT NULL UNIQUE REFERENCES shelf_storage_text_registry(logical_key),
 package_sha256 TEXT NOT NULL CHECK(length(package_sha256)=64 AND package_sha256 NOT GLOB '*[^a-f0-9]*'),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
 etag TEXT NOT NULL CHECK(length(etag) BETWEEN 1 AND 128),
 format TEXT NOT NULL CHECK(format IN ('PDF','EPUB')),
 chunk_count INTEGER NOT NULL CHECK(typeof(chunk_count)='integer' AND chunk_count BETWEEN 1 AND 20000),
 text_bytes INTEGER NOT NULL CHECK(typeof(text_bytes)='integer' AND text_bytes BETWEEN 1 AND 20000000),
 codepoint_count INTEGER NOT NULL CHECK(typeof(codepoint_count)='integer' AND codepoint_count BETWEEN 1 AND 20000000),
 index_sha256 TEXT NOT NULL CHECK(length(index_sha256)=64 AND index_sha256 NOT GLOB '*[^a-f0-9]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 PRIMARY KEY(scope,file_id,version_hash)
);
CREATE TABLE shelf_prepared_index_chunks (
 scope TEXT NOT NULL, file_id TEXT NOT NULL, version_hash TEXT NOT NULL,
 chunk_index INTEGER NOT NULL CHECK(typeof(chunk_index)='integer' AND chunk_index BETWEEN 0 AND 19999),
 locator_type TEXT NOT NULL CHECK(locator_type IN ('pdf-page','epub-spine')),
 section_number INTEGER NOT NULL CHECK(typeof(section_number)='integer' AND section_number BETWEEN 0 AND 20000000),
 start_offset INTEGER NOT NULL CHECK(typeof(start_offset)='integer' AND start_offset BETWEEN 0 AND 20000000 AND start_offset%6000=0),
 end_offset INTEGER NOT NULL CHECK(typeof(end_offset)='integer' AND end_offset>start_offset AND end_offset<=20000000),
 chunk_sha256 TEXT NOT NULL CHECK(length(chunk_sha256)=64 AND chunk_sha256 NOT GLOB '*[^a-f0-9]*'),
 codepoints INTEGER NOT NULL CHECK(typeof(codepoints)='integer' AND codepoints BETWEEN 1 AND 6000 AND codepoints=end_offset-start_offset),
 utf8_bytes INTEGER NOT NULL CHECK(typeof(utf8_bytes)='integer' AND utf8_bytes BETWEEN codepoints AND codepoints*4),
 PRIMARY KEY(scope,file_id,version_hash,chunk_index),
 FOREIGN KEY(scope,file_id,version_hash) REFERENCES shelf_prepared_indexes(scope,file_id,version_hash)
);
CREATE TABLE shelf_prepared_index_publications (
 scope TEXT NOT NULL, file_id TEXT NOT NULL, version_hash TEXT NOT NULL,
 index_sha256 TEXT NOT NULL,
 chunk_count INTEGER NOT NULL CHECK(typeof(chunk_count)='integer' AND chunk_count BETWEEN 1 AND 20000),
 text_bytes INTEGER NOT NULL CHECK(typeof(text_bytes)='integer' AND text_bytes BETWEEN 1 AND 20000000),
 codepoint_count INTEGER NOT NULL CHECK(typeof(codepoint_count)='integer' AND codepoint_count BETWEEN 1 AND 20000000),
 PRIMARY KEY(scope,file_id,version_hash),
 FOREIGN KEY(scope,file_id,version_hash) REFERENCES shelf_prepared_indexes(scope,file_id,version_hash)
);
CREATE TRIGGER shelf_prepared_index_insert BEFORE INSERT ON shelf_prepared_indexes BEGIN
 SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM shelf_storage_text_registry t
 JOIN shelf_storage_reservations r ON r.reservation_id=t.reservation_id
 JOIN shelf_storage_original_registry o ON o.enabled=1
 JOIN shelf_storage_reservations original ON original.reservation_id=o.reservation_id
 JOIN file_registry f ON f.scope=NEW.scope AND f.file_id=NEW.file_id AND f.book_id=NEW.book_id AND f.state='confirmed'
 JOIN catalog_books b ON b.scope=NEW.scope AND b.book_id=NEW.book_id
 WHERE t.logical_key=NEW.text_logical_key AND t.reservation_id=NEW.text_reservation_id AND t.enabled=1
 AND r.state='confirmed' AND r.content_verified=1 AND r.descriptor_json=t.descriptor_json AND r.etag=t.etag AND t.etag=NEW.etag
 AND json_extract(t.descriptor_json,'$.kind')='prepared-text'
 AND json_extract(t.descriptor_json,'$.scope')=NEW.scope
 AND json_extract(t.descriptor_json,'$.fileId')=NEW.file_id
 AND json_extract(t.descriptor_json,'$.bookId')=NEW.book_id
 AND json_extract(t.descriptor_json,'$.versionHash')=NEW.version_hash
 AND json_extract(t.descriptor_json,'$.source.fileId')=NEW.file_id
 AND json_extract(t.descriptor_json,'$.source.bookId')=NEW.book_id
 AND json_extract(t.descriptor_json,'$.source.versionHash')=NEW.version_hash
 AND json_extract(t.descriptor_json,'$.sha256')=NEW.package_sha256
 AND json_extract(t.descriptor_json,'$.source.sourceSha256')=NEW.source_sha256
 AND json_extract(t.descriptor_json,'$.source.format')=NEW.format
 AND original.state='confirmed' AND original.content_verified=1 AND original.descriptor_json=o.descriptor_json AND original.etag=o.etag
 AND json_extract(o.descriptor_json,'$.kind')='original'
 AND json_extract(o.descriptor_json,'$.scope')=NEW.scope
 AND json_extract(o.descriptor_json,'$.fileId')=NEW.file_id
 AND json_extract(o.descriptor_json,'$.bookId')=NEW.book_id
 AND json_extract(o.descriptor_json,'$.sha256')=NEW.source_sha256
 AND json_extract(o.descriptor_json,'$.format')=NEW.format
 AND f.object_key=json_extract(o.descriptor_json,'$.objectKey') AND f.etag=o.etag AND f.sha256=NEW.source_sha256
 AND f.size_bytes=json_extract(o.descriptor_json,'$.sizeBytes') AND f.format=NEW.format
 AND json_extract(t.descriptor_json,'$.source.sizeBytes')=f.size_bytes
 AND EXISTS(SELECT 1 FROM json_each(b.public_json,'$.files') j WHERE json_extract(j.value,'$.id')=f.file_id
 AND json_extract(j.value,'$.format')=f.format AND json_extract(j.value,'$.sizeBytes')=f.size_bytes AND json_extract(j.value,'$.status')='candidate')
 AND NOT EXISTS(SELECT 1 FROM book_management m WHERE m.scope=NEW.scope AND m.book_id=NEW.book_id AND m.trashed=1)
 ) THEN RAISE(ABORT,'prepared_source_unavailable') END;
END;
CREATE TRIGGER shelf_prepared_chunk_insert BEFORE INSERT ON shelf_prepared_index_chunks BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shelf_prepared_index_publications p WHERE p.scope=NEW.scope AND p.file_id=NEW.file_id AND p.version_hash=NEW.version_hash)
 OR NOT EXISTS(SELECT 1 FROM shelf_prepared_indexes i WHERE i.scope=NEW.scope AND i.file_id=NEW.file_id AND i.version_hash=NEW.version_hash
 AND NEW.chunk_index<i.chunk_count AND ((i.format='PDF' AND NEW.locator_type='pdf-page' AND NEW.section_number>=1) OR (i.format='EPUB' AND NEW.locator_type='epub-spine' AND NEW.section_number<=9999)))
 THEN RAISE(ABORT,'prepared_index_invalid') END;
END;
CREATE TRIGGER shelf_prepared_publication_insert BEFORE INSERT ON shelf_prepared_index_publications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_prepared_indexes i WHERE i.scope=NEW.scope AND i.file_id=NEW.file_id AND i.version_hash=NEW.version_hash
 AND i.index_sha256=NEW.index_sha256 AND i.chunk_count=NEW.chunk_count AND i.text_bytes=NEW.text_bytes AND i.codepoint_count=NEW.codepoint_count
 AND (SELECT count(*) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash)=i.chunk_count
 AND (SELECT min(chunk_index) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash)=0
 AND (SELECT max(chunk_index) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash)=i.chunk_count-1
 AND (SELECT sum(utf8_bytes) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash)=i.text_bytes
 AND (SELECT sum(codepoints) FROM shelf_prepared_index_chunks c WHERE c.scope=i.scope AND c.file_id=i.file_id AND c.version_hash=i.version_hash)=i.codepoint_count)
 THEN RAISE(ABORT,'prepared_index_incomplete') END;
END;
CREATE TRIGGER shelf_prepared_index_update BEFORE UPDATE ON shelf_prepared_indexes BEGIN SELECT RAISE(ABORT,'prepared_index_immutable'); END;
CREATE TRIGGER shelf_prepared_index_delete BEFORE DELETE ON shelf_prepared_indexes BEGIN SELECT RAISE(ABORT,'prepared_index_immutable'); END;
CREATE TRIGGER shelf_prepared_chunks_update BEFORE UPDATE ON shelf_prepared_index_chunks BEGIN SELECT RAISE(ABORT,'prepared_index_immutable'); END;
CREATE TRIGGER shelf_prepared_chunks_delete BEFORE DELETE ON shelf_prepared_index_chunks BEGIN SELECT RAISE(ABORT,'prepared_index_immutable'); END;
CREATE TRIGGER shelf_prepared_publication_update BEFORE UPDATE ON shelf_prepared_index_publications BEGIN SELECT RAISE(ABORT,'prepared_index_immutable'); END;
CREATE TRIGGER shelf_prepared_publication_delete BEFORE DELETE ON shelf_prepared_index_publications BEGIN SELECT RAISE(ABORT,'prepared_index_immutable'); END;
CREATE VIEW shelf_prepared_readable_sources AS
 SELECT i.*,t.descriptor_json,a.identity_json,COALESCE(m.version,0) AS management_version,
 o.descriptor_json AS original_descriptor_json,o.etag AS original_etag,
 f.object_key AS original_object_key,f.sha256 AS original_sha256,f.size_bytes AS original_size_bytes,f.format AS original_format,
 f.version AS original_version,b.public_json AS original_catalog_json
 FROM shelf_prepared_indexes i
 JOIN shelf_prepared_index_publications p ON p.scope=i.scope AND p.file_id=i.file_id AND p.version_hash=i.version_hash
 JOIN shelf_storage_text_registry t ON t.logical_key=i.text_logical_key AND t.reservation_id=i.text_reservation_id AND t.enabled=1
 JOIN shelf_storage_reservations r ON r.reservation_id=t.reservation_id AND r.state='confirmed' AND r.content_verified=1 AND r.descriptor_json=t.descriptor_json AND r.etag=t.etag
 JOIN shelf_storage_original_registry o ON o.enabled=1
 JOIN shelf_storage_reservations original ON original.reservation_id=o.reservation_id AND original.state='confirmed' AND original.content_verified=1 AND original.descriptor_json=o.descriptor_json AND original.etag=o.etag
 JOIN file_registry f ON f.scope=i.scope AND f.file_id=i.file_id AND f.book_id=i.book_id AND f.state='confirmed'
 JOIN catalog_books b ON b.scope=i.scope AND b.book_id=i.book_id
 JOIN shelf_storage_authority a ON a.id=1
 LEFT JOIN book_management m ON m.scope=i.scope AND m.book_id=i.book_id
 WHERE COALESCE(m.trashed,0)=0
 AND p.index_sha256=i.index_sha256 AND p.chunk_count=i.chunk_count AND p.text_bytes=i.text_bytes AND p.codepoint_count=i.codepoint_count
 AND t.etag=i.etag AND json_extract(t.descriptor_json,'$.kind')='prepared-text'
 AND json_extract(t.descriptor_json,'$.scope')=i.scope AND json_extract(t.descriptor_json,'$.fileId')=i.file_id
 AND json_extract(t.descriptor_json,'$.bookId')=i.book_id AND json_extract(t.descriptor_json,'$.versionHash')=i.version_hash
 AND json_extract(t.descriptor_json,'$.source.fileId')=i.file_id AND json_extract(t.descriptor_json,'$.source.bookId')=i.book_id
 AND json_extract(t.descriptor_json,'$.source.versionHash')=i.version_hash
 AND json_extract(t.descriptor_json,'$.sha256')=i.package_sha256 AND json_extract(t.descriptor_json,'$.source.sourceSha256')=i.source_sha256
 AND json_extract(t.descriptor_json,'$.source.format')=i.format
 AND json_extract(o.descriptor_json,'$.kind')='original' AND json_extract(o.descriptor_json,'$.scope')=i.scope
 AND json_extract(o.descriptor_json,'$.fileId')=i.file_id AND json_extract(o.descriptor_json,'$.bookId')=i.book_id
 AND json_extract(o.descriptor_json,'$.sha256')=i.source_sha256 AND json_extract(o.descriptor_json,'$.format')=i.format
 AND f.object_key=json_extract(o.descriptor_json,'$.objectKey') AND f.etag=o.etag AND f.sha256=i.source_sha256
 AND f.size_bytes=json_extract(o.descriptor_json,'$.sizeBytes') AND f.size_bytes=json_extract(t.descriptor_json,'$.source.sizeBytes') AND f.format=i.format
 AND EXISTS(SELECT 1 FROM json_each(b.public_json,'$.files') j WHERE json_extract(j.value,'$.id')=f.file_id
 AND json_extract(j.value,'$.format')=f.format AND json_extract(j.value,'$.sizeBytes')=f.size_bytes AND json_extract(j.value,'$.status')='candidate');
