import { z } from "zod";
import {
  createReleaseRequest,
  getFreeze,
  getReleaseRequest,
  getRun,
  type ReleaseRequest,
} from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";

const requestView = z.object({
  id: z.string(),
  run_id: z.string(),
  tag: z.string(),
  artifacts: z.array(z.string()),
  status: z.enum(["pending", "claimed", "signed", "refused", "error"]),
  reason: z.string().nullable().describe("Why the release lane refused, as a short code."),
  created_at: z.int(),
  finished_at: z.int().nullable(),
  key_id: z.string().nullable().describe("The id of the key that signed, when it signed."),
});

const view = (r: ReleaseRequest): z.infer<typeof requestView> => ({
  id: r.id,
  run_id: r.runId,
  tag: r.tag,
  artifacts: JSON.parse(r.artifacts) as string[],
  status: r.status as z.infer<typeof requestView>["status"],
  reason: r.reason,
  created_at: r.createdAt,
  finished_at: r.finishedAt,
  key_id: r.result ? ((JSON.parse(r.result) as { keyid?: string }).keyid ?? null) : null,
});

export const requestReleaseOp = defineOp({
  name: "request_release",
  summary: "Ask the release lane to sign the artifacts of a tagged run.",
  description:
    "Queues a request for the release lane, a separate process that holds the signing keys. The " +
    "request names a run, the tag being released, the artifact names (never an approval environment: that is the project's own setting). It is " +
    "only a request: the release lane re-checks with the forge that the tag points at the run's " +
    "commit and recomputes the artifact digests itself, so nothing here can make it sign " +
    "something it cannot verify. Poll get_release_request for the outcome. Needs one project and " +
    "release_operator or admin; audited. Not available over MCP.",
  input: z.object({
    run_id: z.string().min(1).max(40),
    tag: z.string().min(1).max(200),
    artifacts: z.array(z.string().min(1).max(200)).min(1).max(50),
  }),
  output: requestView,
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/release-requests" },
  mcp: false,
  async handler(ctx, i) {
    if ((await getFreeze(ctx.db, ctx.scope)).frozen) {
      throw new OpError("conflict", "this org or project is frozen; releases are paused");
    }
    const run = await getRun(ctx.db, ctx.scope, i.run_id);
    if (!run) throw new OpError("not_found", "no such run in this project");
    const row = await createReleaseRequest(ctx.db, ctx.scope, {
      runId: i.run_id,
      tag: i.tag,
      artifacts: i.artifacts,
      requestedBy: `${ctx.principal.kind}:${ctx.principal.id}`,
    });
    return view(row);
  },
});

export const getReleaseRequestOp = defineOp({
  name: "get_release_request",
  summary: "The state of a release request: pending, signed, or refused with a reason.",
  description:
    "Returns one release request by id: its status (pending, claimed, signed, refused, error), the " +
    "refusal reason as a short code when the release lane refused it, and the key id when it " +
    "signed. Needs one project and release_operator or admin. Read-only.",
  input: z.object({ id: z.string().min(1).max(40) }),
  output: requestView,
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/release-requests/{id}" },
  async handler(ctx, i) {
    const r = await getReleaseRequest(ctx.db, ctx.scope, i.id);
    if (!r) throw new OpError("not_found", "no such release request");
    return view(r);
  },
});
