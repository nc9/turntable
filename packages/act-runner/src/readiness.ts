import { ExprError, evaluateJobCondition, type ExprContext, type Value } from "./expr";
import type { NeedResult } from "./split";
import type { PlannedJob } from "./workflow-plan";

/** A job state as the scheduler stores it. */
export type NeedState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "success"
  | "failure"
  | "infra_error"
  | "cancelled"
  | "skipped";

/** One needed job (a matrix leg counts as its own job) as the scheduler sees it. */
export interface NeedStatus {
  state: NeedState;
  /** The job's outputs once it has finished. */
  outputs?: Readonly<Record<string, string>>;
  /** The needed job's own `continue-on-error`: a failure then counts as success. */
  continueOnError?: boolean;
}

export type Readiness =
  | { decision: "ready" }
  | { decision: "wait" }
  | { decision: "skip"; reason: string }
  | { decision: "cancel"; reason: string };

export interface ReadinessContext {
  /** github, vars, inputs and env contexts for `if:`. needs, matrix and status are filled in. */
  contexts?: Readonly<Record<string, Value>>;
  /** The run was cancelled: queued jobs are cancelled, not started. */
  cancelled?: boolean;
}

const TERMINAL: readonly NeedState[] = [
  "success",
  "failure",
  "infra_error",
  "cancelled",
  "skipped",
];

/** What dependents see for one finished job. */
export function needResultOf(s: NeedStatus): NeedResult["result"] {
  switch (s.state) {
    case "success":
      return "success";
    case "failure":
    case "infra_error":
      return s.continueOnError ? "success" : "failure";
    case "cancelled":
      return "cancelled";
    default:
      return "skipped";
  }
}

/**
 * Folds the legs of one needed job id into the single result and outputs `needs.<id>` exposes:
 * failure if any leg failed, else cancelled if any was, else skipped if all were, else success.
 * Outputs merge in leg order; a later non-empty value wins.
 */
export function aggregateNeed(legs: readonly NeedStatus[]): NeedResult {
  const rs = legs.map(needResultOf);
  const result: NeedResult["result"] = rs.includes("failure")
    ? "failure"
    : rs.includes("cancelled")
      ? "cancelled"
      : rs.every((r) => r === "skipped")
        ? "skipped"
        : "success";
  const outputs: Record<string, string> = {};
  for (const l of legs) {
    for (const [k, v] of Object.entries(l.outputs ?? {})) {
      if (v !== "" || !(k in outputs)) outputs[k] = v;
    }
  }
  return { result, outputs };
}

/**
 * Decides whether a queued job can start. Pure: give it the planned job and the current states
 * of its needs (keyed by planned job key). `wait` until every need is terminal; then `cancel`
 * if the run was cancelled, `skip` for an `if:` that is false (the
 * default `if:` is success(): every need succeeded, so a failed, cancelled or skipped need skips
 * the job), else `ready`. The needs results and outputs are what `if:` and the job's own
 * `needs.*` expressions see. An unsupported job is `ready` once its own `if:` allows it: the
 * runner ends it as a failure with the reason, never `skipped` (branch protection counts a skipped
 * required check as passing). Only the workflow's own false `if:` skips it.
 */
export function jobReadiness(
  job: PlannedJob,
  needs: Readonly<Record<string, NeedStatus>>,
  ctx: ReadinessContext = {},
): Readiness {
  const status = (k: string): NeedStatus => needs[k] ?? { state: "queued" };
  if (!job.needs.every((k) => TERMINAL.includes(status(k).state))) return { decision: "wait" };
  if (ctx.cancelled) return { decision: "cancel", reason: "run cancelled" };
  if (job.staticSkip) return { decision: "skip", reason: job.staticSkip.reason };

  const byId = Object.fromEntries(
    job.needsIds.map((id) => {
      // A needed job's legs are the needs entries whose key is the id or `id[n]`.
      const legs = job.needs
        .filter((k) => k === id || k.startsWith(`${id}[`))
        .map((k) => status(k));
      return [id, aggregateNeed(legs)];
    }),
  );
  const exprCtx: ExprContext = {
    contexts: {
      ...ctx.contexts,
      needs: Object.fromEntries(
        Object.entries(byId).map(([id, n]) => [id, { result: n.result, outputs: n.outputs }]),
      ),
      matrix: (job.matrix ?? {}) as Value,
    },
    status: { needs: Object.values(byId).map((n) => n.result), cancelled: false },
  };
  try {
    if (!evaluateJobCondition(job.ifExpr, exprCtx)) {
      return {
        decision: "skip",
        reason: `if: ${String(job.ifExpr ?? "success()").trim()} is false`,
      };
    }
  } catch (e) {
    if (e instanceof ExprError)
      return { decision: "skip", reason: `cannot evaluate if: ${e.message}` };
    throw e;
  }
  return { decision: "ready" };
}
