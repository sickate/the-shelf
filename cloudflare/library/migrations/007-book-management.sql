-- Additive migration. Apply before deploying management-capable Worker; retain on rollback.
CREATE TABLE IF NOT EXISTS book_management (
 scope TEXT NOT NULL, book_id TEXT NOT NULL,
 visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private')),
 trashed INTEGER NOT NULL DEFAULT 0 CHECK(trashed IN (0,1)),
 version INTEGER NOT NULL CHECK(version>=1), updated_at INTEGER NOT NULL,
 PRIMARY KEY(scope,book_id), FOREIGN KEY(scope,book_id) REFERENCES catalog_books(scope,book_id)
);
CREATE TABLE IF NOT EXISTS browser_uploads (
 upload_id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope='production'),
 book_id TEXT NOT NULL, file_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
 reservation_id TEXT NOT NULL UNIQUE, descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
 created_at INTEGER NOT NULL, UNIQUE(scope,sha256),
 FOREIGN KEY(scope,book_id) REFERENCES catalog_books(scope,book_id)
);
CREATE TRIGGER IF NOT EXISTS book_management_insert AFTER INSERT ON book_management BEGIN
 UPDATE public_state SET revision=revision+1,updated_at=NEW.updated_at WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS book_management_update AFTER UPDATE ON book_management BEGIN
 UPDATE public_state SET revision=revision+1,updated_at=NEW.updated_at WHERE scope=NEW.scope;
END;
CREATE TRIGGER IF NOT EXISTS book_management_retain BEFORE DELETE ON book_management BEGIN
 SELECT RAISE(ABORT,'library_management_retained');
END;
CREATE TRIGGER IF NOT EXISTS browser_upload_retain BEFORE DELETE ON browser_uploads BEGIN
 SELECT RAISE(ABORT,'library_upload_retained');
END;
CREATE TRIGGER IF NOT EXISTS book_management_access BEFORE INSERT ON admissions
WHEN NEW.kind='access' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM file_registry f JOIN book_management m ON m.scope=f.scope AND m.book_id=f.book_id
 WHERE f.scope=NEW.scope AND f.file_id=NEW.file_id AND m.trashed=1)
 THEN RAISE(ABORT,'library_file_unavailable') END;
END;
