import type { AgentRole, MemberRole } from "../db/schema";

/**
 * Who is calling. A `token` principal comes from a bearer token (REST, MCP). A `member`
 * principal is a person, built by trusted in-process callers only (the local CLI, and web
 * sessions once they exist); no network adapter can construct one.
 */
export type Principal =
  | { kind: "token"; id: string; orgId: string; projectId: string | null; role: AgentRole }
  | { kind: "member"; id: string; orgId: string; role: MemberRole };

/** What a caller presents to the dispatcher. */
export type Credential =
  | { kind: "bearer"; token: string }
  /** In-process only: an already-authenticated principal. Adapters never build this. */
  | { kind: "principal"; principal: Principal };

export const principalLabel = (p: Principal): string => `${p.kind}:${p.id}`;
