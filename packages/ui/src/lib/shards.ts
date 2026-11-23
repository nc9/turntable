// Shards of one split job are shown as ONE job: its name, the fold of the shards' states and the
// wall time from the first shard's start to the last one's finish. The fold is the server's
// (failure, then infra_error, cancelled, skipped only if all, else success; running or queued
// while any shard is).
import type { Job, JobState } from "@/api/types";

const TERMINAL: readonly JobState[] = ["success", "failure", "infra_error", "cancelled", "skipped"];

export function foldShardStates(states: readonly JobState[]): JobState {
  if (states.some((s) => !TERMINAL.includes(s))) {
    if (states.includes("running")) return "running";
    if (states.includes("awaiting_approval")) return "awaiting_approval";
    return "queued";
  }
  if (states.includes("failure")) return "failure";
  if (states.includes("infra_error")) return "infra_error";
  if (states.includes("cancelled")) return "cancelled";
  if (states.every((s) => s === "skipped")) return "skipped";
  return "success";
}

export type ShardGroup = {
  /** Stable id: `shard:<workflow job id>`. */
  id: string;
  name: string;
  /** The shards, by index. */
  shards: Job[];
  state: JobState;
  startedAt: number | null;
  /** Null until every shard has finished. */
  finishedAt: number | null;
};

export type JobItem = { kind: "job"; job: Job } | { kind: "shards"; group: ShardGroup };

/** The group a shard row belongs to, or null for any other row. */
export const shardGroupId = (job: Job): string | null =>
  job.shard ? `shard:${job.shard.job}` : null;

/** Jobs in order, with the shards of each split job gathered into one item at the first shard. */
export function groupJobs(jobs: readonly Job[]): JobItem[] {
  const groups = new Map<string, Job[]>();
  for (const j of jobs) {
    const id = shardGroupId(j);
    if (id) groups.set(id, [...(groups.get(id) ?? []), j]);
  }
  const out: JobItem[] = [];
  const emitted = new Set<string>();
  for (const j of jobs) {
    const id = shardGroupId(j);
    if (!id) {
      out.push({ kind: "job", job: j });
      continue;
    }
    if (emitted.has(id)) continue;
    emitted.add(id);
    out.push({ kind: "shards", group: makeGroup(id, groups.get(id) as Job[]) });
  }
  return out;
}

export function makeGroup(id: string, rows: readonly Job[]): ShardGroup {
  const shards = rows.toSorted((a, b) => (a.shard?.index ?? 0) - (b.shard?.index ?? 0));
  const starts = shards.map((s) => s.startedAt).filter((x): x is number => x !== null);
  const ends = shards.map((s) => s.finishedAt);
  const allDone = ends.every((e) => e !== null);
  return {
    id,
    name: shards[0]?.name ?? "",
    shards,
    state: foldShardStates(shards.map((s) => s.state)),
    startedAt: starts.length > 0 ? Math.min(...starts) : null,
    finishedAt: allDone && ends.length > 0 ? Math.max(...(ends as number[])) : null,
  };
}

/** "Shard 2 of 3". */
export const shardLabel = (j: Job): string =>
  j.shard ? `Shard ${j.shard.index + 1} of ${j.shard.total}` : "";
