import {
  InfraError,
  SandboxNotFoundError,
  type ExecStatus,
  type Provider,
} from "@turntable/provider-sdk";
import {
  ACT_RELEASES,
  EXTRACT_ACTION_SH,
  INSTALL_SH,
  archFromUname,
  fetchAct,
  fetchActionTarball,
  type ActTarball,
  type ActionFetcher,
} from "./act-install";
import { checkoutStubAction } from "./checkout-stub";
import { createActParser, summarize, type ActEvent } from "./events";
import { assertNoDockerAccess, type JobPlan } from "./plan";

export type JobState = "success" | "failure" | "skipped" | "infra_error";

export interface JobResult {
  state: JobState;
  /** act's exit code when it ran to the end. */
  exitCode?: number;
  /** Short human-readable cause. */
  reason: string;
}

export type RunEvent =
  | { kind: "phase"; phase: "preparing" | "running" | "draining" }
  | { kind: "log"; offset: number; bytes: Uint8Array }
  | { kind: "act"; event: ActEvent };

export interface RunInput {
  /** Tarball of the repository to run, .git included. */
  repoTarball: Uint8Array;
  /** Override the pinned act download (tests and offline use). Must carry its sha256. */
  act?: ActTarball;
  /** Override how remote actions are fetched by sha (tests). */
  fetchAction?: ActionFetcher;
}

export interface RunOptions {
  /** Wall-clock limit for act inside the sandbox. Default 3600. */
  timeoutSeconds?: number;
  /** Poll interval. Default 500 ms. */
  pollMs?: number;
  /** Bytes per logs call. Default 256 KiB. */
  logChunkBytes?: number;
  /** Consecutive provider errors tolerated before giving up with infra_error. Default 5. */
  maxProviderErrors?: number;
}

/**
 * Environment set INSIDE the sandbox for act itself (constants, never controller env). act gives
 * run steps a pty, so without these a `git log` would block in a pager until the timeout.
 */
export const SANDBOX_ENV: readonly string[] = [
  "GIT_PAGER=cat",
  "PAGER=cat",
  "GIT_TERMINAL_PROMPT=0",
];

const dec = new TextDecoder();
const enc = new TextEncoder();

/** Retries a provider call on retryable errors, with a small backoff. */
async function withRetry<T>(fn: () => Promise<T>, max: number, pollMs: number): Promise<T> {
  let n = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof InfraError) || e instanceof SandboxNotFoundError) throw e;
      n += 1;
      if (n >= max) throw e;
      await Bun.sleep(pollMs * n);
    }
  }
}

const fail = (reason: string): JobResult => ({ state: "infra_error", reason });

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/** Runs a short command to completion and returns its output. Setup only. */
async function execShort(
  p: Provider,
  id: string,
  script: string,
  args: string[],
  retry: { max: number; pollMs: number },
): Promise<{ exitCode: number; output: string }> {
  const { execId } = await withRetry(
    () => p.exec.start(id, { argv: ["sh", "-c", script, "tt", ...args], timeoutSeconds: 600 }),
    retry.max,
    retry.pollMs,
  );
  const deadline = Date.now() + 600_000;
  let st: ExecStatus;
  for (;;) {
    st = await withRetry(() => p.exec.status(id, execId), retry.max, retry.pollMs);
    if (st.state !== "running") break;
    if (Date.now() > deadline) throw new InfraError("setup command timed out");
    await sleep(100);
  }
  if (st.state !== "exited") throw new InfraError(`setup command ${st.state}`);
  const logs = await withRetry(
    () => p.exec.logs(id, execId, { fromOffset: 0, maxBytes: 64 * 1024 }),
    retry.max,
    retry.pollMs,
  );
  return { exitCode: st.exitCode ?? -1, output: dec.decode(logs.bytes) };
}

/**
 * Runs one planned job in an existing sandbox using only the provider SDK. Yields log chunks
 * (with offsets) and parsed act events; the generator's return value is the JobResult.
 * Cancellation is the caller destroying the sandbox: calls then fail and the job ends as
 * infra_error. State lives in the sandbox (detached exec), not in this function.
 */
export async function* runJob(
  provider: Provider,
  sandboxId: string,
  plan: JobPlan,
  input: RunInput,
  opts: RunOptions = {},
): AsyncGenerator<RunEvent, JobResult> {
  const pollMs = opts.pollMs ?? 500;
  const chunk = opts.logChunkBytes ?? 256 * 1024;
  const maxErr = opts.maxProviderErrors ?? 5;
  const retry = { max: maxErr, pollMs };
  const L = plan.layout;

  try {
    // Every remote action must be pinned to a commit before anything runs.
    assertNoDockerAccess(plan.argv);
    const unresolved = plan.actions.filter((a) => !a.sha);
    if (unresolved.length > 0) {
      return fail(
        `actions not resolved to a commit sha (run resolveActions first): ${unresolved.map((a) => a.uses).join(", ")}`,
      );
    }
    yield { kind: "phase", phase: "preparing" };
    let act = input.act;
    const mk = await execShort(provider, sandboxId, 'mkdir -p "$1" && uname -m', [L.root], retry);
    if (mk.exitCode !== 0) return fail(`cannot prepare sandbox: ${mk.output.trim()}`);
    if (!act) {
      const arch = archFromUname(mk.output);
      if (!arch) return fail(`unsupported sandbox architecture: ${mk.output.trim()}`);
      act = await fetchAct(arch);
    }
    await withRetry(() => provider.files.put(sandboxId, L.actTarball, act.bytes), maxErr, pollMs);
    await withRetry(
      () => provider.files.put(sandboxId, L.repoTarball, input.repoTarball),
      maxErr,
      pollMs,
    );
    for (const dir of plan.stubDirs) {
      const bytes = enc.encode(checkoutStubAction(L.repo));
      await withRetry(
        () => provider.files.put(sandboxId, `${dir}/action.yml`, bytes),
        maxErr,
        pollMs,
      );
    }
    const inst = await execShort(
      provider,
      sandboxId,
      INSTALL_SH,
      [L.actTarball, act.sha256, L.root],
      retry,
    );
    if (inst.exitCode !== 0) return fail(`act install failed: ${inst.output.trim()}`);

    // Pin every `uses:` to its sha in the files act will read.
    for (const f of plan.files) {
      if (f.text === f.source) continue;
      await withRetry(
        () => provider.files.put(sandboxId, `${L.repo}/${f.path}`, enc.encode(f.text)),
        maxErr,
        pollMs,
      );
    }
    // Deliver remote actions by commit sha. The checkout stub only copies the delivered repo.
    for (const [i, a] of plan.actions.filter((x) => x.kind === "remote").entries()) {
      const tgz = await (input.fetchAction ?? fetchActionTarball)(a.repo, a.sha ?? "");
      const path = `${L.stubs}/action-${i}.tgz`;
      await withRetry(() => provider.files.put(sandboxId, path, tgz), maxErr, pollMs);
      const x = await execShort(provider, sandboxId, EXTRACT_ACTION_SH, [path, a.dir], retry);
      if (x.exitCode !== 0) return fail(`cannot unpack ${a.uses}: ${x.output.trim()}`);
    }

    const { execId } = await withRetry(
      () =>
        provider.exec.start(sandboxId, {
          argv: ["env", ...SANDBOX_ENV, ...plan.argv],
          cwd: plan.cwd,
          timeoutSeconds: opts.timeoutSeconds ?? 3600,
        }),
      maxErr,
      pollMs,
    );
    yield { kind: "phase", phase: "running" };

    const parser = createActParser();
    const events: ActEvent[] = [];
    let offset = 0;
    let status: ExecStatus = { state: "running" };

    const drainOnce = async function* (): AsyncGenerator<RunEvent, boolean> {
      const r = await withRetry(
        () => provider.exec.logs(sandboxId, execId, { fromOffset: offset, maxBytes: chunk }),
        maxErr,
        pollMs,
      );
      if (r.bytes.length > 0) {
        yield { kind: "log", offset, bytes: r.bytes };
        for (const ev of parser.push(dec.decode(r.bytes, { stream: true }))) {
          events.push(ev);
          yield { kind: "act", event: ev };
        }
      }
      offset = r.nextOffset;
      return r.eof;
    };

    // Poll status first, then drain logs, so the final drain happens after the exit is known.
    for (;;) {
      status = await withRetry(() => provider.exec.status(sandboxId, execId), maxErr, pollMs);
      const running = status.state === "running";
      if (!running) yield { kind: "phase", phase: "draining" };
      let eof = false;
      for (;;) {
        const before = offset;
        eof = yield* drainOnce();
        if (eof || offset === before) break;
      }
      if (!running && eof) break;
      if (!running && !eof) continue;
      await sleep(pollMs);
    }
    for (const ev of parser.end()) {
      events.push(ev);
      yield { kind: "act", event: ev };
    }

    return decide(status, summarize(events));
  } catch (e) {
    if (e instanceof SandboxNotFoundError) return fail("sandbox is gone (cancelled or expired)");
    if (e instanceof InfraError) return fail(e.message);
    throw e;
  }
}

/** Turns the authoritative exec status plus parsed events into a verdict. */
export function decide(status: ExecStatus, sum: ReturnType<typeof summarize>): JobResult {
  if (status.state === "lost") return { state: "infra_error", reason: "act process lost" };
  if (status.state === "killed") {
    const why = status.reason ?? "killed";
    return {
      state: why === "timeout" || why === "output_limit" ? "failure" : "infra_error",
      ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
      reason: `act stopped: ${why}`,
    };
  }
  const code = status.exitCode ?? -1;
  if (code === 0) {
    if (!sum.started)
      return { state: "skipped", exitCode: 0, reason: "job produced no events (skipped)" };
    if (sum.finished && sum.result === "success") {
      return { state: "success", exitCode: 0, reason: "job succeeded" };
    }
    return {
      state: "infra_error",
      exitCode: 0,
      reason: `act exited 0 but job result was ${sum.result ?? "missing"}`,
    };
  }
  if (sum.started && sum.finished && sum.result === "failure") {
    const steps = sum.failedSteps.length ? `: ${sum.failedSteps.join(", ")}` : "";
    return { state: "failure", exitCode: code, reason: `job failed${steps}` };
  }
  return {
    state: "infra_error",
    exitCode: code,
    reason: `act exited ${code} without a job result`,
  };
}

/** Consumes a run, calling `onEvent` for each, and returns the result. */
export async function drain(
  run: AsyncGenerator<RunEvent, JobResult>,
  onEvent?: (e: RunEvent) => void,
): Promise<JobResult> {
  for (;;) {
    const r = await run.next();
    if (r.done) return r.value;
    onEvent?.(r.value);
  }
}

export { ACT_RELEASES };
