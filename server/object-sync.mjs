/** Recoverable single-object protocol; no credentials, HTTP client, CLI or retry loop. */
import {
  StorageError,
  validateObjectBytes,
  objectContentType,
  snapshotObjectStore,
} from "./storage-authority.mjs";

export async function syncObject({
  authority,
  identity,
  reservationId,
  descriptor,
  bytes,
  evidence,
  store,
}) {
  // Pin all caller-owned inputs before any await, including evidence and target.
  const pinnedIdentity = structuredClone(identity),
    pinnedEvidence = structuredClone(evidence);
  const pinnedStore = snapshotObjectStore(pinnedIdentity, store);
  const validatedPromise = validateObjectBytes(descriptor, bytes);
  const validated = await validatedPromise;
  let reservation;
  try {
    reservation = await authority.reserve(
      pinnedIdentity,
      reservationId,
      validated.descriptor,
      validated.bytes,
      pinnedEvidence,
    );
    if (reservation.state === "confirmed") return reservation;
    if (reservation.state !== "reserved" || reservation.putAttempted)
      return await authority.reconcile(
        pinnedIdentity,
        reservationId,
        pinnedStore,
      );
    // Existing objects are verified, never overwritten or treated as a successful PUT.
    if ((await pinnedStore.head(validated.descriptor.objectKey)) !== null)
      return await authority.reconcile(
        pinnedIdentity,
        reservationId,
        pinnedStore,
      );
    await authority.claimPut(pinnedIdentity, reservationId);
    // The durable CAS precedes the only PUT. Losing this response never retries it.
    await pinnedStore.put(
      validated.descriptor.objectKey,
      Uint8Array.from(validated.bytes),
      {
        ifNoneMatch: "*",
        sha256: validated.descriptor.sha256,
        contentType: objectContentType(validated.descriptor),
      },
    );
    return await authority.reconcile(
      pinnedIdentity,
      reservationId,
      pinnedStore,
    );
  } catch (error) {
    if (reservation) {
      try {
        await authority.markUncertain(pinnedIdentity, reservationId);
      } catch {
        /* Original durable state retains the full reservation. */
      }
    }
    throw error instanceof StorageError
      ? error
      : new StorageError("object_sync_unknown");
  }
}
