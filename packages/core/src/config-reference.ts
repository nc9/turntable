// The one typed list of the environment variables `turntable` reads, and the `serve` flag each
// stands for. docs/configuration.mdx's reference table is generated from it
// (scripts/config-reference.ts), and a test fails when the source reads a TURNTABLE_* variable
// that is not listed here, so the reference cannot drift from the code.

export type ConfigArea =
  | "Server"
  | "Worker and provider"
  | "Secrets and keys"
  | "GitHub"
  | "Secrets proxy"
  | "Job cache"
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
  "Job cache",
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
    name: "TURNTABLE_HOST",
    area: "Server",
    flag: "--host",
    default: "127.0.0.1",
    description: "Interface to bind. The container image sets `0.0.0.0`.",
  },
  {
    name: "TURNTABLE_DATA_DIR",
    area: "Server",
    flag: "--data-dir",
    default: "./data",
    description: "Directory that holds `turntable.db` and the files the server keeps.",
  },
  {
    name: "TURNTABLE_ROLES",
    area: "Server",
    flag: "--roles",
    description:
      "Which parts this process runs: `web`, `worker`, `poller`, `all` (those three), or `release`, which runs alone. Without it, `--worker` and `--poll` decide.",
  },
  {
    name: "TURNTABLE_PUBLIC_URL",
    area: "Server",
    flag: "--public-url",
    description:
      "The server's public base URL, linked from check runs and used for WebAuthn and OIDC defaults.",
  },
  {
    name: "TURNTABLE_ALLOWED_ORIGINS",
    area: "Server",
    flag: "--allowed-origin",
    description:
      "Comma-separated extra origins allowed to open the realtime WebSocket. The page's own origin is always allowed.",
  },
  {
    name: "TURNTABLE_TRUSTED_PROXIES",
    area: "Server",
    description:
      "Comma-separated addresses and CIDR ranges of the proxies in front of the server. The webhook failure limiter keys on the client address the forwarded chain reports through them. Required for correct client addresses behind a proxy.",
  },
  {
    name: "TURNTABLE_TRUST_FORWARDED_PROTO",
    area: "Server",
    default: "off",
    description:
      "Set to `1` behind a TLS-terminating proxy you control: plain-http requests it forwards get a 301 to https (GET and HEAD; 400 otherwise), and secret values sent over `x-forwarded-proto: https` are accepted.",
  },
  {
    name: "TURNTABLE_TRUST_FORWARDED_FOR",
    area: "Server",
    description:
      "No longer read (a warning is printed). Name your proxies in `TURNTABLE_TRUSTED_PROXIES`.",
  },
  {
    name: "TURNTABLE_HSTS_MAX_AGE",
    area: "Server",
    default: "31536000",
    description:
      "`Strict-Transport-Security` max-age in seconds on https responses. `0` or `off` disables it.",
  },
  {
    name: "TURNTABLE_HSTS_INCLUDE_SUBDOMAINS",
    area: "Server",
    default: "on",
    description: "Set to `0` to drop `includeSubDomains` from the HSTS header.",
  },
  {
    name: "TURNTABLE_BOOTSTRAP_TOKEN_SHA256",
    area: "Server",
    description:
      "sha256 of a token from `turntable token generate`. On boot, an org with no tokens gets one operator token with this hash.",
  },
  {
    name: "TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256",
    area: "Server",
    description:
      "sha256 of a token from `turntable token generate --instance`. On boot, an instance with no active (unexpired, unrevoked) instance token gets one instance-administrator token with this hash, expiring in 30 days at most. Otherwise it is ignored, and a hash that was registered before is never registered again. Rotate the token once, then remove the variable.",
  },
  {
    name: "TURNTABLE_INSTANCE_BOOTSTRAP_EXPIRY_DAYS",
    area: "Server",
    default: "30",
    description:
      "Lifetime in days of the bootstrap instance token, from 1 to 30. It can lower the limit, never raise it.",
  },
  {
    name: "TURNTABLE_BOOTSTRAP_ORG",
    area: "Server",
    default: "local",
    description: "The org that receives the bootstrap token.",
  },
  {
    name: "TURNTABLE_NET_ALLOW_HOSTS",
    area: "Server",
    description:
      "Comma-separated hostnames or IP literals the outbound HTTP client may reach even when they resolve to a private address (an audit webhook on a private network, a mock in tests). Everything else private is refused.",
  },
  {
    name: "TURNTABLE_HOSTED",
    area: "Server",
    flag: "--hosted",
    default: "off",
    description:
      "A hosted, multi-tenant instance: every job needs a `microvm` or `vm` provider and third-party provider plugins are disabled.",
  },
  {
    name: "TURNTABLE_CLAIM_INSTALLATIONS",
    area: "Server",
    default: "off",
    description:
      "Set to `1` on a hosted instance: an org claims its own GitHub App installation (`start_installation_claim`, then GitHub redirects to `/api/v1/github/setup`).",
  },
  // ---- Worker and provider ----
  {
    name: "TURNTABLE_WORKER",
    area: "Worker and provider",
    flag: "--worker",
    default: "off",
    description: "Run the scheduler and worker in this process.",
  },
  {
    name: "TURNTABLE_PROVIDER",
    area: "Worker and provider",
    flag: "--provider",
    default: "docker",
    description: "`docker` or `daytona`.",
  },
  {
    name: "TURNTABLE_PROVIDER_CONFIG",
    area: "Worker and provider",
    flag: "--provider-config",
    description: "Path of a JSON file of provider options. Secrets never go in it.",
  },
  {
    name: "TURNTABLE_PROVIDER_CONFIG_JSON",
    area: "Worker and provider",
    description:
      "The provider options as JSON, for hosts with no files. Used when no config file is named.",
  },
  {
    name: "TURNTABLE_POLL",
    area: "Worker and provider",
    flag: "--poll",
    description: "Path of the poller's JSON config.",
  },
  {
    name: "TURNTABLE_POLL_JSON",
    area: "Worker and provider",
    description: "The poller config as JSON, for hosts with no files. Used when no file is named.",
  },
  {
    name: "TURNTABLE_IMAGE",
    area: "Worker and provider",
    flag: "--image",
    default: "built in",
    description: "The image jobs run in (Docker).",
  },
  {
    name: "TURNTABLE_GLOBAL_CAP",
    area: "Worker and provider",
    flag: "--global-cap",
    default: "4",
    description: "Most jobs running at once across the instance.",
  },
  {
    name: "TURNTABLE_ORG_CAP",
    area: "Worker and provider",
    flag: "--org-cap",
    default: "2",
    description:
      "Most jobs running at once per org. A stored per-org quota (`set_quotas`) replaces it for that org.",
  },
  {
    name: "TURNTABLE_LEASE_SECONDS",
    area: "Worker and provider",
    flag: "--lease-seconds",
    default: "30",
    description: "How long a worker holds a claimed attempt without a heartbeat.",
  },
  {
    name: "TURNTABLE_ISOLATION_OVERRIDE",
    area: "Worker and provider",
    flag: "--isolation-override",
    description:
      "A reason. Lets jobs run on a provider weaker than their trust class requires. Audited and shown at the top of each affected job's log.",
  },
  {
    name: "TURNTABLE_JOB_TOKENS",
    area: "Worker and provider",
    default: "on",
    description: "Set to `off` to stop issuing a per-job GitHub token.",
  },
  // ---- Secrets and keys ----
  {
    name: "TURNTABLE_MASTER_KEY_FILE",
    area: "Secrets and keys",
    description:
      "32-byte master key file for the encrypted secret store (`turntable keys init`). Required for the GitHub App, its webhook endpoint, the vault and OIDC.",
  },
  {
    name: "TURNTABLE_MASTER_KEY",
    area: "Secrets and keys",
    description:
      "The master key itself: 32 bytes as base64 (`openssl rand -base64 32`) or 64 hex characters. It keeps the key off the data volume, so a volume backup does not hold the key next to what it unseals. Read once at boot and deleted from the environment before any child process starts. Setting it together with `TURNTABLE_MASTER_KEY_FILE` is an error.",
  },
  {
    name: "TURNTABLE_MASTER_KEY_PREVIOUS",
    area: "Secrets and keys",
    description:
      "The master key the sealed rows are under now, set together with the new key to rotate it. At boot every sealed row (secrets, vault versions, webhook secrets, audit anchor files) is re-encrypted under the new key in one transaction, verified and audited; on any failure nothing changes and the boot stops. Rows already under the new key are skipped, so it is safe to leave set for one more boot, but remove it once a new backup is taken. Same encoding as `TURNTABLE_MASTER_KEY`.",
  },
  {
    name: "TURNTABLE_MASTER_KEY_PREVIOUS_FILE",
    area: "Secrets and keys",
    description:
      "The previous master key as a 32-byte file, instead of `TURNTABLE_MASTER_KEY_PREVIOUS`.",
  },
  {
    name: "TURNTABLE_SECRETS_PROXY",
    area: "Secrets proxy",
    default: "off",
    description:
      "Set to `1` on a worker that has the vault to run the secrets proxy: a job whose project has proxy rules runs with no route but the proxy.",
  },
  // ---- GitHub ----
  {
    name: "TURNTABLE_GITHUB_TOKEN",
    area: "GitHub",
    description:
      "A GitHub token used to resolve and verify actions and to poll, when the run's own credential (the poll token, or an App token) is not available.",
  },
  // ---- Secrets proxy ----
  {
    name: "TURNTABLE_PROXY_PORT",
    area: "Secrets proxy",
    default: "a free port",
    description: "Port of the secrets proxy listener.",
  },
  {
    name: "TURNTABLE_PROXY_BIND",
    area: "Secrets proxy",
    default: "the Docker bridge gateway on Linux, else `127.0.0.1`",
    description:
      "Address the proxy binds. `0.0.0.0` is an explicit opt-in (public listener) and logs a warning.",
  },
  {
    name: "TURNTABLE_PROXY_ADVERTISE_HOST",
    area: "Secrets proxy",
    default: "host.docker.internal",
    description: "How the provider's sandboxes name this machine.",
  },
  {
    name: "TURNTABLE_PROXY_ADVERTISE_PORT",
    area: "Secrets proxy",
    description: "The port to advertise when the platform forwards a different one.",
  },
  {
    name: "TURNTABLE_PROXY_ADVERTISE_ADDRESSES",
    area: "Secrets proxy",
    description:
      "Comma-separated stable IPv4 addresses of the listener. Required for the strict Daytona confinement, which allows exactly those.",
  },
  {
    name: "TURNTABLE_PROXY_TLS_CERT_FILE",
    area: "Secrets proxy",
    description:
      "Certificate (from a public CA) for a public TLS listener, for sandboxes in another provider's network. Set together with the key file.",
  },
  {
    name: "TURNTABLE_PROXY_TLS_KEY_FILE",
    area: "Secrets proxy",
    description: "Private key for the proxy's TLS listener.",
  },
  // ---- Release lane ----
  {
    name: "TURNTABLE_RELEASE_MASTER_KEY_FILE",
    area: "Release lane",
    description: "The release lane's own master key file. Read only by `serve --roles release`.",
  },
  {
    name: "TURNTABLE_RELEASE_DATA_DIR",
    area: "Release lane",
    description: "The release lane's own data directory.",
  },
  {
    name: "TURNTABLE_RELEASE_GITHUB_TOKEN",
    area: "Release lane",
    description: "The forge credential the lane uses to re-check a release (read access).",
  },
  {
    name: "TURNTABLE_RELEASE_GITHUB_PUBLISH_TOKEN",
    area: "Release lane",
    description: "Optional credential the lane uses to publish. Absent means it does not publish.",
  },
  {
    name: "TURNTABLE_RELEASE_ARTIFACT_DIR",
    area: "Release lane",
    description:
      "Directory laid out `<run id>/<name>` that the lane reads artifact bytes from (read-only).",
  },
  {
    name: "TURNTABLE_RELEASE_BUILDER_ID",
    area: "Release lane",
    description: "The builder id recorded in provenance.",
  },
  {
    name: "TURNTABLE_RELEASE_POLL_MS",
    area: "Release lane",
    default: "5000",
    description: "How often the lane looks for release requests (at least 100).",
  },
  // ---- Audit ----
  {
    name: "TURNTABLE_AUDIT_EXPORT_DIR",
    area: "Audit",
    description: "Rotate audit entries and checkpoints to JSONL files here.",
  },
  {
    name: "TURNTABLE_AUDIT_WEBHOOK_URL",
    area: "Audit",
    description:
      "POST audit batches here, signed with the secret file. A webhook on a private address needs `TURNTABLE_NET_ALLOW_HOSTS`.",
  },
  {
    name: "TURNTABLE_AUDIT_WEBHOOK_SECRET_FILE",
    area: "Audit",
    description:
      "File holding the HMAC secret for audit webhook batches (`x-longshore-signature: sha256=...`).",
  },
  // ---- OIDC ----
  {
    name: "TURNTABLE_OIDC_BASE_URL",
    area: "OIDC",
    default: "`<public url>/oidc`",
    description:
      "Base of the per-org OIDC issuers. An org's issuer is `<base>/<org slug>`. Needs the master key.",
  },
  {
    name: "TURNTABLE_OIDC_ALLOW_CLASSES",
    area: "OIDC",
    default: "protected,release",
    description:
      "Trust classes that may get an OIDC token. `untrusted_pr` is refused unless you list it, which you should not.",
  },
  // ---- Approvals ----
  {
    name: "TURNTABLE_WEBAUTHN_RP_ID",
    area: "Approvals",
    default: "the public URL's host",
    description: "WebAuthn relying party id for human approvals.",
  },
  {
    name: "TURNTABLE_WEBAUTHN_ORIGINS",
    area: "Approvals",
    default: "the public URL",
    description: "Comma-separated origins allowed for WebAuthn ceremonies.",
  },
  // ---- Channel and MCP clients ----
  {
    name: "TURNTABLE_TOKEN_FILE",
    area: "Channel and MCP clients",
    description:
      "Token file (mode 0600) for `turntable mcp` and `turntable channel`. A token is never taken from the command line.",
  },
  {
    name: "TURNTABLE_URL",
    area: "Channel and MCP clients",
    description: "Server URL for `turntable channel`.",
  },
  {
    name: "TURNTABLE_ORG",
    area: "Channel and MCP clients",
    description: "Org slug for `turntable channel`.",
  },
  {
    name: "TURNTABLE_CHANNEL_PROJECTS",
    area: "Channel and MCP clients",
    description: "Comma-separated project filter for `turntable channel`.",
  },
  {
    name: "TURNTABLE_CHANNEL_BRANCHES",
    area: "Channel and MCP clients",
    description: "Comma-separated branch filter for `turntable channel`.",
  },
  {
    name: "TURNTABLE_CHANNEL_TYPES",
    area: "Channel and MCP clients",
    description: "Comma-separated event types for `turntable channel`.",
  },
  {
    name: "TURNTABLE_CHANNEL_CONCLUSIONS",
    area: "Channel and MCP clients",
    description: "Comma-separated run conclusions for `turntable channel`.",
  },
  {
    name: "TURNTABLE_CHANNEL_STATE_FILE",
    area: "Channel and MCP clients",
    description: "Where `turntable channel` remembers the last event it sent.",
  },
  // ---- Process and privileges ----
  {
    name: "TURNTABLE_DROP_PRIVILEGES",
    area: "Process and privileges",
    description:
      "`<uid>:<gid>`. When started as root, take ownership of the files Turntable expects in the data directory and drop to that user before opening anything. The image sets `65532:65532`.",
  },
  {
    name: "TURNTABLE_ALLOW_ROOT",
    area: "Process and privileges",
    default: "off",
    description:
      "Set to `1` to keep running as root. Otherwise a server still root after startup is refused.",
  },
  {
    name: "TURNTABLE_STEP_GRACE",
    area: "Process and privileges",
    default: "5",
    description:
      "Seconds a step gets between TERM and KILL when it is stopped (set inside the job's step shim).",
  },
  // ---- Build ----
  {
    name: "TURNTABLE_VERSION",
    area: "Build",
    description:
      "Version for `scripts/build.ts` (a leading `v` is stripped); defaults to the root package.json version.",
  },
  {
    name: "TURNTABLE_SIGN_DARWIN",
    area: "Build",
    description:
      "Set to `1` for `scripts/build.ts` to re-sign the darwin binary with rcodesign and verify it.",
  },
  {
    name: "TURNTABLE_DIST",
    area: "Build",
    description:
      "Output directory of `scripts/build.ts` (the reproducibility check builds twice into two directories).",
  },
  {
    name: "TURNTABLE_UI_BACKEND",
    area: "Build",
    description: "UI build default backend (`fixture` or `http`); set by `bun run dev`.",
  },
  // ---- the checkout child (control plane fetches a run's commit without git) ----
  {
    name: "TURNTABLE_CHECKOUT_TIMEOUT_SECONDS",
    area: "Worker and provider",
    default: "300",
    description:
      "Wall-clock deadline for one run's checkout (10 to 3600 seconds). The checkout child is killed when it passes.",
  },
  {
    name: "TURNTABLE_CHECKOUT_MAX_MEMORY_MIB",
    area: "Worker and provider",
    default: "1536",
    description:
      "Resident-memory ceiling of the checkout child, read from `/proc` on Linux (0 turns it off; other systems log once that it is not enforced).",
  },
  {
    name: "TURNTABLE_CHECKOUT_CONCURRENCY",
    area: "Worker and provider",
    default: "2",
    description: "Checkouts that may run at once (1 to 16).",
  },
  {
    name: "TURNTABLE_CHECKOUT_MAX_PACK_MIB",
    area: "Worker and provider",
    default: "128",
    description: "Largest pack a checkout accepts from the forge (1 to 4096 MiB).",
  },
  {
    name: "TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB",
    area: "Worker and provider",
    default: "512",
    description: "Most a checkout may unpack in total (1 to 16384 MiB).",
  },
  {
    name: "TURNTABLE_CHECKOUT_MAX_TARBALL_MIB",
    area: "Worker and provider",
    default: "256",
    description: "Largest tarball the checkout child may hand back (1 to 4096 MiB).",
  },
  // ---- added with the hosted and Postgres work ----
  {
    name: "TURNTABLE_DATABASE_URL",
    area: "Server",
    flag: "--database-url",
    default: "SQLite in the data dir",
    description:
      "Postgres connection URL. Every subcommand that opens the database uses it. See [Postgres](/postgres).",
  },
  {
    name: "TURNTABLE_UI_DIR",
    area: "Server",
    default: "`packages/ui/dist`",
    description:
      "Serve the web UI from this directory (it needs an `index.html`). Only for a run from source: the compiled binary serves its embedded UI and ignores it with a warning.",
  },
  {
    name: "TURNTABLE_MASTER_KEY_AUTOINIT",
    area: "Secrets and keys",
    flag: "--init-master-key",
    default: "off",
    description:
      "Set to `1` to create `TURNTABLE_MASTER_KEY_FILE` on first boot when it is absent, for a platform with no shell. It is written once, complete and private, and an existing file is never overwritten; of two replicas starting together exactly one creates it. Needs `TURNTABLE_MASTER_KEY_FILE`, and is refused with `TURNTABLE_MASTER_KEY`. Back the key up: without it stored secrets cannot be opened.",
  },
  {
    name: "TURNTABLE_REQUIRE_ORG_KEYS",
    area: "Secrets and keys",
    default: "off",
    description:
      "Set to `1` after `turntable keys reseal` has run for every org: a sealed record that is not under its org's own key is then refused wherever the org is known, and `keys reseal` itself refuses to run while it is set. See [Secrets vault](/secrets-vault#per-org-keys).",
  },
  {
    name: "TURNTABLE_PROVIDER_PLUGINS",
    area: "Worker and provider",
    description:
      'A JSON array of `{ "name", "path", "sha256" }`: external provider plugins, each loaded only if the file at `path` has that digest. Never in hosted mode. See [Providers](/providers).',
  },
  {
    name: "TURNTABLE_CONFIG",
    area: "Server",
    flag: "--config",
    description:
      "Path of a `turntable.toml` of settings. An unknown key or a bad value stops the boot, naming the key and the file; no file is fine. The environment beats the file. See [Settings registry](#settings-registry).",
  },
  {
    name: "TURNTABLE_BACKUP_BEFORE_MIGRATE",
    area: "Server",
    description:
      "Set to `1` to back up the SQLite database at boot when migrations are pending, before they run. A failed backup stops the boot. See [Backups](/instance-admin#backups).",
  },
  {
    name: "TURNTABLE_BACKUP_KEEP",
    area: "Server",
    default: "10",
    description:
      "How many backups to keep under `<data-dir>/backups`. The environment name of the `backup_keep` setting, which `turntable.toml` and `instance_set_setting` also set.",
  },
  {
    name: "TURNTABLE_SANDBOX_SIZES_JSON",
    area: "Worker and provider",
    description:
      "The sandbox size map (JSON): which `runs-on` labels get how many CPUs and how much memory. Set only one of this and `TURNTABLE_SANDBOX_SIZES_FILE`. A run classified `untrusted_pr` gets `untrustedClass`, then `default`, then the provider's own size: set `untrustedClass` to a small class on a hosted or multi-tenant instance (see [Hosted](/hosted#sandbox-sizes-set-untrustedclass-explicitly)). See [Sandbox size per job](/providers#sandbox-size-per-job).",
  },
  {
    name: "TURNTABLE_SANDBOX_SIZES_FILE",
    area: "Worker and provider",
    description:
      "A file holding the sandbox size map. The same as `TURNTABLE_SANDBOX_SIZES_JSON`, including the `untrustedClass` advice: set it to a small class on a hosted or multi-tenant instance.",
  },
  {
    name: "TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256",
    area: "GitHub",
    description:
      "sha256 (64 hex characters) of a setup token (`turntable token generate`). Turns on creating the GitHub App from the instance, for a host with no shell. Needs `TURNTABLE_PUBLIC_URL` and a master key. The route closes after the first success and 6 hours after start; remove the variable when you are done. See [Hosted deployment](/hosted).",
  },
  {
    name: "TURNTABLE_GITHUB_TOKEN_FILE",
    area: "GitHub",
    description:
      "A file holding a GitHub token for `turntable parity`, to avoid the unauthenticated rate limit. Never taken from the command line.",
  },
  {
    name: "TURNTABLE_CACHE_URL",
    area: "Job cache",
    description:
      "The base URL jobs reach the control-plane cache at, no trailing slash. Setting it turns the cache on. See [Job cache](/cache).",
  },
  {
    name: "TURNTABLE_CACHE_QUOTA_GIB",
    area: "Job cache",
    default: "10",
    description: "GiB an org may hold in the cache in total, split between trust classes.",
  },
  {
    name: "TURNTABLE_CACHE_MAX_ENTRY_GIB",
    area: "Job cache",
    default: "2",
    description: "GiB of the largest single cache entry.",
  },
  {
    name: "TURNTABLE_PUBLISH_CHANNEL_KEY_FILE",
    area: "Release lane",
    description:
      "On the worker: the request key it shares with the release lane (`TURNTABLE_RELEASE_CHANNEL_KEY_FILE`), enabling compat publishing. Set it with the socket or the URL below. See [Release lane](/release-lane#how-a-job-gets-its-credential-the-release-channel).",
  },
  {
    name: "TURNTABLE_PUBLISH_CHANNEL_SOCKET",
    area: "Release lane",
    description: "On the worker: the unix socket of the release channel (same host as the lane).",
  },
  {
    name: "TURNTABLE_PUBLISH_CHANNEL_URL",
    area: "Release lane",
    description:
      "On the worker: the release channel as `host:port` over mutual TLS (split hosts), instead of the socket. Needs `_TLS_CERT_FILE`, `_TLS_KEY_FILE` and `_TLS_CA_FILE` (same prefix).",
  },
  {
    name: "TURNTABLE_PUBLISH_CHANNEL_TLS_CERT_FILE",
    area: "Release lane",
    description: "On the worker: its client certificate for the release channel.",
  },
  {
    name: "TURNTABLE_PUBLISH_CHANNEL_TLS_KEY_FILE",
    area: "Release lane",
    description: "On the worker: the private key of that certificate.",
  },
  {
    name: "TURNTABLE_PUBLISH_CHANNEL_TLS_CA_FILE",
    area: "Release lane",
    description: "On the worker: the CA that signed the lane's certificate.",
  },
  {
    name: "TURNTABLE_RELEASE_CHANNEL_KEY_FILE",
    area: "Release lane",
    description:
      "On the lane: the request key shared with the worker. Needs the release proxy (`TURNTABLE_RELEASE_PROXY_PORT`).",
  },
  {
    name: "TURNTABLE_RELEASE_CHANNEL_SOCKET",
    area: "Release lane",
    default: "`<data dir>/channel.sock`",
    description: "On the lane: the unix socket the release channel listens on (mode 0600).",
  },
  {
    name: "TURNTABLE_RELEASE_CHANNEL_TCP",
    area: "Release lane",
    description:
      "On the lane: listen on `host:port` with mutual TLS instead of the socket, for split hosts. Needs `_TLS_CERT_FILE`, `_TLS_KEY_FILE` and `_TLS_CA_FILE` (same prefix).",
  },
  {
    name: "TURNTABLE_RELEASE_CHANNEL_TLS_CERT_FILE",
    area: "Release lane",
    description: "On the lane: its server certificate for the TCP channel.",
  },
  {
    name: "TURNTABLE_RELEASE_CHANNEL_TLS_KEY_FILE",
    area: "Release lane",
    description: "On the lane: the private key of that certificate.",
  },
  {
    name: "TURNTABLE_RELEASE_CHANNEL_TLS_CA_FILE",
    area: "Release lane",
    description: "On the lane: the CA that signs the worker's client certificate.",
  },
  {
    name: "TURNTABLE_RELEASE_PROXY_PORT",
    area: "Release lane",
    description:
      "On the lane: the port of its release proxy (`0` for any free port). Setting it turns the proxy on.",
  },
  {
    name: "TURNTABLE_RELEASE_PROXY_BIND",
    area: "Release lane",
    default: "`127.0.0.1`",
    description: "On the lane: the interface the release proxy binds.",
  },
  {
    name: "TURNTABLE_RELEASE_PROXY_ADVERTISE_HOST",
    area: "Release lane",
    description: "On the lane: how the worker's sandboxes name the release proxy.",
  },
  {
    name: "TURNTABLE_RELEASE_PROXY_ADVERTISE_PORT",
    area: "Release lane",
    description: "On the lane: the port sandboxes are told, when it differs from the one bound.",
  },
  {
    name: "TURNTABLE_RELEASE_PROXY_ADVERTISE_ADDRESSES",
    area: "Release lane",
    description:
      "On the lane: comma-separated stable addresses of the proxy, for a provider that filters by address.",
  },
  {
    name: "TURNTABLE_RELEASE_PROXY_TLS_CERT_FILE",
    area: "Release lane",
    description:
      "On the lane: a certificate, to serve the release proxy over TLS on a public name.",
  },
  {
    name: "TURNTABLE_RELEASE_PROXY_TLS_KEY_FILE",
    area: "Release lane",
    description: "On the lane: the private key of that certificate.",
  },
];

/**
 * Names that appear in the source but are not configuration an operator sets: constants, internal
 * markers between Turntable's own processes, and name prefixes.
 */
export const NOT_CONFIGURATION: readonly string[] = [
  "TURNTABLE_BUILD_VERSION", // replaced at compile time by scripts/build.ts
  "TURNTABLE_BUILD_TYPE", // a provenance constant
  "TURNTABLE_STEP_IO", // set by the step shim for the processes it starts
  "TURNTABLE_RELEASE", // the prefix of the release lane variables
  "TURNTABLE_CHECKOUT", // the prefix of the checkout variables
  "TURNTABLE_CI", // an example project var name in the `policy set --var` help text
  "TURNTABLE_TEST_DB", // the test harness: run the suites against Postgres
  "TURNTABLE_TEST_PGLITE_ISOLATED", // the test harness
];
