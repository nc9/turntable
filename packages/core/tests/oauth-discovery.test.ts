import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Db } from "../src/db";
import { createMcpHttp } from "../src/mcp/http";
import { registry } from "../src/ops";
import { createRestApi } from "../src/ops/rest";
import { handleRequest } from "../src/server";
import { registerUiAssets } from "../src/ui-assets";
import { seedWorld } from "./ops-helpers";

let db: Db;
let call: (path: string, init?: RequestInit) => Promise<Response>;
let handle: (req: Request) => Promise<Response>;
const base = "http://localhost";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-oauth-ui-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
  registerUiAssets({ "/index.html": join(dir, "index.html") });
  ({ db } = await seedWorld());
  // The same chain the server's request handler runs (MCP first, then REST and the app), in-process.
  const mcp = createMcpHttp({ registry, db });
  const api = createRestApi({ registry, db });
  handle = async (req) => (await mcp(req)) ?? (await handleRequest(req, api));
  call = (path, init) => handle(new Request(base + path, init));
});
afterAll(() => {
  registerUiAssets(null);
  db.close();
});

async function expectJson404(path: string, method = "GET"): Promise<void> {
  const res = await call(path, { method });
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("not_found");
}

describe("OAuth discovery is never the web app", () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/register",
    "/authorize",
    "/token",
    "/oauth/anything",
  ]) {
    test(`GET ${path}`, async () => {
      await expectJson404(path);
      const res = await call(path);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  }
  test("POST /register", () => expectJson404("/register", "POST"));
});

describe("unknown API and MCP paths", () => {
  test("/api/v1/nope", () => expectJson404("/api/v1/nope"));
  test("/mcp/nope", () => expectJson404("/mcp/nope"));
});

describe("/mcp authentication challenge", () => {
  const init = (headers: Record<string, string>) =>
    call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
  test("no token: 401 JSON, no error attribute", async () => {
    const res = await init({});
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="turntable"');
    await res.json();
  });
  test("bad token: 401 with invalid_token", async () => {
    const res = await init({ authorization: "Bearer tt_nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="turntable", error="invalid_token"',
    );
    await res.json();
  });
});

describe("app routes still return the page", () => {
  for (const path of ["/", "/onboarding", "/runs/abc"]) {
    test(path, async () => {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });
  }
});

test("a real MCP client without a token fails with an auth error, not a parse error", async () => {
  const client = new Client({ name: "test", version: "0" });
  const err = await client
    .connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: (input, init) => handle(new Request(String(input), init)),
      }),
    )
    .then(
      () => undefined,
      (e: unknown) => e as Error,
    );
  expect(err).toBeDefined();
  expect(err!.constructor.name).not.toBe("SyntaxError");
  expect(err!.message).not.toContain("JSON Parse");
  expect(err!.message).not.toContain("Unrecognized token");
});
