import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateDirectory, privateFile, regularFile } from "./cf-deploy.mjs";
import { PROFILES, ApiDeployError } from "./cf-api-deploy.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const names = ["owner-access-key", "owner-key-pepper", "session-secret"];
const canonical = (value) =>
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, "base64url").length === 32 &&
  Buffer.from(value, "base64url").toString("base64url") === value;
export async function initialize({
  root = ROOT,
  profile,
  verifierFactory,
  now = Date.now,
} = {}) {
  if (!PROFILES[profile]) throw new ApiDeployError("target");
  root = await fs.realpath(root);
  const ignored = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  if (!ignored.split(/\r?\n/).some((line) => line.trim() === ".local/"))
    throw new ApiDeployError("files");
  for (const relative of [".local", ".local/cf03", `.local/cf03/${profile}`])
    await privateDirectory(path.join(root, relative));
  const directory = path.join(root, ".local/cf03", profile),
    values = [];
  for (const name of names) {
    const filename = path.join(directory, name);
    try {
      const stat = await regularFile(filename);
      if ((stat.mode & 0o777) !== 0o600 || stat.size > 100)
        throw new ApiDeployError("files");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await privateFile(filename, randomBytes(32).toString("base64url") + "\n");
    }
    const value = (await fs.readFile(filename, "utf8")).trim();
    if (!canonical(value)) throw new ApiDeployError("files");
    values.push(value);
  }
  if (new Set(values).size !== 3) throw new ApiDeployError("secrets");
  const policy = PROFILES[profile];
  const factory =
    verifierFactory ||
    (await import("../cloudflare/library/security.mjs")).createOwnerVerifier;
  const verifier = await factory(values[0], values[1], {
    scope: policy.scope,
    origin: policy.origin,
  });
  if (!/^[a-f0-9]{64}$/.test(verifier)) throw new ApiDeployError("secrets");
  const sql = `-- Apply schema.sql first. An existing owner row MUST fail; never reset generation.\nINSERT INTO auth_config(scope,origin,scheme,verifier,generation,enabled,updated_at) VALUES ('${policy.scope}','${policy.origin}','owner-access-key-v1','${verifier}',1,1,${now()});\n`;
  // Keep initial SQL immutable; a repeated invocation validates existing content and never rotates credentials.
  const sqlPath = path.join(directory, "auth-init.sql");
  try {
    const stat = await regularFile(sqlPath);
    if ((stat.mode & 0o777) !== 0o600 || stat.size > 4096)
      throw new ApiDeployError("files");
    const existing = await fs.readFile(sqlPath, "utf8");
    const normalizeTimestamp = (value) =>
      value.replace(/,\d+\);\n$/, ",TIMESTAMP);\n");
    if (normalizeTimestamp(existing) !== normalizeTimestamp(sql))
      throw new ApiDeployError("secrets");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await privateFile(sqlPath, sql);
  }
  return {
    ok: true,
    profile,
    ownerKeyPath: path.relative(root, path.join(directory, names[0])),
    sqlPath: path.relative(root, sqlPath),
  };
}
export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 2 || argv[0] !== "--profile")
      throw new ApiDeployError("target");
    const result = await initialize({ profile: argv[1] });
    console.log(
      `Private owner credentials prepared: .local/cf03/${result.profile}/\nOwner key file: ${result.ownerKeyPath}\nInitial SQL: ${result.sqlPath}\nNo Cloudflare resources or secrets were changed.`,
    );
  } catch {
    console.error(
      "Cloudflare owner initialization stopped safely; existing credentials were retained.",
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
