import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmedFileAccess,
  STORAGE_READ_ADMISSION_SQL,
  STORAGE_READ_LIMITS,
} from "../cloudflare/library/storage-read-controller.mjs";
import { handleRequest } from "../cloudflare/library/worker.mjs";
import {
  trialOperatorRoute,
  trialOperatorAuthorized,
} from "../cloudflare/library/single-trial.mjs";
import {
  uploadCapability,
  managementRoute,
} from "../cloudflare/library/management.mjs";
import {
  randomKey,
  sessionDigest,
  csrfForSession,
} from "../cloudflare/library/security.mjs";
import { fixture, context, session } from "./helpers/storage-read-fixture.mjs";

const reject = (operation, status) =>
  assert.rejects(operation, (error) => error.status === status);
const request = (action = "content", options = {}) =>
  new Request(`${context.origin}/api/files/file_shared/${action}`, options);
const admissions = (f) =>
  f.db.prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'").get()
    .n;
function objectStore(f, source = "normal", { change, cancel } = {}) {
  const store = source === "normal" ? f.normalStore : f.trialStore;
  const meta = () => ({
    size: f.d.sizeBytes,
    etag: "synthetic_etag",
    customMetadata: { sha256: f.d.sha256 },
    httpMetadata: { contentType: "application/pdf" },
  });
  store.head = async (...args) => {
    f.r2.push([source, "head", ...args]);
    await change?.();
    return meta();
  };
  store.get = async (...args) => {
    f.r2.push([source, "get", ...args]);
    const range = args[1].range;
    const all = source === "normal" ? "normal original" : "trial isolated!";
    const value = range
      ? all.slice(range.offset, range.offset + range.length)
      : all;
    await change?.();
    return {
      ...meta(),
      ...(range ? { range } : {}),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(value));
        },
        cancel: cancel || (() => {}),
      }),
    };
  };
}
const read = (f, req = request(), content = true) =>
  confirmedFileAccess(req, f.env, context, session, f.d.fileId, content);

for (const source of ["normal", "trial"])
  for (const action of ["access", "content"])
    for (const method of ["GET", "HEAD"])
      test(`v2 ${source} ${method} ${action}: one object, one atomic admission`, async (t) => {
        const f = fixture(t, { source });
        objectStore(f, source);
        const out = await read(
          f,
          request(action, { method }),
          action === "content",
        );
        assert.equal(out.status, 200);
        assert.equal(admissions(f), 1);
        assert.equal(f.calls.length, 4);
        assert.equal(f.r2.length, 1);
        assert.equal(f.r2[0][0], source);
        assert.equal(
          f.r2[0][1],
          action === "content" && method === "GET" ? "get" : "head",
        );
        const admission = f.calls.find(
          (call) => call.sql === STORAGE_READ_ADMISSION_SQL,
        );
        assert.equal(admission.params.length, 9);
        assert.equal(f.secretReads(), 0);
        assert.equal(f.writeReads(), 0);
        if (method === "HEAD") assert.equal(await out.text(), "");
        else if (action === "content") {
          const reader = out.body.getReader();
          const first = await reader.read();
          assert.equal(
            new TextDecoder().decode(first.value),
            source === "normal" ? "normal original" : "trial isolated!",
          );
          await reader.cancel();
          assert.equal(out.headers.get("etag"), '"synthetic_etag"');
          assert.equal(out.headers.get("content-length"), "15");
        } else {
          const value = await out.json();
          assert.deepEqual(value, {
            url: "/api/files/file_shared/content",
            format: "PDF",
            expiresAt: null,
            mode: "local",
          });
        }
      });

test("fixed SQL and exact binding budget", () => {
  assert.equal(Buffer.byteLength(STORAGE_READ_ADMISSION_SQL), 5456);
  assert.ok(
    Buffer.byteLength(STORAGE_READ_ADMISSION_SQL) <=
      STORAGE_READ_LIMITS.sqlBytes,
  );
  assert.equal(STORAGE_READ_LIMITS.admissionParameters, 9);
});

for (const method of ["GET", "HEAD"])
  test(`v2 ${method} single Range`, async (t) => {
    const f = fixture(t);
    objectStore(f);
    const out = await read(
      f,
      request("content", { method, headers: { range: "bytes=2-5" } }),
    );
    assert.equal(out.status, 206);
    assert.equal(out.headers.get("content-range"), "bytes 2-5/15");
    assert.equal(out.headers.get("content-length"), "4");
    assert.equal(admissions(f), 1);
    if (method === "GET") {
      assert.deepEqual(f.r2[0][3], {
        onlyIf: { etagMatches: "synthetic_etag" },
        range: { offset: 2, length: 4 },
      });
      const reader = out.body.getReader();
      assert.equal(
        new TextDecoder().decode((await reader.read()).value),
        "rmal",
      );
      await reader.cancel();
    } else assert.equal(await out.text(), "");
  });
for (const range of [
  "bytes=-1",
  "bytes=1-2,5-6",
  "bytes=15-",
  "bytes=5-3",
  "bytes=0-99",
  "bytes=9007199254740992-",
])
  test(`v2 invalid range zero R2/admission: ${range}`, async (t) => {
    const f = fixture(t);
    objectStore(f);
    await reject(
      () => read(f, request("content", { headers: { range } })),
      416,
    );
    assert.equal(f.r2.length, 0);
    assert.equal(admissions(f), 0);
  });
test("v2 open-ended Range and matching If-Match", async (t) => {
  const f = fixture(t);
  objectStore(f);
  const out = await read(
    f,
    request("content", {
      headers: { range: "bytes=14-", "if-match": '"synthetic_etag"' },
    }),
  );
  assert.equal(out.status, 206);
  assert.equal(out.headers.get("content-range"), "bytes 14-14/15");
  await out.body.cancel();
});
for (const value of ["other", 'W/"synthetic_etag"', "*"])
  test(`v2 If-Match mismatch zero R2/admission: ${value}`, async (t) => {
    const f = fixture(t);
    objectStore(f);
    await reject(
      () => read(f, request("content", { headers: { "if-match": value } })),
      412,
    );
    assert.equal(f.r2.length, 0);
    assert.equal(admissions(f), 0);
  });
test("v2 conflict rejects without selecting either bucket", async (t) => {
  const f = fixture(t, { source: "both" });
  await reject(() => read(f), 409);
  assert.equal(f.r2.length, 0);
  assert.equal(admissions(f), 0);
});

const changes = {
  schema: (f) => f.db.exec("CREATE TABLE unexpected(value TEXT)"),
  authority: (f) =>
    f.unsafe(() =>
      f.db
        .prepare(
          "UPDATE shelf_storage_authority SET identity_json=json_set(identity_json,'$.legacyDatabases.check','33333333-3333-4333-8333-333333333333')",
        )
        .run(),
    ),
  source: (f) =>
    f.unsafe(() => f.db.exec("UPDATE file_registry SET version=version+1")),
  catalog: (f) =>
    f.db.exec(
      "UPDATE catalog_books SET public_json=json_set(public_json,'$.title','Changed')",
    ),
  revoked: (f) => f.db.exec("UPDATE sessions SET revoked=1"),
  expired: (f) =>
    f.db.prepare("UPDATE sessions SET expires_at=?").run(Date.now() - 1),
  disabled: (f) => f.db.exec("UPDATE auth_config SET enabled=0"),
  generation: (f) =>
    f.db.exec("UPDATE auth_config SET generation=generation+1"),
  trash: (f) =>
    f.db.exec("UPDATE book_management SET trashed=1,version=version+1"),
  visibility: (f) =>
    f.db.exec(
      "UPDATE book_management SET visibility='public',version=version+1",
    ),
  binding: (f) => {
    f.env.BOOKS = { ...f.normalStore };
  },
  trialBinding: (f) => {
    f.env.TRIAL_BOOKS = { ...f.trialStore };
  },
  method: (f) => {
    f.env.TRIAL_BOOKS.head = async () => null;
  },
  normalMethod: (f) => {
    f.env.BOOKS.get = async () => null;
  },
  database: (f) => {
    f.env.DB = { ...f.env.DB };
  },
  databaseMethod: (f) => {
    const original = f.env.DB.withSession;
    f.env.DB.withSession = function (...args) {
      return original.apply(this, args);
    };
  },
  mode: (f) => {
    f.env.STORAGE_WRITE_MODE = "open";
  },
  crossSource: (f) =>
    f.unsafe(() => {
      const identity = f.db
        .prepare("SELECT identity_json FROM shelf_storage_authority")
        .get().identity_json;
      f.db
        .prepare(
          "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,?,?)",
        )
        .run(
          "synthetic_permit",
          "2026-10-23-first-book",
          identity,
          JSON.stringify({
            accountId: f.env.R2_ACCOUNT_ID,
            bucket: f.env.TRIAL_R2_BUCKET,
          }),
          JSON.stringify(f.d),
          f.env.TRIAL_TARGET_SHA256,
          f.d.sizeBytes,
          context.now - 172800000,
          context.now - 172800000 + 3600000,
          "synthetic_etag",
          context.now - 172800000 + 1000,
        );
    }),
};
for (const [name, change] of Object.entries(changes))
  test(`v2 ${name} drift during R2 cancels and consumes zero access`, async (t) => {
    const f = fixture(t);
    let cancelled = 0;
    objectStore(f, "normal", {
      change: () => change(f),
      cancel: () => {
        cancelled++;
        return new Promise(() => {});
      },
    });
    await assert.rejects(() => read(f));
    assert.ok(cancelled > 0);
    assert.equal(admissions(f), 0);
  });
for (const [name, change] of Object.entries(changes))
  test(`v2 ${name} drift during admission await is rejected after one admission`, async (t) => {
    const f = fixture(t);
    let cancelled = 0;
    objectStore(f, "normal", {
      cancel: () => {
        cancelled++;
      },
    });
    f.env.DB.afterFirst = (sql) => {
      if (sql === STORAGE_READ_ADMISSION_SQL) change(f);
    };
    await assert.rejects(() => read(f));
    assert.equal(admissions(f), 1);
    assert.ok(cancelled > 0);
  });
test("guard and insertion share statement: change before INSERT consumes zero access", async (t) => {
  const f = fixture(t);
  objectStore(f);
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = function (sql) {
    if (sql === STORAGE_READ_ADMISSION_SQL)
      f.db.exec("UPDATE file_registry SET version=version+1");
    return prepare.call(this, sql);
  };
  await reject(() => read(f), 409);
  assert.equal(admissions(f), 0);
});
test("admission rate limit preserves 429 and atomically rolls back access counters", async (t) => {
  const f = fixture(t);
  let cancelled = 0;
  objectStore(f, "normal", {
    cancel: () => {
      cancelled++;
    },
  });
  f.db
    .prepare(
      "INSERT INTO counters VALUES('production','access_day','global',?,1000,1000)",
    )
    .run(Math.floor(Date.now() / 86400000));
  await reject(() => read(f), 429);
  assert.equal(admissions(f), 0);
  assert.equal(
    f.db.prepare("SELECT count FROM counters WHERE kind='access_day'").get()
      .count,
    1000,
  );
  assert.ok(cancelled > 0);
});
test("lost admission response retains one consumed access and does not return content", async (t) => {
  const f = fixture(t);
  let cancelled = 0;
  objectStore(f, "normal", {
    cancel: () => {
      cancelled++;
    },
  });
  f.env.DB.afterFirst = (sql) => {
    if (sql === STORAGE_READ_ADMISSION_SQL)
      throw Error("synthetic lost response");
  };
  await reject(() => read(f), 503);
  assert.equal(admissions(f), 1);
  assert.ok(cancelled > 0);
});
test("admission deadline rejects without waiting for a never settling body cancel", async (t) => {
  const f = fixture(t);
  let cancelled = 0,
    entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  objectStore(f, "normal", {
    cancel: () => {
      cancelled++;
      return new Promise(() => {});
    },
  });
  f.env.DB.afterFirst = (sql) => {
    if (sql === STORAGE_READ_ADMISSION_SQL) {
      entered();
      return new Promise(() => {});
    }
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = read(f);
  const rejection = reject(() => result, 503);
  await started;
  t.mock.timers.tick(30000);
  await rejection;
  assert.equal(admissions(f), 1);
  assert.ok(cancelled > 0);
});

function onlyMode() {
  return new Proxy(
    { STORAGE_MODE: "authority-v2" },
    {
      get(target, key) {
        if (key === "STORAGE_MODE") return target[key];
        throw Error(`unexpected env read ${String(key)}`);
      },
    },
  );
}
for (const path of [
  "/api/single-trial",
  "/api/single-trial/",
  "/api/single-trial/upload",
  "/api/single-trial/object",
  "/api/single-trial/unknown/deep",
])
  for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"])
    test(`v2 operator earliest 404 ${method} ${path}`, async () => {
      const out = await handleRequest(
        new Request(`${context.origin}${path}`, {
          method,
          headers: {
            "x-shelf-trial-secret": randomKey(),
            origin: "https://wrong.example",
          },
        }),
        onlyMode(),
      );
      assert.equal(out.status, 404);
      assert.equal(out.headers.get("cache-control"), "no-store");
      assert.equal((await out.json()).error.code, "not_found");
    });
for (const operation of [trialOperatorRoute, trialOperatorAuthorized])
  test(`${operation.name} direct v2 zero IO`, async () => {
    await reject(
      () =>
        operation(
          new Proxy(
            {},
            {
              get() {
                throw Error("request accessed");
              },
            },
          ),
          onlyMode(),
        ),
      404,
    );
  });
test("v2 upload capability zero storage/DB reads even with malformed configuration", async () => {
  const value = await uploadCapability(onlyMode(), null, null);
  assert.equal(value.enabled, false);
  assert.deepEqual(value.reasons, ["storage_write_closed"]);
});
for (const path of ["/api/manage/uploads", "/api/manage/uploads/unknown/bytes"])
  test(`v2 upload earliest handler gate ${path}`, async () => {
    const req = new Proxy(
      { url: context.origin + path, method: "POST" },
      {
        get(target, key) {
          if (key in target) return target[key];
          throw Error("body read");
        },
      },
    );
    const out = await managementRoute(req, onlyMode(), null, null, {
      response: (status, value) =>
        new Response(JSON.stringify(value), { status }),
    });
    assert.equal(out.status, 409);
    assert.deepEqual((await out.json()).upload.reasons, [
      "storage_write_closed",
    ]);
  });

async function workerFixture(t, options = {}) {
  const f = fixture(t, options);
  objectStore(f, options.source || "normal");
  const token = randomKey();
  for (const name of ["OWNER_KEY_PEPPER", "SESSION_SECRET"])
    Object.defineProperty(f.env, name, {
      value: randomKey(),
      enumerable: true,
      configurable: true,
    });
  const digest = await sessionDigest(token, f.env.SESSION_SECRET, context);
  f.unsafe(() =>
    f.db.prepare("UPDATE sessions SET session_hash=?").run(digest),
  );
  return { ...f, token, headers: { cookie: `__Host-shelf_session=${token}` } };
}
test("Worker v2 imported file bypasses browser_uploads and never presigns", async (t) => {
  const f = await workerFixture(t);
  const out = await handleRequest(
    request("access", { headers: f.headers }),
    f.env,
  );
  assert.equal(out.status, 200);
  assert.equal((await out.json()).url, "/api/files/file_shared/content");
  assert.equal(admissions(f), 1);
  assert.equal(
    f.calls.some((call) =>
      /SELECT upload_id FROM browser_uploads/.test(call.sql),
    ),
    false,
  );
  assert.equal(f.secretReads(), 0);
});
test("Worker v2 config reports storage without reading old credentials", async (t) => {
  const f = await workerFixture(t);
  const out = await handleRequest(
    new Request(context.origin + "/api/config"),
    f.env,
  );
  assert.equal(out.status, 200);
  assert.equal((await out.json()).r2Configured, true);
  assert.equal(f.r2.length, 0);
});
for (const mutation of [
  (env) => {
    env.STORAGE_MODE = "unknown";
  },
  (env) => {
    env.STORAGE_WRITE_MODE = "open";
  },
  (env) => {
    env.NORMAL_UPLOAD_MODE = "authority-v1";
  },
  (env) => {
    delete env.STORAGE_MODE;
  },
])
  test("Worker malformed/mixed/partial v2 closes before D1/R2", async (t) => {
    const f = await workerFixture(t);
    mutation(f.env);
    const out = await handleRequest(
      request("access", { headers: f.headers }),
      f.env,
    );
    assert.equal(out.status, 503);
    assert.equal(f.calls.length, 0);
    assert.equal(f.r2.length, 0);
  });
test("Worker normal upload preserves Origin/session/CSRF before closed response", async (t) => {
  const f = await workerFixture(t);
  const url = context.origin + "/api/manage/uploads/unknown/bytes";
  const options = {
    method: "POST",
    headers: {
      ...f.headers,
      origin: context.origin,
      "content-type": "application/octet-stream",
    },
    body: "unused",
  };
  const invalid = await handleRequest(new Request(url, options), f.env);
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).error.code, "csrf_invalid");
  options.headers["x-csrf-token"] = await csrfForSession(
    f.token,
    f.env.SESSION_SECRET,
    context,
  );
  const out = await handleRequest(new Request(url, options), f.env);
  assert.equal(out.status, 409);
  assert.deepEqual((await out.json()).upload.reasons, ["storage_write_closed"]);
  assert.equal(f.r2.length, 0);
  assert.equal(
    f.calls.some((call) =>
      /SELECT u\.\*|UPDATE shelf_storage_reservations|INSERT INTO browser_uploads/.test(
        call.sql,
      ),
    ),
    false,
  );
});
