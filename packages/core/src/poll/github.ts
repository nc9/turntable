// A minimal, read-only GitHub REST client for polling. The token, when there is one, is added to
// the request and nowhere else: it is not stored in errors, logs or returned values.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class RateLimited extends Error {
  /** Epoch ms when the limit resets, when GitHub said. */
  readonly resetAt: number | undefined;
  constructor(resetAt: number | undefined) {
    super("GitHub API rate limit reached");
    this.resetAt = resetAt;
  }
}

export class GithubError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`GitHub API ${status} for ${path}`);
    this.status = status;
  }
}

export type BranchHead = {
  sha: string;
  message: string;
  /** Forge login of the commit author, or null when GitHub has no account for it. */
  author: string | null;
};

export type PullRequest = {
  number: number;
  title: string;
  author: string | null;
  headSha: string;
  headRef: string;
  /** `owner/name` of the head repo; null when the fork was deleted. */
  headRepo: string | null;
  baseRepo: string;
};

type Cached = { etag: string; body: unknown };

export class GithubClient {
  readonly #fetch: FetchLike;
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #cache = new Map<string, Cached>();

  constructor(o: { fetch?: FetchLike; baseUrl: string; token?: string | undefined }) {
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#base = o.baseUrl.replace(/\/$/, "");
    this.#token = o.token;
  }

  /**
   * GET with a conditional request: a 304 reuses the cached body, which GitHub does not count
   * against the rate limit, so a steady poll of an idle repo is nearly free.
   */
  async #get(path: string, accept = "application/vnd.github+json"): Promise<unknown> {
    const cached = this.#cache.get(path);
    const headers: Record<string, string> = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "turntable-poller",
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      ...(cached ? { "if-none-match": cached.etag } : {}),
    };
    const res = await this.#fetch(`${this.#base}${path}`, { headers });
    if (res.status === 304 && cached) return cached.body;
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 429 || remaining === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        throw new RateLimited(Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined);
      }
    }
    if (!res.ok) throw new GithubError(res.status, path);
    const body: unknown = accept.includes("raw") ? await res.text() : await res.json();
    const etag = res.headers.get("etag");
    if (etag) this.#cache.set(path, { etag, body });
    return body;
  }

  async branchHead(repo: string, branch: string): Promise<BranchHead> {
    const body = (await this.#get(`/repos/${repo}/commits/${encodeURIComponent(branch)}`)) as {
      sha?: string;
      commit?: { message?: string };
      author?: { login?: string } | null;
    };
    if (typeof body.sha !== "string") throw new GithubError(502, `/repos/${repo}/commits`);
    return {
      sha: body.sha.toLowerCase(),
      message: body.commit?.message ?? "",
      author: body.author?.login ?? null,
    };
  }

  async openPulls(repo: string): Promise<PullRequest[]> {
    const body = (await this.#get(
      `/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
    )) as {
      number: number;
      title?: string;
      user?: { login?: string } | null;
      head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
      base?: { repo?: { full_name?: string } };
    }[];
    return body.flatMap((p) => {
      const baseRepo = p.base?.repo?.full_name;
      if (typeof p.head?.sha !== "string" || typeof baseRepo !== "string") return [];
      return [
        {
          number: p.number,
          title: p.title ?? "",
          author: p.user?.login ?? null,
          headSha: p.head.sha.toLowerCase(),
          headRef: p.head.ref ?? "",
          headRepo: p.head.repo?.full_name ?? null,
          baseRepo,
        },
      ];
    });
  }

  /** Raw file content at a commit, or undefined when it does not exist there. */
  async fileAt(repo: string, path: string, sha: string): Promise<string | undefined> {
    try {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      return (await this.#get(
        `/repos/${repo}/contents/${encoded}?ref=${sha}`,
        "application/vnd.github.raw+json",
      )) as string;
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return undefined;
      throw err;
    }
  }
}
