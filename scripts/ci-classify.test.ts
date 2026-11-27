import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classify, classifyRange, JOBS, readWorkspaceGraph, type Job } from "./ci-classify";

const graph = readWorkspaceGraph(join(import.meta.dir, ".."));
const run = (files: string[]): Job[] => {
  const c = classify(files, graph);
  return JOBS.filter((j) => c.jobs[j].run);
};

describe("workspace graph", () => {
  test("reverse dependents are included", () => {
    expect(graph.core).toContain("proxy");
    expect(graph.proxy).toContain("redact");
  });
});

// Example diffs: files changed -> the jobs that run.
const EXAMPLES: [string, string[], Job[]][] = [
  ["ui only: no postgres, no act-runner e2e", ["packages/ui/src/router.tsx"], ["check", "docker"]],
  [
    "db change runs postgres and the core jobs",
    ["packages/core/src/db/schema.ts"],
    ["check", "postgres", "postgres-pglite", "release-golden", "act-runner-e2e", "docker"],
  ],
  [
    "redact reaches core through proxy",
    ["packages/redact/src/index.ts"],
    ["check", "postgres", "postgres-pglite", "release-golden", "act-runner-e2e", "docker"],
  ],
  [
    "provider-sdk reaches provider-docker and core",
    ["packages/provider-sdk/src/index.ts"],
    [
      "check",
      "postgres",
      "postgres-pglite",
      "release-golden",
      "provider-docker",
      "act-runner-e2e",
      "docker",
    ],
  ],
  ["docs prose: docs job only", ["docs/quickstart.mdx", "README.md"], ["docs"]],
  ["root markdown: docs job only", ["AGENTS.md"], ["docs"]],
  ["generated docs file also runs check", ["docs/openapi.json"], ["check", "docs"]],
  [
    "compatibility table runs runner-image",
    ["docs/compatibility.mdx"],
    ["check", "runner-image", "docs"],
  ],
  ["runner image input", ["images/runner/Dockerfile"], ["check", "runner-image", "docker"]],
  ["lane config only runs check", [".longshore/config.toml"], ["check"]],
];

describe("example diffs", () => {
  for (const [name, files, want] of EXAMPLES) {
    test(name, () => {
      expect(run(files)).toEqual(JOBS.filter((j) => want.includes(j)));
    });
  }

  test("every skipped and run job has a reason", () => {
    const c = classify(["packages/ui/src/a.ts"], graph);
    for (const j of JOBS) expect(c.jobs[j].reason.length).toBeGreaterThan(0);
    expect(c.affected.ui).toBe("files changed");
  });
});

describe("global inputs widen to everything", () => {
  for (const f of [
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
    "bunfig.toml",
    "Dockerfile",
    ".github/workflows/ci.yml",
    "scripts/ci-classify.ts",
  ]) {
    test(f, () => {
      const c = classify(["docs/a.mdx", f], graph);
      expect(c.all).toBe(true);
      expect(run([f])).toEqual([...JOBS]);
      expect(c.jobs.docs.reason).toContain(f);
    });
  }
});

describe("fail open", () => {
  test("empty diff", () => expect(run([])).toEqual([...JOBS]));
  test("unknown top-level path", () => expect(run(["mystery/file.txt"])).toEqual([...JOBS]));
  test("file in an unknown package directory", () =>
    expect(run(["packages/new-pkg/a.ts"])).toEqual([...JOBS]));
  test("a git error runs everything", () => {
    const c = classifyRange(join(import.meta.dir, ".."), "0".repeat(40), "f".repeat(40));
    expect(c.all).toBe(true);
    expect(JOBS.every((j) => c.jobs[j].run && c.jobs[j].reason.startsWith("fail open"))).toBe(true);
  });
  test("non-sha arguments run everything", () => {
    expect(classifyRange(join(import.meta.dir, ".."), "--output=x", "HEAD").all).toBe(true);
  });
});
