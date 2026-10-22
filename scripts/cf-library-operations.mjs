import { createHash, randomUUID } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import {
  CEILING,
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

// Legacy reservations are historical read data. Only the remote authority may admit writes.
export async function reserve() {
  fail("legacy_storage_migration_required");
}
export async function reconcile() {
  fail("legacy_storage_migration_required");
}
export async function uploadOne() {
  fail("legacy_storage_migration_required");
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
