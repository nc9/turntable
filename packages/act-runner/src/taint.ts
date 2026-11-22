// Structural taint rules for workflow definitions. A privileged trigger (one that runs with the
// base repository's trust but is set off by outside input) must never be handed the PR head.
// These helpers find the places a workflow asks for it.

import { parse } from "yaml";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Events that run with the base repository's trust but are triggered by outside input (a fork's
 * pull request, a comment, an issue). A job on one of these must work from a protected ref.
 */
export const PRIVILEGED_EVENTS: readonly string[] = [
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "issues",
  "pull_request_review",
  "pull_request_review_comment",
  "discussion",
  "discussion_comment",
];

export const isPrivilegedEvent = (event: string): boolean => PRIVILEGED_EVENTS.includes(event);

/** Expressions that name the head of a pull request (a fork's commit, an attacker's branch). */
const HEAD_EXPR = new RegExp(
  [
    "github\\.event\\.pull_request\\.head\\.",
    "github\\.head_ref",
    "github\\.event\\.workflow_run\\.head_",
    "github\\.event\\.issue\\.pull_request",
    "refs/pull/",
  ].join("|"),
);

export interface HeadCheckout {
  step: string;
  field: "ref" | "repository";
  expression: string;
}

/**
 * Steps that check out, or are pointed at, the PR head: any step whose `with.ref` or
 * `with.repository` names it (the usual `actions/checkout` pwn-request shape).
 */
export function findHeadCheckouts(steps: readonly unknown[]): HeadCheckout[] {
  const out: HeadCheckout[] = [];
  for (const [i, s] of steps.entries()) {
    if (!isObj(s) || !isObj(s.with)) continue;
    const step = typeof s.name === "string" ? s.name : `step ${i + 1}`;
    for (const field of ["ref", "repository"] as const) {
      const v = s.with[field];
      if (typeof v === "string" && HEAD_EXPR.test(v))
        out.push({ step, field, expression: v.trim() });
    }
  }
  return out;
}

/** Head checkouts per job id, for a whole workflow file. */
export function workflowHeadCheckouts(yaml: string): Record<string, HeadCheckout[]> {
  const doc: unknown = parse(yaml, { merge: true });
  const jobs = isObj(doc) && isObj(doc.jobs) ? doc.jobs : {};
  const out: Record<string, HeadCheckout[]> = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (isObj(job) && Array.isArray(job.steps)) out[id] = findHeadCheckouts(job.steps);
  }
  return out;
}
