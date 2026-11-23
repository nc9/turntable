import { z } from "zod";
import { sandboxUsage, utcDayStart } from "../../db/repos";
import { defineOp } from "../define";

const DAY_MS = 86_400_000;

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
    "the number quotas limit. Read-only.",
  input: z.object({
    days: z.int().min(1).max(92).default(7).describe("How many UTC days, ending today."),
  }),
  output: z.object({
    days: z.array(
      z.object({
        day: z.string().describe("UTC day, YYYY-MM-DD."),
        sandbox_seconds: z.number(),
        sandbox_minutes: z.number(),
        attempts: z.int(),
        estimated_attempts: z.int(),
      }),
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
    const seconds = Math.round(rows.reduce((n, r) => n + r.seconds, 0) * 1000) / 1000;
    return {
      days: rows.map((r) => ({
        day: r.day,
        sandbox_seconds: r.seconds,
        sandbox_minutes: r.minutes,
        attempts: r.attempts,
        estimated_attempts: r.estimated,
      })),
      total_seconds: seconds,
      total_minutes: Math.round((seconds / 60) * 1000) / 1000,
    };
  },
});
