import { z } from "zod";
import { systemOrgId } from "../../audit/failures";
import { appendAudit } from "../../db";
import type { RateLimitInfo } from "../../poll/github";
import { classifyPollError, ingestStatus } from "../../poll/status";
import { iso } from "../common";
import { defineOp } from "../define";

const rateLimitShape = z.object({
  limit: z.int().nullable(),
  remaining: z.int().nullable(),
  reset_at: z.string().nullable(),
  observed_at: z.string(),
});

const wireRate = (r: RateLimitInfo | undefined): z.infer<typeof rateLimitShape> | null =>
  r
    ? {
        limit: r.limit ?? null,
        remaining: r.remaining ?? null,
        reset_at: iso(r.resetAt),
        observed_at: iso(r.observedAt)!,
      }
    : null;

export const instanceIngestStatusOp = defineOp({
  name: "instance_ingest_status",
  summary: "Poll health of every org's repos, for the instance administrator.",
  description:
    "Reports the GitHub poller's health across all orgs, with no org credential: per repo the org " +
    "and project slug, the configured poll interval, the last poll time, the last successful poll time and the last outcome (ok, rate_limited or error), the error " +
    "class (rate_limited, auth, not_found, github_4xx, github_5xx, network, stale_binding or " +
    "unknown) and never the raw error text, consecutive failures, the next poll time, the auth " +
    "mode (anonymous, token or installation) and that mode's last rate-limit budget (limit, " +
    "remaining, reset). Also the last budget of each mode. It carries no token, commit message or " +
    "run content. The view is the poller in the server process answering the call: it is empty " +
    "when polling is off or runs in another process. Only the instance administrator can call " +
    "it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: z.object({
    running: z.boolean().describe("Whether the poller is running in this process."),
    rate_limit_by_mode: z.object({
      anonymous: rateLimitShape.nullable(),
      poll_token: rateLimitShape.nullable(),
      installation: rateLimitShape
        .nullable()
        .describe("The installed repo with the least budget left."),
    }),
    repos: z.array(
      z.object({
        org: z.string(),
        project: z.string(),
        repo: z.string(),
        effective_repo: z
          .string()
          .optional()
          .describe(
            "Set when the repo was renamed or transferred: the slug actually polled, found by forge repo id. The poll entry's repo should be updated to it.",
          ),
        warning: z.string().optional().describe("Something the operator should change."),
        interval_seconds: z.int(),
        last_poll_at: z.string().nullable(),
        last_success_at: z
          .string()
          .nullable()
          .describe("The last successful poll; failures and skipped polls do not move it."),
        last_outcome: z.enum(["ok", "rate_limited", "error"]).nullable(),
        error_class: z
          .enum([
            "rate_limited",
            "auth",
            "not_found",
            "github_4xx",
            "github_5xx",
            "network",
            "stale_binding",
            "unknown",
          ])
          .nullable(),
        consecutive_failures: z.int(),
        next_poll_at: z.string().nullable(),
        auth_mode: z.enum(["anonymous", "token", "installation"]).nullable(),
        rate_limit: rateLimitShape
          .nullable()
          .describe("The budget of that auth mode for this repo."),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/ingest-status" },
  mcp: false,
  async handler(ctx) {
    const repos = [...ingestStatus.repos.values()];
    // Cross-tenant visibility is a read worth a trace: the system chain says who looked.
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_ingest_status",
        effect: "read",
        outcome: "ok",
        input: { repos: repos.length },
      },
    );
    const fallback = wireRate(ingestStatus.rateLimit);
    const installed = repos
      .filter((r) => r.authMode === "installation" && r.rateLimit)
      .map((r) => r.rateLimit as RateLimitInfo)
      .toSorted((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity))[0];
    return {
      running: ingestStatus.running,
      rate_limit_by_mode: {
        anonymous: ingestStatus.fallbackAuth === "anonymous" ? fallback : null,
        poll_token: ingestStatus.fallbackAuth === "token" ? fallback : null,
        installation: wireRate(installed),
      },
      repos: repos.map((r) => ({
        org: r.org,
        project: r.project,
        repo: r.repo,
        ...(r.effectiveRepo !== undefined
          ? {
              effective_repo: r.effectiveRepo,
              warning: `update the poll entry's repo to ${r.effectiveRepo}`,
            }
          : {}),
        interval_seconds: r.intervalSeconds,
        last_poll_at: iso(r.lastPollAt),
        last_success_at: iso(r.lastSuccessAt),
        last_outcome: r.lastOutcome,
        error_class: classifyPollError(r),
        consecutive_failures: r.consecutiveFailures,
        next_poll_at: iso(r.nextPollAt),
        auth_mode: r.authMode,
        rate_limit: wireRate(r.rateLimit),
      })),
    };
  },
});
