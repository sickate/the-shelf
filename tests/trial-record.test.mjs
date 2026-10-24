import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeTrialRecord } from "../cloudflare/library/trial-record.mjs";
import { decodeTrialRow } from "../cloudflare/library/single-trial.mjs";

const accountId = "a".repeat(32),
  targetSha256 = "b".repeat(64);
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
const descriptor = {
  kind: "original",
  scope: "production",
  fileId: "trial_file",
  bookId: "trial_book",
  format: "PDF",
  sizeBytes: 15,
  sha256: "c".repeat(64),
  objectKey: `books/cf03/trial_file/${"c".repeat(64)}.pdf`,
  versionHash: null,
  source: null,
};
function row() {
  return {
    id: 1,
    permit_id: "synthetic_permit",
    consent_id: "2026-10-23-first-book",
    authority_identity_json: JSON.stringify(identity),
    target_json: JSON.stringify({
      accountId,
      bucket: "the-shelf-first-book-20261023",
    }),
    descriptor_json: JSON.stringify(descriptor),
    isolated_target_config_sha256: targetSha256,
    size_bytes: 15,
    issued_at: 1000,
    expires_at: 2000,
    state: "confirmed",
    put_attempted: 1,
    content_verified: 1,
    etag: "synthetic_etag",
    updated_at: 3000,
  };
}
const target = { accountId, targetSha256 };
const reject = (callback) =>
  assert.throws(callback, { code: "file_unavailable", status: 409 });

test("pure confirmed trial decoder accepts an expired historical permit and snapshots its record", () => {
  const input = row(),
    decoded = decodeTrialRecord(input, target);
  assert.equal(decoded.row.expires_at, 2000);
  assert.deepEqual(decoded.descriptor, descriptor);
  assert.deepEqual(decoded.authority, identity);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.row));
  assert.ok(Object.isFrozen(decoded.authority.legacyDatabases));
  input.etag = "changed";
  assert.equal(decoded.row.etag, "synthetic_etag");
});
for (const [label, change] of [
  ["id", (v) => (v.id = 2)],
  ["consent", (v) => (v.consent_id = "another_consent")],
  ["permit", (v) => (v.permit_id = 12)],
  [
    "target account",
    (v) =>
      (v.target_json = JSON.stringify({
        accountId: "d".repeat(32),
        bucket: "the-shelf-first-book-20261023",
      })),
  ],
  [
    "target bucket",
    (v) =>
      (v.target_json = JSON.stringify({
        accountId,
        bucket: "the-shelf-books",
      })),
  ],
  [
    "target extra",
    (v) =>
      (v.target_json = JSON.stringify({
        accountId,
        bucket: "the-shelf-first-book-20261023",
        extra: true,
      })),
  ],
  ["target hash", (v) => (v.isolated_target_config_sha256 = "d".repeat(64))],
  [
    "authority UUID",
    (v) => {
      const a = structuredClone(identity);
      a.legacyDatabases.production = a.legacyDatabases.check;
      v.authority_identity_json = JSON.stringify(a);
    },
  ],
  [
    "authority extra",
    (v) =>
      (v.authority_identity_json = JSON.stringify({
        ...identity,
        extra: true,
      })),
  ],
  [
    "authority account",
    (v) =>
      (v.authority_identity_json = JSON.stringify({
        ...identity,
        accountId: "d".repeat(32),
      })),
  ],
  [
    "authority bucket",
    (v) =>
      (v.authority_identity_json = JSON.stringify({
        ...identity,
        bucket: "other",
      })),
  ],
  [
    "descriptor extra",
    (v) => (v.descriptor_json = JSON.stringify({ ...descriptor, extra: true })),
  ],
  [
    "descriptor object key",
    (v) =>
      (v.descriptor_json = JSON.stringify({
        ...descriptor,
        objectKey: "books/other",
      })),
  ],
  [
    "descriptor kind",
    (v) =>
      (v.descriptor_json = JSON.stringify({
        ...descriptor,
        kind: "prepared-text",
      })),
  ],
  [
    "descriptor source",
    (v) => (v.descriptor_json = JSON.stringify({ ...descriptor, source: {} })),
  ],
  [
    "descriptor numeric ID",
    (v) => (v.descriptor_json = JSON.stringify({ ...descriptor, fileId: 12 })),
  ],
  ["size", (v) => (v.size_bytes = 16)],
  ["zero size", (v) => (v.size_bytes = 0)],
  ["flags", (v) => (v.put_attempted = 0)],
  ["verification", (v) => (v.content_verified = 0)],
  ["state", (v) => (v.state = "uncertain")],
  ["etag", (v) => (v.etag = 'W/"etag"')],
  ["issued timestamp", (v) => (v.issued_at = -1)],
  ["expiry", (v) => (v.expires_at = v.issued_at)],
  ["lifetime", (v) => (v.expires_at = v.issued_at + 86400001)],
  ["updated timestamp", (v) => (v.updated_at = v.issued_at - 1)],
  ["JSON", (v) => (v.descriptor_json = "{")],
])
  test(`confirmed historical trial rejects ${label}`, () => {
    const input = row();
    change(input);
    reject(() => decodeTrialRecord(input, target));
  });

test("trial remains PDF/EPUB only, independently of normal Kindle support", () => {
  for (const format of ["PDF", "EPUB", "MOBI", "AZW", "AZW3"]) {
    const input = row();
    input.descriptor_json = JSON.stringify({
      ...descriptor,
      format,
      objectKey: `books/cf03/${descriptor.fileId}/${descriptor.sha256}.${format.toLowerCase()}`,
    });
    if (["PDF", "EPUB"].includes(format))
      assert.equal(decodeTrialRecord(input, target).descriptor.format, format);
    else reject(() => decodeTrialRecord(input, target));
  }
});
test("legacy decoder delegates while retaining explicit old mode and put capability checks", () => {
  let secretReads = 0;
  const env = {
    APP_SCOPE: "production",
    SINGLE_TRIAL_MODE: "first-book-20261023",
    R2_ACCOUNT_ID: accountId,
    R2_BUCKET: "the-shelf-first-book-20261023",
    SINGLE_TRIAL_TARGET_SHA256: targetSha256,
    BOOKS: { put() {}, head() {}, get() {} },
  };
  Object.defineProperty(env, "SINGLE_TRIAL_UPLOAD_SECRET", {
    get() {
      secretReads++;
      throw Error("must-not-read");
    },
  });
  const decoded = decodeTrialRow(row(), env);
  assert.deepEqual(Object.keys(decoded), ["row", "descriptor", "file"]);
  assert.deepEqual(decoded.descriptor, descriptor);
  assert.equal(secretReads, 0);
  assert.throws(
    () => decodeTrialRow(row(), { ...env, BOOKS: { head() {}, get() {} } }),
    { code: "files_unconfigured" },
  );
  reject(() => decodeTrialRow(row(), {}));
  for (const [state, put_attempted, content_verified, etag] of [
    ["reserved", 0, 0, null],
    ["uploading", 1, 0, null],
    ["uncertain", 1, 0, null],
  ]) {
    const input = { ...row(), state, put_attempted, content_verified, etag };
    assert.equal(
      decodeTrialRow(input, env, { confirmed: false }).file.state,
      state,
    );
    reject(() => decodeTrialRow(input, env));
  }
});
test("decoder rejects getters and invalid target configurations without evaluating them", () => {
  let reads = 0;
  const input = row();
  Object.defineProperty(input, "descriptor_json", {
    enumerable: true,
    get() {
      reads++;
      throw Error("must-not-read");
    },
  });
  reject(() => decodeTrialRecord(input, target));
  const accessor = { ...target };
  Object.defineProperty(accessor, "accountId", {
    enumerable: true,
    get() {
      reads++;
      throw Error("must-not-read");
    },
  });
  reject(() => decodeTrialRecord(row(), accessor));
  for (const configuration of [
    { ...target, extra: true },
    { ...target, accountId: 12 },
    { ...target, targetSha256: undefined },
  ])
    reject(() => decodeTrialRecord(row(), configuration));
  reject(() => decodeTrialRecord(row(), target, { confirmed: "true" }));
  assert.equal(reads, 0);
  const source = readFileSync(
    new URL("../cloudflare/library/trial-record.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    /\b(?:env|Date|process|fetch|SINGLE_TRIAL_UPLOAD_SECRET)\b/.test(
      source.replace(/^\/\*\*[^]*?\*\//, ""),
    ),
    false,
  );
});
