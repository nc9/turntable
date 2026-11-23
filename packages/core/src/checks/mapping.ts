// What a check run says. Pure functions: the mode decides the name, the conclusion and the text.
import type { ChecksMode } from "../db/repos";

export type AttemptResult = "success" | "failure" | "skipped" | "infra_error" | "cancelled";
export type Conclusion = "success" | "failure" | "neutral" | "cancelled" | "skipped";

/** A name from the workflow: one line, no markup-breaking characters, bounded. */
export function plain(text: string, max = 100): string {
  return text
    .replaceAll(/[\r\n\t`]+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The check name: `shadow / <job>` in shadow mode (so a required-check rule never matches it),
 * `turntable / <job>` in live mode, plus the matrix leg when the job has one.
 */
export function checkName(
  mode: Exclude<ChecksMode, "off">,
  job: { name: string; matrix: string | null },
): string {
  let leg = "";
  if (job.matrix) {
    try {
      const values = Object.values(JSON.parse(job.matrix) as Record<string, unknown>).map(String);
      const label = values.join(", ");
      if (label !== "" && !job.name.includes(label)) leg = ` (${plain(label, 60)})`;
    } catch {
      // an unreadable matrix adds no leg
    }
  }
  return `${mode === "shadow" ? "shadow" : "turntable"} / ${plain(job.name)}${leg}`;
}

const WORD: Record<AttemptResult, string> = {
  success: "success",
  failure: "failure",
  skipped: "skipped",
  cancelled: "cancelled",
  infra_error: "infrastructure error",
};

/**
 * Shadow mode is always `neutral`: it can never gate a merge, whatever happened. Live maps the
 * result; an infrastructure error is a `failure` with an infrastructure title, because nothing
 * trustworthy passed.
 */
export function conclusionFor(mode: Exclude<ChecksMode, "off">, result: AttemptResult): Conclusion {
  if (mode === "shadow") return "neutral";
  return result === "infra_error" ? "failure" : result;
}

export function titleFor(mode: Exclude<ChecksMode, "off">, result: AttemptResult): string {
  return `${mode === "shadow" ? "Shadow" : "Turntable"}: ${WORD[result]}`;
}

export const RUNNING_TITLE = (mode: Exclude<ChecksMode, "off">): string =>
  `${mode === "shadow" ? "Shadow" : "Turntable"}: running`;

/** A code fence longer than any fence in the text, so the text cannot close it. */
export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * Why an infrastructure error happened, as a fixed word. The raw reason is an exception message
 * (hostnames, paths, provider detail) and a check run is public on a public repo, so only this
 * class is ever published.
 */
export type InfraClass =
  | "sandbox_create_failed"
  | "exec_lost"
  | "provider_unavailable"
  | "timeout"
  | "isolation_policy"
  | "egress_policy"
  | "approval_required"
  | "plan_rejected"
  | "workflow_missing"
  | "runner_error"
  | "internal";

export function classifyInfra(reason: string | undefined): InfraClass {
  const r = (reason ?? "").toLowerCase();
  if (r.startsWith("isolation:")) return "isolation_policy";
  if (r.startsWith("egress:")) return "egress_policy";
  if (r.includes("approval")) return "approval_required";
  if (r.includes("plan rejected") || r.startsWith("lint") || r.startsWith("policy")) {
    return "plan_rejected";
  }
  if (r.includes("not found at")) return "workflow_missing";
  if (/timeout|timed out|deadline/.test(r)) return "timeout";
  if (/lost|controller_lost|probe|no exec|exec status/.test(r)) return "exec_lost";
  if (/cannot prepare sandbox|sandbox.*(create|start|fail)|create.*sandbox/.test(r)) {
    return "sandbox_create_failed";
  }
  if (/provider|unreachable|econn|enotfound|network|fetch failed|dns|502|503|504/.test(r)) {
    return "provider_unavailable";
  }
  if (/act (exited|install)|without a job result/.test(r)) return "runner_error";
  return "internal";
}

export type SummaryInput = {
  mode: Exclude<ChecksMode, "off">;
  result: AttemptResult;
  runUrl: string | undefined;
  failingStep?: string | undefined;
  /** Already redacted and capped by the digest. */
  excerpt?: string | undefined;
  /** For infra_error: the classified reason. Never the raw text. */
  infraClass?: InfraClass | undefined;
  /** For a job split across sandboxes: one line per shard (fixed words and numbers only). */
  shards?: readonly string[] | undefined;
};

/**
 * The summary. Fixed text, the real result, the failing step and the digest excerpt in a code
 * fence (so markdown, links and mentions in log text stay inert). Never more log than the digest.
 */
export function summaryFor(i: SummaryInput): string {
  const lines: string[] = [`**Result:** ${WORD[i.result]}`];
  if (i.mode === "shadow") {
    lines.push(
      "This is a shadow check: it is always neutral and never gates a merge. The result above is what Turntable found.",
    );
  }
  if (i.result === "infra_error") {
    lines.push(
      "Infrastructure error: the sandbox or the runner failed, so this says nothing about the code.",
    );
    lines.push(`Reason: ${i.infraClass ?? "internal"}. See the Turntable run for details.`);
  }
  if (i.shards && i.shards.length > 0)
    lines.push(`**Shards:**\n${i.shards.map((s) => `- ${s}`).join("\n")}`);
  if (i.failingStep) lines.push(`**Failing step:** ${plain(i.failingStep, 120)}`);
  if (i.runUrl) lines.push(`[Open the run in Turntable](${i.runUrl})`);
  if (i.excerpt) lines.push(fenced(i.excerpt));
  return lines.join("\n\n");
}
