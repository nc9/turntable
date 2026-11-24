import { createHash, randomBytes } from "node:crypto";

/** Prefix of every Turntable API token, so scanners and humans can recognise one. */
export const TOKEN_PREFIX = "tt_";

/**
 * Prefix of an instance-administrator token. A different prefix from every org token, so the two
 * are told apart before any lookup, and a scanner or a human can tell what a leaked one is.
 */
export const INSTANCE_TOKEN_PREFIX = "tti_";

/** Instance tokens minted before the rename (formerly Longshore). Still accepted: only hashes are stored. */
const LEGACY_INSTANCE_TOKEN_PREFIX = "lsi_"; // rename-keep

/** A new instance token: `tti_` plus 32 random bytes, base64url. Shown once; only its hash is kept. */
export function generateInstanceToken(): string {
  return `${INSTANCE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function looksLikeInstanceToken(value: string): boolean {
  return [INSTANCE_TOKEN_PREFIX, LEGACY_INSTANCE_TOKEN_PREFIX].some(
    (prefix) => value.startsWith(prefix) && value.length === prefix.length + 43,
  );
}

/** Org tokens minted before the rename (formerly Longshore). Still accepted, nothing else changes. */
const LEGACY_TOKEN_PREFIX = "ls_"; // rename-keep

/** A new random token: `tt_` plus 32 random bytes, base64url. Shown once; only its hash is kept. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** sha256 hex of the full token. Lookup by this hash is the comparison: no secret is compared. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Cheap shape check before hitting the database. */
export function looksLikeToken(value: string): boolean {
  return [TOKEN_PREFIX, LEGACY_TOKEN_PREFIX].some(
    (prefix) => value.startsWith(prefix) && value.length === prefix.length + 43,
  );
}

import type { AgentRole, TokenKind } from "../db/schema";
import { OpError } from "./errors";
import type { Principal } from "./principal";
import { ROLE_RANK } from "./roles";

/**
 * A token can never mint a token that exceeds its own grant: a higher role, a wider scope
 * (an org-wide token from a project-scoped one, or a different project), or a less restricted
 * kind (an agent token cannot mint a person token). People (`member`
 * principals) are the trust root and may mint any agent role. `create_api_token` calls it for a bearer token (#437). An agent token may mint only agent
 * tokens, up to `operator`.
 */
export function assertMintable(
  creator: Principal,
  request: { role: AgentRole; projectId: string | undefined; kind?: TokenKind },
): void {
  if (creator.kind === "member") return;
  if (creator.kind === "approver" || creator.kind === "instance") {
    throw new OpError(
      "forbidden",
      `${creator.kind === "approver" ? "an approver key" : "an instance token"} cannot create tokens`,
    );
  }
  if (ROLE_RANK[request.role] > ROLE_RANK[creator.role]) {
    throw new OpError("forbidden", "a token cannot create a token with a higher role than its own");
  }
  if (creator.tokenKind === "agent") {
    if (request.kind === "person") {
      throw new OpError("forbidden", "an agent token cannot create a person token");
    }
    if (ROLE_RANK[request.role] > ROLE_RANK.operator) {
      throw new OpError("forbidden", "an agent token can create tokens up to operator only");
    }
  }
  if (creator.projectId !== null && request.projectId !== creator.projectId) {
    throw new OpError("forbidden", "a token cannot create a token wider than its own scope");
  }
}
