// Whether Turntable retries an infra error by itself. The attempt carries the reason text
// (`errorClass`); a refused checkout (kind `checkout_auth_failed`, never transient) says so in
// fixed words, so the page must not promise a retry for it.
const NOT_RETRIED_PREFIXES: readonly string[] = ["the checkout was refused by GitHub"];

/** True when an infra-error attempt is one Turntable retries automatically. */
export function retriedAutomatically(a: { errorClass: string | null }): boolean {
  const reason = a.errorClass ?? "";
  return !NOT_RETRIED_PREFIXES.some((p) => reason.startsWith(p));
}
