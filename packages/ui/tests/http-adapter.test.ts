import { describe, expect, test } from "bun:test";
import { ApiError, createHttpApi } from "../src/api/http-adapter";
import type { WireLog, WireRunDetail, WireRunList } from "../src/api/wire";

type Call = { url: URL; init: RequestInit };

function stub(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, fetchStub };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const wireRun = (over: Partial<WireRunList["runs"][number]> = {}) => ({
  id: "run1",
  project: "api",
  workflow_path: ".github/workflows/ci.yml",
  event: "push",
  ref: "refs/heads/main",
  sha: "abc1234",
  state: "running" as const,
  created_at: "2026-11-22T10:00:00.000Z",
  started_at: "2026-11-22T10:00:05.000Z",
  finished_at: null,
  duration_ms: null,
  ...over,
});

function make(
  handler: Parameters<typeof stub>[0],
  opts: { token?: string | null; onUnauthenticated?: () => void } = {},
) {
  const s = stub(handler);
  const api = createHttpApi({
    org: () => "acme",
    token: () => (opts.token === undefined ? "tt_secret" : opts.token),
    ...(opts.onUnauthenticated ? { onUnauthenticated: opts.onUnauthenticated } : {}),
    fetch: s.fetchStub,
  });
  return { api, ...s };
}

describe("requests", () => {
  test("sends the bearer token in a header only, never in the URL, and omits cookies", async () => {
    const { api, calls } = make(() => json({ runs: [wireRun()], next_cursor: "c2" }));
    const page = await api.listRuns({
      projectId: "api",
      status: "failure",
      branch: "main",
      limit: 500,
    });
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe("/api/v1/runs");
    expect(url.search).not.toContain("tt_secret");
    expect(url.toString()).not.toContain("tt_secret");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tt_secret");
    expect(init.credentials).toBe("omit");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      org: "acme",
      project: "api",
      state: "failure",
      branch: "main",
      limit: "100", // clamped to the API maximum
    });
    expect(page.nextCursor).toBe("c2");
  });

  test("makes no request without a token", async () => {
    const { api, calls } = make(() => json({}), { token: null });
    await expect(api.listRuns({ projectId: "" })).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(0);
  });

  test("a 401 clears the session through the callback and throws a typed error", async () => {
    let cleared = 0;
    const { api } = make(
      () => json({ error: { code: "unauthenticated", message: "token expired" } }, 401),
      { onUnauthenticated: () => cleared++ },
    );
    const err = await api.listRuns({ projectId: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "unauthenticated", message: "token expired" });
    expect(cleared).toBe(1);
  });

  test("an unreadable error body still yields a generic ApiError", async () => {
    const { api } = make(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(api.listRuns({ projectId: "" })).rejects.toMatchObject({
      status: 502,
      code: "internal",
    });
  });
});

describe("mapping", () => {
  test("maps a run: slugs as ids, epoch ms, derived title, no invented actor", async () => {
    const { api } = make(() => json({ runs: [wireRun()], next_cursor: null }));
    const { runs } = await api.listRuns({ projectId: "api" });
    expect(runs[0]).toMatchObject({
      id: "run1",
      orgId: "acme",
      projectId: "api",
      workflowName: "ci",
      commitMessage: "ci on main",
      actor: "",
      status: "running",
      createdAt: Date.parse("2026-11-22T10:00:00.000Z"),
      finishedAt: null,
    });
  });

  test("derives projects from recent runs", async () => {
    const { api } = make(() =>
      json({
        runs: [
          wireRun({ project: "web" }),
          wireRun({ project: "api" }),
          wireRun({ project: "web" }),
        ],
        next_cursor: null,
      }),
    );
    expect((await api.listProjects("acme")).map((p) => p.slug)).toEqual(["api", "web"]);
    expect(await api.listOrgs()).toEqual([{ id: "acme", slug: "acme", name: "acme" }]);
  });

  const detail: WireRunDetail = {
    ...wireRun({ state: "failure", finished_at: "2026-11-22T10:02:00.000Z", duration_ms: 115000 }),
    jobs: [
      {
        id: "job1",
        job_key: "test",
        name: "test",
        state: "failure",
        exit_code: 1,
        started_at: "2026-11-22T10:00:10.000Z",
        finished_at: "2026-11-22T10:01:00.000Z",
        duration_ms: 50000,
        infra_error_reason: null,
        log_path: null,
        attempts: [
          {
            id: "a1",
            attempt: 1,
            state: "infra_error",
            provider: "docker",
            exit_code: null,
            error_class: "heartbeat_lost",
            started_at: "2026-11-22T10:00:10.000Z",
            finished_at: "2026-11-22T10:00:20.000Z",
            duration_ms: 10000,
          },
          {
            id: "a2",
            attempt: 2,
            state: "failure",
            provider: "docker",
            exit_code: 1,
            error_class: null,
            started_at: "2026-11-22T10:00:25.000Z",
            finished_at: "2026-11-22T10:01:00.000Z",
            duration_ms: 35000,
          },
        ],
      },
    ],
  };

  test("maps jobs and attempts, keeping infra_error distinct", async () => {
    const { api } = make(() => json(detail));
    const d = await api.getRun("run1");
    expect(d.jobs[0]).toMatchObject({
      id: "job1",
      jobKey: "test",
      needs: [],
      matrix: null,
      approval: null,
      exitCode: 1,
    });
    expect(d.attempts.map((a) => [a.attempt, a.state, a.errorClass])).toEqual([
      [1, "infra_error", "heartbeat_lost"],
      [2, "failure", null],
    ]);
  });

  test("jobSteps, jobCuts and events are empty until the API has them; rerun is unsupported", async () => {
    const { api, calls } = make(() => json({}));
    expect(await api.jobSteps({ attemptId: "a1" })).toEqual([]);
    expect(await api.jobCuts({ attemptId: "a1" })).toEqual([]);
    expect(await api.events({ cursor: "5" })).toEqual({ events: [], cursor: "5" });
    expect(api.capabilities.rerun).toBe(false);
    await expect(api.rerun({ runId: "run1" })).rejects.toMatchObject({ code: "not_supported" });
    expect(calls).toHaveLength(0);
  });

  test("checks_for_sha maps the verdict", async () => {
    const { api, calls } = make(() =>
      json({
        sha: "abc1234",
        state: "RED",
        counts: {},
        runs: [
          {
            id: "run1",
            project: "api",
            workflow_path: ".github/workflows/ci.yml",
            state: "failure",
          },
        ],
      }),
    );
    const c = await api.checksForSha({ projectId: "api", sha: "abc1234" });
    expect(c).toMatchObject({
      state: "failure",
      runs: [{ runId: "run1", workflowName: "ci", status: "failure" }],
    });
    expect(calls[0]!.url.pathname).toBe("/api/v1/checks/abc1234");
  });

  test("cancel POSTs a JSON body with the org", async () => {
    const { api, calls } = make(() =>
      json({ run_id: "run1", state: "cancelled", cancelled_jobs: 2, unchanged_jobs: 0 }),
    );
    await api.cancel({ runId: "run1" });
    const { url, init } = calls[0]!;
    expect(init.method).toBe("POST");
    expect(url.pathname).toBe("/api/v1/runs/run1/cancel");
    expect(JSON.parse(String(init.body))).toEqual({ org: "acme" });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});

describe("job log by offset", () => {
  const a2Detail = (state: "running" | "failure"): WireRunDetail => ({
    ...wireRun(),
    jobs: [
      {
        id: "job1",
        job_key: "t",
        name: "t",
        state,
        exit_code: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        infra_error_reason: null,
        log_path: null,
        attempts: [
          {
            id: "a2",
            attempt: 2,
            state,
            provider: "docker",
            exit_code: null,
            error_class: null,
            started_at: null,
            finished_at: null,
            duration_ms: null,
          },
        ],
      },
    ],
  });

  function logHandler(total: number, state: "running" | "failure") {
    return (url: URL) => {
      if (url.pathname === "/api/v1/runs/run1") return json(a2Detail(state));
      const offset = Number(url.searchParams.get("offset"));
      const max = Number(url.searchParams.get("max_bytes"));
      const bytes = Math.min(max, total - offset);
      const page: WireLog = {
        job_id: "job1",
        attempt: 2,
        mode: "range",
        text: "x".repeat(bytes),
        offset,
        bytes,
        total_bytes: total,
        next_offset: offset + bytes < total ? offset + bytes : null,
        truncated: false,
      };
      return json(page);
    };
  }

  test("pages in 256 KiB reads up to the limit, using the job and attempt number", async () => {
    const { api, calls } = make(logHandler(600_000, "failure"));
    await api.getRun("run1");
    const slice = await api.jobLog({ attemptId: "a2", offset: 0, limit: 600_000 });
    const reads = calls.filter((c) => c.url.pathname.endsWith("/log"));
    expect(
      reads.map((c) => [c.url.searchParams.get("offset"), c.url.searchParams.get("max_bytes")]),
    ).toEqual([
      ["0", "262144"],
      ["262144", "262144"],
      ["524288", "75712"],
    ]);
    expect(reads[0]!.url.pathname).toBe("/api/v1/jobs/job1/log");
    expect(reads[0]!.url.searchParams.get("attempt")).toBe("2");
    expect(reads[0]!.url.searchParams.get("mode")).toBe("range");
    expect(slice.bytes.length).toBe(600_000);
    expect(slice.size).toBe(600_000);
    expect(slice.done).toBe(true);
  });

  test("a running attempt is not done even when caught up; the limit is respected", async () => {
    const { api } = make(logHandler(1000, "running"));
    await api.getRun("run1");
    const slice = await api.jobLog({ attemptId: "a2", offset: 100, limit: 400 });
    expect(slice).toMatchObject({ offset: 100, size: 1000, done: false });
    expect(slice.bytes.length).toBe(400);
    const tail = await api.jobLog({ attemptId: "a2", offset: 500, limit: 5000 });
    expect(tail.bytes.length).toBe(500);
    expect(tail.done).toBe(false);
  });

  test("keeps byte offsets exact when the text re-encodes to a different length", async () => {
    const { api } = make((url) =>
      url.pathname === "/api/v1/runs/run1"
        ? json(a2Detail("failure"))
        : json({
            job_id: "job1",
            attempt: 2,
            mode: "range",
            text: "café",
            offset: 0,
            bytes: 4,
            total_bytes: 4,
            next_offset: null,
            truncated: false,
          }),
    );
    await api.getRun("run1");
    const slice = await api.jobLog({ attemptId: "a2", offset: 0, limit: 100 });
    expect(slice.bytes.length).toBe(4); // server said 4 bytes; "café" is 5 in UTF-8
  });

  test("an attempt the adapter has not seen is a 404, not a guess", async () => {
    const { api, calls } = make(() => json({}));
    await expect(api.jobLog({ attemptId: "nope", offset: 0, limit: 10 })).rejects.toMatchObject({
      status: 404,
    });
    expect(calls).toHaveLength(0);
  });
});
