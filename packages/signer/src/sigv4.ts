// AWS Signature Version 4, by hand with node:crypto (no AWS SDK). General enough for the AWS
// published test suite (GET with a query, POST with a body); the KMS and STS callers use it with
// their own fixed headers. Only what the callers need: no chunked payloads, no presigned URLs.
import crypto from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials always have one; sent as `x-amz-security-token` and signed. */
  sessionToken?: string | undefined;
}

export interface SigV4Request {
  method: string;
  /** Already URI-encoded path, `/` when empty. */
  path?: string;
  /** Raw (unencoded) query parameters; names and values are encoded and sorted here. */
  query?: readonly (readonly [string, string])[];
  /** Headers to send and sign. `host` is required. Names are matched case-insensitively. */
  headers: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** `YYYYMMDD'T'HHMMSS'Z'`. */
  amzDate: string;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  crypto.createHmac("sha256", key).update(data).digest();
const sha256Hex = (data: string): string => crypto.createHash("sha256").update(data).digest("hex");

/** RFC 3986 unreserved characters stay; everything else is percent-encoded in upper-case hex. */
const encode = (s: string): string =>
  encodeURIComponent(s).replaceAll(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `YYYYMMDD'T'HHMMSS'Z'` for a time in ms. */
export const amzDateOf = (ms: number): string =>
  new Date(ms).toISOString().replaceAll(/[-:]|\.\d{3}/g, "");

/**
 * The headers to send: the given ones (lower-cased), `x-amz-date`, `x-amz-security-token` when the
 * credentials have a session token, and `authorization`.
 */
export function signV4(r: SigV4Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = v.trim();
  headers["x-amz-date"] = r.amzDate;
  if (r.credentials.sessionToken) headers["x-amz-security-token"] = r.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const query = (r.query ?? [])
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    r.method,
    r.path || "/",
    query,
    ...names.map((n) => `${n}:${headers[n]}`),
    "",
    names.join(";"),
    sha256Hex(r.body ?? ""),
  ].join("\n");
  const date = r.amzDate.slice(0, 8);
  const scope = `${date}/${r.region}/${r.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", r.amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${r.credentials.secretAccessKey}`, date), r.region), r.service),
    "aws4_request",
  );
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}
