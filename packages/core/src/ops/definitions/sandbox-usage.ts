import { z } from "zod";
import { sandboxUsage, sandboxUsageByProject, utcDayStart } from "../../db/repos";
import { defineOp } from "../define";

const DAY_MS = 86_400_000;

const dayShape = z.object({
  day: z.string().describe("UTC day, YYYY-MM-DD."),
  sandbox_seconds: z.number(),
  sandbox_minutes: z.number(),
  attempts: z.int(),
  estimated_attempts: z.int(),
});

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const mapDay = (r: {
  day: string;
  seconds: number;
  minutes: number;
  attempts: number;
  estimated: number;
}) => ({
  day: r.day,
  sandbox_seconds: r.seconds,
  sandbox_minutes: r.minutes,
  attempts: r.attempts,
  estimated_attempts: r.estimated,
});

export const sandboxUsageOp = defineOp({
  name: "sandbox_usage",
  summary: "Exact sandbox time per UTC day: from the provider's create to its confirmed destroy.",
  description:
    "Returns, for the last `days` UTC days (today included, default 7, at most 92), how long " +
    "sandboxes were alive: seconds and minutes per day, how many attempts had a sandbox that day, " +
    "and how many of those have no confirmed destroy (their end is the attempt's finish, or now " +
    "while it runs, so the figure is an estimate for them). Counted from the provider's create to " +
    "its confirmed destroy, so time spent waiting for provider capacity is not included, unlike an " +
    "attempt's duration. Scoped to the org, or to one project when a project is given. This is " +
    'the number quotas limit. With `group_by: "project"` the answer also carries `projects`: the same ' +
    "per-day figures for each project that had a sandbox alive in the window (a project with no " +
    "usage is left out), with its `scheduling_class`, and `classes` totals them per class (yield usage, preempted attempts included, is reported apart); each day's project rows add up to that day's org row. A project-scoped " +
    "token sees only its own project. Read-only.",
  input: z.object({
    days: z.int().min(1).max(92).default(7).describe("How many UTC days, ending today."),
    group_by: z
      .enum(["project"])
      .optional()
      .describe("`project` adds a per-project breakdown under `projects`."),
  }),
  output: z.object({
    days: z.array(dayShape),
    projects: z
      .array(
        z.object({
          project_id: z.string(),
          project_slug: z.string(),
          project_name: z.string(),
          scheduling_class: z.enum(["normal", "yield"]),
          days: z.array(dayShape),
          total_seconds: z.number(),
          total_minutes: z.number(),
        }),
      )
      .optional()
      .describe("Present only with `group_by: project`."),
    classes: z
      .array(
        z.object({
          scheduling_class: z.enum(["normal", "yield"]),
          total_seconds: z.number(),
          total_minutes: z.number(),
        }),
      )
      .optional()
      .describe(
        "Present only with `group_by: project`: the totals per scheduling class, so yield usage is reported apart.",
      ),
    total_seconds: z.number(),
    total_minutes: z.number(),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/usage/sandbox" },
  async handler(ctx, input) {
    const now = ctx.now();
    const to = utcDayStart(now) + DAY_MS;
    const from = to - input.days * DAY_MS;
    const rows = await sandboxUsage(ctx.db, ctx.scope, { from, to, now });
    const seconds = round3(rows.reduce((n, r) => n + r.seconds, 0));
    const base = {
      days: rows.map(mapDay),
      total_seconds: seconds,
      total_minutes: round3(seconds / 60),
    };
    if (input.group_by !== "project") return base;
    const byProject = await sandboxUsageByProject(ctx.db, ctx.scope, { from, to, now });
    const projects = byProject.map((p) => {
      const secs = round3(p.days.reduce((n, r) => n + r.seconds, 0));
      return {
        project_id: p.projectId,
        project_slug: p.slug,
        project_name: p.name,
        scheduling_class: p.schedulingClass,
        days: p.days.map(mapDay),
        total_seconds: secs,
        total_minutes: round3(secs / 60),
      };
    });
    const classes = (["normal", "yield"] as const).map((c) => {
      const secs = round3(
        projects.filter((p) => p.scheduling_class === c).reduce((n, p) => n + p.total_seconds, 0),
      );
      return { scheduling_class: c, total_seconds: secs, total_minutes: round3(secs / 60) };
    });
    return { ...base, projects, classes };
  },
});
