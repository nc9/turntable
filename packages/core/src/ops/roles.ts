import { AGENT_ROLES, type AgentRole, MEMBER_ROLES, type MemberRole } from "../db/schema";

/** Every role that can be held or required. Agent roles belong to tokens, org roles to people. */
export type Role = AgentRole | MemberRole;

/**
 * The one explicit mapping of both role families onto a single ladder. A requirement is met
 * when the principal's rank is at least the required rank.
 *
 * - `reader` and `viewer`: read-only.
 * - `operator` and `member`: may start and cancel work.
 * - `release_operator`: operator plus release-gate calls. Still not an admin: it cannot manage
 *   tokens or members. (Release approvals themselves are human-only, signature ops.)
 * - `admin` and `owner`: org administration. Only people hold these; no token role maps here.
 */
export const ROLE_RANK = {
  reader: 1,
  viewer: 1,
  operator: 2,
  member: 2,
  release_operator: 3,
  admin: 4,
  owner: 5,
} as const satisfies Record<Role, number>;

export const ALL_ROLES: readonly Role[] = [...AGENT_ROLES, ...MEMBER_ROLES];

/** True when `held` satisfies a requirement of `required`. */
export function roleSatisfies(held: Role, required: Role): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

export function isAgentRole(role: string): role is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(role);
}
