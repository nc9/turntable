import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { lastOrg, useOrgs } from "@/lib/directory";
import { pickOrg } from "@/lib/session";
import { cn } from "@/lib/utils";

export function HomeRedirect() {
  const { data, error } = useOrgs();
  const navigate = useNavigate();
  // The last org if it is still reachable, else the only org, else the picker below (#477).
  const target = data ? pickOrg(data, { remembered: lastOrg() }) : null;
  useEffect(() => {
    if (target) void navigate({ to: "/$org", params: { org: target }, replace: true });
  }, [target, navigate]);
  if (error) return <EmptyState title="Could not load organizations">{error}</EmptyState>;
  if (data && data.length === 0)
    return (
      <EmptyState title="No organizations yet">
        Create an org to start running workflows.
      </EmptyState>
    );
  if (data && !target)
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
      </div>
    );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-3 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full" />
    </div>
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
