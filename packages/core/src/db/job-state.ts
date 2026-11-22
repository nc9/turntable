import type { JobState } from "./schema";

/**
 * Allowed job state transitions.
 *
 * - `failure`: the job's own non-zero exit. `infra_error`: no trustworthy result (sandbox
 *   create failed, provider error, exit code unrecoverable, infra timeout).
 * - Terminal: success, failure, cancelled. `infra_error` may return to `queued` so a retry can
 *   start a new attempt; a `failure` is a real result and is never retried implicitly.
 */
export const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "awaiting_approval", "cancelled"],
  awaiting_approval: ["queued", "cancelled"],
  running: ["success", "failure", "infra_error", "cancelled"],
  infra_error: ["queued"],
  success: [],
  failure: [],
  cancelled: [],
};

export const TERMINAL_STATES: readonly JobState[] = ["success", "failure", "cancelled"];

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Exit-code invariant: success is 0, failure is non-zero, infra_error has none. */
export function exitCodeValid(state: JobState, exitCode: number | null | undefined): boolean {
  if (state === "success") return exitCode === 0;
  if (state === "failure") return typeof exitCode === "number" && exitCode !== 0;
  if (state === "infra_error") return exitCode == null;
  return true;
}

/** Aggregates job states into a run status. Any infra_error outranks failure: result untrusted. */
export function aggregateRunStatus(states: readonly JobState[]): JobState {
  if (states.length === 0) return "queued";
  const has = (s: JobState) => states.includes(s);
  if (states.every((s) => s === "cancelled")) return "cancelled";
  if (has("running")) return "running";
  if (has("queued")) return states.some((s) => s !== "queued") ? "running" : "queued";
  if (has("awaiting_approval")) return "awaiting_approval";
  if (has("infra_error")) return "infra_error";
  if (has("failure")) return "failure";
  if (has("cancelled")) return "cancelled";
  return "success";
}
