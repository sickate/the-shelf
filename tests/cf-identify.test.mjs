import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  identifyRoute,
  identifyCapability,
  callIdentifyTask,
  validateIdentifyInput,
  validateIdentifyMetadata,
  identifyTaskBody,
  IDENTIFY_ENDPOINT,
} from "../cloudflare/library/identify.mjs";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import {
  createOwnerVerifier,
  LibraryError,
} from "../cloudflare/library/security.mjs";
const ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const metadata = {
  title: "Synthetic Lantern",
  author: "Synthetic Writer",
  category: "测试",
};
const envelope = (m = metadata) => ({
  task_id: "synthetic_task",
  kind: "research_summary",
  model: "gpt-6-luna",
  content: JSON.stringify(m),
  usage: { input_tokens: 12, output_tokens: 8 },
});
const answer = (m = metadata) => Response.json(envelope(m));
class D1 {
  constructor(sql) {
    this.sql = sql;
    this.lostClaim = false;
    this.lostSave = false;
    this.beforeRead = null;
  }
  prepare(text) {
    const d = this;
    const build = (args = []) => ({
      bind: (...a) => build(a),
      first: async () => {
        const r = d.sql.prepare(text).get(...args) || null;
        if (d.beforeRead) await d.beforeRead(text);
        if (d.lostSave && text.startsWith("UPDATE filename_identifications")) {
          d.lostSave = false;
          throw Error("lost response");
        }
        return r;
      },
      all: async () => ({ results: d.sql.prepare(text).all(...args) }),
      run: async () => ({ meta: d.sql.prepare(text).run(...args) }),
      execute: () => ({ results: d.sql.prepare(text).all(...args) }),
    });
    return build();
  }
  async batch(statements) {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const r = statements.map((s) => s.execute());
      this.sql.exec("COMMIT");
      if (
        r.some((v) =>
          v.results?.some((row) => row.contract_version === "filename-v1"),
        )
      ) {
        this.afterClaim?.();
        if (this.lostClaim) {
          this.lostClaim = false;
          throw Error("lost claim response");
        }
      }
      return r;
    } catch (e) {
      if (this.sql.isTransaction) this.sql.exec("ROLLBACK");
      throw e;
    }
  }
}
async function fixture(t, { file = false } = {}) {
  let directory;
  if (file)
    directory = await fs.mkdtemp(path.join(tmpdir(), "shelf-identify-db-"));
  const sql = new DatabaseSync(
    file ? path.join(directory, "test.sqlite") : ":memory:",
  );
  const others = [];
  t.after(async () => {
    others.forEach((d) => d.close());
    sql.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });
  for (const name of [
    "schema.sql",
    "migrations/007-book-management.sql",
    "migrations/008-filename-identification.sql",
  ])
    sql.exec(
      readFileSync(
        new URL("../cloudflare/library/" + name, import.meta.url),
        "utf8",
      ),
    );
  const now = Date.now(),
    session = { session_hash: "a".repeat(64), generation: 1 };
  sql
    .prepare(
      "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,1,?)",
    )
    .run(ORIGIN, "b".repeat(64), now);
  sql
    .prepare("INSERT INTO sessions VALUES('production',?,1,?,?,0)")
    .run(session.session_hash, now - 100, now + 3600000);
  const db = new D1(sql),
    context = { scope: "production", origin: ORIGIN, now, ip: "c".repeat(64) };
  const env = {
    APP_SCOPE: "production",
    SITE_ORIGIN: ORIGIN,
    FILENAME_AI_MODE: "filename-v1",
    FILENAME_AI_KEY: "synthetic_private_key_123456789",
    DB: db,
  };
  let ordinal = 0,
    calls = 0;
  const d = {
    prepare: (e, text, ...args) => e.DB.prepare(text).bind(...args),
    query: (fn) => fn(),
    response: (s, value) => Response.json(value, { status: s }),
    admission: (e, c, kind, s) =>
      e.DB.prepare(
        "INSERT INTO admissions(scope,request_id,kind,ip_key,created_at,session_hash,generation)VALUES(?,?,?,?,?,?,?)",
      ).bind(
        c.scope,
        `test-${++ordinal}`,
        kind,
        c.ip,
        c.now,
        s.session_hash,
        s.generation,
      ),
  };
  let fetchImpl = async () => {
    calls++;
    return answer();
  };
  const run = async (
    body = {
      filename: "Synthetic Lantern - Synthetic Writer.pdf",
      requestId: id(1),
    },
    options = {},
  ) => {
    const poll = typeof body === "string";
    try {
      return await identifyRoute(
        new Request(
          ORIGIN + "/api/manage/identify" + (poll ? "/" + body : ""),
          {
            method: poll ? "GET" : "POST",
            ...(poll
              ? {}
              : {
                  body: JSON.stringify(body),
                  headers: { "Content-Type": "application/json" },
                }),
          },
        ),
        env,
        context,
        session,
        d,
        {
          fetchImpl: (...args) => fetchImpl(...args),
          timeoutMs: 100,
          ...options,
        },
      );
    } catch (e) {
      if (!(e instanceof LibraryError)) throw e;
      return Response.json({ error: { code: e.code } }, { status: e.status });
    }
  };
  return {
    sql,
    db,
    env,
    context,
    session,
    d,
    run,
    calls: () => calls,
    fetch: (f) => {
      fetchImpl = async (...args) => {
        calls++;
        return f(...args);
      };
    },
    second: () => {
      const other = new DatabaseSync(path.join(directory, "test.sqlite"));
      others.push(other);
      return other;
    },
  };
}
test("filename input and model output accept only exact keys and bounded scalar fields", () => {
  assert.equal(
    validateIdentifyInput({ filename: "  a.epub ", requestId: id(1) }).filename,
    "a.epub",
  );
  for (const filename of [
    "../a.pdf",
    "C:\\a.pdf",
    "a\n.pdf",
    "\ud800.pdf",
    "x.txt",
    "x".repeat(256) + ".pdf",
    "",
    null,
  ])
    assert.throws(() => validateIdentifyInput({ filename, requestId: id(1) }));
  assert.throws(() =>
    validateIdentifyInput({
      filename: "a.pdf",
      requestId: id(1),
      bytes: "secret",
    }),
  );
  assert.throws(() =>
    validateIdentifyInput({ filename: "a.pdf", requestId: "bad" }),
  );
  assert.deepEqual(
    validateIdentifyMetadata({ title: null, author: null, category: null }),
    { title: null, author: null, category: null },
  );
  for (const m of [
    { ...metadata, instructions: "injected" },
    { ...metadata, title: "a".repeat(301) },
    { ...metadata, category: "" },
    { ...metadata, author: "x\u007f" },
    Object.create(metadata),
  ])
    assert.throws(() => validateIdentifyMetadata(m));
});
test("task payload is filename-only fixed endpoint/model/effort and successful results stay private", async (t) => {
  const f = await fixture(t);
  f.fetch((url, options) => {
    assert.equal(url, IDENTIFY_ENDPOINT);
    assert.equal(options.redirect, "error");
    const b = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(b.input), {
      filename: "Synthetic Lantern - Synthetic Writer.pdf",
    });
    assert.equal(b.model, "gpt-luna");
    assert.equal(b.effort, "low");
    assert.equal(b.output_format, "json_object");
    assert.equal(b.kind, "research_summary");
    assert.ok(!options.body.includes(f.session.session_hash));
    return answer();
  });
  const result = await f.run();
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).metadata, metadata);
  assert.equal(f.calls(), 1);
  const row = f.sql.prepare("SELECT * FROM filename_identifications").get();
  assert.equal(row.state, "completed");
  assert.ok(
    !JSON.stringify(row).includes("Synthetic Lantern - Synthetic Writer.pdf"),
  );
  assert.equal((await identifyCapability(f.env, f.d)).remaining, 19);
});
test("same filename and request ID are permanently deduplicated, conflicting filenames return409", async (t) => {
  const f = await fixture(t);
  await f.run();
  for (const requestId of [id(1), id(2)]) {
    const r = await f.run({
      filename: "Synthetic Lantern - Synthetic Writer.pdf",
      requestId,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.cached, true);
    assert.equal(body.requestId, id(1));
  }
  assert.equal(
    (await f.run({ filename: "Different.pdf", requestId: id(1) })).status,
    409,
  );
  assert.equal((await f.run(id(1))).status, 200);
  assert.equal(f.calls(), 1);
  assert.equal(
    f.sql.prepare("SELECT count(*) AS n FROM filename_identifications").get().n,
    1,
  );
});
test("concurrent tabs dispatch once, expose only pending until completion, and block other filenames", async (t) => {
  const f = await fixture(t);
  let release, started;
  const ready = new Promise((r) => (started = r));
  f.fetch(async () => {
    started();
    await new Promise((r) => (release = r));
    return answer();
  });
  const first = f.run();
  await ready;
  const duplicate = await f.run({
    filename: "Synthetic Lantern - Synthetic Writer.pdf",
    requestId: id(2),
  });
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).requestId, id(1));
  assert.equal((await f.run(id(1))).status, 202);
  assert.equal(
    (await f.run({ filename: "Another.pdf", requestId: id(3) })).status,
    409,
  );
  assert.equal(f.calls(), 1);
  release();
  assert.equal((await first).status, 200);
});
test("lost durable INSERT response never dispatches and pending survives restart/deadline observation", async (t) => {
  const f = await fixture(t);
  f.db.lostClaim = true;
  assert.equal((await f.run()).status, 202);
  assert.equal(f.calls(), 0);
  const row = f.sql.prepare("SELECT * FROM filename_identifications").get(),
    savedNow = Date.now;
  try {
    Date.now = () => row.deadline_at + 1;
    assert.equal((await f.run(id(1))).status, 409);
    assert.equal(
      (await f.run({ filename: "Next.pdf", requestId: id(2) })).status,
      409,
    );
  } finally {
    Date.now = savedNow;
  }
  assert.equal(
    f.sql.prepare("SELECT state FROM filename_identifications").get().state,
    "pending",
  );
  assert.equal(f.calls(), 0);
});
test("timeout with ignored abort retains uncertain call and permanently blocks new IDs/days", async (t) => {
  const f = await fixture(t);
  f.fetch(() => new Promise(() => {}));
  assert.equal((await f.run(undefined, { timeoutMs: 5 })).status, 409);
  assert.equal(f.calls(), 1);
  assert.equal(
    (await identifyCapability(f.env, f.d)).code,
    "identify_reconciliation_required",
  );
  assert.equal(
    (await f.run({ filename: "Next.pdf", requestId: id(2) })).status,
    409,
  );
  assert.equal(f.calls(), 1);
  const state = f.sql
    .prepare("SELECT state FROM filename_identifications")
    .get().state;
  assert.equal(state, "uncertain");
  assert.throws(
    () => f.sql.exec("DELETE FROM filename_identifications"),
    /retained/,
  );
  assert.throws(
    () => f.sql.exec("UPDATE filename_identifications SET state='failed'"),
    /transition_invalid/,
  );
});
test("cross-connection SQL claims enforce one global caller and daily20 including failures", async (t) => {
  const f = await fixture(t, { file: true }),
    other = f.second();
  const insert = (conn, n, at) =>
    conn
      .prepare(
        "INSERT INTO filename_identifications VALUES('production',?,?,'filename-v1',?,1,?,?,?,5,'pending',NULL,NULL,NULL,?)",
      )
      .run(
        id(n),
        n.toString(16).padStart(64, "0"),
        f.session.session_hash,
        at,
        at + 60000,
        Math.floor(at / 86400000),
        at,
      );
  const now = Date.now();
  insert(f.sql, 1, now);
  assert.throws(() => insert(other, 2, now), /identify_call_locked/);
  f.sql
    .prepare(
      "UPDATE filename_identifications SET state='failed',error_code='identify_upstream_failed' WHERE request_id=?",
    )
    .run(id(1));
  for (let n = 2; n <= 20; n++) {
    insert(n % 2 ? f.sql : other, n, now);
    other
      .prepare(
        "UPDATE filename_identifications SET state='failed',error_code='identify_upstream_failed' WHERE request_id=?",
      )
      .run(id(n));
  }
  assert.throws(() => insert(other, 21, now), /identify_daily_budget/);
  const nextDay = (Math.floor(now / 86400000) + 1) * 86400000 + 1;
  other.prepare("UPDATE sessions SET expires_at=?").run(nextDay + 1000);
  insert(other, 21, nextDay);
  other
    .prepare(
      "UPDATE filename_identifications SET state='uncertain',error_code='identify_upstream_uncertain' WHERE request_id=?",
    )
    .run(id(21));
  assert.throws(() => insert(f.sql, 22, nextDay), /identify_call_locked/);
});
test("explicit4xx and invalid completed metadata never auto-retry or cache invented fields", async (t) => {
  const f = await fixture(t);
  f.fetch(() => new Response("private upstream error", { status: 401 }));
  assert.equal((await f.run()).status, 502);
  assert.equal((await f.run()).status, 502);
  assert.equal(f.calls(), 1);
  f.fetch(() => answer({ ...metadata, secret: "private injected extra" }));
  const r = await f.run({ filename: "Invalid.pdf", requestId: id(2) });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, "identify_invalid_output");
  assert.equal(f.calls(), 2);
  assert.ok(
    !JSON.stringify(
      f.sql.prepare("SELECT * FROM filename_identifications").all(),
    ).includes("private injected extra"),
  );
});
test("revoked session after upstream await cannot read output, including cache/poll", async (t) => {
  const f = await fixture(t);
  f.fetch(() => {
    f.sql.exec("UPDATE sessions SET revoked=1");
    return answer();
  });
  assert.equal((await f.run()).status, 401);
  assert.equal((await f.run(id(1))).status, 401);
  assert.equal(f.calls(), 1);
  assert.equal(
    f.sql.prepare("SELECT state FROM filename_identifications").get().state,
    "completed",
  );
});
test("revocation after durable claim prevents dispatch and releases only as a known no-fetch failure", async (t) => {
  const f = await fixture(t);
  f.db.afterClaim = () => f.sql.exec("UPDATE sessions SET revoked=1");
  assert.equal((await f.run()).status, 401);
  assert.equal(f.calls(), 0);
  const row = f.sql
    .prepare("SELECT state,error_code FROM filename_identifications")
    .get();
  assert.equal(row.state, "failed");
  assert.equal(row.error_code, "authentication_required");
});
test("retained identification history does not block full Worker expired-session maintenance", async (t) => {
  const f = await fixture(t);
  await f.run();
  const now = Date.now();
  f.sql
    .prepare("UPDATE sessions SET created_at=?,expires_at=?")
    .run(now - 3 * 86400000, now - 2 * 86400000);
  f.env.OWNER_KEY_PEPPER = Buffer.alloc(32, 2).toString("base64url");
  f.env.SESSION_SECRET = Buffer.alloc(32, 3).toString("base64url");
  assert.equal(
    (await handleRequest(new Request(ORIGIN + "/api/health"), f.env)).status,
    200,
  );
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
  assert.equal(
    f.sql.prepare("SELECT count(*) AS n FROM filename_identifications").get().n,
    1,
  );
  const other = await fixture(t, { file: true });
  await other.run();
  const connection = other.second();
  connection
    .prepare("UPDATE sessions SET created_at=?,expires_at=?")
    .run(now - 3 * 86400000, now - 2 * 86400000);
  connection.exec("DELETE FROM sessions");
  assert.equal(
    other.sql
      .prepare("SELECT count(*) AS n FROM filename_identifications")
      .get().n,
    1,
  );
});
test("success envelope pins real model/kind/task ID and validates usage without converting missing to zero", async () => {
  const key = "synthetic_private_key_123456789";
  for (const change of [
    (v) => {
      delete v.task_id;
    },
    (v) => {
      v.task_id = " ";
    },
    (v) => {
      v.model = "gpt-sol";
    },
    (v) => {
      v.kind = "custom";
    },
    (v) => {
      v.usage = { input_tokens: -1 };
    },
    (v) => {
      v.usage = { input_tokens: 1.5 };
    },
    (v) => {
      v.usage = { private_field: 1 };
    },
    (v) => {
      v.usage = [];
    },
  ]) {
    const value = envelope();
    change(value);
    await assert.rejects(
      callIdentifyTask(key, "a.pdf", {
        fetchImpl: async () => Response.json(value),
        timeoutMs: 100,
      }),
      /uncertain/,
    );
  }
  for (const absent of ["missing", "null"]) {
    const value = envelope({ title: null, author: null, category: null });
    if (absent === "missing") delete value.usage;
    else value.usage = null;
    const r = await callIdentifyTask(key, "a.pdf", {
      fetchImpl: async () => Response.json(value),
      timeoutMs: 100,
    });
    assert.equal(r.usage, null);
    assert.equal(r.metadata.title, null);
  }
});
test("lost completion response retains completed cache and cannot cause second upstream call", async (t) => {
  const f = await fixture(t);
  f.db.lostSave = true;
  await assert.rejects(f.run(), /lost response/);
  assert.equal((await f.run()).status, 200);
  assert.equal(f.calls(), 1);
});
test("adapter bounds response bytes/chunks/deadline and handles nonterminating cancel/late fetch", async () => {
  const key = "synthetic_private_key_123456789";
  await assert.rejects(
    callIdentifyTask(key, "a.pdf", {
      fetchImpl: async () =>
        new Response("x".repeat(65537), {
          headers: { "Content-Type": "application/json" },
        }),
      timeoutMs: 100,
    }),
    /uncertain/,
  );
  await assert.rejects(
    callIdentifyTask(key, "a.pdf", {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array());
            },
            cancel() {
              return new Promise(() => {});
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      timeoutMs: 10,
    }),
    /uncertain/,
  );
  await assert.rejects(
    callIdentifyTask(key, "a.pdf", {
      fetchImpl: async () =>
        new Promise((resolve) => setTimeout(() => resolve(answer()), 20)),
      timeoutMs: 2,
    }),
    /uncertain/,
  );
  await assert.rejects(
    callIdentifyTask(key, "a.pdf", {
      fetchImpl: async () =>
        new Response("{}", {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      timeoutMs: 100,
    }),
    /uncertain/,
  );
});
test("full Worker denies anonymous, wrong Origin/CSRF and never calls AI", async (t) => {
  const f = await fixture(t),
    owner = Buffer.alloc(32, 1).toString("base64url");
  f.env.OWNER_KEY_PEPPER = Buffer.alloc(32, 2).toString("base64url");
  f.env.SESSION_SECRET = Buffer.alloc(32, 3).toString("base64url");
  f.sql
    .prepare("UPDATE auth_config SET verifier=?,generation=2")
    .run(await createOwnerVerifier(owner, f.env.OWNER_KEY_PEPPER, f.context));
  const req = (headers = {}, body = { filename: "a.pdf", requestId: id(1) }) =>
    new Request(ORIGIN + "/api/manage/identify", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await handleRequest(req(), f.env)).status, 401);
  const login = await handleRequest(
    new Request(ORIGIN + "/api/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: owner }),
    }),
    f.env,
  );
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await handleRequest(
        req({ Cookie: cookie, Origin: "https://wrong.invalid" }),
        f.env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleRequest(
        req({ Cookie: cookie, "X-CSRF-Token": "invalid" }),
        f.env,
      )
    ).status,
    403,
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) AS n FROM filename_identifications").get().n,
    0,
  );
});
