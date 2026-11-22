import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { lastOrg, useOrgs } from "@/lib/directory";
import { cn } from "@/lib/utils";

export function HomeRedirect() {
  const { data, error } = useOrgs();
  const navigate = useNavigate();
  useEffect(() => {
    if (!data || data.length === 0) return;
    const slug = data.find((o) => o.slug === lastOrg())?.slug ?? (data[0] as { slug: string }).slug;
    void navigate({ to: "/$org", params: { org: slug }, replace: true });
  }, [data, navigate]);
  if (error) return <EmptyState title="Could not load organizations">{error}</EmptyState>;
  if (data && data.length === 0)
    return (
      <EmptyState title="No organizations yet">
        Create an org to start running workflows.
      </EmptyState>
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
