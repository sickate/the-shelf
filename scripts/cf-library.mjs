// Explicit, local-only operator CLI. No collection scanning, credential generation or retry loop.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  PROFILES,
  validateDeployConfig,
  readProjectEnvironment,
  loadPrivacySecrets,
} from "./cf-api-deploy.mjs";
import {
  LibraryError,
  publicCatalog,
  readPrivateJson,
  writePrivateJson,
} from "./cf-library-data.mjs";
import {
  bootstrap,
  makeFilePlan,
  snapshot,
  saveSnapshot,
} from "./cf-library-operations.mjs";
import { d1Client } from "./cf-library-clients.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const fail = (code) => {
  throw new LibraryError(code);
};
const allowed = new Set([
  "--profile",
  "--file",
  "--manifest",
  "--overrides",
  "--account-evidence",
  "--execute",
  "--resume",
]);
export function parseArguments(argv) {
  const [action, ...rest] = argv;
  if (
    !["plan", "upload", "reconcile", "bootstrap", "snapshot"].includes(action)
  )
    fail("usage");
  const result = { action, execute: false },
    seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i];
    if (!allowed.has(option) || seen.has(option)) fail("usage");
    seen.add(option);
    if (option === "--execute" || option === "--resume") {
      result[option.slice(2)] = true;
      continue;
    }
    const value = rest[++i];
    if (!value || value.startsWith("--")) fail("usage");
    result[option.slice(2)] = value;
  }
  if (!Object.hasOwn(PROFILES, result.profile)) fail("profile_required");
  if (result.resume && (action !== "bootstrap" || !result.execute))
    fail("usage");
  if (
    ["plan", "upload", "reconcile"].includes(action) !== !!result.file ||
    (action === "plan" && result.execute) ||
    (action === "reconcile" && !result.execute)
  )
    fail("usage");
  if (
    (["bootstrap", "snapshot"].includes(action) && result.manifest) ||
    (action !== "bootstrap" && result.overrides) ||
    (!["plan", "upload"].includes(action) && result["account-evidence"])
  )
    fail("usage");
  return result;
}

async function publicInput(root) {
  const filename = path.join(root, "data/catalog.json"),
    stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20_000_000)
    fail("invalid_catalog_file");
  return publicCatalog(JSON.parse(await fs.readFile(filename, "utf8")));
}
async function optionalPrivate(filename, root, fallback) {
  try {
    return await readPrivateJson(filename, root);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function ensureStateDirectory(root) {
  for (const name of [".local", ".local/cf03"]) {
    const directory = path.join(root, name);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o700
    )
      fail("unsafe_private_directory");
  }
}

export async function runLibrary(
  argv,
  { root = ROOT, environment = process.env, dbFactory = d1Client, now } = {},
) {
  const args = parseArguments(argv);
  if ((args.action === "upload" && args.execute) || args.action === "reconcile")
    fail("legacy_storage_migration_required");
  now = now === undefined ? Date.now() : now;
  root = await fs.realpath(root);
  const loaded = await readProjectEnvironment(root, environment);
  if (
    loaded.credentials.ci ||
    loaded.fileEnvironment.SHELF_R2_ACCOUNT_ID !== loaded.credentials.accountId
  )
    fail("local_project_account_required");
  const resources = validateDeployConfig(
    await readPrivateJson(path.join(root, ".local/cf03/deploy.json"), root),
  );
  const scope = PROFILES[args.profile].scope;
  const secrets = [
    ...loaded.credentials.privateValues,
    ...Object.values(await loadPrivacySecrets(root)),
    ...Object.entries(loaded.fileEnvironment)
      .filter(([k]) => /(?:KEY|TOKEN|SECRET|PASSWORD|ACCOUNT_ID)/.test(k))
      .map(([, v]) => v),
  ];
  await ensureStateDirectory(root);
  const absolutePrivate = (value, fallback) =>
    path.resolve(root, value || fallback);
  const planPath = args.file
    ? path.join(root, `.local/cf03/${args.profile}-fileplan-${args.file}.json`)
    : null;
  const db = () =>
    dbFactory(loaded.credentials, resources.profiles[args.profile]);
  const connect = async () => {
    const connection = db();
    await connection.verify();
    return connection;
  };
  if (["plan", "upload"].includes(args.action)) {
    const manifest = await readPrivateJson(
      absolutePrivate(args.manifest, ".local/manifest.json"),
      root,
    );
    const evidence = await optionalPrivate(
      absolutePrivate(
        args["account-evidence"],
        ".local/cf03/account-storage.json",
      ),
      root,
      undefined,
    );
    const plan = await makeFilePlan(
      manifest,
      args.file,
      evidence,
      loaded.credentials.accountId,
      { now, scope },
    );
    await writePrivateJson(
      planPath,
      {
        ...plan,
        profile: args.profile,
        scope,
        databaseName: resources.profiles[args.profile].databaseName,
      },
      root,
    );
    return {
      dryRun: true,
      fileId: args.file,
      format: plan.file.format,
      sizeBytes: plan.file.sizeBytes,
      blockedReason: plan.blockedReason,
      privatePlan: path.relative(root, planPath),
    };
  }
  if (args.action === "bootstrap") {
    const catalog = await publicInput(root);
    const overrides = await optionalPrivate(
      absolutePrivate(args.overrides, ".local/overrides.json"),
      root,
      { schemaVersion: 1, books: {} },
    );
    if (!args.execute) {
      // Reuse the same validation without a network client; the adapter records no SQL/data.
      const summary = await bootstrap(
        { query: async () => [] },
        scope,
        catalog,
        overrides,
        now,
        { secrets, dryRun: true },
      );
      return {
        dryRun: true,
        books: summary.books,
        baseRevision: summary.baseRevision,
        baseRevisionKind: summary.baseRevisionKind,
        inputFingerprint: summary.inputFingerprint,
      };
    }
    // Privacy validation must finish before even connecting to a remote database.
    await bootstrap(undefined, scope, catalog, overrides, now, {
      secrets,
      dryRun: true,
    });
    const result = await bootstrap(
      await connect(),
      scope,
      catalog,
      overrides,
      now,
      { secrets, resume: args.resume === true },
    );
    await writePrivateJson(
      path.join(root, `.local/cf03/${args.profile}-bootstrap.json`),
      { schemaVersion: 1, profile: args.profile, ...result },
      root,
    );
    return result;
  }
  const result = await snapshot(await connect(), scope, { now });
  const privateSnapshot = path.join(
    root,
    `.local/cf03/${args.profile}-snapshot.json`,
  );
  if (!args.execute || args.profile === "check") {
    if (args.execute) fail("check_snapshot_cannot_publish");
    await writePrivateJson(privateSnapshot, result, root);
    return {
      dryRun: true,
      sourceRevision: result.sourceRevision,
      books: result.catalog.books.length,
      privateSnapshot: path.relative(root, privateSnapshot),
    };
  }
  const saved = await saveSnapshot(result, root, {
    staging: privateSnapshot,
    secrets,
  });
  await writePrivateJson(
    path.join(root, ".local/cf03/production-snapshot-receipt.json"),
    {
      schemaVersion: 1,
      ...saved,
      publicSha256: createHash("sha256")
        .update(await fs.readFile(path.join(root, "data/catalog.json")))
        .digest("hex"),
    },
    root,
  );
  return saved;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(await runLibrary(argv), null, 2));
  } catch (error) {
    console.error(
      `CF-03 library operation stopped safely (${error instanceof LibraryError ? error.code : "private_configuration_or_remote_failure"}). No automatic retry.`,
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
