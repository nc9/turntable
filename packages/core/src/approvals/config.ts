import type { RelyingParty } from "./webauthn";

/**
 * The WebAuthn relying party. By default derived from the public URL: the rp id is its host and
 * the one allowed origin is its origin. TURNTABLE_WEBAUTHN_RP_ID and TURNTABLE_WEBAUTHN_ORIGINS
 * override (several origins, or a parent domain as rp id). Without either, WebAuthn is off and
 * only offline ed25519 approvals work. A passkey is bound to the rp id: changing it orphans
 * every enrolled passkey.
 */
export function relyingPartyFromEnv(
  publicUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): RelyingParty | undefined {
  const origins = (env.TURNTABLE_WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  let rpId = env.TURNTABLE_WEBAUTHN_RP_ID?.trim() || undefined;
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      rpId ??= u.hostname;
      if (origins.length === 0) origins.push(u.origin);
    } catch {
      // an invalid public URL gives no relying party
    }
  }
  if (!rpId || origins.length === 0) return undefined;
  return { rpId, origins };
}
