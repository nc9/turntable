// The one outbound HTTP client of the control plane (issue #49). Everything the control plane
// fetches goes through it: the GitHub API and codeload, the Daytona API, release downloads, and
// outbound webhooks later. A source-guard test fails if anything else calls fetch.
//
// What it enforces:
//  - the URL: https only (http only for an allowlisted host), no credentials in the URL;
//  - the address: the host is resolved here, EVERY answer must be public (loopback, link-local
//    including cloud metadata, RFC1918, CGNAT, ULA and the rest are refused) unless the host is
//    explicitly allowlisted;
//  - pinning: the connection goes to the address that was validated, never to a second lookup, so
//    DNS rebinding between check and connect is impossible;
//  - redirects: followed by hand, each hop fully re-validated, at most 5, never to a refused
//    address, credentials dropped when the origin changes;
//  - size and time: responses are capped while streaming and the whole exchange has a deadline.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { blockedReason } from "./ip";

export class SsrfError extends Error {
  readonly host: string;
  readonly reason: string;
  constructor(host: string, reason: string) {
    super(`refusing to contact ${host}: ${reason}`);
    this.name = "SsrfError";
    this.host = host;
    this.reason = reason;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(max: number) {
    super(`response is larger than ${max} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export class RequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`request timed out after ${ms} ms`);
    this.name = "RequestTimeoutError";
  }
}

export class TooManyRedirectsError extends Error {
  constructor(max: number) {
    super(`more than ${max} redirects`);
    this.name = "TooManyRedirectsError";
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

export interface RequestExtras {
  /** Response cap in bytes. Default: the client's `maxBytes` (32 MiB). */
  maxBytes?: number;
  /** Deadline for the whole exchange, redirects included. Default: the client's (30 s). */
  timeoutMs?: number;
}

export type SafeFetch = (
  input: string | URL | Request,
  init?: RequestInit & RequestExtras,
) => Promise<Response>;

export interface HttpClientOptions {
  /**
   * Hostnames or IP literals that may resolve to a private or loopback address (a local Daytona,
   * a test server), and may use plain http. Exact match, case-insensitive. Nothing else is.
   */
  allowHosts?: readonly string[];
  /** DNS. Default: the system resolver, all answers. */
  resolve?: Resolver;
  /**
   * How long one address may take to connect before the next one is tried, when a name has more
   * than one. The last address gets whatever is left of the overall deadline. Default 3000.
   */
  connectAttemptMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_BODY = new Set([101, 204, 205, 304]);
const SENSITIVE = ["authorization", "cookie", "proxy-authorization"];

const defaultResolve: Resolver = async (h) =>
  (await dnsLookup(h, { all: true, verbatim: true })).map((a) => a.address);

interface Target {
  url: URL;
  host: string;
  /**
   * Every validated address, in the order to try them. Each attempt is pinned to its own
   * address: DNS is never consulted again.
   */
  ips: string[];
}

/**
 * Orders addresses for connecting: the two families interleaved, starting with the family the
 * resolver listed first, each family keeping its own order. A host with an IPv6 answer and no
 * IPv6 route then reaches its IPv4 address after one failed attempt, and the reverse.
 */
export function interleaveFamilies(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const v6: string[] = [];
  const v4: string[] = [];
  let firstIs6 = false;
  for (const a of addresses) {
    if (seen.has(a)) continue;
    if (seen.size === 0) firstIs6 = isIP(a) === 6;
    seen.add(a);
    (isIP(a) === 6 ? v6 : v4).push(a);
  }
  const [first, second] = firstIs6 ? [v6, v4] : [v4, v6];
  const out: string[] = [];
  for (let i = 0; i < Math.max(first.length, second.length); i += 1) {
    if (i < first.length) out.push(first[i] as string);
    if (i < second.length) out.push(second[i] as string);
  }
  return out;
}

/** A failure before the TCP connection was made: nothing was sent, so another address may be tried. */
class ConnectFailure extends Error {
  readonly underlying: Error;
  constructor(underlying: Error) {
    super(underlying.message);
    this.underlying = underlying;
  }
}

export interface HttpClient {
  fetch: SafeFetch;
}

export function createHttpClient(o: HttpClientOptions = {}): HttpClient {
  const allow = new Set((o.allowHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  const resolve = o.resolve ?? defaultResolve;
  const maxRedirects = o.maxRedirects ?? 5;
  const defaultMax = o.maxBytes ?? 32 * 1024 * 1024;
  const defaultTimeout = o.timeoutMs ?? 30_000;
  const attemptMs = o.connectAttemptMs ?? 3000;
  const ua = o.userAgent ?? "longshore";

  const hostOf = (u: URL): string => {
    let h = u.hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    return h.endsWith(".") ? h.slice(0, -1) : h;
  };

  /** Validates a URL and resolves its host to the addresses the connection may use. */
  async function target(url: URL): Promise<Target> {
    const host = hostOf(url);
    const allowed = allow.has(host);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && allowed)) {
      throw new SsrfError(
        host || url.href,
        `${url.protocol.replace(":", "")} is not allowed (https only)`,
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new SsrfError(host, "credentials in the URL are not allowed");
    }
    if (host === "") throw new SsrfError(url.href, "no host");
    if (!allowed && (host === "localhost" || host.endsWith(".localhost"))) {
      throw new SsrfError(host, "localhost is not allowed");
    }
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (addresses.length === 0) throw new SsrfError(host, "the name did not resolve");
    if (!allowed) {
      // Every answer must be public: one private record among public ones is still refused.
      for (const a of addresses) {
        const why = blockedReason(a);
        if (why) throw new SsrfError(host, `${a} is ${why}`);
      }
    }
    return { url, host, ips: interleaveFamilies(addresses) };
  }

  /**
   * Tries each validated address in turn. Only a failure to connect moves on to the next one (no
   * byte was sent, so a retry is safe for any method); anything after the connection was made,
   * or the overall deadline, ends the attempt. Every attempt is pinned to its own address.
   */
  async function exchange(
    t: Target,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
    deadline: AbortSignal,
    maxBytes: number,
  ): Promise<{ status: number; statusText: string; headers: Headers; bytes: Uint8Array }> {
    let last: Error | undefined;
    for (let i = 0; i < t.ips.length; i += 1) {
      const isLast = i === t.ips.length - 1;
      try {
        return await once(
          t,
          t.ips[i] as string,
          method,
          headers,
          body,
          deadline,
          maxBytes,
          isLast ? undefined : attemptMs,
        );
      } catch (err) {
        if (!(err instanceof ConnectFailure) || deadline.aborted) {
          throw err instanceof ConnectFailure ? err.underlying : err;
        }
        last = err.underlying;
      }
    }
    throw last ?? new Error("no address to connect to");
  }

  async function once(
    t: Target,
    ip: string,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
    deadline: AbortSignal,
    maxBytes: number,
    connectTimeoutMs?: number,
  ): Promise<{ status: number; statusText: string; headers: Headers; bytes: Uint8Array }> {
    const isHttps = t.url.protocol === "https:";
    const lib = isHttps ? https : http;
    return await new Promise((resolveP, rejectP) => {
      const req = lib.request(
        {
          host: t.host,
          port: t.url.port === "" ? (isHttps ? 443 : 80) : Number(t.url.port),
          method,
          path: `${t.url.pathname}${t.url.search}`,
          headers,
          agent: false,
          // The connection goes to the address validated above. DNS is not consulted again, so a
          // record that changes after the check cannot redirect the connection.
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
            const entry = { address: ip, family: isIP(ip) };
            if (opts?.all) cb(null, [entry]);
            else cb(null, entry.address, entry.family);
          }) as unknown as http.RequestOptions["lookup"],
          ...(isHttps && !isIP(t.host) ? { servername: t.host } : {}),
        } as https.RequestOptions,
        (res) => {
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            rejectP(new ResponseTooLargeError(maxBytes));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total > maxBytes) {
              res.destroy();
              req.destroy();
              rejectP(new ResponseTooLargeError(maxBytes));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) for (const x of v) h.append(k, x);
              else if (v !== undefined) h.set(k, v);
            }
            resolveP({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: h,
              bytes: new Uint8Array(Buffer.concat(chunks)),
            });
          });
          res.on("error", rejectP);
        },
      );
      // Until the TCP connection is made, a failure (refused, unreachable, too slow) is a
      // ConnectFailure: the caller may try the next address.
      let connected = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      req.on("socket", (socket) => {
        const made = (): void => {
          connected = true;
          clearTimeout(connectTimer);
        };
        if (!socket.connecting) {
          made();
          return;
        }
        socket.once("connect", made);
        if (connectTimeoutMs !== undefined) {
          connectTimer = setTimeout(() => {
            if (connected) return;
            const e = new Error(`connect to ${ip} timed out`);
            (e as NodeJS.ErrnoException).code = "ETIMEDOUT";
            req.destroy(e);
          }, connectTimeoutMs);
        }
      });
      req.on("error", (e) => {
        clearTimeout(connectTimer);
        rejectP(connected || deadline.aborted ? e : new ConnectFailure(e));
      });
      const onAbort = (): void => {
        req.destroy();
        rejectP(deadline.reason instanceof Error ? deadline.reason : new Error("aborted"));
      };
      if (deadline.aborted) onAbort();
      else deadline.addEventListener("abort", onAbort, { once: true });
      req.end(body ? Buffer.from(body) : undefined);
    });
  }

  const doFetch: SafeFetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    let url = new URL(request ? request.url : String(input));
    let method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const hdrs = new Headers(request?.headers);
    new Headers(init.headers).forEach((v, k) => hdrs.set(k, v));
    if (!hdrs.has("user-agent")) hdrs.set("user-agent", ua);
    if (!hdrs.has("accept-encoding")) hdrs.set("accept-encoding", "identity");
    let body: Uint8Array | undefined;
    const rawBody = init.body ?? (request ? await request.clone().arrayBuffer() : undefined);
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === "string") {
        body = new TextEncoder().encode(rawBody);
      } else {
        // FormData, URLSearchParams, Blob and streams: let Response serialise them, and keep the
        // content type it derives (a multipart boundary, for one).
        const r = new Response(rawBody as ConstructorParameters<typeof Response>[0]);
        const ct = r.headers.get("content-type"); // before the body is consumed
        body = new Uint8Array(await r.arrayBuffer());
        if (ct && !hdrs.has("content-type")) hdrs.set("content-type", ct);
      }
      hdrs.set("content-length", String(body.length));
    }

    const maxBytes = init.maxBytes ?? defaultMax;
    const timeoutMs = init.timeoutMs ?? defaultTimeout;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new RequestTimeoutError(timeoutMs)), timeoutMs);
    const outer = init.signal ?? request?.signal;
    const onOuter = (): void => ac.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) onOuter();
      else outer.addEventListener("abort", onOuter, { once: true });
    }
    try {
      const redirectMode = init.redirect ?? "follow";
      for (let hop = 0; ; hop += 1) {
        const t = await target(url);
        const send: Record<string, string> = {};
        hdrs.forEach((v, k) => (send[k] = v));
        const res = await exchange(
          t,
          method,
          send,
          body && method !== "GET" && method !== "HEAD" ? body : undefined,
          ac.signal,
          maxBytes,
        );
        const location = res.headers.get("location");
        if (REDIRECTS.has(res.status) && location !== null && redirectMode !== "manual") {
          if (redirectMode === "error") throw new TypeError("unexpected redirect");
          if (hop >= maxRedirects) throw new TooManyRedirectsError(maxRedirects);
          const next = new URL(location, url);
          if (next.origin !== url.origin) for (const h of SENSITIVE) hdrs.delete(h);
          if (
            res.status === 303 ||
            ((res.status === 301 || res.status === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
            hdrs.delete("content-type");
            hdrs.delete("content-length");
          }
          url = next; // validated in full at the top of the loop: scheme, host, address
          continue;
        }
        return new Response(NO_BODY.has(res.status) || method === "HEAD" ? null : res.bytes, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
  };

  return { fetch: doFetch };
}

/** Parses `LONGSHORE_NET_ALLOW_HOSTS`: comma-separated hostnames or IP literals. */
export function allowHostsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.LONGSHORE_NET_ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

let shared: { key: string; client: HttpClient } | undefined;

/**
 * The process-wide client: addresses validated, hosts from LONGSHORE_NET_ALLOW_HOSTS allowed to
 * be private (for example a local Daytona). This is what callers use unless a test injects its own.
 * The allowlist is read from the environment on each call, so a changed value takes effect.
 */
export const safeFetch: SafeFetch = (input, init) => {
  const key = process.env.LONGSHORE_NET_ALLOW_HOSTS ?? "";
  if (shared?.key !== key)
    shared = { key, client: createHttpClient({ allowHosts: allowHostsFromEnv() }) };
  return shared.client.fetch(input, init);
};

/** Reads a request body up to a cap, as it streams. `"too-large"` when it exceeds it. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  declaredLength?: number,
): Promise<Uint8Array | "too-large"> {
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    return "too-large";
  }
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
