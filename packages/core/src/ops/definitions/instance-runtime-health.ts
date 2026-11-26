import { z } from "zod";
import { runtimeHealth } from "../../health/monitor";
import { iso } from "../common";
import { defineOp } from "../define";

export const instanceRuntimeHealthOp = defineOp({
  name: "instance_runtime_health",
  summary:
    "Event-loop lag, open outbound calls and log reader lag, for the instance administrator.",
  description:
    "Reports the health of the server process answering the call: event-loop lag over the last " +
    "minute (p50, p99 and max in milliseconds, sampled every second), the outbound calls open now " +
    "per host with the oldest one's host, operation and age (no URL query, no header), how many " +
    "calls ended by timeout per host, and the lag of each running job's log reader (now minus its " +
    "last successful read). It carries no secret. A stall with idle CPU is usually a hung " +
    "outbound call. Only the instance administrator can call it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: z.object({
    running: z.boolean().describe("Whether the monitor runs in this process."),
    uptime_seconds: z.int(),
    event_loop: z.object({
      samples: z.int(),
      window_seconds: z.int(),
      p50_ms: z.number(),
      p99_ms: z.number(),
      max_ms: z.number(),
      last_over_1s_at: z.string().nullable(),
    }),
    outbound: z.object({
      in_flight: z.int(),
      by_host: z.array(z.object({ host: z.string(), count: z.int() })),
      oldest: z.object({ host: z.string(), operation: z.string(), age_ms: z.int() }).nullable(),
      timeouts_by_host: z.array(z.object({ host: z.string(), count: z.int() })),
      slow_reported: z.int(),
    }),
    log_readers: z.object({
      tracking: z.int(),
      max_lag_ms: z.int(),
      lagging: z.array(z.object({ attempt_id: z.string(), lag_ms: z.int() })),
    }),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/runtime-health" },
  mcp: false,
  async handler() {
    const s = runtimeHealth.snapshot();
    const rows = (m: Record<string, number>): { host: string; count: number }[] =>
      Object.entries(m).map(([host, count]) => ({ host, count }));
    return {
      running: s.running,
      uptime_seconds: Math.round(s.uptimeMs / 1000),
      event_loop: {
        samples: s.loop.samples,
        window_seconds: s.loop.windowSeconds,
        p50_ms: Math.round(s.loop.p50),
        p99_ms: Math.round(s.loop.p99),
        max_ms: Math.round(s.loop.max),
        last_over_1s_at: iso(s.loop.lastOverAt),
      },
      outbound: {
        in_flight: s.outbound.inFlight,
        by_host: rows(s.outbound.byHost),
        oldest: s.outbound.oldest
          ? {
              host: s.outbound.oldest.host,
              operation: s.outbound.oldest.op,
              age_ms: Math.round(s.outbound.oldest.ageMs),
            }
          : null,
        timeouts_by_host: rows(s.outbound.timeouts),
        slow_reported: s.outbound.slowReported,
      },
      log_readers: {
        tracking: s.logReaders.tracking,
        max_lag_ms: Math.round(s.logReaders.maxLagMs),
        lagging: s.logReaders.lagging.map((l) => ({
          attempt_id: l.attemptId,
          lag_ms: Math.round(l.lagMs),
        })),
      },
    };
  },
});
