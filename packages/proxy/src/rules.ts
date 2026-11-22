// The rule engine: pure functions. A rule says where a credential may go; a request either
// matches one rule exactly or it matches none and is refused.
import { isIP } from "node:net";
import { MIN_SECRET_LENGTH } from "@longshore/redact";
import { type Inject, type Rule, RuleError } from "./types";

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const METHOD = /^[A-Z]{3,10}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
/** Headers a rule may not set: they frame or route the request, or are the proxy's own. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
]);

export const DEFAULT_PORT = 443;

/** Headers that can change the method or the target downstream of the proxy's own checks. */
export const OVERRIDE_HEADERS: ReadonlySet<string> = new Set([
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-original-url",
  "x-rewrite-url",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-forwarded-port",
  "forwarded",
]);

/** What a job may send to a host whose rule injects a credential, whatever the rule says. */
export const INJECTING_ALLOWLIST: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
]);

/** A rule with defaults applied, or a RuleError saying what is wrong. */
export interface CompiledRule extends Rule {
  port: number;
  methods: readonly string[];
  forwardHeaders: readonly string[];
}

export function compileRule(r: Rule): CompiledRule {
  const bad = (why: string): never => {
    throw new RuleError(`rule ${r.id}: ${why}`);
  };
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(r.id))
    throw new RuleError("rule id must be 1 to 64 plain characters");
  if (r.host !== r.host.toLowerCase() || !HOST.test(r.host) || isIP(r.host) !== 0) {
    bad("host must be one lower-case hostname (no IP literal, no wildcard)");
  }
  const port = r.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad("port out of range");
  if (r.methods.length === 0) bad("methods must name at least one method");
  for (const m of r.methods)
    if (!METHOD.test(m)) bad(`method ${m} is not an upper-case method name`);
  if (!r.pathPrefix.startsWith("/")) bad("pathPrefix must start with /");
  if (checkPath(r.pathPrefix) !== undefined) bad("pathPrefix must be a canonical path");
  const inject: Inject = r.inject;
  if (inject.type === "header") {
    if (!HEADER.test(inject.name) || FORBIDDEN_HEADERS.has(inject.name.toLowerCase())) {
      bad("header name is not allowed");
    }
    if (inject.format !== undefined && !inject.format.includes("{secret}")) {
      bad("header format must contain {secret}");
    }
  }
  if (
    inject.type === "basic" &&
    (!/^[\x21-\x7e]{0,64}$/.test(inject.username) || inject.username.includes(":"))
  ) {
    bad("basic username must be printable and contain no colon");
  }
  for (const h of r.forwardHeaders ?? []) {
    const n = h.toLowerCase();
    if (!HEADER.test(h) || FORBIDDEN_HEADERS.has(n) || OVERRIDE_HEADERS.has(n)) {
      bad(`forwardHeaders entry ${h} is not allowed`);
    }
  }
  if (inject.type !== "none" && !r.secret) bad("a rule that injects must name its secret");
  return {
    ...r,
    port,
    methods: [...new Set(r.methods)],
    forwardHeaders: [...new Set((r.forwardHeaders ?? []).map((h) => h.toLowerCase()))],
  };
}

export function compileRules(rules: readonly Rule[]): CompiledRule[] {
  const out = rules.map(compileRule);
  const ids = new Set<string>();
  for (const r of out) {
    if (ids.has(r.id)) throw new RuleError(`duplicate rule id ${r.id}`);
    ids.add(r.id);
  }
  return out;
}

/**
 * Why a request path is not acceptable, or undefined. The raw path must already be in canonical
 * form: no dot segments (plain or encoded), no ';' parameters, no empty segments, no encoded slash or backslash or
 * NUL, no characters a URL parser would rewrite. A refused path is never normalised into one that
 * matches.
 */
export function checkPath(rawPath: string): string | undefined {
  if (!rawPath.startsWith("/")) return "not_origin_form";
  if (!/^[\x21-\x7e]*$/.test(rawPath)) return "bad_characters";
  if (rawPath.includes("\\")) return "backslash";
  // A matrix parameter: some upstreams drop everything from ';' in a segment, so "..;x" is ".." there.
  if (rawPath.includes(";")) return "matrix_param";
  if (/%(2f|5c|00|2e)/i.test(rawPath)) return "encoded_separator";
  const segments = rawPath.split("/").slice(1);
  for (const [i, s] of segments.entries()) {
    if (s === "." || s === "..") return "dot_segment";
    if (s === "" && i !== segments.length - 1) return "empty_segment";
  }
  let parsed: string;
  try {
    parsed = new URL(`https://h${rawPath}`).pathname;
  } catch {
    return "unparseable";
  }
  if (parsed !== rawPath) return "not_canonical";
  return undefined;
}

/** True when `path` is the prefix or lies below it, on segment boundaries. */
export function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === p || path.startsWith(`${p}/`);
}

export type Match =
  | { ok: true; rule: CompiledRule }
  | { ok: false; reason: "no_rule_for_host" | "no_rule_for_method" | "no_rule_for_path" };

/** The rule for this host, port, method and (raw) path, or the most specific reason there is none. */
export function matchRule(
  rules: readonly CompiledRule[],
  host: string,
  port: number,
  method: string,
  path: string,
): Match {
  const forHost = rules.filter((r) => r.host === host && r.port === port);
  if (forHost.length === 0) return { ok: false, reason: "no_rule_for_host" };
  const forMethod = forHost.filter((r) => r.methods.includes(method));
  if (forMethod.length === 0) return { ok: false, reason: "no_rule_for_method" };
  // The longest matching prefix wins, so a narrow rule beats a broad one.
  const hits = forMethod
    .filter((r) => underPrefix(path, r.pathPrefix))
    .toSorted((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  const best = hits[0];
  return best ? { ok: true, rule: best } : { ok: false, reason: "no_rule_for_path" };
}

/** True when a host is named by any rule: the gate for CONNECT. */
export function hostAllowed(rules: readonly CompiledRule[], host: string, port: number): boolean {
  return rules.some((r) => r.host === host && r.port === port);
}

/** What goes on the wire, and the values that must never come back in a response. */
export function wireValue(
  inject: Inject,
  secret: string,
): { header: string; value: string; scrub: string[] } {
  if (inject.type === "header") {
    const value = (inject.format ?? "{secret}").replaceAll("{secret}", secret);
    return { header: inject.name.toLowerCase(), value, scrub: [secret, value] };
  }
  if (inject.type === "basic") {
    const pair = `${inject.username}:${secret}`;
    const value = `Basic ${Buffer.from(pair).toString("base64")}`;
    return { header: "authorization", value, scrub: [secret, pair, value] };
  }
  throw new RuleError("nothing to inject");
}

/** A value shorter than this cannot be redacted reliably, so it is never injected. */
export const MIN_INJECTABLE = MIN_SECRET_LENGTH;
