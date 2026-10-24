import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalId,
  queryId,
  bookDetailHref,
  readHref,
  apiBook,
  currentBookFile,
} from "../src/lib/book-navigation.mjs";
import { privateView, SESSION_CLEARED } from "../src/lib/private-view.mjs";
import { fetchAuthorizedFile } from "../src/lib/api-runtime.mjs";
import { readBoundedResponse } from "../src/lib/ebook/reader.mjs";
import { build } from "esbuild";

const file = {
  id: "file_new",
  format: "PDF",
  sizeBytes: 42,
  status: "candidate",
  reason: "uploaded",
  visibility: "private",
};
const book = { id: "new_book", files: [file] };
test("navigation requires unique canonical ids and preserves the configured base", () => {
  assert.equal(queryId("?id=new_book", "id"), "new_book");
  for (const search of [
    "",
    "?id=",
    "?id=a&id=a",
    "?id=../a",
    "?id=a%2Fb",
    "?id=a+",
    "?id=中文",
    "?id=" + "a".repeat(129),
  ])
    assert.equal(queryId(search, "id"), null);
  assert.equal(canonicalId("a_0-Z"), "a_0-Z");
  assert.equal(
    bookDetailHref("new_book", "/the-shelf/"),
    "/the-shelf/book/?id=new_book",
  );
  assert.equal(
    readHref("new_book", "file_new", "/the-shelf/"),
    "/the-shelf/read/?book=new_book&file=file_new",
  );
  for (const base of [
    "//evil/",
    "https://evil/",
    "/../",
    "/a?x/",
    "/a%2f/",
    "/a",
  ])
    assert.throws(() => bookDetailHref("new_book", base));
  assert.throws(() => readHref("wrong/book", "file_new"));
});
test("only the current API book's single accessible file can obtain a capability", () => {
  assert.equal(apiBook({ book }, "new_book"), book);
  assert.throws(() => apiBook({ book }, "other_book"));
  assert.equal(
    currentBookFile(book, "new_book", "file_new", "same-origin"),
    file,
  );
  for (const [info, id, mode] of [
    [book, "another", "same-origin"],
    [{ ...book, files: [file, file] }, "file_new", "same-origin"],
    [
      { ...book, files: [{ ...file, reason: "not_uploaded" }] },
      "file_new",
      "same-origin",
    ],
    [book, "file_new", "disabled"],
  ])
    assert.equal(currentBookFile(info, "new_book", id, mode), null);
  assert.equal(
    currentBookFile(
      { ...book, id: null },
      "../invalid",
      "file_new",
      "same-origin",
    ),
    null,
  );
});
test("confirmed logout/pagehide closes the view once, aborts work and prevents late responses", () => {
  const host = new EventTarget();
  let clears = 0,
    cleanups = 0;
  const view = privateView({
    window: host,
    clear() {
      clears++;
    },
  });
  view.cleanup(() => cleanups++);
  host.dispatchEvent(new Event(SESSION_CLEARED));
  host.dispatchEvent(new Event("pagehide"));
  assert.equal(view.active, false);
  assert.equal(view.signal.aborted, true);
  assert.equal(clears, 1);
  assert.equal(cleanups, 1);
  assert.throws(() => view.assert(), { code: "view_closed" });
  view.cleanup(() => cleanups++);
  assert.equal(cleanups, 2);
});
test("a late access response after logout cannot start a content request", async () => {
  let alive = true,
    contents = 0;
  await assert.rejects(
    fetchAuthorizedFile("file_new", {
      api: async () => {
        alive = false;
        return { url: "/content", format: "PDF" };
      },
      resolveUrl: (url) => url,
      guard() {
        if (!alive) throw Error("closed");
      },
      fetcher: async () => {
        contents++;
        return new Response("bytes");
      },
    }),
    /closed/,
  );
  assert.equal(contents, 0);
});
test("a late content response is cancelled and never passed to the view", async () => {
  let alive = true,
    cancelled = 0;
  await assert.rejects(
    fetchAuthorizedFile("file_new", {
      api: async () => ({ url: "/content", format: "PDF" }),
      resolveUrl: (url) => url,
      guard() {
        if (!alive) throw Error("closed");
      },
      fetcher: async () => {
        alive = false;
        return {
          status: 200,
          ok: true,
          body: {
            cancel() {
              cancelled++;
            },
          },
        };
      },
    }),
    /closed/,
  );
  assert.equal(cancelled, 1);
});

test("resuming a previously authenticated view checks only session and clears confirmed expiry", async () => {
  const host = new EventTarget();
  let calls = 0,
    clears = 0;
  const view = privateView({
    window: host,
    checkSession: async () => {
      calls++;
      return { authenticated: false };
    },
    clear() {
      clears++;
    },
  });
  host.dispatchEvent(new Event("pageshow"));
  assert.equal(calls, 0, "anonymous/public resume must not clear the page");
  view.setAuthenticated(true);
  host.dispatchEvent(new Event("pageshow"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(clears, 1);
  assert.equal(view.active, false);
});
test("visibility resume unknown is retained and obsolete checks cannot close a newer session state", async () => {
  const host = new EventTarget(),
    doc = new EventTarget();
  doc.visibilityState = "visible";
  let resolve;
  let calls = 0;
  const view = privateView({
    window: host,
    document: doc,
    checkSession: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  view.setAuthenticated(true);
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 1);
  view.setAuthenticated(true);
  resolve({ authenticated: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(view.active, true);
  view.close();
});

test("visibility resume clears a confirmed 401, retains unknown failures, and removes listeners", async () => {
  const host = new EventTarget(),
    doc = new EventTarget();
  doc.visibilityState = "hidden";
  let calls = 0,
    status = 503;
  const view = privateView({
    window: host,
    document: doc,
    checkSession: async () => {
      calls++;
      throw Object.assign(new Error("unavailable"), { status });
    },
  });
  view.setAuthenticated(true);
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 0);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.active, true);
  status = 401;
  doc.dispatchEvent(new Event("visibilitychange"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.active, false);
  assert.equal(calls, 2);
  host.dispatchEvent(new Event("pageshow"));
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 2);
});

test("closing the view aborts a stalled stream and the file fetch receives the same signal", async () => {
  const host = new EventTarget();
  const view = privateView({ window: host });
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const read = readBoundedResponse(response, { signal: view.signal });
  view.close();
  await assert.rejects(read, /页面已关闭/);
  assert.equal(cancelled, true);
  const controller = new AbortController();
  await fetchAuthorizedFile("file_new", {
    api: async () => ({ url: "/content", format: "PDF" }),
    resolveUrl: (url) => url,
    signal: controller.signal,
    fetcher: async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      return new Response("pdf");
    },
  });
});

test("the actual API client preserves anonymous public pages on 401 and clears confirmed private expiry", async () => {
  const compiled = await build({
    entryPoints: [new URL("../src/lib/api.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    define: {
      "import.meta.env.PUBLIC_SHELF_API_MODE": '"same-origin"',
      "import.meta.env.PUBLIC_SHELF_API_URL": '""',
    },
  });
  const originals = Object.fromEntries(
    ["window", "location", "fetch", "BroadcastChannel"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const host = new EventTarget();
  let clears = 0,
    authenticated = false;
  host.addEventListener(SESSION_CLEARED, () => clears++);
  try {
    Object.assign(globalThis, {
      window: host,
      location: { hostname: "localhost", origin: "http://localhost" },
      BroadcastChannel: class extends EventTarget {
        postMessage() {}
      },
      fetch: async (url) =>
        url.endsWith("/api/session")
          ? Response.json({
              authenticated,
              csrfToken: authenticated ? "synthetic-token" : null,
            })
          : url.endsWith("/api/files/file_new/access")
            ? Response.json({ url: "/synthetic-content", format: "PDF" })
            : url.endsWith("/api/logout")
              ? Response.json({ authenticated: false })
              : new Response('{"error":"authentication_required"}', {
                  status: 401,
                }),
    });
    const client = await import(
      `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
    );
    await client.session();
    await assert.rejects(client.api("/api/books/public/published"), {
      status: 401,
    });
    assert.equal(clears, 0);
    authenticated = true;
    await client.session();
    assert.equal(client.csrfToken, "synthetic-token");
    await assert.rejects(client.api("/api/books/private/history"), {
      status: 401,
    });
    assert.equal(clears, 1);
    assert.equal(client.csrfToken, null);
    await assert.rejects(client.api("/api/books/public/published"), {
      status: 401,
    });
    assert.equal(
      clears,
      1,
      "anonymous 401 must not repeat private invalidation",
    );
    await client.session();
    authenticated = false;
    await client.session();
    assert.equal(clears, 2);
    authenticated = true;
    await client.session();
    await assert.rejects(client.fetchFile("file_new"), { status: 401 });
    assert.equal(
      clears,
      3,
      "content 401 also invalidates a known private view",
    );
    assert.equal(client.csrfToken, null);
    await client.api("/api/logout", {});
    assert.equal(clears, 4);
  } finally {
    for (const [key, descriptor] of Object.entries(originals))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  }
});
