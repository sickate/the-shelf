import test from "node:test";
import assert from "node:assert/strict";
import { busyDelayMs, parseArgs, parseRetryAfter, selectBooks } from "../scripts/mvp-enrich.mjs";

test("parseRetryAfter: seconds, HTTP-date, default and clamping", () => {
  assert.equal(parseRetryAfter("30"), 30);
  assert.equal(parseRetryAfter(" 5 "), 5);
  assert.equal(parseRetryAfter(null), 10);
  assert.equal(parseRetryAfter("soon"), 10);
  assert.equal(parseRetryAfter("0"), 1);
  assert.equal(parseRetryAfter("99999"), 600);
  const now = Date.parse("2026-10-24T00:00:00Z");
  assert.equal(parseRetryAfter("Sat, 24 Oct 2026 00:00:42 GMT", now), 42);
  assert.equal(parseRetryAfter("Fri, 23 Oct 2026 00:00:00 GMT", now), 1);
});

test("busyDelayMs adds 1-5 s jitter", () => {
  assert.equal(busyDelayMs("10", () => 0), 11_000);
  assert.ok(busyDelayMs("10", () => 0.999) < 15_000);
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["--limit", "2", "--ids", "a1,b_2", "--dry-run", "--force"]), {
    limit: 2,
    ids: ["a1", "b_2"],
    dryRun: true,
    force: true,
    retryFailed: false,
  });
  assert.throws(() => parseArgs(["--limit", "-1"]));
  assert.throws(() => parseArgs(["--ids", "a/b"]));
  assert.throws(() => parseArgs(["--excerpt"]), /not supported/);
  assert.throws(() => parseArgs(["--nope"]));
});

test("selectBooks: uploaded without info, state resume, ids, force, limit", () => {
  const books = [
    { id: "a", status: "uploaded", hasInfo: false },
    { id: "b", status: "uploaded", hasInfo: true },
    { id: "c", status: "local_only", hasInfo: false },
    { id: "d", status: "uploaded", hasInfo: false },
    { id: "e", status: "uploaded", hasInfo: false },
    { id: "f", status: "uploaded", hasInfo: false },
  ];
  const state = { d: { result: "ready" }, e: { result: "failed" } };
  const ids = (o) =>
    selectBooks(books, state, { limit: Infinity, ids: null, force: false, retryFailed: false, ...o }).map((b) => b.id);
  assert.deepEqual(ids({}), ["a", "f"]);
  assert.deepEqual(ids({ retryFailed: true }), ["a", "e", "f"]);
  assert.deepEqual(ids({ ids: ["e", "b", "c"] }), ["e"]);
  assert.deepEqual(ids({ force: true }), ["a", "b", "d", "e", "f"]);
  assert.deepEqual(ids({ limit: 1 }), ["a"]);
});
