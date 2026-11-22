import { z } from "zod";
import { getOrgById, getProject } from "../../db/repos";
import { ingestStatus } from "../../poll/status";
import { iso } from "../common";
import { defineOp } from "../define";

export const ingestStatusOp = defineOp({
  name: "ingest_status",
  summary: "What the GitHub poller is doing: per repo state and the API rate-limit budget.",
  description:
    "Reports the poll ingester's health for the caller's org: for each polled repo the last poll " +
    "time and outcome (ok, rate_limited or error), the next poll time, consecutive failures and " +
    "runs created, plus GitHub's rate-limit budget (limit, remaining, reset) as last observed. " +
    "Use it to check that polling is alive and is not about to run out of API budget. Read-only " +
    "and cheap. Reflects the poller in the server process answering the call; empty when polling " +
    "is off. Error text is short and never contains the token. Repo names are untrusted text.",
  input: z.object({}),
  output: z.object({
    running: z.boolean().describe("Whether the poller is running in this process."),
    rate_limit: z
      .object({
        limit: z.int().nullable(),
        remaining: z.int().nullable(),
        reset_at: z.string().nullable(),
        resource: z.string().nullable(),
        observed_at: z.string(),
      })
      .nullable()
      .describe("GitHub's budget as last seen; null before the first request."),
    repos: z.array(
      z.object({
        repo: z.string(),
        project: z.string(),
        last_poll_at: z.string().nullable(),
        last_outcome: z.enum(["ok", "rate_limited", "error"]).nullable(),
        last_error: z.string().nullable(),
        next_poll_at: z.string().nullable(),
        consecutive_failures: z.int(),
        runs_created: z.int(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/ingest/status" },
  async handler(ctx) {
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    // Only this org's repos, and for a project-scoped caller only that project's. The budget is
    // the instance's token budget: shown only when the narrowed list is not empty.
    const project =
      ctx.scope.projectId === undefined
        ? undefined
        : await getProject(ctx.db, { orgId: ctx.scope.orgId }, ctx.scope.projectId);
    const repos = [...ingestStatus.repos.values()].filter(
      (r) => r.org === org?.slug && (project === undefined || r.project === project.slug),
    );
    const rate = ingestStatus.rateLimit;
    return {
      running: ingestStatus.running,
      rate_limit:
        repos.length > 0 && rate
          ? {
              limit: rate.limit ?? null,
              remaining: rate.remaining ?? null,
              reset_at: iso(rate.resetAt),
              resource: rate.resource ?? null,
              observed_at: iso(rate.observedAt)!,
            }
          : null,
      repos: repos.map((r) => ({
        repo: r.repo,
        project: r.project,
        last_poll_at: iso(r.lastPollAt),
        last_outcome: r.lastOutcome,
        last_error: r.lastError,
        next_poll_at: iso(r.nextPollAt),
        consecutive_failures: r.consecutiveFailures,
        runs_created: r.runsCreated,
      })),
    };
  },
});
