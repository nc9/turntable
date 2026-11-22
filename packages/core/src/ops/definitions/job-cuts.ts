import { z } from "zod";
import { listCuts, listNotices } from "../../db/repos";
import { attemptInput, resolveAttempt } from "../attempt";
import { defineOp } from "../define";

export const jobCuts = defineOp({
  name: "job_cuts",
  summary: "Where a job log had bytes omitted (head and tail caps).",
  description:
    "Lists the places where the stored log of one job attempt is missing bytes because of the " +
    "output cap: at_offset is the byte offset in the stored log where the omission falls and " +
    "omitted_bytes how much was dropped. Use it with job_log so you know a log is incomplete " +
    "and where, instead of guessing from the text. Recorded apart from the log text, so the log " +
    "cannot forge a cut. Also lists the control plane's system notices for the attempt (the " +
    "cache dropped entries, a hold reason): short lines recorded apart from the log text, so the " +
    "job's output cannot forge one either; `at_offset` is where the stored log ended when it was " +
    "added. Read-only. The reason string comes from the runner.",
  input: z.object(attemptInput),
  output: z.object({
    job_id: z.string(),
    attempt: z.int().nullable().describe("Attempt number; null when the job has no attempt yet."),
    cuts: z.array(
      z.object({
        at_offset: z.int(),
        omitted_bytes: z.int(),
        reason: z.string(),
      }),
    ),
    notices: z.array(
      z.object({
        at_offset: z.int(),
        source: z.string().describe("Where it came from, for example `cache`."),
        text: z.string(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/jobs/{job_id}/cuts" },
  async handler(ctx, input) {
    const { job, attempt } = await resolveAttempt(ctx, input);
    if (!attempt) return { job_id: job.id, attempt: null, cuts: [], notices: [] };
    const cuts = await listCuts(ctx.db, ctx.scope, attempt.id);
    const notices = await listNotices(ctx.db, ctx.scope, attempt.id);
    return {
      job_id: job.id,
      attempt: attempt.attempt,
      cuts: cuts.map((c) => ({
        at_offset: c.atOffset,
        omitted_bytes: c.omittedBytes,
        reason: c.reason,
      })),
      notices: notices.map((n) => ({ at_offset: n.atOffset, source: n.source, text: n.text })),
    };
  },
});
