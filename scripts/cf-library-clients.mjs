import { createHash, createHmac } from "node:crypto";
import { LibraryError, LIMIT } from "./cf-library-data.mjs";

const fail = (code) => {
  throw new LibraryError(code);
};
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

async function boundedBody(response, limit) {
  const advertised = response.headers?.get("content-length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > limit))
    fail("response_too_large");
  const chunks = [];
  let length = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) {
      await response.body.cancel?.().catch(() => {});
      fail("response_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

export function d1Client(credentials, resource, { fetchImpl = fetch } = {}) {
  if (
    !/^[a-f0-9]{32}$/.test(credentials.accountId || "") ||
    !credentials.token ||
    !/^[a-f0-9-]{36}$/.test(resource.databaseId || "") ||
    !["the-shelf-library", "the-shelf-cf03-check"].includes(
      resource.databaseName,
    )
  )
    fail("invalid_database_target");
  const url = `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/d1/database/${resource.databaseId}`;
  let verified = false;
  const request = async (suffix, options = {}) => {
    let response, data;
    try {
      response = await fetchImpl(url + suffix, {
        ...options,
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      data = JSON.parse(
        (await boundedBody(response, 10_000_000)).toString("utf8"),
      );
    } catch {
      fail(options.method === "POST" ? "d1_outcome_unknown" : "d1_unavailable");
    }
    if (!response.ok || data.success !== true) {
      const errors = JSON.stringify(data.errors || []);
      const known = [
        "library_import_fenced",
        "library_import_incomplete",
        "library_storage_budget",
        "library_already_registered",
        "library_upload_state",
        "library_upload_unverified",
      ];
      fail(known.find((code) => errors.includes(code)) || "d1_rejected");
    }
    return data.result;
  };
  return {
    async verify() {
      const result = await request("");
      if (
        result?.uuid !== resource.databaseId ||
        result?.name !== resource.databaseName
      )
        fail("database_identity_mismatch");
      verified = true;
    },
    async query(sql, params = []) {
      if (!verified) fail("database_identity_unverified");
      if (
        typeof sql !== "string" ||
        sql.length > 100_000 ||
        !Array.isArray(params) ||
        params.length > 100
      )
        fail("invalid_d1_query");
      const result = await request("/query", {
        method: "POST",
        body: JSON.stringify({ sql, params }),
      });
      if (
        !Array.isArray(result) ||
        result.length !== 1 ||
        result[0].success === false ||
        !Array.isArray(result[0].results)
      )
        fail("d1_response_invalid");
      return result[0].results;
    },
  };
}

export function r2Client(
  config,
  scope,
  { fetchImpl = fetch, clock = () => new Date() } = {},
) {
  if (
    !/^[a-f0-9]{32}$/.test(config.accountId || "") ||
    config.bucket !== "the-shelf-books" ||
    !config.accessKey ||
    !config.secretKey ||
    !["check", "production"].includes(scope)
  )
    fail("invalid_r2_target");
  const prefix = scope === "production" ? "books/cf03/" : "cf03-check/";
  const request = async (
    method,
    key,
    { data = Buffer.alloc(0), sha256, format } = {},
  ) => {
    if (
      typeof key !== "string" ||
      !key.startsWith(prefix) ||
      !/^(?:books\/cf03|cf03-check)\/[\w-]{1,100}\/[a-f0-9]{64}\.(epub|pdf)$/.test(
        key,
      ) ||
      key.includes("..")
    )
      fail("invalid_storage_key");
    const host = `${config.accountId}.r2.cloudflarestorage.com`;
    const uri = "/" + [config.bucket, ...key.split("/")].map(encode).join("/");
    const date = clock()
        .toISOString()
        .replace(/[:-]|\.\d{3}/g, ""),
      day = date.slice(0, 8),
      credentialScope = `${day}/auto/s3/aws4_request`;
    const headers = {
      host,
      "x-amz-content-sha256": sha(data),
      "x-amz-date": date,
    };
    if (method === "PUT") {
      if (
        !/^[a-f0-9]{64}$/.test(sha256 || "") ||
        sha256 !== sha(data) ||
        !["EPUB", "PDF"].includes(format) ||
        data.length < 1 ||
        data.length > LIMIT
      )
        fail("invalid_upload_body");
      Object.assign(headers, {
        "x-amz-meta-sha256": sha256,
        "cache-control": "private, no-store",
        "content-type":
          format === "EPUB" ? "application/epub+zip" : "application/pdf",
        "if-none-match": "*",
      });
    }
    const keys = Object.keys(headers).sort(),
      signed = keys.join(";");
    const canonical = `${method}\n${uri}\n\n${keys.map((k) => `${k}:${headers[k].trim()}\n`).join("")}\n${signed}\n${headers["x-amz-content-sha256"]}`;
    const signing = hmac(
      hmac(hmac(hmac("AWS4" + config.secretKey, day), "auto"), "s3"),
      "aws4_request",
    );
    const signature = createHmac("sha256", signing)
      .update(
        `AWS4-HMAC-SHA256\n${date}\n${credentialScope}\n${sha(canonical)}`,
      )
      .digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${credentialScope}, SignedHeaders=${signed}, Signature=${signature}`;
    let response;
    try {
      response = await fetchImpl(`https://${host}${uri}`, {
        method,
        headers,
        ...(method === "PUT" ? { body: data } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      fail(
        method === "PUT" ? "upload_outcome_unknown" : "object_read_unavailable",
      );
    }
    if (method === "HEAD" && response.status === 404) return null;
    if (!response.ok)
      fail(
        method === "PUT" ? "upload_outcome_unknown" : "object_read_unavailable",
      );
    return response;
  };
  return {
    async head(key) {
      const response = await request("HEAD", key);
      if (!response) return null;
      const length = response.headers.get("content-length");
      if (!/^\d+$/.test(length || "") || !Number.isSafeInteger(Number(length)))
        fail("object_identity_mismatch");
      return {
        size: Number(length),
        sha256: response.headers.get("x-amz-meta-sha256"),
        etag: response.headers.get("etag"),
      };
    },
    async get(key, size) {
      if (!Number.isSafeInteger(size) || size < 1 || size > LIMIT)
        fail("invalid_object_size");
      return boundedBody(await request("GET", key), size);
    },
    async put(key, data, options) {
      await request("PUT", key, { ...options, data });
    },
  };
}
