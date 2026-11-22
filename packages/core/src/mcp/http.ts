// Streamable HTTP transport at /mcp. Stateless: each request authenticates its own bearer token
// and gets its own server, so no session can outlive a token or be used by another caller.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticate, type DispatchEnv } from "../ops";
import { OpError, errorBody } from "../ops/errors";
import { createMcpServer } from "./server";

export const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

function failure(err: OpError, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(errorBody(err)), {
    status: err.status,
    headers: { ...HEADERS, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

/** Handler for `/mcp`; resolves to undefined for any other path. */
export function createMcpHttp(env: DispatchEnv): (req: Request) => Promise<Response | undefined> {
  return async (req) => {
    if (new URL(req.url).pathname !== MCP_PATH) return undefined;
    // Stateless: no server-initiated stream and no session to delete.
    if (req.method !== "POST") {
      return failure(new OpError("method_not_allowed", "use POST"), { allow: "POST" });
    }
    // The token comes from the Authorization header only: never a query string or a body.
    const bearer = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!bearer) {
      return failure(new OpError("unauthenticated", "missing bearer token"), {
        "www-authenticate": 'Bearer realm="longshore"',
      });
    }
    const token = bearer[1]!;
    try {
      // Refuse a bad token here so the client sees 401; every call is checked again by dispatch.
      await authenticate(env, { kind: "bearer", token });
    } catch (err) {
      if (err instanceof OpError) {
        return failure(err, { "www-authenticate": 'Bearer realm="longshore"' });
      }
      throw err;
    }
    let body: unknown;
    try {
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) throw new OpError("payload_too_large", "request too large");
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) throw new OpError("payload_too_large", "request too large");
      body = JSON.parse(text);
    } catch (err) {
      if (err instanceof OpError) return failure(err);
      return failure(new OpError("invalid_input", "request body is not valid JSON"));
    }
    // No DNS-rebinding host allowlist: access needs the bearer token in this header, which a
    // browser never attaches on its own (there are no cookies or ambient credentials to ride).
    const server = createMcpServer(env, token);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(req, { parsedBody: body });
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } finally {
      void server.close().catch(() => {});
    }
  };
}
