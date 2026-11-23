// The two read-only sides of a parity comparison: our run over the REST API with a reader token,
// and the check runs another CI posted for a commit, from GitHub's checks API. Neither side is
// written to. Tokens go in a header only; redirects are refused so a token cannot be carried to
// another host. Every request goes through @turntable/net.
import { foldShardStates } from "@turntable/act-runner";
import { createHttpClient, type SafeFetch } from "@turntable/net";
import { baseString } from "../channel/api";
import type { OurJob, TheirCheck } from "./compare";

export class ParityApiError extends Error {}

async function getJson(
  f: SafeFetch,
  url: URL,
  headers: Record<string, string>,
  what: string,
): Promise<unknown> {
  const res = await f(url, { headers, redirect: "error" });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: { message?: string }; message?: string };
      msg = b.error?.message ?? b.message ?? msg;
    } catch {
      // not JSON
    }
    throw new ParityApiError(`${what}: ${msg}`);
  }
  return res.json();
}

export type OurRunRef = { id: string; sha: string | null; state: string };

/** The newest runs matching a branch and event, newest first (one page, at most 100). */
export async function listOurRuns(o: {
  baseUrl: URL;
  org: string;
  token: string;
  branch?: string | undefined;
  event?: string | undefined;
  limit: number;
  fetch?: SafeFetch;
}): Promise<OurRunRef[]> {
  const f = o.fetch ?? createHttpClient({ allowHosts: [o.baseUrl.hostname] }).fetch;
  const u = new URL(`${baseString(o.baseUrl)}/api/v1/runs`);
  u.searchParams.set("org", o.org);
  u.searchParams.set("limit", String(Math.min(100, Math.max(1, o.limit))));
  if (o.branch) u.searchParams.set("branch", o.branch);
  if (o.event) u.searchParams.set("event", o.event);
  const body = (await getJson(
    f,
    u,
    { authorization: `Bearer ${o.token}`, accept: "application/json" },
    "our runs",
  )) as { runs?: { id: string; sha: string | null; state: string }[] };
  return (body.runs ?? []).map((r) => ({ id: r.id, sha: r.sha, state: r.state }));
}

export type OurRun = { id: string; sha: string | null; jobs: OurJob[] };

/** Our run's jobs, with the stored reason for each skipped job (its log's first line). */
export async function fetchOurRun(o: {
  baseUrl: URL;
  org: string;
  token: string;
  runId: string;
  fetch?: SafeFetch;
}): Promise<OurRun> {
  const f = o.fetch ?? createHttpClient({ allowHosts: [o.baseUrl.hostname] }).fetch;
  const headers = { authorization: `Bearer ${o.token}`, accept: "application/json" };
  const url = (path: string, q: Record<string, string> = {}): URL => {
    const u = new URL(`${baseString(o.baseUrl)}/api/v1${path}`);
    u.searchParams.set("org", o.org);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u;
  };
  const run = (await getJson(
    f,
    url(`/runs/${encodeURIComponent(o.runId)}`),
    headers,
    "our run",
  )) as {
    id: string;
    sha: string | null;
    jobs: {
      id: string;
      name: string;
      state: string;
      duration_ms: number | null;
      started_at?: string | null;
      finished_at?: string | null;
      shard?: { job: string; index: number; total: number } | null;
    }[];
  };
  const jobs: OurJob[] = [];
  // The shards of one split job are one job: its state is the fold of theirs and its duration the
  // wall time from the first shard's start to the last one's finish (never the sum), counting only the shards that ran.
  const shards = new Map<string, typeof run.jobs>();
  for (const j of run.jobs) {
    if (!j.shard) continue;
    const g = shards.get(j.shard.job) ?? [];
    g.push(j);
    shards.set(j.shard.job, g);
  }
  const skipReasonOf = async (j: { id: string; name: string }): Promise<string> => {
    const log = (await getJson(
      f,
      url(`/jobs/${encodeURIComponent(j.id)}/log`, { mode: "head", lines: "1" }),
      headers,
      `log of ${j.name}`,
    )) as { text?: string };
    return (log.text ?? "").split("\n", 1)[0]?.replace(/^(skipped|cancelled): /, "") ?? "";
  };
  const folded = new Set<string>();
  for (const j of run.jobs) {
    if (j.shard) {
      if (folded.has(j.shard.job)) continue;
      folded.add(j.shard.job);
      const group = shards.get(j.shard.job)!;
      const state = foldShardStates(group.map((g) => g.state));
      // Skipped shards (none of their paths changed) never ran: they do not count toward the wall time.
      const ran = group.filter((g) => g.state !== "skipped");
      const starts = ran.map((g) => (g.started_at ? Date.parse(g.started_at) : Number.NaN));
      const ends = ran.map((g) => (g.finished_at ? Date.parse(g.finished_at) : Number.NaN));
      const done = ran.length > 0 && [...starts, ...ends].every(Number.isFinite);
      jobs.push({
        name: j.name,
        state,
        durationMs: done ? Math.max(...ends) - Math.min(...starts) : null,
        // Every shard has the same `if:`, so the first one's reason is the job's.
        skipReason: state === "skipped" ? await skipReasonOf(group[0]!) : undefined,
      });
      continue;
    }
    let skipReason: string | null | undefined;
    if (j.state === "skipped") skipReason = await skipReasonOf(j);
    jobs.push({ name: j.name, state: j.state, durationMs: j.duration_ms, skipReason });
  }
  return { id: run.id, sha: run.sha, jobs };
}

const ms = (s: string | null | undefined, e: string | null | undefined): number | null => {
  const a = s ? Date.parse(s) : Number.NaN;
  const b = e ? Date.parse(e) : Number.NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
};

/** The check runs one GitHub App posted for a commit (all pages, at most 300). */
export async function fetchTheirChecks(o: {
  githubUrl: URL;
  repo: string;
  sha: string;
  appId: number;
  token?: string | undefined;
  fetch?: SafeFetch;
}): Promise<TheirCheck[]> {
  const f = o.fetch ?? createHttpClient().fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
  };
  const out: TheirCheck[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const u = new URL(`${baseString(o.githubUrl)}/repos/${o.repo}/commits/${o.sha}/check-runs`);
    u.searchParams.set("per_page", "100");
    u.searchParams.set("page", String(page));
    const body = (await getJson(f, u, headers, "check runs")) as {
      total_count?: number;
      check_runs?: {
        name?: string;
        status?: string;
        conclusion?: string | null;
        started_at?: string | null;
        completed_at?: string | null;
        app?: { id?: number } | null;
      }[];
    };
    const runs = body.check_runs ?? [];
    for (const c of runs) {
      if (c.app?.id !== o.appId || typeof c.name !== "string") continue;
      out.push({
        name: c.name,
        status: c.status ?? "queued",
        conclusion: c.conclusion ?? null,
        durationMs: ms(c.started_at, c.completed_at),
      });
    }
    if (runs.length < 100) break;
  }
  return out;
}
