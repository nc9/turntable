import { eq, useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Filter, GitBranch, PlayCircle, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { StateIcon } from "@/components/state-badge";
import { Duration } from "@/components/live-clock";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { JobState, Run } from "@/api/types";
import { runsCollection } from "@/db/collections";
import { useProjectSync } from "@/db/sync";
import { useScope } from "@/features/shell/scope";
import { branchFromRef, formatRelative } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { STATE_META } from "@/lib/states";
import { cn } from "@/lib/utils";
import type { RunsSearch } from "@/router";
import { RefChip, RunLink, ShaChip } from "./common";

const EVENTS = ["push", "pull_request", "workflow_dispatch"];
const FILTER_STATES: JobState[] = [
  "running",
  "queued",
  "failure",
  "infra_error",
  "awaiting_approval",
  "success",
  "cancelled",
  "skipped",
];

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string; icon?: React.ReactNode }[];
  onChange: (v: string | undefined) => void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className={cn(value && "border-accent text-foreground")}
          aria-label={`Filter by ${label}`}
        >
          {current?.icon}
          {current ? current.label : label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={value ?? "__all"}
          onValueChange={(v) => onChange(v === "__all" ? undefined : v)}
        >
          <DropdownMenuRadioItem value="__all">Any {label.toLowerCase()}</DropdownMenuRadioItem>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.icon}
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunRowItem({
  run,
  orgSlug,
  projectSlug,
  fresh,
}: {
  run: Run;
  orgSlug: string;
  projectSlug: string;
  fresh: boolean;
}) {
  const pending = run.id.startsWith("pending_");
  const meta = STATE_META[run.status];
  const rowBody = (
    <>
      <StateIcon state={run.status} className="mt-0.5 size-[18px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{run.commitMessage}</span>
          {pending ? <span className="shrink-0 text-xs text-faint">Starting</span> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dim">
          <span>{run.workflowName}</span>
          <RefChip run={run} className="max-w-48" />
          <ShaChip sha={run.sha} />
          <span>{run.event.replace("_", " ")}</span>
          {run.actor ? <span>{run.actor}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-dim">
        <Duration
          startedAt={run.startedAt ?? (run.status === "queued" ? null : run.createdAt)}
          finishedAt={run.finishedAt}
          className="text-foreground"
        />
        <span className="tabular">{formatRelative(run.createdAt)}</span>
      </div>
    </>
  );
  const cls = cn(
    "flex items-start gap-3 border-b border-line px-4 py-3 transition-colors duration-150 hover:bg-subtle focus-visible:-outline-offset-2 sm:px-5",
    fresh && "flash",
  );
  if (pending)
    return (
      <div className={cls} aria-label={`${meta.label}: ${run.commitMessage}`}>
        {rowBody}
      </div>
    );
  return (
    <RunLink
      orgSlug={orgSlug}
      projectSlug={projectSlug}
      runId={run.id}
      className={cls}
      data-run-row=""
    >
      {rowBody}
    </RunLink>
  );
}

export function RunsPage() {
  const scope = useScope();
  const search = useSearch({ strict: false }) as RunsSearch;
  const navigate = useNavigate();
  const sync = useProjectSync(scope.project?.id ?? null);
  const projectId = scope.project?.id ?? "";
  const { data } = useLiveQuery(
    (q) =>
      q
        .from({ run: runsCollection })
        .where(({ run }) => eq(run.projectId, projectId))
        .orderBy(({ run }) => run.createdAt, "desc"),
    [projectId],
  );
  const [branchText, setBranchText] = useState(search.branch ?? "");
  const branch = useDeferredValue(branchText);
  const listRef = useRef<HTMLDivElement>(null);

  // Rows that arrived after first paint get a brief highlight so live changes are noticeable.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data || sync.loading) return;
    if (seen.current === null) {
      seen.current = new Set(data.map((r) => r.id));
      return;
    }
    const added = data.filter((r) => !seen.current!.has(r.id)).map((r) => r.id);
    if (added.length > 0) {
      for (const id of added) seen.current.add(id);
      setFresh(new Set(added));
      const t = setTimeout(() => setFresh(new Set()), 1200);
      return () => clearTimeout(t);
    }
  }, [data, sync.loading]);

  const setSearch = (patch: Partial<RunsSearch>) => {
    if (!scope.orgSlug || !scope.projectSlug) return;
    const next: RunsSearch = { ...search, ...patch };
    for (const k of Object.keys(next) as (keyof RunsSearch)[])
      if (next[k] === undefined || next[k] === "") delete next[k];
    void navigate({
      to: "/$org/$project",
      params: { org: scope.orgSlug, project: scope.projectSlug },
      search: next,
      replace: true,
    });
  };

  // Keep the URL in step with the branch box, without a navigation per keystroke.
  useEffect(() => {
    if ((search.branch ?? "") !== branch) setSearch({ branch: branch || undefined });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

  const filtered = useMemo(
    () =>
      (data ?? []).filter(
        (r) =>
          (!search.status || r.status === search.status) &&
          (!search.event || r.event === search.event) &&
          (!search.branch ||
            branchFromRef(r.ref).toLowerCase().includes(search.branch.toLowerCase())),
      ),
    [data, search.status, search.event, search.branch],
  );

  const hotkeys = useMemo(() => {
    const move = (d: 1 | -1) => () => {
      const rows = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>("[data-run-row]") ?? [],
      );
      if (rows.length === 0) return;
      const i = rows.findIndex((r) => r === document.activeElement);
      rows[
        Math.min(rows.length - 1, Math.max(0, i === -1 ? (d === 1 ? 0 : rows.length - 1) : i + d))
      ]?.focus();
    };
    return { j: move(1), k: move(-1) };
  }, []);
  useHotkeys(hotkeys);

  if (scope.orgs && scope.org === null)
    return (
      <EmptyState title="Organization not found">
        Check the address or switch org from the header.
      </EmptyState>
    );
  if (scope.projects && scope.project === null)
    return (
      <EmptyState title="Project not found">
        It may have been renamed. Pick one from the sidebar.
      </EmptyState>
    );

  const filtersOn = Boolean(search.status || search.event || search.branch);
  const active = (data ?? []).filter((r) => r.status === "running" || r.status === "queued").length;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="flex flex-col gap-3 px-4 pb-3 pt-6 sm:px-5">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">Runs</h1>
            <p className="mt-0.5 text-sm text-dim">
              {scope.project ? scope.project.repo : " "}
              {active > 0 ? <span className="ml-3 text-st-running">{active} active</span> : null}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter runs">
          <FilterMenu
            label="Status"
            value={search.status}
            onChange={(v) => setSearch({ status: v as JobState | undefined })}
            options={FILTER_STATES.map((s) => ({
              value: s,
              label: STATE_META[s].label,
              icon: <StateIcon state={s} />,
            }))}
          />
          <FilterMenu
            label="Event"
            value={search.event}
            onChange={(v) => setSearch({ event: v })}
            options={EVENTS.map((e) => ({ value: e, label: e.replace("_", " ") }))}
          />
          <div className="relative min-w-40 flex-1 sm:max-w-64 sm:flex-none">
            <GitBranch
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint"
              aria-hidden="true"
            />
            <Input
              value={branchText}
              onChange={(e) => setBranchText(e.target.value)}
              placeholder="Branch"
              aria-label="Filter by branch"
              spellCheck={false}
              autoComplete="off"
              className="h-8 pl-8 text-[13px]"
            />
          </div>
          {filtersOn ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBranchText("");
                void navigate({
                  to: "/$org/$project",
                  params: { org: scope.orgSlug as string, project: scope.projectSlug as string },
                  search: {},
                  replace: true,
                });
              }}
            >
              <X />
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      <div ref={listRef} className="border-t border-line" aria-busy={sync.loading}>
        {sync.error ? (
          <ErrorState title="Could not load runs" message={sync.error} onRetry={sync.reload} />
        ) : sync.loading && (data?.length ?? 0) === 0 ? (
          <div role="status" aria-label="Loading runs">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-line px-5 py-3.5">
                <Skeleton className="mt-0.5 size-[18px] rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-3/5" />
                </div>
                <Skeleton className="h-8 w-14" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          filtersOn ? (
            <EmptyState
              icon={<Filter />}
              title="No runs match these filters"
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setBranchText("");
                    void navigate({
                      to: "/$org/$project",
                      params: {
                        org: scope.orgSlug as string,
                        project: scope.projectSlug as string,
                      },
                      search: {},
                      replace: true,
                    });
                  }}
                >
                  Clear filters
                </Button>
              }
            >
              Try a different status, event or branch.
            </EmptyState>
          ) : (
            <EmptyState icon={<PlayCircle />} title="No runs yet">
              Push to {scope.project?.repo ?? "the repo"} or trigger a workflow and it appears here
              as it starts.
            </EmptyState>
          )
        ) : (
          filtered.map((run) => (
            <RunRowItem
              key={run.id}
              run={run}
              orgSlug={scope.orgSlug as string}
              projectSlug={scope.projectSlug as string}
              fresh={fresh.has(run.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
