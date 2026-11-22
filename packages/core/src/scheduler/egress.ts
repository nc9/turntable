/**
 * Egress for a run's sandboxes. The default is `none`. A run gets `open` only when its recorded
 * plan says `"egress": "open"` (set from the project's configuration when the run is created),
 * or when the runner was explicitly built with `open` (the local `longshore run` opt-in).
 * Anything else, including a missing, malformed or unknown value, is `none`.
 */
export type Egress = "none" | "open";

export function egressForRun(runPlan: string | null | undefined, explicit?: Egress): Egress {
  if (explicit === "open") return "open";
  if (!runPlan) return "none";
  try {
    const plan = JSON.parse(runPlan) as { egress?: unknown } | null;
    return plan !== null && typeof plan === "object" && plan.egress === "open" ? "open" : "none";
  } catch {
    return "none";
  }
}
