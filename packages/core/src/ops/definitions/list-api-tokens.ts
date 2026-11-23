import { z } from "zod";
import { listApiTokens } from "../../db/repos";
import { AGENT_ROLES, TOKEN_KINDS } from "../../db/schema";
import { decodeCursor, encodeCursor, nextCursor, pageInput } from "../common";
import { defineOp } from "../define";

export const TOKEN_STATUSES = ["active", "revoked", "expired"] as const;

export const listApiTokensOp = defineOp({
  name: "list_api_tokens",
  summary: "List the org's API tokens: role, scope, last use, expiry, revoked. Never a secret.",
  description:
    "Lists the API tokens of the org, newest first, revoked and expired ones included: id, name, " +
    "role, kind, the project it is scoped to (null for the whole org), when it was created and " +
    "last used, when it expires and whether it was revoked. A project-scoped token sees only " +
    "its project's tokens. The secret and its hash are never returned: only the id identifies a " +
    "token, and `revoke_api_token` takes that id. `last_used_at` is approximate (updated at most " +
    "every few minutes). Read-only. Token names are chosen by org admins: untrusted text.",
  input: z.object({ ...pageInput }),
  output: z.object({
    tokens: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: z.enum(AGENT_ROLES),
        kind: z.enum(TOKEN_KINDS),
        project_id: z.string().nullable().describe("Set when the token is scoped to one project."),
        created_at: z.string(),
        created_by: z.string(),
        last_used_at: z.string().nullable(),
        expires_at: z.string().nullable(),
        revoked_at: z.string().nullable(),
        status: z.enum(TOKEN_STATUSES),
      }),
    ),
    next_cursor: nextCursor,
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/tokens" },
  async handler(ctx, input) {
    const now = ctx.now();
    const iso = (ms: number | null): string | null =>
      ms === null ? null : new Date(ms).toISOString();
    // Newest first (ids sort by creation); an org holds few tokens, so page in memory.
    const before = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const all = (await listApiTokens(ctx.db, ctx.scope)).filter(
      (r) => before === undefined || r.id < before,
    );
    const rows = all.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      next_cursor: all.length > input.limit && last ? encodeCursor(last.id) : null,
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role as (typeof AGENT_ROLES)[number],
        // Anything but an explicit person reads as an agent (fail closed), as elsewhere.
        kind: r.kind === "person" ? ("person" as const) : ("agent" as const),
        project_id: r.projectId,
        created_at: new Date(r.createdAt).toISOString(),
        created_by: r.createdBy,
        last_used_at: iso(r.lastUsedAt),
        expires_at: iso(r.expiresAt),
        revoked_at: iso(r.revokedAt),
        status:
          r.revokedAt !== null
            ? ("revoked" as const)
            : r.expiresAt !== null && r.expiresAt <= now
              ? ("expired" as const)
              : ("active" as const),
      })),
    };
  },
});
