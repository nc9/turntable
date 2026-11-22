import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Provider } from "@longshore/provider-sdk";
import { type Db, ensureInstance, openDatabase } from "./db";
import { githubFacts } from "./github/api";
import { CheckReporter } from "./checks/reporter";
import { githubCheckRunsApi } from "./checks/client";
import { AppAuth } from "./github/app-auth";
import { createForgeToken } from "./pins/forge-token";
import { createWebhookHandler, type WebhookHandler } from "./github/webhook";
import { startCheckpointer } from "./audit/checkpoint";
import { jsonlSink, startExporter, webhookSink, type AuditSink } from "./audit/export";
import { bootstrapToken } from "./ops/bootstrap";
import { loadMasterKey } from "./secrets/crypto";
import { SecretStore } from "./secrets/store";
import { generateToken, hashToken } from "./ops/tokens";
import { loadPollConfig, Poller } from "./poll";
import {
  createActRunner,
  createProvider,
  gitRepoSource,
  loadProviderConfig,
  reconcileExpired,
  Scheduler,
  withEgressPolicy,
  withIsolationPolicy,
} from "./scheduler";
import { createTokenFromCli, listTokensFromCli, revokeTokenFromCli } from "./ops/token-cli";
import { startServer } from "./server";
import { VERSION } from "./version";

const USAGE = `longshore ${VERSION}

Usage:
  longshore serve [--port 8080] [--host 127.0.0.1] [--data-dir ./data] [--allowed-origin <origin>]
                  [--public-url <base url>]
                  [--worker [--provider docker|daytona] [--provider-config <file>] [--global-cap 4]
                   [--org-cap 2] [--lease-seconds 30] [--image <ref>] [--hosted]
                   [--isolation-override <reason>]]
                  [--poll <config.json>]
  longshore audit verify [--org <slug>] [--public-key <file>] | checkpoint | export | public-key
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
  longshore channel --url <https://host> --org <slug> [--token-file <path>] [--project a,b]
                    [--branch main] [--types run.finished,approval.required] [--state-file <path>]
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
  LONGSHORE_TOKEN_FILE  token file for "longshore mcp" (mode 0600; never pass a token on the command line)
  LONGSHORE_PUBLIC_URL  default for --public-url: the server's public base URL, linked from check runs
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
  extras: { auth?: AppAuth } = {},
): Promise<{ stop(): Promise<void> }> {
  const log = (m: string) => console.log(`[longshore] ${m}`);
  // Loaded first: the worker uses the poll token to resolve actions for the repos it watches.
  const pollConfig = v.poll ? loadPollConfig(v.poll) : undefined;
  let scheduler: Scheduler | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let poller: Poller | undefined;
  let workerProvider: Provider | undefined;

  if (v.worker) {
    const providerName = v.provider ?? "docker";
    const provider = createProvider(providerName, loadProviderConfig(v["provider-config"]));
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
    scheduler = new Scheduler({
      db,
      providers,
      // Jobs never start on a provider weaker than their trust class allows (see isolation.ts).
      runner: withIsolationPolicy(
        // Egress is none by default and refused where it cannot be enforced; each `none`
        // sandbox is probed for a real way out before the job starts.
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
            ...(v.image ? { image: v.image } : {}),
          }),
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
    async stop() {
      poller?.stop();
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (scheduler) {
        // Stop claiming, give running attempts a moment, then leave the rest: their leases
        // expire and the next boot's reconcile re-attaches to them. Never abort them
        // here, which would record a user cancel that never happened.
        await Promise.race([scheduler.stop(), Bun.sleep(10_000)]);
      }
    },
  };
}

async function serve(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", default: process.env.PORT?.trim() || "8080" },
      host: { type: "string", default: process.env.LONGSHORE_HOST ?? "127.0.0.1" },
      "data-dir": { type: "string", default: "./data" },
      "allowed-origin": { type: "string", multiple: true },
      "public-url": { type: "string" },
      worker: { type: "boolean", default: false },
      "global-cap": { type: "string", default: "4" },
      "org-cap": { type: "string", default: "2" },
      "lease-seconds": { type: "string", default: "30" },
      image: { type: "string" },
      poll: { type: "string" },
      provider: { type: "string", default: "docker" },
      "provider-config": { type: "string" },
      hosted: { type: "boolean", default: false },
      "isolation-override": { type: "string" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  const dataDir = resolve(values["data-dir"]);
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

  const allowedOrigins = [
    ...(values["allowed-origin"] ?? []),
    ...(process.env.LONGSHORE_ALLOWED_ORIGINS?.split(",") ?? []),
  ]
    .map((o) => o.trim())
    .filter((o) => o !== "");
  // GitHub webhooks (/api/v1/webhooks/github) need the secret store, so they need a master key.
  let webhooks: WebhookHandler | undefined;
  let checks: CheckReporter | undefined;
  const auditStops: (() => void)[] = [];
  let appAuth: AppAuth | undefined;
  const keyFile = process.env.LONGSHORE_MASTER_KEY_FILE?.trim();
  if (keyFile) {
    const store = new SecretStore(db, loadMasterKey(keyFile));
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
    webhooks = createWebhookHandler({
      db,
      store,
      facts: githubFacts(auth),
      trustForwardedFor: process.env.LONGSHORE_TRUST_FORWARDED_FOR === "1",
    });
    void webhooks.retryUnfinished().catch(() => {});
    // Signed audit checkpoints need the store's key; export sinks are opt in.
    auditStops.push(startCheckpointer(db, store));
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
  const server = startServer({
    port,
    host: values.host,
    db,
    allowedOrigins,
    ...(webhooks ? { webhooks } : {}),
  });
  console.log(`longshore ${VERSION} listening on http://${server.hostname}:${server.port}`);

  const background = await startBackground(db, values, checks, appAuth ? { auth: appAuth } : {});

  const stop = () => {
    for (const s of auditStops) s();
    void background
      .stop()
      .then(() => server.stop())
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
    case "channel": {
      const { channelCommand } = await import("./channel/cli");
      return await channelCommand(rest);
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
