// The single place that turns the App's private key into credentials: an App JWT, and from it
// installation access tokens scoped down per call. Nothing else in the codebase signs or mints.
import { type SafeFetch, safeFetch } from "@turntable/net";
import { createHash, createSign } from "node:crypto";
import { getGithubApp } from "../db/repos";
import type { Db } from "../db";
import type { SecretStore } from "../secrets/store";

export const SECRET_APP_ID = "github-app/app-id";
export const SECRET_PRIVATE_KEY = "github-app/private-key";
export const SECRET_WEBHOOK = "github-app/webhook-secret";
export const SECRET_WEBHOOK_PREVIOUS = "github-app/webhook-secret-previous";
export const SECRET_CLIENT = "github-app/client-secret";

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** RS256 JWT for the App itself. Valid 9 minutes, backdated 60 s for clock skew (GitHub's rule). */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({ iat, exp: iat + 60 + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64u(sig)}`;
}

export interface TokenScope {
  /** Repository names (not owner/name) the token may touch. Absent means all of the installation. */
  repositories?: readonly string[];
  /** Permission name to access level. Absent means all the installation has. */
  permissions?: Readonly<Record<string, "read" | "write">>;
}

export interface MintedToken {
  token: string;
  expiresAt: number;
}

export interface AppAuthOptions {
  db: Db;
  store: SecretStore;
  /** GitHub API base. Default https://api.github.com. */
  apiBase?: string;
  fetch?: SafeFetch;
  now?: () => number;
}

/** Refresh when fewer than this many ms of life remain. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Mints and caches installation tokens. The ONE mint function: every GitHub credential in the
 * process comes from `mint` or `appJwt`. Tokens are cached per (installation, scope) until about
 * five minutes before they expire, are never logged, and are never returned by any operation.
 */
export class AppAuth {
  readonly #o: AppAuthOptions;
  readonly #cache = new Map<string, MintedToken>();

  constructor(o: AppAuthOptions) {
    this.#o = o;
  }

  /** Forgets every cached installation token (incident freeze). Returns how many were held. */
  dropCached(): number {
    const n = this.#cache.size;
    this.#cache.clear();
    return n;
  }

  get apiBase(): string {
    return this.#o.apiBase ?? "https://api.github.com";
  }

  async #credentials(): Promise<{ appId: string; pem: string }> {
    const app = await getGithubApp(this.#o.db);
    if (!app) throw new Error("no GitHub App is configured (run: turntable github-app create)");
    const pem = await this.#o.store.get(app.orgId, SECRET_PRIVATE_KEY);
    if (!pem) throw new Error("the GitHub App private key is missing from the secret store");
    return { appId: app.appId, pem };
  }

  /** A short-lived JWT for App-level calls (installation lookup, minting). */
  async appJwt(): Promise<string> {
    const { appId, pem } = await this.#credentials();
    return signAppJwt(appId, pem, (this.#o.now ?? Date.now)());
  }

  #headers(bearer: string): Record<string, string> {
    return {
      authorization: `Bearer ${bearer}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "turntable",
    };
  }

  /**
   * A token for exactly one use: never cached, never shared, so revoking it cannot break another
   * job and another job cannot be handed it. Callers revoke it when they are done.
   */
  async mintFresh(installationId: string, scope: TokenScope = {}): Promise<MintedToken> {
    const body: Record<string, unknown> = {};
    if (scope.repositories) body.repositories = [...scope.repositories];
    if (scope.permissions) body.permissions = scope.permissions;
    const res = await (this.#o.fetch ?? safeFetch)(
      `${this.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          ...this.#headers(await this.appJwt()),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new Error(`minting an installation token failed: HTTP ${res.status}`);
    const json = (await res.json()) as { token?: string; expires_at?: string };
    if (!json.token || !json.expires_at)
      throw new Error("minting an installation token: bad response");
    return { token: json.token, expiresAt: Date.parse(json.expires_at) };
  }

  /** What the installation was granted, so a request is never wider than the grant. */
  async installationPermissions(installationId: string): Promise<Readonly<Record<string, string>>> {
    const res = await (this.#o.fetch ?? safeFetch)(
      `${this.apiBase}/app/installations/${encodeURIComponent(installationId)}`,
      {
        headers: this.#headers(await this.appJwt()),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new Error(`reading the installation failed: HTTP ${res.status}`);
    const json = (await res.json()) as { permissions?: Record<string, string> };
    return json.permissions ?? {};
  }

  /** Revokes an installation token at GitHub (DELETE /installation/token). Never throws. */
  async revoke(token: string): Promise<boolean> {
    try {
      const res = await (this.#o.fetch ?? safeFetch)(`${this.apiBase}/installation/token`, {
        method: "DELETE",
        headers: this.#headers(token),
        signal: AbortSignal.timeout(15_000),
      });
      return res.status === 204;
    } catch {
      return false;
    }
  }

  async mint(installationId: string, scope: TokenScope = {}): Promise<MintedToken> {
    const now = (this.#o.now ?? Date.now)();
    const key = cacheKey(installationId, scope);
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt - REFRESH_MARGIN_MS > now) return hit;

    const body: Record<string, unknown> = {};
    if (scope.repositories) body.repositories = [...scope.repositories];
    if (scope.permissions) body.permissions = scope.permissions;
    const res = await (this.#o.fetch ?? safeFetch)(
      `${this.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.appJwt()}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "turntable",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new Error(`minting an installation token failed: HTTP ${res.status}`);
    const json = (await res.json()) as { token?: string; expires_at?: string };
    if (!json.token || !json.expires_at)
      throw new Error("minting an installation token: bad response");
    const minted = { token: json.token, expiresAt: Date.parse(json.expires_at) };
    this.#cache.set(key, minted);
    return minted;
  }
}

function cacheKey(installationId: string, scope: TokenScope): string {
  const repos = [...(scope.repositories ?? [])].sort();
  const perms = Object.entries(scope.permissions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(
      JSON.stringify([
        installationId,
        scope.repositories ? repos : null,
        scope.permissions ? perms : null,
      ]),
    )
    .digest("hex");
}
