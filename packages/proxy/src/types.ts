// The proxy's interfaces: what a job's rules look like, where secret values come from, and where
// audit events go. The proxy depends on these and on nothing of the vault or the scheduler.

/** How a credential is attached to a request that a rule allows. */
export type Inject =
  | { type: "none" }
  /** `format` holds `{secret}`; the default is the bare value, for example `Bearer {secret}`. */
  | { type: "header"; name: string; format?: string }
  /** HTTP Basic: a fixed username and the secret as the password. */
  | { type: "basic"; username: string }
  /**
   * An OCI registry (Docker distribution API) that hands out short-lived bearer tokens in
   * exchange for a long-lived credential. The proxy answers the registry's challenge itself, with
   * the secret as the Basic password and a token scoped to `scope` (for example
   * `repository:owner/name:push,pull`), keeps the token in memory, and attaches it. The job
   * never sees a challenge or a token. The token realm must be on `realmHost` (default: the rule's host).
   */
  | { type: "oci-bearer"; username: string; scope: string; realmHost?: string };

/** What the lane computed from the verified tarball. */
export interface NpmExpect {
  name: string;
  version: string;
  tag: string;
  access?: "public" | "restricted" | undefined;
  /** The tarball's package.json. */
  manifest: Record<string, unknown>;
  /**
   * The README files at the top of the tarball, by file name (`README.md`). The only `readme` text
   * a document may carry is empty or exactly one of these; `readmeFilename` must name one.
   */
  readmes?: Readonly<Record<string, string>> | undefined;
  /** The commit the approved tag points at: the only `gitHead` a document may carry. */
  gitHead?: string | undefined;
}

/**
 * A check on the body of a request that carries one (anything but GET and HEAD). A request that
 * fails it is refused before any credential is attached.
 */
export type BodyCheck =
  /**
   * An npm publish document: one attachment whose sha256 is in `digests`, one version. With
   * `expect`, the whole document must be the one the lane derived from the verified tarball: the
   * name, exactly one version key, a version manifest equal to the tarball's own package.json plus
   * `dist` (integrity required), `dist-tags` exactly `{ [tag]: version }`, and no other field
   * (besides the few the npm client adds on its own, see `checkBody`).
   */
  | {
      type: "npm-publish";
      digests: readonly string[];
      expect?: NpmExpect | undefined;
    }
  /** The whole body hashes to one of `digests` (lower-case hex sha256), for example an OCI manifest. */
  | { type: "sha256"; digests: readonly string[] }
  /** A JSON object whose top-level `field` equals `equals`, for example `draft: true`. */
  | { type: "json"; field: string; equals: boolean | string | number };

/** Where a credential may go. The job's rule list is the whole of what it may reach. */
export interface Rule {
  id: string;
  /** One exact hostname. No IP literals, no wildcards. */
  host: string;
  /** Default 443. */
  port?: number;
  /** An explicit list, upper case. `*` is not accepted. */
  methods: readonly string[];
  /** Starts with `/`; matched on segment boundaries. */
  pathPrefix: string;
  /** The path must be exactly `pathPrefix`, not anything below it. */
  pathExact?: boolean | undefined;
  /**
   * The path must have exactly this shape, segment by segment: a literal segment matches itself,
   * `*` matches exactly one non-empty segment, and `{sha256}` matches one `sha256:<64 hex>`
   * segment. A shape fixes the number of segments, so a prefix cannot match a longer path
   * (a registry repository named `app/blobs/x` is not the `app` repository's blob path).
   * `pathPrefix` must be the literal segments before the first wildcard; it orders rules.
   */
  pathShape?: string | undefined;
  /**
   * A scoped npm package, `@scope/name`. `pathPrefix` must then be `/@scope%2Fname`: the one place
   * the proxy accepts an encoded slash, and only for this exact path (which implies `pathExact`).
   */
  npmPackage?: string | undefined;
  bodyCheck?: BodyCheck | undefined;
  inject: Inject;
  /**
   * Headers (besides the always-forwarded few) the job may send to this host. A rule that injects
   * forwards ONLY an allowlist: accept, accept-language, content-type and user-agent, plus these.
   */
  forwardHeaders?: readonly string[] | undefined;
  /** The name the secret source resolves. Required unless `inject` is `none`. */
  secret?: string | undefined;
}

/** Who is asking for a value, by id. The class of the run is the source's own business. */
export interface SecretScope {
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  attemptId: string;
  /** Where it would be sent. */
  host: string;
}

export type ResolvedSecret = { ok: true; value: string } | { ok: false; reason: string };

/** Implemented by the vault. Called for every injection; nothing is cached by the proxy. */
export interface SecretSource {
  resolve(scope: SecretScope, rule: Rule): Promise<ResolvedSecret>;
}

export type AuditKind = "inject" | "deny" | "auth_failure" | "redact" | "tunnel";

export interface AuditEvent {
  kind: AuditKind;
  /** The attempt the credential named (unauthenticated for an auth failure). */
  attemptId: string;
  host?: string;
  port?: number;
  method?: string;
  ruleId?: string;
  /** A short fixed reason. Never a value, a header or a body. */
  reason?: string;
  /** Short facts for a refusal, such as the digest seen and the ones approved. Never a secret. */
  detail?: string;
  /** Epoch ms. */
  at: number;
}

/** Throw to refuse: when an audit write fails the proxy injects nothing. */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

/** What an attempt is registered with. */
export interface AttemptSpec {
  attemptId: string;
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  rules: readonly Rule[];
  /**
   * Hosts with no rule are refused, unless they match one of these (exact host, or `*.suffix` for
   * any subdomain) on one of its ports: then they get a plain tunnel (nothing injected, the job's
   * own TLS end to end). Empty or absent: rule hosts only.
   */
  passthroughHosts?: readonly { host: string; ports: readonly number[] }[] | undefined;
  /** How long the credential lives. */
  ttlMs: number;
}

/** What the job is given. `caPem` is the only certificate material that leaves the proxy. */
export interface AttemptCredential {
  username: string;
  password: string;
  caPem: string;
  expiresAt: number;
  /** `http://user:pass@host:port`, for HTTPS_PROXY. */
  proxyUrl(host: string, port: number): string;
}

export class RuleError extends Error {}
