import type { ActivityRun, JobState } from "@/api/types";

/** How often the feed refetches: slowly when the tab is hidden, and always again on focus. */
export const POLL_VISIBLE_MS = 30_000;
export const POLL_HIDDEN_MS = 120_000;
export const pollDelay = (hidden: boolean): number => (hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);

/** The state to draw: the conclusion once a run is completed, else the in-progress state. */
export const stateOf = (r: Pick<ActivityRun, "state" | "conclusion">): JobState =>
  r.state === "completed" ? (r.conclusion ?? "success") : r.state;

/**
 * Folds a freshly fetched first page into what is already shown: the fresh rows win (and lead),
 * and rows loaded from older pages stay below them, de-duplicated. Newest first by run id.
 */
export function mergeFirstPage(
  shown: readonly ActivityRun[],
  fresh: readonly ActivityRun[],
): ActivityRun[] {
  const seen = new Set(fresh.map((r) => r.runId));
  const oldest = fresh.at(-1)?.runId;
  const older = shown.filter(
    (r) => !seen.has(r.runId) && (oldest === undefined || r.runId < oldest),
  );
  return [...fresh, ...older];
}

export const runPath = (r: Pick<ActivityRun, "org" | "project" | "runId">): string =>
  `/${encodeURIComponent(r.org)}/${encodeURIComponent(r.project)}/runs/${encodeURIComponent(r.runId)}`;

export type FeedSearch = {
  org?: string | undefined;
  project?: string | undefined;
  status?: "running" | "failed" | undefined;
};

/**
 * The feed's filters from a URL's search. Anything that is not a plausible slug or a known status
 * is dropped (the router merges its parent's raw search over a route's own, so the route's check
 * alone does not keep junk out of what the page reads).
 */
export function parseFeedSearch(s: Record<string, unknown>): FeedSearch {
  const out: FeedSearch = {};
  const slug = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
  if (slug(s.org)) out.org = s.org;
  if (slug(s.project)) out.project = s.project;
  if (s.status === "running" || s.status === "failed") out.status = s.status;
  return out;
}
