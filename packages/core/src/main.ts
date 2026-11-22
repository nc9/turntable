import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Provider } from "@longshore/provider-sdk";
import { type Db, ensureInstance, getAttempt, openDatabase } from "./db";
import { githubFacts } from "./github/api";
import { CheckReporter } from "./checks/reporter";
import { githubCheckRunsApi } from "./checks/client";
import { AppAuth } from "./github/app-auth";
import { registerCredentialRevoker } from "./incident";
import { createForgeToken } from "./pins/forge-token";
import { parseTrustedProxies } from "./github/trusted-proxies";
import { createWebhookHandler, type WebhookHandler } from "./github/webhook";
import {
  createClaimHandler,
  githubUserVerifier,
  InstallationClaims,
  type ClaimHandler,
} from "./github/claim";
import { AuditAnchor } from "./audit/anchor";
import { startCheckpointer } from "./audit/checkpoint";
import { jsonlSink, startExporter, webhookSink, type AuditSink } from "./audit/export";
import { bootstrapToken } from "./ops/bootstrap";
import { loadMasterKey } from "./secrets/crypto";
import { SecretStore } from "./secrets/store";
import { relyingPartyFromEnv } from "./approvals/config";
import { createOidcHandler, type OidcHandler } from "./oidc/http";
import { OidcIssuer, parseAllowClasses } from "./oidc/issuer";
import { githubTargetOf, SecretsProxy, withSecretsProxy } from "./proxy";
import { JobTokens, publicRepoCheck } from "./github/job-token";
import { CacheGrants } from "./cache/grants";
import { jobCacheProvider } from "./cache/job";
import { createCacheService, type CacheService } from "./cache/service";
import { FsCacheStore } from "./cache/store";
import { SecretVault } from "./secrets/vault";
import { generateToken, hashToken } from "./ops/tokens";
import { Poller } from "./poll";
import { resolvePollConfig, resolveProviderConfig, serveDefaults } from "./serve-config";
import {
  createActRunner,
  createProvider,
  gitRepoSource,
  reconcileExpired,
  type AttemptRunner,
  Scheduler,
  withEgressPolicy,
  withIsolationPolicy,
} from "./scheduler";
import { createTokenFromCli, listTokensFromCli, revokeTokenFromCli } from "./ops/token-cli";
import { dropForCommand } from "./command-privileges";
import { enforceRootPolicy } from "./privileges";
import { mainRuntime, resolveRoles } from "./roles";
import { createChannelClient, withReleaseChannel } from "./release/channel-client";
import { serveRelease } from "./release/serve";
import { startServer } from "./server";
import { transportOptionsFromEnv } from "./transport";
import { VERSION } from "./version";

const USAGE = `longshore ${VERSION}

Usage:
  longshore serve [--roles web,worker,poller|all|release] [--port 8080] [--host 127.0.0.1] [--data-dir ./data]
                  [--allowed-origin <origin>]
                  [--public-url <base url>]
                  [--worker [--provider docker|daytona] [--provider-config <file>] [--global-cap 4]
                   [--org-cap 2] [--lease-seconds 30] [--image <ref>] [--hosted]
                   [--isolation-override <reason>]]
                  [--poll <config.json>]
  longshore oidc status|rotate|export --org <slug> (see longshore oidc)
  longshore secret set|rotate|delete|list --org <slug> --name <NAME> (--value-file <path> | --value-stdin)
  longshore audit init-key|adopt|verify|checkpoint|export-key|export (see longshore audit)
  longshore policy show | set [--org local] [--project local] [--require-sha-pins true|false]
                              [--allow-owners a,b | --clear-allowlist] [--data-dir ./data]
  longshore keys init [--file <path>] [--data-dir ./data]
  longshore github-app create --url <public base url> [--org <github org>] [--name Longshore]
                              [--longshore-org local] [--master-key-file <path>]
  longshore github-app rotate-webhook-secret | status [--master-key-file <path>] [--data-dir ./data]
  longshore token create --org <slug> [--project <slug>] --role <reader|operator|release_operator>
                         --name <name> [--expires-days 90] [--data-dir ./data]
  longshore token generate
  longshore token list --org <slug> [--project <slug>] [--data-dir ./data]
  longshore token revoke <id> [--data-dir ./data]
  longshore run <workflow-path> -j <job> [--repo <dir>] [--image <ref>] [--data-dir ./data] [--event push] [--egress none|open]
  longshore policy set approve-run-min-role <operator|release_operator> [--org local]
  longshore policy set --egress <none|open|allowlist> [--org local] [--project <slug>]
  longshore policy set --checks-mode <off|shadow|live> [--org local] [--project <slug>]
  longshore mcp [--token-file <path>] [--data-dir ./data]
  longshore approvals keygen|bootstrap|sign|policy|list|revoke ...   (human approvals; see docs/security.mdx)
  longshore incident freeze|unfreeze|status --org <slug> [--project <slug>] [--reason <text>]
  longshore quotas show|set --org <slug> [--max-concurrent <n|none> ...] [--data-dir ./data]
  longshore artifacts list|check --url <https://host> --org <slug> --project <slug> [--run <id>] [--token-file <path>]
  longshore quotas get --url <https://host> --org <slug> [--token-file <path>]  (remote read)
  longshore channel --url <https://host> --org <slug> [--token-file <path>] [--project a,b]
                    [--branch main] [--types run.finished,approval.required] [--state-file <path>]
  longshore verify <artifact> --provenance <file> --pubkey <file> [--name <subject>]
  longshore version

Environment:
  PORT  default for --port (Railway and similar hosts set it)
  LONGSHORE_BOOTSTRAP_TOKEN_SHA256  sha256 of a token from "longshore token generate"; on boot, an
                    org with no tokens gets one operator token with this hash
  LONGSHORE_BOOTSTRAP_ORG  org for the bootstrap token (default local)
  LONGSHORE_MASTER_KEY_FILE  32-byte master key file for the encrypted secret store (longshore keys init);
                    required for the GitHub App and its webhook endpoint
  LONGSHORE_AUDIT_EXPORT_DIR  rotate audit entries and checkpoints to JSONL files here
  LONGSHORE_AUDIT_WEBHOOK_URL  POST audit batches here (HMAC with LONGSHORE_AUDIT_WEBHOOK_SECRET_FILE)
  LONGSHORE_OIDC_BASE_URL  base of the per-org OIDC issuers (default <public url>/oidc); an org's issuer
                    is <base>/<org slug>. Needs LONGSHORE_MASTER_KEY_FILE
  LONGSHORE_OIDC_ALLOW_CLASSES  trust classes that may get an OIDC token (default protected,release;
                    untrusted_pr is refused unless you list it, which you should not)
  LONGSHORE_TRUST_FORWARDED_PROTO  set to 1 behind a TLS-terminating proxy you control: plain-http requests it
                    forwards get a 301 to https (GET and HEAD; 400 otherwise), and secret values
                    sent over x-forwarded-proto: https are accepted
  LONGSHORE_HSTS_MAX_AGE  Strict-Transport-Security max-age in seconds for https responses (default 31536000;
                    0 or off disables); LONGSHORE_HSTS_INCLUDE_SUBDOMAINS=0 drops includeSubDomains
  LONGSHORE_DROP_PRIVILEGES  <uid>:<gid>; when started as root, chown the data dir to it and drop to it
                    before opening anything (the image sets 65532:65532)
  LONGSHORE_ALLOW_ROOT  set to 1 to keep running as root (otherwise a root server is refused)
  LONGSHORE_RELEASE_*  belong to "serve --roles release" alone (its own master key file, data dir, forge
                    token, artifact dir): the release lane runs as its own process and no other role reads them
  LONGSHORE_TOKEN_FILE  token file for "longshore mcp" (mode 0600; never pass a token on the command line)
  LONGSHORE_WEBAUTHN_RP_ID, LONGSHORE_WEBAUTHN_ORIGINS  WebAuthn relying party for human approvals (default: the public URL)
  LONGSHORE_CACHE_URL  base URL jobs reach the control-plane cache at (enables it; see docs/cache.mdx)
  LONGSHORE_CACHE_QUOTA_GIB, LONGSHORE_CACHE_MAX_ENTRY_GIB  per-org cache quota (default 10) and largest entry (default 2)
  LONGSHORE_PUBLIC_URL  default for --public-url: the server's public base URL, linked from check runs
  LONGSHORE_TRUSTED_PROXIES  comma-separated addresses and CIDR ranges of the proxies in front of the server;
                    the webhook failure limiter keys on the client the forwarded chain reports through them
  LONGSHORE_CLAIM_INSTALLATIONS  set to 1 on a hosted instance: an org claims its own App installation
                    (start_installation_claim, then GitHub redirects to /api/v1/github/setup)
  LONGSHORE_WORKER, LONGSHORE_PROVIDER, LONGSHORE_PROVIDER_CONFIG, LONGSHORE_POLL, LONGSHORE_IMAGE,
  LONGSHORE_GLOBAL_CAP, LONGSHORE_ORG_CAP, LONGSHORE_LEASE_SECONDS, LONGSHORE_ISOLATION_OVERRIDE, LONGSHORE_DATA_DIR
                    the environment equivalent of each serve flag (a flag wins)
  LONGSHORE_POLL_JSON, LONGSHORE_PROVIDER_CONFIG_JSON  the poll and provider configs as JSON, for hosts with no files
  LONGSHORE_HOST  default for --host (the container image sets 0.0.0.0)
  LONGSHORE_ALLOWED_ORIGINS  comma-separated extra origins allowed to open the realtime WebSocket
`;

/** Starts the worker and the poller when asked for. Returns a stop function. */
async function startBackground(
  db: Db,
  v: {
    worker?: boolean | undefined;
    "global-cap"?: string | undefined;
    "org-cap"?: string | undefined;
    "lease-seconds"?: string | undefined;
    image?: string | undefined;
    poll?: string | undefined;
    provider?: string | undefined;
    "provider-config"?: string | undefined;
    hosted?: boolean | undefined;
    "isolation-override"?: string | undefined;
  },
  observer?: CheckReporter,
  extras: { auth?: AppAuth; vault?: SecretVault; cache?: CacheService } = {},
): Promise<{ stop(): Promise<void>; nudge(repo: string): boolean }> {
  const log = (m: string) => console.log(`[longshore] ${m}`);
  // Loaded first: the worker uses the poll token to resolve actions for the repos it watches.
  const pollConfig = resolvePollConfig(v.poll);
  let scheduler: Scheduler | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let poller: Poller | undefined;
  let workerProvider: Provider | undefined;
  let secretsProxy: SecretsProxy | undefined;

  if (v.worker) {
    const providerName = v.provider ?? "docker";
    const provider = createProvider(providerName, resolveProviderConfig(v["provider-config"]), {
      hosted: v.hosted === true || process.env.LONGSHORE_HOSTED === "1",
    });
    workerProvider = provider;
    // Fail at startup, with the provider named, instead of at the first job.
    try {
      await provider.healthcheck();
    } catch (err) {
      throw new Error(
        `provider ${providerName} is not usable: ${err instanceof Error ? err.message : "error"}`,
        { cause: err },
      );
    }
    // One provider per server for now; the name stored on an attempt is the provider it was made for.
    const providers = () => provider;
    const override = v["isolation-override"]?.trim();
    if (v["isolation-override"] !== undefined && !override) {
      throw new Error(
        "--isolation-override needs a reason (it is audited and shown on affected runs)",
      );
    }
    if (override) log(`isolation override ON: ${override}`);
    const leaseMs = Number(v["lease-seconds"]) * 1000;
    const num = (name: string, value: string | undefined): number => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`invalid --${name}: ${value}`);
      return n;
    };
    // The secrets proxy (#15): opt in, and only with a vault. A job whose project has proxy rules
    // runs with no route but the proxy; see docs/secrets-proxy.mdx.
    if (process.env.LONGSHORE_SECRETS_PROXY === "1") {
      if (!extras.vault) {
        throw new Error("LONGSHORE_SECRETS_PROXY=1 needs the vault (LONGSHORE_MASTER_KEY_FILE)");
      }
      const port = process.env.LONGSHORE_PROXY_PORT?.trim();
      secretsProxy = await SecretsProxy.start({
        db,
        vault: extras.vault,
        ...(port ? { port: Number(port) } : {}),
        ...(process.env.LONGSHORE_PROXY_BIND?.trim()
          ? { bindHost: process.env.LONGSHORE_PROXY_BIND.trim() }
          : {}),
        ...(process.env.LONGSHORE_PROXY_ADVERTISE_HOST?.trim()
          ? { advertiseHost: process.env.LONGSHORE_PROXY_ADVERTISE_HOST.trim() }
          : {}),
        // A public TLS listener, for sandboxes in another provider's network (Daytona).
        ...(process.env.LONGSHORE_PROXY_TLS_CERT_FILE?.trim() ||
        process.env.LONGSHORE_PROXY_TLS_KEY_FILE?.trim()
          ? { tls: readProxyTls() }
          : {}),
        ...(process.env.LONGSHORE_PROXY_ADVERTISE_PORT?.trim()
          ? { advertisePort: Number(process.env.LONGSHORE_PROXY_ADVERTISE_PORT.trim()) }
          : {}),
        ...(process.env.LONGSHORE_PROXY_ADVERTISE_ADDRESSES?.trim()
          ? {
              advertiseAddresses: process.env.LONGSHORE_PROXY_ADVERTISE_ADDRESSES.split(",")
                .map((a) => a.trim())
                .filter(Boolean),
            }
          : {}),
        log,
      });
      log(`secrets proxy listening on port ${secretsProxy.port}`);
    }
    // A GitHub token per job (see github/job-token), when the App is configured.
    const jobTokens =
      extras.auth && process.env.LONGSHORE_JOB_TOKENS !== "off"
        ? new JobTokens(extras.auth, { isPublic: publicRepoCheck({ auth: extras.auth }) })
        : undefined;
    // Compat publishing: a release-class job may ask the release lane for a release-proxy
    // credential. This process holds only the request key, never a publish credential.
    const channelKey = process.env.LONGSHORE_PUBLISH_CHANNEL_KEY_FILE?.trim();
    const publishChannel = channelKey
      ? createChannelClient({
          key: readFileSync(channelKey, "utf8").trim(),
          target: process.env.LONGSHORE_PUBLISH_CHANNEL_URL?.trim()
            ? {
                url: process.env.LONGSHORE_PUBLISH_CHANNEL_URL.trim(),
                tls: {
                  cert: readFileSync(
                    requiredEnv("LONGSHORE_PUBLISH_CHANNEL_TLS_CERT_FILE"),
                    "utf8",
                  ),
                  key: readFileSync(requiredEnv("LONGSHORE_PUBLISH_CHANNEL_TLS_KEY_FILE"), "utf8"),
                  ca: readFileSync(requiredEnv("LONGSHORE_PUBLISH_CHANNEL_TLS_CA_FILE"), "utf8"),
                },
              }
            : { unix: requiredEnv("LONGSHORE_PUBLISH_CHANNEL_SOCKET") },
        })
      : undefined;
    const released = (r: AttemptRunner): AttemptRunner =>
      publishChannel ? withReleaseChannel(r, { client: publishChannel }) : r;
    const proxied = (r: AttemptRunner): AttemptRunner =>
      secretsProxy
        ? withSecretsProxy(r, {
            proxy: secretsProxy,
            ...(jobTokens ? { github: githubTargetOf(db) } : {}),
          })
        : r;
    scheduler = new Scheduler({
      db,
      providers,
      // Jobs never start on a provider weaker than their trust class allows (see isolation.ts).
      runner: withIsolationPolicy(
        // Egress is none by default and refused where it cannot be enforced; each `none`
        // sandbox is probed for a real way out before the job starts.
        proxied(
          released(
            withEgressPolicy(
              createActRunner({
                db,
                source: gitRepoSource(),
                // Actions are resolved and verified with the run's own GitHub credential: the poll
                // token, else an App token read-only for that repo, else LONGSHORE_GITHUB_TOKEN.
                forgeToken: createForgeToken({
                  db,
                  poll: pollConfig,
                  auth: extras.auth,
                  envToken: process.env.LONGSHORE_GITHUB_TOKEN?.trim() || undefined,
                  log: (m) => console.warn(`[longshore] ${m}`),
                }),
                canary: true,
                ...(jobTokens ? { jobTokens } : {}),
                ...(extras.cache ? { cache: jobCacheProvider(db, extras.cache) } : {}),
                ...(v.image ? { image: v.image } : {}),
              }),
              // A job behind the proxy holds secrets: it never runs with open egress.
              { secretBearing: (ctx) => ctx.proxy?.vaultRules === true },
            ),
          ),
        ),
        {
          db,
          hosted: v.hosted === true || process.env.LONGSHORE_HOSTED === "1",
          ...(override ? { override: { reason: override } } : {}),
        },
      ),
      leaseMs,
      ...(observer ? { observer } : {}),
      globalCap: num("global-cap", v["global-cap"]),
      perOrgCap: num("org-cap", v["org-cap"]),
      log,
    });
    const sched = scheduler;
    const reconcile = () =>
      reconcileExpired(db, providers, {
        log,
        owner: sched.owner,
        leaseMs,
        // Re-attach to execs a dead worker left behind: the real result is recovered by replay.
        adopt: (claim, resume) => sched.adopt(claim, resume),
      });
    // Boot reconcile before claiming: abandoned attempts are re-attached or resolved first.
    const report = await reconcile();
    if (report.resolved.length + report.adopted.length > 0) {
      log(
        `reconciled: ${report.adopted.length} re-attached, ${report.resolved.length} marked infra_error`,
      );
    }
    scheduler.start();
    reconcileTimer = setInterval(
      () => {
        void reconcile().catch((e) => log(`reconcile failed: ${String(e)}`));
      },
      Math.max(leaseMs, 10_000),
    );
    log("worker started");
  }

  if (pollConfig) {
    if (v.worker && pollConfig.provider !== (v.provider ?? "docker")) {
      throw new Error(
        `poll config provider "${pollConfig.provider}" does not match --provider ${v.provider ?? "docker"}`,
      );
    }
    poller = new Poller({
      db,
      config: pollConfig,
      // Repos bound by an installation are ingested once their project has ingest settings.
      bindings: true,
      log,
      onQueued: () => scheduler?.nudge(),
      // A newer cancel-in-progress run took over running attempts: stop their workers now and
      // destroy their sandboxes (the worker's own cleanup is the same; this is the backstop).
      onSuperseded: (running) => {
        scheduler?.abort(running.map((r) => r.attemptId));
        for (const r of running) {
          if (r.sandboxId && workerProvider) {
            void workerProvider
              .destroy(r.sandboxId)
              .catch((e) => log(`could not destroy sandbox: ${String(e)}`));
          }
        }
      },
    });
    poller.start();
    log(`polling per ${v.poll}`);
  }

  return {
    nudge: (repo) => poller?.nudge(repo) ?? false,
    async stop() {
      poller?.stop();
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (scheduler) {
        // Stop claiming, give running attempts a moment, then leave the rest: their leases
        // expire and the next boot's reconcile re-attaches to them. Never abort them
        // here, which would record a user cancel that never happened.
        await Promise.race([scheduler.stop(), Bun.sleep(10_000)]);
      }
      await secretsProxy?.stop();
    },
  };
}

/** The proxy's TLS certificate and key, from their files: both or neither. */
function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function readProxyTls(): { key: string; cert: string } {
  const certFile = process.env.LONGSHORE_PROXY_TLS_CERT_FILE?.trim();
  const keyFile = process.env.LONGSHORE_PROXY_TLS_KEY_FILE?.trim();
  if (!certFile || !keyFile) {
    throw new Error(
      "LONGSHORE_PROXY_TLS_CERT_FILE and LONGSHORE_PROXY_TLS_KEY_FILE must be set together",
    );
  }
  if (!process.env.LONGSHORE_PROXY_ADVERTISE_HOST?.trim()) {
    throw new Error("a TLS proxy listener needs LONGSHORE_PROXY_ADVERTISE_HOST (its public name)");
  }
  return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
}

async function serve(args: string[]): Promise<void> {
  // Every option has an environment variable (serve-config.ts), so a platform with no shell
  // configures the whole server from variables. A flag wins over its variable.
  const d = serveDefaults(process.env);
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", default: d.port },
      host: { type: "string", default: d.host },
      "data-dir": { type: "string", default: d.dataDir },
      "allowed-origin": { type: "string", multiple: true },
      "public-url": { type: "string" },
      roles: { type: "string" },
      worker: { type: "boolean", default: d.worker },
      "global-cap": { type: "string", default: d.globalCap },
      "org-cap": { type: "string", default: d.orgCap },
      "lease-seconds": { type: "string", default: d.leaseSeconds },
      image: { type: "string", ...(d.image ? { default: d.image } : {}) },
      poll: { type: "string", ...(d.poll ? { default: d.poll } : {}) },
      provider: { type: "string", default: d.provider },
      "provider-config": {
        type: "string",
        ...(d.providerConfig ? { default: d.providerConfig } : {}),
      },
      hosted: { type: "boolean", default: d.hosted },
      "isolation-override": {
        type: "string",
        ...(d.isolationOverride ? { default: d.isolationOverride } : {}),
      },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  const roles = resolveRoles(values.roles, { worker: values.worker, poll: values.poll });
  if (roles.has("release")) {
    // The release lane is its own process with its own keys: nothing below runs for it. It drops
    // (or refuses) like every other process that opens a data dir, before any file is touched. It
    // does not chown: its own directories belong to whoever provisions the lane.
    enforceRootPolicy(resolve(values["data-dir"]), process.env, undefined, { chown: false });
    const lane = await serveRelease(values);
    const stopLane = () => {
      lane.stop();
      process.exit(0);
    };
    process.on("SIGINT", stopLane);
    process.on("SIGTERM", stopLane);
    return;
  }
  // A process that is not the release lane holds nothing of it: those variables do nothing here.
  const runtime = mainRuntime(roles, process.env);
  if (runtime.ignoredReleaseEnv.length > 0) {
    console.warn(
      `warning: ${runtime.ignoredReleaseEnv.join(", ")} belong to the release lane and are ignored here; run it as its own process (serve --roles release)`,
    );
  }
  const dataDir = resolve(values["data-dir"]);
  // Before anything is opened: as root, own the data dir and drop to an unprivileged user.
  const privilege = enforceRootPolicy(dataDir);
  if (privilege === "dropped")
    console.log(`dropped privileges to ${process.env.LONGSHORE_DROP_PRIVILEGES}`);
  if (privilege === "root_allowed")
    console.warn("warning: running as root (LONGSHORE_ALLOW_ROOT=1)");
  const db = openDatabase(join(dataDir, "longshore.db"));
  await ensureInstance(db);

  // First-boot access without a shell: see ops/bootstrap.ts.
  const bootstrapHash = process.env.LONGSHORE_BOOTSTRAP_TOKEN_SHA256?.trim();
  if (bootstrapHash) {
    const r = await bootstrapToken(db, {
      sha256: bootstrapHash,
      org: process.env.LONGSHORE_BOOTSTRAP_ORG,
    });
    console.log(
      r.status === "created"
        ? `bootstrap: created an operator token for org ${r.org} (expires ${iso(r.expiresAt)})`
        : `bootstrap: org ${r.org} already has tokens, nothing created`,
    );
  }

  // The control-plane cache for jobs (#38). Off unless a URL the sandboxes can reach is given.
  let cache: CacheService | undefined;
  const cacheUrl = process.env.LONGSHORE_CACHE_URL?.trim();
  if (cacheUrl) {
    const gib = (name: string, dflt: number): number => {
      const n = Number(process.env[name] ?? dflt);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}`);
      return Math.floor(n * 1024 ** 3);
    };
    cache = createCacheService({
      db,
      // With a master key the blobs are encrypted at rest, per org (cache/blob-crypto.ts).
      store: new FsCacheStore(join(dataDir, "cache"), {
        masterKey: process.env.LONGSHORE_MASTER_KEY_FILE?.trim()
          ? loadMasterKey(process.env.LONGSHORE_MASTER_KEY_FILE.trim())
          : undefined,
      }),
      grants: new CacheGrants(),
      orgQuotaBytes: gib("LONGSHORE_CACHE_QUOTA_GIB", 10),
      maxEntryBytes: gib("LONGSHORE_CACHE_MAX_ENTRY_GIB", 2),
      baseUrl: cacheUrl,
      onNotice: (g, m) => console.log(`[longshore] ${m} (attempt ${g.attemptId})`),
      // A grant works only while its attempt is running, whatever else the token says.
      isActive: async (g) =>
        (await getAttempt(db, { orgId: g.own.orgId, projectId: g.own.projectId }, g.attemptId))
          ?.state === "running",
    });
    const sweep = setInterval(() => void cache?.sweep().catch(() => {}), 5 * 60_000);
    sweep.unref();
    console.log(`[longshore] job cache on, sandboxes reach it at ${cacheUrl}`);
  }

  const allowedOrigins = [
    ...(values["allowed-origin"] ?? []),
    ...(process.env.LONGSHORE_ALLOWED_ORIGINS?.split(",") ?? []),
  ]
    .map((o) => o.trim())
    .filter((o) => o !== "");
  // GitHub webhooks (/api/v1/webhooks/github) need the secret store, so they need a master key.
  let webhooks: WebhookHandler | undefined;
  let claims: { starter: InstallationClaims; handler: ClaimHandler } | undefined;
  // Set once the poller exists: a push or pull request webhook wakes it for that repo.
  let wake: ((repo: string) => void) | undefined;
  // Hosted multi-tenant installs: an org claims its own installation (github/claim.ts).
  const claimMode = process.env.LONGSHORE_CLAIM_INSTALLATIONS === "1";
  let checks: CheckReporter | undefined;
  const auditStops: (() => void)[] = [];
  let appAuth: AppAuth | undefined;
  let vault: SecretVault | undefined;
  let oidc: OidcHandler | undefined;
  const keyFile = process.env.LONGSHORE_MASTER_KEY_FILE?.trim();
  if (keyFile) {
    const masterKey = loadMasterKey(keyFile);
    const store = new SecretStore(db, masterKey);
    vault = new SecretVault({ db, masterKey });
    // Per-org OIDC issuer: needs a public https base, which is what an issuer URL is.
    const publicUrl = (values["public-url"] ?? process.env.LONGSHORE_PUBLIC_URL)?.trim();
    const oidcBase =
      process.env.LONGSHORE_OIDC_BASE_URL?.trim() ||
      (publicUrl ? `${publicUrl.replace(/\/+$/, "")}/oidc` : undefined);
    if (oidcBase) {
      const u = new URL(oidcBase);
      const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !local) {
        throw new Error(
          "the OIDC issuer base URL must be https (LONGSHORE_PUBLIC_URL or LONGSHORE_OIDC_BASE_URL)",
        );
      }
      const issuer = new OidcIssuer({
        db,
        masterKey,
        baseUrl: oidcBase,
        allowClasses: parseAllowClasses(process.env.LONGSHORE_OIDC_ALLOW_CLASSES),
      });
      oidc = createOidcHandler({ db, issuer, masterKey });
    }
    const auth = new AppAuth({ db, store });
    // Check runs: a per-project setting (off by default); the reporter does nothing for a project
    // that has not turned it on.
    checks = new CheckReporter({
      db,
      auth,
      api: githubCheckRunsApi(),
      publicUrl: values["public-url"] ?? process.env.LONGSHORE_PUBLIC_URL?.trim(),
      log: (m) => console.log(`[longshore] checks: ${m}`),
    });
    appAuth = auth;
    // An incident freeze drops the cached installation tokens. GitHub tokens still live until
    // they expire (within an hour); this stops the server handing them out again.
    registerCredentialRevoker({
      name: "github-installation-tokens",
      revoke: () => auth.dropCached(),
    });
    const ghFacts = githubFacts(auth);
    webhooks = createWebhookHandler({
      db,
      store,
      facts: ghFacts,
      trustedProxies: parseTrustedProxies(process.env.LONGSHORE_TRUSTED_PROXIES),
      ...(claimMode ? { claimMode: true } : {}),
      onRepoEvent: (repo) => wake?.(repo),
    });
    if (claimMode) {
      const starter = new InstallationClaims({
        db,
        store,
        publicUrl: values["public-url"] ?? process.env.LONGSHORE_PUBLIC_URL?.trim(),
      });
      claims = {
        starter,
        handler: createClaimHandler({
          claims: starter,
          facts: ghFacts,
          user: githubUserVerifier({ db, store }),
          log: (m) => console.warn(`[longshore] ${m}`),
        }),
      };
    }
    if (process.env.LONGSHORE_TRUST_FORWARDED_FOR !== undefined) {
      console.warn(
        "warning: LONGSHORE_TRUST_FORWARDED_FOR is no longer read; name your proxies in LONGSHORE_TRUSTED_PROXIES",
      );
    }
    void webhooks.retryUnfinished().catch(() => {});
    // Signed audit checkpoints need the store's key; export sinks are opt in.
    auditStops.push(
      startCheckpointer(db, store, new AuditAnchor(AuditAnchor.dirFor(keyFile), masterKey)),
    );
  }
  const sinks: AuditSink[] = [];
  const exportDir = process.env.LONGSHORE_AUDIT_EXPORT_DIR?.trim();
  if (exportDir) sinks.push(jsonlSink(resolve(exportDir)));
  const exportUrl = process.env.LONGSHORE_AUDIT_WEBHOOK_URL?.trim();
  if (exportUrl) {
    const secretFile = process.env.LONGSHORE_AUDIT_WEBHOOK_SECRET_FILE?.trim();
    const secret = secretFile ? (await Bun.file(secretFile).text()).trim() : undefined;
    sinks.push(webhookSink(exportUrl, secret ? { secret } : {}));
  }
  if (sinks.length > 0) auditStops.push(startExporter(db, sinks));
  const webauthn = relyingPartyFromEnv(
    values["public-url"] ?? process.env.LONGSHORE_PUBLIC_URL?.trim(),
  );
  const server = roles.has("web")
    ? startServer({
        port,
        host: values.host,
        db,
        allowedOrigins,
        ...(webhooks ? { webhooks } : {}),
        ...(vault ? { vault } : {}),
        ...(webauthn ? { webauthn } : {}),
        ...(oidc ? { oidc } : {}),
        ...(claims ? { claims } : {}),
        ...(cache ? { cache } : {}),
        trustForwardedProto: process.env.LONGSHORE_TRUST_FORWARDED_PROTO === "1",
        transport: transportOptionsFromEnv(process.env),
      })
    : undefined;
  if (server)
    console.log(`longshore ${VERSION} listening on http://${server.hostname}:${server.port}`);

  const background = await startBackground(
    db,
    {
      ...values,
      worker: roles.has("worker"),
      poll: roles.has("poller") ? values.poll : undefined,
    },
    checks,
    {
      ...(appAuth ? { auth: appAuth } : {}),
      ...(vault ? { vault } : {}),
      ...(cache ? { cache } : {}),
    },
  );

  wake = (repo) => void background.nudge(repo);

  const stop = () => {
    for (const s of auditStops) s();
    void background
      .stop()
      .then(() => server?.stop())
      .finally(() => {
        db.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const iso = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

async function token(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const options = {
    org: { type: "string" },
    project: { type: "string" },
    role: { type: "string" },
    name: { type: "string" },
    "expires-days": { type: "string" },
    "data-dir": { type: "string", default: "./data" },
  } as const;
  const { values, positionals } = parseArgs({
    args: rest,
    options,
    allowPositionals: sub === "revoke",
    strict: true,
  });
  const open = () => openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  if (sub === "generate") {
    // No database: the token goes to stdout, its hash to stderr. Keep the token; set only the
    // hash (LONGSHORE_BOOTSTRAP_TOKEN_SHA256) on the server.
    const secret = generateToken();
    console.error(
      `sha256: ${hashToken(secret)}\nSet LONGSHORE_BOOTSTRAP_TOKEN_SHA256 to that hash on the server and keep the token below; it is not stored anywhere else.`,
    );
    console.log(secret);
    return;
  }
  if (sub === "create") {
    if (!values.org || !values.role || !values.name) {
      throw new Error("--org, --role and --name are required");
    }
    const db = open();
    try {
      const created = await createTokenFromCli(db, {
        org: values.org,
        project: values.project,
        role: values.role,
        name: values.name,
        expiresInDays:
          values["expires-days"] === undefined ? undefined : Number(values["expires-days"]),
      });
      // Details to stderr, the secret alone to stdout, so `TOKEN=$(longshore token create ...)` works.
      console.error(
        `created ${created.role} token ${created.id} for ${created.org}${created.project ? `/${created.project}` : ""}, expires ${iso(created.expiresAt)}. It is shown once.`,
      );
      console.log(created.secret);
    } finally {
      db.close();
    }
  } else if (sub === "list") {
    if (!values.org) throw new Error("--org is required");
    const db = open();
    try {
      const rows = await listTokensFromCli(db, { org: values.org, project: values.project });
      console.log(["ID", "NAME", "ROLE", "PROJECT", "STATUS", "LAST USED", "EXPIRES"].join("\t"));
      for (const r of rows) {
        console.log(
          [
            r.id,
            r.name,
            r.role,
            r.project ?? "(org)",
            r.status,
            iso(r.lastUsedAt),
            iso(r.expiresAt),
          ].join("\t"),
        );
      }
    } finally {
      db.close();
    }
  } else if (sub === "revoke") {
    const [id] = positionals;
    if (!id) throw new Error("usage: longshore token revoke <id> [--data-dir ./data]");
    const db = open();
    try {
      const done = await revokeTokenFromCli(db, id);
      console.error(`revoked token ${done.id} (${done.name})`);
    } finally {
      db.close();
    }
  } else {
    throw new Error("usage: longshore token <generate|create|list|revoke> ...");
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  // Before any subcommand opens the data directory: as root, drop (or refuse) like `serve` does.
  dropForCommand(command, rest);
  switch (command) {
    case "serve":
      return await serve(rest);
    case "token":
      return await token(rest);
    case "keys": {
      const { keysCommand } = await import("./github/cli");
      return await keysCommand(rest);
    }
    case "github-app": {
      const { githubAppCommand } = await import("./github/cli");
      return await githubAppCommand(rest);
    }
    case "run": {
      const { runCommand } = await import("./run/cli");
      process.exit(await runCommand(rest));
    }
    case "release": {
      const { releaseCommand } = await import("./release/cli");
      process.exit(await releaseCommand(rest));
    }
    case "oidc": {
      const { oidcCommand } = await import("./oidc/cli");
      process.exit(await oidcCommand(rest));
    }
    case "secret": {
      const { secretCommand } = await import("./secrets/cli");
      process.exit(await secretCommand(rest));
    }
    case "audit": {
      const { auditCommand } = await import("./audit/cli");
      process.exit(await auditCommand(rest));
    }
    case "policy": {
      const { policyCommand } = await import("./ops/policy-command");
      return await policyCommand(rest);
    }
    case "mcp": {
      const { mcpCommand } = await import("./mcp/cli");
      return await mcpCommand(rest);
    }
    case "approvals": {
      const { approvalsCommand } = await import("./approvals/cli");
      process.exit(await approvalsCommand(rest));
    }
    case "incident": {
      const { incidentCommand } = await import("./incident/cli");
      process.exit(await incidentCommand(rest));
    }
    case "quotas": {
      const { quotasCommand } = await import("./quotas/cli");
      process.exit(await quotasCommand(rest));
    }
    case "artifacts": {
      const { artifactsCommand } = await import("./artifacts/cli");
      process.exit(await artifactsCommand(rest));
    }
    case "channel": {
      const { channelCommand } = await import("./channel/cli");
      return await channelCommand(rest);
    }
    case "verify": {
      const { verifyCommand } = await import("./verify/cli");
      process.exit(await verifyCommand(rest));
    }
    case "version":
    case "--version":
      console.log(VERSION);
      return;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
