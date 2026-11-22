// Which parts of Longshore one process runs, and what each part may hold.
//
//  web      the HTTP server: API, UI, webhooks, the OIDC issuer
//  worker   the job scheduler and runner (what `--worker` starts)
//  poller   the GitHub poller (what `--poll` starts)
//  release  the release lane, ALONE: it signs and publishes, and holds what that needs
//
// The release role is the only one that holds the signing backend configuration, cloud (KMS)
// credentials, the release master key and the forge credential it uses to re-check a release. It
// shares no process with the other roles, so a process that runs untrusted code paths (web,
// worker) has no signer to call and no key to read, whatever its database access. Nothing outside
// `releaseConfigFromEnv`, which only the release role calls, looks at those variables.
export const ROLES = ["web", "worker", "poller", "release"] as const;
export type Role = (typeof ROLES)[number];
export const MAIN_ROLES: readonly Role[] = ["web", "worker", "poller"];

/** Every environment variable that belongs to the release lane and to nothing else. */
export const RELEASE_ENV_PREFIXES = ["LONGSHORE_RELEASE_"] as const;

/**
 * The roles for this process. `--roles` is explicit (`all` is web, worker and poller; `release`
 * stands alone). Without it, the long-standing flags decide: always web, plus worker for
 * `--worker` and poller for `--poll`.
 */
export function resolveRoles(
  raw: string | undefined,
  legacy: { worker?: boolean | undefined; poll?: string | undefined },
): Set<Role> {
  if (raw === undefined) {
    const out = new Set<Role>(["web"]);
    if (legacy.worker) out.add("worker");
    if (legacy.poll) out.add("poller");
    return out;
  }
  const out = new Set<Role>();
  for (const part of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (part === "all") {
      for (const r of MAIN_ROLES) out.add(r);
    } else if ((ROLES as readonly string[]).includes(part)) {
      out.add(part as Role);
    } else {
      throw new Error(`unknown role "${part}"; use ${[...ROLES, "all"].join(", ")}`);
    }
  }
  if (out.size === 0) throw new Error("--roles needs at least one role");
  if (out.has("release") && out.size > 1) {
    throw new Error(
      "the release role runs alone: it holds the signing keys and publish credentials that no other role may have. Start it as its own process: serve --roles release",
    );
  }
  if (legacy.worker && !out.has("worker") && !out.has("release")) {
    throw new Error("--worker conflicts with --roles: add worker to --roles");
  }
  if (legacy.poll && !out.has("poller") && !out.has("release")) {
    throw new Error("--poll conflicts with --roles: add poller to --roles");
  }
  return out;
}

export interface ReleaseConfig {
  /** The release role's own master key file: unreadable by the other roles. */
  masterKeyFile: string;
  /** Where the release role keeps its own state (its own SQLite file), apart from the main data dir. */
  dataDir: string;
  /** The release role's own forge credential, used only to re-check tags and shas. */
  githubToken: string;
  /** Read-only directory of artifact bytes, `<dir>/<run id>/<name>`. */
  artifactDir: string;
  /** The instance URL, as the provenance's builder id. */
  builderId: string;
  pollMs: number;
}

/**
 * The release role's configuration, from its own environment. Called ONLY when the release role
 * is chosen: a main process never calls it, so these variables do nothing there even when set.
 */
export function releaseConfigFromEnv(env: Record<string, string | undefined>): ReleaseConfig {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`the release role needs ${name}`);
    return v;
  };
  const pollMs = Number(env.LONGSHORE_RELEASE_POLL_MS ?? "5000");
  if (!Number.isInteger(pollMs) || pollMs < 100) {
    throw new Error(
      "LONGSHORE_RELEASE_POLL_MS must be a whole number of milliseconds, at least 100",
    );
  }
  return {
    masterKeyFile: need("LONGSHORE_RELEASE_MASTER_KEY_FILE"),
    dataDir: need("LONGSHORE_RELEASE_DATA_DIR"),
    githubToken: need("LONGSHORE_RELEASE_GITHUB_TOKEN"),
    artifactDir: need("LONGSHORE_RELEASE_ARTIFACT_DIR"),
    builderId: need("LONGSHORE_RELEASE_BUILDER_ID"),
    pollMs,
  };
}

/** Release-lane variables present in an environment: for a warning in a process that is not the lane. */
export function releaseEnvPresent(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => RELEASE_ENV_PREFIXES.some((p) => k.startsWith(p)));
}

/**
 * What a non-release process holds of the release lane: nothing. A value, so a test can assert it
 * with the release variables present in the environment.
 */
export interface MainRuntime {
  roles: Set<Role>;
  release: undefined;
  /** Release variables seen and deliberately ignored. */
  ignoredReleaseEnv: string[];
}

export function mainRuntime(
  roles: Set<Role>,
  env: Record<string, string | undefined>,
): MainRuntime {
  if (roles.has("release"))
    throw new Error("mainRuntime is for processes that are not the release lane");
  return { roles, release: undefined, ignoredReleaseEnv: releaseEnvPresent(env) };
}
