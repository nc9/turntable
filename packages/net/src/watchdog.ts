// Outbound-call watchdog (#693). Every request the control plane makes through the one client is
// registered here while it is in flight, so a hung call shows up: how many calls are open per
// host, how old the oldest is, and a one-time log line for a call that has outlived a threshold.
// The client's own deadline still ends the call; this only makes the wait visible.
//
// What it records: the host, the method and a coarse path (identifier-like segments are
// replaced). Never the query, a header or a body.

export interface InFlightCall {
  id: number;
  host: string;
  /** For example `GET /repos/:x/:x/pulls`. No query string. */
  op: string;
  startedAt: number;
  /** Whether the slow-call line was already written for this call. */
  reported: boolean;
}

export interface WatchdogSnapshot {
  inFlight: number;
  /** Open calls per host. */
  byHost: Record<string, number>;
  /** The oldest open call, when there is one. */
  oldest: { host: string; op: string; ageMs: number } | null;
  /** Calls that ended by timeout since start, per host. */
  timeouts: Record<string, number>;
  /** Calls reported as slow since start. */
  slowReported: number;
}

/** Path words of the APIs the control plane calls. Anything else (a repo, an id) is dropped. */
const KNOWN = new Set(
  (
    "api v1 v2 v3 repos orgs user users app installations installation access_tokens hook config " +
    "git refs commits pulls branches tags contents releases assets actions runs jobs check-runs " +
    "check-suites statuses sandbox sandboxes toolbox process files exec snapshots token oauth " +
    "login device access_token app-manifests conversions rate_limit meta tarball zipball issues " +
    "comments search logs artifacts"
  ).split(" "),
);

/** Keeps the shape of a path and drops anything that could be an identifier. */
export function coarsePath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const out = parts.slice(0, 5).map((s) => (KNOWN.has(s) ? s : ":x"));
  return `/${out.join("/")}${parts.length > 5 ? "/..." : ""}`;
}

export class OutboundWatchdog {
  readonly #calls = new Map<number, InFlightCall>();
  readonly #timeouts = new Map<string, number>();
  #next = 1;
  #slow = 0;

  /** Registers a call; the returned function ends it (call it once, in a finally). */
  begin(host: string, op: string, now: number = Date.now()): (timedOut?: boolean) => void {
    const id = this.#next++;
    this.#calls.set(id, { id, host, op, startedAt: now, reported: false });
    return (timedOut = false) => {
      if (!this.#calls.delete(id)) return;
      if (timedOut) this.#timeouts.set(host, (this.#timeouts.get(host) ?? 0) + 1);
    };
  }

  snapshot(now: number = Date.now()): WatchdogSnapshot {
    const byHost: Record<string, number> = {};
    let oldest: InFlightCall | undefined;
    for (const c of this.#calls.values()) {
      byHost[c.host] = (byHost[c.host] ?? 0) + 1;
      if (!oldest || c.startedAt < oldest.startedAt) oldest = c;
    }
    return {
      inFlight: this.#calls.size,
      byHost,
      oldest: oldest
        ? { host: oldest.host, op: oldest.op, ageMs: Math.max(0, now - oldest.startedAt) }
        : null,
      timeouts: Object.fromEntries(this.#timeouts),
      slowReported: this.#slow,
    };
  }

  /**
   * Calls older than `thresholdMs`, each returned once (and marked), for the caller to log.
   * Run it on a timer.
   */
  takeSlow(thresholdMs: number, now: number = Date.now()): InFlightCall[] {
    const out: InFlightCall[] = [];
    for (const c of this.#calls.values()) {
      if (!c.reported && now - c.startedAt > thresholdMs) {
        c.reported = true;
        this.#slow += 1;
        out.push({ ...c });
      }
    }
    return out;
  }

  /** For tests. */
  reset(): void {
    this.#calls.clear();
    this.#timeouts.clear();
    this.#slow = 0;
  }
}

/** The process-wide watchdog every client reports to. */
export const outboundWatchdog = new OutboundWatchdog();
