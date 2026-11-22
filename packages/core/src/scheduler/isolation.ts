import { type IsolationClass, isolationAtLeast } from "@longshore/provider-sdk";
import { appendAudit, type Scope } from "../db/repos";
import type { Db } from "../db";
import { isolationTrust } from "../trust";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "./types";

/**
 * Isolation minimums by trust. A run is `trusted` only when its stored class (decided at ingest)
 * is protected, release or trusted_pr, or it is a local run; anything else, including a missing or
 * unknown class, is `untrusted`. A job needing untrusted-author approval, or demoted by the
 * privileged-trigger rule, is untrusted too.
 *
 * - untrusted: gVisor or stronger.
 * - hosted instance (many tenants): microVM or VM, for every run.
 * - otherwise: any provider.
 */
export type IsolationTrust = "trusted" | "untrusted";

/** Fails closed: see `isolationTrust` in the trust module. */
export function trustOf(
  job: Parameters<typeof isolationTrust>[0],
  run: Parameters<typeof isolationTrust>[1],
): IsolationTrust {
  return isolationTrust(job, run);
}

export function requiredIsolation(trust: IsolationTrust, hosted: boolean): IsolationClass {
  if (hosted) return "microvm";
  return trust === "untrusted" ? "gvisor" : "container";
}

export type IsolationPolicy = {
  db: Db;
  /** A hosted, multi-tenant instance: every run needs microVM or VM. */
  hosted: boolean;
  /**
   * An explicit, audited decision to run on a provider weaker than required. `reason` is
   * recorded in the audit log and shown at the top of every affected job's log.
   */
  override?: { reason: string } | undefined;
  /** Test seam; the default writes an audit row. */
  audit?: (scope: Scope, entry: Parameters<typeof appendAudit>[2]) => Promise<void>;
};

/** Wraps a runner so a job never starts on a provider weaker than its class allows. */
export function withIsolationPolicy(runner: AttemptRunner, policy: IsolationPolicy): AttemptRunner {
  const audit = policy.audit ?? ((scope, entry) => appendAudit(policy.db, scope, entry));
  return async (ctx: AttemptContext): Promise<AttemptOutcome> => {
    const trust = trustOf(ctx.job, ctx.run);
    const need = requiredIsolation(trust, policy.hosted);
    const have = ctx.provider.info.isolation;
    if (isolationAtLeast(have, need)) return runner(ctx);

    const where = policy.hosted ? "a hosted instance" : `${trust} runs`;
    if (!policy.override) {
      return {
        state: "infra_error",
        reason: `isolation: provider ${ctx.provider.info.name} is ${have}; ${where} need ${need} or stronger`,
      };
    }
    await audit(ctx.scope, {
      principalKind: "system",
      principalId: "scheduler",
      op: "isolation.override",
      effect: "write",
      outcome: "ok",
      input: {
        runId: ctx.run.id,
        jobId: ctx.job.id,
        attemptId: ctx.attempt.id,
        provider: ctx.provider.info.name,
        have,
        need,
        trust,
        hosted: policy.hosted,
        reason: policy.override.reason,
      },
    });
    const notice = `[longshore] isolation override: this job ran on ${have} isolation where ${need} was required (${trust}${policy.hosted ? ", hosted" : ""}). Reason: ${policy.override.reason}`;
    return runner({ ...ctx, notices: [...(ctx.notices ?? []), notice] });
  };
}
