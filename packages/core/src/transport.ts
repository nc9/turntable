// Transport policy for the whole HTTP server: plain http is redirected to https, and responses
// that went over https carry HSTS. Every site we run does both (the proxy in front is the primary
// control; this keeps a proxy misconfiguration from serving plain http).
//
// The scheme is only believed from a proxy the operator says is theirs: with
// TURNTABLE_TRUST_FORWARDED_PROTO=1 the last x-forwarded-proto hop counts. Without that, a
// request is https only if the server itself terminated TLS. Loopback dev, with no proxy
// headers, is never touched.

export interface TransportOptions {
  /** Believe `x-forwarded-proto` (TURNTABLE_TRUST_FORWARDED_PROTO=1). */
  trustForwardedProto: boolean;
  /** Strict-Transport-Security max-age in seconds; 0 turns the header off. */
  hstsMaxAge: number;
  hstsIncludeSubDomains: boolean;
}

export const DEFAULT_HSTS_MAX_AGE = 31_536_000;

export function transportOptionsFromEnv(env: Record<string, string | undefined>): TransportOptions {
  const raw = env.TURNTABLE_HSTS_MAX_AGE?.trim().toLowerCase();
  const maxAge =
    raw === undefined || raw === "" ? DEFAULT_HSTS_MAX_AGE : raw === "off" ? 0 : Number(raw);
  if (!Number.isInteger(maxAge) || maxAge < 0) {
    throw new Error("TURNTABLE_HSTS_MAX_AGE must be a whole number of seconds, or off");
  }
  return {
    trustForwardedProto: env.TURNTABLE_TRUST_FORWARDED_PROTO === "1",
    hstsMaxAge: maxAge,
    hstsIncludeSubDomains: env.TURNTABLE_HSTS_INCLUDE_SUBDOMAINS !== "0",
  };
}

export type TransportDecision =
  | { action: "pass"; secure: boolean }
  | { action: "redirect"; location: string }
  | { action: "reject" };

/** A host[:port] as the Host header carries it: no userinfo, path or whitespace. */
const SAFE_HOST = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

/**
 * Decides what to do with a request before anything else sees it.
 *  - https (server-terminated TLS, or a trusted forwarded proto of https): pass, secure.
 *  - a trusted forwarded proto of http: GET and HEAD get a 301 to the https URL, anything else is
 *    refused (a redirect would silently drop a body or change its method).
 *  - anything else (no proxy headers, which is how loopback dev looks, or forwarded headers we do
 *    not trust): pass untouched, not secure.
 */
export function decideTransport(
  req: Request,
  o: Pick<TransportOptions, "trustForwardedProto">,
): TransportDecision {
  const url = new URL(req.url);
  if (url.protocol === "https:") return { action: "pass", secure: true };
  if (o.trustForwardedProto) {
    const proto = req.headers.get("x-forwarded-proto")?.split(",").at(-1)?.trim().toLowerCase();
    if (proto === "https") return { action: "pass", secure: true };
    if (proto === "http") {
      if (req.method !== "GET" && req.method !== "HEAD") return { action: "reject" };
      const host = req.headers.get("host") ?? "";
      if (!SAFE_HOST.test(host)) return { action: "reject" };
      return { action: "redirect", location: `https://${host}${url.pathname}${url.search}` };
    }
  }
  return { action: "pass", secure: false };
}

export function hstsValue(o: TransportOptions): string | undefined {
  if (o.hstsMaxAge <= 0) return undefined;
  return `max-age=${o.hstsMaxAge}${o.hstsIncludeSubDomains ? "; includeSubDomains" : ""}`;
}

/** The response with HSTS added. A new Response, because a fetched one has immutable headers. */
export function withHsts(res: Response, o: TransportOptions): Response {
  const v = hstsValue(o);
  if (!v) return res;
  const headers = new Headers(res.headers);
  headers.set("strict-transport-security", v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const redirectResponse = (location: string): Response =>
  new Response(null, {
    status: 301,
    headers: { location, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

export const rejectResponse = (): Response =>
  new Response("https is required", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
