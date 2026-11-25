// Multi-org user tokens (#547): mint, list and revoke. A user token (`ttu_`) is a person's own
// credential for every org they belong to; see `authenticateUser` in dispatch.ts for how a call
// with one gets its org and role. Minting is a web-session act with a fresh passkey step-up.
// Listing and revoking sit under the user's profile (`account` ops), not under any org's tokens.
import { z } from "zod";
import {
  appendAudit,
  countLiveUserTokens,
  getIdentityByUserId,
  getUserToken,
  insertUserToken,
  listUserTokenOrgs,
  listUserTokens,
  MAX_LIVE_USER_TOKENS,
  revokeUserToken,
} from "../../db/repos";
import { systemOrgId } from "../../audit/failures";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { generateUserToken, hashToken } from "../tokens";
import { iso } from "../common";

const DAY_MS = 86_400_000;
export const MAX_USER_TOKEN_DAYS = 90;

export const createUserToken = defineOp({
  name: "create_user_token",
  // A credential must never be minted into an agent's context.
  mcp: false,
  summary: "Mint your own multi-org user token (ttu_). Web session and passkey step-up only.",
  description:
    "Mints a bearer token bound to YOUR GitHub account, not to an org: it acts in every org you " +
    "belong to, with your CURRENT role in the org each call names (pass `org` on every call; " +
    "removing your membership stops it for that org on the next call). Only a signed-in web " +
    "session may call this, with a fresh passkey step-up for exactly this request (`step_up`, " +
    "see `session_step_up_challenge`; the passkey is one enrolled in the org you name here). No " +
    "token of any kind can mint one. The secret is returned once in `token`; only its hash is " +
    "stored. It lasts ttl_days (1 to 90). A user token can do what your web session can do, " +
    "except: it cannot mint tokens, it cannot satisfy a passkey step-up and so cannot call " +
    "operations that need one, and approvals still need your passkey on the approval screen. " +
    "You may hold 10 live user tokens. Writes and is audited in the org's chain and in your own " +
    "(system) chain, never with the token or its hash. Not an MCP tool.",
  input: z.object({
    name: z.string().min(1).max(80).describe("A label, e.g. the machine or client that uses it."),
    ttl_days: z.int().min(1).max(MAX_USER_TOKEN_DAYS),
  }),
  output: z.object({
    id: z.string(),
    name: z.string(),
    github_user_id: z.string(),
    expires_at: z.string(),
    token: z.string().describe("The secret. Shown once, store it now."),
  }),
  oneTimeSecretFields: ["token"],
  effect: "write",
  auth: { type: "token", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/user-tokens" },
  async handler(ctx, input) {
    const p = ctx.principal;
    if (ctx.transport === "mcp" || ctx.viaMcp) {
      throw new OpError("forbidden", "create_user_token is not available over MCP");
    }
    if (p.kind !== "session") {
      throw new OpError("forbidden", "a user token is minted from a signed-in web session only");
    }
    if (ctx.stepUp?.action !== "create_user_token") {
      throw new OpError("forbidden", "minting a user token needs a passkey step-up", {
        reason: "step_up_required",
      });
    }
    const identity = await getIdentityByUserId(ctx.db, p.id);
    if (!identity) throw new OpError("forbidden", "this session has no GitHub identity");
    const now = ctx.now();
    if ((await countLiveUserTokens(ctx.db, identity.githubUserId, now)) >= MAX_LIVE_USER_TOKENS) {
      throw new OpError(
        "conflict",
        `at most ${MAX_LIVE_USER_TOKENS} live user tokens: revoke one first`,
      );
    }
    const secret = generateUserToken();
    const expiresAt = now + input.ttl_days * DAY_MS;
    const row = await insertUserToken(ctx.db, {
      githubUserId: identity.githubUserId,
      name: input.name,
      tokenHash: hashToken(secret),
      expiresAt,
    });
    // The dispatcher audits this op in the org's chain; the person's own chain (the system
    // chain: there is no per-user chain) gets its own entry.
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "session",
        principalId: p.id,
        op: "create_user_token",
        effect: "write",
        outcome: "ok",
        input: {
          token_id: row.id,
          github_user_id: identity.githubUserId,
          name: input.name,
          ttl_days: input.ttl_days,
        },
      },
    );
    return {
      id: row.id,
      name: row.name,
      github_user_id: identity.githubUserId,
      expires_at: new Date(expiresAt).toISOString(),
      token: secret,
    };
  },
  auditDetail: (out) => ({ token_id: out.id }),
});

export const listUserTokensOp = defineOp({
  name: "list_user_tokens",
  summary: "List your own user tokens: name, last use, expiry, revoked. Never a secret.",
  description:
    "Lists the multi-org user tokens of the signed-in GitHub account, newest first, revoked and " +
    "expired ones included. Needs a signed-in web session with no org named: no token of any " +
    "kind can call it. Never returns a secret or its hash. Not available over MCP.",
  input: z.object({}),
  output: z.object({
    tokens: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        created_at: z.string(),
        last_used_at: z.string().nullable(),
        expires_at: z.string(),
        revoked_at: z.string().nullable(),
        status: z.enum(["active", "revoked", "expired"]),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "account", minRole: "viewer" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/account/user-tokens" },
  mcp: false,
  async handler(ctx) {
    const p = ctx.principal;
    if (p.kind !== "account") throw new OpError("forbidden", "an account session is required");
    const now = ctx.now();
    const rows = await listUserTokens(ctx.db, p.githubUserId);
    return {
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        created_at: iso(r.createdAt)!,
        last_used_at: iso(r.lastUsedAt),
        expires_at: iso(r.expiresAt)!,
        revoked_at: iso(r.revokedAt),
        status: (r.revokedAt !== null ? "revoked" : r.expiresAt <= now ? "expired" : "active") as
          "active" | "revoked" | "expired",
      })),
    };
  },
});

export const revokeUserTokenOp = defineOp({
  name: "revoke_user_token",
  summary: "Revoke one of your own user tokens. Takes effect on its next call.",
  description:
    "Revokes a user token of the signed-in GitHub account by id (from `list_user_tokens`). It " +
    "stops working at once, in every org. Another person's token id is the same not_found as an " +
    "unknown one. Needs a signed-in web session with no org named: no token of any kind can call " +
    "it. Audited in your own (system) chain and in the chain of every org the token was used in. " +
    "Not available over MCP.",
  input: z.object({
    token_id: z.string().min(1).max(64).describe("The id from list_user_tokens."),
  }),
  output: z.object({ token_id: z.string(), revoked: z.boolean() }),
  effect: "destructive",
  auth: { type: "account", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/account/user-tokens/{token_id}/revoke" },
  mcp: false,
  async handler(ctx, i) {
    const p = ctx.principal;
    if (p.kind !== "account") throw new OpError("forbidden", "an account session is required");
    const row = await getUserToken(ctx.db, i.token_id);
    if (!row || row.githubUserId !== p.githubUserId) {
      throw new OpError("not_found", "no such user token");
    }
    // Revoking twice is fine: the second call finds it already revoked.
    const done = await revokeUserToken(ctx.db, p.githubUserId, row.id, ctx.now());
    if (done) {
      for (const orgId of await listUserTokenOrgs(ctx.db, row.id)) {
        await appendAudit(
          ctx.db,
          { orgId },
          {
            principalKind: "account",
            principalId: p.githubUserId,
            op: "revoke_user_token",
            effect: "destructive",
            outcome: "ok",
            input: { token_id: row.id, github_user_id: p.githubUserId },
          },
        );
      }
    }
    return { token_id: row.id, revoked: true };
  },
  auditDetail: (out) => ({ revoked: out.revoked }),
});
