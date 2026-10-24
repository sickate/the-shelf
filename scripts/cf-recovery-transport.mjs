// Recovery-only transport observation. No retries, logging, credentials or file IO.
// The caller persists only these two allowlisted observations in private records.
export const RECOVERY_TRANSPORT_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  responseBytes: 1_048_576,
  responseChunks: 4096,
  errorCodes: 32,
});
const fail = () => {
  const error = new Error("recovery_transport_unknown");
  error.code = "recovery_transport_unknown";
  throw error;
};
const cancel = (value) => {
  try {
    void Promise.resolve(value?.cancel()).catch(() => {});
  } catch {}
};

// Status is observed before any response rejection. Error responses are consumed
// under the same bounds solely to retain numeric API codes; they still fail.
export async function observedRecoveryResponse(
  fetcher,
  url,
  options,
  {
    timeoutMs = RECOVERY_TRANSPORT_LIMITS.timeoutMs,
    observe,
    allowAssetUpload = false,
  } = {},
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RECOVERY_TRANSPORT_LIMITS.timeoutMs ||
    typeof observe !== "function" ||
    typeof allowAssetUpload !== "boolean"
  )
    fail();
  const controller = new AbortController();
  let timer, response, reader;
  const operation = (async () => {
    response = await fetcher(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      cancel(response?.body);
      fail();
    }
    if (
      !Number.isSafeInteger(response?.status) ||
      response.status < 100 ||
      response.status > 599
    )
      fail();
    await observe({ httpStatus: response.status });
    if (
      controller.signal.aborted ||
      response.redirected ||
      (response.url && response.url !== url) ||
      !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") || "",
      )
    )
      fail();
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) ||
        Number(length) > RECOVERY_TRANSPORT_LIMITS.responseBytes)
    )
      fail();
    reader = response.body.getReader();
    const chunks = [];
    let count = 0,
      size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (
        !(part.value instanceof Uint8Array) ||
        ++count > RECOVERY_TRANSPORT_LIMITS.responseChunks ||
        (size += part.value.byteLength) >
          RECOVERY_TRANSPORT_LIMITS.responseBytes
      )
        fail();
      chunks.push(Buffer.from(part.value));
    }
    const body = Buffer.concat(chunks),
      data = JSON.parse(body.toString("utf8")),
      cloudflareErrorCodes = Array.isArray(data?.errors)
        ? data.errors
            .slice(0, RECOVERY_TRANSPORT_LIMITS.errorCodes)
            .map((error) => error?.code)
            .filter((code) => Number.isSafeInteger(code) && code >= 1000)
        : [];
    if (controller.signal.aborted) fail();
    await observe({ cloudflareErrorCodes });
    if (
      controller.signal.aborted ||
      (response.status !== 200 &&
        !(allowAssetUpload && [201, 202].includes(response.status)))
    )
      fail();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  })();
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          cancel(reader);
          cancel(response?.body);
          const error = new Error("recovery_transport_unknown");
          error.code = "recovery_transport_unknown";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch {
    controller.abort();
    cancel(reader);
    cancel(response?.body);
    fail();
  } finally {
    clearTimeout(timer);
    cancel(reader);
    try {
      reader?.releaseLock();
    } catch {}
  }
}
