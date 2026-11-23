// Installation sync: maps a GitHub App installation to the owning org, and its repositories to
// projects, through the tenancy repos. Every fact comes from the GitHub API. The webhook payload
// contributes only an installation id to look up, so a payload that names a different
// installation, account or repository than the API reports changes nothing.
import type { Db } from "../db";
import {
  adoptRepoBinding,
  appendAudit,
  bindRepo,
  createProject,
  findGithubRepoBinding,
  findReattachableProject,
  getGithubApp,
  getInstallation,
  getProjectBySlug,
  listInstallationsWithPolledBindings,
  listInstallationBindings,
  type RepoBinding,
  setInstallationStatus,
  UNBIND_AUDIT_OP,
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
  /** Polled repos (a binding with no installation) now served by this installation. */
  adopted: string[];
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
  const result: SyncResult = {
    outcome: "synced",
    bound: [],
    adopted: [],
    unbound: [],
    conflicts: [],
  };
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
      if (await unbindAndRecord(db, scope, installationId, b)) {
        result.unbound.push(`${b.owner}/${b.repo}`);
      }
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
      // Already bound. Ours when it is in this org and from this installation. A binding in this
      // org with no installation is a polled repo: adopt it (it keeps its project) when its
      // forge repo id is unset or matches, so checks can be posted for it. Anything else is
      // another owner's: an installation must never take it.
      if (found.orgId === orgId && found.installationId === installationId) continue;
      if (found.orgId === orgId && found.installationId === null) {
        const adopted =
          (found.forgeRepoId === null || found.forgeRepoId === repo.id) &&
          (await adoptRepoBinding(db, scope, found.id, {
            installationId,
            forgeRepoId: repo.id,
          }));
        if (adopted) {
          await appendAudit(db, scope, {
            principalKind: "system",
            principalId: "github-installation",
            op: "adopt_repo_binding",
            effect: "write",
            outcome: "ok",
            input: { repo: repo.fullName, installationId, projectId: found.projectId },
          });
          result.adopted.push(repo.fullName);
          continue;
        }
      }
      result.conflicts.push(repo.fullName);
      continue;
    }
    // A re-grant: this org's project that last held this forge repo id and has no binding now.
    const reattachId = await findReattachableProject(db, scope, repo.id);
    const project =
      reattachId !== undefined
        ? { id: reattachId }
        : await createProjectFor(db, scope, repo.owner, repo.name, repo.id, repo.fullName);
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
    if (reattachId !== undefined) {
      await appendAudit(db, scope, {
        principalKind: "system",
        principalId: "github-installation",
        op: "reattach_repo_binding",
        effect: "write",
        outcome: "ok",
        input: { repo: repo.fullName, installationId, projectId: reattachId, forgeRepoId: repo.id },
      });
    }
    result.bound.push(repo.fullName);
  }
  for (const b of await listInstallationBindings(db, scope, installationId)) {
    if (b.forgeRepoId !== null && !granted.has(b.forgeRepoId)) {
      if (await unbindAndRecord(db, scope, installationId, b)) {
        result.unbound.push(`${b.owner}/${b.repo}`);
      }
    }
  }
  return result;
}

/**
 * Unbinds a repo the installation no longer grants and records it in the org's audit chain, with
 * the project and forge repo id, so a later re-grant can find the project again.
 */
async function unbindAndRecord(
  db: Db,
  scope: { orgId: string },
  installationId: string,
  b: RepoBinding,
): Promise<boolean> {
  if (!(await unbindRepo(db, scope, b.id))) return false;
  await appendAudit(
    db,
    { orgId: scope.orgId, projectId: b.projectId },
    {
      principalKind: "system",
      principalId: "github-installation",
      op: UNBIND_AUDIT_OP,
      effect: "write",
      outcome: "ok",
      input: {
        repo: `${b.owner}/${b.repo}`,
        installationId,
        projectId: b.projectId,
        forgeRepoId: b.forgeRepoId,
      },
    },
  );
  return true;
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

/**
 * Boot sweep for installations synced before polled bindings were adopted: re-runs the sync for
 * each active installation whose org still has a binding with no installation. Idempotent, and
 * makes no GitHub call when no org has one. A failure for one installation is logged and audited
 * and never stops the others. Run it after the server is listening: it must not hold up startup.
 */
export async function adoptPolledBindings(
  db: Db,
  facts: GithubFacts,
  log: (message: string) => void = () => {},
): Promise<{ adopted: string[]; failed: string[] }> {
  const out = { adopted: [] as string[], failed: [] as string[] };
  for (const inst of await listInstallationsWithPolledBindings(db)) {
    try {
      const r = await syncInstallation(db, facts, inst.installationId);
      out.adopted.push(...r.adopted);
      if (r.adopted.length > 0) {
        log(`adopted ${r.adopted.length} polled repo(s) into installation ${inst.installationId}`);
      }
    } catch (err) {
      out.failed.push(inst.installationId);
      // Short: the message can carry GitHub's text, never a credential, but keep it bounded.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      log(`adopt sweep failed for installation ${inst.installationId}: ${message}`);
      await appendAudit(
        db,
        { orgId: inst.orgId },
        {
          principalKind: "system",
          principalId: "github-installation",
          op: "adopt_sweep",
          effect: "write",
          outcome: "error:sync_failed",
          input: { installationId: inst.installationId, message },
        },
      ).catch(() => {});
    }
  }
  return out;
}
