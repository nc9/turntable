import type { AttemptCredential } from "@turntable/proxy";
import { probeEgress, probeProxy } from "./egress-canary";
import {
  EXPORT_STEP_NAME,
  missingTool,
  missingToolNotice,
  resumeJob,
  runJob,
  type ActEvent,
  type ActTarball,
  type ActionFetcher,
  type JobPlan,
} from "@turntable/act-runner";
import type { Provider, ProxyEndpoint, SandboxResources } from "@turntable/provider-sdk";
import { Redactor, SecretRegistry, redactString } from "@turntable/redact";
import { renderEvent, stepLabel } from "./render";
import type { JobIds, RunStore, StepRecord } from "./store";

/** Node 22 with bash, git and tar, which act host mode needs. Multi-arch index digest. */
export const DEFAULT_IMAGE =
  "node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb";

export type Verdict = "success" | "failure" | "skipped" | "infra_error" | "cancelled";

/** Process exit code: 0 success or skipped, 1 failure, 2 infra_error, 130 cancelled. */
export type ExitCode = 0 | 1 | 2 | 130;

export const EXIT: Record<Verdict, ExitCode> = {
  success: 0,
  skipped: 0,
  failure: 1,
  infra_error: 2,
  cancelled: 130,
};

/** Everything executeJob needs that does not change between jobs of one run. */
export interface JobEnv {
  provider: Provider;
  store: RunStore;
  /** Not needed to resume. */
  image?: string;
  /** Not needed to resume. */
  repoTarball?: Uint8Array;
  /**
   * The provider snapshot to start the sandbox from: the project's, which beats a size class's
   * and the provider config's. Unset: the provider's own choice.
   */
  snapshot?: string;
  /** Sink for the (redacted) log text. */
  out: (text: string) => void;
  /** `none` (default) gives the sandbox no network. `open` is an explicit opt-in. */
  egress?: "none" | "open";
  /** The sandbox's size, from the operator's size map (see scheduler/sandbox-size.ts). Absent: the provider's default. */
  sandbox?: { resources?: SandboxResources; snapshot?: string };
  registry: SecretRegistry;
  signal?: AbortSignal | undefined;
  idleFlushMs?: number;
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  pollMs?: number;
  timeoutSeconds?: number;
  /**
   * Prove the sandbox cannot reach out before the job runs, when egress is `none`: a probe tries a
   * public IP and the metadata IP. A breach is infra_error. If the probe cannot run (no tool in the
   * image) the job proceeds with a notice, unless it is `secretBearing`, which is then refused.
   */
  canary?: boolean;
  /** The job holds secrets: it never runs on `open` egress or without a verified `none`. */
  secretBearing?: boolean;
  /** Lines written to the top of the log before anything else (a fresh run, not a re-attach). */
  notices?: readonly string[];
  /**
   * Run the job behind the secrets proxy: the sandbox gets no route but to the proxy (the
   * provider must enforce `deny-all-except-proxy`), and its env points everything at it. Verified
   * before the job runs: the direct path must be closed and the proxy open, or the job is not
   * run. `listen` is the proxy as the provider's host reaches it.
   */
  proxy?: { listen: ProxyEndpoint; credential: AttemptCredential };
  /**
   * The value of GITHUB_TOKEN inside the job. The real token for a trusted class with no proxy
   * (the caller has registered it with `registry`), or a placeholder behind the proxy, which
   * attaches the real one.
   */
  githubToken?: string;
  /** GitHub's OIDC request variables for the steps; the token is a placeholder (see oidc/job-delivery). */
  oidc?: { requestUrl: string; requestToken: string };
}

export interface JobOutcome {
  state: Verdict;
  exitCode: ExitCode;
  reason: string;
  /** act's exit code when it ran to the end. */
  actExitCode?: number;
  outputs?: Record<string, string>;
}

const enc = new TextEncoder();

/** Re-attach to an exec a dead controller started, instead of starting one. */
export interface ResumeFrom {
  sandboxId: string;
  execId: string;
}

/**
 * Runs one planned job in a fresh sandbox: streams redacted log text to `out` and the store
 * (with offsets), records steps, writes the job's final state, and always destroys the sandbox.
 *
 * With `resume` it re-attaches to the exec of a dead controller instead (`plan` is then only used
 * to tell the job's own events from stub-needs events and to read outputs; pass it when the job has
 * either): the store's output is reset, the whole exec log is replayed by offset, and the real
 * verdict is derived from it, even for a job that finished while nobody was watching.
 */
export async function executeJob(
  env: JobEnv,
  ids: JobIds,
  plan: JobPlan | undefined,
  resume?: ResumeFrom,
): Promise<JobOutcome> {
  const clean = (text: string): string => redactString(text, env.registry);

  const finish = async (
    state: Verdict,
    rawReason: string,
    code?: number,
    outputs?: Record<string, string>,
  ): Promise<JobOutcome> => {
    const reason = clean(rawReason);
    const exitCode =
      state === "success" ? 0 : state === "failure" ? (code && code !== 0 ? code : 1) : undefined;
    await env.store.finishJob(ids, state, {
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(state === "infra_error" ? { errorClass: reason.slice(0, 200) } : {}),
    });
    return {
      state,
      exitCode: EXIT[state],
      reason,
      ...(code !== undefined ? { actExitCode: code } : {}),
      ...(outputs ? { outputs } : {}),
    };
  };

  const log = new LogPipe(env, ids.attemptId);
  const idle = setInterval(() => log.idleFlush(env.idleFlushMs ?? 1000), 250);
  if (!resume) for (const n of env.notices ?? []) log.push(`${n}\n`);

  const steps = new Map<string, StepRecord>();
  const hidden = new Set<string>();
  /** What each open step printed (a bounded tail), for the missing-tool notice. */
  const stepOutput = new Map<string, string>();
  const OUTPUT_KEEP = 8 * 1024;
  const onAct = (e: ActEvent): void => {
    // The generated output-export step is plumbing, not part of the user's job.
    if ((e.type === "step-start" || e.type === "step-end") && e.name === EXPORT_STEP_NAME) {
      hidden.add(e.stepKey);
      return;
    }
    if ((e.type === "output" || e.type === "command") && hidden.has(e.stepKey)) return;
    if (e.type === "output") {
      const kept = stepOutput.get(e.stepKey) ?? "";
      // The tail is what shows the last error; keep a bounded window of it.
      stepOutput.set(e.stepKey, `${kept}${e.text}`.slice(-OUTPUT_KEEP));
    }
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
      log.chain(() => env.store.recordStep(ids.attemptId, { ...rec }));
    } else if (e.type === "step-end") {
      const rec = steps.get(`${e.stepKey}\0${e.stage}`);
      if (rec) {
        rec.result = e.result;
        rec.endedAt = Date.now();
        if (e.durationMs !== undefined) rec.durationMs = e.durationMs;
        log.chain(() => env.store.recordStep(ids.attemptId, { ...rec }));
      }
    }
    log.push(renderEvent(e));
    // A failed step whose output ends in a shell "not found" says which tool the image lacks. The
    // result is act's, unchanged.
    if (e.type === "step-end" && e.result === "failure") {
      const tool = missingTool(stepOutput.get(e.stepKey) ?? "");
      if (tool) log.push(missingToolNotice(tool));
    }
    if (e.type === "step-end") {
      stepOutput.delete(e.stepKey);
    }
  };

  const settle = async (
    state: Verdict,
    reason: string,
    code?: number,
    outputs?: Record<string, string>,
  ): Promise<JobOutcome> => {
    clearInterval(idle);
    await log.close();
    return finish(state, reason, code, outputs);
  };

  let sandboxId: string | undefined;
  let cancelled = env.signal?.aborted ?? false;
  const aborted = new Promise<"abort">((resolve) => {
    if (cancelled) resolve("abort");
    env.signal?.addEventListener("abort", () => {
      cancelled = true;
      resolve("abort");
    });
  });
  try {
    if (cancelled) return await settle("cancelled", "cancelled by user");
    let run;
    if (resume) {
      sandboxId = resume.sandboxId;
      await env.store.resetOutput?.(ids.attemptId);
      run = resumeJob(
        env.provider,
        resume.sandboxId,
        resume.execId,
        { pollMs: env.pollMs ?? 500 },
        plan,
      );
    } else {
      if (!plan || !env.image || !env.repoTarball) {
        throw new Error("plan, image and repoTarball are required to start a job");
      }
      const proxied = env.proxy;
      const pick = proxied
        ? proxyEgress(env.provider.info.network.egressPolicy, proxied.listen)
        : undefined;
      if (proxied && pick === undefined) {
        return await settle(
          "infra_error",
          `provider ${env.provider.info.name} cannot confine a sandbox to the secrets proxy; the job was not run`,
        );
      }
      const ttlSeconds = (env.timeoutSeconds ?? 3600) + 900;
      const sb = await env.provider.create({
        name: `tt-run-${ids.attemptId.toLowerCase()}`,
        labels: { "turntable.run": ids.runId, "turntable.job": ids.jobId },
        image: env.image,
        ...(env.sandbox?.resources ? { resources: env.sandbox.resources } : {}),
        // The project's snapshot (set by the instance operator) beats a size class's, which beats the provider's.
        ...((env.snapshot ?? env.sandbox?.snapshot)
          ? { snapshot: (env.snapshot ?? env.sandbox?.snapshot) as string }
          : {}),
        ttlSeconds,
        network:
          proxied && pick
            ? { egress: pick, proxy: proxied.listen }
            : { egress: env.egress ?? "none" },
      });
      sandboxId = sb.id;
      // A provider with its own cap (Daytona) may end the sandbox sooner than asked: that is how
      // long it can outlive the attempt, so the quota grace follows it.
      const cap = env.provider.info.ttlSeconds;
      await env.store.setSandbox(
        ids.attemptId,
        sb.id,
        Date.now(),
        cap === undefined ? undefined : Math.min(ttlSeconds, cap),
      );
      let proxyUrl: string | undefined;
      if (proxied) {
        if (!sb.proxy) {
          return await settle(
            "infra_error",
            "the provider did not say how the sandbox reaches the proxy; the job was not run",
          );
        }
        proxyUrl = proxied.credential.proxyUrl(sb.proxy.host, sb.proxy.port);
        // The credential is the job's own, but it is not for the log.
        env.registry.register(proxied.credential.password);
        // Direct path closed, proxy path open, verified from inside; anything else is no run.
        const direct = await probeEgress(env.provider, sb.id, {
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (direct.kind !== "blocked") {
          return await settle(
            "infra_error",
            direct.kind === "reachable"
              ? `proxy canary: the sandbox reached ${direct.target} without the proxy; the job was not run`
              : `proxy canary could not verify isolation (${direct.why}); the job was not run`,
          );
        }
        // The host's address on the sandbox's own network must be closed too: a listener on the
        // host (the proxy's own port included) is not a way around the proxy's rules.
        // Fail closed: a provider that cannot name what must be closed cannot be trusted to have
        // closed it.
        if (!sb.mustNotReach || sb.mustNotReach.length === 0) {
          return await settle(
            "infra_error",
            "the provider did not name the host addresses to verify closed; the job was not run",
          );
        }
        const host = await probeEgress(env.provider, sb.id, {
          targets: sb.mustNotReach,
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (host.kind !== "blocked") {
          return await settle(
            "infra_error",
            host.kind === "reachable"
              ? `proxy canary: the sandbox reached the host at ${host.target}; the job was not run`
              : `proxy canary could not verify host isolation (${host.why}); the job was not run`,
          );
        }
        const via = await probeProxy(env.provider, sb.id, sb.proxy, {
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (via.kind !== "open") {
          return await settle(
            "infra_error",
            `proxy canary: the sandbox cannot reach the proxy (${via.why}); the job was not run`,
          );
        }
      }
      // A job that holds a secret is always probed, whatever `canary` says, and an answer the probe
      // cannot give refuses it (below).
      if (!proxied && (env.canary || env.secretBearing) && (env.egress ?? "none") === "none") {
        const v = await probeEgress(env.provider, sb.id, {
          ...(env.pollMs ? { pollMs: env.pollMs } : {}),
          signal: env.signal,
        });
        if (v.kind === "reachable") {
          return await settle(
            "infra_error",
            `egress canary: the sandbox reached ${v.target} although egress is none; the job was not run`,
          );
        }
        if (v.kind === "unknown") {
          if (env.secretBearing) {
            return await settle(
              "infra_error",
              `egress canary could not verify isolation (${v.why}); a job with secrets was not run`,
            );
          }
          log.push(
            `[turntable] egress canary could not run (${v.why}); egress none is unverified\n`,
          );
        }
      }
      run = runJob(
        env.provider,
        sb.id,
        plan,
        {
          repoTarball: env.repoTarball,
          ...(proxied && proxyUrl
            ? { proxy: { url: proxyUrl, caPem: proxied.credential.caPem } }
            : {}),
          ...(env.githubToken !== undefined ? { githubToken: env.githubToken } : {}),
          ...(env.oidc ? { oidc: env.oidc } : {}),
          ...(env.act ? { act: env.act } : {}),
          ...(env.fetchAction ? { fetchAction: env.fetchAction } : {}),
        },
        {
          pollMs: env.pollMs ?? 500,
          ...(env.timeoutSeconds ? { timeoutSeconds: env.timeoutSeconds } : {}),
          // As soon as the exec exists, record it: a restarted controller needs it to re-attach.
          onExec: ({ execId }) => env.store.setExec?.(ids.attemptId, execId) ?? Promise.resolve(),
        },
      );
    }
    for (;;) {
      const next = await Promise.race([run.next(), aborted]);
      if (next === "abort") {
        void run.return({ state: "infra_error", reason: "cancelled" });
        return await settle("cancelled", "cancelled by user");
      }
      if (next.done) {
        const r = next.value;
        return await settle(r.state, r.reason, r.exitCode, r.outputs);
      }
      if (next.value.kind === "act") onAct(next.value.event);
      else if (next.value.kind === "cut") log.cut(next.value.omittedBytes);
    }
  } catch (e) {
    if (cancelled) return await settle("cancelled", "cancelled by user");
    return await settle("infra_error", e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(idle);
    if (sandboxId) {
      try {
        await env.provider.destroy(sandboxId);
        // Confirmed gone: the sandbox's billed life ends here. A destroy that failed records
        // nothing, so the time is never guessed (the provider's TTL ended it).
        await env.store.setSandboxDestroyed?.(ids.attemptId, Date.now());
      } catch (e) {
        env.out(`warning: could not destroy sandbox ${sandboxId}: ${String(e)}\n`);
      }
    }
  }
}

/** Redacts text, shows it, and stores it in order with byte offsets (offsets of what is stored). */
export class LogPipe {
  stored = 0;
  #redactor: Redactor;
  readonly #env: JobEnv;
  readonly #attemptId: string;
  #lastPush = Date.now();
  #writes: Promise<void> = Promise.resolve();

  constructor(env: JobEnv, attemptId: string) {
    this.#redactor = new Redactor({ registry: env.registry });
    this.#env = env;
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

  /**
   * Records, as metadata at the current position of the stored log, that `omittedBytes` of output
   * were dropped. Nothing is written into the log text. What was held for redaction is flushed
   * first and redaction starts afresh after the cut, so text from either side of the gap is
   * never joined.
   */
  cut(omittedBytes: number): void {
    this.#emit(this.#redactor.end());
    this.#redactor = new Redactor({ registry: this.#env.registry });
    const atOffset = this.stored;
    this.chain(
      () =>
        this.#env.store.addCut?.(this.#attemptId, {
          atOffset,
          omittedBytes,
          reason: "output cap",
        }) ?? Promise.resolve(),
    );
  }

  /** Flushes the held tail and waits for every pending write. */
  async close(): Promise<void> {
    this.#emit(this.#redactor.end());
    await this.#writes;
  }

  #emit(text: string): void {
    if (text === "") return;
    this.#env.out(text);
    const bytes = enc.encode(text);
    const at = this.stored;
    this.stored += bytes.length;
    this.chain(() => this.#env.store.appendLog(this.#attemptId, at, bytes));
  }
}

/**
 * The confinement a proxied job asks its provider for. The strict one, whenever the provider has
 * it, unless the proxy endpoint has no stable address and the provider also offers the
 * domain-filtered one (which its operator enabled on purpose): then that. A provider with neither
 * cannot run a proxied job.
 */
export function proxyEgress(
  offered: readonly string[],
  listen: { addresses?: readonly string[] | undefined },
): "deny-all-except-proxy" | "proxy-domain-filtered" | undefined {
  const hasAddresses = (listen.addresses?.length ?? 0) > 0;
  if (!hasAddresses && offered.includes("proxy-domain-filtered")) return "proxy-domain-filtered";
  if (offered.includes("deny-all-except-proxy")) return "deny-all-except-proxy";
  return undefined;
}
