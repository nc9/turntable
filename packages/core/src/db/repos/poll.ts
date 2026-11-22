// Poll ingest persistence. Part of the only code that names tenant tables.
import { and, count, eq, gte } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { createAttempt, createJob, createRun, type Run, type RunInput } from "./index";
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

export type PolledJob = { key: string; name: string; needs: readonly string[] };

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
  },
): Promise<Run | undefined> {
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
    const run = await createRun(tx, scope, input.run);
    for (const job of input.jobs) {
      const created = await createJob(tx, scope, {
        runId: run.id,
        jobKey: job.key,
        name: job.name,
        needs: job.needs,
      });
      if (created) await createAttempt(tx, scope, { jobId: created.id, provider: input.provider });
    }
    await tx.orm.insert(s.pollSeen).values({
      orgId: scope.orgId,
      ...key,
      runId: run.id,
      ...(input.now === undefined ? {} : { createdAt: input.now }),
    });
    return run;
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
