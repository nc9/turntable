import { z } from "zod";
import { getOrgQuotas, quotaStatuses, quotaUsage, setOrgQuotas } from "../../db/repos";
import { defineOp } from "../define";
import { principalLabel } from "../principal";

const limit = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const quotasShape = z.object({
  max_concurrent: limit.nullable(),
  max_runs_per_hour: limit.nullable(),
  max_sandbox_minutes_per_day: limit.nullable(),
  max_log_bytes: limit.nullable(),
  max_stored_bytes: limit.nullable(),
});

const view = z.object({
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

async function build(
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
    "(`infra.error` with `error_class` `quota_warning` at 80% and `quota_reached` at 100%) fire " +
    "once per window. Read-only.",
  input: z.object({}),
  output: view,
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/quotas" },
  async handler(ctx) {
    return build(ctx, ctx.scope.orgId);
  },
});

export const setQuotas = defineOp({
  name: "set_quotas",
  summary: "Set the org's quotas. Operator only; not available over MCP.",
  description:
    "Sets the limits you give (a number sets one, null removes it) and leaves the others as they " +
    "are. `max_concurrent` replaces the instance's per-org concurrency cap for this org. The " +
    "other limits hold new work when reached: running attempts finish, queued ones wait until " +
    "the window moves or the limit is raised. Audited. Not exposed as an MCP tool: an agent must " +
    "not raise its own limits.",
  input: quotasShape.partial(),
  output: view,
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/quotas" },
  mcp: false,
  async handler(ctx, input) {
    const patch = {
      ...(input.max_concurrent !== undefined ? { maxConcurrent: input.max_concurrent } : {}),
      ...(input.max_runs_per_hour !== undefined ? { maxRunsPerHour: input.max_runs_per_hour } : {}),
      ...(input.max_sandbox_minutes_per_day !== undefined
        ? { maxSandboxMinutesPerDay: input.max_sandbox_minutes_per_day }
        : {}),
      ...(input.max_log_bytes !== undefined ? { maxLogBytes: input.max_log_bytes } : {}),
      ...(input.max_stored_bytes !== undefined ? { maxStoredBytes: input.max_stored_bytes } : {}),
    };
    await setOrgQuotas(ctx.db, ctx.scope.orgId, patch, principalLabel(ctx.principal), ctx.now());
    return build(ctx, ctx.scope.orgId);
  },
});
