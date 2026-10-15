import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw =
  process.env.SHELF_CF_SITE_URL || "https://the-shelf.iamzhutuo.workers.dev";
let site;
try {
  site = new URL(raw);
} catch {
  throw new Error("SHELF_CF_SITE_URL must be an HTTPS origin");
}
if (
  site.protocol !== "https:" ||
  site.username ||
  site.password ||
  site.pathname !== "/" ||
  site.search ||
  site.hash
) {
  throw new Error(
    "SHELF_CF_SITE_URL must be a plain HTTPS origin without credentials, path, query, or fragment",
  );
}

const apiMode = process.env.SHELF_CF_API_MODE || "disabled";
if (!["disabled", "same-origin"].includes(apiMode))
  throw new Error("SHELF_CF_API_MODE must be disabled or same-origin");
if (
  apiMode === "same-origin" &&
  site.origin !== "https://the-shelf.iamzhutuo.workers.dev"
)
  throw new Error("Same-origin API builds require the production Shelf origin");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    SHELF_SITE_URL: site.origin,
    SHELF_BASE_PATH: "/",
    PUBLIC_SHELF_API_URL: "",
    PUBLIC_SHELF_API_MODE: apiMode,
    ASTRO_TELEMETRY_DISABLED: "1",
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

if (result.status === 0) {
  await fs.mkdir(path.join(root, "dist/data"), { recursive: true });
  await fs.writeFile(
    path.join(root, "dist/data/runtime.json"),
    JSON.stringify({ schemaVersion: 1, apiMode }) + "\n",
  );
}
