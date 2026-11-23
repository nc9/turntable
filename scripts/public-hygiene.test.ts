// The repository is public: a customer's name must not appear in it. This fails when it does.
// The only allowed hits are files vendored verbatim from a public repository, which name that
// repository in their header (a public slug, cited for provenance).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Built at runtime so this file does not contain the name it looks for.
const NAME = new RegExp(["squir", "rel"].join(""), "i");

/** Files that may name the public repository they were vendored from. */
const ALLOWED = new Set([
  "packages/act-runner/tests/fixtures/vendored-ci.yml",
  "packages/act-runner/tests/fixtures/vendored-setup-bun.yml",
]);

/**
 * One line of the README may name the customer: the dogfooding statement that links the public
 * repository (the maintainer asked for it). Nothing else of theirs: no hosted URL, account or id.
 */
const ALLOWED_LINES: Record<string, RegExp> = {
  "README.md": new RegExp(["github.com/squir", "relscan/squir", "relscan"].join("")),
};

const SKIP = new Set(["node_modules", "dist", ".git", "coverage", ".tsbuildinfo"]);
const TEXT = /\.(ts|tsx|js|mjs|json|md|mdx|yml|yaml|toml|sh|css|html|txt|sql|dockerfile)$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e.endsWith(".tsbuildinfo")) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT.test(e) || e === "Dockerfile" || e === "LICENSE") out.push(p);
  }
  return out;
}

describe("public hygiene", () => {
  test("no customer name in packages, docs, scripts, examples, images or the workflows, outside the vendored fixtures", () => {
    const dirs = ["packages", "docs", "scripts", "examples", "images", ".github"].map((d) =>
      join(root, d),
    );
    const files = [
      ...dirs.flatMap((d) => {
        try {
          return walk(d);
        } catch {
          return [];
        }
      }),
      ...readdirSync(root)
        .filter((f) => /\.(md|json|toml|yml)$/.test(f))
        .map((f) => join(root, f)),
    ];
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of files) {
      const rel = f.slice(root.length + 1);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(f, "utf8");
      const only = ALLOWED_LINES[rel];
      const line = text.split("\n").findIndex((l) => NAME.test(l) && !only?.test(l));
      if (line >= 0) hits.push(`${rel}:${line + 1}`);
    }
    expect(hits).toEqual([]);
  });

  test("the allowed files exist, and are only vendored copies that cite their public source", () => {
    for (const rel of ALLOWED) {
      const head = readFileSync(join(root, rel), "utf8").split("\n", 1)[0]!;
      expect(head).toMatch(
        /^# Vendored from https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\//,
      );
    }
  });
});
