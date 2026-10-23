# First book single trial authority contract

This exception is the user's 2026-10-23 first fixed book approval. It waives unknown account usage and old request closure only for one original production PDF/EPUB of at most 20,000,000 bytes. It does not certify actual total storage below 8 GB, clear any unknown, enable ordinary uploads, or change billing.

SQL005 adds `shelf_storage_single_trial` to the existing production D1 authority. Its sole row is both the irrevocable permit and additional reservation. Its triggers update the existing `shelf_storage_authority.reserved_bytes` and `committed_bytes`; they do not create another balance. Known committed/reserved liabilities plus this file must still fit 8,000,000,000 bytes. Old imported reservations, staging, sources, guards, receipts and evidence remain intact. The phase stays imported and cannot advance while the singleton exists.

The immutable target is `{accountId: existingAuthority.accountId, bucket: "the-shelf-first-book-20261023"}`. The old bucket identity in the authority is unchanged. The operator must actually verify the new private bucket and binding isolation; `isolatedTargetConfigSha256` is only a configuration fingerprint, never self-certified proof of isolation. No old credential or Worker binding is restored.

`singleTrialPermit(value, identity, now)` validates exactly:

```
{schemaVersion:1, permitId, consentId:"2026-10-23-first-book",
 target:{accountId,bucket:"the-shelf-first-book-20261023"},
 descriptor, isolatedTargetConfigSha256, issuedAt, expiresAt}
```

`descriptor` is the existing canonical original/production descriptor with PDF/EPUB format, fixed file/book/hash/key/size and null versionHash/source. The maximum permit duration is 24 hours. Issuance must be within five minutes of the server clock and unexpired. Expiry blocks claiming, while read-only reconciliation and reading remain possible after expiry. An expired reserved row remains permanently occupied and accounted for.

The Node `RemoteStorageAuthority` has these explicit methods:

- `issueSingleTrial(identity, permit)` performs a single INSERT; lost response requires inspection, never replay.
- `inspectSingleTrial(identity)` returns null or `{permit,state,putAttempted,contentVerified,etag,updatedAt}`.
- `claimSingleTrialPut(identity, permitId, descriptor, bytes)` validates bytes before a durable CAS. Only successful completion grants dispatch; response loss consumes the claim. The production binding transport instead performs this CAS directly in the Worker immediately before its only `BOOKS.put`; the local operator must not claim first.
- `markSingleTrialUncertain(identity, permitId)` retains the reservation.
- `reconcileSingleTrial(identity, permitId, store)` requires an already claimed row and the exact isolated target. It verifies HEAD, full hash GET, and final HEAD, then confirms in D1. Missing/corrupt/unknown storage retains all bytes. It never PUTs or deletes.

The claim statement agreed with the Worker is:

```sql
UPDATE shelf_storage_single_trial SET state='uploading',put_attempted=1,updated_at=?
WHERE id=1 AND permit_id=? AND descriptor_json=? AND state='reserved'
AND put_attempted=0 AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
RETURNING id
```

A process crash after the CAS but before PUT may leave no object and a permanently consumed claim. A lost PUT response or uncertain confirmation may only use bounded same-object read-only recovery; neither case permits a second PUT, replacement key, clearing the row, or automatic deletion. The singleton INSERT guard also rejects `INSERT OR REPLACE` before it can reset occupancy.

Legacy authority clients retain their request behavior by default. Constructor `singleTrial:true` or a dedicated trial method explicitly enables exact SQL005 schema verification and combined audits. Missing SQL005 is supported for old default clients; partial/drifted SQL005 is rejected by opted-in clients. Old clients cannot validate an occupied trial ledger and therefore fail closed rather than hiding its reservation.

SQL006 replaces `admission_private` while preserving the original session/generation/enabled checks and legacy registry behavior. The additional access path requires the confirmed verified singleton and an exact production catalog candidate id/format/size. It must be applied only while the API is absent/disabled and auth enabled=0; no REST multi-statement transaction guarantee is assumed. A failed or unknown DROP/CREATE stops deployment. Exact independent trigger readback is required before API deployment or enabling auth. A partial replacement needs a new reviewed repair; it must not be automatically replayed.

The singleton itself is the runtime registry. It never projects an isolated object into old `file_registry`, whose rows imply the old bucket. Runtime reads must use explicit single-trial mode, fixed isolated `BOOKS` binding, exact target/descriptor checks and the existing private session/CSRF/Range protections. Turning the API off and revoking sessions is the rollback; all permit/object/reservation/history records are retained.

Offline tests use real SQLite and separate connections for issue/claim competition; they cover loss of issuance/claim/confirmation responses, crash recovery, expiry, malformed bindings, NULL/replacement attempts, corrupted content, unchanged imported unknown history and private admission checks. These tests do not establish real bucket isolation, cloud upload, deployed reading or browser acceptance.
