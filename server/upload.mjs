// Explicit selected-file upload only. Dry run is the default; never scans a collection.
import { promises as fs } from "node:fs";
import path from "node:path";
import { getConfig, r2Configured } from "./config.mjs";
import { loadJson, validateFile, presign, ApiError } from "./storage.mjs";
export async function uploadSelected(
  config,
  ids,
  { execute = false, fetchImpl = fetch } = {},
) {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
    throw new ApiError("select_1_to_100_unique_file_ids");
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await fs.open(
      path.join(config.stateDir, "upload.lock"),
      "wx",
      0o600,
    );
  } catch {
    throw new ApiError("upload_locked", 409);
  }
  try {
    const manifest = await loadJson(config.manifestPath, { files: {} }),
      selected = [];
    for (const id of ids) {
      if (!/^[\w-]+$/.test(id)) throw new ApiError("invalid_file_id");
      const f = await validateFile(manifest, id);
      if (f.entry.storageKey) throw new ApiError("already_uploaded");
      selected.push({
        id,
        ...f,
        key: `books/${id}.${f.entry.format.toLowerCase()}`,
      });
    }
    const reservationPath = path.join(
      config.stateDir,
      "upload-reservations.json",
    );
    const reservations = await loadJson(reservationPath, {});
    if (ids.some((id) => reservations[id]))
      throw new ApiError("upload_pending_confirmation", 409);
    const reservedBytes = Object.entries(reservations)
      .filter(([id]) => !manifest.files[id]?.storageKey)
      .reduce((n, [, r]) => n + r.sizeBytes, 0);
    const registered = Object.values(manifest.files)
        .filter((f) => f.storageKey)
        .reduce((n, f) => n + f.sizeBytes, 0),
      bytes = selected.reduce((n, f) => n + f.entry.sizeBytes, 0);
    if (
      !Number.isSafeInteger(config.r2ExistingBytes) ||
      config.r2ExistingBytes < 0 ||
      registered + reservedBytes + config.r2ExistingBytes + bytes >
        config.r2Budget
    )
      throw new ApiError("storage_budget_exceeded", 409);
    const plan = {
      dryRun: !execute,
      selectedFiles: ids,
      bytes,
      registeredBytes: registered,
      reservedBytes,
      otherExistingBytes: config.r2ExistingBytes,
      budgetBytes: config.r2Budget,
    };
    if (!execute) return plan;
    if (!r2Configured(config)) throw new ApiError("r2_unconfigured", 503);
    for (const f of selected)
      reservations[f.id] = {
        sizeBytes: f.entry.sizeBytes,
        key: f.key,
        createdAt: new Date().toISOString(),
      };
    await fs.writeFile(reservationPath, JSON.stringify(reservations), {
      mode: 0o600,
    });
    for (const f of selected) {
      await validateFile(manifest, f.id);
      const data = await fs.readFile(f.real);
      await validateFile(manifest, f.id);
      const response = await fetchImpl(presign(config, f.key, "PUT"), {
        method: "PUT",
        body: data,
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new ApiError("upload_failed", 502);
      f.entry.storageKey = f.key;
      const temp = config.manifestPath + ".upload.tmp";
      await fs.writeFile(temp, JSON.stringify(manifest, null, 2) + "\n", {
        mode: 0o600,
      });
      await fs.rename(temp, config.manifestPath);
      delete reservations[f.id];
      await fs.writeFile(reservationPath, JSON.stringify(reservations), {
        mode: 0o600,
      });
    }
    return plan;
  } finally {
    await lock.close();
    await fs.unlink(path.join(config.stateDir, "upload.lock"));
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  const args = process.argv.slice(2),
    execute = args.includes("--execute");
  if (args.some((x) => x.startsWith("--") && x !== "--execute"))
    throw new ApiError("unknown_option");
  try {
    console.log(
      JSON.stringify(
        await uploadSelected(
          getConfig(),
          args.filter((x) => x !== "--execute"),
          { execute },
        ),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e.code || "upload_failed");
    process.exitCode = 1;
  }
}
