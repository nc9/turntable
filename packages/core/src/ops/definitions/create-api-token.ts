import { z } from "zod";
import { getOrgById, insertApiToken } from "../../db/repos";
import { AGENT_ROLES } from "../../db/schema";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { principalLabel } from "../principal";
import { assertMintable, generateToken, hashToken } from "../tokens";

const DAY_MS = 86_400_000;

export const createApiToken = defineOp({
  name: "create_api_token",
  // Token minting: no agent role can call it, and a token must never be minted into an agent's context.
  mcp: false,
  summary: "Create an agent token, scoped to the org or one project. Shown once.",
  description:
    "Creates a bearer token for an agent or script, with a role (reader, operator or " +
    "release_operator), scoped to the org or to one project (pass project). The secret is " +
    "returned once in `token` and cannot be read again: only its hash is stored. Tokens expire " +
    "after expires_in_days (default 90, max 365). Org admins only; no agent token can create " +
    "tokens. Writes and is audited. Grant the least role and the narrowest scope that works.",
  input: z.object({
    name: z.string().min(1).max(80).describe("A label, e.g. the agent or pipeline that uses it."),
    role: z.enum(AGENT_ROLES).describe("reader: read-only. operator: also cancel and rerun."),
    expires_in_days: z.int().min(1).max(365).default(90),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(AGENT_ROLES),
    org: z.string().describe("Org slug."),
    project_id: z.string().nullable().describe("Set when the token is scoped to one project."),
    expires_at: z.string(),
    token: z.string().describe("The secret. Shown once, store it now."),
  }),
  oneTimeSecretFields: ["token"],
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/tokens" },
  async handler(ctx, input) {
    // Defense in depth: the dispatcher already requires admin, which no token role reaches.
    if (ctx.principal.kind !== "member") {
      throw new OpError("forbidden", "only org members can create tokens");
    }
    assertMintable(ctx.principal, { role: input.role, projectId: ctx.scope.projectId });
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    if (!org) throw new OpError("not_found", "org not found");
    const secret = generateToken();
    const expiresAt = ctx.now() + input.expires_in_days * DAY_MS;
    const row = await insertApiToken(ctx.db, ctx.scope, {
      name: input.name,
      role: input.role,
      tokenHash: hashToken(secret),
      createdBy: principalLabel(ctx.principal),
      expiresAt,
    });
    return {
      id: row.id,
      name: row.name,
      role: input.role,
      org: org.slug,
      project_id: row.projectId,
      expires_at: new Date(expiresAt).toISOString(),
      token: secret,
    };
  },
});
