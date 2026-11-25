import { Link, useNavigate } from "@tanstack/react-router";
import { GitBranch, GitCommitHorizontal, Tag } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "@/api";
import type { ActivityRun, ActivityStatus } from "@/api/types";
import { Avatar, OrgAvatar, ProjectAvatar } from "@/components/avatar";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Duration } from "@/components/live-clock";
import { StateIcon } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { mergeFirstPage, pollDelay, runPath, stateOf } from "@/lib/activity";
import { learnAvatars } from "@/lib/avatar";
import { formatRelative, shortSha } from "@/lib/format";
import { STATE_META } from "@/lib/states";
import { cn } from "@/lib/utils";

export type FeedFilter = {
  org?: string | undefined;
  project?: string | undefined;
  status: ActivityStatus;
};

const PAGE = 30;
/** Never refetch more often than this, however many focus events arrive. */
const MIN_GAP_MS = 2_000;

/**
 * The feed's data: the first page now, again every 30 s while the tab is visible (120 s hidden)
 * and whenever it regains focus, plus further pages on demand. Web sessions cannot open the
 * realtime socket, so this polls.
 */
export function useActivityFeed(filter: FeedFilter) {
  const key = `${filter.org ?? ""}|${filter.project ?? ""}|${filter.status}`;
  const [rows, setRows] = useState<ActivityRun[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const last = useRef(0);
  /** True once a deeper page was loaded: a refresh then must not rewind the cursor. */
  const deep = useRef(false);
  const keyRef = useRef(key);
  keyRef.current = key;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const fetchFirst = useCallback(async () => {
    const started = key;
    last.current = Date.now();
    try {
      const page = await getBackend().api.myActivityFeed({ ...filterRef.current, limit: PAGE });
      if (keyRef.current !== started) return;
      learnAvatars(page.runs);
      setRows((prev) => (prev === null ? page.runs : mergeFirstPage(prev, page.runs)));
      // Only the first load sets the cursor: a refresh must not rewind a deeper one.
      if (!deep.current) setCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      if (keyRef.current === started) setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [key]);

  // A new filter starts over.
  useEffect(() => {
    deep.current = false;
    setRows(null);
    setCursor(null);
    setError(null);
    void fetchFirst();
  }, [fetchFirst]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          void fetchFirst();
          schedule();
        },
        pollDelay(document.visibilityState === "hidden"),
      );
    };
    schedule();
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - last.current < MIN_GAP_MS) return;
      void fetchFirst();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [fetchFirst]);

  const loadMore = useCallback(async () => {
    if (!cursor || more) return;
    const started = keyRef.current;
    setMore(true);
    try {
      const page = await getBackend().api.myActivityFeed({
        ...filterRef.current,
        limit: PAGE,
        cursor,
      });
      if (keyRef.current !== started) return;
      learnAvatars(page.runs);
      setRows((prev) => {
        const have = new Set((prev ?? []).map((r) => r.runId));
        return [...(prev ?? []), ...page.runs.filter((r) => !have.has(r.runId))];
      });
      deep.current = true;
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setMore(false);
    }
  }, [cursor, more]);

  return { rows, error, hasMore: cursor !== null, loadMore, loadingMore: more };
}

const STATUS_TABS: { value: ActivityStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
];

function RefCell({ run }: { run: ActivityRun }) {
  const Icon = run.refType === "tag" ? Tag : GitBranch;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-dim">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{run.ref}</span>
    </span>
  );
}

/**
 * Every string in a row (workflow, ref, commit message, actor) comes from the forge. They are
 * rendered only as React text children: no HTML, no markdown, no attributes built from them.
 */
export function FeedRow({ run }: { run: ActivityRun }) {
  const navigate = useNavigate();
  const state = stateOf(run);
  const label = STATE_META[state].label;
  return (
    <tr
      data-run-row={run.runId}
      className="cursor-pointer border-b border-line last:border-b-0 hover:bg-subtle"
      onClick={(e) => {
        // A click on the link itself is handled by the router.
        if ((e.target as HTMLElement).closest("a")) return;
        void navigate({ to: runPath(run) });
      }}
    >
      <td className="w-8 py-2.5 pl-4 pr-2">
        <StateIcon state={state} />
      </td>
      <td className="max-w-0 py-2.5 pr-3">
        <div className="flex min-w-0 flex-col">
          <Link
            to="/$org/$project/runs/$runId"
            params={{ org: run.org, project: run.project, runId: run.runId }}
            className="truncate font-medium hover:underline"
            aria-label={`${run.workflow}, ${label}`}
          >
            {run.workflow}
          </Link>
          {run.commitMessage ? (
            <span className="truncate text-xs text-dim">{run.commitMessage}</span>
          ) : null}
        </div>
      </td>
      <td className="hidden py-2.5 pr-3 md:table-cell">
        <span className="inline-flex items-center gap-1.5">
          <OrgAvatar slug={run.org} name={run.orgName} className="size-4" />
          <span className="truncate">{run.org}</span>
          <span className="text-faint" aria-hidden="true">
            /
          </span>
          <ProjectAvatar
            org={run.org}
            slug={run.project}
            name={run.projectName}
            className="size-4"
          />
          <span className="truncate">{run.project}</span>
        </span>
      </td>
      <td className="hidden max-w-[12rem] py-2.5 pr-3 lg:table-cell">
        <RefCell run={run} />
      </td>
      <td className="hidden py-2.5 pr-3 sm:table-cell">
        <span className="inline-flex items-center gap-1 font-mono text-xs text-dim">
          <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
          {shortSha(run.sha)}
        </span>
      </td>
      <td className="hidden py-2.5 pr-3 xl:table-cell">
        <span className="text-xs text-dim">{run.event}</span>
      </td>
      <td className="hidden py-2.5 pr-3 lg:table-cell">
        {run.actor ? (
          <span className="inline-flex items-center gap-1.5">
            <Avatar src={run.actorAvatarUrl} name={run.actor} className="size-5" />
            <span className="truncate text-xs">{run.actor}</span>
          </span>
        ) : (
          <span className="text-faint">-</span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right text-xs text-dim">
        <Duration startedAt={run.startedAt} finishedAt={run.finishedAt} />
      </td>
      <td
        className="py-2.5 pr-4 text-right text-xs text-dim"
        title={new Date(run.createdAt).toISOString()}
      >
        {formatRelative(run.createdAt)}
      </td>
    </tr>
  );
}

export function FeedTable({ rows }: { rows: ActivityRun[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <table className="w-full table-fixed text-[13px]">
        <caption className="sr-only">Recent runs across your organizations</caption>
        <thead className="sr-only">
          <tr>
            <th>Status</th>
            <th>Workflow</th>
            <th>Org and project</th>
            <th>Ref</th>
            <th>Commit</th>
            <th>Event</th>
            <th>Actor</th>
            <th>Duration</th>
            <th>Age</th>
          </tr>
        </thead>
        <colgroup>
          <col className="w-10" />
          <col />
          <col className="hidden md:table-column md:w-56" />
          <col className="hidden lg:table-column lg:w-44" />
          <col className="hidden sm:table-column sm:w-24" />
          <col className="hidden xl:table-column xl:w-28" />
          <col className="hidden lg:table-column lg:w-36" />
          <col className="w-20" />
          <col className="w-24" />
        </colgroup>
        <tbody>
          {rows.map((r) => (
            <FeedRow key={r.runId} run={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Home: the feed across every org the person belongs to. */
export function ActivityFeed({
  filter,
  onFilter,
  orgs,
  projects,
  action,
}: {
  action?: React.ReactNode;
  filter: FeedFilter;
  onFilter: (next: FeedFilter) => void;
  orgs: { slug: string; name: string }[];
  /** Projects of the selected org, for the project filter; empty when no org is selected. */
  projects: { slug: string; name: string }[];
}) {
  const { rows, error, hasMore, loadMore, loadingMore } = useActivityFeed(filter);
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold tracking-tight">Activity</h1>
        {action}
        <div role="group" aria-label="Status" className="flex items-center gap-1">
          {STATUS_TABS.map((t) => (
            <Button
              key={t.value}
              size="sm"
              variant="secondary"
              aria-pressed={filter.status === t.value}
              className={cn(filter.status === t.value && "border-accent text-foreground")}
              onClick={() => onFilter({ ...filter, status: t.value })}
            >
              {t.label}
            </Button>
          ))}
        </div>
        {projects.length > 0 ? (
          <label className="ml-auto flex items-center gap-2 text-xs text-dim">
            Project
            <select
              className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-foreground"
              value={filter.project ?? ""}
              onChange={(e) => onFilter({ ...filter, project: e.target.value || undefined })}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {orgs.length > 1 ? (
          <label
            className={cn(
              "flex items-center gap-2 text-xs text-dim",
              projects.length === 0 && "ml-auto",
            )}
          >
            Org
            <select
              className="h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-foreground"
              value={filter.org ?? ""}
              onChange={(e) =>
                onFilter({ ...filter, org: e.target.value || undefined, project: undefined })
              }
            >
              <option value="">All orgs</option>
              {orgs.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {error && rows === null ? (
        <ErrorState title="Could not load activity" message={error} />
      ) : rows === null ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={filter.status === "all" ? "No runs yet" : "Nothing matches"}>
          {filter.status === "all"
            ? "Runs from every organization you belong to show up here."
            : "No runs match this filter right now. This list refreshes by itself."}
        </EmptyState>
      ) : (
        <>
          <FeedTable rows={rows} />
          {error ? <p className="text-xs text-st-failure">{error}</p> : null}
          {hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
