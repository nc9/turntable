// Trust classes and the structural taint rules (issue #37).
//
// A run's CLASS says how much it may be trusted; credentials and lint strictness follow the
// class. The demotion rule is structural: a job on a privileged trigger that is handed a
// non-protected ref, by delivery or by its own checkout step, is demoted to untrusted before it
// starts, so it can never hold credentials next to attacker-controlled code.
import { isPrivilegedEvent, matchesPatterns } from "@longshore/act-runner";

export type TrustClass = "protected" | "release" | "trusted_pr" | "untrusted_pr";

/** What the forge says a user may do in a repo (collaborator permission, `role_name`). */
export type ForgePermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** Can push to the repo: the bar for "trusted author". */
export const canWrite = (p: ForgePermission | undefined): boolean =>
  p === "admin" || p === "maintain" || p === "write";

/** A maintainer: may start a manual run that counts as protected. */
export const isMaintainer = (p: ForgePermission | undefined): boolean =>
  p === "admin" || p === "maintain";

/** Provisional defaults until protected refs are configured per project (#17). */
export const DEFAULT_PROTECTED_REFS: readonly string[] = [
  "refs/heads/main",
  "refs/heads/master",
  "refs/heads/release/**",
];
export const DEFAULT_RELEASE_REFS: readonly string[] = ["refs/tags/v*"];

export interface RunFacts {
  event: string;
  /** The ref of the commit the job works from: refs/heads/main, refs/pull/5/merge, refs/tags/v1. */
  ref: string;
  /** Base branch name, for pull request events. */
  baseRef?: string;
  /** The default branch, for events whose workflow comes from it. */
  defaultBranch?: string;
  /** The pull request comes from a fork. Unknown counts as a fork. */
  fork?: boolean;
  /** The PR author is a known trusted collaborator. Unknown counts as untrusted. */
  authorTrusted?: boolean;
  protectedRefs?: readonly string[];
  releaseRefs?: readonly string[];
  /** Permission of whoever started a manual run (`workflow_dispatch`). Unknown is no permission. */
  actorPermission?: ForgePermission;
}

const normalizeRef = (ref: string): string => (ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);

export function isProtectedRef(
  ref: string,
  patterns: readonly string[] = DEFAULT_PROTECTED_REFS,
): boolean {
  return matchesPatterns(patterns, normalizeRef(ref));
}

export function isReleaseRef(
  ref: string,
  patterns: readonly string[] = DEFAULT_RELEASE_REFS,
): boolean {
  return matchesPatterns(patterns, normalizeRef(ref));
}

/** Events a maintainer or the schedule starts; their class follows the ref. */
const REF_DRIVEN = ["push", "schedule", "release", "repository_dispatch"];

/**
 * Class from forge facts alone. Anything not positively trusted is untrusted. A push needs write
 * access, so a push to a non-protected branch is trusted but never protected.
 */
export function classifyRun(f: RunFacts): TrustClass {
  const protectedRefs = f.protectedRefs ?? DEFAULT_PROTECTED_REFS;
  const releaseRefs = f.releaseRefs ?? DEFAULT_RELEASE_REFS;
  if (f.event === "workflow_dispatch") {
    // Anyone with write access can start a manual run, so the actor decides, not the ref: only a
    // maintainer's run is protected or release. A writer's is a trusted run on that ref without
    // credentials, and anyone else's (or an unknown actor) is untrusted.
    if (isMaintainer(f.actorPermission)) {
      if (isReleaseRef(f.ref, releaseRefs)) return "release";
      if (isProtectedRef(f.ref, protectedRefs)) return "protected";
      return "trusted_pr";
    }
    return canWrite(f.actorPermission) ? "trusted_pr" : "untrusted_pr";
  }
  if (REF_DRIVEN.includes(f.event)) {
    if (isReleaseRef(f.ref, releaseRefs)) return "release";
    if (isProtectedRef(f.ref, protectedRefs)) return "protected";
    return "trusted_pr";
  }
  if (f.event === "merge_group") return "trusted_pr";
  if (f.event === "pull_request" || f.event === "pull_request_target") {
    return f.fork === false && f.authorTrusted === true ? "trusted_pr" : "untrusted_pr";
  }
  return "untrusted_pr";
}

/**
 * Where the workflow DEFINITION is read from. A privileged trigger reads it from the base, never
 * from the head it was triggered by; `pull_request` reads the PR head, like GitHub, but its
 * class never carries credentials.
 */
export function workflowSourceRef(f: RunFacts): string {
  if (isPrivilegedEvent(f.event) || f.event === "schedule") {
    return normalizeRef(f.baseRef ?? f.defaultBranch ?? "main");
  }
  return normalizeRef(f.ref);
}

export interface Assessment {
  klass: TrustClass;
  /** Set when the demotion rule lowered the class. */
  demotedFrom?: TrustClass;
  reasons: string[];
}

/**
 * The class a job actually runs as. `headCheckouts` is true when the job's own steps ask for the
 * PR head (see findHeadCheckouts). A privileged-trigger job that receives a non-protected ref,
 * either as the delivered ref or through such a step, is demoted to untrusted.
 */
export function assessJob(f: RunFacts, headCheckouts = false): Assessment {
  const base = classifyRun(f);
  const reasons: string[] = [`${f.event} on ${f.ref} is ${base}`];
  if (isPrivilegedEvent(f.event)) {
    const nonProtected =
      !isProtectedRef(f.ref, f.protectedRefs) && !isReleaseRef(f.ref, f.releaseRefs);
    if (nonProtected || headCheckouts) {
      if (nonProtected)
        reasons.push(`privileged trigger ${f.event} was handed non-protected ref ${f.ref}`);
      if (headCheckouts) reasons.push("a step checks out the pull request head");
      if (base !== "untrusted_pr") reasons.push("demoted to untrusted_pr before start");
      return {
        klass: "untrusted_pr",
        ...(base !== "untrusted_pr" ? { demotedFrom: base } : {}),
        reasons,
      };
    }
  }
  return { klass: base, reasons };
}

export interface Credentials {
  /** The job may be given secrets. */
  secrets: boolean;
  /** The job may be given a token that can write to the forge. */
  writeToken: boolean;
}

/** Untrusted and trusted PR classes never get secrets or write tokens here (#17 refines). */
export function credentialsFor(klass: TrustClass): Credentials {
  const privileged = klass === "protected" || klass === "release";
  return { secrets: privileged, writeToken: privileged };
}

/** Protected and release runs fail lint; the others only warn. */
export function lintFailsFor(klass: TrustClass): boolean {
  return klass === "protected" || klass === "release";
}

/** The facts a class decision was made from, kept on the run for audit and the UI. */
export interface TrustFacts {
  event: string;
  ref: string;
  /** Pull request head repo is the base repo. Unknown counts as a fork. */
  sameRepo?: boolean;
  /** Login of whoever opened the pull request or started the run. */
  actor?: string | null;
  /** Their forge permission as re-fetched; absent when it could not be asked. */
  permission?: ForgePermission | "unknown";
  /** True when the login is on the project's explicit trusted list. */
  allowlisted?: boolean;
  /** The ref matched the project's protected refs (or the forge says the branch is protected). */
  protectedRef?: boolean;
  forgeProtected?: boolean;
}

export interface TrustDecision {
  class: TrustClass;
  reasons: string[];
  facts: TrustFacts;
  /** sha256 of the workflow file the run was planned from; approval is bound to it. */
  workflowHash: string;
  /** Epoch ms. */
  decidedAt: number;
}

/**
 * The one place a run's class is decided at ingest, from re-fetched forge facts. Anything not
 * positively trusted is untrusted: an unknown fork status, an unknown permission, a permission
 * the token could not ask for.
 */
export function decideRun(input: {
  event: string;
  ref: string;
  baseRef?: string | undefined;
  sameRepo?: boolean | undefined;
  actor?: string | null | undefined;
  permission?: ForgePermission | "unknown" | undefined;
  allowlisted?: boolean | undefined;
  protectedRefs?: readonly string[] | undefined;
  forgeProtected?: boolean | undefined;
  workflowHash: string;
  now: number;
}): TrustDecision {
  const authorTrusted =
    input.allowlisted === true ||
    canWrite(input.permission === "unknown" ? undefined : input.permission);
  const facts: TrustFacts = {
    event: input.event,
    ref: input.ref,
    ...(input.sameRepo === undefined ? {} : { sameRepo: input.sameRepo }),
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.permission === undefined ? {} : { permission: input.permission }),
    ...(input.allowlisted === undefined ? {} : { allowlisted: input.allowlisted }),
    ...(input.forgeProtected === undefined ? {} : { forgeProtected: input.forgeProtected }),
  };
  const refs = [
    ...(input.protectedRefs ?? DEFAULT_PROTECTED_REFS),
    ...(input.forgeProtected ? [input.ref] : []),
  ];
  const run: RunFacts = {
    event: input.event,
    ref: input.ref,
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    fork: input.sameRepo !== true,
    authorTrusted,
    protectedRefs: refs,
    ...(input.permission && input.permission !== "unknown"
      ? { actorPermission: input.permission }
      : {}),
  };
  const klass = classifyRun(run);
  const reasons = [`${input.event} on ${input.ref} is ${klass}`];
  if (input.event === "pull_request" || input.event === "pull_request_target") {
    if (input.sameRepo !== true) reasons.push("the head is not in the base repo (a fork)");
    else if (input.allowlisted) reasons.push(`${input.actor ?? "author"} is on the trusted list`);
    else if (input.permission === "unknown")
      reasons.push("the author's permission could not be read, so the author is not trusted");
    else if (!canWrite(input.permission as ForgePermission | undefined))
      reasons.push(`the author has ${input.permission ?? "no known"} permission, not write`);
    else reasons.push(`the author has ${input.permission} permission`);
  }
  return {
    class: klass,
    reasons,
    facts: { ...facts, protectedRef: klass === "protected" },
    workflowHash: input.workflowHash,
    decidedAt: input.now,
  };
}

/** Runs of these classes wait for a human before any job starts. */
export const needsApproval = (klass: TrustClass): boolean => klass === "untrusted_pr";
