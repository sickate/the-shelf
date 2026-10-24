import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import {
  runStaticBindingRecovery,
  recoveryUploadMetadata,
  RECOVERY_SOURCE_VERSION,
  RECOVERY_ASSETS_VERSION,
  RECOVERY_AUTH_SQL,
  RECOVERY_LIMITS,
} from "../scripts/cf-static-binding-recovery.mjs";
import { STATIC_WORKER_SOURCE } from "../scripts/cf-deploy.mjs";
import { FILENAME_AI_SECRET_NAMES } from "../scripts/cf-api-deploy.mjs";
import {
  isolatedFixture,
  identity,
  response,
} from "./helpers/isolated-operator-fixture.mjs";
const NEW_VERSION = "55555555-5555-4555-8555-555555555555",
  DEPLOYMENT = "66666666-6666-4666-8666-666666666666";
const staticBindings = () => [
  { name: "ASSETS", type: "assets" },
  ...FILENAME_AI_SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
];
async function fixture(t) {
  const f = await isolatedFixture(t);
  f.db.exec("UPDATE auth_config SET generation=2,enabled=0,updated_at=2");
  const source = {
    id: RECOVERY_SOURCE_VERSION,
    resources: {
      bindings: f.settings.bindings.filter(
        (b) => !b.name.startsWith("ISOLATED_UPLOAD_"),
      ),
    },
  };
  const current = {
    calls: [],
    source,
    settings: { bindings: [] },
    latest: { items: [{ id: RECOVERY_ASSETS_VERSION }] },
    uploaded: { id: NEW_VERSION },
    immutable: { id: NEW_VERSION, resources: { bindings: staticBindings() } },
    postSettings: { bindings: staticBindings() },
    versionPosts: 0,
    deploymentPosts: 0,
    hook: null,
  };
  const deployment = (version) => ({
    id: DEPLOYMENT,
    strategy: "percentage",
    versions: [{ version_id: version, percentage: 100 }],
  });
  current.fetchImpl = async (url, init = {}) => {
    const call = { url, method: init.method || "GET", body: init.body };
    current.calls.push(call);
    const replaced = await current.hook?.(call, current);
    if (replaced !== undefined) return replaced;
    if (url.endsWith(`/versions/${RECOVERY_SOURCE_VERSION}`))
      return response(current.source);
    if (url.endsWith("/settings"))
      return response(
        current.versionPosts ? current.postSettings : current.settings,
      );
    if (url.endsWith(`/d1/database/${identity.legacyDatabases.production}`))
      return response({
        uuid: identity.legacyDatabases.production,
        name: "the-shelf-library",
      });
    if (url.endsWith("/query")) {
      const b = JSON.parse(init.body);
      assert.equal(b.sql, RECOVERY_AUTH_SQL);
      assert.deepEqual(b.params, []);
      return response([{ success: true, results: f.db.prepare(b.sql).all() }]);
    }
    if (url.endsWith("/deployments?page=1&per_page=1"))
      return response({
        deployments: [
          deployment(
            current.deploymentPosts ? NEW_VERSION : RECOVERY_SOURCE_VERSION,
          ),
        ],
      });
    if (url.endsWith("/versions?page=1&per_page=1"))
      return response(current.latest);
    if (url.endsWith("/versions?bindings_inherit=strict")) {
      current.versionPosts++;
      assert.ok(init.body instanceof FormData);
      assert.deepEqual(
        JSON.parse(init.body.get("metadata")),
        recoveryUploadMetadata(),
      );
      assert.equal(
        await init.body.get("static-worker.mjs").text(),
        STATIC_WORKER_SOURCE,
      );
      assert.equal(init.headers["Content-Type"], undefined);
      return response(current.uploaded);
    }
    if (url.endsWith(`/versions/${NEW_VERSION}`))
      return response(current.immutable);
    if (url.endsWith("/deployments?force=true")) {
      current.deploymentPosts++;
      assert.deepEqual(JSON.parse(init.body).versions, [
        { version_id: NEW_VERSION, percentage: 100 },
      ]);
      return response(deployment(NEW_VERSION));
    }
    assert.fail("unexpected synthetic URL");
  };
  current.run = (runId = "recovery", extra = {}) =>
    runStaticBindingRecovery({
      execute: true,
      runId,
      root: f.root,
      environment: {},
      fetchImpl: current.fetchImpl,
      ...extra,
    });
  return { ...f, current };
}
const prefix = (code) => (e) => e.code === `static_binding_recovery_${code}`;
test("preview has zero IO and no cloud mutation; fixed direct request caps", async () => {
  const result = await runStaticBindingRecovery({
    root: "/absent",
    fetchImpl: () => assert.fail(),
  });
  assert.equal(result.requests, 0);
  assert.equal(result.cloudMutation, false);
  assert.deepEqual(RECOVERY_LIMITS, {
    http: 13,
    versionPosts: 1,
    deploymentPosts: 1,
    responseBytes: 1_048_576,
    timeoutMs: 30_000,
  });
});
test("actual installed Wrangler serializer emits exact immutable source inherit and keep_assets without secretvalues or globalinherit", () => {
  const require = createRequire(import.meta.url),
    filename = require.resolve("wrangler"),
    loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(
    readFileSync(filename, "utf8") +
      "\nexports.shelfRecovery=(w,c)=>{init_binding_utils();init_create_worker_upload_form();return createWorkerUploadForm(w,getBindings(c));};",
    filename,
  );
  const expected = recoveryUploadMetadata(),
    config = {
      assets: { binding: "ASSETS" },
      unsafe: {
        bindings: FILENAME_AI_SECRET_NAMES.map((name) => ({
          name,
          type: "inherit",
          version_id: RECOVERY_SOURCE_VERSION,
        })),
      },
    };
  const form = loaded.exports.shelfRecovery(
    {
      main: {
        name: "static-worker.mjs",
        type: "esm",
        content: STATIC_WORKER_SOURCE,
      },
      modules: [],
      compatibility_date: "2026-10-15",
      keep_assets: true,
    },
    config,
  );
  assert.deepEqual(JSON.parse(form.get("metadata")), expected);
  assert.equal(expected.keep_bindings, undefined);
  assert.equal(expected.bindings.length, 5);
  assert.equal(
    expected.bindings.some((b) => Object.hasOwn(b, "text")),
    false,
  );
});
test("happy path is13 bounded HTTP, one direct strict version POST and one force deployment POST, auth remainsclosed", async (t) => {
  const { current, root } = await fixture(t),
    result = await current.run();
  assert.equal(result.requests, 13);
  assert.equal(result.versionPosts, 1);
  assert.equal(result.deploymentPosts, 1);
  assert.equal(result.outcome, "static_bindings_verified");
  assert.equal(result.authEnabled, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.assetsRuntimeVerified, false);
  assert.equal(
    current.calls.filter(
      (c) => c.method === "POST" && !c.url.endsWith("/query"),
    ).length,
    2,
  );
  assert.equal(
    current.calls.some((c) => /secrets|r2|assets-upload/.test(c.url)),
    false,
  );
  const record = JSON.parse(
    await fs.readFile(
      path.join(root, ".local/cf-static-binding-recovery/attempt-claim.json"),
      "utf8",
    ),
  );
  assert.equal(record.identity.sourceVersion, RECOVERY_SOURCE_VERSION);
  await assert.rejects(current.run("new-run"));
  assert.equal(current.versionPosts, 1);
  assert.equal(current.deploymentPosts, 1);
});
for (const [name, damage] of [
  ["source wrong version", (f) => (f.current.source.id = NEW_VERSION)],
  [
    "source missing secret",
    (f) =>
      (f.current.source.resources.bindings =
        f.current.source.resources.bindings.filter(
          (b) => b.name !== "FILENAME_AI_KEY",
        )),
  ],
  [
    "source extra binding",
    (f) =>
      f.current.source.resources.bindings.push({
        name: "OTHER",
        type: "secret_text",
      }),
  ],
  [
    "source secretvalue field",
    (f) =>
      (f.current.source.resources.bindings.find(
        (b) => b.name === "FILENAME_AI_KEY",
      ).text = "synthetic-invalid"),
  ],
  [
    "source wrong DB",
    (f) =>
      (f.current.source.resources.bindings.find((b) => b.name === "DB").id =
        NEW_VERSION),
  ],
  [
    "source wrong bucket",
    (f) =>
      (f.current.source.resources.bindings.find(
        (b) => b.name === "BOOKS",
      ).bucket_name = "other-project"),
  ],
  [
    "settings no longerempty",
    (f) => (f.current.settings.bindings = [{ name: "ASSETS", type: "assets" }]),
  ],
  [
    "latest version changed",
    (f) => (f.current.latest.items[0].id = NEW_VERSION),
  ],
  [
    "auth opened",
    (f) => f.db.exec("UPDATE auth_config SET enabled=1,updated_at=3"),
  ],
  [
    "auth generation drift",
    (f) => f.db.exec("UPDATE auth_config SET generation=3,updated_at=3"),
  ],
  [
    "auth trigger drift",
    (f) =>
      f.db.exec(
        "CREATE TRIGGER extra_auth BEFORE UPDATE ON auth_config BEGIN SELECT 1; END",
      ),
  ],
])
  test(`preflight ${name} blocks all Worker mutations`, async (t) => {
    const f = await fixture(t);
    damage(f);
    await assert.rejects(f.current.run());
    assert.equal(f.current.versionPosts, 0);
    assert.equal(f.current.deploymentPosts, 0);
  });
test("wrongproductionidentity and activeversion fail beforeupload", async (t) => {
  for (const drift of ["database", "active"]) {
    const f = await fixture(t);
    f.current.hook = (call) =>
      drift === "database" &&
      call.url.endsWith(`/d1/database/${identity.legacyDatabases.production}`)
        ? response({ uuid: NEW_VERSION, name: "the-shelf-library" })
        : drift === "active" &&
            call.url.endsWith("/deployments?page=1&per_page=1")
          ? response({
              deployments: [
                {
                  id: DEPLOYMENT,
                  versions: [{ version_id: NEW_VERSION, percentage: 100 }],
                },
              ],
            })
          : undefined;
    await assert.rejects(f.current.run());
    assert.equal(f.current.versionPosts, 0);
  }
});
test("missinguploadresponsebindings accepted only after exact independentimmutableGET", async (t) => {
  const f = await fixture(t);
  assert.equal(f.current.uploaded.resources, undefined);
  assert.equal((await f.current.run()).outcome, "static_bindings_verified");
});
test("binding and object-key ordering differences normalize after exact validation", async (t) => {
  const f = await fixture(t);
  f.current.uploaded = {
    id: NEW_VERSION,
    resources: {
      bindings: staticBindings()
        .reverse()
        .map((b) => ({ type: b.type, name: b.name })),
    },
  };
  f.current.immutable.resources.bindings = staticBindings().reverse();
  f.current.postSettings.bindings = staticBindings().map((b) => ({
    type: b.type,
    name: b.name,
  }));
  assert.equal((await f.current.run()).outcome, "static_bindings_verified");
});
for (const stage of ["upload-response", "immutable-uploaded"])
  test(`wrong ${stage} binding set neverdeploys`, async (t) => {
    const f = await fixture(t);
    if (stage === "upload-response")
      f.current.uploaded.resources = { bindings: [] };
    else f.current.immutable.resources.bindings = [];
    await assert.rejects(f.current.run());
    assert.equal(f.current.versionPosts, 1);
    assert.equal(f.current.deploymentPosts, 0);
  });
for (const stage of ["version", "deployment"])
  test(`unknown ${stage} POST is neverretried or replayed withnewrun`, async (t) => {
    const f = await fixture(t);
    let dispatched = 0;
    f.current.hook = (call) => {
      if (
        call.url.endsWith(
          stage === "version"
            ? "/versions?bindings_inherit=strict"
            : "/deployments?force=true",
        )
      ) {
        dispatched++;
        throw Error("synthetic lost response");
      }
    };
    await assert.rejects(f.current.run(), prefix("mutation_unknown"));
    assert.equal(dispatched, 1);
    assert.equal(f.current.deploymentPosts, 0);
    f.current.hook = null;
    await assert.rejects(f.current.run("retry"));
    assert.equal(dispatched, 1);
    assert.equal(f.current.deploymentPosts, 0);
    const stopped = JSON.parse(
      await fs.readFile(
        path.join(
          f.root,
          ".local/cf-static-binding-recovery/recovery/result.json",
        ),
        "utf8",
      ),
    );
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.versionPosts, 1);
  });
for (const drift of ["settings", "immutable", "deployment", "auth"])
  test(`postflight ${drift} mismatch preservesclaims and neverreplays`, async (t) => {
    const f = await fixture(t);
    let immutableGets = 0;
    f.current.hook = (call) => {
      if (
        drift === "settings" &&
        f.current.deploymentPosts &&
        call.url.endsWith("/settings")
      )
        return response({ bindings: [] });
      if (
        drift === "immutable" &&
        call.url.endsWith(`/versions/${NEW_VERSION}`) &&
        ++immutableGets === 2
      )
        return response({ id: NEW_VERSION, resources: { bindings: [] } });
      if (
        drift === "deployment" &&
        f.current.deploymentPosts &&
        call.url.endsWith("/deployments?page=1&per_page=1")
      )
        return response({ deployments: [] });
      if (
        drift === "auth" &&
        f.current.deploymentPosts &&
        call.url.endsWith("/query")
      )
        f.db.exec("UPDATE auth_config SET enabled=1,updated_at=4");
    };
    await assert.rejects(f.current.run());
    assert.equal(f.current.versionPosts, 1);
    assert.equal(f.current.deploymentPosts, 1);
    assert.ok(
      await fs.stat(
        path.join(
          f.root,
          ".local/cf-static-binding-recovery/attempt-claim.json",
        ),
      ),
    );
  });
test("concurrentruns share immutableclaim and onlyone versiondispatch", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.current.run("a"),
    f.current.run("b"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.current.versionPosts, 1);
  assert.equal(f.current.deploymentPosts, 1);
});
test("responseoversize and deadline cancel withoutwrites; unsafeprivatefile blocksnetwork", async (t) => {
  for (const kind of ["size", "deadline", "symlink"]) {
    const f = await fixture(t);
    if (kind === "symlink") {
      await fs.unlink(path.join(f.root, ".local/cf03/deploy.json"));
      await fs.symlink("missing", path.join(f.root, ".local/cf03/deploy.json"));
    } else
      f.current.hook = () =>
        kind === "size"
          ? new Response("x", {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": "1048577",
              },
            })
          : new Promise(() => {});
    await assert.rejects(f.current.run("bounded", { timeoutMs: 10 }));
    assert.equal(f.current.versionPosts, 0);
    if (kind === "symlink") assert.equal(f.current.calls.length, 0);
  }
});
