// Only synthetic local facts; no credentials, original bytes or network.
import {
  fixture as originalFixture,
  context,
  session,
} from "./storage-read-fixture.mjs";
import {
  buildPreparedIndex,
  preparedChunkRow,
  preparedDigest,
} from "../../shared/prepared-index.mjs";
import { loadPreparedForJob } from "../../cloudflare/library/prepared.mjs";
export const FILE = "file_1234567890abcdef",
  BOOK = "book_1234567890abcdef";
const encoder = new TextEncoder();
export async function fixture(
  t,
  {
    count = 2,
    format = "PDF",
    source = "normal",
    profile = "trial-010",
    extraFile = false,
  } = {},
) {
  const f = originalFixture(t, { format, source, profile });
  const old = f.d.fileId,
    oldBook = f.d.bookId;
  f.d.fileId = FILE;
  f.d.bookId = BOOK;
  f.d.objectKey = f.d.objectKey.replace(old, FILE);
  f.book.id = BOOK;
  f.book.files[0].id = FILE;
  if (extraFile)
    f.book.files.push({ ...f.book.files[0], id: "file_aaaaaaaaaaaaaaaa" });
  f.db.exec("PRAGMA foreign_keys=OFF");
  f.unsafe(() => {
    f.db
      .prepare("UPDATE catalog_books SET book_id=?,public_json=?")
      .run(BOOK, JSON.stringify(f.book));
    f.db.prepare("UPDATE book_management SET book_id=?").run(BOOK);
    f.db
      .prepare("UPDATE file_registry SET file_id=?,book_id=?,object_key=?")
      .run(FILE, BOOK, f.d.objectKey);
    f.db
      .prepare(
        "UPDATE shelf_storage_reservations SET logical_key=?,object_key=?,descriptor_json=?",
      )
      .run(
        `original:production:${FILE}:original`,
        f.d.objectKey,
        JSON.stringify(f.d),
      );
    f.db
      .prepare(
        "UPDATE shelf_storage_original_registry SET logical_key=?,descriptor_json=?",
      )
      .run(`original:production:${FILE}:original`, JSON.stringify(f.d));
    f.db
      .prepare("UPDATE shelf_storage_single_trial SET descriptor_json=?")
      .run(JSON.stringify(f.d));
  });
  f.db.exec("PRAGMA foreign_keys=ON");
  const chunks = [];
  for (let index = 0; index < count; index++) {
    const text =
      count > 1000
        ? "a"
        : index === 0
          ? "磁流体发动机研究证据。"
          : "普通自然随笔。";
    chunks.push({
      index,
      locator:
        format === "PDF"
          ? {
              type: "pdf-page",
              page: index + 1,
              start: 0,
              end: [...text].length,
            }
          : {
              type: "epub-spine",
              spineIndex: index,
              start: 0,
              end: [...text].length,
            },
      text,
      sha256: await preparedDigest(encoder.encode(text)),
    });
  }
  const body = {
    schemaVersion: 1,
    kind: "shelf.prepared-text",
    preparation: {
      algorithm: "shelf-text-v1",
      normalization: "LF-NFC-trim-section",
      chunkCodepoints: 6000,
      offsetUnit: "unicode-code-point",
    },
    source: {
      fileId: FILE,
      bookId: BOOK,
      format,
      sizeBytes: f.d.sizeBytes,
      mtimeNs: "123",
      fingerprint: { algorithm: "sha256", value: f.d.sha256 },
    },
    textBytes: chunks.reduce(
      (n, c) => n + encoder.encode(c.text).byteLength,
      0,
    ),
    contentHash: await preparedDigest(encoder.encode(JSON.stringify(chunks))),
    chunks,
  };
  const versionHash = await preparedDigest(
      encoder.encode(JSON.stringify(body)),
    ),
    value = { ...body, versionHash },
    bytes = encoder.encode(JSON.stringify(value) + "\n"),
    index = await buildPreparedIndex(value),
    packageSha256 = await preparedDigest(bytes),
    etag = "prepared-etag";
  const pin = {
    fileId: FILE,
    bookId: BOOK,
    format,
    sizeBytes: f.d.sizeBytes,
    mtimeNs: "123",
    versionHash,
    sourceSha256: f.d.sha256,
  };
  const descriptor = {
    kind: "prepared-text",
    scope: "production",
    fileId: FILE,
    bookId: BOOK,
    format: "JSON",
    sizeBytes: bytes.length,
    sha256: packageSha256,
    objectKey: `prepared-text/v1/production/${FILE}/${versionHash}/${packageSha256}.json`,
    versionHash,
    source: pin,
  };
  const logical = `prepared-text:production:${FILE}:${versionHash}`;
  const header = [
    "production",
    FILE,
    versionHash,
    BOOK,
    "text-reservation",
    logical,
    packageSha256,
    f.d.sha256,
    etag,
    format,
    count,
    index.textBytes,
    index.codepointCount,
    index.indexSha256,
    context.now - 100,
  ];
  f.unsafe(() => {
    f.db
      .prepare(
        "INSERT INTO shelf_storage_reservations VALUES(?,?,?,?,?,'confirmed',1,1,?,?,?)",
      )
      .run(
        "text-reservation",
        logical,
        descriptor.objectKey,
        JSON.stringify(descriptor),
        bytes.length,
        etag,
        context.now - 500,
        context.now - 250,
      );
    f.db
      .prepare("INSERT INTO shelf_storage_text_registry VALUES(?,?,?,?,1)")
      .run(logical, "text-reservation", JSON.stringify(descriptor), etag);
    f.db
      .prepare(
        "INSERT INTO shelf_prepared_indexes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(...header);
    const statement = f.db.prepare(
      "INSERT INTO shelf_prepared_index_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const chunk of index.chunks)
      statement.run(
        "production",
        FILE,
        versionHash,
        ...Object.values(preparedChunkRow(chunk)),
      );
    f.db
      .prepare(
        "INSERT INTO shelf_prepared_index_publications VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "production",
        FILE,
        versionHash,
        index.indexSha256,
        count,
        index.textBytes,
        index.codepointCount,
      );
  });
  const r2 = [];
  const preparedStore = {
    async head(key) {
      r2.push(["head", key]);
      return { size: bytes.length, etag };
    },
    async get(key, options) {
      r2.push(["get", key, options]);
      return { size: bytes.length, etag, body: new Response(bytes).body };
    },
  };
  for (const name of ["put", "delete", "list"])
    Object.defineProperty(preparedStore, name, {
      get() {
        throw Error("no write capability access");
      },
    });
  Object.assign(f.env, {
    PREPARED_TEXT_MODE: "registry-v1",
    PREPARED_R2_ACCOUNT_ID: f.env.R2_ACCOUNT_ID,
    PREPARED_R2_BUCKET: "the-shelf-books",
    PREPARED_BOOKS: preparedStore,
  });
  const grant = {
      context: { ...context },
      session: { ...session },
      bookId: BOOK,
    },
    selected = { fileId: FILE, versionHash };
  return {
    ...f,
    bytes,
    value,
    pin,
    index,
    descriptor,
    preparedStore,
    preparedR2: r2,
    header,
    grant,
    selected,
    load: (options) => loadPreparedForJob(f.env, grant, selected, options),
    admissions: () =>
      f.db
        .prepare("SELECT count(*) AS n FROM admissions WHERE kind='access'")
        .get().n,
  };
}
