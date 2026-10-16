// The sole live transport supplied here is fixed check HTTP/2. Management and
// credentials remain explicitly injected by a separately reviewed local runner.
import http2 from "node:http2";
import { CHECK } from "./cf-cpu-sampler.mjs";
const stopped = (code) =>
  Object.assign(new Error("Controlled HTTP/2 transport stopped."), { code });
const PATH =
  /^\/api\/(?:health|session|login|logout|does-not-exist|books\/cf03-sampler-(?:first-access|subsequent)(?:\/metadata)?|files\/(?:cf03-sampler-(?:first-access|subsequent)-file|unknown-file)\/access)$/;
export async function connectSamplerH2(
  { origin, signal },
  { connectImpl = http2.connect, timeoutMs = 30000 } = {},
) {
  if (
    origin !== CHECK.origin ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30000 ||
    signal?.aborted
  )
    throw stopped("h2_invalid_target");
  let client,
    failed = false;
  const target = new URL(CHECK.origin);
  try {
    client = connectImpl(CHECK.origin, {
      rejectUnauthorized: true,
      servername: target.hostname,
      ALPNProtocols: ["h2"],
    });
  } catch {
    throw stopped("h2_connect_failed");
  }
  client.on("error", () => {
    failed = true;
  });
  client.on("goaway", () => {
    failed = true;
  });
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      client.removeListener("error", errorHandler);
      client.removeListener("connect", ready);
      if (error) {
        client.destroy();
        reject(stopped(error));
      } else resolve();
    };
    const abort = () => finish("h2_connect_aborted"),
      errorHandler = () => finish("h2_connect_failed");
    const ready = () =>
      finish(client.alpnProtocol === "h2" ? null : "h2_alpn_failed");
    const timer = setTimeout(() => finish("h2_connect_timeout"), timeoutMs);
    client.once("connect", ready);
    client.once("error", errorHandler);
    signal?.addEventListener("abort", abort, { once: true });
  });
  return {
    protocol: "h2",
    request({ path, method, headers = {}, body, signal }) {
      if (
        failed ||
        client.closed ||
        client.destroyed ||
        signal?.aborted ||
        !PATH.test(path || "") ||
        !["GET", "POST"].includes(method) ||
        (body !== undefined &&
          (typeof body !== "string" || Buffer.byteLength(body) > 18000)) ||
        Object.keys(headers).some(
          (k) =>
            !["content-type", "origin", "cookie", "x-csrf-token"].includes(k),
        )
      )
        return Promise.reject(stopped("h2_request_rejected"));
      return new Promise((resolve, reject) => {
        let stream,
          ended = false,
          responseHeaders,
          bytes = 0;
        const chunks = [];
        const abort = () => finish("h2_request_aborted");
        const finish = (error) => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (error) {
            try {
              stream?.close(http2.constants.NGHTTP2_CANCEL);
            } catch {}
            reject(stopped(error));
          } else if (!responseHeaders) reject(stopped("h2_headers_missing"));
          else
            resolve({
              status: Number(responseHeaders[":status"]),
              headers: responseHeaders,
              body: Buffer.concat(chunks, bytes),
            });
        };
        const timer = setTimeout(() => finish("h2_request_timeout"), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          stream = client.request({
            ":method": method,
            ":scheme": "https",
            ":authority": target.host,
            ":path": path,
            ...headers,
          });
        } catch {
          finish("h2_stream_failed");
          return;
        }
        stream.once("response", (headers) => {
          responseHeaders = headers;
          const size = headers["content-length"];
          if (
            Number(headers[":status"]) >= 300 &&
            Number(headers[":status"]) < 400
          )
            finish("h2_redirect_rejected");
          else if (
            size !== undefined &&
            (!/^\d+$/.test(String(size)) || Number(size) > 65536)
          )
            finish("h2_response_too_large");
        });
        stream.on("data", (chunk) => {
          if (ended) return;
          bytes += chunk.length;
          if (bytes > 65536) finish("h2_response_too_large");
          else chunks.push(Buffer.from(chunk));
        });
        stream.once("error", () => finish("h2_stream_failed"));
        stream.once("aborted", () => finish("h2_stream_aborted"));
        stream.once("end", () => finish());
        stream.once("close", () => {
          if (!ended) finish("h2_stream_incomplete");
        });
        stream.end(body);
      });
    },
    async close() {
      failed = true;
      client.close();
      client.destroy();
    },
  };
}
