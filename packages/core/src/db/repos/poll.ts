// Poll ingest persistence. Part of the only code that names tenant tables.
import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import {
  cancelRunJobs,
  createAttempt,
  createJob,
  createRun,
  type Run,
  type RunInput,
} from "./index";
import { requireProject, type Scope, scoped } from "./scope";

const SEEN_COLS = { orgId: s.pollSeen.orgId, projectId: s.pollSeen.projectId };

/** Most jobs one run may have. A workflow with more is refused at ingest. */
export const MAX_JOBS_PER_RUN = 256;

/**
 * Checks a run's job graph: at most MAX_JOBS_PER_RUN jobs, unique keys, every `needs` entry names
 * a job of the run, and no cycles (a self-dependency is one). Returns the first problem, or
 * undefined when the graph is sound.
 */
export function validateJobGraph(
  jobs: readonly { key: string; needs: readonly string[] }[],
): string | undefined {
  if (jobs.length > MAX_JOBS_PER_RUN) {
    return `workflow has ${jobs.length} jobs; the limit is ${MAX_JOBS_PER_RUN}`;
  }
  const byKey = new Map<string, readonly string[]>();
  for (const job of jobs) {
    if (byKey.has(job.key)) return `duplicate job key ${job.key}`;
    byKey.set(job.key, job.needs);
  }
  for (const job of jobs) {
    for (const need of job.needs) {
      if (!byKey.has(need)) return `job ${job.key} needs unknown job ${need}`;
    }
  }
  // Depth-first search with colours: grey on the current path, black when finished.
  const colour = new Map<string, "grey" | "black">();
  const visit = (key: string, path: string[]): string | undefined => {
    colour.set(key, "grey");
    for (const need of byKey.get(key) ?? []) {
      if (colour.get(need) === "grey")
        return `dependency cycle: ${[...path, key, need].join(" -> ")}`;
      if (!colour.has(need)) {
        const found = visit(need, [...path, key]);
        if (found) return found;
      }
    }
    colour.set(key, "black");
    return undefined;
  };
  for (const job of jobs) {
    if (!colour.has(job.key)) {
      const found = visit(job.key, []);
      if (found) return found;
    }
  }
  return undefined;
}

export type PolledJob = {
  key: string;
  name: string;
  needs: readonly string[];
  matrix?: Record<string, unknown> | undefined;
  /** The planned job (see PlannedJob in act-runner), kept as JSON for the scheduler. */
  planned?: unknown;
};

/** What a newer run took from older ones in its concurrency group. */
export type Superseded = {
  runIds: string[];
  /** Attempts that were running: their workers must stop and their sandboxes be destroyed. */
  running: { attemptId: string; sandboxId: string | null; provider: string }[];
};

/** The run, its jobs and a queued attempt per job. Shared by the poller and `longshore run`. */
async function insertPlannedRun(
  tx: Db,
  scope: Scope,
  input: { run: RunInput; jobs: readonly PolledJob[]; provider: string },
): Promise<Run> {
  const run = await createRun(tx, scope, input.run);
  for (const job of input.jobs) {
    const created = await createJob(tx, scope, {
      runId: run.id,
      jobKey: job.key,
      name: job.name,
      needs: job.needs,
      ...(job.matrix ? { matrix: job.matrix } : {}),
      ...(job.planned === undefined ? {} : { planned: job.planned }),
    });
    if (created) await createAttempt(tx, scope, { jobId: created.id, provider: input.provider });
  }
  return run;
}

/**
 * Creates a run started by `longshore run`: the planned jobs with queued attempts, marked
 * `local` so only the starting process runs them. No poll marker, no concurrency group (a local
 * run never waits for, or cancels, another).
 */
export function createLocalRun(
  db: Db,
  scope: Scope,
  input: { run: RunInput; jobs: readonly PolledJob[]; provider: string },
): Promise<Run> {
  const invalid = validateJobGraph(input.jobs);
  if (invalid) return Promise.reject(new Error(`invalid job graph: ${invalid}`));
  return db.transaction((tx) =>
    insertPlannedRun(tx, scope, {
      ...input,
      run: { ...input.run, local: true, concurrencyGroup: undefined },
    }),
  );
}

/**
 * Creates the run, its jobs and a queued attempt per job for something the poller found, once
 * per (repo, workflow, event, sha): a second call for the same key returns `undefined` and
 * changes nothing. The key check, the rows and the marker commit in one transaction.
 */
export function createPolledRun(
  db: Db,
  scope: Scope,
  input: {
    /** `owner/name`, any case. */
    repo: string;
    run: RunInput & { sha: string };
    jobs: readonly PolledJob[];
    provider: string;
    /** Epoch ms stamped on the marker; the hourly cap counts by it. Default: the clock. */
    now?: number | undefined;
    /** Cancel older runs of the same concurrency group (cancel-in-progress). */
    cancelInProgress?: boolean | undefined;
  },
): Promise<{ run: Run; superseded: Superseded } | undefined> {
  const invalid = validateJobGraph(input.jobs);
  if (invalid) return Promise.reject(new Error(`invalid job graph: ${invalid}`));
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const key = {
      projectId,
      repo: input.repo.toLowerCase(),
      workflowPath: input.run.workflowPath,
      event: input.run.event,
      sha: input.run.sha,
    };
    const [seen] = await tx.orm
      .select({ n: count() })
      .from(s.pollSeen)
      .where(
        and(
          eq(s.pollSeen.projectId, key.projectId),
          eq(s.pollSeen.repo, key.repo),
          eq(s.pollSeen.workflowPath, key.workflowPath),
          eq(s.pollSeen.event, key.event),
          eq(s.pollSeen.sha, key.sha),
        ),
      );
    if (Number(seen?.n ?? 0) > 0) return undefined;
    const run = await insertPlannedRun(tx, scope, input);
    await tx.orm.insert(s.pollSeen).values({
      orgId: scope.orgId,
      ...key,
      runId: run.id,
      ...(input.now === undefined ? {} : { createdAt: input.now }),
    });
    // The new run exists (rows and marker) before anything is cancelled: if this transaction
    // fails, nothing was superseded, and no moment has neither run (reliability rule R3).
    const superseded = run.concurrencyGroup
      ? await supersedeOlderRuns(tx, scope, run, input.cancelInProgress ? "all" : "pending")
      : { runIds: [], running: [] };
    return { run, superseded };
  });
}

/** Runs the poller created for a repo since `since` (epoch ms): the per-hour cap counts these. */
export function countPolledSince(
  db: Db,
  scope: Scope,
  repo: string,
  since: number,
): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: count() })
      .from(s.pollSeen)
      .where(
        scoped(
          scope,
          SEEN_COLS,
          eq(s.pollSeen.repo, repo.toLowerCase()),
          gte(s.pollSeen.createdAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

/** Unfinished runs of a run's concurrency group that are older than it. */
async function olderUnfinished(db: Db, run: Run): Promise<Run[]> {
  if (!run.concurrencyGroup) return [];
  return db.orm
    .select()
    .from(s.runs)
    .where(
      and(
        eq(s.runs.orgId, run.orgId),
        eq(s.runs.projectId, run.projectId),
        eq(s.runs.concurrencyGroup, run.concurrencyGroup),
        lt(s.runs.id, run.id),
        inArray(s.runs.status, ["queued", "running", "awaiting_approval"]),
      ),
    );
}

/**
 * Applies a concurrency group to a run that was just created (call it in the same transaction,
 * after the run exists, so there is no moment with neither run).
 *
 * - `all` (`cancel-in-progress: true`): every older unfinished run of the group is cancelled,
 *   queued and running jobs alike.
 * - `pending` (no cancel-in-progress, GitHub's semantics): a group has at most one running run
 *   and one pending run. If a run is running, an older PENDING run (one that has not started) is
 *   replaced, that is cancelled, and this run waits as the new pending one. The running run is
 *   left alone, and this run's jobs are not claimed until it finishes (see `groupBlocked`).
 *
 * Running attempts that were cancelled are reported (and announced on the abort bus after
 * commit) so their workers stop and their sandboxes are destroyed.
 */
export async function supersedeOlderRuns(
  db: Db,
  scope: Scope,
  run: Run,
  mode: "all" | "pending" = "all",
): Promise<Superseded> {
  const out: Superseded = { runIds: [], running: [] };
  const older = await olderUnfinished(db, run);
  // "Started" means the aggregate is anything but queued: some job ran or is waiting on approval.
  const anyStarted = older.some((r) => r.status !== "queued");
  for (const old of older) {
    if (mode === "pending" && (old.status !== "queued" || !anyStarted)) continue;
    const res = await cancelRunJobs(db, scope, old.id, {
      errorClass: mode === "all" ? "superseded by a newer run" : "replaced by a newer pending run",
    });
    if (!res) continue;
    out.runIds.push(old.id);
    out.running.push(...res.running);
  }
  return out;
}

/**
 * True when a run must wait for its concurrency group: it has not started and an older run of the
 * same group is still unfinished. The scheduler does not claim its jobs until then.
 */
export async function groupBlocked(db: Db, run: Run): Promise<boolean> {
  if (!run.concurrencyGroup || run.status !== "queued") return false;
  return (await olderUnfinished(db, run)).length > 0;
}

/**
 * Remembers a (repo, workflow, event, sha) the poller looked at and decided not to run (the
 * workflow's triggers did not match, e.g. a path filter), so it is not looked at again. No run is
 * created. Returns false when the key was already recorded.
 */
export function markPollSkipped(
  db: Db,
  scope: Scope,
  input: {
    repo: string;
    workflowPath: string;
    event: string;
    sha: string;
    now?: number | undefined;
  },
): Promise<boolean> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const rows = await h.orm
      .insert(s.pollSeen)
      .values({
        orgId: scope.orgId,
        projectId,
        repo: input.repo.toLowerCase(),
        workflowPath: input.workflowPath,
        event: input.event,
        sha: input.sha,
        runId: "skipped",
        ...(input.now === undefined ? {} : { createdAt: input.now }),
      })
      .onConflictDoNothing()
      .returning({ sha: s.pollSeen.sha });
    return rows.length > 0;
  });
}

/** Whether the key was already handled (run created or deliberately skipped). */
export function pollSeen(
  db: Db,
  scope: Scope,
  input: { repo: string; workflowPath: string; event: string; sha: string },
): Promise<boolean> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ n: count() })
      .from(s.pollSeen)
      .where(
        and(
          eq(s.pollSeen.projectId, projectId),
          eq(s.pollSeen.repo, input.repo.toLowerCase()),
          eq(s.pollSeen.workflowPath, input.workflowPath),
          eq(s.pollSeen.event, input.event),
          eq(s.pollSeen.sha, input.sha),
        ),
      );
    return Number(row?.n ?? 0) > 0;
  });
}

/** The sha the poller last handled for a repo and event (the `before` of the next push). */
export function lastPolledSha(
  db: Db,
  scope: Scope,
  repo: string,
  workflowPath: string,
  event: string,
): Promise<string | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ sha: s.pollSeen.sha })
      .from(s.pollSeen)
      .where(
        scoped(
          scope,
          SEEN_COLS,
          eq(s.pollSeen.repo, repo.toLowerCase()),
          eq(s.pollSeen.workflowPath, workflowPath),
          eq(s.pollSeen.event, event),
        ),
      )
      .orderBy(desc(s.pollSeen.createdAt), desc(s.pollSeen.sha))
      .limit(1);
    return row?.sha;
  });
}
