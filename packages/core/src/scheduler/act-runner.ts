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
  resolveActions,
  splitJob,
} from "@longshore/act-runner";
import type { Db } from "../db";
import { listJobs, listRepos, type Run } from "../db/repos";
import { SecretRegistry } from "@longshore/redact";
import { DEFAULT_IMAGE, executeJob } from "../run/job-exec";
import { snapshotRepo } from "../run/repo-archive";
import { makeSafeReader } from "../run/safe-read";
import { type RunStore, stepInputOf } from "../run/store";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "./types";

/** The source of a run: a tarball to deliver and the files the planner reads. */
export interface Checkout {
  tarball: Uint8Array;
  readFile(path: string): string | undefined;
  dispose?(): void;
}

export interface RepoSource {
  checkout(run: Run, repo: { owner: string; repo: string }): Promise<Checkout>;
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
    async checkout(run, { owner, repo }) {
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
  timeoutSeconds?: number;
  // Test seams.
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  pollMs?: number;
  /** Sandbox root the job layout is planned under (a fake provider needs a host path). */
  planRoot?: string;
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
    const res = await executeJob(
      {
        provider: ctx.provider,
        store: workerStore(ctx),
        out: () => {},
        registry: new SecretRegistry(),
        signal: ctx.signal,
        ...(ctx.resume || !repoTarball ? {} : { image: o.image ?? DEFAULT_IMAGE, repoTarball }),
        ...(o.egress ? { egress: o.egress } : {}),
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
    );
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
    const repo = (await listRepos(o.db, ctx.scope))[0];
    if (!repo) return { state: "infra_error", reason: "project has no bound repo to fetch from" };
    if (dbRun.sha === null) return { state: "infra_error", reason: "run has no sha" };

    const checkout = await o.source.checkout(dbRun, { owner: repo.owner, repo: repo.repo });
    try {
      const workflowYaml = checkout.readFile(dbRun.workflowPath);
      if (workflowYaml === undefined) {
        return {
          state: "infra_error",
          reason: `workflow ${dbRun.workflowPath} not found at ${dbRun.sha}`,
        };
      }
      let plan: JobPlan;
      try {
        const root = o.planRoot ? { root: o.planRoot } : {};
        const planned = job.planned ? (JSON.parse(job.planned) as PlannedJob) : undefined;
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
                ...root,
              },
            )
          : planJob(workflowYaml, job.jobKey, {
              workflowPath: dbRun.workflowPath,
              event: dbRun.event,
              readFile: checkout.readFile,
              ...root,
            });
        plan = await resolveActions(jobPlan, o.resolver ?? githubResolver());
      } catch (err) {
        if (err instanceof PlanError) {
          return { state: "infra_error", reason: `plan rejected: ${err.message}` };
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
