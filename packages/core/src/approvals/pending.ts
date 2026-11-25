// What waits on ONE person (#545). Read-only: it decides nothing about who may approve. Every
// check here is the one the approving code runs (key identity and counting, the key policy with
// the environment's tightening, the author rule, the enrolment self-approval rule, the quorum
// already met), called from the same modules; this file only asks them per person, per item.
//
// Output carries ids, slugs, environment names and times only. Nothing here selects a title, a
// branch, a workflow name, a job name or a tag message, so none can reach a notification.
import {
  type Approver,
  effectiveKeyPolicy,
  getApproveRunMinRole,
  getEnvPolicy,
  getIdentityByUserId,
  getKeyPolicy,
  getOrgById,
  getProjectSigning,
  getRun,
  listApprovers,
  listAwaitingJobs,
  listEnrolmentRecords,
  listEnvironmentRecords,
  listLivePolicyRecords,
  listPendingEnrolments,
  listRunArtifacts,
  parseTrust,
  plannedEnvironment,
  projectSlugs,
  recordIdentities,
} from "../db/repos";
import type { Db } from "../db";
import type { MemberRole } from "../db/schema";
import { roleSatisfies } from "../ops/roles";
import { effectiveApproval } from "../ops/setting-guard";
import type { SettingsRuntime } from "../settings/resolve";
import { manifestSha256 } from "../release/manifest";
import {
  authorBlocked,
  enrolmentQuorum,
  liveEnvironmentRecords,
  policyQuorum,
  requiredApprovals,
} from "./apply";
import { approverIdentity } from "./identity";
import { type KeyPolicy, keyPolicyViolation, samePolicy } from "./key-policy";
import { type PolicyStatement, policyStatementSchema } from "./statement";

export const PENDING_KINDS = [
  "release_approval",
  "environment_approval",
  "untrusted_run_approval",
  "enrolment_approval",
  "key_policy_approval",
] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

export type PendingItem = {
  id: string;
  kind: PendingKind;
  org: string;
  project: string;
  environment?: string;
  created_at: string;
  expires_at?: number;
  link: string;
};

const iso = (ms: number): string => new Date(ms).toISOString();
const seg = (s: string): string => encodeURIComponent(s);

/** The UI routes of the approval screens (packages/ui/src/router.tsx). */
export const approvalLink = {
  environment: (org: string, project: string, runId: string, environment: string): string =>
    `/${seg(org)}/${seg(project)}/runs/${seg(runId)}/approve?environment=${seg(environment)}`,
  run: (org: string, project: string, runId: string): string =>
    `/${seg(org)}/${seg(project)}/runs/${seg(runId)}`,
  approvers: (org: string): string => `/${seg(org)}/-/approvers`,
};

/** The caller's keys in one org: live, bound to their numeric GitHub id, and counting. */
function ownKeys(keys: readonly Approver[], githubUserId: string): Approver[] {
  return keys.filter(
    (k) =>
      k.githubUserId !== null && k.githubUserId === githubUserId && approverIdentity(k) !== null,
  );
}

/**
 * The items waiting on the person `userId`, across every org they are a member of. A person with
 * no GitHub identity, or with no live key bound to their numeric id in an org, has nothing there.
 */
export async function myPendingApprovals(
  db: Db,
  o: {
    userId: string;
    memberships: readonly { orgId: string; role: MemberRole }[];
    now: number;
    settings?: SettingsRuntime | undefined;
  },
): Promise<PendingItem[]> {
  const identity = await getIdentityByUserId(db, o.userId);
  if (!identity) return [];
  const out: PendingItem[] = [];
  for (const m of o.memberships) {
    out.push(...(await orgItems(db, m, identity.githubUserId, o.now, o.settings)));
  }
  return out.toSorted(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

async function orgItems(
  db: Db,
  m: { orgId: string; role: MemberRole },
  githubUserId: string,
  now: number,
  settings: SettingsRuntime | undefined,
): Promise<PendingItem[]> {
  const org = await getOrgById(db, m.orgId);
  if (!org) return [];
  const mine = ownKeys(await listApprovers(db, m.orgId), githubUserId);
  if (mine.length === 0) return [];
  const orgPolicy = await getKeyPolicy(db, m.orgId);
  const scope = { orgId: m.orgId };
  const items: PendingItem[] = [];
  const jobs = await listAwaitingJobs(db, m.orgId);
  const slugOf = await projectSlugs(db, m.orgId, [...new Set(jobs.map((j) => j.projectId))]);

  // ---- environment and release approvals, and runs held for an untrusted author ----
  const seen = new Set<string>();
  for (const job of jobs) {
    const project = slugOf.get(job.projectId);
    if (!project) continue;
    if (job.approvalKind === "environment") {
      const environment = plannedEnvironment(job.planned);
      if (environment === undefined) continue;
      const id = `${job.runId}:${environment}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const run = await getRun(db, scope, job.runId);
      if (!run || run.sha === null) continue;
      const trust = parseTrust(run);
      if (!trust) continue;
      const projectScope = { orgId: m.orgId, projectId: job.projectId };
      const release = (await getProjectSigning(db, projectScope)).environment === environment;
      const policy = await getEnvPolicy(db, m.orgId, environment);
      const keyPolicy = effectiveKeyPolicy(orgPolicy, policy);
      const eligible = mine.filter(
        (k) =>
          keyPolicyViolation(keyPolicy, k) === null &&
          authorBlocked(policy, k.forgeLogin, run) === null,
      );
      if (eligible.length === 0) continue;
      let manifest: string | undefined;
      if (release) {
        // A release is approved over the digest of its recorded release-class artifacts; with
        // none recorded the challenge is refused, so there is nothing to act on yet.
        const files = (await listRunArtifacts(db, projectScope, run.id))
          .filter((a) => a.klass === "release")
          .map((a) => ({ name: a.name, sha256: a.sha256, size: a.size }));
        if (files.length === 0) continue;
        try {
          manifest = manifestSha256(files);
        } catch {
          continue;
        }
      }
      const live = liveEnvironmentRecords(
        await listEnvironmentRecords(db, m.orgId, run.id, environment),
        {
          runId: run.id,
          headSha: run.sha,
          workflowHash: trust.workflowHash,
          environment,
          ...(manifest !== undefined ? { manifest } : {}),
        },
        now,
      );
      const people = await recordIdentities(db, m.orgId, live, keyPolicy);
      // Enough people already approved: nothing is left to act on.
      if (people.size >= requiredApprovals(policy, run)) continue;
      // Everyone this person signs as has already approved.
      if (eligible.every((k) => people.has(approverIdentity(k) as string))) continue;
      items.push({
        id,
        kind: release ? "release_approval" : "environment_approval",
        org: org.slug,
        project,
        environment,
        created_at: iso(job.createdAt),
        link: approvalLink.environment(org.slug, project, run.id, environment),
      });
    } else if (job.approvalKind === "untrusted_author") {
      const id = job.runId;
      if (seen.has(`run:${id}`)) continue;
      seen.add(`run:${id}`);
      // Only the `human` policy makes an enrolled approver's signature the way in.
      if ((await effectiveApproval(settings, db, m.orgId, job.projectId)) !== "human") continue;
      const run = await getRun(db, scope, id);
      if (!run || run.sha === null || !parseTrust(run)) continue;
      let needed = await getApproveRunMinRole(db, m.orgId);
      if (run.ref.startsWith("refs/tags/") && parseTrust(run)?.class === "release")
        needed = "release_operator";
      if (!roleSatisfies(m.role, needed)) continue;
      if (!mine.some((k) => keyPolicyViolation(orgPolicy, k) === null)) continue;
      items.push({
        id,
        kind: "untrusted_run_approval",
        org: org.slug,
        project,
        created_at: iso(run.createdAt),
        link: approvalLink.run(org.slug, project, run.id),
      });
    }
  }

  // ---- enrolments ----
  for (const e of await listPendingEnrolments(db, m.orgId, now)) {
    const enrolee = approverIdentity(e);
    const signers = mine.filter(
      (k) =>
        keyPolicyViolation(orgPolicy, k) === null &&
        approverIdentity(k) !== enrolee &&
        k.person.trim().toLowerCase() !== e.person.trim().toLowerCase(),
    );
    if (signers.length === 0) continue;
    const recs = (await listEnrolmentRecords(db, m.orgId, e.id)).filter((r) => r.expiresAt > now);
    const people = await recordIdentities(db, m.orgId, recs, orgPolicy);
    if (people.size >= (await enrolmentQuorum(db, m.orgId, enrolee))) continue;
    if (signers.every((k) => people.has(approverIdentity(k) as string))) continue;
    items.push({
      id: e.id,
      kind: "enrolment_approval",
      org: org.slug,
      project: "-",
      created_at: iso(e.createdAt),
      expires_at: e.expiresAt,
      link: approvalLink.approvers(org.slug),
    });
  }

  // ---- key policy changes: proposals with live signatures that have not yet reached quorum ----
  const byDigest = new Map<string, Awaited<ReturnType<typeof listLivePolicyRecords>>>();
  for (const r of await listLivePolicyRecords(db, m.orgId, now)) {
    if (r.enrolmentId === null) continue;
    byDigest.set(r.enrolmentId, [...(byDigest.get(r.enrolmentId) ?? []), r]);
  }
  for (const [digest, recs] of byDigest) {
    let statement: PolicyStatement;
    try {
      statement = policyStatementSchema.parse(JSON.parse(recs[0]!.statement));
    } catch {
      continue;
    }
    // A proposal made against an older policy can no longer apply.
    if (
      (orgPolicy.generation ?? 0) !== statement.generation ||
      !samePolicy(orgPolicy, statement.old)
    )
      continue;
    const signers = mine.filter((k) => keyPolicyViolation(orgPolicy, k) === null);
    if (signers.length === 0) continue;
    const people = await recordIdentities(db, m.orgId, recs, orgPolicy as KeyPolicy);
    if (people.size >= (await policyQuorum(db, m.orgId))) continue;
    if (signers.every((k) => people.has(approverIdentity(k) as string))) continue;
    items.push({
      id: digest,
      kind: "key_policy_approval",
      org: org.slug,
      project: "-",
      created_at: iso(Math.min(...recs.map((r) => r.createdAt))),
      expires_at: Math.max(...recs.map((r) => r.expiresAt)),
      link: approvalLink.approvers(org.slug),
    });
  }
  return items;
}
