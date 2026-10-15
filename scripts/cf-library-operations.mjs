import { createHash, randomUUID } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import {
  CEILING,
  LIMIT,
  LibraryError,
  validId,
  publicBook,
  publicCatalog,
  metadataPatch,
  selectedFile,
  accountEvidence,
  assertPublic,
  writePrivateJson,
} from "./cf-library-data.mjs";
import { mergePublicBook } from "../cloudflare/library/core.mjs";

const fail = (code) => {
  throw new LibraryError(code);
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
const nowMs = () => Date.now();
export const STORAGE_ADMISSION =
  "observedAccountBytes + committedBytes + reservedBytes + requestedBytes <= ceilingBytes";
export function conservativeStorageBudget(
  observedAccountBytes,
  committedBytes,
  reservedBytes,
  requestedBytes,
  ceilingBytes = CEILING,
) {
  if (
    [
      observedAccountBytes,
      committedBytes,
      reservedBytes,
      requestedBytes,
      ceilingBytes,
    ].some((value) => !Number.isSafeInteger(value) || value < 0) ||
    requestedBytes < 1 ||
    ceilingBytes < 1 ||
    ceilingBytes > CEILING
  )
    fail("invalid_storage_budget_state");
  const total =
    BigInt(observedAccountBytes) +
    BigInt(committedBytes) +
    BigInt(reservedBytes) +
    BigInt(requestedBytes);
  return {
    projectedBytes:
      total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null,
    admitted: total <= BigInt(ceilingBytes),
  };
}
export const statements = {
  reservations:
    "SELECT * FROM upload_reservations WHERE scope=? AND file_id=? AND state<>'aborted'",
};

export function bootstrapInput(
  scope,
  catalog,
  overrides = { schemaVersion: 1, books: {} },
  now = nowMs(),
  { secrets = [] } = {},
) {
  if (!["check", "production"].includes(scope)) fail("invalid_scope");
  const safe = publicCatalog(catalog, { now: new Date(now), secrets });
  if (
    overrides.schemaVersion !== 1 ||
    !overrides.books ||
    typeof overrides.books !== "object" ||
    Array.isArray(overrides.books)
  )
    fail("invalid_overrides");
  const known = new Set(safe.books.map((b) => b.id));
  const patches = Object.entries(overrides.books)
    .filter(([id]) => known.has(id))
    .map(([id, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail("invalid_overrides");
      const patch = metadataPatch(
        Object.fromEntries(
          ["title", "author", "description", "category", "tags"]
            .filter((k) => Object.hasOwn(value, k))
            .map((k) => [k, value[k]]),
        ),
      );
      if (patch.category)
        patch.categoryId =
          safe.books.find((b) => b.category === patch.category)?.categoryId ||
          `cat-${hash(patch.category).slice(0, 12)}`;
      assertPublic(patch, secrets);
      return [id, patch];
    })
    .filter(([, patch]) => Object.keys(patch).length)
    .sort(([a], [b]) => a.localeCompare(b));
  return {
    safe,
    patches,
    baseRevision: hash(JSON.stringify(safe.books)),
    inputFingerprint: hash(
      JSON.stringify({ scope, books: safe.books, patches }),
    ),
  };
}

export async function bootstrap(
  db,
  scope,
  catalog,
  overrides = { schemaVersion: 1, books: {} },
  now = nowMs(),
  { secrets = [], resume = false, dryRun = false } = {},
) {
  // Validate and fingerprint every input before acquiring the durable lease.
  const input = bootstrapInput(scope, catalog, overrides, now, { secrets });
  const { safe, patches, baseRevision, inputFingerprint } = input;
  if (dryRun)
    return {
      books: safe.books.length,
      baseRevision,
      baseRevisionKind: "input-books-sha256",
      inputFingerprint,
    };
  const ownerToken = randomUUID();
  const lease = resume
    ? await db.query(
        "UPDATE catalog_imports SET owner_token=?,updated_at=? WHERE scope=? AND state='active' AND input_hash=? RETURNING scope",
        [ownerToken, now, scope, inputFingerprint],
      )
    : await db.query(
        "INSERT INTO catalog_imports(scope,input_hash,base_hash,owner_token,state,book_count,patch_count,seeded_overrides,started_at,updated_at) VALUES (?,?,?,?,'active',?,?,0,?,?) ON CONFLICT(scope) DO UPDATE SET input_hash=excluded.input_hash,base_hash=excluded.base_hash,owner_token=excluded.owner_token,state='active',book_count=excluded.book_count,patch_count=excluded.patch_count,seeded_overrides=0,started_at=excluded.started_at,updated_at=excluded.updated_at WHERE catalog_imports.state='complete' RETURNING scope",
        [
          scope,
          inputFingerprint,
          baseRevision,
          ownerToken,
          safe.books.length,
          patches.length,
          now,
          now,
        ],
      );
  if (lease.length !== 1)
    fail(resume ? "catalog_import_resume_mismatch" : "catalog_import_active");
  const patchMap = new Map(patches);
  // Every staging write is fenced by a BEFORE INSERT/UPDATE trigger. A resumed
  // lease rotates the token; a delayed old writer cannot write or publish again.
  for (let start = 0; start < safe.books.length; start += 15) {
    const books = safe.books.slice(start, start + 15);
    const rows = await db.query(
      `INSERT INTO catalog_import_rows(scope,input_hash,book_id,public_json,patch_json,writer_token) VALUES ${books.map(() => "(?,?,?,?,?,?)").join(",")} ON CONFLICT(scope,book_id) DO UPDATE SET input_hash=excluded.input_hash,public_json=excluded.public_json,patch_json=excluded.patch_json,writer_token=excluded.writer_token RETURNING book_id`,
      books.flatMap((b) => [
        scope,
        inputFingerprint,
        b.id,
        JSON.stringify(b),
        patchMap.has(b.id) ? JSON.stringify(patchMap.get(b.id)) : null,
        ownerToken,
      ]),
    );
    if (rows.length !== books.length) fail("catalog_import_fenced");
  }
  // The completion trigger checks staging cardinality and publishes the whole
  // base, insert-if-absent overrides, and matching hash in this one transaction.
  const committed = await db.query(
    "UPDATE catalog_imports SET state='complete',updated_at=? WHERE scope=? AND input_hash=? AND owner_token=? AND state='active' RETURNING scope",
    [now, scope, inputFingerprint, ownerToken],
  );
  if (committed.length !== 1) fail("catalog_import_fenced");
  const [completed] = await db.query(
    "SELECT state,input_hash,seeded_overrides FROM catalog_imports WHERE scope=?",
    [scope],
  );
  if (
    completed?.state !== "complete" ||
    completed.input_hash !== inputFingerprint
  )
    fail("catalog_import_outcome_unknown");
  return {
    books: safe.books.length,
    seededOverrides: completed.seeded_overrides,
    preservedOverrides: patches.length - completed.seeded_overrides,
    baseRevision,
    baseRevisionKind: "input-books-sha256",
    inputFingerprint,
  };
}

export async function makeFilePlan(
  manifest,
  fileId,
  evidence,
  accountId,
  { now = nowMs(), scope = "production", budgetState } = {},
) {
  const { data, ...file } = await selectedFile(manifest, fileId, { scope });
  let observation,
    blockedReason = null;
  try {
    observation = accountEvidence(evidence, accountId, now);
  } catch (error) {
    if (!(error instanceof LibraryError)) throw error;
    blockedReason = error.code;
  }
  // A local-only dry run does not know the authoritative D1 ledger. Never treat
  // missing committed/reserved bytes as zero or assume metrics include commits.
  const knownBudget =
    observation && budgetState
      ? conservativeStorageBudget(
          observation.observedBytes,
          budgetState.committedBytes,
          budgetState.reservedBytes,
          file.sizeBytes,
          budgetState.ceilingBytes ?? CEILING,
        )
      : null;
  const observedFloor = observation
    ? conservativeStorageBudget(observation.observedBytes, 0, 0, file.sizeBytes)
    : null;
  if (knownBudget?.admitted === false || observedFloor?.admitted === false)
    blockedReason = "storage_budget_exceeded";
  return {
    schemaVersion: 1,
    dryRun: true,
    file,
    budget: {
      ceilingBytes: budgetState?.ceilingBytes ?? CEILING,
      accountObservedBytes: observation?.observedBytes ?? null,
      committedBytes: budgetState?.committedBytes ?? null,
      reservedBytes: budgetState?.reservedBytes ?? null,
      requestedBytes: file.sizeBytes,
      projectedBytes: knownBudget?.projectedBytes ?? null,
      admissionFormula: STORAGE_ADMISSION,
      overlapDeductedBytes: 0,
      existingReservationsChecked: Boolean(budgetState),
    },
    uploadAllowed: false,
    blockedReason: blockedReason || "atomic_reservation_required",
    createdAt: new Date(now).toISOString(),
  };
}

export async function reserve(
  db,
  scope,
  accountId,
  file,
  evidence,
  now = nowMs(),
  { clock = () => now } = {},
) {
  const observation = accountEvidence(evidence, accountId, now);
  const prefix =
    scope === "production"
      ? "books/cf03"
      : scope === "check"
        ? "cf03-check"
        : fail("invalid_scope");
  if (
    !validId(file.fileId) ||
    !validId(file.bookId) ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 0 ||
    file.sizeBytes > LIMIT ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !["EPUB", "PDF"].includes(file.format) ||
    file.objectKey !==
      `${prefix}/${file.fileId}/${file.sha256}.${file.format.toLowerCase()}`
  )
    fail("invalid_file_plan");
  // Never reset accounting or replace fresher evidence; the reservation INSERT
  // trigger adds observed + committed + reserved + requested. Delayed account
  // metrics never justify subtracting a guessed overlap with confirmed uploads.
  const [catalogRow] = await db.query(
    "SELECT public_json FROM catalog_books WHERE scope=? AND book_id=?",
    [scope, file.bookId],
  );
  const catalogFile =
    catalogRow &&
    publicBook(JSON.parse(catalogRow.public_json)).files.find(
      (f) => f.id === file.fileId,
    );
  if (
    !catalogFile ||
    catalogFile.format !== file.format ||
    catalogFile.sizeBytes !== file.sizeBytes ||
    catalogFile.status !== "candidate"
  )
    fail("file_catalog_mismatch");
  await db.query(
    "INSERT INTO storage_state(id,account_id,observed_account_bytes,observed_at,ceiling_bytes,reserved_bytes,committed_bytes,evidence_hash,evidence_complete,updated_at) VALUES (1,?,?,?, ?,0,0,?,1,?) ON CONFLICT(id) DO UPDATE SET observed_account_bytes=excluded.observed_account_bytes,observed_at=excluded.observed_at,evidence_hash=excluded.evidence_hash,evidence_complete=1,updated_at=excluded.updated_at WHERE storage_state.account_id=excluded.account_id AND (storage_state.observed_at<excluded.observed_at OR storage_state.observed_at=excluded.observed_at AND storage_state.evidence_hash=excluded.evidence_hash)",
    [
      accountId,
      observation.observedBytes,
      observation.observedAt,
      CEILING,
      observation.evidenceSha256,
      now,
    ],
  );
  const [state] = await db.query(
    "SELECT account_id,observed_at,evidence_hash FROM storage_state WHERE id=1",
  );
  if (
    !state ||
    state.account_id !== accountId ||
    state.observed_at !== observation.observedAt ||
    state.evidence_hash !== observation.evidenceSha256
  )
    fail("account_storage_conflict");
  const reservationId = randomUUID();
  const admissionTime = clock();
  accountEvidence(evidence, accountId, admissionTime);
  await db.query(
    "INSERT INTO upload_reservations(reservation_id,scope,file_id,book_id,object_key,size_bytes,format,sha256,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'reserved',?,?)",
    [
      reservationId,
      scope,
      file.fileId,
      file.bookId,
      file.objectKey,
      file.sizeBytes,
      file.format,
      file.sha256,
      admissionTime,
      admissionTime,
    ],
  );
  const [reservation] = await db.query(
    "SELECT * FROM upload_reservations WHERE reservation_id=? AND scope=?",
    [reservationId, scope],
  );
  if (!reservation) fail("reservation_outcome_unknown");
  return reservation;
}

async function pending(db, scope, fileId) {
  if (!validId(fileId)) fail("invalid_file_selection");
  const rows = await db.query(statements.reservations, [scope, fileId]);
  if (rows.length !== 1)
    fail(rows.length ? "reservation_conflict" : "reservation_missing");
  return rows[0];
}

export async function reconcile(db, scope, fileId, r2, { now = nowMs() } = {}) {
  const reservation = await pending(db, scope, fileId);
  if (reservation.state === "confirmed")
    return { state: "confirmed", fileId, alreadyConfirmed: true };
  if (!["reserved", "uploading", "uncertain"].includes(reservation.state))
    fail("reservation_conflict");
  const head = await r2.head(reservation.object_key);
  // A 404 after a lost PUT is not sufficient to prove a delayed write will never arrive.
  if (!head)
    return {
      state: reservation.state,
      fileId,
      blockedReason: "object_absence_unresolved",
    };
  if (
    head.size !== reservation.size_bytes ||
    head.sha256 !== reservation.sha256 ||
    !head.etag
  )
    fail("object_identity_mismatch");
  const bytes = await r2.get(reservation.object_key, reservation.size_bytes);
  if (
    bytes.length !== reservation.size_bytes ||
    hash(bytes) !== reservation.sha256
  )
    fail("object_hash_mismatch");
  const after = await r2.head(reservation.object_key);
  if (
    !after ||
    after.size !== head.size ||
    after.sha256 !== head.sha256 ||
    after.etag !== head.etag
  )
    fail("object_changed");
  await db.query(
    "UPDATE upload_reservations SET state='confirmed',etag=?,content_verified=1,updated_at=? WHERE reservation_id=? AND scope=? AND state IN ('reserved','uploading','uncertain')",
    [head.etag, now, reservation.reservation_id, scope],
  );
  const [confirmed] = await db.query(
    "SELECT state FROM upload_reservations WHERE reservation_id=? AND scope=?",
    [reservation.reservation_id, scope],
  );
  if (confirmed?.state !== "confirmed") fail("confirmation_outcome_unknown");
  return { state: "confirmed", fileId, sha256: reservation.sha256 };
}

export async function uploadOne(
  db,
  scope,
  accountId,
  manifest,
  fileId,
  evidence,
  r2,
  { persist = async () => {}, now = nowMs(), clock = () => now } = {},
) {
  const file = await selectedFile(manifest, fileId, { scope });
  accountEvidence(evidence, accountId, clock());
  if ((await db.query(statements.reservations, [scope, fileId])).length)
    fail("upload_pending_reconcile_required");
  if (await r2.head(file.objectKey)) fail("object_exists_reconcile_required");
  const reservation = await reserve(
    db,
    scope,
    accountId,
    file,
    evidence,
    clock(),
    { clock },
  );
  await persist({
    reservationId: reservation.reservation_id,
    fileId,
    state: "reserved",
    objectKey: file.objectKey,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  });
  // Reopen and hash immediately before PUT, using the same durable reservation identity.
  const current = await selectedFile(manifest, fileId, { scope });
  if (current.sha256 !== file.sha256) fail("file_changed");
  const rows = await db.query(
    "UPDATE upload_reservations SET state='uploading',updated_at=? WHERE reservation_id=? AND scope=? AND state='reserved' RETURNING reservation_id",
    [nowMs(), reservation.reservation_id, scope],
  );
  if (rows.length !== 1) fail("reservation_conflict");
  try {
    await persist({
      reservationId: reservation.reservation_id,
      fileId,
      state: "uploading",
      objectKey: file.objectKey,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    });
    await r2.put(file.objectKey, current.data, {
      sha256: file.sha256,
      format: file.format,
    });
    const result = await reconcile(db, scope, fileId, r2);
    await persist({ reservationId: reservation.reservation_id, ...result });
    return result;
  } catch (error) {
    try {
      await db.query(
        "UPDATE upload_reservations SET state='uncertain',updated_at=? WHERE reservation_id=? AND scope=? AND state IN ('reserved','uploading')",
        [nowMs(), reservation.reservation_id, scope],
      );
    } catch {
      /* Its existing state still holds the full reservation. */
    }
    try {
      await persist({
        reservationId: reservation.reservation_id,
        fileId,
        state: "uncertain",
        noAutomaticRetry: true,
      });
    } catch {
      /* D1 remains the authority. */
    }
    throw new LibraryError(
      error instanceof LibraryError ? error.code : "upload_outcome_unknown",
    );
  }
}

export function mergeBooks(rows, confirmed) {
  const bases = rows.map((row) => {
    const base = publicBook(JSON.parse(row.public_json));
    const stored = row.patch_json ? JSON.parse(row.patch_json) : {};
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      Object.keys(stored).some(
        (k) =>
          ![
            "title",
            "author",
            "description",
            "category",
            "tags",
            "categoryId",
          ].includes(k),
      )
    )
      fail("invalid_metadata");
    const { categoryId, ...input } = stored;
    const patch = metadataPatch(input);
    if (categoryId !== undefined) {
      if (!validId(categoryId) || !patch.category) fail("invalid_metadata");
      patch.categoryId = categoryId;
    }
    return { base, patch };
  });
  const categories = new Map(
    bases.map(({ base }) => [base.category, base.categoryId]),
  );
  return bases.map(({ base, patch }) => {
    if (patch.category && !patch.categoryId)
      patch.categoryId =
        categories.get(patch.category) ||
        `cat-${hash(patch.category).slice(0, 12)}`;
    return publicBook(mergePublicBook(base, patch, confirmed));
  });
}

export async function snapshot(
  db,
  scope,
  { attempts = 3, pageSize = 100, now = nowMs() } = {},
) {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > 3 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    fail("invalid_snapshot_options");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [start] = await db.query(
      "SELECT s.revision,i.state AS import_state FROM public_state s LEFT JOIN catalog_imports i ON i.scope=s.scope WHERE s.scope=?",
      [scope],
    );
    if (!Number.isSafeInteger(start?.revision)) fail("public_state_missing");
    if (start.import_state === "active") fail("catalog_import_incomplete");
    const rows = [];
    let cursor = "";
    while (true) {
      const page = await db.query(
        "SELECT b.book_id,b.public_json,o.patch_json FROM catalog_books b LEFT JOIN metadata_overrides o ON o.scope=b.scope AND o.book_id=b.book_id WHERE b.scope=? AND b.book_id>? ORDER BY b.book_id LIMIT ?",
        [scope, cursor, pageSize],
      );
      if (
        page.length > pageSize ||
        page.some(
          (row, i) =>
            !validId(row.book_id) ||
            row.book_id <= (i ? page[i - 1].book_id : cursor),
        )
      )
        fail("invalid_snapshot_page");
      rows.push(...page);
      if (rows.length > 100_000) fail("snapshot_too_large");
      if (page.length < pageSize) break;
      cursor = page.at(-1).book_id;
    }
    const confirmed = await db.query(
      "SELECT file_id,book_id,format,size_bytes,state FROM file_registry WHERE scope=? AND state='confirmed'",
      [scope],
    );
    const [end] = await db.query(
      "SELECT s.revision,i.state AS import_state FROM public_state s LEFT JOIN catalog_imports i ON i.scope=s.scope WHERE s.scope=?",
      [scope],
    );
    if (end?.import_state === "active") fail("catalog_import_incomplete");
    if (start.revision !== end?.revision) continue;
    return {
      catalog: publicCatalog(
        { books: mergeBooks(rows, confirmed) },
        { now: new Date(now) },
      ),
      sourceRevision: start.revision,
    };
  }
  fail("snapshot_revision_changed");
}

const contentHash = (catalog) =>
  hash(JSON.stringify({ ...catalog, generatedAt: undefined }));
export async function saveSnapshot(
  result,
  root,
  {
    staging = path.join(root, ".local/cf03/snapshot.json"),
    output = path.join(root, "data/catalog.json"),
    secrets = [],
  } = {},
) {
  if (path.resolve(output) !== path.resolve(root, "data/catalog.json"))
    fail("snapshot_output_target");
  const safe = publicCatalog(result.catalog, {
    now: new Date(result.catalog.generatedAt),
    secrets,
  });
  await writePrivateJson(
    staging,
    { sourceRevision: result.sourceRevision, catalog: safe },
    root,
  );
  let previous;
  try {
    const stat = await fs.lstat(output);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("snapshot_output_target");
    previous = JSON.parse(await fs.readFile(output, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (previous && contentHash(previous) === contentHash(safe))
    return { changed: false, sourceRevision: result.sourceRevision };
  const directory = await fs.lstat(path.dirname(output));
  if (!directory.isDirectory() || directory.isSymbolicLink())
    fail("snapshot_output_target");
  const temporary = path.join(
    path.dirname(output),
    `.catalog.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(JSON.stringify(safe, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, output);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { changed: true, sourceRevision: result.sourceRevision };
}
