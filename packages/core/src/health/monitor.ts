// Runtime health of the server process (#693): event-loop lag sampled every second, the outbound
// call watchdog scanned on the same tick, the lag of each running job's log reader, and a
// heartbeat log line so that silence itself is a signal. In-process state only: nothing is
// persisted and nothing here carries a secret, a URL query or a header.
import { outboundWatchdog, type WatchdogSnapshot } from "@turntable/net";

export const LAG_SAMPLE_MS = 1000;
/** One sample over this is logged, and doctor warns. */
export const LAG_WARN_MS = 1000;
export const LAG_WINDOW_SAMPLES = 60;
/** An outbound call older than this is logged once. The client's own deadline is 30 s. */
export const OUTBOUND_SLOW_MS = 20_000;
/** A job's log reader this far behind its last successful read is reported. */
export const LOG_LAG_WARN_MS = 20_000;
export const HEARTBEAT_MS = 60_000;

export interface LagStats {
  samples: number;
  p50: number;
  p99: number;
  max: number;
}

export function lagStats(samples: readonly number[]): LagStats {
  if (samples.length === 0) return { samples: 0, p50: 0, p99: 0, max: 0 };
  const s = samples.toSorted((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
  return { samples: s.length, p50: at(0.5), p99: at(0.99), max: s[s.length - 1] as number };
}

export interface LogReaderLag {
  attemptId: string;
  lagMs: number;
}

export interface HealthSnapshot {
  running: boolean;
  startedAt: number | null;
  uptimeMs: number;
  loop: LagStats & { windowSeconds: number; lastOverAt: number | null };
  outbound: WatchdogSnapshot;
  logReaders: { tracking: number; maxLagMs: number; lagging: LogReaderLag[] };
}

export interface MonitorOptions {
  log?: (line: string) => void;
  now?: () => number;
  /** Test hook: the sample period. Default one second. */
  sampleMs?: number;
  heartbeatMs?: number;
}

/** Process-wide runtime health. One instance, `runtimeHealth`; tests make their own. */
export class RuntimeHealth {
  #samples: number[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #startedAt: number | null = null;
  #lastOverAt: number | null = null;
  #readers = new Map<string, number>(); // attempt id -> last successful read
  #now: () => number = Date.now;
  #log: (line: string) => void = (l) => console.log(l);
  #lastTick = 0;
  #sampleMs = LAG_SAMPLE_MS;
  #lastBeat = 0;
  #heartbeatMs = HEARTBEAT_MS;

  get running(): boolean {
    return this.#timer !== undefined;
  }

  start(o: MonitorOptions = {}): void {
    if (this.#timer) return;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? ((l) => console.log(`[turntable] ${l}`));
    this.#sampleMs = o.sampleMs ?? LAG_SAMPLE_MS;
    this.#heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
    this.#startedAt = this.#now();
    this.#lastTick = this.#startedAt;
    this.#lastBeat = this.#startedAt;
    this.#samples = [];
    this.#timer = setInterval(() => this.tick(), this.#sampleMs);
    // The monitor never keeps the process alive.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One sample: how late this tick ran. Public so a test can drive it. */
  tick(): void {
    const now = this.#now();
    const lag = Math.max(0, now - this.#lastTick - this.#sampleMs);
    this.#lastTick = now;
    this.#samples.push(lag);
    if (this.#samples.length > LAG_WINDOW_SAMPLES) this.#samples.shift();
    try {
      if (lag > LAG_WARN_MS) {
        this.#lastOverAt = now;
        const s = lagStats(this.#samples);
        this.#log(
          `event loop lag ${Math.round(lag)} ms (last ${s.samples} s: p50 ${Math.round(s.p50)}, p99 ${Math.round(s.p99)}, max ${Math.round(s.max)} ms)`,
        );
      }
      for (const c of outboundWatchdog.takeSlow(OUTBOUND_SLOW_MS, now)) {
        this.#log(
          `outbound call to ${c.host} (${c.op}) still open after ${Math.round((now - c.startedAt) / 1000)} s`,
        );
      }
      if (now - this.#lastBeat >= this.#heartbeatMs) {
        this.#lastBeat = now;
        this.#log(this.heartbeatLine());
      }
    } catch {
      // Monitoring must never take the process down.
    }
  }

  /** A reader is tracked from its first successful read (or the moment it is armed). */
  trackReader(attemptId: string): void {
    this.#readers.set(attemptId, this.#now());
  }
  readerOk(attemptId: string): void {
    if (this.#readers.has(attemptId)) this.#readers.set(attemptId, this.#now());
  }
  untrackReader(attemptId: string): void {
    this.#readers.delete(attemptId);
  }

  snapshot(): HealthSnapshot {
    const now = this.#now();
    const lagging: LogReaderLag[] = [];
    let max = 0;
    for (const [attemptId, last] of this.#readers) {
      const lagMs = Math.max(0, now - last);
      max = Math.max(max, lagMs);
      if (lagMs > LOG_LAG_WARN_MS) lagging.push({ attemptId, lagMs });
    }
    return {
      running: this.running,
      startedAt: this.#startedAt,
      uptimeMs: this.#startedAt === null ? 0 : now - this.#startedAt,
      loop: {
        ...lagStats(this.#samples),
        windowSeconds: LAG_WINDOW_SAMPLES,
        lastOverAt: this.#lastOverAt,
      },
      outbound: outboundWatchdog.snapshot(now),
      logReaders: { tracking: this.#readers.size, maxLagMs: max, lagging },
    };
  }

  heartbeatLine(): string {
    const s = this.snapshot();
    const o = s.outbound;
    return (
      `heartbeat: up ${Math.round(s.uptimeMs / 1000)} s, loop lag p99 ${Math.round(s.loop.p99)} ms max ${Math.round(s.loop.max)} ms, ` +
      `outbound ${o.inFlight} open${o.oldest ? ` (oldest ${Math.round(o.oldest.ageMs / 1000)} s, ${o.oldest.host})` : ""}, ` +
      `log readers ${s.logReaders.tracking} (max lag ${Math.round(s.logReaders.maxLagMs / 1000)} s), ` +
      `rss ${Math.round(process.memoryUsage().rss / 1048576)} MiB`
    );
  }
}

export const runtimeHealth = new RuntimeHealth();
