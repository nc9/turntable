// Every subcommand that opens the data directory drops root the same way `serve` does. Without it
// `docker exec <container> longshore token create` runs as root and leaves root-owned files
// (the database's -wal and -shm, key state) in a directory the service user then cannot write.
// Subcommands only drop; ownership of the directory is the server's business, so nothing is
// chowned here.
import { resolve } from "node:path";
import { enforceRootPolicy, type PrivilegeOps, type PrivilegeOutcome } from "./privileges";

/** Subcommands that read or write the data directory (a database, keys or state). */
export const DATA_DIR_COMMANDS: ReadonlySet<string> = new Set([
  "token",
  "keys",
  "github-app",
  "run",
  "oidc",
  "secret",
  "audit",
  "policy",
  "mcp",
  "approvals",
  "incident",
  "pins",
]);

/** `--data-dir <v>` or `--data-dir=<v>`, last one wins, as parseArgs reads it; default ./data. */
export function dataDirFromArgs(args: string[]): string {
  let dir = "./data";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") break;
    if (a === "--data-dir") {
      const next = args[i + 1];
      if (next !== undefined) dir = next;
    } else if (a.startsWith("--data-dir=")) dir = a.slice("--data-dir=".length);
  }
  return resolve(dir);
}

/** Drops (or refuses) for a subcommand that touches the data directory; no-op for the rest. */
export function dropForCommand(
  command: string | undefined,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  ops?: PrivilegeOps,
): PrivilegeOutcome | "not_needed" {
  if (command === undefined || !DATA_DIR_COMMANDS.has(command)) return "not_needed";
  return enforceRootPolicy(dataDirFromArgs(args), env, ops, { chown: false });
}
