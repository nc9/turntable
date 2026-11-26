// Text of an infra error made safe to show an instance administrator or write to a job log (#670).
import { redactString } from "@turntable/redact";

const INFRA_ERROR_MAX_CHARS = 500;

/**
 * The stored text of an infra error, made safe for the instance administrator (#670): secrets and
 * tokens redacted by the shared redactor, credentials and query strings and fragments stripped from
 * URLs, control characters and runs of whitespace folded, and the length capped. Exported for tests.
 */
export function sanitizeInfraError(raw: string | null): string {
  if (!raw) return "";
  const noSecrets = redactString(raw);
  const noUrlSecrets = noSecrets.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/?#@]*@)?([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?/gi,
    "$1$2",
  );
  const flat = noUrlSecrets
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > INFRA_ERROR_MAX_CHARS ? `${flat.slice(0, INFRA_ERROR_MAX_CHARS)}...` : flat;
}
