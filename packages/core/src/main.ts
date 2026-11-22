import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DockerProvider } from "@turntable/provider-docker";
import { type Db, ensureInstance, openDatabase } from "./db";
import { loadPollConfig, Poller } from "./poll";
import { createActRunner, gitRepoSource, reconcileExpired, Scheduler } from "./scheduler";
import { createTokenFromCli, listTokensFromCli, revokeTokenFromCli } from "./ops/token-cli";
import { startServer } from "./server";
import { VERSION } from "./version";

const USAGE = `turntable ${VERSION}

Usage:
  turntable serve [--port 8080] [--host 127.0.0.1] [--data-dir ./data] [--allowed-origin <origin>]
                  [--worker [--global-cap 4] [--org-cap 2] [--lease-seconds 30] [--image <ref>]]
                  [--poll <config.json>]
  turntable token create --org <slug> [--project <slug>] --role <reader|operator|release_operator>
                         --name <name> [--expires-days 90] [--data-dir ./data]
  turntable token list --org <slug> [--project <slug>] [--data-dir ./data]
  turntable token revoke <id> [--data-dir ./data]
  turntable run <workflow-path> -j <job> [--repo <dir>] [--image <ref>] [--data-dir ./data] [--event push] [--egress none|open]
  turntable version

Environment:
  TURNTABLE_HOST  default for --host (the container image sets 0.0.0.0)
  TURNTABLE_ALLOWED_ORIGINS  comma-separated extra origins allowed to open the realtime WebSocket
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
  },
): Promise<{ stop(): Promise<void> }> {
  const log = (m: string) => console.log(`[turntable] ${m}`);
  let scheduler: Scheduler | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let poller: Poller | undefined;

  if (v.worker) {
    const provider = new DockerProvider();
    const providers = () => provider; // one provider for now; the name on an attempt is a label
    const leaseMs = Number(v["lease-seconds"]) * 1000;
    const num = (name: string, value: string | undefined): number => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`invalid --${name}: ${value}`);
      return n;
    };
    // Boot reconcile first: anything a dead worker left running is resolved before new claims.
    const report = await reconcileExpired(db, providers, { log });
    if (report.resolved.length > 0)
      log(`reconciled ${report.resolved.length} abandoned attempt(s)`);
    scheduler = new Scheduler({
      db,
      providers,
      runner: createActRunner({
        db,
        source: gitRepoSource(),
        ...(v.image ? { image: v.image } : {}),
      }),
      leaseMs,
      globalCap: num("global-cap", v["global-cap"]),
      perOrgCap: num("org-cap", v["org-cap"]),
      log,
    });
    scheduler.start();
    reconcileTimer = setInterval(
      () => {
        void reconcileExpired(db, providers, { log }).catch((e) =>
          log(`reconcile failed: ${String(e)}`),
        );
      },
      Math.max(leaseMs, 10_000),
    );
    log("worker started");
  }

  if (v.poll) {
    poller = new Poller({
      db,
      config: loadPollConfig(v.poll),
      log,
      onQueued: () => scheduler?.nudge(),
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
        // expire and the next boot's reconcile resolves them as infra_error. Never abort them
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
      port: { type: "string", default: "8080" },
      host: { type: "string", default: process.env.TURNTABLE_HOST ?? "127.0.0.1" },
      "data-dir": { type: "string", default: "./data" },
      "allowed-origin": { type: "string", multiple: true },
      worker: { type: "boolean", default: false },
      "global-cap": { type: "string", default: "4" },
      "org-cap": { type: "string", default: "2" },
      "lease-seconds": { type: "string", default: "30" },
      image: { type: "string" },
      poll: { type: "string" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  const dataDir = resolve(values["data-dir"]);
  const db = openDatabase(join(dataDir, "turntable.db"));
  await ensureInstance(db);

  const allowedOrigins = [
    ...(values["allowed-origin"] ?? []),
    ...(process.env.TURNTABLE_ALLOWED_ORIGINS?.split(",") ?? []),
  ]
    .map((o) => o.trim())
    .filter((o) => o !== "");
  const server = startServer({ port, host: values.host, db, allowedOrigins });
  console.log(`turntable ${VERSION} listening on http://${server.hostname}:${server.port}`);

  const background = await startBackground(db, values);

  const stop = () => {
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
  const open = () => openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
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
      // Details to stderr, the secret alone to stdout, so `TOKEN=$(turntable token create ...)` works.
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
    if (!id) throw new Error("usage: turntable token revoke <id> [--data-dir ./data]");
    const db = open();
    try {
      const done = await revokeTokenFromCli(db, id);
      console.error(`revoked token ${done.id} (${done.name})`);
    } finally {
      db.close();
    }
  } else {
    throw new Error("usage: turntable token <create|list|revoke> ...");
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return await serve(rest);
    case "token":
      return await token(rest);
    case "run": {
      const { runCommand } = await import("./run/cli");
      process.exit(await runCommand(rest));
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
