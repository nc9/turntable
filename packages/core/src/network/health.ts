// Egress health (#698). A hosted instance can lose its outbound network for minutes with the
// process alive and idle. A cheap probe runs every 15 s; two failures in a row mean `degraded`, two
// successes mean healthy again. While degraded the scheduler claims nothing, a failure that
// happened before any sandbox existed is requeued instead of finished, and check posts wait for
// recovery. The state lives in this process only (like the drain flag): a restart boots healthy and
// the first probes decide again. Nothing here carries a secret: a probe records a target label, a
// timing and a short error code, never a URL with credentials or a response body.

/** One target's result in a probe: DNS time, HTTP time and an error code when it failed. */
export type TargetResult = {
  /** A fixed label such as `forge` or `provider`, never a URL. */
  target: string;
  ok: boolean;
  dnsMs?: number;
  httpMs?: number;
  /** A short code such as `ENOTFOUND`, `timeout` or `http_error`. */
  error?: string;
};

export type ProbeResult = { ok: boolean; targets: TargetResult[] };

/** Runs one probe. Must not throw: a throw counts as a failed probe. */
export type NetworkProbe = () => Promise<ProbeResult>;

export type NetworkWindow = {
  /** When the instance entered degraded (epoch ms). */
  start: number;
  /** When it recovered, or null while still degraded. */
  end: number | null;
};

export type NetworkSnapshot = {
  /** `unknown` until a probe has run (a process that does not run the probe never says healthy). */
  state: "healthy" | "degraded" | "unknown";
  /** When the current state began (epoch ms), or null if it never changed since boot. */
  since: number | null;
  /** Consecutive failed probes (0 when the last one passed). */
  consecutive_failures: number;
  last_probe_at: number | null;
  last_probe: ProbeResult | null;
  /** True when the open degraded window passed its maximum and claims resumed regardless. */
  gave_up: boolean;
  /** The most recent degraded windows, oldest first, including the open one. */
  windows: NetworkWindow[];
};

export type NetworkHealthOptions = {
  probe?: NetworkProbe | undefined;
  now?: () => number;
  /** Failures in a row that enter degraded. Default 2. */
  failures?: number;
  /** Successes in a row that leave degraded. Default 2. */
  successes?: number;
  /** Probe interval. Default 15 s. */
  intervalMs?: number;
  /** Degraded windows kept. Default 20. */
  maxWindows?: number;
  /**
   * Longest a degraded window may hold claims (ms). Past it claims resume, with `gave_up` set,
   * whatever the probe says: the probe itself can never hold the queue for good. Default 15 min.
   */
  maxDegradedMs?: number;
  /** Whole-probe deadline (ms). Default 20 s. */
  probeDeadlineMs?: number;
  /** Told once when a window passes `maxDegradedMs`. A throw is swallowed. */
  onGiveUp?: (snapshot: NetworkSnapshot) => void;
  /** Told on every state change. A throw is swallowed. */
  onChange?: (state: "healthy" | "degraded", snapshot: NetworkSnapshot) => void;
};

export const PROBE_INTERVAL_MS = 15_000;
export const PROBE_DEADLINE_MS = 20_000;
export const MAX_DEGRADED_MS = 15 * 60_000;

export class NetworkHealth {
  #probe: NetworkProbe | undefined;
  #now: () => number;
  readonly #failures: number;
  readonly #successes: number;
  readonly #intervalMs: number;
  readonly #maxWindows: number;
  #maxDegradedMs: number;
  readonly #probeDeadlineMs: number;
  #onGiveUp: NetworkHealthOptions["onGiveUp"];
  #gaveUp = false;
  #onChange: NetworkHealthOptions["onChange"];
  #degraded = false;
  #since: number | null = null;
  #fails = 0;
  #oks = 0;
  #last: { at: number; result: ProbeResult } | null = null;
  #windows: NetworkWindow[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #waiters: (() => void)[] = [];

  constructor(o: NetworkHealthOptions = {}) {
    this.#probe = o.probe;
    this.#now = o.now ?? Date.now;
    this.#failures = o.failures ?? 2;
    this.#successes = o.successes ?? 2;
    this.#intervalMs = o.intervalMs ?? PROBE_INTERVAL_MS;
    this.#maxWindows = o.maxWindows ?? 20;
    this.#onChange = o.onChange;
    this.#maxDegradedMs = o.maxDegradedMs ?? MAX_DEGRADED_MS;
    this.#probeDeadlineMs = o.probeDeadlineMs ?? PROBE_DEADLINE_MS;
    this.#onGiveUp = o.onGiveUp;
  }

  /** Wires the probe and the state-change hook (boot). Without a probe the state stays healthy. */
  configure(
    o: Pick<NetworkHealthOptions, "probe" | "now" | "onChange" | "onGiveUp"> & {
      maxDegradedMs?: number;
    },
  ): void {
    if (o.probe) this.#probe = o.probe;
    if (o.onGiveUp) this.#onGiveUp = o.onGiveUp;
    if (o.maxDegradedMs !== undefined) this.#maxDegradedMs = o.maxDegradedMs;
    if (o.now) this.#now = o.now;
    if (o.onChange) this.#onChange = o.onChange;
  }

  /**
   * True while claims are held back. Never longer than `maxDegradedMs` after the window opened:
   * past that the probe's verdict is ignored for claims (doctor fails, a warning is logged).
   */
  get degraded(): boolean {
    if (!this.#degraded) return false;
    if (this.#gaveUp) return false;
    if (
      this.#maxDegradedMs > 0 &&
      this.#since !== null &&
      this.#now() - this.#since >= this.#maxDegradedMs
    ) {
      this.#gaveUp = true;
      const waiting = this.#waiters;
      this.#waiters = [];
      for (const w of waiting) w();
      try {
        this.#onGiveUp?.(this.snapshot());
      } catch {
        // A hook must not break the claim loop.
      }
      return false;
    }
    return true;
  }

  /** True when the last probe failed but the state is not degraded yet. */
  get suspect(): boolean {
    return !this.#degraded && this.#fails > 0;
  }

  /** Runs one probe now and applies it. Probes never overlap: a call during one joins it. */
  probeNow(): Promise<void> {
    if (!this.#probe) return Promise.resolve();
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Whole-probe deadline: a probe that never settles counts as failed and frees the slot. */
  #deadlineMs(): number {
    return this.#probeDeadlineMs;
  }

  async #run(): Promise<void> {
    let result: ProbeResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        (this.#probe as NetworkProbe)(),
        new Promise<ProbeResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                ok: false,
                targets: [{ target: "probe", ok: false, error: "timeout" }],
              }),
            this.#deadlineMs(),
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } catch {
      result = { ok: false, targets: [{ target: "probe", ok: false, error: "probe_threw" }] };
    } finally {
      clearTimeout(timer);
    }
    this.record(result);
  }

  /** Applies one probe result (also the seam for tests). */
  record(result: ProbeResult): void {
    const at = this.#now();
    this.#last = { at, result };
    if (result.ok) {
      this.#fails = 0;
      this.#oks++;
      if (this.#degraded && this.#oks >= this.#successes) this.#set(false, at);
    } else {
      this.#oks = 0;
      this.#fails++;
      if (!this.#degraded && this.#fails >= this.#failures) this.#set(true, at);
    }
  }

  #set(degraded: boolean, at: number): void {
    this.#degraded = degraded;
    this.#since = at;
    this.#gaveUp = false;
    if (degraded) {
      this.#windows.push({ start: at, end: null });
      if (this.#windows.length > this.#maxWindows) this.#windows.shift();
    } else {
      const open = this.#windows.findLast((w) => w.end === null);
      if (open) open.end = at;
      const waiting = this.#waiters;
      this.#waiters = [];
      for (const w of waiting) w();
    }
    try {
      this.#onChange?.(degraded ? "degraded" : "healthy", this.snapshot());
    } catch {
      // A hook must not break the probe loop.
    }
  }

  /** Starts the periodic probe. Idempotent; a no-op without a probe. */
  start(): void {
    if (this.#timer || !this.#probe) return;
    this.#timer = setInterval(() => void this.probeNow(), this.#intervalMs);
    // The probe must not keep a finished process alive.
    (this.#timer as { unref?: () => void }).unref?.();
    void this.probeNow();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Resolves at once when healthy, else when the network recovers or `maxMs` passes (a post that
   * waited that long goes on to its own retries).
   */
  waitHealthy(maxMs: number): Promise<void> {
    if (!this.degraded) return Promise.resolve();
    // Never past the point the window gives up: claims and posts resume together.
    const left =
      this.#maxDegradedMs > 0 && this.#since !== null
        ? Math.max(0, this.#since + this.#maxDegradedMs - this.#now())
        : maxMs;
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, Math.min(maxMs, left));
      (t as { unref?: () => void }).unref?.();
      const self = this;
      function done(): void {
        clearTimeout(t);
        self.#waiters = self.#waiters.filter((w) => w !== done);
        resolve();
      }
      this.#waiters.push(done);
    });
  }

  /**
   * The degraded windows that overlap `[from, to]`, each clipped to it: what a job that waited from
   * `from` (its failed attempt) to `to` (its new claim) waited through.
   */
  windowsBetween(from: number, to: number): NetworkWindow[] {
    return this.#windows
      .filter((w) => w.start <= to && (w.end ?? Infinity) >= from)
      .map((w) => ({ start: w.start, end: w.end }));
  }

  snapshot(): NetworkSnapshot {
    void this.degraded; // applies the give-up deadline
    return {
      gave_up: this.#gaveUp,
      state: this.#degraded ? "degraded" : this.#last ? "healthy" : "unknown",
      since: this.#since,
      consecutive_failures: this.#fails,
      last_probe_at: this.#last?.at ?? null,
      last_probe: this.#last?.result ?? null,
      windows: this.#windows.map((w) => ({ ...w })),
    };
  }

  /** Back to a fresh healthy state (tests, a fresh boot in one process). */
  reset(): void {
    this.stop();
    this.#degraded = false;
    this.#gaveUp = false;
    this.#since = null;
    this.#fails = 0;
    this.#oks = 0;
    this.#last = null;
    this.#windows = [];
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const w of waiting) w();
  }
}

/** The process's own network state: the scheduler, the reporter, doctor and the ops share it. */
export const processNetwork = new NetworkHealth();
