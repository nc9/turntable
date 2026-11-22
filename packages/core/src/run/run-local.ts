import {
  planJob,
  resolveActions,
  type ActTarball,
  type ActionFetcher,
  type ActionRefResolver,
} from "@turntable/act-runner";
import type { Provider } from "@turntable/provider-sdk";
import { parse } from "yaml";
import { SecretRegistry } from "@turntable/redact";
import { executeJob } from "./execute";
import type { RunStore } from "./store";

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
  commitMessage?: string;
  actor?: string;
  headBranch?: string;
  repoTarball: Uint8Array;
  image: string;
  /** Sink for the (redacted) log text, for example the terminal. */
  out: (text: string) => void;
  /** Reads repo files so local composite actions are always scanned and pinned. */
  readFile: (path: string) => string | undefined;
  resolver?: ActionRefResolver;
  /** `none` (default) gives the sandbox no network. `open` is an explicit opt-in. */
  egress?: "none" | "open";
  /** Secrets to redact everywhere: log text, step names, stored error text. */
  registry?: SecretRegistry;
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
    readFile: o.readFile,
  });
  for (const w of planned.warnings) o.out(`warning: ${w.message}\n`);
  const plan = await resolveActions(planned, o.resolver);

  const workflowName = workflowNameOf(o.workflowYaml);
  const ids = await o.store.begin({
    workflowPath: o.workflowPath,
    event: o.event,
    ref: o.ref,
    ...(o.sha ? { sha: o.sha } : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(o.commitMessage ? { commitMessage: o.commitMessage } : {}),
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.headBranch ? { headBranch: o.headBranch } : {}),
    jobKey: o.job,
    jobName: o.job,
    provider: o.providerName,
  });
  await o.store.markRunning(ids);

  // One registry for everything act-derived that we show or store.
  const registry = o.registry ?? new SecretRegistry();

  const result = await executeJob({
    provider: o.provider,
    plan,
    ids,
    io: {
      setSandbox: (sandboxId) => o.store.setSandbox(ids.attemptId, sandboxId),
      appendLog: (offset, bytes) => o.store.appendLog(ids.attemptId, offset, bytes),
      recordStep: (step) => o.store.recordStep(ids.attemptId, step),
    },
    repoTarball: o.repoTarball,
    image: o.image,
    out: o.out,
    ...(o.egress ? { egress: o.egress } : {}),
    registry,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.idleFlushMs !== undefined ? { idleFlushMs: o.idleFlushMs } : {}),
    ...(o.act ? { act: o.act } : {}),
    ...(o.fetchAction ? { fetchAction: o.fetchAction } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}),
  });

  const exitCode =
    result.state === "success"
      ? 0
      : result.state === "failure"
        ? result.code && result.code !== 0
          ? result.code
          : 1
        : undefined;
  await o.store.finish(ids, result.state, {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(result.state === "infra_error" ? { errorClass: result.reason.slice(0, 200) } : {}),
  });
  return { state: result.state, exitCode: EXIT[result.state], reason: result.reason, ...ids };
}

/** The workflow's top-level `name:`, if it has a plain string one. */
function workflowNameOf(yaml: string): string | undefined {
  try {
    const doc: unknown = parse(yaml);
    const name =
      typeof doc === "object" && doc !== null ? (doc as { name?: unknown }).name : undefined;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}
