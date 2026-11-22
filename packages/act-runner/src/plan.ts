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

/** A step that interpolates attacker-controllable context straight into a script. */
export interface PlanWarning {
  code: "untrusted-expression";
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

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const layout = layoutFor(opts.root);
  const checkoutRefs: string[] = [];
  const actions: PlannedAction[] = [];
  const warnings: PlanWarning[] = [];
  for (const [i, s] of steps.entries()) {
    if (!isObj(s)) continue;
    const stepName = typeof s.name === "string" ? s.name : `step ${i + 1}`;
    if (typeof s.run === "string") warnings.push(...untrustedIn(stepName, s.run));
    if (isObj(s.with) && typeof s.with.script === "string") {
      warnings.push(...untrustedIn(stepName, s.with.script));
    }
    if (typeof s.uses !== "string") continue;
    const uses = s.uses.trim();
    if (uses.startsWith("docker://")) {
      throw new PlanError("docker:// action", `step uses ${uses}; docker actions are unsupported`);
    }
    if (uses.startsWith("./") || uses.startsWith("../")) continue;
    if (actions.some((a) => a.uses === uses)) continue;
    const m = /^([^/@\s]+\/[^/@\s]+)((?:\/[^@\s]+)?)@(\S+)$/.exec(uses);
    if (!m) throw new PlanError("action ref", `cannot parse action reference "${uses}"`);
    const [, repo = "", subpath = "", ref = ""] = m;
    const kind = uses.startsWith("actions/checkout@") ? "checkout" : "remote";
    if (kind === "checkout") checkoutRefs.push(uses);
    const dir =
      kind === "checkout"
        ? `${layout.stubs}/checkout-${checkoutRefs.length - 1}`
        : `${layout.stubs}/action-${actions.length}`;
    actions.push({
      uses,
      repo,
      subpath: subpath.replace(/^\//, ""),
      ref,
      ...(/^[0-9a-f]{40}$/.test(ref) ? { sha: ref } : {}),
      kind,
      dir,
    });
  }
  const stubDirs = actions.filter((a) => a.kind === "checkout").map((a) => a.dir);
  const argv = [
    layout.act,
    opts.event ?? "push",
    "-W",
    opts.workflowPath,
    "-j",
    jobId,
    ...labels.filter((l) => l !== "self-hosted").flatMap((l) => ["-P", `${l}=-self-hosted`]),
    "-P",
    "self-hosted=-self-hosted",
    "--json",
    "--concurrent-jobs",
    "1",
    "--no-skip-checkout",
    // Never hand the job a container socket.
    "--container-daemon-socket",
    "-",
    // Every action is served from a local dir: the checkout stub, or the sha-delivered copy.
    ...[...new Map(actions.map((a) => [`${a.repo}@${a.ref}`, a.dir])).entries()].flatMap(
      ([key, dir]) => ["--local-repository", `${key}=${dir}`],
    ),
  ];
  return {
    jobId,
    workflowPath: opts.workflowPath,
    layout,
    checkoutRefs,
    stubDirs,
    actions,
    warnings,
    argv,
    cwd: layout.repo,
  };
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
  /github\.event\.commits\.[^.}\s]+\.(message|author\.(email|name))\b/,
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

/** Resolves a tag or branch to a commit sha. */
export type RefResolver = (repo: string, ref: string) => Promise<string>;

/** Default resolver: the GitHub API, which also dereferences annotated tags. */
export function githubResolver(token?: string): RefResolver {
  return async (repo, ref) => {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: "application/vnd.github.sha",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      throw new PlanError("action ref", `cannot resolve ${repo}@${ref}: HTTP ${res.status}`);
    }
    const sha = (await res.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new PlanError("action ref", `bad sha for ${repo}@${ref}`);
    return sha;
  };
}

/** Fills in the sha of every action whose ref is not already a full sha. Returns a new plan. */
export async function resolveActions(
  plan: JobPlan,
  resolve: RefResolver = githubResolver(),
): Promise<JobPlan> {
  const actions = await Promise.all(
    plan.actions.map(async (a) => (a.sha ? a : { ...a, sha: await resolve(a.repo, a.ref) })),
  );
  return { ...plan, actions };
}
