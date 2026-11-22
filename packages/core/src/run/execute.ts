import {
  runJob,
  type ActTarball,
  type ActionFetcher,
  type ActEvent,
  type JobPlan,
} from "@turntable/act-runner";
import type { Provider } from "@turntable/provider-sdk";
import { Redactor, SecretRegistry, redactString } from "@turntable/redact";
import { renderEvent, stepLabel } from "./render";
import type { StepRecord } from "./store";

/** Where an execution writes what it produces. The CLI and the worker each supply their own. */
export interface ExecIo {
  /** Records the sandbox as soon as it exists, so a restarted controller can find it. */
  setSandbox(sandboxId: string): Promise<void>;
  appendLog(offset: number, bytes: Uint8Array): Promise<void>;
  recordStep(step: StepRecord): Promise<void>;
}

export interface ExecuteOptions {
  provider: Provider;
  /** A planned job with its actions resolved (see planJob and resolveActions). */
  plan: JobPlan;
  ids: { runId: string; jobId: string; attemptId: string };
  io: ExecIo;
  repoTarball: Uint8Array;
  image: string;
  /** Sink for the (redacted) log text, for example the terminal. Default: discard. */
  out?: (text: string) => void;
  /** `none` (default) gives the sandbox no network. `open` is an explicit opt-in. */
  egress?: "none" | "open";
  /** Secrets to redact everywhere: log text, step names, error text. */
  registry?: SecretRegistry;
  /** Aborting cancels: the sandbox is destroyed and the result is cancelled. */
  signal?: AbortSignal;
  /** Idle flush interval for the redactor's held partial line. Default 1000 ms. */
  idleFlushMs?: number;
  // Test seams.
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  pollMs?: number;
  timeoutSeconds?: number;
}

export interface ExecuteResult {
  state: "success" | "failure" | "skipped" | "infra_error" | "cancelled";
  /** Redacted. */
  reason: string;
  /** act's exit code, when it ran to the end. */
  code?: number;
}

const enc = new TextEncoder();

/**
 * Runs one planned job in a fresh sandbox and returns how it ended. It creates no run, job or
 * attempt rows and records no outcome: the caller does, so the CLI and the scheduler's worker
 * share this one code path. Log text is redacted before it is shown or stored. The sandbox is
 * always destroyed.
 */
export async function executeJob(o: ExecuteOptions): Promise<ExecuteResult> {
  const { ids, plan } = o;
  const out = o.out ?? (() => {});
  // One registry for everything act-derived that we show or store.
  const registry = o.registry ?? new SecretRegistry();
  const clean = (text: string): string => redactString(text, registry);

  const log = new LogPipe(o, registry, out);
  const idle = setInterval(() => log.idleFlush(o.idleFlushMs ?? 1000), 250);

  const steps = new Map<string, StepRecord>();
  const onAct = (e: ActEvent): void => {
    if (e.type === "step-start") {
      const rec: StepRecord = {
        stepKey: e.stepKey,
        stage: e.stage,
        index: steps.size,
        name: clean(stepLabel(e.name, e.stage)),
        startedAt: Date.now(),
        logOffset: log.stored,
      };
      steps.set(`${e.stepKey}\0${e.stage}`, rec);
      log.chain(() => o.io.recordStep({ ...rec }));
    } else if (e.type === "step-end") {
      const rec = steps.get(`${e.stepKey}\0${e.stage}`);
      if (rec) {
        rec.result = e.result;
        rec.endedAt = Date.now();
        if (e.durationMs !== undefined) rec.durationMs = e.durationMs;
        log.chain(() => o.io.recordStep({ ...rec }));
      }
    }
    log.push(renderEvent(e));
  };

  const settle = async (
    state: ExecuteResult["state"],
    reason: string,
    code?: number,
  ): Promise<ExecuteResult> => {
    clearInterval(idle);
    await log.close();
    return { state, reason: clean(reason), ...(code === undefined ? {} : { code }) };
  };

  let sandboxId: string | undefined;
  let cancelled = o.signal?.aborted ?? false;
  const aborted = new Promise<"abort">((resolve) => {
    if (cancelled) resolve("abort");
    o.signal?.addEventListener("abort", () => {
      cancelled = true;
      resolve("abort");
    });
  });
  try {
    if (cancelled) return await settle("cancelled", "cancelled by user");
    const sb = await o.provider.create({
      name: `tt-run-${ids.attemptId.toLowerCase()}`,
      labels: { "turntable.run": ids.runId, "turntable.job": ids.jobId },
      image: o.image,
      ttlSeconds: (o.timeoutSeconds ?? 3600) + 900,
      // TODO(#16): egress none works for host-mode jobs with sha-delivered actions (proved in
      // the act-runner e2e), so local runs get no network.
      network: { egress: o.egress ?? "none" },
    });
    sandboxId = sb.id;
    await o.io.setSandbox(sb.id);
    const run = runJob(
      o.provider,
      sb.id,
      plan,
      {
        repoTarball: o.repoTarball,
        ...(o.act ? { act: o.act } : {}),
        ...(o.fetchAction ? { fetchAction: o.fetchAction } : {}),
      },
      {
        pollMs: o.pollMs ?? 500,
        ...(o.timeoutSeconds ? { timeoutSeconds: o.timeoutSeconds } : {}),
      },
    );
    for (;;) {
      const next = await Promise.race([run.next(), aborted]);
      if (next === "abort") {
        void run.return({ state: "infra_error", reason: "cancelled" });
        return await settle("cancelled", "cancelled by user");
      }
      if (next.done) {
        const r = next.value;
        return await settle(r.state, r.reason, r.exitCode);
      }
      if (next.value.kind === "act") onAct(next.value.event);
    }
  } catch (e) {
    if (cancelled) return await settle("cancelled", "cancelled by user");
    return await settle("infra_error", e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(idle);
    if (sandboxId) {
      try {
        await o.provider.destroy(sandboxId);
      } catch (e) {
        out(`warning: could not destroy sandbox ${sandboxId}: ${String(e)}\n`);
      }
    }
  }
}

/** Redacts text, shows it, and stores it in order with byte offsets (offsets of what is stored). */
class LogPipe {
  stored = 0;
  readonly #redactor: Redactor;
  readonly #io: ExecIo;
  readonly #out: (text: string) => void;
  #lastPush = Date.now();
  #writes: Promise<void> = Promise.resolve();

  constructor(o: ExecuteOptions, registry: SecretRegistry, out: (text: string) => void) {
    this.#redactor = new Redactor({ registry });
    this.#io = o.io;
    this.#out = out;
  }

  push(text: string): void {
    this.#lastPush = Date.now();
    this.#emit(this.#redactor.push(text));
  }

  idleFlush(afterMs: number): void {
    if (Date.now() - this.#lastPush >= afterMs) this.#emit(this.#redactor.flushIdle());
  }

  chain(fn: () => Promise<void>): void {
    this.#writes = this.#writes.then(fn);
  }

  /** Flushes the held tail and waits for every pending write. */
  async close(): Promise<void> {
    this.#emit(this.#redactor.end());
    await this.#writes;
  }

  #emit(text: string): void {
    if (text === "") return;
    this.#out(text);
    const bytes = enc.encode(text);
    const at = this.stored;
    this.stored += bytes.length;
    this.chain(() => this.#io.appendLog(at, bytes));
  }
}
