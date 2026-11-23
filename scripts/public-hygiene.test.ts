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
 * The README may name the customer on at most MAX_README_LINES lines, for the dogfooding statement
 * that links the public repository (the maintainer asked for it): only the public repo URL, its
 * `owner/name` link text and the bare name are taken out of such a line, and what is left must
 * still pass the normal check (so a hosted URL, an account, an id or a private repo name fails).
 * Built at runtime, like NAME.
 */
const BARE = ["squir", "relscan"].join("");
// Each token is taken out only as a whole: never followed by a word character or `-` (`name-ci`)
// or by `.` and a word character (`name.example`), and the bare name never preceded by a word
// character, `.`, `/` or `-` (`ci.name`, `/name`). A sentence-final `name.` still counts as whole.
const END = "(?![\\w-]|\\.\\w)";
const REPO_URL = new RegExp(`github\\.com/${BARE}/${BARE}${END}`, "gi");
const REPO_SLUG = new RegExp(`(?<![\\w./-])${BARE}/${BARE}${END}`, "gi");
const BARE_NAME = new RegExp(`(?<![\\w./-])${BARE}${END}`, "gi");
const MAX_README_LINES = 2;

/** `file:line` of each place `text` (the content of `rel`) names the customer when it may not. */
export function hygieneHits(rel: string, text: string): string[] {
  if (ALLOWED.has(rel)) return [];
  const hits: string[] = [];
  let allowedLines = 0;
  for (const [i, line] of text.split("\n").entries()) {
    if (!NAME.test(line)) continue;
    if (rel === "README.md") {
      const rest = line.replace(REPO_URL, "").replace(REPO_SLUG, "").replace(BARE_NAME, "");
      if (!NAME.test(rest)) {
        allowedLines += 1;
        if (allowedLines <= MAX_README_LINES) continue;
      }
    }
    hits.push(`${rel}:${i + 1}`);
  }
  return hits;
}

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
  test("no customer name in packages, docs, scripts, examples, images, skills, the plugin manifest or the workflows, outside the vendored fixtures", () => {
    const dirs = [
      "packages",
      "docs",
      "scripts",
      "examples",
      "images",
      "skills",
      ".github",
      "claude-plugin",
      ".claude-plugin",
    ].map((d) => join(root, d));
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
      hits.push(...hygieneHits(rel, readFileSync(f, "utf8")));
    }
    expect(hits).toEqual([]);
  });

  describe("the README exception is exactly the public repo link", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const urlLine = new RegExp(REPO_URL.source, "i");
    const real = readme.split("\n").find((l) => urlLine.test(l))!;
    const privateTerm = ["squir", "rel-ci"].join("");

    test("the real README passes", () => {
      expect(real).toBeDefined();
      expect(hygieneHits("README.md", readme)).toEqual([]);
    });
    test("the same line with a private-looking customer term fails", () => {
      expect(hygieneHits("README.md", `${real} Also see ${privateTerm}.`)).toEqual(["README.md:1"]);
      expect(hygieneHits("README.md", `${real}\nOur ${privateTerm} fleet.`)).toEqual([
        "README.md:2",
      ]);
    });
    test("the repo URL in any other file fails", () => {
      expect(hygieneHits("docs/x.mdx", real)).toEqual(["docs/x.mdx:1"]);
      expect(hygieneHits("CHANGELOG.md", real)).toEqual(["CHANGELOG.md:1"]);
    });
    test("the bare name passes only as a standalone word on the allowed line", () => {
      expect(hygieneHits("README.md", `${real} Thanks to ${BARE}.`)).toEqual([]); // sentence-final
      for (const bad of [
        `https://ci.${BARE}.example`, // a hosted URL
        `${BARE}-ci`, // a private-looking name
        `/${BARE}`, // a path
        `github.com/${BARE}/${BARE}-ci`, // a private repo under the same owner
      ])
        expect(hygieneHits("README.md", `${real} ${bad}`), bad).toEqual(["README.md:1"]);
    });
    test("two such README lines pass and a third fails", () => {
      expect(hygieneHits("README.md", [real, real].join("\n"))).toEqual([]);
      expect(hygieneHits("README.md", [real, real, real].join("\n"))).toEqual(["README.md:3"]);
    });
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
