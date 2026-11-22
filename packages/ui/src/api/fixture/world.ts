import type { ChangeEvent } from "../realtime";
import type { Job, JobAttempt, JobState, Org, Project, Run } from "../types";
import { generateLog, type GeneratedLog, type LogKind, type LogOutcome } from "./log-gen";
import { createRng, fakeUlid, type Rng } from "./prng";

type Plan = { durationMs: number; outcome: LogOutcome; kind: LogKind };

type JobTemplate = {
  key: string;
  name: string;
  needs: string[];
  kind: LogKind;
  matrix?: Record<string, string>;
  matrixGroup?: string;
  /** Baseline duration in ms before jitter. */
  base: number;
  /** Release/environment gate: approved by a human with a security key. */
  approval?: boolean;
};

type WorkflowTemplate = {
  path: string;
  name: string;
  events: string[];
  jobs: (rng: Rng, huge: boolean) => JobTemplate[];
};

const matrixLegs = (): JobTemplate[] => {
  const legs: JobTemplate[] = [];
  for (const os of ["ubuntu-22.04", "ubuntu-24.04"]) {
    for (const node of ["20", "22"]) {
      legs.push({
        key: `test-${os}-${node}`,
        name: `test (${os}, ${node})`,
        needs: [],
        kind: "test",
        matrix: { os, node },
        matrixGroup: "test",
        base: 70_000,
      });
    }
  }
  return legs;
};

const WORKFLOWS: WorkflowTemplate[] = [
  {
    path: ".github/workflows/ci.yml",
    name: "CI",
    events: ["push", "pull_request"],
    jobs: (_rng, huge) => [
      { key: "lint", name: "lint", needs: [], kind: "lint", base: 25_000 },
      { key: "typecheck", name: "typecheck", needs: [], kind: "typecheck", base: 40_000 },
      ...matrixLegs(),
      {
        key: "build",
        name: "build",
        needs: [
          "lint",
          "typecheck",
          "test-ubuntu-22.04-20",
          "test-ubuntu-22.04-22",
          "test-ubuntu-24.04-20",
          "test-ubuntu-24.04-22",
        ],
        kind: "build",
        base: 55_000,
      },
      {
        key: "e2e",
        name: "e2e",
        needs: ["build"],
        kind: huge ? "huge" : "e2e",
        base: huge ? 150_000 : 90_000,
      },
    ],
  },
  {
    path: ".github/workflows/release.yml",
    name: "Release",
    events: ["push", "workflow_dispatch"],
    jobs: () => [
      { key: "build", name: "build", needs: [], kind: "build", base: 50_000 },
      { key: "sign", name: "sign", needs: ["build"], kind: "deploy", base: 20_000 },
      {
        key: "publish",
        name: "publish",
        needs: ["sign"],
        kind: "deploy",
        base: 20_000,
        approval: true,
      },
    ],
  },
  {
    path: ".github/workflows/docs.yml",
    name: "Docs",
    events: ["push"],
    jobs: () => [
      { key: "build-docs", name: "build docs", needs: [], kind: "build", base: 30_000 },
      {
        key: "deploy-docs",
        name: "deploy docs",
        needs: ["build-docs"],
        kind: "deploy",
        base: 15_000,
      },
    ],
  },
];

const ACTORS = ["maya", "jonas", "priya", "tomas", "ines", "kofi", "lena"];
const MESSAGES = [
  "fix(queue): retry infra errors once",
  "feat(api): add checks_for_sha",
  "refactor(db): scope repos by org",
  "chore(deps): bump drizzle-orm",
  "fix(log): split lines across chunks",
  "feat(ui): live log viewer",
  "docs(security): describe the secrets proxy",
  "perf(scheduler): batch dispatch",
  "test(auth): cover cross-org reads",
  "fix(webhook): verify signature before parse",
];
const BRANCHES = [
  "main",
  "main",
  "main",
  "feat/log-viewer",
  "fix/queue-retry",
  "chore/deps",
  "release/0.2",
];

export type World = ReturnType<typeof createWorld>;

export function createWorld(options: { now?: () => number; seed?: string } = {}) {
  const now = options.now ?? Date.now;
  const rng = createRng(options.seed ?? "longshore-fixture");

  const orgs: Org[] = [
    { id: "01FIXTURE0ORG0NORTHWIND0000", slug: "northwind", name: "Northwind" },
    { id: "01FIXTURE0ORG0LUMENLABS00000", slug: "lumen-labs", name: "Lumen Labs" },
  ];
  const projects: Project[] = [
    {
      id: "01FIXTURE0PRJ0NWAPI000000",
      orgId: orgs[0]!.id,
      slug: "api",
      name: "api",
      repo: "northwind/api",
    },
    {
      id: "01FIXTURE0PRJ0NWWEB000000",
      orgId: orgs[0]!.id,
      slug: "web",
      name: "web",
      repo: "northwind/web",
    },
    {
      id: "01FIXTURE0PRJ0NWINFRA0000",
      orgId: orgs[0]!.id,
      slug: "infra",
      name: "infra",
      repo: "northwind/infra",
    },
    {
      id: "01FIXTURE0PRJ0LUMCORE0000",
      orgId: orgs[1]!.id,
      slug: "core",
      name: "core",
      repo: "lumen-labs/core",
    },
  ];

  const runs = new Map<string, Run>();
  const jobs = new Map<string, Job>();
  const attempts = new Map<string, JobAttempt>();
  const plans = new Map<string, Plan>();
  const retryAt = new Map<string, number>();
  const events: ChangeEvent[] = [];
  let cursorN = 0;
  const listeners = new Set<(e: ChangeEvent) => void>();

  const cursor = () => String(cursorN).padStart(10, "0");
  const emit = (entity: "run" | "job" | "attempt", value: Run | Job | JobAttempt) => {
    cursorN += 1;
    const ev = {
      type: "change",
      cursor: cursor(),
      entity,
      op: "upsert",
      value: { ...value },
    } as ChangeEvent;
    events.push(ev);
    if (events.length > 5000) events.splice(0, 1000);
    for (const l of listeners) l(ev);
  };

  // Counter-based id time keeps ids stable across reloads, so deep links survive in the fixture.
  let idClock = 1_790_000_000_000;
  const id = (_t?: number) => fakeUlid(rng, (idClock += 1000));
  const sha = () => Array.from({ length: 40 }, () => rng.int(0, 15).toString(16)).join("");

  function planFor(t: JobTemplate, runIsFailing: boolean, key: string): Plan {
    const jitter = 0.7 + rng.next() * 0.7;
    let outcome: LogOutcome = "success";
    if (
      runIsFailing &&
      (t.kind === "test" || t.kind === "typecheck" || t.kind === "lint") &&
      rng.chance(0.4)
    )
      outcome = "failure";
    if (rng.chance(0.05)) outcome = "infra_error";
    const plan = { durationMs: Math.round(t.base * jitter), outcome, kind: t.kind };
    plans.set(key, plan);
    return plan;
  }

  function createRunRow(
    project: Project,
    wf: WorkflowTemplate,
    at: number,
    extra: Partial<Run> = {},
  ): { run: Run; templates: JobTemplate[] } {
    const huge = rng.chance(0.08);
    const templates = wf.jobs(rng, huge);
    const run: Run = {
      id: id(at),
      orgId: project.orgId,
      projectId: project.id,
      workflowPath: wf.path,
      workflowName: wf.name,
      event: rng.pick(wf.events),
      ref: `refs/heads/${rng.pick(BRANCHES)}`,
      sha: sha(),
      commitMessage: rng.pick(MESSAGES),
      actor: rng.pick(ACTORS),
      status: "queued",
      createdAt: at,
      startedAt: null,
      finishedAt: null,
      ...extra,
    };
    if (run.event === "pull_request") run.ref = `refs/pull/${rng.int(40, 220)}/merge`;
    if (wf.name === "Release") run.ref = `refs/tags/v0.${rng.int(1, 9)}.${rng.int(0, 9)}`;
    return { run, templates };
  }

  function createJobRows(run: Run, templates: JobTemplate[]): Job[] {
    return templates.map((t) => ({
      id: id(run.createdAt),
      orgId: run.orgId,
      projectId: run.projectId,
      runId: run.id,
      jobKey: t.key,
      name: t.name,
      state: "queued" as JobState,
      needs: t.needs,
      matrix: t.matrix ?? null,
      matrixGroup: t.matrixGroup ?? null,
      approval: null,
      exitCode: null,
      createdAt: run.createdAt,
      startedAt: null,
      finishedAt: null,
    }));
  }

  const templateOf = new Map<string, JobTemplate>();
  const failingRuns = new Map<string, boolean>();

  /** Seeds one fully finished historical run directly (no events). */
  function seedHistorical(
    project: Project,
    wf: WorkflowTemplate,
    at: number,
    failing: boolean,
  ): void {
    const { run, templates } = createRunRow(project, wf, at);
    const rows = createJobRows(run, templates);
    let t = at + rng.int(2000, 9000);
    run.startedAt = t;
    const finished = new Map<string, number>();
    let broken = false;
    for (const row of rows) {
      const tpl = templates.find((x) => x.key === row.jobKey)!;
      templateOf.set(row.id, tpl);
      const depEnd = Math.max(0, ...row.needs.map((n) => finished.get(n) ?? 0));
      if (broken && row.needs.length > 0) {
        row.state = "skipped";
        jobs.set(row.id, row);
        finished.set(row.jobKey, depEnd);
        continue;
      }
      const start = Math.max(t, depEnd) + rng.int(1500, 6000);
      const aKey = `${row.id}:1`;
      const plan = planFor(tpl, failing, aKey);
      if (tpl.approval) {
        row.state = "awaiting_approval";
        row.approval = "environment";
        jobs.set(row.id, row);
        finished.set(row.jobKey, start);
        continue;
      }
      const attempt = makeAttempt(row, 1, start);
      attempt.finishedAt = start + plan.durationMs;
      attempt.state = plan.outcome;
      if (plan.outcome === "infra_error") {
        attempt.errorClass = rng.pick([
          "sandbox_create_failed",
          "heartbeat_lost",
          "provider_timeout",
        ]);
        attempts.set(attempt.id, attempt);
        const a2 = makeAttempt(row, 2, attempt.finishedAt + 4000);
        a2.finishedAt = a2.startedAt! + plan.durationMs;
        a2.state = "success";
        a2.exitCode = 0;
        attempts.set(a2.id, a2);
        plans.set(`${row.id}:2`, { ...plan, outcome: "success" });
        row.state = "success";
        row.exitCode = 0;
        row.finishedAt = a2.finishedAt;
      } else {
        attempt.exitCode = plan.outcome === "failure" ? 1 : 0;
        attempts.set(attempt.id, attempt);
        row.state = plan.outcome;
        row.exitCode = attempt.exitCode;
        row.finishedAt = attempt.finishedAt;
        if (plan.outcome === "failure") broken = true;
      }
      row.startedAt = start;
      finished.set(row.jobKey, row.finishedAt ?? start);
      jobs.set(row.id, row);
    }
    run.status = aggregate(rows);
    run.finishedAt = Math.max(...rows.map((r) => r.finishedAt ?? 0));
    if (run.status === "awaiting_approval") run.finishedAt = null;
    runs.set(run.id, run);
  }

  function makeAttempt(job: Job, n: number, start: number): JobAttempt {
    return {
      id: id(start),
      orgId: job.orgId,
      projectId: job.projectId,
      jobId: job.id,
      attempt: n,
      state: "running",
      provider: rng.pick(["daytona", "docker"]),
      sandboxId: `sbx_${rng.int(100000, 999999).toString(36)}`,
      exitCode: null,
      errorClass: null,
      createdAt: start,
      startedAt: start,
      finishedAt: null,
    };
  }

  function aggregate(rows: Job[]): JobState {
    const states = rows.map((r) => r.state);
    if (states.some((s) => s === "running")) return "running";
    if (rows.some((r) => r.state === "infra_error" && retryAt.has(r.id))) return "running";
    if (states.some((s) => s === "awaiting_approval")) return "awaiting_approval";
    const started = rows.some((r) => r.startedAt != null);
    const pending = states.some((s) => s === "queued");
    if (pending) return started ? "running" : "queued";
    if (states.some((s) => s === "awaiting_approval")) return "awaiting_approval";
    if (states.some((s) => s === "failure")) return "failure";
    if (states.some((s) => s === "infra_error")) return "infra_error";
    if (states.some((s) => s === "cancelled")) return "cancelled";
    return "success";
  }

  function jobsOf(runId: string): Job[] {
    return [...jobs.values()].filter((j) => j.runId === runId);
  }
  function attemptsOf(jobId: string): JobAttempt[] {
    return [...attempts.values()]
      .filter((a) => a.jobId === jobId)
      .toSorted((a, b) => a.attempt - b.attempt);
  }

  function startRunning(
    project: Project,
    wf: WorkflowTemplate,
    failing: boolean,
    untrustedAuthor = false,
  ): string {
    const at = now() - rng.int(0, 5000);
    const { run, templates } = createRunRow(project, wf, at);
    const rows = createJobRows(run, templates);
    runs.set(run.id, run);
    for (const row of rows) {
      jobs.set(row.id, row);
      templateOf.set(
        row.id,
        templates.find((x) => x.key === row.jobKey)!,
      );
      row.state = "queued";
      if (untrustedAuthor && row.needs.length === 0) {
        // Untrusted-author gate: nothing runs until an operator approves.
        row.state = "awaiting_approval";
        row.approval = "untrusted_author";
      }
    }
    if (untrustedAuthor) {
      run.event = "pull_request";
      run.ref = `refs/pull/${rng.int(40, 220)}/merge`;
      run.actor = "first-time-contributor";
      run.status = "awaiting_approval";
    }
    failingRuns.set(run.id, failing);
    emit("run", run);
    for (const row of rows) emit("job", row);
    return run.id;
  }
  /** Advance the simulation to the current time. Emits events for every change. */
  function tick(): void {
    const t = now();
    for (const run of runs.values()) {
      if (run.status === "success" || run.status === "failure" || run.status === "cancelled")
        continue;
      if (run.status === "awaiting_approval" || run.status === "infra_error") continue;
      const rows = jobsOf(run.id);
      let changed = false;
      for (const row of rows) {
        const tpl = templateOf.get(row.id);
        if (!tpl) continue;
        if (row.state === "running") {
          const a = attemptsOf(row.id).at(-1)!;
          const plan = plans.get(`${row.id}:${a.attempt}`)!;
          if (a.startedAt != null && t >= a.startedAt + plan.durationMs) {
            a.finishedAt = a.startedAt + plan.durationMs;
            a.state = plan.outcome;
            if (plan.outcome === "infra_error") {
              a.errorClass = rng.pick([
                "sandbox_create_failed",
                "heartbeat_lost",
                "provider_timeout",
              ]);
              row.state = "infra_error";
              row.exitCode = null;
              if (a.attempt < 2) retryAt.set(row.id, t + 4000);
              else row.finishedAt = t;
            } else {
              a.exitCode = plan.outcome === "failure" ? 1 : 0;
              row.state = plan.outcome;
              row.exitCode = a.exitCode;
              row.finishedAt = t;
            }
            emit("attempt", a);
            emit("job", row);
            changed = true;
          }
        } else if (
          row.state === "infra_error" &&
          retryAt.has(row.id) &&
          t >= retryAt.get(row.id)!
        ) {
          retryAt.delete(row.id);
          row.state = "queued";
          row.finishedAt = null;
          emit("job", row);
          changed = true;
        } else if (row.state === "queued") {
          const deps = row.needs.map((n) => rows.find((r) => r.jobKey === n));
          if (
            deps.some(
              (d) =>
                d &&
                (d.state === "failure" ||
                  d.state === "cancelled" ||
                  d.state === "skipped" ||
                  (d.state === "infra_error" && !retryAt.has(d.id))),
            )
          ) {
            row.state = "skipped";
            row.finishedAt = t;
            emit("job", row);
            changed = true;
          } else if (deps.every((d) => !d || d.state === "success")) {
            if (tpl.approval) {
              row.state = "awaiting_approval";
              row.approval = "environment";
              emit("job", row);
              changed = true;
              continue;
            }
            const n = attemptsOf(row.id).length + 1;
            const a = makeAttempt(row, n, t);
            attempts.set(a.id, a);
            const key = `${row.id}:${n}`;
            const plan = planFor(tpl, failingRuns.get(run.id) ?? false, key);
            if (n > 1) plans.set(key, { ...plan, outcome: "success" });
            row.state = "running";
            row.startedAt = row.startedAt ?? t;
            emit("attempt", a);
            emit("job", row);
            changed = true;
          }
        }
      }
      const next = aggregate(rows);
      if (changed || next !== run.status) {
        if (next !== run.status || changed) {
          run.status = next;
          if (run.startedAt == null && next !== "queued") run.startedAt = t;
          if (
            next === "success" ||
            next === "failure" ||
            next === "cancelled" ||
            next === "infra_error"
          )
            run.finishedAt = t;
          emit("run", run);
        }
      }
    }
  }

  function activeRunCount(projectId: string): number {
    return [...runs.values()].filter(
      (r) => r.projectId === projectId && (r.status === "running" || r.status === "queued"),
    ).length;
  }

  // ---- seed ----
  const base = now();
  for (const project of projects) {
    const wfs = project.slug === "infra" ? [WORKFLOWS[1]!, WORKFLOWS[2]!] : WORKFLOWS;
    for (let i = 0; i < 34; i++) {
      const wf =
        i % 6 === 5
          ? wfs[wfs.length - 1]!
          : i % 11 === 10
            ? wfs[Math.min(1, wfs.length - 1)]!
            : wfs[0]!;
      seedHistorical(project, wf, base - (i + 1) * rng.int(900_000, 2_400_000), rng.chance(0.22));
    }
  }
  // Live work: two running runs on the first project, one elsewhere.
  startRunning(projects[0]!, WORKFLOWS[0]!, false);
  startRunning(projects[0]!, WORKFLOWS[0]!, true);
  startRunning(projects[1]!, WORKFLOWS[0]!, false);
  startRunning(projects[1]!, WORKFLOWS[0]!, false, true);

  function maybeSpawn(): void {
    for (const p of projects) {
      if (activeRunCount(p.id) < 1 && rng.chance(0.18)) {
        const wfs =
          p.slug === "infra" ? [WORKFLOWS[2]!] : [WORKFLOWS[0]!, WORKFLOWS[0]!, WORKFLOWS[2]!];
        startRunning(p, rng.pick(wfs), rng.chance(0.3));
      }
    }
  }

  // ---- reads ----
  function planOfAttempt(a: JobAttempt): Plan {
    return (
      plans.get(`${a.jobId}:${a.attempt}`) ?? {
        durationMs: 60_000,
        outcome: "success",
        kind: "build",
      }
    );
  }

  /** The log for an attempt and how many bytes of it exist right now. */
  function logOf(attemptId: string): {
    log: GeneratedLog;
    available: number;
    done: boolean;
    steps: GeneratedLog["steps"];
    cuts: GeneratedLog["cuts"];
  } | null {
    const a = attempts.get(attemptId);
    if (!a || a.startedAt == null) return null;
    const plan = planOfAttempt(a);
    const durationMs = plan.durationMs;
    const log = generateLog({
      kind: plan.kind,
      outcome: plan.outcome,
      seed: a.id,
      startedAt: a.startedAt,
      durationMs,
    });
    const finished = a.finishedAt != null;
    if (finished)
      return { log, available: log.bytes.length, done: true, steps: log.steps, cuts: log.cuts };
    const p = Math.min(1, Math.max(0, (now() - a.startedAt) / durationMs));
    const lines = Math.floor(log.lineCount * p);
    const available = lines === 0 ? 0 : (log.lineEnds[lines - 1] ?? 0);
    return {
      log,
      available,
      done: false,
      steps: log.steps.filter((st) => st.logOffset <= available),
      cuts: log.cuts.filter((c) => c.atOffset <= available),
    };
  }

  // ---- writes ----
  function rerun(runId: string, jobId?: string): { runId: string } {
    const run = runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (jobId) {
      const job = jobs.get(jobId);
      if (!job || job.runId !== runId) throw new Error(`job not found: ${jobId}`);
      const ids = new Set<string>([job.id]);
      // Re-queue the job and anything downstream that was cancelled.
      for (const j of jobsOf(runId))
        if (j.state === "cancelled" || j.state === "skipped") ids.add(j.id);
      for (const jid of ids) {
        const j = jobs.get(jid)!;
        j.state = "queued";
        j.exitCode = null;
        j.finishedAt = null;
        retryAt.delete(jid);
        emit("job", j);
      }
      run.status = "running";
      run.finishedAt = null;
      failingRuns.set(runId, false);
      emit("run", run);
      return { runId };
    }
    const project = projects.find((p) => p.id === run.projectId)!;
    const wf = WORKFLOWS.find((w) => w.path === run.workflowPath) ?? WORKFLOWS[0]!;
    const newId = startRunning(project, wf, false);
    const created = runs.get(newId)!;
    created.sha = run.sha;
    created.ref = run.ref;
    created.event = "workflow_dispatch";
    created.commitMessage = run.commitMessage;
    emit("run", created);
    return { runId: newId };
  }

  function cancel(runId: string): void {
    const run = runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const t = now();
    for (const j of jobsOf(runId)) {
      if (j.state === "queued" || j.state === "running" || j.state === "awaiting_approval") {
        const a = attemptsOf(j.id).at(-1);
        if (a && a.finishedAt == null && j.state === "running") {
          a.state = "cancelled";
          a.finishedAt = t;
          emit("attempt", a);
        }
        j.state = "cancelled";
        j.finishedAt = t;
        retryAt.delete(j.id);
        emit("job", j);
      }
    }
    run.status = "cancelled";
    run.finishedAt = t;
    emit("run", run);
  }

  return {
    orgs,
    projects,
    runs,
    jobs,
    attempts,
    events,
    jobsOf,
    attemptsOf,
    tick,
    maybeSpawn,
    logOf,
    rerun,
    cancel,
    cursor,
    now,
    onEvent(l: (e: ChangeEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
