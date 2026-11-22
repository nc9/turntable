import {
  BasicIndex,
  createCollection,
  createOptimisticAction,
  type Collection,
  type SyncConfig,
} from "@tanstack/db";
import { getBackend } from "@/api";
import type { ChangeEvent } from "@/api/realtime";
import type { Job, JobAttempt, Run } from "@/api/types";
import { isActive } from "@/lib/states";

// Three collections fed only by the sync layer (initial fetches plus realtime change events).
// `mirror` holds the rows the server has confirmed, independent of optimistic state, so an
// optimistic action can wait for the real change to arrive before its overlay is dropped.

type SyncApi<T extends object> = {
  begin: () => void;
  write: (m: { type: "insert" | "update"; value: T }) => void;
  commit: () => unknown;
};

function createSyncedCollection<T extends { id: string }>(id: string) {
  const mirror = new Map<string, T>();
  let api: SyncApi<T> | null = null;
  const backlog: T[] = [];

  const syncConfig: SyncConfig<T, string> = {
    sync: (params) => {
      api = params as unknown as SyncApi<T>;
      if (backlog.length > 0) flush(backlog.splice(0));
      params.markReady();
      return () => {
        api = null;
      };
    },
  };

  const collection: Collection<T, string> = createCollection<T, string>({
    id,
    getKey: (row) => row.id,
    gcTime: 0,
    startSync: true,
    defaultIndexType: BasicIndex,
    sync: syncConfig,
  }) as unknown as Collection<T, string>;

  function flush(rows: T[]): void {
    if (!api) {
      backlog.push(...rows);
      return;
    }
    api.begin();
    for (const row of rows) {
      const type = mirror.has(row.id) ? "update" : "insert";
      mirror.set(row.id, row);
      api.write({ type, value: row });
    }
    api.commit();
  }

  return {
    collection,
    mirror,
    upsert(rows: T[]): void {
      if (rows.length === 0) return;
      // Ignore stale rows: never move an entity backwards in time within one session.
      flush(rows);
    },
  };
}

export const runs = createSyncedCollection<Run>("runs");
export const jobs = createSyncedCollection<Job>("jobs");
export const attempts = createSyncedCollection<JobAttempt>("attempts");

export const runsCollection = runs.collection;
export const jobsCollection = jobs.collection;
export const attemptsCollection = attempts.collection;

/** Apply one realtime change event to the right collection. */
export function applyChange(ev: ChangeEvent): void {
  switch (ev.entity) {
    case "run":
      runs.upsert([ev.value]);
      break;
    case "job":
      jobs.upsert([ev.value]);
      break;
    case "attempt":
      attempts.upsert([ev.value]);
      break;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 40));
}

/**
 * Rerun the failed jobs of a run, or the named jobs, with an audited reason. Optimistic: the
 * targeted jobs show queued at once. The run keeps its id; the jobs get a new attempt.
 */
export const rerunAction = createOptimisticAction<{
  runId: string;
  jobKeys?: string[];
  reason: string;
}>({
  onMutate: ({ runId, jobKeys }) => {
    for (const [key, job] of jobsCollection.entries()) {
      if (job.runId !== runId) continue;
      const hit = jobKeys
        ? jobKeys.includes(job.jobKey)
        : job.state === "failure" || job.state === "infra_error";
      if (hit) jobsCollection.update(key, (d) => void (d.state = "queued"));
    }
    if (runsCollection.has(runId)) runsCollection.update(runId, (d) => void (d.status = "running"));
  },
  mutationFn: async ({ runId, jobKeys, reason }) => {
    const result = await getBackend().api.rerun(
      jobKeys ? { runId, jobKeys, reason } : { runId, reason },
    );
    const ids = new Set(result.reruns.map((r) => r.jobId));
    await waitFor(() => [...ids].every((id) => jobs.mirror.get(id)?.state !== "failure"));
  },
});

/** Cancel a run. Optimistic: the run and its unfinished jobs show cancelled immediately. */
export const cancelAction = createOptimisticAction<{ runId: string }>({
  onMutate: ({ runId }) => {
    if (runsCollection.has(runId))
      runsCollection.update(runId, (d) => void (d.status = "cancelled"));
    for (const [key, job] of jobsCollection.entries()) {
      if (job.runId === runId && isActive(job.state))
        jobsCollection.update(key, (d) => void (d.state = "cancelled"));
    }
  },
  mutationFn: async ({ runId }) => {
    await getBackend().api.cancel({ runId });
    await waitFor(() => runs.mirror.get(runId)?.status === "cancelled");
  },
});

// Ordered, limited live queries (palette, org overview) need an index on the sort key.
runsCollection.createIndex((row) => row.createdAt);
