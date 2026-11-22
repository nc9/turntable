// The release proxy: compat publishing. A project's own job runs `npm publish`, `docker push` or
// `gh release upload`, and this proxy, hosted by the release lane, attaches the credential to the
// approved request and nothing else. It is the same proxy code the worker hosts, with the release
// vault as its secret source and the lane as the only thing that registers attempts, so the worker
// that schedules the job never sees a credential or a rule.
//
// Rules exist only while the lane holds its own record (in its own file) that it signed this run's
// release, the tag still points at the signed commit at the forge, and no incident freeze is on.
import {
  AttemptRegistry,
  startProxy,
  type AttemptCredential,
  type AuditEvent,
  type ResolvedSecret,
  type RunningProxy,
  type Rule,
  type SecretScope,
} from "@longshore/proxy";
import type { SafeFetch } from "@longshore/net";
import type net from "node:net";
import type { Db } from "../db";
import { appendAudit, getFreeze } from "../db/repos";
import type { SecretVault } from "../secrets/vault";
import type { AttestationStore } from "./attest";
import { compatRules, RELEASE_GITHUB_SECRET } from "./compat";
import type { ForgeFacts } from "./forge";

export interface ReleaseProxyOptions {
  db: Db;
  /** The release lane's vault (`lane: "release"`). */
  vault: SecretVault;
  attest: AttestationStore;
  forge: ForgeFacts;
  /** The lane's own GitHub write credential, for the GitHub rules. */
  githubToken: () => Promise<string | undefined>;
  bindHost?: string;
  port?: number;
  /** How a sandbox reaches this listener. Default: the bind address. */
  advertiseHost?: string;
  /** Test seams: where requests and tunnels really go. */
  upstream?: SafeFetch;
  tunnel?: (host: string, port: number) => Promise<net.Socket>;
  now?: () => number;
  log?: (m: string) => void;
}

export type RegisterRefusal =
  | "frozen"
  | "not_approved"
  | "repo_mismatch"
  | "tag_moved"
  | "no_compat_targets";

export type RegisterResult =
  | {
      ok: true;
      credential: AttemptCredential;
      listen: { host: string; port: number };
      /** Ids of the rules the job was given, for the audit trail and the status page. */
      rules: string[];
    }
  | { ok: false; reason: RegisterRefusal };

interface Live {
  orgId: string;
  projectId: string;
  runId: string;
  tag: string;
}

export class ReleaseProxy {
  readonly #o: ReleaseProxyOptions;
  readonly #registry: AttemptRegistry;
  readonly #live = new Map<string, Live>();
  #running: RunningProxy | undefined;

  private constructor(o: ReleaseProxyOptions) {
    this.#o = o;
    this.#registry = new AttemptRegistry(o.now ? { now: o.now } : {});
  }

  static async start(o: ReleaseProxyOptions): Promise<ReleaseProxy> {
    const p = new ReleaseProxy(o);
    p.#running = await startProxy({
      registry: p.#registry,
      source: { resolve: (scope, rule) => p.#resolve(scope, rule) },
      audit: { record: (e) => p.#audit(e) },
      host: o.bindHost ?? "127.0.0.1",
      port: o.port ?? 0,
      ...(o.upstream ? { upstream: o.upstream } : {}),
      ...(o.tunnel ? { tunnel: o.tunnel } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    return p;
  }

  get host(): string {
    return this.#running?.host ?? "127.0.0.1";
  }
  get port(): number {
    return this.#running?.port ?? 0;
  }
  get active(): number {
    return this.#live.size;
  }

  async stop(): Promise<void> {
    await this.#running?.close();
  }

  /**
   * Hands a publish job its proxy credential and rules, only for a release the lane signed. The
   * rules come from the project's compat targets in the lane's own file and the digests the lane
   * attested, never from the workflow or the main database.
   */
  async register(a: {
    orgId: string;
    projectId: string;
    runId: string;
    jobId: string;
    attemptId: string;
    ttlMs: number;
  }): Promise<RegisterResult> {
    const scope = { orgId: a.orgId, projectId: a.projectId };
    const refuse = async (reason: RegisterRefusal): Promise<RegisterResult> => {
      await appendAudit(this.#o.db, scope, {
        principalKind: "system",
        principalId: "release-lane",
        op: "release_proxy_register",
        effect: "write",
        outcome: `refused:${reason}`,
        input: { run: a.runId, job: a.jobId, attempt: a.attemptId },
      });
      return { ok: false, reason };
    };
    if ((await getFreeze(this.#o.db, scope)).frozen) return refuse("frozen");
    const approved = this.#o.attest.approvedRelease({ ...scope, runId: a.runId });
    if (!approved) return refuse("not_approved");
    if (this.#o.attest.pinnedRepo(a.orgId, a.projectId) !== approved.repo)
      return refuse("repo_mismatch");
    const tag = await this.#o.forge.tagCommit(approved.repo, approved.tag);
    if (!tag.found || tag.sha !== approved.sha) return refuse("tag_moved");
    const digests = this.#o.attest.attestedDigests({
      ...scope,
      repo: approved.repo,
      tag: approved.tag,
    });
    const targets = this.#o.attest.publishTargets(a.orgId, a.projectId);
    const rules: Rule[] = Object.entries(targets).flatMap(([key, t]) =>
      compatRules(key, t, { repo: approved.repo, tag: approved.tag, digests }),
    );
    if (rules.length === 0) return refuse("no_compat_targets");
    this.#live.set(a.attemptId, {
      orgId: a.orgId,
      projectId: a.projectId,
      runId: a.runId,
      tag: approved.tag,
    });
    const credential = this.#registry.register({
      attemptId: a.attemptId,
      orgId: a.orgId,
      projectId: a.projectId,
      runId: a.runId,
      jobId: a.jobId,
      rules,
      ttlMs: a.ttlMs,
    });
    await appendAudit(this.#o.db, scope, {
      principalKind: "system",
      principalId: "release-lane",
      op: "release_proxy_register",
      effect: "write",
      outcome: "ok",
      input: {
        run: a.runId,
        job: a.jobId,
        attempt: a.attemptId,
        tag: approved.tag,
        rules: rules.map((r) => r.id),
      },
    });
    return {
      ok: true,
      credential,
      listen: { host: this.#o.advertiseHost ?? this.host, port: this.port },
      rules: rules.map((r) => r.id),
    };
  }

  /** Ends an attempt's credential and closes its tunnels. Idempotent. */
  release(attemptId: string): void {
    this.#registry.revoke(attemptId);
    this.#registry.sweep();
    this.#live.delete(attemptId);
  }

  /** Revokes every attempt whose org or project is now frozen. Returns how many. */
  async sweepFrozen(): Promise<number> {
    let n = 0;
    for (const [id, l] of this.#live) {
      if ((await getFreeze(this.#o.db, { orgId: l.orgId, projectId: l.projectId })).frozen) {
        this.release(id);
        await appendAudit(
          this.#o.db,
          { orgId: l.orgId, projectId: l.projectId },
          {
            principalKind: "system",
            principalId: "release-lane",
            op: "release_proxy_revoke",
            effect: "write",
            outcome: "frozen",
            input: { run: l.runId, attempt: id },
          },
        );
        n++;
      }
    }
    return n;
  }

  async #resolve(scope: SecretScope, rule: Rule): Promise<ResolvedSecret> {
    const live = this.#live.get(scope.attemptId);
    if (!live || !rule.secret) return { ok: false, reason: "no_attempt" };
    // Checked on every request, not only at registration.
    if ((await getFreeze(this.#o.db, live)).frozen) return { ok: false, reason: "frozen" };
    if (rule.secret === RELEASE_GITHUB_SECRET) {
      const token = await this.#o.githubToken();
      return token ? { ok: true, value: token } : { ok: false, reason: "no_github_credential" };
    }
    const r = await this.#o.vault.usePublishCredential({
      orgId: live.orgId,
      projectId: live.projectId,
      name: rule.secret,
      destination: scope.host,
      tag: live.tag,
      requestId: `compat:${scope.attemptId}`,
    });
    return r.ok ? { ok: true, value: r.value } : { ok: false, reason: r.reason };
  }

  async #audit(e: AuditEvent): Promise<void> {
    const live = this.#live.get(e.attemptId);
    if (!live) {
      this.#o.log?.(`release proxy: ${e.kind} ${e.reason ?? ""} for an unknown attempt`);
      return;
    }
    await appendAudit(
      this.#o.db,
      { orgId: live.orgId, projectId: live.projectId },
      {
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
      },
    );
  }
}
