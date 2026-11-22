import type { ApiCapabilities, TurntableApi } from "./client";
import type {
  CheckSummary,
  CutRecord,
  Job,
  JobAttempt,
  JobState,
  LogSlice,
  Org,
  Project,
  Run,
  RunDetail,
  StepEvent,
} from "./types";
import type {
  WireAttempt,
  WireChecks,
  WireError,
  WireJob,
  WireLog,
  WireRun,
  WireRunDetail,
  WireRunList,
} from "./wire";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type HttpApiOptions = {
  /** Where `/api/v1` lives; empty for same-origin. */
  baseUrl?: string;
  /** The org slug requests are made for. */
  org: () => string | null;
  /** The bearer token, read per request so it is never captured. */
  token: () => string | null;
  /** Called when the server says the token is not accepted (401). */
  onUnauthenticated?: () => void;
  fetch?: typeof fetch;
};

/** The server caps a log read at 256 KiB. */
const LOG_PAGE_BYTES = 262_144;

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function workflowName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(ya?ml)$/i, "");
}

function branchOf(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

export function mapRun(w: WireRun, org: string): Run {
  const name = workflowName(w.workflow_path);
  return {
    id: w.id,
    orgId: org,
    projectId: w.project,
    workflowPath: w.workflow_path,
    workflowName: name,
    event: w.event,
    ref: w.ref,
    sha: w.sha,
    // The API reports no commit message or actor yet; show the workflow and branch instead.
    commitMessage: `${name} on ${branchOf(w.ref)}`,
    actor: "",
    status: w.state,
    createdAt: ms(w.created_at) ?? 0,
    startedAt: ms(w.started_at),
    finishedAt: ms(w.finished_at),
  };
}

function mapAttempt(a: WireAttempt, job: WireJob, run: WireRun, org: string): JobAttempt {
  return {
    id: a.id,
    orgId: org,
    projectId: run.project,
    jobId: job.id,
    attempt: a.attempt,
    state: a.state,
    provider: a.provider,
    sandboxId: null,
    exitCode: a.exit_code,
    errorClass: a.error_class,
    createdAt: ms(a.started_at) ?? ms(run.created_at) ?? 0,
    startedAt: ms(a.started_at),
    finishedAt: ms(a.finished_at),
  };
}

function mapJob(j: WireJob, run: WireRun, org: string): Job {
  return {
    id: j.id,
    orgId: org,
    projectId: run.project,
    runId: run.id,
    jobKey: j.job_key,
    name: j.name,
    state: j.state,
    // Not in the API yet: the dependency graph, matrix legs and the kind of approval gate.
    needs: [],
    matrix: null,
    matrixGroup: null,
    approval: null,
    exitCode: j.exit_code,
    createdAt: ms(run.created_at) ?? 0,
    startedAt: ms(j.started_at),
    finishedAt: ms(j.finished_at),
  };
}

const FINISHED: readonly JobState[] = ["success", "failure", "infra_error", "cancelled"];

export function createHttpApi(options: HttpApiOptions): TurntableApi {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = `${options.baseUrl ?? ""}/api/v1`;
  /** attemptId -> where to read its log, learned from get_run. */
  const attempts = new Map<string, { jobId: string; attempt: number; state: JobState }>();
  const org = (): string => {
    const o = options.org();
    if (!o) throw new ApiError(401, "unauthenticated", "Not connected");
    return o;
  };

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const token = options.token();
    if (!token) throw new ApiError(401, "unauthenticated", "Not connected");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${base}${path}${qs.size > 0 ? `?${qs}` : ""}`;
    const res = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) {
      let code = "internal";
      let message = `Request failed (${res.status})`;
      try {
        const e = (await res.json()) as WireError;
        code = e.error.code;
        message = e.error.message;
      } catch {
        // not JSON; keep the generic message
      }
      if (res.status === 401) options.onUnauthenticated?.();
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  const api: TurntableApi = {
    capabilities: { rerun: false } satisfies ApiCapabilities,

    async listOrgs(): Promise<Org[]> {
      // No list_orgs operation: a token is bound to one org, which the user named when connecting.
      const slug = org();
      return [{ id: slug, slug, name: slug }];
    },

    async listProjects(orgId: string): Promise<Project[]> {
      // No list_projects operation either: derive the projects from recent runs.
      const page = await call<WireRunList>("GET", "/runs", { org: orgId, limit: 100 });
      const slugs = [...new Set(page.runs.map((r) => r.project))].toSorted();
      return slugs.map((slug) => ({ id: slug, orgId, slug, name: slug, repo: "" }));
    },

    async listRuns(f) {
      const slug = org();
      const page = await call<WireRunList>("GET", "/runs", {
        org: slug,
        project: f.projectId || undefined,
        state: f.status,
        branch: f.branch,
        event: f.event,
        limit: f.limit ? Math.min(100, f.limit) : undefined,
        cursor: f.cursor,
      });
      return { runs: page.runs.map((r) => mapRun(r, slug)), nextCursor: page.next_cursor };
    },

    async getRun(runId: string): Promise<RunDetail> {
      const slug = org();
      const w = await call<WireRunDetail>("GET", `/runs/${encodeURIComponent(runId)}`, {
        org: slug,
      });
      const jobs: Job[] = [];
      const atts: JobAttempt[] = [];
      for (const j of w.jobs) {
        jobs.push(mapJob(j, w, slug));
        for (const a of j.attempts) {
          atts.push(mapAttempt(a, j, w, slug));
          attempts.set(a.id, { jobId: j.id, attempt: a.attempt, state: a.state });
        }
      }
      return { run: mapRun(w, slug), jobs, attempts: atts };
    },

    async jobLog({ attemptId, offset, limit }): Promise<LogSlice> {
      const known = attempts.get(attemptId);
      if (!known)
        throw new ApiError(404, "not_found", "Open the run first so the attempt is known");
      const slug = org();
      const chunks: Uint8Array[] = [];
      let at = offset;
      let size = 0;
      let more = true;
      const enc = new TextEncoder();
      while (more && at - offset < limit) {
        const page = await call<WireLog>("GET", `/jobs/${encodeURIComponent(known.jobId)}/log`, {
          org: slug,
          attempt: known.attempt,
          mode: "range",
          offset: at,
          max_bytes: Math.min(LOG_PAGE_BYTES, limit - (at - offset)),
        });
        size = page.total_bytes;
        // Keep byte offsets exact: the text should re-encode to `page.bytes`; if the server
        // substituted characters, pad or trim so the parser's offsets stay in step with the server's.
        let bytes = enc.encode(page.text);
        if (bytes.length !== page.bytes) {
          const fixed = new Uint8Array(page.bytes).fill(0x20);
          fixed.set(bytes.subarray(0, page.bytes));
          bytes = fixed;
        }
        chunks.push(bytes);
        at += page.bytes;
        more = page.next_offset !== null && page.bytes > 0;
      }
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let p = 0;
      for (const c of chunks) {
        joined.set(c, p);
        p += c.length;
      }
      const finished = FINISHED.includes(known.state);
      return { attemptId, offset, bytes: joined, size, done: finished && at >= size };
    },

    async jobSteps(): Promise<StepEvent[]> {
      return []; // not in the API yet (steps arrive out of band with the log pipeline)
    },

    async jobCuts(): Promise<CutRecord[]> {
      return []; // not in the API yet
    },

    async checksForSha({ projectId, sha }): Promise<CheckSummary> {
      const w = await call<WireChecks>("GET", `/checks/${encodeURIComponent(sha)}`, {
        org: org(),
        project: projectId || undefined,
      });
      const map = { GREEN: "success", PENDING: "running", RED: "failure", NONE: "none" } as const;
      return {
        sha: w.sha,
        state: map[w.state],
        runs: w.runs.map((r) => ({
          runId: r.id,
          workflowName: workflowName(r.workflow_path),
          status: r.state,
        })),
      };
    },

    async rerun(): Promise<{ runId: string }> {
      throw new ApiError(501, "not_supported", "Rerun is not available through the API yet");
    },

    async cancel({ runId }): Promise<void> {
      await call("POST", `/runs/${encodeURIComponent(runId)}/cancel`, {}, { org: org() });
    },

    async events({ cursor }) {
      return { events: [], cursor: cursor ?? "" }; // the event feed has not landed yet
    },
  };
  return api;
}
