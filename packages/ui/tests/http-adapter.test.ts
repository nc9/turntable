import { describe, expect, test } from "bun:test";
import { ApiError, createHttpApi } from "../src/api/http-adapter";
import type { WireLog, WireRun, WireRunDetail } from "../src/api/wire";

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

const wireRun = (over: Partial<WireRun> = {}): WireRun => ({
  id: "run1",
  project: "api",
  workflow_path: ".github/workflows/ci.yml",
  event: "push",
  ref: "refs/heads/main",
  sha: "abc1234",
  workflow_name: null,
  commit_message: null,
  actor: null,
  head_branch: null,
  pr_number: null,
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

describe("my_activity_feed", () => {
  const wireRow = {
    run_id: "R1",
    org: "acme",
    org_name: "Acme",
    org_avatar_url: "https://avatars.githubusercontent.com/u/1",
    project: "api",
    project_name: "API",
    project_avatar_url: null,
    workflow: "CI",
    ref: "main",
    ref_type: "branch",
    sha: "a".repeat(40),
    event: "push",
    commit_message: null,
    actor: "octocat",
    actor_avatar_url: null,
    state: "completed",
    conclusion: "failure",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:05.000Z",
    finished_at: "2026-01-01T00:01:05.000Z",
    duration_ms: 60000,
  };

  test("calls /activity with only the filters, never the URL's org, and maps the rows", async () => {
    const { api, calls } = make(() => json({ runs: [wireRow], next_cursor: "n" }));
    const page = await api.myActivityFeed({ status: "failed", limit: 500, cursor: "c" });
    const { url } = calls[0]!;
    expect(url.pathname).toBe("/api/v1/activity");
    // The adapter's own org ("acme") is not sent: the feed spans the person's orgs.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: "failed",
      limit: "100",
      cursor: "c",
    });
    expect(page.nextCursor).toBe("n");
    expect(page.runs[0]).toMatchObject({
      runId: "R1",
      org: "acme",
      orgAvatarUrl: "https://avatars.githubusercontent.com/u/1",
      state: "completed",
      conclusion: "failure",
      startedAt: Date.parse("2026-01-01T00:00:05.000Z"),
    });
  });

  test("org and project are filters when given", async () => {
    const { api, calls } = make(() => json({ runs: [], next_cursor: null }));
    await api.myActivityFeed({ org: "beta", project: "web" });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ org: "beta", project: "web" });
  });
});

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

  test("lists orgs and projects from the API", async () => {
    const { api, calls } = make((url) =>
      url.pathname === "/api/v1/orgs"
        ? json({ orgs: [{ id: "o1", slug: "acme", name: "Acme" }], next_cursor: null })
        : json({
            projects: [
              {
                id: "p1",
                slug: "api",
                name: "API",
                repos: [{ forge: "github", owner: "acme", repo: "api" }],
              },
              { id: "p2", slug: "web", name: "Web", repos: [] },
            ],
            next_cursor: null,
          }),
    );
    expect(await api.listOrgs()).toEqual([{ id: "acme", slug: "acme", name: "Acme" }]);
    const projects = await api.listProjects("acme");
    expect(projects.map((p) => [p.id, p.slug, p.repo])).toEqual([
      ["api", "api", "acme/api"],
      ["web", "web", ""],
    ]);
    expect(calls.some((c) => c.url.pathname === "/api/v1/projects")).toBe(true);
  });

  test("maps run metadata and the trust decision", async () => {
    const { api } = make(() =>
      json({
        runs: [
          wireRun({
            workflow_name: "CI",
            commit_message: "fix typo",
            actor: "octo",
            head_branch: "contrib/typo",
            pr_number: 12,
            trust_class: "untrusted_pr",
            trust: {
              class: "untrusted_pr",
              reasons: ["no prior contribution"],
              facts: {},
              workflow_hash: "deadbeef",
              decided_at: "2026-11-22T10:00:00.000Z",
            },
          }),
          wireRun({ id: "run2" }),
        ],
        next_cursor: null,
      }),
    );
    const { runs } = await api.listRuns({ projectId: "api" });
    expect(runs[0]).toMatchObject({
      workflowName: "CI",
      commitMessage: "fix typo",
      actor: "octo",
      headBranch: "contrib/typo",
      prNumber: 12,
      trustClass: "untrusted_pr",
      trust: { reasons: ["no prior contribution"], workflowHash: "deadbeef" },
    });
    // An older server reports no trust: the UI sees null, not a guess.
    expect(runs[1]).toMatchObject({ trustClass: null, trust: null });
  });

  const detail: WireRunDetail = {
    ...wireRun({ state: "failure", finished_at: "2026-11-22T10:02:00.000Z", duration_ms: 115000 }),
    jobs: [
      {
        id: "job1",
        job_key: "test",
        name: "test",
        state: "failure",
        needs: [],
        matrix: null,
        shard: null,
        approval_kind: null,
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
            sandbox_created_at: "2026-11-22T10:00:12.000Z",
            sandbox_destroyed_at: "2026-11-22T10:00:21.500Z",
            sandbox_seconds: 9.5,
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
            sandbox_created_at: "2026-11-22T10:00:26.000Z",
            sandbox_destroyed_at: null,
            sandbox_seconds: null,
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
      shard: null,
      approval: null,
      exitCode: 1,
    });
    expect(d.attempts.map((a) => [a.attempt, a.state, a.errorClass])).toEqual([
      [1, "infra_error", "heartbeat_lost"],
      [2, "failure", null],
    ]);
  });

  test("maps sandbox times, leaving an unconfirmed destroy null", async () => {
    const { api } = make(() => json(detail));
    const d = await api.getRun("run1");
    expect(
      d.attempts.map((a) => [a.sandboxCreatedAt, a.sandboxDestroyedAt, a.sandboxSeconds]),
    ).toEqual([
      [Date.parse("2026-11-22T10:00:12.000Z"), Date.parse("2026-11-22T10:00:21.500Z"), 9.5],
      [Date.parse("2026-11-22T10:00:26.000Z"), null, null],
    ]);
  });

  test("sandboxUsage maps the days and reads the quota limit, tolerating a refusal", async () => {
    const days = {
      days: [
        {
          day: "2026-11-22",
          sandbox_seconds: 90,
          sandbox_minutes: 1.5,
          attempts: 2,
          estimated_attempts: 1,
        },
      ],
      total_seconds: 90,
      total_minutes: 1.5,
    };
    const ok = make((url) =>
      url.pathname.endsWith("/usage/sandbox")
        ? json(days)
        : json({ limits: { max_sandbox_minutes_per_day: 600 } }),
    );
    expect(await ok.api.sandboxUsage({ days: 7 })).toEqual({
      days: [{ day: "2026-11-22", seconds: 90, minutes: 1.5, attempts: 2, estimatedAttempts: 1 }],
      totalMinutes: 1.5,
      projects: [],
      limitMinutesPerDay: 600,
    });
    expect(ok.calls[0]!.url.searchParams.get("days")).toBe("7");
    expect(ok.calls[0]!.url.searchParams.has("group_by")).toBe(false);
    const refused = make((url) =>
      url.pathname.endsWith("/usage/sandbox")
        ? json(days)
        : json({ error: { code: "forbidden", message: "no" } }, 403),
    );
    expect((await refused.api.sandboxUsage({ days: 7 })).limitMinutesPerDay).toBeNull();
  });

  test("sandboxUsage with byProject asks for group_by=project and maps each project", async () => {
    const d = (minutes: number) => ({
      day: "2026-11-22",
      sandbox_seconds: minutes * 60,
      sandbox_minutes: minutes,
      attempts: 1,
      estimated_attempts: 0,
    });
    const fx = make((url) =>
      url.pathname.endsWith("/usage/sandbox")
        ? json({
            days: [d(3)],
            total_seconds: 180,
            total_minutes: 3,
            projects: [
              {
                project_id: "p1",
                project_slug: "api",
                project_name: "API",
                days: [d(2)],
                total_seconds: 120,
                total_minutes: 2,
              },
              {
                project_id: "p2",
                project_slug: "web",
                project_name: "Web",
                days: [d(1)],
                total_seconds: 60,
                total_minutes: 1,
              },
            ],
          })
        : json({ limits: { max_sandbox_minutes_per_day: null } }),
    );
    const u = await fx.api.sandboxUsage({ days: 7, byProject: true });
    expect(fx.calls[0]!.url.searchParams.get("group_by")).toBe("project");
    expect(u.projects.map((p) => [p.id, p.slug, p.name, p.totalMinutes])).toEqual([
      ["p1", "api", "API", 2],
      ["p2", "web", "Web", 1],
    ]);
    expect(u.projects[0]!.days[0]).toEqual({
      day: "2026-11-22",
      seconds: 120,
      minutes: 2,
      attempts: 1,
      estimatedAttempts: 0,
    });
  });

  test("maps the shard of a split job, with the steps it owns; other jobs have none", async () => {
    const shardRow = (i: number): WireRunDetail["jobs"][number] => ({
      ...detail.jobs[0]!,
      id: `s${i}`,
      job_key: `tests[${i}]`,
      name: "CLI tests",
      state: "success",
      shard: { job: "tests", index: i, total: 3, steps: [`suite ${i}`] },
      attempts: [],
    });
    const { api } = make(() =>
      json({ ...detail, jobs: [detail.jobs[0]!, shardRow(0), shardRow(2)] }),
    );
    const d = await api.getRun("run1");
    expect(d.jobs[0]!.shard).toBeNull();
    expect(d.jobs[1]!.shard).toEqual({ job: "tests", index: 0, total: 3, steps: ["suite 0"] });
    expect(d.jobs[2]!.shard).toMatchObject({ index: 2, total: 3 });
    // an older server that sends no `shard` is the same as none
    const old = { ...detail.jobs[0]! } as Record<string, unknown>;
    delete old.shard;
    const o = make(() => json({ ...detail, jobs: [old] }));
    expect((await o.api.getRun("run1")).jobs[0]!.shard).toBeNull();
  });

  test("capabilities: rerun and approve are available", () => {
    const { api } = make(() => json({}));
    expect(api.capabilities).toEqual({
      rerun: true,
      approve: true,
      humanApproval: true,
      simulatedCeremony: false,
    });
  });

  test("events is empty until the feed exists", async () => {
    const { api, calls } = make(() => json({}));
    expect(await api.events({ cursor: "5" })).toEqual({ events: [], cursor: "5" });
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
        needs: [],
        matrix: null,
        shard: null,
        approval_kind: null,
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
            sandbox_created_at: null,
            sandbox_destroyed_at: null,
            sandbox_seconds: null,
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
        matches: 0,
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

describe("operations added for trust, digests, search and ingest", () => {
  const withRun =
    (rest: (url: URL, init: RequestInit) => Response) => (url: URL, init: RequestInit) =>
      url.pathname === "/api/v1/runs/run1"
        ? json({
            ...wireRun(),
            jobs: [
              {
                id: "job1",
                job_key: "t",
                name: "t",
                state: "failure",
                needs: [],
                matrix: null,
                shard: null,
                approval_kind: null,
                exit_code: 1,
                started_at: null,
                finished_at: null,
                duration_ms: null,
                infra_error_reason: null,
                log_path: null,
                attempts: [
                  {
                    id: "a1",
                    attempt: 3,
                    state: "failure",
                    provider: "docker",
                    exit_code: 1,
                    error_class: null,
                    started_at: null,
                    finished_at: null,
                    duration_ms: null,
                  },
                ],
              },
            ],
          })
        : rest(url, init);

  test("rerun posts the reason and job keys and maps the result", async () => {
    const { api, calls } = make(() =>
      json({
        run_id: "run1",
        state: "running",
        reruns: [
          {
            job_id: "job1",
            job_key: "t",
            attempt: 4,
            previous_state: "failure",
            state: "queued",
            reruns_used: 1,
          },
        ],
      }),
    );
    const r = await api.rerun({ runId: "run1", jobKeys: ["t"], reason: "flaky" });
    const { url, init } = calls[0]!;
    expect(init.method).toBe("POST");
    expect(url.pathname).toBe("/api/v1/runs/run1/rerun");
    expect(JSON.parse(String(init.body))).toEqual({ reason: "flaky", org: "acme", jobs: ["t"] });
    expect(r.reruns[0]).toMatchObject({ jobKey: "t", attempt: 4, previousState: "failure" });
    await api.rerun({ runId: "run1", reason: "again" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ reason: "again", org: "acme" });
  });

  test("approve binds to the head sha and workflow hash; whoami carries the role", async () => {
    const { api, calls } = make((url) =>
      url.pathname.endsWith("/approve")
        ? json({
            run_id: "run1",
            state: "queued",
            released_jobs: 2,
            approved_by: "me",
            head_sha: "abc",
            workflow_hash: "h1",
          })
        : json({
            kind: "member",
            id: "m1",
            name: "Me",
            role: "release_operator",
            org: "acme",
            project: null,
            expires_at: null,
          }),
    );
    expect((await api.whoami()).role).toBe("release_operator");
    const res = await api.approveRun({ runId: "run1", headSha: "abc", workflowHash: "h1" });
    expect(res).toMatchObject({
      releasedJobs: 2,
      approvedBy: "me",
      headSha: "abc",
      workflowHash: "h1",
    });
    const post = calls.find((c) => c.url.pathname.endsWith("/approve"))!;
    expect(post.init.method).toBe("POST");
    expect(JSON.parse(String(post.init.body))).toEqual({
      head_sha: "abc",
      workflow_hash: "h1",
      org: "acme",
    });
    expect(String(post.url)).not.toContain("tt_secret");
  });

  test("failure digest maps the excerpt as plain data", async () => {
    const { api, calls } = make(() =>
      json({
        failing_jobs: 1,
        digests: [
          {
            job_id: "job1",
            job_key: "t",
            state: "failure",
            attempt: 1,
            step: { name: "Run tests", stage: "main", index: 3, result: "failure" },
            basis: "annotation",
            excerpt: "<img src=x onerror=alert(1)> boom",
            truncated: true,
            infra_error_reason: null,
          },
        ],
      }),
    );
    const d = await api.failureDigest({ jobId: "job1" });
    expect(calls[0]!.url.searchParams.get("job_id")).toBe("job1");
    expect(d.failingJobs).toBe(1);
    expect(d.digests[0]).toMatchObject({
      jobKey: "t",
      basis: "annotation",
      truncated: true,
      excerpt: "<img src=x onerror=alert(1)> boom",
    });
  });

  test("grep sends mode=grep with the pattern and parses hits and context rows", async () => {
    const { api, calls } = make(
      withRun(() =>
        json({
          job_id: "job1",
          attempt: 3,
          mode: "grep",
          matches: 2,
          text: "120:error: boom\n150-  at file.ts:1\n9000:error: again",
          offset: 0,
          bytes: 50,
          total_bytes: 12_000_000,
          next_offset: 5_000_000,
          truncated: true,
        }),
      ),
    );
    await api.getRun("run1");
    const r = await api.grepLog({
      attemptId: "a1",
      pattern: "error",
      ignoreCase: true,
      context: 1,
      maxMatches: 50,
    });
    const g = calls.find((c) => c.url.searchParams.get("mode") === "grep")!;
    expect(g.url.pathname).toBe("/api/v1/jobs/job1/log");
    expect(g.url.searchParams.get("pattern")).toBe("error");
    expect(g.url.searchParams.get("attempt")).toBe("3");
    expect(g.url.searchParams.get("ignore_case")).toBe("true");
    expect(g.url.searchParams.get("context")).toBe("1");
    expect(g.url.searchParams.get("max_matches")).toBe("50");
    expect(r.matches).toBe(2);
    expect(r.nextOffset).toBe(5_000_000);
    expect(r.hits).toEqual([
      { offset: 120, text: "error: boom", context: false },
      { offset: 150, text: "  at file.ts:1", context: true },
      { offset: 9000, text: "error: again", context: false },
    ]);
  });

  test("ingest status maps times to epoch milliseconds", async () => {
    const { api, calls } = make(() =>
      json({
        running: true,
        rate_limit: {
          limit: 5000,
          remaining: 4000,
          reset_at: "2026-11-22T11:00:00.000Z",
          resource: "core",
          observed_at: "2026-11-22T10:00:00.000Z",
        },
        repos: [
          {
            repo: "acme/api",
            project: "api",
            last_poll_at: "2026-11-22T10:00:00.000Z",
            last_outcome: "error",
            last_error: "502",
            next_poll_at: null,
            consecutive_failures: 3,
            runs_created: 9,
          },
        ],
      }),
    );
    const s = await api.ingestStatus();
    expect(calls[0]!.url.pathname).toBe("/api/v1/ingest/status");
    expect(s.rateLimit).toMatchObject({ limit: 5000, remaining: 4000, resource: "core" });
    expect(s.rateLimit?.resetAt).toBe(Date.parse("2026-11-22T11:00:00.000Z"));
    expect(s.repos[0]).toMatchObject({
      repo: "acme/api",
      lastOutcome: "error",
      nextPollAt: null,
      consecutiveFailures: 3,
    });
  });

  test("approval calls: signature routes carry the statement in the body, the challenge maps to data", async () => {
    const { api, calls } = make((url) => {
      if (url.pathname.endsWith("/approvals/challenge"))
        return json({
          statement: { run_id: "run1", environment: "production" },
          canonical: "{}",
          statement_hash: "ab",
          challenge: "YWI",
          rp_id: "ci.example.com",
          passkey_id: "cred",
          challenge_expires_at: "2026-11-23T10:10:00.000Z",
        });
      if (url.pathname.endsWith("/approvals"))
        return json({
          run_id: "run1",
          environment: "production",
          approvals: 1,
          required: 2,
          released_jobs: 0,
          state: "queued",
        });
      if (url.pathname.endsWith("/approvals/status"))
        return json({
          run_id: "run1",
          head_sha: "c".repeat(40),
          workflow_hash: "ab".repeat(32),
          author: "octo",
          environments: [
            {
              environment: "production",
              required: 2,
              allow_author_approval: false,
              waiting: true,
              release: false,
              approvals: [
                {
                  person: "alice",
                  method: "webauthn",
                  approved_at: "2026-11-23T10:00:00.000Z",
                  expires_at: "2026-11-24T10:00:00.000Z",
                },
              ],
            },
          ],
        });
      return json({});
    });
    const ch = await api.approvalChallenge({
      runId: "run1",
      environment: "production",
      approver: "ap1",
      project: "app",
    });
    expect(ch).toMatchObject({ challenge: "YWI", rpId: "ci.example.com", passkeyId: "cred" });
    const post = calls.find((c) => c.url.pathname.endsWith("/approvals/challenge"))!;
    expect(JSON.parse(String(post.init.body))).toEqual({
      run_id: "run1",
      environment: "production",
      approver: "ap1",
      org: "acme",
      project: "app",
    });
    const r = await api.approveEnvironment({
      statement: ch.statement,
      signature: { kind: "ed25519", signature: "AAAA" },
    });
    expect(r).toMatchObject({ approvals: 1, required: 2, releasedJobs: 0 });
    const sent = calls.find((c) => c.url.pathname === "/api/v1/approvals")!;
    expect(sent.init.method).toBe("POST");
    expect(JSON.parse(String(sent.init.body))).toEqual({
      statement: ch.statement,
      signature: { kind: "ed25519", signature: "AAAA" },
    });
    const st = await api.approvalStatus({ runId: "run1" });
    expect(st.environments[0]).toMatchObject({
      environment: "production",
      required: 2,
      waiting: true,
    });
    expect(st.environments[0]!.approvals[0]!.person).toBe("alice");
    expect(st.author).toBe("octo");
  });

  test("release approval calls: the v2 challenge carries the manifest, the approval goes to /approvals/release", async () => {
    const A = "a".repeat(64);
    const { api, calls } = make((url) => {
      if (url.pathname.endsWith("/approvals/release-challenge"))
        return json({
          statement: { run_id: "run1", environment: "release", manifest_sha256: "d".repeat(64) },
          canonical: "{}",
          statement_hash: "ab",
          challenge: "YWI",
          rp_id: "ci.example.com",
          passkey_id: "cred",
          challenge_expires_at: "2026-11-23T10:10:00.000Z",
          manifest_sha256: "d".repeat(64),
          artifacts: [{ name: "SHA256SUMS", sha256: A, size: 412 }],
        });
      if (url.pathname.endsWith("/approvals/release"))
        return json({
          run_id: "run1",
          environment: "release",
          approvals: 1,
          required: 2,
          released_jobs: 0,
          state: "queued",
          manifest_sha256: "d".repeat(64),
        });
      return json({}, 404);
    });
    const ch = await api.releaseApprovalChallenge({
      runId: "run1",
      approver: "ap1",
      project: "app",
    });
    expect(ch.manifestSha256).toBe("d".repeat(64));
    expect(ch.artifacts).toEqual([{ name: "SHA256SUMS", sha256: A, size: 412 }]);
    const post = calls.find((c) => c.url.pathname.endsWith("/approvals/release-challenge"))!;
    expect(JSON.parse(String(post.init.body))).toEqual({
      run_id: "run1",
      approver: "ap1",
      org: "acme",
      project: "app",
    });
    const r = await api.approveRelease({
      statement: ch.statement,
      signature: { kind: "ed25519", signature: "AAAA" },
    });
    expect(r).toMatchObject({ approvals: 1, required: 2, releasedJobs: 0 });
    const sent = calls.find((c) => c.url.pathname === "/api/v1/approvals/release")!;
    expect(sent.init.method).toBe("POST");
    expect(JSON.parse(String(sent.init.body))).toEqual({
      statement: ch.statement,
      signature: { kind: "ed25519", signature: "AAAA" },
    });
  });

  test("incident status maps the freeze, its reason as data, and the rotation list", async () => {
    const { api, calls } = make(() =>
      json({
        frozen: true,
        level: "org",
        reason: "<script>alert(1)</script> key leaked",
        frozen_at: 1_700_000_000_000,
        frozen_by: "member:maya",
        rotation_required_count: 3,
        rotation_required: [
          {
            name: "DEPLOY_KEY",
            reason: "leaked",
            flagged_by: "member:maya",
            flagged_at: 1_700_000_000_000,
          },
        ],
      }),
    );
    const s = await api.incidentStatus({ project: "api" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/incident");
    expect(calls[0]!.url.searchParams.get("project")).toBe("api");
    expect(s).toMatchObject({
      frozen: true,
      level: "org",
      reason: "<script>alert(1)</script> key leaked",
      frozenBy: "member:maya",
      rotationRequiredCount: 3,
      rotationRequired: [{ name: "DEPLOY_KEY", flaggedBy: "member:maya" }],
    });
  });
});

describe("App-secret calls", () => {
  const proof = {
    id: "s".repeat(20),
    approver: "ap1",
    signature: {
      credential_id: "a",
      client_data_json: "b",
      authenticator_data: "c",
      signature: "d",
    },
  };

  test("the rotation posts the step-up beside the org and returns the one-time secret", async () => {
    const { api, calls } = make(() =>
      json({ fingerprint: "SHA256:x", overlap_until: "2026-11-25T10:00:00.000Z" }),
    );
    const r = await api.rotateWebhookSecret({ overlapMinutes: 30, stepUp: proof });
    expect(r).toEqual({ fingerprint: "SHA256:x", overlapUntil: "2026-11-25T10:00:00.000Z" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/app-secrets/webhook-secret/rotate");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      org: "acme",
      overlap_minutes: 30,
      step_up: proof,
    });
  });

  test("the key upload goes in the body, never the URL", async () => {
    const { api, calls } = make(() => json({ fingerprint: "SHA256:y", app_id: "42" }));
    const pem = `key-${crypto.randomUUID()}`;
    const r = await api.replaceAppPrivateKey({ privateKey: pem, stepUp: proof });
    expect(r).toEqual({ fingerprint: "SHA256:y", appId: "42" });
    expect(calls[0]!.url.search).toBe("");
    expect(String(calls[0]!.init.body)).toContain(pem);
  });
});
