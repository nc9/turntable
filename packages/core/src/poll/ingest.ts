import { githubContext, planWorkflow, type Value, type WorkflowEvent } from "@turntable/act-runner";
import { parse } from "yaml";
import type { Db } from "../db";
import {
  bindRepo,
  countPolledSince,
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
import type { PollConfig, PollRepoConfig } from "./config";
import type { GithubClient } from "./github";

export type Candidate = {
  /** For a pull request: the base branch it targets. */
  baseRef?: string;
  event: "push" | "pull_request";
  ref: string;
  sha: string;
  actor: string | null;
  message: string;
  headBranch: string;
  prNumber?: number;
};

export type GateVerdict = { ok: true } | { ok: false; reason: string };

const lower = (s: string | null | undefined): string => (s ?? "").toLowerCase();

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

/** The `github.event` payload `if:` expressions see (the parts we know). */
function eventPayload(c: Candidate): Value {
  if (c.event === "pull_request") {
    return {
      pull_request: {
        base: { ref: c.baseRef ?? "" },
        head: { ref: c.headBranch, sha: c.sha },
        draft: false,
      },
    };
  }
  return {};
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
  candidates.push({
    event: "push",
    ref: `refs/heads/${cfg.defaultBranch}`,
    sha: head.sha,
    actor: head.author,
    message: head.message,
    headBranch: cfg.defaultBranch,
  });

  if (cfg.prMode === "allowlist") {
    for (const pr of await deps.github.openPulls(repo)) {
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
      });
    }
  }

  for (const c of candidates) {
    const what = `${c.event} ${c.sha.slice(0, 7)}`;
    const key = { repo, workflowPath: cfg.workflow, event: c.event, sha: c.sha };
    if (await pollSeen(deps.db, scope, key)) continue;
    const used = await countPolledSince(deps.db, scope, repo, now - 3_600_000);
    if (used + result.created.length >= cfg.maxRunsPerHour) {
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
      event: eventPayload(c),
    };

    let wp;
    try {
      wp = planWorkflow(yaml, event, { readFile: () => undefined, github: githubExtra });
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
    const created = await createPolledRun(deps.db, scope, {
      repo,
      provider: deps.provider,
      now,
      jobs,
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
          ...(wp.concurrency ? { concurrency: wp.concurrency } : {}),
        }),
        ...(wp.concurrency ? { concurrencyGroup: wp.concurrency.group } : {}),
      },
    });
    if (created) {
      result.created.push(created.run.id);
      result.superseded.push(...created.superseded.running);
      log(
        `poll ${repo}: queued ${what}, ${jobs.length} job(s)${
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
