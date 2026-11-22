// The proxy's interfaces: what a job's rules look like, where secret values come from, and where
// audit events go. The proxy depends on these and on nothing of the vault or the scheduler.

/** How a credential is attached to a request that a rule allows. */
export type Inject =
  | { type: "none" }
  /** `format` holds `{secret}`; the default is the bare value, for example `Bearer {secret}`. */
  | { type: "header"; name: string; format?: string }
  /** HTTP Basic: a fixed username and the secret as the password. */
  | { type: "basic"; username: string };

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
