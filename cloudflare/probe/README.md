# CF-01 isolated diagnostics

This is a disposable probe, not the production login/API. It never loads books,
the Shelf password, AI keys, the private manifest or the existing SQLite database.
All operations other than `GET /health` require a 32-byte random lowercase hex
`CF_PROBE_TOKEN` bearer secret. Never deploy the local fixture token.

## Operator setup

Use a dedicated D1 database (`CF_DB`) and apply `schema.sql` once. Both Workers
bind the same diagnostic D1 and the same secret. Main Worker additionally binds
the private Shelf R2 bucket as `CF_BUCKET`, the mock as service `CF_MOCK`, and
Workflow `CF_WORKFLOW` using exported class `Cf01Workflow`.

Copy both `wrangler*.example.json` to ignored `.local/cf01/` configs, fill in the
project account/database IDs locally, and change `main` to an absolute path or
`../../cloudflare/probe/worker.mjs` / `mock.mjs`. The schema path then also needs
adjustment or removal. Configure main name `the-shelf-cf01`, mock name
`the-shelf-cf01-mock`, and Workflow name `the-shelf-cf01`. The mock has no public
route, workers.dev, or preview URL. Keep it private. Deploy mock before main.
Free automatically applies its 10 ms CPU limit and rejects configurable
`limits.cpu_ms` (actual deploy rejection code 100328 confirmed this account's
Free plan). Templates therefore omit that option. Only for a Paid account's
equivalent-cap experiment, add `limits.cpu_ms=10` in the private config. Capture
actual CPU/outcomes from tail/analytics regardless of the plan.

Secrets belong in ignored `.env` or `.local` files with mode 0600. Supply secrets
to Wrangler through its secret input API/stdin, never command arguments. Configure
`CF_PROBE_URL=https://the-diagnostic-worker-origin` and `CF_PROBE_TOKEN` in private
`.env` for the client (already exported env values also work). Keep tail output
private. Wrangler may load `.env`; use `--env-file` explicitly when appropriate.

## Validation commands

```sh
npm run cf:probe -- start short
npm run cf:probe -- poll short
npm run cf:probe -- start scrypt
npm run cf:probe -- start pbkdf2
npm run cf:probe -- cleanup short
npm run cf:probe -- start long
npm run cf:probe -- poll long
npm run cf:probe -- cleanup long
npm run cf:probe -- start uncertain
npm run cf:probe -- poll uncertain
npm run cf:probe -- cleanup all
```

`start storage` and `smoke` are frozen and return
`legacy_storage_migration_required` before configuration, directories, locks,
private evidence, or network access. Historically, `smoke` wrote/read a 72-byte
neutral R2 object, including a 5-byte Range read, then started a 65-second
Workflow. Use `start short` for the independent 65-second Workflow diagnostic.
Historical storage runs can still be polled with `poll storage` and cleaned
with `cleanup storage` when terminal. Storage writes have no override or fallback.
Each Workflow start returns after Workflow creation;
close the client and poll in another process after the requested delay. Start
`long` after the short run completes or is cleaned. It makes a real private
service-binding HTTP fetch that waits 840 seconds before returning. No
`step.sleep` or `waitUntil` is used to imitate a long network call. `uncertain`
waits 65 seconds then returns HTTP 503; state must become `uncertain`, with both
`network_calls` and `mock_calls` exactly 1. Repeated starts with the same active
label only poll the recorded ID and do not POST again. Request ambiguity is
recorded before returning an error and must be inspected/polled, never retried
automatically.

The private client evidence is `.local/cf01/evidence.json` (0600). It records IDs,
request outcomes, returned run state, and neutral results; no bearer token.
Writes use fsync and atomic rename. An exclusive `.lock` prevents concurrent
clients from losing each other's IDs. If a client crashes, inspect evidence and
confirm no client remains active before removing the stale lock; do not restart
an ambiguous request with a new ID.
Polling is one GET per command, without an automatic request loop. Each client
evidence file allows at most 512 requests. Deployment runs allow at most 12
lifetime reservations: 4 historical storage, 4 Workflows, 2 scrypt and 2 PBKDF2;
new storage admission is disabled. Only one
reserved/running/uncertain Workflow can exist at once. Cleanup terminates a
Workflow first, deletes only its exact R2 key under
`diagnostics/cf01/<UUID>/neutral.txt`, verifies deletion, then removes the run
record. Budget tombstones remain to prevent cleanup resetting the limit or an
old request recreating work. Remove the dedicated probe D1/Workers/Workflow only
after preserving the needed private evidence.

All Workflow steps explicitly use zero retries and a 20-minute timeout.
The durable network claim is written before fetch, and the mock independently
claims one invocation. Replaying an interrupted step cannot make another mock
request. If workflow creation was ambiguous and no instance can be found,
cleanup retains diagnostics for operator review rather than racing a live run.

## Interpreting results

The scrypt probe mirrors existing Node `scryptSync` defaults (`N=16384,r=8,p=1`,
32-byte salt/key) for startup hashing plus verification. The alternative uses
asynchronous WebCrypto PBKDF2-SHA256 with 600,000 iterations for each of two
derivations. It does not weaken password protection to fit a CPU limit.
`wallMs`/`networkWallMs` come from the runtime clock. Deployed Workers freeze
`Date.now()` and `performance.now()` during pure computation and advance them
only after I/O; `wallMs=0` can therefore accompany expensive scrypt computation
and proves neither zero CPU cost nor suitability for Free. See the official
[performance and timers documentation](https://developers.cloudflare.com/workers/runtime-apis/performance/).
Capture actual CPU time and
invocation outcomes with Cloudflare tail/analytics, including interrupted probes
whose D1 state remains running. Local test times and local Wrangler success are
not Free-tier CPU evidence. Mock success does not establish real AI connectivity.

KDF failures persist only fixed, allowlisted codes: iteration limit, unsupported
algorithm, rejected parameter, operation failure, or generic failure. Raw
exception names/messages are never returned or logged. A cloud PBKDF2 rejection
must be diagnosed by its actual code; current local workerd accepted 600,000
iterations, which does not establish that every deployed runtime accepts it.

## Local checks

```sh
node --test tests/cf-probe.test.mjs tests/cf-probe-cli-freeze.test.mjs
npx wrangler deploy --dry-run --config cloudflare/probe/wrangler.example.json --env-file cloudflare/probe/local.env.example --outdir "$(pwd)/.local/cf01/build"
npx wrangler deploy --dry-run --config cloudflare/probe/wrangler.mock.example.json --env-file cloudflare/probe/local.env.example --outdir "$(pwd)/.local/cf01/mock-build"
node scripts/cf-probe-local.mjs
```

Use isolated Wrangler local persistence under `.local/cf01/local-state` for any
local D1/Worker execution. Never point Wrangler at existing Shelf SQLite files.
The local runtime script uses in-memory D1/R2, a synthetic service response, and
does not load `.env`. It verifies real workerd storage and cross-request behavior;
the cloud short/long Workflow commands separately validate the actual mock network wait.
