import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  CF01_CLOSE_INTERNALS as H,
  CF01_CLOSE_GUARDS,
  CF01_CLOSE_SQL,
} from "../scripts/cf01-storage-close.mjs";
import {
  runCf01VersionClose,
  CF01_VERSION_CLOSE_LIMITS,
  Cf01VersionCloseError,
} from "../scripts/cf01-version-close.mjs";
const ACCOUNT = "a".repeat(32),
  DB = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222",
  W = "33333333-3333-4333-8333-333333333333";
const D0 = "44444444-4444-4444-8444-444444444444",
  D1 = "55555555-5555-4555-8555-555555555555";
const OLD = "66666666-6666-4666-8666-666666666666",
  STORAGE = "77777777-7777-4777-8777-777777777777";
const SECRET = "sentinel-secret-never-persist",
  ANNO = "sentinel-annotation-never-persist",
  CODE = "sentinel-code-never-persist";
const digest = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const envelope = (result) =>
  Response.json({ success: true, errors: [], result });
const errorIs = (suffix) => (e) =>
  e instanceof Cf01VersionCloseError &&
  e.code === `cf01_version_close_${suffix}` &&
  e.message === e.code;
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shelf-version-close-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".local"), { mode: 0o700 });
  await fs.mkdir(path.join(root, ".local/cf01"), { mode: 0o700 });
  const write = (name, v) =>
    fs.writeFile(
      path.join(root, name),
      typeof v === "string" ? v : JSON.stringify(v),
      { mode: 0o600 },
    );
  const read = async (name) =>
    JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
  await write(
    ".env",
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_CF_DEPLOY_TOKEN=synthetic-deploy-token\n`,
  );
  await write(".local/cf01/resources.json", {
    accountId: ACCOUNT,
    databaseId: DB,
    databaseName: "the-shelf-cf01",
    ownedWorkers: ["the-shelf-cf01", "the-shelf-cf01-mock"],
  });
  const config = {
    name: "the-shelf-cf01",
    account_id: ACCOUNT,
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      { binding: "CF_DB", database_id: DB, database_name: "the-shelf-cf01" },
    ],
    r2_buckets: [],
    services: [{ binding: "CF_MOCK", service: "the-shelf-cf01-mock" }],
    workflows: [
      {
        binding: "CF_WORKFLOW",
        name: "the-shelf-cf01",
        class_name: "Cf01Workflow",
      },
    ],
  };
  await write(".local/cf01/wrangler.json", config);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    await fs.readFile(
      new URL("../cloudflare/probe/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.prepare(
    "INSERT INTO cf01_budget VALUES (?,'storage',100,0,'success')",
  ).run(STORAGE);
  db.prepare("DELETE FROM cf01_runs WHERE run_id=?").run(STORAGE);
  for (const g of CF01_CLOSE_GUARDS) db.exec(g.sql);
  const bindings = [
    { name: "CF_DB", type: "d1", id: DB },
    { name: "CF_BUCKET", type: "r2_bucket", bucket_name: "the-shelf-books" },
    {
      name: "CF_MOCK",
      type: "service",
      service: "the-shelf-cf01-mock",
      environment: "production",
    },
    { name: "CF_PROBE_TOKEN", type: "secret_text", text: SECRET },
    {
      name: "CF_WORKFLOW",
      type: "workflow",
      workflow_name: "the-shelf-cf01",
      class_name: "Cf01Workflow",
    },
  ];
  const source = {
    id: U,
    number: 1,
    urls: [],
    created_on: "2026-10-22T00:00:00Z",
    author_email: "sentinel-author-never-persist@example.test",
    bindings,
    main_module: "index.js",
    modules: [
      {
        name: "index.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from(
          `export default {fetch(){return new Response('${CODE}')}}`,
        ).toString("base64"),
      },
      {
        name: "helper.txt",
        content_type: "text/plain",
        content_base64: Buffer.from("second-module").toString("base64"),
      },
    ],
    annotations: {
      "workers/message": ANNO,
      "workers/tag": "fixed-tag",
      "workers/triggered_by": "upload",
    },
    compatibility_date: "2026-10-15",
    compatibility_flags: ["nodejs_compat"],
    limits: { cpu_ms: 10, subrequests: 50 },
    usage_model: "standard",
  };
  const versions = new Map([[U, source]]);
  const deployment = (uuid, ver) => ({
    id: uuid,
    created_on: "2026-10-22T00:00:00Z",
    source: "api",
    strategy: "percentage",
    versions: [{ version_id: ver, percentage: 100 }],
    annotations: {
      "workers/message": ANNO,
      "workers/triggered_by": "deployment",
    },
  });
  const f = {
    root,
    write,
    read,
    db,
    config,
    source,
    versions,
    calls: [],
    current: deployment(D0, U),
    settingsLatest: false,
    hook: null,
    settingsExtra: {},
    mutationCount: 0,
  };
  const settings = () => {
    const ver = versions.get(
      f.settingsLatest && versions.has(W)
        ? W
        : f.current.versions[0].version_id,
    );
    return {
      bindings: ver.bindings,
      annotations: ver.annotations,
      compatibility_date: ver.compatibility_date,
      compatibility_flags: ver.compatibility_flags,
      limits: ver.limits,
      usage_model: ver.usage_model,
      observability: { enabled: false },
      logpush: false,
      tags: [],
      tail_consumers: [],
      ...f.settingsExtra,
    };
  };
  f.settings = settings;
  const identity = {
    root,
    accountId: ACCOUNT,
    databaseId: DB,
    worker: "the-shelf-cf01",
    guardSha256: digest(CF01_CLOSE_GUARDS),
  };
  const s = H.settingsView(settings(), DB),
    code = H.validateVersion(source, U, H.normalizeBindings(bindings, DB), DB);
  const expected = {
    bindingsSha256: digest(s.bindings.filter((b) => b.name !== "CF_BUCKET")),
    metadataSha256: s.metadataSha256,
    annotationsSha256: s.annotationsSha256,
    codeSha256: digest(code),
    subdomainSha256: digest({ enabled: false, previewsEnabled: false }),
  };
  const legacy = {
    schemaVersion: 1,
    identity,
    writes: [
      {
        runId: OLD,
        index: 25,
        at: 100,
        kind: "patch",
        state: "unknown",
        expected,
      },
    ],
    failures: [],
    checkpoint: null,
  };
  await write(".local/cf01/storage-close-state.json", legacy);
  await write(`.local/cf01/storage-close-${OLD}.json`, {
    schemaVersion: 1,
    kind: "cf01-storage-capability-reduction",
    action: "close",
    runId: OLD,
    identity,
    requests: Array.from({ length: 25 }, (_, i) =>
      i === 24
        ? {
            index: 25,
            kind: "patch",
            state: "unknown",
            at: 100,
            label: "remove-fixed-r2-binding",
            path: "/workers/scripts/the-shelf-cf01/settings",
            method: "PATCH",
          }
        : { index: i + 1, kind: "read", state: "observed" },
    ),
  });
  f.oldBytes = await fs.readFile(
    path.join(root, ".local/cf01/storage-close-state.json"),
  );
  f.receipts = async () => {
    const names = (await fs.readdir(path.join(root, ".local/cf01"))).filter(
      (n) => /^version-close-[a-f0-9-]{36}\.json$/.test(n),
    );
    return Promise.all(names.map((n) => read(`.local/cf01/${n}`)));
  };
  f.fetch = async (url, options) => {
    const call = { url, options, index: f.calls.length + 1 };
    f.calls.push(call);
    const pending = (await f.receipts()).find(
      (r) => r.requests.at(-1)?.state === "dispatched",
    );
    assert.ok(pending, "receipt durable before every dispatch");
    assert.ok(
      pending.requests.length <=
        CF01_VERSION_CLOSE_LIMITS.requests[pending.action],
    );
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(
      options.headers.authorization,
      "Bearer synthetic-deploy-token",
    );
    assert.ok(
      url.startsWith(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`,
      ),
    );
    assert.ok(!url.includes("latest"));
    if (f.hook) {
      const result = await f.hook(call, pending);
      if (result !== undefined) return result;
    }
    const u = new URL(url),
      suffix = u.pathname.split(`/accounts/${ACCOUNT}`)[1];
    if (suffix === `/d1/database/${DB}`)
      return envelope({ uuid: DB, name: "the-shelf-cf01" });
    if (suffix === `/d1/database/${DB}/query`) {
      const b = JSON.parse(options.body);
      assert.deepEqual(b.params, []);
      assert.ok([CF01_CLOSE_SQL.schema, CF01_CLOSE_SQL.counts].includes(b.sql));
      return envelope([
        {
          success: true,
          results: db.prepare(b.sql).all(),
          meta: { has_more: false },
        },
      ]);
    }
    const prefix = "/workers/scripts/the-shelf-cf01";
    if (suffix === prefix + "/settings") return envelope(settings());
    if (suffix === prefix + "/subdomain")
      return envelope({ enabled: false, previews_enabled: false });
    if (suffix === prefix + "/deployments" && options.method === "GET") {
      assert.equal(u.search, "?page=1&per_page=1");
      return envelope({ deployments: [f.current] });
    }
    if (suffix === prefix + "/deployments" && options.method === "POST") {
      assert.equal(u.search, "?force=false");
      f.mutationCount++;
      const b = JSON.parse(options.body);
      assert.equal(b.strategy, "percentage");
      assert.deepEqual(b.versions, [{ version_id: W, percentage: 100 }]);
      assert.deepEqual(b.annotations, { "workers/message": ANNO });
      f.current = deployment(D1, W);
      return envelope(f.current);
    }
    if (suffix === prefix + `/deployments/${D1}`) return envelope(f.current);
    const vprefix = "/workers/workers/the-shelf-cf01/versions";
    if (suffix === vprefix && options.method === "POST") {
      assert.equal(u.search, "?deploy=false");
      f.mutationCount++;
      const b = JSON.parse(options.body);
      assert.deepEqual(
        b.bindings,
        ["CF_DB", "CF_MOCK", "CF_PROBE_TOKEN", "CF_WORKFLOW"].map((name) => ({
          name,
          type: "inherit",
          version_id: U,
        })),
      );
      assert.ok(!options.body.includes(SECRET));
      assert.deepEqual(b.modules, source.modules);
      assert.equal(b.main_module, source.main_module);
      assert.deepEqual(b.annotations, {
        "workers/message": ANNO,
        "workers/tag": "fixed-tag",
      });
      versions.set(W, {
        ...structuredClone(source),
        ...b,
        id: W,
        number: 2,
        bindings: structuredClone(
          source.bindings.filter((x) => x.name !== "CF_BUCKET"),
        ),
      });
      return envelope({ id: W });
    }
    if (suffix.startsWith(vprefix + "/")) {
      assert.equal(u.search, "?include=modules");
      const v = versions.get(suffix.slice(vprefix.length + 1));
      assert.ok(v);
      return envelope(v);
    }
    throw new Error("unexpected-route-must-not-leak");
  };
  f.run = (action, extra = {}) =>
    runCf01VersionClose({
      action,
      execute: true,
      root,
      environment: {},
      fetchImpl: f.fetch,
      ...extra,
    });
  f.state = () => read(".local/cf01/version-close-state.json");
  f.assertPrivate = async () => {
    for (const n of await fs.readdir(path.join(root, ".local/cf01"))) {
      if (!n.startsWith("version-close-")) continue;
      const file = path.join(root, ".local/cf01", n),
        text = await fs.readFile(file, "utf8");
      for (const x of [
        SECRET,
        ANNO,
        CODE,
        source.modules[0].content_base64,
        "sentinel-author-never-persist",
      ])
        assert.ok(!text.includes(x), `no private raw data in ${n}`);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      await fs.readFile(
        path.join(root, ".local/cf01/storage-close-state.json"),
      ),
      f.oldBytes,
    );
  };
  return f;
}

test("preview has zero filesystem, clock and network IO", async () => {
  for (const action of ["create", "deploy", "status"]) {
    const r = await runCf01VersionClose({
      action,
      root: "/definitely-not-a-root",
      clock: () => assert.fail(),
      fetchImpl: () => assert.fail(),
    });
    assert.equal(r.requests, 0);
    assert.equal(r.mode, "preview");
    assert.equal(r.uploadAllowed, false);
  }
});
test("create, separate deploy, independent status obey fixed request matrices and preserve old unknown", async (t) => {
  const f = await fixture(t);
  const c = await f.run("create");
  assert.equal(c.requests, 18);
  assert.equal(c.status, "candidate_verified");
  assert.equal(f.current.versions[0].version_id, U);
  assert.equal((await f.state()).writes[0].state, "verified");
  await f.assertPrivate();
  const d = await f.run("deploy");
  assert.equal(d.requests, 20);
  assert.equal(d.capabilityObserved, true);
  assert.equal(f.mutationCount, 2);
  const s = await f.run("status");
  assert.equal(s.requests, 13);
  assert.equal(s.capabilityObserved, true);
  assert.equal(s.cloudWriteFreezeProven, false);
  assert.equal(s.drainProven, false);
  await f.assertPrivate();
});
test("status before create is read only, bounded and reports remaining R2", async (t) => {
  const f = await fixture(t);
  const r = await f.run("status");
  assert.equal(r.requests, 13);
  assert.equal(r.capabilityObserved, false);
  assert.equal(f.mutationCount, 0);
  await f.assertPrivate();
});
test("settings-read empty placement reaches concrete source GET but exact cross-metadata remains strict", async (t) => {
  const f = await fixture(t);
  f.settingsExtra = { placement: {} };
  await assert.rejects(f.run("status"), errorIs("metadata_invalid"));
  assert.equal(f.calls.length, 7);
  assert.ok(f.calls.at(-1).url.includes(`/${U}?include=modules`));
  assert.equal(f.mutationCount, 0);
  assert.deepEqual((await f.state()).writes, []);
  await f.assertPrivate();
});
test("empty placement on concrete version is still unsupported and cannot enable create", async (t) => {
  const f = await fixture(t);
  f.settingsExtra = { placement: {} };
  f.source.placement = {};
  await assert.rejects(f.run("create"), errorIs("metadata_invalid"));
  assert.equal(f.calls.length, 7);
  assert.equal(f.mutationCount, 0);
  assert.deepEqual((await f.state()).writes, []);
});
test("matching explicit smart placement remains supported in settings and concrete version", async (t) => {
  const f = await fixture(t);
  f.settingsExtra = { placement: { mode: "smart" } };
  f.source.placement = { mode: "smart" };
  const result = await f.run("status");
  assert.equal(result.requests, 13);
  assert.equal(f.mutationCount, 0);
});
for (const placement of [
  { mode: "off" },
  { mode: "targeted" },
  { extra: true },
  null,
  [],
])
  test(`settings-read nonempty unsupported placement ${JSON.stringify(placement)} remains rejected`, async (t) => {
    const f = await fixture(t);
    f.settingsExtra = { placement };
    await assert.rejects(f.run("status"), errorIs("metadata_invalid"));
    assert.equal(f.calls.length, 5);
    assert.equal(f.mutationCount, 0);
  });
test("undeployed latest settings may show candidate while actual current remains source", async (t) => {
  const f = await fixture(t);
  f.settingsLatest = true;
  assert.equal((await f.run("create")).requests, 18);
  assert.equal((await f.run("deploy")).requests, 20);
  await f.assertPrivate();
});
test("replaying create or completed deploy never dispatches a mutation", async (t) => {
  const f = await fixture(t);
  await f.run("create");
  const n = f.calls.length;
  await assert.rejects(f.run("create"), errorIs("already_created"));
  assert.equal(f.calls.length, n);
  await f.run("deploy");
  const n2 = f.calls.length;
  await assert.rejects(f.run("deploy"), errorIs("already_deployed"));
  assert.equal(f.calls.length, n2);
});
test("deploy needs a durably verified candidate", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("deploy"), errorIs("candidate_required"));
  assert.equal(f.calls.length, 0);
});
for (const phase of ["create", "deploy"])
  for (const result of [
    "throw",
    "http400",
    "http500",
    "envelope",
    "contradiction",
    "redirect",
    "oversize",
    "deadline",
  ]) {
    test(`${phase} mutation ${result} is unknown, stops and cannot retry`, async (t) => {
      const f = await fixture(t);
      if (phase === "deploy") await f.run("create");
      const start = f.calls.length;
      f.hook = async (call) => {
        if (call.options.method !== "POST" || call.url.endsWith("/query"))
          return;
        if (result === "throw") throw new Error(SECRET);
        if (result === "http400" || result === "http500")
          return Response.json(
            { success: false, errors: [{ message: SECRET }] },
            { status: result === "http400" ? 400 : 500 },
          );
        if (result === "envelope") return envelope({ id: "not-an-id" });
        if (result === "contradiction")
          return Response.json({
            success: true,
            errors: [{ message: SECRET }],
            result: { id: W },
          });
        if (result === "redirect") return new Response(null, { status: 302 });
        if (result === "oversize")
          return new Response("x", {
            headers: { "content-length": "2000001" },
          });
        if (result === "deadline") return new Promise(() => {});
      };
      await assert.rejects(
        f.run(phase, result === "deadline" ? { requestTimeoutMs: 5 } : {}),
        (e) =>
          e instanceof Cf01VersionCloseError && !e.message.includes(SECRET),
      );
      const state = await f.state();
      assert.equal(state.writes.at(-1).state, "unknown");
      assert.equal(f.calls.length - start, phase === "create" ? 11 : 12);
      const count = f.calls.length;
      await assert.rejects(f.run(phase), errorIs("unknown_write_pending"));
      assert.equal(f.calls.length, count);
      if (phase === "create") {
        assert.equal(state.candidate, null);
        await assert.rejects(f.run("deploy"), errorIs("unknown_write_pending"));
      }
      await f.assertPrivate();
    });
  }
for (const phase of ["create", "deploy"]) {
  const total = phase === "create" ? 18 : 20,
    mutation = phase === "create" ? 11 : 12;
  for (let at = mutation + 1; at <= total; at++)
    test(`${phase} accepted but independent request ${at} fails: unknown never retried`, async (t) => {
      const f = await fixture(t);
      if (phase === "deploy") await f.run("create");
      const start = f.calls.length;
      f.hook = async (call) => {
        if (call.index - start === at) throw new Error(SECRET);
      };
      await assert.rejects(f.run(phase));
      const state = await f.state();
      assert.equal(state.writes.at(-1).state, "unknown");
      assert.equal(state.candidate.versionId, W);
      if (phase === "create") assert.equal(state.candidate.verified, false);
      f.hook = null;
      const count = f.calls.length;
      await assert.rejects(f.run(phase), errorIs("unknown_write_pending"));
      assert.equal(f.calls.length, count);
      const observed = await f.run("status");
      assert.equal(observed.capabilityObserved, phase === "deploy");
      assert.equal((await f.state()).writes.at(-1).state, "unknown");
      await f.assertPrivate();
    });
}
test("create unknown with lost candidate UUID never lists or adopts a version", async (t) => {
  const f = await fixture(t);
  f.hook = async (call) => {
    if (call.url.endsWith("?deploy=false")) {
      f.versions.set(W, {
        ...structuredClone(f.source),
        id: W,
        bindings: f.source.bindings.filter((b) => b.name !== "CF_BUCKET"),
      });
      throw new Error(SECRET);
    }
  };
  await assert.rejects(f.run("create"));
  f.hook = null;
  await f.run("status");
  assert.equal((await f.state()).candidate, null);
  assert.ok(!f.calls.some((c) => /\/versions\?page/.test(c.url)));
  await assert.rejects(f.run("deploy"), errorIs("unknown_write_pending"));
});
for (const field of [
  "assets",
  "containers",
  "exports",
  "migrations",
  "migration_tag",
  "exports_reconciliation",
  "unknown_field",
])
  test(`source ${field} presence blocks before a version write`, async (t) => {
    const f = await fixture(t);
    f.source[field] = {};
    await assert.rejects(f.run("create"));
    assert.equal(f.mutationCount, 0);
    assert.equal(f.calls.length, 7);
    await f.assertPrivate();
  });
for (const change of [
  "duplicate-module",
  "bad-base64",
  "missing-main",
  "extra-module-key",
  "extra-binding",
  "service-env",
  "annotations-tag-large",
  "unknown-annotation",
  "limits-key",
  "cache-enabled",
  "package-deps",
  "placement-region",
])
  test(`source ${change} is rejected without cloud mutation`, async (t) => {
    const f = await fixture(t);
    if (change === "duplicate-module")
      f.source.modules.push({ ...f.source.modules[0] });
    if (change === "bad-base64")
      f.source.modules[0].content_base64 = "not base64";
    if (change === "missing-main") f.source.main_module = "missing.js";
    if (change === "extra-module-key") f.source.modules[0].extra = SECRET;
    if (change === "extra-binding")
      f.source.bindings.push({
        name: "OTHER",
        type: "plain_text",
        text: SECRET,
      });
    if (change === "service-env")
      f.source.bindings.find((b) => b.name === "CF_MOCK").environment =
        "development";
    if (change === "annotations-tag-large")
      f.source.annotations["workers/tag"] = "啊".repeat(34);
    if (change === "unknown-annotation") f.source.annotations.unknown = SECRET;
    if (change === "limits-key") f.source.limits.unknown = 1;
    if (change === "cache-enabled") f.source.cache_options = { enabled: true };
    if (change === "package-deps")
      f.source.package_dependencies = [
        { name: "p", packageJsonVersion: "1", installedVersion: "1" },
      ];
    if (change === "placement-region")
      f.source.placement = { region: "aws:test" };
    await assert.rejects(f.run("create"));
    assert.equal(f.mutationCount, 0);
    await f.assertPrivate();
  });
test("candidate is independently compared before deploy can be enabled", async (t) => {
  const f = await fixture(t);
  f.hook = async (call) => {
    if (call.url.includes(`/${W}?include=modules`))
      return envelope({ ...f.versions.get(W), main_module: "helper.txt" });
  };
  await assert.rejects(f.run("create"), errorIs("candidate_invalid"));
  assert.equal((await f.state()).writes[0].state, "unknown");
  assert.equal(f.current.versions[0].version_id, U);
});
for (const changed of ["deployment", "metadata", "annotation", "subdomain"])
  test(`before-write ${changed} drift stops without mutation`, async (t) => {
    const f = await fixture(t);
    f.hook = async (call) => {
      if (call.index === 8 && changed === "deployment")
        return envelope({ deployments: [{ ...f.current, id: D1 }] });
      if (call.index === 9 && changed === "metadata")
        return envelope({ ...f.settings(), observability: { enabled: true } });
      if (call.index === 9 && changed === "annotation")
        return envelope({
          ...f.settings(),
          annotations: { "workers/message": "changed" },
        });
      if (call.index === 10 && changed === "subdomain")
        return envelope({ enabled: true, previews_enabled: false });
    };
    await assert.rejects(f.run("create"));
    assert.equal(f.mutationCount, 0);
  });
test("guard absence and nonzero storage rows are never accepted", async (t) => {
  const f = await fixture(t);
  f.db.exec(`DROP TRIGGER ${CF01_CLOSE_GUARDS[0].name}`);
  await assert.rejects(f.run("create"), errorIs("guards_invalid"));
  assert.equal(f.mutationCount, 0);
});
for (const p of [
  ".env",
  ".local/cf01/resources.json",
  ".local/cf01/wrangler.json",
  ".local/cf01/storage-close-state.json",
])
  test(`private input ${p} replacement is detected before next request`, async (t) => {
    const f = await fixture(t);
    f.hook = async (call) => {
      if (call.index === 1) {
        const file = path.join(f.root, p),
          bytes = await fs.readFile(file);
        await fs.rename(file, file + ".prior");
        await fs.writeFile(file, bytes, { mode: 0o600 });
      }
    };
    await assert.rejects(f.run("create"));
    assert.equal(f.calls.length, 1);
    assert.equal(f.mutationCount, 0);
  });
test("shared close lock blocks before network", async (t) => {
  const f = await fixture(t);
  await f.write(".local/cf01/storage-close.lock", "locked");
  await assert.rejects(f.run("create"), errorIs("operator_locked"));
  assert.equal(f.calls.length, 0);
});
test("lock substitution is detected before next dispatch and not unlinked", async (t) => {
  const f = await fixture(t);
  f.hook = async (call) => {
    if (call.index === 1) {
      const p = path.join(f.root, ".local/cf01/storage-close.lock");
      await fs.rename(p, p + ".prior");
      await fs.writeFile(p, "replacement", { mode: 0o600 });
    }
  };
  await assert.rejects(f.run("create"), errorIs("operator_locked"));
  assert.equal(f.calls.length, 1);
  assert.equal(
    await fs.readFile(
      path.join(f.root, ".local/cf01/storage-close.lock"),
      "utf8",
    ),
    "replacement",
  );
});
test("caller-mutated error text/code is reconstructed from allowlist", async (t) => {
  const f = await fixture(t);
  const e = new Cf01VersionCloseError("cf01_version_close_deadline");
  e.code = SECRET;
  e.message = SECRET;
  e.name = SECRET;
  f.hook = async () => {
    throw e;
  };
  await assert.rejects(f.run("create"), errorIs("local_or_transport_failure"));
  await f.assertPrivate();
});
test("state verified without the independently completed receipt cannot enable deploy", async (t) => {
  const f = await fixture(t);
  await f.run("create");
  const state = await f.state();
  const p = `.local/cf01/version-close-${state.writes[0].runId}.json`,
    receipt = await f.read(p);
  receipt.status = "planned";
  await f.write(p, receipt);
  const n = f.calls.length;
  await assert.rejects(f.run("deploy"), errorIs("unknown_write_pending"));
  assert.equal(f.calls.length, n);
});
test("shared private reader enforces explicit 1MB before open and retains default 2MB", async (t) => {
  const f = await fixture(t);
  const file = ".local/cf01/bounded-fixture.json";
  await f.write(file, "x".repeat(1_000_001));
  const dirs = await H.pinReceiptDirectories(f.root),
    store = await H.privateStore(f.root, dirs);
  await assert.rejects(
    store.read(file, false, 1_000_000),
    (e) => e.code === "cf01_close_private_file_unsafe",
  );
  assert.equal((await store.read(file)).length, 1_000_001);
  for (const max of [0, -1, 2_000_001, 1.5, Infinity, "1000000"])
    await assert.rejects(
      store.read(file, false, max),
      (e) => e.code === "cf01_close_options_invalid",
    );
});
for (const mode of ["mode", "symlink", "hardlink"])
  test(`private input ${mode} is rejected before network`, async (t) => {
    const f = await fixture(t),
      p = path.join(f.root, ".env");
    if (mode === "mode") await fs.chmod(p, 0o644);
    if (mode === "symlink") {
      await fs.rename(p, p + ".prior");
      await fs.symlink(p + ".prior", p);
    }
    if (mode === "hardlink") await fs.link(p, p + ".linked");
    await assert.rejects(f.run("create"));
    assert.equal(f.calls.length, 0);
  });
test("parent private directory substitution stops before the next dispatch", async (t) => {
  const f = await fixture(t);
  f.hook = async (call) => {
    if (call.index === 1) {
      const p = path.join(f.root, ".local/cf01");
      await fs.rename(p, p + ".prior");
      await fs.mkdir(p, { mode: 0o700 });
    }
  };
  await assert.rejects(f.run("create"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.mutationCount, 0);
});
for (const phase of ["create", "deploy"])
  test(`${phase} success response followed by unsafe input before journal save stays dispatched or unknown`, async (t) => {
    const f = await fixture(t);
    if (phase === "deploy") await f.run("create");
    f.hook = async (call) => {
      if (call.options.method !== "POST" || call.url.endsWith("/query")) return;
      const p = path.join(f.root, ".env"),
        bytes = await fs.readFile(p);
      await fs.rename(p, p + ".prior");
      await fs.writeFile(p, bytes, { mode: 0o600 });
      if (phase === "create") return envelope({ id: W });
      return envelope({
        ...f.current,
        id: D1,
        versions: [{ version_id: W, percentage: 100 }],
      });
    };
    await assert.rejects(f.run(phase));
    const state = await f.state();
    assert.ok(["dispatched", "unknown"].includes(state.writes.at(-1).state));
    const n = f.calls.length;
    await assert.rejects(f.run("deploy"), errorIs("unknown_write_pending"));
    assert.equal(f.calls.length, n);
  });
for (const result of [
  "body-deadline",
  "chunk-limit",
  "stream-limit",
  "bad-json",
  "false-success",
  "pagination",
])
  test(`read transport ${result} is bounded and private`, async (t) => {
    const f = await fixture(t);
    f.hook = async () => {
      if (result === "body-deadline")
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
          }),
        );
      if (result === "chunk-limit")
        return new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 10001; i++) c.enqueue(new Uint8Array([32]));
              c.close();
            },
          }),
        );
      if (result === "stream-limit")
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(2_000_001));
              c.close();
            },
          }),
        );
      if (result === "bad-json") return new Response(SECRET);
      if (result === "false-success")
        return Response.json({
          success: false,
          result: { uuid: DB, name: "the-shelf-cf01" },
        });
      if (result === "pagination")
        return Response.json({
          success: true,
          result: { uuid: DB, name: "the-shelf-cf01" },
          result_info: { has_more: true },
        });
    };
    await assert.rejects(
      f.run(
        "create",
        result === "body-deadline" ? { requestTimeoutMs: 5 } : {},
      ),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.mutationCount, 0);
    await f.assertPrivate();
  });
test("oversize code cannot enter a version POST intent or relax byte bounds", async (t) => {
  const f = await fixture(t);
  // Re-register only this synthetic fixture's expected code fingerprint; neither
  // source response nor outgoing payload may bypass its independent 2MB limit.
  const bytes = Buffer.alloc(1_500_001, 97);
  f.source.modules = [
    {
      name: "index.js",
      content_type: "application/javascript+module",
      content_base64: bytes.toString("base64"),
    },
  ];
  const legacy = await f.read(".local/cf01/storage-close-state.json");
  legacy.writes[0].expected.codeSha256 = digest(
    H.validateVersion(
      f.source,
      U,
      H.normalizeBindings(f.source.bindings, DB),
      DB,
    ),
  );
  await f.write(".local/cf01/storage-close-state.json", legacy);
  // Source-response limit may reject even earlier; neither outcome may dispatch a
  // version write, and neither can relax the finite byte bound.
  await assert.rejects(f.run("create"));
  assert.equal(f.mutationCount, 0);
});
for (const changed of [
  "unknown-kind",
  "unknown-state",
  "bad-run",
  "bad-index",
  "bad-at",
  "duplicate",
  "extra-d1-expected",
  "unknown-failure",
  "two-patches",
])
  test(`malformed legacy state ${changed} stops before any cloud request`, async (t) => {
    const f = await fixture(t),
      v = await f.read(".local/cf01/storage-close-state.json");
    const item = {
      runId: STORAGE,
      index: 1,
      at: 1,
      kind: "ddl",
      state: "observed",
    };
    if (changed === "unknown-kind") item.kind = "other";
    if (changed === "unknown-state") item.state = "hidden-pending";
    if (changed === "bad-run") item.runId = "arbitrary/path";
    if (changed === "bad-index") item.index = null;
    if (changed === "bad-at") item.at = -1;
    if (changed === "duplicate") {
      v.writes.push({ ...item });
    }
    if (changed === "extra-d1-expected") item.expected = v.writes[0].expected;
    if (changed === "unknown-failure")
      v.failures.push({ runId: STORAGE, at: 1, raw: SECRET });
    if (changed === "two-patches")
      v.writes.push({ ...v.writes[0], runId: STORAGE, state: "observed" });
    v.writes.push(item);
    await f.write(".local/cf01/storage-close-state.json", v);
    await assert.rejects(f.run("create"), errorIs("legacy_invalid"));
    assert.equal(f.calls.length, 0);
  });
for (const changed of [
  "schema",
  "kind",
  "action",
  "run",
  "identity",
  "label",
  "path",
  "method",
  "index",
  "at",
  "state",
  "duplicate-patch",
  "short-list",
])
  test(`malformed linked old receipt ${changed} never permits a new mutation`, async (t) => {
    const f = await fixture(t),
      file = `.local/cf01/storage-close-${OLD}.json`,
      v = await f.read(file),
      p = v.requests.at(-1);
    if (changed === "schema") v.schemaVersion = 2;
    if (changed === "kind") v.kind = "other";
    if (changed === "action") v.action = "status";
    if (changed === "run") v.runId = STORAGE;
    if (changed === "identity") v.identity.databaseId = STORAGE;
    if (changed === "label") p.label = "arbitrary";
    if (changed === "path") p.path = "/workers/scripts/other/settings";
    if (changed === "method") p.method = "POST";
    if (changed === "index") p.index = 1;
    if (changed === "at") p.at = 99;
    if (changed === "state") p.state = "observed";
    if (changed === "duplicate-patch") v.requests[0] = { ...p, index: 1 };
    if (changed === "short-list") v.requests.shift();
    await f.write(file, v);
    await assert.rejects(f.run("create"), errorIs("legacy_invalid"));
    assert.equal(f.calls.length, 0);
  });
for (const phase of ["create", "deploy"])
  test(`${phase} late mutation response after deadline cannot persist response IDs or unlock writes`, async (t) => {
    const f = await fixture(t);
    if (phase === "deploy") await f.run("create");
    let release, entered;
    const arrived = new Promise((resolve) => {
      entered = resolve;
    });
    f.hook = async (call) => {
      if (call.options.method === "POST" && !call.url.endsWith("/query")) {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    };
    const running = f.run(phase, { requestTimeoutMs: 20 });
    await arrived;
    await assert.rejects(running, errorIs("deadline"));
    release(
      phase === "create"
        ? envelope({ id: W })
        : envelope({
            ...f.current,
            id: D1,
            versions: [{ version_id: W, percentage: 100 }],
          }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const state = await f.state(),
      w = state.writes.at(-1);
    assert.equal(w.state, "unknown");
    assert.equal(w.responseDeploymentId, undefined);
    if (phase === "create") {
      assert.equal(w.responseVersionId, undefined);
      assert.equal(state.candidate, null);
    }
    f.hook = null;
    const count = f.calls.length;
    await assert.rejects(f.run(phase), errorIs("unknown_write_pending"));
    assert.equal(f.calls.length, count);
    await f.assertPrivate();
  });
for (const changed of [
  "schema",
  "kind",
  "mutation-method",
  "mutation-path",
  "mutation-http",
  "mutation-at",
  "extra-mutation",
])
  test(`completed create journal ${changed} cannot unlock deployment`, async (t) => {
    const f = await fixture(t);
    await f.run("create");
    const state = await f.state();
    const file = `.local/cf01/version-close-${state.writes[0].runId}.json`,
      receipt = await f.read(file),
      mutation = receipt.requests[10];
    if (changed === "schema") receipt.schemaVersion = 2;
    if (changed === "kind") receipt.kind = "other";
    if (changed === "mutation-method") mutation.method = "GET";
    if (changed === "mutation-path") mutation.path = "/arbitrary";
    if (changed === "mutation-http") mutation.httpStatus = 201;
    if (changed === "mutation-at") mutation.at = 1;
    if (changed === "extra-mutation") receipt.requests[0].kind = "create";
    await f.write(file, receipt);
    const n = f.calls.length;
    await assert.rejects(f.run("deploy"), errorIs("unknown_write_pending"));
    assert.equal(f.calls.length, n);
  });
