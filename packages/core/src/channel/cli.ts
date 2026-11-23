import { parseArgs } from "node:util";
import { EVENT_TYPES } from "../db/schema";
import { readTokenFile } from "../mcp/stdio";
import { createChannelApi, parseBaseUrl } from "./api";
import { buildFilter } from "./filter";
import { runFeed } from "./feed";
import { connectChannel, createChannelServer } from "./server";
import { defaultStatePath, fileCursorStore } from "./state";

const CONCLUSIONS = ["failure", "infra_error", "success", "cancelled"] as const;

export const CHANNEL_USAGE = `Usage: turntable channel --url <https://host> --org <slug> [--token-file <path>]
                         [--project a,b] [--branch main,release/*]
                         [--types run.finished,approval.required]
                         [--conclusions failure,infra_error] [--state-file <path>]

A Claude Code channel: pushes run events from a Turntable server into a running Claude Code
session. Claude Code starts it as an MCP server over stdio (see docs/agent-interface.mdx).
The token (reader role is enough) is read from --token-file or TURNTABLE_TOKEN_FILE, a file with
mode 0600; it is never taken from the command line. Each option also reads TURNTABLE_URL,
TURNTABLE_ORG, TURNTABLE_CHANNEL_PROJECTS, TURNTABLE_CHANNEL_BRANCHES, TURNTABLE_CHANNEL_TYPES,
TURNTABLE_CHANNEL_CONCLUSIONS and TURNTABLE_CHANNEL_STATE_FILE. Event types: ${EVENT_TYPES.join(", ")}.
Conclusions: ${CONCLUSIONS.join(", ")}. Only stdout carries the protocol.`;

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

/** Runs until the session closes stdin, or the token is rejected. */
export async function channelCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      org: { type: "string" },
      "token-file": { type: "string" },
      project: { type: "string" },
      branch: { type: "string" },
      types: { type: "string" },
      conclusions: { type: "string" },
      "state-file": { type: "string" },
      "allow-insecure": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.error(CHANNEL_USAGE);
    return;
  }
  const fail = (m: string): never => {
    console.error(`turntable channel: ${m}\n\n${CHANNEL_USAGE}`);
    process.exit(2);
  };
  const url =
    values.url ?? env("TURNTABLE_URL") ?? fail("no server: pass --url or set TURNTABLE_URL");
  const org = values.org ?? env("TURNTABLE_ORG") ?? fail("no org: pass --org or set TURNTABLE_ORG");
  const tokenFile =
    values["token-file"] ??
    env("TURNTABLE_TOKEN_FILE") ??
    fail("no token file: pass --token-file or set TURNTABLE_TOKEN_FILE");
  try {
    const baseUrl = parseBaseUrl(url, values["allow-insecure"]);
    const filter = buildFilter(
      {
        types: values.types ?? env("TURNTABLE_CHANNEL_TYPES"),
        conclusions: values.conclusions ?? env("TURNTABLE_CHANNEL_CONCLUSIONS"),
        projects: values.project ?? env("TURNTABLE_CHANNEL_PROJECTS"),
        branches: values.branch ?? env("TURNTABLE_CHANNEL_BRANCHES"),
      },
      EVENT_TYPES,
      CONCLUSIONS,
    );
    const token = readTokenFile(tokenFile);
    const api = createChannelApi({ baseUrl, org, token });
    const store = fileCursorStore(
      values["state-file"] ??
        env("TURNTABLE_CHANNEL_STATE_FILE") ??
        defaultStatePath(baseUrl.href, org, filter.projects),
    );
    const server = createChannelServer();
    const ac = new AbortController();
    server.onclose = () => ac.abort();
    const notify = await connectChannel(server);
    const result = await runFeed({
      api,
      filter,
      store,
      baseUrl,
      org,
      notify,
      signal: ac.signal,
      log: (m) => console.error(`turntable channel: ${m}`),
    });
    await server.close().catch(() => {});
    process.exit(result === "auth" ? 2 : 0);
  } catch (e) {
    // stderr only: stdout is the protocol channel.
    console.error(`turntable channel: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
