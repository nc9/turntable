// The production AttemptRunner: plans the claimed job from the workflow at the run's sha and runs
// it with act in a provider sandbox. It shares executeJob with `turntable run`, so a job behaves
// the same from the CLI and from the worker.
import { mkdtempSync } from "node:fs";
import { rm as rmAsync } from "node:fs/promises";
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
  workflowFullHistoryJobs,
  workflowSubmodulesJobs,
  workflowHeadCheckouts,
} from "@turntable/act-runner";
import type { JobArtifactProvider } from "../artifacts/job";
import type { JobCacheProvider } from "../cache/job";
import { egressForRun } from "./egress";
import type { Db } from "../db";
import { effectiveChecksMode } from "../ops/setting-guard";
import { ambientSettings } from "../settings/ambient";
import type { SettingsRuntime } from "../settings/resolve";
import { getOrgById, logSize } from "../db/repos/api";
import { listJobs, listRepos, type Run } from "../db/repos";
import { SecretRegistry } from "@turntable/redact";
import { DEFAULT_IMAGE, executeJob } from "../run/job-exec";
import { prefixedOut } from "../run/prefixed-out";
import { buildActEvent } from "../run/act-event";
import { assertCloneHost, isRepoPart } from "../run/checkout";
import {
  CheckoutAuthError,
  type CheckoutConfig,
  DEFAULT_CHECKOUT_CONFIG,
  limitsFor,
  readChildTarball,
  runCheckoutChild,
  Semaphore,
  sweepOldCheckouts,
} from "../run/checkout-child";
import { clean, type FetchLimits } from "../run/git-fetch";
import { deliverSubmodules } from "../run/submodule-fetch";
import { scrubToken } from "../run/scrub-token";
import { tarballReader } from "../run/tarball-reader";
import { treeScanOutcome } from "./tree-scan-outcome";
import { fetchLimitOutcome } from "./fetch-limit-outcome";
import { effectiveCheckoutLimits } from "../run/checkout-limits";
import { resolvePlanActions } from "../pins";
import { normalizeForgeToken, type ForgeToken } from "../pins/forge-token";
import {
  actionCredentials,
  credentialedReachability,
  credentialedResolver,
} from "../pins/action-credentials";
import { githubReachability } from "../pins/reachability";
import { cachedReachability, cachedResolver, type VerdictTtl } from "../pins/verdict-cache";
import { createBackoff, RateLimitedError, type SafeFetch } from "@turntable/net";
import type { ReachabilityChecker } from "../pins/reachability";
import { type RunStore, stepInputOf } from "../run/store";
import { createHash } from "node:crypto";
import { type IssuedJobToken, type JobTokens, SHADOW_LOWERED_NOTICE } from "../github/job-token";
import type { JobOidc } from "../oidc/job-delivery";
import {
  getActionPolicy,
  getProjectSandboxSettings,
  getVerdict,
  parseTrust,
  putVerdict,
} from "../db/repos";
import { resolveRunnerLabelMaps } from "./runner-labels";
import { realiseSize } from "./realise-size";
import {
  dockerRefusal,
  refusalFor,
  type SandboxSizes,
  sizeFor,
  tenantMapRefusal,
  untrustedForSize,
} from "./sandbox-size";
import { assessJob, lintFailsFor, type TrustClass } from "../trust";
import { appendAudit } from "../db/repos/audit";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "./types";

/** The source of a run: a tarball to deliver and the files the planner reads. */
export interface Checkout {
  tarball: Uint8Array;
  readFile(path: string): string | undefined;
  dispose?(): void;
}

export interface RepoSource {
  /** `repo` is undefined for a local run (`turntable run`), which has no bound repo. */
  checkout(
    run: Run,
    repo: { owner: string; repo: string; installationId?: string | null | undefined } | undefined,
    opts?: {
      signal?: AbortSignal | undefined;
      fullHistory?: boolean | undefined;
      /**
       * The size budgets for this checkout's shallow tree (pack, unpacked, tarball), from the
       * project's settings; a full-history delivery multiplies them (see `limitsFor`). Absent:
       * the source's own configuration.
       */
      limits?: Partial<FetchLimits> | undefined;
      /** Also deliver each submodule at its pinned commit (a job's `submodules:` input). */
      submodules?: "true" | "recursive" | undefined;
      /**
       * Whether a same-owner submodule may get an installation token. Only a trusted run does;
       * absent means no, so every submodule is fetched anonymously (a fork PR's token reads only
       * its own repository on GitHub, and an untrusted run must not pull in another private repo).
       */
      submoduleCredentials?: boolean | undefined;
    },
  ): Promise<Checkout>;
}

/**
 * The source of a `turntable run`: the tarball and files already read from the working repo. The
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
 * Fetches exactly the run's commit from a public repo (see run/git-fetch.ts: git's smart-HTTP
 * protocol at depth 1, every object verified), writes the tree and the `.git` git would have made,
 * and packs them the way `turntable run` does. It runs no `git` or `tar` binary, and it runs in a
 * CHILD process of this same binary (run/checkout-child.ts), because it parses hostile input: one
 * deadline, a memory ceiling where the system can enforce one, at most `concurrency` at a time,
 * and killed when the attempt is cancelled. The child writes the tree and a tarball to a private
 * temporary directory; this process reads workflow files through the safe reader and hands the
 * tarball on.
 */
/** What a checkout's installation token may do: read one repository's contents, nothing more. */
export const CHECKOUT_PERMISSIONS = { contents: "read" } as const;

export function gitRepoSource(
  o: {
    cloneUrl?: (owner: string, repo: string) => string;
    /** Hosts besides github.com a clone URL may name. */
    allowHosts?: readonly string[];
    config?: Partial<CheckoutConfig>;
    /** The program that runs a checkout, default this binary (a test seam). */
    command?: string[];
    /**
     * Mints the token for a repo bound to an App installation: that one repository, `contents:
     * read` and nothing more (CHECKOUT_PERMISSIONS). Absent: every checkout is anonymous.
     */
    installationToken?: (installationId: string, repo: string) => Promise<string>;
  } = {},
): RepoSource {
  const url = o.cloneUrl ?? ((owner, repo) => `https://github.com/${owner}/${repo}.git`);
  const cfg = { ...DEFAULT_CHECKOUT_CONFIG, ...o.config };
  const turns = new Semaphore(cfg.concurrency);
  // What an earlier process left in the temporary directory is cleared once, at start.
  if (!sweptOnce) {
    sweptOnce = true;
    void sweepOldCheckouts().catch(() => {});
  }
  return {
    async checkout(run, bound, opts) {
      if (!bound) throw new Error("run has no repo binding");
      const { owner, repo } = bound;
      const installationId = bound.installationId ?? undefined;
      if (!isRepoPart(owner) || !isRepoPart(repo) || run.sha === null) {
        throw new Error("run has no sha or the repo binding is not a plain owner/name");
      }
      const sha = run.sha.toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(sha))
        throw new Error("the run's commit is not a 40 character sha");
      // Like actions/checkout, leave `origin` pointing at the repo, so a step that runs
      // `git fetch origin <sha>` works (it needs egress, and fails closed without it).
      // Never with credentials in the URL.
      const clone = url(owner, repo);
      assertNoCredentials(clone);
      assertCloneHost(clone, o.allowHosts);
      // This checkout's budgets: the project's when the caller resolved them, else the source's.
      const base = { ...cfg.limits, ...opts?.limits };
      const lim = limitsFor(base, opts?.fullHistory === true, cfg.memoryMb);
      const release = await turns.acquire(opts?.signal);
      let token: string | undefined;
      const dir = mkdtempSync(join(tmpdir(), "tt-src-"));
      const out = join(tmpdir(), `tt-src-${crypto.randomUUID()}.tgz`);
      // Removed in the background: a recursive delete of a large tree must not hold the event loop.
      const manifests: string[] = [];
      const cleanup = async (): Promise<void> => {
        await Promise.all([
          rmAsync(dir, { recursive: true, force: true }),
          rmAsync(out, { force: true }),
          ...manifests.map((m) => rmAsync(m, { force: true })),
        ]).catch(() => {});
      };
      try {
        // Minted here, in the parent, just before the child starts (the App's cache keeps it until
        // near expiry). It goes to the child on stdin only.
        if (installationId && o.installationToken) {
          try {
            token = await o.installationToken(installationId, repo);
          } catch (e) {
            throw new Error(
              `could not mint an installation token for the checkout: ${clean(e instanceof Error ? e.message : String(e))}`,
            );
          }
        }
        const startedAt = Date.now();
        const submodules = opts?.submodules;
        const manifest = join(tmpdir(), `tt-src-${crypto.randomUUID()}.json`);
        manifests.push(manifest);
        let res = await runCheckoutChild({
          ...(token ? { token } : {}),
          ...(opts?.fullHistory ? { fullHistory: true } : {}),
          owner,
          repo,
          sha,
          ...(o.cloneUrl ? { url: clone } : {}),
          dir,
          out,
          // With submodules the main tree is written and listed first; the tarball is made last,
          // over the tree and the modules together.
          ...(submodules ? { stage: "tree" as const, manifest } : {}),
          allowHosts: o.allowHosts ?? [],
          config: { ...cfg, limits: base },
          signal: opts?.signal,
          ...(o.command ? { command: o.command } : {}),
        });
        if (submodules) {
          if (res.sha !== sha)
            throw new Error("the checkout is of a different commit than the one asked for");
          await deliverSubmodules({
            mode: submodules,
            root: dir,
            manifest,
            main: res,
            owner,
            ...(opts?.submoduleCredentials === true
              ? { installationId, mint: o.installationToken }
              : {}),
            cloneUrl: o.cloneUrl,
            allowHosts: o.allowHosts ?? [],
            config: { ...cfg, limits: base },
            ...(opts?.fullHistory ? { fullHistory: true } : {}),
            startedAt,
            signal: opts?.signal,
            command: o.command,
          });
          const left = cfg.timeoutMs - (Date.now() - startedAt);
          if (left <= 1000) throw new Error("the checkout took too long");
          res = await runCheckoutChild({
            stage: "pack",
            // The tarball cap is the full-history one when the tree was.
            ...(opts?.fullHistory ? { fullHistory: true } : {}),
            owner,
            repo,
            sha,
            dir,
            out,
            allowHosts: o.allowHosts ?? [],
            config: { ...cfg, limits: base, timeoutMs: left },
            signal: opts?.signal,
            ...(o.command ? { command: o.command } : {}),
          });
        }
        // The child is not trusted: what it says it fetched, and the file it wrote, are checked.
        if (res.sha !== sha)
          throw new Error("the checkout is of a different commit than the one asked for");
        const tarball = await readChildTarball(out, {
          maxBytes: lim.maxTarballBytes,
          expectBytes: res.tarballBytes,
        });
        // Planned from the bytes that will be delivered, never from the directory the child also wrote.
        const readFile = await tarballReader(tarball, {
          maxUnpackedBytes: 2 * lim.maxInflatedBytes + 64 * 1024 * 1024,
        });
        void cleanup(); // the tree and the file are not needed any more
        return { tarball, readFile, dispose: () => {} };
      } catch (err) {
        await cleanup();
        if (token && err instanceof Error) err.message = scrubToken(err.message, token);
        throw err;
      } finally {
        release();
      }
    },
  };
}

let sweptOnce = false;

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
  /** Gives a job its artifact access (see artifacts/job.ts). Absent: the artifact actions fail. */
  artifacts?: JobArtifactProvider;
  /** Sandbox root the job layout is planned under (a fake provider needs a host path). */
  planRoot?: string;
  /** Live terminal output of a job, line by line (`turntable run` prints it with a key prefix). */
  out?: (jobKey: string, text: string) => void;
  /**
   * Gives each job its own GitHub token as GITHUB_TOKEN (see github/job-token): minted at job
   * start for the run's repository with the workflow's declared permissions, capped by the trust
   * class and the App's grant, revoked when the job ends. Absent: jobs get no GITHUB_TOKEN.
   */
  jobTokens?: JobTokens;
  /**
   * The settings layers (env, `turntable.toml`) the project's effective `checks_mode` is read
   * through when a job token is issued. Default: the process's own (`ambientSettings`).
   */
  settings?: SettingsRuntime;
  /**
   * Gives a job that asked for it (`permissions: id-token: write`) GitHub's OIDC request
   * variables, for a class the issuer allows. Behind the secrets proxy only: the request token is
   * a placeholder and the proxy attaches the real credential. Absent: jobs get no OIDC variables.
   */
  jobOidc?: JobOidc;

  /** The operator's map from `runs-on` labels to a sandbox size (see sandbox-size.ts). Absent: the provider's default size. */
  sizes?: SandboxSizes;
  /** Seconds to wait for a docker-class sandbox's daemon before the job fails as infra. Default 30. */
  dockerWaitSeconds?: number;
};

/** The image act runs a docker-class job in, unless the operator sets `dockerJobImage`. */
export const DEFAULT_DOCKER_JOB_IMAGE = "catthehacker/ubuntu:act-latest";

/** What GITHUB_TOKEN holds inside a job that is behind the secrets proxy. The proxy attaches the real one. */
export const PROXIED_TOKEN_PLACEHOLDER = "turntable-token-is-added-by-the-proxy";

/**
 * The persistence executeJob writes to while a worker runs an attempt. Every write goes through
 * the lease-fenced attempt store. The final state is NOT written here: the scheduler records the
 * outcome (fenced) once the runner returns, so `finishJob` and the run-level calls do nothing.
 */
/**
 * Whether this job's submodules may be fetched with the installation token: only when the class
 * it will run as (the same rule as the job start: the ingest class is a ceiling, the demotion
 * rule only lowers it) is trusted. Anything else, or anything unreadable, is anonymous.
 */
function submoduleCredentialsFor(
  workflowYaml: string,
  dbRun: Run,
  job: { jobKey: string; planned?: string | null },
): boolean {
  try {
    const pj = job.planned ? (JSON.parse(job.planned) as PlannedJob) : undefined;
    const head = workflowHeadCheckouts(workflowYaml)[pj?.id ?? job.jobKey] ?? [];
    const assessed = assessJob({ event: dbRun.event, ref: dbRun.ref }, head.length > 0);
    const klass = assessed.demotedFrom
      ? assessed.klass
      : (parseTrust(dbRun)?.class ?? assessed.klass);
    return !untrustedForSize(klass, false);
  } catch {
    return false;
  }
}

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
    setSandbox: (_id, sandboxId, createdAt, ttlSeconds) =>
      ctx.store.setExec({
        sandboxId,
        ...(createdAt === undefined ? {} : { sandboxCreatedAt: createdAt }),
        ...(ttlSeconds === undefined ? {} : { sandboxTtlSeconds: ttlSeconds }),
      }),
    setSandboxDestroyed: (_id, at) => ctx.store.setExec({ sandboxDestroyedAt: at }),
    setExec: (_id, execId) => ctx.store.setExec({ execId }),
    resetOutput: () => ctx.store.reset(),
    ...(ctx.store.truncate
      ? { truncateOutput: (_id: string, logOffset: number) => ctx.store.truncate!(logOffset) }
      : {}),
    ...(ctx.store.setLogCheckpoint
      ? {
          setLogCheckpoint: (_id: string, execOffset: number, logOffset: number) =>
            ctx.store.setLogCheckpoint!(execOffset, logOffset),
        }
      : {}),
    appendLog: (_id, offset, bytes) => ctx.store.appendLog(offset, bytes),
    addCut: (_id, cut) => ctx.store.addCut(cut),
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
  // Attempts whose sandbox has been handed to `executeJob`, which destroys it however it ends.
  const handedOff = new Set<string>();
  const run = async (
    ctx: AttemptContext,
    plan: JobPlan,
    repoTarball: Uint8Array | undefined,
    githubToken?: string,
    secrets: readonly string[] = [],
    oidc?: { requestUrl: string; requestToken: string },
    /** The job's effective class (after demotion); on a re-attach, the one recorded for the attempt. */
    effectiveClass?: string | null,
  ): Promise<AttemptOutcome> => {
    const registry = ctx.redact ?? new SecretRegistry();
    // A real token in the environment is something the log must never show.
    if (githubToken !== undefined && githubToken !== PROXIED_TOKEN_PLACEHOLDER) {
      registry.register(githubToken);
    }
    // Values that must never reach the job log: act echoes env and URLs when it is verbose.
    for (const v of secrets) registry.register(v);
    const planned = ctx.job.planned ? (JSON.parse(ctx.job.planned) as PlannedJob) : undefined;
    const untrusted = untrustedForSize(effectiveClass ?? ctx.attempt.trustClass, ctx.run.local);
    // Tenant label maps never apply to an untrusted run (sizeFor ignores labels for it anyway).
    const dockerMode = plan.docker !== undefined;
    // A job routed to the docker class ignores label maps (the operator's `dockerClass` decides).
    const overrides =
      o.sizes && !untrusted && !dockerMode ? await resolveRunnerLabelMaps(o.db, ctx.scope) : [];
    if (dockerMode) {
      // Also on a re-attach: the config or the provider may have changed since the plan was stored.
      const why = dockerRefusal(o.sizes, "needs Docker", {
        untrusted,
        provider: ctx.provider.info,
      });
      if (why) {
        await ctx.store.appendLog(0, new TextEncoder().encode(`${why}\n`));
        o.out?.(ctx.job.jobKey, `[${ctx.job.jobKey}] ${why}\n`);
        return { state: "failure", reason: why };
      }
    }
    // A stored tenant entry for a class the org may no longer select (the operator changed
    // `tenantSelectable` or `orgs` after the map was set) fails the job with the reason, before any
    // sandbox exists. It never falls back to the instance map or the default: that would hide
    // size-dependent bugs behind confusing OOMs and timeouts.
    const mapWhy = dockerMode
      ? undefined
      : tenantMapRefusal(o.sizes, planned?.runsOn ?? [], {
          untrusted,
          overrides,
          orgSlug:
            o.sizes && !untrusted ? (await getOrgById(o.db, ctx.scope.orgId))?.slug : undefined,
        });
    if (mapWhy) {
      await ctx.store.appendLog(0, new TextEncoder().encode(`${mapWhy}\n`));
      o.out?.(ctx.job.jobKey, `[${ctx.job.jobKey}] ${mapWhy}\n`);
      return { state: "failure", reason: mapWhy };
    }
    const size = sizeFor(o.sizes, planned?.runsOn ?? [], {
      untrusted,
      overrides,
      docker: dockerMode,
    });
    const realised = realiseSize(ctx.provider, size);
    if (!realised.ok) {
      const why = `unsupported: the sandbox provider cannot realise size class ${size.class ?? ""}: ${realised.reason}`;
      await ctx.store.appendLog(0, new TextEncoder().encode(`${why}\n`));
      o.out?.(ctx.job.jobKey, `[${ctx.job.jobKey}] ${why}\n`);
      return { state: "failure", reason: why };
    }
    const sink = o.out
      ? prefixedOut((text) => o.out?.(ctx.job.jobKey, text), ctx.job.jobKey)
      : undefined;
    // The project's own snapshot (set by the instance operator) beats the provider's default.
    const { sandboxSnapshot } = await getProjectSandboxSettings(o.db, ctx.scope);
    // Past the last early exit: from here `executeJob` owns the sandbox and destroys it.
    handedOff.add(ctx.attempt.id);
    const res = await executeJob(
      {
        provider: ctx.provider,
        store: workerStore(ctx),
        // Not for a docker-class job: the project's snapshot would replace the one with the daemon.
        ...(sandboxSnapshot && !dockerMode ? { snapshot: sandboxSnapshot } : {}),
        ...(o.dockerWaitSeconds !== undefined ? { dockerWaitSeconds: o.dockerWaitSeconds } : {}),
        out: sink ? sink.out : () => {},
        registry,
        ...(ctx.proxy ? { proxy: ctx.proxy } : {}),
        ...(realised.sandbox ? { sandbox: realised.sandbox } : {}),
        ...(githubToken !== undefined ? { githubToken } : {}),
        ...(oidc ? { oidc } : {}),
        // A job holding a minted token, in its environment or behind the proxy, is secret-bearing:
        // an egress canary that cannot verify isolation refuses it instead of letting it run.
        ...(githubToken !== undefined || oidc ? { secretBearing: true } : {}),
        signal: ctx.signal,
        ...(ctx.detach ? { detach: ctx.detach } : {}),
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
      // says which events are this job's and which outputs to read. The checkpoint, when the
      // attempt has one, keeps the stored log and renders only what follows it (#761).
      ctx.resume
        ? {
            ...ctx.resume,
            ...(ctx.attempt.execLogOffset !== null && ctx.attempt.logCheckpoint !== null
              ? {
                  checkpoint: {
                    execOffset: ctx.attempt.execLogOffset,
                    logOffset: ctx.attempt.logCheckpoint,
                  },
                }
              : {}),
          }
        : undefined,
    ).finally(() => sink?.flush());
    return {
      state: res.state,
      ...(res.actExitCode === undefined ? {} : { exitCode: res.actExitCode }),
      reason: res.reason,
      ...(res.outputs ? { outputs: res.outputs } : {}),
      ...(res.infraKind ? { infraKind: res.infraKind } : {}),
      ...(res.errorName ? { errorName: res.errorName } : {}),
      ...(res.errorCode ? { errorCode: res.errorCode } : {}),
    };
  };

  /**
   * An attempt that is resumed inherits a sandbox (and its exec) from a dead worker. When it ends
   * before `executeJob` takes over, nothing else would release it until its TTL or the sweeper.
   * This does what a cancel does: stop the exec if it still runs, destroy the sandbox through the
   * provider and record the destroy; plus one job-log line and one audit entry.
   */
  const releaseInherited = async (
    ctx: AttemptContext,
    reason: string,
    logged: () => number,
  ): Promise<void> => {
    const resume = ctx.resume;
    if (!resume) return;
    const { sandboxId, execId } = resume;
    try {
      const st = await ctx.provider.exec.status(sandboxId, execId);
      if (st.state === "running") await ctx.provider.exec.kill(sandboxId, execId, "KILL");
    } catch {
      // destroying the sandbox below ends the exec anyway
    }
    let failure: string | undefined;
    try {
      await ctx.provider.destroy(sandboxId);
    } catch (e) {
      // The sandbox's own TTL or the sweeper ends it; nothing is recorded as destroyed.
      failure = String(e);
    }
    if (failure === undefined) {
      await ctx.store.setExec({ sandboxDestroyedAt: Date.now() }).catch(() => undefined);
    }
    const line =
      failure === undefined
        ? `[turntable] released sandbox ${sandboxId}: ${reason}`
        : `[turntable] could not release sandbox ${sandboxId} (${failure}): ${reason}`;
    await ctx.store
      .appendLog(logged(), new TextEncoder().encode(`${line}\n`))
      .catch(() => undefined);
    o.out?.(ctx.job.jobKey, `[${ctx.job.jobKey}] ${line}\n`);
    await appendAudit(o.db, ctx.scope, {
      principalKind: "system",
      principalId: "scheduler",
      op: "sandbox.release_resumed",
      effect: "write",
      outcome: failure === undefined ? "ok" : "error",
      input: {
        sandbox_id: sandboxId,
        attempt_id: ctx.attempt.id,
        job_id: ctx.job.id,
        reason,
        ...(failure === undefined ? {} : { error: failure.slice(0, 200) }),
      },
    }).catch(() => undefined);
  };

  const attemptRunner: AttemptRunner = async (ctx) => {
    // A job Turntable cannot run (macOS, Windows, arm without a capable provider, docker,
    // services, ...) fails with its reason. It is never `skipped`: branch protection counts a
    // skipped required check as passing, so a skip would let a PR merge unchecked. The workflow's
    // own false `if:` already skipped it before it got here.
    if (!ctx.resume) {
      const planned0 = ctx.job.planned ? (JSON.parse(ctx.job.planned) as PlannedJob) : undefined;
      const why = refusalFor(planned0, ctx.provider.info.arch);
      if (why) {
        await ctx.store.appendLog(0, new TextEncoder().encode(`${why}\n`));
        o.out?.(ctx.job.jobKey, `[${ctx.job.jobKey}] ${why}\n`);
        return { state: "failure", reason: why };
      }
    }
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

    let checkout: Checkout;
    // The project's checkout budgets (#677), read once for both fetches of this job.
    const checkoutLimits =
      repo && !dbRun.local
        ? await effectiveCheckoutLimits(
            o.settings ?? ambientSettings(),
            o.db,
            ctx.scope.orgId,
            ctx.scope.projectId,
          )
        : undefined;
    try {
      checkout = await o.source.checkout(
        dbRun,
        repo
          ? { owner: repo.owner, repo: repo.repo, installationId: repo.installationId }
          : undefined,
        { signal: ctx.signal, ...(checkoutLimits ? { limits: checkoutLimits } : {}) },
      );
    } catch (e) {
      // A refused credential is not transient: its own kind, so it is never retried.
      if (e instanceof CheckoutAuthError)
        return { state: "infra_error", infraKind: "checkout_auth_failed", reason: e.message };
      const scan = treeScanOutcome(e) ?? fetchLimitOutcome(e);
      if (scan) {
        await ctx.store.appendLog(0, new TextEncoder().encode(scan.logLine));
        o.out?.(ctx.job.jobKey, `[${ctx.job.jobKey}] ${scan.logLine}`);
        return scan.outcome;
      }
      throw e;
    }
    try {
      const workflowYaml = checkout.readFile(dbRun.workflowPath);
      if (workflowYaml === undefined) {
        return {
          state: "infra_error",
          reason: `workflow ${dbRun.workflowPath} not found at ${dbRun.sha}`,
        };
      }
      // Depth 1 is the default. Only a job whose checkout asks for more (fetch-depth 0, a depth
      // above 1, fetch-tags) gets the full history, the tags and the default branch: the commit is
      // fetched again that way, and fails with the reason when the repository is over the caps.
      if (repo && !dbRun.local) {
        let wantsFull = false;
        let wantsSubmodules: "true" | "recursive" | undefined;
        try {
          const pj = job.planned ? (JSON.parse(job.planned) as PlannedJob) : undefined;
          const id = pj?.id ?? job.jobKey;
          wantsFull = workflowFullHistoryJobs(workflowYaml)[id] === true;
          // `submodules: true|recursive` (the default is false): the modules at their pinned
          // commits are delivered too, under the checkout's own limits and rules.
          wantsSubmodules = workflowSubmodulesJobs(workflowYaml)[id];
        } catch {
          // a workflow that does not parse fails in the planner below, with its own reason
        }
        if (wantsFull || wantsSubmodules) {
          checkout.dispose?.();
          try {
            checkout = await o.source.checkout(
              dbRun,
              { owner: repo.owner, repo: repo.repo, installationId: repo.installationId },
              {
                signal: ctx.signal,
                ...(checkoutLimits ? { limits: checkoutLimits } : {}),
                ...(wantsFull ? { fullHistory: true } : {}),
                ...(wantsSubmodules
                  ? {
                      submodules: wantsSubmodules,
                      submoduleCredentials: submoduleCredentialsFor(workflowYaml, dbRun, job),
                    }
                  : {}),
              },
            );
          } catch (e) {
            if (e instanceof CheckoutAuthError)
              return { state: "infra_error", infraKind: "checkout_auth_failed", reason: e.message };
            const scan = treeScanOutcome(e) ?? fetchLimitOutcome(e);
            if (scan) {
              await ctx.store.appendLog(0, new TextEncoder().encode(scan.logLine));
              o.out?.(ctx.job.jobKey, `[${ctx.job.jobKey}] ${scan.logLine}`);
              return scan.outcome;
            }
            return {
              state: "infra_error",
              reason: `checkout: ${clean(e instanceof Error ? e.message : String(e), 400)}`,
            };
          }
        }
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
        // A job with `services:` or `container:` runs in act's container mode on the docker class,
        // or fails here with the reason. Every other job is untouched.
        let docker: { image: string } | undefined;
        if (planned?.needsDocker !== undefined) {
          const why = dockerRefusal(o.sizes, planned.needsDocker, {
            untrusted: untrustedForSize(klass, dbRun.local),
            provider: ctx.provider.info,
          });
          if (why) {
            await ctx.store.appendLog(0, new TextEncoder().encode(`${why}\n`));
            o.out?.(job.jobKey, `[${job.jobKey}] ${why}\n`);
            return { state: "failure", reason: why };
          }
          docker = { image: o.sizes?.dockerJobImage ?? DEFAULT_DOCKER_JOB_IMAGE };
        }
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
                workflowPath: `.turntable/jobs/${safeName(planned.key)}.yml`,
                event: dbRun.event,
                readFile: checkout.readFile,
                split: true,
                failOnLint,
                ...(planned.vars ? { vars: planned.vars } : {}),
                ...(docker ? { docker } : {}),
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
        const cred = normalizeForgeToken(await o.forgeToken?.({ run: dbRun, scope: ctx.scope }));
        const token = cred?.token;
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
          publicActions: cred?.publicActions === true,
          publicCache: {
            get: async (repo) =>
              (
                await getVerdict(
                  o.db,
                  ctx.scope,
                  { kind: "public", repo },
                  PUBLIC_TTL_MS,
                  o.now?.() ?? Date.now(),
                )
              )?.verdict === true,
            put: (repo) =>
              putVerdict(
                o.db,
                ctx.scope,
                { kind: "public", repo, sha: "", verdict: true },
                { now: o.now?.() ?? Date.now() },
              ),
          },
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
        // GitHub's limit outlasted this job's wait budget: nothing ran, so requeue the attempt
        // (once, after the reset) instead of failing the job (#621).
        const limited = rateLimitOf(err);
        if (limited) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.store.appendLog(0, new TextEncoder().encode(`${msg}\n`));
          return {
            state: "infra_error",
            infraKind: "github_rate_limited",
            reason: msg,
            ...(limited.waitMs !== undefined ? { retryAfterMs: limited.waitMs } : {}),
          };
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
      // Only when the capped permissions need one (a write scope or a read beyond contents): a
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
            // Read now, at issue time: a project that is not live never holds a write token.
            const readOnly =
              (await effectiveChecksMode(
                o.settings ?? ambientSettings(),
                o.db,
                ctx.scope.orgId,
                ctx.scope.projectId,
              )) !== "live";
            const r = await o.jobTokens.issue({
              readOnly,
              installationId: repo.installationId,
              owner: repo.owner,
              repo: repo.repo,
              klass: jobKlass,
              workflowYaml,
              jobId: plannedJob?.id ?? job.jobKey,
            });
            if ("none" in r) {
              notices.push(`[turntable] GITHUB_TOKEN is not set (${r.none})`);
              if (r.lowered) notices.push(`[turntable] ${SHADOW_LOWERED_NOTICE}`);
            } else if (egressForRun(ctx.run.plan, o.egress) === "open") {
              // A job holding a token never runs with open egress.
              await r.revoke();
              return {
                state: "infra_error",
                reason: `this job needs a GitHub token (a write permission, or a private repository), and a job with a token cannot run with open egress${r.needs.length > 0 ? ` (it needs: ${r.needs.join(", ")})` : ""}`,
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
                `[turntable] GITHUB_TOKEN for ${repo.owner}/${repo.repo}: ${perms} (${ctx.proxy ? "added by the proxy" : "in the environment"}), revoked when the job ends`,
                ...r.notes.map((n) => `[turntable] GITHUB_TOKEN: ${n}`),
                ...(r.lowered ? [`[turntable] ${SHADOW_LOWERED_NOTICE}`] : []),
              );
            }
          } catch (err) {
            // The job runs without a token rather than not at all; its log says so.
            notices.push(
              "[turntable] GITHUB_TOKEN is not available: the installation token could not be minted",
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
            "[turntable] GITHUB_TOKEN is not set (this class may not hold a token, and no secrets proxy is running to attach one)",
          );
        }
      }
      // The job's OIDC request variables, when it asked and its class may mint. Only behind the
      // proxy, which holds the credential; a job with no proxy gets nothing and the log says so.
      let oidcVars: { requestUrl: string; requestToken: string } | undefined;
      if (o.jobOidc && jobKlass) {
        const r = await o.jobOidc.issue({
          orgId: ctx.scope.orgId,
          attemptId: ctx.attempt.id,
          klass: jobKlass,
          planned: job.planned,
        });
        if ("none" in r) {
          // Silent when the job never asked: most jobs do not.
          if (r.none !== "the job did not ask for it")
            notices.push(`[turntable] ACTIONS_ID_TOKEN_REQUEST_URL is not set (${r.none})`);
        } else if (!ctx.proxy) {
          notices.push(
            "[turntable] ACTIONS_ID_TOKEN_REQUEST_URL is not set (no secrets proxy is running to attach the credential)",
          );
        } else if (egressForRun(ctx.run.plan, o.egress) === "open") {
          return {
            state: "infra_error",
            reason:
              "this job asked for an OIDC identity token, and a job that can mint one cannot run with open egress",
          };
        } else {
          ctx.proxy.setOidcMinter(r.credentialFor);
          oidcVars = { requestUrl: r.requestUrl, requestToken: r.requestToken };
          useProxy = true;
          notices.push(
            "[turntable] ID token: ACTIONS_ID_TOKEN_REQUEST_URL points at this org's issuer, the credential is added by the proxy",
          );
        }
      }
      // A job with no network of its own that uploads artifacts reaches the artifact service
      // through the proxy, which lets it through to the upload endpoints and nothing else; the
      // credential it holds there is upload-only. With open egress it reaches the service itself.
      const artifactsViaProxy =
        ctx.proxy?.artifactUpload === true && egressForRun(ctx.run.plan, o.egress) !== "open";
      if (artifactsViaProxy) useProxy = true;
      // A job that uses none of vault rules, a token or an artifact upload is not proxied, and
      // its egress is unchanged.
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
      // Likewise the artifact credential (ACTIONS_RUNTIME_TOKEN), for upload and download-artifact.
      const jobArtifacts =
        o.artifacts && jobKlass
          ? o.artifacts({
              runId: dbRun.id,
              attemptId: ctx.attempt.id,
              scope: ctx.scope,
              klass: jobKlass,
              egress: egressForRun(ctx.run.plan, o.egress) === "open" ? "open" : "none",
              local: dbRun.local === true,
              proxyRoute: artifactsViaProxy,
            })
          : undefined;
      // Whether another controller may re-attach to this job (#761), recorded before its exec
      // starts. A job behind the secrets proxy or holding an artifact credential depends on state
      // only this process has (the proxy's attempt registration, the in-memory grant): it is not.
      // The cache grant is in memory too, but a job that loses it only loses its cache.
      await ctx.store.setExec({
        adoptBlock:
          useProxy && access ? "secrets proxy" : jobArtifacts ? "artifact credential" : null,
      });
      try {
        return await run(
          jobCtx,
          jobCache || jobArtifacts
            ? rebuildArgv({
                ...plan,
                ...(jobCache ? { cacheUrl: jobCache.url } : {}),
                ...(jobArtifacts
                  ? {
                      artifacts: { resultsUrl: jobArtifacts.resultsUrl, token: jobArtifacts.token },
                    }
                  : {}),
              })
            : plan,
          checkout.tarball,
          githubToken,
          [...(jobCache ? [jobCache.secret] : []), ...(jobArtifacts ? [jobArtifacts.token] : [])],
          oidcVars,
          jobKlass,
        );
      } finally {
        jobCache?.release();
        jobArtifacts?.release();
        ctx.signal.removeEventListener("abort", revoke);
        // Handed off (#761): the job runs on under the next controller and keeps its token.
        if (!ctx.detach?.aborted) await issued?.revoke();
      }
    } finally {
      checkout.dispose?.();
    }
  };

  return async (ctx) => {
    // A fresh attempt has no sandbox yet: nothing to release.
    if (!ctx.resume) return attemptRunner(ctx);
    const id = ctx.attempt.id;
    // The job-log lines an early exit writes. The stored log holds the dead worker's partial
    // output: when the runner exits before re-attaching, nothing can be replayed (the sandbox is
    // released), so that log is the only record and these lines are appended after it. A runner
    // that does re-attach resets the log itself (`executeJob`) before it replays the exec.
    let written = 0;
    let base: number | undefined;
    const store: AttemptContext["store"] = {
      ...ctx.store,
      appendLog: async (offset, bytes) => {
        if (handedOff.has(id)) return ctx.store.appendLog(offset, bytes);
        base ??= await logSize(o.db, ctx.scope, id).catch(() => 0);
        written = Math.max(written, base + offset + bytes.length);
        return ctx.store.appendLog(base + offset, bytes);
      },
    };
    const rctx: AttemptContext = { ...ctx, store };
    const release = async (reason: string): Promise<void> => {
      base ??= await logSize(o.db, ctx.scope, id).catch(() => 0);
      written = Math.max(written, base);
      // `rctx.store` adds the base itself, so the release line's offset is relative to it.
      await releaseInherited(rctx, reason, () => written - (base ?? 0));
    };
    handedOff.delete(id);
    try {
      if (ctx.signal.aborted) {
        await release("cancelled before re-attaching");
        return { state: "cancelled", reason: "cancelled by user" };
      }
      const outcome = await attemptRunner(rctx);
      if (!handedOff.has(id)) await release(`ended before re-attaching: ${outcome.reason}`);
      return outcome;
    } catch (err) {
      if (!handedOff.has(id)) {
        await release(
          ctx.signal.aborted
            ? "cancelled before re-attaching"
            : `error before re-attaching: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    } finally {
      handedOff.delete(id);
    }
  };
}

/** The rate limit behind an error (it is wrapped in an InfraError on the way up), if any. */
function rateLimitOf(err: unknown): RateLimitedError | undefined {
  for (let e: unknown = err, i = 0; e instanceof Error && i < 4; i++) {
    if (e instanceof RateLimitedError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * How long "this action repo is public" is remembered (#621). Short, because the check is what
 * keeps a repo made private from being read with a token: a second run in the window makes no
 * call, and a repo made private is noticed within it.
 */
const PUBLIC_TTL_MS = 10 * 60_000;
