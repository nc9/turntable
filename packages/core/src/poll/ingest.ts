import {
  githubContext,
  localActionDir,
  planWorkflow,
  workflowHeadCheckouts,
  type Value,
  type WorkflowEvent,
} from "@longshore/act-runner";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { Db } from "../db";
import {
  bindRepo,
  countPolledSince,
  countWaitingRuns,
  getProjectEgress,
  createPolledRun,
  lastPolledSha,
  markPollSkipped,
  pollSeen,
  type Superseded,
  ensureLocalTenant,
  getOrgBySlug,
  getProjectBySlug,
  listRepos,
  type PolledJob,
  type Scope,
  validateJobGraph,
} from "../db/repos";
import { assertRepoRelative, MAX_REPO_FILE_BYTES } from "../run/safe-read";
import type { PollConfig, PollRepoConfig } from "./config";
import { decideRun, type ForgePermission, needsApproval } from "../trust";
import type { GithubClient } from "./github";

export type Candidate = {
  /** For a pull request: the base branch it targets. */
  baseRef?: string;
  /** The base branch commit at poll time, stored on the run for `github.event`. */
  baseSha?: string;
  event: "push" | "pull_request";
  ref: string;
  sha: string;
  actor: string | null;
  message: string;
  headBranch: string;
  prNumber?: number;
  /** Forge facts for the trust decision, re-fetched at ingest. */
  sameRepo?: boolean;
  permission?: ForgePermission | "unknown";
  allowlisted?: boolean;
  forgeProtected?: boolean;
};

export type GateVerdict = { ok: true } | { ok: false; reason: string };

const lower = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/** Narrows open pull requests to `prNumbers` when the config lists them. */
const onlyListed = <T extends { number: number }>(
  cfg: Pick<PollRepoConfig, "prNumbers">,
  prs: T[],
): T[] =>
  cfg.prNumbers === undefined ? prs : prs.filter((p) => cfg.prNumbers!.includes(p.number));

const allowed = (cfg: Pick<PollRepoConfig, "authors">, login: string | null): boolean =>
  login !== null && cfg.authors.some((a) => lower(a) === lower(login));

/**
 * First half of the pull request gate, from the PR list alone: the head repo must BE the
 * configured repo (never a fork, never a deleted fork), the base must be it too, and whoever
 * opened the PR must be on the allowlist. Facts come from the API response, never from PR text.
 * A bot is allowed only if its exact login is listed.
 */
export function gatePullRequestOpener(
  cfg: Pick<PollRepoConfig, "repo" | "prMode" | "authors">,
  pr: { headRepo: string | null; baseRepo: string; author: string | null },
): GateVerdict {
  if (cfg.prMode !== "allowlist") return { ok: false, reason: "pull requests are off" };
  const repo = lower(cfg.repo);
  if (lower(pr.baseRepo) !== repo)
    return { ok: false, reason: "base repo is not the configured repo" };
  if (pr.headRepo === null) return { ok: false, reason: "head repo is gone (deleted fork)" };
  if (lower(pr.headRepo) !== repo) return { ok: false, reason: "head repo is a fork" };
  if (pr.author === null) return { ok: false, reason: "no author login" };
  if (!allowed(cfg, pr.author)) return { ok: false, reason: "author is not on the allowlist" };
  return { ok: true };
}

/**
 * Second half: whoever AUTHORED the head commit must also be on the allowlist. The opener can be
 * trusted while the commit that would run was written by someone else (someone pushed to the
 * branch, or the PR was opened by a maintainer for another's work). GitHub linking no account
 * to the commit (null) is refused: we cannot say who wrote the code we would run.
 *
 * This is defense in depth, NOT identity. A commit's author is whatever name and email the
 * committer put in it, and GitHub links an account by matching that email, so anyone who can
 * push can write a commit "authored by" an allowlisted user. The real anchors of the gate are:
 * (a) the head repo is the configured repo, because pushing a branch there needs write access;
 * and (b) the PR opener, an authenticated GitHub identity. Hosted mode will need verified
 * (signed) commits or per-sha approval; tracked on #17. The check stays because it is cheap and
 * catches honest mistakes, such as a maintainer opening a PR for someone else's branch.
 */
export function gateHeadCommit(
  cfg: Pick<PollRepoConfig, "authors">,
  headAuthor: string | null,
): GateVerdict {
  if (headAuthor === null) return { ok: false, reason: "head commit has no linked GitHub account" };
  if (!allowed(cfg, headAuthor))
    return { ok: false, reason: "head commit author is not on the allowlist" };
  return { ok: true };
}

/** The whole gate, given the head commit's author. */
export function gatePullRequest(
  cfg: Pick<PollRepoConfig, "repo" | "prMode" | "authors">,
  pr: {
    headRepo: string | null;
    baseRepo: string;
    author: string | null;
    headAuthor: string | null;
  },
): GateVerdict {
  const opener = gatePullRequestOpener(cfg, pr);
  return opener.ok ? gateHeadCommit(cfg, pr.headAuthor) : opener;
}

/** Job keys, display name and `needs` of a workflow, or undefined when it does not parse. */
export function describeWorkflow(
  yaml: string,
): { name: string | null; jobs: PolledJob[] } | undefined {
  let doc: unknown;
  try {
    doc = parse(yaml, { merge: true });
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object") return undefined;
  const root = doc as { name?: unknown; jobs?: unknown };
  if (root.jobs === null || typeof root.jobs !== "object") return undefined;
  const jobs: PolledJob[] = Object.entries(root.jobs as Record<string, unknown>).map(
    ([key, def]) => {
      const j = (def ?? {}) as { name?: unknown; needs?: unknown };
      const needs =
        typeof j.needs === "string"
          ? [j.needs]
          : Array.isArray(j.needs)
            ? j.needs.filter((n): n is string => typeof n === "string")
            : [];
      return { key, name: typeof j.name === "string" ? j.name : key, needs };
    },
  );
  return { name: typeof root.name === "string" ? root.name : null, jobs };
}

export type IngestDeps = {
  db: Db;
  github: GithubClient;
  provider: string;
  now?: () => number;
  log?: (message: string) => void;
  /**
   * Head shas skipped because the repo's waiting cap was full, kept by the long-lived poller so a
   * full queue is not re-examined (and re-reported) every poll. Cleared once room opens up.
   */
  overCap?: Set<string>;
};

async function targetScope(db: Db, cfg: PollRepoConfig): Promise<Required<Scope>> {
  if (cfg.org === "local" && cfg.project === "local") return ensureLocalTenant(db);
  const org = await getOrgBySlug(db, cfg.org);
  if (!org) throw new Error(`poll config: no org ${cfg.org}`);
  const project = await getProjectBySlug(db, { orgId: org.id }, cfg.project);
  if (!project) throw new Error(`poll config: no project ${cfg.project} in org ${cfg.org}`);
  return { orgId: org.id, projectId: project.id };
}

/** What a poll found and what it did. */
export type IngestResult = {
  created: string[];
  refused: { what: string; reason: string }[];
  /** Attempts of older runs that a cancel-in-progress run took over while running. */
  superseded: Superseded["running"];
};

/**
 * The `github.event` payload: what `if:` expressions see at plan time, and what act is given for
 * the job. Forge facts only, each fetched at poll time.
 */
function eventPayload(c: Candidate, repo: string, before?: string): Value {
  const repository = { full_name: repo };
  if (c.event === "pull_request") {
    return {
      ...(c.prNumber === undefined ? {} : { number: c.prNumber }),
      pull_request: {
        ...(c.prNumber === undefined ? {} : { number: c.prNumber }),
        base: { ref: c.baseRef ?? "", ...(c.baseSha ? { sha: c.baseSha } : {}), repo: repository },
        head: { ref: c.headBranch, sha: c.sha, repo: repository },
        draft: false,
      },
      repository,
    };
  }
  return {
    ref: c.ref,
    ...(before ? { before } : {}),
    after: c.sha,
    repository,
  };
}

/** Most local action directories read while planning one workflow. */
const MAX_LOCAL_ACTIONS = 20;
const MAX_LOCAL_ACTION_DEPTH = 5;

/** `uses: ./dir` references in a workflow or composite action document. */
function localUses(text: string): string[] {
  let doc: unknown;
  try {
    doc = parse(text, { merge: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "uses" && typeof v === "string" && (v.startsWith("./") || v.startsWith("../"))) {
          out.push(v.trim());
        } else walk(v);
      }
    }
  };
  walk(doc);
  return out;
}

/**
 * Fetches the local composite actions a workflow uses (`uses: ./dir`, and the ones those use,
 * to a bounded depth and count) through the read-only GitHub client, so the planner can see
 * a docker step hidden inside one. Paths go through the same repo-relative check as host
 * reads: anything absolute or climbing out is never requested (the planner marks that job
 * unsupported). Files over the safe reader's size cap are ignored.
 */
async function fetchLocalActions(
  github: GithubClient,
  repo: string,
  sha: string,
  workflowYaml: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  let level = localUses(workflowYaml);
  for (let depth = 0; depth < MAX_LOCAL_ACTION_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const uses of level) {
      const dir = localActionDir(uses);
      if (dir === undefined || seen.has(dir) || seen.size >= MAX_LOCAL_ACTIONS) continue;
      seen.add(dir);
      for (const name of ["action.yml", "action.yaml"]) {
        const path = dir === "" ? name : `${dir}/${name}`;
        assertRepoRelative(path);
        const text = await github.fileAt(repo, path, sha);
        if (text === undefined) continue;
        if (text.length <= MAX_REPO_FILE_BYTES) {
          files.set(path, text);
          next.push(...localUses(text));
        }
        break;
      }
    }
    level = next;
  }
  return files;
}

/** True when the workflow has a path filter, so changed files are worth an API call. */
const hasPathFilter = (yaml: string): boolean => /^\s*paths(-ignore)?\s*:/m.test(yaml);

/**
 * One poll of one repo: finds the default branch head and (when allowed) open same-repo PRs by
 * allowlisted authors, and for each (repo, workflow, event, sha) not seen before plans the whole
 * workflow: the trigger router (event, branch and path filters, with the changed files from the
 * compare API), the job graph with matrices expanded, needs, and `if:` and unsupported flags per
 * job. A workflow that does not trigger creates no run (and is remembered, so it is not looked at
 * again). Otherwise one run is created with every job queued and the plan stored, and a run in
 * the same concurrency group with cancel-in-progress supersedes the older ones. Idempotent.
 * Honours the per-hour run cap. Rate limits propagate to the caller.
 */
export async function pollRepo(deps: IngestDeps, cfg: PollRepoConfig): Promise<IngestResult> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  const result: IngestResult = { created: [], refused: [], superseded: [] };
  const scope = await targetScope(deps.db, cfg);
  const repo = cfg.repo;

  // The worker finds the repo to fetch through the project's binding.
  const [owner, name] = repo.toLowerCase().split("/") as [string, string];
  const bound = await listRepos(deps.db, scope);
  if (!bound.some((r) => r.forge === "github" && r.owner === owner && r.repo === name)) {
    await bindRepo(deps.db, scope, { forge: "github", owner, repo: name });
  }

  const candidates: Candidate[] = [];
  const head = await deps.github.branchHead(repo, cfg.defaultBranch);
  const forgeProtected = await deps.github.branchProtected(repo, cfg.defaultBranch);
  candidates.push({
    event: "push",
    ref: `refs/heads/${cfg.defaultBranch}`,
    sha: head.sha,
    actor: head.author,
    message: head.message,
    headBranch: cfg.defaultBranch,
    sameRepo: true,
    ...(forgeProtected === undefined ? {} : { forgeProtected }),
  });

  if (cfg.prMode === "approval") {
    // Stranger-controlled work is bounded before any forge call is spent on it: a waiting cap
    // checked first (counting what this poll already took), and a budget of new candidates.
    const memo = deps.overCap;
    let waiting = await countWaitingRuns(deps.db, scope, repo);
    if (waiting < cfg.maxWaitingRuns) {
      for (const k of memo ?? []) if (k.startsWith(`${repo}#`)) memo?.delete(k);
    }
    let budget = cfg.maxNewPrsPerPoll;
    let taken = 0;
    for (const pr of onlyListed(cfg, await deps.github.openPulls(repo))) {
      if (
        await pollSeen(deps.db, scope, {
          repo,
          workflowPath: cfg.workflow,
          event: "pull_request",
          sha: pr.headSha,
        })
      ) {
        continue;
      }
      if (lower(pr.baseRepo) !== lower(repo)) {
        result.refused.push({
          what: `pr #${pr.number}`,
          reason: "base repo is not the configured repo",
        });
        continue;
      }
      const sameRepo = pr.headRepo !== null && lower(pr.headRepo) === lower(repo);
      const allowlisted = pr.author !== null && allowed(cfg, pr.author);
      if (!allowlisted) {
        const memoKey = `${repo}#${pr.headSha}`;
        if (memo?.has(memoKey)) continue;
        // A new push to a waiting PR replaces its run, so its own waiting run does not count.
        const full =
          waiting + taken >= cfg.maxWaitingRuns &&
          (await countWaitingRuns(deps.db, scope, repo, pr.number)) + taken >= cfg.maxWaitingRuns;
        if (full) {
          memo?.add(memoKey);
          result.refused.push({
            what: `pr #${pr.number}`,
            reason: "too many runs are waiting for approval",
          });
          continue;
        }
        if (budget <= 0) continue; // the next poll
        budget--;
        taken++;
      }
      // A fork is untrusted whoever opened it, so the forge is not asked about its author. For a
      // same-repo PR the opener's permission is re-fetched now (never taken from PR text); if the
      // token cannot ask, the author is not trusted.
      let permission: ForgePermission | "unknown" | undefined;
      if (sameRepo && !allowlisted && pr.author !== null) {
        permission = await deps.github.collaboratorPermission(repo, pr.author);
        if (permission === "unknown") {
          log(`poll ${repo}: cannot read ${pr.author}'s permission; pr #${pr.number} is untrusted`);
        }
      }
      candidates.push({
        event: "pull_request",
        ref: `refs/pull/${pr.number}/head`,
        sha: pr.headSha,
        actor: pr.author,
        message: pr.title,
        headBranch: pr.headRef,
        prNumber: pr.number,
        baseRef: pr.baseRef,
        ...(pr.baseSha ? { baseSha: pr.baseSha } : {}),
        sameRepo,
        allowlisted,
        ...(permission === undefined ? {} : { permission }),
      });
    }
  }

  if (cfg.prMode === "allowlist") {
    for (const pr of onlyListed(cfg, await deps.github.openPulls(repo))) {
      // Already handled: no API call at all.
      if (
        await pollSeen(deps.db, scope, {
          repo,
          workflowPath: cfg.workflow,
          event: "pull_request",
          sha: pr.headSha,
        })
      ) {
        continue;
      }
      let verdict = gatePullRequestOpener(cfg, pr);
      let message = pr.title;
      if (verdict.ok) {
        // Only now spend an API call (ETag-cached, immutable) on the head commit: who wrote it
        // for the gate, and its real message for the run.
        const head = await deps.github.commitInfo(repo, pr.headSha);
        verdict = gateHeadCommit(cfg, head.author);
        if (head.message !== "") message = head.message;
      }
      if (!verdict.ok) {
        result.refused.push({ what: `pr #${pr.number}`, reason: verdict.reason });
        continue;
      }
      candidates.push({
        event: "pull_request",
        ref: `refs/pull/${pr.number}/head`,
        sha: pr.headSha,
        actor: pr.author,
        message,
        headBranch: pr.headRef,
        prNumber: pr.number,
        baseRef: pr.baseRef,
        ...(pr.baseSha ? { baseSha: pr.baseSha } : {}),
        sameRepo: true,
        allowlisted: true,
      });
    }
  }

  for (const c of candidates) {
    const what = `${c.event} ${c.sha.slice(0, 7)}`;
    const key = { repo, workflowPath: cfg.workflow, event: c.event, sha: c.sha };
    if (await pollSeen(deps.db, scope, key)) continue;
    const used = await countPolledSince(deps.db, scope, repo, now - 3_600_000);
    // `used` already includes what this poll created (the marker commits with the run).
    // A pull request that may be held for approval is judged after its class is known: held
    // runs have their own cap and must not eat this one.
    const mayBeHeld = c.event === "pull_request" && c.allowlisted !== true;
    const capReached = (): boolean => used >= cfg.maxRunsPerHour;
    if (capReached() && !mayBeHeld) {
      result.refused.push({ what, reason: "hourly run cap reached" });
      log(`poll ${repo}: hourly cap of ${cfg.maxRunsPerHour} reached`);
      continue;
    }
    const yaml = await deps.github.fileAt(repo, cfg.workflow, c.sha);
    if (yaml === undefined) {
      result.refused.push({ what, reason: "workflow not found at that commit" });
      continue;
    }

    // Changed files, for path filters: base..head for a PR, before..after for a push. Unknown
    // (no base, a force push, too many files) means the filters are not applied.
    let changedFiles: string[] | undefined;
    if (hasPathFilter(yaml)) {
      if (c.event === "pull_request") {
        changedFiles = c.baseRef
          ? await deps.github.changedFiles(repo, c.baseRef, c.sha)
          : undefined;
      } else {
        const before = await lastPolledSha(deps.db, scope, repo, cfg.workflow, "push");
        changedFiles =
          before && before !== c.sha
            ? await deps.github.changedFiles(repo, before, c.sha)
            : undefined;
      }
    }
    const event: WorkflowEvent = {
      name: c.event,
      ref: c.ref,
      ...(c.baseRef ? { baseRef: c.baseRef } : {}),
      ...(changedFiles ? { changedFiles } : {}),
    };
    const workflowName = describeWorkflow(yaml)?.name ?? undefined;
    const githubExtra: Record<string, Value> = {
      sha: c.sha,
      ...(c.actor ? { actor: c.actor } : {}),
      ...(c.event === "pull_request" ? { head_ref: c.headBranch } : {}),
      ...(workflowName ? { workflow: workflowName } : {}),
      event: eventPayload(
        c,
        repo,
        c.event === "push"
          ? ((await lastPolledSha(deps.db, scope, repo, cfg.workflow, "push")) ?? undefined)
          : undefined,
      ),
    };

    let wp;
    try {
      // Local composite actions are fetched first (read-only, bounded), so a docker step inside
      // one marks its job unsupported at plan time.
      const localFiles = /uses:\s*['"]?\.\.?\//.test(yaml)
        ? await fetchLocalActions(deps.github, repo, c.sha, yaml)
        : new Map<string, string>();
      wp = planWorkflow(yaml, event, {
        readFile: (p) => {
          assertRepoRelative(p);
          return localFiles.get(p);
        },
        github: githubExtra,
      });
    } catch (err) {
      const reason = `plan rejected: ${err instanceof Error ? err.message : String(err)}`;
      await markPollSkipped(deps.db, scope, { ...key, now });
      result.refused.push({ what, reason });
      continue;
    }
    if (!wp.trigger.matched) {
      // Deterministic for this sha: remember it so the compare call is not repeated.
      await markPollSkipped(deps.db, scope, { ...key, now });
      result.refused.push({ what, reason: `not triggered: ${wp.trigger.reason}` });
      log(`poll ${repo}: ${what} not triggered (${wp.trigger.reason})`);
      continue;
    }
    if (wp.jobs.length === 0) {
      result.refused.push({ what, reason: "workflow has no jobs" });
      continue;
    }
    const jobs: PolledJob[] = wp.jobs.map((n) => ({
      key: n.key,
      name: n.name,
      needs: n.needs,
      ...(n.matrix ? { matrix: n.matrix } : {}),
      planned: n,
    }));
    // Unknown needs, cycles and absurd job counts never become a run.
    const invalid = validateJobGraph(jobs);
    if (invalid) {
      result.refused.push({ what, reason: invalid });
      continue;
    }
    // The class is decided here, once, from the facts above; the worker never raises it.
    const decision = decideRun({
      event: c.event,
      ref: c.ref,
      baseRef: c.baseRef,
      sameRepo: c.sameRepo,
      actor: c.actor,
      permission: c.permission,
      allowlisted: c.allowlisted,
      protectedRefs: [`refs/heads/${cfg.defaultBranch}`, ...cfg.protectedRefs],
      forgeProtected: c.forgeProtected,
      workflowHash: createHash("sha256").update(yaml).digest("hex"),
      now,
    });
    const hold = needsApproval(decision.class);
    if (!hold && capReached()) {
      result.refused.push({ what, reason: "hourly run cap reached" });
      log(`poll ${repo}: hourly cap of ${cfg.maxRunsPerHour} reached`);
      continue;
    }
    if (hold && (await countWaitingRuns(deps.db, scope, repo, c.prNumber)) >= cfg.maxWaitingRuns) {
      result.refused.push({ what, reason: "too many runs are waiting for approval" });
      continue;
    }
    // An untrusted workflow file picks its own concurrency group: never let it name one that
    // another run uses (it could cancel or block the default branch). Its group is its PR's.
    const group = wp.concurrency
      ? hold
        ? `untrusted:pr-${c.prNumber ?? "x"}:${wp.concurrency.group}`
        : wp.concurrency.group
      : undefined;
    // Untrusted code never gets open egress, whatever the repo or project allows.
    const egress = hold
      ? cfg.untrustedEgress
      : (cfg.egress ?? (await getProjectEgress(deps.db, scope)));
    const headCheckoutJobs = Object.entries(workflowHeadCheckouts(yaml))
      .filter(([, v]) => v.length > 0)
      .map(([k]) => k);
    const created = await createPolledRun(deps.db, scope, {
      repo,
      provider: deps.provider,
      now,
      jobs,
      hold,
      cancelInProgress: wp.concurrency?.cancelInProgress ?? false,
      run: {
        workflowPath: cfg.workflow,
        event: c.event,
        ref: c.ref,
        sha: c.sha,
        workflowName: workflowName ?? wp.name ?? undefined,
        commitMessage: c.message,
        actor: c.actor ?? undefined,
        headBranch: c.headBranch,
        prNumber: c.prNumber,
        plan: JSON.stringify({
          env: wp.env,
          github: githubContext(event, githubExtra),
          vars: {},
          // What isolation and egress policy read: the decided class, and the sandbox egress.
          trust: decision.class,
          egress,
          // Jobs whose own steps check out the PR head: the demotion rule makes them untrusted.
          ...(headCheckoutJobs.length > 0 ? { headCheckouts: headCheckoutJobs } : {}),
          ...(wp.concurrency ? { concurrency: wp.concurrency } : {}),
        }),
        ...(group ? { concurrencyGroup: group } : {}),
        trust: JSON.stringify(decision),
      },
    });
    if (created) {
      result.created.push(created.run.id);
      result.superseded.push(...created.superseded.running);
      log(
        `poll ${repo}: ${hold ? "holding for approval" : "queued"} ${what} (${decision.class}), ${jobs.length} job(s)${
          created.superseded.runIds.length > 0
            ? `, superseded ${created.superseded.runIds.length} older run(s)`
            : ""
        }`,
      );
    }
  }
  return result;
}

export type { PollConfig };
