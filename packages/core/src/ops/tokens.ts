import { createHash, randomBytes } from "node:crypto";

/** Prefix of every Longshore API token, so scanners and humans can recognise one. */
export const TOKEN_PREFIX = "tt_";

/** A new random token: `ls_` plus 32 random bytes, base64url. Shown once; only its hash is kept. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** sha256 hex of the full token. Lookup by this hash is the comparison: no secret is compared. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Cheap shape check before hitting the database. */
export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length === TOKEN_PREFIX.length + 43;
}

import type { AgentRole } from "../db/schema";
import { OpError } from "./errors";
import type { Principal } from "./principal";
import { ROLE_RANK } from "./roles";

/**
 * A token can never mint a token that exceeds its own grant: a higher role, or a wider scope
 * (an org-wide token from a project-scoped one, or a different project). People (`member`
 * principals) are the trust root and may mint any agent role. Today no token can reach
 * `create_api_token` at all (it needs admin); this keeps the rule true if that ever changes.
 */
export function assertMintable(
  creator: Principal,
  request: { role: AgentRole; projectId: string | undefined },
): void {
  if (creator.kind === "member") return;
  if (ROLE_RANK[request.role] > ROLE_RANK[creator.role]) {
    throw new OpError("forbidden", "a token cannot create a token with a higher role than its own");
  }
  if (creator.projectId !== null && request.projectId !== creator.projectId) {
    throw new OpError("forbidden", "a token cannot create a token wider than its own scope");
  }
}
