// Builds the deploy note (a GitHub Deployment description and a comment on the deploy log issue).
import type { MigrationClass } from "./migrations";

export interface NotesInput {
  deployedSha: string | null;
  targetSha: string;
  prs: { number: number; title: string }[];
  migrations: MigrationClass[];
  backupId: string | null;
  timings: { backupMs?: number; deployMs?: number; verifyMs?: number };
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
  return `${lines.join("\n")}\n`;
}
