import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_VARS, NOT_CONFIGURATION } from "../packages/core/src/config-reference";
import { settingsRegistry } from "../packages/core/src/settings/definitions";
import { applyReference } from "./config-reference";

const root = join(import.meta.dir, "..");

/** Source files (not tests, not node_modules) of every package, plus the build scripts. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "tests" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("configuration reference", () => {
  test("every TURNTABLE_* variable the source names is in the reference", () => {
    const files = [
      ...readdirSync(join(root, "packages")).flatMap((p) => {
        try {
          return sources(join(root, "packages", p, "src"));
        } catch {
          return [];
        }
      }),
      join(root, "scripts/build.ts"),
    ];
    const known = new Set([...CONFIG_VARS.map((v) => v.name), ...NOT_CONFIGURATION]);
    const missing = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/TURNTABLE_[A-Z0-9_]*[A-Z0-9]/g)) {
        if (!known.has(m[0])) missing.add(`${m[0]} (${f.slice(root.length + 1)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  test("no variable is listed twice and every flag looks like one", () => {
    const names = CONFIG_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of CONFIG_VARS) if (v.flag) expect(v.flag).toMatch(/^--[a-z-]+$/);
  });

  test("docs/configuration.mdx holds the current table", () => {
    const doc = readFileSync(join(root, "docs/configuration.mdx"), "utf8");
    expect(applyReference(doc)).toBe(doc);
    for (const v of CONFIG_VARS) expect(doc).toContain(`\`${v.name}\``);
  });

  test("every setting of the registry is listed with its scope, role, MCP rule and names", () => {
    const doc = readFileSync(join(root, "docs/configuration.mdx"), "utf8");
    for (const d of settingsRegistry.settings) {
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${d.key}\` |`));
      expect(row, `no row for setting ${d.key}`).toBeDefined();
      expect(row).toContain(`| ${d.scope} |`);
      expect(row).toContain(
        d.strictness
          ? `| ${d.role} may tighten, instance_admin may loosen (strictness, least to most strict: ${d.strictness.map((v) => `\`${v}\``).join(" < ")}) |`
          : d.instanceAdminOnly
            ? "| instance_admin (`instanceAdminOnly`) |"
            : `| ${d.role} |`,
      );
      expect(row).toContain(d.mcpEditable ? "| yes |" : "| no: ");
      for (const e of d.env) expect(row).toContain(`\`${e}\``);
      expect(row).toContain(d.toml.split(".").at(-1)!);
    }
  });
});
