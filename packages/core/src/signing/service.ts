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
} from "@turntable/signer";
import type { Db } from "../db";
import {
  appendAudit,
  getProjectSigning,
  signingKeyUsedByOtherOrg,
  getRun,
  getRunArtifactsByName,
  listRunArtifacts,
  listRunAttempts,
  parseTrust,
  type Scope,
} from "../db/repos";
import { manifestSha256 } from "../release/manifest";
import type { ReleaseApprovalVerifier, ApprovalSubject } from "./approvals";
import { CONFIG_CHANGED_REASON } from "../release/attest";
import { decideSigning, type SigningDenial } from "./policy";

export type Backend = "builtin" | "aws-kms" | "gcp-kms";

export interface SigningServiceOptions {
  db: Db;
  /** The backends this instance has. A project's key names one of them. */
  signers: Partial<Record<Backend, Signer>>;
  approvals: ReleaseApprovalVerifier;
  /** The Turntable instance, as a URL: the provenance's builder id. */
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
   *
   * An artifact that is a zip is only transport: the lane unpacks it and the statement names the
   * files inside, so `subjects` are those files, and `archives` lists each zip the lane unpacked
   * with the digest it computed. The service checks each of those digests against its own row
   * (the zip really is the recorded artifact), and every recorded artifact NOT listed there must
   * itself be a subject, name and digest. Subject names must be unique.
   */
  verified?:
    | {
        sha: string;
        repo: string;
        ref: string;
        subjects: readonly Artifact[];
        archives?: readonly Artifact[] | undefined;
        /**
         * The lane's configuration version now: a release approval given under another version
         * does not count (the pin, targets or secrets changed since the approver looked).
         */
        configVersion?: number | undefined;
      }
    | undefined;
}

export type SignOutcome =
  | { ok: true; envelope: DsseEnvelope; keyid: string; subjects: Artifact[] }
  | { ok: false; reason: SigningDenial; detail?: string };

/**
 * The name a project's `builtin:<name>` key has in the key vault: the ORG's id and the name. The
 * org comes from the run's scope, never from the setting or the request, so a project cannot name
 * another org's key: whatever it writes after `builtin:` is looked up inside its own org.
 * Org ids are ULIDs (no dots), so `<org id>.<name>` decodes one way.
 */
export const builtinKeyRef = (orgId: string, name: string): string => `${orgId}.${name}`;

/** The digest of the recorded rows of the requested artifacts, or undefined when there is none. */
function manifestOf(
  recorded: readonly { name: string; sha256: string; size: number }[],
): string | undefined {
  if (recorded.length === 0) return undefined;
  try {
    return manifestSha256(recorded);
  } catch {
    return undefined;
  }
}

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

  /**
   * A dry run's question: is the project's signing key there to sign with? Reads the key's public
   * half only; signs nothing, reads and spends no approval.
   */
  async checkKey(scope: Required<Scope>): Promise<{ ok: true } | { ok: false; reason: string }> {
    const project = await getProjectSigning(this.#o.db, scope);
    if (!project.signingKey) return { ok: false, reason: "no signing key is set for the project" };
    const key = parseKeyRef(project.signingKey);
    const signer = key ? this.#o.signers[key.backend] : undefined;
    if (!key || !signer)
      return { ok: false, reason: "the lane has no backend for the signing key" };
    const keyRef = key.backend === "builtin" ? builtinKeyRef(scope.orgId, key.keyRef) : key.keyRef;
    try {
      await signer.publicKey(keyRef);
      return { ok: true };
    } catch {
      return { ok: false, reason: "the lane does not hold the project's signing key" };
    }
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
    // The verifier re-checks the signed statements itself, for exactly this run, sha, workflow,
    // environment AND the digest of the artifacts about to be signed (#424): an approval of other
    // bytes counts for nothing. A run with no sha, no recorded workflow hash or no artifact set
    // that can be digested cannot have been approved.
    const workflowHash = parseTrust(run)?.workflowHash;
    const manifest = manifestOf(recorded);
    const subject: ApprovalSubject | undefined =
      run.sha === null || workflowHash === undefined || manifest === undefined
        ? undefined
        : {
            orgId: scope.orgId,
            projectId: scope.projectId,
            runId: run.id,
            headSha: run.sha,
            workflowHash,
            manifestSha256: manifest,
            ...(req.verified?.configVersion !== undefined
              ? { laneConfigVersion: req.verified.configVersion }
              : {}),
          };
    const approval =
      subject === undefined ? undefined : await this.#o.approvals.verify(subject, environment);
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
    if (!decision.ok) {
      // A classified reason for a release approval that exists but does not cover these bytes.
      if (
        decision.reason === "no_approval" &&
        approval?.approved === false &&
        approval.reason === "config_changed"
      ) {
        return deny("config_changed", CONFIG_CHANGED_REASON, { manifest_sha256: manifest });
      }
      if (
        decision.reason === "no_approval" &&
        approval?.approved === false &&
        (approval.reason === "manifest_mismatch" || approval.reason === "approval_spent")
      ) {
        // An artifact no release attempt wrote is the more telling refusal than a digest that
        // differs only because that artifact is in the request.
        const lower = recorded.find((a) => a.klass !== "release");
        if (lower) return deny("artifact_not_release_class", lower.name);
        return deny(approval.reason, undefined, { manifest_sha256: manifest });
      }
      return deny(decision.reason, decision.detail);
    }
    // A release signs only what a release-class run produced: nothing a lower class could write.
    const lower = recorded.find((a) => a.klass !== "release");
    if (lower) return deny("artifact_not_release_class", lower.name);

    if (req.verified) {
      const v = req.verified;
      const own = new Map(recorded.map((a) => [a.name, a.sha256]));
      const archives = new Map((v.archives ?? []).map((a) => [a.name, a.sha256]));
      const subjectNames = new Set(v.subjects.map((s) => s.name));
      const subjectDigest = new Map(v.subjects.map((s) => [s.name, s.sha256]));
      // Each archive is a recorded artifact with the digest the lane saw; each recorded artifact
      // that is not an archive is a subject as it is; the names signed are all different.
      const sameSubjects =
        v.subjects.length > 0 &&
        subjectNames.size === v.subjects.length &&
        archives.size === (v.archives ?? []).length &&
        // With no archive there is nothing to unpack: the subjects are the recorded artifacts.
        (archives.size > 0 || subjectNames.size === own.size) &&
        [...archives].every(([name, sha]) => own.get(name) === sha) &&
        [...own].every(([name, sha]) => archives.has(name) || subjectDigest.get(name) === sha);
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
    // A key named outside the org namespace (a KMS key) must belong to this org alone.
    if (
      key.backend !== "builtin" &&
      (await signingKeyUsedByOtherOrg(db, scope.orgId, project.signingKey!))
    ) {
      return deny("key_shared", "another org names the same signing key");
    }
    const keyRef = key.backend === "builtin" ? builtinKeyRef(scope.orgId, key.keyRef) : key.keyRef;

    // Everything has checked out: spend the approvals this signature rests on, all or none, so one
    // approval authorises one signature of these bytes and a racing second request is refused.
    if (approval?.approved && subject) {
      // Fail closed: a verifier that cannot spend would let one approval sign again and again.
      // The type requires `spend`; this guards a wiring that got past it (a cast, untyped JS).
      if (typeof this.#o.approvals.spend !== "function") return deny("approval_unspendable");
      const spent = await this.#o.approvals.spend(subject, approval.approvals);
      if (!spent) return deny("approval_spent", undefined, { manifest_sha256: manifest });
    }

    const subjects: Artifact[] = req.verified?.archives?.length
      ? req.verified.subjects.map((a) => ({ name: a.name, sha256: a.sha256 }))
      : recorded.map((a) => ({ name: a.name, sha256: a.sha256 }));
    const chosen = new Set(subjects.map((s) => s.name));
    // A statement signed for a caller that verified the facts itself (the release lane) carries
    // only what that caller verified. The other recorded artifacts and the pinned actions are
    // plain reads of rows nobody re-checked, so they are left out, not vouched for.
    const byproducts = req.verified
      ? []
      : (await listRunArtifacts(db, scope, run.id))
          // A statement vouches only for what a release-class attempt wrote: a lower-class
          // artifact of the same run is left out, not listed next to the signed ones.
          .filter((a) => !chosen.has(a.name) && a.klass === "release")
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
    const envelope = await signEnvelope(PAYLOAD_TYPE, statementBytes(statement), signer, keyRef);
    const keyid = envelope.signatures[0]!.keyid;
    // The signature is returned only after the record of it is written.
    await this.#audit(scope, "ok", {
      runId: run.id,
      environment,
      keyid,
      artifacts: subjects,
      approvers: approval?.approved ? approval.approvals.map((a) => a.person) : [],
      manifest_sha256: manifest,
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
