// CD's wait for the public deploy gate (GET /api/v1/deploy-gate): a deploy restarts the instance,
// so it waits while a release is in flight. The gate answers one bit and a fixed reason, so this
// script never learns what is running. After the timeout the run fails and pages.
export interface GateDeps {
  fetch(url: string): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface GateOptions {
  baseUrl: string;
  /** Default 6 hours. */
  timeoutMs?: number;
  /** Default 30 seconds. */
  pollMs?: number;
}

export const GATE_TIMEOUT_MS = 6 * 60 * 60_000;
/** The page text when the wait runs out. */
export const GATE_TIMEOUT_MESSAGE = "deploy waited 6 h for a release to finish";

export type GateResult =
  { ok: true; waitedMs: number } | { ok: false; page: true; reason: string; waitedMs: number };

export async function waitForGate(deps: GateDeps, opts: GateOptions): Promise<GateResult> {
  const started = deps.now();
  const timeoutMs = opts.timeoutMs ?? GATE_TIMEOUT_MS;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/deploy-gate`;
  for (;;) {
    try {
      const res = await deps.fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { safe?: unknown };
        // Only an explicit `true` opens the gate; anything else (a malformed body too) waits.
        if (body.safe === true) return { ok: true, waitedMs: deps.now() - started };
      }
    } catch {
      // Unreachable or unreadable: the answer is unknown, so keep waiting.
    }
    if (deps.now() - started >= timeoutMs) {
      const reason =
        timeoutMs === GATE_TIMEOUT_MS
          ? GATE_TIMEOUT_MESSAGE
          : `deploy waited ${Math.round(timeoutMs / 3_600_000)} h for a release to finish`;
      return { ok: false, page: true, reason, waitedMs: deps.now() - started };
    }
    await deps.sleep(opts.pollMs ?? 30_000);
  }
}
