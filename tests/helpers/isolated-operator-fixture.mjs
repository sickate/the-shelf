// Synthetic database and fixed control API only; never connects to Cloudflare.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { DATABASE_SCHEMA_PROFILES } from "../../shared/storage-schema-profiles.mjs";
import { createOwnerVerifier } from "../../cloudflare/library/security.mjs";
import { validateSingleTrialTarget } from "../../scripts/single-trial-config.mjs";
import {
  workerConfig,
  FILENAME_AI_SECRET_NAMES,
} from "../../scripts/cf-api-deploy.mjs";
import {
  isolatedConsentRecord,
  validateIsolatedConsent,
  ISOLATED_INSTALL_STATEMENTS,
} from "../../scripts/isolated-upload.mjs";
export const ACCOUNT = "a".repeat(32),
  ORIGIN = "https://the-shelf.iamzhutuo.workers.dev",
  VERSION = "33333333-3333-4333-8333-333333333333";
export const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
export const sha = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
export const response = (result) =>
  Response.json({ success: true, errors: [], result });
export async function isolatedFixture(
  t,
  {
    installed = false,
    seeded = false,
    enabled = 0,
    authEnabled = 0,
    profile = "trial-009",
  } = {},
) {
  const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "shelf-isolated-operator-")),
    ),
    db = new DatabaseSync(":memory:");
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const dir of [
    ".local",
    ".local/cf03",
    ".local/cf03/production",
    ".local/isolated-upload",
    "cloudflare",
    "cloudflare/library",
    "dist",
    "dist/data",
    "dist/docs",
  ])
    await fs.mkdir(path.join(root, dir), { mode: 0o700 });
  const write = (name, v) =>
    fs.writeFile(
      path.join(root, name),
      typeof v === "string" ? v : JSON.stringify(v),
      { mode: 0o600 },
    );
  const resources = {
    schemaVersion: 1,
    profiles: {
      check: {
        databaseId: identity.legacyDatabases.check,
        databaseName: "the-shelf-cf03-check",
      },
      production: {
        databaseId: identity.legacyDatabases.production,
        databaseName: "the-shelf-library",
      },
    },
  };
  const [owner, pepper, session, trialSecret] = [17, 23, 29, 31].map((n) =>
    Buffer.alloc(32, n).toString("base64url"),
  );
  const targetInput = {
    schemaVersion: 1,
    mode: "first-book-20261023",
    accountId: ACCOUNT,
    bucket: "the-shelf-first-book-20261023",
    worker: "the-shelf",
    origin: ORIGIN,
    uploadSecretSha256: createHash("sha256").update(trialSecret).digest("hex"),
  };
  const target = validateSingleTrialTarget(targetInput, ACCOUNT, trialSecret),
    consent = validateIsolatedConsent(
      isolatedConsentRecord(identity),
      identity,
    );
  await write(
    ".env",
    `SHELF_R2_ACCOUNT_ID=${ACCOUNT}\nSHELF_R2_BUCKET=the-shelf-books\nCLOUDFLARE_API_TOKEN=synthetic-project-token-only-1234\n`,
  );
  await write(".local/cf03/deploy.json", resources);
  await write(
    ".local/isolated-upload/consent.json",
    isolatedConsentRecord(identity),
  );
  await write(".local/cf03/production/single-trial-target.json", targetInput);
  for (const [name, value] of [
    ["owner-access-key", owner],
    ["owner-key-pepper", pepper],
    ["session-secret", session],
    ["single-trial-upload-secret", trialSecret],
  ])
    await write(`.local/cf03/production/${name}`, value);
  await write(
    "cloudflare/library/schema.sql",
    await fs.readFile(
      new URL("../../cloudflare/library/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await write("cloudflare/library/worker.mjs", "export default {};");
  await write("dist/index.html", "<p>Synthetic</p>");
  await write("dist/data/runtime.json", {
    schemaVersion: 1,
    apiMode: "same-origin",
  });
  await write("dist/docs/index.json", { basePath: "/" });
  await write("wrangler.jsonc", {
    name: "the-shelf",
    compatibility_date: "2026-10-15",
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: "./dist",
      html_handling: "force-trailing-slash",
      not_found_handling: "404-page",
    },
  });
  const rows = DATABASE_SCHEMA_PROFILES[profile];
  for (const type of ["table", "index", "view"])
    for (const r of rows) if (r.type === type) db.exec(r.sql);
  const now = Date.now(),
    descriptor = {
      kind: "original",
      scope: "production",
      fileId: "retained_file",
      bookId: "retained_book",
      format: "PDF",
      sizeBytes: 15,
      sha256: "e".repeat(64),
      objectKey: `books/cf03/retained_file/${"e".repeat(64)}.pdf`,
      versionHash: null,
      source: null,
    };
  db.exec(
    "INSERT INTO public_state(scope,updated_at)VALUES('production',0),('check',0)",
  );
  db.prepare(
    "INSERT INTO auth_config VALUES('production',?,'owner-access-key-v1',?,1,?,1)",
  ).run(
    ORIGIN,
    await createOwnerVerifier(owner, pepper, {
      scope: "production",
      origin: ORIGIN,
    }),
    authEnabled,
  );
  db.prepare(
    "INSERT INTO shelf_storage_authority(id,identity_json,phase,migration_hash,committed_bytes,reserved_bytes)VALUES(1,?,'imported',?,15,72)",
  ).run(JSON.stringify(identity), "f".repeat(64));
  db.prepare(
    "INSERT INTO shelf_storage_reservations VALUES('retained_unknown','original:check:legacy:original','legacy',?,72,'uncertain',1,0,NULL,?,?)",
  ).run(
    JSON.stringify({ kind: "original", scope: "check", fileId: "legacy" }),
    now - 10000,
    now - 10000,
  );
  db.prepare(
    "INSERT INTO shelf_storage_single_trial VALUES(1,?,?,?,?,?,?,?,?,?,'confirmed',1,1,'syntheticetag',?)",
  ).run(
    "consumed_permit",
    "2026-10-23-first-book",
    JSON.stringify(identity),
    JSON.stringify({ accountId: ACCOUNT, bucket: target.bucket }),
    JSON.stringify(descriptor),
    target.configSha256,
    15,
    now - 10000,
    now - 5000,
    now - 6000,
  );
  db.prepare(
    "INSERT INTO shelf_storage_legacy_freeze VALUES(1,?,?,?,'synthetic-freeze',?)",
  ).run(identity.authorityId, ACCOUNT, identity.bucket, now - 10000);
  for (const r of rows) if (r.type === "trigger") db.exec(r.sql);
  if (installed) for (const sql of ISOLATED_INSTALL_STATEMENTS) db.exec(sql);
  if (seeded) {
    db.prepare(
      "INSERT INTO shelf_storage_isolated_upload_policy(target_id,authority_identity_json,account_id,bucket,trial_target_sha256,consent_sha256,budget_bytes,created_at,updated_at)VALUES('isolated-project-20261024',?,?,?,?,?,8000000000,?,?)",
    ).run(
      JSON.stringify(identity),
      ACCOUNT,
      target.bucket,
      target.configSha256,
      consent.sha256,
      now,
      now,
    );
    if (enabled)
      db.prepare(
        "UPDATE shelf_storage_isolated_upload_policy SET enabled=1,generation=1,updated_at=?",
      ).run(now);
  }
  const config = workerConfig(
    "production",
    resources.profiles.production,
    ACCOUNT,
    root,
    {
      singleTrialTarget: target,
      filenameAi: true,
      isolatedUploadConsentSha256: consent.sha256,
    },
  );
  const settings = {
    bindings: [
      { name: "DB", type: "d1", id: identity.legacyDatabases.production },
      { name: "ASSETS", type: "assets" },
      { name: "BOOKS", type: "r2_bucket", bucket_name: target.bucket },
      ...FILENAME_AI_SECRET_NAMES.map((name) => ({
        name,
        type: "secret_text",
      })),
      ...Object.entries(config.vars).map(([name, text]) => ({
        name,
        type: "plain_text",
        text,
      })),
    ],
  };
  const calls = [];
  const fixture = {
    root,
    db,
    resources,
    target,
    consent,
    settings,
    write,
    calls,
    context: {
      root,
      resources,
      identity,
      credentials: {
        accountId: ACCOUNT,
        token: "synthetic-project-token-only-1234",
      },
    },
    beforeQuery: null,
    beforeSettings: null,
  };
  fixture.fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method || "GET",
      ...(url.endsWith("/query") ? JSON.parse(init.body) : {}),
    });
    if (url.endsWith("/settings")) {
      await fixture.beforeSettings?.(calls);
      return response(fixture.settings);
    }
    if (url.endsWith("/query")) {
      const { sql, params } = JSON.parse(init.body);
      await fixture.beforeQuery?.(sql, params);
      return response([
        { success: true, results: db.prepare(sql).all(...params) },
      ]);
    }
    if (url.endsWith("/deployments?page=1&per_page=1"))
      return response({
        deployments: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            source: "api",
            strategy: "percentage",
            versions: [{ version_id: VERSION, percentage: 100 }],
          },
        ],
      });
    if (url.endsWith("/subdomain"))
      return response({ enabled: true, previews_enabled: false });
    assertDatabaseUrl(url);
    return response({
      uuid: identity.legacyDatabases.production,
      name: "the-shelf-library",
    });
  };
  return fixture;
}
function assertDatabaseUrl(url) {
  if (!url.endsWith(`/d1/database/${identity.legacyDatabases.production}`))
    throw Error("unexpected synthetic URL");
}
