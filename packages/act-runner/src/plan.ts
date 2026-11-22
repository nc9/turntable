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

export interface JobPlan {
  jobId: string;
  workflowPath: string;
  layout: Layout;
  /** Every `actions/checkout@<ref>` used by the job, to be stubbed. */
  checkoutRefs: string[];
  /** Stub dir for each checkout ref, same order. */
  stubDirs: string[];
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
  const checkoutRefs: string[] = [];
  for (const s of steps) {
    if (!isObj(s) || typeof s.uses !== "string") continue;
    const uses = s.uses.trim();
    if (uses.startsWith("docker://")) {
      throw new PlanError("docker:// action", `step uses ${uses}; docker actions are unsupported`);
    }
    if (uses.startsWith("actions/checkout@") && !checkoutRefs.includes(uses))
      checkoutRefs.push(uses);
  }

  const layout = layoutFor(opts.root);
  const stubDirs = checkoutRefs.map((_, i) => `${layout.stubs}/checkout-${i}`);
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
    ...checkoutRefs.flatMap((ref, i) => ["--local-repository", `${ref}=${stubDirs[i]}`]),
  ];
  return {
    jobId,
    workflowPath: opts.workflowPath,
    layout,
    checkoutRefs,
    stubDirs,
    argv,
    cwd: layout.repo,
  };
}
