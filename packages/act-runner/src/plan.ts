import { parse } from "yaml";
import { layoutFor, type Layout } from "./layout";

/** A workflow feature that M0 refuses, named so the user can see why. */
export class PlanError extends Error {
  readonly feature: string;
  constructor(feature: string, message: string) {
    super(message);
    this.name = "PlanError";
    this.feature = feature;
  }
}

export interface PlanOptions {
  /** Workflow file path relative to the repo root, for `-W`. */
  workflowPath: string;
  /** act event name. Default `push`. */
  event?: string;
  /** Sandbox root dir. Default `/tmp/tt-act`. */
  root?: string;
  /**
   * Reads a repo file (path relative to the repo root) so local composite actions can be scanned
   * for remote actions and untrusted expressions. Return undefined when the file is missing.
   */
  readFile?: (path: string) => string | undefined;
}

export interface PlannedAction {
  /** The `uses:` string as written, for example `actions/checkout@v4`. */
  uses: string;
  /** `owner/repo` */
  repo: string;
  /** Path inside the repo, empty for the root action. */
  subpath: string;
  /** The tag, branch or sha as written. */
  ref: string;
  /** Commit sha. Known up front when `ref` is a full sha; otherwise filled by resolveActions. */
  sha?: string;
  /** `checkout` is replaced by the stub; `remote` is delivered by sha. */
  kind: "checkout" | "remote";
  /** Where the action lives in the sandbox. */
  dir: string;
}

/** A repo file the plan owns: the workflow and any local composite actions it reaches. */
export interface PlanFile {
  /** Path relative to the repo root. */
  path: string;
  /** Original text. */
  source: string;
  /** Text with every `uses: owner/repo@ref` rewritten to `@sha`. Same as source until resolved. */
  text: string;
}

/** A step that interpolates attacker-controllable context straight into a script. */
export interface PlanWarning {
  code: "untrusted-expression";
  /** File the step is in. */
  file?: string;
  step: string;
  expression: string;
  message: string;
}

export interface JobPlan {
  jobId: string;
  workflowPath: string;
  layout: Layout;
  /** Every `actions/checkout@<ref>` used by the job, to be stubbed. */
  checkoutRefs: string[];
  /** Stub dir for each checkout ref, same order. */
  stubDirs: string[];
  /**
   * Every remote action the job uses, with its commit sha (the tag-to-sha mapping). Run
   * resolveActions before runJob; runJob refuses an unresolved remote action.
   */
  actions: PlannedAction[];
  /** Runner labels the job asks for. */
  labels: string[];
  /** act event name. */
  event: string;
  /** Files to overwrite in the delivered repo so every `uses:` is pinned to its sha. */
  files: PlanFile[];
  /** Non-fatal findings. Failing lints come later. */
  warnings: PlanWarning[];
  /** Full command: act binary then args. Run with cwd = layout.repo. */
  argv: string[];
  cwd: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function runsOnLabels(runsOn: unknown): string[] {
  if (typeof runsOn === "string") return [runsOn];
  if (Array.isArray(runsOn) && runsOn.every((x) => typeof x === "string")) return runsOn;
  if (isObj(runsOn)) {
    const l = runsOn.labels;
    if (typeof l === "string") return [l];
    if (Array.isArray(l) && l.every((x) => typeof x === "string")) return l;
    throw new PlanError("runs-on group", "runs-on with a group and no labels is not supported");
  }
  throw new PlanError("runs-on", "runs-on is missing or has an unsupported shape");
}

const isLinuxLabel = (l: string): boolean => /^(ubuntu(-|$)|linux$|self-hosted$)/.test(l);

/**
 * Validates one job for M0 and builds the act command. Rejects, naming the feature: needs,
 * services, container, non-Linux runs-on, docker:// actions, matrix and reusable workflows.
 */
export function planJob(workflowYaml: string, jobId: string, opts: PlanOptions): JobPlan {
  let doc: unknown;
  try {
    doc = parse(workflowYaml);
  } catch (e) {
    throw new PlanError("yaml", `workflow is not valid YAML: ${(e as Error).message}`);
  }
  const jobs = isObj(doc) ? doc.jobs : undefined;
  if (!isObj(jobs)) throw new PlanError("jobs", "workflow has no jobs");
  const job = jobs[jobId];
  if (!isObj(job)) throw new PlanError("job", `no job "${jobId}" in workflow`);

  const needs = job.needs;
  if (needs !== undefined && !(Array.isArray(needs) && needs.length === 0)) {
    throw new PlanError("needs", `job "${jobId}" uses needs; dependent jobs arrive in M1`);
  }
  if (job.uses !== undefined) {
    throw new PlanError("reusable workflow", `job "${jobId}" calls a reusable workflow (uses)`);
  }
  if (job.services !== undefined) {
    throw new PlanError("services", `job "${jobId}" uses services; act host mode ignores them`);
  }
  if (job.container !== undefined) {
    throw new PlanError("container", `job "${jobId}" uses container; host mode cannot run it`);
  }
  if (isObj(job.strategy) && job.strategy.matrix !== undefined) {
    throw new PlanError("matrix", `job "${jobId}" uses a matrix; matrices arrive in M1`);
  }

  const labels = runsOnLabels(job["runs-on"]);
  for (const l of labels) {
    if (l.includes("${{")) {
      throw new PlanError("runs-on expression", `runs-on "${l}" is an expression`);
    }
    if (!isLinuxLabel(l)) {
      throw new PlanError("non-Linux runs-on", `runs-on "${l}" is not a Linux runner`);
    }
  }

  const layout = layoutFor(opts.root);
  const actions: PlannedAction[] = [];
  const warnings: PlanWarning[] = [];
  const files: PlanFile[] = [{ path: opts.workflowPath, source: workflowYaml, text: workflowYaml }];
  const seenLocal = new Set<string>();

  const scan = (file: string, steps: unknown[], depth: number): void => {
    for (const [i, s] of steps.entries()) {
      if (!isObj(s)) continue;
      const stepName = typeof s.name === "string" ? s.name : `step ${i + 1}`;
      const found: PlanWarning[] = [];
      if (typeof s.run === "string") found.push(...untrustedIn(stepName, s.run));
      if (isObj(s.with) && typeof s.with.script === "string") {
        found.push(...untrustedIn(stepName, s.with.script));
      }
      warnings.push(...found.map((w) => ({ ...w, file })));
      if (typeof s.uses !== "string") continue;
      const uses = s.uses.trim();
      if (uses.startsWith("docker://")) {
        throw new PlanError(
          "docker:// action",
          `step uses ${uses}; docker actions are unsupported`,
        );
      }
      if (uses.startsWith("./")) {
        scanLocal(uses.replace(/^\.\//, "").replace(/\/$/, ""), depth + 1);
        continue;
      }
      if (uses.startsWith("../")) continue;
      if (actions.some((a) => a.uses === uses)) continue;
      const m = /^([^/@\s]+\/[^/@\s]+)((?:\/[^@\s]+)?)@(\S+)$/.exec(uses);
      if (!m) throw new PlanError("action ref", `cannot parse action reference "${uses}"`);
      const [, repo = "", subpath = "", ref = ""] = m;
      const kind = uses.startsWith("actions/checkout@") ? "checkout" : "remote";
      actions.push({
        uses,
        repo,
        subpath: subpath.replace(/^\//, ""),
        ref,
        ...(/^[0-9a-f]{40}$/.test(ref) ? { sha: ref } : {}),
        kind,
        dir: `${layout.stubs}/${kind === "checkout" ? "checkout" : "action"}-${actions.length}`,
      });
    }
  };

  const scanLocal = (dir: string, depth: number): void => {
    if (depth > 5 || seenLocal.has(dir) || !opts.readFile) return;
    seenLocal.add(dir);
    for (const name of ["action.yml", "action.yaml"]) {
      const path = `${dir}/${name}`;
      const text = opts.readFile(path);
      if (text === undefined) continue;
      files.push({ path, source: text, text });
      let doc2: unknown;
      try {
        doc2 = parse(text);
      } catch (e) {
        throw new PlanError("yaml", `${path} is not valid YAML: ${(e as Error).message}`);
      }
      const runs = isObj(doc2) ? doc2.runs : undefined;
      if (isObj(runs) && runs.using === "composite" && Array.isArray(runs.steps)) {
        scan(path, runs.steps, depth);
      }
      return;
    }
  };

  scan(opts.workflowPath, Array.isArray(job.steps) ? job.steps : [], 0);
  const plan: JobPlan = {
    jobId,
    workflowPath: opts.workflowPath,
    layout,
    checkoutRefs: actions.filter((a) => a.kind === "checkout").map((a) => a.uses),
    stubDirs: actions.filter((a) => a.kind === "checkout").map((a) => a.dir),
    actions,
    files,
    warnings,
    labels,
    event: opts.event ?? "push",
    argv: [],
    cwd: layout.repo,
  };
  return withArgv(plan);
}

/** Builds the act command. Remote actions are keyed by sha once known, else by the written ref. */
function withArgv(plan: JobPlan): JobPlan {
  const argv = [
    plan.layout.act,
    plan.event,
    "-W",
    plan.workflowPath,
    "-j",
    plan.jobId,
    ...plan.labels.filter((l) => l !== "self-hosted").flatMap((l) => ["-P", `${l}=-self-hosted`]),
    "-P",
    "self-hosted=-self-hosted",
    "--json",
    "--concurrent-jobs",
    "1",
    "--no-skip-checkout",
    // act's artifact and cache servers bind the outbound IP by default and fail with no network
    // ("lookup <nil>"). Loopback works with egress none.
    "--artifact-server-addr",
    "127.0.0.1",
    "--cache-server-addr",
    "127.0.0.1",
    // Never hand the job a container socket.
    "--container-daemon-socket",
    "-",
    // Every action is served from a local dir: the checkout stub, or the sha-delivered copy.
    ...[
      ...new Map(plan.actions.map((a) => [`${a.repo}@${a.sha ?? a.ref}`, a.dir])).entries(),
    ].flatMap(([key, dir]) => ["--local-repository", `${key}=${dir}`]),
  ];
  assertNoDockerAccess(argv);
  return { ...plan, argv };
}

/** Asserts nothing in a command exposes the container runtime to a job. */
export function assertNoDockerAccess(argv: readonly string[]): void {
  for (const [i, a] of argv.entries()) {
    if (a.includes("docker.sock") || a === "--privileged" || a.startsWith("--privileged=")) {
      throw new PlanError("container runtime access", `refusing to pass ${a} to a job`);
    }
    if (a === "--container-daemon-socket" && argv[i + 1] !== "-") {
      throw new PlanError("container runtime access", "container-daemon-socket must be -");
    }
    if (a === "-b" || a === "--bind") {
      throw new PlanError("container runtime access", "bind mounts are not allowed");
    }
  }
}

const esc = (s: string): string => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrites `uses: owner/repo@tag` to `@sha` for every resolved action. Comments survive. */
export function rewriteUses(text: string, actions: readonly PlannedAction[]): string {
  let out = text;
  for (const a of actions) {
    if (!a.sha || a.sha === a.ref) continue;
    const re = new RegExp(
      `^(\\s*(?:-\\s*)?uses:\\s*["']?)${esc(a.uses)}(["']?[ \\t]*(?:#.*)?)$`,
      "gm",
    );
    out = out.replace(re, (_m, pre: string, post: string) => {
      const pinned = `${a.repo}${a.subpath ? `/${a.subpath}` : ""}@${a.sha}`;
      return `${pre}${pinned}${post.includes("#") ? post : `${post} # ${a.ref}`}`;
    });
  }
  return out;
}

/**
 * Context values an outside party controls. Interpolated straight into a script they allow
 * command injection. Pass them through `env:` instead.
 */
const UNTRUSTED: RegExp[] = [
  /github\.event\.(issue|pull_request|discussion)\.(title|body)\b/,
  /github\.event\.(comment|review|review_comment)\.body\b/,
  /github\.event\.pull_request\.head\.(ref|label)\b/,
  /github\.event\.pull_request\.head\.repo\.(default_branch|description|homepage)\b/,
  /github\.event\.pages\.[^.}\s]+\.page_name\b/,
  /github\.event\.commits(\[[^\]]*\]|\.[^.}\s]+)\.(message|author\.(email|name))\b/,
  /github\.event\.head_commit\.(message|author\.(email|name))\b/,
  /github\.event\.workflow_run\.(head_branch|display_title|head_commit\.(message|author\.(email|name)))\b/,
  /github\.head_ref\b/,
];

export function untrustedIn(step: string, script: string): PlanWarning[] {
  const out: PlanWarning[] = [];
  for (const m of script.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const expr = (m[1] ?? "").trim();
    if (UNTRUSTED.some((re) => re.test(expr))) {
      out.push({
        code: "untrusted-expression",
        step,
        expression: expr,
        message: `step "${step}" interpolates \${{ ${expr} }} into a script; pass it through env: instead`,
      });
    }
  }
  return out;
}

/** Resolves a tag or branch to a commit sha. Core implements it later with the forge API. */
export type ActionRefResolver = (owner: string, repo: string, ref: string) => Promise<string>;

/** Default resolver: the GitHub API, which also dereferences annotated tags. */
export function githubResolver(token?: string): ActionRefResolver {
  return async (owner, repo, ref) => {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: "application/vnd.github.sha",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      throw new PlanError(
        "action ref",
        `cannot resolve ${owner}/${repo}@${ref}: HTTP ${res.status}`,
      );
    }
    const sha = (await res.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new PlanError("action ref", `bad sha for ${owner}/${repo}@${ref}`);
    }
    return sha;
  };
}

/** Test stub: a fixed map of `owner/repo@ref` to sha. Unknown refs throw. */
export function staticResolver(map: Readonly<Record<string, string>>): ActionRefResolver {
  return async (owner, repo, ref) => {
    const sha = map[`${owner}/${repo}@${ref}`];
    if (!sha) throw new PlanError("action ref", `no stub sha for ${owner}/${repo}@${ref}`);
    return sha;
  };
}

/**
 * Fills in the sha of every action whose ref is not already a full sha, rewrites each plan file
 * so `uses:` is pinned, and re-keys the act command by sha. Returns a new plan.
 */
export async function resolveActions(
  plan: JobPlan,
  resolve: ActionRefResolver = githubResolver(),
): Promise<JobPlan> {
  const actions = await Promise.all(
    plan.actions.map(async (a) => {
      if (a.sha) return a;
      const [owner = "", repo = ""] = a.repo.split("/");
      return { ...a, sha: await resolve(owner, repo, a.ref) };
    }),
  );
  const files = plan.files.map((f) => ({ ...f, text: rewriteUses(f.source, actions) }));
  return withArgv({ ...plan, actions, files });
}
