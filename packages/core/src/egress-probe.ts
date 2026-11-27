// Interim egress diagnostics (#693, #698): tell a DNS failure from a TCP or TLS failure when the
// server loses outbound network. Off unless TURNTABLE_EGRESS_PROBE_SECONDS is set. Every period it
// resolves each host and sends one unauthenticated HEAD to it, then logs the failures and slow
// calls (with the error code and timings), plus one OK line every ten minutes. It never sends a
// credential, and it logs host names only, never a path or a query. The default hosts are the
// GitHub web host and the Daytona API host: never api.github.com for the HEAD, whose anonymous
// requests count against the same per-IP REST budget the anonymous poller uses. api.github.com
// gets a DNS lookup only.
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { safeFetch } from "@turntable/net";
import { errorCode, withDeadline } from "./network/probe";

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SLOW_MS = 2_000;
const TIMEOUT_MS = 10_000;
const OK_EVERY_MS = 600_000;

export interface EgressProbeConfig {
  periodSeconds: number;
  /** DNS lookup plus one HEAD each. */
  hosts: string[];
  /** DNS lookup only. */
  dnsOnly: string[];
}

export const DEFAULT_PROBE_HOSTS = ["github.com", "app.daytona.io"];
export const DNS_ONLY_HOSTS = ["api.github.com"];

/** The probe's settings from the environment, or undefined when it is off. Bad values throw. */
export function egressProbeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): EgressProbeConfig | undefined {
  const raw = env.TURNTABLE_EGRESS_PROBE_SECONDS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 10 || n > 3600)
    throw new Error("TURNTABLE_EGRESS_PROBE_SECONDS must be a whole number from 10 to 3600");
  const hosts = (env.TURNTABLE_EGRESS_PROBE_HOSTS?.trim() || DEFAULT_PROBE_HOSTS.join(","))
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  if (hosts.length === 0 || hosts.length > 5 || !hosts.every((h) => HOST.test(h)))
    throw new Error("TURNTABLE_EGRESS_PROBE_HOSTS must be 1 to 5 comma-separated host names");
  if (hosts.includes("api.github.com"))
    throw new Error(
      "TURNTABLE_EGRESS_PROBE_HOSTS may not include api.github.com: its anonymous requests use the poller's REST budget",
    );
  return { periodSeconds: n, hosts, dnsOnly: DNS_ONLY_HOSTS };
}

// One implementation for both probes: the degraded-state probe lives in ./network.
export { errorCode } from "./network/probe";

export type ProbeResult = {
  host: string;
  dnsMs: number;
  dnsError?: string;
  headMs?: number;
  headError?: string;
  status?: number;
};

export interface ProbeDeps {
  resolve?: (host: string) => Promise<unknown>;
  head?: (url: string, signal: AbortSignal) => Promise<{ status: number }>;
  now?: () => number;
}

/** One probe of one host: DNS, then (when it resolved) an unauthenticated HEAD over https. */
export async function probeHost(
  host: string,
  d: ProbeDeps = {},
  dnsOnly = false,
): Promise<ProbeResult> {
  const now = d.now ?? Date.now;
  const resolve = d.resolve ?? ((h: string) => lookup(h));
  // Through the one outbound client (address validation, pinned resolution, caps), never fetch.
  const head =
    d.head ??
    ((url: string, signal: AbortSignal) =>
      safeFetch(url, { method: "HEAD", signal, redirect: "manual", timeoutMs: TIMEOUT_MS }));
  const t0 = now();
  try {
    await withDeadline(Promise.resolve(resolve(host)), TIMEOUT_MS);
  } catch (e) {
    return { host, dnsMs: now() - t0, dnsError: errorCode(e) };
  }
  const dnsMs = now() - t0;
  if (dnsOnly) return { host, dnsMs };
  const t1 = now();
  try {
    const r = await head(`https://${host}/`, AbortSignal.timeout(TIMEOUT_MS));
    return { host, dnsMs, headMs: now() - t1, status: r.status };
  } catch (e) {
    return { host, dnsMs, headMs: now() - t1, headError: errorCode(e) };
  }
}

/** The log line for a result, and whether it is a failure or a slow call. */
export function describe(r: ProbeResult): { line: string; bad: boolean } {
  const bad =
    r.dnsError !== undefined ||
    r.headError !== undefined ||
    r.dnsMs > SLOW_MS ||
    (r.headMs ?? 0) > SLOW_MS;
  const parts = [`egress probe ${r.host}: dns ${r.dnsMs}ms`];
  if (r.dnsError) parts.push(`dns failed ${r.dnsError}`);
  if (r.headMs !== undefined) parts.push(`head ${r.headMs}ms`);
  if (r.headError) parts.push(`head failed ${r.headError}`);
  if (r.status !== undefined) parts.push(`status ${r.status}`);
  return { line: parts.join(", "), bad };
}

/**
 * The resolver configuration lines of /etc/resolv.conf (nameserver, search, options), joined, or
 * undefined where there is none. Logged once when the probe starts (#693): which resolver the
 * container uses and with which timeout and attempts. Addresses only; no secrets live there.
 */
export function resolverConfig(text?: string): string | undefined {
  let t = text;
  if (t === undefined) {
    try {
      t = readFileSync("/etc/resolv.conf", "utf8");
    } catch {
      return undefined;
    }
  }
  const keep = t
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(nameserver|search|domain|options)\s/.test(l))
    .map((l) => l.replace(/[^\x20-\x7e]/g, "").slice(0, 200))
    .slice(0, 12);
  return keep.length > 0 ? keep.join("; ") : undefined;
}

/** Starts the probe loop. Returns a stop function. Overlapping probes are skipped, not stacked. */
export function startEgressProbe(
  cfg: EgressProbeConfig,
  log: (m: string) => void,
  d: ProbeDeps = {},
): () => void {
  const now = d.now ?? Date.now;
  log(`egress probe resolver: ${resolverConfig() ?? "no /etc/resolv.conf"}`);
  let busy = false;
  let lastOk = 0;
  const tick = async (): Promise<void> => {
    if (busy) {
      log("egress probe: previous probe still running, skipped");
      return;
    }
    busy = true;
    try {
      const results = await Promise.all([
        ...cfg.hosts.map((h) => probeHost(h, d)),
        ...cfg.dnsOnly.map((h) => probeHost(h, d, true)),
      ]);
      const okTime = now() - lastOk >= OK_EVERY_MS;
      for (const r of results) {
        const { line, bad } = describe(r);
        if (bad || okTime) log(bad ? line : `${line} (ok)`);
      }
      if (okTime) lastOk = now();
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick().catch(() => {}), cfg.periodSeconds * 1000);
  timer.unref?.();
  void tick().catch(() => {});
  return () => clearInterval(timer);
}
