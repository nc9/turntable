// The production AttemptRunner: plans the claimed job from the workflow at the run's sha and runs
// it with act in a provider sandbox. It shares executeJob with `longshore run`, so a job behaves
// the same from the CLI and from the worker.
import { scrubbedEnv } from "@longshore/provider-sdk";
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
  rebuildArgv,
  splitJob,
  workflowHeadCheckouts,
} from "@longshore/act-runner";
import type { JobCacheProvider } from "../cache/job";
import { egressForRun } from "./egress";
import type { Db } from "../db";
import { listJobs, listRepos, type Run } from "../db/repos";
import { SecretRegistry } from "@longshore/redact";
import { DEFAULT_IMAGE, executeJob } from "../run/job-exec";
import { prefixedOut } from "../run/prefixed-out";
import { buildActEvent } from "../run/act-event";
import { snapshotRepo } from "../run/repo-archive";
import { makeSafeReader } from "../run/safe-read";
import { resolvePlanActions } from "../pins";
import type { ForgeToken } from "../pins/forge-token";
import {
  actionCredentials,
  credentialedReachability,
  credentialedResolver,
} from "../pins/action-credentials";
import { githubReachability } from "../pins/reachability";
import { cachedReachability, cachedResolver, type VerdictTtl } from "../pins/verdict-cache";
import { createBackoff, type SafeFetch } from "@longshore/net";
import type { ReachabilityChecker } from "../pins/reachability";
import { type RunStore, stepInputOf } from "../run/store";
import { createHash } from "node:crypto";
import type { IssuedJobToken, JobTokens } from "../github/job-token";
import { getActionPolicy, parseTrust } from "../db/repos";
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
    env: scrubbedEnv({ HOME: cwd, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" }),
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${argv[0]} failed: ${err.trim().split("\n")[0]}`);
}

/** A remote URL with a user or password in it would be stored in the repo's config. */
export function assertNoCredentials(u: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(u);
  } catch {
    return; // a local path, as tests use
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("the remote URL must not carry credentials");
  }
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
        // Like actions/checkout, leave `origin` pointing at the repo, so a step that runs
        // `git fetch origin <sha>` works (it needs egress, and fails closed without it).
        // Never with credentials in the URL.
        const remote = o.cloneUrl ? url(owner, repo) : `https://github.com/${owner}/${repo}`;
        assertNoCredentials(remote);
        await git(dir, ["remote", "add", "origin", remote]);
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
  /**
   * The GitHub credential for resolving and verifying actions (see pins/forge-token). Without it
   * those requests are unauthenticated and hit GitHub's 60-per-hour limit.
   */
  forgeToken?: ForgeToken;
  /** How long one job may wait out GitHub rate limits in total. Default 2 minutes. */
  backoff?: { budgetMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
  /** How long action verdicts are remembered (see pins/verdict-cache). */
  verdictTtl?: Partial<VerdictTtl>;
  now?: () => number;
  /** Test seam: the HTTP client for action resolution and reachability (default: safeFetch). */
  fetch?: SafeFetch;
  /** Gives a job its control-plane cache (see cache/job.ts). Absent: jobs keep act's local cache. */
  cache?: JobCacheProvider;
  /** Sandbox root the job layout is planned under (a fake provider needs a host path). */
  planRoot?: string;
  /** Live terminal output of a job, line by line (`longshore run` prints it with a key prefix). */
  out?: (jobKey: string, text: string) => void;
  /**
   * Gives each job its own GitHub token as GITHUB_TOKEN (see github/job-token): minted at job
   * start for the run's repository with the workflow's declared permissions, capped by the trust
   * class and the App's grant, revoked when the job ends. Absent: jobs get no GITHUB_TOKEN.
   */
  jobTokens?: JobTokens;
};

/** What GITHUB_TOKEN holds inside a job that is behind the secrets proxy. The proxy attaches the real one. */
export const PROXIED_TOKEN_PLACEHOLDER = "longshore-token-is-added-by-the-proxy";

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
    githubToken?: string,
    secrets: readonly string[] = [],
  ): Promise<AttemptOutcome> => {
    const registry = ctx.redact ?? new SecretRegistry();
    // A real token in the environment is something the log must never show.
    if (githubToken !== undefined && githubToken !== PROXIED_TOKEN_PLACEHOLDER) {
      registry.register(githubToken);
    }
    // Values that must never reach the job log: act echoes env and URLs when it is verbose.
    for (const v of secrets) registry.register(v);
    const sink = o.out
      ? prefixedOut((text) => o.out?.(ctx.job.jobKey, text), ctx.job.jobKey)
      : undefined;
    const res = await executeJob(
      {
        provider: ctx.provider,
        store: workerStore(ctx),
        out: sink ? sink.out : () => {},
        registry,
        ...(ctx.proxy ? { proxy: ctx.proxy } : {}),
        ...(githubToken !== undefined ? { githubToken } : {}),
        // A job holding a minted token, in its environment or behind the proxy, is secret-bearing:
        // an egress canary that cannot verify isolation refuses it instead of letting it run.
        ...(githubToken !== undefined ? { secretBearing: true } : {}),
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
      let jobKlass: TrustClass | undefined;
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
        // Recorded before anything starts: the secrets vault decides from this and nothing else.
        jobKlass = klass;
        await ctx.store.setTrustClass(klass);
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
                eventPayload: buildActEvent(dbRun),
                ...root,
              },
            )
          : planJob(workflowYaml, job.jobKey, {
              workflowPath: dbRun.workflowPath,
              event: dbRun.event,
              readFile: checkout.readFile,
              failOnLint,
              eventPayload: buildActEvent(dbRun),
              ...root,
            });
        // The run's own GitHub credential (never an unauthenticated 60-per-hour budget when one
        // exists), a rate-limit wait shared by everything this job fetches, and verdicts kept in
        // the database so a restart or a parallel job does not ask again.
        const token = await o.forgeToken?.({ run: dbRun, scope: ctx.scope });
        const backoff = createBackoff({
          ...o.backoff,
          onWait: (ms, why) =>
            o.out?.(
              job.jobKey,
              `[${job.jobKey}] waiting ${Math.ceil(ms / 1000)}s for GitHub's rate limit (${why})\n`,
            ),
        });
        const cacheOpts = {
          db: o.db,
          scope: ctx.scope,
          ...(o.verdictTtl ? { ttl: o.verdictTtl } : {}),
          ...(o.now ? { now: o.now } : {}),
        };
        // The credential is for the run's own repo and the org's allowlisted owners only, and
        // never for an untrusted run (see pins/action-credentials); every other action is
        // resolved anonymously, so a private repo a workflow names just looks not found.
        const policy = await getActionPolicy(o.db, ctx.scope);
        const creds = actionCredentials({
          token,
          ownRepo: dbRun.repo,
          allowedOwners: policy.allowedOwners,
          // A local run is the operator's own checkout: trusted, whatever event it simulates.
          untrusted: klass === "untrusted_pr" && !dbRun.local,
          local: dbRun.local,
          backoff,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        const fetchOpt = o.fetch ? { fetch: o.fetch } : {};
        plan = await resolvePlanActions(jobPlan, {
          db: o.db,
          scope: ctx.scope,
          klass,
          // The credential and privacy decision is OUTSIDE the cache, so a cache hit can never
          // skip it, and verdicts learned with a token are kept apart from anonymous ones.
          base:
            o.resolver ??
            credentialedResolver(creds, (tk) =>
              cachedResolver({
                ...cacheOpts,
                credentialed: tk !== undefined,
                base: githubResolver(tk, { backoff, ...fetchOpt }),
              }),
            ),
          readFile: checkout.readFile,
          reachable:
            o.reachable ??
            credentialedReachability(creds, (tk) =>
              cachedReachability({
                ...cacheOpts,
                credentialed: tk !== undefined,
                base: githubReachability({ ...(tk ? { token: tk } : {}), backoff, ...fetchOpt }),
              }),
            ),
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
      // The job's own GitHub token, minted now that the job is known and revoked however it ends.
      // Only when the capped permissions need one (a write scope, or a private repository): a
      // public repo's job that needs nothing beyond contents read gets none, and stays as it was.
      let issued: IssuedJobToken | undefined;
      let githubToken: string | undefined;
      const notices: string[] = [...(ctx.notices ?? [])];
      // The proxy is used for the project's vault rules, or because a token needs holding.
      let useProxy = ctx.proxy?.vaultRules === true;
      if (o.jobTokens && repo?.installationId && jobKlass) {
        const plannedJob = job.planned ? (JSON.parse(job.planned) as PlannedJob) : undefined;
        // Behind the proxy the job holds a placeholder. Without it the real token goes in the
        // environment, and only for a class that may hold credentials.
        const envOk = jobKlass === "protected" || jobKlass === "release";
        if (ctx.proxy || envOk) {
          try {
            const r = await o.jobTokens.issue({
              installationId: repo.installationId,
              owner: repo.owner,
              repo: repo.repo,
              klass: jobKlass,
              workflowYaml,
              jobId: plannedJob?.id ?? job.jobKey,
            });
            if ("none" in r) {
              notices.push(`[longshore] GITHUB_TOKEN is not set (${r.none})`);
            } else if (egressForRun(ctx.run.plan, o.egress) === "open") {
              // A job holding a token never runs with open egress.
              await r.revoke();
              return {
                state: "infra_error",
                reason:
                  "this job needs a GitHub token (a write permission, or a private repository), and a job with a token cannot run with open egress",
              };
            } else {
              issued = r;
              if (ctx.proxy) {
                ctx.proxy.setGithubToken(r.token);
                githubToken = PROXIED_TOKEN_PLACEHOLDER;
                useProxy = true;
              } else {
                githubToken = r.token;
              }
              const perms = Object.entries(r.permissions)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ");
              notices.push(
                `[longshore] GITHUB_TOKEN for ${repo.owner}/${repo.repo}: ${perms} (${ctx.proxy ? "added by the proxy" : "in the environment"}), revoked when the job ends`,
                ...r.notes.map((n) => `[longshore] GITHUB_TOKEN: ${n}`),
              );
            }
          } catch (err) {
            // The job runs without a token rather than not at all; its log says so.
            notices.push(
              "[longshore] GITHUB_TOKEN is not available: the installation token could not be minted",
            );
            console.warn(
              `job token for ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      if (o.jobTokens && repo?.installationId && jobKlass && !ctx.proxy && !issued) {
        if (jobKlass !== "protected" && jobKlass !== "release") {
          notices.push(
            "[longshore] GITHUB_TOKEN is not set (this class may not hold a token, and no secrets proxy is running to attach one)",
          );
        }
      }
      // A job that uses neither vault rules nor a token is not proxied, and its egress is unchanged.
      const { proxy: access, ...rest } = ctx;
      const jobCtx: AttemptContext = {
        ...rest,
        notices,
        ...(useProxy && access ? { proxy: access } : {}),
      };
      const revoke = (): void => void issued?.revoke();
      ctx.signal.addEventListener("abort", revoke, { once: true });
      // The job's control-plane cache, if configured and reachable. The URL carries a credential
      // that lasts as long as this attempt, so it is added now (after the plan was stored) and
      // revoked when the run ends, however it ends.
      const jobCache =
        o.cache && jobKlass
          ? await o.cache({
              run: dbRun,
              attemptId: ctx.attempt.id,
              scope: ctx.scope,
              klass: jobKlass,
              egress: egressForRun(ctx.run.plan, o.egress) === "open" ? "open" : "none",
            })
          : undefined;
      try {
        return await run(
          jobCtx,
          jobCache ? rebuildArgv({ ...plan, cacheUrl: jobCache.url }) : plan,
          checkout.tarball,
          githubToken,
          jobCache ? [jobCache.secret] : [],
        );
      } finally {
        jobCache?.release();
        ctx.signal.removeEventListener("abort", revoke);
        await issued?.revoke();
      }
    } finally {
      checkout.dispose?.();
    }
  };
}
