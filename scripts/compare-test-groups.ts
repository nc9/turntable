// Proves a change to the test wiring kept the same tests: resolves every `test:*` script of the
// package.json at a git ref (the old one-line `bun test <files>` form, or the group-file form)
// and of the working tree, and compares env prefix, file list and order per script.
//
//   bun scripts/compare-test-groups.ts origin/main
import { parseGroupCall, parseGroupFile, readGroup } from "./test-groups";

interface Resolved {
  env: string[];
  files: string[];
}

/** Returns the files of a group, or throws when the group file does not exist. */
export type GroupReader = (group: string) => string[];

/** Reads group files from the working tree at `repo`. */
export function worktreeReader(repo: string): GroupReader {
  return (group) => readGroup(group, repo);
}

/** Reads group files as committed at `ref`, so a changed working tree cannot leak into the ref side. */
export function gitReader(ref: string, repo: string): GroupReader {
  return (group) => {
    const path = `scripts/test-groups/${group}.txt`;
    const r = Bun.spawnSync(["git", "show", `${ref}:${path}`], { cwd: repo });
    if (r.exitCode !== 0) throw new Error(`test group ${group}: no ${path} at ${ref}`);
    return parseGroupFile(group, r.stdout.toString());
  };
}

/** Resolves one script command, from group files via `read` or from the inline `bun test` list. */
export function resolveCommand(
  cmd: string,
  repo: string,
  read: GroupReader = worktreeReader(repo),
): Resolved {
  const call = parseGroupCall(cmd);
  if (call) return { env: call.env, files: read(call.group) };
  const words = cmd.trim().split(/\s+/);
  const at = words.indexOf("bun");
  if (at < 0 || words[at + 1] !== "test") throw new Error(`unrecognised test script: ${cmd}`);
  return { env: words.slice(0, at), files: words.slice(at + 2) };
}

/** The differences between two resolved script maps, one line each. Empty means identical. */
export function diff(before: Map<string, Resolved>, after: Map<string, Resolved>): string[] {
  const out: string[] = [];
  for (const k of before.keys()) if (!after.has(k)) out.push(`${k}: removed`);
  for (const k of after.keys()) if (!before.has(k)) out.push(`${k}: added`);
  for (const [k, a] of before) {
    const b = after.get(k);
    if (!b) continue;
    if (a.env.join(" ") !== b.env.join(" "))
      out.push(`${k}: env ${a.env.join(" ")} -> ${b.env.join(" ")}`);
    if (a.files.join("\n") !== b.files.join("\n"))
      out.push(`${k}: files differ (${a.files.length} -> ${b.files.length})`);
  }
  return out;
}

const scriptsOf = (json: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries((JSON.parse(json) as { scripts: Record<string, string> }).scripts).filter(
      ([k]) => k.startsWith("test:"),
    ),
  );

const load = (json: string, repo: string, read: GroupReader): Map<string, Resolved> =>
  new Map(Object.entries(scriptsOf(json)).map(([k, v]) => [k, resolveCommand(v, repo, read)]));

/** Compares the scripts and group files at `ref` with the working tree. Empty means identical. */
export async function compareToRef(
  ref: string,
  repo: string,
): Promise<{ problems: string[]; after: Map<string, Resolved> }> {
  const git = Bun.spawnSync(["git", "show", `${ref}:package.json`], { cwd: repo });
  if (git.exitCode !== 0) throw new Error(`git show ${ref}:package.json failed`);
  const before = load(git.stdout.toString(), repo, gitReader(ref, repo));
  const after = load(await Bun.file(`${repo}/package.json`).text(), repo, worktreeReader(repo));
  return { problems: diff(before, after), after };
}

if (import.meta.main) {
  const ref = process.argv[2];
  if (!ref) throw new Error("usage: compare-test-groups.ts <git-ref>");
  const repo = new URL("..", import.meta.url).pathname;
  const { problems, after } = await compareToRef(ref, repo);
  const total = [...after.values()].reduce((n, g) => n + g.files.length, 0);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(
    `identical: ${after.size} scripts, ${total} file entries, same env prefixes and order`,
  );
}
