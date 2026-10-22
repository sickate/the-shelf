# Bounded production reading verification

`runReadingSmoke` in `cf-reading-smoke.mjs` is a module-only operator. It never discovers configuration, reads `.env`, loads a book, uploads an object, changes D1 or Worker configuration, or calls AI. There is no CLI. A separate reviewed operator must explicitly load the verified production inputs and invoke it. This module has not made a real cloud request.

The default preview validates its explicit plan and returns a request budget without filesystem or network IO. Preview does not prove upload, authorization, resource headroom or deployment readiness.

```js
import { runReadingSmoke } from "./scripts/cf-reading-smoke.mjs";
const preview = await runReadingSmoke({ plan });
// Execute only after the main agent has reviewed the production run plan:
const result = await runReadingSmoke({
  execute: true,
  plan,
  accessKey, // explicitly loaded private owner key, never argv or logs
  receipt: {
    root: verifiedProjectRoot,
    directory: absoluteNewReadingSmokeDirectory,
  },
});
```

The exact plan fields are `schemaVersion:1`, `profile:"production"`, `origin:"https://the-shelf.iamzhutuo.workers.dev"`, explicit 32-hex `accountId`, `bucket:"the-shelf-books"`, explicit confirmed `etag`, and the existing canonical original-object `descriptor`. The descriptor must have production scope and PDF or EPUB format; it includes file/book IDs, positive size up to 20,000,000 bytes, SHA256 and the deterministic object key. These fields come from independently verified local selection and confirmed upload records. The module does not accept an `uploaded:true` assertion: it separately verifies the live public catalog's matching file/book/format/size/private candidate and `reason:"uploaded"`, then hashes the actual object.

Prepare existing owned 0700 `.local/cf03` parents. The receipt directory must be a **new**, direct child named `reading-smoke-<1–80 alphanumeric/underscore/hyphen characters>`. The operator creates it exclusively and retains it on failure. It reuses the project private-path validator and adds ancestor inode/open-handle pins, file inode/size/time/link pins, exclusive 0600 files, file and directory fsync. Existing runs, symlinks, hardlinks and directory replacement stop execution. A journal failure blocks further network dispatch, including logout. Do not remove or reuse an incomplete run to retry mutations.

A successful run has exactly ten HTTP requests, in order:

1. Anonymous file access must return 401 `authentication_required`.
2. One same-origin JSON login; validate the secure host cookie and CSRF response.
3. Confirm the authenticated session and matching CSRF token.
4. Read and compare the live catalog file descriptor.
5. Authorize the selected file; validate the fixed R2 account host, bucket/key, strict SigV4 query allowlist and TTL at most 300 seconds.
6. Full object GET with cookie omitted; enforce size, MIME, ETag and stream SHA256. Retain only the first 32 bytes in memory.
7. GET the first `min(32,size)` bytes with Range and If-Match; require 206, exact Content-Range, same ETag/MIME and the corresponding full-GET bytes.
8. One same-origin CSRF logout.
9. Confirm the old cookie now reports an anonymous session.
10. The old cookie must receive 401 for the selected file access.

Both R2 GETs send only the fixed production Origin (and the Range/If-Match headers on step 7), never cookies. They check exact production ACAO, no allow-credentials header, and exposed Accept-Ranges, Content-Range, Content-Length and ETag. This is an HTTP CORS check; it does not test browser preflight or rendering.

The hard request limit is 11, including a separately journaled, single failure-cleanup logout if a confirmed cookie and CSRF token are available and no logout has been attempted. All requests, including failures and cleanup, require a durable intent before dispatch. Every request has one 30-second deadline covering headers and streaming body, redirect rejection, and bounded bytes (65,536 JSON bytes, selected object size, or 32 Range bytes), plus a hard maximum of 65,536 data chunks per response (including zero-length chunks). Exceeding the chunk bound cancels the stream with `response_chunk_limit`, so an immediately resolving zero-byte stream cannot evade the deadline by starving timer tasks. Late responses are canceled and a late login response never supplies a cookie. No login or logout mutation is retried. Test injection supports explicit `fetchImpl`, `now`, `timeoutMs<=30000`, and `environment:{}`; actual execution defaults to the process environment and rejects CI.

Cookies, keys, CSRF tokens, signed URLs, file/account IDs, descriptor hashes, titles and object bytes are never written to evidence or returned. Receipts contain fixed step labels, sequence, HTTP status, finite error codes and outcome flags. `browserVerified` is always false. The caller must not log its private input or transport options.

A lost/invalid login response may have created a session without a usable cookie. The result then sets `loginUnknown` and `generationRevocationRequired`; the main agent must independently disable/advance the production auth generation and verify revoked sessions. A lost or invalid logout response is never replayed and likewise requires generation revocation. A successful logout followed by failed revocation checks also requires independent revocation. If evidence persistence itself fails, the module throws only a fixed safe code, stops all dispatch, and may be unable to write a final result; the main agent must treat an incomplete login/logout intent conservatively and perform independent generation revocation. This runner does not change the generation or close the production entry point.

Passing proves this bounded HTTP chain for one selected object at that time. It does not establish storage readiness, old-writer closure, account/free-plan safety, deployment identity, static button availability, expired signed-URL rejection, or a browser PDF/EPUB reading result. Those remain separate main-agent gates. Signed URLs remain bearer capabilities for up to 300 seconds after logout; the final access check concerns issuing a new URL. Already downloaded bytes are not revoked. The existing reader still downloads the whole small file; this Range test does not claim network-segmented PDF rendering.

Offline validation:

```sh
node --test tests/cf-reading-smoke.test.mjs
```
