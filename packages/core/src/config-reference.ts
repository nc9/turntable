// The one typed list of the environment variables `longshore` reads, and the `serve` flag each
// stands for. docs/configuration.mdx's reference table is generated from it
// (scripts/config-reference.ts), and a test fails when the source reads a LONGSHORE_* variable
// that is not listed here, so the reference cannot drift from the code.

export type ConfigArea =
  | "Server"
  | "Worker and provider"
  | "Secrets and keys"
  | "GitHub"
  | "Secrets proxy"
  | "Release lane"
  | "Audit"
  | "OIDC"
  | "Approvals"
  | "Channel and MCP clients"
  | "Process and privileges"
  | "Build";

export type ConfigVar = {
  name: string;
  area: ConfigArea;
  /** The `serve` flag this variable sets the default of; a flag, when given, wins. */
  flag?: string;
  /** What it is when unset. */
  default?: string;
  description: string;
};

export const AREA_ORDER: readonly ConfigArea[] = [
  "Server",
  "Worker and provider",
  "Secrets and keys",
  "GitHub",
  "Secrets proxy",
  "Release lane",
  "Audit",
  "OIDC",
  "Approvals",
  "Channel and MCP clients",
  "Process and privileges",
  "Build",
];

export const CONFIG_VARS: readonly ConfigVar[] = [
  // ---- Server ----
  {
    name: "PORT",
    area: "Server",
    flag: "--port",
    default: "8080",
    description: "TCP port. Platforms such as Railway set it.",
  },
  {
    name: "LONGSHORE_HOST",
    area: "Server",
    flag: "--host",
    default: "127.0.0.1",
    description: "Interface to bind. The container image sets `0.0.0.0`.",
  },
  {
    name: "LONGSHORE_DATA_DIR",
    area: "Server",
    flag: "--data-dir",
    default: "./data",
    description: "Directory that holds `longshore.db` and the files the server keeps.",
  },
  {
    name: "LONGSHORE_ROLES",
    area: "Server",
    flag: "--roles",
    description:
      "Which parts this process runs: `web`, `worker`, `poller`, `all` (those three), or `release`, which runs alone. Without it, `--worker` and `--poll` decide.",
  },
  {
    name: "LONGSHORE_PUBLIC_URL",
    area: "Server",
    flag: "--public-url",
    description:
      "The server's public base URL, linked from check runs and used for WebAuthn and OIDC defaults.",
  },
  {
    name: "LONGSHORE_ALLOWED_ORIGINS",
    area: "Server",
    flag: "--allowed-origin",
    description:
      "Comma-separated extra origins allowed to open the realtime WebSocket. The page's own origin is always allowed.",
  },
  {
    name: "LONGSHORE_TRUSTED_PROXIES",
    area: "Server",
    description:
      "Comma-separated addresses and CIDR ranges of the proxies in front of the server. The webhook failure limiter keys on the client address the forwarded chain reports through them. Required for correct client addresses behind a proxy.",
  },
  {
    name: "LONGSHORE_TRUST_FORWARDED_PROTO",
    area: "Server",
    default: "off",
    description:
      "Set to `1` behind a TLS-terminating proxy you control: plain-http requests it forwards get a 301 to https (GET and HEAD; 400 otherwise), and secret values sent over `x-forwarded-proto: https` are accepted.",
  },
  {
    name: "LONGSHORE_TRUST_FORWARDED_FOR",
    area: "Server",
    description:
      "No longer read (a warning is printed). Name your proxies in `LONGSHORE_TRUSTED_PROXIES`.",
  },
  {
    name: "LONGSHORE_HSTS_MAX_AGE",
    area: "Server",
    default: "31536000",
    description:
      "`Strict-Transport-Security` max-age in seconds on https responses. `0` or `off` disables it.",
  },
  {
    name: "LONGSHORE_HSTS_INCLUDE_SUBDOMAINS",
    area: "Server",
    default: "on",
    description: "Set to `0` to drop `includeSubDomains` from the HSTS header.",
  },
  {
    name: "LONGSHORE_BOOTSTRAP_TOKEN_SHA256",
    area: "Server",
    description:
      "sha256 of a token from `longshore token generate`. On boot, an org with no tokens gets one operator token with this hash.",
  },
  {
    name: "LONGSHORE_BOOTSTRAP_ORG",
    area: "Server",
    default: "local",
    description: "The org that receives the bootstrap token.",
  },
  {
    name: "LONGSHORE_NET_ALLOW_HOSTS",
    area: "Server",
    description:
      "Comma-separated hostnames or IP literals the outbound HTTP client may reach even when they resolve to a private address (an audit webhook on a private network, a mock in tests). Everything else private is refused.",
  },
  {
    name: "LONGSHORE_HOSTED",
    area: "Server",
    flag: "--hosted",
    default: "off",
    description:
      "A hosted, multi-tenant instance: every job needs a `microvm` or `vm` provider and third-party provider plugins are disabled.",
  },
  {
    name: "LONGSHORE_CLAIM_INSTALLATIONS",
    area: "Server",
    default: "off",
    description:
      "Set to `1` on a hosted instance: an org claims its own GitHub App installation (`start_installation_claim`, then GitHub redirects to `/api/v1/github/setup`).",
  },
  // ---- Worker and provider ----
  {
    name: "LONGSHORE_WORKER",
    area: "Worker and provider",
    flag: "--worker",
    default: "off",
    description: "Run the scheduler and worker in this process.",
  },
  {
    name: "LONGSHORE_PROVIDER",
    area: "Worker and provider",
    flag: "--provider",
    default: "docker",
    description: "`docker` or `daytona`.",
  },
  {
    name: "LONGSHORE_PROVIDER_CONFIG",
    area: "Worker and provider",
    flag: "--provider-config",
    description: "Path of a JSON file of provider options. Secrets never go in it.",
  },
  {
    name: "LONGSHORE_PROVIDER_CONFIG_JSON",
    area: "Worker and provider",
    description:
      "The provider options as JSON, for hosts with no files. Used when no config file is named.",
  },
  {
    name: "LONGSHORE_POLL",
    area: "Worker and provider",
    flag: "--poll",
    description: "Path of the poller's JSON config.",
  },
  {
    name: "LONGSHORE_POLL_JSON",
    area: "Worker and provider",
    description: "The poller config as JSON, for hosts with no files. Used when no file is named.",
  },
  {
    name: "LONGSHORE_IMAGE",
    area: "Worker and provider",
    flag: "--image",
    default: "built in",
    description: "The image jobs run in (Docker).",
  },
  {
    name: "LONGSHORE_GLOBAL_CAP",
    area: "Worker and provider",
    flag: "--global-cap",
    default: "4",
    description: "Most jobs running at once across the instance.",
  },
  {
    name: "LONGSHORE_ORG_CAP",
    area: "Worker and provider",
    flag: "--org-cap",
    default: "2",
    description:
      "Most jobs running at once per org. A stored per-org quota (`set_quotas`) replaces it for that org.",
  },
  {
    name: "LONGSHORE_LEASE_SECONDS",
    area: "Worker and provider",
    flag: "--lease-seconds",
    default: "30",
    description: "How long a worker holds a claimed attempt without a heartbeat.",
  },
  {
    name: "LONGSHORE_ISOLATION_OVERRIDE",
    area: "Worker and provider",
    flag: "--isolation-override",
    description:
      "A reason. Lets jobs run on a provider weaker than their trust class requires. Audited and shown at the top of each affected job's log.",
  },
  {
    name: "LONGSHORE_JOB_TOKENS",
    area: "Worker and provider",
    default: "on",
    description: "Set to `off` to stop issuing a per-job GitHub token.",
  },
  // ---- Secrets and keys ----
  {
    name: "LONGSHORE_MASTER_KEY_FILE",
    area: "Secrets and keys",
    description:
      "32-byte master key file for the encrypted secret store (`longshore keys init`). Required for the GitHub App, its webhook endpoint, the vault and OIDC.",
  },
  {
    name: "LONGSHORE_SECRETS_PROXY",
    area: "Secrets proxy",
    default: "off",
    description:
      "Set to `1` on a worker that has the vault to run the secrets proxy: a job whose project has proxy rules runs with no route but the proxy.",
  },
  // ---- GitHub ----
  {
    name: "LONGSHORE_GITHUB_TOKEN",
    area: "GitHub",
    description:
      "A GitHub token used to resolve and verify actions and to poll, when the run's own credential (the poll token, or an App token) is not available.",
  },
  // ---- Secrets proxy ----
  {
    name: "LONGSHORE_PROXY_PORT",
    area: "Secrets proxy",
    default: "a free port",
    description: "Port of the secrets proxy listener.",
  },
  {
    name: "LONGSHORE_PROXY_BIND",
    area: "Secrets proxy",
    default: "the Docker bridge gateway on Linux, else `127.0.0.1`",
    description:
      "Address the proxy binds. `0.0.0.0` is an explicit opt-in (public listener) and logs a warning.",
  },
  {
    name: "LONGSHORE_PROXY_ADVERTISE_HOST",
    area: "Secrets proxy",
    default: "host.docker.internal",
    description: "How the provider's sandboxes name this machine.",
  },
  {
    name: "LONGSHORE_PROXY_ADVERTISE_PORT",
    area: "Secrets proxy",
    description: "The port to advertise when the platform forwards a different one.",
  },
  {
    name: "LONGSHORE_PROXY_ADVERTISE_ADDRESSES",
    area: "Secrets proxy",
    description:
      "Comma-separated stable IPv4 addresses of the listener. Required for the strict Daytona confinement, which allows exactly those.",
  },
  {
    name: "LONGSHORE_PROXY_TLS_CERT_FILE",
    area: "Secrets proxy",
    description:
      "Certificate (from a public CA) for a public TLS listener, for sandboxes in another provider's network. Set together with the key file.",
  },
  {
    name: "LONGSHORE_PROXY_TLS_KEY_FILE",
    area: "Secrets proxy",
    description: "Private key for the proxy's TLS listener.",
  },
  // ---- Release lane ----
  {
    name: "LONGSHORE_RELEASE_MASTER_KEY_FILE",
    area: "Release lane",
    description: "The release lane's own master key file. Read only by `serve --roles release`.",
  },
  {
    name: "LONGSHORE_RELEASE_DATA_DIR",
    area: "Release lane",
    description: "The release lane's own data directory.",
  },
  {
    name: "LONGSHORE_RELEASE_GITHUB_TOKEN",
    area: "Release lane",
    description: "The forge credential the lane uses to re-check a release (read access).",
  },
  {
    name: "LONGSHORE_RELEASE_GITHUB_PUBLISH_TOKEN",
    area: "Release lane",
    description: "Optional credential the lane uses to publish. Absent means it does not publish.",
  },
  {
    name: "LONGSHORE_RELEASE_ARTIFACT_DIR",
    area: "Release lane",
    description:
      "Directory laid out `<run id>/<name>` that the lane reads artifact bytes from (read-only).",
  },
  {
    name: "LONGSHORE_RELEASE_BUILDER_ID",
    area: "Release lane",
    description: "The builder id recorded in provenance.",
  },
  {
    name: "LONGSHORE_RELEASE_POLL_MS",
    area: "Release lane",
    default: "5000",
    description: "How often the lane looks for release requests (at least 100).",
  },
  // ---- Audit ----
  {
    name: "LONGSHORE_AUDIT_EXPORT_DIR",
    area: "Audit",
    description: "Rotate audit entries and checkpoints to JSONL files here.",
  },
  {
    name: "LONGSHORE_AUDIT_WEBHOOK_URL",
    area: "Audit",
    description:
      "POST audit batches here, signed with the secret file. A webhook on a private address needs `LONGSHORE_NET_ALLOW_HOSTS`.",
  },
  {
    name: "LONGSHORE_AUDIT_WEBHOOK_SECRET_FILE",
    area: "Audit",
    description:
      "File holding the HMAC secret for audit webhook batches (`x-longshore-signature: sha256=...`).",
  },
  // ---- OIDC ----
  {
    name: "LONGSHORE_OIDC_BASE_URL",
    area: "OIDC",
    default: "`<public url>/oidc`",
    description:
      "Base of the per-org OIDC issuers. An org's issuer is `<base>/<org slug>`. Needs the master key.",
  },
  {
    name: "LONGSHORE_OIDC_ALLOW_CLASSES",
    area: "OIDC",
    default: "protected,release",
    description:
      "Trust classes that may get an OIDC token. `untrusted_pr` is refused unless you list it, which you should not.",
  },
  // ---- Approvals ----
  {
    name: "LONGSHORE_WEBAUTHN_RP_ID",
    area: "Approvals",
    default: "the public URL's host",
    description: "WebAuthn relying party id for human approvals.",
  },
  {
    name: "LONGSHORE_WEBAUTHN_ORIGINS",
    area: "Approvals",
    default: "the public URL",
    description: "Comma-separated origins allowed for WebAuthn ceremonies.",
  },
  // ---- Channel and MCP clients ----
  {
    name: "LONGSHORE_TOKEN_FILE",
    area: "Channel and MCP clients",
    description:
      "Token file (mode 0600) for `longshore mcp` and `longshore channel`. A token is never taken from the command line.",
  },
  {
    name: "LONGSHORE_URL",
    area: "Channel and MCP clients",
    description: "Server URL for `longshore channel`.",
  },
  {
    name: "LONGSHORE_ORG",
    area: "Channel and MCP clients",
    description: "Org slug for `longshore channel`.",
  },
  {
    name: "LONGSHORE_CHANNEL_PROJECTS",
    area: "Channel and MCP clients",
    description: "Comma-separated project filter for `longshore channel`.",
  },
  {
    name: "LONGSHORE_CHANNEL_BRANCHES",
    area: "Channel and MCP clients",
    description: "Comma-separated branch filter for `longshore channel`.",
  },
  {
    name: "LONGSHORE_CHANNEL_TYPES",
    area: "Channel and MCP clients",
    description: "Comma-separated event types for `longshore channel`.",
  },
  {
    name: "LONGSHORE_CHANNEL_CONCLUSIONS",
    area: "Channel and MCP clients",
    description: "Comma-separated run conclusions for `longshore channel`.",
  },
  {
    name: "LONGSHORE_CHANNEL_STATE_FILE",
    area: "Channel and MCP clients",
    description: "Where `longshore channel` remembers the last event it sent.",
  },
  // ---- Process and privileges ----
  {
    name: "LONGSHORE_DROP_PRIVILEGES",
    area: "Process and privileges",
    description:
      "`<uid>:<gid>`. When started as root, take ownership of the files Longshore expects in the data directory and drop to that user before opening anything. The image sets `65532:65532`.",
  },
  {
    name: "LONGSHORE_ALLOW_ROOT",
    area: "Process and privileges",
    default: "off",
    description:
      "Set to `1` to keep running as root. Otherwise a server still root after startup is refused.",
  },
  {
    name: "LONGSHORE_STEP_GRACE",
    area: "Process and privileges",
    default: "5",
    description:
      "Seconds a step gets between TERM and KILL when it is stopped (set inside the job's step shim).",
  },
  // ---- Build ----
  {
    name: "LONGSHORE_VERSION",
    area: "Build",
    description:
      "Version for `scripts/build.ts` (a leading `v` is stripped); defaults to the root package.json version.",
  },
  {
    name: "LONGSHORE_SIGN_DARWIN",
    area: "Build",
    description:
      "Set to `1` for `scripts/build.ts` to re-sign the darwin binary with rcodesign and verify it.",
  },
  {
    name: "LONGSHORE_UI_BACKEND",
    area: "Build",
    description: "UI build default backend (`fixture` or `http`); set by `bun run dev`.",
  },
];

/**
 * Names that appear in the source but are not configuration an operator sets: constants, internal
 * markers between Longshore's own processes, and name prefixes.
 */
export const NOT_CONFIGURATION: readonly string[] = [
  "LONGSHORE_BUILD_VERSION", // replaced at compile time by scripts/build.ts
  "LONGSHORE_BUILD_TYPE", // a provenance constant
  "LONGSHORE_STEP_IO", // set by the step shim for the processes it starts
  "LONGSHORE_RELEASE", // the prefix of the release lane variables
];
