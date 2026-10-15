import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = process.env.SHELF_CF_SITE_URL || "https://the-shelf.iamzhutuo.workers.dev";
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
  throw new Error("SHELF_CF_SITE_URL must be a plain HTTPS origin without credentials, path, query, or fragment");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    SHELF_SITE_URL: site.origin,
    SHELF_BASE_PATH: "/",
    PUBLIC_SHELF_API_URL: "",
    ASTRO_TELEMETRY_DISABLED: "1",
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
