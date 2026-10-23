-- Additive owner-only filename AI ledger. Never reset or replay an uncertain call.
CREATE TABLE filename_identifications (
 scope TEXT NOT NULL CHECK(scope='production'),
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 contract_version TEXT NOT NULL CHECK(contract_version='filename-v1'),
 session_hash TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>=1),
 created_at INTEGER NOT NULL CHECK(created_at>0),
 deadline_at INTEGER NOT NULL CHECK(deadline_at=created_at+60000),
 billing_day INTEGER NOT NULL CHECK(billing_day=created_at/86400000),
 input_characters INTEGER NOT NULL CHECK(input_characters BETWEEN 1 AND 255),
 state TEXT NOT NULL CHECK(state IN ('pending','completed','failed','uncertain')),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
 error_code TEXT,
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 PRIMARY KEY(scope,request_id), UNIQUE(scope,fingerprint),
 CHECK((state='completed' AND result_json IS NOT NULL AND error_code IS NULL) OR (state<>'completed' AND result_json IS NULL))
);
CREATE INDEX filename_identification_day ON filename_identifications(billing_day);
CREATE INDEX filename_identification_state ON filename_identifications(state,deadline_at);
CREATE TRIGGER filename_identification_admit BEFORE INSERT ON filename_identifications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN auth_config a ON a.scope=s.scope WHERE s.scope=NEW.scope AND s.session_hash=NEW.session_hash AND s.generation=NEW.generation AND s.revoked=0 AND s.expires_at>NEW.created_at AND a.enabled=1 AND a.generation=s.generation)
 THEN RAISE(ABORT,'library_session_invalid') END;
 SELECT CASE WHEN NEW.state<>'pending' OR NEW.result_json IS NOT NULL OR NEW.usage_json IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.updated_at<>NEW.created_at
 THEN RAISE(ABORT,'identify_admission_invalid') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM filename_identifications WHERE state IN ('pending','uncertain'))
 THEN RAISE(ABORT,'identify_call_locked') END;
 SELECT CASE WHEN (SELECT count(*) FROM filename_identifications WHERE billing_day=NEW.billing_day)>=20
 THEN RAISE(ABORT,'identify_daily_budget') END;
END;
CREATE TRIGGER filename_identification_transition BEFORE UPDATE ON filename_identifications BEGIN
 SELECT CASE WHEN NEW.scope<>OLD.scope OR NEW.request_id<>OLD.request_id OR NEW.fingerprint<>OLD.fingerprint OR NEW.contract_version<>OLD.contract_version OR NEW.session_hash<>OLD.session_hash OR NEW.generation<>OLD.generation OR NEW.created_at<>OLD.created_at OR NEW.deadline_at<>OLD.deadline_at OR NEW.billing_day<>OLD.billing_day OR NEW.input_characters<>OLD.input_characters OR NEW.updated_at<OLD.updated_at OR OLD.state<>'pending' OR NEW.state NOT IN ('completed','failed','uncertain')
 THEN RAISE(ABORT,'identify_transition_invalid') END;
END;
CREATE TRIGGER filename_identification_retain BEFORE DELETE ON filename_identifications BEGIN
 SELECT RAISE(ABORT,'identify_call_retained');
END;
