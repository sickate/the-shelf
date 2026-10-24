/** J0 private D1 state authority. No fetch, Workflow, R2, routes or environment access. */
export const JOBS_SCHEMA_SHA256 =
  "c49703f05401a5756182263f6c2d05ac060bf3b0a4e46ca3c093e7f76c3124df";
export const JOBS_LIMITS = Object.freeze({
  daily: 20,
  maxCalls: 4,
  sourceBytes: 65536,
  inputBytes: 32768,
  coverageBytes: 16384,
  requestBytes: 262144,
  responseBytes: 131072,
  responseCodepoints: 16000,
  historyItems: 25,
  historyBytes: 65536,
});
const E = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/,
  UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  BOOK = /^book_[a-f0-9]{16}$/,
  FILE = /^file_[a-f0-9]{16}$/;
const permits = new WeakMap(),
  receipts = new WeakMap();
export class JobsStateError extends Error {
  constructor(code = "jobs_state_unavailable") {
    super(code);
    this.name = "JobsStateError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new JobsStateError(code);
};
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const int = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const bytes = (v) => E.encode(v).byteLength;
const json = (v, max) => {
  const s = JSON.stringify(v);
  if (!s || bytes(s) > max) fail("jobs_input_limit");
  return s;
};
export async function jobsDigest(value) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? E.encode(value) : value,
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
const nonce = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const dto = (r) =>
  r
    ? Object.freeze({
        id: r.job_id,
        requestId: r.request_id,
        operation: r.operation,
        state: r.state,
        version: r.version,
        maxCalls: r.max_calls,
        requiredCalls: r.required_calls,
        cancelRequested: r.cancel_requested === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })
    : null;
const code = (e) =>
  e instanceof JobsStateError
    ? e.code
    : /\bjobs_[a-z_]+\b/.exec(String(e?.message || ""))?.[0] ||
      "jobs_state_unavailable";
const rows = (r) => (Array.isArray(r?.results) ? r.results : []);
const one = (r) => {
  const a = rows(r);
  if (a.length !== 1) fail("jobs_claim_unverified");
  return a[0];
};
const schemaQuery =
  "SELECT type,CASE WHEN length(CAST(name AS BLOB))<=128 THEN name ELSE NULL END AS name,CASE WHEN SUM(length(CAST(json_quote(sql) AS BLOB))+length(CAST(json_quote(name) AS BLOB))+32) OVER()<=131072 THEN sql ELSE NULL END AS sql FROM (SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (tbl_name='shelf_jobs' OR tbl_name GLOB 'shelf_job_*' OR name IN ('shelf_ai_charges','shelf_ai_slots','filename_identification_shared_admit_v1')) ORDER BY name LIMIT 50) ORDER BY name";
export async function assertJobsSchema(db) {
  const r = await (db.withSession ? db.withSession("first-primary") : db)
    .prepare(schemaQuery)
    .all();
  const a = rows(r).map((x) => [x.type, x.name, x.sql]);
  if (
    a.length !== 49 ||
    bytes(JSON.stringify(a)) > 131072 ||
    (await jobsDigest(JSON.stringify(a))) !== JOBS_SCHEMA_SHA256
  )
    fail("jobs_schema_unavailable");
  const c = await (db.withSession ? db.withSession("first-primary") : db)
    .prepare(
      "SELECT scope,mode,generation,updated_at FROM shelf_job_control WHERE scope='production'",
    )
    .first();
  if (
    !c ||
    !["closed", "jobs-v1"].includes(c.mode) ||
    !int(c.generation, 1) ||
    !int(c.updated_at)
  )
    fail("jobs_schema_unavailable");
}
function canonical(input) {
  if (
    !exact(input, [
      "requestId",
      "bookId",
      "source",
      "operation",
      "question",
      "range",
    ]) ||
    !UUID.test(input.requestId) ||
    !BOOK.test(input.bookId) ||
    !exact(input.source, ["fileId", "versionHash"]) ||
    !FILE.test(input.source.fileId) ||
    !HASH.test(input.source.versionHash)
  )
    fail("jobs_input_invalid");
  if (
    !["question", "chapter_summary", "full_summary"].includes(input.operation)
  )
    fail("jobs_input_invalid");
  let question = null,
    range = null;
  if (input.operation === "question") {
    if (typeof input.question !== "string" || input.range !== null)
      fail("jobs_input_invalid");
    question = input.question.replace(/\r\n?/g, "\n").normalize("NFC").trim();
    if (
      !question ||
      [...question].length > 4000 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        question,
      )
    )
      fail("jobs_input_invalid");
  } else {
    if (input.question !== null) fail("jobs_input_invalid");
    if (input.operation === "chapter_summary") {
      if (
        !exact(input.range, ["type", "start", "end"]) ||
        !["pdf-page", "epub-spine"].includes(input.range.type) ||
        !int(
          input.range.start,
          input.range.type === "pdf-page" ? 1 : 0,
          20000000,
        ) ||
        !int(input.range.end, input.range.start, 20000000)
      )
        fail("jobs_input_invalid");
      range = {
        type: input.range.type,
        start: input.range.start,
        end: input.range.end,
      };
    } else if (input.range !== null) fail("jobs_input_invalid");
  }
  const value = {
    operation: input.operation,
    question,
    range,
    conversation: [],
  };
  return { ...input, question, range, inputJson: json(value, 32768) };
}
const liveSql =
  "EXISTS(SELECT 1 FROM sessions s JOIN auth_config a ON a.scope=s.scope JOIN shelf_job_control c ON c.scope=s.scope WHERE s.scope=j.scope AND s.session_hash=j.session_hash AND s.generation=j.generation AND s.revoked=0 AND s.expires_at>? AND a.enabled=1 AND a.generation=s.generation AND a.origin=j.origin AND c.mode='jobs-v1' AND c.generation=j.gate_generation AND j.deadline_at>?)\n AND EXISTS(SELECT 1 FROM shelf_job_current_sources x WHERE x.scope=j.scope AND x.book_id=j.book_id AND x.file_id=j.file_id AND x.version_hash=j.version_hash AND x.snapshot_json=j.source_snapshot_json)";
export function createJobsState(db, { clock = Date.now } = {}) {
  if (!db?.prepare || !db?.batch || typeof clock !== "function")
    fail("jobs_state_unavailable");
  const owner = {};
  const now = () => {
    const n = clock();
    if (!int(n, 1)) fail("jobs_clock_invalid");
    return n;
  };
  const primary = () => (db.withSession ? db.withSession("first-primary") : db);
  const p = (sql, ...args) => {
    if (args.length > 32) fail("jobs_statement_limit");
    return db.prepare(sql).bind(...args);
  };
  const raw = async (column, value) => {
    if (!["job_id", "request_id", "logical_fingerprint"].includes(column))
      fail("jobs_input_invalid");
    return primary()
      .prepare(
        "SELECT * FROM shelf_jobs WHERE scope='production' AND " +
          column +
          "=?",
      )
      .bind(value)
      .first();
  };
  const result = async (id) => dto(await raw("job_id", id));
  const token = (kind, row) => {
    const v = Object.freeze({});
    permits.set(v, { owner, kind, ...row });
    return v;
  };
  const event = (
    id,
    version,
    kind,
    to,
    at,
    { required = null, reference = null, eventCode, cancel = null } = {},
  ) =>
    p(
      "INSERT INTO shelf_job_events(scope,job_id,event_id,kind,expected_version,new_version,from_state,to_state,cancel_requested,required_calls,created_at,reference_nonce,code) SELECT scope,job_id,?,?,?,? ,state,?,COALESCE(?,cancel_requested),CASE WHEN ?='ready' THEN ? ELSE required_calls END,?,?,? FROM shelf_jobs WHERE scope='production' AND job_id=? RETURNING event_id,job_id,new_version",
      crypto.randomUUID(),
      kind,
      version,
      version + 1,
      to,
      cancel,
      kind,
      required,
      at,
      reference,
      eventCode,
      id,
    );
  const writeEvent = async (id, version, kind, to, options = {}) => {
    await assertJobsSchema(db);
    if (!UUID.test(id) || !int(version)) fail("jobs_input_invalid");
    try {
      one(await event(id, version, kind, to, now(), options).all());
      return await result(id);
    } catch (e) {
      throw new JobsStateError(code(e));
    }
  };
  return Object.freeze({
    async getJob(id) {
      if (!UUID.test(id)) fail("jobs_input_invalid");
      return result(id);
    },
    async getByRequest(id) {
      if (!UUID.test(id)) fail("jobs_input_invalid");
      return dto(await raw("request_id", id));
    },
    async getByFingerprint(f) {
      if (!HASH.test(f)) fail("jobs_input_invalid");
      return dto(await raw("logical_fingerprint", f));
    },
    async sharedBudget() {
      const at = now(),
        day = Math.floor(at / 86400000);
      const r = await primary()
        .prepare(
          "SELECT (SELECT count(*) FROM shelf_ai_charges WHERE scope='production' AND billing_day=?) AS used,(SELECT count(*) FROM shelf_ai_slots WHERE scope='production') AS slots",
        )
        .bind(day)
        .first();
      return Object.freeze({
        billingDay: day,
        used: r.used,
        remaining: Math.max(0, 20 - r.used),
        busy: r.slots > 0,
      });
    },
    async admitJob(input, grant) {
      const v = canonical(input);
      if (
        !exact(grant, ["sessionHash", "generation", "origin"]) ||
        !HASH.test(grant.sessionHash) ||
        !int(grant.generation, 1) ||
        typeof grant.origin !== "string"
      )
        fail("jobs_grant_invalid");
      await assertJobsSchema(db);
      const fingerprint = await jobsDigest(
        JSON.stringify([
          "jobs-semantic-v1",
          v.bookId,
          v.source.fileId,
          v.source.versionHash,
          v.operation,
          v.range,
          v.question,
          [],
          "gpt-6-luna",
        ]),
      );
      const oldId = await raw("request_id", v.requestId),
        old = oldId || (await raw("logical_fingerprint", fingerprint));
      if (oldId && oldId.logical_fingerprint !== fingerprint)
        fail("jobs_request_conflict");
      if (old) return { job: dto(old), permit: null, code: "jobs_existing" };
      const source = await primary()
        .prepare(
          "SELECT x.snapshot_json,s.expires_at,c.generation AS gate_generation,c.mode FROM shelf_job_current_sources x JOIN sessions s ON s.scope=x.scope JOIN auth_config a ON a.scope=s.scope JOIN shelf_job_control c ON c.scope=s.scope WHERE x.scope='production' AND x.book_id=? AND x.file_id=? AND x.version_hash=? AND s.session_hash=? AND s.generation=? AND s.revoked=0 AND a.enabled=1 AND a.generation=s.generation AND a.origin=?",
        )
        .bind(
          v.bookId,
          v.source.fileId,
          v.source.versionHash,
          grant.sessionHash,
          grant.generation,
          grant.origin,
        )
        .first();
      if (!source || source.mode !== "jobs-v1") fail("jobs_grant_invalid");
      const inputHash = await jobsDigest(v.inputJson),
        claimNonce = nonce(),
        id = crypto.randomUUID(),
        at = now(),
        max = v.operation === "question" ? 1 : 4,
        day = Math.floor(at / 86400000),
        deadline = at + max * 960000 + (max + 1) * 30000;
      if (
        deadline > source.expires_at ||
        deadline > (day + 1) * 86400000 ||
        bytes(source.snapshot_json) > 65536
      )
        fail("jobs_deadline");
      try {
        const r = await db.batch([
          p(
            "INSERT INTO shelf_jobs(scope,job_id,request_id,logical_fingerprint,contract,operation,model,effort,prompt_contract,origin,book_id,file_id,version_hash,source_snapshot_json,input_json,input_sha256,session_hash,generation,gate_generation,created_at,deadline_at,billing_day,max_calls,required_calls,state,version,cancel_requested,updated_at,last_event_id) VALUES('production',?,?,?,'jobs-v1',?,'gpt-6-luna','low','jobs-prompt-v1',?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'queued',0,0,?,NULL) RETURNING job_id,request_id,logical_fingerprint,version",
            id,
            v.requestId,
            fingerprint,
            v.operation,
            grant.origin,
            v.bookId,
            v.source.fileId,
            v.source.versionHash,
            source.snapshot_json,
            v.inputJson,
            inputHash,
            grant.sessionHash,
            grant.generation,
            source.gate_generation,
            at,
            deadline,
            day,
            max,
            at,
          ),
          p(
            "INSERT INTO shelf_job_workflow_intents VALUES('production',?,?,?,?,0) RETURNING job_id,claim_nonce",
            id,
            "shelf-job-" + id,
            claimNonce,
            at,
          ),
          p(
            "SELECT j.* FROM shelf_jobs j JOIN shelf_job_workflow_intents w ON w.scope=j.scope AND w.job_id=j.job_id WHERE j.scope='production' AND j.job_id=? AND w.claim_nonce=?",
            id,
            claimNonce,
          ),
        ]);
        const a = one(r[0]),
          b = one(r[1]),
          c = one(r[2]);
        if (
          a.job_id !== id ||
          a.request_id !== v.requestId ||
          a.logical_fingerprint !== fingerprint ||
          a.version !== 0 ||
          b.job_id !== id ||
          b.claim_nonce !== claimNonce ||
          c.job_id !== id ||
          c.version !== 0
        )
          fail("jobs_claim_unverified");
        return {
          job: dto(c),
          permit: token("workflow", { jobId: id, nonce: claimNonce }),
          code: "jobs_admitted",
        };
      } catch (e) {
        const foundId = await raw("request_id", v.requestId),
          found = foundId || (await raw("logical_fingerprint", fingerprint));
        if (foundId && foundId.logical_fingerprint !== fingerprint)
          fail("jobs_request_conflict");
        if (found)
          return {
            job: dto(found),
            permit: null,
            code: "jobs_claim_unverified",
          };
        throw new JobsStateError(code(e));
      }
    },
    startPlanning(id, version) {
      return writeEvent(id, version, "planning", "planning", {
        eventCode: "planning",
      });
    },
    async savePlan(id, version, plans) {
      await assertJobsSchema(db);
      if (
        !UUID.test(id) ||
        !int(version) ||
        !Array.isArray(plans) ||
        ![1, 3, 4].includes(plans.length)
      )
        fail("jobs_input_invalid");
      const at = now(),
        statements = plans.map((v, i) => {
          if (
            !exact(v, [
              "phase",
              "inputHash",
              "inputCodepoints",
              "requestBytes",
              "coverage",
            ]) ||
            !["question", "leaf", "reduce"].includes(v.phase) ||
            !HASH.test(v.inputHash) ||
            !int(v.inputCodepoints, 1, 50000) ||
            !int(v.requestBytes, 1, 262144) ||
            !Array.isArray(v.coverage) ||
            v.coverage.length > 256
          )
            fail("jobs_input_invalid");
          return p(
            "INSERT INTO shelf_job_call_plans VALUES('production',?,?,?,?,?,?,?,?) RETURNING ordinal",
            id,
            i + 1,
            v.phase,
            v.inputHash,
            v.inputCodepoints,
            v.requestBytes,
            json(v.coverage, 16384),
            at,
          );
        });
      statements.push(
        event(id, version, "ready", "ready", at, {
          required: plans.length,
          eventCode: "planned",
        }),
      );
      try {
        const r = await db.batch(statements);
        r.forEach(one);
        return result(id);
      } catch (e) {
        throw new JobsStateError(code(e));
      }
    },
    async claimCall(id, ordinal, version, bodyHash) {
      await assertJobsSchema(db);
      if (
        !UUID.test(id) ||
        !int(ordinal, 1, 4) ||
        !int(version) ||
        !HASH.test(bodyHash)
      )
        fail("jobs_input_invalid");
      const n = nonce(),
        at = now(),
        day = Math.floor(at / 86400000);
      try {
        const r = await db.batch([
          p(
            "INSERT INTO shelf_job_call_intents VALUES('production',?,?,?,?,?,?,?,?) RETURNING job_id,ordinal,dispatch_nonce,expected_version",
            id,
            ordinal,
            n,
            version,
            day,
            at,
            at + 900000,
            bodyHash,
          ),
          event(id, version, "call_admitted", "running", at, {
            reference: n,
            eventCode: "dispatched",
          }),
          p(
            "SELECT * FROM shelf_jobs WHERE scope='production' AND job_id=?",
            id,
          ),
        ]);
        const a = one(r[0]),
          b = one(r[1]),
          c = one(r[2]);
        if (
          a.job_id !== id ||
          a.ordinal !== ordinal ||
          a.dispatch_nonce !== n ||
          a.expected_version !== version ||
          b.job_id !== id ||
          b.new_version !== version + 1 ||
          c.job_id !== id ||
          c.version !== version + 1 ||
          c.state !== "running"
        )
          fail("jobs_claim_unverified");
        return {
          job: dto(c),
          permit: token("call", { jobId: id, ordinal, nonce: n }),
          code: "jobs_admitted",
        };
      } catch (e) {
        const row = await raw("job_id", id);
        if (row) return { job: dto(row), permit: null, code: code(e) };
        throw new JobsStateError(code(e));
      }
    },
    async consumePermit(permit, callback) {
      const v = permits.get(permit);
      if (!v || v.owner !== owner || typeof callback !== "function")
        fail("jobs_permit_invalid");
      // Burn the in-memory qualification before the first await. A delayed or
      // failed recheck cannot put it back, including a concurrent consumer.
      permits.delete(permit);
      let current;
      try {
        await assertJobsSchema(db);
        const at = now();
        current = await primary()
          .prepare(
            v.kind === "call"
              ? "SELECT i.created_at,i.deadline_at FROM shelf_jobs j JOIN shelf_job_call_intents i ON i.scope=j.scope AND i.job_id=j.job_id JOIN shelf_job_events e ON e.scope=i.scope AND e.job_id=i.job_id AND e.kind='call_admitted' AND e.reference_nonce=i.dispatch_nonce AND e.expected_version=i.expected_version WHERE j.scope='production' AND j.job_id=? AND i.dispatch_nonce=? AND j.state='running' AND j.cancel_requested=0 AND i.deadline_at>? AND NOT EXISTS(SELECT 1 FROM shelf_job_call_receipts r WHERE r.scope=i.scope AND r.job_id=i.job_id AND r.ordinal=i.ordinal) AND " +
                  liveSql
              : "SELECT w.created_at,j.deadline_at FROM shelf_jobs j JOIN shelf_job_workflow_intents w ON w.scope=j.scope AND w.job_id=j.job_id WHERE j.scope='production' AND j.job_id=? AND w.claim_nonce=? AND j.state IN ('queued','planning','ready','running') AND j.cancel_requested=0 AND j.deadline_at>? AND NOT EXISTS(SELECT 1 FROM shelf_job_workflow_receipts r WHERE r.scope=w.scope AND r.job_id=w.job_id) AND " +
                  liveSql,
          )
          .bind(v.jobId, v.nonce, at, at, at)
          .first();
      } catch (e) {
        throw new JobsStateError(code(e));
      }
      if (!current) fail("jobs_dispatch_revoked");
      const context = Object.freeze({
        kind: v.kind,
        jobId: v.jobId,
        ...(v.kind === "call" ? { ordinal: v.ordinal } : {}),
        admittedAt: current.created_at,
        deadlineAt: current.deadline_at,
      });
      receipts.set(context, v);
      return callback(context);
    },
    async recordWorkflowOutcome(context, outcome) {
      const v = receipts.get(context);
      if (
        !v ||
        v.owner !== owner ||
        v.kind !== "workflow" ||
        !["created", "uncertain"].includes(outcome)
      )
        fail("jobs_permit_invalid");
      receipts.delete(context);
      const at = now();
      try {
        one(
          await p(
            "INSERT INTO shelf_job_workflow_receipts VALUES('production',?,?,?,?,?) RETURNING job_id",
            v.jobId,
            v.nonce,
            at,
            outcome,
            outcome === "created" ? "workflow_created" : "workflow_uncertain",
          ).all(),
        );
        return result(v.jobId);
      } catch (e) {
        throw new JobsStateError(code(e));
      }
    },
    async finishCall(context, value) {
      const v = receipts.get(context);
      if (
        !v ||
        v.owner !== owner ||
        v.kind !== "call" ||
        !exact(value, ["outcome", "content", "usage", "coverage"]) ||
        !["completed", "failed", "uncertain"].includes(value.outcome) ||
        !Array.isArray(value.coverage) ||
        value.coverage.length > 256
      )
        fail("jobs_permit_invalid");
      let text = null,
        hash = null,
        usage = null;
      if (value.outcome === "completed") {
        if (
          typeof value.content !== "string" ||
          !value.content ||
          [...value.content].length > 16000 ||
          bytes(value.content) > 131072
        )
          fail("jobs_content_limit");
        text = value.content;
        hash = await jobsDigest(text);
      } else if (value.content !== null) fail("jobs_input_invalid");
      if (value.usage !== null) {
        if (
          !exact(value.usage, ["input_tokens", "output_tokens"]) ||
          !int(value.usage.input_tokens) ||
          !int(value.usage.output_tokens)
        )
          fail("jobs_usage_invalid");
        usage = json(value.usage, 1024);
      }
      const coverage = json(value.coverage, 16384);
      // digest() above yields. Only one concurrent finisher may claim this
      // context after validation, before its terminal INSERT is attempted.
      if (receipts.get(context) !== v) fail("jobs_permit_invalid");
      receipts.delete(context);
      const at = now(),
        errorCode = {
          completed: "completed",
          failed: "upstream_failed",
          uncertain: "upstream_uncertain",
        }[value.outcome];
      try {
        // The usability predicate runs atomically in the same INSERT as the terminal receipt.
        const s =
          "INSERT INTO shelf_job_call_receipts(scope,job_id,ordinal,dispatch_nonce,observed_at,outcome,transport_closed,usable,code,content_text,content_sha256,usage_json,coverage_json) SELECT j.scope,j.job_id,?,?,?, ?,1,CASE WHEN ?='completed' AND j.cancel_requested=0 AND EXISTS(SELECT 1 FROM shelf_job_call_intents i WHERE i.scope=j.scope AND i.job_id=j.job_id AND i.ordinal=? AND i.dispatch_nonce=? AND i.deadline_at>?) AND " +
          liveSql +
          " THEN 1 ELSE 0 END,?,?,?,?,? FROM shelf_jobs j WHERE j.scope='production' AND j.job_id=? RETURNING job_id,ordinal,usable";
        // liveSql has two independent timestamp bindings (session and job expiry).
        one(
          await p(
            s,
            v.ordinal,
            v.nonce,
            at,
            value.outcome,
            value.outcome,
            v.ordinal,
            v.nonce,
            at,
            at,
            at,
            errorCode,
            text,
            hash,
            usage,
            coverage,
            v.jobId,
          ).all(),
        );
        return result(v.jobId);
      } catch (e) {
        throw new JobsStateError(code(e));
      }
    },
    async cancelJob(id, version) {
      const r = await raw("job_id", id);
      if (!r) fail("jobs_not_found");
      const pending = await primary()
        .prepare(
          "SELECT count(*) AS n FROM shelf_job_call_intents i WHERE i.scope='production' AND i.job_id=? AND NOT EXISTS(SELECT 1 FROM shelf_job_call_receipts r WHERE r.scope=i.scope AND r.job_id=i.job_id AND r.ordinal=i.ordinal)",
        )
        .bind(id)
        .first();
      // The trigger re-evaluates this target under the CAS. Any race aborts conservatively.
      return writeEvent(
        id,
        version,
        "cancel",
        pending.n ? "cancellation_requested" : "cancelled",
        { cancel: 1, eventCode: "cancelled" },
      );
    },
    stopUnsent(id, version, errorCode = "local_invalid") {
      if (
        ![
          "local_invalid",
          "source_changed",
          "grant_invalid",
          "deadline",
        ].includes(errorCode)
      )
        fail("jobs_input_invalid");
      return writeEvent(id, version, "stop", "failed", {
        eventCode: errorCode,
      });
    },
  });
}
