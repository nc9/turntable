// The listener. An explicit forward proxy: `CONNECT host:port`, then TLS terminated with a leaf
// for that host signed by the attempt's CA, then HTTP/1.1 requests read, checked against the
// attempt's rules, given their credential, sent upstream through the validated client, and the
// response scrubbed of every injected value before it is returned.
import net from "node:net";
import tls from "node:tls";
import { type SafeFetch, createHttpClient } from "@longshore/net";
import { SecretRegistry } from "@longshore/redact";
import { DEFAULT_LIMITS, type Limits, RequestReader } from "./http";
import type { Attempt, AttemptRegistry } from "./registry";
import {
  DEFAULT_PORT,
  INJECTING_ALLOWLIST,
  OVERRIDE_HEADERS,
  checkPath,
  hostAllowed,
  matchRule,
  wireValue,
  MIN_INJECTABLE,
} from "./rules";
import { scrubBytes, scrubText } from "./scrub";
import type { AuditEvent, AuditSink, SecretSource } from "./types";

export interface ProxyOptions {
  registry: AttemptRegistry;
  source: SecretSource;
  audit: AuditSink;
  /** Where requests go. Default: the validated outbound client, redirects never followed. */
  upstream?: SafeFetch;
  host?: string;
  port?: number;
  now?: () => number;
  limits?: Partial<Limits> & {
    /** Response cap in bytes. Default 64 MiB. */
    responseBytes?: number;
    tunnelsPerAttempt?: number;
    /** Idle time before a tunnel is closed. Default 60 s. */
    idleMs?: number;
    upstreamTimeoutMs?: number;
  };
}

export interface RunningProxy {
  host: string;
  port: number;
  close(): Promise<void>;
}

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DROP_REQUEST = new Set([...HOP, "host", "content-length", "accept-encoding", "expect"]);
/** Dropped once an attempt has injected anything: they ask for part of a representation. */
const PARTIAL_REQUEST = new Set([
  "range",
  "if-range",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
]);
/** A response fragment this long of an injected value is treated as the value leaking. */
const FRAGMENT = 16;
const DROP_RESPONSE = new Set([...HOP, "content-length"]);

/** Reason phrases are ours, by status code. The upstream's phrase is never passed on. */
const REASONS: Record<number, string> = {
  100: "Continue",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  206: "Partial Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  412: "Precondition Failed",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
const reasonFor = (status: number): string =>
  REASONS[status] ??
  (status < 200
    ? "Informational"
    : status < 300
      ? "Success"
      : status < 400
        ? "Redirect"
        : status < 500
          ? "Client Error"
          : "Server Error");

const text = (status: number, reason: string, extra: string[] = [], body = ""): string =>
  `HTTP/1.1 ${status} ${reason}\r\n${extra.join("\r\n")}${extra.length ? "\r\n" : ""}content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;

/** The same 407 for unknown, wrong and expired credentials. */
const AUTH_REQUIRED = text(407, "Proxy Authentication Required", [
  'proxy-authenticate: Basic realm="longshore"',
]);

export async function startProxy(o: ProxyOptions): Promise<RunningProxy> {
  const now = o.now ?? Date.now;
  const lim = {
    ...DEFAULT_LIMITS,
    responseBytes: 64 * 1024 * 1024,
    tunnelsPerAttempt: 32,
    idleMs: 60_000,
    upstreamTimeoutMs: 30_000,
    ...o.limits,
  };
  const upstream: SafeFetch = o.upstream ?? createHttpClient().fetch;
  /** Every secret form injected so far in an attempt: the set scrubbed from its responses. */
  const injected = new WeakMap<Attempt, SecretRegistry>();
  /** Tunnel slots held by CONNECTs whose audit write is still pending. */
  const reserved = new WeakMap<Attempt, number>();

  const record = async (e: Omit<AuditEvent, "at">): Promise<void> => {
    await o.audit.record({ ...e, at: now() });
  };
  /** For denials: a failing audit sink must not turn a refusal into something else. */
  const deny = async (e: Omit<AuditEvent, "at" | "kind">): Promise<void> => {
    try {
      await record({ kind: "deny", ...e });
    } catch {
      // the request is refused either way
    }
  };

  const open = new Set<net.Socket>();
  const server = net.createServer((raw) => {
    open.add(raw);
    raw.once("close", () => open.delete(raw));
    void handle(raw).catch(() => raw.destroy());
  });

  async function handle(raw: net.Socket): Promise<void> {
    raw.setTimeout(10_000, () => raw.destroy());
    raw.on("error", () => raw.destroy());
    const head = await readConnectHead(raw);
    if (head === undefined) return void raw.destroy();
    const auth = o.registry.authenticate(head.headers.get("proxy-authorization"));
    if (!auth.ok) {
      try {
        await record({ kind: "auth_failure", attemptId: auth.attemptId, reason: auth.reason });
      } catch {
        // refused either way
      }
      raw.end(AUTH_REQUIRED);
      return;
    }
    const attempt = auth.attempt;
    const id = attempt.spec.attemptId;
    const m = /^CONNECT ([^\s]+) HTTP\/1\.1$/.exec(head.line);
    if (!m) {
      await deny({ attemptId: id, reason: "not_connect" });
      raw.end(text(405, "Method Not Allowed", ["allow: CONNECT"], "https only"));
      return;
    }
    const authority = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(m[1]!);
    if (!authority) {
      await deny({ attemptId: id, reason: "bad_authority" });
      raw.end(text(400, "Bad Request"));
      return;
    }
    const host = authority[1]!.toLowerCase();
    const port = Number(authority[2]);
    if (!hostAllowed(attempt.rules, host, port)) {
      await deny({ attemptId: id, host, port, reason: "no_rule_for_host" });
      raw.end(text(403, "Forbidden"));
      return;
    }
    // The slot is reserved here, with no await between the check and the reservation, so a burst of
    // CONNECTs cannot all pass the check while the audit write is pending.
    if (attempt.tunnels.size + (reserved.get(attempt) ?? 0) >= lim.tunnelsPerAttempt) {
      await deny({ attemptId: id, host, port, reason: "too_many_tunnels" });
      raw.end(text(429, "Too Many Requests"));
      return;
    }
    reserved.set(attempt, (reserved.get(attempt) ?? 0) + 1);
    const release = (): void => {
      reserved.set(attempt, (reserved.get(attempt) ?? 1) - 1);
    };
    try {
      await record({ kind: "tunnel", attemptId: id, host, port });
    } catch {
      release();
      raw.end(text(502, "Bad Gateway"));
      return;
    }

    release();
    // The peer may have gone while the audit write ran: its close event is already past.
    if (raw.destroyed) return;
    // Nor may the attempt have been revoked or expired meanwhile: revoke already swept the set.
    if (!o.registry.live(attempt)) return void raw.destroy();
    raw.setTimeout(0);
    attempt.tunnels.add(raw);
    raw.once("close", () => attempt.tunnels.delete(raw));
    if (head.rest.length > 0) raw.unshift(head.rest);
    raw.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const leaf = attempt.ca.leafFor(host);
    const secure = new tls.TLSSocket(raw, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
    });
    raw.resume();
    secure.on("error", () => secure.destroy());
    secure.setTimeout(lim.idleMs, () => secure.destroy());
    const tunnel = { attempt, host, port, secure };
    await new Promise<void>((resolve) => {
      secure.once("secure", () => resolve());
      secure.once("close", () => resolve());
    });
    if (secure.destroyed) return;
    // The server name the client asked for must be the host it tunnelled to.
    const sni = ((secure as unknown as { servername?: string | false }).servername || "")
      .toString()
      .toLowerCase();
    if (sni !== host) {
      await deny({ attemptId: id, host, port, reason: sni === "" ? "no_sni" : "sni_mismatch" });
      secure.destroy();
      return;
    }
    await serve(tunnel);
  }

  async function serve(t: {
    attempt: Attempt;
    host: string;
    port: number;
    secure: tls.TLSSocket;
  }): Promise<void> {
    const { attempt, host, port, secure } = t;
    const reader = new RequestReader({ headerBytes: lim.headerBytes, bodyBytes: lim.bodyBytes });
    let busy = false;
    let closing = false;
    const id = attempt.spec.attemptId;

    const finish = (payload: string | Buffer, close: boolean): Promise<void> =>
      new Promise((resolve) => {
        secure.write(payload, () => {
          if (close) {
            closing = true;
            secure.end();
          }
          resolve();
        });
      });

    const pump = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        for (;;) {
          if (closing || secure.destroyed) return;
          const r = reader.next();
          if (r.kind === "need_more") return;
          if (r.kind === "continue") {
            secure.write("HTTP/1.1 100 Continue\r\n\r\n");
            continue;
          }
          if (r.kind === "error") {
            await deny({ attemptId: id, host, port, reason: `bad_request_${r.reason}` });
            await finish(text(400, "Bad Request"), true);
            return;
          }
          // The credential must still be live for every request, not only at CONNECT.
          if (!o.registry.live(attempt)) {
            await deny({ attemptId: id, host, port, reason: "expired" });
            secure.destroy();
            return;
          }
          const out = await forward(r.request);
          await finish(out.payload, out.close || r.request.close);
          if (out.close || r.request.close) return;
        }
      } finally {
        busy = false;
      }
    };
    secure.on("data", (c: Buffer) => {
      reader.feed(c);
      void pump().catch(() => secure.destroy());
    });

    async function forward(req: {
      method: string;
      target: string;
      headers: [string, string][];
      body: Buffer;
    }): Promise<{ payload: Buffer | string; close: boolean }> {
      const refuse = async (
        status: number,
        reason: string,
        extra: Omit<AuditEvent, "at" | "kind" | "attemptId" | "reason"> = {},
      ) => {
        await deny({ attemptId: id, host, port, method: req.method, reason, ...extra });
        return { payload: text(status, status === 403 ? "Forbidden" : "Bad Gateway"), close: true };
      };
      // Origin-form targets only: no absolute URL can name a different host.
      if (!req.target.startsWith("/")) return refuse(400, "absolute_form");
      const q = req.target.indexOf("?");
      const path = q < 0 ? req.target : req.target.slice(0, q);
      const query = q < 0 ? "" : req.target.slice(q);
      const bad = checkPath(path);
      if (bad !== undefined) return refuse(403, `path_${bad}`);
      // The Host header must be the host that was tunnelled to.
      const hostHeader = (req.headers.find(([k]) => k === "host")?.[1] ?? "").toLowerCase();
      const wantHost = port === DEFAULT_PORT ? [host, `${host}:${port}`] : [`${host}:${port}`];
      if (!wantHost.includes(hostHeader)) return refuse(403, "host_mismatch");
      const m = matchRule(attempt.rules, host, port, req.method, path);
      if (!m.ok) return refuse(403, m.reason);
      const rule = m.rule;

      const headers = new Headers();
      // After anything was injected in this attempt, no request may ask for part of a
      // representation: a fragment of an echo would slip past a scrubber that looks for whole
      // values. (The request that injects is held to the same rule.)
      const guarded = injected.has(attempt) || rule.inject.type !== "none";
      // A rule that injects forwards an allowlist of headers, not whatever the job sent: a header
      // that changes the method or the target must not ride along with a credential. A rule that
      // injects nothing forwards the job's headers, minus the ones that override the method.
      const injecting = rule.inject.type !== "none";
      for (const [k, v] of req.headers) {
        if (DROP_REQUEST.has(k) || OVERRIDE_HEADERS.has(k)) continue;
        if (guarded && PARTIAL_REQUEST.has(k)) continue;
        if (injecting && !INJECTING_ALLOWLIST.has(k) && !rule.forwardHeaders.includes(k)) continue;
        headers.append(k, v);
      }
      headers.set("accept-encoding", "identity");
      let injectedHere = false;
      if (rule.inject.type !== "none") {
        let resolved;
        try {
          resolved = await o.source.resolve(
            {
              orgId: attempt.spec.orgId,
              projectId: attempt.spec.projectId,
              runId: attempt.spec.runId,
              jobId: attempt.spec.jobId,
              attemptId: id,
              host,
            },
            rule,
          );
        } catch {
          return refuse(502, "secret_unavailable", { ruleId: rule.id });
        }
        if (!resolved.ok) return refuse(502, "secret_unavailable", { ruleId: rule.id });
        if (resolved.value.length < MIN_INJECTABLE)
          return refuse(502, "secret_too_short", { ruleId: rule.id });
        const wire = wireValue(rule.inject, resolved.value);
        let scrubSet = injected.get(attempt);
        if (!scrubSet) injected.set(attempt, (scrubSet = new SecretRegistry({ warn: () => {} })));
        for (const v of wire.scrub) scrubSet.register(v);
        // Audited before it is sent: if the record cannot be written, nothing is injected.
        try {
          await record({
            kind: "inject",
            attemptId: id,
            host,
            port,
            method: req.method,
            ruleId: rule.id,
          });
        } catch {
          return refuse(502, "audit_failed", { ruleId: rule.id });
        }
        // The job's own copy of this header is replaced, never added to.
        headers.delete(wire.header);
        headers.set(wire.header, wire.value);
        injectedHere = true;
      }

      const url = `https://${host}${port === DEFAULT_PORT ? "" : `:${port}`}${path}${query}`;
      let res: Response;
      try {
        res = await upstream(url, {
          method: req.method,
          headers,
          ...(req.body.length > 0 && req.method !== "GET" && req.method !== "HEAD"
            ? { body: req.body }
            : {}),
          redirect: "manual",
          maxBytes: lim.responseBytes,
          timeoutMs: lim.upstreamTimeoutMs,
        });
      } catch (e) {
        const blocked = e instanceof Error && e.name === "SsrfError";
        return refuse(502, blocked ? "upstream_blocked" : "upstream_error", { ruleId: rule.id });
      }
      const encoding = (res.headers.get("content-encoding") ?? "identity").toLowerCase();
      // Once an attempt has injected anything, a compressed response to ANY of its requests is
      // refused: a later request could fetch an echo that cannot be scanned.
      const scanning = injectedHere || injected.has(attempt);
      if (scanning && encoding !== "identity") {
        void res.body?.cancel();
        return refuse(502, "encoded_response", { ruleId: rule.id });
      }
      if (scanning && (res.status === 206 || res.headers.has("content-range"))) {
        void res.body?.cancel();
        return refuse(502, "partial_response", { ruleId: rule.id });
      }
      const raw = Buffer.from(await res.arrayBuffer());
      // Everything injected in this attempt is scrubbed, not only this rule's value.
      const forms = injected.get(attempt)?.forms() ?? [];
      const body = scrubBytes(raw, forms);
      let scrubbed = body.count;
      const lines: string[] = [];
      const addHeader = (k: string, v: string): void => {
        const s = scrubText(v, forms);
        scrubbed += s.count;
        lines.push(`${k}: ${s.text.replaceAll(/[\r\n]+/g, " ")}`);
      };
      for (const [k, v] of res.headers) {
        if (
          DROP_RESPONSE.has(k) ||
          (k === "content-encoding" && encoding === "identity") ||
          k === "set-cookie"
        )
          continue;
        addHeader(k, v);
      }
      for (const c of res.headers.getSetCookie()) addHeader("set-cookie", c);
      // Defence in depth: whole values are gone by now, so a long piece of one that is still
      // present is a partial echo.
      if (scanning && leaksFragment(body.bytes, lines, forms)) {
        return refuse(502, "partial_secret_in_response", { ruleId: rule.id });
      }
      if (scrubbed > 0) {
        try {
          await record({
            kind: "redact",
            attemptId: id,
            host,
            port,
            method: req.method,
            ruleId: rule.id,
          });
        } catch {
          return refuse(502, "audit_failed", { ruleId: rule.id });
        }
      }
      const noBody =
        res.status === 204 || res.status === 304 || req.method === "HEAD" || res.status < 200;
      const headText = `HTTP/1.1 ${res.status} ${reasonFor(res.status)}\r\n${lines.join("\r\n")}${lines.length ? "\r\n" : ""}${noBody ? "" : `content-length: ${body.bytes.length}\r\n`}\r\n`;
      return {
        payload: noBody
          ? Buffer.from(headText, "latin1")
          : Buffer.concat([Buffer.from(headText, "latin1"), body.bytes]),
        close: false,
      };
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, o.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address() as net.AddressInfo;
  return {
    host: addr.address,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of open) s.destroy();
      }),
  };
}

/** True when a prefix or suffix of a registered form (16 characters or more) remains in the response. */
function leaksFragment(
  body: Buffer,
  headerLines: readonly string[],
  forms: readonly string[],
): boolean {
  const headerText = Buffer.from(headerLines.join("\n"), "latin1");
  for (const form of forms) {
    if (form.length < FRAGMENT) continue;
    for (const piece of [form.slice(0, FRAGMENT), form.slice(-FRAGMENT)]) {
      const needle = Buffer.from(piece);
      if (body.includes(needle) || headerText.includes(needle)) return true;
    }
  }
  return false;
}

/** Reads the head of the CONNECT request: its line, headers, and any bytes after it. */
function readConnectHead(
  raw: net.Socket,
): Promise<{ line: string; headers: Map<string, string>; rest: Buffer } | undefined> {
  return new Promise((resolve) => {
    let buf: Buffer = Buffer.alloc(0);
    const done = (v: Awaited<ReturnType<typeof readConnectHead>>): void => {
      raw.off("data", onData);
      raw.off("close", onClose);
      resolve(v);
    };
    const onClose = (): void => done(undefined);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 8192) done(undefined);
        return;
      }
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const headers = new Map<string, string>();
      for (const l of lines.slice(1)) {
        const i = l.indexOf(":");
        if (i < 1) return done(undefined);
        headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
      }
      raw.pause();
      done({ line: lines[0] ?? "", headers, rest: buf.subarray(end + 4) });
    };
    raw.on("data", onData);
    raw.on("close", onClose);
  });
}
