import {
  planJob,
  resolveActions,
  runJob,
  type ActTarball,
  type ActionFetcher,
  type ActionRefResolver,
  type ActEvent,
} from "@turntable/act-runner";
import type { Provider } from "@turntable/provider-sdk";
import { Redactor } from "@turntable/redact";
import { renderEvent, stepLabel } from "./render";
import type { RunStore, StepRecord } from "./store";

/** Node 22 with bash, git and tar, which act host mode needs. Multi-arch index digest. */
export const DEFAULT_IMAGE =
  "node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb";

export interface RunLocalOptions {
  provider: Provider;
  providerName: string;
  store: RunStore;
  /** Workflow path relative to the repo root. */
  workflowPath: string;
  workflowYaml: string;
  job: string;
  event: string;
  ref: string;
  sha?: string;
  repoTarball: Uint8Array;
  image: string;
  /** Sink for the (redacted) log text, for example the terminal. */
  out: (text: string) => void;
  /** Reads repo files so local composite actions are scanned and pinned. */
  readFile?: (path: string) => string | undefined;
  resolver?: ActionRefResolver;
  /** Aborting cancels: the sandbox is destroyed and the attempt marked cancelled. */
  signal?: AbortSignal;
  /** Idle flush interval for the redactor's held partial line. Default 1000 ms. */
  idleFlushMs?: number;
  // Test seams.
  planRoot?: string;
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  pollMs?: number;
  timeoutSeconds?: number;
}

export interface RunLocalResult {
  state: "success" | "failure" | "skipped" | "infra_error" | "cancelled";
  /** Process exit code: 0 success or skipped, 1 failure, 2 infra_error, 130 cancelled. */
  exitCode: 0 | 1 | 2 | 130;
  reason: string;
  runId: string;
  jobId: string;
  attemptId: string;
}

const enc = new TextEncoder();

const EXIT: Record<RunLocalResult["state"], RunLocalResult["exitCode"]> = {
  success: 0,
  skipped: 0,
  failure: 1,
  infra_error: 2,
  cancelled: 130,
};

/**
 * Plans, creates DB rows, runs one job in a fresh sandbox and records the result. Plan errors
 * (unsupported workflow features, unresolvable action refs) throw before any row exists.
 * The sandbox is always destroyed.
 */
export async function runLocal(o: RunLocalOptions): Promise<RunLocalResult> {
  const planned = planJob(o.workflowYaml, o.job, {
    workflowPath: o.workflowPath,
    event: o.event,
    ...(o.planRoot ? { root: o.planRoot } : {}),
    ...(o.readFile ? { readFile: o.readFile } : {}),
  });
  for (const w of planned.warnings) o.out(`warning: ${w.message}\n`);
  const plan = await resolveActions(planned, o.resolver);

  const ids = await o.store.begin({
    workflowPath: o.workflowPath,
    event: o.event,
    ref: o.ref,
    ...(o.sha ? { sha: o.sha } : {}),
    jobKey: o.job,
    jobName: o.job,
    provider: o.providerName,
  });
  await o.store.markRunning(ids);

  const finish = async (
    state: RunLocalResult["state"],
    reason: string,
    code?: number,
  ): Promise<RunLocalResult> => {
    const dbState = state;
    const exitCode =
      dbState === "success"
        ? 0
        : dbState === "failure"
          ? code && code !== 0
            ? code
            : 1
          : undefined;
    await o.store.finish(ids, dbState, {
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(state === "infra_error" ? { errorClass: reason.slice(0, 200) } : {}),
    });
    return { state, exitCode: EXIT[state], reason, ...ids };
  };

  const log = new LogPipe(o, ids.attemptId);
  const idle = setInterval(() => log.idleFlush(o.idleFlushMs ?? 1000), 250);

  const steps = new Map<string, StepRecord>();
  const onAct = (e: ActEvent): void => {
    if (e.type === "step-start") {
      const rec: StepRecord = {
        stepKey: e.stepKey,
        stage: e.stage,
        index: steps.size,
        name: stepLabel(e.name, e.stage),
        startedAt: Date.now(),
        logOffset: log.stored,
      };
      steps.set(`${e.stepKey}\0${e.stage}`, rec);
      log.chain(() => o.store.recordStep(ids.attemptId, { ...rec }));
    } else if (e.type === "step-end") {
      const rec = steps.get(`${e.stepKey}\0${e.stage}`);
      if (rec) {
        rec.result = e.result;
        rec.endedAt = Date.now();
        if (e.durationMs !== undefined) rec.durationMs = e.durationMs;
        log.chain(() => o.store.recordStep(ids.attemptId, { ...rec }));
      }
    }
    log.push(renderEvent(e));
  };

  const settle = async (
    state: RunLocalResult["state"],
    reason: string,
    code?: number,
  ): Promise<RunLocalResult> => {
    clearInterval(idle);
    await log.close();
    return finish(state, reason, code);
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
      network: { egress: "none" },
    });
    sandboxId = sb.id;
    await o.store.setSandbox(ids.attemptId, sb.id);
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
        o.out(`warning: could not destroy sandbox ${sandboxId}: ${String(e)}\n`);
      }
    }
  }
}

/** Redacts text, shows it, and stores it in order with byte offsets (offsets of what is stored). */
class LogPipe {
  stored = 0;
  readonly #redactor = new Redactor();
  readonly #o: RunLocalOptions;
  readonly #attemptId: string;
  #lastPush = Date.now();
  #writes: Promise<void> = Promise.resolve();

  constructor(o: RunLocalOptions, attemptId: string) {
    this.#o = o;
    this.#attemptId = attemptId;
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
    this.#o.out(text);
    const bytes = enc.encode(text);
    const at = this.stored;
    this.stored += bytes.length;
    this.chain(() => this.#o.store.appendLog(this.#attemptId, at, bytes));
  }
}
