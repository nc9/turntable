// Reports each job's result to the forge as a check run, from the scheduler's attempt events.
// A GitHub outage never blocks a run: reporting is queued per attempt, retried with backoff, and
// its failures are logged, never thrown into the scheduler.
import { redactString } from "@turntable/redact";
import { foldShardStates } from "@turntable/act-runner";
import type { Db } from "../db";
import {
  appendAudit,
  listBackfillAttempts,
  settleBackfill,
  claimSkippedCheck,
  type DismissReason,
  dismissSkippedCheck,
  getAttemptCheckRunId,
  getOrgById,
  listAttempts,
  isRunSuperseded,
  listJobs,
  listUnreportedSkips,
  listProjects,
  listRepos,
  releaseSkippedCheckClaim,
  setAttemptCheckRunId,
  type ChecksMode,
} from "../db/repos";
import { capExcerpt } from "../ops/failure-digest";
import { digestJob } from "../ops/definitions/failure-digest";
import { effectiveChecksMode } from "../ops/setting-guard";
import type { SettingsRuntime } from "../settings/resolve";
import type { Claim } from "../db/repos";
import type { AttemptOutcome } from "../scheduler/types";
import { type CheckRunBody, type CheckRunsApi, CheckRunsError } from "./client";
import { PermissionNotAcceptedError } from "../github/app-auth";
import {
  type AttemptResult,
  checkName,
  checkScopeOf,
  classifyInfra,
  infraRetryLine,
  refusalSentence,
  conclusionFor,
  NO_ATTEMPT_SKIP,
  skipReasonFor,
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
  /**
   * The settings runtime, so an environment or `turntable.toml` value of `checks_mode` locks the
   * mode. Without it the mode is the project's stored one, as before.
   */
  settings?: SettingsRuntime | undefined;
  /** Attempts per request before giving up. Default 5. */
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
};

/** The digest excerpt in a summary is capped at this many bytes. */
export const SUMMARY_EXCERPT_BYTES = 1024;

/** Skipped jobs older than this are not looked for (a check on a week-old commit is moot). */
const SKIP_WINDOW_MS = 3 * 24 * 3600_000;
/**
 * A claim to post a skipped check is retaken after this long: its holder died before posting. It
 * is far longer than one post (a retried create takes seconds) so a live holder is not robbed.
 */
export const SKIP_CLAIM_TTL_MS = 5 * 60_000;
/** Most skipped attempts one sweep looks at. */
export const SKIP_BATCH = 200;

type PostTarget = {
  mode: Exclude<ChecksMode, "off">;
  token: string;
  repo: string;
  sha: string;
};

export class CheckReporter {
  readonly #o: CheckReporterOptions;
  readonly #chains = new Map<string, Promise<void>>();
  #sweeping = false;
  /** A tick arrived during a sweep, which may have listed the skips before it: sweep again. */
  #resweep = false;

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

  /**
   * Called at the end of every scheduler claim pass: posts a `skipped` check for each job the
   * scheduler resolved as skipped without an attempt. A tick during a sweep is not lost: the sweep runs once more when it ends.
   */
  tick(): void {
    if (this.#sweeping) {
      this.#resweep = true;
      return;
    }
    this.#sweeping = true;
    // The re-sweep loop is inside the one queued job, so idle() cannot see the chain empty
    // between the sweep that missed a skip and the one that posts it.
    void this.#enqueue("sweep:skipped", async () => {
      try {
        let more: boolean;
        do {
          this.#resweep = false;
          more = await this.sweepSkipped();
          await this.sweepBackfill();
        } while (more || this.#resweep);
      } finally {
        this.#sweeping = false;
      }
    });
  }

  /**
   * Posts one check run per job that ended skipped without an attempt (a false `if:`, a failed or
   * skipped need, every shard path-skipped), under the same checks-mode gate as every other check.
   * Idempotent: the check is created by external id and its id stored on the attempt, so a rerun
   * of the sweep or a reconcile never posts a second one for the same job. Two workers racing are
   * kept apart by an exclusive claim on the attempt (a conditional update): only its holder
   * posts, and a claim whose holder died expires after SKIP_CLAIM_TTL_MS and is retaken.
   *
   * Returns true when the batch was full and settled at least one attempt (posted or dismissed),
   * so more unreported skips may remain. Each such pass shrinks the backlog, so repeating it ends;
   * a full batch that settled nothing (all waiting, failing or dismissed) returns false.
   */
  async sweepSkipped(): Promise<boolean> {
    const now = (this.#o.now ?? Date.now)();
    const rows = await listUnreportedSkips(this.#o.db, {
      since: now - SKIP_WINDOW_MS,
      limit: SKIP_BATCH,
    });
    let settled = 0;
    for (const row of rows) {
      const scope = { orgId: row.attempt.orgId, projectId: row.attempt.projectId };
      const claim: Claim = { attempt: row.attempt, job: row.job, run: row.run, scope };
      // The shards of a job share one chain and one check, as for a job that ran.
      await this.#enqueue(chainKey(claim), async () => {
        // Nothing to post (checks off, no repo or App): persisted, so a restart does not re-sweep.
        const out = await this.#postSkipped(claim);
        if (typeof out === "object") {
          await dismissSkippedCheck(this.#o.db, scope, row.attempt.id, now, out.nothing);
        }
        if (out !== "waiting") settled++;
      });
    }
    return rows.length >= SKIP_BATCH && settled > 0;
  }

  /**
   * Posts the current state of each job marked by a checks-mode flip (#630): off to shadow or
   * live, or shadow to live. The marker is set in the database by the flip itself, for the latest
   * run per ref only, and is cleared once the job has its check, so a restart neither loses nor
   * repeats it. The post is the event path's own (`#post`), so the external ids are the same and
   * a later event for the job updates this check. An attempt that already has a check (its own
   * event posted it after the flip) only has its marker cleared. One audit entry per project and
   * sweep records what was posted.
   */
  async sweepBackfill(): Promise<void> {
    const rows = await listBackfillAttempts(this.#o.db, { limit: SKIP_BATCH });
    const tally = new Map<string, { scope: Claim["scope"]; posted: number; dismissed: number }>();
    for (const row of rows) {
      const scope = { orgId: row.attempt.orgId, projectId: row.attempt.projectId };
      const claim: Claim = { attempt: row.attempt, job: row.job, run: row.run, scope };
      await this.#enqueue(chainKey(claim), async () => {
        const { db } = this.#o;
        const now = (this.#o.now ?? Date.now)();
        const t = tally.get(scope.projectId) ?? { scope, posted: 0, dismissed: 0 };
        tally.set(scope.projectId, t);
        const gate = await this.#gate(claim);
        if ("reason" in gate) {
          await settleBackfill(db, scope, row.attempt.id, now, gate.reason);
          t.dismissed++;
          return;
        }
        const state = row.attempt.state;
        if ((await getAttemptCheckRunId(db, scope, row.attempt.id)) === null) {
          if (
            state === "success" ||
            state === "failure" ||
            state === "infra_error" ||
            state === "cancelled" ||
            state === "skipped"
          ) {
            await this.#post(claim, { state, reason: row.attempt.errorClass ?? "" });
            t.posted++;
          } else if (state !== "queued") {
            await this.#post(claim, undefined); // running: its own finish event completes it
            t.posted++;
          }
        }
        await settleBackfill(db, scope, row.attempt.id, now);
      });
    }
    for (const t of tally.values()) {
      if (t.posted === 0 && t.dismissed === 0) continue;
      const mode = await effectiveChecksMode(
        this.#o.settings,
        this.#o.db,
        t.scope.orgId,
        t.scope.projectId,
      );
      await appendAudit(this.#o.db, t.scope, {
        principalKind: "system",
        principalId: "checks-reporter",
        op: "checks_backfill",
        effect: "write",
        outcome: "ok",
        input: { mode, posted: t.posted, nothing_to_post: t.dismissed },
      }).catch((err) => this.#log(`checks backfill audit not written: ${msg(err)}`));
    }
  }

  /** Resolves when everything queued so far has been attempted (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#chains.size > 0) await Promise.all(this.#chains.values());
  }

  /**
   * One attempt's requests run in order; different attempts do not wait for each other. The
   * shards of one split job share one chain, because they share one check.
   */
  #enqueue(attemptId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.#chains.get(attemptId) ?? Promise.resolve();
    const next = prev
      .then(work)
      .catch((err) => this.#log(`check run for ${attemptId} not reported: ${msg(err)}`))
      .finally(() => {
        if (this.#chains.get(attemptId) === next) this.#chains.delete(attemptId);
      });
    this.#chains.set(attemptId, next);
    return next;
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
        const retryable =
          err instanceof PermissionNotAcceptedError
            ? false
            : err instanceof CheckRunsError
              ? err.retryable
              : true;
        if (!retryable || attempt >= max) throw err;
        this.#log(`${what} failed (${msg(err)}); retry ${attempt} of ${max - 1}`);
        await sleep((this.#o.baseDelayMs ?? 1000) * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * The checks-mode gate, shared by every post: the mode (nothing when off), the commit, and a
   * token minted for the one repository with `checks: write` only. Undefined when nothing is to
   * be posted (checks off, a local run, a repo not installed through the App).
   */
  async #target(claim: Claim): Promise<PostTarget | undefined> {
    const t = await this.#gate(claim);
    return "reason" in t ? undefined : t;
  }

  /** `#target`, with the reason when there is nothing to post. */
  async #gate(claim: Claim): Promise<PostTarget | { reason: DismissReason }> {
    const { db } = this.#o;
    const { scope, run } = claim;
    const mode: ChecksMode = await effectiveChecksMode(
      this.#o.settings,
      db,
      scope.orgId,
      scope.projectId,
    );
    if (mode === "off") return { reason: "checks_off" };
    if (!run.repo || !run.sha) return { reason: "local_run" }; // local runs and runs with no forge commit
    const [owner, name] = run.repo.split("/") as [string, string];
    const bound = (await listRepos(db, scope)).find(
      (r) => r.forge === "github" && r.owner === owner && r.repo === name,
    );
    if (!bound) return { reason: "no_binding" };
    // Not installed through the App: no token to mint.
    if (!bound.installationId) return { reason: "no_installation" };

    const installationId = bound.installationId;
    const { token } = await this.#retry("mint token", () =>
      this.#o.auth.mint(installationId, {
        // One repository, and only the permission this needs.
        repositories: [name],
        permissions: { checks: "write" },
      }),
    );
    return { mode, token, repo: run.repo, sha: run.sha };
  }

  /**
   * A `skipped` check for a job that ended skipped without running. For a split job the check is
   * the job's one shared check, posted once every shard is settled and all of them were skipped
   * (when a shard ran, the job already has its check and this shard just records it). Returns
   * `nothing` when there is nothing to post at all, so the sweep stops looking at it.
   */
  async #postSkipped(claim: Claim): Promise<"posted" | "waiting" | { nothing: DismissReason }> {
    const { db } = this.#o;
    const { scope, run, job, attempt } = claim;
    if ((await getAttemptCheckRunId(db, scope, attempt.id)) !== null) return "posted";
    // A newer run owns this sha's check names (#648): posting now could land after its checks.
    if (await isRunSuperseded(db, run)) return { nothing: "superseded" };
    const target = await this.#gate(claim);
    if ("reason" in target) return { nothing: target.reason };
    const all = await listJobs(db, scope, run.id);
    const mine = shardGroup(job.planned);
    const members = mine ? all.filter((j) => shardGroup(j.planned)?.id === mine.id) : [job];
    if (
      !members.every((j) =>
        ["success", "failure", "infra_error", "cancelled", "skipped"].includes(j.state),
      )
    )
      return "waiting";
    const latest = new Map<string, typeof attempt>();
    for (const m of members) {
      const a = (await listAttempts(db, scope, m.id)).at(-1);
      if (a) latest.set(m.id, a);
    }
    if (mine) {
      // A shard ran: the job's check exists (or its last shard makes it). This one joins it.
      for (const a of latest.values()) {
        const cid = await getAttemptCheckRunId(db, scope, a.id);
        if (cid !== null) {
          await setAttemptCheckRunId(db, scope, attempt.id, cid);
          return "posted";
        }
      }
      if ([...latest.values()].some((a) => a.state !== "skipped" || a.startedAt !== null)) {
        return "waiting";
      }
    }
    // One claim per check: for a split job, on its lowest-id attempt, whichever shard we hold.
    const claimOn = [...latest.values()].map((a) => a.id).toSorted()[0] ?? attempt.id;
    const now = (this.#o.now ?? Date.now)();
    const claimedAt = await claimSkippedCheck(db, scope, claimOn, now, SKIP_CLAIM_TTL_MS);
    if (claimedAt === null) return "waiting";
    try {
      return await this.#postClaimed(claim, target, all, latest, mine);
    } catch (err) {
      await releaseSkippedCheckClaim(db, scope, claimOn, claimedAt).catch(() => {});
      throw err;
    }
  }

  /** Creates the skipped check; the caller holds the claim. */
  async #postClaimed(
    claim: Claim,
    target: PostTarget,
    all: Awaited<ReturnType<typeof listJobs>>,
    latest: Map<string, Claim["attempt"]>,
    mine: { id: string } | undefined,
  ): Promise<"posted"> {
    const { db } = this.#o;
    const { scope, run, job, attempt } = claim;
    const { mode, token } = target;
    const externalId = mine ? `shards-${run.id}-${mine.id}` : `skipped-${job.id}`;
    const name = checkName(mode, job, checkScopeOf(run.plan));
    const runUrl = await this.#runUrl(claim);
    const reason = skipReasonFor({
      errorClass: attempt.errorClass,
      needs: (JSON.parse(job.needs) as string[]).map((key) => {
        const dep = all.find((j) => j.jobKey === key);
        return { name: dep?.name ?? key, state: dep?.state ?? "missing" };
      }),
    });
    const at = new Date((this.#o.now ?? Date.now)()).toISOString();
    const id = await this.#create(token, target.repo, target.sha, externalId, name, {
      name,
      head_sha: target.sha,
      external_id: externalId,
      status: "completed",
      conclusion: conclusionFor(mode, NO_ATTEMPT_SKIP),
      started_at: at,
      completed_at: at,
      ...(runUrl ? { details_url: runUrl } : {}),
      output: {
        title: titleFor(mode, NO_ATTEMPT_SKIP),
        summary: summaryFor({ mode, result: NO_ATTEMPT_SKIP, runUrl, skipReason: reason }),
      },
    });
    for (const a of latest.values()) await setAttemptCheckRunId(db, scope, a.id, id);
    await setAttemptCheckRunId(db, scope, attempt.id, id);
    return "posted";
  }

  /** The infra kind of the attempt this one retries (#517), or undefined: a first attempt or a rerun. */
  async #retryOf(claim: Claim): Promise<string | undefined> {
    const { attempt, scope, job } = claim;
    if (attempt.attempt < 2 || attempt.rerunReason !== null) return undefined;
    const prev = (await listAttempts(this.#o.db, scope, job.id)).find(
      (a) => a.attempt === attempt.attempt - 1,
    );
    return prev?.state === "infra_error" && prev.infraKind ? prev.infraKind : undefined;
  }

  async #post(claim: Claim, outcome: AttemptOutcome | undefined): Promise<void> {
    const { db } = this.#o;
    const { scope, job, attempt } = claim;
    const target = await this.#target(claim);
    if (!target) return;
    const { mode, token, repo, sha } = target;
    const checkName_ = checkName(mode, job, checkScopeOf(claim.run.plan));
    const runUrl = await this.#runUrl(claim);
    let id = await getAttemptCheckRunId(db, scope, attempt.id);
    // A job the operator splits across sandboxes has ONE check, under the job's own name, shared
    // by its shards: made when the first shard starts, completed when the last one finishes.
    const group = shardGroup(job.planned) ? await this.#shardState(claim) : undefined;

    const retryOf = await this.#retryOf(claim);
    if (outcome === undefined) {
      // A retry after an infra failure (#517) inherits the first attempt's check: show the retry.
      if (id !== null && retryOf && !group) {
        const existing = id;
        const body: CheckRunBody = {
          status: "in_progress",
          output: {
            title: RUNNING_TITLE(mode),
            summary: summaryRunning(mode, runUrl, retryOf),
          },
        };
        await this.#retry("update check run", () =>
          this.#o.api.update(token, repo, existing, body),
        );
        return;
      }
      // Started, or re-attached after a restart: the id already stored means it exists.
      if (id !== null) return;
      if (group?.sharedId !== undefined) {
        await setAttemptCheckRunId(db, scope, attempt.id, group.sharedId);
        return;
      }
      id = await this.#create(token, repo, sha, group?.externalId ?? attempt.id, checkName_, {
        name: checkName_,
        head_sha: sha,
        status: "in_progress",
        started_at: new Date((this.#o.now ?? Date.now)()).toISOString(),
        external_id: group?.externalId ?? attempt.id,
        ...(runUrl ? { details_url: runUrl } : {}),
        output: {
          title: RUNNING_TITLE(mode),
          summary: summaryRunning(mode, runUrl, retryOf),
        },
      });
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
        title: titleFor(
          mode,
          result,
          !group && result === "failure" && refusalSentence(outcome.reason) !== undefined,
        ),
        summary: summaryFor({
          mode,
          result,
          runUrl,
          failingStep,
          excerpt,
          infraClass: result === "infra_error" ? classifyInfra(outcome.reason) : undefined,
          retryOf,
          ...(!group && result === "failure" && refusalSentence(outcome.reason)
            ? { refusal: refusalSentence(outcome.reason) }
            : {}),
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
      await this.#retry("update check run", () => this.#o.api.update(token, repo, existing, body));
      return;
    }
    // The start was never reported (an outage, a restart before it): create it completed.
    id = await this.#create(token, repo, sha, group?.externalId ?? attempt.id, checkName_, {
      ...body,
      name: checkName_,
      head_sha: sha,
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

function summaryRunning(
  mode: Exclude<ChecksMode, "off">,
  runUrl: string | undefined,
  retryOf?: string,
): string {
  const lines = [
    mode === "shadow"
      ? "Turntable is running this job as a shadow check: the result will be neutral."
      : "Turntable is running this job.",
  ];
  const retry = infraRetryLine(retryOf);
  if (retry) lines.push(retry);
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
