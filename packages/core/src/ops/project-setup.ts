// Whether a project was ever set up for CI. Derived from existing data, nothing stored: a project
// that installation sync created and nobody onboarded is `available`, not `active`.

export type ProjectSetup = "active" | "available";

export type ProjectSetupFacts = {
  /** The project's stored ingest settings (JSON text), null when ingest is off. */
  ingestConfig: string | null;
  /** A static entry of the running poll config names this project. */
  inStaticPoll: boolean;
  /** The project has at least one run. */
  hasRuns: boolean;
  /** A repo of the project is bound through a GitHub App installation (what the sync does). */
  fromInstallation: boolean;
};

/**
 * `available` only for a project the installation sync created and nobody set up. A project that
 * was made on purpose (no installation binding) is `active`, as is one with ingest on, a static
 * poll entry naming it, or any run.
 */
export function projectSetup(f: ProjectSetupFacts): ProjectSetup {
  if (!f.fromInstallation) return "active";
  if (f.ingestConfig !== null && f.ingestConfig !== "") return "active";
  if (f.inStaticPoll || f.hasRuns) return "active";
  return "available";
}

/** The static poll entries as the `org/project` slug pairs they target. */
export function staticPollKey(orgSlug: string, projectSlug: string): string {
  return `${orgSlug}/${projectSlug}`;
}
