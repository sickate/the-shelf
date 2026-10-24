/** Public, cloud-independent frozen 010 definitions; importing performs no private IO. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
export const PREPARED_SCHEMA_SHA256 =
  "b70ad99611023bde6aa08901cd8eeebbdeeae0cd38e96f0ea8dec93e566afd0f";
const source = readFileSync(
  new URL(
    "../cloudflare/library/migrations/010-prepared-index.sql",
    import.meta.url,
  ),
  "utf8",
);
if (
  createHash("sha256").update(source).digest("hex") !== PREPARED_SCHEMA_SHA256
)
  throw new Error("prepared_schema_source_changed");
const db = new DatabaseSync(":memory:");
let definitions;
try {
  db.exec(source);
  definitions = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY rowid",
    )
    .all();
  if (
    definitions.length !== 13 ||
    definitions.filter((v) => v.type === "table").length !== 3 ||
    definitions.filter((v) => v.type === "trigger").length !== 9 ||
    definitions.filter((v) => v.type === "view").length !== 1
  )
    throw new Error("prepared_schema_invalid");
} finally {
  db.close();
}
export const PREPARED_SCHEMA_DEFINITIONS = Object.freeze(
  definitions.map((v) => Object.freeze({ ...v })),
);
