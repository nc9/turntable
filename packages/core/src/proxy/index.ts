// The secrets proxy, wired into job execution (#15). One proxy per worker. For each attempt the
// worker registers the project's injection rules (from `proxy_rules`, each host re-checked
// against the vault secret's destinations) and revokes them when the attempt ends, however it
// ends. Values come from the vault per request, through its one policy path, and are added to the
// attempt's redaction set as they are used. Nothing here puts a secret in a sandbox.
import type net from "node:net";
import {
  AttemptRegistry,
  compileRule,
  type AttemptCredential,
  type AuditEvent,
  type AuditSink,
  type Inject,
  type ResolvedSecret,
  type Rule,
  type SecretScope,
  type SecretSource,
  startProxy,
  type RunningProxy,
} from "@longshore/proxy";
import { dockerBridgeGateway } from "@longshore/provider-docker";
import type { ProxyEndpoint } from "@longshore/provider-sdk";
import { SecretRegistry } from "@longshore/redact";
import type { SafeFetch } from "@longshore/net";
import type { Db } from "../db";
import {
  appendAudit,
  listPassthroughHosts,
  listRepos,
  type PassthroughEntry,
  listProxyRules,
  type ProxyRuleRow,
  type Scope,
} from "../db/repos";
import { parseTrust } from "../db/repos/approve";
import type { SecretVault } from "../secrets/vault";
import { credentialsFor, type TrustClass } from "../trust";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "../scheduler/types";

/** What a runner needs to put a job behind the proxy. */
export interface ProxyAccess {
  /** The proxy as the provider's host reaches it (the provider gives the sandbox its own route). */
  listen: ProxyEndpoint;
  credential: AttemptCredential;
  /**
   * The attempt has vault rules, so it must run behind the proxy. Without them the proxy is only
   * there to hold a GitHub token, and a job that gets none runs as if it were not here.
   */
  vaultRules: boolean;
  /**
   * Hands the proxy this attempt's GitHub installation token, minted once the job is planned. The
   * proxy attaches it to requests to the run's own repository; the job never holds it.
   */
  setGithubToken(token: string | undefined): void;
}

/** The rule `secret` that means "this attempt's GitHub token" (not a vault secret). */
export const GITHUB_TOKEN_SECRET = "@github-token";

/** A GitHub repository the run belongs to, with the installation its token comes from. */
export interface GithubTarget {
  owner: string;
  repo: string;
  installationId: string;
}

const SAFE_GH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The rules that let a job use its own GitHub token without holding it: the API for this one
 * repository (and GraphQL), and git over HTTPS for this one repository. Nothing else on GitHub.
 */
export function githubRules(t: GithubTarget): Rule[] {
  if (!SAFE_GH.test(t.owner) || !SAFE_GH.test(t.repo)) return [];
  const api = (id: string, pathPrefix: string, methods: string[]): Rule => ({
    id,
    host: "api.github.com",
    methods,
    pathPrefix,
    inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    secret: GITHUB_TOKEN_SECRET,
    forwardHeaders: ["x-github-api-version"],
  });
  const git = (id: string, pathPrefix: string): Rule => ({
    id,
    host: "github.com",
    methods: ["GET", "POST"],
    pathPrefix,
    inject: { type: "basic", username: "x-access-token" },
    secret: GITHUB_TOKEN_SECRET,
    forwardHeaders: ["git-protocol"],
  });
  const base = `/${t.owner}/${t.repo}`;
  return [
    api("github-api-repo", `/repos/${t.owner}/${t.repo}`, [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]),
    api("github-api-graphql", "/graphql", ["POST"]),
    git("github-git", base),
    git("github-git-dotgit", `${base}.git`),
  ];
}

export interface SecretsProxyOptions {
  db: Db;
  vault: SecretVault;
  /**
   * Interface to bind. Default: the Docker bridge's gateway on Linux (what containers reach as
   * the host, and no other interface), else loopback (Docker Desktop routes the host name there).
   * `0.0.0.0` or `::` is an explicit opt-in and logs a warning.
   */
  bindHost?: string;
  /** Test seam: how the bridge gateway is found. */
  bridgeGateway?: () => Promise<string | undefined>;
  /** Default: a free port. */
  port?: number;
  /** How the provider's host names this machine. Default `host.docker.internal`. */
  advertiseHost?: string;
  /**
   * Serve over TLS on a public name (for sandboxes in another provider's network, such as
   * Daytona). The certificate is for `advertiseHost`.
   */
  tls?: { key: string; cert: string };
  /** The port sandboxes are told to use, when it differs from the one bound (a platform that forwards). */
  advertisePort?: number;
  /** The endpoint's stable IPv4 addresses, for a provider that filters by address. */
  advertiseAddresses?: readonly string[];
  /** Limits on the listener (see the proxy's limits). */
  limits?: Parameters<typeof startProxy>[0]["limits"];
  /** Test seams: where requests and passthrough tunnels really go. */
  upstream?: SafeFetch;
  tunnel?: (host: string, port: number) => Promise<net.Socket>;
  now?: () => number;
  log?: (message: string) => void;
}

interface Live {
  scope: Required<Scope>;
  redact: SecretRegistry;
  githubToken?: string | undefined;
}

const toRule = (r: ProxyRuleRow): Rule => ({
  id: r.name,
  host: r.host,
  port: r.port,
  methods: JSON.parse(r.methods) as string[],
  pathPrefix: r.pathPrefix,
  inject:
    r.injectType === "basic"
      ? { type: "basic", username: r.injectUsername ?? "" }
      : ({
          type: "header",
          name: r.injectHeader ?? "",
          ...(r.injectFormat === null ? {} : { format: r.injectFormat }),
        } satisfies Inject),
  secret: r.secret,
});

/** The address to bind when none was asked for: the narrowest one a container can reach. */
export async function defaultBindHost(
  gateway: () => Promise<string | undefined> = () => dockerBridgeGateway(),
): Promise<string> {
  return (await gateway()) ?? "127.0.0.1";
}

const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

export class SecretsProxy {
  readonly #o: SecretsProxyOptions;
  readonly #registry: AttemptRegistry;
  readonly #live = new Map<string, Live>();
  #running: RunningProxy | undefined;

  private constructor(o: SecretsProxyOptions) {
    this.#o = o;
    this.#registry = new AttemptRegistry(o.now ? { now: o.now } : {});
  }

  static async start(o: SecretsProxyOptions): Promise<SecretsProxy> {
    const p = new SecretsProxy(o);
    const bind = o.bindHost ?? (await defaultBindHost(o.bridgeGateway));
    if (WILDCARD.has(bind)) {
      o.log?.(
        `WARNING: the secrets proxy is bound to ${bind}, every interface of this machine. Each connection still needs a per-attempt credential, but prefer the Docker bridge address.`,
      );
    }
    const source: SecretSource = { resolve: (scope, rule) => p.#resolve(scope, rule) };
    const audit: AuditSink = { record: (e) => p.#audit(e) };
    p.#running = await startProxy({
      registry: p.#registry,
      source,
      audit,
      host: bind,
      port: o.port ?? 0,
      ...(o.tls ? { tls: o.tls } : {}),
      ...(o.limits ? { limits: o.limits } : {}),
      ...(o.upstream ? { upstream: o.upstream } : {}),
      ...(o.tunnel ? { tunnel: o.tunnel } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    return p;
  }

  /** The address the proxy actually bound. */
  get host(): string {
    return this.#running?.host ?? "127.0.0.1";
  }

  get port(): number {
    return this.#running?.port ?? 0;
  }

  async stop(): Promise<void> {
    await this.#running?.close();
  }

  async #resolve(scope: SecretScope, rule: Rule): Promise<ResolvedSecret> {
    const live = this.#live.get(scope.attemptId);
    if (!live || !rule.secret) return { ok: false, reason: "no_attempt" };
    if (rule.secret === GITHUB_TOKEN_SECRET) {
      // This attempt's own token, never a vault secret. Only the rules githubRules builds name it.
      if (!live.githubToken) return { ok: false, reason: "no_github_token" };
      live.redact.register(live.githubToken);
      return { ok: true, value: live.githubToken };
    }
    // Through the vault's one policy path, per request: class, scope, destination, rotation,
    // freeze and audit all apply. Nothing is read ahead of time.
    const r = await this.#o.vault.use({
      orgId: scope.orgId,
      projectId: scope.projectId,
      runId: scope.runId,
      jobId: scope.jobId,
      attemptId: scope.attemptId,
      name: rule.secret,
      destination: scope.host,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    // The log redactor learns the value before it can be echoed anywhere.
    live.redact.register(r.value);
    return { ok: true, value: r.value };
  }

  async #audit(e: AuditEvent): Promise<void> {
    const live = this.#live.get(e.attemptId);
    // An event with no attempt behind it (a bad credential) has no org to attribute it to.
    if (!live) {
      this.#o.log?.(`proxy: ${e.kind} ${e.reason ?? ""} for an unknown attempt`);
      return;
    }
    await appendAudit(this.#o.db, live.scope, {
      principalKind: "attempt",
      principalId: e.attemptId,
      op: `proxy_${e.kind}`,
      effect: "use",
      outcome: e.reason ?? "ok",
      input: {
        host: e.host ?? null,
        port: e.port ?? null,
        method: e.method ?? null,
        rule: e.ruleId ?? null,
        ...(e.detail ? { detail: e.detail } : {}),
      },
    });
  }

  /**
   * The rules this attempt may have: the project's, each one only while the vault secret it names
   * still lists the rule's host. Never from a workflow.
   */
  async rulesFor(scope: Required<Scope>): Promise<Rule[]> {
    const out: Rule[] = [];
    for (const row of await listProxyRules(this.#o.db, scope)) {
      if (!(await this.#o.vault.canDeliver(scope.orgId, scope.projectId, row.secret, row.host))) {
        this.#o.log?.(
          `proxy rule ${row.name} skipped: its host is not a destination of the secret`,
        );
        continue;
      }
      const rule = toRule(row);
      try {
        compileRule(rule);
      } catch {
        this.#o.log?.(`proxy rule ${row.name} skipped: it does not compile`);
        continue;
      }
      out.push(rule);
    }
    return out;
  }

  /** The hosts the project allows plain tunnels to. */
  passthroughFor(scope: Required<Scope>): Promise<PassthroughEntry[]> {
    return listPassthroughHosts(this.#o.db, scope);
  }

  register(
    ctx: AttemptContext,
    rules: readonly Rule[],
    o: { passthroughHosts: readonly PassthroughEntry[]; ttlMs: number; vaultRules?: boolean },
  ): { access: ProxyAccess; redact: SecretRegistry } {
    const redact = new SecretRegistry();
    this.#live.set(ctx.attempt.id, { scope: ctx.scope, redact });
    const live = this.#live.get(ctx.attempt.id);
    const credential = this.#registry.register({
      attemptId: ctx.attempt.id,
      orgId: ctx.scope.orgId,
      projectId: ctx.scope.projectId,
      runId: ctx.run.id,
      jobId: ctx.job.id,
      rules,
      passthroughHosts: o.passthroughHosts,
      ttlMs: o.ttlMs,
    });
    return {
      access: {
        listen: {
          host: this.#o.advertiseHost ?? "host.docker.internal",
          port: this.#o.advertisePort ?? this.port,
          // The name the certificate is for, when this is a public TLS listener.
          ...(this.#o.tls ? { tlsName: this.#o.advertiseHost ?? "host.docker.internal" } : {}),
          ...(this.#o.advertiseAddresses ? { addresses: this.#o.advertiseAddresses } : {}),
        },
        credential,
        vaultRules: o.vaultRules ?? true,
        setGithubToken: (token) => {
          if (live) live.githubToken = token;
        },
      },
      redact,
    };
  }

  /** Ends the attempt's credential and closes its tunnels. Idempotent. */
  release(attemptId: string): void {
    this.#registry.revoke(attemptId);
    this.#registry.sweep();
    this.#live.delete(attemptId);
  }

  /** Attempts with a live registration (for tests and status). */
  get active(): number {
    return this.#live.size;
  }
}

export interface SecretsProxyRunnerOptions {
  proxy: SecretsProxy;
  /** How long an attempt's credential lives. Default: the longest job plus a margin. */
  ttlMs?: number;
  /**
   * Where a run's GitHub token would come from: its bound repository and installation. Absent or
   * returning nothing: no GitHub rules.
   */
  github?: (ctx: AttemptContext) => Promise<GithubTarget | undefined>;
}

/**
 * Wraps a runner: registers the attempt's rules before it starts and revokes them after, in a
 * finally and at once when the attempt is aborted (cancel, timeout, lease loss).
 * - Vault rules (the project's `proxy_rules`) only for a class that may hold secrets; never for
 *   `untrusted_pr`.
 * - GitHub rules (the job's own token, for its own repository) for every class when the run is
 *   bound to an installation. For `untrusted_pr` they are the ONLY rules.
 * - No rules at all: no proxy, egress unchanged.
 * - A re-attached attempt (its credential died with the old process) is refused, fail closed,
 *   when it would have had rules.
 */
export function withSecretsProxy(
  runner: AttemptRunner,
  o: SecretsProxyRunnerOptions,
): AttemptRunner {
  return async (ctx): Promise<AttemptOutcome> => {
    const klass = parseTrust(ctx.run)?.class as TrustClass | undefined;
    if (klass === undefined) return runner(ctx);
    const mayHoldSecrets = klass !== "untrusted_pr" && credentialsFor(klass).secrets;
    const vaultRules = mayHoldSecrets ? await o.proxy.rulesFor(ctx.scope) : [];
    const target = o.github ? await o.github(ctx) : undefined;
    const ghRules = target ? githubRules(target) : [];
    const rules = [...vaultRules, ...ghRules];
    if (rules.length === 0) return runner(ctx);
    if (ctx.resume) {
      // Vault rules: the credential died with the old process, so the job cannot be resumed. With
      // GitHub rules only, the job may or may not have had a token; it carries on without the
      // proxy (a token it held is unusable: its credential is gone), which can only fail closed.
      if (vaultRules.length === 0) return runner(ctx);
      return {
        state: "infra_error",
        reason: "re-attached attempt lost its secrets-proxy credential; not resumed",
      };
    }
    const { access, redact } = o.proxy.register(ctx, rules, {
      // Hosts with no rule are tunnelled only if the project listed them, and only for a class
      // that may hold secrets. No list, rule hosts only.
      passthroughHosts: mayHoldSecrets ? await o.proxy.passthroughFor(ctx.scope) : [],
      ttlMs: o.ttlMs ?? 5 * 3600 * 1000,
      vaultRules: vaultRules.length > 0,
    });
    const revoke = (): void => o.proxy.release(ctx.attempt.id);
    ctx.signal.addEventListener("abort", revoke, { once: true });
    try {
      return await runner({ ...ctx, proxy: access, redact });
    } finally {
      ctx.signal.removeEventListener("abort", revoke);
      revoke();
    }
  };
}

/**
 * The run's GitHub repository and installation, from the project's binding: what a job token is
 * minted for. Nothing for a local run, a project with no binding, or a binding with no installation.
 */
export function githubTargetOf(
  db: Db,
): (ctx: Pick<AttemptContext, "run" | "scope">) => Promise<GithubTarget | undefined> {
  return async ({ run, scope }) => {
    if (run.local) return undefined;
    const bound = (await listRepos(db, scope))[0];
    if (!bound || bound.forge !== "github" || !bound.installationId) return undefined;
    return { owner: bound.owner, repo: bound.repo, installationId: bound.installationId };
  };
}
