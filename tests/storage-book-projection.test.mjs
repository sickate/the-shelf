import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DATABASE_SCHEMA_PROFILES } from "../shared/storage-schema-profiles.mjs";
import { bootstrapInput } from "../scripts/cf-library-operations.mjs";
import { validateMetadataFields } from "../cloudflare/library/core.mjs";
import {
  storageReadConfiguration,
  assertStorageReadConfiguration,
  decodeStorageBookProjection,
  readSourceAdapter,
  confirmedSourceGuard,
  STORAGE_SOURCE_LIMITS,
  STORAGE_BOOK_PROJECTION_LIMITS,
} from "../cloudflare/library/storage-sources.mjs";

const json = JSON.stringify,
  clone = structuredClone,
  ACCOUNT = "a".repeat(32),
  TARGET = "b".repeat(64),
  ORIGIN = "https://the-shelf.iamzhutuo.workers.dev";
const identity = {
  schemaVersion: 1,
  authorityId: "shelf-remote-storage-v1",
  accountId: ACCOUNT,
  bucket: "the-shelf-books",
  legacyDatabases: {
    check: "11111111-1111-4111-8111-111111111111",
    production: "22222222-2222-4222-8222-222222222222",
  },
};
const rejects = (operation, status = 409) =>
  assert.throws(
    operation,
    (error) => error instanceof Error && error.status === status,
  );

function fixture({
  source = "normal",
  format = "PDF",
  fileId = "file_synthetic",
  bookId = "book_synthetic",
  profile = "trial-010-cf-metadata-v1",
} = {}) {
  const calls = { d1: 0, r2: 0, secrets: 0, writes: 0 };
  const store = () => {
    const result = {
      head() {
        calls.r2++;
        throw Error("no IO");
      },
      get() {
        calls.r2++;
        throw Error("no IO");
      },
    };
    for (const name of ["put", "delete", "list"])
      Object.defineProperty(result, name, {
        get() {
          calls.writes++;
          throw Error("no writes");
        },
      });
    return result;
  };
  const env = {
    APP_SCOPE: "production",
    SITE_ORIGIN: ORIGIN,
    STORAGE_MODE: "authority-v2",
    STORAGE_WRITE_MODE: "closed",
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: "the-shelf-books",
    TRIAL_R2_ACCOUNT_ID: ACCOUNT,
    TRIAL_R2_BUCKET: "the-shelf-first-book-20261023",
    TRIAL_TARGET_SHA256: TARGET,
    FILENAME_AI_MODE: "filename-v1",
    BOOKS: store(),
    TRIAL_BOOKS: store(),
    DB: {
      withSession() {
        calls.d1++;
        throw Error("no IO");
      },
    },
  };
  for (const name of [
    "OWNER_KEY_PEPPER",
    "SESSION_SECRET",
    "SINGLE_TRIAL_UPLOAD_SECRET",
    "FILENAME_AI_KEY",
  ])
    Object.defineProperty(env, name, {
      get() {
        calls.secrets++;
        throw Error("no secret reads");
      },
    });
  const configuration = storageReadConfiguration(env);
  const descriptor = {
    kind: "original",
    scope: "production",
    fileId,
    bookId,
    format,
    sizeBytes: 15,
    sha256: "d".repeat(64),
    objectKey: `books/cf03/${fileId}/${"d".repeat(64)}.${format.toLowerCase()}`,
    versionHash: null,
    source: null,
  };
  const normal = {
    file: {
      scope: "production",
      file_id: fileId,
      book_id: bookId,
      format,
      size_bytes: 15,
      object_key: descriptor.objectKey,
      sha256: descriptor.sha256,
      etag: "synthetic_etag",
      state: "confirmed",
      version: 1,
      updated_at: 2000,
    },
    registry: {
      logical_key: `original:production:${fileId}:original`,
      reservation_id: "synthetic_reservation",
      descriptor_json: json(descriptor),
      etag: "synthetic_etag",
      enabled: 1,
    },
    reservation: {
      reservation_id: "synthetic_reservation",
      logical_key: `original:production:${fileId}:original`,
      object_key: descriptor.objectKey,
      descriptor_json: json(descriptor),
      size_bytes: 15,
      state: "confirmed",
      put_attempted: 1,
      content_verified: 1,
      etag: "synthetic_etag",
      created_at: 1000,
      updated_at: 2000,
    },
  };
  const trial = {
    id: 1,
    permit_id: "synthetic_permit",
    consent_id: "2026-10-23-first-book",
    authority_identity_json: json(identity),
    target_json: json({
      accountId: ACCOUNT,
      bucket: "the-shelf-first-book-20261023",
    }),
    descriptor_json: json(descriptor),
    isolated_target_config_sha256: TARGET,
    size_bytes: 15,
    issued_at: 0,
    expires_at: 3600000,
    state: "confirmed",
    put_attempted: 1,
    content_verified: 1,
    etag: "synthetic_etag",
    updated_at: 2000,
  };
  const book = {
    id: bookId,
    title: "Synthetic book",
    author: null,
    category: "Synthetic",
    categoryId: "cat-synthetic",
    tags: [],
    description: "",
    files: [
      {
        id: fileId,
        format,
        sizeBytes: 15,
        status: "candidate",
        reason: "uploaded",
        visibility: "private",
        readable: ["PDF", "EPUB"].includes(format),
      },
    ],
  };
  const payload = {
    header: {
      schema: clone(DATABASE_SCHEMA_PROFILES[profile]),
      authority: { identity_json: json(identity), phase: "imported" },
    },
    books: [
      {
        scope: "production",
        book_id: bookId,
        catalog_json: json(book),
        management: {
          scope: "production",
          book_id: bookId,
          visibility: "private",
          trashed: 0,
          version: 1,
          updated_at: 2000,
        },
        metadata: null,
      },
    ],
    sources: [
      {
        scope: "production",
        file_id: fileId,
        raw_count: source === "none" ? 0 : 1,
        normal: source === "normal" ? [normal] : [],
        trial: source === "trial" ? [trial] : [],
      },
    ],
  };
  const observation = () => ({ projection_json: json(payload), overflow: 0 });
  const decode = (options = { audience: "owner", allowTrash: true }) =>
    decodeStorageBookProjection(configuration, observation(), options);
  const setBook = (edit) => {
    const current = JSON.parse(payload.books[0].catalog_json);
    edit(current);
    payload.books[0].catalog_json = json(current);
  };
  const setPatch = (patch, version = 1) => {
    payload.books[0].metadata = {
      scope: "production",
      book_id: bookId,
      patch_json: json(patch),
      version,
    };
  };
  return {
    env,
    calls,
    configuration,
    payload,
    normal,
    trial,
    descriptor,
    book,
    observation,
    decode,
    setBook,
    setPatch,
  };
}

for (const profile of Object.keys(DATABASE_SCHEMA_PROFILES))
  for (const source of ["normal", "trial"])
    test(`pure ${source} display validates one full ${profile} header without IO or grants`, () => {
      const f = fixture({ profile, source }),
        result = f.decode();
      assert.deepEqual(result.registry, [
        {
          file_id: f.descriptor.fileId,
          book_id: f.descriptor.bookId,
          format: "PDF",
          size_bytes: 15,
          state: "confirmed",
        },
      ]);
      assert.deepEqual(Object.keys(result).sort(), ["books", "registry"]);
      assert.deepEqual(result.books[0], {
        bookId: f.descriptor.bookId,
        visibility: "private",
        trashed: 0,
        managementVersion: 1,
        deletedAt: null,
        metadataVersion: 0,
        patch: {},
        book: f.book,
      });
      assert.ok(Object.isFrozen(result.books[0].book.files[0]));
      assert.ok(Object.isFrozen(result.registry[0]));
      rejects(() => readSourceAdapter(f.env, result), 409);
      rejects(() => readSourceAdapter(f.env, result.books[0]), 409);
      rejects(() => confirmedSourceGuard(result.registry[0]), 409);
      assert.deepEqual(f.calls, { d1: 0, r2: 0, secrets: 0, writes: 0 });
    });

test("raw zero retains book management and metadata while clearing stale uploaded display", () => {
  const f = fixture({ source: "none" });
  f.setPatch({ title: "Edited" }, 7);
  const result = f.decode();
  assert.deepEqual(result.registry, []);
  assert.equal(result.books[0].book.title, "Edited");
  assert.equal(result.books[0].book.files[0].reason, "not_uploaded");
  assert.equal(result.books[0].managementVersion, 1);
  assert.equal(result.books[0].metadataVersion, 7);
});

test("every catalog reference needs an explicit global source group, including raw zero", () => {
  const f = fixture({ source: "none" });
  f.payload.sources = [];
  rejects(() => f.decode(), 503);
});

test("every raw conflict precedes malformed source facts, catalog, metadata and display filters", () => {
  const f = fixture(),
    other = fixture({ source: "trial", bookId: "other_book" });
  f.payload.sources[0].normal = [null];
  f.payload.sources[0].trial = [other.trial];
  f.payload.sources[0].raw_count = 2;
  f.payload.books[0].catalog_json = "broken JSON";
  f.payload.books[0].metadata = { broken: true };
  f.payload.books[0].management.trashed = 1;
  rejects(() => f.decode({ audience: "anonymous", allowTrash: false }), 409);
});

test("a later conflict is checked before an earlier invalid record", () => {
  const f = fixture(),
    other = fixture({
      fileId: "other_file",
      bookId: "other_book",
      source: "trial",
    });
  f.payload.sources[0].normal = [null];
  other.payload.sources[0].normal = [null];
  other.payload.sources[0].raw_count = 2;
  f.payload.sources.push(other.payload.sources[0]);
  rejects(() => f.decode(), 409);
});

for (const format of ["PDF", "EPUB", "MOBI", "AZW", "AZW3"])
  test(`normal ${format} keeps the existing original-file capability rules`, () => {
    const f = fixture({ format });
    assert.equal(f.decode().registry[0].format, format);
  });

for (const [label, mutate] of [
  [
    "missing registry",
    (f) => {
      f.normal.registry = null;
    },
  ],
  [
    "disabled registry",
    (f) => {
      f.normal.registry.enabled = 0;
    },
  ],
  [
    "reservation state",
    (f) => {
      f.normal.reservation.state = "uncertain";
    },
  ],
  [
    "content verification",
    (f) => {
      f.normal.reservation.content_verified = 0;
    },
  ],
  [
    "PUT consumed",
    (f) => {
      f.normal.reservation.put_attempted = 0;
    },
  ],
  [
    "reservation descriptor",
    (f) => {
      f.normal.reservation.descriptor_json += " ";
    },
  ],
  [
    "reservation id",
    (f) => {
      f.normal.registry.reservation_id = "other";
    },
  ],
  [
    "file version",
    (f) => {
      f.normal.file.version = 0;
    },
  ],
  [
    "file etag",
    (f) => {
      f.normal.file.etag = "other";
    },
  ],
  [
    "file key",
    (f) => {
      f.normal.file.object_key = "other";
    },
  ],
  [
    "file book",
    (f) => {
      f.normal.file.book_id = "other_book";
    },
  ],
  [
    "descriptor scope",
    (f) => {
      const d = clone(f.descriptor);
      d.scope = "check";
      f.normal.registry.descriptor_json = f.normal.reservation.descriptor_json =
        json(d);
    },
  ],
  [
    "catalog false readable",
    (f) =>
      f.setBook((b) => {
        b.files[0].readable = false;
      }),
  ],
  [
    "catalog wrong format",
    (f) =>
      f.setBook((b) => {
        b.files[0].format = "EPUB";
      }),
  ],
  [
    "catalog wrong size",
    (f) =>
      f.setBook((b) => {
        b.files[0].sizeBytes++;
      }),
  ],
  [
    "catalog extra file field",
    (f) =>
      f.setBook((b) => {
        b.files[0].key = "not-public";
      }),
  ],
])
  test(`display reuses strict normal attribution: ${label}`, () => {
    const f = fixture();
    mutate(f);
    rejects(() => f.decode());
  });

for (const [label, mutate] of [
  [
    "unconsumed",
    (f) => {
      f.trial.put_attempted = 0;
    },
  ],
  [
    "unverified",
    (f) => {
      f.trial.content_verified = 0;
    },
  ],
  [
    "wrong fixed target",
    (f) => {
      f.trial.isolated_target_config_sha256 = "f".repeat(64);
    },
  ],
  [
    "authority mismatch",
    (f) => {
      const a = clone(identity);
      a.legacyDatabases.production = "33333333-3333-4333-8333-333333333333";
      f.trial.authority_identity_json = json(a);
    },
  ],
  [
    "malformed descriptor",
    (f) => {
      f.trial.descriptor_json = "{}";
    },
  ],
  [
    "catalog false readable",
    (f) =>
      f.setBook((b) => {
        b.files[0].readable = false;
      }),
  ],
])
  test(`display reuses historical trial decoder: ${label}`, () => {
    const f = fixture({ source: "trial" });
    mutate(f);
    rejects(() => f.decode());
  });

for (const source of ["normal", "trial"])
  test(`${source} cannot attach its confirmed file to a different catalog book`, () => {
    const f = fixture({ source });
    f.payload.books[0].book_id = "other_book";
    f.payload.books[0].management.book_id = "other_book";
    f.setBook((b) => {
      b.id = "other_book";
    });
    rejects(() => f.decode());
  });

for (const source of ["normal", "none"])
  test(`duplicate file IDs are rejected even with ${source} raw state`, () => {
    const f = fixture({ source });
    f.setBook((b) => b.files.push(clone(b.files[0])));
    rejects(() => f.decode());
  });

test("one page cannot contain two books referencing the same file ID", () => {
  const f = fixture(),
    other = fixture({ bookId: "other_book", source: "none" });
  f.payload.books.push(other.payload.books[0]);
  rejects(() => f.decode());
});

test("a claimed-book source missing from the catalog is retained and rejected", () => {
  const f = fixture();
  f.setBook((b) => {
    b.files = [];
  });
  rejects(() => f.decode());
});

test("zero candidate facts with no catalog reference are rejected", () => {
  const f = fixture({ source: "none" });
  f.setBook((b) => {
    b.files = [];
  });
  rejects(() => f.decode(), 503);
});

test("anonymous output includes public overrides and excludes private/trash facts and patches", () => {
  const f = fixture(),
    publicBook = fixture({ bookId: "public_book", fileId: "public_file" }),
    trashed = fixture({ bookId: "trash_book", fileId: "trash_file" });
  publicBook.payload.books[0].management.visibility = "public";
  publicBook.setPatch({ title: "Public edited title" }, 4);
  trashed.payload.books[0].management.visibility = "public";
  trashed.payload.books[0].management.trashed = 1;
  f.setPatch({ title: "Private marker" });
  trashed.setPatch({ title: "Trash marker" });
  f.payload.books.push(publicBook.payload.books[0], trashed.payload.books[0]);
  f.payload.sources.push(
    publicBook.payload.sources[0],
    trashed.payload.sources[0],
  );
  const result = f.decode({ audience: "anonymous", allowTrash: false });
  assert.equal(result.books.length, 1);
  assert.equal(result.books[0].book.title, "Public edited title");
  assert.equal(result.books[0].metadataVersion, 4);
  assert.deepEqual(
    result.registry.map((r) => r.file_id),
    ["public_file"],
  );
  assert.equal(
    /Private marker|Trash marker|trash_file|file_synthetic/.test(json(result)),
    false,
  );
});

test("owners can display trash, while active views and anonymous views exclude it", () => {
  const f = fixture();
  f.payload.books[0].management.trashed = 1;
  const result = f.decode();
  assert.equal(result.books[0].deletedAt, 2000);
  assert.equal(result.registry.length, 1);
  assert.deepEqual(f.decode({ audience: "owner", allowTrash: false }), {
    registry: [],
    books: [],
  });
  assert.deepEqual(f.decode({ audience: "anonymous", allowTrash: false }), {
    registry: [],
    books: [],
  });
  rejects(() => readSourceAdapter(f.env, result.books[0]), 409);
});

test("missing management defaults to public, active, version zero and no deletion timestamp", () => {
  const f = fixture();
  f.payload.books[0].management = null;
  const item = f.decode({ audience: "anonymous", allowTrash: false }).books[0];
  assert.equal(item.visibility, "public");
  assert.equal(item.trashed, 0);
  assert.equal(item.managementVersion, 0);
  assert.equal(item.deletedAt, null);
});

test("metadata from the existing bootstrap producer and writer remains valid", () => {
  const f = fixture();
  const imported = bootstrapInput(
    "production",
    { schemaVersion: 1, books: [f.book] },
    {
      schemaVersion: 1,
      books: {
        [f.book.id]: {
          title: "  Imported  ",
          category: " Imported category ",
          tags: [" tag ", "tag"],
        },
      },
    },
    2000,
  );
  const patch = {
    ...imported.patches[0][1],
    ...validateMetadataFields({ description: " Writer edit ", author: null }),
  };
  f.setPatch(patch, 8);
  const result = f.decode().books[0];
  assert.equal(result.book.title, "Imported");
  assert.equal(result.book.description, "Writer edit");
  assert.deepEqual(result.book.tags, ["tag"]);
  assert.match(result.book.categoryId, /^cat-[a-f0-9]{12}$/);
  assert.deepEqual(result.patch, patch);
  assert.equal(result.metadataVersion, 8);
});

test("safe historical metadata is preserved without trimming or deduplicating on read", () => {
  const f = fixture(),
    patch = {
      title: " Padded ",
      author: "",
      tags: [" tag ", " tag "],
      description: " Line\n ",
    };
  f.setPatch(patch);
  const result = f.decode().books[0];
  assert.deepEqual(result.patch, patch);
  assert.equal(result.book.title, patch.title);
  assert.deepEqual(result.book.tags, patch.tags);
  assert.equal(result.book.author, "");
});

test("empty persisted metadata is valid with its existing positive version", () => {
  const f = fixture();
  f.setPatch({}, 3);
  assert.equal(f.decode().books[0].metadataVersion, 3);
});

for (const [label, mutate] of [
  [
    "metadata version zero",
    (f) => {
      f.setPatch({});
      f.payload.books[0].metadata.version = 0;
    },
  ],
  [
    "metadata wrong scope",
    (f) => {
      f.setPatch({});
      f.payload.books[0].metadata.scope = "check";
    },
  ],
  [
    "metadata wrong book",
    (f) => {
      f.setPatch({});
      f.payload.books[0].metadata.book_id = "other";
    },
  ],
  [
    "metadata extra field",
    (f) => {
      f.setPatch({});
      f.payload.books[0].metadata.key = "hidden";
    },
  ],
  ["metadata unknown patch field", (f) => f.setPatch({ objectKey: "hidden" })],
  [
    "metadata invalid category ID",
    (f) => f.setPatch({ categoryId: "invalid/id" }),
  ],
  ["metadata invalid title", (f) => f.setPatch({ title: 7 })],
  [
    "metadata oversized description",
    (f) => f.setPatch({ description: "x".repeat(4001) }),
  ],
  ["metadata invalid control", (f) => f.setPatch({ title: "bad\u0000title" })],
  ["metadata invalid tag", (f) => f.setPatch({ tags: [""] })],
  ["metadata array", (f) => f.setPatch([])],
  [
    "metadata invalid JSON",
    (f) => {
      f.setPatch({});
      f.payload.books[0].metadata.patch_json = "broken";
    },
  ],
  [
    "management trash primitive",
    (f) => {
      f.payload.books[0].management.trashed = true;
    },
  ],
  [
    "management version zero",
    (f) => {
      f.payload.books[0].management.version = 0;
    },
  ],
  [
    "management wrong book",
    (f) => {
      f.payload.books[0].management.book_id = "other";
    },
  ],
])
  test(`unsafe persisted projection rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    rejects(() => f.decode(), label.startsWith("management") ? 409 : 503);
  });

for (const [label, mutate] of [
  [
    "unknown header schema",
    (f) =>
      f.payload.header.schema.push({
        type: "table",
        name: "unknown",
        tbl_name: "unknown",
        sql: "CREATE TABLE unknown(v)",
      }),
  ],
  [
    "unknown authority phase",
    (f) => {
      f.payload.header.authority.phase = "migration_required";
    },
  ],
  [
    "authority wrong account",
    (f) => {
      const a = clone(identity);
      a.accountId = "f".repeat(32);
      f.payload.header.authority.identity_json = json(a);
    },
  ],
  [
    "header extra field",
    (f) => {
      f.payload.header.session = null;
    },
  ],
  [
    "payload extra field",
    (f) => {
      f.payload.nextCursor = "not-decoder-input";
    },
  ],
  [
    "book extra field",
    (f) => {
      f.payload.books[0].source = "normal";
    },
  ],
  [
    "duplicate book row",
    (f) => f.payload.books.push(clone(f.payload.books[0])),
  ],
  [
    "book wrong scope",
    (f) => {
      f.payload.books[0].scope = "check";
    },
  ],
  [
    "missing metadata field",
    (f) => {
      delete f.payload.books[0].metadata;
    },
  ],
  [
    "source wrong scope",
    (f) => {
      f.payload.sources[0].scope = "check";
    },
  ],
  [
    "source duplicate group",
    (f) => f.payload.sources.push(clone(f.payload.sources[0])),
  ],
  [
    "source count mismatch",
    (f) => {
      f.payload.sources[0].raw_count = 0;
    },
  ],
  [
    "source count fraction",
    (f) => {
      f.payload.sources[0].raw_count = 1.5;
    },
  ],
  [
    "source count greater than two",
    (f) => {
      f.payload.sources[0].normal.push(null, null);
      f.payload.sources[0].raw_count = 3;
    },
  ],
  [
    "source arrays invalid",
    (f) => {
      f.payload.sources[0].trial = null;
    },
  ],
  [
    "over one hundred books",
    (f) => {
      f.payload.books = Array.from({ length: 101 }, () =>
        clone(f.payload.books[0]),
      );
    },
  ],
])
  test(`bounded exact projection rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    rejects(() => f.decode(), 503);
  });

for (const [label, mutate] of [
  [
    "normal registry descriptor",
    (f) => {
      f.normal.registry.descriptor_json = "x".repeat(4097);
    },
  ],
  [
    "normal reservation descriptor",
    (f) => {
      f.normal.reservation.descriptor_json = "x".repeat(4097);
    },
  ],
  [
    "catalog",
    (f) => {
      f.payload.books[0].catalog_json = "x".repeat(262145);
    },
  ],
  [
    "metadata",
    (f) => {
      f.setPatch({});
      f.payload.books[0].metadata.patch_json = " ".repeat(32769);
    },
  ],
])
  test(`preserves the per-value byte bound for ${label}`, () => {
    const f = fixture();
    mutate(f);
    rejects(() => f.decode(), 503);
  });

for (const [field, maximum] of [
  ["descriptor_json", 4096],
  ["authority_identity_json", 2048],
  ["target_json", 256],
])
  test(`preserves trial ${field} byte bound before decoding it`, () => {
    const f = fixture({ source: "trial" });
    f.trial[field] = "x".repeat(maximum + 1);
    rejects(() => f.decode(), 503);
  });

test("one MiB is an exact UTF8 outer transport bound, independent of the raw candidate cap", () => {
  const f = fixture(),
    row = f.observation(),
    limit = STORAGE_BOOK_PROJECTION_LIMITS.responseBytes;
  row.projection_json += " ".repeat(limit - Buffer.byteLength(json(row)));
  assert.equal(Buffer.byteLength(json(row)), 1048576);
  assert.equal(
    decodeStorageBookProjection(f.configuration, row, {
      audience: "owner",
      allowTrash: false,
    }).registry.length,
    1,
  );
  row.projection_json += " ";
  rejects(
    () =>
      decodeStorageBookProjection(f.configuration, row, {
        audience: "owner",
        allowTrash: false,
      }),
    503,
  );
  assert.equal(STORAGE_BOOK_PROJECTION_LIMITS.rawCandidates, 20000);
  assert.equal(STORAGE_BOOK_PROJECTION_LIMITS.candidateQueryLimit, 20001);
  assert.equal(STORAGE_SOURCE_LIMITS.rawCandidates, 2);
  assert.equal(STORAGE_SOURCE_LIMITS.snapshotBytes, 524224);
});

test("UTF8 byte limits count multibyte catalog data, not JS character counts", () => {
  const f = fixture();
  f.setBook((b) => {
    b.description = "汉".repeat(90000);
  });
  assert.ok(f.payload.books[0].catalog_json.length < 262144);
  assert.ok(Buffer.byteLength(f.payload.books[0].catalog_json) > 262144);
  rejects(() => f.decode(), 503);
});

test("transport/options accessors and forged configuration are rejected without invocation", () => {
  const f = fixture();
  let accesses = 0;
  const row = { overflow: 0 };
  Object.defineProperty(row, "projection_json", {
    enumerable: true,
    get() {
      accesses++;
      throw Error("not-read");
    },
  });
  rejects(
    () =>
      decodeStorageBookProjection(f.configuration, row, {
        audience: "owner",
        allowTrash: false,
      }),
    503,
  );
  const options = { allowTrash: false };
  Object.defineProperty(options, "audience", {
    enumerable: true,
    get() {
      accesses++;
      throw Error("not-read");
    },
  });
  rejects(
    () =>
      decodeStorageBookProjection(f.configuration, f.observation(), options),
    503,
  );
  rejects(
    () =>
      decodeStorageBookProjection(clone(f.configuration), f.observation(), {
        audience: "owner",
        allowTrash: false,
      }),
    503,
  );
  rejects(() => f.decode({ audience: "anonymous", allowTrash: true }), 503);
  assert.equal(accesses, 0);
});

test("overflow and oversized projection strings fail closed without decoding", () => {
  const f = fixture();
  for (const row of [
    { projection_json: null, overflow: 1 },
    { projection_json: "broken", overflow: 0 },
    { projection_json: "x".repeat(1048577), overflow: 0 },
    { ...f.observation(), extra: true },
  ])
    rejects(
      () =>
        decodeStorageBookProjection(f.configuration, row, {
          audience: "owner",
          allowTrash: false,
        }),
      503,
    );
});

test("the configuration assertion returns void and detects replacement bindings and methods without IO", () => {
  for (const mutate of [
    (f) => {
      f.env.DB = { ...f.env.DB };
    },
    (f) => {
      f.env.DB.withSession = () => {};
    },
    (f) => {
      f.env.BOOKS = { ...f.env.BOOKS };
    },
    (f) => {
      f.env.TRIAL_BOOKS.get = () => {};
    },
    (f) => {
      f.env.TRIAL_TARGET_SHA256 = "f".repeat(64);
    },
  ]) {
    const f = fixture();
    assert.equal(
      assertStorageReadConfiguration(f.env, f.configuration),
      undefined,
    );
    mutate(f);
    rejects(() => assertStorageReadConfiguration(f.env, f.configuration), 409);
    assert.deepEqual(f.calls, { d1: 0, r2: 0, secrets: 0, writes: 0 });
  }
});

test("pure display decoder still bundles for Workers without server, operators or IO imports", async () => {
  const result = await build({
    entryPoints: ["cloudflare/library/storage-sources.mjs"],
    platform: "browser",
    format: "esm",
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.equal(
    Object.keys(result.metafile.inputs).some(
      (name) =>
        /^(server|scripts)\//.test(name) || name.includes("single-trial.mjs"),
    ),
    false,
  );
});
