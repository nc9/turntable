// The release lane's configuration from the operator org owner's browser (#541). Each write runs
// the passkey step-up first: ask the server for a challenge bound to this exact input, sign it with
// the person's own passkey, then send the input with the assertion. A secret value never goes into
// the challenge: its digest does, so the device and the challenge request never see the value.
import type { TurntableApi } from "@/api/client";
import type { LaneAction, StepUpProof, WebAuthnSignature } from "@/api/types";

/** What `release_secret_set` binds in place of the value: sha256 hex of a fixed prefix, field and value. */
export async function secretDigest(field: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`turntable.step_up.secret.v1\0${field}\0${value}`);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A key id (hex sha256 of the SPKI DER) as colon-separated upper-case pairs, to compare by eye. */
export function fingerprintOf(keyid: string): string {
  return (keyid.toUpperCase().match(/.{1,2}/g) ?? []).join(":");
}

export type Signer = (o: {
  challenge: string;
  rpId: string;
  passkeyId: string;
}) => Promise<WebAuthnSignature>;

/**
 * Runs one lane write behind its step-up. `input` is exactly what the op takes (snake_case); for
 * `release_secret_set` it holds `value`, which is replaced by its digest in the challenge.
 * Resolves with the op's answer; rejects with the server's refusal or the ceremony's failure.
 */
export async function runLaneWrite(
  api: TurntableApi,
  sign: Signer,
  action: LaneAction,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const asked: Record<string, unknown> = { ...input };
  if (action === "release_secret_set") {
    asked.value_sha256 = await secretDigest("value", String(input.value ?? ""));
    delete asked.value;
  }
  const c = await api.stepUpChallenge({ action, input: asked });
  const key = c.passkeys[0];
  if (!key) throw new Error("No passkey of yours is enrolled to confirm this.");
  const sig = await sign({ challenge: c.challenge, rpId: c.rpId, passkeyId: key.passkeyId });
  const stepUp: StepUpProof = {
    id: c.id,
    approver: key.approver,
    signature: {
      credential_id: sig.credential_id,
      client_data_json: sig.client_data_json,
      authenticator_data: sig.authenticator_data,
      signature: sig.signature,
    },
  };
  return api.laneWrite({ action, input, stepUp });
}

/** Splits comma or newline separated text into trimmed, non-empty items. */
export function listOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

/** Who sees the page: an owner of the operator org. The server enforces it either way. */
export function canConfigureLane(who: { role: string; operatorOrg: boolean } | undefined): boolean {
  return who?.role === "owner" && who.operatorOrg === true;
}

/** The input of `release_set_project_signing` from the form's text fields. */
export function signingInput(f: {
  targetOrg: string;
  targetProject: string;
  signingKey: string;
  environment: string;
  refs: string;
}): Record<string, unknown> {
  return {
    target_org: f.targetOrg.trim(),
    target_project: f.targetProject.trim(),
    signing_key: f.signingKey.trim(),
    ...(f.environment.trim() ? { signing_environment: f.environment.trim() } : {}),
    ...(listOf(f.refs).length > 0 ? { release_refs: listOf(f.refs) } : {}),
  };
}

/** The input of `release_cosign_key_set` from the form's text fields. */
export function cosignKeyInput(f: {
  targetOrg: string;
  targetProject: string;
  name: string;
  publicKeyPem: string;
  signs: string;
  outputName: string;
  manifestBinaries: boolean;
}): Record<string, unknown> {
  return {
    target_org: f.targetOrg.trim(),
    target_project: f.targetProject.trim(),
    name: f.name.trim(),
    public_key_pem: f.publicKeyPem.trim(),
    signs: f.signs.trim(),
    output_name: f.outputName.trim(),
    format: "detached-der-p256-sha256",
    ...(f.manifestBinaries ? { manifest_binaries: true } : {}),
  };
}

/** The input of `release_publish_target_set` from the form: only the fields its kind takes. */
export function targetInput(f: {
  targetOrg: string;
  targetProject: string;
  key: string;
  kind: "npm" | "github-release" | "oci-image";
  fields: Record<string, string>;
  acceptLongLived: boolean;
}): Record<string, unknown> {
  const t = (k: string): string => (f.fields[k] ?? "").trim();
  const out: Record<string, unknown> = {
    target_org: f.targetOrg.trim(),
    target_project: f.targetProject.trim(),
    key: f.key.trim(),
    kind: f.kind,
  };
  const put = (k: string): void => {
    if (t(k)) out[k] = t(k);
  };
  if (f.kind === "npm") {
    for (const k of ["package", "artifact", "secret", "tag", "access"]) put(k);
    out.accept_long_lived_token = f.acceptLongLived;
  } else if (f.kind === "github-release") {
    if (listOf(f.fields.assets ?? "").length > 0) out.assets = listOf(f.fields.assets ?? "");
    if (listOf(f.fields.asset_artifacts ?? "").length > 0)
      out.asset_artifacts = listOf(f.fields.asset_artifacts ?? "");
    put("provenance_asset");
  } else {
    for (const k of ["registry", "repository", "manifest", "username", "secret", "realm_host"]) {
      put(k);
    }
    if (listOf(f.fields.tags ?? "").length > 0) out.tags = listOf(f.fields.tags ?? "");
  }
  return out;
}
