// The `permissions:` a workflow declares for a job, as the GitHub token it would get. Pure: it
// reads YAML and returns what was asked for, with a note for anything it could not map. What is
// actually granted is decided later, capped by the run's trust class and the App's installation.
import { parse } from "yaml";

export type PermissionLevel = "read" | "write";

/** Installation-token permission names a workflow permission can map to. */
const MAPPABLE = new Set([
  "actions",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "issues",
  "packages",
  "pages",
  "pull_requests",
  "repository_projects",
  "security_events",
  "statuses",
]);

/** True for a permission name an installation token can carry (never id_token). */
export const isMappablePermission = (name: string): boolean => MAPPABLE.has(name);

export interface DeclaredPermissions {
  /** The declared permissions, mappable ones only. `none` entries are left out. */
  permissions: Record<string, PermissionLevel>;
  /** Declared at all (job or workflow level). False means the default applies. */
  declared: boolean;
  /** Things asked for that no installation token can carry (id-token, attestations, ...). */
  notes: string[];
}

/** What a job with no `permissions:` gets: contents read, nothing else. */
export const DEFAULT_PERMISSIONS: Readonly<Record<string, PermissionLevel>> = { contents: "read" };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The job's `permissions:` if it has one, else the workflow's (a job's block replaces the
 * workflow's, it does not merge). `read-all` and `write-all` cover every mappable name, `{}` is
 * none. Nothing declared: the default (contents read).
 */
export function declaredPermissions(workflowYaml: string, jobId: string): DeclaredPermissions {
  let doc: unknown;
  try {
    doc = parse(workflowYaml, { merge: true });
  } catch {
    return { permissions: { ...DEFAULT_PERMISSIONS }, declared: false, notes: [] };
  }
  const root = isObj(doc) ? doc : {};
  const job = isObj(root.jobs) && isObj(root.jobs[jobId]) ? (root.jobs[jobId] as object) : {};
  const raw =
    "permissions" in job ? (job as { permissions?: unknown }).permissions : root.permissions;
  const notes: string[] = [];
  if (raw === undefined || raw === null) {
    return { permissions: { ...DEFAULT_PERMISSIONS }, declared: false, notes };
  }
  const out: Record<string, PermissionLevel> = {};
  if (raw === "read-all" || raw === "write-all") {
    for (const n of MAPPABLE) out[n] = raw === "write-all" ? "write" : "read";
    return { permissions: out, declared: true, notes };
  }
  if (!isObj(raw)) {
    notes.push("permissions is not a map, read-all or write-all; treated as none");
    return { permissions: out, declared: true, notes };
  }
  for (const [name, level] of Object.entries(raw)) {
    const key = name.replaceAll("-", "_");
    if (level !== "read" && level !== "write" && level !== "none") {
      notes.push(`permission ${name}: ${String(level)} is not read, write or none; ignored`);
      continue;
    }
    if (level === "none") continue;
    if (!MAPPABLE.has(key)) {
      notes.push(`permission ${name} cannot be carried by an installation token; ignored`);
      continue;
    }
    out[key] = level;
  }
  return { permissions: out, declared: true, notes };
}
