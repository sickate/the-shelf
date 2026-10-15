const encoder = new TextEncoder();
const pattern = /^[A-Za-z0-9_-]{43}$/;
// 32 bytes encode into 42 full base64url characters plus four data bits. The
// final character must have its two padding bits clear; this is exactly the
// canonical unpadded representation without decoding/re-encoding user input.
const canonicalPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export function isCanonicalKey(value) {
  return typeof value === "string" && canonicalPattern.test(value);
}
export class LibraryError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function decodeKey(value) {
  if (typeof value !== "string" || !pattern.test(value))
    throw new LibraryError("invalid_credentials", 401);
  let bytes;
  try {
    bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="),
      (c) => c.charCodeAt(0),
    );
  } catch {
    throw new LibraryError("invalid_credentials", 401);
  }
  if (bytes.length !== 32 || encodeKey(bytes) !== value)
    throw new LibraryError("invalid_credentials", 401);
  return bytes;
}
export function encodeKey(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function randomKey() {
  return encodeKey(crypto.getRandomValues(new Uint8Array(32)));
}
const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
function unhex(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new LibraryError("service_unavailable", 503);
  return Uint8Array.from(value.match(/../g), (s) => Number.parseInt(s, 16));
}
const importedKeys = new Map();
async function importHmac(secret) {
  // Bounded cache: production has two keys. Do not retain arbitrary request inputs.
  if (!importedKeys.has(secret)) {
    if (importedKeys.size >= 8) importedKeys.clear();
    importedKeys.set(
      secret,
      crypto.subtle.importKey(
        "raw",
        decodeKey(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    );
  }
  return importedKeys.get(secret);
}
function context({ scope, origin }) {
  if (!["production", "check"].includes(scope))
    throw new LibraryError("service_unavailable", 503);
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new LibraryError("service_unavailable", 503);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    throw new LibraryError("service_unavailable", 503);
  return { scope, origin };
}
function message(kind, value, options) {
  const { scope, origin } = context(options);
  return encoder.encode(
    `the-shelf/cf03/v1/${kind}\n${scope}\n${origin}\n${value}`,
  );
}
async function sign(secret, bytes) {
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", await importHmac(secret), bytes),
  );
}
export async function createOwnerVerifier(accessKey, pepper, options) {
  decodeKey(accessKey);
  return hex(await sign(pepper, message("owner", accessKey, options)));
}
export async function verifyOwnerKey(accessKey, verifier, pepper, options) {
  // A malformed candidate is processed with a fixed neutral candidate; no human password hash exists here.
  const valid = isCanonicalKey(accessKey);
  if (!valid) accessKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const verified = await crypto.subtle.verify(
    "HMAC",
    await importHmac(pepper),
    unhex(verifier),
    message("owner", accessKey, options),
  );
  return valid && verified;
}
export async function sessionDigest(token, secret, options) {
  decodeKey(token);
  return hex(await sign(secret, message("session", token, options)));
}
export async function csrfForSession(token, secret, options) {
  decodeKey(token);
  return encodeKey(await sign(secret, message("csrf", token, options)));
}
export async function verifyCsrf(value, token, secret, options) {
  let signature;
  try {
    signature = decodeKey(value);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    "HMAC",
    await importHmac(secret),
    signature,
    message("csrf", token, options),
  );
}
export async function ipDigest(ip, secret) {
  return hex(
    await sign(
      secret,
      encoder.encode(`the-shelf/cf03/v1/ip\n${canonicalIp(ip)}`),
    ),
  );
}
export function canonicalIp(ip) {
  if (typeof ip !== "string" || ip.length > 64) return "unknown";
  if (
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split(".").every((s) => Number(s) <= 255)
  )
    return ip.split(".").map(Number).join(".");
  if (!/^[0-9a-f:]+$/i.test(ip) || !ip.includes(":")) return "unknown";
  try {
    const normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
    const sides = normalized.split("::");
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides[1] ? sides[1].split(":") : [];
    const words =
      sides.length === 2
        ? [
            ...left,
            ...Array(8 - left.length - right.length).fill("0"),
            ...right,
          ]
        : left;
    if (words.length !== 8) return "unknown";
    return (
      words
        .slice(0, 4)
        .map((v) => Number.parseInt(v, 16).toString(16))
        .join(":") + "::/64"
    );
  } catch {
    return "unknown";
  }
}
export async function readJson(request) {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > 16384)
  )
    throw new LibraryError("body_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new LibraryError("invalid_json");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) {
        await reader.cancel();
        throw new LibraryError("body_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error();
    return input;
  } catch {
    throw new LibraryError("invalid_json");
  }
}
