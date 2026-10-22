# Legacy storage write freeze

The old local `server/upload.mjs --execute`, `cf-library upload --execute`, and `cf-library reconcile --execute` commands permanently fail with `legacy_storage_migration_required` before loading project configuration or touching source files, D1, R2, or private receipts. There is no force flag or fallback. The exported legacy reservation/upload/reconciliation functions and old R2 adapter `put` also refuse immediately.

CF01 storage admission and `storageProbe` refuse before D1/R2 operations. Historical diagnostic reads and terminal cleanup remain available. Dry planning, catalog bootstrap, snapshots, other backend functions, and crypto/Workflow diagnostics retain their existing behavior.

Existing local reservations, uncertain outcomes, manifests, source files, and D1 legacy rows are retained. A refusal never releases or confirms a pending reservation. Only the new remote storage authority may handle new writes after its independent migration and deployment acceptance; this freeze does not establish that acceptance. Do not restore legacy writes as a rollback. Keep reads and the existing static deployment available if migration acceptance fails.

This operator document is excluded from the fixed public documentation export list. Tests create synthetic historical SQLite rows directly to verify retained ledger/cleanup behavior; no production override exists.
