import { useEffect, useState } from "react";
import { getBackend } from "@/api";
import type { Org, Project } from "@/api/types";

// Orgs and projects change rarely, so they live in a tiny cache rather than live collections.
let orgsCache: Promise<Org[]> | null = null;
const projectsCache = new Map<string, Promise<Project[]>>();

function loadOrgs(): Promise<Org[]> {
  orgsCache ??= getBackend().api.listOrgs();
  return orgsCache;
}

function loadProjects(orgId: string): Promise<Project[]> {
  let p = projectsCache.get(orgId);
  if (!p) {
    p = getBackend().api.listProjects(orgId);
    projectsCache.set(orgId, p);
  }
  return p;
}

/** Forget cached orgs and projects (after connecting to a different org). */
export function resetDirectory(): void {
  orgsCache = null;
  projectsCache.clear();
}

type Loaded<T> = { data: T | null; error: string | null };

function useCached<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string | null } & Loaded<T>>({
    key,
    data: null,
    error: null,
  });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    load().then(
      (data) => live && setState({ key, data, error: null }),
      (e: unknown) =>
        live &&
        setState({ key, data: null, error: e instanceof Error ? e.message : "Request failed" }),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { data: null, error: null };
}

export function useOrgs(): Loaded<Org[]> {
  return useCached("orgs", loadOrgs);
}

export function useProjects(orgId: string | null): Loaded<Project[]> {
  return useCached(orgId, () => loadProjects(orgId as string));
}

const LAST_ORG = "tt-last-org";
export function rememberOrg(slug: string): void {
  try {
    localStorage.setItem(LAST_ORG, slug);
  } catch {
    // storage unavailable
  }
}
export function lastOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG);
  } catch {
    return null;
  }
}
