// `longshore mcp`: the MCP server over stdio for local agents. The token comes from a file,
// never argv (argv is visible to every process on the machine). stdout is the protocol channel:
// nothing here may write to it.
import { statSync, readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authenticate, type DispatchEnv } from "../ops";
import { createMcpServer } from "./server";

/** Reads a token from a file that only its owner can read. */
export function readTokenFile(path: string): string {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a file`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by others; chmod 600 it`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (token === "") throw new Error(`${path} is empty`);
  return token;
}

export async function runMcpStdio(o: {
  env: DispatchEnv;
  token: string;
  stdin?: Readable;
  stdout?: Writable;
  /** Called when the client goes away (stdin closed). */
  onClose?: () => void;
}): Promise<{ close(): Promise<void> }> {
  // Fail at start with a clear message, not on the first tool call.
  await authenticate(o.env, { kind: "bearer", token: o.token });
  const server = createMcpServer(o.env, o.token);
  if (o.onClose) server.onclose = o.onClose;
  await server.connect(new StdioServerTransport(o.stdin, o.stdout));
  return { close: () => server.close() };
}
