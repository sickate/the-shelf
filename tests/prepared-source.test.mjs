import test from "node:test";
import assert from "node:assert/strict";
import { fixture, FILE, BOOK } from "./helpers/prepared-v2-fixture.mjs";
import {
  loadPreparedForJob,
  preparedRoute,
} from "../cloudflare/library/prepared.mjs";
import {
  PREPARED_SOURCE_LIMITS,
  PREPARED_SOURCE_SQL,
  PREPARED_SOURCE_ADMISSION_SQL,
} from "../cloudflare/library/prepared-source.mjs";
import {
  storageReadConfiguration,
  confirmedSourceProjection,
  decodePreparedNormalSource,
  confirmedSourceGuard,
  readSourceAdapter,
  STORAGE_SOURCE_SQL,
  STORAGE_SOURCE_GUARD_SQL,
} from "../cloudflare/library/storage-sources.mjs";
import { createHash } from "node:crypto";
const rejects = (p, status) =>
  assert.rejects(
    p,
    (e) => e instanceof Error && (!status || e.status === status),
  );
const pureInput = (f) => ({
  scope: f.grant.context.scope,
  fileId: FILE,
  sessionHash: f.grant.session.session_hash,
  generation: 1,
  nowMs: Date.now(),
  origin: f.grant.context.origin,
});
const observe = (f) => {
  const config = storageReadConfiguration(f.env),
    input = pureInput(f),
    p = confirmedSourceProjection(config, input);
  return {
    config,
    input,
    observation: f.db.prepare(p.sql).get(...p.parameters),
  };
};
for (const format of ["PDF", "EPUB"])
  for (const profile of ["trial-010", "activation-011"])
    test(`v2 ${format} ${profile} prepared uses exactly 3 control statements, one page, 3 R2 and one final admission`, async (t) => {
      const f = await fixture(t, { format, profile, extraFile: true });
      let legacyCalls = 0;
      const result = await f.load({
        admitAccess: () => {
          legacyCalls++;
          throw Error("legacy must not run");
        },
      });
      assert.equal(result.value.chunks.length, 2);
      assert.equal(legacyCalls, 0);
      assert.equal(f.admissions(), 1);
      assert.equal(f.calls.length, 4);
      assert.equal(
        f.calls.filter((c) => c.sql === PREPARED_SOURCE_SQL).length,
        2,
      );
      assert.equal(
        f.calls.filter((c) => c.sql === PREPARED_SOURCE_ADMISSION_SQL).length,
        1,
      );
      assert.equal(
        f.calls.filter((c) => c.sql.includes("LIMIT 1000")).length,
        1,
      );
      assert.deepEqual(
        f.preparedR2.map((c) => c[0]),
        ["head", "get", "head"],
      );
      assert.equal(f.r2.length, 0);
      assert.deepEqual(f.preparedR2[1][2], {
        onlyIf: { etagMatches: "prepared-etag" },
      });
    });
test("fixed SQL, bind and original source budgets remain pinned", () => {
  assert.equal(
    createHash("sha256").update(STORAGE_SOURCE_SQL).digest("hex"),
    "288c332940e6ed423db2dbeeca6a114bd78bdc7444c2df41ba7e3f99ed4a1e46",
  );
  assert.equal(
    createHash("sha256").update(STORAGE_SOURCE_GUARD_SQL).digest("hex"),
    "1dd9f6d8a3b705046b0a1a9bc672119451969e17da49f1b4983c2b194870c719",
  );
  for (const sql of [PREPARED_SOURCE_SQL, PREPARED_SOURCE_ADMISSION_SQL])
    assert.ok(Buffer.byteLength(sql) <= 16384);
  assert.deepEqual(
    [
      PREPARED_SOURCE_LIMITS.parameters,
      PREPARED_SOURCE_LIMITS.admissionParameters,
    ],
    [10, 14],
  );
  assert.ok(PREPARED_SOURCE_SQL.includes("LIMIT 2"));
  assert.ok(
    PREPARED_SOURCE_SQL.includes(
      "COALESCE(length(CAST(p.original_object_key AS BLOB)),0)",
    ),
  );
});
test("pure normal proof accepts full multi-file catalog without minting a storage grant", async (t) => {
  const f = await fixture(t, { extraFile: true }),
    { config, input, observation } = observe(f),
    result = decodePreparedNormalSource(config, observation, input, BOOK);
  assert.equal(
    JSON.parse(JSON.parse(observation.snapshot_json).catalog_json).files.length,
    2,
  );
  assert.equal(result.source, "normal");
  assert.throws(
    () => confirmedSourceGuard(result),
    (e) => e.status === 409,
  );
  assert.throws(
    () => readSourceAdapter(f.env, result),
    (e) => e.status === 409,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.preparedR2.length, 0);
});
for (const source of ["trial", "both"])
  test(`${source} is rejected before prepared R2 and admission`, async (t) => {
    const f = await fixture(t, { source });
    await rejects(f.load(), 409);
    assert.equal(f.preparedR2.length, 0);
    assert.equal(f.admissions(), 0);
  });
for (const mutate of [
  (f) => {
    f.env.STORAGE_MODE = "unknown";
  },
  (f) => {
    delete f.env.STORAGE_MODE;
  },
  (f) => {
    delete f.env.STORAGE_WRITE_MODE;
  },
  (f) => {
    delete f.env.TRIAL_BOOKS;
  },
  (f) => {
    delete f.env.PREPARED_R2_BUCKET;
  },
  (f) => {
    delete f.env.DB.withSession;
  },
])
  test("direct v2 load rejects incomplete or unknown configuration without legacy fallback", async (t) => {
    const f = await fixture(t);
    mutate(f);
    await rejects(f.load(), 503);
    assert.equal(f.calls.length, 0);
    assert.equal(f.preparedR2.length, 0);
  });
for (const [label, mutate] of [
  ["unknown DDL", (f) => f.db.exec("CREATE TABLE unexpected(a TEXT)")],
  [
    "wrong authority target",
    (f) =>
      f.unsafe(() =>
        f.db
          .prepare(
            "UPDATE shelf_storage_authority SET identity_json=json_set(identity_json,'$.accountId',?)",
          )
          .run("b".repeat(32)),
      ),
  ],
  ["logout", (f) => f.db.prepare("UPDATE sessions SET revoked=1").run()],
  [
    "expiry",
    (f) => {
      f.db.exec("PRAGMA ignore_check_constraints=ON");
      f.db.prepare("UPDATE sessions SET expires_at=created_at+90000000").run();
    },
  ],
  [
    "bad session lifetime",
    (f) => {
      f.db.exec("PRAGMA ignore_check_constraints=ON");
      f.db.prepare("UPDATE sessions SET expires_at=created_at").run();
    },
  ],
  [
    "generation",
    (f) => f.db.prepare("UPDATE auth_config SET generation=generation+1").run(),
  ],
  [
    "origin",
    (f) =>
      f.unsafe(() =>
        f.db
          .prepare("UPDATE auth_config SET origin='https://wrong.invalid'")
          .run(),
      ),
  ],
  ["trash", (f) => f.db.prepare("UPDATE book_management SET trashed=1").run()],
  [
    "source descriptor extra",
    (f) =>
      f.unsafe(() => {
        f.db
          .prepare(
            "UPDATE shelf_storage_original_registry SET descriptor_json=json_set(descriptor_json,'$.extra',1)",
          )
          .run();
        f.db
          .prepare(
            "UPDATE shelf_storage_reservations SET descriptor_json=json_set(descriptor_json,'$.extra',1) WHERE reservation_id='normal_reservation'",
          )
          .run();
      }),
  ],
  [
    "partial 011",
    (f) => f.db.exec("CREATE TABLE shelf_storage_activations(fake TEXT)"),
  ],
])
  test(`${label} closes before prepared R2`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    await rejects(f.load());
    assert.equal(f.preparedR2.length, 0);
    assert.equal(f.admissions(), 0);
  });
for (const mutate of [
  (o) => ({ ...o, extra: 1 }),
  (o) => ({ ...o, overflow: 1 }),
  (o) => ({ ...o, overflow: "0" }),
  (o) => ({ ...o, snapshot_json: null }),
  (o) => ({ ...o, snapshot_json: " ".repeat(524225) }),
])
  test("pure source proof enforces exact outer shape and byte caps", async (t) => {
    const f = await fixture(t),
      { config, input, observation } = observe(f);
    assert.throws(
      () =>
        decodePreparedNormalSource(config, mutate(observation), input, BOOK),
      (e) => e.status === 503,
    );
  });
for (const [label, mutate] of [
  [
    "file version",
    (f) =>
      f.unsafe(() =>
        f.db.prepare("UPDATE file_registry SET version=version+1").run(),
      ),
  ],
  [
    "catalog",
    (f) =>
      f.db
        .prepare(
          "UPDATE catalog_books SET public_json=json_set(public_json,'$.title','changed')",
        )
        .run(),
  ],
  [
    "management version",
    (f) => f.db.prepare("UPDATE book_management SET version=version+1").run(),
  ],
  ["schema", (f) => f.db.exec("CREATE TABLE unexpected(a)")],
  ["session", (f) => f.db.prepare("UPDATE sessions SET revoked=1").run()],
  [
    "prepared timestamp",
    (f) =>
      f.unsafe(() =>
        f.db
          .prepare("UPDATE shelf_prepared_indexes SET created_at=created_at+1")
          .run(),
      ),
  ],
])
  test(`drift during R2: ${label} yields zero final admission`, async (t) => {
    const f = await fixture(t),
      get = f.preparedStore.get;
    f.preparedStore.get = async (...args) => {
      const result = await get(...args);
      mutate(f);
      return result;
    };
    await rejects(f.load());
    assert.equal(f.admissions(), 0);
  });
for (const [label, mutate] of [
  [
    "DB",
    (f) => {
      f.env.DB = { ...f.env.DB };
    },
  ],
  [
    "withSession",
    (f) => {
      f.env.DB.withSession = function () {
        return this;
      };
    },
  ],
  [
    "prepared binding",
    (f) => {
      f.env.PREPARED_BOOKS = { ...f.preparedStore };
    },
  ],
  [
    "prepared get",
    (f) => {
      f.preparedStore.get = async () => {
        throw Error("changed");
      };
    },
  ],
  [
    "prepared head",
    (f) => {
      f.preparedStore.head = async () => {
        throw Error("changed");
      };
    },
  ],
  [
    "normal binding",
    (f) => {
      f.env.BOOKS = { ...f.normalStore };
    },
  ],
  [
    "trial binding",
    (f) => {
      f.env.TRIAL_BOOKS = { ...f.trialStore };
    },
  ],
  [
    "mode",
    (f) => {
      f.env.STORAGE_MODE = "changed";
    },
  ],
])
  for (const phase of ["initial", "get", "admission", "final"])
    test(`capture rejects ${label} drift after ${phase} await`, async (t) => {
      const f = await fixture(t);
      let seen = 0;
      if (phase === "get") {
        const get = f.preparedStore.get;
        f.preparedStore.get = async (...args) => {
          const result = await get(...args);
          mutate(f);
          return result;
        };
      } else
        f.env.DB.afterFirst = async (sql) => {
          if (sql === PREPARED_SOURCE_SQL) {
            seen++;
            if (
              (phase === "initial" && seen === 1) ||
              (phase === "final" && seen === 2)
            )
              mutate(f);
          }
          if (phase === "admission" && sql === PREPARED_SOURCE_ADMISSION_SQL)
            mutate(f);
        };
      await rejects(f.load());
      assert.equal(
        f.admissions(),
        phase === "admission" || phase === "final" ? 1 : 0,
      );
    });
test("guard sees a source change immediately before insertion and consumes zero access", async (t) => {
  const f = await fixture(t),
    prepare = f.env.DB.prepare;
  f.env.DB.prepare = function (sql) {
    if (sql === PREPARED_SOURCE_ADMISSION_SQL)
      f.unsafe(() =>
        f.db.prepare("UPDATE file_registry SET version=version+1").run(),
      );
    return prepare.call(this, sql);
  };
  await rejects(f.load(), 401);
  assert.equal(f.admissions(), 0);
});
test("final primary rejects database drift during admission await after exactly one access", async (t) => {
  const f = await fixture(t);
  f.env.DB.afterFirst = async (sql) => {
    if (sql === PREPARED_SOURCE_ADMISSION_SQL)
      f.db.prepare("UPDATE book_management SET version=version+1").run();
  };
  await rejects(f.load(), 401);
  assert.equal(f.admissions(), 1);
});
test("lost admission response never retries or returns private bytes", async (t) => {
  const f = await fixture(t);
  f.env.DB.afterFirst = async (sql) => {
    if (sql === PREPARED_SOURCE_ADMISSION_SQL) throw Error("lost result");
  };
  await rejects(f.load(), 503);
  assert.equal(f.admissions(), 1);
  assert.equal(
    f.calls.filter((c) => c.sql === PREPARED_SOURCE_ADMISSION_SQL).length,
    1,
  );
});
test("20,000 chunks use exactly 20 bounded primary pages and 3 source/control statements", async (t) => {
  const f = await fixture(t, { count: 20000 });
  const result = await f.load();
  assert.equal(result.value.chunks.length, 20000);
  assert.equal(f.calls.length, 23);
  assert.equal(f.calls.filter((c) => c.sql.includes("LIMIT 1000")).length, 20);
  assert.equal(f.admissions(), 1);
  assert.equal(f.preparedR2.length, 3);
});
test("late get body is cancelled without awaiting never-settling cancellation", async (t) => {
  const f = await fixture(t);
  let cancelled = 0;
  f.preparedStore.get = () =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            size: f.bytes.length,
            etag: "prepared-etag",
            body: {
              locked: false,
              cancel() {
                cancelled++;
                return new Promise(() => {});
              },
            },
          }),
        25,
      ),
    );
  await rejects(f.load({ deadlineMs: 5 }), 503);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(cancelled, 1);
  assert.equal(f.admissions(), 0);
});
test("prepared oversized non-descriptor raw text is bounded before JSON construction", async (t) => {
  const f = await fixture(t);
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.unsafe(() => {
    const huge = "x".repeat(100000);
    f.db.prepare("UPDATE shelf_prepared_indexes SET etag=?").run(huge);
    f.db.prepare("UPDATE shelf_storage_text_registry SET etag=?").run(huge);
    f.db
      .prepare(
        "UPDATE shelf_storage_reservations SET etag=? WHERE reservation_id='text-reservation'",
      )
      .run(huge);
  });
  await rejects(f.load());
  assert.equal(f.preparedR2.length, 0);
});
for (const phase of ["initial", "page", "admission", "final"])
  for (const target of ["prepare", "operation", "bind"])
    test(`captured ${phase} D1 ${target} drift during deferred await is rejected`, async (t) => {
      const f = await fixture(t),
        originalPrepare = f.env.DB.prepare;
      let sourceCount = 0,
        changed = false;
      f.env.DB.prepare = function (sql) {
        const query = originalPrepare.call(this, sql),
          oldBind = query.bind;
        query.bind = function (...args) {
          const statement = oldBind.apply(this, args),
            method = sql.includes("LIMIT 1000") ? "all" : "first",
            original = statement[method];
          if (sql === PREPARED_SOURCE_SQL) sourceCount++;
          const relevant =
            (phase === "initial" &&
              sql === PREPARED_SOURCE_SQL &&
              sourceCount === 1) ||
            (phase === "final" &&
              sql === PREPARED_SOURCE_SQL &&
              sourceCount === 2) ||
            (phase === "admission" && sql === PREPARED_SOURCE_ADMISSION_SQL) ||
            (phase === "page" && sql.includes("LIMIT 1000"));
          if (relevant)
            statement[method] = async function () {
              const result = await original.call(this);
              await Promise.resolve();
              changed = true;
              if (target === "prepare")
                f.env.DB.prepare = function () {
                  throw Error("replaced prepare");
                };
              else if (target === "bind")
                query.bind = function () {
                  throw Error("replaced bind");
                };
              else statement[method] = async () => result;
              return result;
            };
          return statement;
        };
        return query;
      };
      await rejects(f.load());
      assert.equal(changed, true);
      assert.equal(
        f.admissions(),
        phase === "admission" || phase === "final" ? 1 : 0,
      );
    });
for (const phase of ["initial", "final"])
  test(`session expiring during ${phase} SQL await is rejected using current time`, async (t) => {
    const f = await fixture(t);
    const originalNow = Date.now;
    let count = 0;
    f.env.DB.afterFirst = async (sql) => {
      if (
        sql === PREPARED_SOURCE_SQL &&
        ++count === (phase === "initial" ? 1 : 2)
      ) {
        const expires = f.db
          .prepare("SELECT expires_at FROM sessions")
          .get().expires_at;
        Date.now = () => expires + 1;
      }
    };
    try {
      await rejects(f.load(), 401);
      assert.equal(f.admissions(), phase === "initial" ? 0 : 1);
    } finally {
      Date.now = originalNow;
    }
  });
for (const field of [
  "scope",
  "file_id",
  "version_hash",
  "book_id",
  "text_reservation_id",
  "text_logical_key",
  "package_sha256",
  "source_sha256",
  "etag",
  "format",
  "chunk_count",
  "text_bytes",
  "codepoint_count",
  "index_sha256",
  "created_at",
  "descriptor_json",
  "identity_json",
  "management_version",
  "original_descriptor_json",
  "original_etag",
  "original_object_key",
  "original_sha256",
  "original_size_bytes",
  "original_format",
  "original_version",
  "actual_chunk_count",
])
  test(`prepared named primitive ${field} rejects null before R2`, async (t) => {
    const f = await fixture(t);
    f.env.DB.afterFirst = async (sql, params, result) => {
      if (sql === PREPARED_SOURCE_SQL) {
        const row = JSON.parse(result.prepared_json);
        row[field] = null;
        result.prepared_json = JSON.stringify(row);
      }
    };
    await rejects(f.load());
    assert.equal(f.preparedR2.length, 0);
    assert.equal(f.admissions(), 0);
  });
for (const phase of ["head", "stream", "index-page"])
  test(`prepared binding drift after ${phase} asynchronous work discards bytes`, async (t) => {
    const f = await fixture(t);
    if (phase === "head") {
      const head = f.preparedStore.head;
      f.preparedStore.head = async (...args) => {
        const result = await head(...args);
        f.env.TRIAL_BOOKS = { ...f.trialStore };
        return result;
      };
    } else if (phase === "stream") {
      f.preparedStore.get = async () => ({
        size: f.bytes.length,
        etag: "prepared-etag",
        body: new ReadableStream({
          pull(controller) {
            f.env.TRIAL_BOOKS = { ...f.trialStore };
            controller.enqueue(f.bytes);
            controller.close();
          },
        }),
      });
    } else {
      const prepare = f.env.DB.prepare;
      f.env.DB.prepare = function (sql) {
        const query = prepare.call(this, sql);
        const bind = query.bind;
        query.bind = function (...args) {
          const statement = bind.apply(this, args);
          if (sql.includes("LIMIT 1000")) {
            const all = statement.all;
            statement.all = async () => {
              const result = await all.call(statement);
              f.env.PREPARED_BOOKS = { ...f.preparedStore };
              return result;
            };
          }
          return statement;
        };
        return query;
      };
    }
    await rejects(f.load());
    assert.equal(f.admissions(), 0);
  });
test("wrong admission requestId never authorizes a private result", async (t) => {
  const f = await fixture(t);
  f.env.DB.afterFirst = async (sql, params, result) => {
    if (sql === PREPARED_SOURCE_ADMISSION_SQL) result.request_id = "wrong";
  };
  await rejects(f.load(), 401);
  assert.equal(f.admissions(), 1);
});
