-- Additive private observations. Install v2 before removing the old, stricter guard.
CREATE TABLE filename_identification_observations (
 scope TEXT NOT NULL CHECK(scope='production'),
 request_id TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('pre_dispatch','dispatch','fetch_error','timeout','url_invalid','http_status','content_type','response_limit','body_error','json_invalid','envelope_invalid','model_mismatch','usage_invalid','metadata_invalid','completed')),
 http_status INTEGER CHECK(http_status IS NULL OR (typeof(http_status)='integer' AND http_status BETWEEN 100 AND 599)),
 elapsed_ms INTEGER CHECK(elapsed_ms IS NULL OR (typeof(elapsed_ms)='integer' AND elapsed_ms BETWEEN 0 AND 900000)),
 response_bytes INTEGER CHECK(response_bytes IS NULL OR (typeof(response_bytes)='integer' AND response_bytes BETWEEN 0 AND 65537)),
 response_chunks INTEGER CHECK(response_chunks IS NULL OR (typeof(response_chunks)='integer' AND response_chunks BETWEEN 0 AND 4097)),
 content_type TEXT CHECK(content_type IS NULL OR content_type IN ('json','other','missing')),
 request_id_present INTEGER CHECK(request_id_present IS NULL OR request_id_present IN (0,1)),
 request_id_valid INTEGER CHECK(request_id_valid IS NULL OR request_id_valid IN (0,1)),
 upstream_request_id TEXT CHECK(upstream_request_id IS NULL OR (length(upstream_request_id)=32 AND upstream_request_id NOT GLOB '*[^0-9a-f]*') OR (length(upstream_request_id)=36 AND substr(upstream_request_id,9,1)='-' AND substr(upstream_request_id,14,1)='-' AND substr(upstream_request_id,19,1)='-' AND substr(upstream_request_id,24,1)='-' AND length(replace(upstream_request_id,'-',''))=32 AND replace(upstream_request_id,'-','') NOT GLOB '*[^0-9a-f]*')),
 url_matches INTEGER CHECK(url_matches IS NULL OR url_matches IN (0,1)),
 envelope_valid INTEGER CHECK(envelope_valid IS NULL OR envelope_valid IN (0,1)),
 model_matches INTEGER CHECK(model_matches IS NULL OR model_matches IN (0,1)),
 usage_valid INTEGER CHECK(usage_valid IS NULL OR usage_valid IN (0,1)),
 metadata_valid INTEGER CHECK(metadata_valid IS NULL OR metadata_valid IN (0,1)),
 PRIMARY KEY(scope,request_id),
 FOREIGN KEY(scope,request_id) REFERENCES filename_identifications(scope,request_id),
 CHECK((request_id_present IS NULL AND request_id_valid IS NULL AND upstream_request_id IS NULL) OR (request_id_present IS 0 AND request_id_valid IS NULL AND upstream_request_id IS NULL) OR (request_id_present IS 1 AND request_id_valid IS 0 AND upstream_request_id IS NULL) OR (request_id_present IS 1 AND request_id_valid IS 1 AND upstream_request_id IS NOT NULL))
);
CREATE TRIGGER filename_identification_observation_admit BEFORE INSERT ON filename_identification_observations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM filename_identifications f WHERE f.scope=NEW.scope AND f.request_id=NEW.request_id AND f.state='pending')
 THEN RAISE(ABORT,'identify_observation_not_pending') END;
END;
CREATE TRIGGER filename_identification_observation_immutable BEFORE UPDATE ON filename_identification_observations BEGIN
 SELECT RAISE(ABORT,'identify_observation_immutable');
END;
CREATE TRIGGER filename_identification_observation_retain BEFORE DELETE ON filename_identification_observations BEGIN
 SELECT RAISE(ABORT,'identify_observation_retained');
END;
CREATE TRIGGER filename_identification_admit_v2 BEFORE INSERT ON filename_identifications BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions s JOIN auth_config a ON a.scope=s.scope WHERE s.scope=NEW.scope AND s.session_hash=NEW.session_hash AND s.generation=NEW.generation AND s.revoked=0 AND s.expires_at>NEW.created_at AND a.enabled=1 AND a.generation=s.generation)
 THEN RAISE(ABORT,'library_session_invalid') END;
 SELECT CASE WHEN NEW.state<>'pending' OR NEW.result_json IS NOT NULL OR NEW.usage_json IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.updated_at<>NEW.created_at
 THEN RAISE(ABORT,'identify_admission_invalid') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM filename_identifications WHERE state='pending')
 THEN RAISE(ABORT,'identify_call_locked') END;
 SELECT CASE WHEN (SELECT count(*) FROM filename_identifications WHERE billing_day=NEW.billing_day)>=20
 THEN RAISE(ABORT,'identify_daily_budget') END;
END;
DROP TRIGGER filename_identification_admit;
