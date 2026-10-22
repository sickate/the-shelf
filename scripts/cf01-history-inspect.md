# CF01 local history inspection

This operator inspects only the fixed local `.local/cf01/evidence.json`. It fills
the old audit's collection gap: every request is retained, including a pending
or uncertain `POST /v1/runs` without a response run ID. It does not establish
complete history, provider completion, a closed writer, or drained execution.
`readyEligible`, `drainProven`, and `uploadAllowed` are always `false`.

```sh
node scripts/cf01-history-inspect.mjs
# After implementation acceptance, explicitly inspect the fixed private file:
node scripts/cf01-history-inspect.mjs --execute
```

The default preview performs no filesystem/configuration/network operations.
`--execute` performs zero network requests, never loads `.env`, and reads no
other project input. There is no custom input path, endpoint, force option, or
ready integration. The original evidence is never rewritten, trimmed, confirmed,
or repaired. Do not retry any historical cloud mutation based on this report.

Execution requires existing `.local` and `.local/cf01` directories owned by the
current user with mode `0700`, and a current-user-owned regular evidence file
with mode `0600` and one hardlink. The shared frozen private-store helper pins
ancestor directories and the input file, uses `O_NOFOLLOW`, and checks identities
again before and after reading and saving. Symlinks, hardlinks, replacement,
permission drift, malformed input, unknown finite enums, and unexpected fields
fail closed with fixed errors. Input is limited to 1,000,000 bytes, 512 local run
records, and 512 requests; the read itself is bounded. Missing or unsafe paths
are rejected rather than created or repaired. UTF-8 replacement glyphs are
rejected conservatively so the stored input digest cannot describe lossy decoding.

The terminal prints only numeric summary counts, fixed metadata, and the three
false flags. A separate `history-inspect-<new UUID>.json` receipt is written in
the already-private CF01 directory with mode `0600`, using the shared fsync/rename
store. It includes the input digest and size, the safe run/request projection,
and the same summary and false flags. Original run UUIDs, full paths, origins,
timestamps, response errors, Workflow output, and `result_json` are absent.
Run association hashes exist only in this private receipt, never the summary.
The generated receipt UUID does not identify a historical run. Keep the receipt
private; this document and the new tool are outside public document exports.

Request `index` is the original zero-based array index. Methods are limited to
`POST`, `GET`, and `DELETE`; path classes are `runs_collection` and `run_item`.
`pending` stays pending, `uncertain_no_resend` becomes `unknown`, and a recorded
HTTP response stays `response` with its numeric status. A response alone does
not prove successful work. A response `run.kind`/`run.state` is a finite observed
classification; no result payload is interpreted.

Association comes only from an explicit item-path UUID or `data.run.run_id`;
conflicting explicit IDs fail. The tool never guesses a missing POST body from
time, request order, label, a nearby local run record, or a later response.
Unattributed requests remain present. `localRunMatched` means only that an
explicit ID appeared in the local runs array; it is not a completeness claim.
Generic crypto/Workflow records are validated for the finite projection and
then discarded. Opaque `result_json` strings are never parsed; malformed JSON
inside that string does not prevent preserving a safe request classification.

`unresolvedStarts` and `unresolvedMutations` count pending/unknown transport
outcomes, with mutations limited to POST/DELETE. `failedResponses` counts HTTP
statuses at least 400. `storageCompletedResponses` counts successful HTTP
responses that reported storage/completed, without verifying their payloads.
`cleanupResponses` counts successful DELETE responses with both cleanup flags;
neither count is an independent provider receipt or a drain proof. Repeated
responses remain separate observations and are not deduplicated into operations.
Zero counters never turn unknown history into a complete or empty history.

Hermetic checks use synthetic temporary evidence only:

```sh
node --test tests/cf01-history-inspect.test.mjs
```

The collector does not alter legacy audit interpretation, SQL guards, authority
state, ready sources, historical unknown records, or production resources. On
failure preserve the original evidence and existing deployment. There is no
cloud rollback or cloud write to replay; an independent diagnostic receipt may
be retained for review without changing historical outcomes.
