// The signing service. It signs a statement it builds itself, from what the server stored: the
// run, its stored plan and the artifact store. A caller names a run and artifact names; it never
// supplies a digest, a class, a ref or a key.
import {
  type DsseEnvelope,
  type Artifact,
  PAYLOAD_TYPE,
  type ResolvedAction,
  type Signer,
  buildStatement,
  signEnvelope,
  statementBytes,
} from "@longshore/signer";
import type { Db } from "../db";
import {
  appendAudit,
  getProjectSigning,
  getRun,
  getRunArtifactsByName,
  listRunArtifacts,
  listRunAttempts,
  parseTrust,
  type Scope,
} from "../db/repos";
import type { ApprovalVerifier } from "./approvals";
import { decideSigning, type SigningDenial } from "./policy";

export type Backend = "builtin" | "aws-kms" | "gcp-kms";

export interface SigningServiceOptions {
  db: Db;
  /** The backends this instance has. A project's key names one of them. */
  signers: Partial<Record<Backend, Signer>>;
  approvals: ApprovalVerifier;
  /** The Longshore instance, as a URL: the provenance's builder id. */
  builderId: string;
}

export interface SignRequest {
  runId: string;
  /** Names of artifacts recorded for the run. */
  artifacts: readonly string[];
  /**
   * Optional, and never trusted: the approval environment is the project's own setting. A request
   * that names a different one is refused.
   */
  environment?: string | undefined;
  /**
   * What a caller that checked the facts itself (the release lane) verified: the commit, the
   * repository and the digests it computed from the bytes. The service signs only if its own
   * read of the stored run and artifacts is exactly this, so a row changed after the caller
   * looked is refused, never signed.
   */
  verified?: { sha: string; repo: string; ref: string; subjects: readonly Artifact[] } | undefined;
}

export type SignOutcome =
  | { ok: true; envelope: DsseEnvelope; keyid: string; subjects: Artifact[] }
  | { ok: false; reason: SigningDenial; detail?: string };

const BACKENDS: readonly Backend[] = ["builtin", "aws-kms", "gcp-kms"];

/** `backend:ref`, or undefined when the setting is not one the service understands. */
export function parseKeyRef(setting: string): { backend: Backend; keyRef: string } | undefined {
  const i = setting.indexOf(":");
  const backend = setting.slice(0, i) as Backend;
  const keyRef = setting.slice(i + 1);
  return i > 0 && BACKENDS.includes(backend) && keyRef !== "" ? { backend, keyRef } : undefined;
}

export class SigningService {
  readonly #o: SigningServiceOptions;

  constructor(o: SigningServiceOptions) {
    this.#o = o;
  }

  async signRelease(scope: Required<Scope>, req: SignRequest): Promise<SignOutcome> {
    const { db } = this.#o;
    const deny = async (
      reason: SigningDenial,
      detail?: string,
      extra: Record<string, unknown> = {},
    ): Promise<SignOutcome> => {
      await this.#audit(scope, `denied:${reason}`, {
        runId: req.runId,
        environment: req.environment,
        ...extra,
      });
      return { ok: false, reason, ...(detail ? { detail } : {}) };
    };

    const run = await getRun(db, scope, req.runId);
    if (!run) return deny("unknown_run");
    const project = await getProjectSigning(db, scope);
    // The approval policy comes from the project, not from the caller.
    const environment = project.environment;
    if (req.environment !== undefined && req.environment !== environment) {
      return deny("environment_mismatch", undefined, { required: environment });
    }
    const recorded = await getRunArtifactsByName(db, scope, run.id, req.artifacts);
    // The verifier re-checks the signed statements itself, for exactly this run, sha, workflow
    // and environment. A run with no sha or no recorded workflow hash cannot have been approved.
    const workflowHash = parseTrust(run)?.workflowHash;
    const approval =
      run.sha === null || workflowHash === undefined
        ? undefined
        : await this.#o.approvals.verify(
            {
              orgId: scope.orgId,
              projectId: scope.projectId,
              runId: run.id,
              headSha: run.sha,
              workflowHash,
            },
            environment,
          );
    const decision = decideSigning({
      klass: parseTrust(run)?.class,
      status: run.status,
      ref: run.ref,
      repo: run.repo,
      releaseRefs: project.releaseRefs,
      signingKey: project.signingKey,
      requested: req.artifacts,
      recorded: recorded.map((a) => a.name),
      approvalOk: approval?.approved === true,
    });
    if (!decision.ok) return deny(decision.reason, decision.detail);
    if (req.verified) {
      const v = req.verified;
      const own = new Map(recorded.map((a) => [a.name, a.sha256]));
      const sameSubjects =
        own.size === v.subjects.length && v.subjects.every((s) => own.get(s.name) === s.sha256);
      const sameSha = run.sha !== null && run.sha.toLowerCase() === v.sha.toLowerCase();
      const sameRepo = run.repo !== null && run.repo.toLowerCase() === v.repo.toLowerCase();
      const sameRef = run.ref === v.ref;
      if (!sameSha || !sameRepo || !sameRef || !sameSubjects) {
        return deny(
          "verification_mismatch",
          [
            !sameSha && "sha",
            !sameRepo && "repo",
            !sameRef && "ref",
            !sameSubjects && "artifact digests",
          ]
            .filter(Boolean)
            .join(", "),
        );
      }
    }

    const key = parseKeyRef(project.signingKey!);
    const signer = key ? this.#o.signers[key.backend] : undefined;
    if (!key || !signer) return deny("no_backend");

    const subjects: Artifact[] = recorded.map((a) => ({ name: a.name, sha256: a.sha256 }));
    const chosen = new Set(subjects.map((s) => s.name));
    // A statement signed for a caller that verified the facts itself (the release lane) carries
    // only what that caller verified. The other recorded artifacts and the pinned actions are
    // plain reads of rows nobody re-checked, so they are left out, not vouched for.
    const byproducts = req.verified
      ? []
      : (await listRunArtifacts(db, scope, run.id))
          .filter((a) => !chosen.has(a.name))
          .map((a) => ({ name: a.name, sha256: a.sha256 }));
    const actions = req.verified ? [] : await this.#actions(scope, run.id);

    const statement = buildStatement({
      builderId: this.#o.builderId,
      invocationId: run.id,
      repo: run.repo!,
      workflowPath: run.workflowPath,
      ref: run.ref,
      sha: run.sha ?? "",
      event: run.event,
      inputs: {},
      environment,
      actions,
      subjects,
      byproducts,
      startedOn: run.startedAt === null ? undefined : new Date(run.startedAt).toISOString(),
      finishedOn: run.finishedAt === null ? undefined : new Date(run.finishedAt).toISOString(),
    });
    const envelope = await signEnvelope(
      PAYLOAD_TYPE,
      statementBytes(statement),
      signer,
      key.keyRef,
    );
    const keyid = envelope.signatures[0]!.keyid;
    // The signature is returned only after the record of it is written.
    await this.#audit(scope, "ok", {
      runId: run.id,
      environment,
      keyid,
      artifacts: subjects,
      approvers: approval?.approved ? approval.approvals.map((a) => a.person) : [],
    });
    return { ok: true, envelope, keyid, subjects };
  }

  /** The actions every attempt of the run pinned, from the plans stored when they started. */
  async #actions(scope: Required<Scope>, runId: string): Promise<ResolvedAction[]> {
    const out: ResolvedAction[] = [];
    for (const attempt of await listRunAttempts(this.#o.db, scope, runId)) {
      if (!attempt.plan) continue;
      let plan: { actions?: { uses?: string; repo?: string; ref?: string; sha?: string }[] };
      try {
        plan = JSON.parse(attempt.plan);
      } catch {
        continue;
      }
      for (const a of plan.actions ?? []) {
        if (a.uses && a.repo && a.ref && a.sha) {
          out.push({ uses: a.uses, repo: a.repo, ref: a.ref, sha: a.sha });
        }
      }
    }
    return out;
  }

  #audit(scope: Required<Scope>, outcome: string, input: Record<string, unknown>): Promise<void> {
    return appendAudit(this.#o.db, scope, {
      principalKind: "system",
      principalId: "signing-service",
      op: "sign_release",
      effect: "write",
      outcome,
      input,
    });
  }
}
