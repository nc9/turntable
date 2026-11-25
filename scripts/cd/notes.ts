// Builds the deploy note (a GitHub Deployment description and a comment on the deploy log issue).
import type { MigrationClass } from "./migrations";

export interface NotesInput {
  deployedSha: string | null;
  targetSha: string;
  prs: { number: number; title: string }[];
  migrations: MigrationClass[];
  backupId: string | null;
  timings: { backupMs?: number; deployMs?: number; verifyMs?: number };
  /**
   * How many running attempts the drain cut and requeued, when it cut any. A COUNT only: this note
   * is public, so it never names an org, project, run or job. The named list belongs in the
   * private rollout log.
   */
  cutAttempts?: number;
}

/** Renders text as text: markdown control characters escaped, one line, mentions defused. */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]()#+\-.!|<>~&:]/g, "\\$&")
    .replace(/@/g, "&#64;");
}

const short = (sha: string): string => sha.slice(0, 12);
const secs = (ms: number | undefined): string =>
  ms === undefined ? "n/a" : `${Math.round(ms / 1000)}s`;

export function buildNotes(n: NotesInput): string {
  const lines: string[] = [];
  lines.push(`Deployed \`${short(n.targetSha)}\``);
  lines.push(n.deployedSha ? `Previous: \`${short(n.deployedSha)}\`` : "Previous: none");
  lines.push("", "### Merged pull requests", "");
  if (n.prs.length === 0) lines.push("None.");
  for (const pr of n.prs) lines.push(`- #${pr.number} ${escapeMarkdown(pr.title)}`);
  lines.push("", "### Migrations", "");
  if (n.migrations.length === 0) lines.push("None.");
  for (const m of n.migrations) {
    lines.push(
      `- ${m.dialect}/\`${m.tag}\`: ${m.additive ? "additive" : "NOT additive"} (${escapeMarkdown(m.reason)})`,
    );
  }
  lines.push("", `Backup: ${n.backupId ? `\`${n.backupId.replace(/[^\w-]/g, "")}\`` : "none"}`);
  lines.push(
    `Timings: backup ${secs(n.timings.backupMs)}, deploy ${secs(n.timings.deployMs)}, verify ${secs(n.timings.verifyMs)}`,
  );
  if (n.cutAttempts !== undefined && n.cutAttempts > 0) {
    const c = Math.floor(n.cutAttempts);
    lines.push("", `${c} running ${c === 1 ? "attempt was" : "attempts were"} cut and requeued`);
  }
  return `${lines.join("\n")}\n`;
}

/** The note for an automatic rollback: `rolled back <target> to <previous>: <reason>`. */
export function buildRollbackNote(r: {
  targetSha: string;
  previousSha: string;
  reason: string;
}): string {
  return `rolled back \`${short(r.targetSha)}\` to \`${short(r.previousSha)}\`: ${escapeMarkdown(r.reason)}\n`;
}
