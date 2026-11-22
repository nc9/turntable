import { parse } from "yaml";
import {
  ExprError,
  evaluateCondition,
  interpolate,
  referencedContexts,
  wholeExpression,
  type ExprContext,
  type Value,
} from "./expr";
import { lintError, localActionDir, PlanError, type PlanWarning, untrustedIn } from "./plan";
import { wantsIdToken } from "./permissions";
import { findHeadCheckouts, isPrivilegedEvent } from "./taint";
import { matchTrigger, type TriggerResult, type WorkflowEvent } from "./triggers";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface PlannedJob {
  /** Unique within the run: the job id, or `id[n]` for a matrix leg. */
  key: string;
  /** The workflow's job id. */
  id: string;
  /** Display name: the interpolated `name:` (or the id), with matrix values for legs. */
  name: string;
  /** Keys of the jobs this one waits for. A need on a matrix job waits for every leg. */
  needs: string[];
  /** The job ids named in `needs:`. */
  needsIds: string[];
  matrix?: Record<string, Value>;
  /** The job's `if:` as written. Evaluated at schedule time with the needs results. */
  ifExpr?: string | boolean;
  /** False when `if:` depends only on plan-time data and is false: the job is skipped. */
  staticSkip?: { reason: string };
  /** The job cannot run here (docker, non-Linux ...). Reported, not failed. */
  unsupported?: string;
  continueOnError: boolean;
  /** Output name to expression. */
  outputs: Record<string, string>;
  /** strategy.fail-fast (default true). */
  failFast: boolean;
  /** strategy.max-parallel, when set. */
  maxParallel?: number;
  /** The job's `environment:` (a name, or `name` of the mapping), when it is a literal. */
  environment?: string;
  /** The job asked for an OIDC identity token (`permissions: id-token: write`). */
  idToken?: true;
}

export interface WorkflowPlan {
  name?: string;
  event: WorkflowEvent;
  trigger: TriggerResult;
  /** Workflow-level env, literal strings only (expressions are evaluated by act per job). */
  env: Record<string, string>;
  concurrency?: { group: string; cancelInProgress: boolean };
  /** Jobs in dependency order. */
  jobs: PlannedJob[];
  warnings: PlanWarning[];
}

export interface PlanWorkflowOptions {
  /** github context fields beyond the event (sha, actor, repository, event payload ...). */
  github?: Record<string, Value>;
  vars?: Record<string, Value>;
  inputs?: Record<string, Value>;
  /** Reads repo files so local composite actions can be checked for docker. */
  readFile: (path: string) => string | undefined;
  /** Fail the plan on lint findings (outside text in a script, a privileged job taking the PR head). */
  failOnLint?: boolean;
}

export function githubContext(
  event: WorkflowEvent,
  extra: Record<string, Value> = {},
): Record<string, Value> {
  const ref = event.ref ?? "";
  const refName = ref.replace(/^refs\/(heads|tags)\//, "");
  return {
    event_name: event.name,
    ref,
    ref_name: refName,
    ref_type: ref.startsWith("refs/tags/") ? "tag" : "branch",
    base_ref: event.baseRef ?? "",
    event: {},
    ...extra,
  };
}

// ---- matrix ----

type Combo = Record<string, Value>;

const subsetMatch = (small: Combo, big: Combo): boolean =>
  Object.entries(small).every(([k, v]) => k in big && JSON.stringify(big[k]) === JSON.stringify(v));

/** Expands a static matrix: cartesian product, then exclude, then include. */
export function expandMatrix(matrix: unknown): Combo[] {
  if (!isObj(matrix)) throw new PlanError("matrix", "strategy.matrix must be a mapping");
  const include = Array.isArray(matrix.include) ? (matrix.include.filter(isObj) as Combo[]) : [];
  const exclude = Array.isArray(matrix.exclude) ? (matrix.exclude.filter(isObj) as Combo[]) : [];
  const axes = Object.entries(matrix).filter(([k]) => k !== "include" && k !== "exclude");
  let combos: Combo[] = [];
  if (axes.length > 0) {
    combos = [{}];
    for (const [k, vals] of axes) {
      if (!Array.isArray(vals)) {
        throw new PlanError(
          "matrix",
          `matrix axis "${k}" must be a list (expressions are not supported)`,
        );
      }
      combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v as Value })));
    }
    combos = combos.filter((c) => !exclude.some((e) => subsetMatch(e, c)));
  }
  const original = new Set(axes.map(([k]) => k));
  for (const inc of include) {
    const originalPart: Combo = Object.fromEntries(
      Object.entries(inc).filter(([k]) => original.has(k)),
    );
    let matched = false;
    for (const c of combos) {
      if (subsetMatch(originalPart, c) && Object.keys(originalPart).length > 0) {
        matched = true;
        for (const [k, v] of Object.entries(inc)) if (!original.has(k)) c[k] = v;
      }
    }
    if (!matched) combos.push({ ...inc });
  }
  if (combos.length === 0) throw new PlanError("matrix", "matrix expands to no jobs");
  return combos;
}

// ---- docker detection ----

const DOCKER_CMD = /(^|[\s;&|(`])docker(\s|$)/m;
const DOCKER_OWNERS = /^docker\//i;

/**
 * Why a local composite action (a directory of the repo) needs docker, looking through the local
 * actions it uses in turn, to a bounded depth. Undefined when it does not, or cannot be read.
 */
function localActionDockerReason(
  uses: string,
  readFile: (p: string) => string | undefined,
  depth: number,
  seen: Set<string>,
): string | undefined {
  const dir = localActionDir(uses);
  if (dir === undefined) return `step uses ${uses}, a path outside the repository`;
  if (depth > 5 || seen.has(dir)) return undefined;
  seen.add(dir);
  for (const f of ["action.yml", "action.yaml"]) {
    const text = readFile(dir === "" ? f : `${dir}/${f}`);
    if (text === undefined) continue;
    try {
      const doc: unknown = parse(text);
      const runs = isObj(doc) ? doc.runs : undefined;
      if (isObj(runs) && String(runs.using).trim().toLowerCase() === "docker")
        return `local action ${uses} is a docker action`;
      if (isObj(runs) && Array.isArray(runs.steps)) {
        for (const cs of runs.steps) {
          if (!isObj(cs)) continue;
          if (typeof cs.run === "string" && DOCKER_CMD.test(cs.run)) {
            return `local action ${uses} runs docker`;
          }
          if (typeof cs.uses === "string") {
            const u = cs.uses.trim();
            if (u.startsWith("docker://")) return `local action ${uses} uses ${u}`;
            if (u.startsWith("./") || u.startsWith("../")) {
              const inner = localActionDockerReason(u, readFile, depth + 1, seen);
              if (inner) return `local action ${uses} uses ${inner.replace(/^step uses /, "")}`;
            }
          }
        }
      }
    } catch {
      // an unparsable action fails loudly at run time
    }
    break;
  }
  return undefined;
}

/** Why a job needs a container runtime, or undefined. */
function dockerReason(job: Obj, readFile: (p: string) => string | undefined): string | undefined {
  if (job.container !== undefined) return "uses container:";
  if (job.services !== undefined) return "uses services:";
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const s of steps) {
    if (!isObj(s)) continue;
    if (typeof s.uses === "string") {
      const u = s.uses.trim();
      if (u.startsWith("docker://")) return `step uses ${u}`;
      if (DOCKER_OWNERS.test(u)) return `step uses ${u}, which needs a docker daemon`;
      if (u.startsWith("./") || u.startsWith("../")) {
        const why = localActionDockerReason(u, readFile, 0, new Set());
        if (why) return why;
      }
    }
    if (typeof s.run === "string" && DOCKER_CMD.test(s.run))
      return "a step runs the docker command";
  }
  return undefined;
}

const LINUX_LABEL = /^(ubuntu(-|$)|linux$|self-hosted$)/;

function runsOnReason(runsOn: unknown, ctx: ExprContext): string | undefined {
  let labels: unknown[];
  if (typeof runsOn === "string") labels = [runsOn];
  else if (Array.isArray(runsOn)) labels = runsOn;
  else if (isObj(runsOn) && runsOn.labels !== undefined) labels = [runsOn.labels].flat();
  else return "runs-on is missing or has an unsupported shape";
  for (const l of labels) {
    if (typeof l !== "string") return "runs-on has a non-string label";
    const v = l.includes("${{") ? interpolate(l, ctx) : l;
    if (!LINUX_LABEL.test(v)) return `runs-on "${v}" is not a Linux runner`;
  }
  return undefined;
}

// ---- planning ----

/** True when the expression reads only data known at plan time. */
function isStatic(expr: string): boolean {
  const refs = referencedContexts(expr);
  return !["needs", "status", "steps", "job"].some((c) => refs.has(c));
}

/**
 * Plans a whole workflow: trigger match, the job graph with matrices expanded, static `if:`
 * results, and jobs that cannot run here marked unsupported. Job `if:` that reads needs is kept
 * for schedule time (evaluateCondition with the real needs results).
 */
export function planWorkflow(
  yaml: string,
  event: WorkflowEvent,
  opts: PlanWorkflowOptions,
): WorkflowPlan {
  let doc: unknown;
  try {
    doc = parse(yaml, { merge: true });
  } catch (e) {
    throw new PlanError("yaml", `workflow is not valid YAML: ${(e as Error).message}`);
  }
  if (!isObj(doc) || !isObj(doc.jobs)) throw new PlanError("jobs", "workflow has no jobs");
  const on = doc.on ?? (doc as Obj)["true"];
  const trigger = matchTrigger(on, event);
  const github = githubContext(event, opts.github);
  const base: Record<string, Value> = {
    github,
    vars: opts.vars ?? {},
    inputs: opts.inputs ?? {},
    env: {},
    secrets: {},
    runner: { os: "Linux", arch: "X64" },
  };
  const wfCtx: ExprContext = { contexts: base, status: { needs: [], cancelled: false } };

  const warnings: PlanWarning[] = [];
  const env: Record<string, string> = {};
  if (isObj(doc.env)) {
    for (const [k, v] of Object.entries(doc.env))
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        env[k] = String(v);
  }
  base.env = env;

  let concurrency: WorkflowPlan["concurrency"];
  if (doc.concurrency !== undefined) {
    const c = doc.concurrency;
    const groupRaw = typeof c === "string" ? c : isObj(c) ? c.group : undefined;
    if (typeof groupRaw !== "string")
      throw new PlanError("concurrency", "concurrency needs a group");
    let cancel = false;
    if (isObj(c) && c["cancel-in-progress"] !== undefined) {
      const v = c["cancel-in-progress"];
      cancel = typeof v === "boolean" ? v : evaluateCondition(String(v), wfCtx);
    }
    concurrency = { group: interpolate(groupRaw, wfCtx), cancelInProgress: cancel };
  }

  const rawJobs = doc.jobs;
  const ids = Object.keys(rawJobs);
  const legsOf = new Map<string, string[]>();
  const nodes: PlannedJob[] = [];

  for (const id of ids) {
    const job = rawJobs[id];
    if (!isObj(job)) throw new PlanError("job", `job "${id}" is not a mapping`);
    const needsIds = job.needs === undefined ? [] : ([job.needs].flat() as unknown[]).map(String);
    for (const n of needsIds) {
      if (!ids.includes(n)) throw new PlanError("needs", `job "${id}" needs unknown job "${n}"`);
    }
    const strategy = isObj(job.strategy) ? job.strategy : {};
    let combos: Combo[] | undefined;
    let dynamicMatrix = false;
    if (strategy.matrix !== undefined) {
      if (typeof strategy.matrix === "string" || JSON.stringify(strategy.matrix).includes("${{")) {
        dynamicMatrix = true;
      } else {
        combos = expandMatrix(strategy.matrix);
      }
    }
    const failFast = strategy["fail-fast"] === undefined ? true : strategy["fail-fast"] !== false;
    const maxParallel =
      typeof strategy["max-parallel"] === "number" ? strategy["max-parallel"] : undefined;
    const outputs = isObj(job.outputs)
      ? Object.fromEntries(Object.entries(job.outputs).map(([k, v]) => [k, String(v)]))
      : {};

    const legs: (Combo | undefined)[] = combos ?? [undefined];
    const keys: string[] = [];
    for (const [i, leg] of legs.entries()) {
      const key = leg === undefined ? id : `${id}[${i}]`;
      keys.push(key);
      const ctx: ExprContext = {
        contexts: {
          ...base,
          matrix: leg ?? {},
          strategy: { "job-index": i, "job-total": legs.length, "fail-fast": failFast },
        },
        status: { needs: [], cancelled: false },
      };
      let name = id;
      try {
        if (typeof job.name === "string") name = interpolate(job.name, ctx);
        else if (leg)
          name = `${id} (${Object.values(leg)
            .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
            .join(", ")})`;
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
        name = job.name as string;
      }
      let unsupported: string | undefined =
        dockerReason(job, opts.readFile) ??
        (job.uses !== undefined ? "calls a reusable workflow (uses:)" : undefined) ??
        runsOnReason(job["runs-on"], ctx);
      if (dynamicMatrix)
        unsupported ??= "matrix built from an expression (fromJSON) is not supported yet";
      // A literal environment can be gated by approval policy. One built from an expression
      // cannot be known at plan time, so the job is refused rather than run ungated.
      let environment: string | undefined;
      if (job.environment !== undefined) {
        const raw = isObj(job.environment) ? job.environment.name : job.environment;
        if (typeof raw === "string" && raw !== "" && !raw.includes("${{")) environment = raw;
        else unsupported ??= "environment: must be a literal name (an expression cannot be gated)";
      }
      let coe = false;
      if (job["continue-on-error"] !== undefined) {
        const v = job["continue-on-error"];
        try {
          coe = typeof v === "boolean" ? v : evaluateCondition(String(v), ctx);
        } catch (e) {
          if (!(e instanceof ExprError)) throw e;
          unsupported ??= `continue-on-error expression: ${e.message}`;
        }
      }
      const node: PlannedJob = {
        key,
        id,
        name,
        needs: [],
        needsIds,
        ...(leg ? { matrix: leg } : {}),
        ...(job.if !== undefined ? { ifExpr: job.if as string | boolean } : {}),
        ...(unsupported ? { unsupported } : {}),
        continueOnError: coe,
        outputs,
        failFast,
        ...(maxParallel !== undefined ? { maxParallel } : {}),
        ...(environment !== undefined ? { environment } : {}),
        ...(wantsIdToken(doc, job) ? { idToken: true as const } : {}),
      };
      // Static `if:` is decided now; one that reads needs waits for schedule time.
      if (job.if !== undefined && !unsupported) {
        const cond = job.if as string | boolean;
        try {
          const isStat = typeof cond === "boolean" || isStatic(wholeExpression(cond) ?? cond);
          if (isStat && !evaluateCondition(cond, ctx)) {
            node.staticSkip = { reason: `if: ${String(cond).trim()} is false` };
          }
        } catch (e) {
          if (e instanceof ExprError) node.unsupported = `if: ${e.message}`;
          else throw e;
        }
      }
      for (const w of untrustedStepWarnings(job, id, event.name)) warnings.push(w);
      nodes.push(node);
    }
    legsOf.set(id, keys);
  }

  for (const n of nodes) n.needs = n.needsIds.flatMap((i) => legsOf.get(i) ?? []);
  if (opts.failOnLint && warnings.length > 0) throw lintError(warnings);
  return {
    ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    event,
    trigger,
    env,
    ...(concurrency ? { concurrency } : {}),
    jobs: topoSort(nodes),
    warnings,
  };
}

function untrustedStepWarnings(job: Obj, id: string, event: string): PlanWarning[] {
  const out: PlanWarning[] = [];
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const [i, s] of steps.entries()) {
    if (!isObj(s)) continue;
    const name = typeof s.name === "string" ? s.name : `step ${i + 1}`;
    if (typeof s.run === "string") out.push(...untrustedIn(`${id}: ${name}`, s.run));
  }
  if (isPrivilegedEvent(event)) {
    for (const h of findHeadCheckouts(steps)) {
      out.push({
        code: "privileged-head-checkout",
        step: `${id}: ${h.step}`,
        expression: h.expression,
        message: `step "${id}: ${h.step}" takes ${h.field} from the pull request head (${h.expression}) in a ${event} job; a privileged job must work from a protected ref`,
      });
    }
  }
  return out;
}

/** Orders jobs so every job follows its needs. Throws on a cycle. */
export function topoSort(nodes: readonly PlannedJob[]): PlannedJob[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const out: PlannedJob[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: PlannedJob, path: string[]): void => {
    if (state.get(n.key) === 2) return;
    if (state.get(n.key) === 1)
      throw new PlanError("needs", `needs cycle: ${[...path, n.key].join(" -> ")}`);
    state.set(n.key, 1);
    for (const k of n.needs) visit(byKey.get(k) as PlannedJob, [...path, n.key]);
    state.set(n.key, 2);
    out.push(n);
  };
  for (const n of nodes) visit(n, []);
  return out;
}
