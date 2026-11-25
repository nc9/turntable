// Onboarding, account side (lane A2): the ops a signed-in GitHub user calls before they hold an org
// session (`account` auth), and `bind_installation`, which an org owner or admin calls with their
// own GitHub token. Schemas come from ../onboarding-schemas.ts; nothing is redefined here.
//
// Every GitHub fact these ops read comes from GitHub with the SESSION USER'S token, freshly on
// every call, never from a cache and never from the request.
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { selfServeAllows } from "../../auth/self-serve";
import {
  addMember,
  appendAudit,
  countAuditEntries,
  createOrg,
  getIdentityByUserId,
  getInstallation,
  getOrgBySlug,
  getProject,
  getUserIdByGithubUserId,
  listInstallationBindings,
  listMembershipsOfUser,
} from "../../db/repos";
import { syncInstallation } from "../../github/installations";
import {
  notInstallationOwnerMessage,
  ownershipUnverifiableMessage,
  proveInstallationOwnership,
} from "../../github/ownership";
import { defineOp } from "../define";
import { OpError } from "../errors";
import {
  bindInstallationInput,
  bindInstallationOutput,
  listMyOrgsInput,
  listMyOrgsOutput,
  listUserInstallationsInput,
  listUserInstallationsOutput,
  onboardingCreateOrgInput,
  onboardingCreateOrgOutput,
} from "../onboarding-schemas";

/** Orgs one GitHub user may create in a day, and the window it is counted over. */
export const SELF_SERVE_ORGS_PER_DAY = 3;
export const SELF_SERVE_WINDOW_MS = 24 * 3_600_000;

/** The exact refusal for an installation another Turntable org holds. Never names that org. */
export const INSTALLATION_HELD_ELSEWHERE =
  "this GitHub account is already connected to a different Turntable org; ask its owner";

export const NOT_ENABLED_FOR_ACCOUNT =
  "self-serve org creation is not enabled for your account on this instance";

export const listMyOrgsOp = defineOp({
  name: "list_my_orgs",
  summary: "List the orgs the signed-in GitHub user belongs to, with their role.",
  description:
    "Returns every org where the signed-in GitHub user holds a membership, with the role the " +
    "database gives them there (never anything GitHub says). For the onboarding page, before an " +
    "org is picked. Needs a signed-in web session with no org named: no token of any kind can " +
    "call it. Not available over MCP.",
  input: listMyOrgsInput,
  output: listMyOrgsOutput,
  effect: "read",
  auth: { type: "account", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/account/orgs" },
  mcp: false,
  async handler(ctx) {
    const p = ctx.principal;
    if (p.kind !== "account") throw new OpError("forbidden", "an account session is required");
    const userId = await getUserIdByGithubUserId(ctx.db, p.githubUserId);
    const rows = userId ? await listMembershipsOfUser(ctx.db, userId) : [];
    return { orgs: rows.map((m) => ({ slug: m.slug, display_name: m.name, role: m.role })) };
  },
});

export const onboardingCreateOrgOp = defineOp({
  name: "onboarding_create_org",
  summary: "Create an org for yourself and become its owner (self-serve).",
  description:
    "Creates an org with the instance's default quotas and makes the signed-in GitHub user its " +
    "owner. Allowed only when the instance's `self_serve_orgs` setting is `any`, or is " +
    "`allowlist` and the user's GitHub login is in `self_serve_org_logins` (compared without " +
    "regard to case); otherwise forbidden. A GitHub user may create 3 orgs in 24 hours. Audited " +
    "in the new org's chain and in the system chain. Needs a signed-in web session with no org " +
    "named: no token of any kind can call it. Not available over MCP.",
  input: onboardingCreateOrgInput,
  output: onboardingCreateOrgOutput,
  effect: "write",
  auth: { type: "account", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/account/orgs" },
  mcp: false,
  async handler(ctx, i) {
    const p = ctx.principal;
    if (p.kind !== "account") throw new OpError("forbidden", "an account session is required");
    if (!(await selfServeAllows(ctx.settings, ctx.db, p.login))) {
      throw new OpError("forbidden", NOT_ENABLED_FOR_ACCOUNT);
    }
    const userId = await getUserIdByGithubUserId(ctx.db, p.githubUserId);
    if (!userId) throw new OpError("forbidden", NOT_ENABLED_FOR_ACCOUNT);
    // The rate limit counts the successful creations in the system chain (the entries this
    // dispatcher writes for this op). The handler runs inside the write transaction that takes
    // the chain's lock, so two parallel creates cannot both pass the count.
    const made = await countAuditEntries(ctx.db, ctx.scope, {
      op: "onboarding_create_org",
      principalKind: "account",
      principalId: p.githubUserId,
      since: ctx.now() - SELF_SERVE_WINDOW_MS,
    });
    if (made >= SELF_SERVE_ORGS_PER_DAY) {
      throw new OpError(
        "rate_limited",
        `at most ${SELF_SERVE_ORGS_PER_DAY} orgs can be created per GitHub user in 24 hours`,
      );
    }
    if (i.slug === SYSTEM_ORG_SLUG || (await getOrgBySlug(ctx.db, i.slug))) {
      throw new OpError("conflict", "an org with that slug already exists");
    }
    const org = await createOrg(ctx.db, { slug: i.slug, name: i.display_name });
    await addMember(ctx.db, { orgId: org.id }, { userId, role: "owner" });
    await appendAudit(
      ctx.db,
      { orgId: org.id },
      {
        principalKind: "account",
        principalId: p.githubUserId,
        op: "onboarding_create_org",
        effect: "write",
        outcome: "ok",
        input: { slug: org.slug, github_login: p.login, user_id: userId },
      },
    );
    return {
      org: { id: org.id, slug: org.slug, display_name: org.name },
      role: "owner" as const,
    };
  },
});

export const listUserInstallationsOp = defineOp({
  name: "list_user_installations",
  summary: "List the App installations the signed-in GitHub user can reach.",
  description:
    "Asks GitHub (`GET /user/installations`, with the user's own token, on every call and never " +
    "cached) which installations of this instance's App the signed-in person can reach. " +
    "`bound` says whether an installation is already connected to one of the orgs this user " +
    "belongs to (`this_org`), to an org they do not belong to (`other_org`, with no name of it) " +
    "or to nothing (`none`). Needs a signed-in web session with no org named: no token of any " +
    "kind can call it. Not available over MCP.",
  input: listUserInstallationsInput,
  output: listUserInstallationsOutput,
  effect: "read",
  auth: { type: "account", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/account/installations" },
  mcp: false,
  async handler(ctx) {
    const p = ctx.principal;
    if (p.kind !== "account") throw new OpError("forbidden", "an account session is required");
    if (!ctx.userGithub) throw new OpError("unavailable", "sign-in is not configured");
    const facts = await ctx.userGithub.listInstallations(p.sessionHash);
    const userId = await getUserIdByGithubUserId(ctx.db, p.githubUserId);
    const mine = new Set(
      (userId ? await listMembershipsOfUser(ctx.db, userId) : []).map((m) => m.orgId),
    );
    const installations = [];
    for (const f of facts) {
      const held = await getInstallation(ctx.db, f.id);
      installations.push({
        installation_id: f.id,
        account_login: f.accountLogin,
        account_type: f.accountType,
        repository_selection: f.repositorySelection,
        bound: held
          ? mine.has(held.orgId)
            ? ("this_org" as const)
            : ("other_org" as const)
          : ("none" as const),
      });
    }
    return { installations };
  },
});

export const bindInstallationOp = defineOp({
  name: "bind_installation",
  summary: "Connect a GitHub App installation you own to this org.",
  description:
    "Binds an installation to the org of the signed-in session and records it. It creates NO " +
    "project: a repository the installation can reach becomes a project only through " +
    "`add_project` (the installation's access is a permission). It reads `GET /user/installations` with the signed-in person's own GitHub token " +
    "AT THIS MOMENT (never cached): an installation they cannot reach is not found, and one " +
    "they reach without owning (an organization they are only a member of) is refused. An " +
    "installation already connected to a different Turntable org is refused, and never moved. " +
    "Returns the org's projects already bound to the installation, which keep every setting. " +
    "Audited with the installation, its GitHub account and who bound it. Needs a signed-in web session of an org owner or admin: a token is refused " +
    "(the person's own GitHub authorization is what proves ownership). Not available over MCP.",
  input: bindInstallationInput,
  output: bindInstallationOutput,
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/github/installations/bind" },
  mcp: false,
  // It calls GitHub several times: it must not hold the database's write lock meanwhile.
  outsideTransaction: true,
  auditDetail: (out) => ({
    account_login: out.account_login,
    bound_projects: out.projects.length,
  }),
  async handler(ctx, i) {
    const p = ctx.principal;
    if (p.kind !== "session") {
      throw new OpError("forbidden", "bind_installation needs a signed-in web session");
    }
    if (!ctx.userGithub || !ctx.githubFacts) {
      throw new OpError("unavailable", "installations are not configured on this instance");
    }
    const sessionHash = p.sessionHash;
    if (!sessionHash)
      throw new OpError("forbidden", "bind_installation needs a signed-in web session");
    // Fresh, from GitHub, with this person's token: the request's id proves nothing.
    const mine = await ctx.userGithub.listInstallations(sessionHash);
    const inst = mine.find((m) => m.id === i.installation_id);
    if (!inst)
      throw new OpError("not_found", "that installation was not found for your GitHub account");
    // Access is not ownership: every member of a GitHub organization sees its installation.
    const who = await getIdentityByUserId(ctx.db, p.id);
    const verdict = await proveInstallationOwnership(ctx.db, {
      installationId: i.installation_id,
      accountType: inst.accountType,
      accountId: inst.accountId,
      claimantGithubId: who?.githubUserId ?? "",
      isOrgAdmin: () => ctx.userGithub!.isOrgAdmin(sessionHash, inst.accountLogin),
    });
    if (!verdict.owns) {
      throw new OpError(
        "forbidden",
        verdict.reason === "ownership_unverifiable"
          ? ownershipUnverifiableMessage(inst.accountLogin)
          : notInstallationOwnerMessage(inst.accountLogin),
        undefined,
        { reason: verdict.reason, installation_id: i.installation_id, account: inst.accountLogin },
      );
    }
    const held = await getInstallation(ctx.db, i.installation_id);
    if (held && held.orgId !== ctx.scope.orgId) {
      throw new OpError("conflict", INSTALLATION_HELD_ELSEWHERE);
    }
    let r;
    try {
      r = await syncInstallation(ctx.db, ctx.githubFacts, i.installation_id, {
        claimedBy: ctx.scope.orgId,
      });
    } catch (e) {
      // Another org took it between the check and the sync.
      if (e instanceof Error && e.message.includes("already claimed by another org")) {
        throw new OpError("conflict", INSTALLATION_HELD_ELSEWHERE);
      }
      throw new OpError(
        "unavailable",
        e instanceof Error ? e.message : "could not bind the installation",
      );
    }
    if (r.outcome === "unknown" || r.outcome === "deleted") {
      throw new OpError("not_found", "GitHub does not know that installation");
    }
    const projects = [];
    for (const b of await listInstallationBindings(ctx.db, ctx.scope, i.installation_id)) {
      const project = await getProject(ctx.db, ctx.scope, b.projectId);
      if (!project) continue;
      projects.push({
        slug: project.slug,
        repo: `${b.owner}/${b.repo}`,
      });
    }
    return { installation_id: i.installation_id, account_login: inst.accountLogin, projects };
  },
});
