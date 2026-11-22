import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, openDatabase } from "./db";
import { startServer } from "./server";
import { VERSION } from "./version";

const USAGE = `turntable ${VERSION}

Usage:
  turntable serve [--port 8080] [--host 127.0.0.1] [--data-dir ./data]
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

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return await serve(rest);
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
