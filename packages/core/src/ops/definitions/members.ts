// Org membership by invite (#430). A person signs in with GitHub (auth/github-login.ts); what they
// may do comes only from a membership row here, never from GitHub org membership or repo access.
// Two ways to create the first grant, neither automatic:
//   - `invite_member`: an admin member or a person's own release_operator token invites a login;
//   - `instance_bind_github_login`: the instance administrator does it for an org, which is the
//     only root of an admin or owner on a new org (REST and `tti_` only, audited in both chains).
// Either way the invitee's first sign-in with that login binds their numeric GitHub id, consumes
// the invite and emits `org.member_joined`.
import { z } from "zod";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import {
  appendAudit,
  appendEvent,
  createMemberInvite,
  findMemberByGithubUserId,
  getOrgBySlug,
} from "../../db/repos";
import { MEMBER_ROLES, type MemberRole } from "../../db/schema";
import { iso } from "../common";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";
import { ROLE_RANK } from "../roles";

/** How long an invite stays open. */
export const INVITE_TTL_MS = 7 * 86_400_000;

const login = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}$/)
  .describe("The GitHub login to invite. Matched case-insensitively at sign-in.");

const inviteOutput = z.object({
  invite_id: z.string(),
  github_login: z.string(),
  role: z.enum(MEMBER_ROLES),
  expires_at: z.string().nullable(),
});

export const inviteMemberOp = defineOp({
  name: "invite_member",
  summary: "Invite a GitHub login to this org.",
  description:
    "Creates a pending invite for a GitHub login, with an org role (viewer, member, admin or " +
    "owner). The invitee's first sign-in with GitHub binds their numeric GitHub id, consumes the " +
    "invite and makes them a member; nothing else grants membership (not GitHub org membership, " +
    "not repo access). The invite expires in 7 days, and a newer invite for the same login " +
    "replaces the older one. Who may call it: a person's own token with release_operator or " +
    "above (it may invite viewer or member only), or a signed-in admin or owner (up to their own " +
    "role; only an owner invites an owner). An agent token is refused. Audited, and the org's " +
    "feed gets an `org.member_invited` event. Not an MCP tool.",
  input: z.object({ github_login: login, role: z.enum(MEMBER_ROLES) }),
  output: inviteOutput,
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/members/invites" },
  mcp: false,
  async handler(ctx, i) {
    if (ctx.scope.projectId || (ctx.principal.kind === "token" && ctx.principal.projectId)) {
      throw new OpError("forbidden", "an org-level credential is required");
    }
    const p = ctx.principal;
    if (p.kind === "token") {
      if (p.tokenKind !== "person") {
        throw new OpError("forbidden", "an agent token cannot invite members");
      }
      if (ROLE_RANK[i.role] > ROLE_RANK.member) {
        throw new OpError("forbidden", "a token can invite a viewer or member only");
      }
    } else if (p.kind === "member") {
      // Until passkey step-up exists, a stolen session must never mint a persistent admin or owner.
      if (p.session && i.role !== "viewer" && i.role !== "member") {
        throw new OpError("forbidden", "needs passkey step-up or the instance operator");
      }
      if (ROLE_RANK[i.role] > ROLE_RANK[p.role]) {
        throw new OpError("forbidden", "you cannot invite a role above your own");
      }
    } else {
      throw new OpError("forbidden", "not available to this principal");
    }
    return await invite(ctx, i.github_login, i.role, `${p.kind}:${p.id}`, "invite", undefined);
  },
});

async function invite(
  ctx: Pick<OpContext, "db" | "scope" | "now" | "githubUsers">,
  githubLogin: string,
  role: MemberRole,
  by: string,
  via: "invite" | "instance",
  reason: string | undefined,
) {
  const loginLc = githubLogin.toLowerCase();
  // The login is resolved to the numeric account NOW and the invite binds that id: a login that is
  // later renamed or recycled to someone else cannot use it. Any failure refuses the invite.
  if (!ctx.githubUsers) {
    throw new OpError("unavailable", "inviting needs a configured GitHub App to resolve the login");
  }
  let githubUserId: string | undefined;
  try {
    githubUserId = await ctx.githubUsers.idOfLogin(loginLc);
  } catch {
    throw new OpError("unavailable", "could not ask GitHub who that login is; try again");
  }
  if (!githubUserId) throw new OpError("not_found", "GitHub has no user with that login");
  if (await findMemberByGithubUserId(ctx.db, ctx.scope, githubUserId)) {
    throw new OpError("conflict", "that GitHub login is already a member of this org");
  }
  const now = ctx.now();
  const row = await createMemberInvite(ctx.db, ctx.scope, {
    githubLogin: loginLc,
    githubUserId,
    role,
    createdBy: by,
    reason,
    now,
    expiresAt: now + INVITE_TTL_MS,
  });
  await appendEvent(ctx.db, ctx.scope, {
    type: "org.member_invited",
    payload: {
      github_login: loginLc,
      github_user_id: githubUserId,
      role,
      by,
      via,
      invite_id: row.id,
    },
  });
  return {
    invite_id: row.id,
    github_login: loginLc,
    role,
    expires_at: iso(row.expiresAt),
  };
}

export const instanceBindGithubLoginOp = defineOp({
  name: "instance_bind_github_login",
  summary: "Grant an org role to a GitHub login (instance administrator only).",
  description:
    "Creates a pending grant of `role` in the org `target_org` for the GitHub login " +
    "`github_login`, for an org that has no admin who can invite (a new org's first owner). It is " +
    "the same single-use invite `invite_member` makes: the person's first sign-in with GitHub " +
    "binds their numeric id and makes them a member. It expires in 7 days. `reason` is required " +
    "and kept in the audit. Audited in the system org's chain and in the target org's own, and " +
    "the org's feed gets `org.member_invited`. The system org is never a target. Only the " +
    "instance administrator can call it, over REST: an org's own tokens never can. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org that gains the member."),
    github_login: login,
    role: z.enum(MEMBER_ROLES),
    reason: z.string().min(1).max(500).describe("Why the operator grants it. Kept in the audit."),
  }),
  output: inviteOutput,
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/member-bindings" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    const target = { orgId: org.id };
    const out = await invite(
      { db: ctx.db, scope: target, now: ctx.now, githubUsers: ctx.githubUsers },
      i.github_login,
      i.role,
      `instance:${ctx.principal.id}`,
      "instance",
      i.reason,
    );
    // The system chain gets the dispatcher's entry; the org's own chain says it too.
    await appendAudit(ctx.db, target, {
      principalKind: "instance",
      principalId: ctx.principal.id,
      op: "instance_bind_github_login",
      effect: "write",
      outcome: "ok",
      input: {
        target_org: org.slug,
        github_login: out.github_login,
        role: i.role,
        invite_id: out.invite_id,
        reason: i.reason,
      },
    });
    return out;
  },
});
