// Which parts of Turntable one process runs, and what each part may hold.
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
import { loadMasterKey } from "./secrets/crypto";
import { parseMasterKeyValue } from "./secrets/master-key";
export const ROLES = ["web", "worker", "poller", "release"] as const;
export type Role = (typeof ROLES)[number];
/** The release lane's key variables: read once by the lane, never left in an environment. */
export const RELEASE_KEY_ENV = "TURNTABLE_RELEASE_MASTER_KEY";
export const RELEASE_KEY_PREVIOUS_ENV = "TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS";
export const MAIN_ROLES: readonly Role[] = ["web", "worker", "poller"];

/** Every environment variable that belongs to the release lane and to nothing else. */
export const RELEASE_ENV_PREFIXES = ["TURNTABLE_RELEASE_", "LONGSHORE_RELEASE_"] as const; // rename-keep: the second is the pre-rename spelling

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
  /** The release role's own master key file: unreadable by the other roles. Absent when the key is in `masterKey`. */
  masterKeyFile?: string | undefined;
  /** The release key from TURNTABLE_RELEASE_MASTER_KEY, already removed from the environment. */
  masterKey?: Buffer | undefined;
  /** The key the lane's sealed state is under before a rotation (TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS). */
  previousMasterKey?: Buffer | undefined;
  /** Where the release role keeps its own state (its own SQLite file), apart from the main data dir. */
  dataDir: string;
  /** The release role's own forge credential, used only to re-check tags and shas. */
  githubToken: string;
  /** Read-only directory of artifact bytes, `<dir>/<run id>/<name>`. */
  artifactDir: string;
  /** The instance URL, as the provenance's builder id. */
  builderId: string;
  pollMs: number;
  /** A GitHub credential that may write releases, for publishing. Only the lane has it. */
  githubPublishToken?: string | undefined;
  /**
   * Where the release proxy (compat publishing) listens. Absent: no release proxy. The lane
   * hosts it so the credential it injects never leaves the process that can open it.
   */
  proxy?:
    | {
        bind: string;
        port: number;
        advertiseHost: string | undefined;
        advertisePort: number | undefined;
        advertiseAddresses: string[] | undefined;
        tlsCertFile: string | undefined;
        tlsKeyFile: string | undefined;
      }
    | undefined;
  /**
   * How the worker asks the lane for a publish job's proxy credential. Needs the proxy. A unix
   * socket by default; TCP with mutual TLS when the worker is on another host.
   */
  channel?:
    | {
        keyFile: string;
        socket: string;
        tcp:
          | { host: string; port: number; certFile: string; keyFile: string; caFile: string }
          | undefined;
      }
    | undefined;
}

function channelConfig(
  env: Record<string, string | undefined>,
  keyFile: string,
  need: (name: string) => string,
): NonNullable<ReleaseConfig["channel"]> {
  const tcp = env.TURNTABLE_RELEASE_CHANNEL_TCP?.trim();
  let parsed: NonNullable<ReleaseConfig["channel"]>["tcp"];
  if (tcp) {
    const m = /^(.+):(\d{1,5})$/.exec(tcp);
    if (!m || Number(m[2]) > 65535)
      throw new Error("TURNTABLE_RELEASE_CHANNEL_TCP must be host:port");
    parsed = {
      host: m[1]!,
      port: Number(m[2]),
      certFile: need("TURNTABLE_RELEASE_CHANNEL_TLS_CERT_FILE"),
      keyFile: need("TURNTABLE_RELEASE_CHANNEL_TLS_KEY_FILE"),
      caFile: need("TURNTABLE_RELEASE_CHANNEL_TLS_CA_FILE"),
    };
  }
  return {
    keyFile,
    socket: env.TURNTABLE_RELEASE_CHANNEL_SOCKET?.trim() || "",
    tcp: parsed,
  };
}

/**
 * The release role's configuration, from its own environment. Called ONLY when the release role
 * is chosen: a main process never calls it, so these variables do nothing there even when set.
 */
export function releaseConfigFromEnv(env: Record<string, string | undefined>): ReleaseConfig {
  // First, before anything can fail or start: the key variables are read and removed.
  const keyValue = env[RELEASE_KEY_ENV]?.trim();
  const prevValue = env[RELEASE_KEY_PREVIOUS_ENV]?.trim();
  delete env[RELEASE_KEY_ENV];
  delete env[RELEASE_KEY_PREVIOUS_ENV];
  const keyFile = env.TURNTABLE_RELEASE_MASTER_KEY_FILE?.trim();
  if (keyValue && keyFile) {
    throw new Error(
      `${RELEASE_KEY_ENV} and TURNTABLE_RELEASE_MASTER_KEY_FILE are both set: use one`,
    );
  }
  if (prevValue && !keyValue && !keyFile) {
    throw new Error(`${RELEASE_KEY_PREVIOUS_ENV} is set but there is no current release key`);
  }
  const masterKey = keyValue ? parseMasterKeyValue(RELEASE_KEY_ENV, keyValue) : undefined;
  let previousMasterKey = prevValue
    ? parseMasterKeyValue(RELEASE_KEY_PREVIOUS_ENV, prevValue)
    : undefined;
  if (previousMasterKey && masterKey?.equals(previousMasterKey)) previousMasterKey = undefined;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`the release role needs ${name}`);
    return v;
  };
  const pollMs = Number(env.TURNTABLE_RELEASE_POLL_MS ?? "5000");
  if (!Number.isInteger(pollMs) || pollMs < 100) {
    throw new Error(
      "TURNTABLE_RELEASE_POLL_MS must be a whole number of milliseconds, at least 100",
    );
  }
  const channelKeyFile = env.TURNTABLE_RELEASE_CHANNEL_KEY_FILE?.trim();
  if (channelKeyFile && !env.TURNTABLE_RELEASE_PROXY_PORT?.trim()) {
    throw new Error(
      "TURNTABLE_RELEASE_CHANNEL_KEY_FILE needs the release proxy (TURNTABLE_RELEASE_PROXY_PORT)",
    );
  }
  const proxyPort = env.TURNTABLE_RELEASE_PROXY_PORT?.trim();
  if (proxyPort !== undefined && proxyPort !== "") {
    const n = Number(proxyPort);
    if (!Number.isInteger(n) || n < 0 || n > 65535)
      throw new Error("TURNTABLE_RELEASE_PROXY_PORT must be a port number (0 for any free port)");
  }
  return {
    ...(masterKey
      ? { masterKey }
      : { masterKeyFile: keyFile || need("TURNTABLE_RELEASE_MASTER_KEY_FILE") }),
    ...(previousMasterKey ? { previousMasterKey } : {}),
    dataDir: need("TURNTABLE_RELEASE_DATA_DIR"),
    githubToken: need("TURNTABLE_RELEASE_GITHUB_TOKEN"),
    artifactDir: need("TURNTABLE_RELEASE_ARTIFACT_DIR"),
    builderId: need("TURNTABLE_RELEASE_BUILDER_ID"),
    githubPublishToken: env.TURNTABLE_RELEASE_GITHUB_PUBLISH_TOKEN?.trim() || undefined,
    ...(proxyPort
      ? {
          proxy: {
            bind: env.TURNTABLE_RELEASE_PROXY_BIND?.trim() || "127.0.0.1",
            port: Number(proxyPort),
            advertiseHost: env.TURNTABLE_RELEASE_PROXY_ADVERTISE_HOST?.trim() || undefined,
            advertisePort: env.TURNTABLE_RELEASE_PROXY_ADVERTISE_PORT?.trim()
              ? Number(env.TURNTABLE_RELEASE_PROXY_ADVERTISE_PORT.trim())
              : undefined,
            advertiseAddresses: env.TURNTABLE_RELEASE_PROXY_ADVERTISE_ADDRESSES?.trim()
              ? env.TURNTABLE_RELEASE_PROXY_ADVERTISE_ADDRESSES.split(",")
                  .map((x) => x.trim())
                  .filter(Boolean)
              : undefined,
            tlsCertFile: env.TURNTABLE_RELEASE_PROXY_TLS_CERT_FILE?.trim() || undefined,
            tlsKeyFile: env.TURNTABLE_RELEASE_PROXY_TLS_KEY_FILE?.trim() || undefined,
          },
        }
      : {}),
    ...(channelKeyFile ? { channel: channelConfig(env, channelKeyFile, need) } : {}),
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

/** The release lane's master key, from the variable (already parsed) or its file. */
export function releaseMasterKey(cfg: ReleaseConfig): Buffer {
  return cfg.masterKey ?? loadMasterKey(cfg.masterKeyFile!);
}

/** Where the release lane's key file and own data directory are, for doctor. Reads, never changes, the environment. */
export function releaseKeyLocation(
  env: Record<string, string | undefined>,
): { file: string; dataDir: string | undefined } | undefined {
  const file = env.TURNTABLE_RELEASE_MASTER_KEY_FILE?.trim();
  return file ? { file, dataDir: env.TURNTABLE_RELEASE_DATA_DIR?.trim() || undefined } : undefined;
}
