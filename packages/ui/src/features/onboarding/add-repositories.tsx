// The Add repositories page: the repositories an installed GitHub App can reach but the org has
// not added. The App's access is only a permission, so a repo becomes a project here, one click at
// a time (`add_project`), and never because the installation was synced.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { InstallationRepo, OnboardingApi, OrgInstallation } from "@/api/onboarding";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { resetDirectory } from "@/lib/directory";
import { useAsync } from "@/lib/use-async";
import { useScope } from "@/features/shell/scope";
import { sanitize } from "@/log/parser";
import { getOnboardingApi } from "./api";

/** The picker's filter: only repos the org has not added. A repo that is a project is not offered. */
export function addableRepos(repos: readonly InstallationRepo[]): InstallationRepo[] {
  return repos.filter((r) => r.status === "new");
}

/** What a new project's cap starts at when the org has not changed `default_project_max_concurrent`. */
export const DEFAULT_NEW_PROJECT_CAP = 2;

/**
 * The cap to send for an add: undefined when the person left the field alone (the server applies
 * the org's default), a whole number when they changed it, and null when what they typed is not
 * a whole number from 0 up (the Add button stays disabled).
 */
export function capToSend(typed: string | undefined): number | undefined | null {
  if (typed === undefined) return undefined;
  if (!/^\d{1,4}$/.test(typed.trim())) return null;
  return Number(typed.trim());
}

export function AddRepositoriesView({
  repos,
  busyRepo,
  error,
  added,
  onAdd,
}: {
  repos: readonly InstallationRepo[];
  busyRepo: string | null;
  error: string | null;
  /** The repos added in this visit, for the confirmation line. */
  added: readonly string[];
  onAdd: (repo: InstallationRepo, maxConcurrent?: number) => void;
}) {
  // Typed caps by repo id; a repo with no entry shows the default and sends nothing.
  const [caps, setCaps] = useState<Record<string, string>>({});
  const todo = addableRepos(repos);
  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="rounded-md border border-line bg-subtle px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
      {added.length > 0 ? (
        <p role="status" className="text-sm text-dim">
          Added {added.map((a) => sanitize(a)).join(", ")}.
        </p>
      ) : null}
      {todo.length === 0 ? (
        <EmptyState title="Every repository is already added">
          The GitHub App can reach {repos.length}{" "}
          {repos.length === 1 ? "repository" : "repositories"}, and each one is a project of this
          org. Grant the App more repositories on GitHub to add others.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {todo.map((r) => (
            <li key={r.repo_id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                {sanitize(r.repo)}
                {r.private ? <span className="ml-2 text-xs text-faint">private</span> : null}
              </span>
              <label className="flex items-center gap-1.5 text-xs text-dim">
                Max concurrent
                <input
                  type="number"
                  min={0}
                  max={1000}
                  step={1}
                  inputMode="numeric"
                  className="h-8 w-16 rounded-md border border-line bg-transparent px-2 text-sm"
                  aria-label={`Max concurrent runs for ${sanitize(r.repo)}`}
                  value={caps[r.repo_id] ?? String(DEFAULT_NEW_PROJECT_CAP)}
                  onChange={(e) => setCaps((c) => ({ ...c, [r.repo_id]: e.target.value }))}
                />
              </label>
              <Button
                type="button"
                size="sm"
                disabled={busyRepo !== null || capToSend(caps[r.repo_id]) === null}
                aria-label={`Add ${sanitize(r.repo)}`}
                onClick={() => onAdd(r, capToSend(caps[r.repo_id]) ?? undefined)}
              >
                {busyRepo === r.repo ? "Adding" : "Add"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InstallationRepos({
  api,
  org,
  installation,
}: {
  api: OnboardingApi;
  org: string;
  installation: OrgInstallation;
}) {
  const repos = useAsync(
    () => api.listInstallationRepos({ org, installationId: installation.installation_id }),
    [api, org, installation.installation_id],
  );
  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  if (repos.error) return <ErrorState message={repos.error} onRetry={repos.reload} />;
  if (!repos.data) return <Skeleton className="h-40 w-full" />;
  return (
    <AddRepositoriesView
      repos={repos.data}
      busyRepo={busyRepo}
      error={error}
      added={added}
      onAdd={(r, maxConcurrent) => {
        setBusyRepo(r.repo);
        setError(null);
        api
          .addProject({
            org,
            installationId: installation.installation_id,
            repo: r.repo,
            ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
          })
          .then(
            (p) => {
              setBusyRepo(null);
              setAdded((a) => [...a, p.repo]);
              resetDirectory();
              repos.reload();
            },
            (e: unknown) => {
              setBusyRepo(null);
              setError(e instanceof Error ? e.message : "Could not add the repository.");
            },
          );
      }}
    />
  );
}

export function AddRepositoriesPage() {
  const scope = useScope();
  const api = getOnboardingApi();
  const org = scope.orgSlug ?? "";
  const installations = useAsync(
    () => (org ? api.listOrgInstallations({ org }) : Promise.resolve([])),
    [api, org],
  );
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">Add repositories</h1>
      <p className="mt-0.5 text-sm text-dim">
        The GitHub App can reach these repositories, but a repository becomes a project only when
        you add it. A new project may run two attempts at once unless you change it here. Adding one
        does not turn CI on: set that up from the onboarding page or the project's settings.
      </p>
      <div className="mt-6 space-y-8">
        {installations.error ? (
          <ErrorState message={installations.error} onRetry={installations.reload} />
        ) : !installations.data ? (
          <Skeleton className="h-40 w-full" />
        ) : installations.data.length === 0 ? (
          <EmptyState
            title="No GitHub App installation yet"
            action={
              <Link to="/onboarding" className={buttonVariants({ size: "sm" })}>
                Connect GitHub
              </Link>
            }
          >
            Install the App on a GitHub account to choose repositories from it.
          </EmptyState>
        ) : (
          installations.data.map((i) => (
            <section
              key={i.installation_id}
              aria-label={`Repositories of ${sanitize(i.account_login)}`}
            >
              <h2 className="mb-3 text-sm font-semibold">{sanitize(i.account_login)}</h2>
              <InstallationRepos api={api} org={org} installation={i} />
            </section>
          ))
        )}
      </div>
    </div>
  );
}
