import type { ActEvent } from "@turntable/act-runner";

/** First line of a step name, shortened. Unnamed `run:` steps are named after their script. */
export function stepLabel(name: string, stage: string): string {
  const first = (name.split("\n")[0] ?? "").trim();
  const short = first.length > 80 ? `${first.slice(0, 77)}...` : first;
  return stage === "Pre" || stage === "Post" ? `${short} (${stage.toLowerCase()})` : short;
}

/**
 * Turns act events into the readable log that is shown and stored. The stored log is this text,
 * not act's JSON, so stored offsets address what the user sees.
 */
export function renderEvent(e: ActEvent): string {
  switch (e.type) {
    case "step-start":
      return `▶ ${stepLabel(e.name, e.stage)}\n`;
    case "step-end": {
      const mark = e.result === "success" ? "✓" : e.result === "skipped" ? "-" : "✗";
      const dur = e.durationMs === undefined ? "" : ` (${Math.round(e.durationMs)} ms)`;
      return `${mark} ${stepLabel(e.name, e.stage)}${e.result === "success" ? "" : ` ${e.result}`}${dur}\n`;
    }
    case "output":
      return e.text.endsWith("\n") ? e.text : `${e.text}\n`;
    case "error":
      return `error: ${e.message}\n`;
    case "text":
      return `${e.text}\n`;
    case "job-end":
      return `job ${e.result}\n`;
    default:
      return "";
  }
}
