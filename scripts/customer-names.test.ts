// Guard: the repository is public, so it names no customer's infrastructure. A customer's name
// and the labels, projects and hosts of its CI never appear in code, docs, scripts or examples;
// examples use generic names (`project=acme-ci`).
//
// The one exception is a customer's PUBLIC open-source repository, which is a legitimate
// conformance corpus: workflow files copied from it, with their provenance. Those files are
// listed below with the reason, and the test checks that each still needs its entry.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
// Built from pieces so this file does not contain the name it forbids.
const NAME = new RegExp(["squir", "rel"].join(""), "i");
// Names of a customer's CI infrastructure: never allowed, even in an allowlisted file.
const INFRA = new RegExp(["squir", "rel-(ci|pub-ci|release)"].join(""), "i");

const ALLOWED = new Map<string, string>([
  [
    "packages/act-runner/tests/fixtures/corpus-ci.yml",
    "a workflow vendored verbatim from the customer's public MIT repository, with its source URL and commit",
  ],
  [
    "packages/act-runner/tests/fixtures/corpus-setup-bun.yml",
    "a composite action vendored verbatim from the same public repository",
  ],
]);

const SCAN_DIRS = ["packages", "docs", "scripts", "examples", ".github"];
const SCAN_FILES = ["README.md", "AGENTS.md", "CLAUDE.md", "package.json"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "data", ".turbo"]);
const TEXT = /\.(ts|tsx|mts|js|mjs|json|md|mdx|yml|yaml|toml|sh|css|html|txt|sql)$/;

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return TEXT.test(e.name) ? [p] : [];
  });
}

const files = [
  ...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...SCAN_FILES.map((f) => join(ROOT, f)),
]
  .map((f) => relative(ROOT, f))
  .filter((rel) => rel !== "scripts/customer-names.test.ts");

const read = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

test("no customer's name or infrastructure appears outside the listed public-corpus files", () => {
  const found = files.filter((rel) => !ALLOWED.has(rel) && NAME.test(read(rel)));
  expect(found).toEqual([]);
});

test("a customer's CI labels and project names appear nowhere, allowlisted files included", () => {
  expect(files.filter((rel) => INFRA.test(read(rel)))).toEqual([]);
});

test("each allowlisted file exists and still needs its entry", () => {
  for (const rel of ALLOWED.keys()) {
    expect(read(rel)).not.toBe("");
    expect(NAME.test(read(rel))).toBe(true);
  }
});

test("the scan covers the files it should", () => {
  expect(files.length).toBeGreaterThan(200);
  expect(files).toContain("packages/provider-daytona/src/policy.ts");
  expect(files).toContain("docs/providers.mdx");
});
