import type { TurntableApi } from "../client";
import type {
  ChangeEvent,
  ConnectionStatus,
  Realtime,
  RealtimeMessage,
  SubscribeOptions,
  Topic,
} from "../realtime";
import type { CheckSummary, RunDetail } from "../types";
import { createRng } from "./prng";
import { createWorld, type World } from "./world";

export type FixtureOptions = {
  /** Simulated network latency range in ms. Use 0 in tests. */
  latency?: [number, number];
  /** Simulation tick interval in ms. */
  tickMs?: number;
  seed?: string;
};

export type Fixture = {
  api: TurntableApi;
  realtime: Realtime;
  world: World;
  stop(): void;
};

function matches(world: World, topic: Topic, ev: ChangeEvent): boolean {
  const v = ev.value;
  switch (topic.kind) {
    case "org":
      return v.orgId === topic.orgId;
    case "project":
      return v.projectId === topic.projectId;
    case "run": {
      if (ev.entity === "run") return v.id === topic.runId;
      if (ev.entity === "job") return (v as { runId: string }).runId === topic.runId;
      const job = world.jobs.get((v as { jobId: string }).jobId);
      return job?.runId === topic.runId;
    }
    case "attempt-log":
      return false;
  }
}

/** In-memory world with a live simulation, behind the same interfaces as the real adapters. */
export function createFixture(options: FixtureOptions = {}): Fixture {
  const [minLat, maxLat] = options.latency ?? [50, 160];
  const world = createWorld(options.seed !== undefined ? { seed: options.seed } : {});
  const lagRng = createRng("latency");
  const delay = <T>(value: () => T): Promise<T> =>
    new Promise((resolve, reject) =>
      setTimeout(
        () => {
          try {
            resolve(value());
          } catch (e) {
            reject(e);
          }
        },
        minLat + lagRng.next() * (maxLat - minLat),
      ),
    );

  const timer = setInterval(() => {
    world.tick();
    world.maybeSpawn();
  }, options.tickMs ?? 1000);

  const api: TurntableApi = {
    listOrgs: () => delay(() => world.orgs.map((o) => ({ ...o }))),
    listProjects: (orgId) =>
      delay(() => world.projects.filter((p) => p.orgId === orgId).map((p) => ({ ...p }))),
    listRuns: (f) =>
      delay(() => {
        let rows = [...world.runs.values()].filter((r) => r.projectId === f.projectId);
        if (f.status) rows = rows.filter((r) => r.status === f.status);
        if (f.event) rows = rows.filter((r) => r.event === f.event);
        if (f.branch) rows = rows.filter((r) => r.ref.endsWith(f.branch!));
        rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
        const start = f.cursor ? Number(f.cursor) : 0;
        const limit = f.limit ?? 50;
        const page = rows.slice(start, start + limit).map((r) => ({ ...r }));
        return {
          runs: page,
          nextCursor: start + limit < rows.length ? String(start + limit) : null,
        };
      }),
    getRun: (runId) =>
      delay((): RunDetail => {
        const run = world.runs.get(runId);
        if (!run) throw new Error(`Run ${runId} was not found`);
        const jobs = world.jobsOf(runId);
        const attempts = jobs.flatMap((j) => world.attemptsOf(j.id));
        return {
          run: { ...run },
          jobs: jobs.map((j) => ({ ...j })),
          attempts: attempts.map((a) => ({ ...a })),
        };
      }),
    jobLog: ({ attemptId, offset, limit }) =>
      delay(() => {
        const l = world.logOf(attemptId);
        if (!l) return { attemptId, offset, bytes: new Uint8Array(0), size: 0, done: false };
        const end = Math.min(l.available, offset + limit);
        const bytes = l.log.bytes.slice(Math.min(offset, l.available), end);
        return { attemptId, offset, bytes, size: l.available, done: l.done && end >= l.available };
      }),
    jobSteps: ({ attemptId }) =>
      delay(() => (world.logOf(attemptId)?.steps ?? []).map((st) => ({ ...st, attemptId }))),
    jobCuts: ({ attemptId }) =>
      delay(() => (world.logOf(attemptId)?.cuts ?? []).map((c) => ({ ...c, attemptId }))),
    checksForSha: ({ projectId, sha }) =>
      delay((): CheckSummary => {
        const rows = [...world.runs.values()].filter(
          (r) => r.projectId === projectId && r.sha === sha,
        );
        const worst =
          rows.find((r) => r.status === "failure") ??
          rows.find((r) => r.status === "running") ??
          rows[0];
        return {
          sha,
          state: worst?.status ?? "none",
          runs: rows.map((r) => ({ runId: r.id, workflowName: r.workflowName, status: r.status })),
        };
      }),
    rerun: ({ runId, jobId }) => delay(() => world.rerun(runId, jobId)),
    cancel: ({ runId }) => delay(() => void world.cancel(runId)),
    events: ({ cursor, limit }) =>
      delay(() => {
        const after = cursor ?? "";
        const evs = world.events.filter((e) => e.cursor > after).slice(0, limit ?? 200);
        return { events: evs, cursor: evs.at(-1)?.cursor ?? after };
      }),
  };

  let status: ConnectionStatus = "live";
  const statusListeners = new Set<(s: ConnectionStatus) => void>();

  const realtime: Realtime = {
    subscribe(topic, opts: SubscribeOptions, handler: (m: RealtimeMessage) => void) {
      let closed = false;
      const deliver = (m: RealtimeMessage) => {
        if (!closed) handler(m);
      };
      if (topic.kind === "attempt-log")
        return subscribeLog(
          world,
          topic.attemptId,
          opts.offset ?? 0,
          deliver,
          () => (closed = true),
        );
      // Replay missed events after the cursor, then stream live, without gaps or duplicates.
      let last = opts.cursor ?? world.cursor();
      queueMicrotask(() => {
        for (const ev of world.events) {
          if (ev.cursor > last && matches(world, topic, ev)) {
            last = ev.cursor;
            deliver(ev);
          }
        }
      });
      const off = world.onEvent((ev) => {
        if (ev.cursor > last && matches(world, topic, ev)) {
          last = ev.cursor;
          // Deferred like a socket would: never re-enter the caller mid-mutation.
          queueMicrotask(() => deliver(ev));
        }
      });
      return () => {
        closed = true;
        off();
      };
    },
    status: () => status,
    onStatus(l) {
      statusListeners.add(l);
      l(status);
      return () => statusListeners.delete(l);
    },
  };

  return {
    api,
    realtime,
    world,
    stop() {
      clearInterval(timer);
    },
  };
}

function subscribeLog(
  world: World,
  attemptId: string,
  fromOffset: number,
  deliver: (m: RealtimeMessage) => void,
  markClosed: () => void,
): () => void {
  const rng = createRng(`chunks:${attemptId}:${fromOffset}`);
  let offset = fromOffset;
  let stepsSent = 0;
  let cutsSent = 0;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    if (stopped) return;
    const l = world.logOf(attemptId);
    if (l && offset < l.available) {
      // Chunks end at arbitrary byte positions, so lines and UTF-8 sequences straddle chunks.
      const size = Math.min(l.available - offset, rng.int(180, 5200));
      const data = l.log.bytes.slice(offset, offset + size);
      offset += size;
      const eof = l.done && offset >= l.available;
      deliver({
        type: "log",
        attemptId,
        offset: offset - size,
        data,
        ...(eof ? { eof: true } : {}),
      });
      // Step boundaries travel out of band, once the log has reached their offset. A resume may
      // replay some; the client applies them idempotently.
      const due = l.steps.filter((st) => st.logOffset >= fromOffset && st.logOffset <= offset);
      for (; stepsSent < due.length; stepsSent++) {
        deliver({ type: "step", attemptId, ...(due[stepsSent] as (typeof due)[number]) });
      }
      const dueCuts = l.cuts.filter((c) => c.atOffset >= fromOffset && c.atOffset <= offset);
      for (; cutsSent < dueCuts.length; cutsSent++) {
        deliver({ type: "cut", attemptId, ...(dueCuts[cutsSent] as (typeof dueCuts)[number]) });
      }
      if (eof) return;
      handle = setTimeout(step, rng.int(20, 90));
      return;
    }
    if (l?.done) {
      deliver({ type: "log", attemptId, offset, data: new Uint8Array(0), eof: true });
      return;
    }
    handle = setTimeout(step, 300);
  };
  handle = setTimeout(step, 30);
  return () => {
    stopped = true;
    markClosed();
    if (handle) clearTimeout(handle);
  };
}
