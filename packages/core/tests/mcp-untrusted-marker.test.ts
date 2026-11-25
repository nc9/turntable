import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Db } from "../src/db";
import { UNTRUSTED_META_KEY } from "../src/mcp/envelope";
import { registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { createRestApi, DEPRECATED_UNTRUSTED_HEADER, UNTRUSTED_HEADER } from "../src/ops/rest";
import { startServer } from "../src/server";
import { mintToken, seedWorld } from "./ops-helpers";

let db: Db;
let token: string;
let server: ReturnType<typeof startServer>;
let client: Client;
let api: ReturnType<typeof createRestApi>;

beforeAll(async () => {
  let a;
  ({ db, a } = await seedWorld());
  token = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
  server = startServer({ port: 0, host: "127.0.0.1", db });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  api = createRestApi({ registry, db });
});
afterAll(async () => {
  await client.close();
  await server.stop(true);
  db.close();
});

// Ops that set the REST header but are not an MCP tool (`mcp: false`), so no MCP result exists to
// mark. A new entry needs a look: if the op should be an MCP tool, it is marked automatically.
const REST_ONLY_UNTRUSTED = [
  // streams bytes; `get_artifact_files` lists files over MCP
  "get_artifact",
  // streams bytes; `get_artifact_files` lists files over MCP
  "get_artifact_file",
  "webhook_deliveries",
];

test("every op that sets the REST header is exposed over MCP, or listed as REST only", () => {
  const mcp = new Set(mcpTools(registry).map((t) => t.name));
  const restOnly = registry
    .tokenOps()
    .filter((o) => o.untrustedOutput && !mcp.has(o.name))
    .map((o) => o.name);
  expect(restOnly).toEqual(REST_ONLY_UNTRUSTED);
});

test("tools/list marks exactly the ops whose REST responses carry the header", async () => {
  const listed = (await client.listTools()).tools;
  expect(listed.length).toBe(mcpTools(registry).length);
  for (const tool of listed) {
    const op = registry.tokenOps().find((o) => o.name === tool.name)!;
    const marked = (tool._meta as Record<string, unknown> | undefined)?.[UNTRUSTED_META_KEY];
    expect(marked === true).toBe(op.untrustedOutput);
    if (!op.untrustedOutput) expect(tool._meta?.[UNTRUSTED_META_KEY]).toBeUndefined();
  }
});

test("a call returns the same marking over REST and MCP, for every op reachable without input", async () => {
  const seen = { untrusted: 0, trusted: 0 };
  const candidates = registry
    .mcpOps()
    .filter(
      (o) =>
        o.http.method === "GET" &&
        o.effect === "read" &&
        o.auth.type === "token" &&
        !o.http.path.includes("{"),
    );
  for (const op of candidates) {
    const rest = (await api(
      new Request(`http://x/api/v1${op.http.path}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    ))!;
    if (rest.status !== 200) continue; // needs input we cannot guess; covered by the static tests
    const mcp = (await client.callTool({ name: op.name, arguments: {} })) as {
      isError?: boolean;
      _meta?: Record<string, unknown>;
      content: { text: string }[];
    };
    expect(mcp.isError).not.toBe(true);
    const restMarked = rest.headers.get(UNTRUSTED_HEADER) === "true";
    expect(rest.headers.get(DEPRECATED_UNTRUSTED_HEADER) === "true").toBe(restMarked);
    const mcpMarked = mcp._meta?.[UNTRUSTED_META_KEY] === true;
    const enveloped = JSON.parse(mcp.content[0]!.text)?.untrusted === true;
    expect({ op: op.name, mcpMarked, enveloped }).toEqual({
      op: op.name,
      mcpMarked: restMarked,
      enveloped: restMarked,
    });
    expect(restMarked).toBe(op.untrustedOutput);
    seen[restMarked ? "untrusted" : "trusted"]++;
  }
  expect(seen.untrusted).toBeGreaterThan(0);
  expect(seen.trusted).toBeGreaterThan(0);
});

test("a resource read carries the marker too", async () => {
  const runs = JSON.parse(
    ((await client.callTool({ name: "list_runs", arguments: {} })) as any).content[0].text,
  );
  const id = runs.content.runs?.[0]?.id ?? runs.content.items?.[0]?.id;
  expect(id).toBeString();
  const res = await client.readResource({ uri: `turntable://runs/${id}` });
  expect((res.contents[0] as { _meta?: Record<string, unknown> })._meta?.[UNTRUSTED_META_KEY]).toBe(
    true,
  );
});
