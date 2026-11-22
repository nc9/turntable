/**
 * Parser for `act --json`: one JSON object per line. Facts it relies on:
 * - there is no job-start event, so job and step starts are inferred;
 * - a step start is a "Run <stage> <name>" message with no stepResult, an end carries stepResult;
 * - setup and complete steps use the key `stepid`, others `stepID` (both are arrays);
 * - a skipped job emits nothing at all (inferred by the caller from exit code 0 and no events);
 * - step outputs are NOT in the stream.
 */

export type StepResult = "success" | "failure" | "skipped" | "cancelled" | (string & {});

export type ActEvent =
  | { type: "job-start"; jobId: string; inferred: true; time: string }
  | {
      type: "step-start";
      jobId: string;
      stepKey: string;
      name: string;
      stage: string;
      /** True when no start line was seen and the start is inferred from the end event. */
      inferred: boolean;
      time: string;
    }
  | {
      type: "step-end";
      jobId: string;
      stepKey: string;
      name: string;
      stage: string;
      result: StepResult;
      durationMs?: number;
      time: string;
    }
  | { type: "job-end"; jobId: string; result: string; time: string }
  | { type: "output"; jobId: string; stepKey: string; text: string; time: string }
  | { type: "command"; jobId: string; stepKey: string; command: string; arg?: string; time: string }
  | { type: "error"; jobId: string; message: string; time: string };

interface Raw {
  job?: string;
  jobID?: string;
  level?: string;
  msg?: string;
  stage?: string;
  step?: string;
  stepID?: string[];
  stepid?: string[];
  stepResult?: string;
  executionTime?: number;
  jobResult?: string;
  raw_output?: boolean;
  command?: string;
  arg?: string;
  time?: string;
}

const stepKeyOf = (r: Raw): string => (r.stepID ?? r.stepid ?? []).join(".") || "?";

export interface ActParser {
  /** Feed text; returns events for every complete line. A trailing partial line is held back. */
  push(chunk: string): ActEvent[];
  /** Flush a final unterminated line. */
  end(): ActEvent[];
}

export function createActParser(): ActParser {
  let buf = "";
  const jobs = new Set<string>();
  /** open steps, `${jobId}\0${stepKey}` */
  const open = new Set<string>();

  function handle(line: string): ActEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    let r: Raw;
    try {
      r = JSON.parse(trimmed) as Raw;
    } catch {
      return [];
    }
    const jobId = r.jobID ?? "";
    const time = r.time ?? "";
    const out: ActEvent[] = [];
    if (jobId && !jobs.has(jobId)) {
      jobs.add(jobId);
      out.push({ type: "job-start", jobId, inferred: true, time });
    }
    if (r.jobResult !== undefined) {
      out.push({ type: "job-end", jobId, result: r.jobResult, time });
      return out;
    }
    const stepKey = stepKeyOf(r);
    const name = r.step ?? "";
    const stage = r.stage ?? "Job";
    const id = `${jobId}\0${stepKey}\0${stage}`;
    if (r.stepResult !== undefined) {
      if (!open.has(id)) {
        out.push({ type: "step-start", jobId, stepKey, name, stage, inferred: true, time });
      }
      open.delete(id);
      const ev: ActEvent = {
        type: "step-end",
        jobId,
        stepKey,
        name,
        stage,
        result: r.stepResult,
        time,
      };
      if (typeof r.executionTime === "number") ev.durationMs = r.executionTime / 1e6;
      out.push(ev);
      return out;
    }
    if (r.raw_output) {
      out.push({ type: "output", jobId, stepKey, text: r.msg ?? "", time });
      return out;
    }
    if (r.command !== undefined) {
      const ev: ActEvent = { type: "command", jobId, stepKey, command: r.command, time };
      if (r.arg !== undefined) ev.arg = r.arg;
      out.push(ev);
      return out;
    }
    if (r.level === "error" && r.msg !== undefined) {
      out.push({ type: "error", jobId, message: r.msg, time });
      return out;
    }
    if (r.msg?.startsWith("\u2b50 Run ") && r.step !== undefined) {
      open.add(id);
      out.push({ type: "step-start", jobId, stepKey, name, stage, inferred: false, time });
    }
    return out;
  }

  return {
    push(chunk) {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      return lines.flatMap(handle);
    },
    end() {
      const rest = buf;
      buf = "";
      return rest ? handle(rest) : [];
    },
  };
}

export interface JobSummary {
  /** A job-end event was seen. */
  finished: boolean;
  result?: string;
  /** Any event for the job was seen (set-up reached). */
  started: boolean;
  failedSteps: string[];
}

/** Folds events into the facts runJob needs. */
export function summarize(events: readonly ActEvent[]): JobSummary {
  const s: JobSummary = { finished: false, started: false, failedSteps: [] };
  for (const e of events) {
    s.started = true;
    if (e.type === "job-end") {
      s.finished = true;
      s.result = e.result;
    } else if (e.type === "step-end" && e.result === "failure") {
      s.failedSteps.push(e.name);
    }
  }
  return s;
}
