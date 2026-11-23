import { z } from "zod";
import { getInstallation } from "../../db/repos";
import { syncInstallation } from "../../github/installations";
import { defineOp } from "../define";
import { OpError } from "../errors";

/** Resyncs allowed per org in a window: each one is a GitHub API round trip. */
export const RESYNC_LIMIT = 6;
export const RESYNC_WINDOW_MS = 60_000;
const recent = new Map<string, number[]>();

/** Records a resync for the org, or says how long until one is allowed. Per process. */
function takeResync(orgId: string, now: number): number | undefined {
  const times = (recent.get(orgId) ?? []).filter((t) => now - t < RESYNC_WINDOW_MS);
  if (times.length >= RESYNC_LIMIT) {
    recent.set(orgId, times);
    return Math.ceil((times[0]! + RESYNC_WINDOW_MS - now) / 1000);
  }
  times.push(now);
  recent.set(orgId, times);
  return undefined;
}

export const resyncInstallation = defineOp({
  name: "resync_installation",
  summary: "Re-sync one GitHub App installation of this org with GitHub.",
  description:
    "Re-fetches an installation and its repositories from GitHub and reconciles this org's repo " +
    "bindings with them, as the installation webhooks do. Use it after installing the App on a " +
    "repo that was already being polled: the existing binding is adopted (it keeps its project) " +
    "so check runs can be posted. Idempotent. Only an installation this org owns: another " +
    "org's installation id is refused as not_found. Limited to 6 calls a minute per org " +
    "(rate_limited). Needs an org-level token with release_operator or admin.",
  input: z.object({
    installation_id: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .describe("The GitHub installation id (numeric)."),
  }),
  output: z.object({
    outcome: z.enum(["synced", "suspended", "deleted", "unknown", "unclaimed"]),
    bound: z.array(z.string()),
    adopted: z.array(z.string()),
    unbound: z.array(z.string()),
    conflicts: z.array(z.string()),
  }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/github/installations/{installation_id}/resync" },
  // GitHub round trips: not inside the audit transaction. The dispatcher audits the outcome.
  outsideTransaction: true,
  auditDetail: (o) => ({ outcome: o.outcome, adopted: o.adopted.length, bound: o.bound.length }),
  async handler(ctx, input) {
    if (ctx.scope.projectId || (ctx.principal.kind === "token" && ctx.principal.projectId)) {
      throw new OpError("forbidden", "an org-level token is required");
    }
    const found = await getInstallation(ctx.db, input.installation_id);
    // The same answer for an unknown id and another org's: nothing says which exists.
    if (!found || found.orgId !== ctx.scope.orgId) {
      throw new OpError("not_found", "no such installation");
    }
    if (!ctx.githubFacts) {
      throw new OpError("unavailable", "no GitHub App is configured on this server");
    }
    const wait = takeResync(ctx.scope.orgId, ctx.now());
    if (wait !== undefined) {
      throw new OpError("rate_limited", `too many resyncs: try again in ${wait}s`, {
        retry_after_seconds: wait,
      });
    }
    try {
      return await syncInstallation(ctx.db, ctx.githubFacts, input.installation_id);
    } catch (err) {
      console.error("turntable: resync_installation failed", err);
      throw new OpError("unavailable", "the installation could not be synced with GitHub");
    }
  },
});
