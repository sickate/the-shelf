import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  fixture,
  activate,
  identity,
} from "./helpers/storage-schema-fixture.mjs";
import { RemoteStorageAuthority } from "../server/remote-storage-authority.mjs";
import { prepareObject } from "../server/storage-authority.mjs";
import {
  STORAGE_ACTIVATION_V2_SOURCE,
  STORAGE_ACTIVATION_V2_SCHEMA_SHA256,
} from "../server/storage-activation-v2.mjs";
import {
  readStorageSchemaState,
  STORAGE_SCHEMA_PROFILES,
  STORAGE_SCHEMA_STATE_SQL,
  STORAGE_SCHEMA_MANIFEST_SQL,
} from "../server/storage-schema-state.mjs";

const json = JSON.stringify;
const query =
  (db) =>
  async (sql, params = []) =>
    db.prepare(sql).all(...params);
test("manifest is ordered exact SQL JSON with bounded additional response payload", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of [
      "schema.sql",
      "migrations/003-storage-authority.sql",
      "migrations/004-freeze-legacy-storage.sql",
      "migrations/005-single-trial.sql",
    ])
      db.exec(
        readFileSync(
          new URL("../cloudflare/library/" + name, import.meta.url),
          "utf8",
        ),
      );
    assert.equal(
      db.prepare(`SELECT ${STORAGE_SCHEMA_MANIFEST_SQL} AS manifest`).get()
        .manifest,
      json(STORAGE_SCHEMA_PROFILES["trial-v1"]),
    );
    for (const [layout, maximum] of [
      ["legacy-v1", 25693],
      ["trial-v1", 32807],
      ["activation-v2", 57661],
    ]) {
      const extra =
        Buffer.byteLength(
          json({ storage_schema_json: json(STORAGE_SCHEMA_PROFILES[layout]) }),
        ) - 2;
      assert.equal(extra, maximum);
      assert.ok(extra < 1_000_000);
    }
  } finally {
    db.close();
  }
});

function remote(f, extra = {}) {
  const calls = [],
    writes = [];
  const create = (options = {}) =>
    new RemoteStorageAuthority({
      identity,
      credentials: { accountId: identity.accountId, token: "synthetic-token" },
      resource: {
        databaseId: identity.legacyDatabases.production,
        databaseName: "the-shelf-library",
      },
      clock: () => f.now,
      requestLimit: 256,
      beforeRequest: async () => {},
      fetchImpl: async (url, options) => {
        assert.ok(url.includes(identity.legacyDatabases.production));
        if (!url.endsWith("/query")) {
          calls.push("identity");
          return Response.json({
            success: true,
            result: {
              uuid: identity.legacyDatabases.production,
              name: "the-shelf-library",
            },
          });
        }
        const { sql, params } = JSON.parse(options.body);
        calls.push(sql);
        if (!sql.startsWith("SELECT")) writes.push(sql);
        return Response.json({
          success: true,
          result: [
            { success: true, results: f.db.prepare(sql).all(...params) },
          ],
        });
      },
      ...extra,
      ...options,
    });
  return { create, calls, writes };
}

for (const layout of ["legacy-v1", "trial-v1", "activation-v2"])
  test(`exact complete profile: ${layout}`, async (t) => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    if (layout === "activation-v2") {
      const f = await fixture(t);
      const s = await readStorageSchemaState({ query: query(f.db) });
      assert.equal(s.layout, layout);
      assert.equal(s.schemaSha256, STORAGE_ACTIVATION_V2_SCHEMA_SHA256);
      return;
    }
    for (const name of [
      "schema.sql",
      "migrations/003-storage-authority.sql",
      "migrations/004-freeze-legacy-storage.sql",
      ...(layout === "trial-v1" ? ["migrations/005-single-trial.sql"] : []),
    ])
      db.exec(
        readFileSync(
          new URL("../cloudflare/library/" + name, import.meta.url),
          "utf8",
        ),
      );
    assert.equal(
      (await readStorageSchemaState({ query: query(db) })).layout,
      layout,
    );
    assert.ok(Object.isFrozen(STORAGE_SCHEMA_PROFILES[layout]));
    if (layout === "legacy-v1")
      await assert.rejects(
        readStorageSchemaState({ query: query(db), requireTrial: true }),
        { code: "single_trial_schema_required" },
      );
  });

test("partial trial and v2 never fall back; extra objects and literal drift fail exact profiles", async (t) => {
  const f = await fixture(t, { install: false });
  f.db.exec("DROP TRIGGER shelf_single_trial_keep_imported");
  await assert.rejects(readStorageSchemaState({ query: query(f.db) }), {
    code: "single_trial_schema_invalid",
  });
  f.db.exec(
    STORAGE_SCHEMA_PROFILES["trial-v1"].find(
      (r) => r.name === "shelf_single_trial_keep_imported",
    ).sql,
  );
  f.db.exec(
    STORAGE_ACTIVATION_V2_SOURCE.slice(
      0,
      STORAGE_ACTIVATION_V2_SOURCE.indexOf(
        "CREATE TABLE shelf_storage_activation_v2",
      ),
    ),
  );
  await assert.rejects(readStorageSchemaState({ query: query(f.db) }), {
    code: "storage_v2_schema_incomplete",
  });
  const g = await fixture(t);
  const definition = STORAGE_SCHEMA_PROFILES["activation-v2"].find(
    (r) => r.name === "shelf_storage_v2_phase_gate",
  );
  g.db.exec(`DROP TRIGGER ${definition.name}`);
  g.db.exec(
    definition.sql.replace(
      "storage_v2_activation_required",
      "storage_v2_activation_required  ",
    ),
  );
  await assert.rejects(readStorageSchemaState({ query: query(g.db) }), {
    code: "storage_v2_schema_incomplete",
  });
});

test("default singleTrial=false counts consumed trial and every inspect rechecks the full schema", async (t) => {
  const f = await fixture(t, { install: false });
  const r = remote(f);
  const a = r.create();
  assert.equal((await a.inspect(identity)).committedBytes, 24591);
  assert.equal(r.calls.length, 3); // identity + complete schema + current accounting
  assert.equal((await a.inspectSingleTrial(identity)).state, "confirmed");
  assert.equal(r.calls.length, 6); // schema + accounting + trial row; no cached layout
  f.db.exec("DROP TRIGGER shelf_single_trial_keep_imported");
  await assert.rejects(a.inspect(identity), {
    code: "single_trial_schema_invalid",
  });
  assert.equal(r.writes.length, 0);
});

test("v2 closed facts count normal/trial/legacy; incomplete installation cannot be read", async (t) => {
  const f = await fixture(t, { legacy: 72 });
  const r = remote(f);
  const a = r.create();
  const s = await a.inspect(identity);
  assert.equal(s.phase, "imported");
  assert.equal(s.committedBytes, 24591);
  assert.equal(s.reservedBytes, 79);
  assert.equal(r.calls.length, 4); // identity + schema + responsibility + publication
  assert.throws(
    () =>
      f.db.exec(
        "UPDATE shelf_storage_authority SET reserved_bytes=reserved_bytes+1 WHERE id=1",
      ),
    /storage_v2_accounting_mismatch/,
  );
  f.db.exec("DROP TRIGGER shelf_storage_v2_accounting");
  await assert.rejects(a.inspect(identity), {
    code: "storage_v2_schema_incomplete",
  });
});

test("v2 historical publication remains readable after evidence ages; registry remains normal-only", async (t) => {
  const f = await fixture(t, { legacy: 72 });
  await activate(f);
  f.advance(86400000);
  const r = remote(f);
  const a = r.create();
  assert.equal((await a.inspect(identity)).phase, "ready");
  assert.equal(
    (await a.inspectSingleTrial(identity)).permit.descriptor.fileId,
    "trial_file",
  );
  const rows = await a.registry(identity, "original");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].descriptor.fileId, "old_confirmed");
  assert.equal(r.writes.length, 0);
});

test("active v2 publication hash and current balance are independently checked", async (t) => {
  const f = await fixture(t);
  await activate(f);
  const q = query(f.db);
  const rows = await q(STORAGE_SCHEMA_STATE_SQL.publication);
  const altered = { ...rows[0], published_evidence_json: "{}" };
  const { readStorageAuthorityState } =
    await import("../server/storage-schema-state.mjs");
  const schema = await readStorageSchemaState({ query: q });
  await assert.rejects(
    readStorageAuthorityState({
      identity,
      schema,
      query: async (sql, ...args) =>
        sql === STORAGE_SCHEMA_STATE_SQL.publication
          ? [altered]
          : q(sql, ...args),
    }),
    { code: "storage_v2_publication_invalid" },
  );
  await assert.rejects(
    readStorageAuthorityState({
      identity,
      schema,
      query: async (sql, ...args) => {
        const rows = await q(sql, ...args);
        if (sql.includes("AS actual_committed")) rows[0].actual_reserved++;
        return rows;
      },
    }),
    { code: "storage_ledger_mismatch" },
  );
  f.db
    .prepare(
      "UPDATE shelf_storage_authority SET evidence_hash=?,observed_at=observed_at+1 WHERE id=1",
    )
    .run("b".repeat(64));
  await assert.rejects(remote(f).create().inspect(identity), {
    code: "storage_v2_publication_invalid",
  });
});

test("schema change between discovery and accounting is rejected in the accounting statement", async (t) => {
  const f = await fixture(t, { install: false });
  const q = query(f.db);
  const schema = await readStorageSchemaState({ query: q });
  f.db.exec(STORAGE_ACTIVATION_V2_SOURCE);
  const { readStorageAuthorityState } =
    await import("../server/storage-schema-state.mjs");
  await assert.rejects(
    readStorageAuthorityState({ query: q, identity, schema }),
    { code: "storage_schema_changed" },
  );
});

test("011 installed immediately before a trial claim cannot consume the old permit", async (t) => {
  const bytes = new Uint8Array([1, 2, 3]);
  const object = await prepareObject({
    kind: "original",
    scope: "production",
    fileId: "trial_file",
    bookId: "book_trial_file",
    format: "PDF",
    bytes,
  });
  const f = await fixture(t, {
    install: false,
    confirmTrial: false,
    claimTrial: false,
    trialDescriptor: object.descriptor,
  });
  let injected = false;
  const r = remote(f, {
    beforeRequest: async (intent) => {
      if (intent.operation === "claim-single-trial-put") {
        f.db.exec(STORAGE_ACTIVATION_V2_SOURCE);
        injected = true;
      }
    },
  });
  await assert.rejects(
    r
      .create()
      .claimSingleTrialPut(identity, "consumed_once", object.descriptor, bytes),
    { code: "single_trial_put_already_claimed" },
  );
  assert.equal(injected, true);
  assert.equal(
    f.db.prepare("SELECT put_attempted FROM shelf_storage_single_trial").get()
      .put_attempted,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT state FROM shelf_storage_activation_v2").get().state,
    "closed",
  );
  assert.ok(r.writes[0].includes("json_group_array"));
});

for (const drift of [false, true])
  test(`trial confirmation rechecks complete layout after R2 awaits: drift=${drift}`, async (t) => {
    const bytes = new Uint8Array([1, 2, 3]);
    const object = await prepareObject({
      kind: "original",
      scope: "production",
      fileId: "trial_file",
      bookId: "book_trial_file",
      format: "PDF",
      bytes,
    });
    const f = await fixture(t, {
      install: false,
      confirmTrial: false,
      trialDescriptor: object.descriptor,
    });
    const r = remote(f);
    const a = r.create();
    let heads = 0;
    const store = {
      target: {
        accountId: identity.accountId,
        bucket: "the-shelf-first-book-20261023",
      },
      async head() {
        if (++heads === 2 && drift)
          f.db.exec("DROP TRIGGER shelf_single_trial_keep_imported");
        return {
          size: bytes.length,
          sha256: object.descriptor.sha256,
          etag: "synthetic_etag",
          contentType: "application/pdf",
        };
      },
      async get() {
        return new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        });
      },
      async put() {
        assert.fail("never upload");
      },
    };
    if (drift) {
      await assert.rejects(
        a.reconcileSingleTrial(identity, "consumed_once", store),
        { code: "object_verification_unknown" },
      );
      assert.equal(
        f.db.prepare("SELECT state FROM shelf_storage_single_trial").get()
          .state,
        "uploading",
      );
      assert.equal(r.writes.length, 0);
    } else {
      assert.equal(
        (await a.reconcileSingleTrial(identity, "consumed_once", store)).state,
        "confirmed",
      );
      assert.equal(r.calls.length, 10); // identity + 3 audits(schema/accounting), 2 trial reads, confirm
      assert.equal(r.writes.length, 1);
    }
    assert.equal(heads, 2);
  });

for (const active of [false, true])
  test(`v2 ${active ? "active" : "closed"} rejects all old mutation entry points with zero writes`, async (t) => {
    const f = await fixture(t);
    if (active) await activate(f);
    const r = remote(f);
    const a = r.create();
    const trial = await a.inspectSingleTrial(identity);
    const bytes = new Uint8Array([1, 2, 3]);
    const object = await prepareObject({
      kind: "original",
      scope: "production",
      fileId: "new_file",
      bookId: "new_book",
      format: "PDF",
      bytes,
    });
    for (const action of [
      () => a.migrateFrozen(identity, []),
      () => a.activateFrozen(identity, []),
      () => a.reserve(identity, "new_one", object.descriptor, bytes, {}),
      () => a.claimPut(identity, "old_unknown"),
      () => a.markUncertain(identity, "old_unknown"),
      () =>
        a.reconcile(identity, "old_unknown", {
          target: { accountId: identity.accountId, bucket: identity.bucket },
          head: async () => assert.fail("R2 must not run"),
          get() {},
          put() {},
        }),
      () => a.issueSingleTrial(identity, trial.permit),
      () =>
        a.claimSingleTrialPut(
          identity,
          trial.permit.permitId,
          object.descriptor,
          bytes,
        ),
      () => a.markSingleTrialUncertain(identity, trial.permit.permitId),
      () => a.reconcileSingleTrial(identity, trial.permit.permitId, {}),
    ])
      await assert.rejects(action(), { code: "storage_v2_write_unavailable" });
    assert.equal(r.writes.length, 0);
  });
