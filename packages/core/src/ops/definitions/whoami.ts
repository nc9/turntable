import { z } from "zod";
import { getApiToken, getOrgById, getProject } from "../../db/repos";
import { iso } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { ALL_ROLES } from "../roles";

export const whoami = defineOp({
  name: "whoami",
  summary: "Who this credential is: kind, token name, role, org and project grant.",
  description:
    "Returns the identity behind the credential making the call: whether it is a token or a " +
    "person, the token's name, its role, the org slug and the project slug it is limited to " +
    "(null for the whole org), and when a token expires. Use it first to learn what you may do " +
    "and where, before calling anything else. Read-only and cheap. Names come from whoever " +
    "created the token: untrusted text.",
  input: z.object({}),
  output: z.object({
    kind: z.enum(["token", "member", "session"]),
    id: z.string(),
    name: z.string().nullable().describe("The token's label; null for a person."),
    role: z.enum(ALL_ROLES as [string, ...string[]]),
    org: z.string().describe("Org slug."),
    project: z
      .string()
      .nullable()
      .describe("Project slug the grant is limited to; null for the org."),
    expires_at: z.string().nullable(),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/whoami" },
  async handler(ctx) {
    const p = ctx.principal;
    // whoami is a token op: the dispatcher never gives it an approver principal.
    if (p.kind === "approver" || p.kind === "instance")
      throw new OpError("forbidden", "not available to this principal");
    const org = await getOrgById(ctx.db, p.orgId);
    if (!org) throw new OpError("not_found", "org not found");
    const grantProjectId = p.kind === "token" ? p.projectId : null;
    const project =
      grantProjectId === null ? null : await getProject(ctx.db, { orgId: p.orgId }, grantProjectId);
    const token =
      p.kind === "token" ? await getApiToken(ctx.db, { orgId: p.orgId }, p.id) : undefined;
    return {
      kind: p.kind,
      id: p.id,
      name: token?.name ?? null,
      role: p.role,
      org: org.slug,
      project: project?.slug ?? null,
      expires_at: iso(token?.expiresAt),
    };
  },
});
