import { z } from "zod";
import { SYSTEM_ORG_SLUG, systemOrgId } from "../../audit/failures";
import {
  appendAudit,
  appendEvent,
  countActiveApiTokens,
  getApiToken,
  getOrgBySlug,
  lockOrgTokens,
} from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { recordOrgTokensExhausted, revokeTokenCascade } from "../token-cli";

export const instanceRevokeOrgTokenOp = defineOp({
  name: "instance_revoke_org_token",
  summary:
    "Break-glass: revoke an org's token and everything it minted (instance administrator only).",
  description:
    "Revokes one token of an org by id, at once, with no help from the token's holder: for a " +
    "leaked tenant token whose holder is unreachable (on a hosted instance a token can otherwise " +
    "only revoke itself). It always cascades: every token the token minted, transitively, is " +
    "revoked in the same transaction, because a leaked token's children are suspect too. The " +
    "next request of each is refused and its open realtime sockets close. The output gives " +
    "`revoked` and `descendants_revoked`, the number of minted tokens revoked with it. Revoking " +
    "an already revoked token is a success with `already_revoked` true (any live descendants are " +
    "still revoked). An unknown id, an id of another org and an unknown org are all the same " +
    "`not_found`; the system org is never a target. `reason` is required and recorded with the " +
    "token id and the descendant count, never the secret or its hash. It can leave the org with " +
    "no usable token (`org_locked_out`): the recovery is `create_org_token`, which for an org " +
    "that had a token waits out the `org_remint_delay_hours` setting. Audited in the system " +
    "org's chain and in the org's own, and emits an `org.token_revoked` event to the org. Only " +
    "the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    token_id: z.string().min(1).max(64).describe("The token id (from `list_api_tokens`)."),
    reason: z.string().min(1).max(500).describe("Why: recorded in both audit chains."),
  }),
  output: z.object({
    token_id: z.string(),
    org: z.string().describe("Org slug."),
    revoked: z.boolean().describe("True: the token is revoked now (or already was)."),
    already_revoked: z.boolean(),
    descendants_revoked: z.number().int().describe("Minted tokens revoked with it."),
    org_locked_out: z.boolean().describe("True when no usable token is left in the org."),
  }),
  effect: "destructive",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/orgs/tokens/revoke" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    // One message for every miss: an unknown org, the system org, an unknown id, another org's id.
    const miss = new OpError("not_found", "no such token");
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw miss;
    const scope = { orgId: org.id };
    // Serialise with other revokes and with minting in this org (#437).
    await lockOrgTokens(ctx.db, org.id);
    const row = await getApiToken(ctx.db, scope, i.token_id);
    if (!row) throw miss;
    const now = ctx.now();
    const by = { kind: "instance", id: ctx.principal.id };
    const { rootChanged, children } = await revokeTokenCascade(
      ctx.db,
      org.id,
      row.id,
      now,
      by,
      true,
    );
    const changed = rootChanged || children.length > 0;
    const lockedOut = changed && (await countActiveApiTokens(ctx.db, scope, now)) === 0;
    if (changed) {
      const detail = { token_id: row.id, reason: i.reason, descendants_revoked: children.length };
      await appendAudit(ctx.db, scope, {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_revoke_org_token",
        effect: "destructive",
        outcome: "ok",
        input: { target_org: org.slug, ...detail },
      });
      await appendAudit(
        ctx.db,
        { orgId: await systemOrgId(ctx.db) },
        {
          principalKind: "instance",
          principalId: ctx.principal.id,
          op: "org_token_revoked",
          effect: "destructive",
          outcome: "ok",
          input: { target_org: org.slug, ...detail },
        },
      );
      await appendEvent(ctx.db, scope, {
        type: "org.token_revoked",
        payload: { ...detail, by: ctx.principal.id },
      });
      if (lockedOut) await recordOrgTokensExhausted(ctx.db, org.id, row.id, by);
    }
    return {
      token_id: row.id,
      org: org.slug,
      revoked: true,
      already_revoked: !rootChanged,
      descendants_revoked: children.length,
      org_locked_out: lockedOut,
    };
  },
});
