// Interim diagnostics (#693): did the event loop block, and for how long? A 1 s timer measures its
// own drift; a drift over the threshold means the loop could not run a timer, so something held it
// (synchronous I/O, a long synchronous computation). Each such stall is logged once with the open
// file-descriptor count and the soft open-files limit, so a stall can be told from fd exhaustion.
// Started with the egress probe (TURNTABLE_EGRESS_PROBE_SECONDS). Reads /proc only where it exists.
import { readdirSync, readFileSync } from "node:fs";

const TICK_MS = 1_000;
const STALL_MS = 1_000;

/** Open file descriptors of this process, or undefined without /proc. */
export function openFds(): number | undefined {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return undefined;
  }
}

/** The soft "Max open files" limit, or undefined without /proc. */
export function openFilesLimit(text?: string): number | undefined {
  let t = text;
  if (t === undefined) {
    try {
      t = readFileSync("/proc/self/limits", "utf8");
    } catch {
      return undefined;
    }
  }
  const m = /^Max open files\s+(\d+|unlimited)/m.exec(t);
  if (!m) return undefined;
  return m[1] === "unlimited" ? Number.POSITIVE_INFINITY : Number(m[1]);
}

/** The log line for one tick, or undefined when the loop was on time. */
export function stallLine(
  driftMs: number,
  fds: number | undefined,
  limit: number | undefined,
): string | undefined {
  if (driftMs <= STALL_MS) return undefined;
  const fdPart = fds === undefined ? "fds n/a" : `fds ${fds}/${limit ?? "?"}`;
  return `event loop stalled ${Math.round(driftMs)} ms (${fdPart})`;
}

/** Starts the monitor; returns a stop function. One summary line every ten minutes, too. */
export function startLoopLag(log: (m: string) => void, now: () => number = Date.now): () => void {
  const limit = openFilesLimit();
  let expected = now() + TICK_MS;
  let worst = 0;
  let lastSummary = now();
  const timer = setInterval(() => {
    const t = now();
    const drift = t - expected;
    expected = t + TICK_MS;
    worst = Math.max(worst, drift);
    const line = stallLine(drift, openFds(), limit);
    if (line) log(line);
    if (t - lastSummary >= 600_000) {
      const fds = openFds();
      log(
        `event loop: worst drift ${Math.round(worst)} ms in 10 min (fds ${fds ?? "n/a"}/${limit ?? "?"})`,
      );
      worst = 0;
      lastSummary = t;
    }
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
