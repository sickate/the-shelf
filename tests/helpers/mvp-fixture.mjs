import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../../app/worker.mjs";

// workerd (miniflare) needs macOS 13.5+, so the MVP tests run the Worker module in Node
// against small faithful fakes: D1 on node:sqlite, R2 on an in-memory Map.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const ORIGIN = "https://shelf.test";
export const OWNER_EMAIL = "owner@example.com";
export const sha = (b) => createHash("sha256").update(b).digest("hex");

export function fakeD1(sqlite) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...next) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  // D1 batch: one transaction; each result is {results, meta} like the real binding.
  const batch = async (statements) => {
    sqlite.exec("BEGIN");
    try {
      const out = statements.map(({ sql, args }) => {
        const st = sqlite.prepare(sql);
        if (st.columns().length) return { results: st.all(...args), meta: { changes: 0 } };
        return { results: [], meta: { changes: Number(st.run(...args).changes) } };
      });
      sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };
  return { prepare: (sql) => statement(sql), batch };
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

/** `shelf_session=<expiry>.<b64url email>.<sig>` as the Worker's Google sign-in issues it. */
export function googleCookie(secret, email = OWNER_EMAIL, expiry = Math.floor(Date.now() / 1000) + 3600) {
  const hmac = (data) => createHmac("sha256", secret).update(data).digest("base64url");
  const sig = hmac(`owner:${expiry}:${hmac(`email:${email}`).slice(0, 22)}`);
  return `shelf_session=${expiry}.${Buffer.from(email).toString("base64url")}.${sig}`;
}

export async function setup(t, secrets = { SESSION_SECRET: "s".repeat(32) }) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(await readFile(`${ROOT}app/schema.sql`, "utf8"));
  const db = fakeD1(sqlite);
  const bucket = fakeR2();
  const env = { OWNER_EMAILS: OWNER_EMAIL, ...secrets, DB: db, BOOKS: bucket, ASSETS: { fetch: async () => new Response("static asset") } };
  const fetch = (path, init = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  // Mints a Google-format session cookie directly (no OAuth round trip).
  const login = async (email = OWNER_EMAIL) => googleCookie(env.SESSION_SECRET, email);
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
