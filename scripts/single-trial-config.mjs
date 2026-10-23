import { createHash } from "node:crypto";
import {
  SINGLE_TRIAL_MODE,
  SINGLE_TRIAL_BUCKET,
} from "../cloudflare/library/single-trial.mjs";
export const SINGLE_TRIAL_TARGET_PATH =
  ".local/cf03/production/single-trial-target.json";
export const SINGLE_TRIAL_SECRET_PATH =
  ".local/cf03/production/single-trial-upload-secret";
export const stableTrialJson = (v) =>
  JSON.stringify(v, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
const sha = (value) => createHash("sha256").update(value).digest("hex");
export function validateSingleTrialTarget(value, accountId, secret) {
  const keys = [
    "schemaVersion",
    "mode",
    "accountId",
    "bucket",
    "worker",
    "origin",
    "uploadSecretSha256",
  ];
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(value, k)) ||
    value.schemaVersion !== 1 ||
    value.mode !== SINGLE_TRIAL_MODE ||
    value.accountId !== accountId ||
    !/^[a-f0-9]{32}$/.test(accountId || "") ||
    value.bucket !== SINGLE_TRIAL_BUCKET ||
    value.worker !== "the-shelf" ||
    value.origin !== "https://the-shelf.iamzhutuo.workers.dev" ||
    !/^[a-f0-9]{64}$/.test(value.uploadSecretSha256 || "") ||
    (secret !== undefined &&
      (!/^[A-Za-z0-9_-]{43}$/.test(secret) ||
        sha(secret) !== value.uploadSecretSha256))
  )
    throw new Error("single_trial_target_invalid");
  return Object.freeze({ ...value, configSha256: sha(stableTrialJson(value)) });
}
