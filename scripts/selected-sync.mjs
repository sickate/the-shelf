#!/usr/bin/env node
/** One selected object. No batch mode, old-ledger fallback, or retry loop. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { getConfig } from "../server/config.mjs";
import { selectedFile, accountEvidence } from "./cf-library-data.mjs";
import { loadMigrationContext } from "./storage-migrate.mjs";
import {
  privateTextOperation,
  readPins,
  validatePin,
  matchPinSource,
} from "../server/prepared-text.mjs";
import { bytesSha256, prepareObject } from "../server/storage-authority.mjs";
import {
  RemoteStorageAuthority,
  validateMigrationReceipt,
} from "../server/remote-storage-authority.mjs";
import { createR2ObjectStore } from "../server/r2-object-store.mjs";
import { syncObject } from "../server/object-sync.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(["plan", "sync", "reconcile"]);
export const SELECTED_REQUEST_LIMIT = 128;
export class SelectedSyncError extends Error {
  constructor(code) {
    super(code);
    this.name = "SelectedSyncError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new SelectedSyncError(code);
};
const safeCode = (error) =>
  typeof error?.code === "string" &&
  /^(selected_|qualifying_storage_|storage_|object_|r2_|prepared_|migration_|account_|file_|invalid_|local_|source_|manifest_|size_|empty_)[a-z_]+$/.test(
    error.code,
  )
    ? error.code
    : "selected_operation_unknown";
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owned = (s, mode) =>
  s.uid === process.getuid() && (s.mode & 0o777) === mode;

function selectionArguments(options) {
  const {
    action = "plan",
    profile,
    fileId,
    kind,
    versionHash,
    sha256,
  } = options;
  if (
    !ACTIONS.has(action) ||
    !["check", "production"].includes(profile) ||
    typeof fileId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(fileId) ||
    !["original", "prepared-text"].includes(kind) ||
    (kind === "prepared-text" &&
      (!HASH.test(versionHash ?? "") || !HASH.test(sha256 ?? ""))) ||
    (kind === "original" && (versionHash !== undefined || sha256 !== undefined))
  )
    fail("selected_invalid_arguments");
  return { action, profile, fileId, kind, versionHash, sha256 };
}

export function parseSelectedSyncArgs(args) {
  const options = { action: "plan" },
    seen = new Set();
  const names = {
    "--profile": "profile",
    "--file": "fileId",
    "--kind": "kind",
    "--version": "versionHash",
    "--sha256": "sha256",
  };
  if (args[0] && !args[0].startsWith("--")) {
    options.action = args[0];
    args = args.slice(1);
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i],
      value = args[++i];
    if (
      !Object.hasOwn(names, arg) ||
      seen.has(arg) ||
      !value ||
      value.startsWith("--")
    )
      fail("selected_invalid_arguments");
    seen.add(arg);
    options[names[arg]] = value;
  }
  selectionArguments(options);
  return options;
}

// Read .env locally for the actual getConfig paths. Plan needs no cloud credential.
async function localEnvironment(root, environment) {
  let fileEnvironment = {};
  try {
    const filename = path.join(root, ".env");
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        !owned(before, 0o600) ||
        before.nlink !== 1 ||
        before.size > 1_000_000
      )
        fail("selected_environment_unsafe");
      const data = await handle.readFile("utf8"),
        after = await handle.stat(),
        named = await fs.lstat(filename);
      if (
        !same(before, named) ||
        !same(before, after) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        fail("selected_environment_changed");
      fileEnvironment = parseEnv(data);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...fileEnvironment, ...environment };
}

async function directoryChain(root, target, create = false) {
  const privateRoot = path.join(root, ".local"),
    relative = path.relative(privateRoot, target);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    fail("selected_configured_path_outside_private");
  let current = root;
  for (const segment of [
    ".local",
    ...relative.split(path.sep).filter(Boolean),
  ]) {
    current = path.join(current, segment);
    let created = false;
    if (create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || !owned(st, 0o700))
      fail("selected_private_directory_unsafe");
    if (created) {
      const parent = await fs.open(
        path.dirname(current),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }
  return target;
}

export async function loadSelectedLocalObject(root, environment, selection) {
  const actual = await fs.realpath(root);
  if (actual !== path.resolve(root)) fail("selected_project_path_unsafe");
  const config = getConfig(await localEnvironment(actual, environment), actual);
  await directoryChain(actual, config.stateDir);
  await directoryChain(actual, path.dirname(config.manifestPath));
  const st = await fs.lstat(config.manifestPath);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    !owned(st, 0o600) ||
    st.nlink !== 1 ||
    st.size > 10_000_000
  )
    fail("selected_manifest_unsafe");
  const { manifest } = await privateTextOperation({
    operation: "manifest",
    path: config.manifestPath,
  });
  const afterManifest = await fs.lstat(config.manifestPath);
  if (
    !same(st, afterManifest) ||
    st.size !== afterManifest.size ||
    st.mtimeMs !== afterManifest.mtimeMs ||
    st.ctimeMs !== afterManifest.ctimeMs ||
    !owned(afterManifest, 0o600)
  )
    fail("selected_manifest_changed");
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.files ||
    typeof manifest.root !== "string"
  )
    fail("selected_manifest_invalid");
  let prepared;
  if (selection.kind === "original") {
    if (manifest.files[selection.fileId]?.visibility !== "private")
      fail("selected_file_not_private");
    const file = await selectedFile(manifest, selection.fileId, {
      scope: selection.profile,
    });
    prepared = await prepareObject({
      kind: "original",
      scope: selection.profile,
      fileId: file.fileId,
      bookId: file.bookId,
      format: file.format,
      bytes: file.data,
    });
  } else {
    const { pins } = await readPins(config.stateDir);
    const pin = validatePin(pins.files[selection.fileId], selection.fileId);
    if (pin.versionHash !== selection.versionHash)
      fail("selected_pin_version_mismatch");
    const entry = manifest.files[selection.fileId];
    matchPinSource(pin, entry);
    const source = await privateTextOperation({
      operation: "read",
      root: manifest.root,
      path: entry.path,
      bytes: pin.sizeBytes,
      mtimeNs: pin.mtimeNs,
    });
    if (bytesSha256(Buffer.from(source.data, "base64")) !== pin.sourceSha256)
      fail("selected_pin_source_mismatch");
    const value = await privateTextOperation({
      operation: "prepared-read",
      stateDir: config.stateDir,
      fileId: selection.fileId,
      versionHash: selection.versionHash,
    });
    const bytes = Buffer.from(value.data, "base64");
    if (
      bytesSha256(bytes) !== selection.sha256 ||
      value.sha256 !== selection.sha256
    )
      fail("selected_package_hash_mismatch");
    prepared = await prepareObject({
      kind: "prepared-text",
      scope: selection.profile,
      fileId: selection.fileId,
      bookId: pin.bookId,
      format: "JSON",
      bytes,
      source: pin,
    });
    // Re-read the independent selection so a changed selection cannot be uploaded.
    if (
      JSON.stringify(
        (await readPins(config.stateDir)).pins.files[selection.fileId],
      ) !== JSON.stringify(pin)
    )
      fail("selected_pin_changed");
  }
  return { root: actual, config, ...prepared };
}

/** Fixed identity + complete descriptor determine one durable reservation across restarts. */
export function selectedReservationId(identity, descriptor) {
  return "selected_" + bytesSha256(JSON.stringify({ identity, descriptor }));
}

// Immutable fsynced request intents omit URLs, keys, SQL, bodies and secrets.
// The separate private selection record retains the pinned descriptor for audit.
async function openJournal(
  root,
  stateDir,
  identity,
  descriptor,
  reservationId,
) {
  const parent = await directoryChain(
    root,
    path.join(stateDir, "selected-sync", reservationId),
    true,
  );
  const directory = path.join(parent, randomUUID());
  await fs.mkdir(directory, { mode: 0o700 });
  const parentHandle = await fs.open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
  const anchor = await fs.lstat(directory);
  let sequence = 0;
  async function write(name, value) {
    await directoryChain(root, directory);
    if (!same(anchor, await fs.lstat(directory)))
      fail("selected_journal_changed");
    const handle = await fs.open(
      path.join(directory, name),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(value) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await directoryChain(root, directory);
    const directoryHandle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (!same(anchor, await directoryHandle.stat()))
        fail("selected_journal_changed");
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
  await write("selection.json", {
    schemaVersion: 1,
    identity,
    descriptor,
    reservationId,
  });
  return {
    async before(intent) {
      if (++sequence > SELECTED_REQUEST_LIMIT) fail("selected_request_budget");
      const id = String(sequence).padStart(3, "0");
      await write(`${id}-intent.json`, {
        schemaVersion: 1,
        ...intent,
        sequence,
      });
      return id;
    },
    outcome: (id, value) => write(`${id}-outcome.json`, value),
    finish: (value) => write("result.json", value),
  };
}

/**
 * trustedOperator is a module-only provider for controlled transport/evidence tests.
 * There is deliberately no CLI/environment/file path that can select a provider.
 * The current account audit cannot supply a qualifying storage receipt, so public
 * sync remains closed before any remote I/O. Reconcile needs no new upload evidence.
 */
export async function runSelectedSync({
  action = "plan",
  profile,
  fileId,
  kind,
  versionHash,
  sha256,
  root = ROOT,
  environment = process.env,
  trustedOperator,
} = {}) {
  const selection = selectionArguments({
    action,
    profile,
    fileId,
    kind,
    versionHash,
    sha256,
  });
  if (trustedOperator !== undefined && typeof trustedOperator !== "function")
    fail("selected_invalid_arguments");
  try {
    const local = await loadSelectedLocalObject(root, environment, selection),
      d = local.descriptor;
    const summary = {
      action,
      profile,
      fileId,
      kind,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
      ...(d.versionHash ? { versionHash: d.versionHash } : {}),
    };
    if (action === "plan")
      return {
        ...summary,
        status: "planned",
        uploadAllowed: false,
        blockedBy: "qualifying_storage_receipt_unavailable",
      };
    if (action === "sync" && trustedOperator === undefined)
      fail("qualifying_storage_receipt_unavailable");
    const context = await loadMigrationContext({
      root: local.root,
      environment,
    });
    const operator = trustedOperator
      ? await trustedOperator(
          Object.freeze({
            identity: structuredClone(context.identity),
            descriptor: structuredClone(d),
            action,
          }),
        )
      : { fetchImpl: fetch };
    if (
      !operator ||
      typeof operator.fetchImpl !== "function" ||
      Object.keys(operator).some(
        (k) => !["fetchImpl", "storageReceipt"].includes(k),
      )
    )
      fail("selected_operator_invalid");
    let evidence;
    if (action === "sync") {
      const receipt = operator.storageReceipt;
      if (receipt?.uploadEligible !== true || !receipt.accountEvidence)
        fail("qualifying_storage_receipt_unavailable");
      evidence = structuredClone(receipt.accountEvidence);
      accountEvidence(evidence, context.identity.accountId);
    }
    const reservationId = selectedReservationId(context.identity, d);
    const journal = await openJournal(
      local.root,
      local.config.stateDir,
      context.identity,
      d,
      reservationId,
    );
    let pendingD1;
    const transport = async (url, options) => {
      const isD1 = new URL(url).hostname === "api.cloudflare.com";
      const id = isD1
        ? pendingD1
        : await journal.before({
            service: "r2",
            method: options.method,
            keySha256: bytesSha256(d.objectKey),
          });
      pendingD1 = undefined;
      if (!id) fail("selected_request_without_intent");
      try {
        const response = await operator.fetchImpl(url, options);
        await journal.outcome(id, {
          status: "headers-received",
          httpStatus: response?.status ?? null,
        });
        return response;
      } catch (error) {
        try {
          await journal.outcome(id, { status: "unknown" });
        } catch {}
        throw error;
      }
    };
    const authority = new RemoteStorageAuthority({
      identity: context.identity,
      credentials: context.credentials,
      resource: context.resources.profiles.production,
      fetchImpl: transport,
      requestLimit: SELECTED_REQUEST_LIMIT,
      beforeRequest: async (intent) => {
        pendingD1 = await journal.before({ service: "d1", ...intent });
      },
    });
    try {
      const inspection = await authority.inspect(context.identity);
      if (inspection.phase !== "ready") fail("storage_migration_required");
      validateMigrationReceipt(
        await authority.migrationReceipt(context.identity),
        context.identity,
        inspection,
      );
      const store = createR2ObjectStore({
        accountId: context.identity.accountId,
        bucket: context.identity.bucket,
        accessKeyId: context.fileEnvironment.SHELF_R2_ACCESS_KEY_ID,
        secretAccessKey: context.fileEnvironment.SHELF_R2_SECRET_ACCESS_KEY,
        descriptors: [d],
        fetchImpl: transport,
      });
      let result;
      if (action === "reconcile") {
        const reservation = await authority.get(
          context.identity,
          reservationId,
        );
        if (JSON.stringify(reservation.descriptor) !== JSON.stringify(d))
          fail("storage_reservation_conflict");
        result = await authority.reconcile(
          context.identity,
          reservationId,
          store,
        );
      } else
        result = await syncObject({
          authority,
          identity: context.identity,
          reservationId,
          descriptor: d,
          bytes: local.bytes,
          evidence,
          store,
        });
      const outcome = {
        ...summary,
        reservationId,
        status: result.state,
        contentVerified: result.contentVerified,
        ...(result.blockedReason ? { blockedBy: result.blockedReason } : {}),
      };
      await journal.finish(outcome);
      return outcome;
    } catch (error) {
      const code = safeCode(error);
      try {
        await journal.finish({
          action,
          reservationId,
          status: "stopped",
          code,
        });
      } catch {}
      throw new SelectedSyncError(code);
    }
  } catch (error) {
    throw new SelectedSyncError(safeCode(error));
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  (async () =>
    console.log(
      JSON.stringify(
        await runSelectedSync(parseSelectedSyncArgs(process.argv.slice(2))),
      ),
    ))().catch((error) => {
    console.error(JSON.stringify({ code: safeCode(error) }));
    process.exitCode = 1;
  });
}
