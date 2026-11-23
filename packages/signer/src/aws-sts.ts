// `sts:AssumeRoleWithWebIdentity` over the STS Query API (an unsigned call: the OIDC token is
// the credential), and a credential cache on top of it. The credentials are temporary, held in
// memory only, and never logged or returned in an error.
import { type SafeFetch, safeFetch } from "@turntable/net";
import type { AwsCredentials } from "./sigv4";
import { AwsSignerError } from "./types";

export interface WebIdentityOptions {
  region: string;
  roleArn: string;
  /** A fresh OIDC token for the audience `sts.amazonaws.com` (or the configured one). */
  token(): Promise<string>;
  sessionName?: string;
  /** Seconds the credentials last (900 to 43200 at AWS; 900 here by default). */
  durationSeconds?: number;
  /** Refresh this long before expiry. Default 60 seconds. */
  refreshBeforeMs?: number;
  fetch?: SafeFetch;
  /** Test seam. Default `https://sts.<region>.amazonaws.com`. */
  endpoint?: string;
  now?: () => number;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const THROTTLE = new Set(["Throttling", "ThrottlingException", "RequestLimitExceeded"]);

/** The error code only: a response body can carry account detail and is never kept. */
function errorCode(text: string): string {
  const m =
    /<Code>([A-Za-z]{1,64})<\/Code>/.exec(text) ?? /"Code"\s*:\s*"([A-Za-z]{1,64})"/.exec(text);
  return m?.[1] ?? "unknown";
}

async function assume(
  o: WebIdentityOptions,
): Promise<{ creds: AwsCredentials; expiresAt: number }> {
  const endpoint = o.endpoint ?? `https://sts.${o.region}.amazonaws.com`;
  const form = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: o.roleArn,
    RoleSessionName: o.sessionName ?? "turntable-release",
    WebIdentityToken: await o.token(),
    DurationSeconds: String(o.durationSeconds ?? 900),
  });
  let res: Response;
  try {
    res = await (o.fetch ?? safeFetch)(`${endpoint}/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "manual",
      maxBytes: 100_000,
      timeoutMs: 30_000,
    });
  } catch {
    throw new AwsSignerError("network", "STS AssumeRoleWithWebIdentity: the request failed");
  }
  if (!res.ok) {
    const code = errorCode(await res.text().catch(() => ""));
    // A throttle and a server error are worth retrying; the rest is a refusal of this token or role.
    const retry = res.status >= 500 || res.status === 429 || THROTTLE.has(code);
    throw new AwsSignerError(
      retry ? "network" : "sts_denied",
      `STS AssumeRoleWithWebIdentity failed: HTTP ${res.status} ${code}`,
    );
  }
  let c: Record<string, unknown> | undefined;
  try {
    const out = (await res.json()) as {
      AssumeRoleWithWebIdentityResponse?: {
        AssumeRoleWithWebIdentityResult?: { Credentials?: Record<string, unknown> };
      };
    };
    c = out.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
  } catch {
    c = undefined;
  }
  const exp =
    typeof c?.Expiration === "number" ? c.Expiration * 1000 : Date.parse(String(c?.Expiration));
  if (
    typeof c?.AccessKeyId !== "string" ||
    typeof c.SecretAccessKey !== "string" ||
    typeof c.SessionToken !== "string" ||
    !Number.isFinite(exp)
  ) {
    throw new AwsSignerError("sts_denied", "STS returned no usable credentials");
  }
  return {
    creds: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    },
    expiresAt: exp,
  };
}

/**
 * A credentials provider: assumes the role with a fresh token, caches the credentials in memory
 * until `refreshBeforeMs` before they expire, and shares one in-flight call between callers.
 */
export function webIdentityCredentials(o: WebIdentityOptions): () => Promise<AwsCredentials> {
  if (!REGION.test(o.region)) throw new AwsSignerError("sts_denied", "bad region");
  if (!ROLE_ARN.test(o.roleArn)) throw new AwsSignerError("sts_denied", "bad role ARN");
  const now = o.now ?? Date.now;
  const margin = o.refreshBeforeMs ?? 60_000;
  let cached: { creds: AwsCredentials; expiresAt: number } | undefined;
  let inflight: Promise<AwsCredentials> | undefined;
  return async () => {
    if (cached && now() < cached.expiresAt - margin) return cached.creds;
    inflight ??= assume(o)
      .then((r) => {
        cached = r;
        return r.creds;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
