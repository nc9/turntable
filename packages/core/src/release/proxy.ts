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
} from "@turntable/proxy";
import type { SafeFetch } from "@turntable/net";
import type { ProxyEndpoint } from "@turntable/provider-sdk";
import { createHash } from "node:crypto";
import type net from "node:net";
import type { Db } from "../db";
import { appendAudit, getFreeze } from "../db/repos";
import type { SecretVault } from "../secrets/vault";
import type { AttestationStore } from "./attest";
import { compatRules, RELEASE_GITHUB_SECRET } from "./compat";
import type { ArtifactBytes } from "./artifacts";
import type { ForgeFacts } from "./forge";
import { inspectNpmTarball } from "./publish/npm";
import { ensureDraft } from "./publish/github-release";

export interface ReleaseProxyOptions {
  db: Db;
  /** The release lane's vault (`lane: "release"`). */
  vault: SecretVault;
  attest: AttestationStore;
  forge: ForgeFacts;
  /** The artifact bytes, to derive the npm publish document from the verified tarball. */
  bytes: ArtifactBytes;
  /** The lane's own GitHub write credential, for the GitHub rules. */
  githubToken: () => Promise<string | undefined>;
  bindHost?: string;
  port?: number;
  /** How a sandbox reaches this listener. Default: the bind address. */
  advertiseHost?: string;
  advertisePort?: number;
  advertiseAddresses?: readonly string[];
  /** A public TLS listener, for sandboxes in another provider's network. */
  tls?: { key: string; cert: string };
  /** Where the lane creates the GitHub draft (tests point it elsewhere). */
  github?: { api?: string; fetch?: SafeFetch };
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
  | "draft_unavailable"
  | "artifact_unverified"
  | "already_registered"
  | "approval_expired"
  | "already_finalized"
  | "superseded"
  | "no_compat_targets";

export type RegisterResult =
  | {
      ok: true;
      credential: AttemptCredential;
      listen: ProxyEndpoint;
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
      ...(o.tls ? { tls: o.tls } : {}),
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
    if (this.#live.has(a.attemptId)) return refuse("already_registered");
    if ((await getFreeze(this.#o.db, scope)).frozen) return refuse("frozen");
    const approved = this.#o.attest.approvedRelease({ ...scope, runId: a.runId });
    if (!approved) return refuse("not_approved");
    // A signed release is not a standing permission: it lasts a while, ends when it is finalized,
    // and a newer approved release replaces it. Otherwise an old approval could be re-registered
    // later to publish old bytes under a name that has moved on (rolling `latest` back).
    const nowMs = (this.#o.now ?? Date.now)();
    if (approved.finalizedAt !== undefined) return refuse("already_finalized");
    if (nowMs >= approved.expiresAt) return refuse("approval_expired");
    const newest = this.#o.attest.isNewestApproved({ ...scope, runId: a.runId });
    if (!newest) return refuse("superseded");
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
    // The lane creates the GitHub draft itself, before the job runs, and pins the job's upload
    // rule to that draft's id: a job can never attach anything to a published release.
    let githubDraftId: number | undefined;
    const wantsDraft = Object.values(targets).some(
      (t) => t.kind === "github-release" && t.mode === "compat",
    );
    if (wantsDraft) {
      const token = await this.#o.githubToken();
      const d = token
        ? await ensureDraft(approved.repo, approved.tag, token, this.#o.github ?? {})
        : ({ ok: false, reason: "no_github_credential" } as const);
      if (!d.ok) {
        this.#o.log?.(`release proxy: no draft for ${approved.tag}: ${d.reason}`);
        return refuse("draft_unavailable");
      }
      githubDraftId = d.id;
    }
    // The npm publish document is derived from the tarball the lane reads and hashes now.
    const npmManifests: Record<string, Record<string, unknown>> = {};
    const npmReadmes: Record<string, Record<string, string>> = {};
    for (const t of Object.values(targets)) {
      if (t.kind !== "npm" || t.mode !== "compat" || npmManifests[t.artifact]) continue;
      const bytes = await this.#o.bytes.read(a.runId, t.artifact);
      const insp =
        bytes && createHash("sha256").update(bytes).digest("hex") === digests[t.artifact]
          ? inspectNpmTarball(bytes, t.package, approved.tag)
          : undefined;
      if (!insp?.ok) {
        this.#o.log?.(`release proxy: ${t.artifact} is not the verified npm tarball`);
        return refuse("artifact_unverified");
      }
      npmManifests[t.artifact] = insp.manifest;
      npmReadmes[t.artifact] = insp.readmes;
    }
    const rules: Rule[] = Object.entries(targets).flatMap(([key, t]) =>
      compatRules(key, t, {
        repo: approved.repo,
        tag: approved.tag,
        digests,
        githubDraftId,
        npmManifests,
        npmReadmes,
        sha: approved.sha,
        newest,
      }),
    );
    if (rules.length === 0) return refuse("no_compat_targets");
    this.#live.set(a.attemptId, {
      orgId: a.orgId,
      projectId: a.projectId,
      runId: a.runId,
      tag: approved.tag,
    });
    // The registration never outlives its approval.
    const ttlMs = Math.min(a.ttlMs, approved.expiresAt - (this.#o.now ?? Date.now)());
    const credential = this.#registry.register({
      attemptId: a.attemptId,
      orgId: a.orgId,
      projectId: a.projectId,
      runId: a.runId,
      jobId: a.jobId,
      rules,
      ttlMs,
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
      listen: {
        host: this.#o.advertiseHost ?? this.host,
        port: this.#o.advertisePort ?? this.port,
        ...(this.#o.tls ? { tlsName: this.#o.advertiseHost ?? this.host } : {}),
        ...(this.#o.advertiseAddresses ? { addresses: this.#o.advertiseAddresses } : {}),
      },
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

  /**
   * Why an approval no longer backs a live registration, or undefined while it does: the release
   * was finalized, its window ended, or a newer release of the project was approved.
   */
  #approvalGone(live: Live): "release_finalized" | "approval_expired" | "superseded" | undefined {
    const id = { orgId: live.orgId, projectId: live.projectId, runId: live.runId };
    const approved = this.#o.attest.approvedRelease(id);
    if (!approved) return "approval_expired";
    if (approved.finalizedAt !== undefined) return "release_finalized";
    if ((this.#o.now ?? Date.now)() >= approved.expiresAt) return "approval_expired";
    if (!this.#o.attest.isNewestApproved(id)) return "superseded";
    return undefined;
  }

  /**
   * Revokes every live registration whose approval is gone (finalized, expired or superseded).
   * Returns how many. Run on a timer beside `sweepFrozen`; each request also checks, so this is
   * what ends a credential that is not being used.
   */
  async sweepApprovals(): Promise<number> {
    let n = 0;
    for (const [id, l] of this.#live) {
      const why = this.#approvalGone(l);
      if (!why) continue;
      this.release(id);
      await this.#revokedAudit(id, l, why);
      n++;
    }
    return n;
  }

  async #revokedAudit(attemptId: string, l: Live, outcome: string): Promise<void> {
    await appendAudit(
      this.#o.db,
      { orgId: l.orgId, projectId: l.projectId },
      {
        principalKind: "system",
        principalId: "release-lane",
        op: "release_proxy_revoke",
        effect: "write",
        outcome,
        input: { run: l.runId, attempt: attemptId },
      },
    );
  }

  async #resolve(scope: SecretScope, rule: Rule): Promise<ResolvedSecret> {
    const live = this.#live.get(scope.attemptId);
    if (!live || !rule.secret) return { ok: false, reason: "no_attempt" };
    // Checked on every request, not only at registration: a freeze, and the approval itself. A
    // release finalized, expired or replaced by a newer one gets nothing more, and its
    // registration ends.
    if ((await getFreeze(this.#o.db, live)).frozen) return { ok: false, reason: "frozen" };
    // The request is refused here and the refusal is written to the job. The registration itself is
    // ended by `sweepApprovals`, not from inside this call: revoking closes the attempt's open
    // tunnels, which would cut the connection this refusal is about to be written on (the job
    // would see a reset instead of the reason). Nothing more is handed out meanwhile, because
    // every request re-checks.
    const gone = this.#approvalGone(live);
    if (gone) {
      await appendAudit(
        this.#o.db,
        { orgId: live.orgId, projectId: live.projectId },
        {
          principalKind: "attempt",
          principalId: scope.attemptId,
          op: "release_proxy_refuse",
          effect: "use",
          outcome: gone,
          input: { run: live.runId, rule: rule.id },
        },
      );
      return { ok: false, reason: gone };
    }
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
