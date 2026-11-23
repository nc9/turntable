// The check-runs API of GitHub, behind a small interface. Every request goes through the
// SSRF-guarded outbound client (address validation, pinned resolution, redirect rules, caps); a
// test injects its own.
import { type SafeFetch, safeFetch } from "@turntable/net";

export type CheckRunBody = {
  name?: string;
  head_sha?: string;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped";
  started_at?: string;
  completed_at?: string;
  details_url?: string;
  external_id?: string;
  output?: { title: string; summary: string };
};

export interface CheckRunsApi {
  /** Creates a check run on `owner/name` and returns its id. */
  create(token: string, repo: string, body: CheckRunBody): Promise<string>;
  update(token: string, repo: string, id: string, body: CheckRunBody): Promise<void>;
  /** An existing check run of this name on the commit with this external id, if there is one. */
  findByExternalId(
    token: string,
    repo: string,
    sha: string,
    name: string,
    externalId: string,
  ): Promise<string | undefined>;
}

/** A failed call. `retryable` is true for outages and rate limits, false for a refusal. */
export class CheckRunsError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, what: string) {
    super(`GitHub ${what} failed: HTTP ${status}`);
    this.status = status;
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

export type HttpFetch = SafeFetch;

export function githubCheckRunsApi(
  o: { baseUrl?: string; fetch?: HttpFetch; timeoutMs?: number } = {},
): CheckRunsApi {
  const base = (o.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch: HttpFetch = o.fetch ?? safeFetch;
  async function call(
    token: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    what: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          // The token goes in this header and nowhere else: never a URL, an error or a log.
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "turntable",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new CheckRunsError(0, what);
    }
    if (!res.ok) throw new CheckRunsError(res.status, what);
    return res.json();
  }
  const safeRepo = (repo: string): string => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
      throw new CheckRunsError(400, "repo name");
    return repo;
  };
  return {
    async create(token, repo, body) {
      const json = (await call(
        token,
        "POST",
        `/repos/${safeRepo(repo)}/check-runs`,
        "create check run",
        body,
      )) as { id?: number };
      if (typeof json.id !== "number") throw new CheckRunsError(502, "create check run");
      return String(json.id);
    },
    async update(token, repo, id, body) {
      if (!/^\d+$/.test(id)) throw new CheckRunsError(400, "check run id");
      await call(
        token,
        "PATCH",
        `/repos/${safeRepo(repo)}/check-runs/${id}`,
        "update check run",
        body,
      );
    },
    async findByExternalId(token, repo, sha, name, externalId) {
      if (!/^[0-9a-f]{40,64}$/i.test(sha)) return undefined;
      const json = (await call(
        token,
        "GET",
        `/repos/${safeRepo(repo)}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
        "list check runs",
      )) as { check_runs?: { id?: number; external_id?: string | null }[] };
      const hit = json.check_runs?.find((c) => c.external_id === externalId);
      return typeof hit?.id === "number" ? String(hit.id) : undefined;
    },
  };
}
