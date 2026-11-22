// Installation sync: maps a GitHub App installation to the owning org, and its repositories to
// projects, through the tenancy repos. Every fact comes from the GitHub API. The webhook payload
// contributes only an installation id to look up, so a payload that names a different
// installation, account or repository than the API reports changes nothing.
import type { Db } from "../db";
import {
  bindRepo,
  createProject,
  findGithubRepoBinding,
  getGithubApp,
  getInstallation,
  getProjectBySlug,
  listInstallationBindings,
  setInstallationStatus,
  unbindRepo,
  upsertInstallation,
} from "../db/repos";
import type { GithubFacts } from "./api";

export interface SyncOptions {
  /**
   * Multi-tenant (hosted) mode: an installation belongs to the org that claimed it, so one nobody
   * has claimed is left alone ("unclaimed") instead of being mapped to the org that owns the App.
   */
  claimMode?: boolean;
  /** The org that just claimed the installation (the claim callback); never taken from a payload. */
  claimedBy?: string;
}

export interface SyncResult {
  outcome: "synced" | "suspended" | "deleted" | "unknown" | "unclaimed";
  bound: string[];
  unbound: string[];
  /** Repos left alone because they are already bound elsewhere. */
  conflicts: string[];
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60) || "repo";

/**
 * Reconciles one installation with GitHub. Idempotent: running it twice, or for a replayed or
 * out-of-order delivery, converges on the same state. Throws when the installation belongs to a
 * different App than ours.
 */
export async function syncInstallation(
  db: Db,
  facts: GithubFacts,
  installationId: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { outcome: "synced", bound: [], unbound: [], conflicts: [] };
  const app = await getGithubApp(db);
  if (!app) throw new Error("no GitHub App is configured");
  const existing = await getInstallation(db, installationId);
  // Which org owns this installation: the one it is already mapped to, then the one that just
  // claimed it, then (single-tenant) the org that owns the App. An installation already mapped
  // somewhere is never moved by a claim, and a hosted instance never guesses.
  if (existing && opts.claimedBy !== undefined && existing.orgId !== opts.claimedBy) {
    throw new Error(`installation ${installationId} is already claimed by another org`);
  }
  const orgId = existing?.orgId ?? opts.claimedBy ?? (opts.claimMode ? undefined : app.orgId);
  if (orgId === undefined) return { ...result, outcome: "unclaimed" };
  const scope = { orgId };

  const inst = await facts.getInstallation(installationId);
  if (!inst) {
    // Gone: whatever the payload said, GitHub does not know it. Unbind what it granted.
    if (!existing) return { ...result, outcome: "unknown" };
    for (const b of await listInstallationBindings(db, scope, installationId)) {
      if (await unbindRepo(db, scope, b.id)) result.unbound.push(`${b.owner}/${b.repo}`);
    }
    await setInstallationStatus(db, scope, installationId, "deleted");
    return { ...result, outcome: "deleted" };
  }
  if (inst.appId !== app.appId) {
    throw new Error(`installation ${installationId} belongs to app ${inst.appId}, not ours`);
  }
  if (inst.id !== installationId) throw new Error("installation id mismatch in API response");

  await upsertInstallation(db, scope, {
    installationId,
    appId: app.appId,
    accountLogin: inst.account.login,
    accountId: inst.account.id,
    accountType: inst.account.type,
    repositorySelection: inst.repositorySelection,
    status: inst.suspended ? "suspended" : "active",
  });
  if (inst.suspended) return { ...result, outcome: "suspended" };

  const repos = await facts.listInstallationRepos(installationId);
  const granted = new Set(repos.map((r) => r.id));
  for (const repo of repos) {
    const found = await findGithubRepoBinding(db, {
      forgeRepoId: repo.id,
      owner: repo.owner,
      repo: repo.name,
    });
    if (found) {
      // Already bound. Ours when it is in this org and from this installation; otherwise leave
      // it alone: an installation must never take a repo another binding owns.
      const ours = found.orgId === orgId && found.installationId === installationId;
      if (!ours && !(found.orgId === orgId && found.installationId === null)) {
        result.conflicts.push(repo.fullName);
      }
      continue;
    }
    const project = await createProjectFor(
      db,
      scope,
      repo.owner,
      repo.name,
      repo.id,
      repo.fullName,
    );
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
    result.bound.push(repo.fullName);
  }
  for (const b of await listInstallationBindings(db, scope, installationId)) {
    if (b.forgeRepoId !== null && !granted.has(b.forgeRepoId)) {
      if (await unbindRepo(db, scope, b.id)) result.unbound.push(`${b.owner}/${b.repo}`);
    }
  }
  return result;
}

async function createProjectFor(
  db: Db,
  scope: { orgId: string },
  owner: string,
  name: string,
  repoId: string,
  fullName: string,
) {
  for (const slug of [
    slugify(name),
    slugify(`${owner}-${name}`),
    slugify(`${owner}-${name}-${repoId}`),
  ]) {
    if (!(await getProjectBySlug(db, scope, slug))) {
      return createProject(db, scope, { slug, name: fullName });
    }
  }
  throw new Error(`no free project slug for ${fullName}`);
}
