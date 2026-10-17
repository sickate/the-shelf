# Workers / D1 account aggregate audit

`cf-account-quota-audit.mjs` has no CLI and defaults to a zero-network preview.
A separately reviewed private operator supplies the original project's fixed account,
existing credential and fresh private evidence directory. This audit does not deploy,
execute SQL, contact business endpoints, discover credentials, list resources, or call
subscriptions/billing APIs.

The manifest contains exactly two independent GraphQL POSTs. Both request only account
aggregates with no dimensions and no script/database filter. `limit:2` detects an
unexpected multi-group result: exactly one aggregate is accepted; no rows is unknown,
not zero. Workers uses UTC midnight through the captured query-window end. D1 uses the
same UTC date in the documented `date_geq`/`date_leq` filters; `filterGranularity` is
`utc-day`, and `receivedAt` identifies observation time. This does not establish precise
instant coverage.

The [official Workers metrics example](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
identifies `workersInvocationsAdaptive.sum.requests`. The project's existing fixed
Workers evidence query also uses `avg.sampleInterval`. The [official D1 metrics contract](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
identifies `d1AnalyticsAdaptiveGroups`, `rowsRead`, `rowsWritten`, date filters and an
account-wide example without dimensions. The locked Wrangler 4.151.0 distribution
also selects `sum.rowsRead` and `sum.rowsWritten` for this dataset. D1's query-insights
dataset is deliberately excluded because it can expose SQL.

The [official sampling contract](https://developers.cloudflare.com/analytics/graphql-api/sampling/)
states Adaptive datasets can return estimates. Workers' reported average interval is
preserved; interval one is not treated as evidence of complete billing coverage. D1's
sampling interval is unknown because this audit has no verified field contract for it.
Neither source establishes ingestion delay or coverage of every management-plane
operation. Consequently `complete` remains false and `remaining` remains null even
when an observed aggregate is available. Observations older than five minutes are
explicitly marked stale; crossing the UTC day stops any next request.

The [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/)
lists a conditional Free allowance of 100,000 requests/day, and the [D1 pricing page](https://developers.cloudflare.com/d1/platform/pricing/)
lists 5,000,000 rows read and 100,000 rows written/day, resetting at 00:00 UTC. These
numbers are reference allowances, not proof this account is Free. The locked SDK's
`accounts.subscriptions.get` lists **all** account subscriptions and offers no verified
product-only response constraint. That API is not called; Workers/D1 Free status
remains unknown. There is no fallback to broad billing, account or subscription reads.

Execution makes at most two requests under a hard ceiling of 12 management requests,
30 seconds/request, 512 KiB/response and 6 MiB reserved evidence bytes. Each reservation
is fsynced before the network call. Run-start and ledger files are exclusive and
synced; any previous start prevents replay. Redirects and retries are disabled.
Successful numeric-only envelopes are validated and canonicalized before persistence,
so error messages, unsolicited fields and duplicate-key hidden content are not saved.
Evidence uses 0700 directories and 0600 files; persistence failures stop further calls.
All errors and reports contain fixed codes, numeric aggregates and completeness data,
never account IDs or credentials.

Offline verification: `node --test tests/cf-account-quota-audit.test.mjs`.
