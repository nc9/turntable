import { z } from "zod";
import { getOrgQuotas, quotaStatuses, quotaUsage } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";

const limit = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const quotasShape = z.object({
  max_concurrent: limit.nullable(),
  max_runs_per_hour: limit.nullable(),
  max_sandbox_minutes_per_day: limit.nullable(),
  max_log_bytes: limit.nullable(),
  max_stored_bytes: limit.nullable(),
});

export const quotaViewSchema = z.object({
  limits: quotasShape,
  usage: z.array(
    z.object({
      metric: z.enum([
        "concurrent",
        "runs_per_hour",
        "sandbox_minutes",
        "log_bytes",
        "stored_bytes",
      ]),
      used: z.int(),
      limit: z.int().nullable(),
      percent: z.int().nullable().describe("Percent of the limit, rounded down; null with none."),
      held: z.string().nullable().describe("Why new work is held because of this limit."),
    }),
  ),
});

export async function quotaView(
  ctx: { db: Parameters<typeof getOrgQuotas>[0]; now: () => number },
  orgId: string,
) {
  const q = await getOrgQuotas(ctx.db, orgId);
  const u = await quotaUsage(ctx.db, orgId, ctx.now());
  return {
    limits: {
      max_concurrent: q.maxConcurrent,
      max_runs_per_hour: q.maxRunsPerHour,
      max_sandbox_minutes_per_day: q.maxSandboxMinutesPerDay,
      max_log_bytes: q.maxLogBytes,
      max_stored_bytes: q.maxStoredBytes,
    },
    usage: quotaStatuses(q, u),
  };
}

export const getQuotas = defineOp({
  name: "get_quotas",
  summary: "The org's quotas, what is used against each, and why work is held.",
  description:
    "The limits of this org (null is no limit), the usage each is measured against (concurrent " +
    "attempts now, runs started in the last hour, sandbox minutes in the last 24 hours, stored " +
    "log bytes, stored artifact and cache bytes), the percent used, and for a limit that is reached the " +
    "reason new work is held. A held limit stops new claims; running attempts finish. Events " +
    "(`quota.warning` at 80% and `quota.reached` at 100%) fire " +
    "once per window. Read-only. Needs an org-level token (a project-scoped one is refused). " +
    "Limits are set by the instance operator, on the host (`longshore quotas set`) or with an " +
    "instance token over REST (`set_quotas`), never by the org's own tokens: a tenant must not " +
    "be able to raise its own.",
  input: z.object({}),
  output: quotaViewSchema,
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/quotas" },
  async handler(ctx) {
    // Quotas belong to the org as a whole: a project-scoped token (or a project named in the
    // request) is refused rather than answered with an org-wide figure.
    if (ctx.scope.projectId || (ctx.principal.kind === "token" && ctx.principal.projectId))
      throw new OpError("forbidden", "an org-level token is required to read quotas");
    return quotaView(ctx, ctx.scope.orgId);
  },
});
