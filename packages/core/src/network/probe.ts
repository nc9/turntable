import { lookup } from "node:dns/promises";
import { safeFetch, type SafeFetch } from "@turntable/net";
import type { NetworkProbe, ProbeResult, TargetResult } from "./health";

export type ProbeTarget = {
  /** A fixed label that appears in doctor and the admin page. Never a URL. */
  label: string;
  /** The URL to GET. Only its host is resolved; it is never reported. */
  url: string;
};

/** A target probed by its own call (the sandbox provider's API), timed as one step. */
export type ProbeCheck = { label: string; run: () => Promise<void> };

export type EgressProbeOptions = {
  targets: readonly ProbeTarget[];
  /** Read at each probe, so a provider wired later is included. */
  checks?: () => readonly ProbeCheck[];
  timeoutMs?: number;
  fetch?: SafeFetch;
  lookup?: (host: string) => Promise<unknown>;
};

/** The error code of a failed call: the error's own, or its cause's (fetch wraps the system error). */
export function errorCode(e: unknown): string {
  const pick = (x: unknown): string | undefined => {
    if (typeof x !== "object" || x === null) return undefined;
    const o = x as { code?: unknown };
    if (typeof o.code === "string" && /^[A-Z0-9_]{1,40}$/.test(o.code)) return o.code;
    return undefined;
  };
  const cause = typeof e === "object" && e !== null ? (e as { cause?: unknown }).cause : undefined;
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  return pick(e) ?? pick(cause) ?? (typeof name === "string" ? name.slice(0, 40) : "Error");
}

/** Races a call against a deadline; a call that never settles rejects with code `TIMEOUT`. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const codeOf = errorCode;

/**
 * A cheap egress probe: for each target, a DNS lookup then a GET (the forge target is `GET /rate_limit`, which GitHub does not count against the limit). Any HTTP answer counts as
 * reachable (a 401 from an API is still a working network). A target failing alone is that
 * service's outage, not ours, so the probe fails only when EVERY target failed: a lost network
 * takes all of them.
 */
export function egressProbe(o: EgressProbeOptions): NetworkProbe {
  const timeoutMs = o.timeoutMs ?? 5_000;
  const doFetch = o.fetch ?? safeFetch;
  const resolve = o.lookup ?? ((h: string) => lookup(h));
  return async (): Promise<ProbeResult> => {
    const targets = await Promise.all(
      o.targets.map(async (t): Promise<TargetResult> => {
        const t0 = performance.now();
        try {
          await withDeadline(Promise.resolve(resolve(new URL(t.url).hostname)), timeoutMs);
        } catch (err) {
          return { target: t.label, ok: false, error: codeOf(err) };
        }
        const t1 = performance.now();
        try {
          const res = await withDeadline(
            Promise.resolve(
              doFetch(t.url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) }),
            ),
            timeoutMs,
          );
          void (res as { body?: { cancel?: () => Promise<void> } } | undefined)?.body
            ?.cancel?.()
            .catch(() => {});
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
          await withDeadline(c.run(), timeoutMs * 2);
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
