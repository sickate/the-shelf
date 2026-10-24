// Wholly synthetic J0 fixture. Actual base/007/008/009/010/012 SQL; storage facts
// are isolated test tables, never connected to R2 or an account.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  fixture as preparedFixture,
  BOOK,
  FILE,
  context,
} from "./prepared-fixture.mjs";
import { createJobsState } from "../../cloudflare/library/jobs-state.mjs";
export { BOOK, FILE, context };
export const NOW = Date.parse("2026-10-23T08:00:00Z");
export const migration012 = readFileSync(
  new URL(
    "../../cloudflare/library/migrations/012-cloud-jobs.sql",
    import.meta.url,
  ),
  "utf8",
);
export const baseFiles = [
  "schema.sql",
  "migrations/007-book-management.sql",
  "migrations/008-filename-identification.sql",
  "migrations/009-filename-identification-observations.sql",
];
export const readMigration = (name) =>
  readFileSync(
    new URL("../../cloudflare/library/" + name, import.meta.url),
    "utf8",
  );
export class SqlD1 {
  constructor(sql) {
    this.sql = sql;
    this.calls = [];
    this.lost = null;
    this.beforeBatch = null;
  }
  withSession(mode) {
    if (mode !== "first-primary") throw Error("primary expected");
    return this;
  }
  prepare(text) {
    const d = this;
    const make = (args = []) => ({
      bind: (...v) => make(v),
      first: async () => {
        d.calls.push({ text, args });
        return d.sql.prepare(text).get(...args) || null;
      },
      all: async () => {
        d.calls.push({ text, args });
        return { results: d.sql.prepare(text).all(...args) };
      },
      execute: () => {
        d.calls.push({ text, args });
        return { results: d.sql.prepare(text).all(...args) };
      },
    });
    return make();
  }
  async batch(statements) {
    await this.beforeBatch?.();
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const r = statements.map((s) => s.execute());
      if (this.lost === "before_commit") {
        this.lost = null;
        throw Error("synthetic precommit");
      }
      this.sql.exec("COMMIT");
      if (this.lost === "after_commit") {
        this.lost = null;
        throw Error("synthetic lost response");
      }
      return r;
    } catch (e) {
      if (this.sql.isTransaction) this.sql.exec("ROLLBACK");
      throw e;
    }
  }
}
export async function jobsFixture(
  t,
  { file = ":memory:", open = true, clock } = {},
) {
  const source = await preparedFixture(t);
  const sql = new DatabaseSync(file);
  sql.exec("PRAGMA busy_timeout=5000");
  t.after(() => sql.close());
  const scripts = baseFiles.map(readMigration);
  scripts.push(`
 CREATE TABLE shelf_storage_authority(id INTEGER PRIMARY KEY,identity_json TEXT);
 CREATE TABLE shelf_storage_reservations(reservation_id TEXT PRIMARY KEY,state TEXT,content_verified INTEGER,descriptor_json TEXT,etag TEXT);
 CREATE TABLE shelf_storage_text_registry(logical_key TEXT PRIMARY KEY,reservation_id TEXT,enabled INTEGER,descriptor_json TEXT,etag TEXT);
 CREATE TABLE shelf_storage_original_registry(logical_key TEXT PRIMARY KEY,reservation_id TEXT,enabled INTEGER,descriptor_json TEXT,etag TEXT);`);
  scripts.push(readMigration("migrations/010-prepared-index.sql"));
  for (const script of scripts) sql.exec(script);
  const insert = (table, row) =>
    sql
      .prepare(
        "INSERT INTO " +
          table +
          "(" +
          Object.keys(row).join(",") +
          ") VALUES(" +
          Object.keys(row)
            .map(() => "?")
            .join(",") +
          ")",
      )
      .run(...Object.values(row));
  insert("auth_config", {
    scope: "production",
    origin: context.origin,
    scheme: "owner-access-key-v1",
    verifier: "a".repeat(64),
    generation: 1,
    enabled: 1,
    updated_at: NOW - 100,
  });
  insert("sessions", {
    scope: "production",
    session_hash: source.session.session_hash,
    generation: 1,
    created_at: NOW - 100,
    expires_at: NOW + 7200000,
    revoked: 0,
  });
  for (const table of [
    "shelf_storage_authority",
    "shelf_storage_reservations",
    "shelf_storage_text_registry",
    "shelf_storage_original_registry",
    "catalog_books",
  ]) {
    for (const row of source.db.prepare("SELECT * FROM " + table).all())
      insert(table, row);
  }
  for (const row of source.db.prepare("SELECT * FROM file_registry").all())
    insert("file_registry", { ...row, updated_at: NOW - 100 });
  for (const row of source.db.prepare("SELECT * FROM book_management").all())
    insert("book_management", { ...row, updated_at: NOW - 100 });
  for (const table of [
    "shelf_prepared_indexes",
    "shelf_prepared_index_chunks",
    "shelf_prepared_index_publications",
  ])
    for (const row of source.db.prepare("SELECT * FROM " + table).all())
      insert(table, row);
  sql.exec(migration012);
  if (open)
    sql
      .prepare(
        "UPDATE shelf_job_control SET mode='jobs-v1',generation=2,updated_at=?",
      )
      .run(NOW);
  let at = NOW;
  const db = new SqlD1(sql),
    state = createJobsState(db, { clock: clock || (() => at) });
  const grant = {
    sessionHash: source.session.session_hash,
    generation: 1,
    origin: context.origin,
  };
  const input = (n = 1, operation = "question") => ({
    requestId: id(n),
    bookId: BOOK,
    source: { fileId: FILE, versionHash: source.pin.versionHash },
    operation,
    question: operation === "question" ? "Synthetic question " + n : null,
    range:
      operation === "chapter_summary"
        ? { type: "pdf-page", start: 1, end: 2 }
        : null,
  });
  return {
    sql,
    db,
    state,
    grant,
    input,
    source,
    advance(ms = 1) {
      at += ms;
    },
    setTime(n) {
      at = n;
    },
    get now() {
      return at;
    },
    scripts,
  };
}
export const id = (n) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
export const plan = (phase = "question") => ({
  phase,
  inputHash: "c".repeat(64),
  inputCodepoints: 20,
  requestBytes: 100,
  coverage: [],
});
export async function ready(
  f,
  n = 1,
  operation = "question",
  plans = [plan()],
) {
  const a = await f.state.admitJob(f.input(n, operation), f.grant);
  let workflowContext;
  await f.state.consumePermit(a.permit, async (c) => {
    workflowContext = c;
  });
  const p = await f.state.startPlanning(a.job.id, a.job.version);
  const r = await f.state.savePlan(a.job.id, p.version, plans);
  return { job: r, workflowContext };
}
export const complete = {
  outcome: "completed",
  content: "Synthetic private answer",
  usage: null,
  coverage: [],
};
export const uncertain = {
  outcome: "uncertain",
  content: null,
  usage: null,
  coverage: [],
};
export const literal = (v) =>
  v === null
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : "'" + v.replaceAll("'", "''") + "'";
export function seedSQL(f) {
  const tables = [
    "auth_config",
    "sessions",
    "catalog_books",
    "file_registry",
    "book_management",
    "shelf_storage_authority",
    "shelf_storage_reservations",
    "shelf_storage_text_registry",
    "shelf_storage_original_registry",
    "shelf_prepared_indexes",
    "shelf_prepared_index_chunks",
    "shelf_prepared_index_publications",
  ];
  let s = f.scripts.join("\n");
  for (const table of tables)
    for (const row of f.sql.prepare("SELECT * FROM " + table).all())
      s +=
        "\nINSERT INTO " +
        table +
        "(" +
        Object.keys(row).join(",") +
        ") VALUES(" +
        Object.values(row).map(literal).join(",") +
        ");";
  s +=
    "\n" +
    migration012 +
    "\nUPDATE shelf_job_control SET mode='jobs-v1',generation=2,updated_at=" +
    NOW +
    ";";
  return s;
}
