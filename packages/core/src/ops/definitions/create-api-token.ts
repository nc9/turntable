import { z } from "zod";
import {
  appendEvent,
  countActiveChildTokens,
  findApiTokenById,
  getOrgById,
  insertApiToken,
  lockOrgTokens,
} from "../../db/repos";
import { AGENT_ROLES, TOKEN_KINDS } from "../../db/schema";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { principalLabel } from "../principal";
import { roleSatisfies } from "../roles";
import { assertMintable, generateToken, hashToken } from "../tokens";

const DAY_MS = 86_400_000;

/** A token may have at most this many active children (a leaked token cannot fan out without bound). */
export const MAX_ACTIVE_CHILD_TOKENS = 20;

export const createApiToken = defineOp({
  name: "create_api_token",
  // Credential minting stays a REST act: a token must never be minted into an agent's context.
  mcp: false,
  summary: "Create an agent token, scoped to the org or one project. Shown once.",
  description:
    "Creates a bearer token with a role (reader, operator or release_operator), scoped to the " +
    "org or to one project (pass project). The secret is returned once in `token` and cannot be " +
    "read again: only its hash is stored. Tokens expire after expires_in_days (default 90, max " +
    "365). Callable by an org admin (in-process) or by a bearer token of role operator or above " +
    "in its own org, which can never escalate: the new token's role is at most the caller's, " +
    "its scope is the caller's or narrower (an org-wide token may mint a project-scoped one, " +
    "never the reverse or another project), and it expires no later than the caller does. " +
    "`kind` is `agent` (default: an MCP client or script) or `person` (a human's own token); " +
    "an agent token may mint only agent tokens, with a role of at most operator. A token may have at most 20 active children (conflict beyond that). Revoking a token does not revoke what it minted unless the revoker is an admin or asks for `cascade` (see `revoke_api_token`). Fixed at mint " +
    "time. Projects that set untrusted_run_approval to `no_agents` (the default) refuse agent " +
    "tokens as run approvers, so mint a person token only for a human. Writes and is audited " +
    "(the audit entry names the minting token), and emits an `org.token_minted` event. Not an " +
    "MCP tool: credential minting is a REST act. Grant the least role and the narrowest scope " +
    "that works.",
  input: z.object({
    name: z.string().min(1).max(80).describe("A label, e.g. the agent or pipeline that uses it."),
    role: z.enum(AGENT_ROLES).describe("reader: read-only. operator: also cancel and rerun."),
    kind: z
      .enum(TOKEN_KINDS)
      .default("agent")
      .describe("agent: an MCP client or script. person: a human's own token. Fixed at mint."),
    expires_in_days: z.int().min(1).max(365).default(90),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(AGENT_ROLES),
    kind: z.enum(TOKEN_KINDS),
    org: z.string().describe("Org slug."),
    project_id: z.string().nullable().describe("Set when the token is scoped to one project."),
    expires_at: z.string(),
    token: z.string().describe("The secret. Shown once, store it now."),
  }),
  oneTimeSecretFields: ["token"],
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/tokens" },
  async handler(ctx, input) {
    const p = ctx.principal;
    if (ctx.transport === "mcp" || ctx.viaMcp) {
      throw new OpError("forbidden", "create_api_token is not available over MCP");
    }
    if (p.kind === "member") {
      // The in-process admin path, as before.
      if (!roleSatisfies(p.role, "admin")) {
        throw new OpError("forbidden", "only org admins can create tokens");
      }
    } else if (p.kind !== "token") {
      throw new OpError("forbidden", "this principal cannot create tokens");
    }
    // Serialise per org with the revoke path, then check the caller against fresh state.
    await lockOrgTokens(ctx.db, ctx.scope.orgId);
    assertMintable(p, {
      role: input.role,
      projectId: ctx.scope.projectId,
      kind: input.kind,
    });
    const expiresAt = ctx.now() + input.expires_in_days * DAY_MS;
    if (p.kind === "token") {
      const parent = await findApiTokenById(ctx.db, p.id);
      if (!parent || parent.revokedAt !== null || parent.orgId !== ctx.scope.orgId) {
        throw new OpError("forbidden", "the calling token is no longer valid");
      }
      if (
        (await countActiveChildTokens(ctx.db, { orgId: ctx.scope.orgId }, p.id, ctx.now())) >=
        MAX_ACTIVE_CHILD_TOKENS
      ) {
        throw new OpError(
          "conflict",
          `a token may have at most ${MAX_ACTIVE_CHILD_TOKENS} active children: revoke one first`,
        );
      }
      if (parent.expiresAt !== null && expiresAt > parent.expiresAt) {
        throw new OpError(
          "forbidden",
          "a token cannot outlive the token that creates it; ask for a shorter expires_in_days",
        );
      }
    }
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    if (!org) throw new OpError("not_found", "org not found");
    const secret = generateToken();
    const row = await insertApiToken(ctx.db, ctx.scope, {
      name: input.name,
      role: input.role,
      kind: input.kind,
      tokenHash: hashToken(secret),
      createdBy: principalLabel(ctx.principal),
      expiresAt,
    });
    await appendEvent(
      ctx.db,
      { orgId: ctx.scope.orgId },
      {
        type: "org.token_minted",
        payload: {
          token_id: row.id,
          parent_id: p.kind === "token" ? p.id : null,
          by: principalLabel(p),
          role: input.role,
          kind: input.kind,
          project_id: row.projectId,
          expires_at: new Date(expiresAt).toISOString(),
        },
      },
    );
    return {
      id: row.id,
      name: row.name,
      role: input.role,
      kind: input.kind,
      org: org.slug,
      project_id: row.projectId,
      expires_at: new Date(expiresAt).toISOString(),
      token: secret,
    };
  },
});
