import type { TurntableApi } from "./client";
import {
  type ChangeEvent,
  type ConnectionStatus,
  type Realtime,
  type RealtimeMessage,
  type SubscribeOptions,
  type Topic,
} from "./realtime";

export type PollingOptions = {
  /** Poll interval for lists and runs. Log tails poll faster while an attempt is running. */
  intervalMs?: number;
  logIntervalMs?: number;
};

/**
 * Realtime over plain requests, for servers without a push transport (and as the fallback when
 * WebSocket is blocked). It polls the same API calls the UI already uses and turns differences
 * into the change events and log chunks the realtime interface promises, so the collections and
 * the log viewer behave the same either way. Polling pauses while the tab is hidden.
 */
/**
 * Turns "fetch the current state" into change events: it remembers what it last emitted per
 * entity and emits only what changed. Shared by polling (refresh on a timer) and the WebSocket
 * adapter (refresh when the server says something happened, and after a reconnect).
 */
export function createSnapshotSource(
  api: TurntableApi,
  topic: Topic,
  emit: (m: RealtimeMessage) => void,
  nextCursor: () => string,
): { refresh: () => Promise<void> } {
  const seen = new Map<string, string>();
  const push = (entity: ChangeEvent["entity"], value: { id: string }) => {
    const key = `${entity}:${value.id}`;
    const sig = JSON.stringify(value);
    if (seen.get(key) === sig) return;
    seen.set(key, sig);
    emit({ type: "change", cursor: nextCursor(), entity, op: "upsert", value } as ChangeEvent);
  };
  return {
    async refresh() {
      if (topic.kind === "run") {
        const d = await api.getRun(topic.runId);
        push("run", d.run);
        for (const j of d.jobs) push("job", j);
        for (const a of d.attempts) push("attempt", a);
      } else if (topic.kind === "project" || topic.kind === "org") {
        const { runs } = await api.listRuns({
          projectId: topic.kind === "project" ? topic.projectId : "",
          limit: topic.kind === "project" ? 50 : 30,
        });
        for (const r of runs) push("run", r);
      }
    },
  };
}

export function createPollingRealtime(api: TurntableApi, options: PollingOptions = {}): Realtime {
  const interval = options.intervalMs ?? 3000;
  const logInterval = options.logIntervalMs ?? 1000;
  let status: ConnectionStatus = "polling";
  const listeners = new Set<(s: ConnectionStatus) => void>();
  const setStatus = (s: ConnectionStatus) => {
    if (s === status) return;
    status = s;
    for (const l of listeners) l(s);
  };
  let counter = 0;
  const nextCursor = () => String(++counter).padStart(10, "0");

  function pollEntities(topic: Topic, emit: (m: RealtimeMessage) => void): () => void {
    const source = createSnapshotSource(api, topic, emit, nextCursor);
    return every(interval, source.refresh);
  }

  function pollLog(
    topic: Extract<Topic, { kind: "attempt-log" }>,
    from: number,
    emit: (m: RealtimeMessage) => void,
  ): () => void {
    let offset = from;
    return every(logInterval, async () => {
      const slice = await api.jobLog({ attemptId: topic.attemptId, offset, limit: 256 * 1024 });
      if (slice.bytes.length > 0) {
        emit({ type: "log", attemptId: topic.attemptId, offset, data: slice.bytes });
        offset += slice.bytes.length;
      }
      if (slice.done && offset >= slice.size) {
        emit({
          type: "log",
          attemptId: topic.attemptId,
          offset,
          data: new Uint8Array(0),
          eof: true,
        });
        return "stop";
      }
      return undefined;
    });
  }

  /** Runs `fn` now and then every `ms`, skipping ticks while hidden and never overlapping. */
  function every(ms: number, fn: () => Promise<"stop" | undefined | void>): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      let again = true;
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        try {
          if ((await fn()) === "stop") again = false;
          setStatus("polling");
        } catch (e) {
          // An auth failure is handled by the API layer; anything else shows as reconnecting.
          setStatus(
            e instanceof Error && "status" in e && (e as { status: number }).status === 401
              ? "offline"
              : "reconnecting",
          );
        }
      }
      if (again && !stopped) timer = setTimeout(() => void tick(), ms);
    };
    // The first poll is immediate so a subscription catches anything that changed since the load.
    timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return {
    subscribe(topic: Topic, opts: SubscribeOptions, handler: (m: RealtimeMessage) => void) {
      let closed = false;
      const emit = (m: RealtimeMessage) => {
        if (!closed) handler(m);
      };
      const stop =
        topic.kind === "attempt-log"
          ? pollLog(topic, opts.offset ?? 0, emit)
          : pollEntities(topic, emit);
      return () => {
        closed = true;
        stop();
      };
    },
    status: () => status,
    onStatus(l) {
      listeners.add(l);
      l(status);
      return () => listeners.delete(l);
    },
  };
}
