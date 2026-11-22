// HTTP for the per-org issuer, under /oidc/<org slug>/:
//   GET  .well-known/openid-configuration   discovery (public)
//   GET  jwks.json                          public keys, never private parameters (public)
//   GET|POST token?audience=<aud>           mint, with the attempt credential as the bearer
// The mint response is `{ "value": "<jwt>" }` like GitHub's, so existing tooling that asks the
// request URL for a token (actions/core getIDToken and the cloud login actions) reads it as is.
import type { Db } from "../db";
import { getOrgBySlug } from "../db/repos";
import { SYSTEM_ORG_SLUG } from "../audit/failures";
import { verifyAttemptCredential } from "./attempt-credential";
import type { OidcIssuer } from "./issuer";

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

const json = (body: unknown, status = 200, cache = "no-store"): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
    },
  });

const PUBLIC_CACHE = "public, max-age=300";

export interface OidcHandlerOptions {
  db: Db;
  issuer: OidcIssuer;
  masterKey: Buffer;
  now?: () => number;
}

export interface OidcHandler {
  handle(req: Request): Promise<Response | undefined>;
}

export function createOidcHandler(o: OidcHandlerOptions): OidcHandler {
  const now = o.now ?? Date.now;
  return {
    async handle(req) {
      const url = new URL(req.url);
      const m = /^\/oidc\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (!m) return undefined;
      const [, slug, rest] = m as unknown as [string, string, string];
      const org = slug === SYSTEM_ORG_SLUG ? undefined : await getOrgBySlug(o.db, slug);
      if (!org) return json({ error: "not found" }, 404);

      if (rest === ".well-known/openid-configuration" || rest === "jwks.json") {
        if (req.method !== "GET" && req.method !== "HEAD")
          return json({ error: "method not allowed" }, 405);
        return json(
          rest === "jwks.json"
            ? await o.issuer.keys.jwks(org.id, now())
            : o.issuer.discovery(org.slug),
          200,
          PUBLIC_CACHE,
        );
      }

      if (rest === "token") {
        if (req.method !== "GET" && req.method !== "POST")
          return json({ error: "method not allowed" }, 405);
        const bearer = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "");
        const who = bearer ? verifyAttemptCredential(o.masterKey, bearer[1]!, now()) : undefined;
        if (!who) return json({ error: "invalid or expired credential" }, 401);
        // The credential names its org; the URL must agree, or one org's job could probe another's.
        if (who.orgId !== org.id) return json({ error: "forbidden" }, 403);
        let audience: unknown = url.searchParams.get("audience") ?? undefined;
        if (req.method === "POST") {
          try {
            const body = (await req.json()) as { audience?: unknown };
            audience = body.audience ?? audience;
          } catch {
            return json({ error: "request body must be JSON" }, 400);
          }
        }
        const r = await o.issuer.mint({ orgId: org.id, attemptId: who.attemptId, audience });
        if (!r.ok) {
          return json({ error: r.reason }, r.reason === "bad_audience" ? 400 : 403);
        }
        return json({ value: r.token, expires_at: r.expiresAt });
      }
      return json({ error: "not found" }, 404);
    },
  };
}
