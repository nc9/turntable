import { z } from "zod";
import {
  ackNotifications,
  getProjectBySlug,
  projectSlugs,
  countUnreadNotifications,
  getUserIdByGithubUserId,
  listMembershipsOfUser,
  listNotificationPrefs,
  listNotifications,
  putNotificationPref,
  type NotificationView,
} from "../../db/repos";
import { NOTIFICATION_KINDS } from "../../db/schema";
import { KIND_DEFAULTS, OPERATOR_ONLY_KINDS } from "../../notifications/rules";
import { decodeCursor, encodeCursor, iso, nextCursor, pageInput } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";
import type { OpContext } from "../define";

const kind = z.enum(NOTIFICATION_KINDS);
const seg = (s: string): string => encodeURIComponent(s);

function link(n: NotificationView): string {
  if (n.projectSlug && n.runId)
    return `/${seg(n.orgSlug)}/${seg(n.projectSlug)}/runs/${seg(n.runId)}`;
  if (n.projectSlug) return `/${seg(n.orgSlug)}/${seg(n.projectSlug)}`;
  return `/${seg(n.orgSlug)}`;
}

/** The person behind the call, or a refusal: notifications are personal, so an agent token has none. */
async function personOf(ctx: OpContext, name: string): Promise<string> {
  const p = ctx.principal;
  if (p.kind === "session" || p.kind === "member") return p.id;
  if (p.kind === "account") {
    const id = await getUserIdByGithubUserId(ctx.db, p.githubUserId);
    if (id) return id;
    throw new OpError("forbidden", `${name} needs a signed-in person`);
  }
  throw new OpError(
    "forbidden",
    `${name} is a person's inbox: it needs a signed-in person, not an org token`,
  );
}

const notificationOut = z.object({
  id: z.string(),
  kind,
  org: z.string().describe("Org slug."),
  project: z.string().nullable().describe("Project slug, when the subject has one."),
  run_id: z.string().nullable(),
  count: z.int().describe("How many events were coalesced into this one (infra_errors)."),
  title: z.string().describe("Escaped, truncated forge text (commit subject). Untrusted."),
  created_at: z.string(),
  read_at: z.string().nullable(),
  link: z.string().describe("The UI route of the subject."),
});

export const myNotificationsOp = defineOp({
  name: "my_notifications",
  summary: "The signed-in person's notifications across every org they belong to, newest first.",
  description:
    "Failure and infra notifications for one person: run_failed, infra_errors (coalesced per " +
    "project per 30 minutes, `count` says how many), work_held, approval_waiting, " +
    "checkout_auth_failed. Orgs come from the person's memberships read on every call, so a " +
    "notification of an org they left is not returned. Cursor paging (pass next_cursor back as " +
    "cursor); `unread` narrows to unread, `kinds` to those kinds; `unread_count` is the total " +
    "unread. A person only: an org token has no inbox and is refused. Read-only. `title` is " +
    "escaped and truncated forge text: untrusted.",
  input: z.object({
    kinds: z.array(kind).max(10).optional().describe("Only these kinds."),
    unread: z.boolean().default(false).describe("Only unread notifications."),
    ...pageInput,
  }),
  output: z.object({
    notifications: z.array(notificationOut),
    unread_count: z.int(),
    next_cursor: nextCursor,
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  crossOrg: true,
  http: { method: "GET", path: "/my/notifications" },
  async handler(ctx, input) {
    const userId = await personOf(ctx, "my_notifications");
    const rows = await listNotifications(ctx.db, {
      userId,
      kinds: input.kinds,
      unreadOnly: input.unread,
      beforeId: input.cursor === undefined ? undefined : decodeCursor(input.cursor),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      notifications: page.map((n) => ({
        id: n.id,
        kind: n.kind as (typeof NOTIFICATION_KINDS)[number],
        org: n.orgSlug,
        project: n.projectSlug,
        run_id: n.runId,
        count: n.count,
        title: n.title,
        created_at: iso(n.createdAt)!,
        read_at: iso(n.readAt),
        link: link(n),
      })),
      unread_count: await countUnreadNotifications(ctx.db, userId),
      next_cursor: rows.length > input.limit && last ? encodeCursor(last.id) : null,
    };
  },
});

export const notificationsAckOp = defineOp({
  name: "notifications_ack",
  summary: "Mark notifications read: the named ids, or all of the caller's unread ones.",
  description:
    "Marks the signed-in person's own notifications read. Pass `ids` (up to 100) to mark those, " +
    "or omit it to mark every unread one. Only the caller's own rows in orgs they still belong " +
    "to change; an id that is not theirs is ignored, exactly like one that does not exist. " +
    "Returns how many changed. Idempotent. A person only: an org token is refused.",
  input: z.object({ ids: z.array(z.string().max(40)).max(100).optional() }),
  output: z.object({ acked: z.int() }),
  effect: "write",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/my/notifications/ack" },
  async handler(ctx, input) {
    const userId = await personOf(ctx, "notifications_ack");
    const acked = await ackNotifications(ctx.db, { userId, ids: input.ids, now: ctx.now() });
    return { acked };
  },
});

const prefOut = z.object({
  kind,
  org: z.string().nullable().describe("Org slug; null for every org."),
  project: z.string().nullable().describe("Project slug; null for every project."),
  enabled: z.boolean(),
});

export const getNotificationPrefsOp = defineOp({
  name: "get_notification_prefs",
  summary: "The signed-in person's notification preferences and the defaults.",
  description:
    "Lists the person's explicit preferences (kind by org by project) and the default for each " +
    "kind that applies when none is set. The most specific row wins: project, then org, then " +
    "all. Reads only the caller's own rows. A signed-in web session only.",
  input: z.object({}),
  output: z.object({
    prefs: z.array(prefOut),
    defaults: z.array(z.object({ kind, enabled: z.boolean(), operator_only: z.boolean() })),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/my/notification-prefs" },
  async handler(ctx) {
    const userId = sessionUser(ctx, "get_notification_prefs");
    const prefs = await listNotificationPrefs(ctx.db, userId);
    const memberships = await listMembershipsOfUser(ctx.db, userId);
    const slug = new Map(memberships.map((m) => [m.orgId, m.slug]));
    const visible = prefs.filter((p) => p.orgId === "" || slug.has(p.orgId));
    const projects = new Map<string, Map<string, string>>();
    for (const orgId of new Set(visible.filter((p) => p.projectId !== "").map((p) => p.orgId))) {
      const ids = visible
        .filter((p) => p.orgId === orgId && p.projectId !== "")
        .map((p) => p.projectId);
      projects.set(orgId, await projectSlugs(ctx.db, orgId, ids));
    }
    return {
      prefs: visible.map((p) => ({
        kind: p.kind as (typeof NOTIFICATION_KINDS)[number],
        org: p.orgId === "" ? null : (slug.get(p.orgId) ?? null),
        project: p.projectId === "" ? null : (projects.get(p.orgId)?.get(p.projectId) ?? null),
        enabled: p.enabled,
      })),
      defaults: NOTIFICATION_KINDS.map((k) => ({
        kind: k,
        enabled: KIND_DEFAULTS[k],
        operator_only: OPERATOR_ONLY_KINDS.includes(k),
      })),
    };
  },
});

function sessionUser(ctx: OpContext, name: string): string {
  const p = ctx.principal;
  if (p.kind !== "session") throw new OpError("forbidden", `${name} needs a signed-in web session`);
  return p.id;
}

export const setNotificationPrefsOp = defineOp({
  name: "set_notification_prefs",
  summary: "Turn one notification kind on or off, for all orgs, one org or one project.",
  description:
    "Sets or clears (`enabled` omitted) the caller's preference for one kind. `scope_org` " +
    "(a slug of an org the caller belongs to) narrows it to that org, and `scope_project` (a " +
    "project slug, needs scope_org) to one project; with neither it applies everywhere. The " +
    "most specific preference wins. Only the caller's own preferences change; an org they do " +
    "not belong to reads as not found. A signed-in web session only.",
  input: z.object({
    kind,
    enabled: z
      .boolean()
      .optional()
      .describe("Omit to remove the preference (back to the default)."),
    scope_org: z.string().max(40).optional(),
    scope_project: z.string().max(40).optional(),
  }),
  output: z.object({ ok: z.literal(true) }),
  effect: "write",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/my/notification-prefs/set" },
  async handler(ctx, input) {
    const userId = sessionUser(ctx, "set_notification_prefs");
    if (input.scope_project !== undefined && input.scope_org === undefined)
      throw new OpError("invalid_input", "scope_project needs scope_org");
    let orgId = "";
    if (input.scope_org !== undefined) {
      const m = (await listMembershipsOfUser(ctx.db, userId)).find(
        (x) => x.slug === input.scope_org,
      );
      if (!m) throw new OpError("not_found", "org not found");
      orgId = m.orgId;
    }
    let projectId = "";
    if (input.scope_project !== undefined) {
      const id = await projectIdBySlug(ctx, orgId, input.scope_project);
      if (!id) throw new OpError("not_found", "project not found");
      projectId = id;
    }
    await putNotificationPref(ctx.db, {
      userId,
      orgId,
      projectId,
      kind: input.kind,
      enabled: input.enabled ?? null,
      now: ctx.now(),
    });
    return { ok: true as const };
  },
});

async function projectIdBySlug(ctx: OpContext, orgId: string, slug: string) {
  return (await getProjectBySlug(ctx.db, { orgId }, slug))?.id;
}
