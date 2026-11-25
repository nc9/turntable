// The cross-org activity feed (`my_activity_feed`). Unlike every other read, it spans several
// orgs, so it takes a LIST of org ids that the caller resolved from the person's memberships and
// enforces it here: no org id outside the list can ever reach the WHERE. Part of the only code
// allowed to name tenant tables.
import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";

export type ActivityStatus = "running" | "failed" | "all";

/** Run states that count as in progress for the `running` filter. */
export const RUNNING_STATES = ["queued", "running", "awaiting_approval"] as const;
export const FAILED_STATES = ["failure", "infra_error"] as const;

export type ActivityRow = {
  run: typeof s.runs.$inferSelect;
  orgSlug: string;
  orgName: string;
  projectSlug: string;
  projectName: string;
  /** The org's GitHub installation account avatar, when one is bound. */
  orgAvatarUrl: string | null;
  /** The repo owner's avatar, when that owner is the org's installation account. */
  projectAvatarUrl: string | null;
  actorAvatarUrl: string | null;
};

export type ActivityQuery = {
  /** The orgs the caller may see. Empty means no rows. Never taken from request input. */
  orgIds: readonly string[];
  /** Narrow to one project of those orgs, by id (a project-scoped token) ... */
  projectId?: string | undefined;
  /** ... or by slug (the same slug may exist in several orgs). */
  projectSlug?: string | undefined;
  status: ActivityStatus;
  beforeId?: string | undefined;
  /** Rows to fetch (the caller asks for one extra to detect a next page). */
  limit: number;
};

const norm = (v: string): string => v.toLowerCase();

export function queryActivity(db: Db, q: ActivityQuery): Promise<ActivityRow[]> {
  if (q.orgIds.length === 0) return Promise.resolve([]);
  return db.run(async (h) => {
    const where: (SQL | undefined)[] = [
      inArray(s.runs.orgId, [...q.orgIds]),
      q.projectId === undefined ? undefined : eq(s.runs.projectId, q.projectId),
      q.projectSlug === undefined ? undefined : eq(s.projects.slug, q.projectSlug),
      q.status === "running"
        ? inArray(s.runs.status, [...RUNNING_STATES])
        : q.status === "failed"
          ? inArray(s.runs.status, [...FAILED_STATES])
          : undefined,
      q.beforeId === undefined ? undefined : lt(s.runs.id, q.beforeId),
    ];
    const rows = await h.orm
      .select({
        run: s.runs,
        orgSlug: s.orgs.slug,
        orgName: s.orgs.name,
        projectSlug: s.projects.slug,
        projectName: s.projects.name,
      })
      .from(s.runs)
      .innerJoin(
        s.projects,
        and(eq(s.projects.id, s.runs.projectId), eq(s.projects.orgId, s.runs.orgId)),
      )
      .innerJoin(s.orgs, eq(s.orgs.id, s.runs.orgId))
      .where(and(...where))
      .orderBy(desc(s.runs.id))
      .limit(q.limit);
    if (rows.length === 0) return [];

    // Avatars: installation accounts of the orgs on the page (the org icon, and the project icon
    // when a project's repo owner is that account), and the identities of signed-in members of
    // those orgs (the actor icon). Public GitHub data, but still held to the visible orgs.
    const orgIds = [...new Set(rows.map((r) => r.run.orgId))];
    const installs = await h.orm
      .select({
        orgId: s.githubInstallations.orgId,
        login: s.githubInstallations.accountLogin,
        avatarUrl: s.githubInstallations.avatarUrl,
      })
      .from(s.githubInstallations)
      .where(
        and(
          inArray(s.githubInstallations.orgId, orgIds),
          eq(s.githubInstallations.status, "active"),
        ),
      );
    const orgAvatar = new Map<string, string>();
    const accountAvatar = new Map<string, string>();
    for (const i of installs) {
      if (!i.avatarUrl) continue;
      if (!orgAvatar.has(i.orgId)) orgAvatar.set(i.orgId, i.avatarUrl);
      accountAvatar.set(`${i.orgId}:${norm(i.login)}`, i.avatarUrl);
    }
    const projectIds = [...new Set(rows.map((r) => r.run.projectId))];
    const repos = await h.orm
      .select({
        orgId: s.projectRepos.orgId,
        projectId: s.projectRepos.projectId,
        owner: s.projectRepos.owner,
      })
      .from(s.projectRepos)
      .where(
        and(inArray(s.projectRepos.orgId, orgIds), inArray(s.projectRepos.projectId, projectIds)),
      );
    const projectAvatar = new Map<string, string>();
    for (const r of repos) {
      const url = accountAvatar.get(`${r.orgId}:${norm(r.owner)}`);
      if (url && !projectAvatar.has(r.projectId)) projectAvatar.set(r.projectId, url);
    }
    const actors = [...new Set(rows.map((r) => r.run.actor).filter((a): a is string => !!a))];
    const actorAvatar = new Map<string, string>();
    if (actors.length > 0) {
      const people = await h.orm
        .select({ login: s.githubIdentities.login, avatarUrl: s.githubIdentities.avatarUrl })
        .from(s.githubIdentities)
        .innerJoin(s.orgMembers, eq(s.orgMembers.userId, s.githubIdentities.userId))
        .where(
          and(
            inArray(s.orgMembers.orgId, orgIds),
            or(...actors.map((a) => eq(s.githubIdentities.login, a))),
          ),
        );
      for (const p of people) if (p.avatarUrl) actorAvatar.set(norm(p.login), p.avatarUrl);
    }
    return rows.map((r) => ({
      ...r,
      orgAvatarUrl: orgAvatar.get(r.run.orgId) ?? null,
      projectAvatarUrl: projectAvatar.get(r.run.projectId) ?? null,
      actorAvatarUrl: r.run.actor
        ? (actorAvatar.get(norm(r.run.actor)) ??
          accountAvatar.get(`${r.run.orgId}:${norm(r.run.actor)}`) ??
          null)
        : null,
    }));
  });
}
