/** Pure historical trial record decoder. No env, clock, storage or secret access. */
import { LibraryError } from "./security.mjs";
import { normalizedEtag, THRESHOLD } from "./core.mjs";
const SINGLE_TRIAL_BUCKET = "the-shelf-first-book-20261023";
const hash = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9_-]{1,100}$/;
const fail = () => {
  throw new LibraryError("file_unavailable", 409);
};
const exact = (v, keys) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  return (
    Reflect.ownKeys(descriptors).length === keys.length &&
    keys.every(
      (k) =>
        descriptors[k]?.enumerable && Object.hasOwn(descriptors[k], "value"),
    )
  );
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
};
export function decodeTrialRecord(
  row,
  targetConfiguration,
  { confirmed = true } = {},
) {
  try {
    if (
      !exact(targetConfiguration, ["accountId", "targetSha256"]) ||
      typeof targetConfiguration.accountId !== "string" ||
      !/^[a-f0-9]{32}$/.test(targetConfiguration.accountId) ||
      typeof targetConfiguration.targetSha256 !== "string" ||
      !hash.test(targetConfiguration.targetSha256) ||
      typeof confirmed !== "boolean" ||
      !exact(row, [
        "id",
        "permit_id",
        "consent_id",
        "authority_identity_json",
        "target_json",
        "descriptor_json",
        "isolated_target_config_sha256",
        "size_bytes",
        "issued_at",
        "expires_at",
        "state",
        "put_attempted",
        "content_verified",
        "etag",
        "updated_at",
      ]) ||
      row.id !== 1 ||
      row.consent_id !== "2026-10-23-first-book" ||
      typeof row.permit_id !== "string" ||
      !id.test(row.permit_id) ||
      ![
        row.target_json,
        row.descriptor_json,
        row.authority_identity_json,
      ].every((v) => typeof v === "string") ||
      ![row.issued_at, row.expires_at, row.updated_at].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      row.updated_at < row.issued_at ||
      row.expires_at <= row.issued_at ||
      row.expires_at > row.issued_at + 86400000 ||
      row.isolated_target_config_sha256 !== targetConfiguration.targetSha256
    )
      fail();
    const target = JSON.parse(row.target_json),
      d = JSON.parse(row.descriptor_json),
      authority = JSON.parse(row.authority_identity_json);
    if (
      !exact(target, ["accountId", "bucket"]) ||
      target.accountId !== targetConfiguration.accountId ||
      target.bucket !== SINGLE_TRIAL_BUCKET ||
      !exact(authority, [
        "schemaVersion",
        "authorityId",
        "accountId",
        "bucket",
        "legacyDatabases",
      ]) ||
      authority.schemaVersion !== 1 ||
      authority.authorityId !== "shelf-remote-storage-v1" ||
      !exact(authority.legacyDatabases, ["check", "production"]) ||
      !Object.values(authority.legacyDatabases).every(
        (v) =>
          typeof v === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            v,
          ),
      ) ||
      authority.legacyDatabases.check ===
        authority.legacyDatabases.production ||
      authority.accountId !== target.accountId ||
      authority.bucket !== "the-shelf-books" ||
      !exact(d, [
        "kind",
        "scope",
        "fileId",
        "bookId",
        "format",
        "sizeBytes",
        "sha256",
        "objectKey",
        "versionHash",
        "source",
      ]) ||
      d.kind !== "original" ||
      d.scope !== "production" ||
      typeof d.fileId !== "string" ||
      !id.test(d.fileId) ||
      typeof d.bookId !== "string" ||
      !id.test(d.bookId) ||
      !["PDF", "EPUB"].includes(d.format) ||
      !Number.isSafeInteger(d.sizeBytes) ||
      d.sizeBytes < 1 ||
      d.sizeBytes > THRESHOLD ||
      d.sizeBytes !== row.size_bytes ||
      typeof d.sha256 !== "string" ||
      !hash.test(d.sha256) ||
      d.versionHash !== null ||
      d.source !== null ||
      d.objectKey !==
        `books/cf03/${d.fileId}/${d.sha256}.${d.format.toLowerCase()}` ||
      !["reserved", "uploading", "uncertain", "confirmed"].includes(row.state)
    )
      fail();
    if (
      (row.state === "reserved" &&
        (row.put_attempted !== 0 ||
          row.content_verified !== 0 ||
          row.etag !== null)) ||
      (["uploading", "uncertain"].includes(row.state) &&
        (row.put_attempted !== 1 ||
          row.content_verified !== 0 ||
          row.etag !== null))
    )
      fail();
    if (
      confirmed &&
      (row.state !== "confirmed" ||
        row.content_verified !== 1 ||
        row.put_attempted !== 1 ||
        !normalizedEtag(row.etag))
    )
      fail();
    return freeze({
      row: { ...row },
      authority,
      target,
      descriptor: d,
      file: {
        file_id: d.fileId,
        book_id: d.bookId,
        object_key: d.objectKey,
        format: d.format,
        size_bytes: d.sizeBytes,
        sha256: d.sha256,
        etag: row.etag,
        state: row.state,
      },
    });
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    fail();
  }
}
