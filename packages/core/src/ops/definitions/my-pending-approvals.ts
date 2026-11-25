import { z } from "zod";
import { myPendingApprovals, PENDING_KINDS } from "../../approvals/pending";
import { listMembershipsOfUser } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";

export const myPendingApprovalsOp = defineOp({
  name: "my_pending_approvals",
  summary: "Approvals waiting on the signed-in person, across every org they belong to.",
  description:
    "The inbox of one person: only the items they can act on right now. Release and environment " +
    "approvals, runs held for an untrusted author under the `human` policy, key enrolments and " +
    "key policy changes, each only where the person has a live approver key bound to their " +
    "GitHub account id and the same checks the approving code applies let that key sign (key " +
    "policy, the author rule, the self-approval rule, a quorum not yet met, not yet expired). " +
    "Each item has its id, kind, org and project slugs, the environment name, when it was " +
    "created, when it expires (if it does) and `link`: the UI route of its approval screen. " +
    "Nothing from the repository is returned (no titles, branch names, workflow or job names). " +
    "A web session only: it is a person's inbox, so every token, agent or not, is refused. " +
    "It approves nothing. Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(PENDING_KINDS),
        org: z.string().describe("Org slug."),
        project: z.string().describe("Project slug; `-` for an org-level item."),
        environment: z.string().optional(),
        created_at: z.string(),
        expires_at: z.int().optional().describe("Epoch milliseconds."),
        link: z.string().describe("The UI route of the item's approval screen."),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/my/pending-approvals" },
  async handler(ctx) {
    const p = ctx.principal;
    if (p.kind !== "session")
      throw new OpError(
        "forbidden",
        "my_pending_approvals is a person's inbox: it needs a signed-in web session",
      );
    const memberships = await listMembershipsOfUser(ctx.db, p.id);
    const items = await myPendingApprovals(ctx.db, {
      userId: p.id,
      memberships,
      now: ctx.now(),
      settings: ctx.settings,
    });
    return { items };
  },
});
