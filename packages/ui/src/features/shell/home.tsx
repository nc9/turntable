import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnyProjects, useOrgs, useProjects } from "@/lib/directory";
import { parseFeedSearch } from "@/lib/activity";
import { ActivityFeed, type FeedFilter } from "./activity-feed";
import { cn } from "@/lib/utils";

/** The way into the onboarding wizard (`/onboarding`). */
export function ConnectButton({ variant = "secondary" }: { variant?: "secondary" | "default" }) {
  return (
    <Link to="/onboarding" className={cn(buttonVariants({ variant, size: "sm" }))}>
      Connect repositories
    </Link>
  );
}

/** Shown instead of an empty feed while no org has a connected repository yet. */
export function OrgChooser({ data }: { data: { id: string; slug: string; name: string }[] }) {
  return (
    <div className="mx-auto w-full max-w-md p-6">
      <h1 className="text-lg font-semibold tracking-tight">Choose an organization</h1>
      <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
        {data.map((o) => (
          <li key={o.id}>
            <Link
              to="/$org"
              params={{ org: o.slug }}
              className="flex h-11 items-center px-3 text-sm hover:bg-muted"
            >
              {o.name}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <ConnectButton />
      </div>
    </div>
  );
}

/** Home is "All orgs": the activity feed across every org the person belongs to. */
export function Home() {
  const { data: orgs, error } = useOrgs();
  const search = parseFeedSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate();
  const org = orgs?.find((o) => o.slug === search.org) ?? null;
  const projects = useProjects(org?.id ?? null).data ?? [];
  const anyProjects = useAnyProjects(orgs);
  const filter: FeedFilter = {
    org: org?.slug,
    project: org && projects.some((p) => p.slug === search.project) ? search.project : undefined,
    status: search.status ?? "all",
  };
  if (error) return <EmptyState title="Could not load organizations">{error}</EmptyState>;
  if (orgs && orgs.length === 0)
    return (
      <EmptyState title="No organizations yet" action={<ConnectButton />}>
        Create an org to start running workflows.
      </EmptyState>
    );
  if (!orgs || anyProjects === null)
    return (
      <div className="mx-auto w-full max-w-5xl space-y-3 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  // No repository connected in any org yet: the way in is onboarding, not an empty feed.
  if (!anyProjects) return <OrgChooser data={orgs} />;
  return (
    <ActivityFeed
      filter={filter}
      orgs={orgs}
      projects={projects}
      action={<ConnectButton variant="default" />}
      onFilter={(next) =>
        void navigate({
          to: "/",
          search: {
            ...(next.org ? { org: next.org } : {}),
            ...(next.project ? { project: next.project } : {}),
            ...(next.status !== "all" ? { status: next.status } : {}),
          },
        })
      }
    />
  );
}

export function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      action={
        <Link to="/" className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}>
          Back to overview
        </Link>
      }
    >
      That address does not match an org, project or run.
    </EmptyState>
  );
}
