import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const forbiddenFields = new Set([
  "path",
  "root",
  "sourcePath",
  "textPath",
  "storageKey",
  "mtimeNs",
  "aiKey",
  "password",
]);
const issues = [];
function check(value, context) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenFields.has(key))
      issues.push(`${context}: private field ${key}`);
    check(child, `${context}.${key}`);
  }
}
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, "data/catalog.json"), "utf8"),
);
check(catalog, "catalog");
const expected = catalog.books.length;
const manifestPath = path.join(root, ".local/manifest.json");
const privateRoot = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).root
  : null;
const secretValues = [
  "SHELF_OAI_KEY",
  "SHELF_R2_ACCESS_KEY_ID",
  "SHELF_R2_SECRET_ACCESS_KEY",
  "SHELF_OWNER_PASSWORD",
]
  .map((k) => process.env[k])
  .filter((v) => v && v.length >= 8);
let count = 0,
  bytes = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push("public output contains a symlink");
      continue;
    }
    if (entry.isDirectory()) {
      if ([".local", ".git", "server"].includes(entry.name))
        issues.push(`private directory ${entry.name}`);
      walk(file);
      continue;
    }
    count++;
    bytes += fs.statSync(file).size;
    if (/\.(pdf|epub|mobi|azw|azw3|azw4|sqlite|db)$/i.test(entry.name))
      issues.push("public output contains a private ebook or database");
    if (/\.(html|json|js|mjs|md|txt|css)$/i.test(entry.name)) {
      const text = fs.readFileSync(file, "utf8");
      if (privateRoot && text.includes(privateRoot))
        issues.push("public output contains the source root");
      if (
        /(?:\/Users\/[^/\s"'<>]+\/|\/Volumes\/[^/\s"'<>]+\/|\/home\/[^/\s"'<>]+\/)/.test(
          text,
        )
      )
        issues.push("public output contains a private absolute path");
      if (secretValues.some((v) => text.includes(v)))
        issues.push("public output contains a configured secret");
    }
  }
}
for (const name of ["public", "dist"])
  if (fs.existsSync(path.join(root, name))) walk(path.join(root, name));
if (fs.existsSync(path.join(root, "dist/books"))) {
  const actual = fs
    .readdirSync(path.join(root, "dist/books"), { withFileTypes: true })
    .filter((d) => d.isDirectory()).length;
  if (actual !== expected)
    issues.push(`expected ${expected} book pages, got ${actual}`);
}
if (issues.length) {
  console.error([...new Set(issues)].join("\n"));
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      ok: true,
      bookRecords: expected,
      inspectedFiles: count,
      publicBytes: bytes,
    }),
  );
