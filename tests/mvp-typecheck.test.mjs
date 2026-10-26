import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("frontend type checks cleanly", () => {
  const r = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "app/tsconfig.json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
