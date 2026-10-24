-- Independent imported -> ready activation. No upload, new balance or proof seed.
-- Historical migration files remain unchanged. Install only on fixed production D1.
SELECT json(CASE WHEN (SELECT count(*) FROM shelf_storage_authority)=1
 AND EXISTS(SELECT 1 FROM shelf_storage_authority WHERE id=1 AND phase='imported'
 AND length(migration_hash)=64 AND length(readback_hash)=64 AND receipt_json IS NOT NULL)
 THEN 'null' ELSE 'storage_v2_imported_required' END);
-- First durable change: even interrupted installation cannot expose old readiness.
CREATE TRIGGER shelf_storage_v2_phase_gate BEFORE UPDATE OF phase ON shelf_storage_authority
WHEN NEW.phase IS NOT OLD.phase BEGIN
 SELECT CASE WHEN NOT (OLD.phase='imported' AND NEW.phase='ready' AND EXISTS(
  SELECT 1 FROM shelf_storage_activation_v2 v WHERE v.id=1 AND v.state='active' AND v.generation=1
  AND v.identity_json=OLD.identity_json AND v.migration_hash=OLD.migration_hash
  AND NEW.receipt_json=v.receipt_json AND NEW.readback_hash=json_extract(v.receipt_json,'$.snapshotSha256')))
 THEN RAISE(ABORT,'storage_v2_activation_required') END;
END;
CREATE TABLE shelf_storage_activation_v2 (
 id INTEGER PRIMARY KEY CHECK(id=1), identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 migration_hash TEXT NOT NULL CHECK(length(migration_hash)=64),
 imported_receipt_json TEXT NOT NULL CHECK(json_valid(imported_receipt_json)),
 imported_readback_hash TEXT NOT NULL CHECK(length(imported_readback_hash)=64),
 state TEXT NOT NULL CHECK(state IN ('closed','active')), generation INTEGER NOT NULL CHECK(generation IN (0,1)),
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)), receipt_hash TEXT,
 evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)), evidence_hash TEXT, activated_at INTEGER,
 CHECK((state='closed' AND generation=0 AND snapshot_json IS NULL AND receipt_json IS NULL AND receipt_hash IS NULL
  AND evidence_json IS NULL AND evidence_hash IS NULL AND activated_at IS NULL) OR
 (state='active' AND generation=1 AND snapshot_json IS NOT NULL AND receipt_json IS NOT NULL AND length(receipt_hash)=64
  AND evidence_json IS NOT NULL AND length(evidence_hash)=64 AND typeof(activated_at)='integer'))
);
CREATE TRIGGER shelf_storage_v2_initial BEFORE INSERT ON shelf_storage_activation_v2 BEGIN
 SELECT CASE WHEN NEW.state<>'closed' OR NEW.generation<>0 OR EXISTS(SELECT 1 FROM shelf_storage_activation_v2)
 OR NOT EXISTS(SELECT 1 FROM shelf_storage_authority a WHERE a.id=1 AND a.phase='imported'
 AND a.identity_json=NEW.identity_json AND a.migration_hash=NEW.migration_hash
 AND a.receipt_json=NEW.imported_receipt_json AND a.readback_hash=NEW.imported_readback_hash)
 THEN RAISE(ABORT,'storage_v2_imported_required') END;
END;
INSERT INTO shelf_storage_activation_v2(id,identity_json,migration_hash,imported_receipt_json,imported_readback_hash,state,generation)
 SELECT id,identity_json,migration_hash,receipt_json,readback_hash,'closed',0 FROM shelf_storage_authority WHERE id=1;
CREATE TABLE shelf_storage_activation_receipts_v2 (
 receipt_hash TEXT PRIMARY KEY CHECK(length(receipt_hash)=64), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE shelf_storage_evidence_v2 (
 evidence_hash TEXT PRIMARY KEY CHECK(length(evidence_hash)=64), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
);
CREATE TABLE shelf_storage_legacy_liabilities_v2 (
 source_id TEXT PRIMARY KEY CHECK(length(source_id) BETWEEN 1 AND 100),
 source_hash TEXT NOT NULL CHECK(length(source_hash)=64), proof_hash TEXT NOT NULL CHECK(length(proof_hash)=64),
 max_bytes INTEGER NOT NULL CHECK(typeof(max_bytes)='integer' AND max_bytes BETWEEN 1 AND 8000000000),
 class_a_max INTEGER NOT NULL CHECK(typeof(class_a_max)='integer' AND class_a_max>=0),
 class_b_max INTEGER NOT NULL CHECK(typeof(class_b_max)='integer' AND class_b_max>=0)
);
CREATE TRIGGER shelf_storage_v2_liability_admit BEFORE INSERT ON shelf_storage_legacy_liabilities_v2 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_activation_v2 v JOIN shelf_storage_authority a ON a.id=v.id
 WHERE v.id=1 AND v.state='closed' AND v.generation=0 AND a.phase='imported'
 AND a.identity_json=v.identity_json AND a.committed_bytes+a.reserved_bytes+NEW.max_bytes<=8000000000)
 THEN RAISE(ABORT,'storage_v2_liability_invalid') END;
END;
CREATE TRIGGER shelf_storage_v2_liability_account AFTER INSERT ON shelf_storage_legacy_liabilities_v2 BEGIN
 UPDATE shelf_storage_authority SET reserved_bytes=reserved_bytes+NEW.max_bytes WHERE id=1;
END;
CREATE TRIGGER shelf_storage_v2_liability_update BEFORE UPDATE ON shelf_storage_legacy_liabilities_v2 BEGIN SELECT RAISE(ABORT,'storage_v2_retained'); END;
CREATE TRIGGER shelf_storage_v2_liability_delete BEFORE DELETE ON shelf_storage_legacy_liabilities_v2 BEGIN SELECT RAISE(ABORT,'storage_v2_retained'); END;
CREATE VIEW shelf_storage_responsibility_v2 AS SELECT
 COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state='confirmed'),0) AS normal_committed,
 COALESCE((SELECT sum(size_bytes) FROM shelf_storage_reservations WHERE state<>'confirmed'),0) AS normal_reserved,
 COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state='confirmed'),0) AS trial_committed,
 COALESCE((SELECT sum(size_bytes) FROM shelf_storage_single_trial WHERE state<>'confirmed'),0) AS trial_reserved,
 COALESCE((SELECT sum(max_bytes) FROM shelf_storage_legacy_liabilities_v2),0) AS legacy_reserved;
CREATE VIEW shelf_storage_snapshot_v2 AS SELECT json_object(
 'authority',json_object('identity',identity_json,'phase',phase,'migrationHash',migration_hash,
 'committed',committed_bytes,'reserved',reserved_bytes,'receipt',receipt_json,'readback',readback_hash,
 'observedBytes',observed_bytes,'observedAt',observed_at,'evidenceHash',evidence_hash,'billingPeriod',billing_period),
 'sources',json((SELECT json_group_array(json_object('scope',scope,'migrationHash',migration_hash,'snapshotHash',snapshot_hash,
 'metadata',metadata_json,'freezeProof',freeze_proof_json,'reservations',reservation_count,'registry',registry_count,'committed',committed_bytes,'reserved',reserved_bytes)) FROM (SELECT * FROM shelf_storage_sources ORDER BY scope))),
 'staging',json((SELECT json_group_array(json_object('id',reservation_id,'logical',logical_key,'key',object_key,'descriptor',descriptor_json,'size',size_bytes,'state',state,'etag',etag,'enabled',enabled,'created',created_at)) FROM (SELECT * FROM shelf_storage_staging ORDER BY reservation_id))),
 'reservations',json((SELECT json_group_array(json_object('id',reservation_id,'logical',logical_key,'key',object_key,'descriptor',descriptor_json,'size',size_bytes,'state',state,'attempted',put_attempted,'verified',content_verified,'etag',etag,'created',created_at,'updated',updated_at)) FROM (SELECT * FROM shelf_storage_reservations ORDER BY reservation_id))),
 'original',json((SELECT json_group_array(json_object('logical',logical_key,'id',reservation_id,'descriptor',descriptor_json,'etag',etag,'enabled',enabled)) FROM (SELECT * FROM shelf_storage_original_registry ORDER BY logical_key))),
 'text',json((SELECT json_group_array(json_object('logical',logical_key,'id',reservation_id,'descriptor',descriptor_json,'etag',etag,'enabled',enabled)) FROM (SELECT * FROM shelf_storage_text_registry ORDER BY logical_key))),
 'projection',json((SELECT json_group_array(json_object('scope',scope,'file',file_id,'book',book_id,'format',format,'size',size_bytes,'key',object_key,'hash',sha256,'etag',etag,'state',state,'version',version,'updated',updated_at)) FROM (SELECT * FROM file_registry ORDER BY scope,file_id))),
 'trial',json((SELECT json_group_array(json_object('id',id,'permit',permit_id,'consent',consent_id,'identity',authority_identity_json,'target',target_json,'descriptor',descriptor_json,'targetHash',isolated_target_config_sha256,'size',size_bytes,'issued',issued_at,'expires',expires_at,'state',state,'attempted',put_attempted,'verified',content_verified,'etag',etag,'updated',updated_at)) FROM (SELECT * FROM shelf_storage_single_trial ORDER BY id))),
 'legacy',json((SELECT json_group_array(json_object('source',source_id,'sourceHash',source_hash,'proofHash',proof_hash,'bytes',max_bytes,'classA',class_a_max,'classB',class_b_max)) FROM (SELECT * FROM shelf_storage_legacy_liabilities_v2 ORDER BY source_id))),
 'freeze',json((SELECT json_group_array(json_object('id',id,'authority',authority_id,'account',account_id,'bucket',bucket,'freezeId',freeze_id,'frozenAt',frozen_at)) FROM (SELECT * FROM shelf_storage_legacy_freeze ORDER BY id)))
 ) AS snapshot_json FROM shelf_storage_authority WHERE id=1;
CREATE TRIGGER shelf_storage_v2_accounting BEFORE UPDATE ON shelf_storage_authority BEGIN
 SELECT CASE WHEN NEW.committed_bytes<>(SELECT normal_committed+trial_committed FROM shelf_storage_responsibility_v2)
 OR NEW.reserved_bytes<>(SELECT normal_reserved+trial_reserved+legacy_reserved FROM shelf_storage_responsibility_v2)
 THEN RAISE(ABORT,'storage_v2_accounting_mismatch') END;
END;
-- Receipt and evidence can only be published by the successful activation transaction.
CREATE TRIGGER shelf_storage_v2_receipt_admit BEFORE INSERT ON shelf_storage_activation_receipts_v2 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_activation_v2 WHERE id=1 AND state='active' AND generation=1
 AND receipt_hash=NEW.receipt_hash AND receipt_json=NEW.receipt_json AND snapshot_json=NEW.snapshot_json)
 THEN RAISE(ABORT,'storage_v2_receipt_unbound') END;
END;
CREATE TRIGGER shelf_storage_v2_evidence_admit BEFORE INSERT ON shelf_storage_evidence_v2 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_activation_v2 WHERE id=1 AND state='active' AND generation=1
 AND evidence_hash=NEW.evidence_hash AND evidence_json=NEW.evidence_json)
 THEN RAISE(ABORT,'storage_v2_evidence_unbound') END;
END;
CREATE TRIGGER shelf_storage_v2_receipt_update BEFORE UPDATE ON shelf_storage_activation_receipts_v2 BEGIN SELECT RAISE(ABORT,'storage_v2_retained'); END;
CREATE TRIGGER shelf_storage_v2_receipt_delete BEFORE DELETE ON shelf_storage_activation_receipts_v2 BEGIN SELECT RAISE(ABORT,'storage_v2_retained'); END;
CREATE TRIGGER shelf_storage_v2_evidence_update BEFORE UPDATE ON shelf_storage_evidence_v2 BEGIN SELECT RAISE(ABORT,'storage_v2_retained'); END;
CREATE TRIGGER shelf_storage_v2_evidence_delete BEFORE DELETE ON shelf_storage_evidence_v2 BEGIN SELECT RAISE(ABORT,'storage_v2_retained'); END;
CREATE TRIGGER shelf_storage_v2_activation_delete BEFORE DELETE ON shelf_storage_activation_v2 BEGIN SELECT RAISE(ABORT,'storage v2 retained'); END;
CREATE TRIGGER shelf_storage_v2_activate_guard BEFORE UPDATE ON shelf_storage_activation_v2 BEGIN
 SELECT CASE WHEN OLD.state<>'closed' OR OLD.generation<>0 OR NEW.state<>'active' OR NEW.generation<>1
 OR NEW.id IS NOT OLD.id OR NEW.identity_json IS NOT OLD.identity_json OR NEW.migration_hash IS NOT OLD.migration_hash
 OR NEW.imported_receipt_json IS NOT OLD.imported_receipt_json OR NEW.imported_readback_hash IS NOT OLD.imported_readback_hash
 OR NOT EXISTS(SELECT 1 FROM shelf_storage_authority a WHERE a.id=1 AND a.phase='imported'
 AND a.identity_json=OLD.identity_json AND a.migration_hash=OLD.migration_hash
 AND a.receipt_json=OLD.imported_receipt_json AND a.readback_hash=OLD.imported_readback_hash)
 OR NEW.snapshot_json IS NOT (SELECT snapshot_json FROM shelf_storage_snapshot_v2)
 OR json_extract(NEW.receipt_json,'$.schemaVersion') IS NOT 2
 OR json_extract(NEW.receipt_json,'$.verificationScope') IS NOT 'activation-at-imported'
 OR json_extract(NEW.receipt_json,'$.migrationHash') IS NOT OLD.migration_hash
 OR length(json_extract(NEW.receipt_json,'$.identitySha256')) IS NOT 64
 OR length(json_extract(NEW.receipt_json,'$.snapshotSha256')) IS NOT 64
 OR length(json_extract(NEW.receipt_json,'$.schemaSha256')) IS NOT 64
 OR json_extract(NEW.receipt_json,'$.schemaSha256') IS NOT (SELECT json_extract(NEW.receipt_json,'$.verifiedSchemaSha256'))
 OR json_extract(NEW.receipt_json,'$.committedBytes') IS NOT (SELECT normal_committed+trial_committed FROM shelf_storage_responsibility_v2)
 OR json_extract(NEW.receipt_json,'$.reservedBytes') IS NOT (SELECT normal_reserved+trial_reserved+legacy_reserved FROM shelf_storage_responsibility_v2)
 OR json_extract(NEW.receipt_json,'$.legacySafety.method') IS NOT 'complete-terminal-closure'
 OR json_extract(NEW.receipt_json,'$.legacySafety.evidenceKind') NOT IN ('enforced-transport-deadline','complete-persisted-terminal-set')
 OR json_type(NEW.receipt_json,'$.legacySafety.evidenceKind') IS NOT 'text'
 OR length(json_extract(NEW.receipt_json,'$.legacySafety.evidenceSha256')) IS NOT 64
 OR json_extract(NEW.receipt_json,'$.legacySafety.identitySha256') IS NOT json_extract(NEW.receipt_json,'$.identitySha256')
 OR json_extract(NEW.receipt_json,'$.legacySafety.snapshotSha256') IS NOT json_extract(NEW.receipt_json,'$.snapshotSha256')
 OR json_type(NEW.receipt_json,'$.legacySafety.verifiedAt') IS NOT 'integer'
 OR json_extract(NEW.receipt_json,'$.legacySafety.verifiedAt')>NEW.activated_at
 OR json_extract(NEW.receipt_json,'$.legacySafety.verifiedAt')<NEW.activated_at-300000
 OR json_type(NEW.receipt_json,'$.legacySafety.allPossibleWritesTerminal') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.legacySafety.databaseWriteFreezeProven') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.legacySafety.sourceProjectionVerified') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.legacySafety.legacyEntryPointsDisabled') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.legacySafety.legacyProcessesStopped') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.legacySafety.legacyConnectionsClosed') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.legacySafety.probeWriteCapabilityDisabled') IS NOT 'true'
 OR (json_extract(NEW.receipt_json,'$.legacySafety.evidenceKind')='complete-persisted-terminal-set' AND (
 length(json_extract(NEW.receipt_json,'$.legacySafety.details.versionSetSha256')) IS NOT 64
 OR length(json_extract(NEW.receipt_json,'$.legacySafety.details.durableLedgerSha256')) IS NOT 64
 OR json_type(NEW.receipt_json,'$.legacySafety.details.possibleWrites') IS NOT 'integer'
 OR json_extract(NEW.receipt_json,'$.legacySafety.details.possibleWrites')<0
 OR json_extract(NEW.receipt_json,'$.legacySafety.details.terminalWrites') IS NOT json_extract(NEW.receipt_json,'$.legacySafety.details.possibleWrites')
 OR json_type(NEW.receipt_json,'$.legacySafety.details.coverageComplete') IS NOT 'true'))
 OR (json_extract(NEW.receipt_json,'$.legacySafety.evidenceKind')='enforced-transport-deadline' AND (
 length(json_extract(NEW.receipt_json,'$.legacySafety.details.configurationSha256')) IS NOT 64
 OR json_type(NEW.receipt_json,'$.legacySafety.details.maxRequestLifetimeMs') IS NOT 'integer'
 OR json_extract(NEW.receipt_json,'$.legacySafety.details.maxRequestLifetimeMs')<1
 OR json_type(NEW.receipt_json,'$.legacySafety.details.stoppedAt') IS NOT 'integer'
 OR json_extract(NEW.receipt_json,'$.legacySafety.details.stoppedAt')<0
 OR json_type(NEW.receipt_json,'$.legacySafety.details.drainedAt') IS NOT 'integer'
 OR json_extract(NEW.receipt_json,'$.legacySafety.details.drainedAt')<json_extract(NEW.receipt_json,'$.legacySafety.details.stoppedAt')+json_extract(NEW.receipt_json,'$.legacySafety.details.maxRequestLifetimeMs')
 OR json_extract(NEW.receipt_json,'$.legacySafety.details.drainedAt')>json_extract(NEW.receipt_json,'$.legacySafety.verifiedAt')))
 OR json_extract(NEW.receipt_json,'$.deployment.mode') IS NOT 'authority-v2'
 OR length(json_extract(NEW.receipt_json,'$.deployment.configurationSha256')) IS NOT 64
 OR length(json_extract(NEW.receipt_json,'$.deployment.versionId')) IS NOT 36
 OR json_extract(NEW.receipt_json,'$.deployment.trialTargetSha256') IS NOT (SELECT isolated_target_config_sha256 FROM shelf_storage_single_trial WHERE id=1)
 OR json_type(NEW.receipt_json,'$.deployment.dualSourceReadVerified') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.deployment.trialOperatorClosed') IS NOT 'true'
 OR json_type(NEW.receipt_json,'$.deployment.normalWritesClosed') IS NOT 'true'
 OR json_extract(NEW.receipt_json,'$.normalTarget.accountId') IS NOT json_extract(OLD.identity_json,'$.accountId')
 OR json_extract(NEW.receipt_json,'$.normalTarget.bucket') IS NOT 'the-shelf-books'
 OR json_extract(NEW.receipt_json,'$.trialTarget.accountId') IS NOT json_extract(OLD.identity_json,'$.accountId')
 OR json_extract(NEW.receipt_json,'$.trialTarget.bucket') IS NOT 'the-shelf-first-book-20261023'
 OR json_extract(NEW.receipt_json,'$.deployment.productionDatabaseId') IS NOT json_extract(OLD.identity_json,'$.legacyDatabases.production')
 OR (SELECT count(*) FROM shelf_storage_sources)<>2
 OR EXISTS(SELECT 1 FROM shelf_storage_sources WHERE migration_hash<>OLD.migration_hash)
 OR (SELECT count(*) FROM shelf_storage_single_trial)<>1
 OR NOT EXISTS(SELECT 1 FROM shelf_storage_single_trial WHERE id=1 AND state='confirmed' AND put_attempted=1 AND content_verified=1
 AND authority_identity_json=OLD.identity_json AND consent_id='2026-10-23-first-book'
 AND json_extract(target_json,'$.accountId')=json_extract(OLD.identity_json,'$.accountId')
 AND json_extract(target_json,'$.bucket')='the-shelf-first-book-20261023')
 OR NOT EXISTS(SELECT 1 FROM shelf_storage_legacy_freeze WHERE id=1
 AND authority_id=json_extract(OLD.identity_json,'$.authorityId') AND account_id=json_extract(OLD.identity_json,'$.accountId') AND bucket='the-shelf-books')
 OR json_extract(NEW.evidence_json,'$.accountEvidence.schemaVersion') IS NOT 1
 OR json_type(NEW.evidence_json,'$.accountEvidence.completeCoverage') IS NOT 'true'
 OR json_type(NEW.evidence_json,'$.accountEvidence.accountMatch') IS NOT 'true'
 OR json_extract(NEW.evidence_json,'$.accountEvidence.source') IS NOT 'cloudflare-account-aggregate'
 OR json_extract(NEW.evidence_json,'$.accountEvidence.targetAccount') IS NOT json_extract(OLD.identity_json,'$.accountId')
 OR json_extract(NEW.evidence_json,'$.accountEvidence.plan') IS NOT 'free'
 OR json_extract(NEW.evidence_json,'$.accountEvidence.storageClass') IS NOT 'Standard'
 OR json_type(NEW.evidence_json,'$.accountEvidence.storedBytes') IS NOT 'integer'
 OR json_extract(NEW.evidence_json,'$.accountEvidence.storedBytes')<0
 OR json_type(NEW.evidence_json,'$.observedAt') IS NOT 'integer'
 OR json_extract(NEW.evidence_json,'$.accountEvidence.observedAt') IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.evidence_json,'$.observedAt')/1000.0,'unixepoch')
 OR json_extract(NEW.evidence_json,'$.observedAt')>CAST(unixepoch('subsec')*1000 AS INTEGER)
 OR json_extract(NEW.evidence_json,'$.observedAt')<CAST(unixepoch('subsec')*1000 AS INTEGER)-300000
 OR json_extract(NEW.evidence_json,'$.accountEvidence.billingPeriod') IS NOT strftime('%Y-%m','now')
 OR json_type(NEW.evidence_json,'$.accountEvidence.classAOperations') IS NOT 'integer'
 OR json_extract(NEW.evidence_json,'$.accountEvidence.classAOperations')<0
 OR json_extract(NEW.evidence_json,'$.accountEvidence.classAOperations')>=800000
 OR json_type(NEW.evidence_json,'$.accountEvidence.classBOperations') IS NOT 'integer'
 OR json_extract(NEW.evidence_json,'$.accountEvidence.classBOperations')<0
 OR json_extract(NEW.evidence_json,'$.accountEvidence.classBOperations')>=8000000
 OR json_extract(NEW.evidence_json,'$.provider.schemaVersion') IS NOT 1
 OR length(json_extract(NEW.evidence_json,'$.provider.contractSha256')) IS NOT 64
 OR length(json_extract(NEW.evidence_json,'$.provider.observationSha256')) IS NOT 64
 OR json_type(NEW.evidence_json,'$.provider.completeCoverageVerified') IS NOT 'true'
 OR json_type(NEW.evidence_json,'$.provider.sourceTimeVerified') IS NOT 'true'
 OR json_type(NEW.evidence_json,'$.provider.billingCountersVerified') IS NOT 'true'
 OR json_type(NEW.evidence_json,'$.provider.freeStandardVerified') IS NOT 'true'
 OR json_extract(NEW.receipt_json,'$.evidenceHash') IS NOT NEW.evidence_hash
 OR json_type(NEW.receipt_json,'$.verifiedAt') IS NOT 'integer'
 OR json_extract(NEW.receipt_json,'$.verifiedAt')>NEW.activated_at
 OR json_extract(NEW.receipt_json,'$.verifiedAt')<json_extract(NEW.receipt_json,'$.legacySafety.verifiedAt')
 OR json_extract(NEW.receipt_json,'$.verifiedAt')<NEW.activated_at-300000
 OR json_type(NEW.activated_at) IS NOT 'integer'
 OR NEW.activated_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
 OR NEW.activated_at<CAST(unixepoch('subsec')*1000 AS INTEGER)-300000
 OR json_extract(NEW.evidence_json,'$.accountEvidence.storedBytes')+(SELECT normal_committed+trial_committed+normal_reserved+trial_reserved+legacy_reserved FROM shelf_storage_responsibility_v2)>8000000000
 THEN RAISE(ABORT,'storage_v2_activation_invalid') END;
END;
CREATE TRIGGER shelf_storage_v2_activate AFTER UPDATE ON shelf_storage_activation_v2 BEGIN
 INSERT INTO shelf_storage_activation_receipts_v2 VALUES(NEW.receipt_hash,NEW.receipt_json,NEW.snapshot_json);
 INSERT INTO shelf_storage_evidence_v2 VALUES(NEW.evidence_hash,NEW.evidence_json);
 UPDATE shelf_storage_authority SET phase='ready',readback_hash=json_extract(NEW.receipt_json,'$.snapshotSha256'),receipt_json=NEW.receipt_json,
 observed_bytes=json_extract(NEW.evidence_json,'$.accountEvidence.storedBytes'),observed_at=json_extract(NEW.evidence_json,'$.observedAt'),
 evidence_hash=NEW.evidence_hash,billing_period=json_extract(NEW.evidence_json,'$.accountEvidence.billingPeriod') WHERE id=1;
END;
-- Add closed admission/claim gates BEFORE replacing the two obsolete phase guards.
CREATE TRIGGER shelf_storage_v2_admit BEFORE INSERT ON shelf_storage_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_activation_v2 v JOIN shelf_storage_authority a ON a.id=v.id
 JOIN shelf_storage_evidence_v2 e ON e.evidence_hash=a.evidence_hash
 WHERE v.id=1 AND v.state='active' AND v.generation=1 AND a.phase='ready'
 AND a.identity_json=v.identity_json AND a.receipt_json=v.receipt_json AND a.readback_hash=json_extract(v.receipt_json,'$.snapshotSha256')
 AND json_extract(e.evidence_json,'$.accountEvidence.storedBytes')=a.observed_bytes
 AND json_extract(e.evidence_json,'$.observedAt')=a.observed_at
 AND json_extract(e.evidence_json,'$.accountEvidence.billingPeriod')=a.billing_period
 AND a.committed_bytes=(SELECT normal_committed+trial_committed FROM shelf_storage_responsibility_v2)
 AND a.reserved_bytes=(SELECT normal_reserved+trial_reserved+legacy_reserved FROM shelf_storage_responsibility_v2))
 THEN RAISE(ABORT,'storage_v2_closed') END;
END;
CREATE TRIGGER shelf_storage_v2_claim BEFORE UPDATE OF state ON shelf_storage_reservations WHEN NEW.state='uploading' AND OLD.state<>'uploading' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_activation_v2 v JOIN shelf_storage_authority a ON a.id=v.id
 JOIN shelf_storage_evidence_v2 e ON e.evidence_hash=a.evidence_hash
 WHERE v.id=1 AND v.state='active' AND v.generation=1 AND a.phase='ready' AND a.identity_json=v.identity_json
 AND a.receipt_json=v.receipt_json AND a.readback_hash=json_extract(v.receipt_json,'$.snapshotSha256')
 AND json_extract(e.evidence_json,'$.accountEvidence.storedBytes')=a.observed_bytes AND json_extract(e.evidence_json,'$.observedAt')=a.observed_at
 AND json_extract(e.evidence_json,'$.accountEvidence.billingPeriod')=a.billing_period
 AND a.committed_bytes=(SELECT normal_committed+trial_committed FROM shelf_storage_responsibility_v2)
 AND a.reserved_bytes=(SELECT normal_reserved+trial_reserved+legacy_reserved FROM shelf_storage_responsibility_v2))
 THEN RAISE(ABORT,'storage_v2_closed') END;
END;
DROP TRIGGER shelf_storage_ready_guard;
CREATE TRIGGER shelf_storage_ready_guard BEFORE UPDATE OF phase ON shelf_storage_authority WHEN OLD.phase='imported' AND NEW.phase='ready' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM shelf_storage_activation_v2 v JOIN shelf_storage_activation_receipts_v2 r ON r.receipt_hash=v.receipt_hash
 WHERE v.id=1 AND v.state='active' AND v.generation=1 AND r.receipt_json=NEW.receipt_json AND r.snapshot_json=v.snapshot_json
 AND v.identity_json=NEW.identity_json AND v.migration_hash=NEW.migration_hash
 AND NEW.committed_bytes=(SELECT normal_committed+trial_committed FROM shelf_storage_responsibility_v2)
 AND NEW.reserved_bytes=(SELECT normal_reserved+trial_reserved+legacy_reserved FROM shelf_storage_responsibility_v2))
 THEN RAISE(ABORT,'storage_v2_activation_required') END;
END;
DROP TRIGGER shelf_single_trial_keep_imported;
CREATE TRIGGER shelf_single_trial_keep_imported BEFORE UPDATE OF phase ON shelf_storage_authority WHEN EXISTS(SELECT 1 FROM shelf_storage_single_trial) AND NEW.phase<>OLD.phase BEGIN
 SELECT CASE WHEN NOT (OLD.phase='imported' AND NEW.phase='ready' AND EXISTS(
 SELECT 1 FROM shelf_storage_activation_v2 v WHERE v.id=1 AND v.state='active' AND v.generation=1 AND v.receipt_json=NEW.receipt_json
 AND json_extract(v.snapshot_json,'$.trial')=(SELECT json_extract(snapshot_json,'$.trial') FROM shelf_storage_snapshot_v2)))
 THEN RAISE(ABORT,'single_trial_keeps_imported') END;
END;
