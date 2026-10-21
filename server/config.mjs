import path from "node:path";
export const THRESHOLD = 20_000_000;
export function getConfig(env = process.env, cwd = process.cwd()) {
  const n = (key, fallback, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  return {
    host: env.SHELF_HOST || "127.0.0.1",
    port: n("SHELF_PORT", 8787, 65535),
    catalogPath: path.resolve(
      cwd,
      env.SHELF_CATALOG_PATH || "data/catalog.json",
    ),
    manifestPath: path.resolve(
      cwd,
      env.SHELF_MANIFEST_PATH || ".local/manifest.json",
    ),
    stateDir: path.resolve(cwd, env.SHELF_STATE_DIR || ".local"),
    password: env.SHELF_OWNER_PASSWORD || "",
    origins: (
      env.SHELF_ALLOWED_ORIGINS || "http://127.0.0.1:4321,http://localhost:4321"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    secureCookie: env.SHELF_COOKIE_SECURE === "true",
    localFilesEnabled: env.SHELF_LOCAL_FILES_ENABLED === "true",
    aiBase: env.SHELF_OAI_BASE_URL || "",
    aiKey: env.SHELF_OAI_KEY || "",
    dailyCalls: n("SHELF_AI_DAILY_CALL_LIMIT", 20, 1000),
    jobCalls: n("SHELF_AI_JOB_CALL_LIMIT", 12, 100),
    queueLimit: n("SHELF_QUEUE_LIMIT", 30, 1000),
    aiTimeout: n("SHELF_AI_TIMEOUT_MS", 900000, 900000),
    r2Account: env.SHELF_R2_ACCOUNT_ID || "",
    r2Bucket: env.SHELF_R2_BUCKET || "",
    r2AccessKey: env.SHELF_R2_ACCESS_KEY_ID || "",
    r2Secret: env.SHELF_R2_SECRET_ACCESS_KEY || "",
    r2DailyAccess: n("SHELF_R2_DAILY_ACCESS", 1000, 100000),
    r2Budget: n("SHELF_STORAGE_BUDGET_BYTES", 8_000_000_000, 8_000_000_000),
    r2ExistingBytes: Number(env.SHELF_R2_EXISTING_BYTES || 0),
  };
}
export const aiConfigured = (c) => Boolean(c.aiBase && c.aiKey);
export const r2Configured = (c) =>
  Boolean(c.r2Account && c.r2Bucket && c.r2AccessKey && c.r2Secret);
