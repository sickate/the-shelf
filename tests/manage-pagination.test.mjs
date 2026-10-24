// Executes the production TypeScript controller with synthetic DOM/API surfaces.
// Network/browser rendering and actual owner data are deliberately unnecessary.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
const bundled = await build({
  entryPoints: ["src/scripts/manage.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ManageFixture",
  define: { "import.meta.env.BASE_URL": '"/"' },
  plugins: [
    {
      name: "synthetic-management-api",
      setup(b) {
        b.onResolve({ filter: /\/lib\/api$/ }, () => ({
          path: "api",
          namespace: "synthetic",
        }));
        b.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({
          contents:
            "export const api=(...a)=>globalThis.__manageApi(...a);export const apiBinary=api;export const errorText=e=>e.message;",
        }));
      },
    },
  ],
});
class Element extends EventTarget {
  constructor(tag = "div") {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.value = "";
    this.files = [];
    this.disabled = false;
    this.hidden = false;
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.textContent = "";
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [...children];
    this.textContent = "";
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  get childElementCount() {
    return this.children.length;
  }
  get text() {
    return (
      this.textContent +
      this.children.map((c) => (typeof c === "string" ? c : c.text)).join("")
    );
  }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};
function fixture(api) {
  const elements = new Map(),
    host = new EventTarget();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const doc = new EventTarget();
  Object.assign(doc, {
    getElementById: get,
    createElement: (tag) => new Element(tag),
    visibilityState: "visible",
  });
  const calls = [];
  const context = {
    window: host,
    document: doc,
    Event,
    AbortController,
    URL,
    console,
    setTimeout,
    clearTimeout,
    __manageApi: (route, ...args) => {
      calls.push(route);
      return api(route, ...args);
    },
  };
  vm.createContext(context);
  vm.runInContext(bundled.outputFiles[0].text, context);
  context.ManageFixture.initManage();
  return { get, host, calls };
}
const entry = (id) => ({
  book: { id, title: id, author: null, category: "synthetic", files: [] },
  metadataVersion: 0,
  trashed: false,
  managementVersion: 1,
});
const page = (id, next = null) => ({
  books: [entry(id)],
  pagination: {
    mode: "keyset-v1",
    pageSize: 100,
    returned: 1,
    nextCursor: next,
  },
  upload: { enabled: false },
  identify: { enabled: false },
});
const click = (f, id) => f.get(id).dispatchEvent(new Event("click"));
test("management fetches one page per user click and refreshes the selected cursor", async () => {
  const f = fixture(async (route) =>
    route === "/api/session"
      ? { authenticated: true }
      : route === "/api/manage"
        ? page("book_a", "book_a")
        : page("book_b"),
  );
  await flush();
  assert.deepEqual(f.calls, ["/api/session", "/api/manage"]);
  assert.equal(f.get("manage-pagination").hidden, false);
  assert.equal(f.get("books-count").textContent, "本页 1 本");
  assert.match(f.get("books-list").text, /book_a/);
  click(f, "manage-next");
  await flush();
  assert.equal(f.calls.at(-1), "/api/manage?cursor=book_a");
  assert.match(f.get("books-list").text, /book_b/);
  assert.equal(f.get("manage-next").disabled, true);
  assert.equal(f.get("manage-previous").disabled, false);
  click(f, "manage-reload");
  await flush();
  assert.equal(f.calls.at(-1), "/api/manage?cursor=book_a");
  click(f, "manage-previous");
  await flush();
  assert.equal(f.calls.at(-1), "/api/manage");
  assert.match(f.get("books-list").text, /book_a/);
  assert.equal(f.get("manage-previous").disabled, true);
  assert.equal(f.calls.length, 5);
});
test("legacy unpaginated management retains its complete response and hides controls", async () => {
  const f = fixture(async (route) =>
    route === "/api/session"
      ? { authenticated: true }
      : { books: [entry("book_old")], upload: {}, identify: {} },
  );
  await flush();
  assert.equal(f.get("manage-pagination").hidden, true);
  assert.equal(f.get("books-count").textContent, "1 本");
  assert.match(f.get("books-list").text, /book_old/);
  assert.equal(f.calls.length, 2);
});
for (const event of ["shelf:session-cleared", "pagehide"])
  test(`${event} clears private DOM and rejects late next-page response`, async () => {
    const pending = deferred();
    const f = fixture(async (route) =>
      route === "/api/session"
        ? { authenticated: true }
        : route === "/api/manage"
          ? page("book_private", "book_private")
          : pending.promise,
    );
    await flush();
    click(f, "manage-next");
    await flush();
    f.host.dispatchEvent(new Event(event));
    assert.equal(f.get("books-list").children.length, 0);
    assert.equal(f.get("trash-list").children.length, 0);
    assert.equal(f.get("manage-pagination").hidden, true);
    assert.equal(f.get("books-count").textContent, "—");
    pending.resolve(page("book_secret_late"));
    await flush();
    assert.equal(f.get("books-list").children.length, 0);
    assert.equal(f.get("upload-submit").disabled, true);
    assert.equal(f.get("manage-next").disabled, true);
  });
test("late session success after pagehide cannot authenticate or fetch private pages", async () => {
  const pending = deferred(),
    f = fixture(() => pending.promise);
  f.host.dispatchEvent(new Event("pagehide"));
  pending.resolve({ authenticated: true });
  await flush();
  assert.deepEqual(f.calls, ["/api/session"]);
  assert.equal(f.get("books-list").children.length, 0);
});
test("later generation wins when page responses return out of order", async () => {
  const first = deferred(),
    second = deferred();
  let requests = 0;
  const f = fixture(async (route) =>
    route === "/api/session"
      ? { authenticated: true }
      : ++requests === 1
        ? page("book_initial")
        : requests === 2
          ? first.promise
          : second.promise,
  );
  await flush();
  click(f, "manage-reload");
  click(f, "manage-reload");
  second.resolve(page("book_new"));
  await flush();
  first.resolve(page("book_obsolete"));
  await flush();
  assert.match(f.get("books-list").text, /book_new/);
  assert.doesNotMatch(f.get("books-list").text, /book_obsolete/);
});
test("late rejected generation cannot overwrite the newer page status", async () => {
  const first = deferred(),
    second = deferred();
  let requests = 0;
  const f = fixture(async (route) =>
    route === "/api/session"
      ? { authenticated: true }
      : ++requests === 1
        ? page("book_initial")
        : requests === 2
          ? first.promise
          : second.promise,
  );
  await flush();
  click(f, "manage-reload");
  click(f, "manage-reload");
  second.resolve(page("book_new"));
  await flush();
  const text = f.get("books-status").textContent;
  first.reject(Error("old failure"));
  await flush();
  assert.equal(f.get("books-status").textContent, text);
  assert.match(f.get("books-list").text, /book_new/);
});
