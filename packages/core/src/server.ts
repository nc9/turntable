import type { ArtifactService } from "./artifacts/service";
import type { CacheService } from "./cache/service";
import type { Db } from "./db";
import type { BackupConfig } from "./db/backup";
import type { SettingsRuntime } from "./settings/resolve";
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
import type { GithubFacts } from "./github/api";
import type { ClaimHandler, InstallationClaims } from "./github/claim";
import type { HostedManifestHandler } from "./github/hosted-manifest";
import type { DoctorReport } from "./doctor/types";
import type { ForwardedObserver } from "./doctor/observe";
import type { SecretStore } from "./secrets/store";
import type { SecretVault } from "./secrets/vault";
import { createRealtime, type WsData } from "./realtime/server";
import { createEventStream } from "./realtime/sse";
import type { WebhookService } from "./webhooks/service";
import { pageCsp, renderPage, servePageAsset } from "./pages/server-pages";
import { serveUi } from "./ui-assets";
import { VERSION } from "./version";

const PLACEHOLDER_HTML = renderPage({
  title: "Turntable",
  body: `<p>Pre-alpha. The web UI is not built yet.</p>
<p class="tt-muted">From source: run <code>bun run --cwd packages/ui build</code> and restart <code>serve</code> (or set <code>TURNTABLE_UI_DIR</code> to a built bundle).</p>`,
});

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": pageCsp(),
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
  const asset = servePageAsset(req);
  if (asset) return asset;
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
  /** GitHub API facts, for `resync_installation`. */
  githubFacts?: GithubFacts;
  /** Creating the GitHub App from this instance (hosted, no shell): github/hosted-manifest.ts. */
  appManifest?: HostedManifestHandler;
  /** The instance's per-org concurrency cap, the ceiling `set_quotas` clamps to. */
  instanceOrgCap?: number | undefined;
  /** What `db_backup` needs: the data dir and database file, or the Postgres marker. */
  backup?: BackupConfig;
  /** The settings registry with its environment and turntable.toml layers (settings/boot.ts). */
  settings?: SettingsRuntime;
  /** WebAuthn relying party for human approvals. Absent: only offline ed25519 approvals work. */
  webauthn?: RelyingParty;
  /** The control-plane cache for jobs (`/_cache/...`), when a cache URL is configured. */
  cache?: CacheService;
  /** The artifact service for jobs (the twirp API and `/_artifacts/...`), when a URL is configured. */
  artifacts?: ArtifactService;
  /** Outbound webhook management ops, when a master key is configured. */
  outboundWebhooks?: WebhookService;
  /** Trust x-forwarded-proto from a proxy you control (for value-bearing requests). */
  trustForwardedProto?: boolean;
  /** The secret store, for `instance_audit_verify`'s public keys. */
  auditStore?: SecretStore | undefined;
  /** The readiness checks, served by the `doctor` operation. */
  doctor?: () => Promise<DoctorReport>;
  /** Counts the forwarded headers requests carry, for doctor to compare with the settings. */
  forwarded?: ForwardedObserver;
};

export function startServer(options: ServeOptions) {
  const env = {
    registry,
    db: options.db,
    vault: options.vault,
    claims: options.claims?.starter,
    githubFacts: options.githubFacts,
    webhooks: options.outboundWebhooks,
    webauthn: options.webauthn,
    instanceOrgCap: options.instanceOrgCap,
    doctor: options.doctor,
    auditStore: options.auditStore,
    backup: options.backup,
    settings: options.settings,
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
  const sse = createEventStream({
    env,
    ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  const transport = options.transport ?? transportOptionsFromEnv({});
  const server = Bun.serve<WsData>({
    port: options.port,
    hostname: options.host,
    async fetch(req, srv) {
      options.forwarded?.record(req);
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
    const manifest = await options.appManifest?.handle(req, srv.requestIP(req)?.address);
    if (manifest) return manifest;
    const claimed = await options.claims?.handler.handle(req);
    if (claimed) return claimed;
    const idp = await options.oidc?.handle(req);
    if (idp) return idp;
    const cached = await options.cache?.handle(req);
    if (cached) return cached;
    const artifact = await options.artifacts?.handle(req);
    if (artifact) return artifact;
    const upgraded = await realtime.handle(req, srv);
    if (upgraded === "upgraded") return undefined;
    if (upgraded) return upgraded;
    const stream = await sse.handle(req, srv);
    if (stream) return stream;
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
