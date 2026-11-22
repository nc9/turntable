// The production AttemptRunner: plans the claimed job from the workflow at the run's sha and runs
// it with act in a provider sandbox. It shares executeJob with `longshore run`, so a job behaves
// the same from the CLI and from the worker.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateNeed,
  type ActionRefResolver,
  type ActTarball,
  type ActionFetcher,
  githubResolver,
  type JobPlan,
  type NeedResult,
  type NeedStatus,
  PlanError,
  type PlannedJob,
  planJob,
  splitJob,
  workflowHeadCheckouts,
} from "@longshore/act-runner";
import { egressForRun } from "./egress";
import type { Db } from "../db";
import { listJobs, listRepos, type Run } from "../db/repos";
import { SecretRegistry } from "@longshore/redact";
import { DEFAULT_IMAGE, executeJob } from "../run/job-exec";
import { prefixedOut } from "../run/prefixed-out";
import { snapshotRepo } from "../run/repo-archive";
import { makeSafeReader } from "../run/safe-read";
import { resolvePlanActions } from "../pins";
import type { ReachabilityChecker } from "../pins/reachability";
import { type RunStore, stepInputOf } from "../run/store";
import { createHash } from "node:crypto";
import { parseTrust } from "../db/repos";
import { assessJob, lintFailsFor, type TrustClass } from "../trust";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "./types";

/** The source of a run: a tarball to deliver and the files the planner reads. */
export interface Checkout {
  tarball: Uint8Array;
  readFile(path: string): string | undefined;
  dispose?(): void;
}

export interface RepoSource {
  /** `repo` is undefined for a local run (`longshore run`), which has no bound repo. */
  checkout(run: Run, repo: { owner: string; repo: string } | undefined): Promise<Checkout>;
}

/**
 * The source of a `longshore run`: the tarball and files already read from the working repo. The
 * workflow file is served from the text read at launch, so every job of the run plans from the
 * same bytes even if the file changes while the run is going.
 */
export function localRepoSource(o: {
  tarball: Uint8Array;
  workflowPath: string;
  workflowYaml: string;
  readFile(path: string): string | undefined;
}): RepoSource {
  return {
    async checkout() {
      return {
        tarball: o.tarball,
        readFile: (p) => (p === o.workflowPath ? o.workflowYaml : o.readFile(p)),
      };
    },
  };
}

const SAFE_PART = /^[A-Za-z0-9_.-]+$/;

async function git(cwd: string, argv: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // No prompts, no credentials, no system config: this only ever reads public repos.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${argv[0]} failed: ${err.trim().split("\n")[0]}`);
}

/**
 * Fetches exactly the run's commit from a public repo with git (a depth-1 fetch by sha) and packs
 * it the way `longshore run` does: the committed tree plus .git.
 */
export function gitRepoSource(
  o: { cloneUrl?: (owner: string, repo: string) => string } = {},
): RepoSource {
  const url = o.cloneUrl ?? ((owner, repo) => `https://github.com/${owner}/${repo}.git`);
  return {
    async checkout(run, bound) {
      if (!bound) throw new Error("run has no repo binding");
      const { owner, repo } = bound;
      if (!SAFE_PART.test(owner) || !SAFE_PART.test(repo) || run.sha === null) {
        throw new Error("run has no sha or the repo binding is not a plain owner/name");
      }
      const dir = mkdtempSync(join(tmpdir(), "tt-src-"));
      try {
        await git(dir, ["init", "-q"]);
        await git(dir, ["fetch", "-q", "--depth", "1", url(owner, repo), run.sha]);
        await git(dir, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
        const snap = await snapshotRepo(dir);
        return {
          tarball: snap.tarball,
          // Repo files are untrusted: no traversal, no symlinks, size-capped.
          readFile: makeSafeReader(dir),
          dispose: () => rmSync(dir, { recursive: true, force: true }),
        };
      } catch (err) {
        rmSync(dir, { recursive: true, force: true });
        throw err;
      }
    },
  };
}

export type ActRunnerOptions = {
  db: Db;
  source: RepoSource;
  image?: string;
  resolver?: ActionRefResolver;
  egress?: "none" | "open";
  /** Probe each `none` sandbox for a real network path before the job runs (see egress-canary). */
  canary?: boolean;
  timeoutSeconds?: number;
  // Test seams.
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  /** Verifies an action sha belongs to its repo (default: the GitHub API). */
  reachable?: ReachabilityChecker;
  pollMs?: number;
  /** Sandbox root the job layout is planned under (a fake provider needs a host path). */
  planRoot?: string;
  /** Live terminal output of a job, line by line (`longshore run` prints it with a key prefix). */
  out?: (jobKey: string, text: string) => void;
};

/**
 * The persistence executeJob writes to while a worker runs an attempt. Every write goes through
 * the lease-fenced attempt store. The final state is NOT written here: the scheduler records the
 * outcome (fenced) once the runner returns, so `finishJob` and the run-level calls do nothing.
 */
function workerStore(ctx: AttemptContext): RunStore {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not used by the worker`);
  };
  return {
    beginRun: unused("beginRun"),
    createJob: unused("createJob"),
    startAttempt: unused("startAttempt"),
    skipJob: unused("skipJob"),
    cancelQueuedJob: unused("cancelQueuedJob"),
    recordLaunch: async () => {},
    finishRun: async () => {},
    finishJob: async () => {},
    setSandbox: (_id, sandboxId) => ctx.store.setExec({ sandboxId }),
    setExec: (_id, execId) => ctx.store.setExec({ execId }),
    resetOutput: () => ctx.store.reset(),
    appendLog: (_id, offset, bytes) => ctx.store.appendLog(offset, bytes),
    recordStep: (_id, step) => {
      const { attemptId: _drop, ...rest } = stepInputOf(ctx.attempt.id, step);
      return ctx.store.recordStep(rest);
    },
  };
}

const safeName = (key: string): string => key.replaceAll(/[^A-Za-z0-9_.-]/g, "_");

/**
 * What the dependents of a job see: for each needed job id, the folded result and outputs of its
 * legs, from the states and outputs stored on the run's job rows.
 */
async function needResultsFor(
  o: ActRunnerOptions,
  ctx: AttemptContext,
  planned: PlannedJob,
): Promise<Record<string, NeedResult>> {
  const siblings = await listJobs(o.db, ctx.scope, ctx.run.id);
  const statusOf = (j: (typeof siblings)[number]): NeedStatus => {
    const p = j.planned ? (JSON.parse(j.planned) as PlannedJob) : undefined;
    return {
      state: j.state as NeedStatus["state"],
      ...(j.outputs ? { outputs: JSON.parse(j.outputs) as Record<string, string> } : {}),
      ...(p?.continueOnError ? { continueOnError: true } : {}),
    };
  };
  return Object.fromEntries(
    planned.needsIds.map((id) => [
      id,
      aggregateNeed(
        siblings
          .filter((j) => j.planned && (JSON.parse(j.planned) as PlannedJob).id === id)
          .map(statusOf),
      ),
    ]),
  );
}

/** Builds the runner for the scheduler. Deterministic plan problems are infra_error with a reason. */
export function createActRunner(o: ActRunnerOptions): AttemptRunner {
  const run = async (
    ctx: AttemptContext,
    plan: JobPlan,
    repoTarball: Uint8Array | undefined,
  ): Promise<AttemptOutcome> => {
    const sink = o.out
      ? prefixedOut((text) => o.out?.(ctx.job.jobKey, text), ctx.job.jobKey)
      : undefined;
    const res = await executeJob(
      {
        provider: ctx.provider,
        store: workerStore(ctx),
        out: sink ? sink.out : () => {},
        registry: new SecretRegistry(),
        signal: ctx.signal,
        ...(ctx.notices ? { notices: ctx.notices } : {}),
        ...(ctx.resume || !repoTarball ? {} : { image: o.image ?? DEFAULT_IMAGE, repoTarball }),
        // `none` unless this run's plan (from the project's config) or the runner says `open`.
        // `allowlist` has no provider support yet and is refused by withEgressPolicy first.
        egress: egressForRun(ctx.run.plan, o.egress) === "open" ? "open" : "none",
        ...(o.canary ? { canary: true } : {}),
        ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}),
        ...(o.act ? { act: o.act } : {}),
        ...(o.fetchAction ? { fetchAction: o.fetchAction } : {}),
        ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      },
      { runId: ctx.run.id, jobId: ctx.job.id, attemptId: ctx.attempt.id },
      plan,
      // A dead worker's exec: replay it for the real result instead of starting over. The plan
      // says which events are this job's and which outputs to read.
      ctx.resume,
    ).finally(() => sink?.flush());
    return {
      state: res.state,
      ...(res.actExitCode === undefined ? {} : { exitCode: res.actExitCode }),
      reason: res.reason,
      ...(res.outputs ? { outputs: res.outputs } : {}),
    };
  };

  return async (ctx) => {
    // Re-attach with the plan stored when the attempt started: no repo fetch, no network.
    if (ctx.resume && ctx.attempt.plan) {
      return run(ctx, JSON.parse(ctx.attempt.plan) as JobPlan, undefined);
    }

    const { run: dbRun, job } = ctx;
    // A local run reads the working repo it was started from; the rest need a bound repo and sha.
    const repo = dbRun.local ? undefined : (await listRepos(o.db, ctx.scope))[0];
    if (!dbRun.local) {
      if (!repo) return { state: "infra_error", reason: "project has no bound repo to fetch from" };
      if (dbRun.sha === null) return { state: "infra_error", reason: "run has no sha" };
    }

    const checkout = await o.source.checkout(
      dbRun,
      repo ? { owner: repo.owner, repo: repo.repo } : undefined,
    );
    try {
      const workflowYaml = checkout.readFile(dbRun.workflowPath);
      if (workflowYaml === undefined) {
        return {
          state: "infra_error",
          reason: `workflow ${dbRun.workflowPath} not found at ${dbRun.sha}`,
        };
      }
      // An untrusted run starts only with an approval bound to this exact sha and workflow. The
      // approval op checks the same thing; this is the backstop for a run that got here some
      // other way (a bug, a hand-edited database), and for a workflow that is not the one read.
      const stored = parseTrust(dbRun);
      if (stored?.class === "untrusted_pr") {
        const approval = dbRun.approval
          ? (JSON.parse(dbRun.approval) as { head_sha?: string; workflow_hash?: string })
          : undefined;
        const hash = createHash("sha256").update(workflowYaml).digest("hex");
        if (!approval) return { state: "infra_error", reason: "untrusted run has no approval" };
        if (
          approval.head_sha !== dbRun.sha?.toLowerCase() ||
          approval.workflow_hash !== hash ||
          stored.workflowHash !== hash
        ) {
          return {
            state: "infra_error",
            reason: "approval does not match this run's sha and workflow",
          };
        }
      }
      let plan: JobPlan;
      try {
        const root = o.planRoot ? { root: o.planRoot } : {};
        const planned = job.planned ? (JSON.parse(job.planned) as PlannedJob) : undefined;
        // The class this job runs as: the demotion rule applies before anything starts, and
        // protected and release runs fail lint instead of warning.
        const headCheckouts = workflowHeadCheckouts(workflowYaml)[planned?.id ?? job.jobKey] ?? [];
        const assessed = assessJob(
          { event: dbRun.event, ref: dbRun.ref },
          headCheckouts.length > 0,
        );
        // The class decided at ingest from forge facts is a ceiling: the demotion rule may lower
        // it, nothing recomputed here may raise it. A run with no decision (local, older) is
        // assessed from its event and ref alone, as before.
        const klass: TrustClass = assessed.demotedFrom
          ? assessed.klass
          : ((stored?.class as TrustClass | undefined) ?? assessed.klass);
        const failOnLint = lintFailsFor(klass);
        const jobPlan = planned
          ? // A whole-workflow job: a generated single-job workflow whose stub need jobs carry the
            // real results and outputs of its dependencies.
            planJob(
              splitJob(workflowYaml, planned, await needResultsFor(o, ctx, planned), {
                event: dbRun.event,
                ...root,
              }),
              planned.id,
              {
                workflowPath: `.longshore/jobs/${safeName(planned.key)}.yml`,
                event: dbRun.event,
                readFile: checkout.readFile,
                split: true,
                failOnLint,
                ...root,
              },
            )
          : planJob(workflowYaml, job.jobKey, {
              workflowPath: dbRun.workflowPath,
              event: dbRun.event,
              readFile: checkout.readFile,
              failOnLint,
              ...root,
            });
        plan = await resolvePlanActions(jobPlan, {
          db: o.db,
          scope: ctx.scope,
          klass,
          base: o.resolver ?? githubResolver(),
          readFile: checkout.readFile,
          ...(o.reachable ? { reachable: o.reachable } : {}),
          ...(o.fetchAction ? { fetchTarball: o.fetchAction } : {}),
          warn: (m) => console.warn(`action pins: ${m}`),
        });
      } catch (err) {
        if (err instanceof PlanError) {
          // A plan rejection (policy, moved tag, unpinned or unreachable action, unsupported
          // feature) is deterministic and the user can act on it: a failure, never retried.
          // infra_error stays for transient causes (a resolver network error, a provider down).
          const msg = `${err.feature === "lint" ? "lint" : "policy"}: ${err.message}`;
          // Shown where the job's log would be, not only as the attempt's reason.
          await ctx.store.appendLog(0, new TextEncoder().encode(`${msg}\n`));
          o.out?.(job.jobKey, `[${job.jobKey}] ${msg}\n`);
          return { state: "failure", reason: msg };
        }
        throw err;
      }
      // Stored before anything runs: a re-attach after a restart then needs no repo.
      await ctx.store.setPlan(JSON.stringify(plan));
      if (ctx.resume) {
        // A legacy attempt with no stored plan: it was just re-planned; replay its exec.
        return run(ctx, plan, undefined);
      }
      return run(ctx, plan, checkout.tarball);
    } finally {
      checkout.dispose?.();
    }
  };
}
