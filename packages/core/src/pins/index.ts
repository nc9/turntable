// Action resolution policy for a project: remembered tag-to-sha pins, moved-tag detection,
// `require_sha_pins` and the org allowlist of action owners. Wraps the plain resolver so every
// path that plans a job (the CLI, the scheduler) applies the same rules.
import {
  PlanError,
  expandNestedActions,
  githubResolver,
  resolveActions,
  type ActionFetcher,
  type ActionRefResolver,
  type JobPlan,
  type PlannedAction,
} from "@longshore/act-runner";
import type { Db } from "../db";
import { getActionPolicy, observePin, type ActionPolicy, type Scope } from "../db/repos";
import { githubReachability, impostorError, type ReachabilityChecker } from "./reachability";

/**
 * How much a run is trusted, for pin policy. Protected and release runs fail on a moved tag;
 * PR classes warn and keep the old pinned sha. The full classification arrives with the trust
 * classes (#17); until then a push is protected and everything else is a PR class.
 */
export type PinClass = "protected" | "release" | "trusted_pr" | "untrusted_pr";

const BLOCKING: readonly PinClass[] = ["protected", "release"];

/** Provisional mapping of a run's event to a class (see PinClass). */
export function pinClassForEvent(event: string): PinClass {
  return event === "pull_request" || event === "pull_request_target" ? "untrusted_pr" : "protected";
}

const SHA = /^[0-9a-f]{40}$/;

/** A tag moved and the run may not use the new commit until an operator accepts it. */
export class MovedTagError extends PlanError {
  readonly repo: string;
  readonly ref: string;
  readonly pinned: string;
  readonly observed: string;
  constructor(repo: string, ref: string, pinned: string, observed: string) {
    super(
      "moved-tag",
      `${repo}@${ref} moved: pinned ${pinned}, now ${observed}. A protected or release run will not use it until an operator accepts the move (accept_action_move).`,
    );
    this.name = "MovedTagError";
    this.repo = repo;
    this.ref = ref;
    this.pinned = pinned;
    this.observed = observed;
  }
}

/** Refuses what the project's policy forbids, before anything is resolved or fetched. */
export function checkActionOwner(a: { uses: string; repo: string }, policy: ActionPolicy): void {
  const owner = a.repo.split("/")[0]?.toLowerCase() ?? "";
  if (policy.allowedOwners !== null && !policy.allowedOwners.includes(owner)) {
    throw new PlanError(
      "action-owner",
      `${a.uses} is from "${owner}", which is not in the org's allowed action owners (${policy.allowedOwners.join(", ") || "none"})`,
    );
  }
}

export function enforceActionPolicy(plan: JobPlan, policy: ActionPolicy): void {
  for (const a of plan.actions) {
    checkActionOwner(a, policy);
    if (policy.requireShaPins && !SHA.test(a.ref)) {
      throw new PlanError(
        "require-sha-pins",
        `${a.uses} is not pinned to a full commit sha, and this project requires sha pins`,
      );
    }
  }
}

export interface PinResolverOptions {
  db: Db;
  /** Needs a project. */
  scope: Required<Scope>;
  base: ActionRefResolver;
  klass: PinClass;
  /** Called for a moved tag that a non-blocking class will run with its OLD pinned sha. */
  warn?: (message: string) => void;
}

/** A resolver that remembers every resolution and detects moved tags. */
export function createPinningResolver(o: PinResolverOptions): ActionRefResolver {
  return async (owner, repo, ref) => {
    const sha = await o.base(owner, repo, ref);
    const full = `${owner}/${repo}`;
    const obs = await observePin(o.db, o.scope, { repo: full, ref, sha });
    if (obs.status !== "moved") return sha;
    if (BLOCKING.includes(o.klass)) throw new MovedTagError(full, ref, obs.pinned, obs.observed);
    o.warn?.(
      `${full}@${ref} moved (pinned ${obs.pinned}, now ${obs.observed}); this ${o.klass} run uses the pinned commit`,
    );
    return obs.pinned;
  };
}

export interface ResolvePlanOptions {
  db: Db;
  scope: Required<Scope>;
  klass: PinClass;
  base?: ActionRefResolver;
  warn?: (message: string) => void;
  /** Verifies a sha belongs to the named repo (default: the GitHub compare and tags APIs). */
  reachable?: ReachabilityChecker;
  /** Fetches action tarballs by sha, to read nested actions (default: codeload). */
  fetchTarball?: ActionFetcher;
}

/**
 * Applies the project's action policy, then pins every action of the plan and everything those
 * actions pull in:
 *  - the user's own `uses:` pass the allowlist and `require_sha_pins` first;
 *  - tags are resolved through the pin store (moved tags);
 *  - every sha, given or resolved, must be reachable from a branch or tag of its own repo
 *    (impostor commits from forks are refused);
 *  - each remote action is read at its sha, and the actions inside a composite go through the
 *    same resolution, allowlist and reachability, recursively, so act never fetches by tag.
 * Nested actions are not subject to `require_sha_pins`: the project does not write them, Longshore
 * pins them.
 */
export async function resolvePlanActions(plan: JobPlan, o: ResolvePlanOptions): Promise<JobPlan> {
  const policy = await getActionPolicy(o.db, o.scope);
  enforceActionPolicy(plan, policy);
  const resolve = createPinningResolver({
    db: o.db,
    scope: o.scope,
    base: o.base ?? githubResolver(),
    klass: o.klass,
    ...(o.warn ? { warn: o.warn } : {}),
  });
  // LONGSHORE_GITHUB_TOKEN (read-only is enough) lifts the unauthenticated API rate limit.
  const token = process.env.LONGSHORE_GITHUB_TOKEN?.trim();
  const reachable = o.reachable ?? githubReachability(token ? { token } : {});
  const verify = async (a: PlannedAction): Promise<void> => {
    if (a.kind !== "remote" || !a.sha) return;
    const [owner = "", repo = ""] = a.repo.split("/");
    if (!(await reachable(owner, repo, a.sha))) throw impostorError(a.repo, a.sha);
  };

  const resolved = await resolveActions(plan, resolve);
  for (const a of resolved.actions) await verify(a);
  return expandNestedActions(resolved, {
    resolve,
    ...(o.fetchTarball ? { fetchTarball: o.fetchTarball } : {}),
    check: async (a) => {
      checkActionOwner(a, policy);
      await verify(a);
    },
  });
}
