import { z } from "zod";
import { getApiToken, lockOrgTokens } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { roleSatisfies } from "../roles";
import { planTokenCascade, recordOrgTokensExhausted, revokeTokenCascade } from "../token-cli";

export const revokeApiTokenOp = defineOp({
  name: "revoke_api_token",
  summary: "Revoke an API token at once: an org admin any token, any token itself.",
  description:
    "Revokes an API token by id (from `list_api_tokens`). It takes effect at once: the token's " +
    "next request is refused, because every call looks the token up afresh. An org owner or " +
    "admin may revoke any token of the org; any token may revoke itself (rotate: mint the new " +
    "token, check it works, then revoke the old one with the old one or as an admin). Refused " +
    "with `conflict` when it would leave the org with no usable token, unless a token revokes " +
    "itself with confirm_lockout true (recovery is then the instance administrator's token " +
    "minting, which waits). Idempotent: revoking an already revoked token changes nothing and " +
    "returns already_revoked true. A token id of another org is `not_found`. `reason` is " +
    "recorded in the audit entry with the token id, never the secret. An admin's revoke always also revokes every token the token minted, transitively, in the same transaction (each is audited as `parent revoked`). A token revoking itself keeps the tokens it minted by default, which is how a rotation works (mint the successor with the old token, verify it, then self-revoke); pass cascade true to kill everything it minted (it is compromised). The last-usable guard counts the tokens that would survive. Destructive and audited.",
  roleNote:
    "Needs the org admin or owner role to revoke another token; any token (any role) may revoke itself.",
  input: z.object({
    token_id: z.string().min(1).max(64).describe("The id from list_api_tokens."),
    reason: z.string().min(1).max(500).describe("Why: recorded in the audit log."),
    cascade: z
      .boolean()
      .default(false)
      .describe(
        "Self-revoke only: also revoke every token this one minted, transitively (compromise). " +
          "Default false keeps a rotation's successor. An admin's revoke always cascades.",
      ),
    confirm_lockout: z
      .boolean()
      .default(false)
      .describe("Needed when a token revokes itself as the org's last usable token."),
  }),
  output: z.object({
    token_id: z.string(),
    name: z.string(),
    revoked: z.boolean().describe("True: the token is revoked now (or already was)."),
    already_revoked: z.boolean(),
    org_locked_out: z.boolean().describe("True when no usable token is left in the org."),
  }),
  effect: "destructive",
  // A token holds at most release_operator, so the bar is the lowest: the handler enforces
  // "self, or an admin member".
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/tokens/{token_id}/revoke" },
  async handler(ctx, input) {
    // Serialise with other revokes and with minting in this org before counting (#437). On
    // Postgres this is an advisory lock; SQLite's write transaction is already exclusive.
    await lockOrgTokens(ctx.db, ctx.scope.orgId);
    const row = await getApiToken(ctx.db, ctx.scope, input.token_id);
    // Uniform with an unknown id: another org's token is not visible at all.
    if (!row) throw new OpError("not_found", "token not found");
    const self = ctx.principal.kind === "token" && ctx.principal.id === row.id;
    const admin = ctx.principal.kind === "member" && roleSatisfies(ctx.principal.role, "admin");
    if (!self && !admin) {
      throw new OpError("forbidden", "only an org admin may revoke another token");
    }
    const now = ctx.now();
    const org = { orgId: ctx.scope.orgId };
    const cascade = self ? input.cascade : true;
    // Revoking a token revokes everything it minted, so the lockout guard counts what survives.
    const plan = await planTokenCascade(ctx.db, org.orgId, row.id, now, cascade);
    const last = plan.activeInTree > 0 && plan.survivors === 0;
    if (last && !(self && input.confirm_lockout)) {
      throw new OpError(
        "conflict",
        self
          ? "this would leave the org with no usable token (this token and the tokens it minted are all of them): pass confirm_lockout true to revoke anyway"
          : "this would leave the org with no usable token: revoking it and the tokens it minted would lock the org out",
      );
    }
    const { rootChanged: changed, children } = await revokeTokenCascade(
      ctx.db,
      org.orgId,
      row.id,
      now,
      { kind: ctx.principal.kind, id: ctx.principal.id },
      cascade,
    );
    if ((changed || children.length > 0) && last) {
      await recordOrgTokensExhausted(ctx.db, ctx.scope.orgId, row.id, {
        kind: ctx.principal.kind,
        id: ctx.principal.id,
      });
    }
    return {
      token_id: row.id,
      name: row.name,
      revoked: true,
      already_revoked: !changed,
      org_locked_out: (changed || children.length > 0) && last,
    };
  },
});
