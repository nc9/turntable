// Minimal REST client for the channel: three read operations over `/api/v1` with a reader token.
// The token goes in a header only, never a URL. Nothing here follows redirects, so a hostile
// redirect cannot carry the token to another host.

export class ChannelApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** The token is wrong, expired or too weak: retrying cannot help. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export type FeedEvent = {
  cursor: number;
  id: string;
  type: string;
  project: string | null;
  run_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type RunInfo = {
  id: string;
  project: string;
  workflow_name: string | null;
  workflow_path: string;
  event: string;
  ref: string;
  head_branch: string | null;
  state: string;
  jobs: { id: string; job_key: string; name: string; state: string }[];
};

export type StepInfo = { job_id: string; job_key: string; state: string; step_name: string | null };

export type ChannelApi = {
  events(o: {
    after: number;
    types?: string[];
    limit: number;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<{ events: FeedEvent[]; next_after: number }>;
  getRun(runId: string, signal?: AbortSignal): Promise<RunInfo | null>;
  /** Failing step names only. The excerpt the server returns is dropped here, on purpose. */
  failingSteps(runId: string, signal?: AbortSignal): Promise<StepInfo[]>;
};

/** The base URL without a trailing slash, for joining paths. */
export const baseString = (u: URL): string => u.origin + u.pathname.replace(/\/+$/, "");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Normalises the base URL and refuses plain http to a non-loopback host (the token would travel in clear). */
export function parseBaseUrl(raw: string, allowInsecure = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid --url: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("--url must be http(s)");
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname) && !allowInsecure)
    throw new Error(
      "refusing to send the token over plain http to a remote host; use https (or --allow-insecure)",
    );
  if (url.username || url.password) throw new Error("--url must not carry credentials");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export function createChannelApi(o: {
  baseUrl: URL;
  org: string;
  token: string;
  fetch?: typeof fetch;
}): ChannelApi {
  const f = o.fetch ?? fetch;
  async function call<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`${baseString(o.baseUrl)}/api/v1${path}`);
    url.searchParams.set("org", o.org);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await f(url, {
      headers: { authorization: `Bearer ${o.token}`, accept: "application/json" },
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      try {
        const b = (await res.json()) as { error?: { code?: string; message?: string } };
        code = b.error?.code ?? code;
        message = b.error?.message ?? message;
      } catch {
        // not JSON
      }
      throw new ChannelApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }
  return {
    events: ({ after, types, limit, waitMs, signal }) =>
      call(
        "/events",
        { after, limit, wait_ms: waitMs, ...(types?.length ? { types: types.join(",") } : {}) },
        signal,
      ),
    async getRun(runId, signal) {
      try {
        return await call<RunInfo>(`/runs/${encodeURIComponent(runId)}`, {}, signal);
      } catch (e) {
        if (e instanceof ChannelApiError && e.status === 404) return null;
        throw e;
      }
    },
    async failingSteps(runId, signal) {
      const r = await call<{
        digests: {
          job_id: string;
          job_key: string;
          state: string;
          step: { name: string } | null;
        }[];
      }>("/failure-digest", { run_id: runId }, signal);
      return r.digests.map((d) => ({
        job_id: d.job_id,
        job_key: d.job_key,
        state: d.state,
        step_name: d.step?.name ?? null,
      }));
    },
  };
}
