// Reports each job's result to the forge as a check run, from the scheduler's attempt events.
// A GitHub outage never blocks a run: reporting is queued per attempt, retried with backoff, and
// its failures are logged, never thrown into the scheduler.
import { redactString } from "@turntable/redact";
import { foldShardStates } from "@turntable/act-runner";
import type { Db } from "../db";
import {
  getAttemptCheckRunId,
  getOrgById,
  getProjectChecksMode,
  listAttempts,
  listJobs,
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
  classifyInfra,
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
    this.#enqueue(chainKey(claim), () => this.#post(claim, undefined));
  }

  /** Called when an attempt has a result. */
  finished(claim: Claim, outcome: AttemptOutcome): void {
    this.#enqueue(chainKey(claim), () => this.#post(claim, outcome));
  }

  /** Resolves when everything queued so far has been attempted (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#chains.size > 0) await Promise.all(this.#chains.values());
  }

  /**
   * One attempt's requests run in order; different attempts do not wait for each other. The
   * shards of one split job share one chain, because they share one check.
   */
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
    // A job the operator splits across sandboxes has ONE check, under the job's own name, shared
    // by its shards: made when the first shard starts, completed when the last one finishes.
    const group = shardGroup(job.planned) ? await this.#shardState(claim) : undefined;

    if (outcome === undefined) {
      // Started, or re-attached after a restart: the id already stored means it exists.
      if (id !== null) return;
      if (group?.sharedId !== undefined) {
        await setAttemptCheckRunId(db, scope, attempt.id, group.sharedId);
        return;
      }
      id = await this.#create(
        token,
        run.repo,
        run.sha,
        group?.externalId ?? attempt.id,
        checkName_,
        {
          name: checkName_,
          head_sha: run.sha,
          status: "in_progress",
          started_at: new Date((this.#o.now ?? Date.now)()).toISOString(),
          external_id: group?.externalId ?? attempt.id,
          ...(runUrl ? { details_url: runUrl } : {}),
          output: {
            title: RUNNING_TITLE(mode),
            summary: summaryRunning(mode, runUrl),
          },
        },
      );
      await setAttemptCheckRunId(db, scope, attempt.id, id);
      return;
    }

    if (group) {
      // Another shard is still going: the one check stays running. It is completed by the last.
      if (group.sharedId !== undefined && id === null)
        await setAttemptCheckRunId(db, scope, attempt.id, group.sharedId);
      if (!group.othersDone) return;
      id = id ?? group.sharedId ?? null;
    }
    const result = (
      group
        ? foldShardStates([...group.otherStates, outcome.state])
        : (outcome.state as AttemptResult)
    ) as AttemptResult;
    let failingStep: string | undefined;
    let excerpt: string | undefined;
    // An infrastructure error publishes only its classified reason: the excerpt of a sandbox that
    // failed says nothing about the code and may carry hosts and paths.
    if (result === "failure") {
      try {
        // For a split job: the first shard that failed (this one, if it did).
        const failed = group ? (group.failedJob ?? job) : job;
        const d = await digestJob(
          { db, scope },
          { id: failed.id, jobKey: failed.jobKey, state: result },
        );
        // Redacted again here (the digest already did) and then capped: nothing leaves unchecked.
        failingStep = d.step?.name === undefined ? undefined : redactString(d.step.name);
        if (d.excerpt) excerpt = capExcerpt(redactString(d.excerpt), SUMMARY_EXCERPT_BYTES).text;
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
          infraClass: result === "infra_error" ? classifyInfra(outcome.reason) : undefined,
          ...(group
            ? {
                shards: [
                  ...group.lines,
                  `shard ${group.index + 1} of ${group.total}: ${outcome.state}`,
                ].toSorted(),
              }
            : {}),
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
    id = await this.#create(token, run.repo, run.sha, group?.externalId ?? attempt.id, checkName_, {
      ...body,
      name: checkName_,
      head_sha: run.sha,
      external_id: group?.externalId ?? attempt.id,
    });
    await setAttemptCheckRunId(db, scope, attempt.id, id);
  }

  /**
   * Where the shards of this attempt's job stand: the check they share (if one exists), whether
   * every other shard is finished, their states, and one line per other shard. A rerun of one
   * shard, when all the others are finished, gets a check of its own.
   */
  async #shardState(claim: Claim): Promise<ShardState> {
    const { db } = this.#o;
    const { scope, run, job, attempt } = claim;
    const mine = shardGroup(job.planned)!;
    const all = await listJobs(db, scope, run.id);
    const others = all.filter((j) => j.id !== job.id && shardGroup(j.planned)?.id === mine.id);
    const terminal = ["success", "failure", "infra_error", "cancelled", "skipped"];
    const othersDone = others.every((j) => terminal.includes(j.state));
    let sharedId: string | undefined;
    const lines: string[] = [];
    let failedJob: (typeof all)[number] | undefined;
    for (const o of others) {
      const attempts = await listAttempts(db, scope, o.id);
      const latest = attempts.at(-1);
      const cid = latest ? await getAttemptCheckRunId(db, scope, latest.id) : null;
      if (cid !== null && sharedId === undefined) sharedId = cid;
      const g = shardGroup(o.planned)!;
      lines.push(`shard ${g.index + 1} of ${g.total}: ${o.state}`);
      if (o.state === "failure" && failedJob === undefined) failedJob = o;
    }
    // A rerun of a single shard (every other shard already finished): its own check.
    if (attempt.attempt > 1 && othersDone) sharedId = undefined;
    return {
      sharedId,
      externalId: attempt.attempt > 1 && othersDone ? attempt.id : `shards-${run.id}-${mine.id}`,
      othersDone,
      otherStates: others.map((j) => j.state),
      lines,
      index: mine.index,
      total: mine.total,
      ...(failedJob ? { failedJob } : {}),
    };
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
      ? "Turntable is running this job as a shadow check: the result will be neutral."
      : "Turntable is running this job.",
  ];
  if (runUrl) lines.push(`[Open the run in Turntable](${runUrl})`);
  return lines.join("\n\n");
}

type ShardState = {
  sharedId: string | undefined;
  externalId: string;
  othersDone: boolean;
  otherStates: string[];
  lines: string[];
  index: number;
  total: number;
  failedJob?: { id: string; jobKey: string };
};

/** The workflow job id and shard of a job row's stored plan, when it is a shard. */
function shardGroup(
  planned: string | null,
): { id: string; index: number; total: number } | undefined {
  if (!planned) return undefined;
  try {
    const p = JSON.parse(planned) as { id?: unknown; shard?: { index?: unknown; total?: unknown } };
    return typeof p.id === "string" &&
      typeof p.shard?.index === "number" &&
      typeof p.shard.total === "number"
      ? { id: p.id, index: p.shard.index, total: p.shard.total }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The shards of one job share a chain (and a check); every other attempt has its own. */
const chainKey = (c: Claim): string => {
  const g = shardGroup(c.job.planned);
  return g ? `shards:${c.run.id}:${g.id}` : c.attempt.id;
};

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
