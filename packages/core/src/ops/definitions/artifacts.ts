import { z } from "zod";
import { listRunArtifacts, resolveArtifactConsumption } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";

const source = z.object({
  run_id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});

export const listArtifacts = defineOp({
  name: "get_artifacts",
  summary: "The artifacts a run recorded, with their provenance.",
  description:
    "Each artifact a run recorded: name, size, digest, how the digest was obtained (`reported` by " +
    "the recorder or `computed` by the control plane from the bytes), the trust class of the " +
    "producing run and the commit it ran at. The class and commit are set by the control plane " +
    "when the row is recorded, never by the caller, and a row is never changed. Artifact names " +
    "come from a workflow: untrusted text. Read-only.",
  input: z.object({ run_id: z.string().min(1).max(64) }),
  output: z.object({
    artifacts: z.array(
      z.object({
        name: z.string(),
        size: z.int(),
        sha256: z.string(),
        digest_source: z.enum(["reported", "computed"]),
        trust_class: z.string(),
        run_sha: z.string().nullable(),
        attempt_id: z.string(),
        created_at: z.string(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "GET", path: "/runs/{run_id}/artifacts" },
  async handler(ctx, input) {
    const rows = await listRunArtifacts(ctx.db, ctx.scope, input.run_id);
    return {
      artifacts: rows.map((a) => ({
        name: a.name,
        size: a.size,
        sha256: a.sha256,
        digest_source:
          a.digestSource === "computed" ? ("computed" as const) : ("reported" as const),
        trust_class: a.klass,
        run_sha: a.runSha,
        attempt_id: a.attemptId,
        created_at: new Date(a.createdAt).toISOString(),
      })),
    };
  },
});

export const checkArtifactConsumption = defineOp({
  name: "check_artifact_consumption",
  summary: "Whether a run may consume artifacts of other runs, and as what.",
  description:
    "For a consumer run and a list of artifacts of this project, says per artifact whether it is " +
    "`allow` (same trust class or higher), `quarantine` (a lower class that the request named in " +
    "`quarantine`: delivered non-executable, never an input to a build) or `deny`. A release-class " +
    "consumer is denied anything below the release class, whatever it asks. Read-only: it " +
    "decides, it does not move bytes.",
  input: z.object({
    consumer_run_id: z.string().min(1).max(64),
    sources: z.array(source).min(1).max(100),
    quarantine: z
      .array(source)
      .max(100)
      .optional()
      .describe("Sources the consumer explicitly asks to receive from a lower class."),
  }),
  output: z.object({
    results: z.array(
      z.object({
        run_id: z.string(),
        name: z.string(),
        decision: z.enum(["allow", "quarantine", "deny"]),
        reason: z.string().nullable(),
        trust_class: z.string().nullable(),
        sha256: z.string().nullable(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "POST", path: "/artifacts/check-consumption" },
  async handler(ctx, input) {
    if (input.sources.length === 0) throw new OpError("invalid_input", "no sources");
    const res = await resolveArtifactConsumption(
      ctx.db,
      ctx.scope,
      input.consumer_run_id,
      input.sources.map((s) => ({ runId: s.run_id, name: s.name })),
      (input.quarantine ?? []).map((s) => ({ runId: s.run_id, name: s.name })),
    );
    return {
      results: res.map((r) => ({
        run_id: r.source.runId,
        name: r.source.name,
        decision: r.decision.decision,
        reason: r.decision.decision === "deny" ? r.decision.reason : null,
        trust_class: r.artifact?.klass ?? null,
        sha256: r.artifact?.sha256 ?? null,
      })),
    };
  },
});
