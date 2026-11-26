// Adding a repo as a project and removing one (#577). An App installation's access to a repo is a
// permission: installation sync records it and creates nothing. A repo becomes a project only
// through `add_project` (or `onboard_repos`, which calls the same code), and stops being one only
// through `remove_project`. Losing access never deletes a project: its binding goes, its history
// stays, and it reads as having no access.
import { z } from "zod";
import type { Db } from "../../db";
import {
  appendAudit,
  bindRepo,
  createProject,
  deleteProjectCascade,
  findGithubRepoBinding,
  findReattachableProject,
  getInstallation,
  forgetLostBinding,
  getProject,
  getProjectBySlug,
  listProjectBindings,
  unbindRepo,
} from "../../db/repos";
import type { GithubRepoFacts } from "../../github/api";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";
import { orgRole } from "../principal";
import { ROLE_RANK } from "../roles";
import { REPO_NAME_RE } from "../onboarding-schemas";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ORG_WIDE = "a project-scoped token cannot do this: use an org-wide credential";

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60) || "repo";

export type AddedProject = {
  slug: string;
  projectId: string;
  repo: string;
  /** False when the repo was already this org's project (nothing changed), or was re-attached. */
  created: boolean;
  reattached: boolean;
};

/**
 * Makes `repo` (which the installation was just seen to grant) a project of the org: a new project
 * with its binding, or, when the org already has one for it, that project (a project that lost
 * access and gets it back is re-attached with its history). Runs inside the caller's transaction.
 * Refuses a repo that is already another org's. Never changes the settings of an existing project.
 */
export async function addProjectFor(
  db: Db,
  orgId: string,
  installationId: string,
  repo: GithubRepoFacts,
  slug: string | undefined,
  now: number,
): Promise<AddedProject> {
  const scope = { orgId };
  const found = await findGithubRepoBinding(db, {
    forgeRepoId: repo.id,
    owner: repo.owner,
    repo: repo.name,
  });
  if (found) {
    if (found.orgId !== orgId) {
      throw new OpError("conflict", `${repo.fullName} is already connected to another project`);
    }
    const project = await getProject(db, scope, found.projectId);
    if (!project) throw new OpError("not_found", "no such project");
    if (slug !== undefined && slug !== project.slug) {
      throw new OpError("conflict", `${repo.fullName} is already the project ${project.slug}`);
    }
    return {
      slug: project.slug,
      projectId: project.id,
      repo: repo.fullName,
      created: false,
      reattached: false,
    };
  }
  const reattachId = await findReattachableProject(db, scope, repo.id);
  const reattach = reattachId === undefined ? undefined : await getProject(db, scope, reattachId);
  if (reattach && (slug === undefined || slug === reattach.slug)) {
    await bindRepo(
      db,
      { orgId, projectId: reattach.id },
      {
        forge: "github",
        owner: repo.owner,
        repo: repo.name,
        installationId,
        forgeRepoId: repo.id,
      },
    );
    return {
      slug: reattach.slug,
      projectId: reattach.id,
      repo: repo.fullName,
      created: false,
      reattached: true,
    };
  }
  const slugs =
    slug !== undefined
      ? [slug]
      : [
          slugify(repo.name),
          slugify(`${repo.owner}-${repo.name}`),
          slugify(`${repo.owner}-${repo.name}-${repo.id}`),
        ];
  for (const candidate of slugs) {
    const existing = await getProjectBySlug(db, scope, candidate);
    // A project that was removed (unbound on purpose) and is added again: the same repo name, no
    // binding now. It comes back with its history instead of a second project.
    if (
      existing &&
      existing.addedAt !== null &&
      // Key on the repo identity, never on the short name alone: another repo can share it.
      // With a recorded forge repo id it must match; legacy rows without one match the full name.
      (existing.lastForgeRepoId !== null
        ? existing.lastForgeRepoId === repo.id
        : existing.name === repo.fullName) &&
      (await listProjectBindings(db, scope, existing.id)).length === 0
    ) {
      await bindRepo(
        db,
        { orgId, projectId: existing.id },
        {
          forge: "github",
          owner: repo.owner,
          repo: repo.name,
          installationId,
          forgeRepoId: repo.id,
        },
      );
      return {
        slug: existing.slug,
        projectId: existing.id,
        repo: repo.fullName,
        created: false,
        reattached: true,
      };
    }
    if (existing) continue;
    const project = await createProject(db, scope, {
      slug: candidate,
      name: repo.name,
      addedAt: now,
    });
    await bindRepo(
      db,
      { orgId, projectId: project.id },
      {
        forge: "github",
        owner: repo.owner,
        repo: repo.name,
        installationId,
        forgeRepoId: repo.id,
      },
    );
    return {
      slug: project.slug,
      projectId: project.id,
      repo: repo.fullName,
      created: true,
      reattached: false,
    };
  }
  throw new OpError(
    "conflict",
    slug !== undefined
      ? `a project named ${slug} already exists`
      : `no free project slug for ${repo.fullName}`,
  );
}

export const addProject = defineOp({
  name: "add_project",
  summary: "Add a repository an installation can reach as a project.",
  description:
    "Turns one repository that a GitHub App installation of this org can reach into a project " +
    "and binds the repo to it. The installation's access is only a permission: nothing becomes " +
    "a project until this runs (or `onboard_repos` does). It asks GitHub, through the " +
    "installation, whether the repo is reachable and refuses one that is not. `repo` is " +
    "`owner/name`; `project` (optional) is the new project's slug, default derived from the repo " +
    "name. The project starts with every setting at its default: no ingest, no checks, so no run " +
    "starts until it is set up (see `onboard_repos`). A repo that is already this org's project " +
    "is returned unchanged with `created: false`; one that is another project's is refused. A " +
    "project that lost access and gets it back is re-attached with its history. Needs owner " +
    "or admin and an org-wide credential. Audited. The Add repositories page calls this.",
  input: z.object({
    installation_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .describe("GitHub installation id, from `list_installation_repos`' installation."),
    repo: z.string().regex(REPO_NAME_RE).describe("Repository full name, owner/name."),
  }),
  output: z.object({
    project: z.string().describe("The project's slug."),
    repo: z.string(),
    created: z.boolean().describe("False when the repo already was this org's project."),
    reattached: z.boolean().describe("True when a project that lost access was bound again."),
  }),
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  projectIsNew: true,
  http: { method: "POST", path: "/projects" },
  // GitHub is asked first and must not hold the write lock; the writes are one transaction.
  outsideTransaction: true,
  auditDetail: (o) => ({ project_slug: o.project, created: o.created }),
  async handler(ctx, i) {
    if (ctx.principal.kind === "token" && ctx.principal.projectId) {
      throw new OpError("forbidden", ORG_WIDE);
    }
    const slug = (i as { project?: string }).project;
    if (slug !== undefined && (!SLUG_RE.test(slug) || slug.length > 40)) {
      throw new OpError("invalid_input", "project must be a lowercase slug (a-z, 0-9, dashes)");
    }
    const orgId = ctx.scope.orgId;
    const granted = await reachableRepo(ctx, i.installation_id, i.repo);
    const added = await ctx.db.transaction(
      (tx) => addProjectFor(tx, orgId, i.installation_id, granted, slug, ctx.now()),
      { lock: `audit:${orgId}` },
    );
    return {
      project: added.slug,
      repo: added.repo,
      created: added.created,
      reattached: added.reattached,
    };
  },
});

/** The repo, as GitHub reports it through this org's installation; refuses anything not granted. */
export async function reachableRepo(
  ctx: OpContext,
  installationId: string,
  fullName: string,
): Promise<GithubRepoFacts> {
  const inst = await getInstallation(ctx.db, installationId);
  // The same answer for an installation that does not exist and one that is another org's.
  if (!inst || inst.orgId !== ctx.scope.orgId || inst.status === "deleted") {
    throw new OpError("not_found", "no such installation in this org");
  }
  if (!ctx.githubFacts) throw new OpError("unavailable", "this server has no GitHub App");
  let all: GithubRepoFacts[];
  try {
    all = await ctx.githubFacts.listInstallationRepos(installationId);
  } catch {
    throw new OpError("unavailable", "GitHub could not be asked for the installation's repos");
  }
  const repo = all.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
  if (!repo) {
    throw new OpError("invalid_input", `${fullName} is not reachable by this installation`);
  }
  return repo;
}

export const removeProject = defineOp({
  name: "remove_project",
  summary: "Stop using a project: unbind its repo and keep its history, or delete it.",
  description:
    "Unbinds the project's repository, so nothing is ingested or checked for it and a sync no " +
    "longer touches it. The project, its runs, logs, artifacts and settings STAY, and it can be " +
    "added again later (`add_project`, which re-attaches it). With `delete_history: true` the " +
    "project and ALL its history (runs, jobs, logs, artifacts, project-scoped tokens, secrets and " +
    "settings) are deleted for good; the audit chain keeps the entry. Deleting needs the org " +
    "owner and, from the web, a fresh passkey step-up (`session_step_up_challenge` for " +
    "`remove_project`); a token can never delete history. The project is the `project` field. " +
    "Needs owner or admin and an org-wide credential. Audited. The project settings page calls this.",
  input: z.object({
    delete_history: z
      .boolean()
      .optional()
      .describe("Also delete every run and all other history of the project. Default false."),
  }),
  output: z.object({
    project: z.string(),
    unbound: z.array(z.string()).describe("The repos that were unbound, owner/name."),
    deleted: z.boolean().describe("True when the project and its history were deleted."),
  }),
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/remove-project" },
  async handler(ctx, i) {
    const p = ctx.principal;
    if (p.kind === "token" && p.projectId) throw new OpError("forbidden", ORG_WIDE);
    const projectId = ctx.scope.projectId!;
    const scope = { orgId: ctx.scope.orgId };
    const project = await getProject(ctx.db, scope, projectId);
    if (!project) throw new OpError("not_found", "no such project");
    const bindings = await listProjectBindings(ctx.db, scope, projectId);
    const repos = bindings.map((b) => `${b.owner}/${b.repo}`);
    if (i.delete_history === true) {
      if (p.kind === "token") {
        throw new OpError("forbidden", "a token cannot delete history: use a web session");
      }
      if (ROLE_RANK[orgRole(p)] < ROLE_RANK.owner) {
        throw new OpError("forbidden", "deleting a project's history needs the org owner");
      }
      if (p.kind === "session" && ctx.stepUp?.action !== "remove_project") {
        throw new OpError(
          "forbidden",
          "deleting history needs a passkey step-up (step_up_required): call session_step_up_challenge",
          { reason: "step_up_required" },
        );
      }
      // The entry goes first and in the same transaction: the project's slug and repos are
      // recorded before they are gone.
      await appendAudit(
        ctx.db,
        { orgId: scope.orgId },
        {
          principalKind: p.kind,
          principalId: p.id,
          op: "remove_project",
          effect: "write",
          outcome: "ok",
          input: { project: project.slug, repos, delete_history: true, project_id: projectId },
        },
      );
      await deleteProjectCascade(ctx.db, scope, projectId);
      return { project: project.slug, unbound: repos, deleted: true };
    }
    for (const b of bindings) await unbindRepo(ctx.db, scope, b.id);
    // A removed project must not be re-attached by a later sync that sees the repo again; only an
    // explicit `add_project` binds it again. Clearing the unbound time keeps sync from doing it; the repo id stays as the identity.
    await forgetLostBinding(ctx.db, scope, projectId);
    return { project: project.slug, unbound: repos, deleted: false };
  },
});
