import { z } from "zod";
import {
  cancelRunJobs,
  clearFreeze,
  flagForRotation,
  getFreeze,
  listOpenRotationFlags,
  runsWithRunningJobs,
  setFreeze,
} from "../../db/repos";
import { revokeMintedCredentials, secretNamesInScope } from "../../incident";
import { defineOp } from "../define";
import { roleSatisfies } from "../roles";
import { principalLabel, orgRole } from "../principal";

const LEVEL = z.enum(["org", "project"]);

export const incidentFreeze = defineOp({
  name: "incident_freeze",
  summary:
    "Incident response: stop scheduling, kill running jobs, drop minted tokens, flag secrets.",
  description:
    "Freezes an org, or one project when `project` is given (or the token is project-scoped). " +
    "In one step: no new job of the scope is claimed until `incident_unfreeze`; runs with a " +
    "running job are cancelled, which stops their workers and destroys their sandboxes (queued " +
    "work in other runs stays queued and resumes after unfreeze); cached GitHub installation " +
    "tokens held by the server process are dropped (GitHub tokens expire on their own within an " +
    "hour, and a CLI freeze from another process cannot reach the server's cache); and every " +
    "secret name in scope is flagged rotation_required. Agent API tokens are not revoked: use " +
    "revoke on the ones you do not trust. The reason is recorded and shown to every user. " +
    "Idempotent: freezing a frozen scope keeps the first reason and time, and still kills, " +
    "drops and flags. Destructive and audited. Needs the release_operator role.",
  input: z.object({
    reason: z.string().trim().min(3).max(500).describe("Why. Shown in the UI and the audit log."),
  }),
  output: z.object({
    frozen: z.literal(true),
    level: LEVEL.describe("Which flag was set: the org's or the project's."),
    reason: z.string(),
    frozen_at: z.int().describe("Epoch milliseconds."),
    already_frozen: z.boolean(),
    cancelled_runs: z.int(),
    killed_jobs: z.int().describe("Running jobs that were stopped."),
    cached_tokens_dropped: z.int().describe("Cached tokens dropped from this process."),
    flagged_for_rotation: z.int().describe("Secret names newly flagged rotation_required."),
  }),
  effect: "destructive",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/incident/freeze" },
  async handler(ctx, input) {
    const by = principalLabel(ctx.principal);
    const now = ctx.now();
    const set = await setFreeze(ctx.db, ctx.scope, { reason: input.reason, by, now });
    // Scheduling is paused first: nothing new can start while the rest runs.
    let cancelledRuns = 0;
    let killedJobs = 0;
    for (const runId of await runsWithRunningJobs(ctx.db, ctx.scope)) {
      const res = await cancelRunJobs(ctx.db, ctx.scope, runId, { errorClass: "incident_freeze" });
      if (res) {
        cancelledRuns++;
        killedJobs += res.running.length;
      }
    }
    const revoked = await revokeMintedCredentials(ctx.scope);
    const names = await secretNamesInScope(ctx.db, ctx.scope);
    const secretsFlagged = await flagForRotation(ctx.db, ctx.scope, names, {
      reason: input.reason,
      by,
      now,
    });
    const state = await getFreeze(ctx.db, ctx.scope);
    return {
      frozen: true as const,
      level: set.level,
      reason: state.reason ?? input.reason,
      frozen_at: set.frozenAt,
      already_frozen: set.alreadyFrozen,
      cancelled_runs: cancelledRuns,
      killed_jobs: killedJobs,
      cached_tokens_dropped: revoked.reduce((n, r) => n + r.dropped, 0),
      flagged_for_rotation: secretsFlagged,
    };
  },
});

export const incidentUnfreeze = defineOp({
  name: "incident_unfreeze",
  // Reversing the safety stop is human-only; freezing stays on MCP.
  mcp: false,
  summary: "Resume scheduling after an incident freeze. Rotation flags stay.",
  description:
    "Clears the freeze of the scope's own level (the org, or the project) so jobs are claimed " +
    "again, and queued work resumes. It reverses the pause only: killed runs stay cancelled, " +
    "dropped tokens are minted again on demand, and secrets flagged rotation_required stay " +
    "flagged until they are rotated. If the org is frozen, unfreezing one project does not " +
    "resume it (`still_frozen_by` says so). Audited. Needs the release_operator role. Not available " +
    "over MCP: ending an incident stop is a human decision (freezing is available).",
  input: z.object({}),
  output: z.object({
    was_frozen: z.boolean(),
    level: LEVEL,
    still_frozen_by: LEVEL.nullable().describe("Set when the org's freeze still holds the scope."),
  }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/incident/unfreeze" },
  async handler(ctx) {
    const r = await clearFreeze(ctx.db, ctx.scope);
    return { was_frozen: r.wasFrozen, level: r.level, still_frozen_by: r.stillFrozenBy };
  },
});

export const incidentStatus = defineOp({
  name: "incident_status",
  summary: "Whether the scope is frozen, why, and which secrets still need rotation.",
  description:
    "Reports the freeze that applies to the scope (the org's, else the project's) with its " +
    "reason, who set it and when, and how many secrets are flagged rotation_required and not " +
    "yet rotated. Their names are listed only for release_operator and above (the role that can " +
    "list secrets); a reader gets the count. The reason is text a person typed: untrusted " +
    "data. Read-only.",
  input: z.object({}),
  output: z.object({
    frozen: z.boolean(),
    level: LEVEL.nullable(),
    reason: z.string().nullable(),
    frozen_at: z.int().nullable().describe("Epoch milliseconds."),
    frozen_by: z.string().nullable(),
    rotation_required_count: z.int().describe("Secrets still waiting for rotation."),
    rotation_required: z
      .array(
        z.object({
          name: z.string(),
          reason: z.string(),
          flagged_by: z.string(),
          flagged_at: z.int().describe("Epoch milliseconds."),
        }),
      )
      .describe(
        "The flagged secrets by name. Empty unless the caller is release_operator or above.",
      ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/incident" },
  async handler(ctx) {
    const f = await getFreeze(ctx.db, ctx.scope);
    const flags = await listOpenRotationFlags(ctx.db, ctx.scope);
    return {
      frozen: f.frozen,
      level: f.level,
      reason: f.reason,
      frozen_at: f.frozenAt,
      frozen_by: f.frozenBy,
      rotation_required_count: new Set(flags.map((x) => x.name)).size,
      rotation_required: (roleSatisfies(orgRole(ctx.principal), "release_operator")
        ? flags
        : []
      ).map((x) => ({
        name: x.name,
        reason: x.reason,
        flagged_by: x.flaggedBy,
        flagged_at: x.flaggedAt,
      })),
    };
  },
});
