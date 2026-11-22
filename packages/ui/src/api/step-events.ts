import type { RealtimeMessage } from "./realtime";

/** The fields of a step as the API and the realtime socket report it. */
export type WireStepLike = {
  name: string;
  result: string | null;
  started_at: string | null;
  finished_at: string | null;
  log_offset: number;
};

const at = (iso: string | null): number => (iso ? Date.parse(iso) : 0);

/**
 * Step snapshots become the start and end events the log parser takes, keyed by log offset. A step
 * ends where the next one begins (the last one at the end of the log). Sent again, they apply
 * idempotently.
 */
export function stepEvents(attemptId: string, steps: readonly WireStepLike[]): RealtimeMessage[] {
  const out: RealtimeMessage[] = [];
  steps.forEach((s, i) => {
    const index = i + 1;
    out.push({
      type: "step",
      attemptId,
      index,
      name: s.name,
      phase: "start",
      at: at(s.started_at),
      logOffset: s.log_offset,
    });
    if (s.result) {
      out.push({
        type: "step",
        attemptId,
        index,
        name: s.name,
        phase: "end",
        result: s.result as "success" | "failure" | "skipped" | "cancelled",
        at: at(s.finished_at),
        logOffset: steps[i + 1]?.log_offset ?? Number.MAX_SAFE_INTEGER,
      });
    }
  });
  return out;
}
