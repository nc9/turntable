// Approval by a pull request label (#666), on the `prMode: "approval"` path: a run waiting in
// `awaiting_approval` is released when a maintainer adds the project's `pr_approval_label`.
// The rules are hard requirements, and every forge fact is re-fetched on each poll:
//   - the latest `labeled` event of that label was made by a `User` (never a `Bot`) who is not
//     the PR's author and has write, maintain or admin permission right now;
//   - that event is newer than the head's latest push and newer than the run, so a label put on
//     an earlier commit never counts (a commit's own date is whatever its author wrote, so the
//     run's creation is the second clock that a pusher cannot move back);
//   - the approval is bound to the run's exact sha through `approveRun`, and the run keeps its
//     `untrusted_pr` class: nothing here touches secrets, tokens or egress.
// A label that a newer push made stale is removed and one comment asks for a new label, both
// best-effort: the timestamp rule above, not the removal, is what enforces it.
import type { Db } from "../db";
import {
  ApproveError,
  appendAudit,
  approveRun,
  listWaitingPrRuns,
  markPollSkipped,
  parseTrust,
  type Run,
} from "../db/repos";
import type { Scope } from "../db/repos/scope";
import type { ForgePermission } from "../trust";
import { type LabeledEvent, type PrTimeline, type PullRequest, RateLimited } from "./github";
import type { PrNoticeWriter } from "./pr-notices";

const lower = (v: string): string => v.toLowerCase();

/** Permissions that may approve: the ones that can push to the repo. */
const APPROVER_PERMISSIONS: readonly string[] = ["write", "maintain", "admin"];

export type LabelVerdict =
  | { ok: true; event: LabeledEvent }
  /** `stale`: the label predates the head or the run, so it is removed and a new one is asked for. */
  | {
      ok: false;
      reason: string;
      stale: boolean;
      /** Why it is stale: older than the head's push, or only older than this run (no new commit). */
      staleKind?: StaleKind;
      event?: LabeledEvent;
    };

export type StaleKind = "push" | "run";

/** The latest `labeled` event of `label` (GitHub compares label names case-insensitively). */
export function latestLabeled(timeline: PrTimeline, label: string): LabeledEvent | undefined {
  let latest: LabeledEvent | undefined;
  for (const e of timeline.labeled) {
    if (lower(e.label) !== lower(label)) continue;
    if (latest === undefined || e.at >= latest.at) latest = e;
  }
  return latest;
}

/**
 * Judges the timeline, without the permission lookup (the caller makes it, only for an event that
 * passes this). Pure so the race rules can be tested to the millisecond.
 */
export function judgeLabelEvent(
  timeline: PrTimeline,
  facts: { label: string; author: string | null; runCreatedAt: number },
): LabelVerdict {
  const event = latestLabeled(timeline, facts.label);
  if (!event) return { ok: false, reason: "no labeled event for the label", stale: false };
  // Strictly newer than the head's latest push: an event at the same millisecond is not provably
  // after it. No push event listed at all (a PR with no commit events) leaves only the run clock.
  if (timeline.lastPush !== undefined && event.at <= timeline.lastPush) {
    return {
      ok: false,
      reason: "the label is older than the head's latest push",
      stale: true,
      staleKind: "push",
      event,
    };
  }
  if (event.at <= facts.runCreatedAt) {
    return {
      ok: false,
      reason: "the label is older than this run",
      stale: true,
      staleKind: "run",
      event,
    };
  }
  if (event.actor === null)
    return { ok: false, reason: "the labeler is unknown", stale: false, event };
  if (event.actor.type !== "User") {
    return {
      ok: false,
      reason: `the labeler is a ${event.actor.type || "non-user"}`,
      stale: false,
      event,
    };
  }
  if (facts.author === null || lower(event.actor.login) === lower(facts.author)) {
    return { ok: false, reason: "the labeler is the pull request's author", stale: false, event };
  }
  return { ok: true, event };
}

export function mayApprove(permission: ForgePermission | "unknown"): boolean {
  return APPROVER_PERMISSIONS.includes(permission);
}

export type LabelApprovalDeps = {
  db: Db;
  github: {
    prTimeline(repo: string, pr: number): Promise<PrTimeline | undefined>;
    collaboratorPermission(repo: string, user: string): Promise<ForgePermission | "unknown">;
  };
  /** The App's write access (`issues: write`), when there is one; minted only when needed. */
  notices?: (() => Promise<PrNoticeWriter | undefined>) | undefined;
  log?: ((message: string) => void) | undefined;
  now?: (() => number) | undefined;
};

const NOTICE_EVENT = "label-notice";
const RUN_NOTICE_EVENT = "label-notice-run";

function staleComment(label: string, kind: StaleKind): string {
  if (kind === "run") {
    return (
      `The \`${label}\` label was added before Turntable queued this commit, so it can't be ` +
      `proven to cover it. Add the \`${label}\` label again to approve the current commit.`
    );
  }
  return (
    `New commits were pushed after the \`${label}\` label was added, so the earlier approval no ` +
    `longer applies and this run is waiting again. A maintainer can add the \`${label}\` label ` +
    "again once they have reviewed the current commit."
  );
}

/**
 * Releases the waiting runs of `repo` whose pull request carries a valid approval label, and
 * answers a stale label. Returns the ids of the runs released.
 */
export async function releaseLabelApprovals(
  deps: LabelApprovalDeps,
  cfg: { repo: string; workflow: string },
  scope: Scope,
  label: string,
  pulls: readonly PullRequest[],
): Promise<string[]> {
  const log = deps.log ?? (() => {});
  const released: string[] = [];
  const byNumber = new Map(pulls.map((p) => [p.number, p]));
  for (const run of await listWaitingPrRuns(deps.db, scope, cfg.repo)) {
    const pr = run.prNumber === null ? undefined : byNumber.get(run.prNumber);
    if (!pr || run.sha === null || lower(pr.headSha) !== lower(run.sha)) continue;
    if (!pr.labels.some((l) => lower(l) === lower(label))) continue;
    // Only an untrusted pull request run is ever released this way.
    if (parseTrust(run)?.class !== "untrusted_pr") continue;
    try {
      const done = await judgeRun(deps, cfg, scope, label, run, pr);
      if (done) released.push(run.id);
    } catch (err) {
      if (err instanceof RateLimited) throw err; // the poller backs off
      // A forge or rate-limit error: the run keeps waiting and the next poll asks again.
      log(`poll ${cfg.repo}: label approval of pr #${pr.number} failed: ${String(err)}`);
    }
  }
  return released;
}

async function judgeRun(
  deps: LabelApprovalDeps,
  cfg: { repo: string; workflow: string },
  scope: Scope,
  label: string,
  run: Run,
  pr: PullRequest,
): Promise<boolean> {
  const trust = parseTrust(run);
  if (!trust || run.sha === null) return false;
  const timeline = await deps.github.prTimeline(cfg.repo, pr.number);
  if (!timeline) return false; // cannot read it: nothing is approved
  const verdict = judgeLabelEvent(timeline, {
    label,
    author: pr.author,
    runCreatedAt: run.createdAt,
  });
  if (!verdict.ok) {
    if (verdict.stale) {
      await answerStaleLabel(deps, cfg, scope, label, pr, run, verdict.staleKind ?? "push");
    }
    return false;
  }
  const login = verdict.event.actor?.login ?? "";
  // Re-fetched on every poll, never remembered. If the forge will not say, nobody is approved.
  const permission = await deps.github.collaboratorPermission(cfg.repo, login);
  if (!mayApprove(permission)) return false;
  const audit = (outcome: string) =>
    appendAudit(deps.db, scope, {
      principalKind: "forge_user",
      principalId: login,
      op: "approval.label",
      effect: "write",
      outcome,
      input: {
        run_id: run.id,
        repo: cfg.repo,
        pr: pr.number,
        login,
        sha: run.sha,
        label,
        label_event_id: verdict.event.id,
        permission,
      },
    });
  // Written first: an approval that cannot be audited does not happen.
  await audit("approved");
  try {
    await approveRun(deps.db, scope, run.id, {
      headSha: run.sha,
      workflowHash: trust.workflowHash,
      by: `@${login}`,
      via: { kind: "label", label, event_id: verdict.event.id },
      ...(deps.now ? { now: deps.now() } : {}),
    });
  } catch (err) {
    if (!(err instanceof ApproveError)) throw err;
    await audit("error:conflict").catch(() => {});
    return false;
  }
  (deps.log ?? (() => {}))(
    `poll ${cfg.repo}: pr #${pr.number} ${run.sha.slice(0, 7)} approved by label, from @${login}`,
  );
  return true;
}

/** Removes the stale label and comments once per head; failures are logged and ignored. */
async function answerStaleLabel(
  deps: LabelApprovalDeps,
  cfg: { repo: string; workflow: string },
  scope: Scope,
  label: string,
  pr: PullRequest,
  run: Run,
  kind: StaleKind,
): Promise<void> {
  const writer = deps.notices ? await deps.notices().catch(() => undefined) : undefined;
  if (!writer) return;
  await writer.removeLabel(cfg.repo, pr.number, label).catch((err) => {
    deps.log?.(
      `poll ${cfg.repo}: could not remove the stale label of pr #${pr.number}: ${String(err)}`,
    );
  });
  // The marker is the "once": it is written before the comment, so a failed comment is not retried.
  const first = await markPollSkipped(deps.db, scope, {
    repo: cfg.repo,
    workflowPath: cfg.workflow,
    event: kind === "run" ? RUN_NOTICE_EVENT : NOTICE_EVENT,
    sha: run.sha ?? pr.headSha,
    ...(deps.now ? { now: deps.now() } : {}),
    runId: run.id,
  });
  if (!first) return;
  await writer.comment(cfg.repo, pr.number, staleComment(label, kind)).catch((err) => {
    deps.log?.(`poll ${cfg.repo}: could not comment on pr #${pr.number}: ${String(err)}`);
  });
}
