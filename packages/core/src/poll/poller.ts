import type { Db } from "../db";
import { type PollConfig, readToken } from "./config";
import { type FetchLike, GithubClient, RateLimited } from "./github";
import { pollRepo } from "./ingest";

export type PollerOptions = {
  db: Db;
  config: PollConfig;
  fetch?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
  /** Called after a poll that queued runs, so the scheduler can start them at once. */
  onQueued?: () => void;
};

/**
 * Polls every configured repo on its own interval. The token (if configured) is read once from
 * its file and handed to the client; it is never logged. A rate-limited repo backs off until the
 * limit resets. A failing poll is logged (without request headers) and retried next interval.
 */
export class Poller {
  readonly #o: PollerOptions;
  readonly #github: GithubClient;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #running = false;

  constructor(o: PollerOptions) {
    this.#o = o;
    const token = o.config.tokenFile ? readToken(o.config.tokenFile) : undefined;
    this.#github = new GithubClient({
      ...(o.fetch ? { fetch: o.fetch } : {}),
      baseUrl: o.config.apiBaseUrl,
      token,
    });
  }

  /** Polls every repo once, now. For tests and `--once` style use. */
  async pollAll(): Promise<void> {
    for (const cfg of this.#o.config.repos) await this.#pollOne(cfg.repo);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    for (const cfg of this.#o.config.repos) void this.#loop(cfg.repo);
  }

  stop(): void {
    this.#running = false;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }

  async #pollOne(repo: string): Promise<number> {
    const cfg = this.#o.config.repos.find((r) => r.repo === repo)!;
    const log = this.#o.log ?? (() => {});
    try {
      const res = await pollRepo(
        {
          db: this.#o.db,
          github: this.#github,
          provider: this.#o.config.provider,
          ...(this.#o.now ? { now: this.#o.now } : {}),
          log,
        },
        cfg,
      );
      if (res.created.length > 0) this.#o.onQueued?.();
      return cfg.intervalSeconds * 1000;
    } catch (err) {
      if (err instanceof RateLimited) {
        const now = (this.#o.now ?? Date.now)();
        const wait = err.resetAt ? Math.max(err.resetAt - now, 1000) : 300_000;
        log(`poll ${repo}: rate limited, backing off ${Math.round(wait / 1000)}s`);
        return Math.max(wait, cfg.intervalSeconds * 1000);
      }
      log(`poll ${repo} failed: ${err instanceof Error ? err.message : "error"}`);
      return cfg.intervalSeconds * 1000;
    }
  }

  async #loop(repo: string): Promise<void> {
    if (!this.#running) return;
    const next = await this.#pollOne(repo);
    if (!this.#running) return;
    this.#timers.set(
      repo,
      setTimeout(() => void this.#loop(repo), next),
    );
  }
}
