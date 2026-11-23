// The slice of the GitHub API the ingest path reads. Trust decisions use what this returns, never
// what a webhook payload claims. Reads only: no GitHub writes yet.
import { type SafeFetch, safeFetch } from "@turntable/net";
import type { AppAuth } from "./app-auth";

export interface GithubInstallationFacts {
  id: string;
  appId: string;
  account: { login: string; id: string; type: string };
  repositorySelection: string;
  suspended: boolean;
}

export interface GithubRepoFacts {
  id: string;
  name: string;
  owner: string;
  fullName: string;
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
        account: { login: string; id: number; type: string };
        repository_selection: string;
        suspended_at: string | null;
      };
      return {
        id: String(j.id),
        appId: String(j.app_id),
        account: { login: j.account.login, id: String(j.account.id), type: j.account.type },
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
          repositories: { id: number; name: string; full_name: string; owner: { login: string } }[];
        };
        for (const r of j.repositories) {
          out.push({ id: String(r.id), name: r.name, owner: r.owner.login, fullName: r.full_name });
        }
        if (j.repositories.length < 100) break;
      }
      return out;
    },
  };
}
