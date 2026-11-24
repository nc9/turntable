// `workflow_dispatch`: a person (or token) with the project role asks for one workflow to run at
// one ref with inputs. Everything the run trusts is decided here, from the forge and the stored
// project config, never from the caller:
//  - the ref (a branch or tag, never a bare sha, as on GitHub) is resolved to a commit sha NOW,
//    in this repository only (a fork's branch and an unknown name are refused), and the run is
//    for exactly that sha;
//  - all forge round trips and validation come first and write nothing; the run, its jobs and
//    the dedupe marker are then written in ONE transaction (createPolledRun), so a failure
//    leaves nothing behind;
//  - the workflow is read at that sha and must declare `on.workflow_dispatch`; the inputs are
//    validated against its declaration;
//  - the class comes from `decideRun`, the same decision every run gets: the default branch (and
//    the project's protected refs) is protected, any other branch is trusted_pr, a tag matching
//    the project's release patterns is a release. A release run is always HELD for approval (the
//    sha and workflow bound approval a tag push needs when no ruleset protects the tag): a
//    dispatch never skips an approval a push or tag would need.
import {
  githubContext,
  planWorkflow,
  workflowHeadCheckouts,
  type Value,
} from "@turntable/act-runner";
import { createHash, randomUUID } from "node:crypto";
import {
  countPolledSince,
  countWaitingRuns,
  createPolledRun,
  getProjectEgress,
  type PolledJob,
  type Scope,
  type Superseded,
  validateJobGraph,
} from "../db/repos";
import { assertRepoRelative } from "../run/safe-read";
import { decideRun, needsApproval, type TrustClass } from "../trust";
import type { PollRepoConfig } from "./config";
import { validateDispatchInputs } from "./dispatch-inputs";
import { describeWorkflow, fetchLocalActions, type IngestDeps } from "./ingest";

export type DispatchErrorCode =
  "invalid_input" | "not_found" | "conflict" | "rate_limited" | "unavailable";

/** A refusal with its reason; nothing was created. */
export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  constructor(code: DispatchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type DispatchRequest = {
  /** Path under `.github/workflows/`. */
  workflow: string;
  /** A branch or tag name, or its full ref (refs/heads/..., refs/tags/...). */
  ref: string;
  inputs: Record<string, string>;
  /** Who dispatched: stored as the run's actor and in the trust facts. */
  actor: string;
  /** The project role that allowed it, recorded in the trust reasons. */
  role: string;
};

export type DispatchResult = {
  runId: string;
  sha: string;
  /** The full ref the run is for. */
  ref: string;
  trustClass: TrustClass;
  /** True when the run waits for approval before any job starts. */
  held: boolean;
  /** Names of the inputs the run got (declared ones, defaults included). */
  inputNames: string[];
  /** Attempts of older runs this one took over (cancel-in-progress) whose sandboxes must stop. */
  superseded: Superseded["running"];
};

/** What the server hands the `run_dispatch` op: the poller's dispatch, for the project's repo. */
export type RunDispatcher = (
  scope: Required<Scope>,
  repo: string | undefined,
  req: DispatchRequest,
) => Promise<DispatchResult & { repo: string }>;

export const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * A ref to a commit of this repository: `{ ref, sha }`, the ref in full. A branch or a tag ONLY,
 * as on GitHub: a bare commit sha is refused. A name that is both a branch and a tag is refused
 * as ambiguous, so the caller says which.
 */
export async function resolveDispatchRef(
  deps: IngestDeps,
  cfg: PollRepoConfig,
  input: string,
): Promise<{ ref: string; sha: string; kind: "branch" | "tag" }> {
  const repo = cfg.repo;
  const text = input.trim();
  const notARef = () =>
    new DispatchError(
      "invalid_input",
      `ref must be a branch or tag of ${repo}; a bare commit sha is not accepted (as on GitHub)`,
    );
  if (FULL_SHA.test(text)) throw notARef();
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(text) || text.includes("..") || text.endsWith("/")) {
    throw notARef();
  }
  const wantHeads = text.startsWith("refs/heads/");
  const wantTags = text.startsWith("refs/tags/");
  if (text.startsWith("refs/") && !wantHeads && !wantTags) {
    throw notARef();
  }
  const name = wantHeads
    ? text.slice("refs/heads/".length)
    : wantTags
      ? text.slice("refs/tags/".length)
      : text;
  const branch = wantTags ? undefined : await deps.github.refObject(repo, "heads", name);
  const tag = wantHeads ? undefined : await deps.github.refObject(repo, "tags", name);
  if (branch && tag) {
    throw new DispatchError(
      "invalid_input",
      `${name} is both a branch and a tag of ${repo}; give refs/heads/${name} or refs/tags/${name}`,
    );
  }
  if (branch) return { ref: `refs/heads/${name}`, sha: branch.sha, kind: "branch" };
  if (tag) {
    let sha = tag.sha;
    if (tag.type === "tag") {
      const peeled = await deps.github.peelTag(repo, tag.sha);
      if (!peeled)
        throw new DispatchError("invalid_input", `tag ${name} does not point at a commit`);
      sha = peeled.sha;
    }
    return { ref: `refs/tags/${name}`, sha, kind: "tag" };
  }
  throw notARef();
}

/**
 * Creates the run for one dispatch, or throws a DispatchError. `scope` is the project the repo's
 * binding belongs to (the caller checked); the run lands there.
 */
export async function dispatchWorkflow(
  deps: IngestDeps,
  cfg: PollRepoConfig,
  scope: Required<Scope>,
  req: DispatchRequest,
): Promise<DispatchResult> {
  const now = (deps.now ?? Date.now)();
  const repo = cfg.repo;
  if (!WORKFLOW_PATH.test(req.workflow)) {
    throw new DispatchError(
      "invalid_input",
      "workflow must be a .yml or .yaml file directly under .github/workflows/",
    );
  }
  const target = await resolveDispatchRef(deps, cfg, req.ref);
  const yaml = await deps.github.fileAt(repo, req.workflow, target.sha);
  if (yaml === undefined) {
    throw new DispatchError(
      "not_found",
      `${req.workflow} does not exist at ${target.sha.slice(0, 12)}`,
    );
  }
  const parsed = validateDispatchInputs(yaml, req.inputs);
  if (!parsed.ok) throw new DispatchError("invalid_input", parsed.reason);

  const isTag = target.kind === "tag";
  const event = { name: "workflow_dispatch", ref: target.ref };
  const workflowName = describeWorkflow(yaml)?.name ?? undefined;
  const githubExtra: Record<string, Value> = {
    sha: target.sha,
    actor: req.actor,
    ...(workflowName ? { workflow: workflowName } : {}),
    event: {
      inputs: parsed.strings,
      ref: target.ref,
      repository: { full_name: repo },
    },
  };
  let wp;
  try {
    const localFiles = /uses:\s*['"]?\.\.?\//.test(yaml)
      ? await fetchLocalActions(deps.github, repo, target.sha, yaml)
      : new Map<string, string>();
    wp = planWorkflow(yaml, event, {
      readFile: (p) => {
        assertRepoRelative(p);
        return localFiles.get(p);
      },
      github: githubExtra,
      vars: cfg.vars ?? {},
      inputs: parsed.typed,
      ...(cfg.splits ? { splits: cfg.splits } : {}),
    });
  } catch (err) {
    throw new DispatchError(
      "invalid_input",
      `plan rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!wp.trigger.matched) {
    throw new DispatchError("invalid_input", `not triggered: ${wp.trigger.reason}`);
  }
  if (wp.jobs.length === 0) throw new DispatchError("invalid_input", "workflow has no jobs");
  const jobs: PolledJob[] = wp.jobs.map((n) => ({
    key: n.key,
    name: n.name,
    needs: n.needs,
    ...(n.matrix ? { matrix: n.matrix } : {}),
    planned: n,
  }));
  const invalid = validateJobGraph(jobs);
  if (invalid) throw new DispatchError("invalid_input", invalid);

  // The class: the same decision as any run. The caller's project role is what authorised the
  // dispatch, so it stands in for a maintainer's forge permission; the reason says so.
  const base = decideRun({
    event: "workflow_dispatch",
    ref: target.ref,
    sameRepo: true,
    actor: req.actor,
    permission: "maintain",
    protectedRefs: [`refs/heads/${cfg.defaultBranch}`, ...cfg.protectedRefs],
    // Only tags the project opted in as release refs are releases.
    ...(isTag ? { releaseRefs: cfg.tagRefs } : {}),
    workflowHash: createHash("sha256").update(yaml).digest("hex"),
    now,
  });
  const release = base.class === "release";
  const decision = {
    ...base,
    reasons: [
      ...base.reasons,
      `dispatched by ${req.actor} with project role ${req.role}`,
      ...(release
        ? [
            "a release ref: held for approval by a release operator, as a tag push no ruleset protects is",
          ]
        : []),
    ],
    facts: { ...base.facts, ...(isTag ? { tag: target.ref.slice("refs/tags/".length) } : {}) },
  };
  const hold = release || needsApproval(decision.class);

  const scopeOnly = { orgId: scope.orgId, projectId: scope.projectId };
  if (hold) {
    if ((await countWaitingRuns(deps.db, scopeOnly, repo)) >= cfg.maxWaitingRuns) {
      throw new DispatchError("rate_limited", "too many runs are waiting for approval");
    }
  } else if (
    (await countPolledSince(deps.db, scopeOnly, repo, now - 3_600_000)) >= cfg.maxRunsPerHour
  ) {
    throw new DispatchError("rate_limited", "hourly run cap reached");
  }

  // A workflow picks its own concurrency group. Only a protected run uses it as written: any
  // other dispatch gets a group of its own ref, so it can never cancel or block the default branch.
  const group = wp.concurrency
    ? decision.class === "protected" && !hold
      ? wp.concurrency.group
      : `dispatch:${target.ref}:${wp.concurrency.group}`
    : undefined;
  const egress = needsApproval(decision.class)
    ? cfg.untrustedEgress
    : (cfg.egress ?? (await getProjectEgress(deps.db, scopeOnly)));
  const headCheckoutJobs = Object.entries(workflowHeadCheckouts(yaml))
    .filter(([, v]) => v.length > 0)
    .map(([k]) => k);
  const created = await createPolledRun(deps.db, scopeOnly, {
    repo,
    provider: deps.provider,
    now,
    jobs,
    hold,
    // Every dispatch is its own run: the dedupe marker is unique to it.
    seenEvent: `dispatch:${randomUUID()}`,
    cancelInProgress: wp.concurrency?.cancelInProgress ?? false,
    run: {
      workflowPath: req.workflow,
      event: "workflow_dispatch",
      ref: target.ref,
      sha: target.sha,
      workflowName: workflowName ?? wp.name ?? undefined,
      actor: req.actor,
      headBranch: target.ref.replace(/^refs\/(heads|tags)\//, ""),
      plan: JSON.stringify({
        env: wp.env,
        github: githubContext(event, githubExtra),
        vars: cfg.vars ?? {},
        // The typed `inputs` context; `github.event.inputs` (strings) is in `github.event`.
        inputs: parsed.typed,
        ...(wp.splitNotices.length > 0 ? { splitNotices: wp.splitNotices } : {}),
        trust: decision.class,
        egress,
        ...(headCheckoutJobs.length > 0 ? { headCheckouts: headCheckoutJobs } : {}),
        ...(wp.concurrency ? { concurrency: wp.concurrency } : {}),
      }),
      ...(group ? { concurrencyGroup: group } : {}),
      trust: JSON.stringify(decision),
    },
  });
  if (!created) throw new DispatchError("conflict", "the run could not be created");
  return {
    runId: created.run.id,
    sha: target.sha,
    ref: target.ref,
    trustClass: decision.class,
    held: hold,
    inputNames: Object.keys(parsed.strings),
    superseded: created.superseded.running,
  };
}
