import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../../app/worker.mjs";

// workerd (miniflare) needs macOS 13.5+, so the MVP tests run the Worker module in Node
// against small faithful fakes: D1 on node:sqlite, R2 on an in-memory Map.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ORIGIN = "https://shelf.test";
export const PASSWORD = "correct horse battery staple";
export const sha = (b) => createHash("sha256").update(b).digest("hex");

export function fakeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => statement(sql) };
}

export function fakeR2() {
  const objects = new Map();
  return {
    objects,
    failPuts: false,
    puts: 0,
    async put(key, value, options = {}) {
      this.puts++;
      if (this.failPuts) throw new Error("network");
      const bytes = new Uint8Array(value);
      if (options.sha256 && sha(bytes) !== options.sha256) throw new Error("sha256 mismatch");
      objects.set(key, { bytes, httpMetadata: options.httpMetadata ?? {} });
      return { key, size: bytes.byteLength };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { key, size: o.bytes.byteLength, httpMetadata: o.httpMetadata } : null;
    },
    async get(key, options = {}) {
      const o = objects.get(key);
      if (!o) return null;
      const { offset = 0, length = o.bytes.byteLength - offset } = options.range ?? {};
      return {
        size: o.bytes.byteLength,
        httpMetadata: o.httpMetadata,
        body: new Blob([o.bytes.slice(offset, offset + length)]).stream(),
      };
    },
  };
}

export async function setup(t, secrets = { OWNER_PASSWORD: PASSWORD, SESSION_SECRET: "s".repeat(32) }) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(await readFile(`${ROOT}app/schema.sql`, "utf8"));
  const db = fakeD1(sqlite);
  const bucket = fakeR2();
  const env = { ...secrets, DB: db, BOOKS: bucket, ASSETS: { fetch: async () => new Response("static asset") } };
  const fetch = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  const login = async () => {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    return res.headers.get("Set-Cookie").split(";")[0];
  };
  const upload = (cookie, path, bytes, hash = sha(bytes), extra = {}) =>
    fetch("/api/upload", {
      method: "PUT",
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        "X-Shelf-Path": encodeURIComponent(path),
        "X-Shelf-Sha256": hash,
        ...extra,
      },
      body: bytes,
    });
  return { sqlite, db, bucket, env, fetch, login, upload };
}
