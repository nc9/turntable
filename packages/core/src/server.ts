import type { Db } from "./db";
import { registry } from "./ops";
import { buildOpenApi } from "./ops/openapi";
import { createMcpHttp } from "./mcp/http";
import { createRestApi } from "./ops/rest";
import type { SecretVault } from "./secrets/vault";
import { createRealtime, type WsData } from "./realtime/server";
import { serveUi } from "./ui-assets";
import { VERSION } from "./version";

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Longshore</title>
  </head>
  <body>
    <h1>Longshore</h1>
    <p>Pre-alpha. The web UI is not built yet.</p>
  </body>
</html>
`;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
} as const;

/** Handler for `/api/v1/*`; resolves to undefined for any other path. */
export type ApiHandler = (req: Request, peer?: string) => Promise<Response | undefined>;

const OPENAPI = JSON.stringify(buildOpenApi(registry, VERSION));

export async function handleRequest(
  req: Request,
  api?: ApiHandler,
  peer?: string,
): Promise<Response> {
  const apiResponse = await api?.(req, peer);
  if (apiResponse) return apiResponse;
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: SECURITY_HEADERS });
  }
  if (url.pathname === "/healthz") {
    return Response.json({ ok: true, version: VERSION }, { headers: SECURITY_HEADERS });
  }
  if (url.pathname === "/openapi.json") {
    return new Response(OPENAPI, {
      headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
    });
  }
  const ui = serveUi(url, req.method, SECURITY_HEADERS);
  if (ui) return ui;
  if (url.pathname === "/") {
    return new Response(PLACEHOLDER_HTML, {
      headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
}

export type ServeOptions = {
  port: number;
  host: string;
  db: Db;
  /** Origins besides the page's own that may open a realtime socket. */
  allowedOrigins?: readonly string[];
  /** GitHub webhook endpoint, when a master key is configured. */
  webhooks?: { handle(req: Request): Promise<Response | undefined> };
  /** The secrets vault, when a master key is configured. */
  vault?: SecretVault;
  /** Trust x-forwarded-proto from a proxy you control (for value-bearing requests). */
  trustForwardedProto?: boolean;
};

export function startServer(options: ServeOptions) {
  const env = { registry, db: options.db, vault: options.vault };
  const api = createRestApi(env, { trustForwardedProto: options.trustForwardedProto === true });
  const mcp = createMcpHttp(env);
  const realtime = createRealtime({
    env,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  const server = Bun.serve<WsData>({
    port: options.port,
    hostname: options.host,
    async fetch(req, srv) {
      const hook = await options.webhooks?.handle(req);
      if (hook) return hook;
      const upgraded = await realtime.handle(req, srv);
      if (upgraded === "upgraded") return undefined;
      if (upgraded) return upgraded;
      const mcpResponse = await mcp(req);
      if (mcpResponse) return mcpResponse;
      return handleRequest(req, api, srv.requestIP(req)?.address);
    },
    websocket: realtime.websocket,
  });
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    realtime.stop();
    return stop(force);
  };
  return server;
}
