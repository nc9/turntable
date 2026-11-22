// Impostor commits. GitHub serves commits from a repository's whole fork network under the
// parent's name, so `uses: owner/repo@<sha>` can name a commit that exists only in an attacker's
// fork. An allowlist or a sha pin passes it, and the code is not owner/repo's. So every sha must
// be reachable from a branch or tag of the named repository itself.
import { PlanError } from "@longshore/act-runner";
import { type SafeFetch, safeFetch } from "@longshore/net";
import { InfraError } from "@longshore/provider-sdk";

/** True when `sha` is reachable from a branch or tag of owner/repo. Throws InfraError if GitHub is unreachable. */
export type ReachabilityChecker = (owner: string, repo: string, sha: string) => Promise<boolean>;

export interface GithubReachabilityOptions {
  fetch?: SafeFetch;
  /** Raises the unauthenticated rate limit. Read-only access is enough. */
  token?: string;
  apiBase?: string;
}

const MAX_TAG_PAGES = 10;
const MAX_BRANCH_PAGES = 5;

export function githubReachability(o: GithubReachabilityOptions = {}): ReachabilityChecker {
  const f = o.fetch ?? safeFetch;
  const base = o.apiBase ?? "https://api.github.com";
  const defaultBranch = new Map<string, Promise<string | undefined>>();
  const verdicts = new Map<string, boolean>();

  const get = async (path: string): Promise<Response> => {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "longshore",
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new InfraError(`cannot reach GitHub to verify an action commit`, e);
    }
    return res;
  };
  const transient = (what: string, status: number): InfraError =>
    new InfraError(`verifying an action commit failed (${what}): HTTP ${status}`);

  const branchOf = (full: string): Promise<string | undefined> => {
    let p = defaultBranch.get(full);
    if (!p) {
      p = (async () => {
        const res = await get(`/repos/${full}`);
        if (res.status === 404) return undefined;
        if (!res.ok) throw transient("repository", res.status);
        return ((await res.json()) as { default_branch?: string }).default_branch;
      })();
      defaultBranch.set(full, p);
      p.catch(() => defaultBranch.delete(full));
    }
    return p;
  };

  const headsContain = async (
    full: string,
    kind: "tags" | "branches",
    pages: number,
    sha: string,
  ): Promise<boolean> => {
    for (let page = 1; page <= pages; page += 1) {
      const res = await get(`/repos/${full}/${kind}?per_page=100&page=${page}`);
      if (!res.ok) throw transient(kind, res.status);
      const list = (await res.json()) as { commit?: { sha?: string } }[];
      if (list.some((x) => x.commit?.sha === sha)) return true;
      if (list.length < 100) break;
    }
    return false;
  };

  return async (owner, repo, sha) => {
    const full = `${owner}/${repo}`;
    const key = `${full.toLowerCase()}@${sha}`;
    const cached = verdicts.get(key);
    if (cached !== undefined) return cached;

    const def = await branchOf(full);
    let ok = false;
    if (def !== undefined) {
      // behind or identical: the commit is in the default branch's history.
      const res = await get(`/repos/${full}/compare/${encodeURIComponent(def)}...${sha}`);
      if (res.ok) {
        const status = ((await res.json()) as { status?: string }).status;
        ok = status === "behind" || status === "identical";
      } else if (res.status !== 404 && res.status !== 422) {
        throw transient("compare", res.status);
      }
      if (!ok) ok = await headsContain(full, "tags", MAX_TAG_PAGES, sha);
      if (!ok) ok = await headsContain(full, "branches", MAX_BRANCH_PAGES, sha);
    }
    verdicts.set(key, ok);
    return ok;
  };
}

/** The refusal for an unreachable commit. */
export function impostorError(repo: string, sha: string): PlanError {
  return new PlanError(
    "unreachable-sha",
    `${repo}@${sha} is not reachable from any branch or tag of ${repo}; it may exist only in a fork`,
  );
}
