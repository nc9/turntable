import { z } from "zod";
import { listSecretUseAudit } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";

/** Most audit rows one query reads. The vault writes one row per use, so a very busy secret hits it. */
export const USAGE_SCAN_LIMIT = 20_000;
const MAX_USES = 500;

const instant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 timestamp");

const usageOutput = z.object({
  name: z.string().describe("The secret name that was queried."),
  since: z.string(),
  until: z.string(),
  total: z.int().describe("Uses found, including those beyond the cap."),
  truncated: z.boolean().describe("The scan or the list was capped; narrow the range."),
  uses: z.array(
    z.object({
      at: z.string(),
      run_id: z.string().nullable(),
      job_id: z.string().nullable(),
      attempt_id: z.string().nullable(),
      destination: z.string().nullable(),
      version: z.int().nullable(),
      trust_class: z.string().nullable(),
    }),
  ),
});

export const secretUsage = defineOp({
  name: "secret_usage",
  summary: "Where a secret was used in a time range: runs, jobs, attempts and destinations.",
  description:
    "For one secret name and a time range, lists each recorded use from the audit log, oldest " +
    "first: when, the run, job and attempt that used it, the destination host it was delivered " +
    "to, the version and the trust class it ran as. This is the blast-radius query for an " +
    "incident: start from the earliest time the secret could have leaked. Names and ids only; " +
    "values are never stored in the audit log. Denied uses are not listed. Covers every version " +
    "and scope of the name in the org (or the project, for a project-scoped token). Results are " +
    "capped; narrow the range when `truncated` is true. Destinations come from workflow " +
    "configuration: untrusted data. Needs release_operator, like list_secrets. Read-only.",
  input: z.object({
    name: z.string().trim().min(1).max(200),
    since: instant.describe("Start of the range, ISO 8601."),
    until: instant.optional().describe("End of the range, ISO 8601. Default: now."),
  }),
  output: usageOutput,
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/secrets/usage" },
  async handler(ctx, input) {
    const since = Date.parse(input.since);
    const until = input.until === undefined ? ctx.now() : Date.parse(input.until);
    if (until < since) throw new OpError("invalid_input", "until is before since");
    const rows = await listSecretUseAudit(ctx.db, ctx.scope, {
      since,
      until,
      limit: USAGE_SCAN_LIMIT,
    });
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    const uses: z.infer<typeof usageOutput>["uses"] = [];
    let total = 0;
    for (const r of rows) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(r.input) as Record<string, unknown>;
      } catch {
        continue; // truncated entry: no name to match
      }
      if (body.secret !== input.name) continue;
      total++;
      if (uses.length < MAX_USES) {
        uses.push({
          at: new Date(r.createdAt).toISOString(),
          run_id: str(body.run),
          job_id: str(body.job),
          attempt_id: str(body.attempt),
          destination: str(body.destination),
          version: typeof body.version === "number" ? body.version : null,
          trust_class: str(body.class),
        });
      }
    }
    return {
      name: input.name,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      total,
      truncated: rows.length >= USAGE_SCAN_LIMIT || total > uses.length,
      uses,
    };
  },
});
