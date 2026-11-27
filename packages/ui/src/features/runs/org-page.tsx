import { eq, useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { ArrowRight, FolderGit2 } from "lucide-react";
import { useMemo } from "react";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { StateIcon } from "@/components/state-badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Project, Run } from "@/api/types";
import { runsCollection } from "@/db/collections";
import { useOrgSync } from "@/db/sync";
import { ConnectButton } from "@/features/shell/home";
import { useScope } from "@/features/shell/scope";
import { formatRelative } from "@/lib/format";
import { RefChip, RunLink } from "./common";

function ProjectCard({
  project,
  runs,
  orgSlug,
}: {
  project: Project;
  runs: Run[];
  orgSlug: string;
}) {
  const mine = runs.filter((r) => r.projectId === project.id);
  const last = mine[0];
  const active = mine.filter((r) => r.status === "running" || r.status === "queued").length;
  const finished = mine
    .filter((r) => r.status === "success" || r.status === "failure")
    .slice(0, 20);
  const passRate =
    finished.length === 0
      ? null
      : Math.round((finished.filter((r) => r.status === "success").length / finished.length) * 100);
  return (
    <Link
      to="/$org/$project"
      params={{ org: orgSlug, project: project.slug }}
      className="group flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 transition-colors duration-150 hover:border-line-strong hover:bg-subtle"
    >
      <div className="flex items-center gap-2">
        <FolderGit2 className="size-4 text-dim" aria-hidden="true" />
        <span className="font-medium">{project.name}</span>
        <ArrowRight
          className="ml-auto size-4 text-faint transition-transform duration-150 group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </div>
      <p className="truncate font-mono text-xs text-dim">
        {project.repo || (project.noAccess ? "No repository access" : "")}
      </p>
      <div className="flex items-center gap-4 text-[13px]">
        {last ? (
          <span className="inline-flex items-center gap-1.5">
            <StateIcon state={last.status} className="size-3.5" />
            <span className="text-dim">{formatRelative(last.createdAt)}</span>
          </span>
        ) : (
          <span className="text-dim">No runs</span>
        )}
        {active > 0 ? <span className="text-st-running">{active} active</span> : null}
        {passRate !== null ? (
          <span className="tabular ml-auto text-dim">
            {passRate}% passing, last {finished.length}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

/** Repos installation sync bound that were never set up: a count, and a plain list to set one up. */
export function AvailableRepositories({
  projects,
  orgSlug,
}: {
  projects: Project[];
  orgSlug: string;
}) {
  if (projects.length === 0) return null;
  return (
    <details className="mt-6 rounded-xl border border-line" data-testid="available-repositories">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">
        Available repositories ({projects.length})
      </summary>
      <ul className="border-t border-line">
        {projects.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-dim">
              {p.repo || p.slug}
            </span>
            <Link
              to="/$org/$project/settings"
              params={{ org: orgSlug, project: p.slug }}
              className="text-sm font-medium"
            >
              Set up
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function OrgPage() {
  const scope = useScope();
  const projectIds = useMemo(() => (scope.projects ?? []).map((p) => p.id), [scope.projects]);
  const sync = useOrgSync(scope.org?.id ?? null, projectIds);
  const orgId = scope.org?.id ?? "";
  const { data } = useLiveQuery(
    (q) =>
      q
        .from({ run: runsCollection })
        .where(({ run }) => eq(run.orgId, orgId))
        .orderBy(({ run }) => run.createdAt, "desc")
        .limit(200),
    [orgId],
  );
  const runs = data ?? [];

  if (scope.orgs && scope.org === null)
    return (
      <EmptyState title="Organization not found">
        Check the address or switch org from the header.
      </EmptyState>
    );
  if (scope.error) return <ErrorState message={scope.error} />;

  const activeProjects = (scope.projects ?? []).filter((p) => p.setup !== "available");
  const availableProjects = (scope.projects ?? []).filter((p) => p.setup === "available");
  const running = runs.filter((r) => r.status === "running");
  const needsAttention = runs
    .filter(
      (r) =>
        r.status === "failure" || r.status === "infra_error" || r.status === "awaiting_approval",
    )
    .slice(0, 6);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">{scope.org?.name ?? " "}</h1>
      <p className="mt-0.5 text-sm text-dim">
        {running.length > 0
          ? `${running.length} ${running.length === 1 ? "run" : "runs"} executing now`
          : "Nothing is running right now"}
      </p>

      <h2 className="mb-3 mt-8 text-sm font-semibold">Projects</h2>
      {scope.projects === null || (sync.loading && runs.length === 0) ? (
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          role="status"
          aria-label="Loading projects"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : activeProjects.length === 0 ? (
        <EmptyState icon={<FolderGit2 />} title="No projects yet" action={<ConnectButton />}>
          Bind a repo to create the first project.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activeProjects.map((p) => (
            <ProjectCard key={p.id} project={p} runs={runs} orgSlug={scope.orgSlug as string} />
          ))}
        </div>
      )}
      <AvailableRepositories projects={availableProjects} orgSlug={scope.orgSlug as string} />

      <h2 className="mb-3 mt-10 text-sm font-semibold">Needs attention</h2>
      {needsAttention.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong p-6 text-sm text-dim">
          Nothing needs attention. Failed, infra-errored and approval-blocked runs show up here.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {needsAttention.map((r) => {
            const project = scope.projects?.find((p) => p.id === r.projectId);
            return (
              <li key={r.id} className="border-b border-line last:border-b-0">
                {project ? (
                  <RunLink
                    orgSlug={scope.orgSlug as string}
                    projectSlug={project.slug}
                    runId={r.id}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-subtle focus-visible:-outline-offset-2"
                  >
                    <StateIcon state={r.status} className="size-[18px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {r.runName || r.commitMessage}
                      </span>
                      <span className="flex items-center gap-3 text-xs text-dim">
                        <span>{project.name}</span>
                        <RefChip run={r} className="max-w-40" />
                      </span>
                    </span>
                    <span className="text-xs text-dim">{formatRelative(r.createdAt)}</span>
                  </RunLink>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
