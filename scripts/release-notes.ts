// Drafts release notes from conventional commits between two refs, grouped by type, with breaking
// changes and the migration files added in the range listed on their own.
//
//   bun run scripts/release-notes.ts --to v0.1.0-alpha.2 [--from v0.1.0-alpha.1] [--out notes.md]
// Without --from it uses the tag before --to, or the first commit when there is none.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Commit = { sha: string; subject: string; body: string };
export type Parsed = {
  sha: string;
  type: string;
  scope: string;
  description: string;
  breaking: boolean;
  breakingNote: string | null;
};

const HEADER = /^(?<type>[a-z]+)\((?<scope>[^)]+)\)(?<bang>!)?: (?<desc>.+)$/;

export function parseCommit(c: Commit): Parsed | null {
  const m = HEADER.exec(c.subject);
  if (!m?.groups) return null;
  const note = /^BREAKING[ -]CHANGE: (.+(?:\n(?!\n).+)*)/m.exec(c.body)?.[1] ?? null;
  return {
    sha: c.sha,
    type: m.groups.type!,
    scope: m.groups.scope!,
    description: m.groups.desc!,
    breaking: m.groups.bang === "!" || note !== null,
    breakingNote: note?.replaceAll(/\s*\n\s*/g, " ") ?? null,
  };
}

export const SECTIONS: [type: string, heading: string][] = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["hotfix", "Hotfixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build and CI"],
  ["chore", "Maintenance"],
  ["style", "Style"],
  ["revert", "Reverts"],
];

export function groupCommits(parsed: Parsed[]): Map<string, Parsed[]> {
  const out = new Map<string, Parsed[]>();
  for (const [type] of SECTIONS) {
    const rows = parsed.filter((p) => p.type === type);
    if (rows.length > 0) out.set(type, rows);
  }
  return out;
}

const line = (p: Parsed): string => `- **${p.scope}:** ${p.description} (${p.sha.slice(0, 7)})`;

export function renderNotes(o: {
  template: string;
  version: string;
  from: string | null;
  commits: Commit[];
  migrations: string[];
  repo?: string;
}): string {
  const parsed = o.commits.map(parseCommit);
  const ok = parsed.filter((p): p is Parsed => p !== null);
  const skipped = parsed.length - ok.length;
  const groups = groupCommits(ok);
  const changes =
    [...groups.entries()]
      .map(([type, rows]) => {
        const heading = SECTIONS.find(([t]) => t === type)![1];
        return `### ${heading}\n\n${rows.map(line).join("\n")}`;
      })
      .join("\n\n") || "No conventional commits in this range.";
  const breaking = ok.filter((p) => p.breaking);
  const breakingText =
    breaking.length === 0
      ? "None."
      : breaking
          .map((p) => `${line(p)}${p.breakingNote ? `\n  ${p.breakingNote}` : ""}`)
          .join("\n");
  const migrationText =
    o.migrations.length === 0
      ? "No database migrations in this release."
      : `Applied automatically on start, in order. Take a backup first; migrations do not roll back.\n\n${o.migrations.map((m) => `- \`${m}\``).join("\n")}`;
  const compare =
    o.repo && o.from ? `https://github.com/${o.repo}/compare/${o.from}...v${o.version}` : "";
  return o.template
    .replaceAll("{{version}}", o.version)
    .replaceAll("{{changes}}", changes)
    .replaceAll("{{breaking}}", breakingText)
    .replaceAll("{{migrations}}", migrationText)
    .replaceAll("{{compare}}", compare ? `Full changelog: ${compare}` : "")
    .replaceAll(
      "{{skipped}}",
      skipped > 0 ? `${skipped} commit(s) without a conventional header were left out.` : "",
    );
}

async function git(args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim()}`);
  return out;
}

/** Commits in `from..to` (or everything up to `to`), oldest first. */
export async function readCommits(from: string | null, to: string): Promise<Commit[]> {
  const range = from ? `${from}..${to}` : to;
  const out = await git(["log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", range]);
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [sha, subject, body] = r.split("\x1f");
      return { sha: sha!, subject: subject!, body: (body ?? "").trim() };
    });
}

/** Migration SQL files added in the range. */
export async function readMigrations(from: string | null, to: string): Promise<string[]> {
  const base = from ?? (await git(["hash-object", "-t", "tree", "/dev/null"])).trim();
  const out = await git([
    "diff",
    "--name-only",
    "--diff-filter=A",
    base,
    to,
    "--",
    "packages/core/drizzle/*.sql",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .toSorted()
    .map((f) => f.replace(/^packages\/core\/drizzle\//, ""));
}

async function previousTag(to: string): Promise<string | null> {
  try {
    return (await git(["describe", "--tags", "--abbrev=0", `${to}^`])).trim();
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const { values } = parseArgs({
    options: {
      to: { type: "string" },
      from: { type: "string" },
      out: { type: "string" },
      repo: { type: "string", default: process.env.GITHUB_REPOSITORY ?? "turntable-ci/turntable" },
      template: { type: "string", default: join(root, ".github", "release-notes-template.md") },
    },
  });
  if (!values.to) throw new Error("usage: release-notes.ts --to <ref> [--from <ref>] [--out file]");
  const from = values.from ?? (await previousTag(values.to));
  const notes = renderNotes({
    template: readFileSync(values.template!, "utf8"),
    version: values.to.replace(/^v/, ""),
    from,
    commits: await readCommits(from, values.to),
    migrations: await readMigrations(from, values.to),
    ...(values.repo ? { repo: values.repo } : {}),
  });
  if (values.out) writeFileSync(values.out, notes);
  else process.stdout.write(notes);
}
