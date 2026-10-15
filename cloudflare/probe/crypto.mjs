import { scryptSync, timingSafeEqual } from "node:crypto";

const FAILURE_CODES = new Set([
  "pbkdf2_iteration_limit", "pbkdf2_unsupported", "pbkdf2_parameter_rejected", "pbkdf2_operation_failed", "pbkdf2_failed",
  "scrypt_unsupported", "scrypt_parameter_rejected", "scrypt_failed",
]);
export class CryptoProbeError extends Error {
  constructor(code) { super("CF-01 controlled crypto failure"); this.code = code; }
}
export function classifyCryptoFailure(kind, error) {
  const name = typeof error?.name === "string" ? error.name : "";
  const message = typeof error?.message === "string" ? error.message : "";
  // Inspect only to classify; never persist, log or return raw exception text.
  if (kind === "pbkdf2" && /iterations?.{0,100}(?:exceed|too (?:large|high)|limit|not supported|maximum)|(?:maximum|limit).{0,100}iterations?/i.test(message))
    return "pbkdf2_iteration_limit";
  if (name === "NotSupportedError" || /not (?:yet )?(?:implemented|supported)|unsupported/i.test(message))
    return `${kind}_unsupported`;
  if (["RangeError", "DataError", "InvalidAccessError", "SyntaxError"].includes(name))
    return `${kind}_parameter_rejected`;
  if (kind === "pbkdf2" && name === "OperationError") return "pbkdf2_operation_failed";
  return `${kind}_failed`;
}
export function safeCryptoFailureReason(error) {
  return error instanceof CryptoProbeError && FAILURE_CODES.has(error.code) ? error.code : "probe_failed";
}

export async function cryptoProbe(kind) {
  if (!["scrypt", "pbkdf2"].includes(kind)) throw new CryptoProbeError("invalid_kind");
  try { return await executeCryptoProbe(kind); }
  catch (error) { throw new CryptoProbeError(classifyCryptoFailure(kind, error)); }
}

async function executeCryptoProbe(kind) {
  // Fixed neutral password, never the real Shelf password or its verifier.
  const password = "cf01-neutral-test-password-with-no-user-data";
  const salt = new Uint8Array(32).fill(37);
  const started = Date.now();
  if (kind === "scrypt") {
    // Mirrors server/index.mjs's default scryptSync, including startup + verify.
    const params = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
    const stored = scryptSync(password, salt, 32, params);
    const verified = timingSafeEqual(stored, scryptSync(password, salt, 32, params));
    return { algorithm: "scrypt", N: 16384, r: 8, p: 1, keyBytes: 32, operations: 2, verified, wallMs: Date.now() - started, timerSource: "io_advancing_runtime_clock_not_cpu", cpuSource: "cloudflare_tail_or_analytics_only" };
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derive = () => crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, key, 256);
  const stored = new Uint8Array(await derive());
  const actual = new Uint8Array(await derive());
  const verified = stored.every((v, i) => v === actual[i]);
  return { algorithm: "PBKDF2-SHA256", iterations: 600000, keyBytes: 32, operations: 2, verified, wallMs: Date.now() - started, timerSource: "io_advancing_runtime_clock_not_cpu", cpuSource: "cloudflare_tail_or_analytics_only" };
}
