// Post-deploy verification: poll /healthz until it is ok and reports the target sha.
import { buildRollbackNote } from "./notes";

export interface VerifyDeps {
  fetch(url: string): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface VerifyOptions {
  baseUrl: string;
  targetSha: string;
  timeoutMs?: number;
  pollMs?: number;
  /** The commit deployed before the target: what a failed verification rolls back to. */
  previousSha?: string | null;
  /** Whether a migration ran in this deploy; the database is never restored automatically. */
  migrationRan?: boolean;
}

/** What the workflow does after a failed verification, and the note to publish for it. */
export type RollbackPlan =
  | { action: "redeploy"; targetSha: string; previousSha: string; reason: string; note: string }
  | { action: "stop"; targetSha: string; previousSha: string | null; reason: string; why: string };

export type VerifyResult =
  | { ok: true; elapsedMs: number }
  | { ok: false; reason: string; elapsedMs: number; rollback: RollbackPlan };

function planRollback(opts: VerifyOptions, reason: string): RollbackPlan {
  const previousSha = opts.previousSha ?? null;
  if (opts.migrationRan) {
    return {
      action: "stop",
      targetSha: opts.targetSha,
      previousSha,
      reason,
      why: "a migration ran: the database is not restored automatically",
    };
  }
  if (previousSha === null) {
    return {
      action: "stop",
      targetSha: opts.targetSha,
      previousSha,
      reason,
      why: "there is no previous deployment to roll back to",
    };
  }
  const note = buildRollbackNote({ targetSha: opts.targetSha, previousSha, reason });
  return { action: "redeploy", targetSha: opts.targetSha, previousSha, reason, note };
}

export async function verifyDeploy(deps: VerifyDeps, opts: VerifyOptions): Promise<VerifyResult> {
  const started = deps.now();
  const deadline = started + (opts.timeoutMs ?? 10 * 60_000);
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/healthz`;
  let last = "no response";
  for (;;) {
    try {
      const res = await deps.fetch(url);
      if (!res.ok) last = `healthz returned ${res.status}`;
      else {
        const body = (await res.json()) as { ok?: unknown; version?: unknown; build_sha?: unknown };
        const seen = typeof body.build_sha === "string" ? body.build_sha : String(body.version);
        if (body.ok !== true) last = "healthz is not ok";
        else if (body.build_sha === opts.targetSha || body.version === opts.targetSha) {
          return { ok: true, elapsedMs: deps.now() - started };
        } else last = `healthz reports ${seen}, expected ${opts.targetSha}`;
      }
    } catch (e) {
      last = `healthz unreachable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (deps.now() >= deadline) {
      const reason = `timed out: ${last}`;
      return {
        ok: false,
        reason,
        elapsedMs: deps.now() - started,
        rollback: planRollback(opts, reason),
      };
    }
    await deps.sleep(opts.pollMs ?? 5_000);
  }
}
