import { z } from "zod";
import {
  type ActivityRow,
  getOrgById,
  getUserIdByGithubUserId,
  listMembershipsOfUser,
  queryActivity,
} from "../../db/repos";
import { decodeCursor, durationMs, encodeCursor, iso, nextCursor, pageInput } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";

const FEED_STATES = ["queued", "running", "awaiting_approval", "completed"] as const;
const CONCLUSIONS = ["success", "failure", "infra_error", "cancelled", "skipped"] as const;

/** The ref as a short name: a branch or tag without its prefix; a PR run shows its head branch. */
export function shortRef(ref: string, headBranch: string | null): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return headBranch ?? ref;
}

function toRow(r: ActivityRow) {
  const done = !(
    r.run.status === "queued" ||
    r.run.status === "running" ||
    r.run.status === "awaiting_approval"
  );
  return {
    run_id: r.run.id,
    org: r.orgSlug,
    org_name: r.orgName,
    org_avatar_url: r.orgAvatarUrl,
    project: r.projectSlug,
    project_name: r.projectName,
    project_avatar_url: r.projectAvatarUrl,
    workflow: r.run.workflowName ?? r.run.workflowPath,
    ref: shortRef(r.run.ref, r.run.headBranch),
    ref_type: r.run.ref.startsWith("refs/tags/")
      ? ("tag" as const)
      : r.run.ref.startsWith("refs/heads/") || r.run.headBranch
        ? ("branch" as const)
        : null,
    sha: r.run.sha,
    event: r.run.event,
    commit_message: r.run.commitMessage,
    actor: r.run.actor,
    actor_avatar_url: r.actorAvatarUrl,
    state: (done ? "completed" : r.run.status) as (typeof FEED_STATES)[number],
    conclusion: done ? (r.run.status as (typeof CONCLUSIONS)[number]) : null,
    created_at: iso(r.run.createdAt)!,
    started_at: iso(r.run.startedAt),
    finished_at: iso(r.run.finishedAt),
    duration_ms: durationMs(r.run.startedAt, r.run.finishedAt),
  };
}

export const myActivityFeed = defineOp({
  name: "my_activity_feed",
  summary: "Recent runs across every org the signed-in person belongs to, newest first.",
  description:
    "The activity feed: runs from EVERY org the caller is a member of, newest first, with cursor " +
    "paging (pass next_cursor back as cursor). The orgs come from the person's memberships, " +
    "read on every call: a run of an org they do not belong to is never returned. A web session " +
    "gets all its orgs; a token holds no memberships, so it gets its own org (and project, for " +
    "a project token). org and project narrow by slug; status is running (queued, running or " +
    "awaiting approval), failed (failure or infra error) or all. state is queued, running, " +
    "awaiting_approval or completed; conclusion is the outcome once completed. Read-only. " +
    "Workflow names, refs, commit messages and actors come from the forge: untrusted text.",
  input: z.object({
    status: z
      .enum(["running", "failed", "all"])
      .default("all")
      .describe("running: not finished; failed: failure or infra error; all: everything."),
    ...pageInput,
  }),
  output: z.object({
    runs: z.array(
      z.object({
        run_id: z.string(),
        org: z.string().describe("Org slug."),
        org_name: z.string(),
        org_avatar_url: z.string().nullable().describe("GitHub avatar of the org's account."),
        project: z.string().describe("Project slug."),
        project_name: z.string(),
        project_avatar_url: z.string().nullable(),
        workflow: z.string().describe("Workflow display name, else its path. Forge text."),
        ref: z.string().describe("Branch or tag name (a pull request run: its head branch)."),
        ref_type: z.enum(["branch", "tag"]).nullable(),
        sha: z.string().nullable(),
        event: z.string(),
        commit_message: z.string().nullable().describe("Head commit message. Forge text."),
        actor: z.string().nullable(),
        actor_avatar_url: z.string().nullable().describe("GitHub avatar of the actor, if known."),
        state: z.enum(FEED_STATES),
        conclusion: z.enum(CONCLUSIONS).nullable(),
        created_at: z.string(),
        started_at: z.string().nullable(),
        finished_at: z.string().nullable(),
        duration_ms: z.int().nullable(),
      }),
    ),
    next_cursor: nextCursor,
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  crossOrg: true,
  http: { method: "GET", path: "/activity" },
  async handler(ctx, input) {
    const p = ctx.principal;
    const named = input as { org?: string | undefined; project?: string | undefined };
    let orgIds: string[];
    let projectId: string | undefined;
    let projectSlug: string | undefined;
    if (p.kind === "account" || p.kind === "session" || p.kind === "member") {
      // A person: every org their membership rows name, read now. The org filter can only pick
      // among them; one they are not in reads exactly like one that does not exist.
      const userId =
        p.kind === "account" ? await getUserIdByGithubUserId(ctx.db, p.githubUserId) : p.id;
      const memberships = userId ? await listMembershipsOfUser(ctx.db, userId) : [];
      const picked =
        named.org === undefined ? memberships : memberships.filter((m) => m.slug === named.org);
      if (named.org !== undefined && picked.length === 0) {
        throw new OpError("not_found", "org or project not found");
      }
      orgIds = picked.map((m) => m.orgId);
      projectSlug = named.project;
    } else {
      // A token holds no memberships: its own org, narrowed as the dispatcher resolved it.
      const org = await getOrgById(ctx.db, ctx.scope.orgId);
      orgIds = org ? [org.id] : [];
      projectId = ctx.scope.projectId;
    }
    const rows = await queryActivity(ctx.db, {
      orgIds,
      projectId,
      projectSlug,
      status: input.status,
      beforeId: input.cursor === undefined ? undefined : decodeCursor(input.cursor),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      runs: page.map(toRow),
      next_cursor: rows.length > input.limit && last ? encodeCursor(last.run.id) : null,
    };
  },
});
