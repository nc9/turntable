// Classifies a diff into the CI jobs it needs (#776, phase 1: report-only).
//
//   bun scripts/ci-classify.ts --base <sha> --head <sha> [--json]
//
// The merge_group run calls it with `merge_group.base_sha..head_sha` and prints what it WOULD skip;
// it does not change which jobs run. The rules, in order:
//   1. an empty diff, a git error or an unknown top-level path fails open: every job runs;
//   2. a global input (lockfile, root package.json, tsconfig base, bunfig, formatter config,
//      Dockerfile and toolchain pins, .github/**, scripts/**) widens to every job;
//   3. a docs-only diff (docs/**, *.md, *.mdx) runs the docs job only, plus the job that checks a
//      generated page or file when one of those changed;
//   4. a file under packages/<name>/ affects that workspace and, through the bun workspace graph
//      (dependencies, devDependencies, peerDependencies), every workspace that depends on it.
// Jobs are the ci.yml job names. Every entry carries the reason it runs or is skipped.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const JOBS = [
  "check",
  "postgres",
  "postgres-pglite",
  "release-golden",
  "provider-docker",
  "act-runner-e2e",
  "runner-image",
  "docker",
  "dep-age",
  "docs",
] as const;
export type Job = (typeof JOBS)[number];

/** workspace name (the directory under packages/) to the workspaces it depends on. */
export type WorkspaceGraph = Record<string, string[]>;

export interface Classification {
  /** True when the whole pipeline runs (global input or fail-open). */
  all: boolean;
  /** Workspaces affected, each with the reason. */
  affected: Record<string, string>;
  /** Every job, run or skipped, with the reason. */
  jobs: Record<Job, { run: boolean; reason: string }>;
}

const GLOBAL_EXACT = new Set([
  "bun.lock",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "bunfig.toml",
  ".prettierrc.json",
  ".prettierignore",
  ".editorconfig",
  ".dockerignore",
  ".bun-version",
  ".tool-versions",
  "Dockerfile",
]);
const GLOBAL_PREFIX = [".github/", "scripts/"];
/** Not code: a change here is never more than the check job. */
const CHECK_ONLY_PREFIX = [".longshore/"];
/** Folders whose files the core test groups and the e2e job read. */
const CORE_PREFIX = ["examples/", "skills/", "claude-plugin/", ".claude-plugin/"];
/** Generated docs files that the check job verifies. */
const GENERATED_DOCS = new Set([
  "docs/openapi.json",
  "docs/mcp-tools.json",
  "docs/configuration.mdx",
  "docs/agent-interface.mdx",
  "docs/compatibility.mdx",
]);

const isDocFile = (f: string): boolean => f.startsWith("docs/") || /\.mdx?$/.test(f);

/** Reads the workspace graph from packages/*\/package.json. Throws on a malformed file. */
export function readWorkspaceGraph(root: string): WorkspaceGraph {
  const dirs = readdirSync(join(root, "packages"), { withFileTypes: true }).filter(
    (d) => d.isDirectory() && existsSync(join(root, "packages", d.name, "package.json")),
  );
  const names = new Map<string, string>(); // package name -> directory
  const pkgs = dirs.map((d) => {
    const json = JSON.parse(
      readFileSync(join(root, "packages", d.name, "package.json"), "utf8"),
    ) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (json.name) names.set(json.name, d.name);
    return { dir: d.name, json };
  });
  const graph: WorkspaceGraph = {};
  for (const { dir, json } of pkgs) {
    const all = { ...json.peerDependencies, ...json.devDependencies, ...json.dependencies };
    graph[dir] = Object.keys(all)
      .map((n) => names.get(n))
      .filter((n): n is string => n !== undefined && n !== dir);
  }
  return graph;
}

/** Direct changes plus every transitive dependent, each with why. */
function affectedWorkspaces(direct: Set<string>, graph: WorkspaceGraph): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of direct) out[w] = "files changed";
  for (let grew = true; grew;) {
    grew = false;
    for (const [w, deps] of Object.entries(graph)) {
      if (out[w]) continue;
      const via = deps.find((d) => out[d]);
      if (via) {
        out[w] = `depends on ${via}`;
        grew = true;
      }
    }
  }
  return out;
}

export function classify(files: string[], graph: WorkspaceGraph): Classification {
  const failOpen = (why: string): Classification => ({
    all: true,
    affected: Object.fromEntries(Object.keys(graph).map((w) => [w, why])),
    jobs: Object.fromEntries(
      JOBS.map((j) => [j, { run: true, reason: why }]),
    ) as Classification["jobs"],
  });
  if (files.length === 0) return failOpen("fail open: empty diff");

  const direct = new Set<string>();
  let docsOnly = true;
  let anyCode = false;
  const extra = new Set<Job>(); // jobs a specific path forces
  const extraWhy = new Map<Job, string>();
  const force = (j: Job, why: string): void => {
    extra.add(j);
    if (!extraWhy.has(j)) extraWhy.set(j, why);
  };

  for (const f of files) {
    if (GLOBAL_EXACT.has(f) || GLOBAL_PREFIX.some((p) => f.startsWith(p)))
      return failOpen(`global input: ${f}`);
    if (f.startsWith("packages/")) {
      const dir = f.split("/")[1] ?? "";
      if (!(dir in graph)) return failOpen(`fail open: ${f} is in no known workspace`);
      direct.add(dir);
      docsOnly = false;
      anyCode = true;
      continue;
    }
    if (isDocFile(f)) {
      if (GENERATED_DOCS.has(f)) force("check", `generated docs file: ${f}`);
      if (f === "docs/compatibility.mdx") force("runner-image", `compatibility table: ${f}`);
      force("docs", `docs file: ${f}`);
      continue;
    }
    docsOnly = false;
    if (f.startsWith("images/")) {
      force("runner-image", `runner image input: ${f}`);
      force("check", `non-doc file: ${f}`);
      anyCode = true;
    } else if (CORE_PREFIX.some((p) => f.startsWith(p))) {
      direct.add("core");
      anyCode = true;
    } else if (CHECK_ONLY_PREFIX.some((p) => f.startsWith(p))) {
      force("check", `lane config: ${f}`);
    } else if (f === "LICENSE" || f === ".gitignore") {
      force("check", `non-doc file: ${f}`);
    } else {
      return failOpen(`fail open: unknown path ${f}`);
    }
  }

  const affected = affectedWorkspaces(direct, graph);
  const has = (w: string): boolean => w in affected;
  const jobs = {} as Classification["jobs"];
  const decide = (j: Job, run: boolean, reason: string): void => {
    jobs[j] = extra.has(j) ? { run: true, reason: extraWhy.get(j) ?? reason } : { run, reason };
  };

  const skipDocs = "docs-only diff";
  const skipUnaffected = (w: string): string => `${w} not affected`;
  decide("check", anyCode, anyCode ? "code or config changed" : skipDocs);
  const coreHit = has("core");
  for (const j of ["postgres", "postgres-pglite", "release-golden"] as const) {
    decide(
      j,
      coreHit,
      coreHit ? `core ${affected.core}` : docsOnly ? skipDocs : skipUnaffected("core"),
    );
  }
  const pd = ["provider-docker", "provider-conformance", "provider-sdk"].find(has);
  decide(
    "provider-docker",
    pd !== undefined,
    pd
      ? `${pd} ${affected[pd]}`
      : docsOnly
        ? skipDocs
        : "provider-docker, provider-conformance and provider-sdk not affected",
  );
  decide(
    "act-runner-e2e",
    coreHit,
    coreHit ? `core ${affected.core}` : docsOnly ? skipDocs : skipUnaffected("core"),
  );
  decide("runner-image", false, docsOnly ? skipDocs : "no runner image input");
  decide("docker", anyCode, anyCode ? "the image builds every package" : skipDocs);
  decide("dep-age", false, docsOnly ? skipDocs : "no dependency input");
  decide("docs", false, "no docs file changed");
  return { all: false, affected, jobs };
}

/** Plain-text report: the affected set, then each job with its reason. */
export function formatReport(c: Classification): string {
  const lines = [`mode: ${c.all ? "everything" : "scoped"}`];
  const w = Object.entries(c.affected);
  lines.push(`affected workspaces: ${w.length === 0 ? "none" : ""}`);
  for (const [k, v] of w) lines.push(`  ${k}: ${v}`);
  lines.push("jobs:");
  for (const j of JOBS)
    lines.push(`  ${c.jobs[j].run ? "RUN " : "SKIP"} ${j}: ${c.jobs[j].reason}`);
  return lines.join("\n");
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Never throws: any error becomes a run-everything result. */
export function classifyRange(root: string, base: string, head: string): Classification {
  try {
    if (!/^[0-9a-f]{7,64}$/.test(base) || !/^[0-9a-f]{7,64}$/.test(head))
      throw new Error("base and head must be shas");
    const files = git(root, "diff", "--no-renames", "--name-only", base, head)
      .split("\n")
      .filter((l) => l !== "");
    return classify(files, readWorkspaceGraph(root));
  } catch (e) {
    const why = `fail open: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
    return {
      all: true,
      affected: {},
      jobs: Object.fromEntries(
        JOBS.map((j) => [j, { run: true, reason: why }]),
      ) as Classification["jobs"],
    };
  }
}

if (import.meta.main) {
  const arg = (n: string): string | undefined => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const c = classifyRange(join(import.meta.dir, ".."), arg("--base") ?? "", arg("--head") ?? "");
  console.log(process.argv.includes("--json") ? JSON.stringify(c, null, 2) : formatReport(c));
}
