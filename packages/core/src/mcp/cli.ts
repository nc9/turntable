import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../db";
import { registry } from "../ops";
import { readTokenFile, runMcpStdio } from "./stdio";

export const MCP_USAGE = `Usage: longshore mcp [--token-file <path>] [--data-dir ./data]

Serves MCP over stdio for a local agent. The token is read from --token-file or the
LONGSHORE_TOKEN_FILE environment variable (a file with mode 0600). It is never taken from the
command line. Create one with "longshore token create". Only stdout carries the protocol.`;

/** Runs until the client closes stdin. Returns a process exit code only on a start failure. */
export async function mcpCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "token-file": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.error(MCP_USAGE);
    return;
  }
  const tokenFile = values["token-file"] ?? process.env.LONGSHORE_TOKEN_FILE?.trim();
  if (!tokenFile) {
    console.error(`no token file: pass --token-file or set LONGSHORE_TOKEN_FILE\n\n${MCP_USAGE}`);
    process.exit(2);
  }
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  try {
    await runMcpStdio({
      env: { registry, db },
      token: readTokenFile(tokenFile),
      onClose: () => {
        db.close();
        process.exit(0);
      },
    });
  } catch (e) {
    db.close();
    // stderr only: stdout is the protocol channel.
    console.error(`longshore mcp: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
