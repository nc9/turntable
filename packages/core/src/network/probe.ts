import { lookup } from "node:dns/promises";
import type { NetworkProbe, ProbeResult, TargetResult } from "./health";

export type ProbeTarget = {
  /** A fixed label that appears in doctor and the admin page. Never a URL. */
  label: string;
  /** The URL to HEAD. Only its host is resolved; it is never reported. */
  url: string;
};

/** A target probed by its own call (the sandbox provider's API), timed as one step. */
export type ProbeCheck = { label: string; run: () => Promise<void> };

export type EgressProbeOptions = {
  targets: readonly ProbeTarget[];
  /** Read at each probe, so a provider wired later is included. */
  checks?: () => readonly ProbeCheck[];
  timeoutMs?: number;
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<unknown>;
};

const codeOf = (err: unknown): string => {
  const e = err as { code?: unknown; name?: unknown } | null;
  if (typeof e?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(e.code)) return e.code;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout";
  return "error";
};

/**
 * A cheap egress probe: for each target, a DNS lookup then a HEAD. Any HTTP answer counts as
 * reachable (a 401 from an API is still a working network). A target failing alone is that
 * service's outage, not ours, so the probe fails only when EVERY target failed: a lost network
 * takes all of them.
 */
export function egressProbe(o: EgressProbeOptions): NetworkProbe {
  const timeoutMs = o.timeoutMs ?? 5_000;
  const doFetch = o.fetch ?? fetch;
  const resolve = o.lookup ?? ((h: string) => lookup(h));
  return async (): Promise<ProbeResult> => {
    const targets = await Promise.all(
      o.targets.map(async (t): Promise<TargetResult> => {
        const t0 = performance.now();
        try {
          await resolve(new URL(t.url).hostname);
        } catch (err) {
          return { target: t.label, ok: false, error: codeOf(err) };
        }
        const t1 = performance.now();
        try {
          await doFetch(t.url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
          return {
            target: t.label,
            ok: true,
            dnsMs: Math.round(t1 - t0),
            httpMs: Math.round(performance.now() - t1),
          };
        } catch (err) {
          return {
            target: t.label,
            ok: false,
            dnsMs: Math.round(t1 - t0),
            error: codeOf(err),
          };
        }
      }),
    );
    const extra = await Promise.all(
      (o.checks?.() ?? []).map(async (c): Promise<TargetResult> => {
        const t0 = performance.now();
        try {
          await Promise.race([
            c.run(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
                timeoutMs * 2,
              ).unref?.(),
            ),
          ]);
          return { target: c.label, ok: true, httpMs: Math.round(performance.now() - t0) };
        } catch (err) {
          return { target: c.label, ok: false, error: codeOf(err) };
        }
      }),
    );
    const all = [...targets, ...extra];
    return { ok: all.length === 0 || all.some((t) => t.ok), targets: all };
  };
}
