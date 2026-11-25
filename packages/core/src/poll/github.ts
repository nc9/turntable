// A minimal, READ-ONLY GitHub REST client for polling. Every request is a GET, enforced in
// `#get` (the only place a request is made) and covered by a test. The token, when there is
// one, goes into the Authorization header and nowhere else: never a URL, an error, a log line
// or a returned value.
import type { ForgePermission } from "../trust";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
import { safeFetch } from "@turntable/net";

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
  /** The base branch the PR targets. */
  baseRef: string;
  /** The commit the base branch pointed at when the PR was read. For `github.event`. */
  baseSha?: string;
  /** Forge facts for `github.event.pull_request`. Text fields are attacker-controlled: data only. */
  authorType: string | null;
  body: string;
  labels: string[];
  draft: boolean;
  /** The head repo's own `fork` flag, as GitHub reports it; absent when the head repo is gone. */
  headFork?: boolean;
};

/** Most bytes of a PR body kept for the event payload. */
export const MAX_PR_BODY_BYTES = 64 * 1024;
/** Most labels kept. */
const MAX_PR_LABELS = 100;

/** `s` cut to at most `max` UTF-8 bytes, never in the middle of a character. */
export function capUtf8(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

type Cached = { etag: string; body: unknown };

/** Pages of 100 files fetched per comparison (300 files, GitHub's own cap for this endpoint). */
const MAX_COMPARE_PAGES = 3;

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** What a tag ruleset covers and who may bypass it. */
export interface TagRuleset {
  include: string[];
  exclude: string[];
  rules: string[];
  /** Who may bypass it. Undefined when the API did not say (it omits the list without admin read access). */
  bypass: { type: string; id: number | null }[] | undefined;
  /** When the ruleset was last changed (epoch ms), if the API says: what it enforces now applies from then. */
  updatedAt?: number | undefined;
}

export class GithubClient {
  readonly #fetch: FetchLike;
  readonly #base: string;
  #token: string | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, Cached>();
  #rate: RateLimitInfo | undefined;

  constructor(o: {
    fetch?: FetchLike;
    baseUrl: string;
    token?: string | undefined;
    now?: () => number;
  }) {
    this.#fetch = o.fetch ?? ((url, init) => safeFetch(url, init));
    this.#base = o.baseUrl.replace(/\/$/, "");
    this.#token = o.token;
    this.#now = o.now ?? Date.now;
  }

  /**
   * Swaps the credential, for an installation token that was minted again. The ETag cache and the
   * rate-limit reading stay: they belong to this client's one auth mode and repo.
   */
  setToken(token: string | undefined): void {
    this.#token = token;
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
      "user-agent": "turntable-poller",
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

  /** The repo's default branch on GitHub, for a repo ingested from its installation binding. */
  async repoDefaultBranch(repo: string): Promise<string> {
    const body = (await this.#get(`/repos/${repo}`)) as { default_branch?: string };
    const b = body.default_branch;
    if (typeof b !== "string" || !/^[A-Za-z0-9._/-]{1,255}$/.test(b)) {
      throw new GithubError(502, `/repos/${repo}`);
    }
    return b;
  }

  /** The repo's stable forge id and current full name (a renamed repo's old slug redirects). */
  async repoIdentity(repo: string): Promise<{ id: string; fullName: string }> {
    const body = (await this.#get(`/repos/${repo}`)) as { id?: unknown; full_name?: unknown };
    if (
      (typeof body.id !== "number" && typeof body.id !== "string") ||
      typeof body.full_name !== "string"
    ) {
      throw new GithubError(502, `/repos/${repo}`);
    }
    return { id: String(body.id), fullName: body.full_name };
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
  async commitInfo(
    repo: string,
    sha: string,
  ): Promise<{ author: string | null; message: string; parents: string[] }> {
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new GithubError(400, "/commits/<invalid sha>");
    const body = (await this.#get(`/repos/${repo}/commits/${sha.toLowerCase()}`)) as {
      commit?: { message?: string };
      author?: { login?: string } | null;
      parents?: { sha?: string }[];
    };
    return {
      author: body.author?.login ?? null,
      message: body.commit?.message ?? "",
      parents: (body.parents ?? []).flatMap((p) =>
        typeof p.sha === "string" && /^[0-9a-f]{40,64}$/i.test(p.sha) ? [p.sha.toLowerCase()] : [],
      ),
    };
  }

  /**
   * The repo's recent push events (the events API: the last few hundred events, delayed by up to
   * minutes), with the ref, the sha pushed and the sha the ref was at before: GitHub's own
   * `before` for each push. Empty when the API says no. Conditional like every read.
   */
  async pushEvents(repo: string): Promise<{ ref: string; head: string; before: string }[]> {
    let body: unknown;
    try {
      body = await this.#get(`/repos/${repo}/events?per_page=100`);
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      return [];
    }
    if (!Array.isArray(body)) return [];
    return body.flatMap(
      (e: { type?: string; payload?: { ref?: string; head?: string; before?: string } }) => {
        const p = e.payload;
        return e.type === "PushEvent" &&
          typeof p?.ref === "string" &&
          typeof p.head === "string" &&
          typeof p.before === "string" &&
          /^[0-9a-f]{40,64}$/i.test(p.head) &&
          /^[0-9a-f]{40,64}$/i.test(p.before)
          ? [{ ref: p.ref, head: p.head.toLowerCase(), before: p.before.toLowerCase() }]
          : [];
      },
    );
  }

  /**
   * The first-parent commits from `head` back to, not including, `stop`, newest first, at most
   * `limit` of them. `reached` says whether `stop` was met (the gap is exactly these commits), so
   * an unrelated `stop` (a force push) gives `reached: false`.
   */
  async firstParentsSince(
    repo: string,
    head: string,
    stop: string,
    limit: number,
  ): Promise<{ shas: string[]; reached: boolean } | undefined> {
    if (!/^[0-9a-f]{40,64}$/i.test(head)) return undefined;
    const parents = new Map<string, string | undefined>();
    let body: { sha?: string; parents?: { sha?: string }[] }[];
    try {
      const got = await this.#get(`/repos/${repo}/commits?sha=${head.toLowerCase()}&per_page=100`);
      body = Array.isArray(got) ? got : [];
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      return undefined;
    }
    for (const c of body) {
      if (typeof c.sha === "string")
        parents.set(c.sha.toLowerCase(), c.parents?.[0]?.sha?.toLowerCase());
    }
    const shas: string[] = [];
    let cur: string | undefined = head.toLowerCase();
    const want = stop.toLowerCase();
    while (cur !== undefined && parents.has(cur)) {
      if (cur === want) return { shas: shas.slice(0, limit), reached: true };
      shas.push(cur);
      cur = parents.get(cur);
    }
    return { shas: shas.slice(0, limit), reached: false };
  }

  /**
   * The merge queue's temporary branches for a base branch: `gh-readonly-queue/<base>/pr-<n>-<sha>`,
   * with the commit each points at. Anyone with write access can create a branch with that prefix,
   * so the caller must not trust these without `queueCommit`.
   */
  async queueBranches(repo: string, base: string): Promise<{ ref: string; sha: string }[]> {
    if (!/^[A-Za-z0-9._/-]{1,255}$/.test(base)) return [];
    const prefix = `gh-readonly-queue/${base.split("/").map(encodeURIComponent).join("/")}/`;
    try {
      const body = (await this.#get(`/repos/${repo}/git/matching-refs/heads/${prefix}`)) as {
        ref?: string;
        object?: { sha?: string };
      }[];
      return (Array.isArray(body) ? body : []).flatMap((r) =>
        typeof r.ref === "string" && typeof r.object?.sha === "string"
          ? [{ ref: r.ref, sha: r.object.sha.toLowerCase() }]
          : [],
      );
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * Tag refs whose name starts with `prefix` (empty: all), as the matching refs API lists them:
   * the ref and what it points at, with NO dereferencing. Filtering by pattern happens before an
   * annotated tag costs a request (see `peelTag`). Conditional like every read.
   */
  async tagRefs(
    repo: string,
    prefix: string,
  ): Promise<{ ref: string; type: "commit" | "tag"; sha: string }[]> {
    if (!/^[A-Za-z0-9._/-]{0,100}$/.test(prefix)) return [];
    const path = `/repos/${repo}/git/matching-refs/tags/${prefix.split("/").map(encodeURIComponent).join("/")}`;
    let body: { ref?: string; object?: { type?: string; sha?: string } }[];
    try {
      const got = await this.#get(path);
      body = Array.isArray(got) ? got : [];
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return [];
      throw err;
    }
    return body.flatMap((r) => {
      const type = r.object?.type;
      const sha = r.object?.sha;
      return typeof r.ref === "string" &&
        r.ref.startsWith("refs/tags/") &&
        (type === "commit" || type === "tag") &&
        typeof sha === "string" &&
        /^[0-9a-f]{40,64}$/i.test(sha)
        ? [{ ref: r.ref, type, sha: sha.toLowerCase() }]
        : [];
    });
  }

  /**
   * An annotated tag object followed to its commit (a few levels at most), with the name its
   * outermost tag object gives as the tagger. The tagger is text the tag's author typed (the API
   * has a name and an email, not a verified login), so it is a label and never an identity.
   * Undefined when the chain does not end at a commit.
   */
  async peelTag(
    repo: string,
    objectSha: string,
  ): Promise<{ sha: string; tagger: string | null } | undefined> {
    let sha = objectSha.toLowerCase();
    let tagger: string | null = null;
    for (let i = 0; i < 3; i += 1) {
      if (!/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
      const body = (await this.#get(`/repos/${repo}/git/tags/${sha}`)) as {
        tagger?: { name?: string } | null;
        object?: { type?: string; sha?: string };
      };
      if (i === 0) tagger = typeof body.tagger?.name === "string" ? body.tagger.name : null;
      const o = body.object;
      if (typeof o?.sha !== "string") return undefined;
      sha = o.sha.toLowerCase();
      if (o.type === "commit") return /^[0-9a-f]{40,64}$/.test(sha) ? { sha, tagger } : undefined;
      if (o.type !== "tag") return undefined;
    }
    return undefined;
  }

  /**
   * The first-parent history of `head`: the commits that were themselves the tip of the branch at
   * some point (a squash, a rebase, a direct push, or a merge commit), NOT the intermediate commits
   * a merged branch brought in. Built from the commit listing (up to `depth` commits, 100 per
   * request) by following each commit's first parent. Undefined when the chain cannot be followed
   * (a parent is outside the listing: the history is deeper than `depth`, or the API said no).
   */
  async firstParentChain(
    repo: string,
    head: string,
    depth = 1000,
  ): Promise<Set<string> | undefined> {
    if (!/^[0-9a-f]{40,64}$/i.test(head)) return undefined;
    const parents = new Map<string, string | undefined>();
    for (let page = 1; page <= Math.ceil(depth / 100); page += 1) {
      let body: { sha?: string; parents?: { sha?: string }[] }[];
      try {
        const got = await this.#get(
          `/repos/${repo}/commits?sha=${head.toLowerCase()}&per_page=100&page=${page}`,
        );
        body = Array.isArray(got) ? got : [];
      } catch (err) {
        if (err instanceof GithubError && (err.status === 404 || err.status === 422))
          return undefined;
        throw err;
      }
      for (const c of body) {
        if (typeof c.sha === "string")
          parents.set(c.sha.toLowerCase(), c.parents?.[0]?.sha?.toLowerCase());
      }
      if (body.length < 100) break;
    }
    const chain = new Set<string>();
    let cur: string | undefined = head.toLowerCase();
    while (cur !== undefined && chain.size < depth) {
      if (!parents.has(cur)) break;
      chain.add(cur);
      cur = parents.get(cur);
    }
    return chain.has(head.toLowerCase()) ? chain : undefined;
  }

  /**
   * The repository's rulesets that govern tags and are active, with what each one covers and who
   * may bypass it, for the one question that matters here: is the creation of a tag restricted.
   * `"unknown"` for any failure to read them (no permission, an error): the caller treats that as
   * not protected. Includes rulesets inherited from the organization.
   */
  async tagRulesets(repo: string): Promise<TagRuleset[] | "unknown"> {
    try {
      const list = (await this.#get(
        `/repos/${repo}/rulesets?includes_parents=true&per_page=100`,
      )) as { id?: number; target?: string; enforcement?: string }[];
      if (!Array.isArray(list)) return "unknown";
      const out: TagRuleset[] = [];
      for (const r of list) {
        if (r.target !== "tag" || r.enforcement !== "active" || typeof r.id !== "number") continue;
        const d = (await this.#get(`/repos/${repo}/rulesets/${r.id}?includes_parents=true`)) as {
          enforcement?: string;
          conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
          rules?: { type?: string }[];
          bypass_actors?: { actor_type?: string; actor_id?: number | null }[];
          updated_at?: string;
        };
        if (d.enforcement !== "active") continue;
        const updated = typeof d.updated_at === "string" ? Date.parse(d.updated_at) : Number.NaN;
        out.push({
          ...(Number.isFinite(updated) ? { updatedAt: updated } : {}),
          include: (d.conditions?.ref_name?.include ?? []).filter((x) => typeof x === "string"),
          exclude: (d.conditions?.ref_name?.exclude ?? []).filter((x) => typeof x === "string"),
          rules: (d.rules ?? []).flatMap((x) => (typeof x.type === "string" ? [x.type] : [])),
          bypass: Array.isArray(d.bypass_actors)
            ? d.bypass_actors.map((b) => ({
                type: String(b.actor_type ?? ""),
                id: typeof b.actor_id === "number" ? b.actor_id : null,
              }))
            : undefined,
        });
      }
      return out;
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      return "unknown";
    }
  }

  /**
   * What proves a merge queue commit was made by GitHub: a signature GitHub verified and GitHub's
   * own committer address. Someone with write access can push a branch named like a queue branch,
   * but cannot make GitHub sign it.
   */
  async queueCommit(
    repo: string,
    sha: string,
  ): Promise<{
    verified: boolean;
    committerEmail: string | null;
    parents: string[];
    message: string;
  }> {
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new GithubError(400, "/commits/<invalid sha>");
    const body = (await this.#get(`/repos/${repo}/commits/${sha.toLowerCase()}`)) as {
      parents?: { sha?: string }[];
      commit?: {
        message?: string;
        committer?: { email?: string } | null;
        verification?: { verified?: boolean; reason?: string } | null;
      };
    };
    return {
      verified: body.commit?.verification?.verified === true,
      committerEmail: body.commit?.committer?.email ?? null,
      parents: (body.parents ?? []).flatMap((p) => (typeof p.sha === "string" ? [p.sha] : [])),
      message: body.commit?.message ?? "",
    };
  }

  /**
   * One pull request's state, fetched on its own (the open list is a single page, so a PR missing
   * from it is not proof that it closed). `closed` covers merged too; `unknown` for anything else.
   */
  async pullState(repo: string, number: number): Promise<"open" | "closed" | "unknown"> {
    if (!Number.isSafeInteger(number) || number < 1) return "unknown";
    const body = (await this.#get(`/repos/${repo}/pulls/${number}`)) as { state?: unknown };
    return body.state === "open" || body.state === "closed" ? body.state : "unknown";
  }

  async openPulls(repo: string): Promise<PullRequest[]> {
    const body = (await this.#get(
      `/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
    )) as {
      number: number;
      title?: string;
      body?: string | null;
      draft?: boolean;
      labels?: { name?: unknown }[] | null;
      user?: { login?: string; type?: string } | null;
      head?: {
        sha?: string;
        ref?: string;
        repo?: { full_name?: string; fork?: boolean } | null;
      };
      base?: { ref?: string; sha?: string; repo?: { full_name?: string } };
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
          baseRef: p.base?.ref ?? "",
          ...(typeof p.base?.sha === "string" ? { baseSha: p.base.sha.toLowerCase() } : {}),
          authorType: typeof p.user?.type === "string" ? p.user.type : null,
          body: capUtf8(typeof p.body === "string" ? p.body : "", MAX_PR_BODY_BYTES),
          labels: (Array.isArray(p.labels) ? p.labels : [])
            .flatMap((l) => (typeof l?.name === "string" ? [l.name] : []))
            .slice(0, MAX_PR_LABELS),
          draft: p.draft === true,
          ...(p.head.repo && typeof p.head.repo.fork === "boolean"
            ? { headFork: p.head.repo.fork }
            : {}),
        },
      ];
    });
  }

  /**
   * Files changed between two refs (`base...head`, the merge-base form, which is what GitHub's
   * own path filters use for pull requests). Read-only and ETag-cached like every request.
   * Returns undefined when the answer cannot be trusted: the comparison does not exist (a force
   * push removed the base), or it is larger than what one poll will page through. The caller
   * then treats the changed files as unknown, which runs the workflow.
   */
  async changedFiles(repo: string, base: string, head: string): Promise<string[] | undefined> {
    const safe = /^[A-Za-z0-9._/-]{1,255}$/;
    if (!safe.test(base) || !safe.test(head)) return undefined;
    const spec = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const files: string[] = [];
    try {
      for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
        const body = (await this.#get(
          `/repos/${repo}/compare/${spec}?per_page=100&page=${page}`,
        )) as {
          files?: { filename?: string; previous_filename?: string }[];
          total_commits?: number;
        };
        const got = body.files ?? [];
        for (const f of got) {
          if (typeof f.filename === "string") files.push(f.filename);
          // A rename touches the old path too, and path filters match on it.
          if (typeof f.previous_filename === "string") files.push(f.previous_filename);
        }
        if (got.length < 100) return files;
      }
      return undefined; // more files than we page through
    } catch (err) {
      if (err instanceof GithubError && (err.status === 404 || err.status === 422))
        return undefined;
      throw err;
    }
  }

  /**
   * What a user may do in the repo, from `GET /repos/{o}/{r}/collaborators/{user}/permission`.
   * Uses `role_name` (admin, maintain, write, triage, read, or a custom role) because the legacy
   * `permission` field folds maintain into write and triage into read; a custom role falls back
   * to the legacy field. A user who is not a collaborator, or does not exist, is `none`. Returns
   * `unknown` when the token is not allowed to ask (401, 403, or no token): the caller must then
   * treat the user as untrusted. Rate limits and server errors propagate, so the poll retries.
   */
  async collaboratorPermission(repo: string, user: string): Promise<ForgePermission | "unknown"> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]|\[bot\])*$/.test(user) || user.length > 100) return "none";
    if (!this.#token) return "unknown";
    try {
      const body = (await this.#get(
        `/repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`,
      )) as { permission?: string; role_name?: string };
      const known = ["admin", "maintain", "write", "triage", "read", "none"] as const;
      const role = body.role_name;
      if (role && (known as readonly string[]).includes(role)) return role as ForgePermission;
      const legacy = body.permission;
      // A custom role: only the legacy field's verdict, and never above write.
      if (legacy === "admin" || legacy === "write" || legacy === "read" || legacy === "none") {
        return legacy === "admin" ? "write" : legacy;
      }
      return "unknown";
    } catch (err) {
      if (err instanceof GithubError) {
        if (err.status === 404) return "none";
        if (err.status === 401 || err.status === 403) return "unknown";
      }
      throw err;
    }
  }

  /** Whether the forge says a branch is protected (`GET /repos/{o}/{r}/branches/{branch}`). */
  async branchProtected(repo: string, branch: string): Promise<boolean | undefined> {
    try {
      const body = (await this.#get(`/repos/${repo}/branches/${encodeURIComponent(branch)}`)) as {
        protected?: boolean;
      };
      return typeof body.protected === "boolean" ? body.protected : undefined;
    } catch (err) {
      if (err instanceof GithubError && [401, 403, 404].includes(err.status)) return undefined;
      throw err;
    }
  }

  /**
   * What `refs/heads/<name>` or `refs/tags/<name>` points at in THIS repository (a fork's branch
   * is not here), or undefined when no such ref exists. An annotated tag is returned as the tag
   * object (`type: "tag"`) for `peelTag`.
   */
  async refObject(
    repo: string,
    kind: "heads" | "tags",
    name: string,
  ): Promise<{ type: "commit" | "tag"; sha: string } | undefined> {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name)) return undefined;
    try {
      const body = (await this.#get(
        `/repos/${repo}/git/ref/${kind}/${name.split("/").map(encodeURIComponent).join("/")}`,
      )) as { object?: { type?: string; sha?: string } };
      const type = body.object?.type;
      const sha = body.object?.sha;
      return (type === "commit" || type === "tag") &&
        typeof sha === "string" &&
        /^[0-9a-f]{40,64}$/i.test(sha)
        ? { type, sha: sha.toLowerCase() }
        : undefined;
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return undefined;
      throw err;
    }
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

  /**
   * The files directly in a directory at a commit (the contents API listing), name and size only.
   * Empty when the directory does not exist there. Never reads file contents.
   */
  async listDir(
    repo: string,
    dir: string,
    ref: string,
  ): Promise<{ path: string; size: number; isFile: boolean }[]> {
    try {
      const encoded = dir.split("/").map(encodeURIComponent).join("/");
      const body = await this.#get(
        `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      );
      if (!Array.isArray(body)) return [];
      return body.flatMap((e: { path?: unknown; size?: unknown; type?: unknown }) =>
        typeof e.path === "string"
          ? [
              {
                path: e.path,
                size: typeof e.size === "number" ? e.size : 0,
                isFile: e.type === "file",
              },
            ]
          : [],
      );
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return [];
      throw err;
    }
  }
}
