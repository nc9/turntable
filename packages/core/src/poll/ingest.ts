import { parse } from "yaml";
import type { Db } from "../db";
import {
  bindRepo,
  countPolledSince,
  createPolledRun,
  ensureLocalTenant,
  getOrgBySlug,
  getProjectBySlug,
  listRepos,
  type PolledJob,
  type Scope,
} from "../db/repos";
import type { PollConfig, PollRepoConfig } from "./config";
import type { GithubClient } from "./github";

export type Candidate = {
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

/**
 * The pull request gate. A PR runs only if its head repo IS the configured repo (never a fork,
 * never a deleted fork) and its author is on the allowlist. Both are read from the API response,
 * never from the PR's own text. Anything else is refused, whatever else is true.
 */
export function gatePullRequest(
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
  if (!cfg.authors.some((a) => lower(a) === lower(pr.author))) {
    return { ok: false, reason: "author is not on the allowlist" };
  }
  return { ok: true };
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

export type IngestResult = { created: string[]; refused: { what: string; reason: string }[] };

async function targetScope(db: Db, cfg: PollRepoConfig): Promise<Required<Scope>> {
  if (cfg.org === "local" && cfg.project === "local") return ensureLocalTenant(db);
  const org = await getOrgBySlug(db, cfg.org);
  if (!org) throw new Error(`poll config: no org ${cfg.org}`);
  const project = await getProjectBySlug(db, { orgId: org.id }, cfg.project);
  if (!project) throw new Error(`poll config: no project ${cfg.project} in org ${cfg.org}`);
  return { orgId: org.id, projectId: project.id };
}

/**
 * One poll of one repo: finds the default branch head and (when allowed) open same-repo PRs by
 * allowlisted authors, and creates a run for each (repo, workflow, event, sha) not seen before.
 * Idempotent. Honours the per-hour run cap. Rate limits propagate to the caller.
 */
export async function pollRepo(deps: IngestDeps, cfg: PollRepoConfig): Promise<IngestResult> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  const result: IngestResult = { created: [], refused: [] };
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
      const verdict = gatePullRequest(cfg, pr);
      if (!verdict.ok) {
        result.refused.push({ what: `pr #${pr.number}`, reason: verdict.reason });
        continue;
      }
      candidates.push({
        event: "pull_request",
        ref: `refs/pull/${pr.number}/head`,
        sha: pr.headSha,
        actor: pr.author,
        message: pr.title,
        headBranch: pr.headRef,
        prNumber: pr.number,
      });
    }
  }

  for (const c of candidates) {
    const used = await countPolledSince(deps.db, scope, repo, now - 3_600_000);
    if (used + result.created.length >= cfg.maxRunsPerHour) {
      result.refused.push({
        what: `${c.event} ${c.sha.slice(0, 7)}`,
        reason: "hourly run cap reached",
      });
      log(`poll ${repo}: hourly cap of ${cfg.maxRunsPerHour} reached`);
      continue;
    }
    const yaml = await deps.github.fileAt(repo, cfg.workflow, c.sha);
    if (yaml === undefined) {
      result.refused.push({
        what: `${c.event} ${c.sha.slice(0, 7)}`,
        reason: "workflow not found at that commit",
      });
      continue;
    }
    const wf = describeWorkflow(yaml);
    if (!wf || wf.jobs.length === 0) {
      result.refused.push({
        what: `${c.event} ${c.sha.slice(0, 7)}`,
        reason: "workflow has no jobs or is not valid YAML",
      });
      continue;
    }
    const run = await createPolledRun(deps.db, scope, {
      repo,
      provider: deps.provider,
      now,
      jobs: wf.jobs,
      run: {
        workflowPath: cfg.workflow,
        event: c.event,
        ref: c.ref,
        sha: c.sha,
        workflowName: wf.name ?? undefined,
        commitMessage: c.message,
        actor: c.actor ?? undefined,
        headBranch: c.headBranch,
        prNumber: c.prNumber,
      },
    });
    if (run) {
      result.created.push(run.id);
      log(`poll ${repo}: queued ${c.event} ${c.sha.slice(0, 7)}`);
    }
  }
  return result;
}

export type { PollConfig };
