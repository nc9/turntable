import type { CacheService } from "./cache/service";
import type { Db } from "./db";
import { registry } from "./ops";
import { buildOpenApi } from "./ops/openapi";
import { createMcpHttp } from "./mcp/http";
import {
  decideTransport,
  redirectResponse,
  rejectResponse,
  transportOptionsFromEnv,
  withHsts,
  type TransportOptions,
} from "./transport";
import { createRestApi } from "./ops/rest";
import type { RelyingParty } from "./approvals/webauthn";
import type { ClaimHandler, InstallationClaims } from "./github/claim";
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
    <p>From source: run <code>bun run --cwd packages/ui build</code> and restart <code>serve</code> (or set <code>LONGSHORE_UI_DIR</code> to a built bundle).</p>
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
  /** Plain-http redirect and HSTS. Default: no proxy trusted, HSTS on over https. */
  transport?: TransportOptions;
  port: number;
  host: string;
  db: Db;
  /** Origins besides the page's own that may open a realtime socket. */
  allowedOrigins?: readonly string[];
  /** GitHub webhook endpoint, when a master key is configured. */
  webhooks?: { handle(req: Request, peer?: string): Promise<Response | undefined> };
  /** Per-org OIDC issuer endpoints, when a master key and a public URL are configured. */
  oidc?: { handle(req: Request): Promise<Response | undefined> };
  /** The secrets vault, when a master key is configured. */
  vault?: SecretVault;
  /** Installation claims (hosted): the start op and the setup callback. */
  claims?: { starter: InstallationClaims; handler: ClaimHandler };
  /** WebAuthn relying party for human approvals. Absent: only offline ed25519 approvals work. */
  webauthn?: RelyingParty;
  /** The control-plane cache for jobs (`/_cache/...`), when a cache URL is configured. */
  cache?: CacheService;
  /** Trust x-forwarded-proto from a proxy you control (for value-bearing requests). */
  trustForwardedProto?: boolean;
};

export function startServer(options: ServeOptions) {
  const env = {
    registry,
    db: options.db,
    vault: options.vault,
    claims: options.claims?.starter,
    webauthn: options.webauthn,
  };
  const api = createRestApi(env, {
    trustForwardedProto:
      options.trustForwardedProto ?? options.transport?.trustForwardedProto === true,
  });
  const mcp = createMcpHttp(env);
  const realtime = createRealtime({
    env,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  const transport = options.transport ?? transportOptionsFromEnv({});
  const server = Bun.serve<WsData>({
    port: options.port,
    hostname: options.host,
    async fetch(req, srv) {
      const t = decideTransport(req, transport);
      if (t.action === "redirect") return redirectResponse(t.location);
      if (t.action === "reject") return rejectResponse();
      const res = await route(req, srv);
      return res !== undefined && t.secure ? withHsts(res, transport) : res;
    },
    websocket: realtime.websocket,
  });
  async function route(req: Request, srv: Bun.Server<WsData>): Promise<Response | undefined> {
    const hook = await options.webhooks?.handle(req, srv.requestIP(req)?.address);
    if (hook) return hook;
    const claimed = await options.claims?.handler.handle(req);
    if (claimed) return claimed;
    const idp = await options.oidc?.handle(req);
    if (idp) return idp;
    const cached = await options.cache?.handle(req);
    if (cached) return cached;
    const upgraded = await realtime.handle(req, srv);
    if (upgraded === "upgraded") return undefined;
    if (upgraded) return upgraded;
    const mcpResponse = await mcp(req);
    if (mcpResponse) return mcpResponse;
    return handleRequest(req, api, srv.requestIP(req)?.address);
  }
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    realtime.stop();
    return stop(force);
  };
  return server;
}
