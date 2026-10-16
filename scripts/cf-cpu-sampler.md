# CF-03 fixed check sampler API

This stage supplies an importable controller and a real `node:http2` transport.
**There is no live Cloudflare management adapter or cloud CLI.** Running the
module alone does nothing. No code discovers credentials, reads `.env`, scans
`.local`, deploys a Worker, uploads to R2, profiles, or calls AI. A future cloud
run requires a separately reviewed management adapter and a new bounded plan;
the closed historical round in `docs/cf03-plan.md` is not reusable authority.

## Plan and dry run

```js
import { runSampler, CHECK, MANAGEMENT_COMMANDS } from "./cf-cpu-sampler.mjs";
const costs = Object.fromEntries(
  [
    "business",
    ...Object.keys(MANAGEMENT_COMMANDS).filter(
      (k) => MANAGEMENT_COMMANDS[k] === "d1",
    ),
  ].map((k) => [k, { rowsRead: 1000, rowsWritten: 100 }]),
);
// Example cost values are illustrative, NOT a live schema cost assessment.
const plan = {
  schemaVersion: 1,
  scope: "check",
  workerName: CHECK.name,
  origin: CHECK.origin,
  versionId: "11111111-2222-4333-8444-555555555555",
  deployConfig: {
    schemaVersion: 1,
    profiles: {
      check: {
        databaseId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        databaseName: CHECK.databaseName,
      },
      production: {
        databaseId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
        databaseName: "the-shelf-library",
      },
    },
  },
  limits: {
    business: 42,
    management: 30,
    d1: 20,
    analytics: 9,
    rowsRead: 100000,
    rowsWritten: 15000,
  },
  costs,
  timeoutMs: 30000,
  spacingMs: 1100,
  analyticsAttempts: 3,
};
const preview = await runSampler({ plan }); // No filesystem/network access.
```

The check and production DB IDs must differ. Every actual management response
must match the fixed check identity. The plan rejects insufficient totals before
any external call. Limits are per new run, not daily renewable allowances; the
controller refuses an existing receipt and cannot resume/retry a mutation.
The operator must supply verified unused limits from a separately persisted
round ledger. This controller cannot detect another runner spending that ledger.

`costs.business` is a schema-reviewed conservative bound **per business HTTP**,
including crypto-route DB work and possible full maintenance. Each D1 command's
cost is its worst-case complete query batch, including triggers, fixture creation
and indexes. Two maintenance batches are seeded (128/16/256/64 historical rows),
while each actual cleanup still has limits 64/8/128/32. The controller reserves
worst-case rows before calls, checks D1 management actual meta against each bound,
and records actual management meta separately. Business D1 actual meta is not
available through the unchanged HTTP API; reserved business costs are not reported
as platform-measured rows. A live adapter must assess these bounds against the
current schema before execute; illustrative values above are not evidence.

## Explicit execute injection

```js
import { connectSamplerH2 } from "./cf-cpu-sampler-h2.mjs";
const result = await runSampler({
  plan,
  execute: true,
  accessKey: explicitlyLoadedCheckKey,
  environment: originalOperatorEnvironment,
  receipt: { root: projectRoot, file: newAbsolutePrivateReceiptPath },
  signal: abortController.signal,
  adapters: { manage: reviewedManagementAdapter, connect: connectSamplerH2 },
});
```

Callers supply credentials only through closure/in-memory values, never argv or
logs. No credential is passed to management operations by the controller.
Pass the original environment to the execute gate before sanitizing any child
process environment. `samplerEnvironment(originalEnv, privateRunDirectory)` reuses
the project's minimal allowlist and rejects CI markers; unlike the deployment
helper, it does not inject `CI=true`. `baseEnvironment` output passed directly to
execute is rejected. Do not sanitize away a CI marker to bypass the gate.

The receipt must be a new file below an existing 0700 `.local` directory tree;
parent/target symlinks and existing files are rejected before cloud access.
Writes are serialized, atomic, 0600. Reservations are persisted before requests.
The CAS pair is prepared and persisted together, then both streams open without
an intervening filesystem await on the same already used H2 session. The
transport checks the fixed origin, allowlisted paths, TLS/ALPN, redirects, size
and timeouts. It never reconnects or retries. One connection covers both rounds;
neither round promises a cold isolate or same-isolate reuse.

Every injected operation must honor its AbortSignal. Controller deadlines also
stop awaiting an unresponsive adapter, but cannot force external work inside an
adapter to stop. A reviewed live adapter must not dispatch work after abort.
Mutations that time out have unknown outcomes and are never replayed. Cleanup
uses an independent signal and four reserved management calls, attempting all
four even if one fails. Receipt write failure stops sampling but does not prevent
in-memory-budgeted cleanup; the returned result flags `receiptFailure`. A process
kill/power failure cannot execute JavaScript finally: the operator must use the
persisted target/ledger and the documented check shutdown procedure.

Optional `adapters.clock = { now, sleep }` supports deterministic tests.
Optional `adapters.beforeCheckpoint(snapshot)` receives only sanitized data and
can inject storage faults in tests; the private writer still enforces its checks.

## Management adapter contract

`manage(command, { target, payload, signal })` returns `{ data, meta? }`.
`target` contains only the fixed check profile, independently configured check
DB ID and planned deployed version. **One call means at most one management HTTP
request**; a D1 command can contain one provider query batch. No hidden retries,
resource enumeration, extra HTTP probes, generic SQL/URL forwarding, deployment,
settings/log/profile changes or production operations are permitted. If the
platform cannot satisfy a command in one request, redesign/rebudget and review
before executing. Each D1 query response must return summed batch meta
`{ rowsRead, rowsWritten }`, normalized from provider `rows_read/rows_written`.
Provider errors/response bodies are not returned as public error strings.

| Command                   | Payload                                                    | Required `data` and action                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspectVersion`          | none                                                       | `{versionId}` from the actual single 100% deployed version; never `latest`. Called before mutation and after each round.                                                                                                                                                                                                                                   |
| `inspectDatabaseIdentity` | none                                                       | One D1 database metadata GET; `{databaseId,databaseName}` must match the configured check DB. Counts as one D1 management call, with no query row meta.                                                                                                                                                                                                    |
| `inspectDatabase`         | none                                                       | One D1 query batch reads schema/002 and check auth; `{scope:'check',origin,schemaVersion:2,authEnabled:false,generation,activeSessions:0}`. No Worker facts are inferred from SQL.                                                                                                                                                                         |
| `inspectEntry`            | none                                                       | One Worker subdomain GET; `{enabled:false,previewsEnabled:false}` before enabling auth.                                                                                                                                                                                                                                                                    |
| `enableAuth`              | `{expectedGeneration}`                                     | Conditional enable of check auth only, increment generation, return `{enabled:true,generation:expectedGeneration+1}`.                                                                                                                                                                                                                                      |
| `seedMaintenance`         | `{limits,batches:2}`                                       | Insert only reviewed old check synthetic fixtures under normal triggers; return `{counts:{admissions,daily,minute,sessions}}`, each at least twice its limit. Never decrement real current day/minute counters or delete admissions to regain capacity.                                                                                                    |
| `enableEntry`             | none                                                       | Enable fixed check workers.dev with previews disabled; `{enabled:true,previewsEnabled:false}`. Controller waits 30 seconds before its first business HTTP.                                                                                                                                                                                                 |
| `prepareRound`            | `{round,bookId,fileId,expectedGeneration,unknownCategory}` | Insert the fixed synthetic book with existing nonuploaded file semantics and Tests base category. Plain INSERT must reject any existing fixture, override or inconsistent state; no upsert/reset of metadata or counters. Return `{fixtureInserted:1,metadataVersion:0,...beforeSnapshot}`.                                                                |
| `rotateGeneration`        | `{expectedGeneration}`                                     | Conditional check auth generation increment, normal revocation trigger intact; `{generation:expectedGeneration+1}`. It runs between HTTP 20 and HTTP 21.                                                                                                                                                                                                   |
| `readCoverage`            | `{round,cutoff,day,bookId}`                                | Read the after snapshot below after all 21 HTTP requests, plus `{sessionRows,hashedSessionRows}` for all check sessions.                                                                                                                                                                                                                                   |
| `analytics`               | `{window,from,to,expectedRequests,requests}`               | Fixed script/version/window GraphQL request returning the existing `analyzeCpuEvidence` input shape (provider microseconds, sampling, aggregate, groups). All three windows are fixed before reads: first-access, subsequent, combined. The controller supplies authoritative requests, scope/version and query bounds. No request/body/secret dimensions. |
| `closeAuth`               | none                                                       | Disable check auth, monotonically increment generation, revoke sessions through normal trigger; `{enabled:false,generation}` greater than the last known generation.                                                                                                                                                                                       |
| `verifyAuthClosed`        | none                                                       | Independent D1 read `{enabled:false,generation,activeSessions:0}`. Generation must equal closeAuth's returned value.                                                                                                                                                                                                                                       |
| `closeEntry`              | none                                                       | Disable check workers.dev and previews; `{enabled:false,previewsEnabled:false}`.                                                                                                                                                                                                                                                                           |
| `verifyEntryClosed`       | none                                                       | Independent entry read `{enabled:false,previewsEnabled:false}`.                                                                                                                                                                                                                                                                                            |

A before/after snapshot contains `{ordinal,metadataAdmissions,day,cutoff,maintenance}`.
`ordinal` is the real current UTC day's global `api_day` counter. `day` is its UTC
date; crossing a day is rejected. `metadataAdmissions` counts actual metadata
mutation admissions for this isolated round, with the same retained boundary in
both snapshots. `cutoff` identifies a fixed historical fixture-count cutoff;
maintenance counts cover the same old check rows and identical cutoff both times,
never wall-clock-dependent shifting subsets. `maintenance` has numeric counts
`{admissions,daily,minute,sessions}`. Keep all fixtures well beyond the real
expiration boundaries, retain the same predicates for both snapshots, and exclude
concurrent fixture mutation. Ordinary setup/API traffic must not alter old rows.
If a cutoff cannot be proved stable, return unavailable and stop.

The controller requires exactly 20 real API admissions per 21-request round
(cross-origin rejection precedes admission) and two additional metadata mutation
admissions. The latter proves the 409 was a true CAS loser. This check runs only
after the final generation-session HTTP; stale CAS cannot truncate request 21.
It derives maintenance ordinals at 1 or multiples of 32, validates exact numeric
before/after decreases and each per-trigger limit, and requires at least one full
batch across the two rounds. An HTTP 200 alone never proves maintenance.

The controller starts no observation tasks and never enables logs/tracing. It
cannot determine the absence of externally created profile/tail sessions from a
D1 query or a subdomain GET. Before any future cloud round, the reviewed run plan
must establish that no such activity is running, explicitly counting any platform
reads in that plan's external preflight ledger. That is a separate prerequisite,
not a hidden request inside these commands or an assertion fabricated by SQL.
The four shutdown calls only verify auth/sessions and entry; they do not claim to
inspect or stop unrelated observation activity.

The manager must use the unchanged normal schema/triggers and preserve authentic
consumption. It must not infer permission, absence of concurrent traffic, entry
state, fresh evidence, or free-account headroom from this controller's success.
No live manager is included precisely because those platform-specific facts still
need a separately reviewed implementation and bounded execution plan.

## Result interpretation and checks

`ok=true` means the complete HTTP/coverage collection and shutdown succeeded.
It does **not** mean CPU passed. `cpuGate` is separately `pass`, `fail` or `unknown`;
missing analytics remains unknown. Every higher CPU aggregate is retained by the
existing offline analyzer. At most three reads are made for each fixed window,
only after all 42 HTTP requests; mutations/business requests never retry.
Receipts contain fixed labels, timestamps, response length/hash, safe Date/Ray,
counts and numerical proofs. They contain no paths, actual URLs, request bodies,
access keys, cookies, CSRF or signed URLs. Unrecognized errors are sanitized.

Run `node --test tests/cf-cpu-sampler.test.mjs`. Tests include the actual Worker
with SQLite executing its real schema/triggers/crypto/CAS, deterministic D1 read
interleaving for both race participants, real 40 API admissions and full cleanup
batches at ordinals 1/32. That test supplies no cloud CPU evidence and must remain
`cpuGate=unknown`. Separate H2 tests exercise synchronous dual-stream creation,
TLS/ALPN, redirects, size and path guards without networking.
