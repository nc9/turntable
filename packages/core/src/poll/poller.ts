import type { Db } from "../db";
import { listIngestBindings } from "../db/repos";
import { backoffMs } from "./backoff";
import {
  ingestSettingsSchema,
  type PollConfig,
  type PollRepoConfig,
  readPollToken,
} from "./config";
import { type FetchLike, GithubClient, RateLimited } from "./github";
import { pollRepo } from "./ingest";
import { ingestStatus, type RepoStatus } from "./status";

export type PollerOptions = {
  db: Db;
  config: PollConfig;
  fetch?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Also poll repos bound to a project through an installation, for projects that have ingest
   * settings (`longshore policy set --ingest`). A binding alone never causes ingest. A repo in the
   * static config wins over a binding of the same name.
   */
  bindings?: boolean;
  /** Called after a poll that queued runs, so the scheduler can start them at once. */
  onQueued?: () => void;
  /**
   * Called when a cancel-in-progress run took over running attempts of older runs: their workers
   * must stop and their sandboxes be destroyed.
   */
  onSuperseded?: (
    running: { attemptId: string; sandboxId: string | null; provider: string }[],
  ) => void;
};

/** Below this many requests left in the window the poller stops asking until it resets. */
const RESERVE = 5;
/** The fewest ms between two polls of one repo that webhooks asked for. */
export const MIN_NUDGE_GAP_MS = 5000;

/**
 * Polls every configured repo on its own interval. The token (read once from its file) is handed
 * to the read-only client and never logged. Failures back off exponentially, never shorter than
 * `Retry-After` or the rate-limit reset GitHub reported; a success resets the backoff. When the
 * remaining budget is nearly gone the poller waits for the reset instead of spending it.
 */
export class Poller {
  readonly #o: PollerOptions;
  readonly #github: GithubClient;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #failures = new Map<string, number>();
  readonly #overCap = new Set<string>();
  readonly #busy = new Set<string>();
  readonly #again = new Set<string>();
  readonly #lastStart = new Map<string, number>();
  /** Repos from installation bindings with ingest settings, by lower-case `owner/name`. */
  readonly #bound = new Map<string, PollRepoConfig>();
  #refreshing: Promise<void> | undefined;
  #lastRefresh = 0;
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(o: PollerOptions) {
    this.#o = o;
    const token = readPollToken(o.config);
    this.#github = new GithubClient({
      ...(o.fetch ? { fetch: o.fetch } : {}),
      baseUrl: o.config.apiBaseUrl,
      token,
      ...(o.now ? { now: o.now } : {}),
    });
    for (const r of o.config.repos) this.#track(r);
  }

  /** The config of a repo this poller serves: the static config first, then a binding. */
  #cfg(repo: string): PollRepoConfig | undefined {
    const l = repo.toLowerCase();
    return this.#o.config.repos.find((r) => r.repo.toLowerCase() === l) ?? this.#bound.get(l);
  }

  #allRepos(): PollRepoConfig[] {
    return [...this.#o.config.repos, ...this.#bound.values()];
  }

  /**
   * Reads the repos bound to projects that have ingest settings. New ones start polling (when
   * running), removed ones stop at their next tick. Invalid settings are logged and skipped.
   * Coalesced, and at most once per MIN_NUDGE_GAP_MS.
   */
  refreshBindings(): Promise<void> {
    if (!this.#o.bindings) return Promise.resolve();
    if (this.#refreshing) return this.#refreshing;
    if (this.#now() - this.#lastRefresh < MIN_NUDGE_GAP_MS) return Promise.resolve();
    this.#refreshing = this.#refresh().finally(() => {
      this.#refreshing = undefined;
      this.#lastRefresh = this.#now();
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const log = this.#o.log ?? (() => {});
    const next = new Map<string, PollRepoConfig>();
    for (const b of await listIngestBindings(this.#o.db)) {
      const name = `${b.owner}/${b.repo}`;
      const key = name.toLowerCase();
      if (this.#o.config.repos.some((r) => r.repo.toLowerCase() === key)) continue;
      if (next.has(key)) {
        log(`ingest ${name}: bound to more than one project; only the first is ingested`);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(b.config);
      } catch {
        log(`ingest ${name}: settings are not JSON; skipped`);
        continue;
      }
      const parsed = ingestSettingsSchema.safeParse(raw);
      if (!parsed.success) {
        log(`ingest ${name}: invalid settings; skipped`);
        continue;
      }
      const { defaultBranch, ...rest } = parsed.data;
      next.set(key, {
        repo: name,
        org: b.orgSlug,
        project: b.projectSlug,
        ...rest,
        // Unset: resolved from GitHub at each poll.
        defaultBranch: defaultBranch ?? "",
        untrustedEgress: "none",
        maxNewPrsPerPoll: 5,
        maxWaitingRuns: 20,
        maxRunsPerHour: 30,
      });
    }
    for (const key of this.#bound.keys()) if (!next.has(key)) this.#bound.delete(key);
    for (const [key, cfg] of next) {
      const fresh = !this.#bound.has(key);
      this.#bound.set(key, cfg);
      if (fresh) {
        this.#track(cfg);
        if (this.#running) void this.#loop(cfg.repo);
      }
    }
  }

  #track(r: PollRepoConfig): void {
    if (ingestStatus.repos.has(r.repo)) return;
    ingestStatus.repos.set(r.repo, {
      repo: r.repo,
      org: r.org,
      project: r.project,
      lastPollAt: null,
      lastOutcome: null,
      lastError: null,
      nextPollAt: null,
      consecutiveFailures: 0,
      runsCreated: 0,
    });
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** Polls every repo once, now. For tests. */
  async pollAll(): Promise<void> {
    await this.refreshBindings();
    for (const cfg of this.#allRepos()) await this.#pollOne(cfg.repo);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    ingestStatus.running = true;
    for (const cfg of this.#o.config.repos) void this.#loop(cfg.repo);
    if (this.#o.bindings) {
      void this.refreshBindings().catch((e) =>
        this.#o.log?.(`ingest bindings: ${e instanceof Error ? e.message : String(e)}`),
      );
      this.#refreshTimer = setInterval(() => {
        void this.refreshBindings().catch((e) =>
          this.#o.log?.(`ingest bindings: ${e instanceof Error ? e.message : String(e)}`),
        );
      }, 60_000);
    }
  }

  stop(): void {
    this.#running = false;
    ingestStatus.running = false;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  /** Polls one repo and returns how long to wait before the next poll. */
  async #pollOne(repo: string): Promise<number> {
    const cfg = this.#cfg(repo)!;
    const log = this.#o.log ?? (() => {});
    const status = ingestStatus.repos.get(repo) as RepoStatus;
    const intervalMs = cfg.intervalSeconds * 1000;
    const now = this.#now();

    const finish = (
      outcome: RepoStatus["lastOutcome"],
      error: string | null,
      waitMs: number,
    ): number => {
      status.lastPollAt = now;
      status.lastOutcome = outcome;
      status.lastError = error;
      status.nextPollAt = now + waitMs;
      status.consecutiveFailures = this.#failures.get(repo) ?? 0;
      ingestStatus.rateLimit = this.#github.rateLimit ?? ingestStatus.rateLimit;
      return waitMs;
    };

    // Nearly out of budget: do not spend the rest, wait for the window to reset.
    const rate = this.#github.rateLimit;
    if (
      rate?.remaining !== undefined &&
      rate.remaining <= RESERVE &&
      rate.resetAt !== undefined &&
      rate.resetAt > now
    ) {
      const wait = Math.max(rate.resetAt - now, intervalMs);
      log(
        `poll ${repo}: ${rate.remaining} requests left, waiting ${Math.round(wait / 1000)}s for the reset`,
      );
      return finish("rate_limited", "rate limit budget nearly spent", wait);
    }

    try {
      // A repo ingested from its binding may not name a branch: ask GitHub (ETag-cached).
      const defaultBranch =
        cfg.defaultBranch === ""
          ? await this.#github.repoDefaultBranch(cfg.repo)
          : cfg.defaultBranch;
      const res = await pollRepo(
        {
          db: this.#o.db,
          github: this.#github,
          provider: this.#o.config.provider,
          overCap: this.#overCap,
          ...(this.#o.now ? { now: this.#o.now } : {}),
          log,
        },
        { ...cfg, defaultBranch },
      );
      this.#failures.delete(repo);
      status.runsCreated += res.created.length;
      if (res.superseded.length > 0) this.#o.onSuperseded?.(res.superseded);
      if (res.created.length > 0) this.#o.onQueued?.();
      return finish("ok", null, intervalMs);
    } catch (err) {
      const failures = (this.#failures.get(repo) ?? 0) + 1;
      this.#failures.set(repo, failures);
      if (err instanceof RateLimited) {
        const wait = backoffMs({
          intervalMs,
          failures,
          retryAfterMs: err.retryAfterMs,
          resetAt: err.resetAt,
          now,
        });
        log(`poll ${repo}: rate limited, backing off ${Math.round(wait / 1000)}s`);
        return finish("rate_limited", "rate limited by GitHub", wait);
      }
      const message = err instanceof Error ? err.message : "error";
      const wait = backoffMs({ intervalMs, failures, capMs: 900_000, now });
      log(`poll ${repo} failed: ${message}`);
      return finish("error", message, wait);
    }
  }

  /**
   * A webhook said something happened in `repo`: poll it now instead of at the next interval.
   * Only a repo this poller is configured for is acted on (the name from a payload selects, it
   * never adds), polls of one repo never overlap (an event during a poll asks for one more), and
   * events cannot poll a repo more than once per MIN_NUDGE_GAP_MS, so a flood costs one poll.
   */
  nudge(repo: string): boolean {
    if (!this.#running) return false;
    const cfg = this.#cfg(repo);
    if (!cfg) {
      // Maybe a project was just given ingest settings: look once, then act if it is now known.
      if (this.#o.bindings) {
        void this.refreshBindings()
          .then(() => {
            if (this.#cfg(repo)) this.nudge(repo);
          })
          .catch(() => {});
      }
      return false;
    }
    // A repo that is backing off after errors or a rate limit stays backed off.
    if ((this.#failures.get(cfg.repo) ?? 0) > 0) return false;
    if (this.#busy.has(cfg.repo)) {
      this.#again.add(cfg.repo);
      return true;
    }
    const wait = Math.max(0, (this.#lastStart.get(cfg.repo) ?? 0) + MIN_NUDGE_GAP_MS - this.#now());
    const t = this.#timers.get(cfg.repo);
    if (t) clearTimeout(t);
    this.#timers.set(
      cfg.repo,
      setTimeout(() => void this.#loop(cfg.repo), wait),
    );
    return true;
  }

  async #loop(repo: string): Promise<void> {
    if (!this.#running) return;
    // A binding that lost its settings (or was unbound) stops here.
    if (!this.#cfg(repo)) return;
    this.#busy.add(repo);
    this.#lastStart.set(repo, this.#now());
    let next: number;
    try {
      next = await this.#pollOne(repo);
    } finally {
      this.#busy.delete(repo);
    }
    if (!this.#running) return;
    // An event arrived while polling: poll once more, soon, not at the full interval.
    if (this.#again.delete(repo)) next = Math.min(next, MIN_NUDGE_GAP_MS);
    this.#timers.set(
      repo,
      setTimeout(() => void this.#loop(repo), next),
    );
  }
}
