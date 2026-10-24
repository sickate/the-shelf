import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Module, { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  runStaticBindingRecoveryV2,
  recoveryV2UploadBody,
  recoveryAssetHash,
  loadFrozenRecoveryAssets,
  validateRecoveryBuckets,
  validateRecoveryJwt,
  validateRecoveryV2Version,
  RECOVERY_ASSET_DIRECTORY,
  RECOVERY_ASSET_202_RUN,
  RECOVERY_V2_DIRECTORY,
  RECOVERY_V2_LIMITS,
  RECOVERY_ASSETS_CONFIG,
} from "../scripts/cf-static-binding-recovery-v2.mjs";
import {
  RECOVERY_AUTH_SQL,
  RECOVERY_SOURCE_VERSION,
  RECOVERY_ASSETS_VERSION,
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
const jwt = (extra = {}) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...extra }),
    ).toString("base64url"),
    "synthetic-signature",
  ].join(".");
const SESSION = jwt({ purpose: "session" }),
  COMPLETION = jwt({ purpose: "completion" });
const sha = (v) => createHash("sha256").update(v).digest("hex");
const bindings = () => [
  { name: "ASSETS", type: "assets" },
  ...FILENAME_AI_SECRET_NAMES.map((name) => ({ name, type: "secret_text" })),
];
const version = () => ({
  id: NEW_VERSION,
  main_module: "static-worker.mjs",
  compatibility_date: "2026-10-15",
  bindings: bindings(),
  modules: recoveryV2UploadBody(COMPLETION).modules,
});
function syntheticAssets() {
  const rows = [],
    contents = new Map();
  for (let i = 0; i < 20; i++) {
    const bytes = Buffer.from(`export default ${i};\n`),
      p = `/asset-${i}.js`;
    rows.push({
      path: p,
      hash: recoveryAssetHash(bytes, p),
      size: bytes.length,
      sha256: sha(bytes),
    });
    contents.set(p, bytes);
  }
  return {
    rows,
    contents,
    byHash: new Map(rows.map((r) => [r.hash, r])),
    manifest: Object.fromEntries(
      rows.map((r) => [r.path, { hash: r.hash, size: r.size }]),
    ),
    bytes: rows.reduce((s, r) => s + r.size, 0),
  };
}
// Synthetic content carrying the five fixed public hashes and byte counts of
// the failed run. Production cannot inject this loader or change its manifest.
function historicalAssets() {
  const assets = syntheticAssets(),
    fixed = [
      ["a15ab5ab7c45014de27e4687ae50d1eb", 8305],
      ["a9689168b0d3af4367b2634c695ce48b", 199848],
      ["6419c9a49225e3eabddbb3cdf3123675", 8517],
      ["331aae699f7f38d0f623e7c6813684ef", 240001],
      ["0cf3bd3ee078d13ee8042611bcc43291", 187825],
    ];
  for (const [i, [hash, size]] of fixed.entries()) {
    const row = assets.rows[i],
      bytes = Buffer.alloc(size, i);
    Object.assign(row, { hash, size, sha256: sha(bytes) });
    assets.contents.set(row.path, bytes);
  }
  assets.byHash = new Map(assets.rows.map((row) => [row.hash, row]));
  assets.manifest = Object.fromEntries(
    assets.rows.map((row) => [row.path, { hash: row.hash, size: row.size }]),
  );
  return assets;
}
async function fixture(t, bucketCount = 0, assets = syntheticAssets()) {
  const f = await isolatedFixture(t);
  f.db.exec("UPDATE auth_config SET generation=2,enabled=0,updated_at=2");
  const current = {
    calls: [],
    assets,
    versionPosts: 0,
    deploymentPosts: 0,
    sessionPosts: 0,
    bucketPosts: 0,
    source: {
      id: RECOVERY_SOURCE_VERSION,
      resources: {
        bindings: f.settings.bindings.filter(
          (b) => !b.name.startsWith("ISOLATED_UPLOAD_"),
        ),
      },
    },
    session: {
      buckets: assets.rows.slice(0, bucketCount).map((r) => [r.hash]),
      jwt: SESSION,
    },
    immutable: version(),
    settings: { bindings: [] },
    hook: null,
  };
  const deployment = (id) => ({
    id: DEPLOYMENT,
    strategy: "percentage",
    versions: [{ version_id: id, percentage: 100 }],
  });
  current.fetchImpl = async (url, init = {}) => {
    const call = {
      url,
      method: init.method || "GET",
      body: init.body,
      headers: init.headers,
    };
    current.calls.push(call);
    const replaced = await current.hook?.(call, current);
    if (replaced !== undefined) return replaced;
    if (url.endsWith(`/versions/${RECOVERY_SOURCE_VERSION}`))
      return response(current.source);
    if (url.endsWith("/settings"))
      return response(
        current.versionPosts ? { bindings: bindings() } : current.settings,
      );
    if (url.endsWith(`/d1/database/${identity.legacyDatabases.production}`))
      return response({
        uuid: identity.legacyDatabases.production,
        name: "the-shelf-library",
      });
    if (url.endsWith("/query")) {
      assert.deepEqual(JSON.parse(init.body), {
        sql: RECOVERY_AUTH_SQL,
        params: [],
      });
      return response([
        { success: true, results: f.db.prepare(RECOVERY_AUTH_SQL).all() },
      ]);
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
      return Response.json({
        success: true,
        errors: null,
        messages: null,
        result: { items: [{ id: RECOVERY_ASSETS_VERSION }] },
      });
    if (url.endsWith("/assets-upload-session")) {
      current.sessionPosts++;
      assert.deepEqual(JSON.parse(init.body), { manifest: assets.manifest });
      return response(current.session);
    }
    if (/\/workers\/assets\/upload\/[a-f0-9]{32}$/.test(url)) {
      const hash = current.session.buckets.flat()[current.bucketPosts++],
        row = assets.byHash.get(hash);
      assert.equal(url.endsWith("/" + hash), true);
      assert.equal(init.headers.Authorization, `Bearer ${current.session.jwt}`);
      assert.equal(
        init.headers["Content-Type"],
        "text/javascript; charset=utf-8",
      );
      assert.deepEqual(init.body, assets.contents.get(row.path));
      const last =
        current.bucketPosts === current.session.buckets.flat().length;
      return Response.json(
        {
          success: true,
          errors: null,
          result: last ? { jwt: COMPLETION } : {},
        },
        { status: last ? 201 : 200 },
      );
    }
    if (url.endsWith("/workers/assets/upload?base64=true")) {
      const bucket = current.session.buckets[current.bucketPosts++];
      assert.equal(init.headers.Authorization, `Bearer ${current.session.jwt}`);
      assert.equal(init.headers["Content-Type"], undefined);
      assert.ok(init.body instanceof FormData);
      assert.deepEqual([...init.body.keys()], bucket);
      for (const hash of bucket) {
        const file = init.body.get(hash),
          row = assets.byHash.get(hash);
        assert.equal(file.name, hash);
        assert.equal(file.type, "text/javascript; charset=utf-8");
        assert.equal(
          await file.text(),
          assets.contents.get(row.path).toString("base64"),
        );
      }
      const last = current.bucketPosts === current.session.buckets.length;
      return Response.json(
        {
          success: true,
          errors: null,
          result: last ? { jwt: COMPLETION } : {},
        },
        { status: last ? 201 : 200 },
      );
    }
    if (url.endsWith("/workers/workers/the-shelf/versions?deploy=false")) {
      current.versionPosts++;
      assert.deepEqual(
        JSON.parse(init.body),
        recoveryV2UploadBody(
          current.session.buckets.length ? COMPLETION : current.session.jwt,
        ),
      );
      return response({ id: NEW_VERSION, bindings: bindings() });
    }
    if (
      url.endsWith(
        `/workers/workers/the-shelf/versions/${NEW_VERSION}?include=modules`,
      )
    )
      return response(current.immutable);
    if (url.endsWith(`/workers/scripts/the-shelf/versions/${NEW_VERSION}`))
      return response({ id: NEW_VERSION, resources: { bindings: bindings() } });
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
    runStaticBindingRecoveryV2({
      execute: true,
      runId,
      root: f.root,
      environment: {},
      fetchImpl: current.fetchImpl,
      loadAssets: async () => assets,
      ...extra,
    });
  return { ...f, current };
}
const prefix = (suffix) => (e) =>
  e.code === `static_binding_recovery_v2_${suffix}`;
async function continuationFixture(t) {
  const f = await fixture(t, 0, historicalAssets()),
    { current, root } = f;
  current.session.buckets = [
    current.assets.rows.slice(0, 2).map((row) => row.hash),
    current.assets.rows.slice(2, 4).map((row) => row.hash),
    [current.assets.rows[4].hash],
  ];
  // The old transport rejected status202. Reproduce its immutable observations
  // with a rejected envelope; raw envelopes were never recorded in either case.
  current.hook = (call) =>
    call.url.endsWith("/workers/assets/upload?base64=true")
      ? Response.json(
          { success: false, errors: [], result: null },
          { status: 202 },
        )
      : undefined;
  await assert.rejects(
    current.run(RECOVERY_ASSET_202_RUN),
    prefix("mutation_unknown"),
  );
  const dir = path.join(root, RECOVERY_V2_DIRECTORY),
    oldRun = path.join(dir, RECOVERY_ASSET_202_RUN),
    snapshot = {};
  for (const name of await fs.readdir(oldRun))
    snapshot[name] = await fs.readFile(path.join(oldRun, name), "utf8");
  current.hook = null;
  current.calls = [];
  current.sessionPosts = 0;
  current.session = {
    jwt: jwt({ purpose: "new-session-only" }),
    buckets: current.assets.rows.slice(2, 5).map((row) => [row.hash]),
  };
  return {
    ...f,
    dir,
    oldRun,
    snapshot,
    continue: (runId = "continuation") =>
      current.run(runId, { continueAfterAsset202: true }),
  };
}
test("preview has no IO, asset paths or transport and fixed maximum30 requests", async () => {
  const result = await runStaticBindingRecoveryV2({
    root: "/absent",
    fetchImpl: () => assert.fail(),
    loadAssets: () => assert.fail(),
  });
  assert.equal(result.requests, 0);
  assert.deepEqual(RECOVERY_V2_LIMITS, {
    http: 30,
    assetSessions: 1,
    assetBuckets: 16,
    assetBytes: 20_000_000,
    versionPosts: 1,
    deploymentPosts: 1,
    responseBytes: 1_048_576,
    timeoutMs: 30_000,
  });
});
test("installed Wrangler hash/MIME/metadata agree with frozen asset hashing and routing", async (t) => {
  const require = createRequire(import.meta.url),
    filename = require.resolve("wrangler"),
    loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(
    readFileSync(filename, "utf8") +
      "\nexports.shelfAssetTools=()=>{init_helpers2();init_hash();return {hashFile,getContentType};};\n",
    filename,
  );
  const actual = loaded.exports.shelfAssetTools(),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "shelf-recovery-hash-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [ext, mime] of [
    ["js", "text/javascript; charset=utf-8"],
    ["mjs", "text/javascript; charset=utf-8"],
    ["html", "text/html; charset=utf-8"],
    ["md", "text/markdown; charset=utf-8"],
    ["css", "text/css; charset=utf-8"],
    ["json", "application/json"],
    ["txt", "text/plain; charset=utf-8"],
  ]) {
    const p = path.join(dir, `fixture.${ext}`),
      bytes = Buffer.from("synthetic public content");
    await fs.writeFile(p, bytes);
    assert.equal(recoveryAssetHash(bytes, p), actual.hashFile(p));
    assert.equal(actual.getContentType(p), mime);
  }
  assert.deepEqual(RECOVERY_ASSETS_CONFIG, {
    html_handling: "force-trailing-slash",
    not_found_handling: "404-page",
  });
  assert.deepEqual(
    recoveryV2UploadBody(COMPLETION).assets.config,
    RECOVERY_ASSETS_CONFIG,
  );
});
for (const count of [0, 2, 16])
  test(`complete JSON recovery with${count} sequential bulk requests usesexact${14 + count} HTTP and retainsold unknown`, async (t) => {
    const { current, root } = await fixture(t, count);
    const oldDir = path.join(root, ".local/cf-static-binding-recovery");
    await fs.mkdir(oldDir, { mode: 0o700 });
    await fs.writeFile(
      path.join(oldDir, "attempt-claim.json"),
      "old unknown retained",
      { mode: 0o600 },
    );
    const result = await current.run();
    assert.equal(result.requests, 14 + count);
    assert.equal(result.assetBuckets, count);
    assert.equal(
      result.assetBytes,
      current.assets.rows.slice(0, count).reduce((s, r) => s + r.size, 0),
    );
    assert.equal(result.codeContentVerified, true);
    assert.equal(result.assetsRuntimeVerified, false);
    assert.equal(result.uploadAllowed, false);
    assert.equal(current.versionPosts, 1);
    assert.equal(current.deploymentPosts, 1);
    assert.equal(
      await fs.readFile(path.join(oldDir, "attempt-claim.json"), "utf8"),
      "old unknown retained",
    );
    const records = await fs.readdir(
      path.join(root, RECOVERY_V2_DIRECTORY, "recovery"),
    );
    for (const name of records) {
      const text = await fs.readFile(
        path.join(root, RECOVERY_V2_DIRECTORY, "recovery", name),
        "utf8",
      );
      assert.equal(text.includes(SESSION), false);
      assert.equal(text.includes(COMPLETION), false);
    }
    const versionCall = current.calls.find((c) =>
      c.url.includes("?deploy=false"),
    );
    assert.equal(JSON.parse(versionCall.body).keep_assets, undefined);
    assert.equal(JSON.parse(versionCall.body).keep_bindings, undefined);
    assert.equal(
      current.calls.some((c) => c.url.endsWith("/workers/workers/the-shelf")),
      false,
    );
    assert.equal(
      current.calls.some((c) => /secrets|r2|\/workers\/workers$/.test(c.url)),
      false,
    );
    await assert.rejects(current.run("second"));
    assert.equal(current.sessionPosts, 1);
    assert.equal(current.versionPosts, 1);
  });
test("empty buckets mayattach completionJWT carrying single-asset flag", async (t) => {
  const { current } = await fixture(t);
  current.session.jwt = jwt({ wrangler_single_asset_uploads: true });
  assert.equal((await current.run()).outcome, "static_bindings_verified");
});
for (const single of [false, true])
  for (const shape of ["null", "omitted", "object"])
    test(`asset202 ${shape} intermediate result then201 completion succeeds in ${single ? "single" : "bulk"} mode`, async (t) => {
      const { current } = await fixture(t, 2);
      if (single)
        current.session.jwt = jwt({ wrangler_single_asset_uploads: true });
      current.hook = (call) => {
        if (
          call.url.includes("/workers/assets/upload") &&
          current.bucketPosts === 0
        ) {
          current.bucketPosts++;
          return Response.json(
            {
              success: true,
              errors: null,
              ...(shape === "omitted"
                ? {}
                : { result: shape === "null" ? null : {} }),
            },
            { status: 202 },
          );
        }
      };
      assert.equal((await current.run()).outcome, "static_bindings_verified");
      assert.equal(current.bucketPosts, 2);
      assert.equal(current.versionPosts, 1);
    });
for (const body of [
  { success: false, errors: [], result: null },
  { success: true, errors: [{ code: 10057 }], result: {} },
  { success: true, errors: "invalid", result: {} },
  { errors: [], result: {} },
])
  test(`asset202 rejects unsuccessful/error envelope ${JSON.stringify(body)}`, async (t) => {
    const { current } = await fixture(t, 2);
    current.hook = (call) =>
      call.url.includes("/workers/assets/upload")
        ? Response.json(body, { status: 202 })
        : undefined;
    await assert.rejects(current.run(), prefix("mutation_unknown"));
    assert.equal(
      current.calls.filter((call) =>
        call.url.includes("/workers/assets/upload"),
      ).length,
      1,
    );
    assert.equal(current.versionPosts, 0);
    assert.equal(current.deploymentPosts, 0);
  });
for (const result of [null, [], "invalid", false])
  test(`asset201 without valid completion cannot dispatch version: ${JSON.stringify(result)}`, async (t) => {
    const { current, root } = await fixture(t, 1);
    current.hook = (call) =>
      call.url.includes("/workers/assets/upload")
        ? Response.json({ success: true, errors: [], result }, { status: 201 })
        : undefined;
    await assert.rejects(current.run());
    assert.equal(current.versionPosts, 0);
    await assert.rejects(
      fs.stat(path.join(root, RECOVERY_V2_DIRECTORY, "attempt-claim.json")),
      { code: "ENOENT" },
    );
  });
for (const status of [201, 202])
  for (const stage of ["source", "session", "version", "deployment"])
    test(`${stage} endpoint remains strict200 when HTTP${status} has success envelope`, async (t) => {
      const { current } = await fixture(t);
      const match = (url) =>
        stage === "source"
          ? url.endsWith(`/versions/${RECOVERY_SOURCE_VERSION}`)
          : stage === "session"
            ? url.endsWith("/assets-upload-session")
            : stage === "version"
              ? url.endsWith("?deploy=false")
              : url.endsWith("/deployments?force=true");
      current.hook = (call) =>
        match(call.url)
          ? Response.json({ success: true, errors: [], result: {} }, { status })
          : undefined;
      await assert.rejects(
        current.run(),
        prefix(stage === "source" ? "read_failed" : "mutation_unknown"),
      );
      assert.equal(current.calls.filter((call) => match(call.url)).length, 1);
    });
test("fixed HTTP202 continuation uses one new session, preserves every old record and shares original version claim", async (t) => {
  const f = await continuationFixture(t),
    { current, root, dir, oldRun, snapshot } = f;
  const claimBefore = await fs.readFile(
    path.join(dir, "asset-session-claim.json"),
    "utf8",
  );
  const result = await f.continue();
  assert.equal(result.requests, 17);
  assert.equal(result.cumulativeRequests, 25);
  assert.equal(result.cumulativeAssetBuckets, 4);
  assert.equal(result.cumulativeAssetBytes, 644496);
  assert.equal(current.sessionPosts, 1);
  assert.equal(current.bucketPosts, 3);
  assert.equal(current.versionPosts, 1);
  assert.equal(current.deploymentPosts, 1);
  assert.equal(
    await fs.readFile(path.join(dir, "asset-session-claim.json"), "utf8"),
    claimBefore,
  );
  for (const [name, value] of Object.entries(snapshot))
    assert.equal(await fs.readFile(path.join(oldRun, name), "utf8"), value);
  const versionClaim = JSON.parse(
    await fs.readFile(path.join(dir, "attempt-claim.json")),
  );
  assert.equal(versionClaim.runId, "continuation");
  for (const name of await fs.readdir(path.join(dir, "continuation"))) {
    const text = await fs.readFile(
      path.join(dir, "continuation", name),
      "utf8",
    );
    assert.equal(text.includes(SESSION), false);
    assert.equal(text.includes(current.session.jwt), false);
    assert.equal(text.includes(COMPLETION), false);
  }
  for (const call of current.calls.filter((call) =>
    call.url.includes("/workers/assets/upload"),
  ))
    assert.equal(call.headers.Authorization, `Bearer ${current.session.jwt}`);
  const count = current.calls.length;
  await assert.rejects(f.continue("third"));
  await assert.rejects(current.run("ordinary"));
  assert.equal(current.sessionPosts, 1);
  assert.equal(current.versionPosts, 1);
  assert.ok(current.calls.length >= count);
  assert.ok(
    await fs.stat(
      path.join(
        root,
        RECOVERY_V2_DIRECTORY,
        "asset-202-continuation-claim.json",
      ),
    ),
  );
});
for (const change of [
  "result",
  "status",
  "error-code",
  "identity",
  "manifest",
  "extra-request",
  "attempt-claim",
  "continuation-claim",
  "mode",
  "missing",
  "unsafe",
])
  test(`fixed202 continuation ${change} prestate drift rejects before any IO write or HTTP`, async (t) => {
    const f = await continuationFixture(t);
    let filename = path.join(f.oldRun, "result.json");
    if (change === "status")
      filename = path.join(f.oldRun, "008-http-status.json");
    if (change === "error-code")
      filename = path.join(f.oldRun, "008-error-codes.json");
    if (change === "identity")
      filename = path.join(f.dir, "asset-session-claim.json");
    if (change === "manifest")
      filename = path.join(f.oldRun, "007-intent.json");
    if (change === "mode") filename = path.join(f.oldRun, "asset-plan.json");
    if (change === "extra-request")
      filename = path.join(f.oldRun, "009-intent.json");
    if (change.endsWith("claim"))
      filename = path.join(
        f.dir,
        change === "attempt-claim"
          ? "attempt-claim.json"
          : "asset-202-continuation-claim.json",
      );
    if (change === "missing") await fs.unlink(filename);
    else if (change === "unsafe") await fs.chmod(filename, 0o644);
    else {
      let value = {};
      try {
        value = JSON.parse(await fs.readFile(filename));
      } catch {}
      if (change === "result") value.versionPosts = 1;
      if (change === "status") value.httpStatus = 200;
      if (change === "error-code") value.cloudflareErrorCodes = [10057];
      if (change === "identity") value.identity.worker = "other";
      if (change === "manifest") value.bodySha256 = "a".repeat(64);
      if (change === "mode") value.mode = "single";
      await fs.writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    }
    const before = (await fs.readdir(f.dir)).sort();
    await assert.rejects(f.continue());
    assert.deepEqual((await fs.readdir(f.dir)).sort(), before);
    assert.equal(f.current.calls.length, 0);
  });
test("concurrent explicit202 continuations acquire exactly one new-session claim", async (t) => {
  const f = await continuationFixture(t);
  const results = await Promise.allSettled([f.continue("a"), f.continue("b")]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(f.current.sessionPosts, 1);
  assert.equal(f.current.versionPosts, 1);
  assert.equal(f.current.deploymentPosts, 1);
});
for (const stage of ["session", "asset", "version"])
  test(`unknown continued ${stage} consumes continuation forever without replay`, async (t) => {
    const f = await continuationFixture(t);
    const match = (url) =>
      stage === "session"
        ? url.endsWith("/assets-upload-session")
        : stage === "asset"
          ? url.includes("/workers/assets/upload")
          : url.endsWith("?deploy=false");
    f.current.hook = (call) => {
      if (match(call.url)) throw Error("synthetic lost response");
    };
    await assert.rejects(f.continue(), prefix("mutation_unknown"));
    const count = f.current.calls.length;
    f.current.hook = null;
    await assert.rejects(f.continue("again"));
    assert.equal(f.current.calls.length, count);
    assert.equal(f.current.calls.filter((call) => match(call.url)).length, 1);
    assert.equal(f.current.deploymentPosts, 0);
  });
test("continuation preflights must match original source/auth hashes", async (t) => {
  const f = await continuationFixture(t);
  // A structurally valid old claim is still bound to the independent new reads.
  const name = path.join(f.dir, "asset-session-claim.json"),
    claim = JSON.parse(await fs.readFile(name));
  claim.authSha256 = "a".repeat(64);
  await fs.writeFile(name, JSON.stringify(claim));
  await assert.rejects(f.continue(), prefix("continuation_preflight_changed"));
  assert.equal(f.current.calls.length, 6);
  assert.equal(f.current.sessionPosts, 0);
});
test("continued session plan reserves later reads and remains within original cumulative30HTTP", async (t) => {
  const f = await continuationFixture(t);
  f.current.session.buckets = f.current.assets.rows
    .slice(0, 9)
    .map((row) => [row.hash]);
  await assert.rejects(f.continue(), prefix("request_budget"));
  assert.equal(f.current.sessionPosts, 1);
  assert.equal(f.current.bucketPosts, 0);
  assert.equal(f.current.versionPosts, 0);
});
test("single-asset mode uploads two frozen raw hashes sequentially and attaches completionJWT", async (t) => {
  const { current } = await fixture(t);
  current.session = {
    jwt: jwt({ wrangler_single_asset_uploads: true }),
    buckets: [current.assets.rows.slice(0, 2).map((r) => r.hash)],
  };
  const result = await current.run();
  assert.equal(result.requests, 16);
  assert.equal(result.assetBuckets, 2);
  assert.equal(current.bucketPosts, 2);
  assert.equal(current.versionPosts, 1);
  assert.equal(
    current.calls.some((c) => c.url.endsWith("?base64=true")),
    false,
  );
});
for (const [name, change] of [
  ["foreign hash", (s) => s.buckets.push(["a".repeat(32)])],
  ["duplicate hash", (s) => s.buckets.push([...s.buckets[0]])],
  ["empty bucket", (s) => s.buckets.push([])],
  [
    "too many buckets",
    (s, a) => {
      s.buckets = a.rows.slice(0, 17).map((r) => [r.hash]);
    },
  ],
  [
    "single-asset mode over16 hashes",
    (s, a) => {
      s.jwt = jwt({ wrangler_single_asset_uploads: true });
      s.buckets = [a.rows.slice(0, 17).map((r) => r.hash)];
    },
  ],
])
  test(`${name} session stops beforeany asset/version/deployment POST`, async (t) => {
    const { current } = await fixture(t, 1);
    change(current.session, current.assets);
    await assert.rejects(current.run());
    assert.equal(current.sessionPosts, 1);
    assert.equal(current.bucketPosts, 0);
    assert.equal(current.versionPosts, 0);
    assert.equal(current.deploymentPosts, 0);
  });
test("bucketplan rejects morethan20MB and accepts exact20MB without reading source files", () => {
  const hash = "b".repeat(32),
    byHash = new Map([[hash, { hash, size: 20_000_000 }]]),
    value = { jwt: SESSION, buckets: [[hash]] };
  assert.equal(validateRecoveryBuckets(value, byHash).bytes, 20_000_000);
  byHash.get(hash).size++;
  assert.throws(
    () => validateRecoveryBuckets(value, byHash),
    prefix("asset_bytes_exceeded"),
  );
  for (const token of [
    "invalid",
    jwt({ exp: 1 }),
    jwt({ exp: Math.floor(Date.now() / 1000) + 10000 }),
  ])
    assert.throws(() => validateRecoveryJwt(token));
});
for (const stage of [
  "session",
  "asset",
  "single-asset",
  "version",
  "deployment",
])
  test(`unknown ${stage} preservesallclaims and neverreplays through newrun`, async (t) => {
    const { current, root } = await fixture(
      t,
      stage === "asset" || stage === "single-asset" ? 2 : 0,
    );
    if (stage === "single-asset")
      current.session.jwt = jwt({ wrangler_single_asset_uploads: true });
    const match = (url) =>
      stage === "session"
        ? url.endsWith("/assets-upload-session")
        : stage === "asset"
          ? url.endsWith("/workers/assets/upload?base64=true")
          : stage === "single-asset"
            ? /\/workers\/assets\/upload\/[a-f0-9]{32}$/.test(url)
            : stage === "version"
              ? url.endsWith("?deploy=false")
              : url.endsWith("/deployments?force=true");
    let dispatched = 0;
    current.hook = (call) => {
      if (match(call.url)) {
        dispatched++;
        throw Error("synthetic response lost");
      }
    };
    await assert.rejects(current.run(), prefix("mutation_unknown"));
    assert.equal(dispatched, 1);
    current.hook = null;
    await assert.rejects(current.run("second"));
    assert.equal(dispatched, 1);
    assert.equal(current.calls.filter((c) => match(c.url)).length, 1);
    assert.ok(
      await fs.stat(
        path.join(root, RECOVERY_V2_DIRECTORY, "asset-session-claim.json"),
      ),
    );
    if (stage === "asset" || stage === "single-asset")
      assert.equal(current.versionPosts, 0);
    if (stage === "version") assert.equal(current.deploymentPosts, 0);
  });
test("bulk HTTP400 numeric code is observed privately without message/JWT and remainsunknown", async (t) => {
  const { current, root } = await fixture(t, 1);
  current.hook = (call) =>
    call.url.endsWith("/workers/assets/upload?base64=true")
      ? Response.json(
          {
            success: false,
            errors: [{ code: 10057, message: `private ${SESSION}` }],
            result: null,
          },
          { status: 400 },
        )
      : undefined;
  await assert.rejects(current.run(), prefix("mutation_unknown"));
  const dir = path.join(root, RECOVERY_V2_DIRECTORY, "recovery");
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, "008-http-status.json"))),
    { httpStatus: 400 },
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, "008-error-codes.json"))),
    { cloudflareErrorCodes: [10057] },
  );
  assert.equal(current.versionPosts, 0);
  for (const name of await fs.readdir(dir))
    assert.equal(
      (await fs.readFile(path.join(dir, name), "utf8")).includes(SESSION),
      false,
    );
});
for (const stage of [
  "source",
  "settings",
  "database",
  "active",
  "latest",
  "auth",
])
  test(`preflight ${stage} drift rejects beforeasset session`, async (t) => {
    const { current, db } = await fixture(t);
    current.hook = (call) => {
      if (
        stage === "source" &&
        call.url.endsWith(`/versions/${RECOVERY_SOURCE_VERSION}`)
      )
        return response({ ...current.source, id: NEW_VERSION });
      if (stage === "settings" && call.url.endsWith("/settings"))
        return response({ bindings: bindings() });
      if (
        stage === "database" &&
        call.url.endsWith(`/d1/database/${identity.legacyDatabases.production}`)
      )
        return response({ uuid: NEW_VERSION });
      if (
        stage === "active" &&
        call.url.endsWith("/deployments?page=1&per_page=1")
      )
        return response({ deployments: [] });
      if (
        stage === "latest" &&
        call.url.endsWith("/versions?page=1&per_page=1")
      )
        return response({ items: [{ id: NEW_VERSION }] });
      if (stage === "auth" && call.url.endsWith("/query"))
        db.exec("UPDATE auth_config SET enabled=1");
    };
    await assert.rejects(current.run());
    assert.equal(current.sessionPosts, 0);
    assert.equal(current.versionPosts, 0);
    assert.equal(current.deploymentPosts, 0);
  });
for (const change of ["module", "bindings", "main"])
  test(`independent newJSON version ${change} mismatch preventsdeployment`, async (t) => {
    const { current } = await fixture(t);
    if (change === "module")
      current.immutable.modules[0].content_base64 =
        Buffer.from("export default{};").toString("base64");
    if (change === "bindings") current.immutable.bindings.pop();
    if (change === "main") current.immutable.main_module = "other.mjs";
    await assert.rejects(current.run());
    assert.equal(current.versionPosts, 1);
    assert.equal(current.deploymentPosts, 0);
  });
test("concurrent runs haveone sharedsession claim and onlyone version dispatch", async (t) => {
  const { current } = await fixture(t, 2);
  const results = await Promise.allSettled([
    current.run("a"),
    current.run("b"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(current.sessionPosts, 1);
  assert.equal(current.bucketPosts, 2);
  assert.equal(current.versionPosts, 1);
  assert.equal(current.deploymentPosts, 1);
});
test("frozen loader rejects changed manifest and symlink without transport or private/ebook reads", async (t) => {
  const { root } = await isolatedFixture(t),
    dir = path.join(root, RECOVERY_ASSET_DIRECTORY);
  await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await fs.mkdir(dir, { mode: 0o755 });
  await fs.writeFile(path.join(dir, "index.html"), "synthetic public");
  await assert.rejects(
    loadFrozenRecoveryAssets(root),
    prefix("asset_manifest_changed"),
  );
  await fs.symlink("missing", path.join(dir, "private.js"));
  await assert.rejects(
    loadFrozenRecoveryAssets(root),
    prefix("asset_file_invalid"),
  );
});
test("new version validation normalizes binding order but rejects secretvalue fields", () => {
  const value = version();
  value.bindings.reverse();
  value.bindings = value.bindings.map((b) => ({ type: b.type, name: b.name }));
  assert.ok(validateRecoveryV2Version(value, NEW_VERSION));
  value.bindings.find((b) => b.type === "secret_text").text =
    "synthetic-secret";
  assert.throws(() => validateRecoveryV2Version(value, NEW_VERSION));
});
