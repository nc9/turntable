import { Link } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { Job, JobAttempt, JobState } from "@/api/types";
import { Duration } from "@/components/live-clock";
import { StateIcon } from "@/components/state-badge";
import { cn } from "@/lib/utils";

const NODE_W = 236;
const COL_GAP = 72;
const ROW_GAP = 16;
const SINGLE_H = 56;
const GROUP_HEAD = 40;
const LEG_H = 30;
const PAD = 4;

type GraphNode = {
  id: string;
  title: string;
  jobs: Job[];
  group: boolean;
  needs: string[];
  level: number;
  x: number;
  y: number;
  h: number;
};

const SEVERITY: JobState[] = [
  "failure",
  "infra_error",
  "running",
  "awaiting_approval",
  "queued",
  "cancelled",
  "skipped",
  "success",
];
export function worstState(states: JobState[]): JobState {
  for (const s of SEVERITY) if (states.includes(s)) return s;
  return "queued";
}

function layout(jobs: Job[]): { nodes: GraphNode[]; width: number; height: number } {
  const byId = new Map<string, GraphNode>();
  const keyToNode = new Map<string, string>();
  for (const job of jobs) {
    const id = job.matrixGroup ?? job.jobKey;
    keyToNode.set(job.jobKey, id);
    const node = byId.get(id) ?? {
      id,
      title: job.matrixGroup ?? job.name,
      jobs: [],
      group: job.matrixGroup !== null,
      needs: [],
      level: 0,
      x: 0,
      y: 0,
      h: 0,
    };
    node.jobs.push(job);
    byId.set(id, node);
  }
  for (const node of byId.values()) {
    const needs = new Set<string>();
    for (const job of node.jobs)
      for (const n of job.needs) {
        const target = keyToNode.get(n);
        if (target && target !== node.id) needs.add(target);
      }
    node.needs = [...needs];
    node.h = node.group ? GROUP_HEAD + node.jobs.length * LEG_H + PAD : SINGLE_H;
  }
  const levelOf = (id: string, seen: Set<string> = new Set()): number => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return 0;
    if (node.needs.length === 0) return 0;
    seen.add(id);
    return 1 + Math.max(...node.needs.map((n) => levelOf(n, seen)));
  };
  const cols: GraphNode[][] = [];
  for (const node of byId.values()) {
    node.level = levelOf(node.id);
    (cols[node.level] ??= []).push(node);
  }
  const colHeights = cols.map(
    (c) => (c ?? []).reduce((a, n) => a + n.h, 0) + Math.max(0, (c?.length ?? 0) - 1) * ROW_GAP,
  );
  const height = Math.max(0, ...colHeights);
  cols.forEach((c, i) => {
    let y = (height - (colHeights[i] ?? 0)) / 2;
    for (const node of c ?? []) {
      node.x = i * (NODE_W + COL_GAP);
      node.y = y;
      y += node.h + ROW_GAP;
    }
  });
  return {
    nodes: [...byId.values()],
    width: cols.length * NODE_W + Math.max(0, cols.length - 1) * COL_GAP,
    height,
  };
}

export function JobGraph({
  jobs,
  attempts,
  orgSlug,
  projectSlug,
  runId,
}: {
  jobs: Job[];
  attempts: JobAttempt[];
  orgSlug: string;
  projectSlug: string;
  runId: string;
}) {
  const { nodes, width, height } = useMemo(() => layout(jobs), [jobs]);
  const [hover, setHover] = useState<string | null>(null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const attemptCount = (jobId: string) => attempts.filter((a) => a.jobId === jobId).length;
  const linked = (id: string) =>
    hover !== null &&
    (hover === id || byId.get(hover)?.needs.includes(id) || byId.get(id)?.needs.includes(hover));

  const jobLink = (job: Job, className: string, children: React.ReactNode) => (
    <Link
      to="/$org/$project/runs/$runId/jobs/$jobId"
      params={{ org: orgSlug, project: projectSlug, runId, jobId: job.id }}
      className={className}
      onMouseEnter={() => setHover(job.matrixGroup ?? job.jobKey)}
      onMouseLeave={() => setHover(null)}
      onFocus={() => setHover(job.matrixGroup ?? job.jobKey)}
      onBlur={() => setHover(null)}
    >
      {children}
    </Link>
  );

  return (
    <div className="overflow-x-auto overscroll-x-contain pb-2" role="group" aria-label="Job graph">
      <div
        className="relative mx-auto"
        style={{ width, height: Math.max(height, SINGLE_H), minWidth: width }}
      >
        <svg
          className="pointer-events-none absolute inset-0"
          width={width}
          height={Math.max(height, SINGLE_H)}
          aria-hidden="true"
        >
          {nodes.flatMap((n) =>
            n.needs.map((src) => {
              const s = byId.get(src);
              if (!s) return null;
              const x1 = s.x + NODE_W;
              const y1 = s.y + s.h / 2;
              const x2 = n.x;
              const y2 = n.y + n.h / 2;
              const mid = (x1 + x2) / 2;
              const on = hover !== null && (hover === n.id || hover === s.id);
              return (
                <path
                  key={`${src}->${n.id}`}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  fill="none"
                  strokeWidth={on ? 2 : 1.5}
                  className={cn(
                    "transition-[stroke] duration-150",
                    on ? "stroke-accent" : "stroke-line-strong",
                  )}
                />
              );
            }),
          )}
        </svg>
        {nodes.map((n) => {
          const state = worstState(n.jobs.map((j) => j.state));
          const dim = hover !== null && !linked(n.id);
          const common =
            "absolute rounded-lg border bg-surface transition-[border-color,opacity] duration-150";
          if (!n.group) {
            const job = n.jobs[0] as Job;
            const attemptsN = attemptCount(job.id);
            return (
              <div
                key={n.id}
                className={cn(
                  common,
                  dim && "opacity-60",
                  linked(n.id) ? "border-accent" : "border-line",
                )}
                style={{ left: n.x, top: n.y, width: NODE_W, height: n.h }}
              >
                {jobLink(
                  job,
                  "flex h-full items-center gap-2.5 rounded-lg px-3 hover:bg-subtle focus-visible:-outline-offset-2",
                  <>
                    <StateIcon state={job.state} className="size-[18px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{job.name}</span>
                      <span className="flex items-center gap-2 text-xs text-dim">
                        <Duration startedAt={job.startedAt} finishedAt={job.finishedAt} />
                        {attemptsN > 1 ? (
                          <span className="inline-flex items-center gap-1 text-st-infra">
                            <RotateCw className="size-3" aria-hidden="true" />
                            {attemptsN} attempts
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </>,
                )}
              </div>
            );
          }
          return (
            <div
              key={n.id}
              className={cn(
                common,
                "overflow-hidden",
                dim && "opacity-60",
                linked(n.id) ? "border-accent" : "border-line",
              )}
              style={{ left: n.x, top: n.y, width: NODE_W, height: n.h }}
            >
              <div className="flex items-center gap-2.5 px-3" style={{ height: GROUP_HEAD }}>
                <StateIcon state={state} className="size-[18px]" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
                <span className="text-xs text-faint">{n.jobs.length} legs</span>
              </div>
              <ul className="border-t border-line">
                {n.jobs.map((job) => (
                  <li key={job.id}>
                    {jobLink(
                      job,
                      "flex h-[30px] items-center gap-2 px-3 text-[13px] text-dim hover:bg-subtle hover:text-foreground focus-visible:-outline-offset-2",
                      <>
                        <StateIcon state={job.state} className="size-3.5" />
                        <span className="min-w-0 flex-1 truncate">
                          {Object.values(job.matrix ?? {}).join(", ")}
                        </span>
                        <Duration
                          startedAt={job.startedAt}
                          finishedAt={job.finishedAt}
                          className="text-xs"
                        />
                      </>,
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
