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
 * `longshore / <job>` in live mode, plus the matrix leg when the job has one.
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
  return `${mode === "shadow" ? "shadow" : "longshore"} / ${plain(job.name)}${leg}`;
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
  return `${mode === "shadow" ? "Shadow" : "Longshore"}: ${WORD[result]}`;
}

export const RUNNING_TITLE = (mode: Exclude<ChecksMode, "off">): string =>
  `${mode === "shadow" ? "Shadow" : "Longshore"}: running`;

/** A code fence longer than any fence in the text, so the text cannot close it. */
export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export type SummaryInput = {
  mode: Exclude<ChecksMode, "off">;
  result: AttemptResult;
  runUrl: string | undefined;
  failingStep?: string | undefined;
  /** Already redacted and capped by the digest. */
  excerpt?: string | undefined;
  /** For infra_error: why. Already short. */
  infraReason?: string | undefined;
};

/**
 * The summary. Fixed text, the real result, the failing step and the digest excerpt in a code
 * fence (so markdown, links and mentions in log text stay inert). Never more log than the digest.
 */
export function summaryFor(i: SummaryInput): string {
  const lines: string[] = [`**Result:** ${WORD[i.result]}`];
  if (i.mode === "shadow") {
    lines.push(
      "This is a shadow check: it is always neutral and never gates a merge. The result above is what Longshore found.",
    );
  }
  if (i.result === "infra_error") {
    lines.push(
      "Infrastructure error: the sandbox or the runner failed, so this says nothing about the code.",
    );
    if (i.infraReason) lines.push(`Reason: ${plain(i.infraReason, 200)}`);
  }
  if (i.failingStep) lines.push(`**Failing step:** ${plain(i.failingStep, 120)}`);
  if (i.runUrl) lines.push(`[Open the run in Longshore](${i.runUrl})`);
  if (i.excerpt) lines.push(fenced(i.excerpt));
  return lines.join("\n\n");
}
