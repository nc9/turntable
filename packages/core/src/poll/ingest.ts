import {
  githubContext,
  localActionDir,
  matchesPatterns,
  planWorkflow,
  workflowHeadCheckouts,
  type Value,
  type WorkflowEvent,
} from "@turntable/act-runner";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { Db } from "../db";
import {
  appendAudit,
  cancelRunJobs,
  listActivePrRuns,
  bindRepo,
  findRepoBindingByName,
  countPolledSince,
  countWaitingRuns,
  getProjectEgress,
  createPolledRun,
  lastPolledSha,
  clearPollMarker,
  markPollSkipped,
  pollMarkedAt,
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
import { checkScopeFor } from "../checks/mapping";
import type { PollConfig, PollRepoConfig } from "./config";
import { decideRun, type ForgePermission, needsApproval } from "../trust";
import type { GithubClient, PullRequest, TagRuleset } from "./github";
import { patternProtected, protectingRulesets, type TagProtection } from "./tag-protection";

export type Candidate = {
  /** For a pull request: the base branch it targets. */
  baseRef?: string;
  /** The base branch commit at poll time, stored on the run for `github.event`. */
  baseSha?: string;
  event: "push" | "pull_request" | "merge_group";
  ref: string;
  sha: string;
  actor: string | null;
  message: string;
  headBranch: string;
  prNumber?: number;
  /** For a pull request: the PR object's facts for `github.event.pull_request` (data only). */
  pr?: PullRequest;
  /** Forge facts for the trust decision, re-fetched at ingest. */
  sameRepo?: boolean;
  permission?: ForgePermission | "unknown";
  allowlisted?: boolean;
  forgeProtected?: boolean;
  /** The tag name, for a run made from a tag ref. */
  tag?: string;
  /** Whether a ruleset restricts creating this tag; a tag that is not protected waits for approval. */
  tagProtection?: TagProtection;
  /** The annotated tag's tagger name: display only (see `facts.taggerLabel`), never the actor. */
  taggerLabel?: string;
  /** A push's `before` and where it came from (see `resolveBefore`). */
  before?: string | undefined;
  beforeSource?: BeforeSource;
};

/** Most missed default-branch pushes one poll turns into runs when `everyPush` is on. */
const MAX_GAP_PUSHES = 5;

/** Where a push run's `before` came from, recorded in the run's trust facts. */
export type BeforeSource = "events" | "first_parent" | "last_polled" | "none";

/**
 * GitHub's `before` for a default-branch push to `sha`, as close as the API lets us get, in order:
 * (a) the events API's PushEvent for that head (GitHub's own value, but delayed and bounded);
 * (b) the commit's first parent when it has exactly one (right for a one-commit push, the squash
 *     merge case; a multi-commit fast-forward would have an older `before`);
 * (c) the last sha the poller handled for the repo, which spans every push it missed.
 * The source is recorded so a divergence from GitHub can be told apart.
 */
async function resolveBefore(
  deps: IngestDeps,
  cfg: PollRepoConfig,
  scope: Required<Scope>,
  events: () => Promise<{ ref: string; head: string; before: string }[]>,
  sha: string,
): Promise<{ before: string | undefined; source: BeforeSource }> {
  const ref = `refs/heads/${cfg.defaultBranch}`;
  const ev = (await events()).find((e) => e.ref === ref && e.head === sha.toLowerCase());
  if (ev) return { before: ev.before, source: "events" };
  const info = await deps.github.commitInfo(cfg.repo, sha);
  if (info.parents.length === 1) return { before: info.parents[0], source: "first_parent" };
  const last = await lastPolledSha(deps.db, scope, cfg.repo, cfg.workflow, "push");
  return last && last !== sha
    ? { before: last, source: "last_polled" }
    : { before: undefined, source: "none" };
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

const lower = (s: string | null | undefined): string => (s ?? "").toLowerCase();

/** Narrows open pull requests to `prNumbers` when the config lists them. */
const onlyListed = <T extends { number: number }>(
  cfg: Pick<PollRepoConfig, "prNumbers">,
  prs: T[],
): T[] =>
  cfg.prNumbers === undefined ? prs : prs.filter((p) => cfg.prNumbers!.includes(p.number));

const MARKER_PR_MODE = { event: "pr-mode-enabled", sha: "since" } as const;

/**
 * The open pull requests this poll may ingest. On the first poll with PR mode on (no persisted
 * `pr-mode-enabled` marker) every open PR's current head is recorded as seen (run id `baseline`),
 * the marker is set, and nothing is ingested, except PRs named in `prNumbers`, an explicit
 * operator choice. After that a (PR, head) pair runs only when it is not already seen, so a push
 * or a newly opened PR runs, and a comment or label (same head) does not. No time is used. The
 * marker survives restarts and is cleared while PR mode is off, so turning it on again takes a
 * new baseline.
 */
async function openPullsFor(
  deps: IngestDeps,
  cfg: PollRepoConfig,
  scope: Scope,
  now: number,
): Promise<PullRequest[]> {
  const marker = { repo: cfg.repo, workflowPath: cfg.workflow, ...MARKER_PR_MODE };
  const all = await deps.github.openPulls(cfg.repo);
  if (!cfg.prBaseline || (await pollMarkedAt(deps.db, scope, marker)) !== undefined) {
    return onlyListed(cfg, all);
  }
  for (const pr of all) {
    if (cfg.prNumbers?.includes(pr.number)) continue;
    await markPollSkipped(deps.db, scope, {
      repo: cfg.repo,
      workflowPath: cfg.workflow,
      event: "pull_request",
      sha: pr.headSha,
      now,
      runId: "baseline",
    });
  }
  // Set last: a poll that fails part way takes the baseline again.
  await markPollSkipped(deps.db, scope, { ...marker, now });
  return cfg.prNumbers === undefined ? [] : onlyListed(cfg, all);
}

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
  /** Tag facts kept between polls by the long-lived poller. A poll with none keeps its own. */
  tagCaches?: TagCaches;
};

export async function targetScope(db: Db, cfg: PollRepoConfig): Promise<Required<Scope>> {
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
  /** Set when the repo was not polled because another project holds its binding. */
  skipped?: string;
};

/**
 * The `github.event` payload: what `if:` expressions see at plan time, and what act is given for
 * the job. Forge facts only, each fetched at poll time.
 */
function eventPayload(c: Candidate, repo: string, before?: string): Value {
  const repository = { full_name: repo };
  if (c.event === "pull_request") {
    const pr = c.pr;
    const headRepo = pr ? pr.headRepo : repo;
    const fork =
      pr?.headFork ?? (headRepo !== null && headRepo.toLowerCase() !== repo.toLowerCase());
    return {
      ...(c.prNumber === undefined ? {} : { number: c.prNumber }),
      pull_request: {
        ...(c.prNumber === undefined ? {} : { number: c.prNumber }),
        base: { ref: c.baseRef ?? "", ...(c.baseSha ? { sha: c.baseSha } : {}), repo: repository },
        head: {
          ref: c.headBranch,
          sha: c.sha,
          ...(headRepo === null ? {} : { repo: { full_name: headRepo, fork } }),
        },
        draft: pr?.draft === true,
        ...(pr
          ? {
              title: pr.title,
              body: pr.body,
              labels: pr.labels.map((name) => ({ name })),
              ...(pr.author === null
                ? {}
                : {
                    user: { login: pr.author, ...(pr.authorType ? { type: pr.authorType } : {}) },
                  }),
            }
          : {}),
      },
      ...(pr?.author
        ? { sender: { login: pr.author, ...(pr.authorType ? { type: pr.authorType } : {}) } }
        : {}),
      repository,
    };
  }
  if (c.event === "merge_group") {
    return {
      action: "checks_requested",
      merge_group: {
        head_sha: c.sha,
        head_ref: c.ref,
        base_ref: `refs/heads/${c.baseRef ?? ""}`,
        base_sha: c.baseSha ?? "",
        head_commit: { id: c.sha, message: c.message },
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
export async function fetchLocalActions(
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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Merge queue candidates. A queue branch is only a name anyone with write access can create, so
 * a run is made for one only when all of this holds, each fact fetched now: the name is
 * `gh-readonly-queue/<default branch>/pr-<n>-<base sha>`; the branch tip's commit is signed and
 * verified by GitHub and committed by GitHub's own address; PR n is open, in this repo (base and
 * head) and opened by a listed author. The class is then decided by the trust module as for any
 * merge_group (trusted_pr: no secrets, no write token).
 */
async function queueCandidates(
  deps: IngestDeps,
  cfg: PollRepoConfig,
  scope: Required<Scope>,
  out: Candidate[],
  result: IngestResult,
): Promise<void> {
  const repo = cfg.repo;
  const re = new RegExp(
    `^refs/heads/gh-readonly-queue/${escapeRe(cfg.defaultBranch)}/pr-(\\d{1,9})-([0-9a-f]{40,64})$`,
  );
  const branches = (await deps.github.queueBranches(repo, cfg.defaultBranch)).slice(0, 20);
  let pulls: Awaited<ReturnType<GithubClient["openPulls"]>> | undefined;
  for (const b of branches) {
    const m = re.exec(b.ref);
    if (!m) continue;
    const what = `merge_group ${b.sha.slice(0, 7)}`;
    if (
      await pollSeen(deps.db, scope, {
        repo,
        workflowPath: cfg.workflow,
        event: "merge_group",
        sha: b.sha,
      })
    ) {
      continue;
    }
    const number = Number(m[1]);
    pulls ??= await deps.github.openPulls(repo);
    const pr = pulls.find((p) => p.number === number);
    if (!pr) {
      result.refused.push({ what, reason: `pr #${number} is not open` });
      continue;
    }
    const opener = gatePullRequestOpener({ ...cfg, prMode: "allowlist" }, pr);
    if (!opener.ok) {
      result.refused.push({ what, reason: `pr #${number}: ${opener.reason}` });
      continue;
    }
    const commit = await deps.github.queueCommit(repo, b.sha);
    if (!commit.verified || lower(commit.committerEmail) !== "noreply@github.com") {
      result.refused.push({ what, reason: "queue commit is not a verified GitHub commit" });
      continue;
    }
    out.push({
      event: "merge_group",
      ref: b.ref,
      sha: b.sha,
      actor: pr.author,
      message: commit.message,
      headBranch: b.ref.slice("refs/heads/".length),
      baseRef: cfg.defaultBranch,
      baseSha: m[2] as string,
      sameRepo: true,
      allowlisted: true,
    });
  }
}

/** Most UNSEEN tags one poll turns into candidates. Seen ones cost nothing and are not counted. */
const MAX_UNSEEN_TAGS_PER_POLL = 10;
/** Most forge requests (tag objects, history pages, rulesets) one poll spends on tags. */
const MAX_TAG_REQUESTS_PER_POLL = 100;
/** How far down the default branch's first-parent history a tagged commit may be. */
const FIRST_PARENT_DEPTH = 1000;
/** How long a repo's rulesets are believed. */
const RULESET_TTL_MS = 60_000;

/** What the poller remembers about tags between polls. All of it is about immutable things or short-lived. */
export type TagCaches = {
  /** Annotated tag objects, peeled: they never change. */
  peeled: Map<string, { sha: string; tagger: string | null } | null>;
  /** Only a reading that protects none of the repo's patterns is kept (see `tagCandidates`). */
  rulesets: Map<string, { at: number; value: TagRuleset[] | "unknown" }>;
  /** When each tag name was first listed, by `repo\ntag`: what the persisted marker says. */
  listed: Map<string, number>;
  /** First-parent history by default head sha (a head's history never changes). */
  chains: Map<string, Set<string> | "unknown">;
};
export const newTagCaches = (): TagCaches => ({
  peeled: new Map(),
  rulesets: new Map(),
  listed: new Map(),
  chains: new Map(),
});

/** The literal start of one pattern after `refs/tags/`, to narrow the listing to that pattern. */
function patternPrefix(pattern: string): string {
  const rest = pattern.slice("refs/tags/".length);
  const cut = rest.search(/[*?]/);
  return cut < 0 ? rest : rest.slice(0, cut);
}

/**
 * Tag candidates, when the project opted in with `tagRefs`. A tag is a name anyone with write
 * access can create or move, so a run is made for one only when all of this holds, each fact
 * fetched now:
 *  - it matches a pattern (listed per pattern, filtered before any tag object is read);
 *  - it is new: (name, commit) not seen. Seen tags are skipped before anything is counted, and a
 *    poll stops after a few UNSEEN ones, so old tags never starve new ones;
 *  - its name was not seen at another commit (a moved tag creates nothing and is audited);
 *  - its commit is on the default branch's FIRST-PARENT history (or was itself ingested as a
 *    default branch push), so a commit that only came in with a merged branch, and a commit on an
 *    unmerged branch, never become a release run;
 *  - the run's actor is the tag's creator (an annotated tag's tagger, else unknown), never the
 *    commit's author.
 * Whether the run starts at once or waits for approval depends on whether a ruleset protects the
 * pattern (see tag-protection.ts); the class itself is decided later by the trust decision.
 */
async function tagCandidates(
  deps: IngestDeps,
  cfg: PollRepoConfig,
  scope: Required<Scope>,
  defaultHead: string,
  out: Candidate[],
  result: IngestResult,
): Promise<void> {
  const repo = cfg.repo;
  const now = (deps.now ?? Date.now)();
  const caches = (deps.tagCaches ??= newTagCaches());
  let requests = 0;
  const spent = (n = 1): boolean => (requests += n) > MAX_TAG_REQUESTS_PER_POLL;

  // The rulesets are read FIRST, then the tags are listed: a tag that is in a listing taken after
  // protection was seen either existed before it or was created under it, and the marker below
  // says which. A reading that shows protection is never kept for a later poll (a ruleset can be
  // loosened or deleted at any moment); one that shows none may be, for a minute.
  let rulesets = caches.rulesets.get(repo);
  if (!rulesets || now - rulesets.at > RULESET_TTL_MS) {
    const value = await deps.github.tagRulesets(repo);
    spent(2);
    rulesets = { at: now, value };
    const protectsSomething = cfg.tagRefs.some((p) => patternProtected(value, p));
    if (protectsSomething) caches.rulesets.delete(repo);
    else caches.rulesets.set(repo, rulesets);
  }
  const rulesetValue = rulesets.value;
  // Since when each pattern has been protected, persisted per (repo, pattern); cleared at the first
  // poll that does not see protection, so a ruleset that lapsed and came back starts again.
  const since = new Map<string, number>();
  for (const pattern of cfg.tagRefs) {
    const marker = {
      repo,
      workflowPath: cfg.workflow,
      event: `tag-protected:${pattern}`,
      sha: "since",
    };
    const covering = protectingRulesets(rulesetValue, pattern);
    if (covering.length === 0) {
      await clearPollMarker(deps.db, scope, marker);
      continue;
    }
    await markPollSkipped(deps.db, scope, { ...marker, now });
    let from = (await pollMarkedAt(deps.db, scope, marker)) ?? now;
    // A ruleset edited after we first saw it protecting may not have protected before the edit
    // (it was loosened, tightened or replaced): start the clock again, so every tag listed up to
    // this poll counts as predating. Only times this server observed are evidence: a tag's own
    // dates (the tagger's, the commit's) are chosen by whoever creates it.
    const changed = Math.max(0, ...covering.map((r) => r.updatedAt ?? 0));
    if (changed > from) {
      await clearPollMarker(deps.db, scope, marker);
      await markPollSkipped(deps.db, scope, { ...marker, now });
      from = (await pollMarkedAt(deps.db, scope, marker)) ?? now;
    }
    since.set(pattern, from);
  }

  // Listed per pattern (a narrow listing each), filtered by pattern before any dereferencing.
  const found = new Map<
    string,
    { ref: string; type: "commit" | "tag"; sha: string; patterns: string[] }
  >();
  for (const pattern of cfg.tagRefs) {
    if (spent()) break;
    for (const r of await deps.github.tagRefs(repo, patternPrefix(pattern))) {
      if (!matchesPatterns([pattern], r.ref)) continue;
      const hit = found.get(r.ref);
      if (hit) hit.patterns.push(pattern);
      else found.set(r.ref, { ...r, patterns: [pattern] });
    }
  }

  // When each tag was first listed (a persisted marker; the first poll to list it writes it).
  const firstListed = new Map<string, number>();
  for (const ref of found.keys()) {
    const name = ref.slice("refs/tags/".length);
    const memo = `${repo}\n${name}`;
    let at = caches.listed.get(memo);
    if (at === undefined) {
      const marker = {
        repo,
        workflowPath: cfg.workflow,
        event: `tag-listed:${name}`,
        sha: "first",
      };
      await markPollSkipped(deps.db, scope, { ...marker, now });
      at = (await pollMarkedAt(deps.db, scope, marker)) ?? now;
      caches.listed.set(memo, at);
    }
    firstListed.set(ref, at);
  }

  let unseen = 0;
  for (const [ref, raw] of [...found].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (unseen >= MAX_UNSEEN_TAGS_PER_POLL || requests >= MAX_TAG_REQUESTS_PER_POLL) break;
    const name = ref.slice("refs/tags/".length);
    const what = `tag ${name}`;
    // The commit: known from the listing for a lightweight tag; an annotated tag is peeled once
    // (the object never changes, so it is remembered).
    let sha = raw.sha;
    let tagger: string | null = null;
    if (raw.type === "tag") {
      let peeled = caches.peeled.get(raw.sha);
      if (peeled === undefined) {
        if (spent()) break;
        peeled = (await deps.github.peelTag(repo, raw.sha)) ?? null;
        caches.peeled.set(raw.sha, peeled);
      }
      if (peeled === null) continue;
      sha = peeled.sha;
      tagger = peeled.tagger;
    }
    const seenEvent = `tag:${name}`;
    const key = { repo, workflowPath: cfg.workflow, event: seenEvent, sha };
    if (await pollSeen(deps.db, scope, key)) continue; // seen: free
    const prior = await lastPolledSha(deps.db, scope, repo, cfg.workflow, seenEvent);
    if (prior !== undefined && prior !== sha) {
      // Said once per (tag, new commit): the marker is the memory.
      const fresh = await markPollSkipped(deps.db, scope, {
        repo,
        workflowPath: cfg.workflow,
        event: `tag-moved:${name}`,
        sha,
        now,
      });
      if (fresh) {
        result.refused.push({
          what,
          reason: `tag_moved: was ${prior.slice(0, 7)}, now ${sha.slice(0, 7)}`,
        });
        await appendAudit(deps.db, scope, {
          principalKind: "system",
          principalId: "poller",
          op: "poll_tag_moved",
          effect: "read",
          outcome: "tag_moved",
          input: { repo, tag: name, was: prior, now: sha },
        }).catch(() => {});
      }
      continue;
    }
    unseen += 1;

    // On the default branch's first-parent history: the head itself, a commit we already ingested
    // as a default-branch push, or a commit on the chain walked from the head.
    let onMainline = sha === defaultHead;
    if (!onMainline) {
      onMainline = await pollSeen(deps.db, scope, {
        repo,
        workflowPath: cfg.workflow,
        event: "push",
        sha,
      });
    }
    if (!onMainline) {
      let chain = caches.chains.get(defaultHead);
      if (chain === undefined) {
        if (spent(Math.ceil(FIRST_PARENT_DEPTH / 100))) break;
        chain =
          (await deps.github.firstParentChain(repo, defaultHead, FIRST_PARENT_DEPTH)) ?? "unknown";
        caches.chains.set(defaultHead, chain);
      }
      onMainline = chain !== "unknown" && chain.has(sha);
    }
    if (!onMainline) {
      // Not remembered: it may be merged (or the history walked further) later.
      result.refused.push({
        what,
        reason: `its commit is not on the first-parent history of ${cfg.defaultBranch} (within ${FIRST_PARENT_DEPTH} commits)`,
      });
      continue;
    }

    const info = await deps.github.commitInfo(repo, sha);
    // Is the creation of this tag restricted to admins by a ruleset, and did that hold when the tag
    // was made? Every pattern the tag matches must be protected now, and the tag must first have
    // been listed strictly after protection was first seen (or last changed) for that pattern,
    // else it may predate it. Unknown counts as no.
    const protectedNow = raw.patterns.every((p) => since.has(p));
    const afterProtection = raw.patterns.every((p) => {
      const from = since.get(p);
      return from !== undefined && (firstListed.get(ref) ?? 0) > from;
    });
    const protection: TagProtection =
      protectedNow && afterProtection
        ? "ruleset"
        : protectedNow
          ? "predates"
          : rulesetValue === "unknown"
            ? "unknown"
            : "none";

    out.push({
      event: "push",
      ref,
      sha,
      // A tag run has NO actor: the API names a tagger as free text, not a verified identity, and
      // the actor feeds the author check and the OIDC claims. The label is kept for display only.
      actor: null,
      ...(tagger ? { taggerLabel: tagger } : {}),
      message: info.message,
      headBranch: name,
      sameRepo: true,
      tag: name,
      tagProtection: protection,
    });
  }
}

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
/** Closed PRs checked per poll, so a project with many stale runs costs a bounded number of calls. */
const MAX_CLOSED_PR_CHECKS = 20;

/**
 * Cancels the queued, running and awaiting-approval runs of pull requests that GitHub now says
 * are closed or merged, with the reason "PR closed". Only runs of event `pull_request` for that PR
 * number in this project and repo; push, merge group, tag and dispatch runs are never touched.
 * A PR is judged closed only by its own state from the forge, never by absence from the open
 * list. Audited as a system action. Best effort per PR: a failed look is retried next poll.
 */
export async function cancelClosedPrRuns(deps: IngestDeps, cfg: PollRepoConfig): Promise<string[]> {
  const scope = await targetScope(deps.db, cfg);
  const cancelledRuns: string[] = [];
  const active = await listActivePrRuns(deps.db, scope, cfg.repo);
  for (const pr of active.slice(0, MAX_CLOSED_PR_CHECKS)) {
    let state: "open" | "closed" | "unknown";
    try {
      state = await deps.github.pullState(cfg.repo, pr.number);
    } catch (err) {
      (deps.log ?? (() => {}))(`poll ${cfg.repo}: cannot read pr #${pr.number}: ${String(err)}`);
      continue;
    }
    if (state !== "closed") continue;
    for (const runId of pr.runIds) {
      const res = await cancelRunJobs(deps.db, scope, runId);
      if (!res) continue;
      cancelledRuns.push(runId);
      await appendAudit(deps.db, scope, {
        principalKind: "system",
        principalId: "poller",
        op: "cancel",
        effect: "destructive",
        outcome: "ok",
        input: { run_id: runId, reason: "PR closed", repo: cfg.repo, pr: pr.number },
      }).catch(() => {});
    }
  }
  if (cancelledRuns.length > 0) {
    (deps.log ?? (() => {}))(
      `poll ${cfg.repo}: cancelled ${cancelledRuns.length} run(s) of closed PRs`,
    );
  }
  return cancelledRuns;
}

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
    // A binding moved to another project (`move_repo_binding`) is the instance admin's: until the
    // entry names that project the repo is skipped, with no bind attempt and no GitHub call.
    if (await findRepoBindingByName(deps.db, { forge: "github", owner, repo: name })) {
      result.skipped = `poll ${repo}: bound to another project than the poll entry names; skipped until the entry is updated`;
      log(result.skipped);
      return result;
    }
    await bindRepo(deps.db, scope, { forge: "github", owner, repo: name });
  }

  // Runs of pull requests that closed or merged since the last poll stop here, before new work.
  await cancelClosedPrRuns(deps, cfg).catch((err) => {
    log(`poll ${repo}: closed-PR cancel failed: ${String(err)}`);
  });

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
  // Pushes the poller missed between two polls: GitHub ran CI for each. Opt-in, the newest few,
  // oldest first so each is its own run in push order; a force push (the last handled sha is not
  // on the head's first-parent history) has no such gap to fill.
  if (cfg.everyPush) {
    const last = await lastPolledSha(deps.db, scope, repo, cfg.workflow, "push");
    if (last !== undefined && last !== head.sha) {
      const gap = await deps.github.firstParentsSince(repo, head.sha, last, MAX_GAP_PUSHES + 1);
      if (gap?.reached) {
        const missed = gap.shas.filter((s) => s !== head.sha).slice(0, MAX_GAP_PUSHES);
        for (const sha of missed.toReversed()) {
          const info = await deps.github.commitInfo(repo, sha);
          candidates.splice(candidates.length - 1, 0, {
            event: "push",
            ref: `refs/heads/${cfg.defaultBranch}`,
            sha,
            actor: info.author,
            message: info.message,
            headBranch: cfg.defaultBranch,
            sameRepo: true,
            ...(forgeProtected === undefined ? {} : { forgeProtected }),
          });
        }
      }
    }
  }

  if (cfg.prMode === "off") {
    await clearPollMarker(deps.db, scope, {
      repo,
      workflowPath: cfg.workflow,
      ...MARKER_PR_MODE,
    });
  }
  const openPulls = (): Promise<PullRequest[]> => openPullsFor(deps, cfg, scope, now);

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
    for (const pr of await openPulls()) {
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
        pr,
        baseRef: pr.baseRef,
        ...(pr.baseSha ? { baseSha: pr.baseSha } : {}),
        sameRepo,
        allowlisted,
        ...(permission === undefined ? {} : { permission }),
      });
    }
  }

  if (cfg.prMode === "allowlist") {
    for (const pr of await openPulls()) {
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
        pr,
        baseRef: pr.baseRef,
        ...(pr.baseSha ? { baseSha: pr.baseSha } : {}),
        sameRepo: true,
        allowlisted: true,
      });
    }
  }

  if (cfg.tagRefs.length > 0) await tagCandidates(deps, cfg, scope, head.sha, candidates, result);
  if (cfg.mergeQueue) await queueCandidates(deps, cfg, scope, candidates, result);

  // The events API is read at most once a poll, and only when a push run is about to be planned.
  let eventsMemo: Promise<{ ref: string; head: string; before: string }[]> | undefined;
  const pushEvents = () => (eventsMemo ??= deps.github.pushEvents(repo));

  for (const c of candidates) {
    const what = `${c.event} ${c.sha.slice(0, 7)}`;
    // A tag run is its own thing even at the default branch's head: it is keyed by the tag.
    const seenEvent = c.tag === undefined ? c.event : `tag:${c.tag}`;
    const key = { repo, workflowPath: cfg.workflow, event: seenEvent, sha: c.sha };
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
    if (c.event === "push" && c.tag === undefined) {
      const r = await resolveBefore(deps, cfg, scope, pushEvents, c.sha);
      c.before = r.before;
      c.beforeSource = r.source;
    }
    let changedFiles: string[] | undefined;
    let changedSource: string | undefined;
    const shardPaths = (cfg.splits ?? []).some((r) => r.shards.some((sh) => sh.paths));
    if (hasPathFilter(yaml) || shardPaths) {
      if (c.event === "pull_request") {
        changedFiles = c.baseRef
          ? await deps.github.changedFiles(repo, c.baseRef, c.sha)
          : undefined;
      } else if (c.event === "push" && c.tag === undefined) {
        changedFiles =
          c.before && c.before !== c.sha && !/^0+$/.test(c.before)
            ? await deps.github.changedFiles(repo, c.before, c.sha)
            : undefined;
      }
    }
    // Shard selection also covers a merge group (against the group's base), which the workflow's
    // own path filters never see: GitHub applies none to it.
    let shardFiles = changedFiles;
    if (shardPaths && c.event === "merge_group" && c.baseSha)
      shardFiles = await deps.github.changedFiles(repo, c.baseSha, c.sha);
    if (shardFiles) {
      const from =
        c.event === "push" ? c.before : c.event === "merge_group" ? c.baseSha : c.baseRef;
      if (from) changedSource = `${c.event} ${from.slice(0, 12)}..${c.sha.slice(0, 12)}`;
    }
    const event: WorkflowEvent = {
      name: c.event,
      ref: c.ref,
      ...(c.baseRef ? { baseRef: c.baseRef } : {}),
      ...(changedFiles ? { changedFiles } : {}),
    };
    const workflowName = describeWorkflow(yaml)?.name ?? undefined;
    const scopeName = checkScopeFor(cfg.primary, cfg.workflow, workflowName);
    const githubExtra: Record<string, Value> = {
      sha: c.sha,
      ...(c.actor ? { actor: c.actor } : {}),
      ...(c.event === "pull_request" ? { head_ref: c.headBranch } : {}),
      ...(workflowName ? { workflow: workflowName } : {}),
      event: eventPayload(
        c,
        repo,
        c.event === "push" && c.tag === undefined ? c.before : undefined,
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
        vars: cfg.vars ?? {},
        ...(cfg.splits ? { splits: cfg.splits } : {}),
        ...(shardFiles ? { shardChangedFiles: shardFiles } : {}),
        ...(changedSource ? { changedSource } : {}),
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
    const tagHeld = c.tag !== undefined && c.tagProtection !== "ruleset";
    const base = decideRun({
      event: c.event,
      ref: c.ref,
      baseRef: c.baseRef,
      sameRepo: c.sameRepo,
      actor: c.actor,
      permission: c.permission,
      allowlisted: c.allowlisted,
      protectedRefs: [`refs/heads/${cfg.defaultBranch}`, ...cfg.protectedRefs],
      // The tag patterns the project opted in with are its release refs.
      ...(c.tag === undefined ? {} : { releaseRefs: cfg.tagRefs }),
      forgeProtected: c.forgeProtected,
      workflowHash: createHash("sha256").update(yaml).digest("hex"),
      now,
    });
    // A tag run records how its creation is governed. One a ruleset does not protect is created
    // HELD: it waits for approval by a release operator (sha and workflow bound) like any held run.
    const tagged =
      c.tag === undefined
        ? base
        : {
            ...base,
            reasons: [
              ...base.reasons,
              tagHeld
                ? c.tagProtection === "predates"
                  ? "a ruleset restricts creating this tag now, but the tag may have been created before it did: held for approval by a release operator"
                  : `no ruleset restricts creating this tag (${c.tagProtection ?? "none"}): held for approval by a release operator`
                : "a ruleset restricts creating this tag to admins",
            ],
            facts: {
              ...base.facts,
              tag: c.tag,
              tagProtection: c.tagProtection ?? "none",
              ...(c.taggerLabel ? { taggerLabel: c.taggerLabel } : {}),
            },
          };
    const decision =
      c.beforeSource === undefined
        ? tagged
        : { ...tagged, facts: { ...tagged.facts, beforeSource: c.beforeSource } };
    const untrusted = needsApproval(decision.class);
    const hold = untrusted || tagHeld;
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
    // A run held for any other reason (a tag no ruleset protects) is isolated the same way until a
    // release operator approves it: a run that may never start must not cancel or queue behind
    // the default branch's runs. Approval moves it into the real group (see approveRun).
    const group = wp.concurrency
      ? untrusted
        ? `untrusted:pr-${c.prNumber ?? "x"}:${wp.concurrency.group}`
        : hold
          ? `held:${c.tag ?? c.sha}:${wp.concurrency.group}`
          : wp.concurrency.group
      : undefined;
    // Untrusted code never gets open egress, whatever the repo or project allows.
    const egress = untrusted
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
      seenEvent,
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
          vars: cfg.vars ?? {},
          // What the operator's split rules did or could not do for this run.
          ...(wp.splitNotices.length > 0 ? { splitNotices: wp.splitNotices } : {}),
          // What isolation and egress policy read: the decided class, and the sandbox egress.
          trust: decision.class,
          egress,
          // Jobs whose own steps check out the PR head: the demotion rule makes them untrusted.
          ...(headCheckoutJobs.length > 0 ? { headCheckouts: headCheckoutJobs } : {}),
          ...(wp.concurrency ? { concurrency: wp.concurrency } : {}),
          // A non-primary workflow's checks are named under its own name (#549).
          ...(scopeName ? { checkScope: scopeName } : {}),
        }),
        ...(group ? { concurrencyGroup: group } : {}),
        trust: JSON.stringify(decision),
      },
    });
    if (created && c.tag !== undefined) {
      await appendAudit(deps.db, scope, {
        principalKind: "system",
        principalId: "poller",
        op: "poll_tag_run",
        effect: "write",
        outcome: tagHeld ? "held" : "release",
        input: {
          repo,
          tag: c.tag,
          sha: c.sha,
          protection: c.tagProtection ?? "none",
          held: tagHeld,
          run: created.run.id,
        },
      }).catch(() => {});
    }
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
