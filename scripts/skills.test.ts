// The setup skills must not drift from the code: every operation, TURNTABLE_* variable and
// `turntable <command>` they name has to exist. Also checks the frontmatter.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_VARS, NOT_CONFIGURATION } from "../packages/core/src/config-reference";
import { registry } from "../packages/core/src/ops";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "packages/core/src/main.ts"), "utf8");

export function skillFiles(): string[] {
  const dir = join(root, "skills");
  return readdirSync(dir)
    .filter((e) => statSync(join(dir, e)).isDirectory())
    .map((e) => join(dir, e, "SKILL.md"));
}

/** The problems in one skill's text: unknown operations, variables or commands. */
export function skillProblems(text: string): string[] {
  const ops = new Set(registry.ops.map((o) => o.name));
  const vars = new Set([...CONFIG_VARS.map((v) => v.name), ...NOT_CONFIGURATION]);
  const out: string[] = [];
  for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    if (!ops.has(m[1]!) && !NOT_OPERATIONS.has(m[1]!)) out.push(`unknown operation ${m[1]}`);
  }
  for (const m of text.matchAll(/TURNTABLE_[A-Z0-9_]*[A-Z0-9]/g)) {
    if (!vars.has(m[0])) out.push(`unknown variable ${m[0]}`);
  }
  for (const m of text.matchAll(/\bturntable ([a-z][a-z-]*)( [a-z][a-z-]*)?/g)) {
    // Only a command in backticks or a code block counts: prose like "turntable instance" does not.
    const at = m.index!;
    const line = text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at));
    if (!/`/.test(line) && !/^\s{2,}|^(\$ )?turntable /.test(line)) continue;
    if (!main.includes(`turntable ${m[1]} `) && !main.includes(`turntable ${m[1]}\n`))
      out.push(`unknown command turntable ${m[1]}`);
  }
  return out;
}

/** Backticked snake_case words that are not operations, such as settings keys, values, roles, GitHub events and tools. */
const NOT_OPERATIONS = new Set([
  "no_agents",
  "untrusted_run_approval",
  "release_operator",
  "pg_dump",
  "pull_request",
  "check_run",
]);

describe("setup skills", () => {
  const files = skillFiles();

  test("the three skills exist", () => {
    expect(files.map((f) => f.split("/").at(-2)).sort()).toEqual([
      "turntable-connect-agent",
      "turntable-github-app",
      "turntable-self-host",
    ]);
  });

  for (const f of files) {
    const rel = f.slice(root.length + 1);
    const text = readFileSync(f, "utf8");
    const dirName = f.split("/").at(-2)!;

    test(`${rel} has name and description frontmatter`, () => {
      const fm = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
      expect(fm).not.toBeNull();
      expect(fm![1]).toBe(dirName);
    });

    test(`${rel} opens with its secret rules`, () => {
      const first = text.split("\n## ")[1] ?? "";
      expect(first.toLowerCase()).toContain("secret rules");
    });

    test(`${rel} names only real operations, variables and commands`, () => {
      expect(skillProblems(text)).toEqual([]);
    });

    test(`${rel} has no em-dash`, () => {
      expect(text).not.toContain("—");
    });
  }

  test("the checker catches a made-up name", () => {
    const fake = ["`not_a_real_op`", "TURNTABLE_NOPE_VAR", "`turntable frobnicate now`"].join("\n");
    expect(skillProblems(fake)).toEqual([
      "unknown operation not_a_real_op",
      "unknown variable TURNTABLE_NOPE_VAR",
      "unknown command turntable frobnicate",
    ]);
  });
});
