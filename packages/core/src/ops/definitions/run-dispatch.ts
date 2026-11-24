import { z } from "zod";
import { DispatchError } from "../../poll/dispatch";
import { GithubError, RateLimited } from "../../poll/github";
import { MAX_DISPATCH_INPUT_BYTES, MAX_DISPATCH_INPUTS } from "../../poll/dispatch-inputs";
import { getRun } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { principalLabel } from "../principal";

/**
 * The lowest role that may dispatch. A dispatch starts a run of a chosen ref with chosen inputs,
 * and on the default branch that run is `protected` (secrets, write token): it is a maintainer's
 * act, so `operator` (start and cancel work) is not enough. `release_operator` is the lowest role
 * above it; admins and owners pass too. Readers and viewers never do.
 */
export const DISPATCH_MIN_ROLE = "release_operator" as const;

export const runDispatch = defineOp({
  name: "run_dispatch",
  summary: "Start a workflow_dispatch run of one workflow at a branch, tag or commit.",
  description:
    "Runs a workflow that declares `on.workflow_dispatch`, as the GitHub 'Run workflow' button " +
    "does. `ref` is a branch or tag name of the project's repo (or refs/heads/..., refs/tags/...), " +
    "or a full commit sha on the default branch's first-parent history; it is resolved to a sha " +
    "NOW and the run is for exactly that sha. A name that is not in the repo (a fork's branch, " +
    "an unknown name) is refused. `inputs` is a map of strings checked against the workflow's " +
    "`on.workflow_dispatch.inputs`: unknown names, missing required inputs, wrong types " +
    "(boolean, number, choice, environment) and values over the size cap are refused with the " +
    "reason; defaults are applied. The job sees `github.event_name == 'workflow_dispatch'`, " +
    "`github.event.inputs.*` (strings) and `inputs.*` (typed). Trust class: the default branch " +
    "(and the project's protected refs) is protected, another branch is trusted_pr (no " +
    "secrets), and a tag the project lists as a release ref is a release run that WAITS for " +
    "release approval like a tag push would (state awaiting_approval); a dispatch never skips an " +
    "approval. Only a repo this project ingests, and only when ingest is on. Input values are " +
    "stored with the run and never written to the audit log (the audit has the input names). " +
    "Needs release_operator or higher (a maintainer); an operator or a reader is refused. " +
    "Counts against the project's hourly run cap. Writes and is audited.",
  input: z.object({
    workflow: z
      .string()
      .min(1)
      .max(200)
      .describe("Workflow file under .github/workflows/, e.g. .github/workflows/release.yml."),
    ref: z.string().min(1).max(200).describe("A branch or tag name, or a full commit sha."),
    inputs: z
      .record(z.string().min(1).max(100), z.string().max(MAX_DISPATCH_INPUT_BYTES))
      .default({})
      .describe(
        `String inputs by name, at most ${MAX_DISPATCH_INPUTS} and ${MAX_DISPATCH_INPUT_BYTES} bytes in total.`,
      ),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional()
      .describe("owner/name; only needed when the project ingests more than one repo."),
  }),
  output: z.object({
    run_id: z.string(),
    repo: z.string(),
    ref: z.string().describe("The full ref the run is for."),
    sha: z.string().describe("The commit the ref resolved to; the run is for exactly this."),
    trust_class: z.enum(["protected", "release", "trusted_pr", "untrusted_pr"]),
    state: z
      .enum(["queued", "awaiting_approval"])
      .describe("awaiting_approval when the run waits for a human before any job starts."),
    input_names: z.array(z.string()).describe("The inputs the run got, defaults included."),
  }),
  effect: "write",
  auth: { type: "token", minRole: DISPATCH_MIN_ROLE },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/dispatches" },
  // A forge round trip: not inside the audit transaction. The dispatcher audits the outcome.
  outsideTransaction: true,
  // Values are never audited, only names.
  logOmitFields: ["inputs"],
  auditDetail: (o) => ({
    run_id: o.run_id,
    resolved_repo: o.repo,
    resolved_ref: o.ref,
    resolved_sha: o.sha,
    trust_class: o.trust_class,
    state: o.state,
    input_names: o.input_names,
  }),
  async handler(ctx, input) {
    if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
    if (!ctx.runDispatcher) {
      throw new OpError("unavailable", "this server cannot dispatch runs (no poller)");
    }
    const scope = { orgId: ctx.scope.orgId, projectId: ctx.scope.projectId };
    try {
      const out = await ctx.runDispatcher(scope, input.repo, {
        workflow: input.workflow,
        ref: input.ref,
        inputs: input.inputs,
        actor: principalLabel(ctx.principal),
        role: ctx.principal.role,
      });
      const run = await getRun(ctx.db, scope, out.runId);
      return {
        run_id: out.runId,
        repo: out.repo,
        ref: out.ref,
        sha: out.sha,
        trust_class: out.trustClass,
        state:
          run?.status === "awaiting_approval"
            ? ("awaiting_approval" as const)
            : ("queued" as const),
        input_names: out.inputNames,
      };
    } catch (err) {
      if (err instanceof DispatchError) throw new OpError(err.code, err.message);
      if (err instanceof RateLimited)
        throw new OpError("rate_limited", "GitHub rate limit: try again shortly");
      if (err instanceof GithubError) {
        throw new OpError(
          "unavailable",
          `GitHub answered ${err.status} while resolving the dispatch`,
        );
      }
      throw err;
    }
  },
});
