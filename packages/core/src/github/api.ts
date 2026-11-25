// The slice of the GitHub API the ingest path reads. Trust decisions use what this returns, never
// what a webhook payload claims. Reads only: no GitHub writes yet.
import { type SafeFetch, safeFetch } from "@turntable/net";
import type { AppAuth } from "./app-auth";
import { sanitizeAvatarUrl } from "./avatar";

export interface GithubInstallationFacts {
  id: string;
  appId: string;
  account: { login: string; id: string; type: string; avatarUrl?: string | undefined };
  repositorySelection: string;
  suspended: boolean;
}

export interface GithubRepoFacts {
  id: string;
  name: string;
  owner: string;
  fullName: string;
  /** Whether the repo is private. Absent from an older fake: callers treat absent as private. */
  private?: boolean;
  /** The repo's default branch, as GitHub reports it. */
  defaultBranch?: string;
}

/** Facts about an installation, fetched with the App's own credentials. */
export interface GithubFacts {
  /** Undefined when GitHub says the installation does not exist (any more). */
  getInstallation(installationId: string): Promise<GithubInstallationFacts | undefined>;
  /** Every repo the installation can access, paged to the end. */
  listInstallationRepos(installationId: string): Promise<GithubRepoFacts[]>;
}

export function githubFacts(auth: AppAuth, fetchImpl: SafeFetch = safeFetch): GithubFacts {
  const headers = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "turntable",
  });
  return {
    async getInstallation(installationId) {
      const res = await fetchImpl(
        `${auth.apiBase}/app/installations/${encodeURIComponent(installationId)}`,
        {
          headers: headers(await auth.appJwt()),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`GET installation failed: HTTP ${res.status}`);
      const j = (await res.json()) as {
        id: number;
        app_id: number;
        account: { login: string; id: number; type: string; avatar_url?: unknown };
        repository_selection: string;
        suspended_at: string | null;
      };
      return {
        id: String(j.id),
        appId: String(j.app_id),
        account: {
          login: j.account.login,
          id: String(j.account.id),
          type: j.account.type,
          avatarUrl: sanitizeAvatarUrl(j.account.avatar_url) ?? undefined,
        },
        repositorySelection: j.repository_selection,
        suspended: j.suspended_at !== null,
      };
    },
    async listInstallationRepos(installationId) {
      // Read-only token, scoped to metadata: enough to list repositories.
      const { token } = await auth.mint(installationId, { permissions: { metadata: "read" } });
      const out: GithubRepoFacts[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const res = await fetchImpl(
          `${auth.apiBase}/installation/repositories?per_page=100&page=${page}`,
          {
            headers: headers(token),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!res.ok) throw new Error(`list installation repositories failed: HTTP ${res.status}`);
        const j = (await res.json()) as {
          repositories: {
            id: number;
            name: string;
            full_name: string;
            owner: { login: string };
            private?: boolean;
            default_branch?: string;
          }[];
        };
        for (const r of j.repositories) {
          out.push({
            id: String(r.id),
            name: r.name,
            owner: r.owner.login,
            fullName: r.full_name,
            private: r.private !== false,
            ...(typeof r.default_branch === "string" ? { defaultBranch: r.default_branch } : {}),
          });
        }
        if (j.repositories.length < 100) break;
      }
      return out;
    },
  };
}

/** Resolves a GitHub login to the numeric user id, so an invite binds an account, not a name. */
export interface GithubUserLookup {
  /** Undefined when GitHub has no such user. Throws when GitHub cannot be asked. */
  idOfLogin(login: string): Promise<string | undefined>;
}

/**
 * GitHub could not be asked. The message holds only the HTTP status and, when GitHub says so, the
 * time its rate limit resets: safe to show to the caller.
 */
export class GithubLookupError extends Error {
  override name = "GithubLookupError";
}

/**
 * `GET /users/{login}` is public, so it is asked without credentials. Never with the App's JWT:
 * GitHub accepts a JWT only on the App's own endpoints (`/app/...`), so every lookup would fail.
 * Never with an installation token either: an installation belongs to one tenant, and resolving a
 * login for another tenant must not spend that tenant's credential. The cost is GitHub's
 * unauthenticated budget (60 an hour per address); a lookup refused by it says when to retry.
 * `auth` supplies only the API base.
 */
export function githubUserLookup(
  auth: Pick<AppAuth, "apiBase">,
  fetchImpl: SafeFetch = safeFetch,
): GithubUserLookup {
  return {
    async idOfLogin(login) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return undefined;
      let res: Response;
      try {
        res = await fetchImpl(`${auth.apiBase}/users/${encodeURIComponent(login)}`, {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "turntable",
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new GithubLookupError("GitHub could not be reached");
      }
      if (res.status === 404) return undefined;
      if (!res.ok) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        if ((res.status === 403 || res.status === 429) && remaining === "0" && reset > 0) {
          throw new GithubLookupError(
            `GitHub's unauthenticated rate limit is spent until ${new Date(reset * 1000).toISOString()}`,
          );
        }
        throw new GithubLookupError(`GitHub answered HTTP ${res.status}`);
      }
      const j = (await res.json()) as { id?: unknown; login?: unknown };
      if (typeof j.id !== "number" || typeof j.login !== "string") return undefined;
      // The answer must be for the login asked about (GitHub answers case-insensitively).
      return j.login.toLowerCase() === login.toLowerCase() ? String(j.id) : undefined;
    },
  };
}
