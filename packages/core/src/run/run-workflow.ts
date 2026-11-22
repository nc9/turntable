import {
  evaluateCondition,
  githubContext,
  githubResolver,
  planJob,
  planWorkflow,
  resolveActions,
  splitJob,
  type ActTarball,
  type ActionFetcher,
  type ActionRefResolver,
  type NeedResult,
  type PlannedJob,
  type Value,
  type WorkflowEvent,
} from "@turntable/act-runner";
import type { Provider } from "@turntable/provider-sdk";
import { SecretRegistry } from "@turntable/redact";
import { aggregateRunStatus } from "../db/job-state";
import { EXIT, executeJob, type ExitCode, type JobEnv, type Verdict } from "./job-exec";
import { workflowNameOf } from "./run-local";
import type { FinalState, JobIds, RunStore } from "./store";

export interface RunWorkflowOptions {
  provider: Provider;
  providerName: string;
  store: RunStore;
  /** Workflow path relative to the repo root. */
  workflowPath: string;
  workflowYaml: string;
  event: WorkflowEvent;
  sha?: string;
  commitMessage?: string;
  actor?: string;
  headBranch?: string;
  repoTarball: Uint8Array;
  image: string;
  out: (text: string) => void;
  readFile: (path: string) => string | undefined;
  resolver?: ActionRefResolver;
  egress?: "none" | "open";
  registry?: SecretRegistry;
  signal?: AbortSignal;
  idleFlushMs?: number;
  /** Jobs running at once, one sandbox each. Default 2. */
  maxParallel?: number;
  vars?: Record<string, Value>;
  // Test seams.
  planRoot?: string;
  act?: ActTarball;
  fetchAction?: ActionFetcher;
  pollMs?: number;
  timeoutSeconds?: number;
}

export interface WorkflowJobResult {
  key: string;
  name: string;
  state: Verdict;
  reason: string;
  outputs?: Record<string, string>;
}

export interface RunWorkflowResult {
  /** False when the workflow's `on:` does not trigger for this event: nothing ran. */
  triggered: boolean;
  triggerReason: string;
  state: Verdict;
  exitCode: ExitCode;
  runId?: string;
  jobs: WorkflowJobResult[];
}

type Entry = { node: PlannedJob; ids?: JobIds; jobId: string };

/** Prefixes each line of a job's terminal output with its key. Stored logs stay unprefixed. */
function prefixed(
  out: (t: string) => void,
  key: string,
): { out: (t: string) => void; flush: () => void } {
  let held = "";
  return {
    out(text) {
      held += text;
      const lines = held.split("\n");
      held = lines.pop() ?? "";
      if (lines.length > 0) out(lines.map((l) => `[${key}] ${l}\n`).join(""));
    },
    flush() {
      if (held) out(`[${key}] ${held}\n`);
      held = "";
    },
  };
}

function eventPayload(o: RunWorkflowOptions): Value {
  const e = o.event;
  if (e.name === "pull_request" || e.name === "pull_request_target") {
    return {
      ...(e.action ? { action: e.action } : {}),
      pull_request: {
        base: { ref: e.baseRef ?? "" },
        head: { ref: o.headBranch ?? "", sha: o.sha ?? "" },
        draft: false,
      },
    };
  }
  return e.action ? { action: e.action } : {};
}

/**
 * Runs a whole workflow: plans the job graph, then schedules jobs as their needs finish, one
 * sandbox per job (at most `maxParallel` at once). Each job runs from a generated single-job
 * workflow whose stub need jobs carry the real needs results and outputs. Jobs that cannot run
 * here (docker ...) or whose `if:` is false are recorded as skipped with the reason; their
 * dependents see `skipped`. A workflow that does not trigger for the event runs nothing.
 */
export async function runWorkflowLocal(o: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const workflowName = workflowNameOf(o.workflowYaml);
  const wp = planWorkflow(o.workflowYaml, o.event, {
    readFile: o.readFile,
    github: {
      ...(o.sha ? { sha: o.sha } : {}),
      ...(o.actor ? { actor: o.actor } : {}),
      ...(o.headBranch ? { head_ref: o.headBranch } : {}),
      ...(workflowName ? { workflow: workflowName } : {}),
      event: eventPayload(o),
    },
    ...(o.vars ? { vars: o.vars } : {}),
  });
  if (!wp.trigger.matched) {
    return {
      triggered: false,
      triggerReason: wp.trigger.reason,
      state: "skipped",
      exitCode: 0,
      jobs: [],
    };
  }
  for (const w of wp.warnings) o.out(`warning: ${w.message}\n`);
  if (wp.trigger.pathsUnknown) o.out(`note: ${wp.trigger.reason}\n`);

  const registry = o.registry ?? new SecretRegistry();
  const resolverBase = o.resolver ?? githubResolver();
  const memo = new Map<string, Promise<string>>();
  const resolver: ActionRefResolver = (owner, repo, ref) => {
    const k = `${owner}/${repo}@${ref}`;
    let p = memo.get(k);
    if (!p) {
      p = resolverBase(owner, repo, ref);
      memo.set(k, p);
    }
    return p;
  };

  const { runId } = await o.store.beginRun({
    workflowPath: o.workflowPath,
    event: o.event.name,
    ref: o.event.ref ?? "refs/heads/main",
    ...(o.sha ? { sha: o.sha } : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(o.commitMessage ? { commitMessage: o.commitMessage } : {}),
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.headBranch ? { headBranch: o.headBranch } : {}),
  });
  await o.store.recordLaunch({
    runId,
    workflow: o.workflowPath,
    jobs: wp.jobs.map((j) => j.key),
    provider: o.providerName,
    image: o.image,
    egress: o.egress ?? "none",
    ...(wp.concurrency ? { concurrency: wp.concurrency } : {}),
  });

  const entries = new Map<string, Entry>();
  for (const node of wp.jobs) {
    const { jobId } = await o.store.createJob(runId, {
      jobKey: node.key,
      jobName: node.name,
      needs: node.needs,
      ...(node.matrix ? { matrix: node.matrix } : {}),
    });
    entries.set(node.key, { node, jobId });
  }

  const env: JobEnv = {
    provider: o.provider,
    store: o.store,
    image: o.image,
    repoTarball: o.repoTarball,
    out: o.out,
    ...(o.egress ? { egress: o.egress } : {}),
    registry,
    signal: o.signal,
    ...(o.idleFlushMs !== undefined ? { idleFlushMs: o.idleFlushMs } : {}),
    ...(o.act ? { act: o.act } : {}),
    ...(o.fetchAction ? { fetchAction: o.fetchAction } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    ...(o.timeoutSeconds !== undefined ? { timeoutSeconds: o.timeoutSeconds } : {}),
  };

  // ---- scheduling state ----
  const results = new Map<string, WorkflowJobResult>(); // by key, finished jobs
  const needView = new Map<string, NeedResult["result"]>(); // by key, what dependents see
  const running = new Map<string, Promise<void>>();
  const failFastCancelled = new Set<string>();
  const legsOf = (id: string): PlannedJob[] => wp.jobs.filter((j) => j.id === id);
  const aborted = (): boolean => o.signal?.aborted ?? false;

  const aggregateNeed = (id: string): NeedResult => {
    const legs = legsOf(id);
    const rs = legs.map((l) => needView.get(l.key) ?? "skipped");
    const result: NeedResult["result"] = rs.includes("failure")
      ? "failure"
      : rs.includes("cancelled")
        ? "cancelled"
        : rs.every((r) => r === "skipped")
          ? "skipped"
          : "success";
    const outputs: Record<string, string> = {};
    for (const l of legs) {
      for (const [k, v] of Object.entries(results.get(l.key)?.outputs ?? {})) {
        if (v !== "" || !(k in outputs)) outputs[k] = v;
      }
    }
    return { result, outputs };
  };

  const record = (
    node: PlannedJob,
    state: Verdict,
    reason: string,
    outputs?: Record<string, string>,
  ): void => {
    results.set(node.key, {
      key: node.key,
      name: node.name,
      state,
      reason,
      ...(outputs ? { outputs } : {}),
    });
    // continue-on-error: a failed job still counts as success for its dependents and the run.
    needView.set(
      node.key,
      state === "failure" || state === "infra_error"
        ? node.continueOnError
          ? "success"
          : "failure"
        : state,
    );
  };

  const skip = async (e: Entry, reason: string): Promise<void> => {
    o.out(`[${e.node.key}] skipped: ${reason}\n`);
    await o.store.skipJob(runId, e.jobId, o.providerName, `skipped: ${reason}`);
    record(e.node, "skipped", reason);
  };

  const runOne = async (e: Entry, needs: Record<string, NeedResult>): Promise<void> => {
    const { node } = e;
    const ids = await o.store.startAttempt(runId, e.jobId, o.providerName);
    const sink = prefixed(o.out, node.key);
    try {
      let plan;
      try {
        const split = splitJob(o.workflowYaml, node, needs, {
          event: o.event.name,
          ...(o.planRoot ? { root: o.planRoot } : {}),
        });
        const planned = planJob(split, node.id, {
          workflowPath: `.turntable/jobs/${node.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_")}.yml`,
          event: o.event.name,
          ...(o.planRoot ? { root: o.planRoot } : {}),
          readFile: o.readFile,
          split: true,
        });
        plan = await resolveActions(planned, resolver);
      } catch (err) {
        const msg = `plan rejected: ${err instanceof Error ? err.message : String(err)}`;
        sink.out(`${msg}\n`);
        sink.flush();
        await o.store.appendLog(ids.attemptId, 0, new TextEncoder().encode(`${msg}\n`));
        await o.store.finishJob(ids, "infra_error", { errorClass: msg.slice(0, 200) });
        record(node, "infra_error", msg);
        return;
      }
      const outcome = await executeJob({ ...env, out: sink.out }, ids, plan);
      sink.flush();
      record(node, outcome.state, outcome.reason, outcome.outputs);
    } finally {
      sink.flush();
    }
  };

  const ifContext = (node: PlannedJob, needs: Record<string, NeedResult>) => ({
    contexts: {
      github: githubContext(o.event, {
        ...(o.sha ? { sha: o.sha } : {}),
        ...(o.actor ? { actor: o.actor } : {}),
        ...(workflowName ? { workflow: workflowName } : {}),
        event: eventPayload(o),
      }),
      needs: Object.fromEntries(
        Object.entries(needs).map(([id, n]) => [id, { result: n.result, outputs: n.outputs }]),
      ),
      matrix: node.matrix ?? {},
      vars: o.vars ?? {},
      inputs: {},
      env: wp.env,
      secrets: {},
    } as Record<string, Value>,
    status: {
      needs: Object.values(needs).map((n) => n.result),
      cancelled: aborted(),
    },
  });

  const cap = o.maxParallel ?? 2;
  const pending = new Map(entries);
  const groupRunning = (id: string): number =>
    [...running.keys()].filter((k) => entries.get(k)?.node.id === id).length;

  const settleReady = async (): Promise<boolean> => {
    let progressed = false;
    for (const [key, e] of pending) {
      if (!e.node.needs.every((n) => results.has(n))) continue;
      if (aborted()) {
        pending.delete(key);
        await o.store.cancelQueuedJob(e.jobId);
        record(e.node, "cancelled", "run cancelled");
        progressed = true;
        continue;
      }
      if (failFastCancelled.has(key)) {
        pending.delete(key);
        await o.store.cancelQueuedJob(e.jobId);
        record(e.node, "cancelled", "matrix fail-fast");
        progressed = true;
        continue;
      }
      const needs = Object.fromEntries(e.node.needsIds.map((id) => [id, aggregateNeed(id)]));
      if (e.node.unsupported) {
        pending.delete(key);
        await skip(e, `unsupported: ${e.node.unsupported}`);
        progressed = true;
        continue;
      }
      if (e.node.staticSkip) {
        pending.delete(key);
        await skip(e, e.node.staticSkip.reason);
        progressed = true;
        continue;
      }
      let go: boolean;
      try {
        go = evaluateCondition(e.node.ifExpr, ifContext(e.node, needs));
      } catch (err) {
        pending.delete(key);
        await skip(e, `cannot evaluate if: ${err instanceof Error ? err.message : String(err)}`);
        progressed = true;
        continue;
      }
      if (!go) {
        pending.delete(key);
        await skip(e, `if: ${String(e.node.ifExpr ?? "success()").trim()} is false`);
        progressed = true;
        continue;
      }
      if (running.size >= cap) continue;
      const mp = e.node.maxParallel;
      if (mp !== undefined && groupRunning(e.node.id) >= mp) continue;
      pending.delete(key);
      const p = runOne(e, needs)
        .catch(async (err: unknown) => {
          // A crash in orchestration must not strand the job in running.
          const msg = err instanceof Error ? err.message : String(err);
          record(e.node, "infra_error", msg);
        })
        .then(() => {
          running.delete(key);
          const r = results.get(key);
          if (
            r &&
            e.node.failFast &&
            e.node.matrix &&
            (r.state === "failure" || r.state === "infra_error") &&
            !e.node.continueOnError
          ) {
            for (const sib of legsOf(e.node.id))
              if (pending.has(sib.key)) failFastCancelled.add(sib.key);
          }
        });
      running.set(key, p);
      progressed = true;
    }
    return progressed;
  };

  while (pending.size > 0 || running.size > 0) {
    const progressed = await settleReady();
    if (running.size > 0) await Promise.race(running.values());
    else if (!progressed && pending.size > 0) {
      // Nothing can start: cannot happen for an acyclic graph, but never hang.
      for (const [key, e] of pending) {
        pending.delete(key);
        await o.store.cancelQueuedJob(e.jobId);
        record(e.node, "cancelled", "unschedulable");
      }
    }
  }

  const finals: FinalState[] = wp.jobs.map((n) => {
    const r = results.get(n.key);
    const st = (r?.state ?? "cancelled") as FinalState;
    return (st === "failure" || st === "infra_error") && n.continueOnError ? "success" : st;
  });
  await o.store.finishRun(runId, finals);
  const status = aggregateRunStatus(finals);
  const state: Verdict =
    status === "queued" || status === "running" || status === "awaiting_approval"
      ? "cancelled"
      : (status as Verdict);
  return {
    triggered: true,
    triggerReason: wp.trigger.reason,
    state,
    exitCode: EXIT[state],
    runId,
    jobs: wp.jobs.map((n) => results.get(n.key) as WorkflowJobResult),
  };
}
