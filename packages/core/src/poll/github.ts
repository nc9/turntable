// A minimal, READ-ONLY GitHub REST client for polling. Every request is a GET, enforced in
// `#get` (the only place a request is made) and covered by a test. The token, when there is
// one, goes into the Authorization header and nowhere else: never a URL, an error, a log line
// or a returned value.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What GitHub last said about the rate limit, from the `x-ratelimit-*` headers. */
export type RateLimitInfo = {
  limit: number | undefined;
  remaining: number | undefined;
  /** Epoch ms when the window resets. */
  resetAt: number | undefined;
  resource: string | undefined;
  /** Epoch ms when we saw these headers. */
  observedAt: number;
};

export class RateLimited extends Error {
  /** Epoch ms when the limit resets, when GitHub said. */
  readonly resetAt: number | undefined;
  /** Milliseconds GitHub asked us to wait (`Retry-After`), when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(resetAt: number | undefined, retryAfterMs?: number) {
    super("GitHub API rate limit reached");
    this.resetAt = resetAt;
    this.retryAfterMs = retryAfterMs;
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
  /** Who opened it. */
  author: string | null;
  headSha: string;
  headRef: string;
  /** `owner/name` of the head repo; null when the fork was deleted. */
  headRepo: string | null;
  baseRepo: string;
};

type Cached = { etag: string; body: unknown };

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export class GithubClient {
  readonly #fetch: FetchLike;
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, Cached>();
  #rate: RateLimitInfo | undefined;

  constructor(o: {
    fetch?: FetchLike;
    baseUrl: string;
    token?: string | undefined;
    now?: () => number;
  }) {
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#base = o.baseUrl.replace(/\/$/, "");
    this.#token = o.token;
    this.#now = o.now ?? Date.now;
  }

  /** The latest rate-limit headers seen (304 responses carry them too), or undefined. */
  get rateLimit(): RateLimitInfo | undefined {
    return this.#rate;
  }

  #observe(res: Response): void {
    const limit = num(res.headers.get("x-ratelimit-limit"));
    const remaining = num(res.headers.get("x-ratelimit-remaining"));
    const reset = num(res.headers.get("x-ratelimit-reset"));
    if (limit === undefined && remaining === undefined && reset === undefined) return;
    this.#rate = {
      limit,
      remaining,
      resetAt: reset === undefined ? undefined : reset * 1000,
      resource: res.headers.get("x-ratelimit-resource") ?? undefined,
      observedAt: this.#now(),
    };
  }

  /**
   * The only request path, and it only ever sends GET. A conditional request: a 304 reuses the
   * cached body, which GitHub does not count against the rate limit.
   */
  async #get(path: string, accept = "application/vnd.github+json"): Promise<unknown> {
    const cached = this.#cache.get(path);
    const headers: Record<string, string> = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "longshore-poller",
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      ...(cached ? { "if-none-match": cached.etag } : {}),
    };
    const url = `${this.#base}${path}`;
    if (this.#token && url.includes(this.#token))
      throw new Error("refusing to put a token in a URL");
    const res = await this.#fetch(url, { method: "GET", headers });
    this.#observe(res);
    if (res.status === 304 && cached) return cached.body;
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const retryAfter = num(res.headers.get("retry-after"));
      // Primary limit (remaining 0), secondary limit (a Retry-After) or a plain 429.
      if (res.status === 429 || remaining === "0" || retryAfter !== undefined) {
        const reset = num(res.headers.get("x-ratelimit-reset"));
        throw new RateLimited(
          reset === undefined || reset <= 0 ? undefined : reset * 1000,
          retryAfter === undefined ? undefined : retryAfter * 1000,
        );
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

  /**
   * Who wrote a commit and what they said. `author` is the login of the account GitHub links to
   * the commit's author, or null when it links none (an email that matches no account). Commits
   * are immutable, so the ETag cache makes repeats free.
   */
  async commitInfo(repo: string, sha: string): Promise<{ author: string | null; message: string }> {
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new GithubError(400, "/commits/<invalid sha>");
    const body = (await this.#get(`/repos/${repo}/commits/${sha.toLowerCase()}`)) as {
      commit?: { message?: string };
      author?: { login?: string } | null;
    };
    return { author: body.author?.login ?? null, message: body.commit?.message ?? "" };
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
