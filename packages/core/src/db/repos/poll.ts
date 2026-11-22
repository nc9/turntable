// Poll ingest persistence. Part of the only code that names tenant tables.
import { and, count, eq, gte } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { createAttempt, createJob, createRun, type Run, type RunInput } from "./index";
import { requireProject, type Scope, scoped } from "./scope";

const SEEN_COLS = { orgId: s.pollSeen.orgId, projectId: s.pollSeen.projectId };

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
