/** Fixed-target R2 S3 transport. No environment discovery, SDK or retry loop. */
import { createHash, createHmac } from "node:crypto";
import {
  StorageError,
  OBJECT_LIMIT,
  objectDescriptor,
  objectContentType,
  validateObjectBytes,
} from "./storage-authority.mjs";

const fail = (code) => {
  throw new StorageError(code);
};
const safeCodes = new Set([
  "r2_deadline_exceeded",
  "r2_response_invalid",
  "r2_request_failed",
  "r2_object_identity_mismatch",
  "r2_stream_required",
  "r2_body_size_mismatch",
  "r2_body_hash_mismatch",
  "r2_body_chunk_limit",
]);
const safeCode = (error, fallback) =>
  error instanceof StorageError && safeCodes.has(error.code)
    ? error.code
    : fallback;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const etagValid = (value) =>
  typeof value === "string" && /^"[\x21\x23-\x7e]{1,254}"$/.test(value);
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** All errors intentionally discard transport messages, URLs and credentials. */
export function createR2ObjectStore(config) {
  const allowed = [
    "accountId",
    "bucket",
    "accessKeyId",
    "secretAccessKey",
    "descriptors",
    "fetchImpl",
    "clock",
    "timeoutMs",
  ];
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !allowed.includes(key))
  )
    fail("r2_config_invalid");
  const {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    fetchImpl,
    clock = () => new Date(),
    timeoutMs = 60_000,
  } = config;
  if (
    typeof accountId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    bucket !== "the-shelf-books" ||
    typeof accessKeyId !== "string" ||
    !/^[a-f0-9]{32}$/.test(accessKeyId) ||
    typeof secretAccessKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(secretAccessKey) ||
    typeof fetchImpl !== "function" ||
    typeof clock !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    !Array.isArray(config.descriptors) ||
    !config.descriptors.length
  )
    fail("r2_config_invalid");
  const descriptors = new Map();
  for (const input of config.descriptors) {
    let pinned;
    try {
      pinned = structuredClone(input);
    } catch {
      fail("r2_config_invalid");
    }
    const descriptor = objectDescriptor(pinned);
    if (descriptors.has(descriptor.objectKey)) fail("r2_descriptor_duplicate");
    descriptors.set(descriptor.objectKey, descriptor);
  }
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const target = Object.freeze({ accountId, bucket });
  const descriptorFor = (key) => {
    if (typeof key !== "string" || !descriptors.has(key))
      fail("r2_key_forbidden");
    return descriptors.get(key);
  };
  function signedRequest(method, key, additional, body) {
    let date;
    try {
      date = clock()
        .toISOString()
        .replace(/[:-]|\.\d{3}/g, "");
    } catch {
      fail("r2_clock_invalid");
    }
    if (!/^\d{8}T\d{6}Z$/.test(date)) fail("r2_clock_invalid");
    const uri = "/" + [bucket, ...key.split("/")].map(encode).join("/");
    const headers = {
      host,
      "accept-encoding": "identity",
      "x-amz-date": date,
      "x-amz-content-sha256": digest(body ?? new Uint8Array()),
      ...additional,
    };
    const keys = Object.keys(headers).sort(),
      signed = keys.join(";");
    const canonical = `${method}\n${uri}\n\n${keys.map((key) => `${key}:${headers[key]}\n`).join("")}\n${signed}\n${headers["x-amz-content-sha256"]}`;
    const day = date.slice(0, 8),
      scope = `${day}/auto/s3/aws4_request`;
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), "auto"), "s3"),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey)
      .update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`)
      .digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    return { url: `https://${host}${uri}`, headers };
  }
  function lifetime() {
    const controller = new AbortController();
    let rejectDeadline,
      finished = false,
      onTimeout = () => {};
    const deadline = new Promise((_, reject) => {
      rejectDeadline = reject;
    });
    // The promise may expire between calls to read; never leave an unhandled rejection.
    deadline.catch(() => {});
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      controller.abort();
      rejectDeadline(new StorageError("r2_deadline_exceeded"));
      onTimeout();
    }, timeoutMs);
    return {
      signal: controller.signal,
      race: (promise) => Promise.race([promise, deadline]),
      expired: () => controller.signal.aborted,
      timeout: (action) => {
        onTimeout = action;
      },
      finish() {
        finished = true;
        clearTimeout(timer);
      },
      abort() {
        finished = true;
        clearTimeout(timer);
        controller.abort();
      },
    };
  }
  const cancelBody = (response) => {
    try {
      Promise.resolve(response?.body?.cancel()).catch(() => {});
    } catch {}
  };
  async function request(method, key, headers = {}, body) {
    const signed = signedRequest(method, key, headers, body),
      life = lifetime();
    let response;
    try {
      const pending = Promise.resolve().then(() =>
        fetchImpl(signed.url, {
          method,
          headers: signed.headers,
          ...(body ? { body } : {}),
          redirect: "error",
          signal: life.signal,
        }),
      );
      pending.then(
        (late) => {
          if (life.expired()) cancelBody(late);
        },
        () => {},
      );
      response = await life.race(pending);
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.redirected ||
        (response.url && response.url !== signed.url)
      )
        fail("r2_response_invalid");
      if (method === "HEAD" && response.status === 404) {
        cancelBody(response);
        life.finish();
        return null;
      }
      if (response.status !== 200) fail("r2_request_failed");
      return { response, life };
    } catch (error) {
      cancelBody(response);
      life.abort();
      fail(safeCode(error, "r2_transport_unknown"));
    }
  }
  function metadata(response, descriptor) {
    const headers = response.headers;
    const length = headers.get("content-length"),
      sha256 = headers.get("x-amz-meta-sha256"),
      etag = headers.get("etag"),
      contentType = headers.get("content-type");
    if (
      !/^[1-9]\d*$/.test(length || "") ||
      Number(length) !== descriptor.sizeBytes ||
      Number(length) > OBJECT_LIMIT ||
      sha256 !== descriptor.sha256 ||
      contentType !== objectContentType(descriptor) ||
      !etagValid(etag) ||
      headers.get("content-range") !== null ||
      ![null, "identity"].includes(headers.get("content-encoding"))
    )
      fail("r2_object_identity_mismatch");
    return { size: Number(length), sha256, etag, contentType };
  }
  return Object.freeze({
    target,
    async head(key) {
      const descriptor = descriptorFor(key),
        result = await request("HEAD", key);
      if (result === null) return null;
      try {
        return metadata(result.response, descriptor);
      } catch (error) {
        fail(safeCode(error, "r2_response_invalid"));
      } finally {
        result.life.finish();
        cancelBody(result.response);
      }
    },
    async get(key, options) {
      const descriptor = descriptorFor(key);
      if (
        !exact(options, ["maxBytes", "ifMatch"]) ||
        options.maxBytes !== descriptor.sizeBytes ||
        !etagValid(options.ifMatch)
      )
        fail("r2_get_options_invalid");
      const ifMatch = options.ifMatch;
      const result = await request("GET", key, { "if-match": ifMatch });
      const { response, life } = result;
      let reader;
      try {
        if (metadata(response, descriptor).etag !== ifMatch)
          fail("r2_object_identity_mismatch");
        if (!(response.body instanceof ReadableStream))
          fail("r2_stream_required");
        reader = response.body.getReader();
      } catch (error) {
        life.abort();
        cancelBody(response);
        fail(safeCode(error, "r2_response_invalid"));
      }
      let offset = 0,
        chunks = 0,
        complete = false;
      const hash = createHash("sha256");
      const stop = () => {
        try {
          Promise.resolve(reader.cancel()).then(
            () => {
              try {
                reader.releaseLock();
              } catch {}
            },
            () => {
              try {
                reader.releaseLock();
              } catch {}
            },
          );
        } catch {}
      };
      return new ReadableStream(
        {
          start(controller) {
            life.timeout(() => {
              if (complete) return;
              complete = true;
              stop();
              controller.error(new StorageError("r2_deadline_exceeded"));
            });
          },
          async pull(controller) {
            try {
              const { done, value } = await life.race(reader.read());
              if (complete) return;
              if (done) {
                if (offset !== descriptor.sizeBytes)
                  fail("r2_body_size_mismatch");
                if (hash.digest("hex") !== descriptor.sha256)
                  fail("r2_body_hash_mismatch");
                complete = true;
                life.finish();
                reader.releaseLock();
                controller.close();
                return;
              }
              if (++chunks > 100_000) fail("r2_body_chunk_limit");
              if (
                !(value instanceof Uint8Array) ||
                value.byteLength > descriptor.sizeBytes - offset
              )
                fail("r2_body_size_mismatch");
              offset += value.byteLength;
              // Hash the same copied bytes that the consumer receives. A producer
              // reusing buffers or a consumer mutating a chunk cannot change it.
              const pinned = Uint8Array.from(value);
              hash.update(pinned);
              controller.enqueue(pinned);
            } catch (error) {
              if (complete) return;
              complete = true;
              life.abort();
              stop();
              controller.error(
                new StorageError(safeCode(error, "r2_body_unavailable")),
              );
            }
          },
          cancel() {
            complete = true;
            life.abort();
            stop();
          },
        },
        { highWaterMark: 0 },
      );
    },
    async put(key, bytes, options) {
      const descriptor = descriptorFor(key);
      if (
        !exact(options, ["ifNoneMatch", "sha256", "contentType"]) ||
        options.ifNoneMatch !== "*" ||
        options.sha256 !== descriptor.sha256 ||
        options.contentType !== objectContentType(descriptor)
      )
        fail("r2_put_options_invalid");
      const validated = await validateObjectBytes(descriptor, bytes);
      const result = await request(
        "PUT",
        key,
        {
          "if-none-match": "*",
          "content-length": String(validated.bytes.byteLength),
          "content-type": objectContentType(descriptor),
          "x-amz-meta-sha256": descriptor.sha256,
          "cache-control": "private, no-store",
        },
        validated.bytes,
      );
      try {
        if (!etagValid(result.response.headers.get("etag")))
          fail("r2_object_identity_mismatch");
      } catch (error) {
        fail(safeCode(error, "r2_response_invalid"));
      } finally {
        result.life.finish();
        cancelBody(result.response);
      }
    },
  });
}
