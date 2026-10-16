# CF-03 fixed check sampler API

The repository supplies an importable controller, a real `node:http2` business
transport and `createSamplerManager` for fixed Cloudflare management commands.
There is no cloud CLI. Importing/running these modules alone sends no requests.
Credentials are explicitly injected; no code discovers credentials, reads `.env`,
scans `.local`, deploys a Worker, uploads R2 objects, profiles or calls AI. A cloud
run still needs a separately reviewed operator, observation preflight and new
bounded plan. The closed historical round is not reusable authority.

## Plan and dry run

```js
import { runSampler, CHECK, MANAGEMENT_COMMANDS } from "./cf-cpu-sampler.mjs";
const costs = Object.fromEntries(
  [
    "business",
    "maintenance",
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
  analyticsDelayMs: 180000,
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
including ordinary route DB work. `costs.maintenance` separately bounds one full
maintenance batch; two batches are reserved and persisted after read-only
preflight and before the first mutation. Reserving full cleanup on every HTTP
would misrepresent the actual maximum of two triggers in 40 API admissions. Each D1 command's
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
The included manager checks only its documented fixed endpoints. Those other
platform-specific facts still need a separately reviewed operator and bounded
execution plan; its existence is not cloud acceptance.

## Result interpretation and checks

`ok=true` means the complete HTTP/coverage collection and shutdown succeeded.
It does **not** mean CPU passed. `cpuGate` is separately `pass`, `fail` or `unknown`;
missing analytics remains unknown. Every higher CPU aggregate is retained by the
existing offline analyzer. At most three reads are made for each fixed window,
only after all 42 HTTP requests and the explicit `analyticsDelayMs` wait
(0–300000ms). The wait is split into interruptible chunks and adds no requests.
Waiting reduces the risk of immature analytics but never guarantees completeness;
mutations/business requests never retry.
Receipts contain fixed labels, timestamps, response length/hash, safe Date/Ray,
counts and numerical proofs. They contain no paths, actual URLs, request bodies,
access keys, cookies, CSRF or signed URLs. Unrecognized errors are sanitized.

Run `node --test tests/cf-cpu-sampler.test.mjs`. Tests include the actual Worker
with SQLite executing its real schema/triggers/crypto/CAS, deterministic D1 read
interleaving for both race participants, real 40 API admissions and full cleanup
batches at ordinals 1/32. That test supplies no cloud CPU evidence and must remain
`cpuGate=unknown`. Separate H2 tests exercise synchronous dual-stream creation,
TLS/ALPN, redirects, size and path guards without networking.

## Fixed Cloudflare manager

```js
import {
  buildSamplerCostBasis,
  createSamplerManager,
  SAMPLER_SCHEMA_HASH,
} from "./cf-cpu-sampler-manager.mjs";
// Starting cardinality bounds come from separately budgeted read-only evidence.
// All project tables must be supplied. The sample dry-run costs above are NOT
// accepted by the manager: it requires these schema-derived costs exactly.
const basis = buildSamplerCostBasis(reviewedStartingTableBounds);
const managedPlan = { ...plan, costs: basis.costs };
const manager = createSamplerManager({
  accountId: explicitlyVerifiedProjectAccount,
  token: explicitlyLoadedProjectToken,
  plan: managedPlan,
  costBasis: {
    reviewed: true,
    schemaHash: SAMPLER_SCHEMA_HASH,
    maxRows: basis.maxRows,
  },
  runNonce: separatelyRecordedFreshRandom32HexCharacters,
  evidenceSink: privateProviderEvidenceSink,
});
// Persist manager.fixtureIdentity in the private operator plan/receipt as well.
// Connect the reviewed function to the controller, with the SAME managedPlan:
// adapters: { manage: manager.manage, connect: connectSamplerH2 }
```

The constructor validates the complete plan, fixed check identity, separate DBs,
account/token format, schema fingerprint and each cost number. Credentials must
already be verified for the project by the operator; syntax validation does not
establish account ownership. Cost comparison ignores JSON key order. No HTTP is
sent by construction. The public schema files are read and executed in an
in-memory SQLite database solely to obtain canonical project tables/indexes/
triggers; no private database is opened. `inspectDatabase` compares the actual
SQL for every project object, including extra indexes/triggers on project tables,
to that contract. `library_schema` legitimately has only version 1: migration 002
updates `reserve_upload` without inserting version 2. The returned
`schemaVersion:2` means the actual complete SQL matches the current schema plus
002, not that an invented migration ledger row was found. Current `schema.sql`
already includes 002's conservative trigger; merely omitting the migration file
does not create an old schema in tests.

All command payloads and target fields are exact allowlists. A manager is for one
run: mutations are marked attempted before dispatch and never automatically
replayed, including unknown failures. Only one `enableAuth` is possible. Either
shutdown mutation makes the manager terminal for collection/enabling commands;
the four cleanup commands remain available independently. No API exposes arbitrary
SQL, URL, account resources, scope, fixture ID or production operation.

`runNonce` defaults to 16 CSPRNG bytes, and the resulting private
`manager.fixtureIdentity` contains `{runNonce,historicalDay,cutoff}`. The nonce
names new synthetic records and selects a historical date 1024–5119 days before
run start. A guard refuses any existing relevant counters in the chosen old
windows; a collision stops rather than finding a new window or resetting counts.
The API fixture admits 128 old rows through normal triggers in one old minute
(limit 240), adds 16/256 old daily/minute rows and creates 64 revoked sessions over
two different old days, 32 each (day limit 50). Existing consumption remains.
Fixed book IDs use plain INSERT and reject previous fixtures/metadata/files.
No fixture is upserted and no current counter/admission is reset or deleted.

Snapshots use one fixed run-start cutoff with the Worker's actual expiry rules
and count the **whole old check collection**, since real cleanup may delete old
fixtures from earlier runs first. Each round privately retains the maximum
admission rowid from its preparation batch; metadata coverage counts actual
mutation admissions beyond that boundary. This avoids timestamp equality or
clock-boundary guesses, and the ordinal delta independently requires 20 API
admissions. New fixture writes cannot masquerade as ordinary sampling consumption.

The REST query body is `{batch:[{sql,params},...]}`, and each returned query must
provide `success:true`, results and integer nonnegative `meta.rows_read`/
`meta.rows_written`. Every statement's meta is summed; missing meta stops the run.
The [official D1 REST query contract](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
defines that body and response. [D1's binding batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
describes transactional rollback for `D1Database.batch`; that binding statement
alone does not establish an independently tested REST isolation/rollback guarantee.
Our SQLite transactional fixture checks generated SQL/constraints and local
rollback, not cloud atomicity. A second test deliberately models partial REST
commit before a later failure: the adapter treats the outcome as unknown, refuses
replay, preserves committed fixture/counter consumption and permits shutdown.
It never restores an old DB or attempts a compensating ledger rollback.

Deployments use the fixed script's GET deployment **list**, checking its first
active deployment has exactly the planned UUID at 100%; this follows the
[deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/).
Subdomain reads/writes use only that same script's
[subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/).
All HTTP uses `redirect:error`, an AbortSignal, the plan deadline, at most a 1MiB
JSON response and no retries. Aborting a mutation does not prove it was rejected.
Permission/rate-limit/provider/parser errors expose only fixed safe error codes.

Live construction requires `evidenceSink`. For pure tests only,
`offlineTest:true` together with a nondefault injected `fetchImpl` permits omission.
The sink receives `{command,window,response}` after successful provider JSON is
read, never request headers, credentials or request bodies. The operator must
write it only to new private 0600 files under 0700 parents, enforce a total byte
budget, and avoid console output. Raw responses are never added to the sanitized
controller receipt. Sink failure stops the operation and leaves mutation outcome
unknown; cleanup remains independent. The sink must honor the surrounding
bounded-operation context and finish promptly.

GraphQL uses a fixed scriptName and the controller's exact window, requests and
planned version; it does not guess a version filter unsupported by a measured
schema. The actual `scriptVersion` dimensions are validated in the projection.
A mismatched group's identity becomes a fixed invalid marker, preserving the
valid whole-window high aggregate for the offline analyzer while rejecting group
attribution; the raw dimension exists only in the private sink. Multiple aggregate
rows are never merged into invented quantiles. Missing metrics/sampling remain
missing, not zero. The query follows the
[official Workers GraphQL metrics example](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/),
with the already verified CPU max/P95/version fields from the existing sampler
contract. Current-account field availability/permissions still require the planned
cloud execution; local fixtures cannot prove them. The
[Workers metrics documentation](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
explains analytics delay; a fixed wait remains a sampling policy, not a freshness
or completeness proof.

## Cost model and limits of its evidence

`buildSamplerCostBasis(maxRows)` requires reviewed maximum **starting** counts for
all `SAMPLER_TABLES`. The single read-only inspect command independently checks
actual counts do not exceed them before mutation. Its schema fingerprint binds
the formulas to the reviewed SQL. Do not raise a failed bound during the run.
Growth allowances above starting maxima are admissions +180 (128 fixture +40 API
+8 login +4 metadata), sessions +68 (64 fixture +4 real), books/overrides +2 each,
and counters +400. The latter covers 272 direct fixture counters, three old API
trigger rows, two historical session-day rows, and up to 104 current trigger rows
if every business admission lands in a different minute, with slack. It does not
assume fast requests or same-minute completion. The reader-replica/business
concurrency assumptions remain isolated check traffic and exactly 20 real API
admissions per round; ordinal or metadata differences stop coverage, not a
retroactive claim that arbitrary external traffic was bounded.

Let A/C/S/B/F be maximum post-growth admissions/counters/sessions/books/files and
T the sum of all post-growth project table bounds. The implemented reservations:

| Unit                                | Rows read reservation                    | Rows written reservation |
| ----------------------------------- | ---------------------------------------- | ------------------------ |
| ordinary HTTP                       | `128 + 4B + 2F + S`                      | 64                       |
| one maintenance batch (two prepaid) | `384 + 2C + 2S`                          | 640                      |
| inspect DB                          | `256 + 4T + 2 × schema object count`     | 1                        |
| auth enable/rotate/close            | `64 + 2S`                                | `16 + 3S`                |
| seed batch                          | `4096 + 128 + 256 + 64(16+S) + snapshot` | 4096                     |
| round preparation                   | `snapshot + 64 + 2B + F`                 | 16                       |
| coverage read                       | `snapshot`                               | 1                        |
| shutdown read                       | `64 + 2S`                                | 1                        |

Here `snapshot = 128 + 2A + 2C + 3S`. Scans account for category lookup, whole-old
count predicates, session-limit/hash checks and both counter cleanup predicates.
Read constants reserve indexed probes, including normal admission trigger work;
seed constants also cover the window guard and returned synthetic rows. Write
reservations count table/index maintenance conservatively: a cleanup has 64
admissions with table/PK/expiry index, 136 counters with table/PK and 32 sessions
with table/PK/expiry index, totalling 560, rounded to 640. Normal 64 includes
admission/counter/session/metadata writes and normal trigger revision updates.
Auth write bounds cover a table update and revocation of every possible session.
Seed 4096 exceeds direct fixture, all affected indexes and trigger counter writes;
its read term explicitly covers 64 session-limit checks against the maximum
session population. Read-only writes reserve 1 as slack, not a claim of a write.

These are reviewable, deliberately conservative estimates, **not provider-measured
costs or a formal SQLite planner upper-bound theorem**. Local SQLite `total_changes`
and synthetic fixture meta are not Cloudflare billed reads/writes. The controller
retains actual provider management meta, checks each command against its reserved
bound, and stops on overrun; business meta remains unavailable through the
unchanged API. Any unexpected provider execution/index accounting or concurrent
traffic can invalidate assumptions and is reported as unknown/failure, followed
by reserved shutdown. The 100k/15k run ceilings and project no-extra-cash policy
remain fixed; these checks do not prove unrelated account free headroom.

Run both `tests/cf-cpu-sampler-manager.test.mjs` and the existing sampler/analyzer
tests. Manager tests execute the actual generated SQL and actual Worker in
SQLite for the full 42 requests, two CAS races and ordinal 1/32 full maintenance.
They additionally cover wrong payloads/targets, drift, partial failure, terminal
shutdown, response limits, meta summation, abort/timeout, private raw sink and
missing/mixed analytics. No local test contacts Cloudflare or proves cloud CPU.

## Pinned remote observability omission contract

`validateSamplerObservationSettings(settings, { wranglerVersion })` is a pure
parser: it reads no files/environment/credentials, executes no CLI or evaluated
SDK code, mutates no input and makes no requests. The caller must pass the
**actual installed** Wrangler version read from its package metadata; the only
accepted version is exported as `SAMPLER_OBSERVABILITY_WRANGLER_VERSION`, currently
`4.151.0`. A newer version stops rather than silently inheriting this default.
Tests independently check the installed package and lockfile versions and read
the pinned bundle's source text without executing it.

The reviewed official installed source is
`node_modules/wrangler/wrangler-dist/cli.js` from the lockfile's Wrangler 4.151.0:

- `normalizeObservability`, line 179862: absent remote observability returns
  defaults with overall/logs enabled false and traces enabled false.
- `normalizeRemoteConfigAsResolvedLocal`, line 179919: remote settings pass
  through that normalization; this is the relevant **remote** contract.
- The deployment fallback, line 181080: absent configuration is sent as
  `observability: worker.observability ?? { enabled: false }`.

These line references identify the pinned bundle, not a promise about future
bundles. New-project/template defaults are a different contract and are not used.
The helper allows omission only when the **entire `observability` property is
absent**. An explicitly present undefined/null value, wrong type, missing enabled
flag or enabled=true is rejected. Explicit objects require `enabled:false`;
present logs/traces objects also require their own `enabled:false`. Only the
reviewed boolean/sampling metadata fields are accepted. Unknown observation
features fail closed. Regardless of observability omission, `logpush` must be
explicit false and `tail_consumers` must be an empty array. The helper does not
check active runtime tails; the separately budgeted fixed tails read still does.

```js
import { validateSamplerObservationSettings } from "./cf-cpu-sampler-manager.mjs";
const observationProof = validateSamplerObservationSettings(
  actualFixedCheckSettings,
  { wranglerVersion: actualInstalledWranglerPackage.version },
);
// observationProof includes a safe source label:
// 'pinned-remote-default' or 'explicit-disabled', and fixed disabled booleans.
```

This is a read-only interpretation of existing settings. It does not enable or
patch observability, relax bindings validation, reset a ledger, authorize a retry,
or by itself prove cloud CPU acceptance. Synthetic tests cover allowed omissions,
explicit disabled metadata, wrong versions, null/types, enabled flags, logpush
and consumer failures; original private settings evidence remains the authority
for a separately reviewed, budget-preserving continuation.
