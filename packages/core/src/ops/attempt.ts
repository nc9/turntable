import { z } from "zod";
import { getJob, listAttempts } from "../db/repos";
import type { OpContext } from "./define";
import { OpError } from "./errors";

/** Input fields that pick one attempt of a job: the latest unless a number is given. */
export const attemptInput = {
  job_id: z.string().min(1).max(64),
  attempt: z.int().min(1).optional().describe("Attempt number. Defaults to the latest attempt."),
};

/** Resolves a job and one of its attempts in the caller's scope; `attempt` is undefined if none yet. */
export async function resolveAttempt(
  ctx: OpContext,
  input: { job_id: string; attempt?: number | undefined },
) {
  const job = await getJob(ctx.db, ctx.scope, input.job_id);
  if (!job) throw new OpError("not_found", "job not found");
  const attempts = await listAttempts(ctx.db, ctx.scope, job.id);
  const attempt =
    input.attempt === undefined
      ? attempts.at(-1)
      : attempts.find((a) => a.attempt === input.attempt);
  if (input.attempt !== undefined && !attempt) throw new OpError("not_found", "attempt not found");
  return { job, attempt };
}
