// Test groups: each `test:<group>` script in package.json is a short call to
// scripts/run-test-group.ts, and the files of the group live in scripts/test-groups/<group>.txt,
// one path per line (blank lines and `#` comment lines are ignored). Keeping the lists out of
// package.json means two pull requests that add a file to the same group edit different lines
// instead of the same one-line script.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** `[ENV=value ...] bun scripts/run-test-group.ts <group>`: the env prefix stays in the script. */
const GROUP_CALL = /^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)bun scripts\/run-test-group\.ts (\S+)$/;

export interface GroupCall {
  /** The `NAME=value` words before `bun`, empty for most groups. */
  env: string[];
  group: string;
}

/** The group a package.json script calls, or undefined when it is not a group call. */
export function parseGroupCall(cmd: string): GroupCall | undefined {
  const m = GROUP_CALL.exec(cmd.trim());
  if (!m) return undefined;
  return { env: (m[1] ?? "").split(/\s+/).filter(Boolean), group: m[2]! };
}

/** The test files of a group, in file order. Throws when the group file is missing or empty. */
export function readGroup(group: string, repo: string = root): string[] {
  const file = join(repo, "scripts", "test-groups", `${group}.txt`);
  if (!existsSync(file)) throw new Error(`no test group file: scripts/test-groups/${group}.txt`);
  const files = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (files.length === 0) throw new Error(`test group ${group} lists no files`);
  return files;
}

/** The root `test:*` scripts as name to command. */
export function testScripts(repo: string = root): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return Object.fromEntries(Object.entries(pkg.scripts).filter(([k]) => k.startsWith("test:")));
}

/** Every `test:*` script resolved to its env prefix and file list. */
export function resolveGroups(
  repo: string = root,
): Map<string, { env: string[]; files: string[] }> {
  const out = new Map<string, { env: string[]; files: string[] }>();
  for (const [name, cmd] of Object.entries(testScripts(repo))) {
    const call = parseGroupCall(cmd);
    if (!call) throw new Error(`${name} is not a run-test-group call: ${cmd}`);
    out.set(name, { env: call.env, files: readGroup(call.group, repo) });
  }
  return out;
}
