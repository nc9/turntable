import {
  InfraError,
  SandboxNotFoundError,
  type ExecStatus,
  type Provider,
} from "@longshore/provider-sdk";
import {
  ACT_RELEASES,
  EXTRACT_ACTION_SH,
  INSTALL_SH,
  archFromUname,
  fetchAct,
  fetchActionTarball,
  sha256Hex,
  type ActTarball,
  type ActionFetcher,
} from "./act-install";
import { checkoutStubAction } from "./checkout-stub";
import { createActParser, summarize, type ActEvent } from "./events";
import { PlanError, assertNoDockerAccess, assertPinned, type JobPlan } from "./plan";
import {
  INSTALL_SHIMS_SH,
  launcherArgv,
  PROXY_BUNDLE_SH,
  envFileOf,
  proxyEnvFile,
  SHIM_NAMES,
  STEP_ENV,
  STEP_SHIM,
} from "./step-env";

export type JobState = "success" | "failure" | "skipped" | "infra_error";

export interface JobResult {
  state: JobState;
  /** act's exit code when it ran to the end. */
  exitCode?: number;
  /** Short human-readable cause. */
  reason: string;
  /** The job's declared outputs, read after it ran (split jobs only; others have none). */
  outputs?: Record<string, string>;
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
  /**
   * Route the job's traffic through the secrets proxy: the proxy URL (as the sandbox reaches it,
   * credential included) and the certificate the proxy signs with. Env and files only, set for
   * act and so for every step; never a provider env field.
   */
  proxy?: { url: string; caPem: string };
  /**
   * The value of GITHUB_TOKEN for act and the steps (`secrets.GITHUB_TOKEN`, `github.token`). Put
   * in the environment file, never in an argv. Behind the secrets proxy this is a placeholder
   * and the proxy attaches the real token.
   */
  githubToken?: string;
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
  /**
   * Called as soon as act's exec has started, before anything is watched. Persist it: a
   * restarted controller needs `{sandboxId, execId}` to re-attach with `resumeJob`.
   */
  onExec?: (info: { sandboxId: string; execId: string }) => void | Promise<void>;
}

/** @deprecated The step environment lives in step-env.ts; kept for importers of the old name. */
export const SANDBOX_ENV: readonly string[] = STEP_ENV;

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

/** Assembles uploaded parts into one file and checks it. Args: path, part count, sha256. */
export const ASSEMBLE_SH = `set -eu
p=$1; n=$2; want=$3
: > "$p"
i=0
while [ "$i" -lt "$n" ]; do
  cat "$p.part$i" >> "$p"
  rm -f "$p.part$i"
  i=$((i + 1))
done
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$p" | cut -d' ' -f1)
else got=$(shasum -a 256 "$p" | cut -d' ' -f1); fi
[ "$got" = "$want" ] || { echo "delivered file checksum mismatch: $got" >&2; exit 3; }
`;

/**
 * Uploads one file. A file over the provider's per-file cap goes up in parts under the cap and is
 * put back together in the sandbox, checked against its digest, so a repository larger than the
 * cap is still delivered whole. Returns a failure reason, or undefined on success.
 */
export async function putChunked(
  provider: Provider,
  sandboxId: string,
  path: string,
  bytes: Uint8Array,
  retry: { max: number; pollMs: number },
): Promise<string | undefined> {
  const cap = provider.info.files.maxBytes;
  if (cap === undefined || bytes.length <= cap) {
    await withRetry(() => provider.files.put(sandboxId, path, bytes), retry.max, retry.pollMs);
    return undefined;
  }
  // Half the cap leaves room for any framing the provider adds.
  const size = Math.max(1, Math.floor(cap / 2));
  const parts = Math.ceil(bytes.length / size);
  for (let i = 0; i < parts; i++) {
    await withRetry(
      () =>
        provider.files.put(sandboxId, `${path}.part${i}`, bytes.subarray(i * size, (i + 1) * size)),
      retry.max,
      retry.pollMs,
    );
  }
  const r = await execShort(
    provider,
    sandboxId,
    ASSEMBLE_SH,
    [path, String(parts), sha256Hex(bytes)],
    retry,
  );
  return r.exitCode === 0
    ? undefined
    : `cannot assemble ${path} from ${parts} parts: ${r.output.trim()}`;
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
  const maxErr = opts.maxProviderErrors ?? 5;
  const retry = { max: maxErr, pollMs };
  const L = plan.layout;

  try {
    // Every remote action must be pinned to a commit before anything runs.
    assertNoDockerAccess(plan.argv);
    assertPinned(plan);
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
    const delivered = await putChunked(
      provider,
      sandboxId,
      L.repoTarball,
      input.repoTarball,
      retry,
    );
    if (delivered !== undefined) return fail(delivered);
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
    // Steps must see no terminal, as on GitHub's runner: shim the interpreters (see step-env.ts).
    const shims = await execShort(
      provider,
      sandboxId,
      INSTALL_SHIMS_SH,
      [L.shims, STEP_SHIM, ...SHIM_NAMES],
      retry,
    );
    if (shims.exitCode !== 0) return fail(`cannot install step shims: ${shims.output.trim()}`);

    // The event payload, byte for byte as the plan stored it.
    if (plan.eventJson !== undefined) {
      await withRetry(
        () => provider.files.put(sandboxId, L.eventFile, enc.encode(plan.eventJson as string)),
        maxErr,
        pollMs,
      );
    }
    // Anything the job needs in its environment that must not appear in an argv (the proxy URL
    // carries the attempt's credential, GITHUB_TOKEN is a token) goes in one 0600 file the launcher
    // sources and deletes before act starts.
    let envText = "";
    if (input.proxy) {
      const caPath = `${L.root}/proxy-ca.pem`;
      const bundle = `${L.root}/proxy-bundle.pem`;
      await withRetry(
        () => provider.files.put(sandboxId, caPath, enc.encode(input.proxy?.caPem ?? "")),
        maxErr,
        pollMs,
      );
      const b = await execShort(provider, sandboxId, PROXY_BUNDLE_SH, [caPath, bundle], retry);
      if (b.exitCode !== 0) return fail(`cannot build the proxy trust bundle: ${b.output.trim()}`);
      envText += proxyEnvFile(input.proxy.url, bundle);
    }
    if (input.githubToken !== undefined)
      envText += envFileOf([["GITHUB_TOKEN", input.githubToken]]);
    let envFile = "";
    if (envText !== "") {
      envFile = `${L.root}/job.env`;
      await withRetry(
        () => provider.files.put(sandboxId, envFile, enc.encode(envText)),
        maxErr,
        pollMs,
      );
      const m = await execShort(provider, sandboxId, 'chmod 600 "$1"', [envFile], retry);
      if (m.exitCode !== 0) return fail("cannot protect the job environment file");
    }

    // Pin every `uses:` to its sha in the files act will read.
    for (const [i, f] of plan.files.entries()) {
      // The workflow itself is always uploaded: for a split job it exists only here.
      if (i > 0 && f.text === f.source) continue;
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
          argv: launcherArgv(
            L.shims,
            // `-s GITHUB_TOKEN` takes the value from the environment: it is never in the argv.
            input.githubToken === undefined ? plan.argv : [...plan.argv, "-s", "GITHUB_TOKEN"],
            envFile,
          ),
          cwd: plan.cwd,
          timeoutSeconds: opts.timeoutSeconds ?? 3600,
        }),
      maxErr,
      pollMs,
    );
    await opts.onExec?.({ sandboxId, execId });
    return yield* watchExec(provider, sandboxId, execId, opts, plan);
  } catch (e) {
    if (e instanceof PlanError) return fail(`plan rejected: ${e.message}`);
    if (e instanceof SandboxNotFoundError) return fail("sandbox is gone (cancelled or expired)");
    if (e instanceof InfraError) return fail(e.message);
    throw e;
  }
}

/**
 * Watches an already-started act exec to its end: polls status, drains the log by offset from
 * the beginning, parses the events, and returns the verdict. It yields the same events as
 * `runJob` (the log from offset 0, every act event). It holds no state outside the sandbox, so a
 * restarted controller can call it for an exec a dead one started and get the real result: the
 * exec outlives the controller, and its log is read by offset.
 */
export async function* watchExec(
  provider: Provider,
  sandboxId: string,
  execId: string,
  opts: RunOptions = {},
  /**
   * The job's plan, when known. It tells which events belong to the job (a split job's stub
   * `needs` jobs emit their own) and which outputs to read. Without it every event counts and no
   * outputs are read, which is only right for a job with no stub needs and no outputs.
   */
  plan?: JobPlan,
): AsyncGenerator<RunEvent, JobResult> {
  const pollMs = opts.pollMs ?? 500;
  const chunk = opts.logChunkBytes ?? 256 * 1024;
  const maxErr = opts.maxProviderErrors ?? 5;
  try {
    yield { kind: "phase", phase: "running" };

    // Events of stub need jobs (split workflows) are not part of this job.
    const mine = (ev: ActEvent): boolean => !("jobId" in ev && plan?.stubIds.includes(ev.jobId));
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
          if (!mine(ev)) continue;
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
      if (!mine(ev)) continue;
      events.push(ev);
      yield { kind: "act", event: ev };
    }

    const verdict = decide(status, summarize(events));
    if (!plan || plan.outputNames.length === 0 || status.state === "lost") return verdict;
    const outputs = await readOutputs(provider, sandboxId, plan, maxErr, pollMs);
    return Object.keys(outputs).length > 0 ? { ...verdict, outputs } : verdict;
  } catch (e) {
    if (e instanceof SandboxNotFoundError) return fail("sandbox is gone (cancelled or expired)");
    if (e instanceof InfraError) return fail(e.message);
    throw e;
  }
}

/**
 * Re-attaches to an exec a previous controller started (`{sandboxId, execId}` from `onExec`).
 * Same events and verdict as `runJob` would have produced. An exec that is lost, or a sandbox
 * that is gone, is infra_error: there is no result to recover.
 */
export function resumeJob(
  provider: Provider,
  sandboxId: string,
  execId: string,
  opts: RunOptions = {},
  plan?: JobPlan,
): AsyncGenerator<RunEvent, JobResult> {
  return watchExec(provider, sandboxId, execId, opts, plan);
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

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Reads the files the generated export step wrote. A missing file is an output never set. */
async function readOutputs(
  provider: Provider,
  sandboxId: string,
  plan: JobPlan,
  maxErr: number,
  pollMs: number,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of plan.outputNames) {
    try {
      const bytes = await withRetry(
        () => provider.files.get(sandboxId, `${plan.layout.outputsDir}/${name}`, MAX_OUTPUT_BYTES),
        maxErr,
        pollMs,
      );
      out[name] = dec.decode(bytes);
    } catch (e) {
      if (e instanceof SandboxNotFoundError) throw e;
      // not written, or too large: the output stays unset
    }
  }
  return out;
}
