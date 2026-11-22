import { useParams } from "@tanstack/react-router";
import type { Org, Project } from "@/api/types";
import { useOrgs, useProjects } from "@/lib/directory";

export type Scope = {
  orgSlug: string | null;
  projectSlug: string | null;
  orgs: Org[] | null;
  org: Org | null;
  projects: Project[] | null;
  project: Project | null;
  error: string | null;
};

/** Resolve the org and project in the URL to records. Everything below the shell reads this. */
export function useScope(): Scope {
  const params = useParams({ strict: false }) as { org?: string; project?: string };
  const orgs = useOrgs();
  const org = orgs.data?.find((o) => o.slug === params.org) ?? null;
  const projects = useProjects(org?.id ?? null);
  const project = projects.data?.find((p) => p.slug === params.project) ?? null;
  return {
    orgSlug: params.org ?? null,
    projectSlug: params.project ?? null,
    orgs: orgs.data,
    org,
    projects: projects.data,
    project,
    error: orgs.error ?? projects.error,
  };
}
