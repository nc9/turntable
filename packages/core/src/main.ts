import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, openDatabase } from "./db";
import { createTokenFromCli } from "./ops/token-cli";
import { startServer } from "./server";
import { VERSION } from "./version";

const USAGE = `turntable ${VERSION}

Usage:
  turntable serve [--port 8080] [--host 127.0.0.1] [--data-dir ./data]
  turntable token create --org <slug> [--project <slug>] --role <reader|operator> --name <name>
                         [--expires-in-days 90] [--data-dir ./data]
  turntable version

Environment:
  TURNTABLE_HOST  default for --host (the container image sets 0.0.0.0)
`;

async function serve(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", default: "8080" },
      host: { type: "string", default: process.env.TURNTABLE_HOST ?? "127.0.0.1" },
      "data-dir": { type: "string", default: "./data" },
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

  const server = startServer({ port, host: values.host, db });
  console.log(`turntable ${VERSION} listening on http://${server.hostname}:${server.port}`);

  const stop = () => {
    void server.stop().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function token(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "create") throw new Error(`usage: turntable token create --org <slug> --role <role> --name <name>`);
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      project: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      "expires-in-days": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (!values.org || !values.role || !values.name) {
    throw new Error("--org, --role and --name are required");
  }
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    const created = await createTokenFromCli(db, {
      org: values.org,
      project: values.project,
      role: values.role,
      name: values.name,
      expiresInDays:
        values["expires-in-days"] === undefined ? undefined : Number(values["expires-in-days"]),
    });
    // Details to stderr, the secret alone to stdout, so `TOKEN=$(turntable token create ...)` works.
    console.error(
      `created ${created.role} token ${created.id} for ${created.org}${created.project ? `/${created.project}` : ""}, expires ${new Date(created.expiresAt).toISOString()}. It is shown once.`,
    );
    console.log(created.secret);
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return await serve(rest);
    case "token":
      return await token(rest);
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
