// The HMAC secret that signs the audit webhook and the anchor export: TURNTABLE_AUDIT_WEBHOOK_SECRET,
// or the first line of the file TURNTABLE_AUDIT_WEBHOOK_SECRET_FILE. Read ONCE at boot and deleted
// from the environment, like the master key (see secrets/master-key.ts), so no child process or
// plugin inherits it.
import { readFileSync } from "node:fs";

export const AUDIT_WEBHOOK_SECRET_ENV = "TURNTABLE_AUDIT_WEBHOOK_SECRET";
export const AUDIT_WEBHOOK_SECRET_FILE_ENV = "TURNTABLE_AUDIT_WEBHOOK_SECRET_FILE";

type Env = Record<string, string | undefined>;

/** A secret variable and file set together, or a file that is empty. Never carries the secret. */
export class AuditWebhookSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditWebhookSecretError";
  }
}

/** Reads the secret from `env` and DELETES the variable from it. Call once, early, at boot. */
export function takeAuditWebhookSecret(env: Env = process.env): string | undefined {
  const value = env[AUDIT_WEBHOOK_SECRET_ENV]?.trim() || undefined;
  const file = env[AUDIT_WEBHOOK_SECRET_FILE_ENV]?.trim() || undefined;
  // Gone from the environment whatever happens next, even if this throws.
  delete env[AUDIT_WEBHOOK_SECRET_ENV];
  if (value && file) {
    throw new AuditWebhookSecretError(
      `${AUDIT_WEBHOOK_SECRET_ENV} and ${AUDIT_WEBHOOK_SECRET_FILE_ENV} are both set: use one`,
    );
  }
  if (value) return value;
  if (!file) return undefined;
  const text = readFileSync(file, "utf8").trim();
  if (text === "") throw new AuditWebhookSecretError(`${file} is empty`);
  return text;
}
