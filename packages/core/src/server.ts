import type { Db } from "./db";
import { VERSION } from "./version";

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Turntable</title>
  </head>
  <body>
    <h1>Turntable</h1>
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

export function handleRequest(req: Request): Response {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: SECURITY_HEADERS });
  }
  if (url.pathname === "/healthz") {
    return Response.json({ ok: true, version: VERSION }, { headers: SECURITY_HEADERS });
  }
  if (url.pathname === "/") {
    return new Response(PLACEHOLDER_HTML, {
      headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
}

export type ServeOptions = { port: number; host: string; db: Db };

export function startServer(options: ServeOptions) {
  return Bun.serve({
    port: options.port,
    hostname: options.host,
    fetch: (req) => handleRequest(req),
  });
}
