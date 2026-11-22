import {
  planJob,
  resolveActions,
  type ActTarball,
  type ActionFetcher,
  type ActionRefResolver,
} from "@longshore/act-runner";
import type { Provider } from "@longshore/provider-sdk";
import { SecretRegistry } from "@longshore/redact";
import { parse } from "yaml";
import { DEFAULT_IMAGE, EXIT, executeJob, type ExitCode, type Verdict } from "./job-exec";
import type { RunStore } from "./store";

export { DEFAULT_IMAGE };

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
  state: Verdict;
  /** Process exit code: 0 success or skipped, 1 failure, 2 infra_error, 130 cancelled. */
  exitCode: ExitCode;
  reason: string;
  runId: string;
  jobId: string;
  attemptId: string;
}

/**
 * Plans one job (a workflow that uses needs or a matrix is refused here: run it whole with
 * runWorkflowLocal), creates DB rows, runs it in a fresh sandbox and records the result. Plan
 * errors throw before any row exists. The sandbox is always destroyed.
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
  const { runId } = await o.store.beginRun({
    workflowPath: o.workflowPath,
    event: o.event,
    ref: o.ref,
    ...(o.sha ? { sha: o.sha } : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(o.commitMessage ? { commitMessage: o.commitMessage } : {}),
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.headBranch ? { headBranch: o.headBranch } : {}),
  });
  await o.store.recordLaunch({
    runId,
    workflow: o.workflowPath,
    job: o.job,
    provider: o.providerName,
    image: o.image,
    egress: o.egress ?? "none",
  });
  const { jobId } = await o.store.createJob(runId, {
    jobKey: o.job,
    jobName: o.job,
    needs: [],
  });
  const ids = await o.store.startAttempt(runId, jobId, o.providerName);

  const outcome = await executeJob(
    {
      provider: o.provider,
      store: o.store,
      image: o.image,
      repoTarball: o.repoTarball,
      out: o.out,
      ...(o.egress ? { egress: o.egress } : {}),
      registry: o.registry ?? new SecretRegistry(),
      signal: o.signal,
      ...(o.idleFlushMs !== undefined ? { idleFlushMs: o.idleFlushMs } : {}),
      ...(o.act ? { act: o.act } : {}),
      ...(o.fetchAction ? { fetchAction: o.fetchAction } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}),
    },
    ids,
    plan,
  );
  await o.store.finishRun(runId, [outcome.state]);
  return { state: outcome.state, exitCode: EXIT[outcome.state], reason: outcome.reason, ...ids };
}

/** The workflow's top-level `name:`, if it has a plain string one. */
export function workflowNameOf(yaml: string): string | undefined {
  try {
    const doc: unknown = parse(yaml);
    const name =
      typeof doc === "object" && doc !== null ? (doc as { name?: unknown }).name : undefined;
    return typeof name === "string" && name !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}
