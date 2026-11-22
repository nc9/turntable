// Reports each job's result to the forge as a check run, from the scheduler's attempt events.
// A GitHub outage never blocks a run: reporting is queued per attempt, retried with backoff, and
// its failures are logged, never thrown into the scheduler.
import type { Db } from "../db";
import {
  getAttemptCheckRunId,
  getOrgById,
  getProjectChecksMode,
  listProjects,
  listRepos,
  setAttemptCheckRunId,
  type ChecksMode,
} from "../db/repos";
import { capExcerpt } from "../ops/failure-digest";
import { digestJob } from "../ops/definitions/failure-digest";
import type { Claim } from "../db/repos";
import type { AttemptOutcome } from "../scheduler/types";
import { type CheckRunBody, type CheckRunsApi, CheckRunsError } from "./client";
import {
  type AttemptResult,
  checkName,
  conclusionFor,
  RUNNING_TITLE,
  summaryFor,
  titleFor,
} from "./mapping";

/** The slice of AppAuth the reporter needs. */
export interface TokenMinter {
  mint(
    installationId: string,
    scope: {
      repositories?: readonly string[];
      permissions?: Readonly<Record<string, "read" | "write">>;
    },
  ): Promise<{ token: string }>;
}

export type CheckReporterOptions = {
  db: Db;
  auth: TokenMinter;
  api: CheckRunsApi;
  /** Public base URL of this server, for `details_url`. Without it the link is omitted. */
  publicUrl?: string | undefined;
  /** Attempts per request before giving up. Default 5. */
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
};

/** The digest excerpt in a summary is capped at this many bytes. */
export const SUMMARY_EXCERPT_BYTES = 1024;

export class CheckReporter {
  readonly #o: CheckReporterOptions;
  readonly #chains = new Map<string, Promise<void>>();

  constructor(o: CheckReporterOptions) {
    this.#o = o;
  }

  /** Called when an attempt starts, or is re-attached after a restart. */
  started(claim: Claim): void {
    this.#enqueue(claim.attempt.id, () => this.#post(claim, undefined));
  }

  /** Called when an attempt has a result. */
  finished(claim: Claim, outcome: AttemptOutcome): void {
    this.#enqueue(claim.attempt.id, () => this.#post(claim, outcome));
  }

  /** Resolves when everything queued so far has been attempted (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#chains.size > 0) await Promise.all(this.#chains.values());
  }

  /** One attempt's requests run in order; different attempts do not wait for each other. */
  #enqueue(attemptId: string, work: () => Promise<void>): void {
    const prev = this.#chains.get(attemptId) ?? Promise.resolve();
    const next = prev
      .then(work)
      .catch((err) => this.#log(`check run for ${attemptId} not reported: ${msg(err)}`))
      .finally(() => {
        if (this.#chains.get(attemptId) === next) this.#chains.delete(attemptId);
      });
    this.#chains.set(attemptId, next);
  }

  #log(m: string): void {
    this.#o.log?.(m);
  }

  async #retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const max = this.#o.retries ?? 5;
    const sleep = this.#o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        // A refusal (4xx) is final; an outage, a rate limit or an unknown failure (a mint that
        // could not reach GitHub) is retried.
        const retryable = err instanceof CheckRunsError ? err.retryable : true;
        if (!retryable || attempt >= max) throw err;
        this.#log(`${what} failed (${msg(err)}); retry ${attempt} of ${max - 1}`);
        await sleep((this.#o.baseDelayMs ?? 1000) * 2 ** (attempt - 1));
      }
    }
  }

  async #post(claim: Claim, outcome: AttemptOutcome | undefined): Promise<void> {
    const { db } = this.#o;
    const { scope, run, job, attempt } = claim;
    const mode: ChecksMode = await getProjectChecksMode(db, scope);
    if (mode === "off") return;
    if (!run.repo || !run.sha) return; // local runs and runs with no forge commit
    const [owner, name] = run.repo.split("/") as [string, string];
    const bound = (await listRepos(db, scope)).find(
      (r) => r.forge === "github" && r.owner === owner && r.repo === name,
    );
    if (!bound?.installationId) return; // not installed through the App: no token to mint

    const installationId = bound.installationId;
    const { token } = await this.#retry("mint token", () =>
      this.#o.auth.mint(installationId, {
        // One repository, and only the permission this needs.
        repositories: [name],
        permissions: { checks: "write" },
      }),
    );
    const checkName_ = checkName(mode, job);
    const runUrl = await this.#runUrl(claim);
    let id = await getAttemptCheckRunId(db, scope, attempt.id);

    if (outcome === undefined) {
      // Started, or re-attached after a restart: the id already stored means it exists.
      if (id !== null) return;
      id = await this.#create(token, run.repo, run.sha, attempt.id, checkName_, {
        name: checkName_,
        head_sha: run.sha,
        status: "in_progress",
        started_at: new Date((this.#o.now ?? Date.now)()).toISOString(),
        external_id: attempt.id,
        ...(runUrl ? { details_url: runUrl } : {}),
        output: {
          title: RUNNING_TITLE(mode),
          summary: summaryRunning(mode, runUrl),
        },
      });
      await setAttemptCheckRunId(db, scope, attempt.id, id);
      return;
    }

    const result = outcome.state as AttemptResult;
    let failingStep: string | undefined;
    let excerpt: string | undefined;
    if (result === "failure" || result === "infra_error") {
      try {
        const d = await digestJob({ db, scope }, { id: job.id, jobKey: job.jobKey, state: result });
        failingStep = d.step?.name;
        if (d.excerpt) excerpt = capExcerpt(d.excerpt, SUMMARY_EXCERPT_BYTES).text;
      } catch (err) {
        this.#log(`failure digest for ${job.id} unavailable: ${msg(err)}`);
      }
    }
    const body: CheckRunBody = {
      status: "completed",
      conclusion: conclusionFor(mode, result),
      completed_at: new Date((this.#o.now ?? Date.now)()).toISOString(),
      ...(runUrl ? { details_url: runUrl } : {}),
      output: {
        title: titleFor(mode, result),
        summary: summaryFor({
          mode,
          result,
          runUrl,
          failingStep,
          excerpt,
          infraReason: result === "infra_error" ? outcome.reason : undefined,
        }),
      },
    };
    if (id !== null) {
      const existing = id;
      await this.#retry("update check run", () =>
        this.#o.api.update(token, run.repo!, existing, body),
      );
      return;
    }
    // The start was never reported (an outage, a restart before it): create it completed.
    id = await this.#create(token, run.repo, run.sha, attempt.id, checkName_, {
      ...body,
      name: checkName_,
      head_sha: run.sha,
      external_id: attempt.id,
    });
    await setAttemptCheckRunId(db, scope, attempt.id, id);
  }

  /**
   * Creates the check run once: an existing one with this attempt's external id (created by a
   * worker that died before it could store the id) is reused and brought up to date.
   */
  async #create(
    token: string,
    repo: string,
    sha: string,
    attemptId: string,
    name: string,
    body: CheckRunBody,
  ): Promise<string> {
    const found = await this.#retry("find check run", () =>
      this.#o.api.findByExternalId(token, repo, sha, name, attemptId),
    );
    if (found !== undefined) {
      await this.#retry("update check run", () => this.#o.api.update(token, repo, found, body));
      return found;
    }
    return this.#retry("create check run", () => this.#o.api.create(token, repo, body));
  }

  async #runUrl(claim: Claim): Promise<string | undefined> {
    const base = this.#o.publicUrl?.replace(/\/$/, "");
    if (!base) return undefined;
    const org = await getOrgById(this.#o.db, claim.scope.orgId);
    const project = (await listProjects(this.#o.db, claim.scope)).find(
      (p) => p.id === claim.scope.projectId,
    );
    if (!org || !project) return undefined;
    return `${base}/${encodeURIComponent(org.slug)}/${encodeURIComponent(project.slug)}/runs/${encodeURIComponent(claim.run.id)}`;
  }
}

function summaryRunning(mode: Exclude<ChecksMode, "off">, runUrl: string | undefined): string {
  const lines = [
    mode === "shadow"
      ? "Longshore is running this job as a shadow check: the result will be neutral."
      : "Longshore is running this job.",
  ];
  if (runUrl) lines.push(`[Open the run in Longshore](${runUrl})`);
  return lines.join("\n\n");
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
