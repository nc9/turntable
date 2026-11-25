// The signed-in user's GitHub user-to-server token (onboarding). Sign-in used to read it once and
// drop it. Onboarding needs it, to ask GitHub which installations THIS person can reach, so it is
// kept:
//
//  - SEALED in the secret store (the same sealed records as every other secret), one record per
//    web session, named by the session row's hash. The database never holds a plain token.
//  - Bound to the session: deleted on sign-out, and swept once its session is revoked, expired or
//    idle past its limit (`sweep`, run at every sign-in and hourly).
//  - Refreshed with GitHub's refresh token when it has expired. GitHub rotates the refresh token
//    on every use, so a refresh is single-flight per session.
//  - Never logged and never returned: `UserGithub` gives callers GitHub's answers, not the token,
//    and no error message here carries a value from GitHub's response.
import { type SafeFetch, safeFetch } from "@turntable/net";
import type { Db } from "../db";
import { appendAudit, getGithubApp } from "../db/repos";
import { OpError } from "../ops/errors";
import { SECRET_CLIENT } from "../github/app-auth";
import type { SecretStore } from "../secrets/store";
import type { WebSessions } from "./web-sessions";

/** What GitHub's token endpoint gave, for one session. */
export type UserTokenSet = {
  access: string;
  refresh?: string | undefined;
  /** Epoch ms the access token stops working; absent when GitHub gave it no expiry. */
  expiresAt?: number | undefined;
  /** Epoch ms the refresh token stops working. */
  refreshExpiresAt?: number | undefined;
  /** The GitHub user id the token belongs to, kept for the audit rows only. */
  githubUserId?: string | undefined;
};

const PREFIX = "web-session/";
const SUFFIX = "/github-user-token";
/** A token this close to its expiry is refreshed first, so a call never starts with a dying one. */
const SKEW_MS = 60_000;

const nameOf = (hash: string): string => `${PREFIX}${hash}${SUFFIX}`;

/** Reads the token fields of GitHub's `access_token` response. Anything malformed is `undefined`. */
export function parseTokenResponse(j: unknown, now: number): UserTokenSet | undefined {
  if (j === null || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  if (typeof o.access_token !== "string" || o.access_token === "") return undefined;
  const secs = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? now + v * 1000 : undefined;
  return {
    access: o.access_token,
    ...(typeof o.refresh_token === "string" && o.refresh_token !== ""
      ? { refresh: o.refresh_token }
      : {}),
    ...(secs(o.expires_in) !== undefined ? { expiresAt: secs(o.expires_in) } : {}),
    ...(secs(o.refresh_token_expires_in) !== undefined
      ? { refreshExpiresAt: secs(o.refresh_token_expires_in) }
      : {}),
  };
}

export interface UserTokensOptions {
  db: Db;
  store: SecretStore;
  sessions: WebSessions;
  fetch?: SafeFetch;
  oauthBase?: string;
}

export class UserTokens {
  readonly #o: UserTokensOptions;
  readonly #inflight = new Map<string, Promise<string | undefined>>();

  constructor(o: UserTokensOptions) {
    this.#o = o;
  }

  async #appOrg(): Promise<string | undefined> {
    return (await getGithubApp(this.#o.db))?.orgId;
  }

  /**
   * The sealed token's own audit row, in the App org's chain: the session id hash and the GitHub
   * user id only. Never the token, nor a hash of it. Not a tenant-secret event, so no `secret_set`.
   */
  #audit(
    org: string,
    op: "github_user_token.sealed" | "github_user_token.deleted",
    hash: string,
    ghUser?: string,
  ): Promise<void> {
    return appendAudit(
      this.#o.db,
      { orgId: org },
      {
        principalKind: "system",
        principalId: "github-user-tokens",
        op,
        effect: "write",
        outcome: "ok",
        input: { session: hash, ...(ghUser ? { github_user_id: ghUser } : {}) },
      },
    );
  }

  /** Seals the token set for a session. */
  async save(hash: string, set: UserTokenSet, githubUserId?: string): Promise<void> {
    const org = await this.#appOrg();
    if (!org) return;
    const kept = githubUserId ?? set.githubUserId;
    const full = kept ? { ...set, githubUserId: kept } : set;
    await this.#o.store.set(org, nameOf(hash), JSON.stringify(full), { audit: false });
    await this.#audit(org, "github_user_token.sealed", hash, kept);
  }

  /** Deletes the session's token (sign-out). True when there was one. */
  async remove(hash: string): Promise<boolean> {
    const org = await this.#appOrg();
    return org ? this.#drop(org, hash) : false;
  }

  async #drop(org: string, hash: string): Promise<boolean> {
    const ghUser = (await this.#load(org, hash).catch(() => undefined))?.githubUserId;
    const removed = await this.#o.store.delete(org, nameOf(hash), { audit: false });
    if (removed) await this.#audit(org, "github_user_token.deleted", hash, ghUser);
    return removed;
  }

  async #load(org: string, hash: string): Promise<UserTokenSet | undefined> {
    const raw = await this.#o.store.get(org, nameOf(hash));
    if (raw === undefined) return undefined;
    try {
      const j = JSON.parse(raw) as UserTokenSet;
      return typeof j.access === "string" ? j : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A working access token for a live session, refreshed first when it has expired. Undefined
   * when the session has none, or it cannot be refreshed (the stored token is then deleted).
   */
  async access(hash: string): Promise<string | undefined> {
    const running = this.#inflight.get(hash);
    if (running) return running;
    const p = this.#access(hash).finally(() => this.#inflight.delete(hash));
    this.#inflight.set(hash, p);
    return p;
  }

  async #access(hash: string): Promise<string | undefined> {
    const org = await this.#appOrg();
    if (!org) return undefined;
    const set = await this.#load(org, hash);
    if (!set) return undefined;
    const now = this.#o.sessions.now();
    if (set.expiresAt === undefined || set.expiresAt - SKEW_MS > now) return set.access;
    if (!set.refresh || (set.refreshExpiresAt !== undefined && set.refreshExpiresAt <= now)) {
      await this.remove(hash);
      return undefined;
    }
    const next = await this.#refresh(org, set.refresh).catch(() => undefined);
    if (!next) {
      await this.remove(hash);
      return undefined;
    }
    await this.save(hash, next, set.githubUserId);
    return next.access;
  }

  async #refresh(org: string, refresh: string): Promise<UserTokenSet | undefined> {
    const app = await getGithubApp(this.#o.db);
    if (!app) return undefined;
    const secret = await this.#o.store.get(org, SECRET_CLIENT);
    if (!secret) return undefined;
    const f = this.#o.fetch ?? safeFetch;
    const res = await f(`${this.#o.oauthBase ?? "https://github.com"}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "turntable",
      },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: secret,
        grant_type: "refresh_token",
        refresh_token: refresh,
      }),
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
    });
    if (!res.ok) return undefined;
    return parseTokenResponse(await res.json().catch(() => undefined), this.#o.sessions.now());
  }

  /**
   * Deletes the token of every session that is no longer live (revoked, expired or idle). Returns
   * how many it deleted. Cheap when there are none: one list of names.
   */
  async sweep(): Promise<number> {
    const org = await this.#appOrg();
    if (!org) return 0;
    let n = 0;
    for (const name of await this.#o.store.list(org)) {
      if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
      const hash = name.slice(PREFIX.length, name.length - SUFFIX.length);
      if (await this.#o.sessions.isLive(hash)) continue;
      if (await this.#drop(org, hash)) n += 1;
    }
    return n;
  }
}

/** An installation of this App that a signed-in user can reach, as GitHub lists it. */
export type UserInstallationFact = {
  id: string;
  accountId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
};

/** GitHub calls made as the signed-in user. Every call reads GitHub afresh: nothing is cached. */
export interface UserGithub {
  /** `GET /user/installations`, every page, only this App's. */
  listInstallations(sessionHash: string): Promise<UserInstallationFact[]>;
  /**
   * Whether the user is an active admin of a GitHub organization (`GET /user/memberships/orgs`),
   * read afresh. Access to an installation is not ownership: any member of the organization sees it.
   */
  isOrgAdmin(sessionHash: string, org: string): Promise<boolean>;
}

const NEEDS_SIGN_IN = "your GitHub authorization has expired: sign in again";

export function githubUserApi(o: {
  db: Db;
  tokens: UserTokens;
  fetch?: SafeFetch;
  apiBase?: string;
}): UserGithub {
  const f = o.fetch ?? safeFetch;
  const api = o.apiBase ?? "https://api.github.com";
  return {
    async listInstallations(hash) {
      const app = await getGithubApp(o.db);
      if (!app) throw new OpError("unavailable", "no GitHub App is configured");
      const token = await o.tokens.access(hash);
      if (!token) throw new OpError("unauthenticated", NEEDS_SIGN_IN);
      const out: UserInstallationFact[] = [];
      for (let page = 1; page <= 20; page += 1) {
        const res = await f(`${api}/user/installations?per_page=100&page=${page}`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "turntable",
          },
          timeoutMs: 15_000,
          maxBytes: 1024 * 1024,
        });
        if (res.status === 401) {
          await o.tokens.remove(hash);
          throw new OpError("unauthenticated", NEEDS_SIGN_IN);
        }
        if (!res.ok) throw new OpError("unavailable", `GitHub answered HTTP ${res.status}`);
        const j = (await res.json()) as {
          installations?: {
            id?: number;
            app_id?: number;
            repository_selection?: string;
            account?: { id?: number; login?: string; type?: string };
          }[];
        };
        for (const i of j.installations ?? []) {
          if (typeof i.id !== "number") continue;
          if (String(i.app_id ?? app.appId) !== app.appId) continue;
          const type = i.account?.type;
          if (type !== "User" && type !== "Organization") continue;
          out.push({
            id: String(i.id),
            accountId: String(i.account?.id ?? ""),
            accountLogin: i.account?.login ?? "",
            accountType: type,
            repositorySelection: i.repository_selection === "all" ? "all" : "selected",
          });
        }
        if ((j.installations ?? []).length < 100) break;
      }
      return out;
    },
    async isOrgAdmin(hash, org) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) return false;
      const token = await o.tokens.access(hash);
      if (!token) throw new OpError("unauthenticated", NEEDS_SIGN_IN);
      const res = await f(`${api}/user/memberships/orgs/${encodeURIComponent(org)}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "turntable",
        },
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
      });
      if (!res.ok) return false;
      const j = (await res.json().catch(() => ({}))) as { role?: string; state?: string };
      return j.role === "admin" && j.state === "active";
    },
  };
}
