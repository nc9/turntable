// The rule engine: pure functions. A rule says where a credential may go; a request either
// matches one rule exactly or it matches none and is refused.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";
import { MIN_SECRET_LENGTH } from "@turntable/redact";
import { type BodyCheck, type Inject, type NpmExpect, type Rule, RuleError } from "./types";

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
  pathExact: boolean;
  port: number;
  methods: readonly string[];
  forwardHeaders: readonly string[];
}

const NPM_PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const HEX256 = /^[0-9a-f]{64}$/;

/** The request path for a package: an unscoped name as is, `@scope/name` with its slash encoded. */
export function npmPath(pkg: string): string {
  return `/${pkg.replace("/", "%2F")}`;
}

function compileBodyCheck(c: BodyCheck, bad: (why: string) => never): void {
  if (c.type === "npm-publish" && c.expect) {
    const e = c.expect;
    if (!NPM_PACKAGE.test(e.name) || typeof e.version !== "string" || e.version === "")
      bad("bodyCheck expect needs a package name and a version");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.tag))
      bad("bodyCheck expect tag is not a dist-tag");
    if (e.manifest.name !== e.name || e.manifest.version !== e.version)
      bad("bodyCheck expect manifest must carry the same name and version");
  }
  if (c.type === "npm-publish" || c.type === "sha256") {
    if (c.digests.length === 0 || !c.digests.every((d) => HEX256.test(d)))
      bad("bodyCheck digests must be lower-case hex sha256 values (at least one)");
  } else if (c.type === "json") {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(c.field)) bad("bodyCheck field must be a plain name");
  } else {
    bad("unknown bodyCheck type");
  }
}

const SHA256_SEGMENT = /^sha256:[0-9a-f]{64}$/;

/** True when `path` has exactly the shape (see `Rule.pathShape`). A trailing slash is a segment. */
export function shapeMatches(path: string, shape: string): boolean {
  const p = path.split("/");
  const sh = shape.split("/");
  if (p.length !== sh.length) return false;
  return sh.every((want, i) => {
    const got = p[i] as string;
    if (want === "*") return got !== "";
    if (want === "{sha256}") return SHA256_SEGMENT.test(got);
    return got === want;
  });
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
  if (r.npmPackage !== undefined) {
    if (!NPM_PACKAGE.test(r.npmPackage) || r.npmPackage.length > 214)
      bad("npmPackage must be a valid npm package name");
    if (r.pathPrefix !== npmPath(r.npmPackage))
      bad(`pathPrefix for npmPackage ${r.npmPackage} must be ${npmPath(r.npmPackage)}`);
  } else if (checkPath(r.pathPrefix) !== undefined) bad("pathPrefix must be a canonical path");
  if (r.pathShape !== undefined) {
    if (r.npmPackage !== undefined) bad("pathShape cannot be combined with npmPackage");
    if (!r.pathShape.startsWith("/")) bad("pathShape must start with /");
    const literal: string[] = [];
    let wild = false;
    for (const seg of r.pathShape.split("/").slice(1)) {
      if (seg === "*" || seg === "{sha256}") wild = true;
      else if (/[*{}]/.test(seg)) bad("pathShape wildcards must be a whole segment");
      else if (!wild) literal.push(seg);
    }
    if (!wild) bad("pathShape needs a wildcard segment; use pathExact for a fixed path");
    const lit = `/${literal.join("/")}`;
    if (checkPath(lit) !== undefined) bad("pathShape literal segments must be a canonical path");
    if (r.pathPrefix !== lit && r.pathPrefix !== `${lit}/`)
      bad(`pathPrefix for this pathShape must be ${lit}`);
  }
  if (r.bodyCheck) compileBodyCheck(r.bodyCheck, bad);
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
  if (inject.type === "oci-bearer") {
    if (!/^[\x21-\x7e]{0,64}$/.test(inject.username) || inject.username.includes(":"))
      bad("oci username must be printable and contain no colon");
    if (!/^repository:[a-z0-9][a-z0-9._/-]{0,254}:(pull|push)(,(pull|push))?$/.test(inject.scope))
      bad("oci scope must be repository:<name>:pull[,push]");
    if (
      inject.realmHost !== undefined &&
      (!HOST.test(inject.realmHost) || isIP(inject.realmHost) !== 0)
    )
      bad("oci realmHost must be one lower-case hostname");
  }
  if (inject.type !== "none" && !r.secret) bad("a rule that injects must name its secret");
  return {
    ...r,
    pathExact: r.pathExact === true || r.npmPackage !== undefined,
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

/**
 * An entry names an exact host, or `*.suffix` for any subdomain (not the bare suffix), and the
 * ports a tunnel to it may use. Empty list: nothing.
 */
export function passthroughAllowed(
  entries: readonly { host: string; ports: readonly number[] }[] | undefined,
  host: string,
  port: number,
): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (entries ?? []).some(
    (e) =>
      e.ports.includes(port) &&
      (e.host.startsWith("*.")
        ? h.endsWith(e.host.slice(1)) && h.length > e.host.length - 1
        : e.host === h),
  );
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
    .filter((r) =>
      r.pathShape !== undefined
        ? shapeMatches(path, r.pathShape)
        : r.pathExact
          ? path === r.pathPrefix
          : underPrefix(path, r.pathPrefix),
    )
    .toSorted((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  const best = hits[0];
  return best ? { ok: true, rule: best } : { ok: false, reason: "no_rule_for_path" };
}

/** True when a host is named by any rule: the gate for CONNECT. */
export function hostAllowed(rules: readonly CompiledRule[], host: string, port: number): boolean {
  return rules.some((r) => r.host === host && r.port === port);
}

/** The rule that lets an exact encoded-slash npm path through the canonical-path check, if any. */
export function npmExactRule(
  rules: readonly CompiledRule[],
  host: string,
  port: number,
  path: string,
): boolean {
  return rules.some(
    (r) =>
      r.host === host && r.port === port && r.npmPackage !== undefined && r.pathPrefix === path,
  );
}

export type BodyVerdict = { ok: true } | { ok: false; reason: string; detail?: string };

/** Top-level fields the npm client writes into a publish document. */
const NPM_TOP = new Set([
  "_id",
  "name",
  "description",
  "dist-tags",
  "versions",
  "access",
  "_attachments",
  "readme",
]);
/** Fields the npm client adds to a version manifest on its own (besides `dist`). */
const NPM_VERSION_EXTRA = new Set([
  "_id",
  "_nodeVersion",
  "_npmVersion",
  "gitHead",
  "readme",
  "readmeFilename",
]);

const SEMVERISH = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,64})?(\+[0-9A-Za-z.-]{1,64})?$/;

const no = (reason: string, detail?: string): BodyVerdict => ({
  ok: false,
  reason,
  ...(detail ? { detail } : {}),
});

/**
 * A publish document against the one the lane derived from the verified tarball. Nothing the lane
 * did not compute is accepted, except the few fields the npm client always adds (`_id`,
 * `_nodeVersion`, `_npmVersion`, `gitHead`, `readme` and `readmeFilename` in a version manifest;
 * `readme` and `access` on top). A package whose package.json `npm publish` rewrites (normalised
 * `repository`, `bin`, `bugs`) therefore does not match: publish it in strict mode.
 */
function checkNpmDocument(o: Record<string, unknown>, bytes: Buffer, e: NpmExpect): BodyVerdict {
  for (const k of Object.keys(o)) if (!NPM_TOP.has(k)) return no("unexpected_field", k);
  if (o.name !== e.name) return no("name_mismatch");
  if (o._id !== undefined && o._id !== e.name) return no("name_mismatch", "_id");
  if (!isDeepStrictEqual(o["dist-tags"], { [e.tag]: e.version })) return no("dist_tags_mismatch");
  if (o.access !== undefined && o.access !== null && o.access !== (e.access ?? "public"))
    return no("access_mismatch");
  if (o.description !== undefined && o.description !== e.manifest.description)
    return no("manifest_mismatch", "description");
  // Text npmjs.com shows must come from the verified tarball, never from the job.
  const readmes = e.readmes ?? {};
  const readmeOk = (v: unknown): boolean =>
    v === undefined || v === "" || (typeof v === "string" && Object.values(readmes).includes(v));
  if (!readmeOk(o.readme)) return no("readme_not_from_tarball", "readme");
  const versions = o.versions;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions))
    return no("version_count");
  const keys = Object.keys(versions);
  if (keys.length !== 1) return no("version_count");
  if (keys[0] !== e.version) return no("version_mismatch", `seen ${keys[0]}`);
  const mv = (versions as Record<string, unknown>)[e.version];
  if (typeof mv !== "object" || mv === null || Array.isArray(mv)) return no("manifest_mismatch");
  const m = mv as Record<string, unknown>;
  if (!readmeOk(m.readme)) return no("readme_not_from_tarball", "versions.readme");
  if (m.readmeFilename !== undefined) {
    if (typeof m.readmeFilename !== "string" || !Object.hasOwn(readmes, m.readmeFilename))
      return no("readme_filename_mismatch");
    if (m.readme !== undefined && m.readme !== "" && m.readme !== readmes[m.readmeFilename])
      return no("readme_filename_mismatch", "readme is not that file");
  }
  if (m.gitHead !== undefined && (e.gitHead === undefined || m.gitHead !== e.gitHead))
    return no("git_head_mismatch");
  for (const k of ["_nodeVersion", "_npmVersion"] as const) {
    if (m[k] !== undefined && (typeof m[k] !== "string" || !SEMVERISH.test(m[k])))
      return no("client_version_malformed", k);
  }
  for (const [k, v] of Object.entries(m)) {
    if (k === "dist" || NPM_VERSION_EXTRA.has(k)) continue;
    if (!Object.hasOwn(e.manifest, k)) return no("unexpected_field", `versions.${k}`);
    if (!isDeepStrictEqual(v, e.manifest[k])) return no("manifest_mismatch", k);
  }
  for (const k of Object.keys(e.manifest)) {
    if (NPM_VERSION_EXTRA.has(k)) continue;
    if (!Object.hasOwn(m, k)) return no("manifest_mismatch", `${k} missing`);
  }
  if (m._id !== undefined && m._id !== `${e.name}@${e.version}`)
    return no("manifest_mismatch", "_id");
  const dist = m.dist;
  if (typeof dist !== "object" || dist === null || Array.isArray(dist))
    return no("integrity_missing");
  const d = dist as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (!["integrity", "shasum", "tarball"].includes(k)) return no("unexpected_field", `dist.${k}`);
  }
  if (typeof d.integrity !== "string") return no("integrity_missing");
  if (d.integrity !== `sha512-${createHash("sha512").update(bytes).digest("base64")}`)
    return no("integrity_mismatch");
  if (d.shasum !== undefined && d.shasum !== createHash("sha1").update(bytes).digest("hex"))
    return no("integrity_mismatch", "shasum");
  if (d.tarball !== undefined && typeof d.tarball !== "string")
    return no("unexpected_field", "dist.tarball");
  return { ok: true };
}

/** Applies a rule's body check to a request body. */
export function checkBody(c: BodyCheck, body: Buffer): BodyVerdict {
  if (c.type === "sha256") {
    const d = createHash("sha256").update(body).digest("hex");
    return c.digests.includes(d)
      ? { ok: true }
      : { ok: false, reason: "digest_not_approved", detail: `seen ${d}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return { ok: false, reason: "not_an_object" };
  const o = doc as Record<string, unknown>;
  if (c.type === "json") {
    return Object.hasOwn(o, c.field) && o[c.field] === c.equals
      ? { ok: true }
      : { ok: false, reason: "field_mismatch", detail: c.field };
  }
  // npm publish: exactly one attachment, one version, and the metadata must say what the bytes are.
  const att = o._attachments;
  if (typeof att !== "object" || att === null || Array.isArray(att))
    return { ok: false, reason: "no_attachment" };
  const names = Object.keys(att);
  if (names.length !== 1) return { ok: false, reason: "attachment_count" };
  const data = (att as Record<string, { data?: unknown }>)[names[0]!]?.data;
  if (typeof data !== "string") return { ok: false, reason: "no_attachment" };
  const bytes = Buffer.from(data, "base64");
  const d = createHash("sha256").update(bytes).digest("hex");
  if (!c.digests.includes(d))
    return { ok: false, reason: "digest_not_approved", detail: `seen ${d}` };
  if (c.expect) {
    const e = c.expect;
    const entry = (att as Record<string, Record<string, unknown>>)[names[0]!]!;
    if (names[0] !== `${e.name}-${e.version}.tgz`) return no("attachment_name", names[0]);
    for (const k of Object.keys(entry))
      if (!["content_type", "data", "length"].includes(k))
        return no("unexpected_field", `_attachments.${k}`);
    if (entry.length !== undefined && entry.length !== bytes.length) return no("attachment_length");
    return checkNpmDocument(o, bytes, e);
  }
  const versions = o.versions;
  if (typeof versions !== "object" || versions === null || Object.keys(versions).length !== 1)
    return { ok: false, reason: "version_count" };
  const meta = Object.values(versions as Record<string, { dist?: { integrity?: unknown } }>)[0];
  const integrity = meta?.dist?.integrity;
  if (integrity !== undefined) {
    const want = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== want) return { ok: false, reason: "integrity_mismatch" };
  }
  return { ok: true };
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
  if (inject.type === "basic" || inject.type === "oci-bearer") {
    // For oci-bearer this is the credential for the token exchange; the proxy swaps in the bearer.
    const pair = `${inject.username}:${secret}`;
    const value = `Basic ${Buffer.from(pair).toString("base64")}`;
    return { header: "authorization", value, scrub: [secret, pair, value] };
  }
  throw new RuleError("nothing to inject");
}

/** A value shorter than this cannot be redacted reliably, so it is never injected. */
export const MIN_INJECTABLE = MIN_SECRET_LENGTH;
